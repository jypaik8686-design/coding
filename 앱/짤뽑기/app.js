// 짤뽑기 — 취향 프롬프트를 늘 붙여 NovelAI로 한 장씩 뽑고, 고른 것과 버린 것에서 취향을 쌓는다.
// 화면 넷: 뽑기 / 비서 / 보관함 / 취향. 글자 데이터는 localStorage, 그림(보관한 것, 참고 그림)은 IndexedDB.

import { PERSONA, MODEL_CHOICES } from "./assistant.js";

const KEY = "짤뽑기/v1";
const API = "https://image.novelai.net/ai/generate-image";
const LOG_MAX = 400;

const SIZES = { 세로: [832, 1216], 가로: [1216, 832], 정사각: [1024, 1024] };
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
const SHAPE = () => ({
  settings: {
    token: "", model: "nai-diffusion-5-full", customModel: "", size: "세로", steps: 28, scale: 5, quality: true,
    aiKey: "", aiModel: MODEL_CHOICES[0], aiCustom: "",
  },
  taste: { style: DEFAULT_STYLE, negative: DEFAULT_NEG, seeded: true },
  draft: { scene: DEFAULT_SCENE, seedLock: false, seed: null, seeded: true },
  log: [],
  chat: [],
});

const store = {
  data: load(),
  persist() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); return true; }
    catch (e) { console.warn("저장 실패", e); return false; }
  },
  save() { this.persist(); render(); },
};

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
    return {
      settings: { ...base.settings, ...(raw.settings || {}) },
      taste,
      draft,
      log: Array.isArray(raw.log) ? raw.log.filter((r) => r && r.id) : [],
      chat: Array.isArray(raw.chat) ? raw.chat.filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string") : [],
    };
  } catch { return base; }
}

// ── 그림 저장 (IndexedDB) ────────────────────────────────────
let dbp = null;
function db() {
  dbp ??= new Promise((ok, no) => {
    // 2: 참고 그림 창고 "ref"를 더했다. 옛 "img"(보관한 그림)는 그대로 둔다.
    const q = indexedDB.open("짤뽑기", 2);
    q.onupgradeneeded = () => {
      for (const n of ["img", "ref"]) if (!q.result.objectStoreNames.contains(n)) q.result.createObjectStore(n, { keyPath: "id" });
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
      const row = { id: crypto.randomUUID(), name: (f.name || "그림").slice(0, 40), at: Date.now(), on: true, strength: 0.6, info: 1, full, thumb, enc: {} };
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

// 요청 몸통은 V5에서 200이 확인된 꼴 그대로 (명세.md '밖에 나가는 것' 참고). v4_prompt 둘을 빼면 500이 난다.
// 참고 그림이 있으면 reference_*_multiple 세 줄에 인코딩 결과·정보량·강도를 같은 순서로 넣는다 (V4.5, 2026-11-18 200 확인).
function requestBody(prompt, negative, rec, used = [], vibes = []) {
  const cap = (t) => ({ use_coords: false, use_order: false, caption: { base_caption: t, char_captions: [] } });
  return {
    input: prompt, model: rec.model, action: "generate",
    parameters: {
      params_version: 4, width: rec.w, height: rec.h, scale: rec.scale, sampler: "k_euler_ancestral",
      steps: rec.steps, seed: rec.seed, n_samples: 1, ucPreset: 3, qualityToggle: false,
      sm: false, sm_dyn: false, dynamic_thresholding: false, controlnet_strength: 1,
      legacy: false, add_original_image: false, cfg_rescale: 0, noise_schedule: "karras",
      legacy_v3_extend: false, uncond_scale: 1, negative_prompt: negative, prompt,
      reference_image_multiple: vibes, reference_information_extracted_multiple: used.map((r) => r.info), reference_strength_multiple: used.map((r) => r.strength),
      extra_noise_seed: rec.seed,
      v4_prompt: cap(prompt), v4_negative_prompt: cap(negative),
    },
  };
}

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
let now = null;      // { rec, blob, url }
let busy = null;     // AbortController
let errMsg = "";

async function generate() {
  const d = store.data, s = d.settings;
  errMsg = "";
  if (!s.token.trim()) { errMsg = "토큰이 없음. ‘취향’ 탭 맨 아래에서 넣기."; return render(); }
  if (!modelId(s)) { errMsg = "모델 이름이 비어 있음. ‘취향’ 탭에서 고르기."; return render(); }
  if (!tidy(d.draft.scene) && !tidy(d.taste.style)) { errMsg = "그릴 것이 비어 있음."; return render(); }

  const [w, h] = SIZES[s.size] || SIZES.세로;
  const seed = d.draft.seedLock && Number.isInteger(d.draft.seed) ? d.draft.seed : Math.floor(Math.random() * 4294967295);
  const rec = {
    id: crypto.randomUUID(), scene: tidy(d.draft.scene), style: tidy(d.taste.style), negative: tidy(d.taste.negative),
    seed, model: modelId(s), w, h, steps: clamp(s.steps, 1, 28, 28), scale: clamp(s.scale, 0, 10, 5), at: Date.now(), verdict: null,
  };
  const prompt = compose(rec.scene, rec.style, s);
  const used = supportsVibe(s) ? refs.filter((r) => r.on) : []; // V5에서는 붙여 둔 그림이 있어도 안 보낸다
  if (used.length) rec.refs = used.map((r) => ({ s: r.strength, i: r.info }));

  busy = new AbortController();
  phase = "";
  render();
  try {
    const vibes = [];
    for (const r of used) vibes.push(await encodeRef(r, rec.model, s.token.trim(), busy.signal)); // 한 장씩, 자동 재시도 없음
    phase = "";
    render();
    const res = await fetch(API, {
      method: "POST", signal: busy.signal,
      headers: { Authorization: `Bearer ${s.token.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody(prompt, rec.negative, rec, used, vibes)),
    });
    if (!res.ok) throw new Error(await failText(res));
    const png = await pngFromResponse(await res.arrayBuffer());
    const blob = new Blob([png], { type: "image/png" });
    if (now) URL.revokeObjectURL(now.url);
    now = { rec, blob, url: URL.createObjectURL(blob) };
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
    rec.verdict = "drop";
    URL.revokeObjectURL(now.url);
    now = null;
  }
  store.save();
}

async function removeKept(id) {
  await imgDel(id).catch(() => {});
  const rec = store.data.log.find((r) => r.id === id);
  if (rec) rec.verdict = "drop";
  if (now?.rec.id === id) now.rec.verdict = "drop";
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
  return `\n\n## 앱 상태 (지금)\n- 모델: ${modelId(s)} (${supportsVibe(s) ? "참고 그림 됨" : "참고 그림 안 됨"})\n- 이번 그림 칸: ${tidy(draft.scene) || "(비어 있음)"}\n- 취향 프롬프트: ${tidy(taste.style) || "(비어 있음)"}\n- 빼는 것: ${tidy(taste.negative) || "(비어 있음)"}\n- 품질 태그 자동: ${s.quality ? "켜짐" : "꺼짐"}\n- 붙여 둔 참고 그림: ${refs.filter((r) => r.on).length}장`;
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

async function ask(text) {
  const d = store.data, s = d.settings;
  askErr = "";
  const model = (s.aiModel === "custom" ? s.aiCustom : s.aiModel).trim().replace(/^models\//, "");
  if (!s.aiKey.trim()) { askErr = "제미니 키가 없음. ‘취향’ 탭 맨 아래에서 넣기."; return render(); }
  if (!model) { askErr = "제미니 모델 이름이 비어 있음. ‘취향’ 탭에서 고르기."; return render(); }
  askDraft = "";
  d.chat.push({ role: "user", text, at: Date.now() });
  while (d.chat.length > CHAT_MAX) d.chat.shift();
  store.persist();
  asking = new AbortController();
  scrollAi = true;
  render();
  try {
    await loadTags();
    let hist = d.chat.slice(-20);
    while (hist.length && hist[0].role !== "user") hist.shift(); // 제미니는 사용자 말로 시작해야 한다
    const cand = candidates(text);
    const contents = hist.map((m, i) => ({
      role: m.role,
      parts: [{ text: i === hist.length - 1 && cand.length ? `${m.text}\n\n[사전 후보]\n${cand.join("\n")}` : m.text }],
    }));
    const res = await fetch(`${GEMINI}${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: asking.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": s.aiKey.trim() },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: PERSONA + stateText() }] }, contents, generationConfig: { temperature: 0.8 } }),
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

// ── 화면 ────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 뽑기 화면의 참고 그림 칸. V5이면 안 되는 이유만 보이고, V4.5 계열이면 그림 목록과 붙이기 버튼이 보인다.
function refBlock() {
  const s = store.data.settings;
  if (!supportsVibe(s)) {
    return `<p class="hint">참고 그림은 V4.5 Full에서만 됨. V5는 서버가 거절함(2026-11-17 확인). ${refs.length ? `붙여 둔 ${refs.length}장은 V5에서는 안 보냄. ` : ""}‘취향’ 탭에서 모델을 V4.5 Full로 바꾸면 여기에 나옴.</p>`;
  }
  const key = (r) => `${modelId(s)}|${r.info}`;
  const sum = refs.filter((r) => r.on).reduce((a, r) => a + r.strength, 0);
  return `
    <h2>참고 그림 <span class="hint">V4.5 바이브 · 화풍·색·분위기를 따라 함</span></h2>
    ${refs.length ? `<ul class="refs">${refs.map((r) => `
      <li class="ref">
        <img src="${r.url}" alt="${esc(r.name)}">
        <div class="refbody">
          <label class="line"><input type="checkbox" data-ron="${r.id}" ${r.on ? "checked" : ""}> 쓰기 <span class="hint">${esc(r.name)}</span></label>
          <label>강도 <output id="rs-${r.id}">${r.strength}</output><input type="range" min="0" max="1" step="0.05" value="${r.strength}" data-rstr="${r.id}"></label>
          <label>정보량 <span class="hint">0~1, 바꾸면 다시 인코딩</span><input type="number" inputmode="decimal" min="0" max="1" step="0.1" value="${r.info}" data-rinfo="${r.id}"></label>
          <p class="hint">${r.enc?.[key(r)] ? "인코딩 있음 (다시 안 함)" : "다음 뽑기에서 인코딩 — 문서 기준 2 Anlas"}</p>
          <button type="button" class="ghost" data-rdel="${r.id}">빼기</button>
        </div>
      </li>`).join("")}</ul>` : ""}
    <input id="refFile" type="file" accept="image/*" multiple hidden>
    <button type="button" class="ghost" id="addRef" ${refs.length >= MAX_REFS ? "disabled" : ""}>＋ 그림 붙이기 (${refs.length}/${MAX_REFS})</button>
    ${sum > 1 ? `<p class="hint warn">켜 둔 강도 합이 ${sum.toFixed(2)}임. 1을 넘으면 프롬프트를 덜 듣는 경향이 있음(문서).</p>` : ""}
    <p class="hint">긴 변 1024px로 줄여 쓰고 이 폰에만 저장됨. 뽑을 때 NovelAI 서버로 같이 감.</p>`;
}

const SCREENS = {
  gen() {
    const { settings: s, taste, draft } = store.data;
    const styleLen = tidy(taste.style).length;
    return `
      ${s.token.trim() ? "" : `<p class="notice">NovelAI 토큰이 아직 없음. <a href="#/taste">‘취향’ 탭 맨 아래</a>에서 넣어야 뽑힘.</p>`}
      <label for="scene">이번 그림 <span class="hint">영어 태그, 쉼표로</span></label>
      <textarea id="scene" rows="4" autocapitalize="off" autocomplete="off" spellcheck="false"
        placeholder="1girl, silver hair, looking at viewer, upper body">${esc(draft.scene)}</textarea>
      <p class="hint">${styleLen ? `여기에 취향 프롬프트(${styleLen}자)` : `취향 프롬프트는 아직 비어 있고,`}${s.quality ? " 품질 태그가" : ""} 뒤에 붙음. 태그가 막막하면 <a href="#/ai">비서</a>에게.</p>
      ${refBlock()}
      <div class="seg" role="group" aria-label="크기">
        ${Object.keys(SIZES).map((k) => `<button type="button" class="${s.size === k ? "on" : ""}" data-size="${k}">${k}<small>${SIZES[k].join("×")}</small></button>`).join("")}
      </div>
      <label class="line"><input type="checkbox" id="seedLock" ${draft.seedLock ? "checked" : ""}>
        같은 시드로 다시 <span class="hint">${Number.isInteger(draft.seed) ? `시드 ${draft.seed}` : "아직 뽑은 적 없음"}</span></label>
      ${busy
        ? `<button type="button" id="stop" class="ghost big">${esc(phase || "뽑는 중…")} 눌러서 취소</button>`
        : `<button type="button" id="go" class="big">뽑기</button>`}
      ${errMsg ? `<p class="error" role="alert">${esc(errMsg)}</p>` : ""}
      ${now ? `
        <figure class="result">
          <img src="${now.url}" alt="방금 뽑은 그림" width="${now.rec.w}" height="${now.rec.h}">
          <figcaption class="hint">시드 ${now.rec.seed} · ${now.rec.w}×${now.rec.h} · ${esc(now.rec.model)}${now.rec.refs?.length ? ` · 참고 ${now.rec.refs.length}장` : ""}</figcaption>
        </figure>
        <div class="acts">
          ${now.rec.verdict === "keep"
            ? `<button type="button" class="ghost" disabled>보관함에 있음</button>`
            : `<button type="button" id="keep">♥ 보관</button>`}
          <button type="button" id="drop" class="ghost">✕ 버림</button>
          <button type="button" id="share" class="ghost">저장</button>
        </div>
        <p class="hint">보관과 버림이 쌓이면 ‘취향’ 탭에 자주 고른 태그가 나옴. 안 고른 그림은 새로 고치면 사라짐.</p>` : ""}`;
  },

  ai() {
    const { settings: s, chat } = store.data;
    const bubbles = chat.map((m, i) => {
      if (m.role === "user") return `<div class="msg me">${esc(m.text)}</div>`;
      const parts = parseBlocks(m.text).map((b, j) => {
        if (b.t === "text") return b.v.trim() ? `<p class="mt">${esc(b.v.trim())}</p>` : "";
        const id = `${i}:${j}`;
        const btns = b.lang === "scene" ? `<button type="button" data-put="${id}">이번 그림에 넣기</button>`
          : b.lang === "negative" ? `<button type="button" data-neg="${id}">빼는 것에 더하기</button>` : "";
        let check = "";
        if (b.lang === "scene") {
          const c = checkTags(b.v);
          if (c && (c.missing.length || c.rare.length)) {
            check = `<p class="hint">${c.missing.length ? `사전(일반 태그)에 없음: ${esc(c.missing.join(", "))}. 자연어 문구나 캐릭터 이름일 수 있음. ` : ""}${c.rare.length ? `게시물 ${RARE}개 미만이라 약할 수 있음: ${esc(c.rare.join(", "))}` : ""}</p>`;
          } else if (!c) check = `<p class="hint">태그 사전을 못 불러와 검사를 못 함.</p>`;
        }
        return `<div class="code"><pre>${esc(b.v)}</pre><div class="acts2">${btns}<button type="button" class="ghost" data-copy="${id}">복사</button></div>${check}</div>`;
      }).join("");
      return `<div class="msg ai">${parts || esc(m.text)}</div>`;
    }).join("");
    return `
      ${s.aiKey.trim() ? "" : `<p class="notice">제미니 키가 아직 없음. <a href="#/taste">‘취향’ 탭 맨 아래</a>에서 넣어야 대답함.</p>`}
      ${chat.length ? "" : `<p class="empty">그리고 싶은 장면을 말로 던지면<br>NovelAI 태그 프롬프트로 바꿔 줌.<br><small>예: 금발 정장 입은 중국식 미인, 로우앵글로 내려다보는 오만한 느낌</small></p>`}
      <div class="chat">${bubbles}${asking ? `<div class="msg ai dim">생각 중…</div>` : ""}</div>
      ${askErr ? `<p class="error" role="alert">${esc(askErr)}</p>` : ""}
      <textarea id="ask" rows="3" placeholder="장면, 인물, 분위기를 한국어로" autocomplete="off">${esc(askDraft)}</textarea>
      ${asking
        ? `<button type="button" id="stopAsk" class="ghost big">눌러서 취소</button>`
        : `<button type="button" id="send" class="big">보내기</button>`}
      ${chat.length ? `<button type="button" class="ghost" id="clearChat">대화 지우기</button>` : ""}
      <p class="hint">대답은 제미니(${esc(s.aiModel === "custom" ? s.aiCustom : s.aiModel)})가 하고, 태그는 같이 실린 단부루 사전에서 맞춰 봄. 제미니 말은 틀릴 수 있어서 ‘이번 그림에 넣기’ 뒤 직접 한 번 읽기.</p>`;
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
          <dt>값</dt><dd>시드 ${r.seed} · ${r.w}×${r.h} · ${r.steps}스텝 · 강도 ${r.scale} · ${esc(r.model)}${r.refs?.length ? ` · 참고 그림 ${r.refs.length}장(강도 ${r.refs.map((x) => x.s).join("·")}, 다시 뽑기에는 안 따라옴)` : ""}</dd>
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
      <div class="two">
        <label>스텝 <span class="hint">1~28</span><input id="steps" type="number" inputmode="numeric" min="1" max="28" value="${esc(s.steps)}"></label>
        <label>프롬프트 강도 <span class="hint">0~10</span><input id="scale" type="number" inputmode="decimal" min="0" max="10" step="0.5" value="${esc(s.scale)}"></label>
      </div>
      <p class="hint">한 번에 한 장, 28스텝 이하, 위 세 크기만 씀. 이 범위를 Opus 구독은 Anlas 없이 뽑고, 다른 구독은 Anlas가 듦. 참고 그림(바이브)은 V4.5 Full에서만 보임.</p>

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
  document.getElementById("screen").innerHTML = SCREENS[name](arg);
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

function wire(name, arg, seq) {
  const d = store.data;
  if (name === "gen") {
    on("scene", "input", (e) => { d.draft.scene = e.target.value; store.persist(); });
    on("seedLock", "change", (e) => { d.draft.seedLock = e.target.checked; store.persist(); });
    document.querySelectorAll("[data-size]").forEach((b) => b.addEventListener("click", () => { d.settings.size = b.dataset.size; store.save(); }));
    on("go", "click", generate);
    on("stop", "click", () => busy?.abort());
    on("keep", "click", () => judge("keep"));
    on("drop", "click", () => judge("drop"));
    on("share", "click", () => now && shareImage(now.blob, now.rec));

    // 참고 그림
    const saveRef = (r) => refPut(rowOf(r)).catch((e) => { errMsg = `참고 그림 설정을 저장하지 못함 (${e?.name || e}).`; render(); });
    const byId = (el, k) => refs.find((x) => x.id === el.dataset[k]);
    on("addRef", "click", () => $("refFile").click());
    on("refFile", "change", (e) => { const f = [...e.target.files]; e.target.value = ""; addRefs(f); });
    document.querySelectorAll("[data-ron]").forEach((el) => el.addEventListener("change", () => {
      const r = byId(el, "ron"); if (!r) return;
      r.on = el.checked; saveRef(r); render();
    }));
    document.querySelectorAll("[data-rstr]").forEach((el) => {
      const r = byId(el, "rstr");
      el.addEventListener("input", () => { if (r) { r.strength = clamp(el.value, 0, 1, 0.6); const o = $(`rs-${r.id}`); if (o) o.textContent = r.strength; } });
      el.addEventListener("change", () => { if (r) { saveRef(r); render(); } });
    });
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
  }
  if (name === "ai") {
    const d2 = store.data;
    on("ask", "input", (e) => { askDraft = e.target.value; });
    on("send", "click", () => { const t = askDraft.trim(); if (t) ask(t); });
    on("stopAsk", "click", () => asking?.abort());
    on("clearChat", "click", () => { if (confirm("비서와 한 대화를 지움.")) { d2.chat = []; store.save(); } });
    const blockOf = (id) => { const [i, j] = id.split(":").map(Number); return parseBlocks(d2.chat[i]?.text || "")[j]?.v; };
    document.querySelectorAll("[data-put]").forEach((el) => el.addEventListener("click", () => {
      const v = blockOf(el.dataset.put); if (!v) return;
      d2.draft.scene = tidy(v); d2.draft.seedLock = false; store.persist();
      location.hash = "#/gen";
    }));
    document.querySelectorAll("[data-neg]").forEach((el) => el.addEventListener("click", () => {
      const v = blockOf(el.dataset.neg); if (!v) return;
      if (!confirm("‘취향’ 탭의 빼는 것 뒤에 붙임. 앞으로 모든 그림에 적용됨.")) return;
      d2.taste.negative = [tidy(d2.taste.negative), tidy(v)].filter(Boolean).join(", ");
      store.save();
      el.textContent = "더했음"; el.disabled = true;
    }));
    document.querySelectorAll("[data-copy]").forEach((el) => el.addEventListener("click", async () => {
      const v = blockOf(el.dataset.copy); if (!v) return;
      try { await navigator.clipboard.writeText(v); el.textContent = "복사함"; }
      catch { el.textContent = "복사 못 함 — 길게 눌러 직접 복사"; }
    }));
    if (scrollAi) { scrollAi = false; scrollTo({ top: document.body.scrollHeight }); }
  }
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
    on("steps", "change", (e) => { d.settings.steps = clamp(e.target.value, 1, 28, 28); e.target.value = d.settings.steps; store.persist(); });
    on("scale", "change", (e) => { d.settings.scale = clamp(e.target.value, 0, 10, 5); e.target.value = d.settings.scale; store.persist(); });
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
      refs.forEach((r) => URL.revokeObjectURL(r.url));
      refs = [];
      if (now) { URL.revokeObjectURL(now.url); now = null; }
      store.data = SHAPE();
      store.save();
    });
  }
}

addEventListener("hashchange", () => { errMsg = ""; askErr = ""; render(); });
render();
loadRefs().then(render); // 참고 그림은 IndexedDB에서 읽어 와야 해서 한 박자 늦게 그린다

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
