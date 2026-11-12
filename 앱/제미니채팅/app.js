// 제미니채팅 — 제미니 API와 1대1 대화. 화면 셋(대화·장부·설정), 데이터 한 덩어리.
// 열쇠는 이 기기 localStorage에만 있다. 저장소에는 적지 않는다.

const KEY = "제미니채팅/v1";
const API = "https://generativelanguage.googleapis.com/v1beta";
const LEDGER_MAX = 100;

// 고르기만 하면 되는 모델들. 이름은 models API 목록에서 확인한 것(2026-11-12).
const PRESETS = [
  ["gemini-4-argon", "Gemini 4 Argon (아르곤)"],
  ["gemini-4-carbon", "Gemini 4 Carbon (카본)"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["gemini-pro-latest", "최신 Pro"],
  ["gemini-flash-latest", "최신 Flash"],
];
// API가 주는 막힘 사유를 사람 말로. 끌 수 있는 것과 없는 것을 갈라서 보여 준다.
const REASONS = {
  SAFETY: "안전 필터가 막음 (설정 → 고급 → 안전 필터가 OFF인지 확인)",
  PROHIBITED_CONTENT: "Google이 끌 수 없게 막는 내용",
  BLOCKLIST: "Google 금지어 목록에 걸림 (끌 수 없음)",
  SPII: "민감한 개인정보로 보여 막힘 (끌 수 없음)",
  IMAGE_SAFETY: "이미지 안전 문제로 막힘",
  RECITATION: "남의 글을 그대로 옮긴 것으로 보여 멈춤",
  OTHER: "Google이 이유를 알려 주지 않음",
  LANGUAGE: "지원하지 않는 언어",
};
const why = (code) => (REASONS[code] ? `${code} — ${REASONS[code]}` : code);
let loadedModels = []; // 설정에서 ‘전체 목록 불러오기’ 한 뒤 채워짐

function modelOptions(cur) {
  const known = new Set(PRESETS.map(([v]) => v));
  const rest = loadedModels.filter((m) => !known.has(m));
  const opt = (v, label) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
  let h = PRESETS.map(([v, l]) => opt(v, l)).join("");
  if (cur && !known.has(cur) && !rest.includes(cur)) h += opt(cur, `직접 입력: ${cur}`);
  if (rest.length) h += `<optgroup label="전체 목록">${rest.map((m) => opt(m, m)).join("")}</optgroup>`;
  return h;
}

// 안전 필터 4칸 + 시민 무결성(늘 설정값 중 가장 느슨한 쪽이 아니라 OFF로 시작해 같은 단계로 내림).
// 아동 안전 같은 핵심 보호는 API가 늘 막고 끌 수 없다.
// https://ai.google.dev/gemini-api/docs/safety-settings (2026-11-12 확인)
const CATS = [
  ["harassment", "HARM_CATEGORY_HARASSMENT", "괴롭힘"],
  ["hate", "HARM_CATEGORY_HATE_SPEECH", "혐오"],
  ["explicit", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "성적 표현"],
  ["danger", "HARM_CATEGORY_DANGEROUS_CONTENT", "위험 내용"],
];
const LEVELS = ["OFF", "BLOCK_NONE", "BLOCK_ONLY_HIGH", "BLOCK_MEDIUM_AND_ABOVE"];
const LEVEL_LABEL = { OFF: "OFF", BLOCK_NONE: "NONE", BLOCK_ONLY_HIGH: "HIGH", BLOCK_MEDIUM_AND_ABOVE: "MED+" };
// OFF를 서버가 거부하면 이 순서로 한 단계씩 내려서 다시 보낸다. 빈 칸 = 설정값 그대로.
const FALLBACK = ["", "BLOCK_NONE", "BLOCK_ONLY_HIGH"];

// ── 데이터 모양 ──────────────────────────────────────────────
// 말 하나:   { id, role: "user"|"model", text, at, err?, note?, cut? }
// 장부 한 줄: { at, md, inTok, ca, out, s }   (ca = 캐시에서 읽은 입력 토큰, out = 출력+생각 토큰)
const SHAPE = () => ({
  messages: [],
  ledger: [],
  settings: {
    apiKey: "",
    model: "gemini-4-argon",
    system: "",
    lexicon: "",
    temperature: 1,
    maxTok: 8192,
    safety: { harassment: "OFF", hate: "OFF", explicit: "OFF", danger: "OFF" },
  },
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
  lend(row) {
    this.data.ledger.unshift(row);
    if (this.data.ledger.length > LEDGER_MAX) this.data.ledger.length = LEDGER_MAX;
  },
  reset() { this.data.messages = []; this.save(); },
};

function validMsg(m) { return m && typeof m.text === "string" && (m.role === "user" || m.role === "model"); }
function fixMsg(m) { return { ...m, id: m.id || crypto.randomUUID(), at: m.at || Date.now() }; }

function mergeSettings(base, saved) {
  const s = { ...base, ...(saved && typeof saved === "object" ? saved : {}) };
  s.safety = { ...base.safety, ...(saved && saved.safety && typeof saved.safety === "object" ? saved.safety : {}) };
  for (const [k] of CATS) if (!LEVELS.includes(s.safety[k])) s.safety[k] = "OFF";
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return SHAPE();
    const d = JSON.parse(raw);
    const base = SHAPE();
    return {
      messages: Array.isArray(d.messages) ? d.messages.filter(validMsg).map(fixMsg) : [],
      ledger: Array.isArray(d.ledger) ? d.ledger.filter((r) => r && typeof r === "object").slice(0, LEDGER_MAX) : [],
      settings: mergeSettings(base.settings, d.settings),
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

// cap보다 느슨한 단계는 cap으로 올린다. cap이 빈 칸이면 설정값 그대로.
function safetyList(want, cap) {
  const lim = (v) => (cap && LEVELS.indexOf(v) < LEVELS.indexOf(cap) ? cap : v);
  const list = CATS.map(([k, cat]) => ({ category: cat, threshold: lim(want[k]) }));
  list.push({ category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: lim("OFF") });
  return list;
}

// 안전 필터 값을 서버가 거부하면(400 + 필터 관련 문구) 한 단계씩 내려서 다시 보낸다.
async function open(body, s, signal) {
  const url = `${API}/models/${encodeURIComponent(s.model.trim())}:streamGenerateContent?alt=sse`;
  const headers = { "content-type": "application/json", "x-goog-api-key": s.apiKey.trim() };
  for (let i = 0; i < FALLBACK.length; i++) {
    body.safetySettings = safetyList(s.safety, FALLBACK[i]);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (res.ok) {
      if (i) toast(`안전 필터 OFF가 거부돼 ${LEVEL_LABEL[FALLBACK[i]]}으로 내려 보냄`);
      return res;
    }
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    const filterIssue = res.status === 400 && /[Ss]afety|[Tt]hreshold|HARM_|\bOFF\b/.test(msg);
    if (!filterIssue || i === FALLBACK.length - 1) throw new Error(msg);
  }
}

async function ask() {
  const s = store.data.settings;
  const reply = store.push("model", "");
  store.saveQuiet();
  render();
  const bubble = () => document.querySelector(`[data-id="${reply.id}"] .text`);

  busy = new AbortController();
  setBusy(true);
  const t0 = Date.now();
  let usage = null;
  try {
    // 앞부분은 늘 같은 순서: 고정 시스템 프롬프트 → 사전설정집 → 대화(덧붙이기만)
    const sys = [s.system.trim(), s.lexicon.trim() && `[설정집]\n${s.lexicon.trim()}`].filter(Boolean).join("\n\n");
    const body = {
      contents: history(),
      generationConfig: {
        temperature: Number(s.temperature),
        maxOutputTokens: parseInt(s.maxTok, 10) || 8192,
      },
    };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };

    const res = await open(body, s, busy.signal);

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
        if (j.usageMetadata) usage = j.usageMetadata;
        if (j.promptFeedback?.blockReason)
          blocked = `질문이 막힘: ${why(j.promptFeedback.blockReason)}${j.promptFeedback.blockReasonMessage ? " · " + j.promptFeedback.blockReasonMessage : ""}`;
        const c = j.candidates?.[0];
        const t = (c?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (t) {
          reply.text += t;
          const b = bubble(); if (b) b.textContent = reply.text;
          follow();
        }
        if (c?.finishReason && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(c.finishReason))
          blocked = `답이 멈춤: ${why(c.finishReason)}`;
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
    if (usage) {
      store.lend({
        at: Date.now(),
        md: s.model.trim(),
        inTok: usage.promptTokenCount || 0,
        ca: usage.cachedContentTokenCount || 0,
        out: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        s: Math.round((Date.now() - t0) / 100) / 10,
      });
    }
    busy = null;
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
const n = (x) => Number(x || 0).toLocaleString("ko-KR");
const hhmm = (ts) => new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

function cachePct() {
  const r = store.data.ledger[0];
  return r && r.inTok ? Math.round((r.ca / r.inTok) * 100) : null;
}

const SCREENS = {
  chat() {
    const ms = store.data.messages;
    const noKey = !store.data.settings.apiKey.trim();
    const list = ms.length
      ? `<ul class="chat">${ms.map(bubbleHTML).join("")}</ul>`
      : `<p class="empty">${noKey ? "설정에서 제미니 API 열쇠를 먼저 넣기." : "아무 말이나 적어 보내기."}</p>`;
    const last = ms[ms.length - 1];
    const again = !busy && last && last.role === "model" ? `<button class="ghost small" id="retry">↻ 다시 뽑기</button>` : "";
    return `${list}
      <div class="again">${again}</div>
      <form id="composer" class="composer">
        <textarea id="msg" name="msg" rows="1" placeholder="메시지" enterkeyhint="send"
                  autocomplete="off" ${noKey ? "disabled" : ""}></textarea>
        <button type="submit" id="sendBtn" aria-label="보내기">${busy ? "■" : "↑"}</button>
      </form>`;
  },

  ledger() {
    const L = store.data.ledger;
    if (!L.length) return `<p class="empty">아직 요청이 없음.<br>대화를 한 번 하면 기록이 쌓임.</p>`;
    const sum = L.reduce((a, r) => ({ i: a.i + (r.inTok || 0), c: a.c + (r.ca || 0), o: a.o + (r.out || 0) }), { i: 0, c: 0, o: 0 });
    const last = L[0];
    const pct = cachePct() ?? 0;
    const rows = L.map((r) => `
      <tr><td>${hhmm(r.at)}</td><td class="md">${esc(String(r.md || "").replace(/^models\//, ""))}</td>
          <td>${n(r.inTok)}</td><td>${n(r.ca)}</td><td>${n(r.out)}</td><td>${r.s ?? ""}</td></tr>`).join("");
    return `
      <h2>캐시 상태</h2>
      <div class="meter" role="img" aria-label="마지막 요청 캐시 ${pct}%"><div style="width:${pct}%"></div></div>
      <p class="hint">마지막 요청: 입력 ${n(last.inTok)} 토큰 중 캐시 ${n(last.ca)} (${pct}%). API가 알려 준 값 그대로임. 이 값이 갑자기 줄면 앞부분(시스템 프롬프트·설정집·옛 대화)이 바뀐 것.</p>
      <h2 style="margin-top:16px">합계 <span class="hint">최근 ${L.length}번</span></h2>
      <p class="hint">입력 ${n(sum.i)} · 캐시 ${n(sum.c)} · 출력 ${n(sum.o)} 토큰 (출력엔 생각 토큰 포함)</p>
      <h2 style="margin-top:16px">장부</h2>
      <div class="tablewrap"><table class="ledger">
        <thead><tr><th>시각</th><th>모델</th><th>입력</th><th>캐시</th><th>출력</th><th>초</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <button class="ghost" id="clearLedger" style="margin-top:12px">장부 지우기</button>`;
  },

  settings() {
    const s = store.data.settings;
    const sel = ([k, , label]) => `
      <label class="sf">${label}
        <select data-sf="${k}">${LEVELS.map((v) =>
          `<option value="${v}" ${s.safety[k] === v ? "selected" : ""}>${LEVEL_LABEL[v]}</option>`).join("")}</select>
      </label>`;
    return `
      <form id="setForm" onsubmit="return false">
        <h2>API 열쇠</h2>
        <input id="apiKey" type="password" autocomplete="off" spellcheck="false"
               value="${esc(s.apiKey)}" placeholder="AIza…">
        <p class="hint">이 기기 브라우저에만 저장됨. 내보내기 파일에는 안 들어감. <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">AI Studio</a>에서 받기.</p>

        <h2>모델</h2>
        <select id="modelPick">${modelOptions(s.model)}</select>
        <p class="hint">아르곤·카본은 새로 나온 모델. 열쇠와 같은 계정에서 쓸 수 있어야 함. 안 되면 대화 칸에 오류가 뜸.</p>

        <h2>고정 시스템 프롬프트 <span class="hint" id="sysLen">${n(s.system.length)}자</span></h2>
        <textarea id="system" rows="6" placeholder="역할, 말투, 규칙… 길이 제한 없음">${esc(s.system)}</textarea>
        <p class="hint">맨 위에 고정. 대화 도중 고치면 앞부분이 달라져 캐시가 새로 쌓임.</p>

        <h2>사전설정집 <span class="hint" id="lexLen">${n(s.lexicon.length)}자</span></h2>
        <textarea id="lexicon" rows="8" placeholder="인물·세계관·말투 사전. 요약 말고 사전으로">${esc(s.lexicon)}</textarea>
        <p class="hint">시스템 프롬프트 바로 뒤에 통째로 같이 감.</p>

        <details class="adv">
          <summary>고급 설정 — 안 건드려도 됨</summary>

          <h2>모델 이름 직접 입력</h2>
          <input id="model" type="text" list="models" autocomplete="off" spellcheck="false" value="${esc(s.model)}">
          <datalist id="models"></datalist>
          <button class="ghost" id="loadModels" type="button">전체 모델 목록 불러오기</button>
          <p class="hint">위 모델 칸에 없는 모델을 쓰고 싶을 때만. 불러오면 위 칸에도 전부 들어감.</p>

          <h2>온도 <span id="tempVal" class="hint">${s.temperature}</span></h2>
          <input id="temperature" type="range" min="0" max="2" step="0.1" value="${s.temperature}">
          <p class="hint">답이 얼마나 제멋대로인지. 낮을수록(0~0.5) 늘 비슷하고 정확한 답, 높을수록(1.2~2) 매번 달라지고 엉뚱해짐. 모르겠으면 1 그대로.</p>

          <h2>한 번 출력 한도 (토큰)</h2>
          <input id="maxTok" type="number" inputmode="numeric" min="1" step="1" value="${esc(s.maxTok)}">
          <p class="hint">한 번에 쓸 수 있는 답의 최대 길이. 한글은 대략 한 글자에 1~2토큰. 답이 중간에 잘리면 올리기.</p>

          <h2>안전 필터</h2>
          <div class="sfgrid">${CATS.map(sel).join("")}</div>
          <p class="hint">OFF를 서버가 거부하면 자동으로 NONE → HIGH 순으로 내려 다시 보냄. 아동 안전 등 핵심 보호는 Google이 늘 막고 끌 수 없음.</p>
        </details>

        <h2 style="margin-top:12px">대화</h2>
        <p class="hint">${store.data.messages.length}개 말이 이 기기에만 저장돼 있음.</p>
        <button class="ghost" id="export" type="button">내보내기 (JSON)</button>
        <button class="ghost" id="import" type="button">가져오기 (JSON)</button>
        <input id="importFile" type="file" accept="application/json,.json" hidden>
        <button class="danger" id="reset" type="button">대화 전부 지우기</button>
        <button class="danger" id="wipe" type="button">처음으로 (열쇠·설정까지 전부)</button>
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
  const p = cachePct();
  document.getElementById("count").textContent = on ? "답하는 중…" : p === null ? "" : `캐시 ${p}%`;
}

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { chat: "제미니채팅", ledger: "장부", settings: "설정" };
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
  if (name === "ledger") {
    document.getElementById("clearLedger")?.addEventListener("click", () => {
      if (confirm("장부를 지움.")) { store.data.ledger = []; store.save(); }
    });
  }
  if (name === "settings") wireSettings();
}

function wireSettings() {
  const s = store.data.settings;
  const bind = (id, key, { num, after } = {}) => document.getElementById(id).addEventListener("input", (e) => {
    s[key] = num ? Number(e.target.value) : e.target.value;
    after?.(e.target.value);
    store.saveQuiet();
  });
  bind("apiKey", "apiKey");
  const pick = document.getElementById("modelPick");
  const text = document.getElementById("model");
  pick.addEventListener("change", () => { s.model = pick.value; text.value = s.model; store.saveQuiet(); });
  text.addEventListener("input", () => { s.model = text.value; pick.innerHTML = modelOptions(s.model.trim()); store.saveQuiet(); });
  bind("system", "system", { after: (v) => (document.getElementById("sysLen").textContent = n(v.length) + "자") });
  bind("lexicon", "lexicon", { after: (v) => (document.getElementById("lexLen").textContent = n(v.length) + "자") });
  bind("temperature", "temperature", { num: true, after: (v) => (document.getElementById("tempVal").textContent = v) });
  document.getElementById("maxTok").addEventListener("input", (e) => {
    s.maxTok = e.target.value === "" ? "" : Number(e.target.value);
    store.saveQuiet();
  });
  document.querySelectorAll("[data-sf]").forEach((el) => el.addEventListener("change", (e) => {
    s.safety[e.target.dataset.sf] = e.target.value;
    store.saveQuiet();
  }));

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
      loadedModels = names;
      document.getElementById("models").innerHTML = names.map((x) => `<option value="${esc(x)}">`).join("");
      pick.innerHTML = modelOptions(s.model.trim());
      toast(`${names.length}개 — 위 모델 칸에서 고를 수 있음`);
    } catch (err) { toast("못 불러옴: " + err.message); }
    btn.disabled = false; btn.textContent = "전체 모델 목록 불러오기";
  });

  document.getElementById("export").addEventListener("click", () => {
    const { apiKey, ...settings } = s; // 열쇠는 백업 파일에 넣지 않는다
    const out = { messages: store.data.messages, settings, ledger: store.data.ledger };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    a.download = "제미니채팅.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000); // 바로 치우면 일부 브라우저에서 다운로드가 끊김
  });

  const file = document.getElementById("importFile");
  document.getElementById("import").addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const msgs = Array.isArray(j) ? j : j.messages;
      if (!Array.isArray(msgs)) throw new Error("대화(messages)가 없는 파일");
      const ok = msgs.filter(validMsg).map(fixMsg);
      if (!confirm(`대화 ${ok.length}개로 바꿈. 지금 대화는 사라짐. (열쇠는 그대로)`)) return;
      store.data.messages = ok;
      if (!Array.isArray(j) && j.settings && typeof j.settings === "object") {
        const { apiKey, ...rest } = j.settings;
        store.data.settings = mergeSettings(store.data.settings, rest);
      }
      if (!Array.isArray(j) && Array.isArray(j.ledger)) store.data.ledger = j.ledger.slice(0, LEDGER_MAX);
      store.save();
      toast("가져왔음");
    } catch (err) { toast("가져오기 실패: " + err.message); }
    file.value = "";
  });

  document.getElementById("reset").addEventListener("click", () => {
    if (confirm("대화를 전부 지움. 되돌릴 수 없음. (열쇠·설정은 남음)")) store.reset();
  });
  document.getElementById("wipe").addEventListener("click", () => {
    if (confirm("대화·열쇠·설정·장부를 전부 지움. 되돌릴 수 없음.")) { store.data = SHAPE(); store.save(); }
  });
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
