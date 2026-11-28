// 글자뽑기 — 긴 스크린샷을 조각으로 잘라 제미니에게 글자를 받아 적게 하고, 이어 붙여 복사하게 해 준다.
// 화면 세 개: 뽑기(pick)·기록(list)·설정(settings). 기록 하나를 여는 화면(view)이 하나 더 있다.

const KEY = "글자뽑기/v1";
const API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-flash-latest";
const MAX_ITEMS = 50;      // 기록은 이만큼만 둔다 (localStorage는 5MB쯤)
const SLICE_W = 1200;      // 조각 너비 상한(px). 이보다 넓으면 줄인다
const SLICE_H = 1600;      // 조각 높이(px, 줄인 뒤 기준)
const SEEK = 400;          // 자를 자리를 찾을 때 조각 아래쪽에서 훑는 높이
const OVERLAP = 140;       // 빈 줄을 못 찾았을 때 겹쳐 자르는 높이
const PARALLEL = 3;        // 한 번에 보내는 조각 수

const PROMPT = `이 그림은 긴 스크린샷을 위에서부터 자른 조각 하나다. 그림에 보이는 글자를 위에서 아래로 빠짐없이 그대로 옮겨 적어라.
- 고치거나 요약하거나 번역하지 않는다. 오타도 보이는 그대로 둔다.
- 한 문단이 화면 폭 때문에 여러 줄로 꺾인 것은 한 줄로 잇고, 문단이 바뀌는 곳에서만 줄을 바꾼다.
- 설명, 머리말, 코드블록 표시 없이 옮겨 적은 글자만 낸다.
- 글자가 하나도 없으면 아무것도 내지 않는다.`;
const PROMPT_CUT = `\n- 맨 위나 맨 아래에서 잘려 반만 보이는 줄은 적지 않는다.`;

// ── 데이터 모양 ──────────────────────────────────────────────
// 항목 하나: { id, at, text, pieces }
const SHAPE = () => ({ items: [], settings: { apiKey: "", model: DEFAULT_MODEL } });

const store = {
  data: load(),
  save() {
    for (;;) {
      try { localStorage.setItem(KEY, JSON.stringify(this.data)); return true; }
      catch (e) {
        // 꽉 찼으면 가장 옛 기록부터 버리고 다시 해 본다
        if (this.data.items.length > 1) this.data.items.pop();
        else { console.warn("저장 실패", e); return false; }
      }
    }
  },
  add(text, pieces) {
    const it = { id: crypto.randomUUID(), at: Date.now(), text, pieces };
    this.data.items.unshift(it);
    this.data.items.length = Math.min(this.data.items.length, MAX_ITEMS);
    this.save();
    return it.id;
  },
  setText(id, text) {
    const it = this.data.items.find((i) => i.id === id);
    if (it) { it.text = text; this.save(); }
  },
  remove(id) {
    this.data.items = this.data.items.filter((i) => i.id !== id);
    this.save();
  },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return SHAPE();
    const j = JSON.parse(raw);
    return {
      items: Array.isArray(j.items) ? j.items.filter((i) => i && i.id && typeof i.text === "string") : [],
      settings: { ...SHAPE().settings, ...(j.settings || {}) },
    };
  } catch { return SHAPE(); }
}

// ── 자르기 ──────────────────────────────────────────────────
// 그림 하나를 위에서부터 조각으로 자른다. 글줄을 반으로 가르지 않게, 조각 아래쪽에서
// 가로로 한 색뿐인 줄(글줄 사이 빈 곳)을 찾아 거기서 자른다. 못 찾으면 겹쳐 자른다.
// 돌려주는 것: [{ b64, cut }]  cut=true면 글줄이 잘렸을 수 있는 조각이다.
async function slice(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error(`그림을 열지 못함: ${file.name || "이름 없음"}`); }
  const k = Math.min(1, SLICE_W / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * k));
  const total = Math.round(bmp.height * k);        // 줄인 뒤 전체 높이
  const work = document.createElement("canvas");
  const ctx = work.getContext("2d", { willReadFrequently: true });
  const out = [];
  let y = 0;                                        // 줄인 뒤 기준, 이번 조각이 시작하는 줄
  let prevCut = false;
  while (y < total) {
    let h = Math.min(SLICE_H, total - y);
    work.width = w; work.height = h;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, y / k, bmp.width, h / k, 0, 0, w, h);
    let cut = false, next = y + h;
    if (y + h < total) {
      const row = blankRow(ctx, w, h);
      if (row > 0) { h = row; next = y + row; }
      else { cut = true; next = y + h - OVERLAP; }
    }
    const piece = document.createElement("canvas");
    piece.width = w; piece.height = h;
    piece.getContext("2d").drawImage(work, 0, 0);
    const b64 = piece.toDataURL("image/jpeg", 0.9).split(",")[1];
    out.push({ b64, cut: cut || prevCut });
    prevCut = cut;
    y = next;
  }
  bmp.close?.();
  return out;
}

// 조각 아래쪽 SEEK줄에서 한 색뿐인 줄이 가장 길게 이어진 곳(문단 사이일 때가 많다)의 가운데를 돌려준다.
// 길이가 같으면 더 아래쪽. 4줄 넘게 이어진 곳이 없으면 0.
function blankRow(ctx, w, h) {
  const top = Math.max(1, h - SEEK);
  const px = ctx.getImageData(0, top, w, h - top).data;
  const rows = h - top;
  const flat = (r) => {
    const o = r * w * 4;
    const r0 = px[o], g0 = px[o + 1], b0 = px[o + 2];
    for (let x = 2; x < w; x += 2) {
      const i = o + x * 4;
      if (Math.abs(px[i] - r0) + Math.abs(px[i + 1] - g0) + Math.abs(px[i + 2] - b0) > 30) return false;
    }
    return true;
  };
  let best = 0, bestLen = 4, end = -1;
  for (let r = rows - 1; r >= -1; r--) {
    if (r >= 0 && flat(r)) { if (end < 0) end = r; continue; }
    if (end >= 0 && end - r > bestLen) { bestLen = end - r; best = top + Math.round((end + r + 1) / 2); }
    end = -1;
  }
  return best;
}

// ── 제미니 ──────────────────────────────────────────────────
async function readPiece(piece, signal) {
  const s = store.data.settings;
  const body = {
    contents: [{ role: "user", parts: [
      { inline_data: { mime_type: "image/jpeg", data: piece.b64 } },
      { text: PROMPT + (piece.cut ? PROMPT_CUT : "") },
    ] }],
    generationConfig: { temperature: 0 },
  };
  let last;
  for (let n = 0; n < 3; n++) {
    if (n) await new Promise((r) => setTimeout(r, 1500 * n));
    let res;
    try {
      res = await fetch(`${API}/models/${encodeURIComponent(s.model.trim() || DEFAULT_MODEL)}:generateContent`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-goog-api-key": s.apiKey.trim() },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      last = new Error("인터넷이 끊겼거나 제미니에 닿지 못함");
      continue;
    }
    if (res.ok) {
      const j = await res.json();
      const c = j.candidates?.[0];
      const text = (c?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
      if (!text && (j.promptFeedback?.blockReason || (c?.finishReason && c.finishReason !== "STOP"))) {
        throw new Error(`제미니가 답하지 않음 (${j.promptFeedback?.blockReason || c.finishReason})`);
      }
      return clean(text);
    }
    const msg = await res.json().then((j) => j.error?.message, () => "") || "";
    if (res.status === 400 && /API key/i.test(msg)) throw new Error("API 열쇠가 틀림. 설정에서 다시 넣기");
    if (res.status === 401 || res.status === 403) throw new Error("API 열쇠가 틀리거나 권한이 없음. 설정에서 확인");
    if (res.status === 404) throw new Error(`모델 이름이 틀림: ${s.model}. 설정에서 고치기`);
    last = new Error(res.status === 429 ? "제미니 한도에 걸림. 잠시 뒤 다시" : `제미니 오류 ${res.status}${msg ? `: ${msg}` : ""}`);
    if (res.status !== 429 && res.status < 500) throw last;
  }
  throw last;
}

// 모델이 붙이기도 하는 코드블록 울타리를 걷어 낸다
const clean = (t) => t.replace(/^\s*```[a-z]*\n/i, "").replace(/\n```\s*$/, "").trim();

// ── 이어 붙이기 ─────────────────────────────────────────────
// 겹쳐 자른 조각은 같은 글이 앞 조각 끝과 뒤 조각 처음에 두 번 나온다. 뒤 조각에서 그만큼 뗀다.
// 빈칸을 뺀 글자로 견준다. 받아 적기가 조금 달라도 맞게 8할이 같으면 겹친 것으로 본다.
function join(a, b, overlapped) {
  if (!a) return b;
  if (!b) return a;
  if (!overlapped) return a + "\n" + b;
  const strip = (s) => { const ch = [], at = []; for (let i = 0; i < s.length; i++) if (!/\s/.test(s[i])) { ch.push(s[i]); at.push(i); } return { ch, at }; };
  const A = strip(a.slice(-1500)), B = strip(b);
  const PROBE = 10;
  for (let off = 0; off <= 40 && off + PROBE <= B.ch.length; off += 10) {
    const probe = B.ch.slice(off, off + PROBE).join("");
    const p = A.ch.join("").lastIndexOf(probe);
    if (p < 0) continue;
    const start = p - off;                       // A에서 겹침이 시작하는 자리 (B의 0번과 맞는 곳)
    const len = A.ch.length - Math.max(0, start); // 겹친 길이 = B에서 뗄 글자 수
    if (len <= 0 || len > B.ch.length) continue;
    let same = 0;
    for (let i = 0; i < len; i++) if (A.ch[A.ch.length - len + i] === B.ch[i]) same++;
    if (same / len < 0.8) continue;
    const rest = b.slice(B.at[len - 1] + 1);
    return a + (/^\s/.test(rest) || !rest ? "" : " ") + rest;
  }
  return a + "\n" + b;
}

// ── 뽑기 한 판 ──────────────────────────────────────────────
// job: null | { state: "work"|"done"|"err", done, total, text, id, err, note, abort }
let job = null;

async function run(files) {
  if (!store.data.settings.apiKey.trim()) { location.hash = "#/settings"; toast("API 열쇠를 먼저 넣기"); return; }
  const abort = new AbortController();
  job = { state: "work", done: 0, total: 0, text: "", abort };
  render();
  try {
    const pieces = [];           // { b64, cut, first }  first=그림의 첫 조각
    for (const f of files) {
      const ps = await slice(f);
      ps.forEach((p, i) => pieces.push({ ...p, first: i === 0 }));
    }
    if (job.abort !== abort) return;
    job.total = pieces.length; render();
    const texts = new Array(pieces.length);
    const fails = [];
    let next = 0;
    const worker = async () => {
      while (next < pieces.length) {
        const i = next++;
        try { texts[i] = await readPiece(pieces[i], abort.signal); }
        catch (e) {
          if (e.name === "AbortError") throw e;
          if (/열쇠|모델 이름/.test(e.message)) { abort.abort(); throw e; }
          texts[i] = ""; fails.push(`${i + 1}번째 조각: ${e.message}`);
        }
        pieces[i].b64 = "";      // 다 쓴 조각은 놓아준다
        if (job.abort === abort) { job.done++; progress(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, pieces.length) }, worker));
    if (job.abort !== abort) return;
    if (fails.length === pieces.length) throw new Error(fails[0].replace(/^.*?: /, ""));
    let text = "";
    pieces.forEach((p, i) => {
      if (p.first) text = text ? (texts[i] ? text + "\n\n" + texts[i] : text) : texts[i];
      else text = join(text, texts[i], p.cut && pieces[i - 1].cut);
    });
    text = text.trim();
    if (!text) throw new Error("그림에서 글자를 찾지 못함");
    job = { state: "done", text, id: store.add(text, pieces.length), note: fails.join("\n") };
  } catch (e) {
    if (job?.abort !== abort) return;
    job = { state: "err", err: e.name === "AbortError" ? "멈춤" : e.message };
  }
  render();
}

function progress() {
  const el = document.getElementById("prog");
  if (el && job?.state === "work") el.textContent = progText();
}
const progText = () => job.total ? `읽는 중 ${job.done}/${job.total} 조각` : "그림을 자르는 중";

// ── 화면 ────────────────────────────────────────────────────
const SCREENS = {
  pick() {
    if (job?.state === "work") return `
      <div class="center">
        <div class="spin" aria-hidden="true"></div>
        <p id="prog" role="status">${progText()}</p>
        <button class="ghost" id="stop">멈추기</button>
      </div>`;
    if (job?.state === "done") return `
      ${job.note ? `<p class="warn" role="alert">못 읽은 곳이 있음\n${esc(job.note)}</p>` : ""}
      <div class="acts">
        <button id="copy">복사</button>
        <button class="ghost" id="again">다른 그림</button>
      </div>
      <p class="hint">${job.text.length.toLocaleString()}자. 아래 칸에서 바로 고칠 수 있음. 기록에도 들어감.</p>
      <textarea id="out" class="out" spellcheck="false" aria-label="뽑은 글자">${esc(job.text)}</textarea>`;
    return `
      ${job?.state === "err" ? `<p class="warn" role="alert">${esc(job.err)}</p>` : ""}
      <label class="drop" for="file">
        <span class="big" aria-hidden="true">＋</span>
        <b>스크린샷 고르기</b>
        <span class="hint">긴 그림도 됨. 여러 장을 고르면 고른 차례로 이어 붙임.</span>
      </label>
      <input id="file" type="file" accept="image/*" multiple hidden>
      ${store.data.settings.apiKey.trim() ? "" : `<p class="hint">처음이면 <a href="#/settings">설정</a>에서 제미니 API 열쇠를 넣기.</p>`}`;
  },

  list() {
    const { items } = store.data;
    if (!items.length) return `<p class="empty">아직 없음.<br>‘뽑기’에서 스크린샷을 넣으면 여기 쌓임.</p>`;
    return `<ul class="list">${items.map((i) => `
      <li class="row" data-id="${i.id}">
        <a class="text" href="#/view/${i.id}">${esc(i.text.slice(0, 60))}</a>
        <time datetime="${new Date(i.at).toISOString()}">${when(i.at)}</time>
        <button class="mini" data-act="copy" aria-label="복사">복사</button>
        <button class="mini x" data-act="remove" aria-label="지우기">✕</button>
      </li>`).join("")}</ul>`;
  },

  view() {
    const it = store.data.items.find((i) => i.id === param());
    if (!it) return `<p class="empty">지워졌거나 없는 기록.</p>`;
    return `
      <div class="acts" data-id="${it.id}">
        <button data-act="copy">복사</button>
        <a class="btn ghost" href="#/list">기록으로</a>
      </div>
      <p class="hint">${when(it.at)} · ${it.text.length.toLocaleString()}자</p>
      <textarea id="out" class="out" spellcheck="false" aria-label="뽑은 글자">${esc(it.text)}</textarea>`;
  },

  settings() {
    const { items, settings: s } = store.data;
    return `
      <h2>제미니 API 열쇠</h2>
      <input id="apiKey" type="password" autocomplete="off" spellcheck="false" value="${esc(s.apiKey)}" placeholder="AIza…">
      <p class="hint">이 폰에만 저장됨. 글자를 뽑을 때 그림이 이 열쇠로 제미니(구글)에 보내짐.</p>
      <h2 style="margin-top:20px">모델</h2>
      <input id="model" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" value="${esc(s.model)}" placeholder="${DEFAULT_MODEL}">
      <p class="hint">비우면 ${DEFAULT_MODEL}.</p>
      <h2 style="margin-top:20px">기록</h2>
      <p class="hint">${items.length}개가 이 폰에만 저장돼 있음. ${MAX_ITEMS}개를 넘으면 옛것부터 지워짐.</p>
      <button class="danger" id="reset" ${items.length ? "" : "disabled"}>기록 전부 지우기</button>`;
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function when(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
  const d = new Date(ts);
  const 올해 = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("ko-KR", { ...(올해 ? {} : { year: "2-digit" }), month: "numeric", day: "numeric" });
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("복사됨"); }
  catch {
    const el = document.getElementById("out");
    if (el) { el.focus(); el.select(); }
    toast(el ? "복사가 막힘. 골라 둔 글을 길게 눌러 복사" : "복사가 막힘");
  }
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { pick: "글자뽑기", list: "기록", view: "기록", settings: "설정" };
const route = () => (location.hash.replace(/^#\/?/, "") || "pick").split("/")[0];
const param = () => location.hash.replace(/^#\/?/, "").split("/")[1] || "";

function render() {
  const name = SCREENS[route()] ? route() : "pick";
  document.getElementById("screen").innerHTML = SCREENS[name]();
  document.getElementById("title").textContent = TITLES[name];
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === (name === "view" ? "list" : name)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  wire(name);
}

function wire(name) {
  const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
  if (name === "pick") {
    on("file", "change", (e) => { const fs = [...e.target.files]; if (fs.length) run(fs); });
    on("stop", "click", () => { job.abort.abort(); job = null; render(); });
    on("copy", "click", () => copy(document.getElementById("out").value));
    on("again", "click", () => { job = null; render(); });
    on("out", "input", (e) => { job.text = e.target.value; store.setText(job.id, job.text); });
  }
  if (name === "view") {
    on("out", "input", (e) => store.setText(param(), e.target.value));
  }
  if (name === "settings") {
    on("apiKey", "input", (e) => { store.data.settings.apiKey = e.target.value.trim(); store.save(); });
    on("model", "input", (e) => { store.data.settings.model = e.target.value.trim() || DEFAULT_MODEL; store.save(); });
    on("reset", "click", () => {
      if (confirm("기록을 전부 지움. 되돌릴 수 없음.")) { store.data.items = []; store.save(); if (job?.state === "done") job = null; render(); }
    });
  }
}

document.getElementById("screen").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest("[data-id]").dataset.id;
  const it = store.data.items.find((i) => i.id === id);
  if (btn.dataset.act === "copy" && it) copy(document.getElementById("out")?.value ?? it.text);
  if (btn.dataset.act === "remove") {
    store.remove(id);
    if (job?.id === id) job = null;
    render();
  }
});

addEventListener("hashchange", render);
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
