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

// 이름 붙여 저장해 두는 설정 묶음(프리셋). 열쇠와 글자 크기(기기 취향)는 넣지 않는다.
const PRESET_KEYS = ["system", "lexicon", "model", "temperature", "maxTok", "safety", "choices"];
const PRESET_MAX = 30;

// ── 첨부 파일 ──
// 파일 내용은 localStorage가 아니라 IndexedDB에 둔다(5MB 안팎 한도를 금방 넘기 때문). 말에는 이름·크기만 남긴다.
const FILE_MAX_COUNT = 10;               // 한 번에 붙일 수 있는 개수
const INLINE_MAX = 14 * 1024 * 1024;     // 요청 하나에 실을 파일 합계(바이트). 요청 전체 20MB(글 포함, base64로 4/3배)에 들게
const TEXT_MAX = 2 * 1024 * 1024;        // 글 파일 하나의 최대 크기
const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "html", "htm", "xml", "log", "srt", "vtt", "yaml", "yml", "ini", "js", "ts", "py", "css", "java", "c", "cpp", "h", "sh", "sql"]);
const OOXML = "application/vnd.openxmlformats-officedocument.";
// 확장자로 MIME을 정한다(브라우저가 비워 두거나 다르게 줄 때가 많아서). 형식은 공식 문서에 나온 것만.
const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  pdf: "application/pdf",
  docx: OOXML + "wordprocessingml.document", pptx: OOXML + "presentationml.presentation", xlsx: OOXML + "spreadsheetml.sheet",
  wav: "audio/wav", mp3: "audio/mp3", m4a: "audio/m4a", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac",
  aiff: "audio/aiff", aif: "audio/aiff", opus: "audio/opus",
};

const idb = (() => {
  const mem = new Map(); // IndexedDB를 못 쓰는 브라우저용 임시 보관(이 창이 열려 있는 동안만)
  let dbp = null, memOnly = false;
  const open = () => dbp || (dbp = new Promise((ok, no) => {
    try {
      const r = indexedDB.open("제미니채팅-파일", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("f");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
      r.onblocked = () => no(new Error("blocked"));
    } catch (e) { no(e); }
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((ok, no) => {
      const tx = db.transaction("f", mode);
      const req = fn(tx.objectStore("f"));
      tx.oncomplete = () => ok(req ? req.result : undefined);
      tx.onerror = tx.onabort = () => no(tx.error || new Error("tx"));
    });
  };
  return {
    async put(id, blob) { // 이 기기에 남겼으면 true, 임시 보관뿐이면 false
      if (!memOnly) { try { await run("readwrite", (s) => s.put(blob, id)); return true; } catch { memOnly = true; } }
      mem.set(id, blob);
      return false;
    },
    async get(id) {
      if (mem.has(id)) return mem.get(id);
      if (memOnly) return null;
      try { return (await run("readonly", (s) => s.get(id))) || null; } catch { return null; }
    },
    async del(ids) {
      for (const id of ids) mem.delete(id);
      if (memOnly || !ids.length) return;
      try { await run("readwrite", (s) => { for (const id of ids) s.delete(id); }); } catch {}
    },
    async clear() { mem.clear(); if (memOnly) return; try { await run("readwrite", (s) => s.clear()); } catch {} },
  };
})();

function dropFiles(msgs, keep = new Set()) { // 지워지는 말에 붙은 파일 내용도 치운다
  idb.del(msgs.flatMap((m) => (m.files || []).map((f) => f.id)).filter((id) => !keep.has(id)));
}
const b64 = (blob) => new Promise((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(",")[1] || "");
  r.onerror = () => no(r.error);
  r.readAsDataURL(blob);
});
function fmtSize(n) { return n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB` : `${(n / 1048576).toFixed(1)}MB`; }
function fileIcon(f) {
  return f.kind === "text" ? "📝" : /^image\//.test(f.mime) ? "🖼" : f.mime === "application/pdf" ? "📄" : /^audio\//.test(f.mime) ? "🎵" : "📎";
}
function classify(f) {
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if (TEXT_EXT.has(ext)) return { kind: "text", mime: "text/plain" };
  if (MIME_BY_EXT[ext]) return { kind: "bin", mime: MIME_BY_EXT[ext] };
  if (/^text\//.test(f.type)) return { kind: "text", mime: "text/plain" };
  if (/^image\/(png|jpeg|webp|heic|heif)$/.test(f.type) || f.type === "application/pdf") return { kind: "bin", mime: f.type };
  const hint = ext === "hwp" || ext === "hwpx" ? " — 한글 파일은 PDF나 txt로 저장해서 올리기" : ext === "gif" ? " — png나 jpg로 바꿔서 올리기" : "";
  return { error: `‘${f.name}’은(는) 못 읽는 형식임${hint}. 가능: txt·md·PDF·docx·이미지·소리` };
}
// 글 파일을 읽는다. 한국어 .txt는 UTF-8이 아니라 EUC-KR(CP949)인 경우가 많아서, UTF-8로 안 읽히면 EUC-KR로 읽는다.
async function readText(f) {
  const u = new Uint8Array(await f.arrayBuffer());
  if (u[0] === 0xff && u[1] === 0xfe) return new TextDecoder("utf-16le").decode(u).replace(/^\uFEFF/, "");
  if (u[0] === 0xfe && u[1] === 0xff) return new TextDecoder("utf-16be").decode(u).replace(/^\uFEFF/, "");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(u).replace(/^\uFEFF/, ""); }
  catch { try { return new TextDecoder("euc-kr").decode(u); } catch { return new TextDecoder("utf-8").decode(u); } }
}

// ── 데이터 모양 ──────────────────────────────────────────────
// 말 하나:   { id, role: "user"|"model", text, at, err?, note?, cut? }
// 장부 한 줄: { at, md, inTok, ca, out, s }   (ca = 캐시에서 읽은 입력 토큰, out = 출력+생각 토큰)
const SHAPE = () => ({
  messages: [],
  ledger: [],
  presets: [],
  settings: {
    apiKey: "",
    model: "gemini-4-argon",
    system: "",
    lexicon: "",
    temperature: 1,
    maxTok: 8192,
    fontSize: 17,
    choices: true,
    autoResume: true,
    safety: { harassment: "OFF", hate: "OFF", explicit: "OFF", danger: "OFF" },
  },
});

const store = {
  data: load(),
  saveOk: true, // 마지막 저장이 됐는지. 안 됐으면 화면에 계속 경고를 띄운다
  saveQuiet() {
    let ok = true;
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
    catch (e) {
      ok = false;
      console.warn("저장 실패", e);
      toast("저장 안 됨 — 이 기기 저장 공간이 가득 참. 설정집·대화를 줄이거나 내보낸 뒤 지우기");
    }
    this.saveOk = ok;
    showSaveState();
    return ok;
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
  reset() { dropFiles(this.data.messages); this.data.messages = []; this.save(); },
};

function validMsg(m) { return m && typeof m.text === "string" && (m.role === "user" || m.role === "model"); }
function fixMsg(m) {
  const o = { ...m, id: m.id || crypto.randomUUID(), at: m.at || Date.now() };
  if (Array.isArray(o.files)) {
    o.files = o.files.filter((f) => f && typeof f.id === "string" && typeof f.name === "string")
      .map((f) => ({ id: f.id, name: f.name.slice(0, 120), mime: String(f.mime || ""), size: Number(f.size) || 0, kind: f.kind === "text" ? "text" : "bin" }));
  }
  if (!o.files || !o.files.length) delete o.files;
  if (o.pending) { // 답이 오던 중에 앱이 꺼진 것: 받은 글은 지키고 끊긴 답으로 표시한다
    delete o.pending;
    if (o.role === "model") {
      if (o.text.trim()) { o.broken = true; o.note = o.note || "연결이 끊김"; }
      else o.err = o.err || "답이 오기 전에 끊김 — ‘다시 뽑기’를 누르기";
    }
  }
  return o;
}

function mergeSettings(base, saved) {
  const s = { ...base, ...(saved && typeof saved === "object" ? saved : {}) };
  s.safety = { ...base.safety, ...(saved && saved.safety && typeof saved.safety === "object" ? saved.safety : {}) };
  for (const [k] of CATS) if (!LEVELS.includes(s.safety[k])) s.safety[k] = "OFF";
  return s;
}

// 파일이나 옛 저장값에서 온 설정 중 쓸 수 있는 칸만 남긴다.
function cleanPreset(o) {
  const s = {};
  if (!o || typeof o !== "object") return s;
  if (typeof o.system === "string") s.system = o.system;
  if (typeof o.lexicon === "string") s.lexicon = o.lexicon;
  if (typeof o.model === "string" && o.model.trim()) s.model = o.model.trim();
  const tp = Number(o.temperature);
  if (o.temperature !== "" && o.temperature != null && Number.isFinite(tp) && tp >= 0 && tp <= 2) s.temperature = tp;
  const mt = Number(o.maxTok);
  if (o.maxTok !== "" && o.maxTok != null && Number.isFinite(mt) && mt >= 1 && mt <= 1000000) s.maxTok = Math.floor(mt);
  if (typeof o.choices === "boolean") s.choices = o.choices;
  if (o.safety && typeof o.safety === "object") {
    s.safety = {};
    for (const [k] of CATS) if (LEVELS.includes(o.safety[k])) s.safety[k] = o.safety[k];
  }
  return s;
}
function validPreset(p) { return !!(p && typeof p.name === "string" && p.name.trim() && p.settings && typeof p.settings === "object"); }
function fixPreset(p) { return { id: p.id || crypto.randomUUID(), name: p.name.trim().slice(0, 40), at: p.at || Date.now(), settings: cleanPreset(p.settings) }; }
function takePreset(s) { // 지금 설정에서 프리셋에 넣을 칸만 뽑는다
  const o = {};
  for (const k of PRESET_KEYS) o[k] = k === "safety" ? { ...s.safety } : s[k];
  return cleanPreset(o);
}
function applyPreset(p) { // 프리셋에 든 칸만 덮는다. 열쇠·글자 크기는 그대로
  const cur = store.data.settings, c = cleanPreset(p.settings);
  store.data.settings = { ...cur, ...c, safety: { ...cur.safety, ...(c.safety || {}) } };
}
function mergePresets(cur, incoming) { // 이름이 같으면 덮어쓰고, 새 이름은 더한다
  const out = [...cur]; let added = 0, replaced = 0, dropped = 0;
  for (const p of incoming.filter(validPreset).map(fixPreset)) {
    const i = out.findIndex((x) => x.name === p.name);
    if (i >= 0) { out[i] = { ...p, id: out[i].id }; replaced++; }
    else if (out.length >= PRESET_MAX) dropped++;
    else { out.push(p); added++; }
  }
  return { list: out, added, replaced, dropped };
}
function download(name, obj) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000); // 바로 치우면 일부 브라우저에서 다운로드가 끊김
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return SHAPE();
    const d = JSON.parse(raw);
    const base = SHAPE();
    return {
      messages: Array.isArray(d.messages) ? d.messages.filter(validMsg).map(fixMsg) : [],
      presets: Array.isArray(d.presets) ? d.presets.filter(validPreset).map(fixPreset).slice(0, PRESET_MAX) : [],
      ledger: Array.isArray(d.ledger) ? d.ledger.filter((r) => r && typeof r === "object").slice(0, LEDGER_MAX) : [],
      settings: mergeSettings(base.settings, d.settings),
    };
  } catch { return SHAPE(); }
}

// ── 제미니 호출 ─────────────────────────────────────────────
let busy = null; // 진행 중인 AbortController

async function history() {
  const msgs = store.data.messages;
  // 용량: 새 첨부부터 세어 INLINE_MAX를 넘으면 오래된 첨부는 안내 글만 보낸다
  const keep = new Set();
  let budget = INLINE_MAX;
  for (let i = msgs.length - 1; i >= 0; i--) {
    for (const f of [...(msgs[i].files || [])].reverse()) if (f.size <= budget) { keep.add(f.id); budget -= f.size; }
  }
  // 오류 난 답과 빈 말은 보내지 않는다. 연달아 같은 역할이 오면 API가 싫어하므로 합친다.
  const out = [];
  for (const m of msgs) {
    const files = m.files || [];
    if (m.err || (!m.text.trim() && !files.length)) continue;
    const parts = [];
    for (const f of files) {
      const blob = keep.has(f.id) ? await idb.get(f.id) : null;
      if (!keep.has(f.id)) parts.push({ text: `[이전 첨부 파일 ‘${f.name}’은(는) 용량 때문에 이번 요청에서 빠짐]` });
      else if (!blob) parts.push({ text: `[첨부 파일 ‘${f.name}’은(는) 이 기기에 없어서 빠짐]` });
      else if (f.kind === "text") parts.push({ text: `[첨부 파일: ${f.name}]\n${await blob.text()}\n[첨부 파일 끝]` });
      else parts.push({ text: `[첨부 파일: ${f.name}]` }, { inline_data: { mime_type: f.mime, data: await b64(blob) } });
    }
    if (m.text.trim()) parts.push({ text: m.text });
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.parts.push({ text: "\n\n" }, ...parts);
    else out.push({ role: m.role, parts });
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

// 다른 창으로 나가면 브라우저가 페이지를 얼리거나 네트워크를 끊을 수 있다(웹앱이 막을 수 없음).
// 그래서 받은 글을 계속 저장해 두고, 끊기면 그 글 뒤부터 이어 받는다.
const STALL_MS = 25000;   // 화면에 돌아온 뒤 이 시간 동안 새 글이 없으면 끊긴 것으로 본다
const RESUME_MAX = 2;     // 자동으로 이어 받는 횟수. 넘으면 ‘이어 쓰기’ 버튼으로
const CONTINUE_ASK = "끊겼어. 방금 쓰던 글 바로 다음부터 이어서 끝까지 써줘. 앞부분은 다시 쓰지 마.";
let lastChunk = 0;
let persistT = 0;

const whenVisible = () => document.visibilityState === "visible" ? Promise.resolve()
  : new Promise((ok) => document.addEventListener("visibilitychange", function h() {
      if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", h); ok(); }
    }));

// 끊긴 글에서 마지막으로 문장이 끝난 자리(문장부호·닫는 따옴표 뒤, 또는 줄바꿈 뒤)의 위치. 끝난 문장이 없으면 0.
function lastSentenceEnd(text) {
  const re = /[.!?…。]+["'”’)」』]*(?=\s|$)|\n+/g;
  let m, end = 0;
  while ((m = re.exec(text))) end = m.index + m[0].length;
  return end;
}

// cont가 있으면 그 답의 뒤를 이어 받는다(받은 글이 없으면 처음부터).
async function ask(cont) {
  const s = store.data.settings;
  const reply = cont || store.push("model", "");
  const resuming = !!(cont && cont.text.trim());
  if (cont) { delete cont.err; delete cont.note; cont.broken = false; cont.stopped = false; cont.cut = false; }
  if (resuming) { // 문장 중간에서 끊긴 조각은 버리고, 마지막으로 끝난 문장 뒤부터 이어 받는다
    const cut = lastSentenceEnd(reply.text);
    if (cut) reply.text = reply.text.slice(0, cut);
  }
  reply.pending = true;
  store.saveQuiet();
  render();
  const bubble = () => document.querySelector(`[data-id="${reply.id}"] .text`);

  const ctl = busy = new AbortController();
  setBusy(true);
  const t0 = Date.now();
  lastChunk = t0;
  let usage = null, streaming = false, resume = false, got = 0;
  try {
    // 앞부분은 늘 같은 순서: 고정 시스템 프롬프트 → 사전설정집 → 대화(덧붙이기만)
    const sys = [s.system.trim(), s.lexicon.trim() && `[설정집]\n${s.lexicon.trim()}`].filter(Boolean).join("\n\n");
    const contents = await history();
    if (resuming) contents.push({ role: "user", parts: [{ text: CONTINUE_ASK }] }); // 저장하지 않는 한 줄
    const body = {
      contents,
      generationConfig: {
        temperature: Number(s.temperature),
        maxOutputTokens: parseInt(s.maxTok, 10) || 8192,
      },
    };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };

    const res = await open(body, s, ctl.signal);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", blocked = "", first = resuming;
    streaming = true;
    for (;;) {
      const { value, done } = await reader.read();
      lastChunk = Date.now();
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
        let t = (c?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (t) {
          // 이어 받는 첫 글이 문장부호 뒤에서 붙으면 띄어 준다
          if (first) { first = false; if (/[.,!?…)"'”’」』]$/.test(reply.text) && !/^\s/.test(t)) t = " " + t; }
          reply.text += t; got += t.length;
          const b = bubble(); if (b) b.innerHTML = fmt(reply.text);
          updateJump();
          if (Date.now() - persistT > 800) { persistT = Date.now(); store.saveQuiet(); } // 앱이 꺼져도 받은 글이 남게
        }
        if (c?.finishReason && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(c.finishReason))
          blocked = `답이 멈춤: ${why(c.finishReason)}`;
        if (c?.finishReason === "MAX_TOKENS") reply.cut = true;
      }
    }
    streaming = false;
    if (!reply.text && blocked) throw new Error(blocked);
    if (!reply.text) throw new Error("빈 답이 옴");
    if (blocked) reply.note = blocked;
    else if (resuming && !got) reply.note = "이어 쓸 글이 더 없음";
  } catch (e) {
    if (e.name === "AbortError" && !ctl.stalled) { // 사용자가 ■를 누름
      if (!reply.text) reply.err = "멈춤";
      else { reply.note = "중간에 멈춤"; reply.stopped = true; }
    } else if (streaming || ctl.stalled) { // 글이 오던 중에 끊김(다른 창으로 나감, 망 끊김 등)
      if (reply.text.trim()) { reply.broken = true; reply.note = "연결이 끊김"; }
      else reply.err = "답이 오기 전에 끊김 — ‘다시 뽑기’를 누르기";
      resume = (reply.tries || 0) < RESUME_MAX && s.autoResume && navigator.onLine !== false && !!s.apiKey.trim();
      if (resume) { reply.tries = (reply.tries || 0) + 1; reply.note = "연결이 끊김 — 곧 이어 받음"; delete reply.err; }
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
    delete reply.pending;
    busy = null;
    store.save();
  }
  if (resume) return resumeLater(reply);
}

// 화면이 보일 때까지 기다렸다가 이어 받는다. 대기는 한 번에 하나만, 그 사이 대화가 바뀌었으면 하지 않는다.
let waiting = false;
async function resumeLater(reply) {
  if (waiting) return;
  waiting = true;
  try { await whenVisible(); } finally { waiting = false; }
  const ms = store.data.messages;
  if (!busy && ms[ms.length - 1] === reply) return ask(reply);
}

// 이어 쓰기 버튼: 끊기거나, 길이 한도에서 잘렸거나, 내가 멈춘 답의 뒤를 이어 받는다.
function continueLast() {
  if (busy) return;
  const ms = store.data.messages, last = ms[ms.length - 1];
  if (!last || last.role !== "model") return;
  last.tries = 0;
  jumpToBottom = true;
  ask(last);
}

let pending = [];   // 아직 안 보낸 첨부 파일 { id, name, mime, size, kind, blob }
let sending = false;
async function send(text) {
  if (busy || sending) return;
  if (!store.data.settings.apiKey.trim()) { location.hash = "#/settings"; toast("API 열쇠를 먼저 넣기"); return; }
  sending = true;
  try {
    const files = pending;
    let kept = true;
    for (const f of files) kept = (await idb.put(f.id, f.blob)) && kept;
    store.push("user", text, files.length ? { files: files.map(({ id, name, mime, size, kind }) => ({ id, name, mime, size, kind })) } : {});
    pending = [];
    if (!kept) toast("이 브라우저는 파일을 저장하지 못함 — 이 창을 닫으면 첨부 파일이 사라짐");
    store.saveQuiet();
    jumpToBottom = true;
  } finally { sending = false; }
  ask();
}

async function attachFiles(list) {
  const errs = [];
  let total = pending.reduce((a, f) => a + f.size, 0);
  for (const f of list) {
    if (pending.length >= FILE_MAX_COUNT) { errs.push(`한 번에 ${FILE_MAX_COUNT}개까지`); break; }
    const c = classify(f);
    if (c.error) { errs.push(c.error); continue; }
    try {
      let blob = f, size = f.size;
      if (c.kind === "text") {
        if (f.size > TEXT_MAX) { errs.push(`‘${f.name}’은(는) 글 파일이 너무 큼 (${fmtSize(TEXT_MAX)}까지)`); continue; }
        blob = new Blob([await readText(f)], { type: "text/plain" });
        size = blob.size;
      }
      if (!size) { errs.push(`‘${f.name}’은(는) 비어 있음`); continue; }
      if (total + size > INLINE_MAX) { errs.push(`‘${f.name}’은(는) 용량이 커서 못 넣음 (한 번에 ${fmtSize(INLINE_MAX)}까지)`); continue; }
      total += size;
      pending.push({ id: crypto.randomUUID(), name: f.name, mime: c.mime, size, kind: c.kind, blob });
    } catch { errs.push(`‘${f.name}’을(를) 못 읽음`); }
  }
  render();
  if (errs.length) toast(errs.slice(0, 2).join(" / ") + (errs.length > 2 ? ` 외 ${errs.length - 2}건` : ""));
}

function retry() {
  if (busy) return;
  const ms = store.data.messages;
  while (ms.length && ms[ms.length - 1].role === "model") ms.pop();
  if (!ms.length) return store.save();
  store.saveQuiet();
  jumpToBottom = true;
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
    const canCont = !busy && last && last.role === "model" && !last.err && last.text.trim() && (last.broken || last.cut || last.stopped);
    const again = !busy && last && last.role === "model"
      ? `${canCont ? `<button class="small" id="cont">▶ 이어 쓰기</button>` : ""}<button class="ghost small" id="retry">↻ 다시 뽑기</button>` : "";
    const opts = !busy && store.data.settings.choices && last && last.role === "model" && !last.err && !last.broken ? choices(last.text) : [];
    const btns = opts.length
      ? `<div class="choices" role="group" aria-label="선택지">${opts.map((o, i) =>
          `<button type="button" class="choice" data-choice="${i}">${esc(o)}</button>`).join("")}</div>` : "";
    return `${list}
      <div class="after">${btns}<div class="again">${again}</div></div>
      <form id="composer" class="composer">
        ${pending.length ? `<div class="pchips">${pending.map((f, i) => `<span class="fchip">${fileIcon(f)} ${esc(f.name)} · ${fmtSize(f.size)}<button type="button" data-fx="${i}" aria-label="${esc(f.name)} 빼기">✕</button></span>`).join("")}</div>` : ""}
        <button type="button" id="attach" class="clip" aria-label="파일 넣기" ${noKey ? "disabled" : ""}>📎</button>
        <input id="fileIn" type="file" multiple hidden>
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

        <h2>글자 크기 <span id="fsVal" class="hint">${s.fontSize}</span></h2>
        <input id="fontSize" type="range" min="14" max="24" step="1" value="${s.fontSize}">
        <p class="hint msg-sample" style="font-size:${s.fontSize}px" id="fsSample">이 크기로 대화가 보임. 가나다라마바사 ABC 123</p>

        <label class="chk"><input type="checkbox" id="autoResumeOn" ${s.autoResume ? "checked" : ""}>
          다른 창을 보다 와서 답이 끊겼으면 자동으로 이어 받기 (최대 ${RESUME_MAX}번)</label>
        <label class="chk"><input type="checkbox" id="choicesOn" ${s.choices ? "checked" : ""}>
          답 끝에 선택지(1. 2. / ① ② / A) B) …)가 있으면 버튼으로 보기</label>

        <h2>모델</h2>
        <select id="modelPick">${modelOptions(s.model)}</select>
        <p class="hint">아르곤·카본은 새로 나온 모델. 열쇠와 같은 계정에서 쓸 수 있어야 함. 안 되면 대화 칸에 오류가 뜸.</p>

        <h2>고정 시스템 프롬프트 <span class="hint" id="sysLen">${n(s.system.length)}자</span></h2>
        <textarea id="system" rows="6" placeholder="역할, 말투, 규칙… 길이 제한 없음">${esc(s.system)}</textarea>
        <p class="hint">맨 위에 고정. 대화 도중 고치면 앞부분이 달라져 캐시가 새로 쌓임.</p>

        <h2>사전설정집 <span class="hint" id="lexLen">${n(s.lexicon.length)}자</span></h2>
        <textarea id="lexicon" rows="8" placeholder="인물·세계관·말투 사전. 요약 말고 사전으로">${esc(s.lexicon)}</textarea>
        <p class="hint">시스템 프롬프트 바로 뒤에 통째로 같이 감.</p>
        <p class="hint ${store.saveOk ? "" : "warn"}" id="saveState">${esc(saveText())}</p>

        <h2>설정 프리셋 <span class="hint">${store.data.presets.length}개</span></h2>
        <p class="hint">시스템 프롬프트·설정집·모델·온도·출력 한도·안전 필터를 이름 붙여 저장해 두고 한 번에 불러옴. 열쇠는 저장하지 않음. 불러와도 앞 대화는 그대로 남음.</p>
        <div class="presetsave">
          <input id="presetName" type="text" maxlength="40" autocomplete="off" placeholder="이름 (예: 세라피나 여왕)">
          <button type="button" id="presetSave">지금 설정 저장</button>
        </div>
        ${store.data.presets.length ? `<ul class="presets">${store.data.presets.map((p) => `
          <li class="preset" data-pid="${esc(p.id)}">
            <span class="pname">${esc(p.name)}<small>${p.settings.system ? n(p.settings.system.length) + "자" : "프롬프트 없음"} · ${esc(String(p.settings.model || "").replace(/^models\//, ""))}</small></span>
            <button type="button" class="small" data-pact="load">불러오기</button>
            <button type="button" class="ghost small" data-pact="del">삭제</button>
          </li>`).join("")}</ul>` : ""}
        <button class="ghost" id="presetExport" type="button">프리셋 파일로 내보내기</button>
        <button class="ghost" id="presetImport" type="button">프리셋 파일 가져오기</button>
        <input id="presetFile" type="file" accept="application/json,.json" hidden>

        <h2>설정 프리셋 <span class="hint">${store.data.presets.length}개</span></h2>
        <p class="hint">시스템 프롬프트·설정집·모델·온도·출력 한도·안전 필터를 이름 붙여 저장해 두고 한 번에 불러옴. 열쇠는 저장하지 않음. 불러와도 앞 대화는 그대로 남음.</p>
        <div class="presetsave">
          <input id="presetName" type="text" maxlength="40" autocomplete="off" placeholder="이름 (예: 세라피나 여왕)">
          <button type="button" id="presetSave">지금 설정 저장</button>
        </div>
        ${store.data.presets.length ? `<ul class="presets">${store.data.presets.map((p) => `
          <li class="preset" data-pid="${esc(p.id)}">
            <span class="pname">${esc(p.name)}<small>${p.settings.system ? n(p.settings.system.length) + "자" : "프롬프트 없음"} · ${esc(String(p.settings.model || "").replace(/^models\//, ""))}</small></span>
            <button type="button" class="small" data-pact="load">불러오기</button>
            <button type="button" class="ghost small" data-pact="del">삭제</button>
          </li>`).join("")}</ul>` : ""}
        <button class="ghost" id="presetExport" type="button">프리셋 파일로 내보내기</button>
        <button class="ghost" id="presetImport" type="button">프리셋 파일 가져오기</button>
        <input id="presetFile" type="file" accept="application/json,.json" hidden>

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

// 답 끝에 붙은 선택지를 뽑는다: 1. 2. / 1) 2) / ① ② / A. B. / [1] [2] / (1) (2) / 질문 뒤의 불릿(-, *, •).
// 2~8개, 한 개당 120자 이하, 답의 맨 끝(뒤에 짧은 질문 한 줄까지 허용)일 때만. 못 찾으면 [].
// 불릿은 오탐이 많아서 바로 위 줄이 ?·:로 끝나거나 ‘선택’·‘고르’가 있을 때만 인정한다.
function choices(text) {
  const MARK = [
    /^[①-⑩]\s*(.+)$/,
    /^[\[(]\s*(?:\d{1,2}|[A-Da-d])\s*[\])]\s*(.+)$/,
    /^(?:\d{1,2}|[A-Da-d])[.)]\s+(.+)$/,
  ];
  const strip = (x) => x.replace(/[*_`]/g, "").trim();
  const num = (l) => { const b = l.replace(/^[-*•]\s+/, ""); for (const r of MARK) { const m = r.exec(b); if (m) return strip(m[1]); } return null; };
  const bul = (l) => { const m = /^[-*•]\s+(.+)$/.exec(l); return m ? strip(m[1]) : null; };
  const lines = String(text).replace(/\r/g, "").split("\n").map((l) => l.replace(/\*\*/g, "").trim());

  let end = lines.length;
  while (end > 0 && !lines[end - 1]) end--;
  let tail = false; // 선택지 뒤에 짧은 질문 한 줄이 붙은 경우
  if (end > 0 && num(lines[end - 1]) === null && bul(lines[end - 1]) === null && lines[end - 1].length <= 80) {
    tail = true; end--;
  }
  const items = []; let kind = null; let i = end - 1;
  for (; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue; // 항목 사이 빈 줄은 건너뜀
    const a = num(l), b = a === null ? bul(l) : null;
    const k = a !== null ? "num" : b !== null ? "bul" : null;
    if (k === null || (kind && k !== kind)) break;
    kind = k; items.unshift(a ?? b);
  }
  if (items.length < 2 || items.length > 8) return [];
  if (items.some((x) => !x || x.length > 120)) return [];
  if (kind === "bul" && !tail && !/[?？:：]$|선택|고르/.test(i >= 0 ? lines[i] : "")) return [];
  return items;
}

// 읽기 쉽게: 빈 줄은 문단으로, **굵게**, *행동*, (행동)은 흐리고 기울인 글씨로. 먼저 esc로 막아서 HTML이 끼어들 수 없다.
function fmt(s) {
  const inline = (x) => esc(x)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, '<span class="act">$1</span>')
    .replace(/(\([^()\n]+\)|（[^（）\n]+）)/g, '<span class="act">$1</span>');
  return String(s).split(/\n{2,}/).filter((q) => q.trim())
    .map((q) => `<p>${inline(q.trim()).replace(/\n/g, "<br>")}</p>`).join("");
}

const bubbleHTML = (m) => `
  <li class="msg ${m.role} ${m.err ? "err" : ""}" data-id="${m.id}">
    ${m.files && !m.text.trim() && !m.err ? "" : `<div class="text">${m.err ? "⚠ " + esc(m.err) : fmt(m.text)}</div>`}
    ${m.files ? `<div class="mfiles">${m.files.map((f) => `<span class="mf">${fileIcon(f)} ${esc(f.name)} · ${fmtSize(f.size)}</span>`).join("")}</div>` : ""}
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

// 이 기기 저장소(localStorage) 사용량. 글자는 UTF-16이라 한 글자 2바이트로 센다.
function storageBytes() {
  try { let n = 0; for (const k of Object.keys(localStorage)) n += (k.length + (localStorage.getItem(k) || "").length) * 2; return n; }
  catch { return 0; }
}
function saveText() {
  const used = `이 기기 저장 사용량 ${fmtSize(storageBytes())}`;
  return store.saveOk ? `저장됨 · ${used}` : `⚠ 저장 안 됨 — 이 기기 저장 공간이 가득 참 (${used}). 설정집·대화를 줄이거나 내보낸 뒤 지우기`;
}
let saveStateT = 0;
function showSaveState() { // 입력할 때마다 계산하면 느려서 잠깐 모아서
  clearTimeout(saveStateT);
  saveStateT = setTimeout(() => {
    const el = document.getElementById("saveState");
    if (el) { el.textContent = saveText(); el.classList.toggle("warn", !store.saveOk); }
    if (typeof setBusy === "function") setBusy(!!busy);
  }, 300);
}

function setBusy(on) {
  const b = document.getElementById("sendBtn");
  if (b) { b.textContent = on ? "■" : "↑"; b.setAttribute("aria-label", on ? "멈추기" : "보내기"); }
  const p = cachePct();
  const c = document.getElementById("count");
  c.textContent = on ? "답하는 중…" : !store.saveOk ? "⚠ 저장 안 됨" : p === null ? "" : `캐시 ${p}%`;
  c.classList.toggle("warn", !on && !store.saveOk);
}

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { chat: "제미니채팅", ledger: "장부", settings: "설정" };
const route = () => (location.hash.replace(/^#\/?/, "") || "chat").split("/")[0];

// 화면 위치는 사용자만 정한다. 맨 아래로 가는 것은 (1) 내가 말을 보냈을 때 (2) 대화 화면에 들어왔을 때뿐.
// 답이 오는 중이거나 다시 그려질 때는 보던 자리를 그대로 둔다.
let jumpToBottom = false;

function render() {
  const name = SCREENS[route()] ? route() : "chat";
  const draft = document.getElementById("msg")?.value || "";
  const before = document.body.dataset.screen, y = scrollY;
  document.getElementById("screen").innerHTML = SCREENS[name]();
  document.getElementById("title").textContent =
    name === "chat" ? store.data.settings.model.replace(/^models\//, "") : TITLES[name];
  document.body.dataset.screen = name;
  document.documentElement.style.setProperty("--fs", `${Number(store.data.settings.fontSize) || 17}px`);
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  wire(name, draft);
  setBusy(!!busy);
  const bottom = document.documentElement.scrollHeight;
  if (name !== before) scrollTo(0, name === "chat" ? bottom : 0);
  else if (jumpToBottom) scrollTo(0, bottom);
  else scrollTo(0, y);
  jumpToBottom = false;
  updateJump();
}

// 위로 올려 읽는 중이면(맨 아래까지 240px 넘게 남음) ‘↓ 맨 아래’ 버튼을 보인다. 대화 화면에서만.
function updateJump() {
  const el = document.getElementById("jump");
  if (!el) return;
  const far = document.body.dataset.screen === "chat" && document.documentElement.scrollHeight - scrollY - innerHeight > 240;
  el.hidden = !far;
  if (far) { // 입력창이 커져도 가리지 않게 입력창 위에 붙인다
    const c = document.getElementById("composer");
    el.style.bottom = `calc(var(--tabs) + env(safe-area-inset-bottom) + ${(c ? c.offsetHeight : 0) + 12}px)`;
  }
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
      if (!v && !pending.length) return;
      t.value = "";
      send(v);
    });
    document.getElementById("attach").addEventListener("click", () => document.getElementById("fileIn").click());
    document.getElementById("fileIn").addEventListener("change", (e) => {
      const fs = [...e.target.files]; // 값을 비우면 목록도 비므로 먼저 복사
      e.target.value = "";
      if (fs.length) attachFiles(fs);
    });
    document.querySelectorAll("[data-fx]").forEach((b) => b.addEventListener("click", () => { pending.splice(Number(b.dataset.fx), 1); render(); }));
    document.getElementById("retry")?.addEventListener("click", retry);
    document.getElementById("cont")?.addEventListener("click", continueLast);
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
  document.getElementById("autoResumeOn").addEventListener("change", (e) => { s.autoResume = e.target.checked; store.saveQuiet(); });
  document.getElementById("choicesOn").addEventListener("change", (e) => { s.choices = e.target.checked; store.saveQuiet(); });
  document.getElementById("fontSize").addEventListener("input", (e) => {
    s.fontSize = Number(e.target.value);
    document.documentElement.style.setProperty("--fs", `${s.fontSize}px`);
    document.getElementById("fsVal").textContent = s.fontSize;
    document.getElementById("fsSample").style.fontSize = `${s.fontSize}px`;
    store.saveQuiet();
  });
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

  document.getElementById("presetSave").addEventListener("click", () => {
    const input = document.getElementById("presetName");
    const name = input.value.trim().slice(0, 40);
    if (!name) { toast("이름을 먼저 적기"); input.focus(); return; }
    const list = store.data.presets, i = list.findIndex((p) => p.name === name);
    if (i >= 0 && !confirm(`‘${name}’이 이미 있음. 지금 설정으로 덮어씀.`)) return;
    if (i < 0 && list.length >= PRESET_MAX) { toast(`프리셋은 ${PRESET_MAX}개까지. 하나를 지우기`); return; }
    const before = JSON.stringify(list);
    const item = { id: i >= 0 ? list[i].id : crypto.randomUUID(), name, at: Date.now(), settings: takePreset(store.data.settings) };
    if (i >= 0) list[i] = item; else list.push(item);
    if (!store.saveQuiet()) { store.data.presets = JSON.parse(before); return; } // 저장 실패하면 원래대로
    render();
    toast(`‘${name}’ 저장함`);
  });
  document.querySelectorAll("[data-pact]").forEach((b) => b.addEventListener("click", () => {
    const id = b.closest("[data-pid]").dataset.pid;
    const p = store.data.presets.find((x) => x.id === id);
    if (!p) return;
    if (b.dataset.pact === "load") { applyPreset(p); store.save(); toast(`‘${p.name}’ 불러옴 — 앞 대화는 그대로 남음`); }
    else if (confirm(`‘${p.name}’ 프리셋을 지움.`)) { store.data.presets = store.data.presets.filter((x) => x.id !== id); store.save(); }
  }));
  document.getElementById("presetExport").addEventListener("click", () => {
    if (!store.data.presets.length) return toast("저장된 프리셋이 없음");
    download("제미니채팅-프리셋.json", { kind: "제미니채팅-프리셋", presets: store.data.presets });
  });
  const pfile = document.getElementById("presetFile");
  document.getElementById("presetImport").addEventListener("click", () => pfile.click());
  pfile.addEventListener("change", async () => {
    const f = pfile.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const arr = Array.isArray(j) ? j : j.presets;
      if (!Array.isArray(arr)) throw new Error("프리셋(presets)이 없는 파일");
      const good = arr.filter(validPreset);
      if (!good.length) throw new Error("쓸 수 있는 프리셋이 없음");
      const m = mergePresets(store.data.presets, good);
      if (m.replaced && !confirm(`같은 이름 ${m.replaced}개는 덮어씀. 계속할까?`)) return;
      store.data.presets = m.list;
      store.save();
      toast(`프리셋 ${m.added}개 추가, ${m.replaced}개 덮어씀${m.dropped ? `, ${m.dropped}개는 ${PRESET_MAX}개 한도로 못 넣음` : ""}`);
    } catch (err) { toast("가져오기 실패: " + err.message); }
    pfile.value = "";
  });

  document.getElementById("export").addEventListener("click", () => {
    const { apiKey, ...settings } = s; // 열쇠는 백업 파일에 넣지 않는다
    download("제미니채팅.json", { messages: store.data.messages, settings, ledger: store.data.ledger, presets: store.data.presets });
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
      dropFiles(store.data.messages, new Set(ok.flatMap((m) => (m.files || []).map((f) => f.id))));
      store.data.messages = ok;
      if (!Array.isArray(j) && j.settings && typeof j.settings === "object") {
        const { apiKey, ...rest } = j.settings;
        store.data.settings = mergeSettings(store.data.settings, rest);
      }
      if (!Array.isArray(j) && Array.isArray(j.ledger)) store.data.ledger = j.ledger.slice(0, LEDGER_MAX);
      if (!Array.isArray(j) && Array.isArray(j.presets)) store.data.presets = mergePresets(store.data.presets, j.presets).list;
      store.save();
      toast("가져왔음");
    } catch (err) { toast("가져오기 실패: " + err.message); }
    file.value = "";
  });

  document.getElementById("reset").addEventListener("click", () => {
    if (confirm("대화를 전부 지움. 되돌릴 수 없음. (열쇠·설정은 남음)")) store.reset();
  });
  document.getElementById("wipe").addEventListener("click", () => {
    if (confirm("대화·열쇠·설정·장부를 전부 지움. 되돌릴 수 없음.")) { idb.clear(); pending = []; store.data = SHAPE(); store.save(); }
  });
}

document.getElementById("screen").addEventListener("click", (e) => {
  const ch = e.target.closest("[data-choice]");
  if (ch) {
    const ms = store.data.messages, last = ms[ms.length - 1];
    const o = last && last.role === "model" ? choices(last.text)[Number(ch.dataset.choice)] : null;
    if (o) send(o);
    return;
  }
  const btn = e.target.closest("[data-act=copy]");
  if (!btn) return;
  const m = store.data.messages.find((x) => x.id === btn.closest("[data-id]").dataset.id);
  if (m) navigator.clipboard?.writeText(m.text).then(() => toast("복사함"), () => toast("복사 못 함"));
});

// 처음 열 때 브라우저가 load 직후 스크롤을 0으로 되돌리는 일이 있다. 사용자가 아직 화면을 건드리지 않았을 때만 한 번 더 맨 아래로.
let touched = false;
for (const ev of ["touchstart", "wheel", "keydown", "mousedown"]) addEventListener(ev, () => { touched = true; }, { passive: true, once: true });
addEventListener("load", () => setTimeout(() => {
  if (!touched && document.body.dataset.screen === "chat") scrollTo(0, document.documentElement.scrollHeight);
}, 50));

document.getElementById("jump").addEventListener("click", () => scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
addEventListener("scroll", updateJump, { passive: true });
addEventListener("resize", updateJump);

// 화면으로 돌아왔는데 새 글이 STALL_MS 동안 없으면 끊긴 것으로 보고 이어 받는다.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !busy) return;
  const ctl = busy, mark = Date.now();
  setTimeout(() => { if (busy === ctl && lastChunk < mark) { ctl.stalled = true; ctl.abort(); } }, STALL_MS);
});
// 망이 돌아오면 끊긴 채 남은 마지막 답을 이어 받는다.
function resumeIfBroken() {
  const ms = store.data.messages, last = ms[ms.length - 1], s = store.data.settings;
  if (!busy && !waiting && last && last.role === "model" && last.broken && !last.err && s.autoResume && s.apiKey.trim()
      && (last.tries || 0) < RESUME_MAX && navigator.onLine !== false) {
    last.tries = (last.tries || 0) + 1;
    resumeLater(last);
  }
}
addEventListener("online", resumeIfBroken);

addEventListener("hashchange", render);
render();
setTimeout(resumeIfBroken, 300); // 답이 오던 중에 앱이 꺼졌다 다시 열린 경우

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
