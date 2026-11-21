// 짤뽑기 — 취향 프롬프트를 늘 붙여 NovelAI로 한 장씩 뽑고, 고른 것과 버린 것에서 취향을 쌓는다.
// 화면 넷: 뽑기 / 비서 / 보관함 / 취향. 글자 데이터는 localStorage, 그림(보관한 것, 참고 그림)은 IndexedDB.

import { PERSONA_PARTS, partState, buildPersona, MODEL_CHOICES } from "./assistant.js";
import { PRESETS } from "./presets.js";
// 받은 파일을 블록으로 펼치는 것은 해체기와 같은 코드를 쓴다(같은 주소 아래 있어서 바로 불러옴). 해체기 폴더를 옮기면 이 줄도 고친다.
import { parseFile, vaultItems } from "../해체기/risu.js";

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
// chat 항목 하나: { role: "user" | "model", text, at, done? }. 비서 대화. 40개를 넘으면 앞에서부터 버린다.
//   done: 그 답에서 칸에 넣은 블록 번호들(2026-11-21). 옛 항목에는 없다 (없으면 아무것도 안 넣은 것으로 읽는다).
// settings 새 칸: sampler / noise(스케줄) / cfgRescale / variety / customW·customH(size가 "직접"일 때) / refMode("vibe"|"precise")
// draft 새 칸: chars [{id, text, neg, pos}] 인물별 프롬프트(pos: null=AI가 정함, 0~24=5x5 칸 번호), i2i {on, strength, noise} (원본 그림은 IndexedDB "src")
// presets 항목: { id, name, text, to: "scene"|"style"|"neg" } 사용자가 저장한 프롬프트
// userDict: 내 단어 사전 [{id, word, tags}]. 비서에게 말할 때 낱말이 들어 있으면 기본 사전보다 먼저 [사전 후보]로 붙는다. 옛 데이터에는 없어 처음 한 번 STARTER_DICT로 채운다(그 뒤에 비우면 다시 안 채움).
// presets 새 칸(옛 항목에는 없음, normPresets가 메움): kind("인물"|"그림체"|"자세·구도"|"빼는 것"|"내 것", 없으면 "내 것") / neg / note / at("front")
// presetEdits: 내장 프리셋(presets.js)을 고친 것. { "b:<종류>:<기본 이름>": { name?, text?, neg?, note?, hidden? } }. 기본과 같아진 칸은 지워서 기본 글이 따라오게 한다.
// draft.slots {count, traits, outfit, pose, bg, rest}: 이번 그림을 칸으로 나눈 것(위 ‘프롬프트 칸’). settings.qualityText: 7순위 품질 태그를 고친 글(비면 모델별 기본). 옛 데이터에는 없다.
// persona: 비서 지시문을 사용자가 고친 것. sections { <조각 id>: { text?, on? } }는 기본 조각을 덮어쓴 것만 담고, extra [{id, name, text, on}]는 사용자가 더한 조각,
//   auto { state, cand }는 앱이 지시문 뒤에 자동으로 붙이는 ‘앱 상태’와 ‘사전 후보’를 켜는지. 옛 데이터에는 없다 (normPersona가 메운다).
// log 새 칸: sampler / noise / cr / vb / chars / i2i / mode. 옛 항목에는 없다 (없으면 처음 값으로 읽는다).
// 2026-11-19 빼는 것을 둘로 나눔: taste.negative = 기본 빼는 것(모든 그림), draft.neg = 이번 빼는 것(프롬프트 칸처럼 프리셋·비서가 넣고 ‘칸 비우기’로 비워짐). 보내는 빼는 것은 둘을 이어 붙인 것.
//   log 새 칸 nd: 그 그림의 이번 빼는 것(옛 항목에는 없음). ext: 밖에서 받은 그림(취향 통계에서 뺌). name: 받은 파일 이름.
// 프리셋 그림: IndexedDB "pimg" { id: 프리셋 key("own:<id>" | "b:<종류>:<기본 이름>"), full(PNG, 긴 변 1024 이하), thumb, ref(프리셋을 넣을 때 참고 그림으로도 넣는지), at }
const SHAPE = () => ({
  settings: {
    token: "", model: "nai-diffusion-5-full", customModel: "", size: "세로", steps: 28, scale: 5, quality: true,
    aiKey: "", aiModel: MODEL_CHOICES[0], aiCustom: "", qualityText: "",
    sampler: "k_euler_ancestral", noise: "karras", cfgRescale: 0, variety: false, customW: 832, customH: 1216, refMode: "vibe",
  },
  taste: { style: DEFAULT_STYLE, negative: DEFAULT_NEG, seeded: true, negSplit: true },
  draft: { scene: sceneOf(DEFAULT_SLOTS), slots: { ...DEFAULT_SLOTS }, neg: "", seedLock: false, seed: null, seeded: true, chars: [], i2i: { on: false, strength: 0.7, noise: 0 } },
  log: [],
  chat: [],
  presets: [],
  persona: { sections: {}, extra: [], auto: { state: true, cand: true } },
  presetEdits: {},
  userDict: starterDict(),
});

const PRESET_KINDS = ["인물", "의상", "그림체", "작가", "자세·구도", "빼는 것", "내 것"];
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
// 내 단어 사전의 처음 낱말. art/취향.md와 이 앱 프리셋(가안)에서 자주 나온 말을, 기본 사전(tags.json)에 있고 게시물 1,000개 이상인 태그로 옮긴 것(2026-11-18 확인). 사용자가 고치거나 지울 수 있다.
const STARTER_DICT = [
  ["정장", "business suit, suit"], ["로우앵글", "from below"], ["내려다보는", "looking down, from below"], ["올려다보는", "looking up, from above"],
  ["팔짱", "crossed arms"], ["턱 괴", "head rest, hand on own chin"], ["왕좌", "throne"], ["눈물", "tears"], ["짜증", "annoyed"],
  ["겁먹", "scared, trembling"], ["오만", "smug, jitome, half-closed eyes"], ["회사원", "office lady"], ["중국식", "east asian"], ["한푸", "hanfu"],
  ["상반신", "upper body"], ["전신", "full body"], ["클로즈업", "close-up"], ["돌아봄", "looking back"], ["옆모습", "profile"],
];
const starterDict = () => STARTER_DICT.map(([word, tags]) => ({ id: crypto.randomUUID(), word, tags }));
const DICT_MAX = 300;

// ── 프롬프트 칸 ─────────────────────────────────────────────
// NovelAI로 가는 글은 칸을 이 순서로 이어 붙인다: 1 인원수·성별 → 2 화풍·작가(취향 프롬프트) → 3 캐릭터 특징 → 4 의상·장신구 → 5 포즈·시선·구도 → 6 배경·조명·분위기·이펙트 → (그 밖에) → 7 품질 태그.
// draft.slots에 담기는 칸은 아래 SLOT_KEYS. 2순위는 taste.style, 7순위는 settings.qualityText(비어 있으면 모델별 기본 글)에 있다.
// draft.scene은 칸들을 이어 붙인 값으로 늘 맞춰 둔다(기록·보관함·통계가 읽는 쪽이라 그대로 쓰게). 이 도우미들은 store가 만들어질 때 load()가 부르므로 함수로 둔다.
const SLOT_KEYS = ["count", "traits", "outfit", "pose", "bg", "rest"];
const SLOT_NAMES = { count: "인원수·성별", traits: "캐릭터 특징", outfit: "의상·장신구", pose: "포즈·시선·구도", bg: "배경·조명·분위기·이펙트", rest: "그 밖에" };
const DEFAULT_SLOTS = { count: "1girl, solo", traits: "blonde hair, long hair, east asian, mature female, elegant", outfit: "business suit, formal", pose: "looking at viewer, upper body", bg: "", rest: "" };
const COUNT_RE = /^(\d+\+?(girl|boy|girls|boys|other|others)|solo|no humans)$/i;
function tg(t) { return String(t || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join(", "); }
function joinTags(parts) { // 칸 글들을 이어 붙이되 같은 태그는 먼저 나온 것만 남긴다
  const seen = new Set(), out = [];
  for (const part of parts) for (const t of tg(part).split(", ")) { if (!t) continue; const k = t.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(t); }
  return out.join(", ");
}
function sceneOf(sl) { return joinTags(SLOT_KEYS.map((k) => sl?.[k])); }
function splitCount(text) { // 인원수·성별 태그(1girl, solo 등)만 따로 뽑는다
  const c = [], r = [];
  for (const t of tg(text).split(", ")) { if (!t) continue; (COUNT_RE.test(t.replace(/[{}\[\]]/g, "")) ? c : r).push(t); }
  return { count: c.join(", "), rest: r.join(", ") };
}
function normSlots(rawSlots, scene) { // 칸이 없던 옛 데이터는 scene 글에서 만든다. 못 나누는 글은 ‘그 밖에’로 간다
  const out = Object.fromEntries(SLOT_KEYS.map((k) => [k, ""]));
  if (rawSlots && typeof rawSlots === "object") { for (const k of SLOT_KEYS) if (typeof rawSlots[k] === "string") out[k] = rawSlots[k].slice(0, 4000); return out; }
  const sc = tg(scene);
  if (!sc) return out;
  if (sc === tg(DEFAULT_SCENE)) return { ...DEFAULT_SLOTS };
  const { count, rest } = splitCount(sc); out.count = count; out.rest = rest;
  return out;
}
function normDict(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && e.id && typeof e.word === "string" && typeof e.tags === "string").slice(0, DICT_MAX).map((e) => ({ id: String(e.id), word: e.word.slice(0, 40), tags: e.tags.slice(0, 300) }));
}
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
    if (SLOT_KEYS.includes(p.slot) && o.to === "scene") o.slot = p.slot;
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
  try { return normAll(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { return SHAPE(); }
}
// 저장된 것이든 내보낸 JSON이든 같은 꼴로 맞춘다(옛 데이터 보정 포함).
function normAll(raw) {
  const base = SHAPE();
  try {
    if (!raw || typeof raw !== "object") return base;
    const draft = { ...base.draft, ...(raw.draft || {}) };
    // 기본값이 생기기 전에 저장된 옛 데이터: 비어 있던 칸은 기본값으로 채우고, 직접 적은 것은 건드리지 않는다.
    if (!raw.draft?.seeded) { draft.seeded = true; if (!String(raw.draft?.scene || "").trim()) draft.scene = DEFAULT_SCENE; }
    draft.slots = normSlots(raw.draft?.slots, draft.scene);
    draft.scene = sceneOf(draft.slots);
    const settings = { ...base.settings, ...(raw.settings || {}) };
    if (typeof settings.qualityText !== "string") settings.qualityText = "";
    const taste = { ...base.taste, ...(raw.taste || {}) };
    if (taste.negative === OLD_NEG) taste.negative = DEFAULT_NEG;
    // 취향 처음 값이 생기기 전에 저장된 데이터: 비어 있으면 한 번만 채운다. 그 뒤에 사용자가 비우면 다시 채우지 않는다.
    if (!raw.taste?.seeded) { taste.seeded = true; if (!String(raw.taste?.style || "").trim()) taste.style = DEFAULT_STYLE; }
    draft.neg = typeof draft.neg === "string" ? draft.neg.slice(0, 4000) : "";
    // 2026-11-19 빼는 것을 기본·이번으로 나누기 전의 데이터: 처음 기본 글에 없는 태그(프리셋·비서가 쌓은 것)를 이번 빼는 것으로 한 번만 옮긴다.
    // 기본 글의 태그가 하나도 없으면(사용자가 통째로 바꾼 것) 그대로 둔다.
    if (!raw.taste?.negSplit) {
      taste.negSplit = true;
      const base = new Set(tg(DEFAULT_NEG).toLowerCase().split(", "));
      const cur = tg(taste.negative).split(", ").filter(Boolean);
      const extra = cur.filter((t) => !base.has(t.toLowerCase()));
      if (extra.length && extra.length < cur.length) {
        draft.neg = joinTags([draft.neg, extra.join(", ")]);
        taste.negative = cur.filter((t) => base.has(t.toLowerCase())).join(", ");
      }
    }
    // 항목 안쪽 칸은 펼치기가 메워 주지 않으니 읽는 자리에서 기본값을 준다.
    draft.chars = Array.isArray(draft.chars) ? draft.chars.filter((c) => c && c.id).slice(0, MAX_CHARS) : [];
    draft.i2i = { ...base.draft.i2i, ...(draft.i2i || {}) };
    return {
      settings,
      taste,
      draft,
      presets: normPresets(raw.presets),
      presetEdits: normPresetEdits(raw.presetEdits),
      userDict: Array.isArray(raw.userDict) ? normDict(raw.userDict) : starterDict(),
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
    // 2: 참고 그림 창고 "ref". 3: 이미지→이미지 원본 창고 "src"(한 줄, id "main"). 4: 프리셋 그림 창고 "pimg". 옛 창고는 그대로 둔다.
    // 5: 보관소 창고 "vault"(받은 프롬프트·파일을 펼친 블록).
    const q = indexedDB.open("짤뽑기", 5);
    q.onupgradeneeded = () => {
      for (const n of ["img", "ref", "src", "pimg", "vault"]) if (!q.result.objectStoreNames.contains(n)) q.result.createObjectStore(n, { keyPath: "id" });
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
const pimgPut = (row) => idb("readwrite", (s) => s.put(row), "pimg");
const pimgGet = (id) => idb("readonly", (s) => s.get(id), "pimg");
const pimgDel = (id) => idb("readwrite", (s) => s.delete(id), "pimg");
const pimgAll = () => idb("readonly", (s) => s.getAll(), "pimg");
const pimgClear = () => idb("readwrite", (s) => s.clear(), "pimg");
const vaultPutRows = (rows) => idb("readwrite", (s) => { rows.forEach((r) => s.put(r)); }, "vault");
const vaultAllRows = () => idb("readonly", (s) => s.getAll(), "vault");
const vaultDelRow = (id) => idb("readwrite", (s) => s.delete(id), "vault");
const vaultClear = () => idb("readwrite", (s) => s.clear(), "vault");

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

// 7순위 품질 태그: 모델별 기본 글(NovelAI 문서) 또는 사용자가 고친 글
const qDefault = (s) => (MODELS[modelId(s)] || MODELS["nai-diffusion-5-full"]).품질.replace(/^[,\s]+/, "");
const qText = (s) => tg(s.qualityText) || qDefault(s);
function syncScene() { store.data.draft.scene = sceneOf(store.data.draft.slots); }
// NovelAI로 보낼 글: 1 인원수 → 2 화풍·작가 → 3 특징 → 4 의상 → 5 포즈 → 6 배경 → 그 밖에 → 7 품질. 같은 태그는 먼저 나온 것만.
function composePrompt(sl, style, s) {
  return joinTags([sl.count, style, sl.traits, sl.outfit, sl.pose, sl.bg, sl.rest, s.quality ? qText(s) : ""]);
}

// ── 참고 그림 (V4.5 바이브 트랜스퍼) ─────────────────────────
// 그림은 IndexedDB "ref"에 둔다. 한 줄: { id, name, at, on, strength, info, full(PNG, 긴 변 1024 이하), thumb, enc }
// enc: { "<모델>|<정보량>": 인코딩 결과(base64) }. 인코딩은 NovelAI 서버가 해 주고 2 Anlas가 든다(문서). 같은 그림·모델·정보량이면 다시 안 한다.
const VIBE_API = "https://image.novelai.net/ai/encode-vibe";
const MAX_REFS = 4; // 한 번에 켜 쓰는 장수. 이 앱이 정한 한도. NovelAI의 한도는 확인하지 못했다.
const LIB_MAX = 60; // 서랍에 넣어 두는 장수 (2026-11-21: 자주 쓰는 바이브를 넣어 두고 골라 켠다)
const refCode = (r) => r.id.slice(0, 4); // 비서가 서랍 그림을 가리키는 짧은 이름
const refsOn = () => refs.filter((r) => r.on).length;
// 비서가 써도 되는 서랍 그림 (2026-11-21, 사용자가 고름). ai가 false인 그림은 비서에게 이름도 그림도 안 가고, refs 블록이 켜지도 끄지도 않는다. 옛 항목은 칸이 없어 써도 되는 것으로 읽는다.
const aiRefs = () => refs.filter((r) => r.ai !== false);
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

// NovelAI 바이브 파일(.naiv4vibe, 묶음은 .naiv4vibebundle). 안이 JSON이다:
// { identifier, type, image(base64), thumbnail(data URL), name, encodings: { "v4-5full": { <해시>: { encoding(base64), params: { information_extracted } } } }, importInfo: { model, information_extracted, strength } }
// 꼴은 RisuAI 소스(database.svelte.ts의 NAIVibeData, stableDiff.ts)에서 확인(2026-11-21). 묶음의 `vibes` 배열은 확인 못 해 있으면 읽는다.
// 파일에 든 인코딩을 그대로 enc에 넣으므로 그 모델·정보량으로는 다시 인코딩하지 않는다(Anlas 안 듦).
const VIBE_MODEL = { "v4-5full": "nai-diffusion-4-5-full", "v4-5curated": "nai-diffusion-4-5-curated", v4full: "nai-diffusion-4-full", v4curated: "nai-diffusion-4-curated-preview" };
const isVibeFile = (f) => /\.naiv4vibe(bundle)?$/i.test(f.name || "");
const b64Blob = async (v, type = "image/png") => (await fetch(/^data:/.test(v) ? v : `data:${type};base64,${v}`)).blob();
async function vibeRows(text) {
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : Array.isArray(j?.vibes) ? j.vibes : [j];
  const rows = [];
  for (const v of list) {
    if (!v || typeof v !== "object" || !v.encodings || typeof v.encodings !== "object") continue;
    const enc = {}; let firstInfo = null;
    for (const [mk, set] of Object.entries(v.encodings)) {
      const model = VIBE_MODEL[mk] || mk;
      for (const e of Object.values(set || {})) {
        if (typeof e?.encoding !== "string" || !e.encoding) continue;
        const info = clamp(e.params?.information_extracted, 0, 1, 1);
        enc[`${model}|${info}`] = e.encoding;
        if (firstInfo == null) firstInfo = info;
      }
    }
    if (!Object.keys(enc).length) continue;
    const wantInfo = clamp(v.importInfo?.information_extracted, 0, 1, firstInfo ?? 1);
    const info = Object.keys(enc).some((k) => k.endsWith(`|${wantInfo}`)) ? wantInfo : firstInfo;
    // 그림: 원본이 있으면 그것, 없으면 썸네일, 둘 다 없으면 빈 칸 그림. 원본이 없는 바이브는 든 인코딩으로만 쓸 수 있다(encOnly).
    let pic = null, encOnly = true;
    try { if (typeof v.image === "string" && v.image.length > 100) { pic = await prepRef(await b64Blob(v.image)); encOnly = false; } } catch { pic = null; encOnly = true; }
    if (!pic) { try { if (typeof v.thumbnail === "string" && v.thumbnail.length > 100) pic = await prepRef(await b64Blob(v.thumbnail, "image/jpeg")); } catch { pic = null; } }
    if (!pic) {
      const c = document.createElement("canvas"); c.width = 96; c.height = 128;
      const g = c.getContext("2d"); g.fillStyle = "#2a2428"; g.fillRect(0, 0, 96, 128); g.fillStyle = "#c9a45c"; g.font = "14px sans-serif"; g.textAlign = "center"; g.fillText("vibe", 48, 68);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/png"));
      pic = { full: blob, thumb: blob };
    }
    rows.push({ id: crypto.randomUUID(), name: String(v.name || "바이브").replace(/\.(png|jpe?g|webp|naiv4vibe)$/i, "").slice(0, 40), at: Date.now() + rows.length, on: false, strength: clamp(v.importInfo?.strength, 0, 1, 0.6), info, fid: 0.5, kind: "character&style", full: pic.full, thumb: pic.thumb, enc, ...(encOnly ? { encOnly: true } : {}), vibe: true });
  }
  return rows;
}

async function addRefs(files) {
  errMsg = "";
  for (const f of files) {
    if (isVibeFile(f) || /\.json$/i.test(f.name || "")) {
      try {
        const rows = await vibeRows(await f.text());
        if (!rows.length) throw new Error("바이브 인코딩이 안 들어 있음");
        let n = 0;
        for (const row of rows) {
          if (refs.length >= LIB_MAX) { errMsg = `서랍은 ${LIB_MAX}장까지. 안 쓰는 것을 ‘서랍 정리’에서 지우기.`; break; }
          row.on = refsOn() < MAX_REFS;
          await refPut(row);
          refs.push({ ...row, url: URL.createObjectURL(row.thumb) });
          n++;
        }
        const models = [...new Set(rows.flatMap((r) => Object.keys(r.enc).map((k) => MODELS[k.split("|")[0]]?.이름 || k.split("|")[0])))].join(", ");
        toast(`바이브 ${n}개를 서랍에 넣음 (든 인코딩: ${models}). 그 모델에서는 다시 인코딩 안 함`);
      } catch (e) { errMsg = `‘${f.name}’은 바이브 파일로 못 읽음 (${e?.message || e}).`; }
      continue;
    }
    if (refs.length >= LIB_MAX) { errMsg = `서랍은 ${LIB_MAX}장까지. 안 쓰는 것을 ‘서랍 정리’에서 지우기.`; break; }
    try {
      const { full, thumb } = await prepRef(f);
      const row = { id: crypto.randomUUID(), name: (f.name || "그림").replace(/\.(png|jpe?g|webp)$/i, "").slice(0, 40), at: Date.now(), on: refsOn() < MAX_REFS, strength: 0.6, info: 1, fid: 0.5, kind: "character&style", full, thumb, enc: {} };
      await refPut(row);
      refs.push({ ...row, url: URL.createObjectURL(thumb) });
    } catch (e) {
      errMsg = `‘${f.name || "그림"}’을 읽지 못함 (${e?.message || e}). 다른 파일로 시도.`;
    }
  }
  render();
}

// ── 프리셋 그림 (#5) ─────────────────────────────────────────
// 프리셋마다 그림 한 장(대표 그림). 그 그림을 참고 그림·이미지→이미지로 바로 넣거나, 프리셋을 넣을 때 참고 그림도 같이 넣게(ref) 할 수 있다.
let pimgs = new Map(); // key → { url(썸네일), ref }
async function loadPimgs() {
  try {
    pimgs.forEach((v) => URL.revokeObjectURL(v.url));
    pimgs = new Map((await pimgAll()).map((r) => [r.id, { url: URL.createObjectURL(r.thumb || r.full), ref: !!r.ref }]));
  } catch (e) { console.warn("프리셋 그림 읽기 실패", e); pimgs = new Map(); }
}
async function setPimg(key, blob) {
  const { full, thumb } = await prepRef(blob);
  const old = await pimgGet(key).catch(() => null);
  await pimgPut({ id: key, full, thumb, ref: !!old?.ref, at: Date.now() });
  await loadPimgs();
}
async function pimgBlob(key) { return (await pimgGet(key).catch(() => null))?.full || null; }
// 이 프리셋의 태그가 전부 들어 있는 보관한 그림 = 이 프리셋으로 만든 작품. 옛 기록에도 그대로 맞는다.
const normT = (t) => t.toLowerCase().replace(/[{}\[\]]/g, "").replace(/^-?\d+(\.\d+)?::/, "").replace(/::$/, "").trim();
function keptSets() {
  return store.data.log.filter((r) => r.verdict === "keep").map((r) => ({ r, pos: new Set(splitTags(`${r.scene},${r.style}`).map(normT)), neg: new Set(splitTags(r.negative).map(normT)) }));
}
function presetWorks(p, sets) {
  const want = splitTags(p.text).map(normT).filter(Boolean);
  if (!want.length) return [];
  return sets.filter((k) => want.every((t) => (p.to === "neg" ? k.neg : k.pos).has(t))).map((k) => k.r);
}

async function autoRef(key, p) {
  if (!pimgs.get(key)?.ref) return;
  const name = `프리셋 ${p.name || ""}`.trim().slice(0, 36);
  const had = refs.find((r) => r.name === name || r.name === `${name}.png`);
  if (had) { if (!had.on && refsOn() < MAX_REFS) { had.on = true; await refPut(rowOf(had)).catch(() => {}); render(); } return; } // 서랍에 이미 있으면 다시 넣지 않고 켠다
  const blob = await pimgBlob(key);
  if (blob) await toRefs(blob, name);
}
// ── 보관소 ─────────────────────────────────────────────────
// 다른 곳에서 받은 프롬프트·파일을 파일 안의 블록 그대로 펼쳐 둔다. IndexedDB "vault" 한 줄:
// { id, name, kind, label, size, at, src("파일"|"붙여 넣기"), blocks:[{title, kind, text, meta?}] }. 원본 파일은 안 남긴다.
let vault = [], vaultErr = "";
async function loadVault() {
  try { vault = ((await vaultAllRows()) || []).sort((a, b) => b.at - a.at); vaultErr = ""; }
  catch (e) { vault = []; vaultErr = `보관소를 못 읽음 (${e?.name || e}).`; }
}
async function vaultAdd(node, src) {
  const rows = vaultItems(node).map((it) => ({ id: crypto.randomUUID(), at: Date.now(), src, ...it }));
  if (!rows.length) return [];
  await vaultPutRows(rows);
  await loadVault();
  return rows;
}
// 블록을 어디에 넣을지. 값은 vaultPut이 읽는다.
const VTO = [
  ["scene", "이번 그림 칸 전체로 (scene 블록처럼)"], ["slot:count", "1순위 인원수·성별에 더하기"], ["style", "2순위 화풍·작가에 더하기"],
  ["slot:traits", "3순위 캐릭터 특징에 더하기"], ["slot:outfit", "4순위 의상에 더하기"], ["slot:pose", "5순위 포즈·구도에 더하기"],
  ["slot:bg", "6순위 배경에 더하기"], ["slot:rest", "‘그 밖에’ 칸에 더하기"], ["neg", "이번 빼는 것에 더하기"], ["char", "인물별 프롬프트 칸으로"],
  ["piece", "비서 내 조각으로"], ...PRESET_KINDS.map((k) => [`p:${k}`, `${k} 프리셋으로 저장`]),
];
const vtoGuess = (b) => (/빼는 것|negative|uc/i.test(b.kind) ? "neg" : /NAI·프롬프트|^scene$/i.test(b.kind) ? "scene" : /NAI·인물|^char$/.test(b.kind) ? "char" : /^style$/i.test(b.kind) ? "style" : "piece");
function vaultPut(b, to) {
  const d = store.data, text = b.text;
  if (to === "piece") return pasteToPiece(`## ${b.title}\n${text}`);
  if (to.startsWith("p:")) {
    const kind = to.slice(2), pto = KIND_TO[kind] || "scene", t = tidy(text);
    if (!t) return toast("블록이 비어 있음");
    const name = (prompt(`${kind} 프리셋 이름`, b.title.slice(0, 30)) || "").trim().slice(0, 30);
    if (!name) return;
    const pr = { id: crypto.randomUUID(), name, text: t, to: pto, kind, ...(pto === "scene" ? { slot: defaultSlot(kind) } : {}), ...(kind === "인물" ? { at: "front" } : {}) };
    d.presets.unshift(pr);
    toast(`‘${name}’을 ${kind} 프리셋으로 저장함`, () => { d.presets = d.presets.filter((x) => x !== pr); store.save(); });
    return store.save();
  }
  const snap = snapBlocks();
  let msg;
  if (to === "scene" || to === "char") msg = applyBlock(to, text, "v");
  else if (to === "style") { d.taste.style = mergeTags(d.taste.style, text, false); msg = "화풍·작가에 더함"; }
  else if (to === "neg") { d.draft.neg = mergeTags(d.draft.neg, text, false); msg = "이번 빼는 것에 더함"; }
  else if (to.startsWith("slot:")) { const k = to.slice(5); d.draft.slots[k] = mergeTags(d.draft.slots[k], text, false); syncScene(); d.draft.seedLock = false; msg = `${SLOT_NAMES[k]} 칸에 더함`; }
  if (!msg) return;
  toast(msg, () => restoreBlocks(snap));
  store.save();
}

// 그림 한 장을 참고 그림으로. 넣었으면 true. 지금 모델이 참고 그림을 못 보내면 알린다.
async function toRefs(blob, name) {
  const before = refs.length;
  await addRefs([new File([blob], `${name}.png`, { type: blob.type || "image/png" })]);
  if (refs.length === before) { toast(errMsg || "참고 그림으로 못 넣음"); return false; }
  ui.open.ref = true;
  const on = refs.at(-1)?.on;
  toast(`참고 그림 서랍에 넣음${on ? "" : ` (꺼 둠: 이미 ${MAX_REFS}장 켜짐)`}${refPlan(store.data.settings) ? "" : ". 지금 모델(V5)은 참고 그림을 안 보냄. V4.5 Full로 바꿔야 쓰임"}`);
  return true;
}

async function failText(res) {
  let said = "";
  try { const t = await res.text(); said = (JSON.parse(t).message ?? t).toString().slice(0, 200); } catch { /* 본문 없음 */ }
  const hint = res.status === 401 ? "토큰이 틀렸거나 만료됨. ‘화풍·작가’ 탭에서 다시 넣기."
    : res.status === 429 ? "요청이 너무 잦거나 다른 생성이 돌고 있음. 잠시 뒤 직접 다시 누르기."
    : "";
  return `${hint} (서버 ${res.status}${said ? `: ${said}` : ""})`.trim();
}

// 이 그림·모델·정보량의 인코딩이 없으면 서버에서 받아 저장해 둔다. 응답은 이진 파일이다.
async function encodeRef(r, model, token, signal) {
  const k = `${model}|${r.info}`;
  if (r.enc?.[k]) return r.enc[k];
  if (r.encOnly) throw new Error(`바이브 ‘${r.name}’에는 원본 그림이 없어서 새로 인코딩을 못 함. 파일에 든 것: ${Object.keys(r.enc || {}).map((x) => { const [m, i] = x.split("|"); return `${MODELS[m]?.이름 || m} 정보량 ${i}`; }).join(", ") || "없음"}. 모델이나 정보량을 거기에 맞추기.`);
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
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch (e) { throw new Error(`그림을 읽지 못함 (${e?.message || e}). 다른 파일로 시도하거나 JPEG·PNG로 바꿔서 올리기.`); }
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
  if (!s.token.trim()) { errMsg = "토큰이 없음. ‘화풍·작가’ 탭 ‘연결’ 칸에서 넣기."; return render(); }
  if (!modelId(s)) { errMsg = "모델 이름이 비어 있음. ‘화풍·작가’ 탭에서 고르기."; return render(); }
  if (!sceneOf(d.draft.slots) && !tidy(d.taste.style)) { errMsg = "그릴 것이 비어 있음."; return render(); }

  const [w, h] = sizeOf(s);
  const seed = d.draft.seedLock && Number.isInteger(d.draft.seed) ? d.draft.seed : Math.floor(Math.random() * 4294967295);
  const plan = refPlan(s);                                   // "vibe" | "precise" | null
  const used = plan ? refs.filter((r) => r.on) : [];         // 모델이 못 받으면 붙여 둔 그림이 있어도 안 보낸다
  const chars = supportsChars(s) ? d.draft.chars.filter((c) => tidy(c.text)).map((c) => ({ text: tidy(c.text), neg: tidy(c.neg || ""), pos: Number.isInteger(c.pos) ? c.pos : null })) : [];
  const useI2i = d.draft.i2i.on && src;
  const rec = {
    id: crypto.randomUUID(), scene: sceneOf(d.draft.slots), slots: { ...d.draft.slots }, style: tidy(d.taste.style), negative: joinTags([d.taste.negative, d.draft.neg]),
    seed, model: modelId(s), w, h, steps: clamp(s.steps, 1, MAX_STEPS, 28), scale: clamp(s.scale, 0, 10, 5), at: Date.now(), verdict: null,
    sampler: SAMPLERS[s.sampler] ? s.sampler : "k_euler_ancestral", noise: NOISES.includes(s.noise) ? s.noise : "karras",
    cr: clamp(s.cfgRescale, 0, 1, 0), vb: !!s.variety,
  };
  if (used.length) { rec.refs = used.map((r) => ({ s: r.strength, i: r.info, id: r.id, n: r.name })); rec.mode = plan; } // id: 다시 뽑기 때 서랍에서 같은 그림을 찾아 켠다
  if (chars.length) rec.chars = chars;
  if (tidy(d.draft.neg)) rec.nd = tidy(d.draft.neg);
  if (useI2i) rec.i2i = { strength: clamp(d.draft.i2i.strength, 0, 1, 0.7), noise: clamp(d.draft.i2i.noise, 0, 1, 0) };
  const prompt = composePrompt(rec.slots, rec.style, s);

  busy = new AbortController();
  phase = "";
  render();
  // 뽑는 동안 화면이 꺼지지 않게 잡아 둔다. 못 잡아도(지원 안 함·절전 모드) 그냥 뽑는다.
  let lock = null, okDone = false;
  try { lock = await navigator.wakeLock?.request("screen"); } catch { lock = null; }
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
    okDone = true;
  } catch (e) {
    if (e.name === "AbortError") errMsg = "취소함. (서버가 이미 받았으면 그 한 장은 계산됐을 수 있음)";
    else if (e instanceof TypeError) errMsg = "서버에 닿지 못함. 망이 끊겼는지 보기.";
    else errMsg = e.message || String(e);
  } finally {
    busy = null;
    phase = "";
    lock?.release?.().catch(() => {});
    render();
    // 끝난 것을 알린다: 짧은 진동, 뽑기 화면이면 그림(실패면 오류 줄)으로 올라가고 다른 탭이면 알림 한 줄.
    try { navigator.vibrate?.(okDone ? 60 : [40, 60, 40]); } catch { /* 진동 없는 기기 */ }
    if (route()[0] === "gen" || !SCREENS[route()[0]]) document.querySelector(okDone ? "figure.result" : "p.error")?.scrollIntoView({ block: "start", behavior: "smooth" });
    else toast(okDone ? "그림이 나옴. ‘뽑기’ 탭에서 보기" : `뽑기 실패: ${errMsg}`);
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

// 보관함에서 여러 장을 한꺼번에 (2026-11-21). 지운 것은 알림의 ‘되돌리기’(9초) 동안 기억해 둔다.
async function removeKeptMany(ids) {
  const d = store.data, rows = [], recs = [];
  for (const id of ids) {
    const row = await imgGet(id).catch(() => null);
    if (row) rows.push(row);
    await imgDel(id).catch(() => {});
    const rec = d.log.find((r) => r.id === id);
    if (rec) { recs.push(rec); rec.verdict = "drop"; }
    const hi = hist.findIndex((h) => h.rec.id === id);
    if (hi >= 0) { const [h] = hist.splice(hi, 1); if (now === h) now = null; URL.revokeObjectURL(h.url); }
  }
  ui.ksel = null;
  toast(`${ids.length}장 지움`, async () => {
    for (const row of rows) await imgPut(row).catch(() => {});
    for (const rec of recs) rec.verdict = "keep";
    store.save();
  });
  store.save();
}
// 고른 그림을 한 장씩 차례로 내려받는다. 브라우저가 처음에 ‘여러 파일 내려받기’를 허락할지 물을 수 있다.
async function saveKeptMany(ids) {
  let n = 0;
  for (const id of ids) {
    const row = await imgGet(id).catch(() => null);
    if (!row?.full) continue;
    const rec = store.data.log.find((r) => r.id === id) || {};
    const a = document.createElement("a");
    a.href = URL.createObjectURL(row.full);
    a.download = `jjal-${rec.seed ?? "x"}-${id.slice(0, 4)}.png`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    n++;
    await new Promise((r) => setTimeout(r, 350));
  }
  toast(n === ids.length ? `${n}장 내려받음` : `${n}장 내려받음 · ${ids.length - n}장은 그림 파일이 없음`);
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

// ── 받은 것 넣기 (#7) ───────────────────────────────────────
// NovelAI가 만든 PNG에는 tEXt 청크 Description(프롬프트)·Software·Source(모델)·Comment(생성 정보 JSON)가 들어 있다
// (novelai-sdk-unofficial 문서, NAIWeaver 변경 기록, 2026-11-19 확인). Comment의 키 이름은 변형이 있어 여럿을 같이 본다.
function pngTexts(u8) {
  if (u8.length < 8 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), dec = new TextDecoder();
  const out = {};
  for (let p = 8; p + 12 <= u8.length;) {
    const len = dv.getUint32(p), type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    if (p + 12 + len > u8.length) break;
    const body = u8.subarray(p + 8, p + 8 + len);
    if (type === "tEXt") { const z = body.indexOf(0); if (z > 0) out[dec.decode(body.subarray(0, z))] = dec.decode(body.subarray(z + 1)); }
    else if (type === "iTXt") { // 키\0 압축여부 방식 언어\0 번역키\0 글. 압축된 것은 건너뜀
      const z = body.indexOf(0);
      if (z > 0 && body[z + 1] === 0) { const l = body.indexOf(0, z + 3), t = l >= 0 ? body.indexOf(0, l + 1) : -1; if (t >= 0) out[dec.decode(body.subarray(0, z))] = dec.decode(body.subarray(t + 1)); }
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return out;
}
function naiMeta(u8) {
  const t = pngTexts(u8);
  if (!t) return null;
  let c = {};
  try { c = JSON.parse(t.Comment || "{}") || {}; } catch { c = {}; }
  const prompt = String(c.prompt ?? t.Description ?? "").trim();
  const uc = String(c.uc ?? c.negative_prompt ?? c.v4_negative_prompt?.caption?.base_caption ?? "").trim();
  if (!prompt && !uc) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  return { prompt, uc, seed: Number.isInteger(num(c.seed)) ? num(c.seed) : null, steps: num(c.steps), scale: num(c.scale), sampler: c.sampler, noise: c.noise_schedule, cr: num(c.cfg_rescale), model: String(t.Source || "").slice(0, 60) };
}
// ── 파일을 바로 넣기 (2026-11-21, 사용자: JSON 같은 파일을 바로 못 넣어 불편) ─────────
// 파일 하나에서 이번 그림에 넣을 것을 읽는다: { scene, neg, chars[], set{} }. 못 읽으면 null(보관소로 보낸다).
// 읽는 것: NovelAI PNG(안에 든 생성 정보), JSON(prompt·input / uc·negative_prompt / slots / parameters / v4 캡션), 글(‘Negative prompt:’ 줄로 나눔).
async function readForSlots(name, u8) {
  const out = { scene: "", neg: "", chars: [], set: {} };
  const take = (o) => {
    for (const [k, to] of [["seed", "seed"], ["steps", "steps"], ["scale", "scale"], ["sampler", "sampler"], ["noise_schedule", "noise"], ["noise", "noise"], ["cfg_rescale", "cr"], ["cr", "cr"]]) if (o?.[k] != null && out.set[to] == null) out.set[to] = o[k];
  };
  const meta = naiMeta(u8);
  if (meta) {
    out.scene = meta.prompt; out.neg = meta.uc; take(meta);
    let c = {};
    try { c = JSON.parse(pngTexts(u8)?.Comment || "{}") || {}; } catch { c = {}; }
    const negs = c.v4_negative_prompt?.caption?.char_captions || [];
    (c.v4_prompt?.caption?.char_captions || []).forEach((x, i) => { if (tidy(x?.char_caption || "")) out.chars.push({ text: tidy(x.char_caption), neg: tidy(negs[i]?.char_caption || "") }); });
    return out;
  }
  if (u8[0] === 0x89 && u8[1] === 0x50) return null; // 생성 정보가 없는 PNG
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(u8); } catch { return null; } // 글이 아닌 파일(zip·카드 등)은 보관소가 펼친다
  if (/^\s*[{[]/.test(text)) {
    let j;
    try { j = JSON.parse(text); } catch { j = null; }
    if (Array.isArray(j)) j = j.find((x) => x && typeof x === "object") || null;
    if (j && typeof j === "object") {
      const p = j.parameters && typeof j.parameters === "object" ? j.parameters : {};
      const str1 = (...v) => v.find((x) => typeof x === "string" && x.trim()) || "";
      if (j.slots && typeof j.slots === "object") out.scene = ["count", "traits", "outfit", "pose", "bg"].filter((k) => tidy(j.slots[k] || "")).map((k) => `${k}: ${tidy(j.slots[k])}`).join("\n") + (tidy(j.slots.rest || "") ? `\n${tidy(j.slots.rest)}` : "");
      else out.scene = str1(j.prompt, j.input, j.positive, j.positive_prompt, j.scene, j.caption, j.v4_prompt?.caption?.base_caption, p.v4_prompt?.caption?.base_caption, p.prompt);
      out.neg = str1(j.nd, j.uc, j.negative_prompt, j.negative, j.neg, p.negative_prompt, p.uc, j.v4_negative_prompt?.caption?.base_caption, p.v4_negative_prompt?.caption?.base_caption);
      const cc = j.v4_prompt?.caption?.char_captions || p.v4_prompt?.caption?.char_captions || p.characterPrompts || j.characterPrompts || j.chars || [];
      if (Array.isArray(cc)) for (const x of cc) { const t = tidy(typeof x === "string" ? x : x?.char_caption || x?.prompt || x?.text || ""); if (t) out.chars.push({ text: t, neg: tidy(x?.uc || x?.neg || "") }); }
      take(j); take(p);
      return out.scene || out.neg || out.chars.length ? out : null;
    }
  }
  const t = text.trim();
  if (!t || t.length > 6000) return null; // 긴 글은 프롬프트 한 덩어리가 아닐 가능성이 크다
  const m = t.match(/^([\s\S]*?)\n\s*(?:negative prompt|negative|빼는 것|uc)\s*:\s*([\s\S]*)$/i);
  out.scene = (m ? m[1] : t).trim();
  if (m) out.neg = m[2].split(/\n\s*(?:steps|seed|sampler)\s*:/i)[0].trim();
  return out;
}
// 고른 파일을 이번 그림 칸에 바로 넣는다. 못 읽는 꼴이면 보관소에 펼쳐 그 화면으로 간다.
async function fileToSlots(f) {
  const d = store.data, s = d.settings;
  let u8;
  try {
    if (f.size > 150 * 1024 * 1024) throw new Error("150MB 넘음");
    u8 = new Uint8Array(await f.arrayBuffer());
  } catch (e) { return toast(`‘${f.name}’을 못 읽음 (${e?.message || e})`); }
  const got = await readForSlots(f.name, u8).catch(() => null);
  if (!got) {
    try {
      const rows = await vaultAdd(await parseFile(f.name, u8), "파일");
      if (!rows.length) return toast(`‘${f.name}’에서 넣을 글을 못 찾음`);
      toast(`프롬프트 한 덩어리가 아니라서 보관소에 펼침 (${rows.reduce((a, r) => a + r.blocks.length, 0)}블록). 넣을 블록을 고르기`);
      location.hash = `#/vault/${rows[0].id}`;
    } catch (e) { toast(`‘${f.name}’을 못 읽음 (${e?.message || e})`); }
    return;
  }
  const before = snapBlocks(), done = [];
  if (tidy(got.scene)) { applyBlock("scene", got.scene, "file"); d.draft.chars = []; done.push("그림 칸"); } // 파일의 그림이 이번 그림을 통째로 대신한다. 옛 인물 칸도 비운다
  if (tidy(got.neg)) { d.draft.neg = tagsMinus(got.neg, d.taste.negative); done.push("빼는 것"); }
  if (got.chars.length && supportsChars(s)) { d.draft.chars = got.chars.slice(0, MAX_CHARS).map((c) => ({ id: crypto.randomUUID(), text: c.text, neg: c.neg || "", pos: null, from: "file" })); ui.open.chars = true; done.push(`인물 ${d.draft.chars.length}명`); }
  const g = got.set;
  if (Number.isInteger(Number(g.seed)) && g.seed !== "" && g.seed != null) { d.draft.seed = Number(g.seed); d.draft.seedLock = true; done.push(`시드 ${g.seed}`); }
  if (g.steps != null) s.steps = clamp(g.steps, 1, MAX_STEPS, 28);
  if (g.scale != null) s.scale = clamp(g.scale, 0, 10, 5);
  if (SAMPLERS[g.sampler]) s.sampler = g.sampler;
  if (NOISES.includes(g.noise)) s.noise = g.noise;
  if (g.cr != null) s.cfgRescale = clamp(g.cr, 0, 1, 0);
  if (g.steps != null || g.scale != null || SAMPLERS[g.sampler]) done.push("생성 값");
  if (!done.length) return toast(`‘${f.name}’에서 넣을 것을 못 찾음`);
  toast(`‘${f.name.slice(0, 24)}’에서 넣음: ${done.join(" · ")}`, () => restoreBlocks(before));
  store.save();
}
// 비서에게 붙일 파일을 글로 바꾼다. 보관소와 같은 펼치기를 쓴다(JSON·글·카드·NovelAI PNG·zip).
const DOC_MAX = 40000;
async function fileToDoc(f) {
  const u8 = new Uint8Array(await f.arrayBuffer());
  const items = vaultItems(await parseFile(f.name, u8));
  const full = items.flatMap((it) => it.blocks.map((b) => `## ${items.length > 1 ? it.name + " / " : ""}${b.title}\n${b.text}`)).join("\n\n").trim();
  if (!full) return null;
  return { name: (f.name || "파일").slice(0, 40), text: full.slice(0, DOC_MAX), len: full.length, cut: full.length > DOC_MAX };
}

const IN_MAX = 25 * 1024 * 1024; // 받은 그림 한 장 한도 (이 앱이 정한 값)
async function importImages(files) {
  let n = 0, withMeta = 0;
  const bad = [];
  for (const f of files) {
    try {
      if (f.size > IN_MAX) throw new Error("25MB 넘음");
      const meta = naiMeta(new Uint8Array(await f.arrayBuffer()));
      const bmp = await createImageBitmap(f);
      const w = bmp.width, h = bmp.height;
      bmp.close?.();
      const id = crypto.randomUUID(), prompt = meta?.prompt || "";
      const rec = {
        id, scene: prompt, slots: normSlots(null, prompt), style: "", negative: meta?.uc || "", nd: "",
        seed: meta?.seed ?? null, model: meta?.model || "받은 그림", w, h,
        steps: clamp(meta?.steps, 1, MAX_STEPS, 28), scale: clamp(meta?.scale, 0, 10, 5), at: Date.now(), verdict: "keep", ext: true, name: String(f.name || "").slice(0, 60),
      };
      if (SAMPLERS[meta?.sampler]) rec.sampler = meta.sampler;
      if (NOISES.includes(meta?.noise)) rec.noise = meta.noise;
      if (meta?.cr) rec.cr = clamp(meta.cr, 0, 1, 0);
      await imgPut({ id, full: f, thumb: await thumbOf(f) });
      store.data.log.unshift(rec);
      n++; if (meta) withMeta++;
    } catch (e) { bad.push(`${f.name || "그림"}(${e?.message || e})`); }
  }
  trimLog();
  store.save();
  toast(`${n}장을 보관함에 넣음${n ? ` · 생성 정보를 읽은 것 ${withMeta}장` : ""}${bad.length ? ` · 못 넣음: ${bad.slice(0, 3).join(", ")}` : ""}`);
}
// 내보낸 기록(JSON)을 되살린다. 기록·프리셋·내 단어·고친 내장 프리셋은 더하고(같은 것은 건너뜀), 화풍·작가·기본 빼는 것·비서 지시문은 불러온 값으로 바꾼다.
// 토큰·키·지금 칸·대화는 그대로 둔다. 그림은 JSON에 없어서 안 따라온다.
function importJson(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return toast("JSON이 아님. ‘기록 내보내기’로 받은 파일을 고르기"); }
  if (!raw || typeof raw !== "object" || !(Array.isArray(raw.log) || Array.isArray(raw.presets) || raw.taste)) return toast("짤뽑기에서 내보낸 기록이 아님");
  const inc = normAll(raw), d = store.data;
  if (!confirm(`불러올 것: 기록 ${inc.log.length}건, 내 프리셋 ${inc.presets.length}개, 내 단어 ${inc.userDict.length}개.\n\n기록·프리셋·내 단어는 지금 것에 더함(같은 것은 건너뜀).\n화풍·작가, 기본 빼는 것, 비서 지시문은 불러온 값으로 바꿈.\n토큰·키·지금 칸·대화는 그대로.\n그림은 JSON에 없어서 안 따라옴.`)) return;
  const before = JSON.stringify(d);
  const ids = new Set(d.log.map((r) => r.id));
  d.log = [...d.log, ...inc.log.filter((r) => !ids.has(r.id))].sort((a, b) => (b.at || 0) - (a.at || 0));
  trimLog();
  const pids = new Set(d.presets.map((x) => x.id));
  d.presets = [...d.presets, ...inc.presets.filter((x) => !pids.has(x.id))];
  for (const [k, v] of Object.entries(inc.presetEdits)) if (!d.presetEdits[k]) d.presetEdits[k] = v;
  const words = new Set(d.userDict.map((e) => e.word.trim()));
  d.userDict = [...d.userDict, ...inc.userDict.filter((e) => e.word.trim() && !words.has(e.word.trim()))].slice(0, DICT_MAX);
  d.taste = { ...d.taste, style: inc.taste.style, negative: inc.taste.negative };
  d.persona = inc.persona;
  toast(`기록을 불러옴 (기록 ${d.log.length}건)`, () => { store.data = normAll(JSON.parse(before)); store.save(); });
  store.save();
}
// 해체기에서 복사한 글을 비서 ‘내 조각’으로. 첫 줄이 "## 이름"이면 그 이름을 쓰고 본문에서 뺀다.
function pasteToPiece(text) {
  const pc = store.data.persona;
  const t = String(text || "").trim();
  if (!t) return toast("붙여 넣은 글이 비어 있음");
  if (pc.extra.length >= 20) return toast("내 조각은 20개까지. 비서 탭에서 하나 지운 뒤 다시");
  const m = t.match(/^##\s*(.+)\n?/);
  const e = { id: crypto.randomUUID(), name: (m ? m[1].replace(/^인물:\s*/, "") : "받은 글").trim().slice(0, 30), text: (m ? t.slice(m[0].length) : t).trim(), on: true };
  if (!e.text) return toast("제목 줄 말고 본문이 없음");
  pc.extra.push(e);
  toast(`비서 내 조각 ‘${e.name}’을 더함`, () => { pc.extra = pc.extra.filter((x) => x !== e); store.save(); });
  store.save();
}

async function shareImage(blob, rec) {
  const name = `jjal-${rec.seed ?? Date.now()}.png`; // 한글 이름은 크로미움이 무시하고 확장자 없는 ‘download’로 저장해서 영어로 둔다 (2026-11-21 확인)
  // 2026-11-21: 공유 시트를 거치지 않고 바로 내려받는다 (사용자 요청). 폰에서는 ‘다운로드’ 폴더로 간다.
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`내려받음: ${name}`);
}

// ── 취향 통계 ────────────────────────────────────────────────
// 고른 그림과 버린 그림의 태그를 세어, 고른 쪽에 치우친 것과 버린 쪽에 치우친 것을 낸다.
function tagStats() {
  const m = new Map();
  for (const r of store.data.log) {
    if (r.verdict !== "keep" && r.verdict !== "drop") continue;
    if (r.ext) continue; // 밖에서 받은 그림은 내 취향이 아니므로 세지 않는다
    // style이 없는 옛 기록에서 ‘undefined’가 태그로 세지던 것과, 취향이 아닌 인원수 태그(1girl·solo 등)를 뺀다 (2026-11-21)
    const tags = new Set(`${r.scene || ""},${r.style || ""}`.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t && !COUNT_RE.test(t)));
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
    judged: store.data.log.filter((r) => r.verdict && !r.ext).length,
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
let tagsErr = "";       // 실패했을 때 이유 한 줄
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
    if (!tags?.ko || !tags?.n) throw new Error("사전 모양이 이상함");
    tagsState = "ok";
  } catch (e) { tags = null; tagsState = "fail"; tagsErr = e?.message === "404" ? "파일이 없음(404)" : (e?.message || "받지 못함"); }
}

const splitTags = (t) => String(t || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const fmtN = (n) => (n === undefined ? "사전에 없음" : `게시물 ${n.toLocaleString("ko-KR")}`);

// 사용자가 쓴 한국어 낱말에서 사전 후보를 뽑는다. 내 단어 사전이 먼저고, 그다음 기본 사전(tags.json).
// 내 단어는 기본 사전을 못 받았어도 붙는다. 비서가 태그를 지어내지 않게 근거로 붙인다.
function candidates(text) {
  const out = [], seen = new Set();
  const mine = store.data.userDict.filter((e) => e.word.trim() && splitTags(e.tags).length && text.includes(e.word.trim())).sort((a, b) => b.word.length - a.word.length);
  for (const e of mine) {
    const ts = splitTags(e.tags);
    out.push(`${e.word.trim()} → ${ts.join(", ")} (내 사전)`);
    ts.forEach((t) => seen.add(t.toLowerCase()));
  }
  if (!tags) return out.slice(0, 20);
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
  return t.replace(/^\s*(count|traits|outfit|pose|bg)\s*:\s*/gim, "").replace(/-?\d*\.?\d+::|::/g, ",").replace(/[{}\[\]()]/g, "").split(/[,\n]/)
    .map((x) => x.trim().toLowerCase()).filter((x) => x && !x.includes(":") && !x.includes("@"));
}
// scene 블록의 태그를 사전과 맞춰 본다. 일반 태그만 사전에 있어서 캐릭터·작가 이름은 '사전에 없음'으로 나올 수 있다.
function checkTags(text) {
  if (!tags) return null;
  const missing = [], rare = [];
  const mine = new Set(store.data.userDict.flatMap((e) => splitTags(e.tags).map((t) => t.toLowerCase()))); // 내 사전의 태그는 사용자가 정한 것이라 검사에서 뺀다
  for (const t of new Set(plainTags(text))) {
    if (mine.has(t)) continue;
    const n = tags.n[t];
    if (n === undefined) missing.push(t);
    else if (n < RARE) rare.push(`${t}(${n})`);
  }
  return { missing, rare };
}

function parseBlocks(text) {
  const out = [], re = /```[ \t]*([a-z]*)[^\n`]*\n?([\s\S]*?)```/gi;
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
  const sl = draft.slots;
  const slotLines = [["1순위 인원수·성별", sl.count], ["2순위 화풍·작가", taste.style], ["3순위 캐릭터 특징", sl.traits], ["4순위 의상·장신구", sl.outfit], ["5순위 포즈·시선·구도", sl.pose], ["6순위 배경·조명·분위기·이펙트", sl.bg], ...(tg(sl.rest) ? [["그 밖에(칸을 못 나눈 글)", sl.rest]] : []), ["7순위 품질 태그", s.quality ? qText(s) : "꺼짐(안 붙임)"]].map(([n, v]) => `  ${n}: ${tg(v) || "(비어 있음)"}`).join("\n");
  const plan = refPlan(s);
  const presetLine = PRESET_KINDS.map((k) => { const names = presetEntries(k).filter((e) => !e.hidden && e.p.name).map((e) => e.p.name); return names.length ? `${k}[${names.join(", ")}]` : ""; }).filter(Boolean).join(" / ");
  return `\n\n## 앱 상태 (지금)\n- 모델: ${modelId(s)} (바이브 ${supportsVibe(s) ? "됨" : "안 됨"}, 정밀 참조 ${supportsPrecise(s) ? "됨" : "안 됨"}, 인물별 프롬프트 ${supportsChars(s) ? "됨" : "안 됨"})\n- 프롬프트 칸(앱이 1→7순위로 이어 붙여 보냄):\n${slotLines}\n- 인물별 프롬프트:${chars ? "\n" + chars : " 없음"}\n- 기본 빼는 것(모든 그림, 사용자만 고침): ${tidy(taste.negative) || "(비어 있음)"}\n- 이번 빼는 것(negative 블록이 통째로 바꾸는 칸): ${tidy(draft.neg) || "(비어 있음)"}\n- 생성 설정: 샘플러 ${s.sampler}, 스텝 ${s.steps}, 프롬프트 강도 ${s.scale}, cfg_rescale ${s.cfgRescale}, 노이즈 스케줄 ${s.noise}, Variety+ ${s.variety ? "켬" : "끔"}, 크기 ${w}x${h}\n- 시드: ${Number.isInteger(draft.seed) ? draft.seed : "없음"}${draft.seedLock ? " (고정)" : ""}\n- 참고 그림: ${plan ? `${plan === "vibe" ? "바이브" : "정밀 참조"} ${refs.filter((r) => r.on).length}장` : "안 씀"}\n- 이미지→이미지: ${draft.i2i.on && src ? `켬 (strength ${draft.i2i.strength}, noise ${draft.i2i.noise})` : "끔"}${now ? `\n- 방금 뽑은 그림: 시드 ${now.rec.seed}, 그림은 ${ui.withImg && !ui.attachFile ? "이 메시지에 첨부함" : "안 보여 줌"}` : ""}${ui.attachFile ? "\n- 첨부: 사용자가 고른 사진 한 장을 이 메시지에 붙임" : ""}\n- 프리셋(사용자가 눌러 쓰는 것): ${presetLine || "없음"}`;
}

// 제미니에 보내는 지시문 전체: 켠 조각들(+내 조각) + (켰다면) 앱 상태. 사전 후보는 질문마다 달라서 질문 쪽에 붙는다.
// 참고 그림 서랍과 refs 블록 쓰는 법. 지시문 조각을 사용자가 고쳐 두면 새 기본 글이 안 들어가므로(2026-11-21: 블록이 안 나옴) 조각과 따로 늘 붙인다.
function refsText() {
  const s = store.data.settings;
  const pool = aiRefs();
  if (!pool.length) return "";
  const lib = pool.map((r) => `- [${refCode(r)}] ${r.name} — ${r.on ? `켜짐, 강도 ${r.strength}, 정보량 ${r.info}` : "꺼짐"}`).join("\n");
  const can = refPlan(s);
  return `\n\n## 참고 그림 서랍 (지금)\n사용자가 앱에 넣어 둔 참고 그림(바이브)이다. 대괄호 안 네 글자가 그 그림의 이름표다. 방식: ${s.refMode === "precise" ? "정밀 참조" : "바이브"}, 한 번에 ${MAX_REFS}장까지 켠다.\n${lib}\n\n${can
    ? `이번 그림에 쓸 참고 그림은 네가 여기서 고른다. 프롬프트(scene 블록)를 줄 때, 그리고 사용자가 바이브·참고 그림·분위기·화풍을 말할 때는 답에 refs 코드 블록을 반드시 하나 넣는다. 블록 첫 줄은 정확히 \`\`\`refs 이고, 안에는 한 줄에 하나씩 \`이름표: 강도\` 또는 \`이름표: 강도 정보량\`만 쓴다. 예:\n\`\`\`refs\n${refCode(pool[0])}: 0.6\n\`\`\`\n적은 것만 켜지고 나머지는 꺼진다. 강도는 0~1, 바이브는 켠 것의 합이 1 이하. 이름표는 위 목록에 있는 것만 쓴다. 맞는 그림이 없으면 \`none\` 한 줄만 쓰고 이유를 한 줄로 말한다. 그림을 같이 받았으면(\`[서랍 그림 이름표]\` 글 뒤에 붙어 옴) 본 것을 근거로, 못 받았으면 이름만 보고 골랐다고 밝힌다.`
    : "지금 모델은 참고 그림을 안 보내므로 refs 블록을 쓰지 않는다. 쓰려면 V4.5 Full로 바꾸라고 알린다."}`;
}
function fullPersona() {
  const d = store.data;
  return buildPersona(d.persona) + refsText() + (d.persona.auto.state ? stateText() : "");
}

async function geminiFail(res) {
  let said = "";
  try { said = (JSON.parse(await res.text()).error?.message ?? "").slice(0, 200); } catch { /* 본문 없음 */ }
  const hint = res.status === 400 && /api key/i.test(said) ? "키가 틀림. ‘화풍·작가’ 탭에서 다시 넣기."
    : res.status === 403 ? "키 권한이 없거나 막힘."
    : res.status === 404 ? "모델 이름이 없음. ‘화풍·작가’ 탭에서 모델 고르기."
    : res.status === 429 ? "한도 초과. 잠시 뒤 직접 다시 보내기."
    : "";
  return `${hint} (제미니 ${res.status}${said ? `: ${said}` : ""})`.trim();
}

// opts.image: true면 방금 뽑은 그림을 이 질문에 붙여 구글로 보낸다 (사용자가 체크했을 때만)
async function ask(text, opts = {}) {
  const d = store.data, s = d.settings;
  askErr = "";
  const model = (s.aiModel === "custom" ? s.aiCustom : s.aiModel).trim().replace(/^models\//, "");
  if (!s.aiKey.trim()) { askErr = "제미니 키가 없음. ‘화풍·작가’ 탭 ‘연결’ 칸에서 넣기."; return render(); }
  if (!model) { askErr = "제미니 모델 이름이 비어 있음. ‘화풍·작가’ 탭에서 고르기."; return render(); }
  // 보여 줄 그림: 사용자가 고른 사진이 있으면 그것, 없으면 체크했을 때의 방금 뽑은 그림. 한 번에 한 장.
  const fileImg = ui.attachFile?.blob || null;
  const nowImg = !fileImg && opts.image && now ? now.blob : null;
  const imgBlob = fileImg || nowImg, imgKind = fileImg ? "file" : nowImg ? "now" : null;
  // 서랍 그림도 보여 주기(체크했을 때만 구글로 감): 켜 둔 것부터 12장까지, 썸네일 크기로.
  const doc = ui.attachDoc;
  const libShow = ui.withRefs ? aiRefs().sort((a, b) => (b.on ? 1 : 0) - (a.on ? 1 : 0)).slice(0, 12) : [];
  askDraft = "";
  d.chat.push({ role: "user", text, at: Date.now(), ...(imgKind ? { img: imgKind } : {}), ...(libShow.length ? { rn: libShow.length } : {}), ...(doc ? { doc: doc.name } : {}) });
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
    const img = imgBlob ? await shrinkJpeg(imgBlob) : null;
    const libParts = [];
    for (const r of libShow) {
      try { const data = await shrinkJpeg(r.thumb || r.full); libParts.push({ text: `[서랍 그림 ${refCode(r)}] ${r.name}` }, { inline_data: { mime_type: "image/jpeg", data } }); } catch { /* 못 읽는 그림은 건너뜀 */ }
    }
    const contents = hist.map((m, i) => {
      const last = i === hist.length - 1;
      const parts = [{ text: last && cand.length ? `${m.text}\n\n[사전 후보]\n${cand.join("\n")}` : m.text }];
      if (last && img) parts.unshift({ inline_data: { mime_type: "image/jpeg", data: img } });
      if (last && doc) parts.push({ text: `[붙인 파일: ${doc.name}${doc.cut ? ` (앞 ${DOC_MAX}자만)` : ""}]\n${doc.text}` });
      if (last) for (const lp of libParts) parts.push(lp);
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
    scrollAi = true; // 새 답의 첫머리로
    if (doc && ui.attachDoc === doc) ui.attachDoc = null; // 파일도 보낸 한 번만
    if (fileImg) clearAttach(); // 사진은 보낸 한 번만. 실패하면 남겨 두어 다시 보낼 수 있다
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
const BLOCK_LABEL = { scene: "이번 그림에 넣기", style: "화풍·작가로 쓰기", negative: "이번 빼는 것에 넣기", char: "인물 칸에 더하기", params: "설정 적용", refs: "참고 그림 이대로 켜기" };

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

// 블록을 넣기 전 값을 통째로 기억해 두고 ‘되돌리기’로 돌린다. 블록이 건드리는 것: 이번 그림, 취향 그림체, 빼는 것, 인물 칸, 생성 설정.
const SETTING_KEYS = ["sampler", "steps", "scale", "cfgRescale", "noise", "variety", "size"];
function snapBlocks() {
  const d = store.data;
  return JSON.stringify({ slots: d.draft.slots, lock: d.draft.seedLock, chars: d.draft.chars, style: d.taste.style, neg: d.taste.negative, nd: d.draft.neg, seed: d.draft.seed, refs: refs.map((r) => [r.id, r.on, r.strength, r.info]), rm: d.settings.refMode, set: Object.fromEntries(SETTING_KEYS.map((k) => [k, d.settings[k]])) });
}
function restoreBlocks(json) {
  const d = store.data, o = JSON.parse(json);
  d.draft.slots = o.slots; syncScene(); d.draft.seedLock = o.lock; d.draft.chars = o.chars; d.taste.style = o.style; d.taste.negative = o.neg; d.draft.neg = o.nd ?? "";
  Object.assign(d.settings, o.set);
  if ("seed" in o) d.draft.seed = o.seed;
  if (o.rm) d.settings.refMode = o.rm;
  for (const [id, on, st, info] of o.refs || []) { const r = refs.find((x) => x.id === id); if (r && (r.on !== on || r.strength !== st || r.info !== info)) { r.on = on; r.strength = st; r.info = info; refPut(rowOf(r)).catch(() => {}); } }
  store.save();
}

// scene 블록: 한 줄에 칸 하나(`count:` `traits:` `outfit:` `pose:` `bg:`로 시작). 줄 이름이 없는 글은 인원수 태그만 1순위로 빼고 나머지를 ‘그 밖에’ 칸에 넣는다.
// 블록이 이번 그림 전체를 대신하므로 블록에 없는 칸은 비워진다.
function parseSceneBlock(v) {
  const out = Object.fromEntries(SLOT_KEYS.map((k) => [k, ""])), loose = [];
  let labeled = false;
  for (const line of String(v).split("\n")) {
    const m = line.match(/^\s*(count|traits|outfit|pose|bg)\s*:\s*(.*)$/i);
    if (m) { labeled = true; const k = m[1].toLowerCase(); out[k] = joinTags([out[k], m[2]]); }
    else if (line.trim()) loose.push(line);
  }
  if (!labeled) { const { count, rest } = splitCount(loose.join("\n")); out.count = count; out.rest = rest; return out; }
  out.rest = joinTags(loose);
  return out;
}

// kind, 블록 글을 칸에 넣는다. 돌려주는 것은 사용자에게 알릴 한 줄 (null이면 아무것도 안 함)
// from: 블록이 나온 곳(비서 답·보관소 항목)의 표시. 인물 칸에 남겨 두고, 다른 곳에서 온 새 그림·새 인물이 들어오면 옛 인물 칸을 뺀다 (2026-11-21, 사용자 요청).
function applyBlock(kind, v, from = "") {
  const d = store.data;
  const dropOld = () => { const n = d.draft.chars.length; d.draft.chars = d.draft.chars.filter((c) => from && c.from === from); return n - d.draft.chars.length; };
  if (kind === "scene") {
    d.draft.slots = parseSceneBlock(v); syncScene(); d.draft.seedLock = false;
    const gone = dropOld();
    return `이번 그림 칸들을 바꿈${gone ? ` · 옛 인물 ${gone}명 뺌` : ""}`;
  }
  if (kind === "style") {
    if (!confirm(`화풍·작가를 바꿈. 앞으로 모든 그림에 붙음.\n\n지금 값: ${tidy(d.taste.style).slice(0, 140) || "(비어 있음)"}`)) return null;
    d.taste.style = tidy(v);
    return "화풍·작가를 바꿈";
  }
  if (kind === "negative") { d.draft.neg = tidy(v); return "이번 빼는 것 칸을 바꿈"; }
  if (kind === "char") {
    if (!supportsChars(d.settings)) return "이 모델은 인물별 프롬프트가 안 됨 (V4 이상)";
    const c = applyChar(v);
    if (!c) return "인물 태그가 비어 있음";
    const gone = dropOld();
    const same = d.draft.chars.findIndex((x) => tidy(x.text) === c.text); // 같은 블록을 다시 누르면 겹쳐 넣지 않고 그 칸을 새로 쓴다
    if (same < 0 && d.draft.chars.length >= MAX_CHARS) return `인물은 ${MAX_CHARS}명까지`;
    if (from) c.from = from;
    if (same >= 0) d.draft.chars[same] = c; else d.draft.chars.push(c);
    ui.open.chars = true;
    return `인물 칸을 ${same >= 0 ? "새로 씀" : "더함"}${gone ? ` · 옛 인물 ${gone}명 뺌` : ""}`;
  }
  if (kind === "refs") {
    // 한 줄에 `서랍이름: 강도 [정보량]`. 적힌 것만 켜고 나머지는 끈다. `none`이면 전부 끈다. `mode: vibe|precise`는 방식.
    const s = d.settings;
    if (!supportsVibe(s)) return "이 모델은 참고 그림이 안 됨 (V4.5 Full에서만)";
    const picks = new Map(); let mode = null, bad = 0;
    const room = MAX_REFS - refs.filter((r) => r.on && r.ai === false).length; // 내가 켜 둔 ‘비서가 못 씀’ 그림은 그대로 두고 남는 자리만 쓴다
    for (const line of String(v).split("\n")) {
      const mm = line.match(/^\s*mode\s*:\s*(vibe|precise)\s*$/i);
      if (mm) { mode = mm[1].toLowerCase(); continue; }
      const m = line.match(/^\s*\[?([0-9a-f]{4})\]?\s*[:=]?\s*([\d.]+)?(?:[\s,]+([\d.]+))?/i);
      if (!m) continue;
      const r = aiRefs().find((x) => refCode(x) === m[1].toLowerCase());
      if (!r) { bad++; continue; }
      if (picks.size < room) picks.set(r, { s: m[2], i: m[3] });
    }
    if (!picks.size && !/^\s*(none|없음)\s*$/im.test(v)) return bad ? "블록이 가리키는 그림이 서랍에 없음 (지웠거나 옛 답)" : "참고 그림 블록을 못 읽음";
    for (const r of aiRefs()) {
      const pk = picks.get(r);
      if (!pk && !r.on) continue;
      r.on = !!pk;
      if (pk?.s != null) r.strength = clamp(pk.s, 0, 1, 0.6);
      if (pk?.i != null) r.info = clamp(pk.i, 0, 1, 1);
      refPut(rowOf(r)).catch(() => {});
    }
    if (mode && (mode === "vibe" || supportsPrecise(s))) s.refMode = mode;
    ui.open.ref = true;
    return picks.size ? `참고 그림 ${picks.size}장 켬: ${[...picks.keys()].map((r) => r.name).join(", ")}${bad ? ` · ${bad}장은 서랍에 없음` : ""}` : "참고 그림을 전부 끔";
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
  if (m.role === "user") return `<div class="msg me">${esc(m.text)}${m.img ? `<small class="att">${m.img === "file" ? "사진 첨부" : "방금 그림 첨부"}</small>` : ""}${m.rn ? `<small class="att">서랍 그림 ${m.rn}장 첨부</small>` : ""}${m.doc ? `<small class="att">파일 첨부: ${esc(m.doc)}</small>` : ""}</div>`;
  const blocks = parseBlocks(m.text), done = Array.isArray(m.done) ? m.done : [];
  const usable = blocks.map((b, j) => (b.t === "code" && BLOCK_LABEL[b.lang] ? j : -1)).filter((j) => j >= 0);
  const parts = blocks.map((b, j) => {
    if (b.t === "text") return b.v.trim() ? `<p class="mt">${esc(b.v.trim())}</p>` : "";
    const id = `${i}:${j}`;
    const btn = BLOCK_LABEL[b.lang] ? (done.includes(j)
      ? `<button type="button" class="ghost done" data-blk="${id}" data-kind="${b.lang}" aria-label="${BLOCK_LABEL[b.lang]} (넣음, 누르면 다시 넣음)">✓ 넣음</button>`
      : `<button type="button" data-blk="${id}" data-kind="${b.lang}">${BLOCK_LABEL[b.lang]}</button>`) : "";
    let check = "";
    if (b.lang === "scene" || b.lang === "char") {
      const c = checkTags(b.v);
      if (c && (c.missing.length || c.rare.length)) {
        check = `<p class="hint">${c.missing.length ? `사전(일반 태그)에 없음: ${esc(c.missing.join(", "))}. 자연어 문구나 캐릭터 이름일 수 있음. ` : ""}${c.rare.length ? `게시물 ${RARE}개 미만이라 약할 수 있음: ${esc(c.rare.join(", "))}` : ""}</p>`;
      } else if (!c) check = `<p class="hint">태그 사전을 못 불러와 검사를 못 함.</p>`;
    }
    return `<div class="code"><pre>${esc(b.v)}</pre><div class="acts2">${btn}<button type="button" class="ghost" data-copy="${id}">복사</button></div>${check}</div>`;
  }).join("");
  const left = usable.filter((j) => !done.includes(j)).length;
  const all = usable.length >= 2
    ? `<div class="acts2 putall">${left
      ? `<button type="button" data-blkall="${i}">전부 넣기 <small>(${left === usable.length ? `${usable.length}개` : `남은 ${left}개`})</small></button>`
      : `<button type="button" class="ghost done" data-blkall="${i}" data-again="1">✓ 전부 넣음 <small>(다시 넣기)</small></button>`}</div>` : "";
  return `<div class="msg ai">${all}${parts || esc(m.text)}</div>`;
}

// ── 화면 ────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── 뽑기 화면 조각들 ─────────────────────────────────────────
// 접었다 펴는 칸. 화면이 다시 그려져도 펼친 상태를 기억하려고 ui.open에 둔다 (새로 고치면 처음으로).
const ui = { open: {}, withImg: false, attachFile: null, presetKind: "인물", pedit: null, showHidden: false, pput: null, pputText: "", dq: "", pimgOpen: null, pimgTarget: null, vq: "", bq: "", vShow: 40, vOpen: new Set(), vto: {} };
const sec = (k, title, hint, inner) =>
  `<details class="sec" data-sec="${k}" ${ui.open[k] ? "open" : ""}><summary>${title}${hint ? ` <small>${esc(hint)}</small>` : ""}</summary><div class="secbody">${inner}</div></details>`;

const QUICK = {
  pose: "지금 칸들의 인물·의상은 그대로 두고, 내 취향에 맞는 자세·구도를 서로 다른 3안으로 줘. 각 안은 칸 이름 줄을 쓴 scene 블록 전체로.",
  style: "지금 장면과 인물에 어울리는 그림체를 내 취향대로 잡아서 style 블록 하나로 줘. 지금 화풍·작가와 뭐가 다른지 한 줄.",
  tidy: "지금 칸들의 프롬프트를 정리해 줘. 겹치는 태그, 서로 부딪치는 태그, 반영이 약한 태그를 고쳐서 칸 이름 줄을 쓴 scene 블록 전체로. 바뀐 점은 한 줄.",
  params: "이 장면에 맞는 생성 설정을 params 블록 JSON으로 추천해 줘. Anlas가 안 드는 범위(스텝 28 이하, 일반 크기)에서. 이유 한 줄.",
};

// 비서에게 그림 보여 주기. 뽑기 화면의 AI 도우미와 ‘비서’ 탭이 같이 쓴다.
// 방금 뽑은 그림(체크)과 내가 고른 사진(한 번만) 둘 중 하나를 이 질문에 붙여 구글로 보낸다. 그림이 없을 때도 이유를 보여 준다.
function attachBar() {
  const f = ui.attachFile;
  return `
    <div class="attach">
      ${now
        ? `<label class="line"><input type="checkbox" id="withImg" ${ui.withImg ? "checked" : ""}> 방금 뽑은 그림도 같이 보여 주기 <span class="hint">체크하면 이 그림이 구글로 감</span></label>`
        : `<p class="hint">방금 뽑은 그림이 없어서 ‘방금 그림 보여 주기’는 꺼져 있음. 새로 고쳤거나 버린 뒤에는 없어짐. 뽑으면 체크칸이 생김.</p>`}
      ${f ? `<div class="srcrow"><img src="${f.url}" alt="고른 사진"><div><span class="hint">${esc(f.name)} — 다음 질문에 한 번 보냄 (구글로 감)</span><button type="button" class="ghost sm" id="askUnpick">빼기</button></div></div>` : ""}
      ${aiRefs().length ? `<label class="line"><input type="checkbox" id="withRefs" ${ui.withRefs ? "checked" : ""}> 참고 그림 서랍도 보여 주기 <span class="hint">비서용으로 둔 ${Math.min(aiRefs().length, 12)}장이 작게 줄어 구글로 감. 안 보여 줘도 이름은 비서가 앎${aiRefs().length < refs.length ? `. ${refs.length - aiRefs().length}장은 비서에게 안 감` : ""}</span></label>` : refs.length ? `<p class="hint">서랍 그림 ${refs.length}장이 전부 ‘비서가 못 씀’이라 비서는 참고 그림을 고르지 못함.</p>` : ""}
      ${ui.attachDoc ? `<div class="docrow"><span class="hint">파일 ‘${esc(ui.attachDoc.name)}’ — ${ui.attachDoc.len.toLocaleString()}자${ui.attachDoc.cut ? `, 앞 ${DOC_MAX.toLocaleString()}자만` : ""}. 다음 질문에 한 번 보냄 (구글로 감)</span><button type="button" class="ghost sm" id="askUndoc">빼기</button></div>` : ""}
      <input id="askFile" type="file" hidden>
      <button type="button" class="ghost sm" id="askPick">${f || ui.attachDoc ? "다른 사진·파일 고르기" : "사진·파일 붙이기"}</button>
    </div>`;
}
function clearAttach() { if (ui.attachFile) { URL.revokeObjectURL(ui.attachFile.url); ui.attachFile = null; } }

function aiPanel() {
  const { settings: s, chat } = store.data;
  const last = chat.length ? chat.length - 1 : -1;
  // 마지막 질문과 그 답만 여기서 보인다. 전체 대화는 ‘비서’ 탭.
  const shown = [];
  if (last >= 0) { if (chat[last].role === "model" && last > 0) shown.push(last - 1); shown.push(last); }
  const body = `
    ${s.aiKey.trim() ? "" : `<p class="notice">제미니 키가 아직 없음. <a href="#/taste/conn">‘화풍·작가’ 탭 ‘연결’ 칸</a>에서 넣어야 대답함.</p>`}
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
    ${attachBar()}
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
    <p class="hint">인원 태그(2girls 등)는 위 1순위 칸에 쓰고, 인물 칸에는 girl·boy처럼 숫자 없이 (NovelAI 문서). 인물 칸에는 화풍·작가·품질 태그가 안 붙음. 위치는 5x5 칸에서 고르고, 글로도 같이 쓰면 더 잘 따라옴(문서). 인물이 여럿이면 번짐이 생길 수 있음.</p>`;
}

function refInner() {
  const s = store.data.settings;
  if (!supportsVibe(s)) {
    return `<p class="hint">참고 그림은 V4.5 Full에서만 됨. V5는 서버가 거절함(2026-11-17 확인). ${refs.length ? `붙여 둔 ${refs.length}장은 V5에서는 안 보냄. ` : ""}‘화풍·작가’ 탭에서 모델을 V4.5 Full로 바꾸면 쓸 수 있음.</p>`;
  }
  const mode = s.refMode === "precise" ? "precise" : "vibe";
  const key = (r) => `${modelId(s)}|${r.info}`;
  const sum = refs.filter((r) => r.on).reduce((a, r) => a + r.strength, 0);
  const row = (r) => `
    <li class="ref">
      <img src="${r.url}" alt="${esc(r.name)}">
      <div class="refbody">
        <input type="text" class="rname" data-rname="${r.id}" value="${esc(r.name)}" aria-label="이름" autocomplete="off">
        <label>강도 <output id="rs-${r.id}">${r.strength}</output><input type="range" min="0" max="1" step="0.05" value="${r.strength}" data-rstr="${r.id}"></label>
        ${mode === "precise" ? `
        <label>충실도 <output id="rf-${r.id}">${r.fid ?? 0.5}</output><input type="range" min="0" max="1" step="0.05" value="${r.fid ?? 0.5}" data-rfid="${r.id}"></label>
        <label>무엇을 따라 할까<select data-rkind="${r.id}"><option value="character&style" ${r.kind !== "character" ? "selected" : ""}>캐릭터와 화풍</option><option value="character" ${r.kind === "character" ? "selected" : ""}>캐릭터만</option></select></label>` : ""}
        <label>정보량 <span class="hint">0~1${mode === "vibe" ? ", 바꾸면 다시 인코딩" : ""}</span><input type="number" inputmode="decimal" min="0" max="1" step="0.1" value="${r.info}" data-rinfo="${r.id}"></label>
        ${mode === "vibe" ? `<p class="hint">${r.enc?.[key(r)] ? `인코딩 있음 (다시 안 함${r.vibe ? ", 바이브 파일" : ""})` : r.encOnly ? "이 모델·정보량의 인코딩이 파일에 없음. 원본 그림이 없어 새로 못 함" : "다음 뽑기에서 인코딩 — 문서 기준 2 Anlas"}</p>` : ""}
        <label class="line"><input type="checkbox" data-rai="${r.id}" ${r.ai !== false ? "checked" : ""}> 비서가 써도 됨</label>
        <button type="button" class="ghost" data-roff="${r.id}">끄기 (서랍에 남음)</button>
      </div>
    </li>`;
  const on = refs.filter((r) => r.on), off = refs.filter((r) => !r.on);
  const tile = (r) => (ui.refEdit
    ? `<li class="rt edit"><img src="${r.url}" alt=""><input type="text" data-rname="${r.id}" value="${esc(r.name)}" aria-label="이름" autocomplete="off"><label class="line mini"><input type="checkbox" data-rai="${r.id}" ${r.ai !== false ? "checked" : ""}> 비서</label><button type="button" class="ghost sm danger" data-rdel="${r.id}">지우기</button></li>`
    : `<li class="rt"><button type="button" data-rpick="${r.id}" aria-label="${esc(r.name)} 켜기"><img src="${r.url}" alt="">${r.ai === false ? `<i class="noai">비서 ✕</i>` : ""}<span>${esc(r.name)}</span></button></li>`);
  return `
    <div class="seg seg2" role="group" aria-label="참고 방식">
      <button type="button" class="${mode === "vibe" ? "on" : ""}" data-rmode="vibe">바이브<small>화풍·색·분위기</small></button>
      <button type="button" class="${mode === "precise" ? "on" : ""}" data-rmode="precise" ${supportsPrecise(s) ? "" : "disabled"}>정밀 참조<small>${supportsPrecise(s) ? "캐릭터·옷 모양" : "V4.5에서만"}</small></button>
    </div>
    ${on.length ? `<ul class="refs">${on.map(row).join("")}</ul>` : `<p class="hint">켜 둔 그림 없음. 아래 서랍에서 눌러 켜기.</p>`}
    <div class="slothead rdh"><label>서랍 <span class="hint">${off.length}장 · 누르면 켜짐 (${on.length}/${MAX_REFS}) · 비서용 ${aiRefs().length}장</span></label>${refs.length ? `<button type="button" class="ghost mini" id="refEdit">${ui.refEdit ? "정리 끝" : "서랍 정리"}</button>` : ""}</div>
    ${ui.refEdit && refs.length ? `<div class="acts2"><button type="button" class="ghost sm" id="raiAll">${aiRefs().length === refs.length ? "전부 비서가 못 쓰게" : "전부 비서가 쓰게"}</button></div><p class="hint">‘비서’ 체크를 뺀 그림은 비서에게 이름도 그림도 안 가고, 비서가 켜거나 끄지 못함. 직접 켜서 쓰는 것은 그대로 됨.</p>` : ""}
    ${off.length ? `<ul class="rgrid ${ui.refEdit ? "edit" : ""}">${off.map(tile).join("")}</ul>` : ""}
    <input id="refFile" type="file" multiple hidden>
    <button type="button" class="ghost" id="addRef" ${refs.length >= LIB_MAX ? "disabled" : ""}>＋ 서랍에 그림·바이브 파일 넣기 (${refs.length}/${LIB_MAX})</button>
    <p class="hint">NovelAI에서 내려받은 바이브 파일(.naiv4vibe)도 됨. 파일에 든 인코딩을 그대로 써서 그 모델·정보량으로는 Anlas가 안 듦.</p>
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
const KIND_TO = { 인물: "scene", 의상: "scene", 그림체: "style", 작가: "style", "자세·구도": "scene", "빼는 것": "neg" }; // 종류 탭에서 새로 만들면 여기에 넣는 곳이 정해진다
const TARGET = { scene: "이번 그림", style: "화풍·작가", neg: "이번 빼는 것" };
const PFIELDS = ["name", "text", "neg", "note"];
const defaultSlot = (kind) => (kind === "인물" ? "traits" : kind === "의상" ? "outfit" : kind === "자세·구도" ? "pose" : "rest");
const SLOT_PRESET = { traits: "인물", outfit: "의상", pose: "자세·구도" }; // 칸 → 그 칸을 저장할 프리셋 종류
const bkey = (kind, p) => `b:${kind}:${p.name}`;
const baseOf = (key) => { const m = key.match(/^b:([^:]+):(.+)$/); return m ? (PRESETS[m[1]] || []).find((b) => b.name === m[2]) : null; };

// 한 종류의 프리셋 전부: 내장(고친 것 반영) + 내가 만든 것. 내장의 key는 기본 이름으로 고정이라 이름을 고쳐도 안 바뀐다.
function presetEntries(kind) {
  const d = store.data, out = [];
  for (const base of PRESETS[kind] || []) {
    const key = bkey(kind, base), e = d.presetEdits[key] || {};
    const p = { ...base, ...(base.to === "scene" ? { slot: base.slot || defaultSlot(kind) } : {}) };
    for (const f of PFIELDS) if (typeof e[f] === "string") p[f] = e[f];
    out.push({ key, p, own: false, hidden: !!e.hidden, edited: PFIELDS.some((f) => typeof e[f] === "string") });
  }
  for (const p of d.presets) if (p.kind === kind) out.push({ key: `own:${p.id}`, p: p.to === "scene" ? { ...p, slot: SLOT_KEYS.includes(p.slot) ? p.slot : defaultSlot(p.kind) } : p, own: true, hidden: false, edited: false });
  return out;
}
// 칸을 바꾸는 것(이번 그림·취향 그림체·빼는 것)을 넣기 전 값으로 기억해 두고, 넣은 뒤 ‘되돌리기’를 단다.
function applyPreset(p, mode) {
  const d = store.data;
  const snap = { slots: JSON.stringify(d.draft.slots), seedLock: d.draft.seedLock, style: d.taste.style, negative: d.taste.negative, nd: d.draft.neg };
  const msg = usePreset(p, mode);
  const changed = snap.slots !== JSON.stringify(d.draft.slots) || snap.style !== d.taste.style || snap.negative !== d.taste.negative || snap.nd !== d.draft.neg;
  toast(msg, changed ? () => {
    d.draft.slots = JSON.parse(snap.slots); syncScene(); d.draft.seedLock = snap.seedLock; d.taste.style = snap.style; d.taste.negative = snap.negative; d.draft.neg = snap.nd;
    store.save();
  } : null);
  store.save();
}
const targetNow = (p) => tidy(p.to === "scene" ? (store.data.draft.slots[p.slot] ?? store.data.draft.slots.rest) : p.to === "style" ? store.data.taste.style : store.data.draft.neg);
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

function pimgPanel(e, works) {
  const { key } = e, im = pimgs.get(key);
  return `
    <div class="pimgbox">
      ${im ? `<img class="pbig" src="${im.url}" alt="대표 그림">` : `<p class="hint">대표 그림이 아직 없음.</p>`}
      <div class="acts2">
        <button type="button" class="ghost sm" data-pimgfile="${esc(key)}">사진 고르기</button>
        ${now ? `<button type="button" class="ghost sm" data-pimgnow="${esc(key)}">방금 그림으로</button>` : ""}
        ${im ? `<button type="button" class="ghost sm" data-pimgref="${esc(key)}">참고 그림에 넣기</button><button type="button" class="ghost sm" data-pimgi2i="${esc(key)}">이미지→이미지로</button><button type="button" class="ghost sm" data-pimgdel="${esc(key)}">그림 빼기</button>` : ""}
      </div>
      ${im ? `<label class="line"><input type="checkbox" data-pimgauto="${esc(key)}" ${im.ref ? "checked" : ""}> 이 프리셋을 넣을 때 그림도 참고 그림으로 같이 넣기</label>` : ""}
      <p class="hint">이 프리셋으로 만든 작품 ${works.length}장 <span class="hint">(프리셋 태그가 다 들어 있는 보관한 그림)</span></p>
      ${works.length ? `<div class="wgrid">${works.slice(0, 24).map((r) => `<div class="wk"><a href="#/keep/${r.id}" data-thumb="${r.id}" style="aspect-ratio:${r.w}/${r.h}" aria-label="시드 ${r.seed ?? ""} 그림"></a><button type="button" class="ghost sm" data-pimgpick="${esc(key)}" data-wid="${r.id}">대표로</button></div>`).join("")}</div>${works.length > 24 ? `<p class="hint">최근 24장만 보임</p>` : ""}` : ""}
    </div>`;
}

function presetCard(e, sets) {
  const { p, key } = e;
  if (ui.pput === key) return presetPut(e);
  const im = pimgs.get(key), works = presetWorks(p, sets);
  const badge = e.own ? TARGET[p.to] : e.edited ? "고침" : p.ok ? "확정" : "가안";
  if (e.hidden) return `<div class="preset dim"><div class="phead"><b>${esc(p.name)}</b><span class="tag">숨김</span></div><div class="acts2"><button type="button" class="ghost" data-punhide="${esc(key)}">숨김 풀기</button></div></div>`;
  return `
    <div class="preset">
      <div class="phead">${im ? `<img class="pthumb" src="${im.url}" alt="">` : ""}<b>${esc(p.name) || "이름 없음"}</b><span class="tag ${!e.own && !e.edited && p.ok ? "ok" : ""}">${badge}</span></div>
      <p class="ptext">${esc(p.text) || "(비어 있음)"}</p>
      ${p.note ? `<p class="hint">${esc(p.note)}</p>` : ""}
      <div class="acts2">
        <button type="button" data-pset="${esc(key)}" data-pmode="add">더하기</button>
        <button type="button" class="ghost" data-pset="${esc(key)}" data-pmode="replace">바꾸기</button>
        ${p.neg ? `<button type="button" class="ghost" data-pset="${esc(key)}" data-pmode="neg">금지 태그도</button>` : ""}
        <button type="button" class="ghost" data-pedit="${esc(key)}">고치기</button>
        <button type="button" class="ghost" data-pimg="${esc(key)}">그림${im ? " ✓" : ""}${works.length ? ` · 작품 ${works.length}` : ""}</button>
      </div>
      ${ui.pimgOpen === key ? pimgPanel(e, works) : ""}
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
      ${e.own && p.to === "scene" ? `<label>넣는 칸<select data-pf="slot">${SLOT_KEYS.map((k) => `<option value="${k}" ${p.slot === k ? "selected" : ""}>${SLOT_NAMES[k]}</option>`).join("")}</select></label>` : ""}
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
  const sets = keptSets();
  const list = `<input id="pimgFile" type="file" accept="image/*" hidden>` + (shown.length ? shown.map((e) => (e.key === ui.pedit ? presetForm(e, kind) : presetCard(e, sets))).join("") : `<p class="hint">${kind === "내 것" ? "저장한 것이 아직 없음." : "없음."}</p>`) + `
    <div class="acts2">
      <button type="button" class="ghost" data-padd>＋ 새로 추가</button>
      ${kind === "내 것" ? `<button type="button" class="ghost" data-psave="scene">지금 이번 그림 저장</button><button type="button" class="ghost" data-psave="style">지금 화풍·작가 저장</button><button type="button" class="ghost" data-psave="neg">지금 빼는 것 저장</button>` : ""}
      ${nHidden ? `<button type="button" class="ghost" data-pshowhidden>${ui.showHidden ? "숨긴 것 감추기" : `숨긴 것 ${nHidden}개 보기`}</button>` : ""}
    </div>`;
  return `
    <div class="chips pk">${PKINDS.map((k) => `<button type="button" class="chip ${k === kind ? "on" : ""}" data-pkind="${k}">${k}</button>`).join("")}</div>
    ${list}
    <p class="hint">확정 = art 저장소에서 사용자가 확정한 것. 가안 = 사용자의 취향에서 이 앱이 짠 것이고, 태그는 사전에서 게시물 수를 확인함. 고친 것은 이 폰에만 저장되고, ‘기본값으로’로 되돌림. 인물은 이번 그림 맨 앞에, 의상은 4순위에, 자세·구도는 5순위에 더해짐. 빼는 것은 ‘이번 빼는 것’ 칸에 들어감. 뽑기 칸 제목 옆 ‘＋ … 프리셋’으로 캐릭터·의상·포즈 칸을 바로 저장함.</p>`;
}

function tagsMinus(a, b) { const no = new Set(tg(b).toLowerCase().split(", ")); return tg(a).split(", ").filter((t) => t && !no.has(t.toLowerCase())).join(", "); }
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
  if (mode === "neg") { d.draft.neg = mergeTags(d.draft.neg, p.neg, false); return `‘${p.name}’의 금지 태그를 이번 빼는 것에 더함`; }
  if (p.to === "scene") {
    // 프리셋은 자기 칸(slot)에만 넣는다. ‘바꾸기’도 그 칸만 바꾸고 다른 칸은 그대로 둔다.
    const slot = SLOT_KEYS.includes(p.slot) ? p.slot : "rest", sl = d.draft.slots;
    const put = (k, txt) => { if (!tidy(txt)) return; sl[k] = mode === "replace" ? tidy(txt) : mergeTags(sl[k], txt, p.at === "front"); };
    if (slot === "traits") { const { count, rest } = splitCount(p.text); put("count", count); put("traits", rest); } else put(slot, p.text);
    syncScene(); d.draft.seedLock = false;
    return `‘${p.name}’을 ${SLOT_NAMES[slot]} 칸에 ${mode === "replace" ? "바꿔 넣음" : "더함"}`;
  }
  if (p.to === "style") { const old = tidy(d.taste.style); d.taste.style = mode === "add" ? mergeTags(old, p.text, false) : tidy(p.text); return `화풍·작가에 ‘${p.name}’을 ${mode === "add" ? "더함" : "넣음"}${mode === "add" ? "" : `. 이전 값: ${old.slice(0, 90)}${old.length > 90 ? "…" : ""}`}`; }
  const old = tidy(d.draft.neg);
  d.draft.neg = mode === "replace" ? tidy(p.text) : mergeTags(old, p.text, false);
  return `이번 빼는 것에 ‘${p.name}’을 ${mode === "replace" ? `넣음. 이전 값: ${old.slice(0, 90)}${old.length > 90 ? "…" : ""}` : "더함"}`;
}

// 칸 아래 프리셋 칩 (2026-11-21, 사용자: 프리셋 쓰기가 번거로움). 누르면 그 칸에 더하고, 켜진 것을 다시 누르면 그 태그만 뺀다.
// 인물·의상은 하나만 켜진다: 다른 것을 누르면 먼저 켜져 있던 것의 태그(와 그 금지 태그)가 빠진다. 인물은 금지 태그도 같이 넣는다.
const CHIP_KIND = { traits: ["인물"], outfit: ["의상"], pose: ["자세·구도"], style: ["그림체", "작가"], neg: ["빼는 것"] };
const isArtist = (t) => /artist:|^\W*by\s/i.test(t);
// ＋를 눌렀을 때 미리 채울 글: 그 칸에 지금 적힌 것. 화풍·작가 칸은 작가 태그와 나머지를 갈라 준다.
function paddText(slotKey, kind) {
  const d = store.data, sl = d.draft.slots;
  if (slotKey === "traits") return joinTags([sl.count, sl.traits]);
  if (slotKey === "neg") return tg(d.draft.neg);
  if (slotKey === "style") return tg(d.taste.style).split(", ").filter((t) => t && isArtist(t) === (kind === "작가")).join(", ");
  return tg(sl[slotKey]);
}
function paddForm() {
  const a = ui.padd;
  return `
    <div class="preset pform padd" data-padd-form>
      <label>${a.kind} 프리셋 이름<input type="text" id="paddName" autocomplete="off" value="${esc(a.name)}" placeholder="${a.kind === "작가" ? "작가 이름이나 조합 이름" : "이름"}"></label>
      <label>내용 <span class="hint">영어 태그, 쉼표로. 지금 칸에 적힌 글을 넣어 둠</span><textarea id="paddText" rows="4" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${a.kind === "작가" ? "artist:이름, artist:이름" : ""}">${esc(a.text)}</textarea></label>
      ${a.kind === "인물" ? `<label>같이 뺄 것 <span class="hint">선택. 이 인물을 켤 때 빼는 것에 같이 들어감</span><input type="text" id="paddNeg" autocapitalize="off" autocomplete="off" value="${esc(a.neg || "")}"></label>` : ""}
      <div class="acts2"><button type="button" id="paddSave">저장</button><button type="button" class="ghost" id="paddCancel">취소</button></div>
    </div>`;
}
const CHIP_ONE = new Set(["인물", "의상"]);
const chipTarget = (p) => (p.to === "style" ? store.data.taste.style : p.to === "neg" ? store.data.draft.neg : store.data.draft.slots[SLOT_KEYS.includes(p.slot) ? p.slot : "rest"]);
const chipBody = (p) => (p.to === "scene" && p.slot === "traits" ? splitCount(p.text).rest : p.text); // 인물은 인원수 태그를 빼고 견준다(그건 1순위 칸에 있다)
function chipOn(p) {
  const want = tg(chipBody(p)).toLowerCase().split(", ").filter(Boolean);
  if (!want.length) return false;
  const have = new Set(tg(chipTarget(p)).toLowerCase().split(", "));
  return want.every((t) => have.has(t));
}
function chipOff(p) {
  const d = store.data;
  if (p.to === "style") d.taste.style = tagsMinus(d.taste.style, p.text);
  else if (p.to === "neg") d.draft.neg = tagsMinus(d.draft.neg, p.text);
  else { const k = SLOT_KEYS.includes(p.slot) ? p.slot : "rest"; d.draft.slots[k] = tagsMinus(d.draft.slots[k], chipBody(p)); syncScene(); }
  if (p.neg && p.to !== "neg") d.draft.neg = tagsMinus(d.draft.neg, p.neg);
}
function chipRow(slotKey) {
  return (CHIP_KIND[slotKey] || []).map((kind) => {
    const list = presetEntries(kind).filter((e) => !e.hidden && tidy(e.p.text || "") && (e.p.to === "scene" ? e.p.slot === slotKey : true));
    const open = ui.padd && ui.padd.kind === kind && ui.padd.slot === slotKey;
    return `<div class="pchips" role="group" aria-label="${kind} 프리셋">${CHIP_KIND[slotKey].length > 1 ? `<span class="pkl">${kind}</span>` : ""}${list.map((e) => `<button type="button" class="chip ${chipOn(e.p) ? "on" : ""}" data-pchip="${esc(e.key)}" aria-pressed="${chipOn(e.p)}">${esc(e.p.name) || "이름 없음"}</button>`).join("")}<button type="button" class="chip add" data-padd-open="${slotKey}:${kind}">＋ ${kind} 저장</button></div>${open ? paddForm() : ""}`;
  }).join("");
}
function chipToggle(key) {
  const d = store.data, p = presetByKey(key); if (!p) return;
  const kind = key.startsWith("own:") ? p.kind : key.match(/^b:([^:]+):/)?.[1];
  const snap = JSON.stringify({ slots: d.draft.slots, lock: d.draft.seedLock, style: d.taste.style, nd: d.draft.neg });
  let msg;
  if (chipOn(p)) { chipOff(p); msg = `‘${p.name}’을 뺌`; }
  else {
    const out = [];
    if (CHIP_ONE.has(kind)) for (const e of presetEntries(kind)) if (e.key !== key && !e.hidden && chipOn(e.p)) { chipOff(e.p); out.push(e.p.name); }
    usePreset(p, "add");
    if (kind === "인물" && tidy(p.neg || "")) usePreset(p, "neg");
    autoRef(key, p);
    msg = `‘${p.name}’을 넣음${kind === "인물" && tidy(p.neg || "") ? " (금지 태그도)" : ""}${out.length ? ` · ‘${out.join("’, ‘")}’은 뺌` : ""}`;
  }
  toast(msg, () => { const o = JSON.parse(snap); d.draft.slots = o.slots; syncScene(); d.draft.seedLock = o.lock; d.taste.style = o.style; d.draft.neg = o.nd; store.save(); });
  store.save();
}

// ── 단어 사전 (비서 탭) ──────────────────────────────────────
// 기본 사전(tags.json)에 없는 내 낱말은 ‘내 단어’에 적어 둔다. 비서에게 말할 때 낱말이 들어 있으면 그 태그가 [사전 후보]로 붙는다.
function dictStatus() {
  if (tags) return `기본 사전: 낱말 ${Object.keys(tags.ko).length.toLocaleString("ko-KR")}개, 태그 ${Object.keys(tags.n).length.toLocaleString("ko-KR")}개 불러옴.`;
  if (tagsState === "loading") return "기본 사전을 받는 중…";
  if (tagsState === "fail") return `기본 사전을 못 받음 (${esc(tagsErr)}). 내 단어는 그대로 쓰임. <button type="button" class="ghost sm" data-dretry>다시 받기</button>`;
  return "기본 사전은 아직 안 받음. 이 칸을 열면 받음.";
}

// 찾기: 내 단어 → 기본 사전의 한국어 낱말 → 영어 태그 이름 순. 최대 20줄.
function dictSearch(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const rows = [];
  for (const e of store.data.userDict) {
    const ts = splitTags(e.tags);
    if (e.word.toLowerCase().includes(q) || ts.some((t) => t.toLowerCase().includes(q))) rows.push({ word: e.word, tags: ts, own: true });
  }
  if (tags) {
    for (const [k, v] of Object.entries(tags.ko)) { if (rows.length >= 20) break; if (k.toLowerCase().includes(q)) rows.push({ word: k, tags: v.slice(0, 4) }); }
    if (rows.length < 20) {
      const seen = new Set(rows.flatMap((r) => r.tags));
      const hit = Object.entries(tags.n).filter(([t]) => t.includes(q) && !seen.has(t)).sort((a, b) => b[1] - a[1]).slice(0, 20 - rows.length);
      for (const [t] of hit) rows.push({ word: t, tags: [t], eng: true });
    }
  }
  return rows.slice(0, 20);
}
function dictResults() {
  const q = ui.dq.trim();
  if (!q) return `<p class="hint">한국어 낱말이나 영어 태그로 찾음. 태그를 누르면 ‘이번 그림’에 더함. 예: 금발, blonde</p>`;
  const rows = dictSearch(q);
  const none = `<p class="hint">${rows.length ? "" : tags ? "찾은 것이 없음. " : "기본 사전을 못 받아서 내 단어만 찾음. "}‘${esc(q)}’를 내 단어로 직접 더할 수 있음.</p><button type="button" class="ghost sm" data-dnew="${esc(q)}">‘${esc(q)}’ 내 단어로 더하기</button>`;
  return rows.map((r) => `<div class="drow"><b>${esc(r.word)}</b>${r.own ? " <small>내 단어</small>" : ""}<div class="chips">${r.tags.map((t) => `<button type="button" class="chip" data-dadd="${esc(t)}">${esc(t)} <small>${tags && !r.own ? fmtN(tags.n[t]).replace("게시물 ", "") : tags ? fmtN(tags.n[t.toLowerCase()]).replace("게시물 ", "") : ""}</small></button>`).join("")}</div></div>`).join("") + none;
}
function dictPanel() {
  const list = store.data.userDict.map((e) => {
    const ts = splitTags(e.tags);
    const info = tags && ts.length ? ts.map((t) => `${esc(t)}(${fmtN(tags.n[t.toLowerCase()])})`).join(" · ") : "";
    return `
      <div class="dent" data-did="${esc(e.id)}">
        <input type="text" data-dword maxlength="40" autocomplete="off" placeholder="낱말 (한국어)" value="${esc(e.word)}">
        <input type="text" data-dtags maxlength="300" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="태그, 쉼표로 (영어)" value="${esc(e.tags)}">
        ${info ? `<p class="hint">${info}</p>` : ""}
        <button type="button" class="ghost sm" data-ddel="${esc(e.id)}">지우기</button>
      </div>`;
  }).join("");
  const body = `
    <p class="hint" id="dstatus">${dictStatus()}</p>
    <label for="dq">사전에서 찾기</label>
    <input id="dq" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="금발, blonde, 팔짱 …" value="${esc(ui.dq)}">
    <div id="dres">${dictResults()}</div>
    <h2>내 단어 <small>${store.data.userDict.length}개</small></h2>
    <p class="hint">여기 적은 낱말이 비서에게 한 말에 들어 있으면 그 태그가 사전 후보로 먼저 붙음. 숫자는 기본 사전의 게시물 수(1000 미만이면 잘 안 먹을 수 있음).</p>
    ${list || `<p class="hint">아직 없음.</p>`}
    <button type="button" class="ghost" id="dadd" ${store.data.userDict.length >= DICT_MAX ? "disabled" : ""}>＋ 단어 더하기</button>`;
  return sec("dict", "단어 사전", `내 단어 ${store.data.userDict.filter((e) => e.word.trim()).length}개`, body);
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

// ── 프롬프트 칸 화면 ────────────────────────────────────────
// 1→7순위 칸. 2순위는 취향 프롬프트, 7순위는 품질 태그와 같은 값이다. 글자를 칠 때는 저장만 하고 다시 그리지 않는다.
function slotsPanel() {
  const d = store.data, sl = d.draft.slots, s = d.settings;
  const area = (key, val, ph) => `<textarea id="slot-${key}" data-slot="${key}" rows="1" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${esc(ph)}">${esc(val)}</textarea>`;
  // 2026-11-21 정리: 칸마다 붙던 설명 줄과 ‘…프리셋으로 저장’ 버튼 줄을 제목 줄 하나로 합쳤다. 저장은 제목 오른쪽 작은 버튼.
  const save = (key) => (false && SLOT_PRESET[key] ? `<button type="button" class="ghost mini" data-slotsave="${key}" aria-label="${SLOT_PRESET[key]} 프리셋으로 저장">＋ ${SLOT_PRESET[key]} 프리셋</button>` : "");
  const head = (key, n, title, extra = "") => `<div class="slothead"><label for="slot-${key}">${/^\d/.test(n) ? `<span class="num">${parseInt(n, 10)}</span>` : `<b>${n}</b>`} ${title}</label>${extra}</div>`;
  const row = (key, n, title, hint, val, ph) => `<div class="slot">${head(key, n, title, save(key))}${area(key, val, ph)}${chipRow(key)}</div>`;
  const full = composePrompt(sl, d.taste.style, s);
  const negAll = joinTags([d.taste.negative, d.draft.neg]);
  // 1~4순위(인물·화풍)는 그림마다 잘 안 바뀌어서 접어 둔다. 제목 옆에 지금 들어 있는 글 앞부분을 보여 준다.
  const fixedHint = [sl.count, d.taste.style, sl.traits, sl.outfit].map(tg).filter(Boolean).join(", ");
  return `
    ${sec("fixed", "인물·화풍", `1~4순위 · ${fixedHint || "비어 있음"}`, `
    ${row("count", "1순위", "인원수·성별", "", sl.count, "1girl, solo")}
    ${row("style", "2순위", "화풍·작가", "‘화풍·작가’ 탭과 같은 칸", d.taste.style, "{painterly}, artist:이름")}
    ${row("traits", "3순위", "캐릭터 고유 특징", "체형, 머리, 눈 색, 표정", sl.traits, "silver hair, long hair, blue eyes")}
    ${row("outfit", "4순위", "의상·장신구", "", sl.outfit, "black suit, necktie")}`)}
    ${row("pose", "5순위", "포즈·시선·구도", "", sl.pose, "crossed arms, from below, upper body")}
    ${row("bg", "6순위", "배경·조명·분위기·이펙트", "", sl.bg, "palace, backlighting")}
    ${tg(sl.rest) ? row("rest", "그 밖에", "칸을 나누기 전의 글", "위 칸으로 옮겨 적고 비워도 됨", sl.rest, "") : ""}
    <div class="slot">${head("neg", "빼는 것", "이번 그림")}
      ${area("neg", d.draft.neg, "earrings, gloves")}${chipRow("neg")}</div>
    ${sec("always", "늘 붙는 것", `품질 태그 ${s.quality ? "붙임" : "안 붙임"} · 기본 빼는 것 ${tg(d.taste.negative) ? tg(d.taste.negative).split(", ").length + "개" : "없음"}`, `
    <div class="slot">${head("quality", "7순위", "품질 태그", `<label class="line mini"><input type="checkbox" id="qualityOn" ${s.quality ? "checked" : ""}> 붙이기</label>`)}
      ${area("quality", qText(s), "")}
      <div class="acts2"><button type="button" class="ghost sm" id="qualityDef" ${tg(s.qualityText) ? "" : "disabled"}>모델 기본값으로</button></div>
    </div>
    <div class="slot">${head("negbase", "빼는 것", "기본 (모든 그림)")}
      ${area("negbase", d.taste.negative, "lowres, bad anatomy")}
      <div class="acts2"><button type="button" class="ghost sm" id="negDef" ${tidy(d.taste.negative) === tidy(DEFAULT_NEG) ? "disabled" : ""}>처음 값으로</button></div></div>
    <p class="hint">‘화풍·작가’ 탭의 같은 칸과 이어져 있음.</p>`)}
    ${sec("sprev", "완성된 프롬프트 보기", "", `<p class="hint">칸이 1→7순위로 이어 붙어 NovelAI로 감. 같은 태그는 먼저 나온 것만 남음.</p><p class="hint" id="scount">${full.length}자</p><pre class="pprev" id="sprevtxt">${esc(full) || "(비어 있음)"}</pre><p class="hint">빼는 것 전체</p><pre class="pprev" id="snegtxt">${esc(negAll) || "(비어 있음)"}</pre>`)}
    <div class="acts2"><button type="button" class="ghost sm" id="saveScene">칸 전부 프리셋으로</button><button type="button" class="ghost sm" id="slotsClear">칸 비우기</button><button type="button" class="ghost sm" id="slotPick">파일에서 넣기</button><input id="slotFile" type="file" hidden></div>
    <p class="hint">‘파일에서 넣기’: JSON·글·NovelAI PNG를 고르면 프롬프트·빼는 것·인물·시드가 칸에 바로 들어감. 여러 덩어리가 든 파일은 보관소에 펼쳐짐.</p>`;
}
function wireSlots() {
  const d = store.data, s = d.settings;
  const prev = () => {
    const t = composePrompt(d.draft.slots, d.taste.style, s); const a = $("sprevtxt"), c = $("scount"), n = $("snegtxt");
    if (a) a.textContent = t || "(비어 있음)"; if (c) c.textContent = `${t.length}자`;
    if (n) n.textContent = joinTags([d.taste.negative, d.draft.neg]) || "(비어 있음)";
  };
  const grow = (el) => { el.style.height = "auto"; el.style.height = Math.max(el.scrollHeight + 2, 46) + "px"; };
  document.querySelectorAll("details.sec").forEach((dt) => dt.addEventListener("toggle", () => { if (dt.open) dt.querySelectorAll("[data-slot]").forEach(grow); }));
  document.querySelectorAll("[data-slot]").forEach((el) => {
    grow(el);
    el.addEventListener("input", () => {
      grow(el);
      const k = el.dataset.slot;
      if (k === "style") d.taste.style = el.value;
      else if (k === "neg") d.draft.neg = el.value;
      else if (k === "negbase") { d.taste.negative = el.value; const b = $("negDef"); if (b) b.disabled = tidy(el.value) === tidy(DEFAULT_NEG); }
      else if (k === "quality") { s.qualityText = tg(el.value) === qDefault(s) ? "" : el.value; const b = $("qualityDef"); if (b) b.disabled = !tg(s.qualityText); }
      else { d.draft.slots[k] = el.value; syncScene(); }
      store.persist(); prev();
    });
  });
  on("slotPick", "click", () => $("slotFile").click());
  on("slotFile", "change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) fileToSlots(f); });
  on("qualityOn", "change", (e) => { s.quality = e.target.checked; store.persist(); prev(); });
  on("qualityDef", "click", () => { s.qualityText = ""; store.save(); });
  on("slotsClear", "click", () => {
    const before = JSON.stringify(d.draft.slots), beforeNeg = d.draft.neg;
    for (const k of SLOT_KEYS) d.draft.slots[k] = "";
    d.draft.neg = "";
    syncScene();
    toast("칸을 비움", () => { d.draft.slots = JSON.parse(before); d.draft.neg = beforeNeg; syncScene(); store.save(); });
    store.save();
  });
  on("negDef", "click", () => {
    const before = d.taste.negative;
    d.taste.negative = DEFAULT_NEG;
    toast("기본 빼는 것을 처음 값으로", () => { d.taste.negative = before; store.save(); });
    store.save();
  });
  document.querySelectorAll("[data-pchip]").forEach((b) => b.addEventListener("click", () => chipToggle(b.dataset.pchip)));
  document.querySelectorAll("[data-padd-open]").forEach((b) => b.addEventListener("click", () => {
    const [slot, kind] = b.dataset.paddOpen.split(":");
    ui.padd = ui.padd && ui.padd.kind === kind && ui.padd.slot === slot ? null : { slot, kind, name: "", text: paddText(slot, kind), neg: "" };
    render();
    $("paddName")?.focus();
  }));
  on("paddName", "input", (e) => { ui.padd.name = e.target.value; });
  on("paddText", "input", (e) => { ui.padd.text = e.target.value; });
  on("paddNeg", "input", (e) => { ui.padd.neg = e.target.value; });
  on("paddCancel", "click", () => { ui.padd = null; render(); });
  on("paddSave", "click", () => {
    const a = ui.padd, name = a.name.trim().slice(0, 30), text = tidy(a.text);
    if (!name) return toast("이름을 적기");
    if (!text) return toast("내용이 비어 있음. 태그를 적기");
    const to = KIND_TO[a.kind] || "scene";
    const pr = { id: crypto.randomUUID(), name, text, to, kind: a.kind, ...(to === "scene" ? { slot: a.slot } : {}), ...(a.kind === "인물" ? { at: "front" } : {}), ...(tidy(a.neg || "") ? { neg: tidy(a.neg) } : {}) };
    d.presets.unshift(pr);
    ui.padd = null;
    toast(`‘${name}’을 ${a.kind} 프리셋으로 저장함`, () => { d.presets = d.presets.filter((x) => x !== pr); store.save(); });
    store.save();
  });
  // 칸 하나를 그 종류의 프리셋으로 (#4). 캐릭터는 1순위 인원수 태그도 같이 담는다(넣을 때 다시 1순위로 나뉨).
  document.querySelectorAll("[data-slotsave]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.slotsave, kind = SLOT_PRESET[k];
    const text = tidy(k === "traits" ? joinTags([d.draft.slots.count, d.draft.slots.traits]) : d.draft.slots[k]);
    if (!text) return toast("칸이 비어 있어서 저장할 게 없음");
    const name = (prompt(`${kind} 프리셋 이름`) || "").trim().slice(0, 30);
    if (!name) return;
    const pr = { id: crypto.randomUUID(), name, text, to: "scene", kind, slot: k, ...(kind === "인물" ? { at: "front" } : {}) };
    d.presets.unshift(pr);
    ui.open.preset = true; ui.presetKind = kind; ui.pedit = null;
    toast(`‘${name}’을 ${kind} 프리셋으로 저장함`, () => { d.presets = d.presets.filter((x) => x !== pr); store.save(); });
    store.save();
  }));
}

function vaultList(list) {
  if (!list.length) return `<p class="hint">${vault.length ? "찾은 것이 없음." : "아직 없음."}</p>`;
  return list.map((v) => `<a class="vrow" href="#/vault/${v.id}"><span class="tag">${esc(v.label)}</span><b>${esc(v.name)}</b><small>${v.blocks.length}블록</small></a>`).join("");
}
function vaultItemView(id) {
  const v = vault.find((x) => x.id === id);
  if (!v) return `<p class="empty">보관소에 없음.<br><a href="#/vault">보관소로</a></p>`;
  return `
    <a class="back" href="#/vault">‹ 보관소</a>
    <h2>${esc(v.name)}</h2>
    <p class="hint">${esc(v.label)} · ${esc(v.src)} · ${new Date(v.at).toLocaleDateString("ko-KR")} · ${v.blocks.length}블록</p>
    <div class="acts2"><button type="button" class="ghost" id="vCopyAll">블록 전부 복사</button><button type="button" class="ghost" id="vDel">보관소에서 지우기</button></div>
    <input id="bq" type="search" placeholder="블록에서 찾기" value="${esc(ui.bq)}" autocomplete="off">
    <div id="blist">${blockList(v)}</div>`;
}
const VPREVIEW = 400, VOPEN = 20000;
function blockList(v) {
  const q = ui.bq.trim().toLowerCase();
  const hit = v.blocks.map((b, i) => ({ b, i })).filter(({ b }) => !q || (b.title + " " + (b.meta || "") + " " + b.text).toLowerCase().includes(q));
  const shown = hit.slice(0, ui.vShow);
  return `<p class="hint">${hit.length}블록${hit.length > shown.length ? ` 중 ${shown.length}개 보임` : ""}</p>${shown.map(({ b, i }) => {
    const open = ui.vOpen.has(i), long = b.text.length > VPREVIEW, sel = ui.vto[`${v.id}:${i}`] || vtoGuess(b);
    return `<section class="blk">
      <div class="bhead"><span class="tag">${esc(b.kind)}</span><b>${esc(b.title)}</b><small class="hint">${b.text.length}자</small></div>
      ${b.meta ? `<p class="hint">키워드: ${esc(b.meta)}</p>` : ""}
      <pre class="bout">${esc(open ? b.text.slice(0, VOPEN) : b.text.slice(0, VPREVIEW))}${!open && long ? "…" : ""}</pre>
      <div class="vput"><select data-vto="${i}" aria-label="넣을 곳">${VTO.map(([k, t]) => `<option value="${esc(k)}" ${k === sel ? "selected" : ""}>${esc(t)}</option>`).join("")}</select><button type="button" data-vgo="${i}">넣기</button></div>
      <div class="acts2"><button type="button" class="ghost sm" data-vcopy="${i}">복사</button>${long ? `<button type="button" class="ghost sm" data-vopen="${i}">${open ? "접기" : "펼치기"}</button>` : ""}</div>
    </section>`;
  }).join("")}${hit.length > shown.length ? `<button type="button" class="ghost" id="vMore">더 보기</button>` : ""}`;
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
    // 2026-11-21 재배치: 그림 자리가 맨 위, 뽑기 버튼은 아래에 떠 있음, 1~4순위는 접힘 (짤뽑기·짤뽑기공유 같이 고침)
    return `
      ${s.token.trim() ? "" : `<p class="notice">NovelAI 토큰이 아직 없음. <a href="#/taste/conn">‘화풍·작가’ 탭 ‘연결’ 칸</a>에서 넣어야 뽑힘.</p>`}
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
        <div class="acts">
          <button type="button" id="useSeed" class="ghost">시드 고정</button>
          <button type="button" id="toI2i" class="ghost">변형하기</button>
          <button type="button" id="toRef" class="ghost">참고 그림</button>
        </div>
` : `<div class="stage" style="aspect-ratio:${w}/${h}"><p>뽑은 그림이 여기 뜸</p><small>아래 칸을 채우고 ‘뽑기’</small></div>`}
      ${histStrip()}
      ${errMsg ? `<p class="error" role="alert">${esc(errMsg)}</p>` : ""}
      ${slotsPanel()}
      <div class="seg seg4" role="group" aria-label="크기">
        ${[...Object.keys(SIZES), "직접"].map((k) => `<button type="button" class="${s.size === k ? "on" : ""}" data-size="${k}">${k}<small>${k === "직접" ? `${w}×${h}` : SIZES[k].join("×")}</small></button>`).join("")}
      </div>
      ${s.size === "직접" ? `<div class="two"><label>가로 <span class="hint">64 단위</span><input id="customW" type="number" inputmode="numeric" step="64" min="64" max="1536" value="${w}"></label><label>세로<input id="customH" type="number" inputmode="numeric" step="64" min="64" max="1536" value="${h}"></label></div>` : ""}
      <div class="seedrow seed3"><input id="seed" type="number" inputmode="numeric" min="0" max="4294967295" placeholder="시드 (비우면 무작위)" aria-label="시드" value="${Number.isInteger(draft.seed) ? draft.seed : ""}"><button type="button" class="ghost" id="seedRand">무작위</button><label class="line"><input type="checkbox" id="seedLock" ${draft.seedLock ? "checked" : ""}> 고정</label></div>
      ${notes.length ? `<p class="hint warn">Anlas가 들 수 있음 (문서 기준, 이 앱에서 차감은 재 보지 않음): ${esc(notes.join(" · "))}</p>` : ""}
      <div class="gobar">${busy
        ? `<button type="button" id="stop" class="ghost big">${esc(phase || "뽑는 중…")} 눌러서 취소</button>`
        : `<button type="button" id="go" class="big">뽑기${nChars || nRefs || (draft.i2i.on && src) ? ` <small>(${[nChars ? `인물 ${nChars}` : "", nRefs ? `참고 ${nRefs}` : "", draft.i2i.on && src ? "이미지→이미지" : ""].filter(Boolean).join(" · ")})</small>` : ""}</button>`}</div>
      ${aiPanel()}
      ${sec("chars", "인물별 프롬프트", nChars ? `${nChars}명` : "", charsInner())}
      ${sec("ref", "참고 그림", nRefs ? `${s.refMode === "precise" ? "정밀 참조" : "바이브"} ${nRefs}장` : "", refInner())}
      ${sec("i2i", "이미지→이미지", draft.i2i.on && src ? "켬" : "", i2iInner())}
      ${sec("adv", "생성 설정", `${SAMPLERS[s.sampler] || s.sampler} · ${s.steps}스텝 · 강도 ${s.scale}`, advInner())}
      ${sec("preset", "프리셋", "인물·그림체·자세·빼는 것", presetInner())}`;
  },

  ai() {
    const { settings: s, chat } = store.data;
    const bubbles = chat.map((m, i) => msgHtml(m, i)).join("");
    return `
      ${s.aiKey.trim() ? "" : `<p class="notice">제미니 키가 아직 없음. <a href="#/taste/conn">‘화풍·작가’ 탭 ‘연결’ 칸</a>에서 넣어야 대답함.</p>`}
      ${chat.length ? "" : `<p class="empty">그리고 싶은 장면을 말로 던지면<br>NovelAI 태그 프롬프트로 바꿔 줌.<br><small>예: 금발 정장 입은 중국식 미인, 로우앵글로 내려다보는 오만한 느낌</small><br><small>자세·그림체·설정 추천과 그림 고치기는 ‘뽑기’ 탭 AI 도우미에서도 됨.</small></p>`}
      <div class="chat">${bubbles}${asking ? `<div class="msg ai dim">생각 중…</div>` : ""}</div>
      ${askErr ? `<p class="error" role="alert">${esc(askErr)}</p>` : ""}
      <textarea id="ask" rows="3" placeholder="장면, 인물, 분위기를 한국어로" autocomplete="off">${esc(askDraft)}</textarea>
      ${attachBar()}
      ${asking
        ? `<button type="button" id="stopAsk" class="ghost big">눌러서 취소</button>`
        : `<button type="button" id="send" class="big">보내기</button>`}
      ${chat.length ? `<button type="button" class="ghost" id="clearChat">대화 지우기</button>` : ""}
      ${dictPanel()}
      ${personaEditor()}
      <label for="aiModelQ">대답하는 모델 <span class="hint">${s.aiModel === "custom" ? "직접 입력한 이름은 ‘화풍·작가’ 탭에서 고침" : ""}</span></label>
      <select id="aiModelQ">${MODEL_CHOICES.map((m) => `<option value="${m}" ${s.aiModel === m ? "selected" : ""}>${m === "gemini-4-argon" ? "gemini-4-argon (아르곤)" : m}</option>`).join("")}<option value="custom" ${s.aiModel === "custom" ? "selected" : ""}>직접 입력${s.aiModel === "custom" && s.aiCustom ? ` (${esc(s.aiCustom)})` : ""}</option></select>
      <p class="hint">대답은 제미니(${esc(s.aiModel === "custom" ? s.aiCustom : s.aiModel)})가 하고, 태그는 같이 실린 단부루 사전에서 맞춰 봄. 제미니 말은 틀릴 수 있어서 넣은 뒤 직접 한 번 읽기.</p>`;
  },

  keep(id) {
    // 2026-11-21 정리: 새 것부터, 날짜별로 묶음, 같은 크기 칸 3줄. 상세는 이전·다음, 칸마다 복사, 지우기는 맨 아래.
    const kept = store.data.log.filter((r) => r.verdict === "keep").sort((a, b) => (b.at || 0) - (a.at || 0));
    if (id) {
      const k = kept.findIndex((x) => x.id === id), r = kept[k];
      if (!r) return `<p class="empty">없는 그림.<br><a href="#/keep">보관함으로</a></p>`;
      const prev = kept[k - 1], next = kept[k + 1];
      const field = (key, label, v) => `<div class="kf"><div class="kfh"><span>${label}</span>${v ? `<button type="button" class="ghost mini" data-kcopy="${key}">복사</button>` : ""}</div><p class="kfv">${esc(v) || "—"}</p></div>`;
      const vals = `시드 ${r.seed ?? "모름"} · ${r.w}×${r.h} · ${r.steps}스텝 · 강도 ${r.scale} · ${esc(r.model)} · ${esc(SAMPLERS[r.sampler] || "Euler Ancestral")}${r.noise ? ` · ${esc(r.noise)}` : ""}${r.cr ? ` · cfg rescale ${r.cr}` : ""}${r.vb ? " · Variety+" : ""}${r.refs?.length ? ` · ${r.mode === "precise" ? "정밀 참조" : "바이브"} ${r.refs.length}장(강도 ${r.refs.map((x) => x.s).join("·")}, 다시 뽑기에는 그림이 안 따라옴)` : ""}${r.i2i ? ` · 이미지→이미지(strength ${r.i2i.strength}, noise ${r.i2i.noise}, 바탕 그림은 안 따라옴)` : ""}`;
      return `
        <nav class="knav"><a class="back" href="#/keep">‹ 보관함</a><span class="knum">${k + 1} / ${kept.length}</span>
          <span class="kpn">${prev ? `<a href="#/keep/${prev.id}" aria-label="이전(더 새 그림)">‹</a>` : `<span aria-hidden="true">‹</span>`}${next ? `<a href="#/keep/${next.id}" aria-label="다음(더 옛 그림)">›</a>` : `<span aria-hidden="true">›</span>`}</span></nav>
        <figure class="result"><img id="full" alt="보관한 그림" width="${r.w}" height="${r.h}"></figure>
        <p class="hint kwhen">${r.ext ? `받은 그림${r.name ? ` · ${esc(r.name)}` : ""} · ` : ""}${r.at ? new Date(r.at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}</p>
        <div class="acts two">
          <button type="button" id="again">다시 뽑기</button>
          <button type="button" id="share" class="ghost">저장</button>
          <button type="button" id="keepI2i" class="ghost">이미지→이미지로</button>
          <button type="button" id="keepRef" class="ghost">참고 그림으로</button>
        </div>
        ${r.ext ? `<p class="hint">${r.scene ? "그림 안에 든 생성 정보를 읽었음." : "생성 정보가 없는 그림."} ‘다시 뽑기’는 지금 화풍·작가를 같이 붙임.</p>` : ""}
        ${field("scene", "그림", r.scene)}
        ${r.chars?.length ? `<div class="kf"><div class="kfh"><span>인물별</span></div><p class="kfv">${r.chars.map((c, i) => `${i + 1}. ${esc(c.text)}${Number.isInteger(c.pos) ? ` (칸 ${c.pos + 1})` : ""}`).join("<br>")}</p></div>` : ""}
        ${field("style", "화풍·작가", r.style)}
        ${sec("kmore", "빼는 것 · 생성 값", `시드 ${r.seed ?? "모름"}`, `${field("negative", "빼는 것", r.negative)}<div class="kf"><div class="kfh"><span>값</span></div><p class="kfv">${vals}</p></div>`)}
        <div class="kdel"><button type="button" id="del" class="ghost danger">이 그림 지우기</button></div>`;
    }
    const inBtn = `<input id="inFile" type="file" accept="image/*" multiple hidden><div class="acts2"><button type="button" class="ghost" id="inAdd">＋ 받은 그림 넣기</button></div><p class="hint">NovelAI PNG면 안에 든 프롬프트·시드를 읽어 ‘다시 뽑기’가 됨. 받은 그림은 취향 통계에 안 셈.</p>`;
    if (!kept.length) return `${inBtn}<p class="empty">아직 없음.<br>뽑은 그림에서 ‘♥ 보관’을 누르면 여기 모임.</p>`;
    // 날짜별로 묶는다: 오늘 · 어제 · 11월 19일. 날짜가 없는 옛 항목은 맨 끝 ‘날짜 모름’.
    const dayKey = (at) => { if (!at) return "날짜 모름"; const d0 = new Date(), d = new Date(at); const diff = Math.round((new Date(d0.toDateString()) - new Date(d.toDateString())) / 864e5); return diff === 0 ? "오늘" : diff === 1 ? "어제" : d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" }); };
    const groups = [];
    for (const r of kept) { const g = dayKey(r.at); if (groups.at(-1)?.g === g) groups.at(-1).list.push(r); else groups.push({ g, list: [r] }); }
    const sel = ui.ksel;
    const addBtn = sel
      ? `<div class="kbar"><b id="kselN">${sel.size}장 고름</b><button type="button" class="ghost sm" id="kAll">${sel.size === kept.length ? "전부 풀기" : "전부"}</button><button type="button" class="ghost sm" id="kSave">저장</button><button type="button" class="ghost sm danger" id="kDel">지우기</button><button type="button" class="ghost sm" id="kOff">취소</button></div>`
      : `<input id="inFile" type="file" accept="image/*" multiple hidden><div class="acts2 ktop"><button type="button" class="ghost sm" id="kOn">고르기</button><button type="button" class="ghost sm" id="inAdd">＋ 받은 그림 넣기</button></div>`;
    return `${addBtn}${groups.map(({ g, list }, gi) => `<h2 class="kday">${esc(g)} <small>${list.length}장</small>${sel ? `<button type="button" class="ghost mini" data-kday="${gi}">이 날 전부</button>` : ""}</h2><div class="kgrid ${sel ? "picking" : ""}" data-kg="${gi}">${list.map((r) =>
      `<a href="#/keep/${r.id}" class="${sel?.has(r.id) ? "sel" : ""}" data-thumb="${r.id}" aria-label="${r.ext ? "받은 그림" : `시드 ${r.seed} 그림`}">${r.ext ? `<span class="kbadge">받음</span>` : ""}</a>`).join("")}</div>`).join("")}<p class="hint kfoot">NovelAI PNG면 안에 든 프롬프트·시드를 읽어 ‘다시 뽑기’가 됨. 받은 그림은 취향 통계에 안 셈.</p>`;
  },

  vault(id) {
    if (id) return vaultItemView(id);
    const q = ui.vq.trim().toLowerCase();
    const list = !q ? vault : vault.filter((v) => (v.name + " " + v.blocks.map((b) => b.title + " " + b.text).join(" ")).toLowerCase().includes(q));
    return `
      ${vaultErr ? `<p class="error">${esc(vaultErr)}</p>` : ""}
      <p class="hint">다른 곳에서 받은 프롬프트·파일을 파일 안의 블록 그대로 펼쳐 이 폰에 둠. 블록마다 칸·프리셋·비서 조각에 넣을 수 있음. RisuAI 파일(.risup·.risum·.charx·카드), NovelAI PNG, 글·JSON, zip.</p>
      <input id="vFile" type="file" multiple hidden>
      <div class="acts2"><button type="button" id="vPick">＋ 받은 파일 펼치기</button></div>
      <label for="vText">받은 글 붙여 넣기 <span class="hint">## 제목, \`\`\` 블록, 빈 줄로 나눈 덩어리가 블록이 됨</span></label>
      <input id="vName" type="text" placeholder="이름 (비우면 첫 줄)" autocomplete="off">
      <textarea id="vText" rows="4" autocomplete="off" spellcheck="false" placeholder="받은 프롬프트, 설정…"></textarea>
      <div class="acts2"><button type="button" class="ghost" id="vPaste">펼쳐서 넣기</button></div>
      <h2>보관소 <small>${vault.length}개</small></h2>
      ${vault.length ? `<input id="vq" type="search" placeholder="이름·블록 글에서 찾기" value="${esc(ui.vq)}" autocomplete="off">` : ""}
      <div id="vlist">${vaultList(list)}</div>`;
  },

  taste() {
    // 2026-11-21 정리: 내 취향(화풍·작가, 자주 나온 태그)만 펼쳐 두고, 늘 붙는 것·연결·받은 것 넣기·데이터는 접는 칸으로.
    const { settings: s, taste, log } = store.data;
    const st = tagStats();
    const chip = (r, act) => `<button type="button" class="chip" ${act ? `data-add="${esc(r.tag)}"` : "disabled"}>${esc(r.tag)} <small>${r.keep}/${r.drop}</small></button>`;
    const hasTok = !!s.token.trim(), hasKey = !!s.aiKey.trim();
    if (ui.open.conn === undefined) ui.open.conn = !hasTok || !hasKey; // 처음 들어왔을 때 열쇠가 빠져 있으면 펼쳐 둔다
    const modelName = s.model === "custom" ? (s.customModel || "직접 입력") : (MODELS[s.model]?.이름 || s.model);
    const negN = tg(taste.negative) ? tg(taste.negative).split(", ").length : 0;
    const keptN = log.filter((r) => r.verdict === "keep").length;
    return `
      <h2>화풍·작가</h2>
      <p class="hint">모든 그림에 2순위로 붙음. 뽑기 탭 2순위 칸과 같은 값.</p>
      <textarea id="style" rows="4" autocapitalize="off" autocomplete="off" spellcheck="false"
        placeholder="artist:이름, soft lighting, muted colors">${esc(taste.style)}</textarea>

      <h2>고른 그림에 자주 나온 태그</h2>
      ${st.liked.length
        ? `<p class="hint">누르면 화풍·작가에 더함. 숫자는 보관/버림.</p><div class="chips">${st.liked.map((r) => chip(r, true)).join("")}</div>`
        : `<p class="hint">${st.judged < 4 ? `보관·버림을 ${st.judged}번 골랐음. 더 골라야 나옴.` : "아직 두 번 넘게 고른 새 태그가 없음."}</p>`}
      ${st.disliked.length ? `<h2>버린 그림에 자주 나온 태그</h2><div class="chips">${st.disliked.map((r) => chip(r, false)).join("")}</div>` : ""}

      <div class="tsecs">
      ${sec("talways", "늘 붙는 것", `품질 태그 ${s.quality ? "붙임" : "안 붙임"} · 기본 빼는 것 ${negN ? negN + "개" : "없음"}`, `
        <label for="negative">기본 빼는 것 <span class="hint">모든 그림에 붙음</span></label>
        <textarea id="negative" rows="3" autocapitalize="off" autocomplete="off" spellcheck="false">${esc(taste.negative)}</textarea>
        <label class="line"><input type="checkbox" id="quality" ${s.quality ? "checked" : ""}> 품질 태그 붙이기</label>
        <p class="hint">이번 그림에만 뺄 것은 뽑기 탭 ‘빼는 것 이번 그림’ 칸에.</p>`)}
      ${sec("conn", "연결", `NovelAI ${hasTok ? `✓ ${modelName}` : "✗ 토큰 없음"} · 제미니 ${hasKey ? "✓" : "✗ 키 없음"}`, `
        <label for="token">NovelAI 토큰</label>
        <input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
          placeholder="pst-…" value="${esc(s.token)}">
        <p class="hint">novelai.net → 톱니바퀴 → Account → Get Persistent API Token. 이 폰에만 저장되고 NovelAI로만 나감.</p>
        <label for="model">NovelAI 모델</label>
        <select id="model">
          ${Object.entries(MODELS).map(([id, m]) => `<option value="${id}" ${s.model === id ? "selected" : ""}>${m.이름}</option>`).join("")}
          <option value="custom" ${s.model === "custom" ? "selected" : ""}>직접 입력</option>
        </select>
        ${s.model === "custom" ? `<input id="customModel" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="nai-diffusion-…" value="${esc(s.customModel)}">` : ""}
        <p class="hint">참고 그림·인물별 프롬프트는 V4 이상, 정밀 참조는 V4.5 Full만. 스텝·샘플러는 뽑기 탭 ‘생성 설정’.</p>
        <label for="aiKey">제미니 API 키 <span class="hint">비서용</span></label>
        <input id="aiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
          placeholder="AIza…" value="${esc(s.aiKey)}">
        <p class="hint">aistudio.google.com에서 발급. 이 폰에만 저장되고 구글로만 나감. 비서에게 보낸 말과 화풍·작가가 구글로 감.</p>
        <label for="aiModel">비서 모델</label>
        <select id="aiModel">
          ${MODEL_CHOICES.map((m) => `<option value="${m}" ${s.aiModel === m ? "selected" : ""}>${m}</option>`).join("")}
          <option value="custom" ${s.aiModel === "custom" ? "selected" : ""}>직접 입력</option>
        </select>
        ${s.aiModel === "custom" ? `<input id="aiCustom" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="gemini-…" value="${esc(s.aiCustom)}">` : ""}`)}
      ${sec("tin", "받은 것 넣기", "그림 · 기록 · 해체기 글", `
        <input id="inFile" type="file" accept="image/*" multiple hidden>
        <input id="jsonFile" type="file" accept="application/json,.json" hidden>
        <div class="acts2">
          <button type="button" class="ghost" id="inAdd">받은 그림 → 보관함</button>
          <button type="button" class="ghost" id="jsonIn">내보낸 기록(JSON) 되살리기</button>
        </div>
        <label for="pasteIn">해체기에서 복사한 글 <span class="hint">비서가 늘 읽는 ‘내 조각’으로</span></label>
        <textarea id="pasteIn" rows="4" autocomplete="off" spellcheck="false" placeholder="## 인물: 이름&#10;설명…"></textarea>
        <div class="acts2"><button type="button" class="ghost" id="pasteGo">비서 내 조각으로 더하기</button></div>`)}
      ${sec("tdata", "데이터", `기록 ${log.length}건 · 보관 ${keptN}장`, `
        <p class="hint">전부 이 기기에만 있음. 다른 폰으로 옮기려면 내보내기 → 거기서 되살리기.</p>
        <button type="button" class="ghost" id="export">기록 내보내기 (JSON, 토큰·그림 제외)</button>
        <button type="button" class="danger" id="reset">전부 지우기</button>`)}
      </div>`;
  },
};

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { gen: "짤뽑기", ai: "비서", keep: "보관함", vault: "보관소", taste: "화풍·작가" };
const route = () => (location.hash.replace(/^#\/?/, "") || "gen").split("/");
let thumbUrls = [];
let renderSeq = 0;

function render() {
  const [n, arg] = route();
  const name = SCREENS[n] ? n : "gen";
  const seq = ++renderSeq;
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  document.getElementById("screen").innerHTML = (saveFail ? `<p class="error" role="alert">저장이 안 되고 있음. 이 기기 저장 공간이 참. 지금 고친 것은 새로 고치면 사라짐. ‘화풍·작가’ 탭에서 기록을 내보낸 뒤 오래된 대화나 기록을 지우기.</p>` : "") + SCREENS[name](arg);
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
  const text = tidy(to === "scene" ? d.draft.scene : to === "style" ? d.taste.style : (tidy(d.draft.neg) || d.taste.negative));
  if (!text) return toast("비어 있어서 저장할 게 없음");
  const name = (prompt("프리셋 이름") || "").trim().slice(0, 30);
  if (!name) return;
  d.presets.unshift({ id: crypto.randomUUID(), name, text, to, kind: "내 것", ...(to === "scene" ? { slot: "rest" } : {}) });
  ui.open.preset = true; ui.presetKind = "내 것";
  toast(`‘${name}’ 저장함`);
  store.save();
}

// 비서 입력칸·버튼·답 블록. 뽑기 화면의 AI 도우미와 ‘비서’ 탭이 같이 쓴다.
function wireAsk() {
  const d = store.data;
  on("ask", "input", (e) => { askDraft = e.target.value; });
  on("withImg", "change", (e) => { ui.withImg = e.target.checked; });
  on("withRefs", "change", (e) => { ui.withRefs = e.target.checked; });
  on("askPick", "click", () => $("askFile").click());
  on("askFile", "change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    const isImg = /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(f.name);
    askErr = "";
    // 그림은 그림으로 보여 주고, 그 밖의 파일(JSON·글·카드)은 안의 글을 붙인다. NovelAI PNG는 그림과 안에 든 생성 정보를 둘 다 붙인다.
    let doc = null;
    if (!isImg || /\.png$/i.test(f.name) || f.type === "image/png") {
      try { if (f.size > 150 * 1024 * 1024) throw new Error("150MB 넘음"); doc = await fileToDoc(f); } catch (err) { if (!isImg) { askErr = `‘${f.name}’을 못 읽음 (${err?.message || err}).`; return render(); } }
    }
    if (!isImg && !doc) { askErr = `‘${f.name}’에서 읽을 글을 못 찾음.`; return render(); }
    clearAttach(); ui.attachDoc = doc;
    if (isImg) ui.attachFile = { blob: f, name: (f.name || "사진").slice(0, 40), url: URL.createObjectURL(f) };
    render();
  });
  on("askUndoc", "click", () => { ui.attachDoc = null; render(); });
  on("askUnpick", "click", () => { clearAttach(); render(); });
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
  // 넣은 블록 표시: chat[i].done에 블록 번호를 남긴다. 되돌리면 넣기 전 표시로 돌린다.
  const fromOf = (i) => `m:${d.chat[i]?.at || i}`;
  const markDone = (i, js) => { const m = d.chat[i]; if (!m) return null; const was = Array.isArray(m.done) ? [...m.done] : []; m.done = [...new Set([...was, ...js])]; return () => { m.done = was; }; };
  document.querySelectorAll("[data-blk]").forEach((el) => el.addEventListener("click", () => {
    const v = blockOf(el.dataset.blk); if (!v) return;
    const before = snapBlocks();
    const [bi, bj] = el.dataset.blk.split(":").map(Number);
    const msg = applyBlock(el.dataset.kind, v, fromOf(bi));
    if (msg == null) return;
    const changed = snapBlocks() !== before;
    const unmark = changed ? markDone(bi, [bj]) : null;
    toast(msg, changed ? () => { unmark?.(); restoreBlocks(before); } : null);
    store.persist();
    if (el.dataset.kind === "scene" && route()[0] === "ai") location.hash = "#/gen"; else render();
  }));
  // 한 답의 블록을 한 번에 넣는다. 이번 그림 → 인물 → 빼는 것 → 설정 → 화풍·작가(확인창) 순서. 되돌리기 한 번에 전부 돌아간다.
  const ORDER = ["scene", "char", "refs", "negative", "params", "style"];
  document.querySelectorAll("[data-blkall]").forEach((el) => el.addEventListener("click", () => {
    const i = +el.dataset.blkall, m = d.chat[i]; if (!m) return;
    const again = el.dataset.again === "1", done = Array.isArray(m.done) ? m.done : [];
    const todo = parseBlocks(m.text).map((b, j) => ({ b, j }))
      .filter(({ b, j }) => b.t === "code" && BLOCK_LABEL[b.lang] && (again || !done.includes(j)))
      .sort((x, y) => ORDER.indexOf(x.b.lang) - ORDER.indexOf(y.b.lang) || x.j - y.j);
    if (!todo.length) return;
    const before = snapBlocks(), msgs = [], ok = [];
    for (const { b, j } of todo) { const r = applyBlock(b.lang, b.v, fromOf(i)); if (r != null) { msgs.push(r); ok.push(j); } }
    if (!ok.length) return;
    const changed = snapBlocks() !== before;
    const unmark = changed ? markDone(i, ok) : null;
    toast(`${ok.length}개 넣음: ${msgs.join(" · ")}`, changed ? () => { unmark?.(); restoreBlocks(before); } : null);
    store.persist();
    if (todo.some((x) => x.b.lang === "scene") && route()[0] === "ai") location.hash = "#/gen"; else render();
  }));
  document.querySelectorAll("[data-copy]").forEach((el) => el.addEventListener("click", async () => {
    let v = blockOf(el.dataset.copy); if (!v) return;
    const [ci, cj] = el.dataset.copy.split(":").map(Number);
    if (parseBlocks(d.chat[ci]?.text || "")[cj]?.lang === "scene") v = sceneOf(parseSceneBlock(v)); // 칸 이름 줄을 떼고 이어 붙인 글
    try { await navigator.clipboard.writeText(v); el.textContent = "복사함"; }
    catch { el.textContent = "복사 못 함 — 길게 눌러 직접 복사"; }
  }));
  if (scrollAi && route()[0] === "ai") { scrollAi = false; const ms = document.querySelectorAll("#screen > .chat > .msg"); const last = ms[ms.length - 1]; if (last) last.scrollIntoView({ block: "start" }); else scrollTo({ top: 0 }); }
  else scrollAi = false;
}

function wireDict() {
  const d = store.data;
  const upd = () => { const st = $("dstatus"); if (st) st.innerHTML = dictStatus(); const r = $("dres"); if (r) r.innerHTML = dictResults(); };
  // 이 화면을 열면 기본 사전을 받아 둔다 (처음 비서에게 말할 때만 받던 것을 앞당김). 받은 뒤에는 상태 줄과 찾기 결과만 고쳐 그린다.
  if (!tags && tagsState !== "loading") { tagsState = ""; loadTags().then(upd); upd(); }
  $("dstatus")?.addEventListener("click", (e) => { if (e.target.closest("[data-dretry]")) { tags = null; tagsState = ""; loadTags().then(upd); upd(); } });
  on("dq", "input", (e) => { ui.dq = e.target.value; const r = $("dres"); if (r) r.innerHTML = dictResults(); });
  $("dres")?.addEventListener("click", (e) => {
    const add = e.target.closest("[data-dadd]"), nw = e.target.closest("[data-dnew]");
    if (add) {
      const before = JSON.stringify(d.draft.slots), lock = d.draft.seedLock;
      d.draft.slots.rest = mergeTags(d.draft.slots.rest, add.dataset.dadd, false); syncScene(); d.draft.seedLock = false;
      toast(`‘${add.dataset.dadd}’를 ‘그 밖에’ 칸에 더함`, () => { d.draft.slots = JSON.parse(before); syncScene(); d.draft.seedLock = lock; store.save(); });
      store.persist();
    } else if (nw) {
      if (d.userDict.length >= DICT_MAX) return toast(`내 단어는 ${DICT_MAX}개까지`);
      d.userDict.unshift({ id: crypto.randomUUID(), word: nw.dataset.dnew.slice(0, 40), tags: "" });
      ui.open.dict = true; store.save();
      document.querySelector(".dent [data-dtags]")?.focus();
    }
  });
  on("dadd", "click", () => {
    if (d.userDict.length >= DICT_MAX) return;
    d.userDict.unshift({ id: crypto.randomUUID(), word: "", tags: "" });
    ui.open.dict = true; store.save();
    document.querySelector(".dent [data-dword]")?.focus();
  });
  const entry = (el) => d.userDict.find((x) => x.id === el.closest("[data-did]")?.dataset.did);
  document.querySelectorAll("[data-dword]").forEach((el) => el.addEventListener("input", () => { const e = entry(el); if (e) { e.word = el.value; store.persist(); } }));
  document.querySelectorAll("[data-dtags]").forEach((el) => el.addEventListener("input", () => { const e = entry(el); if (e) { e.tags = el.value; store.persist(); } }));
  document.querySelectorAll("[data-ddel]").forEach((el) => el.addEventListener("click", () => {
    const i = d.userDict.findIndex((x) => x.id === el.dataset.ddel);
    if (i < 0) return;
    const [gone] = d.userDict.splice(i, 1);
    toast(`‘${gone.word || "빈 칸"}’ 지움`, () => { d.userDict.splice(Math.min(i, d.userDict.length), 0, gone); store.save(); });
    store.save();
  }));
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

function wireVault(id) {
  const v = id && vault.find((x) => x.id === id);
  on("vPick", "click", () => $("vFile").click());
  on("vFile", "change", async (e) => {
    const fs = [...e.target.files]; e.target.value = "";
    let n = 0; const none = [];
    for (const f of fs) {
      try {
        if (f.size > 150 * 1024 * 1024) { none.push(`${f.name}(150MB 넘음)`); continue; }
        const rows = await vaultAdd(await parseFile(f.name, new Uint8Array(await f.arrayBuffer())), "파일");
        if (rows.length) n += rows.length; else none.push(f.name);
      } catch (err) { none.push(`${f.name}(${err?.message || err})`); }
    }
    toast(`보관소에 ${n}개 넣음${none.length ? ` · 펼칠 블록이 없음: ${none.slice(0, 3).join(", ")}` : ""}`);
    render();
  });
  on("vPaste", "click", async () => {
    const text = $("vText").value;
    if (!text.trim()) return toast("붙여 넣은 글이 비어 있음");
    const nm = $("vName").value.trim() || text.trim().split("\n")[0].slice(0, 40);
    const rows = await vaultAdd(await parseFile(/\.(txt|json)$/i.test(nm) ? nm : nm + ".txt", new TextEncoder().encode(text)), "붙여 넣기").catch(() => []);
    if (!rows.length) return toast("펼칠 블록이 없음");
    location.hash = `#/vault/${rows[0].id}`;
  });
  on("vq", "input", (e) => {
    ui.vq = e.target.value;
    const q = ui.vq.trim().toLowerCase();
    $("vlist").innerHTML = vaultList(!q ? vault : vault.filter((x) => (x.name + " " + x.blocks.map((b) => b.title + " " + b.text).join(" ")).toLowerCase().includes(q)));
  });
  if (!v) return;
  const redraw = () => { $("blist").innerHTML = blockList(v); wireBlocks(); };
  const wireBlocks = () => {
    document.querySelectorAll("[data-vto]").forEach((el) => el.addEventListener("change", () => { ui.vto[`${v.id}:${el.dataset.vto}`] = el.value; }));
    document.querySelectorAll("[data-vgo]").forEach((b) => b.addEventListener("click", () => {
      const i = +b.dataset.vgo, sel = document.querySelector(`[data-vto="${i}"]`);
      vaultPut(v.blocks[i], sel.value);
    }));
    document.querySelectorAll("[data-vcopy]").forEach((b) => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(v.blocks[+b.dataset.vcopy].text); toast("복사함"); } catch { toast("복사 못 함. 글을 길게 눌러 직접 선택"); }
    }));
    document.querySelectorAll("[data-vopen]").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.vopen; if (ui.vOpen.has(i)) ui.vOpen.delete(i); else ui.vOpen.add(i); redraw(); }));
    on("vMore", "click", () => { ui.vShow += 40; redraw(); });
  };
  wireBlocks();
  on("bq", "input", (e) => { ui.bq = e.target.value; ui.vShow = 40; redraw(); });
  on("vCopyAll", "click", async () => {
    const all = v.blocks.map((b) => `## ${b.title}${b.meta ? `\n키워드: ${b.meta}` : ""}\n${b.text}`).join("\n\n");
    try { await navigator.clipboard.writeText(all); toast(`블록 ${v.blocks.length}개를 복사함`); } catch { toast("복사 못 함"); }
  });
  on("vDel", "click", async () => {
    if (!confirm("보관소에서 지움. 되돌릴 수 없음.")) return;
    await vaultDelRow(v.id).catch(() => {});
    await loadVault();
    location.hash = "#/vault";
  });
}

// [data-thumb] 칸에 보관한 그림의 썸네일을 채운다. 화면이 다시 그려졌으면(seq가 바뀜) 그만둔다.
function fillThumbs(seq) {
  document.querySelectorAll("[data-thumb]").forEach(async (a) => {
    const row = await imgGet(a.dataset.thumb).catch(() => null);
    if (seq !== renderSeq) return;
    if (!row) { a.textContent = "그림 없음"; return; }
    const u = URL.createObjectURL(row.thumb || row.full);
    thumbUrls.push(u);
    const badge = a.querySelector(".kbadge")?.outerHTML || "";
    a.innerHTML = `<img src="${u}" alt="" loading="lazy">${badge}`;
  });
}

function wire(name, arg, seq) {
  const d = store.data;
  if (name === "gen") {
    document.querySelectorAll("details[data-sec]").forEach((el) => el.addEventListener("toggle", () => { ui.open[el.dataset.sec] = el.open; }));
    wireAsk();
    wireSlots();
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
    document.querySelectorAll("[data-roff]").forEach((el) => el.addEventListener("click", () => { const r = byId(el, "roff"); if (!r) return; r.on = false; saveRef(r); render(); }));
    document.querySelectorAll("[data-rpick]").forEach((el) => el.addEventListener("click", () => {
      const r = byId(el, "rpick"); if (!r) return;
      if (refsOn() >= MAX_REFS) return toast(`한 번에 ${MAX_REFS}장까지 켬. 하나를 끄고 누르기`);
      r.on = true; saveRef(r); render();
    }));
    document.querySelectorAll("[data-rname]").forEach((el) => el.addEventListener("change", () => { const r = byId(el, "rname"); if (!r) return; r.name = el.value.trim().slice(0, 40) || "그림"; saveRef(r); }));
    on("refEdit", "click", () => { ui.refEdit = !ui.refEdit; render(); });
    document.querySelectorAll("[data-rai]").forEach((el) => el.addEventListener("change", () => { const r = byId(el, "rai"); if (!r) return; r.ai = el.checked; saveRef(r); render(); }));
    on("raiAll", "click", () => { const to = aiRefs().length !== refs.length; for (const r of refs) if ((r.ai !== false) !== to) { r.ai = to; saveRef(r); } render(); });
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
      if (!confirm(`‘${r.name}’을 서랍에서 지움. 이 그림을 쓴 옛 기록의 ‘다시 뽑기’에 안 따라옴.`)) return;
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
    on("toRef", "click", async () => {
      if (!now) return;
      await toRefs(now.blob, `방금 그림 (시드 ${now.rec.seed})`);
    });
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
      if (b.dataset.pmode === "add") autoRef(b.dataset.pset, p);
    }));
    document.querySelectorAll("[data-pputtext]").forEach((el) => el.addEventListener("input", () => { ui.pputText = el.value; }));
    document.querySelectorAll("[data-pputgo]").forEach((b) => b.addEventListener("click", () => {
      const key = b.closest("[data-pput]")?.dataset.pput, p = key && presetByKey(key);
      if (!p) return;
      if (!tidy(ui.pputText)) return toast("넣을 글이 비어 있음");
      ui.pput = null;
      applyPreset({ ...p, text: ui.pputText }, b.dataset.pputgo);
      autoRef(key, p);
    }));
    document.querySelectorAll("[data-pputcancel]").forEach((b) => b.addEventListener("click", () => { ui.pput = null; render(); }));
    document.querySelectorAll("[data-pdel]").forEach((b) => b.addEventListener("click", () => {
      const p = d.presets.find((x) => x.id === b.dataset.pdel);
      if (!p || !confirm(`‘${p.name || "이름 없음"}’ 프리셋을 지움.`)) return;
      d.presets = d.presets.filter((x) => x !== p); ui.pedit = null;
      pimgDel(`own:${p.id}`).catch(() => {}).then(loadPimgs).then(render);
      store.save();
    }));
    // 프리셋 고치기·더하기
    document.querySelectorAll("[data-pedit]").forEach((b) => b.addEventListener("click", () => { ui.pedit = b.dataset.pedit; ui.pput = null; ui.open.preset = true; render(); }));
    document.querySelectorAll("[data-pdone]").forEach((b) => b.addEventListener("click", () => { ui.pedit = null; render(); }));
    document.querySelectorAll("[data-padd]").forEach((b) => b.addEventListener("click", () => {
      const kind = ui.presetKind;
      const p = { id: crypto.randomUUID(), name: "새 프리셋", text: "", to: KIND_TO[kind] || "scene", kind };
      if (kind === "인물") p.at = "front";
      if (p.to === "scene") p.slot = defaultSlot(kind);
      d.presets.unshift(p); ui.pedit = `own:${p.id}`; ui.open.preset = true;
      store.save();
    }));
    document.querySelectorAll("[data-pf]").forEach((el) => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      const key = el.closest("[data-pform]")?.dataset.pform, f = el.dataset.pf;
      if (!key) return;
      if (key.startsWith("own:")) {
        const p = d.presets.find((x) => x.id === key.slice(4));
        if (!p) return;
        if (f === "to") { if (TARGET[el.value]) { p.to = el.value; if (p.to !== "scene") { delete p.at; delete p.slot; } else if (!p.slot) p.slot = "rest"; } }
        else if (f === "slot") { if (SLOT_KEYS.includes(el.value)) p.slot = el.value; }
        else p[f] = el.value;
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
    // 프리셋 그림
    const pimgFail = (err) => toast(`그림을 못 넣음 (${err?.message || err}). 다른 파일로 시도`);
    document.querySelectorAll("[data-pimg]").forEach((b) => b.addEventListener("click", () => { ui.pimgOpen = ui.pimgOpen === b.dataset.pimg ? null : b.dataset.pimg; ui.open.preset = true; render(); }));
    document.querySelectorAll("[data-pimgfile]").forEach((b) => b.addEventListener("click", () => { ui.pimgTarget = b.dataset.pimgfile; $("pimgFile")?.click(); }));
    on("pimgFile", "change", async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f || !ui.pimgTarget) return;
      try { await setPimg(ui.pimgTarget, f); toast("대표 그림을 넣음"); } catch (err) { pimgFail(err); }
      render();
    });
    document.querySelectorAll("[data-pimgnow]").forEach((b) => b.addEventListener("click", async () => {
      if (!now) return;
      try { await setPimg(b.dataset.pimgnow, now.blob); toast("방금 그림을 대표 그림으로"); } catch (err) { pimgFail(err); }
      render();
    }));
    document.querySelectorAll("[data-pimgpick]").forEach((b) => b.addEventListener("click", async () => {
      const row = await imgGet(b.dataset.wid).catch(() => null);
      if (!row) return toast("그 그림 파일이 이 기기에 없음");
      try { await setPimg(b.dataset.pimgpick, row.full); toast("이 작품을 대표 그림으로"); } catch (err) { pimgFail(err); }
      render();
    }));
    document.querySelectorAll("[data-pimgref]").forEach((b) => b.addEventListener("click", async () => {
      const blob = await pimgBlob(b.dataset.pimgref), p = presetByKey(b.dataset.pimgref);
      if (blob) await toRefs(blob, `프리셋 ${p?.name || ""}`.trim().slice(0, 36));
    }));
    document.querySelectorAll("[data-pimgi2i]").forEach((b) => b.addEventListener("click", async () => {
      const blob = await pimgBlob(b.dataset.pimgi2i), p = presetByKey(b.dataset.pimgi2i);
      if (!blob) return;
      try { await setSrc(blob, `프리셋 ${p?.name || ""}`.trim()); ui.open.i2i = true; toast("이미지→이미지 바탕 그림으로 넣음"); } catch (err) { pimgFail(err); }
      render();
    }));
    document.querySelectorAll("[data-pimgdel]").forEach((b) => b.addEventListener("click", async () => {
      const key = b.dataset.pimgdel, row = await pimgGet(key).catch(() => null);
      await pimgDel(key).catch(() => {}); await loadPimgs();
      toast("대표 그림을 뺌", row ? async () => { await pimgPut(row).catch(() => {}); await loadPimgs(); render(); } : null);
      render();
    }));
    document.querySelectorAll("[data-pimgauto]").forEach((el) => el.addEventListener("change", async () => {
      const row = await pimgGet(el.dataset.pimgauto).catch(() => null);
      if (!row) return;
      row.ref = el.checked;
      await pimgPut(row).catch(() => toast("설정을 저장하지 못함"));
      await loadPimgs();
    }));
    fillThumbs(seq);
  }
  if (name === "ai") { wireAsk(); wirePersona(); wireDict(); on("aiModelQ", "change", (e) => { d.settings.aiModel = e.target.value; store.save(); }); }
  if (name === "vault") wireVault(arg);
  if (name === "keep" || name === "taste") {
    on("inAdd", "click", () => $("inFile").click());
    on("inFile", "change", (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) importImages(f); });
  }
  if (name === "keep" && !arg) {
    fillThumbs(seq);
    // 여러 장 고르기: ‘고르기’ 버튼이나 그림을 길게 눌러 들어간다. 고르는 동안 누르면 열리지 않고 표시만 바뀐다(썸네일을 다시 안 그리게 화면은 그대로 두고 표시만 고침).
    const cells = [...document.querySelectorAll(".kgrid a[data-thumb]")];
    const sync = () => {
      const n = ui.ksel?.size || 0;
      cells.forEach((a) => a.classList.toggle("sel", !!ui.ksel?.has(a.dataset.thumb)));
      if ($("kselN")) $("kselN").textContent = `${n}장 고름`;
      if ($("kAll")) $("kAll").textContent = n === cells.length ? "전부 풀기" : "전부";
    };
    on("kOn", "click", () => { ui.ksel = new Set(); render(); });
    on("kOff", "click", () => { ui.ksel = null; render(); });
    on("kAll", "click", () => { ui.ksel = ui.ksel.size === cells.length ? new Set() : new Set(cells.map((a) => a.dataset.thumb)); sync(); });
    document.querySelectorAll("[data-kday]").forEach((b) => b.addEventListener("click", () => {
      const ids = [...document.querySelectorAll(`[data-kg="${b.dataset.kday}"] a[data-thumb]`)].map((a) => a.dataset.thumb);
      const all = ids.every((id) => ui.ksel.has(id));
      ids.forEach((id) => (all ? ui.ksel.delete(id) : ui.ksel.add(id)));
      sync();
    }));
    cells.forEach((a) => {
      a.addEventListener("click", (e) => { if (!ui.ksel) return; e.preventDefault(); const id = a.dataset.thumb; if (!ui.ksel.delete(id)) ui.ksel.add(id); sync(); });
      a.addEventListener("contextmenu", (e) => { e.preventDefault(); if (ui.ksel) return; ui.ksel = new Set([a.dataset.thumb]); render(); });
    });
    on("kSave", "click", () => { const ids = [...ui.ksel]; if (!ids.length) return toast("고른 그림이 없음"); saveKeptMany(ids); });
    on("kDel", "click", () => { const ids = [...ui.ksel]; if (!ids.length) return toast("고른 그림이 없음"); if (confirm(`고른 ${ids.length}장을 보관함에서 지움.`)) removeKeptMany(ids); });
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
      d.draft.slots = rec.slots ? normSlots(rec.slots) : normSlots(null, rec.scene); syncScene();
      d.draft.seed = Number.isInteger(rec.seed) ? rec.seed : null; d.draft.seedLock = Number.isInteger(rec.seed);
      // 이번 빼는 것: 새 기록은 nd, 옛 기록은 그때 빼는 것에서 지금 기본 빼는 것을 뺀 나머지
      d.draft.neg = typeof rec.nd === "string" ? rec.nd : tagsMinus(rec.negative || "", d.taste.negative);
      d.draft.chars = (rec.chars || []).map((c) => ({ id: crypto.randomUUID(), text: c.text, neg: c.neg || "", pos: Number.isInteger(c.pos) ? c.pos : null }));
      if (SAMPLERS[rec.sampler]) d.settings.sampler = rec.sampler;
      if (rec.noise) d.settings.noise = rec.noise;
      d.settings.cfgRescale = rec.cr ?? 0; d.settings.variety = !!rec.vb;
      d.settings.steps = rec.steps; d.settings.scale = rec.scale;
      if (rec.refs?.length) {
        const want = rec.refs.filter((x) => x.id);
        let hit = 0;
        for (const r of refs) {
          const w = want.find((x) => x.id === r.id);
          if (!w && !r.on) continue;
          r.on = !!w;
          if (w) { r.strength = clamp(w.s, 0, 1, 0.6); r.info = clamp(w.i, 0, 1, 1); hit++; }
          refPut(rowOf(r)).catch(() => {});
        }
        if (hit && (rec.mode === "vibe" || rec.mode === "precise")) d.settings.refMode = rec.mode;
        if (hit) ui.open.ref = true;
        const miss = rec.refs.length - hit;
        toast(hit ? `그때 쓴 참고 그림 ${hit}장을 서랍에서 다시 켬${miss ? ` · ${miss}장은 서랍에 없음` : ""}` : `그때 쓴 참고 그림 ${miss}장은 서랍에 없어서 못 켬`);
      }
      store.persist();
      location.hash = "#/gen";
    });
    on("share", "click", () => blob && shareImage(blob, rec));
    const label = `보관함 그림 (시드 ${rec?.seed ?? "모름"})`;
    on("keepI2i", "click", async () => {
      if (!blob) return toast("그림을 아직 못 읽음");
      try { await setSrc(blob, label); ui.open.i2i = true; toast("이미지→이미지 바탕 그림으로 넣음"); location.hash = "#/gen"; }
      catch (err) { toast(`바탕 그림으로 못 넣음 (${err?.message || err})`); }
    });
    on("keepRef", "click", async () => {
      if (!blob) return toast("그림을 아직 못 읽음");
      if (await toRefs(blob, label)) location.hash = "#/gen";
    });
    on("del", "click", () => { if (confirm("이 그림을 지움. 되돌릴 수 없음.")) removeKept(arg); });
    document.querySelectorAll("[data-kcopy]").forEach((b) => b.addEventListener("click", async () => {
      const v = String(rec?.[b.dataset.kcopy] || ""); if (!v) return;
      try { await navigator.clipboard.writeText(v); b.textContent = "복사함"; } catch { b.textContent = "복사 못 함"; }
    }));
  }
  if (name === "taste") {
    if (arg === "conn") { // 다른 화면의 ‘토큰·키 없음’ 안내에서 왔을 때: 연결 칸을 펴고 그리로
      const c = document.querySelector('details[data-sec="conn"]');
      if (c) { c.open = true; ui.open.conn = true; c.scrollIntoView({ block: "start" }); }
    }
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
      a.download = "jjalbbopgi.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    on("jsonIn", "click", () => $("jsonFile").click());
    on("jsonFile", "change", async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importJson(await f.text()); });
    on("pasteGo", "click", () => pasteToPiece($("pasteIn")?.value));
    on("reset", "click", async () => {
      if (!confirm("화풍·작가, 빼는 것, 기록, 보관한 그림, 참고 그림, 프리셋 그림, 보관소, 대화, 토큰과 키를 전부 지움. 되돌릴 수 없음.")) return;
      await imgClear().catch(() => {});
      await refClear().catch(() => {});
      await srcClear().catch(() => {});
      await pimgClear().catch(() => {});
      await vaultClear().catch(() => {}); await loadVault();
      await loadPimgs();
      if (src) { URL.revokeObjectURL(src.url); src = null; }
      refs.forEach((r) => URL.revokeObjectURL(r.url));
      refs = [];
      histClear(); clearAttach();
      store.data = SHAPE();
      store.save();
    });
  }
}

// 탭을 바꾸면 그 탭 맨 위에서 시작한다(전에는 앞 탭의 스크롤 위치가 남아 비서 탭이 대화 중간에서 열렸다). 비서 탭만 마지막 대화로 간다.
addEventListener("hashchange", () => { errMsg = ""; askErr = ""; ui.bq = ""; ui.vShow = 40; ui.vOpen = new Set(); if (route()[0] === "ai") scrollAi = true; else scrollTo({ top: 0 }); if (route()[0] !== "keep") ui.ksel = null; render(); });
if (route()[0] === "ai") scrollAi = true;
render();
loadRefs().then(render); loadSrc().then(render); loadPimgs().then(render); loadVault().then(render);
// 참고 그림은 IndexedDB에서 읽어 와야 해서 한 박자 늦게 그린다

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
