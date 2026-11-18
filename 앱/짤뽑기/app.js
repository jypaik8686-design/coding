// 짤뽑기 — 취향 프롬프트를 늘 붙여 NovelAI로 한 장씩 뽑고, 고른 것과 버린 것에서 취향을 쌓는다.
// 화면 넷: 뽑기 / 비서 / 보관함 / 취향. 글자 데이터는 localStorage, 그림(보관한 것, 참고 그림)은 IndexedDB.

import { PERSONA_PARTS, partState, buildPersona, MODEL_CHOICES } from "./assistant.js";
import { PRESETS } from "./presets.js";

const KEY = "짤뽑기/v1";
const API = "https://image.novelai.net/ai/generate-image";
const LOG_MAX = 400;

const SIZES = { 세로: [832, 1216], 가로: [1216, 832], 정사각: [1024, 1024] }; // 이 밖에 ‘직접’(settings.customW/H)
// 샘플러 이름은 2026-11-18 세션에서 하나씩 불러 200을 받은 것만 둔다 (ddim_v3은 500이라 뺌).
const SAMPLERS = {
  k_euler_ancestral: "Euler Ancestral", k_dpmpp_2m: "DPM++ 2M", k_euler: "Euler",
  k_dpmpp_2s_ancestral: "DPM++ 2S Ancestral", k_dpmpp_sde: "DPM++ SDE", k_dpmpp_2m_sde: "DPM++ 2M SDE",
};
const NOISES = ["karras", "exponential", "polyexponential", "native"]; // 넷 다 200 확인 (2026-11-18)
const FREE_STEPS = 28;                 // Opus는 28스텝 이하·일반 크기 이하·한 장씩이면 Anlas 없음 (docs.novelai.net/en/image/basics)
const FREE_PIXELS = 1024 * 1024;       // '일반 크기' 경계를 1024x1024로 잡은 것은 이 앱의 추정. 문서에는 숫자가 없다.
const MAX_STEPS = 50;                  // 이 앱이 정한 상한. NovelAI의 상한은 확인하지 못했다.
const MAX_CHARS = 6;                   // V4 한도(문서). V5는 22명이라는데 이 앱은 6으로 통일했다.
const VARIETY_SIGMA = 19;              // Variety+를 켤 때 보내는 값. 200은 확인했지만 NovelAI 화면이 쓰는 값인지는 확인 못 함.
// 품질 태그는 NovelAI 문서(docs.novelai.net/en/image/qualitytags, 2026-11-15 확인)의 모델별 문구 그대로.
const MODELS = {
  "nai-diffusion-5-full": { 이름: "V5 Full", 품질: ", very aesthetic, masterpiece, no text" },
  "nai-diffusion-4-5-full": { 이름: "V4.5 Full", 품질: ", location, very aesthetic, masterpiece, no text" },
};
// 사용자가 직접 말한 취향(정장, 중국식 미인, 금발)을 태그로 옮긴 처음 값. art/취향.md의 '좋아하는 것'과 같아야 한다.
const DEFAULT_SCENE = "1girl, solo, business suit, formal, blonde hair, long hair, east asian, mature female, elegant, looking at viewer, upper body";
// 취향 프롬프트 처음 값: art/프롬프트/NAI.md에서 사용자가 "엄청 마음에 든다"고 확정한 키아나 그림체 블록. 취향뽑기 앱의 처음 값과 같다.
const DEFAULT_STYLE = "{painterly}, visible brushstrokes, {dappled sunlight}, harsh sunlight, strong shadows, glossy skin, film grain, warm highlights, teal shadows, cinematic lighting, depth of field, bokeh";
// NovelAI 문서(docs.novelai.net/en/image/undesiredcontent, 2026-11-15 확인)의 'Human Focus V5 Full'. V4.5 Full도 같은 글이다.
const DEFAULT_NEG = "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy";
// 처음 버전이 쓰던 값. 사용자가 손대지 않고 그대로 남아 있으면 새 값으로 바꾼다.
const OLD_NEG = "lowres, bad anatomy, bad hands, extra digits, jpeg artifacts, signature, watermark, username, blurry";

// ── 데이터 모양 ──────────────────────────────────────────────
// log 항목 하나: { id, scene, style, negative, seed, model, w, h, steps, scale, at, verdict, refs? }
//   verdict: null(안 고름) | "keep"(보관) | "drop"(버림)
//   refs: 이 그림에 쓴 참고 그림 [{s: 강도, i: 정보량}]. 옛 항목에는 없다 (없으면 0장).
// chat 항목 하나: { role: "user" | "model", text, at }. 비서 대화. 40개를 넘으면 앞에서부터 버린다.
// settings 새 칸: sampler / noise(스케줄) / cfgRescale / variety / customW·customH(size가 "직접"일 때) / refMode("vibe"|"precise")
// draft 새 칸: chars [{id, text, neg, pos}] 인물별 프롬프트(pos: null=AI가 정함, 0~24=5x5 칸 번호), i2i {on, strength, noise} (원본 그림은 IndexedDB "src")
// presets 항목: { id, name, text, to: "scene"|"style"|"neg" } 사용자가 저장한 프롬프트
// presets 새 칸(옛 항목에는 없음, normPresets가 메움): kind("인물"|"그림체"|"자세·구도"|"빼는 것"|"내 것", 없으면 "내 것") / neg / note / at("front")
// presetEdits: 내장 프리셋(presets.js)을 고친 것. { "b:<종류>:<기본 이름>": { name?, text?, neg?, note?, hidden? } }. 기본과 같아진 칸은 지워서 기본 글이 따라오게 한다.
// persona: 비서 지시문을 사용자가 고친 것. sections { <조각 id>: { text?, on? } }는 기본 조각을 덮어쓴 것만 담고, extra [{id, name, text, on}]는 사용자가 더한 조각,
//   auto { state, cand }는 앱이 지시문 뒤에 자동으로 붙이는 ‘앱 상태’와 ‘사전 후보’를 켜는지. 옛 데이터에는 없다 (normPersona가 메운다).
// log 새 칸: sampler / noise / cr / vb / chars / i2i / mode. 옛 항목에는 없다 (없으면 처음 값으로 읽는다).
const SHAPE = () => ({
  settings: {
    token: "", model: "nai-diffusion-5-full", customModel: "", size: "세로", steps: 28, scale: 5, quality: true,
    aiKey: "", aiModel: MODEL_CHOICES[0], aiCustom: "",
    sampler: "k_euler_ancestral", noise: "karras", cfgRescale: 0, variety: false, customW: 832, customH: 1216, refMode: "vibe",
  },
  taste: { style: DEFAULT_STYLE, negative: DEFAULT_NEG, seeded: true },
  draft: { scene: DEFAULT_SCENE, seedLock: false, seed: null, seeded: true, chars: [], i2i: { on: false, strength: 0.7, noise: 0 } },
  log: [],
  chat: [],
  presets: [],
  persona: { sections: {}, extra: [], auto: { state: true, cand: true } },
  presetEdits: {},
});

const PRESET_KINDS = ["인물", "그림체", "자세·구도", "빼는 것", "내 것"];
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
let saveFail = false; // 마지막 저장이 실패했는지 (화면 맨 위 경고)
const store = {
  data: load(),
  persist() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); if (saveFail) { saveFail = false; render(); } return true; }
    catch (e) {
      console.warn("저장 실패", e);
      // 조용히 넘기면 사용자는 저장된 줄 안다. 처음 실패할 때 화면 맨 위에 띄운다 (타이핑 중이라 매번 다시 그리지는 않는다).
      if (!saveFail) { saveFail = true; toast("저장 실패 — 이 기기 저장 공간이 찼음"); render(); }
      return false;
    }
  },
  save() { this.persist(); render(); },
};

function normPresets(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p) => p && p.id && typeof p.text === "string").map((p) => {
    const o = { id: String(p.id), name: str(p.name, 60), text: p.text.slice(0, 4000), to: ["scene", "style", "neg"].includes(p.to) ? p.to : "scene", kind: PRESET_KINDS.includes(p.kind) ? p.kind : "내 것" };
    if (typeof p.neg === "string" && p.neg) o.neg = p.neg.slice(0, 4000);
    if (typeof p.note === "string" && p.note) o.note = p.note.slice(0, 300);
    if (p.at === "front" && o.to === "scene") o.at = "front";
    return o;
  });
}
function normPresetEdits(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const kind of Object.keys(PRESETS)) for (const b of PRESETS[kind]) {
    const k = `b:${kind}:${b.name}`, o = raw[k];
    if (!o || typeof o !== "object") continue;
    const e = {};
    for (const f of ["name", "text", "neg", "note"]) if (typeof o[f] === "string" && o[f] !== (b[f] ?? "")) e[f] = o[f].slice(0, 4000);
    if (o.hidden === true) e.hidden = true;
    if (Object.keys(e).length) out[k] = e;
  }
  return out;
}

// 옛 데이터·깨진 값이 와도 항상 같은 꼴로 돌려준다. 항목 안쪽 칸은 펼치기가 메워 주지 않아서 여기서 하나씩 본다.
function normPersona(raw) {
  const out = { sections: {}, extra: [], auto: { state: true, cand: true } };
  if (!raw || typeof raw !== "object") return out;
  for (const p of PERSONA_PARTS) {
    const o = raw.sections?.[p.id];
    if (!o || typeof o !== "object") continue;
    const e = {};
    if (typeof o.text === "string" && o.text !== p.text) e.text = o.text;
    if (o.on === false) e.on = false;
    if (Object.keys(e).length) out.sections[p.id] = e;
  }
  if (Array.isArray(raw.extra)) out.extra = raw.extra.filter((e) => e && e.id && typeof e.text === "string").map((e) => ({ id: String(e.id), name: String(e.name || "").slice(0, 30), text: e.text, on: e.on !== false })).slice(0, 20);
  out.auto = { state: raw.auto?.state !== false, cand: raw.auto?.cand !== false };
  return out;
}

function load() {
  const base = SHAPE();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || typeof raw !== "object") return base;
    const draft = { ...base.draft, ...(raw.draft || {}) };
    // 기본값이 생기기 전에 저장된 옛 데이터: 비어 있던 칸은 기본값으로 채우고, 직접 적은 것은 건드리지 않는다.
    if (!raw.draft?.seeded) { draft.seeded = true; if (!String(raw.draft?.scene || "").trim()) draft.scene = DEFAULT_SCENE; }
    const taste = { ...base.taste, ...(raw.taste || {}) };
    if (taste.negative === OLD_NEG) taste.negative = DEFAULT_NEG;
    // 취향 처음 값이 생기기 전에 저장된 데이터: 비어 있으면 한 번만 채운다. 그 뒤에 사용자가 비우면 다시 채우지 않는다.
    if (!raw.taste?.seeded) { taste.seeded = true; if (!String(raw.taste?.style || "").trim()) taste.style = DEFAULT_STYLE; }
    // 항목 안쪽 칸은 펼치기가 메워 주지 않으니 읽는 자리에서 기본값을 준다.
    draft.chars = Array.isArray(draft.chars) ? draft.chars.filter((c) => c && c.id).slice(0, MAX_CHARS) : [];
    draft.i2i = { ...base.draft.i2i, ...(draft.i2i || {}) };
    return {
      settings: { ...base.settings, ...(raw.settings || {}) },
      taste,
      draft,
      presets: normPresets(raw.presets),
      presetEdits: normPresetEdits(raw.presetEdits),
      log: Array.isArray(raw.log) ? raw.log.filter((r) => r && r.id) : [],
      chat: Array.isArray(raw.chat) ? raw.chat.filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string") : [],
      persona: normPersona(raw.persona),
    };
  } catch { return base; }
}

// ── 그림 저장 (IndexedDB) ────────────────────────────────────
let dbp = null;
function db() {
  dbp ??= new Promise((ok, no) => {
    // 2: 참고 그림 창고 "ref". 3: 이미지→이미지 원본 창고 "src"(한 줄, id "main"). 옛 "img"(보관한 그림)는 그대로 둔다.
    const q = indexedDB.open("짤뽑기", 3);
    q.onupgradeneeded = () => {
      for (const n of ["img", "ref", "src"]) if (!q.result.objectStoreNames.contains(n)) q.result.createObjectStore(n, { keyPath: "id" });
    };
    q.onsuccess = () => ok(q.result);
    q.onerror = () => no(q.error);
  });
  return dbp;
}
async function idb(mode, fn, name = "img") {
  const d = await db();
  return new Promise((ok, no) => {
    const tx = d.transaction(name, mode);
    const q = fn(tx.objectStore(name));
    tx.oncomplete = () => ok(q?.result);
    tx.onerror = tx.onabort = () => no(tx.error);
  });
}
const imgPut = (row) => idb("readwrite", (s) => s.put(row));
const imgGet = (id) => idb("readonly", (s) => s.get(id));
const imgDel = (id) => idb("readwrite", (s) => s.delete(id));
const imgClear = () => idb("readwrite", (s) => s.clear());
const refPut = (row) => idb("readwrite", (s) => s.put(row), "ref");
const refDel = (id) => idb("readwrite", (s) => s.delete(id), "ref");
const refAll = () => idb("readonly", (s) => s.getAll(), "ref");
const refClear = () => idb("readwrite", (s) => s.clear(), "ref");
const srcPut = (row) => idb("readwrite", (s) => s.put(row), "src");
const srcGet = () => idb("readonly", (s) => s.get("main"), "src");
const srcDel = () => idb("readwrite", (s) => s.delete("main"), "src");
const srcClear = () => idb("readwrite", (s) => s.clear(), "src");

async function thumbOf(blob) {
  const bmp = await createImageBitmap(blob);
  const w = 360, h = Math.round((bmp.height / bmp.width) * w);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((ok) => c.toBlob((b) => ok(b || blob), "image/jpeg", 0.82));
}

// ── NovelAI 부르기 ───────────────────────────────────────────
const modelId = (s) => (s.model === "custom" ? s.customModel.trim() : s.model);
const tidy = (t) => t.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join(", ");

function compose(scene, style, s) {
  const body = [tidy(scene), tidy(style)].filter(Boolean).join(", ");
  const q = (MODELS[modelId(s)] || MODELS["nai-diffusion-5-full"]).품질;
  return s.quality ? body + q : body;
}

// ── 참고 그림 (V4.5 바이브 트랜스퍼) ─────────────────────────
// 그림은 IndexedDB "ref"에 둔다. 한 줄: { id, name, at, on, strength, info, full(PNG, 긴 변 1024 이하), thumb, enc }
// enc: { "<모델>|<정보량>": 인코딩 결과(base64) }. 인코딩은 NovelAI 서버가 해 주고 2 Anlas가 든다(문서). 같은 그림·모델·정보량이면 다시 안 한다.
const VIBE_API = "https://image.novelai.net/ai/encode-vibe";
const MAX_REFS = 4; // 이 앱이 정한 한도. NovelAI의 한도는 확인하지 못했다.
const supportsVibe = (s) => /^nai-diffusion-4/.test(modelId(s)); // V5는 400으로 거절됨 (art 확인 2026-11-17)
const supportsPrecise = (s) => /^nai-diffusion-4-5/.test(modelId(s)); // 정밀 참조는 V4.5 전용 (문서). V4.5 Full에서 200 확인 (2026-11-18)
const supportsChars = (s) => /^nai-diffusion-(4|5)/.test(modelId(s)); // 인물별 프롬프트는 V4 이상 (문서)
// 지금 모델과 방식에서 실제로 보낼 참고 그림. 바이브와 정밀 참조는 같이 못 쓴다(문서)
const refPlan = (s) => (s.refMode === "precise" ? (supportsPrecise(s) ? "precise" : null) : (supportsVibe(s) ? "vibe" : null));
let refs = [];       // 메모리에 올린 참고 그림들 (+ url)
let phase = "";      // 뽑는 중 단계 글

const rowOf = ({ url, ...row }) => row;
async function loadRefs() {
  try {
    refs.forEach((r) => URL.revokeObjectURL(r.url));
    refs = (await refAll()).sort((a, b) => a.at - b.at).map((r) => ({ ...r, url: URL.createObjectURL(r.thumb || r.full) }));
  } catch (e) { console.warn("참고 그림 읽기 실패", e); refs = []; }
}

const bufB64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};

async function prepRef(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const full = await new Promise((ok) => c.toBlob(ok, "image/png"));
  if (!full) throw new Error("PNG로 바꾸지 못함");
  return { full, thumb: await thumbOf(full) };
}

async function addRefs(files) {
  errMsg = "";
  for (const f of files) {
    if (refs.length >= MAX_REFS) { errMsg = `참고 그림은 ${MAX_REFS}장까지.`; break; }
    try {
      const { full, thumb } = await prepRef(f);
      const row = { id: crypto.randomUUID(), name: (f.name || "그림").slice(0, 40), at: Date.now(), on: true, strength: 0.6, info: 1, fid: 0.5, kind: "character&style", full, thumb, enc: {} };
      await refPut(row);
      refs.push({ ...row, url: URL.createObjectURL(thumb) });
    } catch (e) {
      errMsg = `‘${f.name || "그림"}’을 읽지 못함 (${e?.message || e}). 다른 파일로 시도.`;
    }
  }
  render();
}

async function failText(res) {
  let said = "";
  try { const t = await res.text(); said = (JSON.parse(t).message ?? t).toString().slice(0, 200); } catch { /* 본문 없음 */ }
  const hint = res.status === 401 ? "토큰이 틀렸거나 만료됨. ‘취향’ 탭에서 다시 넣기."
    : res.status === 429 ? "요청이 너무 잦거나 다른 생성이 돌고 있음. 잠시 뒤 직접 다시 누르기."
    : "";
  return `${hint} (서버 ${res.status}${said ? `: ${said}` : ""})`.trim();
}

// 이 그림·모델·정보량의 인코딩이 없으면 서버에서 받아 저장해 둔다. 응답은 이진 파일이다.
async function encodeRef(r, model, token, signal) {
  const k = `${model}|${r.info}`;
  if (r.enc?.[k]) return r.enc[k];
  phase = `참고 그림 인코딩 중 (${refs.filter((x) => x.on).indexOf(r) + 1}/${refs.filter((x) => x.on).length})…`;
  render();
  const res = await fetch(VIBE_API, {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ image: bufB64(await r.full.arrayBuffer()), information_extracted: r.info, model }),
  });
  if (!res.ok) throw new Error(`참고 그림 인코딩 실패. ${await failText(res)}`);
  r.enc = { ...(r.enc || {}), [k]: bufB64(await res.arrayBuffer()) };
  await refPut(rowOf(r)).catch(() => {}); // 못 남겨도 이번 뽑기는 계속 (다음에 다시 인코딩)
  return r.enc[k];
}

// ── 이미지 다루기 ────────────────────────────────────────────
// 이미지→이미지 원본: IndexedDB "src"의 한 줄 { id: "main", name, full(PNG, 긴 변 1536 이하), thumb }
let src = null; // { name, full, url }
async function loadSrc() {
  try {
    const row = await srcGet();
    if (src) URL.revokeObjectURL(src.url);
    src = row ? { name: row.name, full: row.full, url: URL.createObjectURL(row.thumb || row.full) } : null;
  } catch { src = null; }
}
async function setSrc(blob, name) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 1536 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const full = await new Promise((ok) => c.toBlob(ok, "image/png"));
  if (!full) throw new Error("PNG로 바꾸지 못함");
  await srcPut({ id: "main", name: String(name || "그림").slice(0, 40), full, thumb: await thumbOf(full) });
  await loadSrc();
  store.data.draft.i2i.on = true;
  store.persist();
}
async function clearSrc() {
  await srcDel().catch(() => {});
  if (src) URL.revokeObjectURL(src.url);
  src = null;
  store.data.draft.i2i.on = false;
  store.persist();
}

const canvasB64 = async (c) => bufB64(await (await new Promise((ok) => c.toBlob(ok, "image/png"))).arrayBuffer());
// 이미지→이미지는 생성 크기와 같아야 해서, 크기에 맞게 가운데를 잘라(cover) 보낸다.
async function fitCover(blob, w, h) {
  const bmp = await createImageBitmap(blob);
  const k = Math.max(w / bmp.width, h / bmp.height);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, (w - bmp.width * k) / 2, (h - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  bmp.close?.();
  return canvasB64(c);
}
// 정밀 참조는 1024×1536, 1536×1024, 1472×1472 중 비율이 가장 가까운 것에 검은 여백으로 맞춘다 (문서).
async function padPrecise(blob) {
  const bmp = await createImageBitmap(blob);
  const ar = bmp.width / bmp.height;
  const [W, H] = [[1024, 1536], [1536, 1024], [1472, 1472]].reduce((a, b) => Math.abs(Math.log(a[0] / a[1] / ar)) <= Math.abs(Math.log(b[0] / b[1] / ar)) ? a : b);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  const k = Math.min(W / bmp.width, H / bmp.height);
  g.drawImage(bmp, (W - bmp.width * k) / 2, (H - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  bmp.close?.();
  return canvasB64(c);
}
// 제미니에 보여 줄 그림: 긴 변 768px JPEG
async function shrinkJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 768 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const b = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
  return bufB64(await b.arrayBuffer());
}

// 칸 번호(0~24, 왼쪽 위부터 가로로)를 NovelAI 좌표(0~1)로. 5x5 격자의 칸 가운데다 (V4·V4.5는 5x5만, 문서).
const cellXY = (n) => ({ x: (n % 5) * 0.2 + 0.1, y: Math.floor(n / 5) * 0.2 + 0.1 });

// 요청 몸통은 V5에서 200이 확인된 꼴 그대로 (명세.md '밖에 나가는 것' 참고). v4_prompt 둘을 빼면 500이 난다.
// ex: { used, vibes, precise(base64 배열), i2i(base64) }
//  - 바이브: reference_*_multiple 세 줄에 인코딩 결과·정보량·강도를 같은 순서로 (V4.5 200 확인)
//  - 정밀 참조: director_reference_* 다섯 줄 + descriptions (V4.5 200 확인, 한 장마다 5 Anlas 추가는 문서 기준)
//  - 이미지→이미지: action "img2img" + image/strength/noise (V4.5 200 확인)
//  - 인물별 프롬프트: v4_prompt.caption.char_captions + centers (V4.5 200 확인, 위치가 따라옴)
function requestBody(prompt, negative, rec, ex = {}) {
  const used = ex.used || [];
  const chars = rec.chars || [];
  const coords = chars.some((c) => c.pos != null);
  const cap = (t, neg) => ({
    use_coords: coords, use_order: false,
    caption: { base_caption: t, char_captions: chars.map((c) => ({ char_caption: neg ? (c.neg || "") : c.text, centers: [c.pos == null ? { x: 0.5, y: 0.5 } : cellXY(c.pos)] })) },
  });
  const params = {
    params_version: 4, width: rec.w, height: rec.h, scale: rec.scale, sampler: rec.sampler || "k_euler_ancestral",
    steps: rec.steps, seed: rec.seed, n_samples: 1, ucPreset: 3, qualityToggle: false,
    sm: false, sm_dyn: false, dynamic_thresholding: false, controlnet_strength: 1,
    legacy: false, add_original_image: false, cfg_rescale: rec.cr ?? 0, noise_schedule: rec.noise || "karras",
    legacy_v3_extend: false, uncond_scale: 1, negative_prompt: negative, prompt,
    reference_image_multiple: ex.vibes || [], reference_information_extracted_multiple: ex.vibes ? used.map((r) => r.info) : [], reference_strength_multiple: ex.vibes ? used.map((r) => r.strength) : [],
    extra_noise_seed: rec.seed,
    v4_prompt: cap(prompt, false), v4_negative_prompt: cap(negative, true),
  };
  if (rec.vb) params.skip_cfg_above_sigma = VARIETY_SIGMA;
  if (ex.precise) {
    Object.assign(params, {
      director_reference_images: ex.precise,
      director_reference_information_extracted: used.map((r) => r.info),
      director_reference_strength_values: used.map((r) => r.strength),
      director_reference_secondary_strength_values: used.map((r) => r.fid ?? 0.5),
      director_reference_descriptions: used.map((r) => ({ caption: { base_caption: r.kind || "character&style", char_captions: [] }, legacy_uc: false })),
    });
  }
  if (ex.i2i) Object.assign(params, { image: ex.i2i, strength: rec.i2i.strength, noise: rec.i2i.noise });
  return { input: prompt, model: rec.model, action: ex.i2i ? "img2img" : "generate", parameters: params };
}

// 이 설정에서 Anlas가 드는 것을 문서 기준으로 알려 준다. 실제 차감은 이 앱에서 재 보지 않았다.
function anlasNotes(s, d) {
  const [w, h] = sizeOf(s), n = [];
  if (clamp(s.steps, 1, MAX_STEPS, 28) > FREE_STEPS) n.push(`스텝 ${FREE_STEPS} 초과`);
  if (w * h > FREE_PIXELS) n.push("일반 크기보다 큼");
  if (refPlan(s) === "precise" && refs.some((r) => r.on)) n.push("정밀 참조는 한 장마다 5 Anlas 추가");
  return n;
}
const sizeOf = (s) => (s.size === "직접" ? [clamp(Math.round(s.customW / 64) * 64, 64, 1536, 832), clamp(Math.round(s.customH / 64) * 64, 64, 1536, 1216)] : SIZES[s.size] || SIZES.세로);

// 응답은 image_0.png 하나가 든 zip이다. 라이브러리 없이 첫 파일만 꺼낸다.
async function pngFromResponse(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (u8.length > 8 && dv.getUint32(0) === 0x89504e47) return u8; // zip이 아니라 PNG가 바로 온 경우
  let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error("받은 것이 zip도 PNG도 아님");
  const cd = dv.getUint32(e + 16, true);
  if (dv.getUint32(cd, true) !== 0x02014b50) throw new Error("zip 목록을 못 읽음");
  const method = dv.getUint16(cd + 10, true), csize = dv.getUint32(cd + 20, true), lho = dv.getUint32(cd + 42, true);
  const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
  const raw = u8.subarray(start, start + csize);
  if (method === 0) return raw;
  if (method !== 8) throw new Error(`모르는 zip 압축 방식 ${method}`);
  if (typeof DecompressionStream === "undefined") throw new Error("이 브라우저는 압축 풀기(DecompressionStream)를 못 함");
  const out = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

// 지금 화면에 떠 있는 한 장. 새로 고치면 사라진다 (보관한 것만 남는다).
let now = null;      // 지금 크게 보이는 한 장: hist 안의 항목 하나 { rec, blob, url }. 버림을 누르면 null
// 이번에 뽑은 그림들(오래된 것이 앞). 새로 뽑아도 버림을 눌러도 여기 남아 있어서 눌러 다시 볼 수 있다. 메모리에만 있어서 새로 고치면 사라지고, 보관한 것만 IndexedDB에 남는다.
const HIST_MAX = 12;
let hist = [];
function histAdd(entry) {
  hist.push(entry);
  while (hist.length > HIST_MAX) {
    const i = hist.findIndex((h) => h !== now) ; // 지금 보는 것은 밀어내지 않는다
    const [old] = hist.splice(i < 0 ? 0 : i, 1);
    URL.revokeObjectURL(old.url);
  }
}
function histClear() { hist.forEach((h) => URL.revokeObjectURL(h.url)); hist = []; now = null; }
let busy = null;     // AbortController
let errMsg = "";

async function generate() {
  const d = store.data, s = d.settings;
  errMsg = "";
  if (!s.token.trim()) { errMsg = "토큰이 없음. ‘취향’ 탭 맨 아래에서 넣기."; return render(); }
  if (!modelId(s)) { errMsg = "모델 이름이 비어 있음. ‘취향’ 탭에서 고르기."; return render(); }
  if (!tidy(d.draft.scene) && !tidy(d.taste.style)) { errMsg = "그릴 것이 비어 있음."; return render(); }

  const [w, h] = sizeOf(s);
  const seed = d.draft.seedLock && Number.isInteger(d.draft.seed) ? d.draft.seed : Math.floor(Math.random() * 4294967295);
  const plan = refPlan(s);                                   // "vibe" | "precise" | null
  const used = plan ? refs.filter((r) => r.on) : [];         // 모델이 못 받으면 붙여 둔 그림이 있어도 안 보낸다
  const chars = supportsChars(s) ? d.draft.chars.filter((c) => tidy(c.text)).map((c) => ({ text: tidy(c.text), neg: tidy(c.neg || ""), pos: Number.isInteger(c.pos) ? c.pos : null })) : [];
  const useI2i = d.draft.i2i.on && src;
  const rec = {
    id: crypto.randomUUID(), scene: tidy(d.draft.scene), style: tidy(d.taste.style), negative: tidy(d.taste.negative),
    seed, model: modelId(s), w, h, steps: clamp(s.steps, 1, MAX_STEPS, 28), scale: clamp(s.scale, 0, 10, 5), at: Date.now(), verdict: null,
    sampler: SAMPLERS[s.sampler] ? s.sampler : "k_euler_ancestral", noise: NOISES.includes(s.noise) ? s.noise : "karras",
    cr: clamp(s.cfgRescale, 0, 1, 0), vb: !!s.variety,
  };
  if (used.length) { rec.refs = used.map((r) => ({ s: r.strength, i: r.info })); rec.mode = plan; }
  if (chars.length) rec.chars = chars;
  if (useI2i) rec.i2i = { strength: clamp(d.draft.i2i.strength, 0, 1, 0.7), noise: clamp(d.draft.i2i.noise, 0, 1, 0) };
  const prompt = compose(rec.scene, rec.style, s);

  busy = new AbortController();
  phase = "";
  render();
  try {
    const ex = { used };
    if (plan === "vibe") {
      ex.vibes = [];
      for (const r of used) ex.vibes.push(await encodeRef(r, rec.model, s.token.trim(), busy.signal)); // 한 장씩, 자동 재시도 없음
    } else if (plan === "precise") {
      ex.precise = [];
      for (const r of used) ex.precise.push(await padPrecise(r.full));
    }
    if (useI2i) ex.i2i = await fitCover(src.full, w, h);
    phase = "";
    render();
    const res = await fetch(API, {
      method: "POST", signal: busy.signal,
      headers: { Authorization: `Bearer ${s.token.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody(prompt, rec.negative, rec, ex)),
    });
    if (!res.ok) throw new Error(await failText(res));
    const png = await pngFromResponse(await res.arrayBuffer());
    const blob = new Blob([png], { type: "image/png" });
    now = { rec, blob, url: URL.createObjectURL(blob) };
    histAdd(now);
    d.draft.seed = seed;
    d.log.unshift(rec);
    trimLog();
    store.persist();
  } catch (e) {
    if (e.name === "AbortError") errMsg = "취소함. (서버가 이미 받았으면 그 한 장은 계산됐을 수 있음)";
    else if (e instanceof TypeError) errMsg = "서버에 닿지 못함. 망이 끊겼는지 보기.";
    else errMsg = e.message || String(e);
  } finally {
    busy = null;
    phase = "";
    render();
  }
}

const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

function trimLog() {
  const log = store.data.log;
  if (log.length <= LOG_MAX) return;
  // 보관한 것은 그림과 이어져 있으니 남기고, 나머지 중 오래된 것부터 버린다.
  let extra = log.length - LOG_MAX;
  for (let i = log.length - 1; i >= 0 && extra > 0; i--) {
    if (log[i].verdict !== "keep") { log.splice(i, 1); extra--; }
  }
}

async function judge(verdict) {
  if (!now) return;
  const rec = store.data.log.find((r) => r.id === now.rec.id);
  if (!rec) return;
  if (verdict === "keep") {
    try { await imgPut({ id: rec.id, full: now.blob, thumb: await thumbOf(now.blob) }); }
    catch (e) { errMsg = `보관 실패: 이 기기 저장 공간이 모자라거나 막혀 있음 (${e?.name || e}). ‘저장’으로 사진첩에 먼저 빼 두기.`; return render(); }
    rec.verdict = "keep";
    now.rec.verdict = "keep";
  } else {
    // 버림은 완전히 버리는 것: 목록에서 빼고, 보관한 그림이었다면 보관함 저장분도 지운다. 실수를 위해 9초 동안만 알림의 ‘되돌리기’로 살릴 수 있다.
    const entry = now, before = rec.verdict, idx = hist.indexOf(entry);
    rec.verdict = "drop";
    if (idx >= 0) hist.splice(idx, 1);
    now = null;
    let row = null;
    if (before === "keep") { row = await imgGet(rec.id).catch(() => null); await imgDel(rec.id).catch(() => {}); }
    toast("버렸음", async () => {
      rec.verdict = before;
      hist.splice(Math.min(Math.max(idx, 0), hist.length), 0, entry);
      now = entry;
      if (row) await imgPut(row).catch(() => {});
      store.save();
    }, () => URL.revokeObjectURL(entry.url));
  }
  store.save();
}

async function removeKept(id) {
  await imgDel(id).catch(() => {});
  const rec = store.data.log.find((r) => r.id === id);
  if (rec) rec.verdict = "drop";
  const hi = hist.findIndex((h) => h.rec.id === id);
  if (hi >= 0) { const [h] = hist.splice(hi, 1); if (now === h) now = null; URL.revokeObjectURL(h.url); }
  store.persist();
  location.hash = "#/keep";
}

async function shareImage(blob, rec) {
  const name = `짤-${rec.seed}.png`;
  const file = new File([blob], name, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ── 취향 통계 ────────────────────────────────────────────────
// 고른 그림과 버린 그림의 태그를 세어, 고른 쪽에 치우친 것과 버린 쪽에 치우친 것을 낸다.
function tagStats() {
  const m = new Map();
  for (const r of store.data.log) {
    if (r.verdict !== "keep" && r.verdict !== "drop") continue;
    const tags = new Set(`${r.scene},${r.style}`.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean));
    for (const t of tags) {
      const c = m.get(t) || { keep: 0, drop: 0 };
      c[r.verdict]++;
      m.set(t, c);
    }
  }
  const mine = new Set(store.data.taste.style.split(/[,\n]/).map((t) => t.trim().toLowerCase()));
  const rows = [...m].map(([tag, c]) => ({ tag, ...c }));
  return {
    liked: rows.filter((r) => r.keep >= 2 && r.keep > r.drop && !mine.has(r.tag)).sort((a, b) => (b.keep - b.drop) - (a.keep - a.drop)).slice(0, 12),
    disliked: rows.filter((r) => r.drop >= 2 && r.drop > r.keep).sort((a, b) => (b.drop - b.keep) - (a.drop - a.keep)).slice(0, 12),
    judged: store.data.log.filter((r) => r.verdict).length,
  };
}

// ── 프롬프트 비서 (제미니) ───────────────────────────────────
// 폰에서 구글 서버(generativelanguage.googleapis.com)로 직접 부른다. 키는 이 폰에만 있다.
// 사전 요청에서 이 서버가 브라우저 호출을 허용하는 것은 확인했다 (2026-11-18, curl OPTIONS).
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/";
const CHAT_MAX = 40;
const RARE = 1000; // 단부루 게시물 수가 이보다 적은 태그는 NovelAI가 잘 못 알아듣는다 (art/태그사전/README.md)
let tags = null;        // tags.json: { ko: {한국어: [태그…]}, n: {태그: 게시물 수} }
let tagsState = "";     // "" | "loading" | "ok" | "fail"
let asking = null;      // AbortController
let askErr = "";
let askDraft = "";      // 쓰는 중인 질문. 화면이 다시 그려져도 남긴다
let scrollAi = false;

async function loadTags() {
  if (tags || tagsState === "loading") return;
  tagsState = "loading";
  try {
    const r = await fetch("tags.json");
    if (!r.ok) throw new Error(String(r.status));
    tags = await r.json();
    tagsState = "ok";
  } catch { tagsState = "fail"; }
}

// 사용자가 쓴 한국어 낱말에서 사전 후보를 뽑는다. 비서가 태그를 지어내지 않게 근거로 붙인다.
function candidates(text) {
  if (!tags) return [];
  const out = [], seen = new Set();
  const keys = Object.keys(tags.ko).filter((k) => k.length >= 2 && text.includes(k)).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    for (const t of tags.ko[k].slice(0, 2)) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(`${k} → ${t} (게시물 ${tags.n[t] ?? "수 없음"})`);
    }
    if (out.length >= 20) break;
  }
  return out;
}

function plainTags(t) {
  return t.replace(/-?\d*\.?\d+::|::/g, ",").replace(/[{}\[\]()]/g, "").split(/[,\n]/)
    .map((x) => x.trim().toLowerCase()).filter((x) => x && !x.includes(":") && !x.includes("@"));
}
// scene 블록의 태그를 사전과 맞춰 본다. 일반 태그만 사전에 있어서 캐릭터·작가 이름은 '사전에 없음'으로 나올 수 있다.
function checkTags(text) {
  if (!tags) return null;
  const missing = [], rare = [];
  for (const t of new Set(plainTags(text))) {
    const n = tags.n[t];
    if (n === undefined) missing.push(t);
    else if (n < RARE) rare.push(`${t}(${n})`);
  }
  return { missing, rare };
}

function parseBlocks(text) {
  const out = [], re = /```([a-z]*)\n?([\s\S]*?)```/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    out.push({ t: "code", lang: m[1].toLowerCase(), v: m[2].trim() });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

function stateText() {
  const { settings: s, taste, draft } = store.data;
  const [w, h] = sizeOf(s);
  const chars = draft.chars.filter((c) => tidy(c.text)).map((c, i) => `  ${i + 1}. ${tidy(c.text)}${Number.isInteger(c.pos) ? ` (위치 칸 ${c.pos + 1}번/25)` : ""}`).join("\n");
  const plan = refPlan(s);
  return `\n\n## 앱 상태 (지금)\n- 모델: ${modelId(s)} (바이브 ${supportsVibe(s) ? "됨" : "안 됨"}, 정밀 참조 ${supportsPrecise(s) ? "됨" : "안 됨"}, 인물별 프롬프트 ${supportsChars(s) ? "됨" : "안 됨"})\n- 이번 그림 칸: ${tidy(draft.scene) || "(비어 있음)"}\n- 인물별 프롬프트:${chars ? "\n" + chars : " 없음"}\n- 취향 프롬프트: ${tidy(taste.style) || "(비어 있음)"}\n- 빼는 것: ${tidy(taste.negative) || "(비어 있음)"}\n- 품질 태그 자동: ${s.quality ? "켜짐" : "꺼짐"}\n- 생성 설정: 샘플러 ${s.sampler}, 스텝 ${s.steps}, 프롬프트 강도 ${s.scale}, cfg_rescale ${s.cfgRescale}, 노이즈 스케줄 ${s.noise}, Variety+ ${s.variety ? "켬" : "끔"}, 크기 ${w}x${h}\n- 시드: ${Number.isInteger(draft.seed) ? draft.seed : "없음"}${draft.seedLock ? " (고정)" : ""}\n- 참고 그림: ${plan ? `${plan === "vibe" ? "바이브" : "정밀 참조"} ${refs.filter((r) => r.on).length}장` : "안 씀"}\n- 이미지→이미지: ${draft.i2i.on && src ? `켬 (strength ${draft.i2i.strength}, noise ${draft.i2i.noise})` : "끔"}${now ? `\n- 방금 뽑은 그림: 시드 ${now.rec.seed}, 그림은 ${ui.withImg ? "이 메시지에 첨부함" : "안 보여 줌"}` : ""}`;
}

// 제미니에 보내는 지시문 전체: 켠 조각들(+내 조각) + (켰다면) 앱 상태. 사전 후보는 질문마다 달라서 질문 쪽에 붙는다.
function fullPersona() {
  const d = store.data;
  return buildPersona(d.persona) + (d.persona.auto.state ? stateText() : "");
}

async function geminiFail(res) {
  let said = "";
  try { said = (JSON.parse(await res.text()).error?.message ?? "").slice(0, 200); } catch { /* 본문 없음 */ }
  const hint = res.status === 400 && /api key/i.test(said) ? "키가 틀림. ‘취향’ 탭에서 다시 넣기."
    : res.status === 403 ? "키 권한이 없거나 막힘."
    : res.status === 404 ? "모델 이름이 없음. ‘취향’ 탭에서 모델 고르기."
    : res.status === 429 ? "한도 초과. 잠시 뒤 직접 다시 보내기."
    : "";
  return `${hint} (제미니 ${res.status}${said ? `: ${said}` : ""})`.trim();
}

// opts.image: true면 방금 뽑은 그림을 이 질문에 붙여 구글로 보낸다 (사용자가 체크했을 때만)
async function ask(text, opts = {}) {
  const d = store.data, s = d.settings;
  askErr = "";
  const model = (s.aiModel === "custom" ? s.aiCustom : s.aiModel).trim().replace(/^models\//, "");
  if (!s.aiKey.trim()) { askErr = "제미니 키가 없음. ‘취향’ 탭 맨 아래에서 넣기."; return render(); }
  if (!model) { askErr = "제미니 모델 이름이 비어 있음. ‘취향’ 탭에서 고르기."; return render(); }
  const withImage = !!(opts.image && now);
  askDraft = "";
  d.chat.push({ role: "user", text, at: Date.now(), ...(withImage ? { img: true } : {}) });
  while (d.chat.length > CHAT_MAX) d.chat.shift();
  store.persist();
  asking = new AbortController();
  scrollAi = true;
  render();
  try {
    await loadTags();
    let hist = d.chat.slice(-20);
    while (hist.length && hist[0].role !== "user") hist.shift(); // 제미니는 사용자 말로 시작해야 한다
    const cand = d.persona.auto.cand ? candidates(text) : [];
    const img = withImage ? await shrinkJpeg(now.blob) : null;
    const contents = hist.map((m, i) => {
      const last = i === hist.length - 1;
      const parts = [{ text: last && cand.length ? `${m.text}\n\n[사전 후보]\n${cand.join("\n")}` : m.text }];
      if (last && img) parts.unshift({ inline_data: { mime_type: "image/jpeg", data: img } });
      return { role: m.role, parts };
    });
    const res = await fetch(`${GEMINI}${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: asking.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": s.aiKey.trim() },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: fullPersona() }] }, contents, generationConfig: { temperature: 0.8 } }),
    });
    if (!res.ok) throw new Error(await geminiFail(res));
    const j = await res.json();
    const c = j.candidates?.[0];
    const out = (c?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
    if (!out) throw new Error(`빈 답이 옴 (${c?.finishReason || j.promptFeedback?.blockReason || "이유 모름"}). 말을 바꿔 다시 보내기.`);
    d.chat.push({ role: "model", text: out, at: Date.now() });
    while (d.chat.length > CHAT_MAX) d.chat.shift();
    store.persist();
  } catch (e) {
    // 답이 없는 질문은 대화에서 빼고 입력칸에 되돌려 놓는다 (사용자 말을 잃지 않게)
    let i = d.chat.length - 1;
    while (i >= 0 && !(d.chat[i].role === "user" && d.chat[i].text === text)) i--;
    if (i >= 0) d.chat.splice(i, 1);
    askDraft = text;
    store.persist();
    if (e.name === "AbortError") askErr = "취소함.";
    else if (e instanceof TypeError) askErr = "구글 서버에 닿지 못함. 망이 끊겼는지 보기.";
    else askErr = e.message || String(e);
  } finally {
    asking = null;
    render();
  }
}

// ── 비서 답의 코드 블록을 칸에 넣기 ──────────────────────────
// 블록 종류: scene(이번 그림) / style(취향 그림체) / negative(빼는 것) / char(인물 한 명) / params(생성 설정 JSON)
const BLOCK_LABEL = { scene: "이번 그림에 넣기", style: "취향 그림체로 쓰기", negative: "빼는 것에 더하기", char: "인물 칸에 더하기", params: "설정 적용" };

function applyParams(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const s = store.data.settings, done = [];
  const set = (k, v, label) => { s[k] = v; done.push(`${label} ${v}`); };
  if (SAMPLERS[j.sampler]) set("sampler", j.sampler, "샘플러");
  if (j.steps != null) set("steps", clamp(j.steps, 1, MAX_STEPS, 28), "스텝");
  if (j.scale != null) set("scale", clamp(j.scale, 0, 10, 5), "프롬프트 강도");
  if (j.cfg_rescale != null) set("cfgRescale", clamp(j.cfg_rescale, 0, 1, 0), "cfg_rescale");
  if (NOISES.includes(j.noise_schedule)) set("noise", j.noise_schedule, "노이즈 스케줄");
  if (typeof j.variety === "boolean") set("variety", j.variety, "Variety+");
  if (SIZES[j.size]) set("size", j.size, "크기");
  return done;
}

function applyChar(text) {
  const lines = text.split("\n"), c = { id: crypto.randomUUID(), text: "", neg: "", pos: null };
  const body = [];
  for (const l of lines) {
    const pos = l.match(/^\s*pos\s*:\s*(\d{1,2})\s*$/i), neg = l.match(/^\s*neg\s*:\s*(.*)$/i);
    if (pos && +pos[1] >= 1 && +pos[1] <= 25) c.pos = +pos[1] - 1;
    else if (neg) c.neg = tidy(neg[1]);
    else body.push(l);
  }
  c.text = tidy(body.join("\n"));
  return c.text ? c : null;
}

// kind, 블록 글을 칸에 넣는다. 돌려주는 것은 사용자에게 알릴 한 줄 (null이면 아무것도 안 함)
function applyBlock(kind, v) {
  const d = store.data;
  if (kind === "scene") { d.draft.scene = tidy(v); d.draft.seedLock = false; return "이번 그림 칸을 바꿈"; }
  if (kind === "style") {
    if (!confirm(`취향 프롬프트를 바꿈. 앞으로 모든 그림에 붙음.\n\n지금 값: ${tidy(d.taste.style).slice(0, 140) || "(비어 있음)"}`)) return null;
    d.taste.style = tidy(v);
    return "취향 그림체를 바꿈";
  }
  if (kind === "negative") {
    if (!confirm("‘취향’ 탭의 빼는 것 뒤에 붙임. 앞으로 모든 그림에 적용됨.")) return null;
    d.taste.negative = [tidy(d.taste.negative), tidy(v)].filter(Boolean).join(", ");
    return "빼는 것에 더함";
  }
  if (kind === "char") {
    if (!supportsChars(d.settings)) return "이 모델은 인물별 프롬프트가 안 됨 (V4 이상)";
    if (d.draft.chars.length >= MAX_CHARS) return `인물은 ${MAX_CHARS}명까지`;
    const c = applyChar(v);
    if (!c) return "인물 태그가 비어 있음";
    d.draft.chars.push(c);
    ui.open.chars = true;
    return "인물 칸을 더함";
  }
  if (kind === "params") {
    const done = applyParams(v);
    if (!done) return "설정 JSON을 못 읽음";
    return done.length ? `설정 적용: ${done.join(", ")}` : "적용할 수 있는 칸이 없음";
  }
  return null;
}

// 비서 한 메시지를 HTML로. i는 chat 안의 번호. 블록 버튼의 data-blk는 "i:j"
function msgHtml(m, i) {
  if (m.role === "user") return `<div class="msg me">${esc(m.text)}${m.img ? `<small class="att">방금 그림 첨부</small>` : ""}</div>`;
  const parts = parseBlocks(m.text).map((b, j) => {
    if (b.t === "text") return b.v.trim() ? `<p class="mt">${esc(b.v.trim())}</p>` : "";
    const id = `${i}:${j}`;
    const btn = BLOCK_LABEL[b.lang] ? `<button type="button" data-blk="${id}" data-kind="${b.lang}">${BLOCK_LABEL[b.lang]}</button>` : "";
    let check = "";
    if (b.lang === "scene" || b.lang === "char") {
      const c = checkTags(b.v);
      if (c && (c.missing.length || c.rare.length)) {
        check = `<p class="hint">${c.missing.length ? `사전(일반 태그)에 없음: ${esc(c.missing.join(", "))}. 자연어 문구나 캐릭터 이름일 수 있음. ` : ""}${c.rare.length ? `게시물 ${RARE}개 미만이라 약할 수 있음: ${esc(c.rare.join(", "))}` : ""}</p>`;
      } else if (!c) check = `<p class="hint">태그 사전을 못 불러와 검사를 못 함.</p>`;
    }
    return `<div class="code"><pre>${esc(b.v)}</pre><div class="acts2">${btn}<button type="button" class="ghost" data-copy="${id}">복사</button></div>${check}</div>`;
  }).join("");
  return `<div class="msg ai">${parts || esc(m.text)}</div>`;
}

// ── 화면 ────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── 뽑기 화면 조각들 ─────────────────────────────────────────
// 접었다 펴는 칸. 화면이 다시 그려져도 펼친 상태를 기억하려고 ui.open에 둔다 (새로 고치면 처음으로).
const ui = { open: {}, withImg: false, presetKind: "인물", pedit: null, showHidden: false, pput: null, pputText: "" };
const sec = (k, title, hint, inner) =>
  `<details class="sec" data-sec="${k}" ${ui.open[k] ? "open" : ""}><summary>${title}${hint ? ` <small>${esc(hint)}</small>` : ""}</summary><div class="secbody">${inner}</div></details>`;

const QUICK = {
  pose: "이번 그림 칸의 인물·의상은 그대로 두고, 내 취향에 맞는 자세·구도를 서로 다른 3안으로 줘. 각 안은 scene 블록 전체 프롬프트로.",
  style: "지금 장면과 인물에 어울리는 그림체를 내 취향대로 잡아서 style 블록 하나로 줘. 지금 취향 프롬프트와 뭐가 다른지 한 줄.",
  tidy: "이번 그림 칸 프롬프트를 정리해 줘. 겹치는 태그, 서로 부딪치는 태그, 반영이 약한 태그를 고쳐서 scene 블록 전체로. 바뀐 점은 한 줄.",
  params: "이 장면에 맞는 생성 설정을 params 블록 JSON으로 추천해 줘. Anlas가 안 드는 범위(스텝 28 이하, 일반 크기)에서. 이유 한 줄.",
};

function aiPanel() {
  const { settings: s, chat } = store.data;
  const last = chat.length ? chat.length - 1 : -1;
  // 마지막 질문과 그 답만 여기서 보인다. 전체 대화는 ‘비서’ 탭.
  const shown = [];
  if (last >= 0) { if (chat[last].role === "model" && last > 0) shown.push(last - 1); shown.push(last); }
  const body = `
    ${s.aiKey.trim() ? "" : `<p class="notice">제미니 키가 아직 없음. <a href="#/taste">‘취향’ 탭 맨 아래</a>에서 넣어야 대답함.</p>`}
    <div class="chips">
      <button type="button" class="chip" data-quick="pose">자세 3안</button>
      <button type="button" class="chip" data-quick="style">그림체 잡기</button>
      <button type="button" class="chip" data-quick="tidy">프롬프트 다듬기</button>
      <button type="button" class="chip" data-quick="params">설정 추천</button>
      <button type="button" class="chip" data-quick="fix">방금 것 고치기</button>
    </div>
    ${shown.length ? `<div class="chat">${shown.map((i) => msgHtml(chat[i], i)).join("")}${asking ? `<div class="msg ai dim">생각 중…</div>` : ""}</div>` : (asking ? `<div class="msg ai dim">생각 중…</div>` : "")}
    ${askErr ? `<p class="error" role="alert">${esc(askErr)}</p>` : ""}
    <textarea id="ask" rows="3" placeholder="예: 팔짱 끼고 내려다보게, 표정은 더 차갑게" autocomplete="off">${esc(askDraft)}</textarea>
    ${now ? `<label class="line"><input type="checkbox" id="withImg" ${ui.withImg ? "checked" : ""}> 방금 뽑은 그림도 같이 보여 주기 <span class="hint">체크하면 이 그림이 구글로 감</span></label>` : ""}
    ${asking ? `<button type="button" id="stopAsk" class="ghost">눌러서 취소</button>` : `<button type="button" id="send">AI에게 부탁</button>`}
    <p class="hint"><a href="#/ai">‘비서’ 탭</a> 맨 아래에서 비서 지시문을 고칠 수 있음.</p>`;
  return sec("ai", "AI 도우미", "자세·그림체·수정·설정", body);
}

function charsInner() {
  const { settings: s, draft } = store.data;
  if (!supportsChars(s)) return `<p class="hint">이 모델은 인물별 프롬프트가 안 됨 (V4 이상에서만).</p>`;
  const list = draft.chars.map((c, i) => `
    <div class="char">
      <div class="charhead"><b>인물 ${i + 1}</b><button type="button" class="ghost sm" data-cdel="${c.id}">빼기</button></div>
      <textarea data-ctext="${c.id}" rows="3" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="girl, silver hair, tanned skin">${esc(c.text)}</textarea>
      <input type="text" data-cneg="${c.id}" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="이 인물에서만 뺄 것 (선택)" value="${esc(c.neg || "")}">
      <div class="posgrid" role="group" aria-label="인물 ${i + 1} 위치">
        ${Array.from({ length: 25 }, (_, n) => `<button type="button" class="${c.pos === n ? "on" : ""}" data-cpos="${c.id}:${n}" aria-label="${n % 5 + 1}열 ${Math.floor(n / 5) + 1}행"></button>`).join("")}
      </div>
      <button type="button" class="ghost sm" data-cpos="${c.id}:auto">${c.pos == null ? "✓ " : ""}AI가 위치를 정함</button>
    </div>`).join("");
  return `${list}
    <button type="button" class="ghost" id="addChar" ${draft.chars.length >= MAX_CHARS ? "disabled" : ""}>＋ 인물 더하기 (${draft.chars.length}/${MAX_CHARS})</button>
    <p class="hint">인원 태그(2girls 등)는 위 ‘이번 그림’에 쓰고, 인물 칸에는 girl·boy처럼 숫자 없이 (NovelAI 문서). 인물 칸에는 취향 프롬프트·품질 태그가 안 붙음. 위치는 5x5 칸에서 고르고, 글로도 같이 쓰면 더 잘 따라옴(문서). 인물이 여럿이면 번짐이 생길 수 있음.</p>`;
}

function refInner() {
  const s = store.data.settings;
  if (!supportsVibe(s)) {
    return `<p class="hint">참고 그림은 V4.5 Full에서만 됨. V5는 서버가 거절함(2026-11-17 확인). ${refs.length ? `붙여 둔 ${refs.length}장은 V5에서는 안 보냄. ` : ""}‘취향’ 탭에서 모델을 V4.5 Full로 바꾸면 쓸 수 있음.</p>`;
  }
  const mode = s.refMode === "precise" ? "precise" : "vibe";
  const key = (r) => `${modelId(s)}|${r.info}`;
  const sum = refs.filter((r) => r.on).reduce((a, r) => a + r.strength, 0);
  const row = (r) => `
    <li class="ref">
      <img src="${r.url}" alt="${esc(r.name)}">
      <div class="refbody">
        <label class="line"><input type="checkbox" data-ron="${r.id}" ${r.on ? "checked" : ""}> 쓰기 <span class="hint">${esc(r.name)}</span></label>
        <label>강도 <output id="rs-${r.id}">${r.strength}</output><input type="range" min="0" max="1" step="0.05" value="${r.strength}" data-rstr="${r.id}"></label>
        ${mode === "precise" ? `
        <label>충실도 <output id="rf-${r.id}">${r.fid ?? 0.5}</output><input type="range" min="0" max="1" step="0.05" value="${r.fid ?? 0.5}" data-rfid="${r.id}"></label>
        <label>무엇을 따라 할까<select data-rkind="${r.id}"><option value="character&style" ${r.kind !== "character" ? "selected" : ""}>캐릭터와 화풍</option><option value="character" ${r.kind === "character" ? "selected" : ""}>캐릭터만</option></select></label>` : ""}
        <label>정보량 <span class="hint">0~1${mode === "vibe" ? ", 바꾸면 다시 인코딩" : ""}</span><input type="number" inputmode="decimal" min="0" max="1" step="0.1" value="${r.info}" data-rinfo="${r.id}"></label>
        ${mode === "vibe" ? `<p class="hint">${r.enc?.[key(r)] ? "인코딩 있음 (다시 안 함)" : "다음 뽑기에서 인코딩 — 문서 기준 2 Anlas"}</p>` : ""}
        <button type="button" class="ghost" data-rdel="${r.id}">빼기</button>
      </div>
    </li>`;
  return `
    <div class="seg seg2" role="group" aria-label="참고 방식">
      <button type="button" class="${mode === "vibe" ? "on" : ""}" data-rmode="vibe">바이브<small>화풍·색·분위기</small></button>
      <button type="button" class="${mode === "precise" ? "on" : ""}" data-rmode="precise" ${supportsPrecise(s) ? "" : "disabled"}>정밀 참조<small>${supportsPrecise(s) ? "캐릭터·옷 모양" : "V4.5에서만"}</small></button>
    </div>
    ${refs.length ? `<ul class="refs">${refs.map(row).join("")}</ul>` : ""}
    <input id="refFile" type="file" accept="image/*" multiple hidden>
    <button type="button" class="ghost" id="addRef" ${refs.length >= MAX_REFS ? "disabled" : ""}>＋ 그림 붙이기 (${refs.length}/${MAX_REFS})</button>
    ${mode === "vibe" && sum > 1 ? `<p class="hint warn">켜 둔 강도 합이 ${sum.toFixed(2)}임. 1을 넘으면 프롬프트를 덜 듣는 경향이 있음(문서).</p>` : ""}
    <p class="hint">${mode === "precise" ? "정밀 참조는 바이브와 같이 못 쓰고, 한 장 뽑을 때마다 5 Anlas가 더 듦(문서). 참고 그림은 검은 여백을 넣어 1024×1536 등에 맞춰 보냄. 서 있는 전신, 단순 배경이 잘 됨." : "바이브는 인코딩을 한 번 하면 저장해 둠."} 긴 변 1024px로 줄여 이 폰에만 저장되고, 뽑을 때 NovelAI 서버로 같이 감.</p>`;
}

function i2iInner() {
  const { draft } = store.data;
  const on = draft.i2i.on && src;
  return `
    <label class="line"><input type="checkbox" id="i2iOn" ${on ? "checked" : ""} ${src ? "" : "disabled"}> 이 그림을 바탕으로 뽑기</label>
    ${src ? `<div class="srcrow"><img src="${src.url}" alt="바탕 그림"><div><span class="hint">${esc(src.name)}</span><button type="button" class="ghost sm" id="srcDel">빼기</button></div></div>` : `<p class="hint">바탕 그림이 아직 없음.</p>`}
    <input id="srcFile" type="file" accept="image/*" hidden>
    <div class="acts2"><button type="button" class="ghost" id="srcAdd">＋ 사진 고르기</button>${now ? `<button type="button" class="ghost" id="srcNow">방금 그림으로</button>` : ""}</div>
    <label>Strength <output id="i2s">${draft.i2i.strength}</output><input type="range" id="i2iStr" min="0" max="1" step="0.05" value="${draft.i2i.strength}"></label>
    <label>Noise <output id="i2n">${draft.i2i.noise}</output><input type="range" id="i2iNoise" min="0" max="1" step="0.05" value="${draft.i2i.noise}"></label>
    <p class="hint">Strength가 높을수록 바탕 그림에서 많이 벗어나 프롬프트를 따름. Noise는 새 디테일을 더함(문서). 둘 다 0이면 거의 같은 그림이 나옴. 바탕 그림은 지금 크기에 맞춰 가운데를 잘라 보냄.</p>`;
}

function advInner() {
  const s = store.data.settings;
  return `
    <label for="sampler">샘플러</label>
    <select id="sampler">${Object.entries(SAMPLERS).map(([k, v]) => `<option value="${k}" ${s.sampler === k ? "selected" : ""}>${v}</option>`).join("")}</select>
    <div class="two">
      <label>스텝 <span class="hint">1~${MAX_STEPS}</span><input id="steps" type="number" inputmode="numeric" min="1" max="${MAX_STEPS}" value="${esc(s.steps)}"></label>
      <label>프롬프트 강도 <span class="hint">0~10</span><input id="scale" type="number" inputmode="decimal" min="0" max="10" step="0.5" value="${esc(s.scale)}"></label>
    </div>
    <div class="two">
      <label>cfg rescale <span class="hint">0~1</span><input id="cfgRescale" type="number" inputmode="decimal" min="0" max="1" step="0.05" value="${esc(s.cfgRescale)}"></label>
      <label for="noise">노이즈 스케줄<select id="noise">${NOISES.map((n) => `<option value="${n}" ${s.noise === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    </div>
    <label class="line"><input type="checkbox" id="variety" ${s.variety ? "checked" : ""}> Variety+ <span class="hint">구도·인물이 더 다양해짐. 값 ${VARIETY_SIGMA}</span></label>
    <p class="hint">스텝 ${FREE_STEPS} 이하, 일반 크기 이하, 한 장씩이면 Opus는 Anlas가 안 듦(문서). 넘기면 Anlas가 들 수 있음. Variety+의 값은 200이 오는 것만 확인했고 NovelAI 화면과 같은 값인지는 확인 못 함. DPM++ 2M과 Euler Ancestral이 NovelAI 권장 샘플러임(문서).</p>`;
}

const PKINDS = PRESET_KINDS;
const KIND_TO = { 인물: "scene", 그림체: "style", "자세·구도": "scene", "빼는 것": "neg" }; // 종류 탭에서 새로 만들면 여기에 넣는 곳이 정해진다
const TARGET = { scene: "이번 그림", style: "취향 그림체", neg: "빼는 것" };
const PFIELDS = ["name", "text", "neg", "note"];
const bkey = (kind, p) => `b:${kind}:${p.name}`;
const baseOf = (key) => { const m = key.match(/^b:([^:]+):(.+)$/); return m ? (PRESETS[m[1]] || []).find((b) => b.name === m[2]) : null; };

// 한 종류의 프리셋 전부: 내장(고친 것 반영) + 내가 만든 것. 내장의 key는 기본 이름으로 고정이라 이름을 고쳐도 안 바뀐다.
function presetEntries(kind) {
  const d = store.data, out = [];
  for (const base of PRESETS[kind] || []) {
    const key = bkey(kind, base), e = d.presetEdits[key] || {};
    const p = { ...base };
    for (const f of PFIELDS) if (typeof e[f] === "string") p[f] = e[f];
    out.push({ key, p, own: false, hidden: !!e.hidden, edited: PFIELDS.some((f) => typeof e[f] === "string") });
  }
  for (const p of d.presets) if (p.kind === kind) out.push({ key: `own:${p.id}`, p, own: true, hidden: false, edited: false });
  return out;
}
// 칸을 바꾸는 것(이번 그림·취향 그림체·빼는 것)을 넣기 전 값으로 기억해 두고, 넣은 뒤 ‘되돌리기’를 단다.
function applyPreset(p, mode) {
  const d = store.data;
  const snap = { scene: d.draft.scene, seedLock: d.draft.seedLock, style: d.taste.style, negative: d.taste.negative };
  const msg = usePreset(p, mode);
  const changed = snap.scene !== d.draft.scene || snap.style !== d.taste.style || snap.negative !== d.taste.negative;
  toast(msg, changed ? () => {
    d.draft.scene = snap.scene; d.draft.seedLock = snap.seedLock; d.taste.style = snap.style; d.taste.negative = snap.negative;
    store.save();
  } : null);
  store.save();
}
const targetNow = (p) => tidy(p.to === "scene" ? store.data.draft.scene : p.to === "style" ? store.data.taste.style : store.data.taste.negative);
const presetByKey = (key) => {
  if (key.startsWith("own:")) return store.data.presets.find((p) => p.id === key.slice(4));
  const m = key.match(/^b:([^:]+):/);
  return m ? presetEntries(m[1]).find((e) => e.key === key)?.p : null;
};

// ‘바꾸기’를 누르면 곧바로 덮어쓰지 않고, 넣을 글을 여기서 고친 뒤 넣는다. 여기서 고친 글은 이번에만 쓰이고 프리셋 자체는 ‘고치기’로 바꾼다.
function presetPut(e) {
  const { p, key } = e, cur = targetNow(p);
  return `
    <div class="preset pput" data-pput="${esc(key)}">
      <div class="phead"><b>${esc(p.name) || "이름 없음"}</b><span class="tag">넣기 전에 고치기</span></div>
      <label>넣을 글 <span class="hint">여기서 고친 것은 이번에만 쓰임</span>
        <textarea data-pputtext rows="6" autocapitalize="off" autocomplete="off" spellcheck="false">${esc(ui.pputText)}</textarea></label>
      <p class="hint">지금 ${TARGET[p.to]} 칸: ${cur ? esc(cur.length > 160 ? cur.slice(0, 160) + "…" : cur) : "(비어 있음)"}<br>‘바꿔 넣기’는 이 칸을 위 글로 통째로 바꿈. 넣은 뒤 ‘되돌리기’로 돌릴 수 있음.</p>
      <div class="acts2">
        <button type="button" data-pputgo="replace">바꿔 넣기</button>
        <button type="button" class="ghost" data-pputgo="add">더하기</button>
        <button type="button" class="ghost" data-pputcancel>취소</button>
      </div>
    </div>`;
}

function presetCard(e) {
  const { p, key } = e;
  if (ui.pput === key) return presetPut(e);
  const badge = e.own ? TARGET[p.to] : e.edited ? "고침" : p.ok ? "확정" : "가안";
  if (e.hidden) return `<div class="preset dim"><div class="phead"><b>${esc(p.name)}</b><span class="tag">숨김</span></div><div class="acts2"><button type="button" class="ghost" data-punhide="${esc(key)}">숨김 풀기</button></div></div>`;
  return `
    <div class="preset">
      <div class="phead"><b>${esc(p.name) || "이름 없음"}</b><span class="tag ${!e.own && !e.edited && p.ok ? "ok" : ""}">${badge}</span></div>
      <p class="ptext">${esc(p.text) || "(비어 있음)"}</p>
      ${p.note ? `<p class="hint">${esc(p.note)}</p>` : ""}
      <div class="acts2">
        <button type="button" data-pset="${esc(key)}" data-pmode="add">더하기</button>
        <button type="button" class="ghost" data-pset="${esc(key)}" data-pmode="replace">바꾸기</button>
        ${p.neg ? `<button type="button" class="ghost" data-pset="${esc(key)}" data-pmode="neg">금지 태그도</button>` : ""}
        <button type="button" class="ghost" data-pedit="${esc(key)}">고치기</button>
      </div>
    </div>`;
}

// 고치는 칸. 글자를 칠 때는 저장만 하고 다시 그리지 않는다(키보드가 내려가지 않게). ‘완료’를 누르면 카드로 돌아간다.
function presetForm(e, kind) {
  const { p, key } = e;
  const f = (name, label, hint, rows, ph) => `<label>${label}${hint ? ` <span class="hint">${hint}</span>` : ""}${rows
    ? `<textarea data-pf="${name}" rows="${rows}" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${ph || ""}">${esc(p[name] ?? "")}</textarea>`
    : `<input type="text" data-pf="${name}" autocomplete="off" value="${esc(p[name] ?? "")}">`}</label>`;
  return `
    <div class="preset pform" data-pform="${esc(key)}">
      ${f("name", "이름", "", 0)}
      ${f("text", "내용", "영어 태그, 쉼표로", 5, "1girl, silver hair, looking at viewer")}
      ${p.to !== "neg" ? f("neg", "같이 뺄 것", "‘금지 태그도’를 누르면 빼는 것에 더함", 2) : ""}
      ${f("note", "메모", "", 0)}
      ${e.own && kind === "내 것" ? `<label>넣는 곳<select data-pf="to">${Object.entries(TARGET).map(([k, v]) => `<option value="${k}" ${p.to === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
      <div class="acts2">
        <button type="button" data-pdone>완료</button>
        ${e.own ? `<button type="button" class="ghost" data-pdel="${esc(p.id)}">지우기</button>` : `
        <button type="button" class="ghost" data-prevert="${esc(key)}" ${e.edited ? "" : "disabled"}>기본값으로</button>
        <button type="button" class="ghost" data-phide="${esc(key)}">숨기기</button>`}
      </div>
    </div>`;
}

function presetInner() {
  const kind = ui.presetKind;
  const all = presetEntries(kind);
  const nHidden = all.filter((e) => e.hidden).length;
  const shown = all.filter((e) => !e.hidden || ui.showHidden);
  const list = (shown.length ? shown.map((e) => (e.key === ui.pedit ? presetForm(e, kind) : presetCard(e))).join("") : `<p class="hint">${kind === "내 것" ? "저장한 것이 아직 없음." : "없음."}</p>`) + `
    <div class="acts2">
      <button type="button" class="ghost" data-padd>＋ 새로 추가</button>
      ${kind === "내 것" ? `<button type="button" class="ghost" data-psave="scene">지금 이번 그림 저장</button><button type="button" class="ghost" data-psave="style">지금 취향 그림체 저장</button><button type="button" class="ghost" data-psave="neg">지금 빼는 것 저장</button>` : ""}
      ${nHidden ? `<button type="button" class="ghost" data-pshowhidden>${ui.showHidden ? "숨긴 것 감추기" : `숨긴 것 ${nHidden}개 보기`}</button>` : ""}
    </div>`;
  return `
    <div class="chips pk">${PKINDS.map((k) => `<button type="button" class="chip ${k === kind ? "on" : ""}" data-pkind="${k}">${k}</button>`).join("")}</div>
    ${list}
    <p class="hint">확정 = art 저장소에서 사용자가 확정한 것. 가안 = 사용자의 취향에서 이 앱이 짠 것이고, 태그는 사전에서 게시물 수를 확인함. 고친 것은 이 폰에만 저장되고, ‘기본값으로’로 되돌림. 인물은 이번 그림 맨 앞에, 자세·구도는 뒤에 더해짐.</p>`;
}

function mergeTags(cur, add, front) {
  const a = tidy(cur).split(", ").filter(Boolean), b = tidy(add).split(", ").filter(Boolean);
  const out = front ? [...b, ...a.filter((t) => !b.includes(t))] : [...a, ...b.filter((t) => !a.includes(t))];
  return out.join(", ");
}
// 프리셋을 칸에 넣는다. mode: add | replace | neg(금지 태그를 빼는 것에 더함). 알릴 한 줄을 돌려준다.
function usePreset(p, mode) {
  const d = store.data;
  if (mode !== "neg" && !tidy(p.text || "")) return "내용이 비어 있음. ‘고치기’에서 채우기";
  if (mode === "neg" && !tidy(p.neg || "")) return "같이 뺄 것이 비어 있음";
  if (mode === "neg") { d.taste.negative = mergeTags(d.taste.negative, p.neg, false); return `‘${p.name}’의 금지 태그를 빼는 것에 더함`; }
  if (p.to === "scene") { d.draft.scene = mode === "replace" ? tidy(p.text) : mergeTags(d.draft.scene, p.text, p.at === "front"); d.draft.seedLock = false; return `‘${p.name}’을 이번 그림에 ${mode === "replace" ? "바꿔 넣음" : "더함"}`; }
  if (p.to === "style") { const old = tidy(d.taste.style); d.taste.style = mode === "add" ? mergeTags(old, p.text, false) : tidy(p.text); return `취향 그림체에 ‘${p.name}’을 ${mode === "add" ? "더함" : "넣음"}${mode === "add" ? "" : `. 이전 값: ${old.slice(0, 90)}${old.length > 90 ? "…" : ""}`}`; }
  const old = tidy(d.taste.negative);
  d.taste.negative = mode === "replace" ? tidy(p.text) : mergeTags(old, p.text, false);
  return `빼는 것에 ‘${p.name}’을 ${mode === "replace" ? `넣음. 이전 값: ${old.slice(0, 90)}${old.length > 90 ? "…" : ""}` : "더함"}`;
}

// ── 비서 지시문 고치기 ───────────────────────────────────────
// 기본 조각(assistant.js)은 바꾸지 않고, 고친 것만 store.data.persona에 덮어쓴다. 되돌리면 기본 글이 다시 나온다.
function personaEditor() {
  const pc = store.data.persona;
  const part = (p) => {
    const st = partState(pc, p);
    return sec(`pp:${p.id}`, esc(p.name), [st.on ? "" : "꺼짐", st.edited ? "고침" : ""].filter(Boolean).join(" · "), `
      <label class="line"><input type="checkbox" data-pon="${p.id}" ${st.on ? "checked" : ""}> 이 조각 쓰기</label>
      <textarea data-ptext="${p.id}" rows="9" spellcheck="false" autocomplete="off">${esc(st.text)}</textarea>
      <button type="button" class="ghost sm" data-prev="${p.id}" ${st.edited ? "" : "disabled"}>이 조각 기본값으로</button>`);
  };
  const extra = (e) => sec(`pe:${e.id}`, esc(e.name || "내 조각"), e.on ? "" : "꺼짐", `
      <label class="line"><input type="checkbox" data-eon="${e.id}" ${e.on ? "checked" : ""}> 이 조각 쓰기</label>
      <label>이름<input type="text" data-ename="${e.id}" maxlength="30" autocomplete="off" value="${esc(e.name)}"></label>
      <textarea data-etext="${e.id}" rows="6" spellcheck="false" autocomplete="off" placeholder="비서가 늘 지킬 말을 적기">${esc(e.text)}</textarea>
      <button type="button" class="ghost sm" data-edel="${e.id}">이 조각 지우기</button>`);
  const full = fullPersona();
  const body = `
    <p class="hint">여기 글이 그대로 제미니의 지시문이 됨. 조각마다 끄거나 고칠 수 있고, 고친 조각은 ‘기본값으로’ 되돌림. 코드 블록 형식(scene·style 등)을 지운 조각을 끄면 답의 ‘넣기’ 버튼이 안 나올 수 있음.</p>
    ${PERSONA_PARTS.map(part).join("")}
    <h2>내 조각</h2>
    ${pc.extra.length ? pc.extra.map(extra).join("") : `<p class="hint">더한 것이 아직 없음. 말투·금지어·늘 넣을 태그 같은 것을 조각으로 따로 두면 기본 조각을 안 건드려도 됨.</p>`}
    <button type="button" class="ghost" id="addPiece" ${pc.extra.length >= 20 ? "disabled" : ""}>＋ 내 조각 더하기</button>
    <h2>앱이 자동으로 붙이는 것</h2>
    <label class="line"><input type="checkbox" id="autoState" ${pc.auto.state ? "checked" : ""}> 앱 상태 <span class="hint">지금 모델·크기·칸 내용</span></label>
    <label class="line"><input type="checkbox" id="autoCand" ${pc.auto.cand ? "checked" : ""}> 사전 후보 <span class="hint">한국어 낱말 → 단부루 태그</span></label>
    ${sec("pprev", "보내는 지시문 미리 보기", "", `<p class="hint" id="pcount">${full.length}자</p><pre class="pprev" id="pprevtxt">${esc(full)}</pre><p class="hint">사전 후보는 질문마다 달라서 여기엔 안 보임.</p>`)}
    <button type="button" class="ghost" id="pReset">지시문 전부 기본값으로</button>`;
  return sec("persona", "비서 지시문 고치기", "조각을 끄고 켜고 고침", body);
}

// 이번에 뽑은 그림 목록. 눌러서 크게 다시 본다 (새로 뽑거나 버린 그림을 되돌리는 길).
function histStrip() {
  if (!hist.length || (hist.length === 1 && hist[0] === now)) return "";
  const items = [...hist].reverse().map((h) => `<button type="button" class="hthumb ${h === now ? "on" : ""} ${h.rec.verdict === "keep" ? "kept" : ""}" data-hist="${esc(h.rec.id)}" aria-label="시드 ${h.rec.seed} 그림 다시 보기"><img src="${h.url}" alt=""></button>`).join("");
  return `<div class="hist"><p class="hint">이번에 뽑은 그림 ${hist.length}장 — 눌러서 다시 봄. 새로 고치면 사라지니 남길 것은 ♥ 보관.</p><div class="hstrip">${items}</div></div>`;
}

const SCREENS = {
  gen() {
    const { settings: s, taste, draft } = store.data;
    const styleLen = tidy(taste.style).length;
    const notes = anlasNotes(s, draft);
    const [w, h] = sizeOf(s);
    const nChars = draft.chars.filter((c) => tidy(c.text)).length;
    const nRefs = refPlan(s) ? refs.filter((r) => r.on).length : 0;
    return `
      ${s.token.trim() ? "" : `<p class="notice">NovelAI 토큰이 아직 없음. <a href="#/taste">‘취향’ 탭 맨 아래</a>에서 넣어야 뽑힘.</p>`}
      ${aiPanel()}
      <label for="scene">이번 그림 <span class="hint">영어 태그, 쉼표로</span></label>
      <textarea id="scene" rows="4" autocapitalize="off" autocomplete="off" spellcheck="false"
        placeholder="1girl, silver hair, looking at viewer, upper body">${esc(draft.scene)}</textarea>
      <p class="hint">${styleLen ? `여기에 취향 프롬프트(${styleLen}자)` : `취향 프롬프트는 아직 비어 있고,`}${s.quality ? " 품질 태그가" : ""} 뒤에 붙음. 아래 ‘프리셋’에서 인물·자세·그림체를 눌러 넣을 수 있음.</p>
      <div class="acts2"><button type="button" class="ghost sm" id="saveScene">이 프롬프트를 내 프리셋으로 저장</button></div>
      <div class="seg seg4" role="group" aria-label="크기">
        ${[...Object.keys(SIZES), "직접"].map((k) => `<button type="button" class="${s.size === k ? "on" : ""}" data-size="${k}">${k}<small>${k === "직접" ? `${w}×${h}` : SIZES[k].join("×")}</small></button>`).join("")}
      </div>
      ${s.size === "직접" ? `<div class="two"><label>가로 <span class="hint">64 단위</span><input id="customW" type="number" inputmode="numeric" step="64" min="64" max="1536" value="${w}"></label><label>세로<input id="customH" type="number" inputmode="numeric" step="64" min="64" max="1536" value="${h}"></label></div>` : ""}
      <label for="seed">시드 <span class="hint">같은 시드·같은 설정이면 같은 그림</span></label>
      <div class="seedrow"><input id="seed" type="number" inputmode="numeric" min="0" max="4294967295" placeholder="비우면 무작위" value="${Number.isInteger(draft.seed) ? draft.seed : ""}"><button type="button" class="ghost" id="seedRand">무작위</button></div>
      <label class="line"><input type="checkbox" id="seedLock" ${draft.seedLock ? "checked" : ""}> 이 시드로 고정 <span class="hint">${draft.seedLock ? "다음 장도 같은 시드" : "끄면 매번 새 시드"}</span></label>
      ${notes.length ? `<p class="hint warn">Anlas가 들 수 있음 (문서 기준, 이 앱에서 차감은 재 보지 않음): ${esc(notes.join(" · "))}</p>` : ""}
      ${busy
        ? `<button type="button" id="stop" class="ghost big">${esc(phase || "뽑는 중…")} 눌러서 취소</button>`
        : `<button type="button" id="go" class="big">뽑기${nChars || nRefs || (draft.i2i.on && src) ? ` <small>(${[nChars ? `인물 ${nChars}` : "", nRefs ? `참고 ${nRefs}` : "", draft.i2i.on && src ? "이미지→이미지" : ""].filter(Boolean).join(" · ")})</small>` : ""}</button>`}
      ${errMsg ? `<p class="error" role="alert">${esc(errMsg)}</p>` : ""}
      ${now ? `
        <figure class="result">
          <img src="${now.url}" alt="방금 뽑은 그림" width="${now.rec.w}" height="${now.rec.h}">
          <figcaption class="hint">시드 ${now.rec.seed} · ${now.rec.w}×${now.rec.h} · ${esc(now.rec.model)} · ${esc(SAMPLERS[now.rec.sampler] || "")} ${now.rec.steps}스텝${now.rec.refs?.length ? ` · 참고 ${now.rec.refs.length}장` : ""}${now.rec.chars?.length ? ` · 인물 ${now.rec.chars.length}` : ""}${now.rec.i2i ? " · 이미지→이미지" : ""}</figcaption>
        </figure>
        <div class="acts">
          ${now.rec.verdict === "keep"
            ? `<button type="button" class="ghost" disabled>보관함에 있음</button>`
            : `<button type="button" id="keep">♥ 보관</button>`}
          <button type="button" id="drop" class="ghost">✕ 버림</button>
          <button type="button" id="share" class="ghost">저장</button>
        </div>
        <div class="acts two">
          <button type="button" id="useSeed" class="ghost">이 시드로 고정</button>
          <button type="button" id="toI2i" class="ghost">이 그림으로 변형</button>
        </div>
        <p class="hint">보관과 버림이 쌓이면 ‘취향’ 탭에 자주 고른 태그가 나옴. 안 고른 그림은 새로 고치면 사라짐.</p>` : ""}
      ${histStrip()}
      ${sec("chars", "인물별 프롬프트", nChars ? `${nChars}명` : "", charsInner())}
      ${sec("ref", "참고 그림", nRefs ? `${s.refMode === "precise" ? "정밀 참조" : "바이브"} ${nRefs}장` : "", refInner())}
      ${sec("i2i", "이미지→이미지", draft.i2i.on && src ? "켬" : "", i2iInner())}
      ${sec("adv", "생성 설정", `${SAMPLERS[s.sampler] || s.sampler} · ${s.steps}스텝 · 강도 ${s.scale}`, advInner())}
      ${sec("preset", "프리셋 · 쓸 만한 프롬프트", "인물·그림체·자세·빼는 것", presetInner())}`;
  },

  ai() {
    const { settings: s, chat } = store.data;
    const bubbles = chat.map((m, i) => msgHtml(m, i)).join("");
    return `
      ${s.aiKey.trim() ? "" : `<p class="notice">제미니 키가 아직 없음. <a href="#/taste">‘취향’ 탭 맨 아래</a>에서 넣어야 대답함.</p>`}
      ${chat.length ? "" : `<p class="empty">그리고 싶은 장면을 말로 던지면<br>NovelAI 태그 프롬프트로 바꿔 줌.<br><small>예: 금발 정장 입은 중국식 미인, 로우앵글로 내려다보는 오만한 느낌</small><br><small>자세·그림체·설정 추천과 그림 고치기는 ‘뽑기’ 탭 맨 위 AI 도우미에서도 됨.</small></p>`}
      <div class="chat">${bubbles}${asking ? `<div class="msg ai dim">생각 중…</div>` : ""}</div>
      ${askErr ? `<p class="error" role="alert">${esc(askErr)}</p>` : ""}
      <textarea id="ask" rows="3" placeholder="장면, 인물, 분위기를 한국어로" autocomplete="off">${esc(askDraft)}</textarea>
      ${asking
        ? `<button type="button" id="stopAsk" class="ghost big">눌러서 취소</button>`
        : `<button type="button" id="send" class="big">보내기</button>`}
      ${chat.length ? `<button type="button" class="ghost" id="clearChat">대화 지우기</button>` : ""}
      ${personaEditor()}
      <label for="aiModelQ">대답하는 모델 <span class="hint">${s.aiModel === "custom" ? "직접 입력한 이름은 ‘취향’ 탭에서 고침" : ""}</span></label>
      <select id="aiModelQ">${MODEL_CHOICES.map((m) => `<option value="${m}" ${s.aiModel === m ? "selected" : ""}>${m === "gemini-4-argon" ? "gemini-4-argon (아르곤)" : m}</option>`).join("")}<option value="custom" ${s.aiModel === "custom" ? "selected" : ""}>직접 입력${s.aiModel === "custom" && s.aiCustom ? ` (${esc(s.aiCustom)})` : ""}</option></select>
      <p class="hint">대답은 제미니(${esc(s.aiModel === "custom" ? s.aiCustom : s.aiModel)})가 하고, 태그는 같이 실린 단부루 사전에서 맞춰 봄. 제미니 말은 틀릴 수 있어서 넣은 뒤 직접 한 번 읽기.</p>`;
  },

  keep(id) {
    const kept =store.data.log.filter((r) => r.verdict === "keep");
    if (id) {
      const r = kept.find((x) => x.id === id);
      if (!r) return `<p class="empty">없는 그림.<br><a href="#/keep">보관함으로</a></p>`;
      return `
        <a class="back" href="#/keep">‹ 보관함</a>
        <figure class="result"><img id="full" alt="보관한 그림" width="${r.w}" height="${r.h}"></figure>
        <div class="acts">
          <button type="button" id="again">다시 뽑기</button>
          <button type="button" id="share" class="ghost">저장</button>
          <button type="button" id="del" class="ghost">지우기</button>
        </div>
        <dl class="meta">
          <dt>그림</dt><dd>${esc(r.scene) || "—"}</dd>
          <dt>취향</dt><dd>${esc(r.style) || "—"}</dd>
          <dt>빼는 것</dt><dd>${esc(r.negative) || "—"}</dd>
          <dt>값</dt><dd>시드 ${r.seed} · ${r.w}×${r.h} · ${r.steps}스텝 · 강도 ${r.scale} · ${esc(r.model)} · ${esc(SAMPLERS[r.sampler] || "Euler Ancestral")}${r.noise ? ` · ${esc(r.noise)}` : ""}${r.cr ? ` · cfg rescale ${r.cr}` : ""}${r.vb ? " · Variety+" : ""}${r.refs?.length ? ` · ${r.mode === "precise" ? "정밀 참조" : "바이브"} ${r.refs.length}장(강도 ${r.refs.map((x) => x.s).join("·")}, 다시 뽑기에는 그림이 안 따라옴)` : ""}${r.i2i ? ` · 이미지→이미지(strength ${r.i2i.strength}, noise ${r.i2i.noise}, 바탕 그림은 안 따라옴)` : ""}</dd>
          ${r.chars?.length ? `<dt>인물별</dt><dd>${r.chars.map((c, i) => `${i + 1}. ${esc(c.text)}${Number.isInteger(c.pos) ? ` (칸 ${c.pos + 1})` : ""}`).join("<br>")}</dd>` : ""}
        </dl>`;
    }
    if (!kept.length) return `<p class="empty">아직 없음.<br>뽑은 그림에서 ‘♥ 보관’을 누르면 여기 모임.</p>`;
    return `<div class="grid">${kept.map((r) =>
      `<a href="#/keep/${r.id}" data-thumb="${r.id}" style="aspect-ratio:${r.w}/${r.h}" aria-label="시드 ${r.seed} 그림"></a>`).join("")}</div>`;
  },

  taste() {
    const { settings: s, taste, log } = store.data;
    const st = tagStats();
    const chip = (r, act) => `<button type="button" class="chip" ${act ? `data-add="${esc(r.tag)}"` : "disabled"}>${esc(r.tag)} <small>${r.keep}/${r.drop}</small></button>`;
    return `
      <h2>취향 프롬프트</h2>
      <p class="hint">뽑을 때마다 뒤에 붙는 것. 화풍, 작가(artist:이름), 색감, 분위기 태그.</p>
      <textarea id="style" rows="4" autocapitalize="off" autocomplete="off" spellcheck="false"
        placeholder="artist:이름, soft lighting, muted colors">${esc(taste.style)}</textarea>
      <h2>빼는 것</h2>
      <textarea id="negative" rows="3" autocapitalize="off" autocomplete="off" spellcheck="false">${esc(taste.negative)}</textarea>
      <label class="line"><input type="checkbox" id="quality" ${s.quality ? "checked" : ""}> 품질 태그 자동으로 붙이기</label>

      <h2>고른 그림에 자주 나온 태그</h2>
      ${st.liked.length
        ? `<p class="hint">누르면 취향 프롬프트에 들어감. 숫자는 보관/버림.</p><div class="chips">${st.liked.map((r) => chip(r, true)).join("")}</div>`
        : `<p class="hint">${st.judged < 4 ? `보관·버림을 ${st.judged}번 골랐음. 더 골라야 나옴.` : "아직 두 번 넘게 고른 새 태그가 없음."}</p>`}
      ${st.disliked.length ? `<h2>버린 그림에 자주 나온 태그</h2><div class="chips">${st.disliked.map((r) => chip(r, false)).join("")}</div>` : ""}

      <h2>NovelAI</h2>
      <label for="token">토큰</label>
      <input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
        placeholder="pst-…" value="${esc(s.token)}">
      <p class="hint">novelai.net에서 톱니바퀴 → Account → Get Persistent API Token. 이 폰에만 저장되고 NovelAI 서버로만 나감.</p>
      <label for="model">모델</label>
      <select id="model">
        ${Object.entries(MODELS).map(([id, m]) => `<option value="${id}" ${s.model === id ? "selected" : ""}>${m.이름}</option>`).join("")}
        <option value="custom" ${s.model === "custom" ? "selected" : ""}>직접 입력</option>
      </select>
      ${s.model === "custom" ? `<input id="customModel" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="nai-diffusion-…" value="${esc(s.customModel)}">` : ""}
      <p class="hint">스텝·강도·샘플러 같은 생성 설정은 ‘뽑기’ 탭 맨 아래 ‘생성 설정’으로 옮김. 참고 그림(바이브·정밀 참조)과 인물별 프롬프트는 V4 이상, 정밀 참조는 V4.5 Full에서만 됨.</p>

      <h2>비서 (제미니)</h2>
      <label for="aiKey">제미니 API 키</label>
      <input id="aiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
        placeholder="AIza…" value="${esc(s.aiKey)}">
      <p class="hint">aistudio.google.com에서 발급. 이 폰에만 저장되고 구글 서버로만 나감. 비서에게 보낸 말과 취향 프롬프트가 구글로 감.</p>
      <label for="aiModel">모델</label>
      <select id="aiModel">
        ${MODEL_CHOICES.map((m) => `<option value="${m}" ${s.aiModel === m ? "selected" : ""}>${m}</option>`).join("")}
        <option value="custom" ${s.aiModel === "custom" ? "selected" : ""}>직접 입력</option>
      </select>
      ${s.aiModel === "custom" ? `<input id="aiCustom" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="gemini-…" value="${esc(s.aiCustom)}">` : ""}

      <h2>데이터</h2>
      <p class="hint">기록 ${log.length}건, 보관 ${log.filter((r) => r.verdict === "keep").length}장이 이 기기에만 있음.</p>
      <button type="button" class="ghost" id="export">기록 내보내기 (JSON, 토큰·그림 제외)</button>
      <button type="button" class="danger" id="reset">전부 지우기</button>`;
  },
};

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { gen: "짤뽑기", ai: "비서", keep: "보관함", taste: "취향" };
const route = () => (location.hash.replace(/^#\/?/, "") || "gen").split("/");
let thumbUrls = [];
let renderSeq = 0;

function render() {
  const [n, arg] = route();
  const name = SCREENS[n] ? n : "gen";
  const seq = ++renderSeq;
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  document.getElementById("screen").innerHTML = (saveFail ? `<p class="error" role="alert">저장이 안 되고 있음. 이 기기 저장 공간이 참. 지금 고친 것은 새로 고치면 사라짐. ‘취향’ 탭에서 기록을 내보낸 뒤 오래된 대화나 기록을 지우기.</p>` : "") + SCREENS[name](arg);
  document.getElementById("title").textContent = TITLES[name];
  const kept = store.data.log.filter((r) => r.verdict === "keep").length;
  document.getElementById("count").textContent = name === "keep" && kept ? `${kept}장` : "";
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  wire(name, arg, seq);
}

const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);

// 눌러서 바꾼 것을 알리는 한 줄. 화면이 바뀌어도 남도록 본문 밖에 띄운다.
// undo가 있으면 ‘되돌리기’ 버튼을 달고 조금 더 오래 둔다.
// expire: 되돌리기 없이 알림이 사라지거나 다른 알림이 덮을 때 한 번 불린다 (버린 그림의 마무리 정리용).
let toastTimer = null, toastExpire = null;
function toastDone() { const f = toastExpire; toastExpire = null; f?.(); }
function toast(msg, undo, expire) {
  clearTimeout(toastTimer);
  toastDone();
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast"; t.setAttribute("role", "status");
  const m = document.createElement("span"); m.textContent = msg; t.appendChild(m);
  toastExpire = expire || null;
  if (undo) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "undo"; b.textContent = "되돌리기";
    b.addEventListener("click", () => { clearTimeout(toastTimer); toastExpire = null; t.remove(); undo(); });
    t.appendChild(b);
  }
  document.body.appendChild(t);
  toastTimer = setTimeout(() => { t.remove(); toastDone(); }, undo ? 9000 : 4500);
}

function savePreset(to) {
  const d = store.data;
  const text = tidy(to === "scene" ? d.draft.scene : to === "style" ? d.taste.style : d.taste.negative);
  if (!text) return toast("비어 있어서 저장할 게 없음");
  const name = (prompt("프리셋 이름") || "").trim().slice(0, 30);
  if (!name) return;
  d.presets.unshift({ id: crypto.randomUUID(), name, text, to, kind: "내 것" });
  ui.open.preset = true; ui.presetKind = "내 것";
  toast(`‘${name}’ 저장함`);
  store.save();
}

// 비서 입력칸·버튼·답 블록. 뽑기 화면의 AI 도우미와 ‘비서’ 탭이 같이 쓴다.
function wireAsk() {
  const d = store.data;
  on("ask", "input", (e) => { askDraft = e.target.value; });
  on("withImg", "change", (e) => { ui.withImg = e.target.checked; });
  on("send", "click", () => { const t = askDraft.trim(); if (t) ask(t, { image: ui.withImg && !!now }); });
  on("stopAsk", "click", () => asking?.abort());
  on("clearChat", "click", () => { if (confirm("비서와 한 대화를 지움.")) { d.chat = []; store.save(); } });
  document.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.quick === "fix") {
      askDraft = "방금 그림에서 이상한 점: ";
      ui.withImg = !!now; ui.open.ai = true;
      render();
      const t = $("ask"); t?.focus(); t?.setSelectionRange(t.value.length, t.value.length);
      return;
    }
    ask(QUICK[b.dataset.quick], { image: ui.withImg && !!now });
  }));
  const blockOf = (id) => { const [i, j] = id.split(":").map(Number); return parseBlocks(d.chat[i]?.text || "")[j]?.v; };
  document.querySelectorAll("[data-blk]").forEach((el) => el.addEventListener("click", () => {
    const v = blockOf(el.dataset.blk); if (!v) return;
    const msg = applyBlock(el.dataset.kind, v);
    if (msg == null) return;
    toast(msg);
    store.persist();
    if (el.dataset.kind === "scene" && route()[0] === "ai") location.hash = "#/gen"; else render();
  }));
  document.querySelectorAll("[data-copy]").forEach((el) => el.addEventListener("click", async () => {
    const v = blockOf(el.dataset.copy); if (!v) return;
    try { await navigator.clipboard.writeText(v); el.textContent = "복사함"; }
    catch { el.textContent = "복사 못 함 — 길게 눌러 직접 복사"; }
  }));
  if (scrollAi && route()[0] === "ai") { scrollAi = false; scrollTo({ top: document.body.scrollHeight }); }
  else scrollAi = false;
}

function wirePersona() {
  const d = store.data, pc = d.persona;
  document.querySelectorAll("details[data-sec]").forEach((el) => el.addEventListener("toggle", () => { ui.open[el.dataset.sec] = el.open; }));
  const refresh = () => {
    const t = fullPersona();
    const a = $("pprevtxt"), c = $("pcount");
    if (a) a.textContent = t;
    if (c) c.textContent = `${t.length}자`;
  };
  // 고친 조각만 남긴다: 기본과 같아지면 덮어쓴 것을 지워 기본 글이 따라오게 한다.
  const setSec = (id, patch) => {
    const o = { ...(pc.sections[id] || {}), ...patch };
    if (o.text === undefined) delete o.text;
    if (o.on !== false) delete o.on;
    if (Object.keys(o).length) pc.sections[id] = o; else delete pc.sections[id];
  };
  document.querySelectorAll("[data-ptext]").forEach((el) => el.addEventListener("input", () => {
    const id = el.dataset.ptext, base = PERSONA_PARTS.find((p) => p.id === id);
    if (!base) return;
    setSec(id, { text: el.value === base.text ? undefined : el.value });
    const b = document.querySelector(`[data-prev="${id}"]`);
    if (b) b.disabled = el.value === base.text;
    store.persist(); refresh();
  }));
  document.querySelectorAll("[data-prev]").forEach((el) => el.addEventListener("click", () => { setSec(el.dataset.prev, { text: undefined }); store.save(); }));
  document.querySelectorAll("[data-pon]").forEach((el) => el.addEventListener("change", () => { setSec(el.dataset.pon, { on: el.checked }); store.save(); }));
  const extraOf = (el, k) => pc.extra.find((e) => e.id === el.dataset[k]);
  on("addPiece", "click", () => {
    if (pc.extra.length >= 20) return;
    const e = { id: crypto.randomUUID(), name: "새 조각", text: "", on: true };
    pc.extra.push(e); ui.open.persona = true; ui.open[`pe:${e.id}`] = true;
    store.save();
  });
  document.querySelectorAll("[data-ename]").forEach((el) => el.addEventListener("input", () => { const e = extraOf(el, "ename"); if (e) { e.name = el.value; store.persist(); refresh(); } }));
  document.querySelectorAll("[data-etext]").forEach((el) => el.addEventListener("input", () => { const e = extraOf(el, "etext"); if (e) { e.text = el.value; store.persist(); refresh(); } }));
  document.querySelectorAll("[data-eon]").forEach((el) => el.addEventListener("change", () => { const e = extraOf(el, "eon"); if (e) { e.on = el.checked; store.save(); } }));
  document.querySelectorAll("[data-edel]").forEach((el) => el.addEventListener("click", () => {
    const e = extraOf(el, "edel");
    if (!e || !confirm(`‘${e.name || "내 조각"}’ 조각을 지움.`)) return;
    pc.extra = pc.extra.filter((x) => x !== e); store.save();
  }));
  on("autoState", "change", (e) => { pc.auto.state = e.target.checked; store.persist(); refresh(); });
  on("autoCand", "change", (e) => { pc.auto.cand = e.target.checked; store.persist(); });
  on("pReset", "click", () => {
    if (!confirm("고친 조각, 내 조각, 켜고 끈 것을 전부 지우고 기본 지시문으로 돌림.")) return;
    d.persona = normPersona(null); store.save();
  });
}

function wire(name, arg, seq) {
  const d = store.data;
  if (name === "gen") {
    document.querySelectorAll("details[data-sec]").forEach((el) => el.addEventListener("toggle", () => { ui.open[el.dataset.sec] = el.open; }));
    wireAsk();
    on("scene", "input", (e) => { d.draft.scene = e.target.value; store.persist(); });
    on("seedLock", "change", (e) => { d.draft.seedLock = e.target.checked; store.save(); });
    on("seed", "change", (e) => {
      const v = e.target.value.trim();
      if (v === "") { d.draft.seed = null; d.draft.seedLock = false; }
      else { const n = Math.floor(Number(v)); if (Number.isFinite(n) && n >= 0 && n <= 4294967295) { d.draft.seed = n; d.draft.seedLock = true; } }
      store.save();
    });
    on("seedRand", "click", () => { d.draft.seed = null; d.draft.seedLock = false; store.save(); });
    document.querySelectorAll("[data-size]").forEach((b) => b.addEventListener("click", () => { d.settings.size = b.dataset.size; store.save(); }));
    on("customW", "change", (e) => { d.settings.customW = clamp(Math.round(e.target.value / 64) * 64, 64, 1536, 832); store.save(); });
    on("customH", "change", (e) => { d.settings.customH = clamp(Math.round(e.target.value / 64) * 64, 64, 1536, 1216); store.save(); });
    on("go", "click", generate);
    on("stop", "click", () => busy?.abort());
    on("keep", "click", () => judge("keep"));
    on("drop", "click", () => judge("drop"));
    on("share", "click", () => now && shareImage(now.blob, now.rec));
    on("useSeed", "click", () => { if (!now) return; d.draft.seed = now.rec.seed; d.draft.seedLock = true; toast(`시드 ${now.rec.seed}로 고정함`); store.save(); });
    on("saveScene", "click", () => savePreset("scene"));
    document.querySelectorAll("[data-hist]").forEach((b) => b.addEventListener("click", () => {
      const h = hist.find((x) => x.rec.id === b.dataset.hist);
      if (!h) return;
      now = h;
      render();
      document.querySelector("figure.result")?.scrollIntoView({ block: "nearest" });
    }));

    // 인물별 프롬프트
    const charOf = (el, k) => d.draft.chars.find((c) => c.id === el.dataset[k]);
    on("addChar", "click", () => { if (d.draft.chars.length < MAX_CHARS) { d.draft.chars.push({ id: crypto.randomUUID(), text: "", neg: "", pos: null }); ui.open.chars = true; store.save(); } });
    document.querySelectorAll("[data-cdel]").forEach((el) => el.addEventListener("click", () => { d.draft.chars = d.draft.chars.filter((c) => c.id !== el.dataset.cdel); store.save(); }));
    document.querySelectorAll("[data-ctext]").forEach((el) => el.addEventListener("input", () => { const c = charOf(el, "ctext"); if (c) { c.text = el.value; store.persist(); } }));
    document.querySelectorAll("[data-cneg]").forEach((el) => el.addEventListener("input", () => { const c = charOf(el, "cneg"); if (c) { c.neg = el.value; store.persist(); } }));
    document.querySelectorAll("[data-cpos]").forEach((el) => el.addEventListener("click", () => {
      const [id, v] = el.dataset.cpos.split(":"), c = d.draft.chars.find((x) => x.id === id);
      if (!c) return;
      c.pos = v === "auto" ? null : (c.pos === +v ? null : +v);
      store.save();
    }));

    // 참고 그림
    const saveRef = (r) => refPut(rowOf(r)).catch((e) => { errMsg = `참고 그림 설정을 저장하지 못함 (${e?.name || e}).`; render(); });
    const byId = (el, k) => refs.find((x) => x.id === el.dataset[k]);
    document.querySelectorAll("[data-rmode]").forEach((b) => b.addEventListener("click", () => { d.settings.refMode = b.dataset.rmode; store.save(); }));
    on("addRef", "click", () => $("refFile").click());
    on("refFile", "change", (e) => { const f = [...e.target.files]; e.target.value = ""; addRefs(f); });
    document.querySelectorAll("[data-ron]").forEach((el) => el.addEventListener("change", () => {
      const r = byId(el, "ron"); if (!r) return;
      r.on = el.checked; saveRef(r); render();
    }));
    const slider = (attr, key, outPrefix, dflt) => document.querySelectorAll(`[${attr}]`).forEach((el) => {
      const r = refs.find((x) => x.id === el.getAttribute(attr));
      el.addEventListener("input", () => { if (r) { r[key] = clamp(el.value, 0, 1, dflt); const o = $(`${outPrefix}-${r.id}`); if (o) o.textContent = r[key]; } });
      el.addEventListener("change", () => { if (r) { saveRef(r); render(); } });
    });
    slider("data-rstr", "strength", "rs", 0.6);
    slider("data-rfid", "fid", "rf", 0.5);
    document.querySelectorAll("[data-rkind]").forEach((el) => el.addEventListener("change", () => {
      const r = byId(el, "rkind"); if (!r) return;
      r.kind = el.value === "character" ? "character" : "character&style"; saveRef(r);
    }));
    document.querySelectorAll("[data-rinfo]").forEach((el) => el.addEventListener("change", () => {
      const r = byId(el, "rinfo"); if (!r) return;
      r.info = clamp(el.value, 0, 1, 1); saveRef(r); render();
    }));
    document.querySelectorAll("[data-rdel]").forEach((el) => el.addEventListener("click", async () => {
      const r = byId(el, "rdel"); if (!r) return;
      await refDel(r.id).catch(() => {});
      URL.revokeObjectURL(r.url);
      refs = refs.filter((x) => x !== r);
      render();
    }));

    // 이미지→이미지
    const srcFail = (err) => { errMsg = `바탕 그림을 읽지 못함 (${err?.message || err}). 다른 파일로 시도.`; };
    on("srcAdd", "click", () => $("srcFile").click());
    on("srcFile", "change", async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; try { await setSrc(f, f.name); } catch (err) { srcFail(err); } render(); });
    on("srcNow", "click", async () => { if (!now) return; try { await setSrc(now.blob, `방금 그림 (시드 ${now.rec.seed})`); } catch (err) { srcFail(err); } render(); });
    on("toI2i", "click", async () => {
      if (!now) return;
      try { await setSrc(now.blob, `방금 그림 (시드 ${now.rec.seed})`); ui.open.i2i = true; toast("바탕 그림으로 넣음. 프롬프트를 고쳐 다시 뽑기"); } catch (err) { srcFail(err); }
      render();
    });
    on("srcDel", "click", async () => { await clearSrc(); render(); });
    on("i2iOn", "change", (e) => { d.draft.i2i.on = e.target.checked; store.save(); });
    const i2 = (id, key, out) => {
      on(id, "input", (e) => { d.draft.i2i[key] = clamp(e.target.value, 0, 1, 0); const o = $(out); if (o) o.textContent = d.draft.i2i[key]; });
      on(id, "change", () => store.save());
    };
    i2("i2iStr", "strength", "i2s");
    i2("i2iNoise", "noise", "i2n");

    // 생성 설정
    on("sampler", "change", (e) => { d.settings.sampler = e.target.value; store.save(); });
    on("noise", "change", (e) => { d.settings.noise = e.target.value; store.save(); });
    on("steps", "change", (e) => { d.settings.steps = clamp(e.target.value, 1, MAX_STEPS, 28); store.save(); });
    on("scale", "change", (e) => { d.settings.scale = clamp(e.target.value, 0, 10, 5); store.save(); });
    on("cfgRescale", "change", (e) => { d.settings.cfgRescale = clamp(e.target.value, 0, 1, 0); store.save(); });
    on("variety", "change", (e) => { d.settings.variety = e.target.checked; store.save(); });

    // 프리셋
    document.querySelectorAll("[data-pkind]").forEach((b) => b.addEventListener("click", () => { ui.presetKind = b.dataset.pkind; ui.pedit = null; ui.pput = null; ui.open.preset = true; render(); }));
    document.querySelectorAll("[data-pset]").forEach((b) => b.addEventListener("click", () => {
      const p = presetByKey(b.dataset.pset); if (!p) return;
      if (b.dataset.pmode === "replace") {
        if (!tidy(p.text || "")) return toast("내용이 비어 있음. ‘고치기’에서 채우기");
        ui.pput = b.dataset.pset; ui.pputText = p.text; ui.pedit = null; ui.open.preset = true;
        return render();
      }
      applyPreset(p, b.dataset.pmode);
    }));
    document.querySelectorAll("[data-pputtext]").forEach((el) => el.addEventListener("input", () => { ui.pputText = el.value; }));
    document.querySelectorAll("[data-pputgo]").forEach((b) => b.addEventListener("click", () => {
      const key = b.closest("[data-pput]")?.dataset.pput, p = key && presetByKey(key);
      if (!p) return;
      if (!tidy(ui.pputText)) return toast("넣을 글이 비어 있음");
      ui.pput = null;
      applyPreset({ ...p, text: ui.pputText }, b.dataset.pputgo);
    }));
    document.querySelectorAll("[data-pputcancel]").forEach((b) => b.addEventListener("click", () => { ui.pput = null; render(); }));
    document.querySelectorAll("[data-pdel]").forEach((b) => b.addEventListener("click", () => {
      const p = d.presets.find((x) => x.id === b.dataset.pdel);
      if (!p || !confirm(`‘${p.name || "이름 없음"}’ 프리셋을 지움.`)) return;
      d.presets = d.presets.filter((x) => x !== p); ui.pedit = null; store.save();
    }));
    // 프리셋 고치기·더하기
    document.querySelectorAll("[data-pedit]").forEach((b) => b.addEventListener("click", () => { ui.pedit = b.dataset.pedit; ui.pput = null; ui.open.preset = true; render(); }));
    document.querySelectorAll("[data-pdone]").forEach((b) => b.addEventListener("click", () => { ui.pedit = null; render(); }));
    document.querySelectorAll("[data-padd]").forEach((b) => b.addEventListener("click", () => {
      const kind = ui.presetKind;
      const p = { id: crypto.randomUUID(), name: "새 프리셋", text: "", to: KIND_TO[kind] || "scene", kind };
      if (kind === "인물") p.at = "front";
      d.presets.unshift(p); ui.pedit = `own:${p.id}`; ui.open.preset = true;
      store.save();
    }));
    document.querySelectorAll("[data-pf]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      const key = el.closest("[data-pform]")?.dataset.pform, f = el.dataset.pf;
      if (!key) return;
      if (key.startsWith("own:")) {
        const p = d.presets.find((x) => x.id === key.slice(4));
        if (!p) return;
        if (f === "to") { if (TARGET[el.value]) { p.to = el.value; if (p.to !== "scene") delete p.at; } } else p[f] = el.value;
      } else {
        const base = baseOf(key);
        if (!base) return;
        const e = (d.presetEdits[key] ??= {});
        if (el.value === (base[f] ?? "")) delete e[f]; else e[f] = el.value;
        if (!Object.keys(e).length) delete d.presetEdits[key];
        const rv = document.querySelector(`[data-prevert="${CSS.escape(key)}"]`);
        if (rv) rv.disabled = !PFIELDS.some((k) => typeof d.presetEdits[key]?.[k] === "string");
      }
      store.persist();
    }));
    document.querySelectorAll("[data-prevert]").forEach((b) => b.addEventListener("click", () => {
      const e = d.presetEdits[b.dataset.prevert];
      if (e) { for (const f of PFIELDS) delete e[f]; if (!Object.keys(e).length) delete d.presetEdits[b.dataset.prevert]; }
      store.save();
    }));
    document.querySelectorAll("[data-phide]").forEach((b) => b.addEventListener("click", () => { (d.presetEdits[b.dataset.phide] ??= {}).hidden = true; ui.pedit = null; store.save(); }));
    document.querySelectorAll("[data-punhide]").forEach((b) => b.addEventListener("click", () => {
      const e = d.presetEdits[b.dataset.punhide];
      if (e) { delete e.hidden; if (!Object.keys(e).length) delete d.presetEdits[b.dataset.punhide]; }
      store.save();
    }));
    document.querySelectorAll("[data-pshowhidden]").forEach((b) => b.addEventListener("click", () => { ui.showHidden = !ui.showHidden; render(); }));
    document.querySelectorAll("[data-psave]").forEach((b) => b.addEventListener("click", () => savePreset(b.dataset.psave)));
  }
  if (name === "ai") { wireAsk(); wirePersona(); on("aiModelQ", "change", (e) => { d.settings.aiModel = e.target.value; store.save(); }); }
  if (name === "keep" && !arg) {
    document.querySelectorAll("[data-thumb]").forEach(async (a) => {
      const row = await imgGet(a.dataset.thumb).catch(() => null);
      if (seq !== renderSeq) return;
      if (!row) { a.textContent = "그림 없음"; return; }
      const u = URL.createObjectURL(row.thumb || row.full);
      thumbUrls.push(u);
      a.innerHTML = `<img src="${u}" alt="" loading="lazy">`;
    });
  }
  if (name === "keep" && arg) {
    const rec = d.log.find((r) => r.id === arg);
    let blob = null;
    imgGet(arg).catch(() => null).then((row) => {
      if (seq !== renderSeq || !$("full")) return;
      if (!row) { $("full").replaceWith(Object.assign(document.createElement("p"), { className: "error", textContent: "그림 파일이 이 기기에서 사라졌음. 설정값만 남아 있음." })); return; }
      blob = row.full;
      const u = URL.createObjectURL(blob);
      thumbUrls.push(u);
      $("full").src = u;
    });
    on("again", "click", () => {
      d.draft.scene = rec.scene; d.draft.seed = rec.seed; d.draft.seedLock = true;
      d.draft.chars = (rec.chars || []).map((c) => ({ id: crypto.randomUUID(), text: c.text, neg: c.neg || "", pos: Number.isInteger(c.pos) ? c.pos : null }));
      if (SAMPLERS[rec.sampler]) d.settings.sampler = rec.sampler;
      if (rec.noise) d.settings.noise = rec.noise;
      d.settings.cfgRescale = rec.cr ?? 0; d.settings.variety = !!rec.vb;
      d.settings.steps = rec.steps; d.settings.scale = rec.scale;
      store.persist();
      location.hash = "#/gen";
    });
    on("share", "click", () => blob && shareImage(blob, rec));
    on("del", "click", () => { if (confirm("이 그림을 지움. 되돌릴 수 없음.")) removeKept(arg); });
  }
  if (name === "taste") {
    on("style", "input", (e) => { d.taste.style = e.target.value; store.persist(); });
    on("negative", "input", (e) => { d.taste.negative = e.target.value; store.persist(); });
    on("quality", "change", (e) => { d.settings.quality = e.target.checked; store.persist(); });
    on("token", "input", (e) => { d.settings.token = e.target.value.trim(); store.persist(); });
    on("model", "change", (e) => { d.settings.model = e.target.value; store.save(); });
    on("customModel", "input", (e) => { d.settings.customModel = e.target.value.trim(); store.persist(); });
    on("aiKey", "input", (e) => { d.settings.aiKey = e.target.value.trim(); store.persist(); });
    on("aiModel", "change", (e) => { d.settings.aiModel = e.target.value; store.save(); });
    on("aiCustom", "input", (e) => { d.settings.aiCustom = e.target.value.trim(); store.persist(); });
    document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => {
      d.taste.style = [tidy(d.taste.style), b.dataset.add].filter(Boolean).join(", ");
      store.save();
    }));
    on("export", "click", () => {
      const out = { ...d, settings: { ...d.settings, token: "", aiKey: "" } };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
      a.download = "짤뽑기.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    on("reset", "click", async () => {
      if (!confirm("취향, 기록, 보관한 그림, 참고 그림, 대화, 토큰과 키를 전부 지움. 되돌릴 수 없음.")) return;
      await imgClear().catch(() => {});
      await refClear().catch(() => {});
      await srcClear().catch(() => {});
      if (src) { URL.revokeObjectURL(src.url); src = null; }
      refs.forEach((r) => URL.revokeObjectURL(r.url));
      refs = [];
      histClear();
      store.data = SHAPE();
      store.save();
    });
  }
}

addEventListener("hashchange", () => { errMsg = ""; askErr = ""; render(); });
render();
loadRefs().then(render); loadSrc().then(render);
// 참고 그림은 IndexedDB에서 읽어 와야 해서 한 박자 늦게 그린다

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
