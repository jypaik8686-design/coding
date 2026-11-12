// 제미니채팅 — 제미니 API와 1대1 대화. 화면 둘(대화·설정), 데이터 한 덩어리.
// 열쇠는 이 기기 localStorage에만 있다. 저장소에는 적지 않는다.

const KEY = "제미니채팅/v1";
const API = "https://generativelanguage.googleapis.com/v1beta";

// 조절 가능한 안전 필터 전부 끔. 아동 안전 같은 핵심 보호는 API가 늘 막고 끌 수 없다.
// https://ai.google.dev/gemini-api/docs/safety-settings (2026-11-12 확인)
const SAFETY = ["HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT", "CIVIC_INTEGRITY"]
  .map((c) => ({ category: `HARM_CATEGORY_${c}`, threshold: "OFF" }));

// ── 데이터 모양 ──────────────────────────────────────────────
// 말 하나: { id, role: "user"|"model", text, at, err? }
const SHAPE = () => ({
  messages: [],
  settings: { apiKey: "", model: "gemini-flash-latest", system: "", temperature: 1 },
});

const store = {
  data: load(),
  saveQuiet() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); return true; }
    catch (e) { console.warn("저장 실패", e); toast("저장 실패 — 기기 저장 공간이 찼을 수 있음. 설정에서 대화를 내보내고 지우기"); return false; }
  },
  save() { this.saveQuiet(); render(); },
  push(role, text, extra = {}) {
    const m = { id: crypto.randomUUID(), role, text, at: Date.now(), ...extra };
    this.data.messages.push(m);
    return m;
  },
  reset() { this.data.messages = []; this.save(); },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return SHAPE();
    const d = JSON.parse(raw);
    const base = SHAPE();
    return {
      messages: Array.isArray(d.messages) ? d.messages.filter((m) => m && typeof m.text === "string") : [],
      settings: { ...base.settings, ...(d.settings || {}) },
    };
  } catch { return SHAPE(); }
}

// ── 제미니 호출 ─────────────────────────────────────────────
let busy = null; // 진행 중인 AbortController

function history() {
  // 오류 난 답과 빈 답은 보내지 않는다. 연달아 같은 역할이 오면 API가 싫어하므로 합친다.
  const out = [];
  for (const m of store.data.messages) {
    if (m.err || !m.text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.parts[0].text += "\n\n" + m.text;
    else out.push({ role: m.role, parts: [{ text: m.text }] });
  }
  return out;
}

async function ask() {
  const s = store.data.settings;
  const reply = store.push("model", "");
  store.saveQuiet();
  render();
  const bubble = () => document.querySelector(`[data-id="${reply.id}"] .text`);

  busy = new AbortController();
  setBusy(true);
  try {
    const body = {
      contents: history(),
      safetySettings: SAFETY,
      generationConfig: { temperature: Number(s.temperature) },
    };
    if (s.system.trim()) body.systemInstruction = { parts: [{ text: s.system }] };

    const res = await fetch(`${API}/models/${encodeURIComponent(s.model.trim())}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": s.apiKey.trim() },
      body: JSON.stringify(body),
      signal: busy.signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error?.message || msg; } catch {}
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", blocked = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let j;
        try { j = JSON.parse(line.slice(5)); } catch { continue; }
        if (j.promptFeedback?.blockReason) blocked = `질문이 막힘: ${j.promptFeedback.blockReason}`;
        const c = j.candidates?.[0];
        const t = (c?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (t) {
          reply.text += t;
          const b = bubble(); if (b) b.textContent = reply.text;
          follow();
        }
        if (c?.finishReason && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(c.finishReason))
          blocked = `답이 멈춤: ${c.finishReason}`;
        if (c?.finishReason === "MAX_TOKENS") reply.cut = true;
      }
    }
    if (!reply.text && blocked) throw new Error(blocked);
    if (!reply.text) throw new Error("빈 답이 옴");
    if (blocked) reply.note = blocked;
  } catch (e) {
    if (e.name === "AbortError") {
      if (!reply.text) reply.err = "멈춤";
      else reply.note = "중간에 멈춤";
    } else {
      reply.err = navigator.onLine === false ? "오프라인 — 망이 돌아오면 ‘다시’를 누르기" : e.message;
    }
  } finally {
    busy = null;
    setBusy(false);
    store.save();
  }
}

function send(text) {
  if (busy) return;
  if (!store.data.settings.apiKey.trim()) { location.hash = "#/settings"; toast("API 열쇠를 먼저 넣기"); return; }
  store.push("user", text);
  store.saveQuiet();
  ask();
}

function retry() {
  if (busy) return;
  const ms = store.data.messages;
  while (ms.length && ms[ms.length - 1].role === "model") ms.pop();
  if (!ms.length) return store.save();
  store.saveQuiet();
  ask();
}

// ── 화면 ────────────────────────────────────────────────────
const SCREENS = {
  chat() {
    const ms = store.data.messages;
    const noKey = !store.data.settings.apiKey.trim();
    const list = ms.length
      ? `<ul class="chat">${ms.map(bubbleHTML).join("")}</ul>`
      : `<p class="empty">${noKey ? "설정에서 제미니 API 열쇠를 먼저 넣기." : "아무 말이나 적어 보내기."}</p>`;
    const last = ms[ms.length - 1];
    const again = !busy && last && last.role === "model" ? `<button class="ghost small" id="retry">↻ 다시</button>` : "";
    return `${list}
      <div class="again">${again}</div>
      <form id="composer" class="composer">
        <textarea id="msg" name="msg" rows="1" placeholder="메시지" enterkeyhint="send"
                  autocomplete="off" ${noKey ? "disabled" : ""}></textarea>
        <button type="submit" id="sendBtn" aria-label="보내기">${busy ? "■" : "↑"}</button>
      </form>`;
  },

  settings() {
    const s = store.data.settings;
    return `
      <form id="setForm" onsubmit="return false">
        <h2>API 열쇠</h2>
        <input id="apiKey" type="password" autocomplete="off" spellcheck="false"
               value="${esc(s.apiKey)}" placeholder="AIza…">
        <p class="hint">이 기기 브라우저에만 저장됨. <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">AI Studio</a>에서 받기.</p>

        <h2>모델</h2>
        <input id="model" type="text" list="models" autocomplete="off" spellcheck="false" value="${esc(s.model)}">
        <datalist id="models"></datalist>
        <button class="ghost" id="loadModels" type="button">모델 목록 불러오기</button>

        <h2>시스템 프롬프트</h2>
        <textarea id="system" rows="6" placeholder="역할, 말투, 규칙… 길이 제한 없음">${esc(s.system)}</textarea>

        <h2>온도 <span id="tempVal" class="hint">${s.temperature}</span></h2>
        <input id="temperature" type="range" min="0" max="2" step="0.1" value="${s.temperature}">

        <p class="hint">안전 필터: 조절 가능한 다섯 가지 전부 끔(OFF). 아동 안전 등 핵심 보호는 Google이 늘 막음.</p>

        <h2 style="margin-top:12px">대화</h2>
        <p class="hint">${store.data.messages.length}개 말이 이 기기에만 저장돼 있음.</p>
        <button class="ghost" id="export" type="button">대화 내보내기 (JSON)</button>
        <button class="danger" id="reset" type="button">대화 전부 지우기</button>
      </form>`;
  },
};

const bubbleHTML = (m) => `
  <li class="msg ${m.role} ${m.err ? "err" : ""}" data-id="${m.id}">
    <div class="text">${m.err ? "⚠ " + esc(m.err) : esc(m.text)}</div>
    ${m.note || m.cut ? `<div class="note">${esc(m.note || "길이 한도에서 잘림")}</div>` : ""}
    ${m.text && !m.err ? `<button class="copy" data-act="copy" aria-label="복사">⧉</button>` : ""}
  </li>`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(t) {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.append(el); }
  el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 3500);
}

function follow() {
  const nearBottom = innerHeight + scrollY > document.documentElement.scrollHeight - 160;
  if (nearBottom || busy) scrollTo(0, document.documentElement.scrollHeight);
}

function setBusy(on) {
  const b = document.getElementById("sendBtn");
  if (b) { b.textContent = on ? "■" : "↑"; b.setAttribute("aria-label", on ? "멈추기" : "보내기"); }
  document.getElementById("count").textContent = on ? "답하는 중…" : "";
}

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { chat: "제미니채팅", settings: "설정" };
const route = () => (location.hash.replace(/^#\/?/, "") || "chat").split("/")[0];

function render() {
  const name = SCREENS[route()] ? route() : "chat";
  const draft = document.getElementById("msg")?.value || "";
  document.getElementById("screen").innerHTML = SCREENS[name]();
  document.getElementById("title").textContent =
    name === "chat" ? store.data.settings.model.replace(/^models\//, "") : TITLES[name];
  document.body.dataset.screen = name;
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  wire(name, draft);
  setBusy(!!busy);
}

function grow(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }

function wire(name, draft) {
  if (name === "chat") {
    const f = document.getElementById("composer");
    const t = f.msg;
    t.value = draft; grow(t);
    t.addEventListener("input", () => grow(t));
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      if (busy) { busy.abort(); return; }
      const v = t.value.trim();
      if (!v) return;
      t.value = "";
      send(v);
    });
    document.getElementById("retry")?.addEventListener("click", retry);
    scrollTo(0, document.documentElement.scrollHeight);
  }
  if (name === "settings") {
    const s = store.data.settings;
    const bind = (id, key, num) => document.getElementById(id).addEventListener("input", (e) => {
      s[key] = num ? Number(e.target.value) : e.target.value;
      if (id === "temperature") document.getElementById("tempVal").textContent = e.target.value;
      store.saveQuiet();
    });
    bind("apiKey", "apiKey"); bind("model", "model"); bind("system", "system"); bind("temperature", "temperature", true);

    document.getElementById("loadModels").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!s.apiKey.trim()) return toast("열쇠를 먼저 넣기");
      btn.disabled = true; btn.textContent = "불러오는 중…";
      try {
        const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": s.apiKey.trim() } });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`);
        const names = (j.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map((m) => m.name.replace(/^models\//, ""));
        document.getElementById("models").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
        toast(`${names.length}개 — 모델 칸을 누르면 고를 수 있음`);
      } catch (err) { toast("못 불러옴: " + err.message); }
      btn.disabled = false; btn.textContent = "모델 목록 불러오기";
    });
    document.getElementById("export").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(store.data.messages, null, 2)], { type: "application/json" }));
      a.download = "제미니채팅.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    document.getElementById("reset").addEventListener("click", () => {
      if (confirm("대화를 전부 지움. 되돌릴 수 없음. (열쇠·설정은 남음)")) store.reset();
    });
  }
}

document.getElementById("screen").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act=copy]");
  if (!btn) return;
  const m = store.data.messages.find((x) => x.id === btn.closest("[data-id]").dataset.id);
  if (m) navigator.clipboard?.writeText(m.text).then(() => toast("복사함"), () => toast("복사 못 함"));
});

addEventListener("hashchange", render);
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
