// 이미지창고 — 폰에 그림을 모아 두고 태그로 나눠 찾는다.
// 그림 원본과 썸네일은 IndexedDB(이 기기·이 브라우저에만), 화면 설정은 localStorage.
// 화면: 창고(#/list) · 넣기(#/add) · 태그(#/tags) · 설정(#/settings) · 한 장(#/img/<id>)

import { naiInfo } from "../해체기/risu.js"; // NovelAI PNG 안의 프롬프트 읽기. 짤뽑기와 같은 코드. 해체기 폴더를 옮기면 이 줄도 고친다.

const DB_NAME = "이미지창고";
const UI_KEY = "이미지창고/v1/ui";
const THUMB = 360; // 썸네일 긴 변(px)

// ── 데이터 모양 ──────────────────────────────────────────────
// meta: { id, hash, name, type, size, w, h, tags: [], memo, at, nai? }
//   nai(NovelAI PNG만, 옛 항목엔 없음): { prompt, uc, chars: [{ text, neg }], params: { seed, steps, … }, model }
// blob: { id, full: Blob, thumb: Blob }
const SHAPE_UI = () => ({ cols: 3, sort: "new", tagSort: "count", naiTags: true });

// ── IndexedDB ───────────────────────────────────────────────
let dbp;
function db() {
  return dbp ??= new Promise((ok, no) => {
    const q = indexedDB.open(DB_NAME, 1);
    q.onupgradeneeded = () => {
      const d = q.result;
      d.createObjectStore("meta", { keyPath: "id" }).createIndex("hash", "hash");
      d.createObjectStore("blob", { keyPath: "id" });
    };
    q.onsuccess = () => ok(q.result);
    q.onerror = () => no(q.error);
  });
}
const done = (t) => new Promise((ok, no) => { t.oncomplete = ok; t.onerror = t.onabort = () => no(t.error); });
const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

async function allMeta() { return req((await db()).transaction("meta").objectStore("meta").getAll()); }
async function getBlob(id) { return req((await db()).transaction("blob").objectStore("blob").get(id)); }
async function putMany(metas) { // 태그·메모만 바뀐 것
  const t = (await db()).transaction("meta", "readwrite");
  metas.forEach((m) => t.objectStore("meta").put(m));
  return done(t);
}
async function putNew(meta, blobRec) {
  const t = (await db()).transaction(["meta", "blob"], "readwrite");
  t.objectStore("meta").put(meta);
  t.objectStore("blob").put(blobRec);
  return done(t);
}
async function delMany(ids) {
  const t = (await db()).transaction(["meta", "blob"], "readwrite");
  ids.forEach((id) => { t.objectStore("meta").delete(id); t.objectStore("blob").delete(id); });
  return done(t);
}

// ── 메모리 상태 ─────────────────────────────────────────────
const S = {
  metas: [],                       // 새 것이 앞
  ui: loadUI(),
  inc: new Set(), exc: new Set(),  // 고른 태그 / 뺀 태그
  untagged: false,
  q: "",
  select: false, picked: new Set(),
  pending: [],                     // 넣기 화면에 고른 파일
  busy: false,
};
function loadUI() {
  try { return { ...SHAPE_UI(), ...JSON.parse(localStorage.getItem(UI_KEY) || "{}") }; }
  catch { return SHAPE_UI(); }
}
function saveUI() { try { localStorage.setItem(UI_KEY, JSON.stringify(S.ui)); } catch {} }

const byId = (id) => S.metas.find((m) => m.id === id);
function tagCounts() {
  const c = new Map();
  for (const m of S.metas) for (const t of m.tags) c.set(t, (c.get(t) || 0) + 1);
  return c;
}
function sortedTags(c = tagCounts(), how = "count") {
  return [...c.entries()].sort((a, b) => how === "name"
    ? a[0].localeCompare(b[0], "ko") : b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
}
// 태그 다듬기: 앞뒤 공백·# 떼고, 가운데 공백은 하나로, 영문은 소문자.
const normTag = (s) => String(s).replace(/^#+/, "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 60);
const splitTags = (s) => [...new Set(String(s).split(/[,，\n]/).map(normTag).filter(Boolean))];

function filtered() {
  const q = S.q.trim().toLowerCase();
  let out = S.metas.filter((m) => {
    if (S.untagged && m.tags.length) return false;
    for (const t of S.inc) if (!m.tags.includes(t)) return false;
    for (const t of S.exc) if (m.tags.includes(t)) return false;
    if (q && !(m.tags.some((t) => t.includes(q)) || m.name.toLowerCase().includes(q) || (m.memo || "").toLowerCase().includes(q))) return false;
    return true;
  });
  if (S.ui.sort === "old") out = out.slice().reverse();
  return out;
}

// ── 썸네일·주소 ─────────────────────────────────────────────
const urlCache = new Map(); // `${id}:thumb|full` → objectURL
async function blobURL(id, kind = "thumb") {
  const k = `${id}:${kind}`;
  if (urlCache.has(k)) return urlCache.get(k);
  const rec = await getBlob(id);
  if (!rec) return "";
  const u = URL.createObjectURL(rec[kind] || rec.full);
  urlCache.set(k, u);
  return u;
}
function forget(id) {
  for (const kind of ["thumb", "full"]) {
    const k = `${id}:${kind}`;
    if (urlCache.has(k)) { URL.revokeObjectURL(urlCache.get(k)); urlCache.delete(k); }
  }
}
async function makeThumb(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch { return { thumb: null, w: 0, h: 0 }; } // 브라우저가 못 여는 형식(HEIC 등)
  const { width: w, height: h } = bmp;
  const r = Math.min(1, THUMB / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * r)); c.height = Math.max(1, Math.round(h * r));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  let thumb = await new Promise((ok) => c.toBlob(ok, "image/webp", 0.8));
  if (!thumb || thumb.type !== "image/webp") thumb = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.82));
  return { thumb, w, h };
}
async function sha(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── NovelAI 프롬프트 → 태그 ──────────────────────────────────
// 늘 붙는 품질 태그와 인원수 태그는 태그 목록만 어지럽혀서 뺀다.
const SKIP_TAGS = new Set([
  "masterpiece", "best quality", "amazing quality", "great quality", "good quality", "normal quality", "high quality",
  "very aesthetic", "aesthetic", "highres", "absurdres", "incredibly absurdres", "ultra detailed", "detailed",
  "no text", "location", "very awa", "girl", "boy", "other", "year 2024", "year 2025", "year 2026", "solo", "multiple girls", "multiple boys",
]);
function promptTags(prompt) {
  return [...new Set(String(prompt || "")
    .replace(/-?\d*\.?\d+::/g, ",")      // V4 가중치 1.2::태그::
    .replace(/::/g, ",")
    .replace(/[{}\[\]()]/g, "")
    .split(/[,|\n]/)
    .map((t) => normTag(t.replace(/_/g, " ").replace(/:\s*\d*\.?\d+\s*$/, "")))
    .filter((t) => t && t.length <= 40 && !SKIP_TAGS.has(t) && !/^\d+\+?(girl|boy|other)s?$/.test(t)))].slice(0, 60);
}
function readNai(buf) {
  try {
    const n = naiInfo(new Uint8Array(buf));
    if (!n) return null;
    return { prompt: n.prompt, uc: n.uc, chars: n.chars || [], params: n.params || {}, model: n.model || "" };
  } catch { return null; }
}
// NovelAI 그림에 붙일 태그 전부: 바탕 프롬프트 + 인물별 프롬프트 + "novelai"
const naiTagsOf = (nai) => nai ? ["novelai", ...promptTags([nai.prompt, ...(nai.chars || []).map((c) => c.text)].join(","))] : [];

// 새 그림 한 장 넣기. 같은 그림(해시)이 있으면 태그만 더하고 false.
// opt.naiTags: NovelAI PNG면 프롬프트를 태그로 더할지 (기본은 설정값)
async function addImage(blob, name, tags = [], extra = {}, opt = {}) {
  const buf = await blob.arrayBuffer();
  const hash = await sha(buf);
  const nai = extra.nai || readNai(buf);
  if (nai) { addImage.nai = (addImage.nai || 0) + 1; if (opt.naiTags ?? S.ui.naiTags) tags = [...tags, ...naiTagsOf(nai)]; }
  const same = S.metas.find((m) => m.hash === hash);
  if (same) {
    const before = same.tags.length;
    same.tags = [...new Set([...same.tags, ...tags])];
    if (same.tags.length !== before || (nai && !same.nai)) { if (nai && !same.nai) same.nai = nai; await putMany([same]); }
    return false;
  }
  const { thumb, w, h } = await makeThumb(blob);
  const meta = {
    id: extra.id || crypto.randomUUID(), hash, name: name || "이름 없음",
    type: blob.type || guessType(name), size: blob.size, w, h,
    tags: [...new Set(tags)], memo: extra.memo || "", at: extra.at || Date.now(),
  };
  if (nai) meta.nai = nai;
  await putNew(meta, { id: meta.id, full: blob, thumb });
  S.metas.push(meta);
  S.metas.sort((a, b) => b.at - a.at);
  return true;
}
function guessType(name = "") {
  const e = name.split(".").pop().toLowerCase();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", heic: "image/heic" }[e] || "application/octet-stream";
}
const extOf = (type, name = "") => {
  const m = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif",
    "image/bmp": "bmp", "image/svg+xml": "svg", "image/heic": "heic" }[type];
  return m || (name.includes(".") ? name.split(".").pop().toLowerCase() : "bin");
};

// ── ZIP (압축 없이 쓰기, 읽기는 무압축·deflate) ───────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(u8) { let c = ~0; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }
function dosTime(ts) {
  const d = new Date(ts);
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
async function makeZip(files, onStep) { // files: [{ name, blob, at }]
  const enc = new TextEncoder(); const parts = []; const central = []; let off = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const nm = enc.encode(f.name);
    const crc = crc32(new Uint8Array(await f.blob.arrayBuffer()));
    const sz = f.blob.size; const { time, date } = dosTime(f.at || Date.now());
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, nm.length, true);
    parts.push(h.buffer, nm, f.blob);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, nm.length, true);
    c.setUint32(42, off, true);
    central.push(c.buffer, nm);
    off += 30 + nm.length + sz;
    onStep?.(i + 1, files.length);
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e.buffer], { type: "application/zip" });
}
async function readZip(file) { // → [{ name, blob() }]
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let p = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error("ZIP 파일이 아님");
  const n = tail.getUint16(p + 10, true), cdSize = tail.getUint32(p + 12, true), cdOff = tail.getUint32(p + 16, true);
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder(); const out = []; let q = 0;
  for (let i = 0; i < n; i++) {
    if (cd.getUint32(q, true) !== 0x02014b50) break;
    const method = cd.getUint16(q + 10, true), csz = cd.getUint32(q + 20, true);
    const nl = cd.getUint16(q + 28, true), xl = cd.getUint16(q + 30, true), cl = cd.getUint16(q + 32, true);
    const lho = cd.getUint32(q + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + q + 46, nl));
    q += 46 + nl + xl + cl;
    if (name.endsWith("/")) continue;
    out.push({ name, method, blob: async () => {
      const lh = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
      const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const raw = file.slice(start, start + csz);
      if (method === 0) return raw;
      if (method === 8) return new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
      throw new Error(`못 푸는 압축 방식(${method}): ${name}`);
    } });
  }
  return out;
}

// ── 작은 도구 ───────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove("on"), 2200);
}
function size(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
const day = (ts) => new Date(ts).toLocaleString("ko-KR", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

// 태그 넣는 칸: 입력 + 이미 있는 태그 추천. onPick(tag)로 하나씩 넘긴다.
function tagInputHTML(id, ph = "태그 (쉼표로 여러 개)") {
  return `<div class="tagin"><div class="search">
    <input id="${id}" type="text" autocomplete="off" autocapitalize="off" enterkeyhint="done" placeholder="${ph}">
    <button type="button" id="${id}Go">붙이기</button></div>
    <div class="sugg" id="${id}Sugg"></div></div>`;
}
function wireTagInput(id, onPick, exclude = () => []) {
  const inp = $("#" + id), sug = $(`#${id}Sugg`);
  const counts = tagCounts();
  const show = () => {
    const parts = inp.value.split(/[,，]/); const cur = normTag(parts[parts.length - 1]);
    const ex = new Set(exclude());
    const list = sortedTags(counts).filter(([t]) => !ex.has(t) && (!cur || t.includes(cur))).slice(0, 12);
    sug.innerHTML = list.map(([t, n]) => `<button type="button" class="chip" data-t="${esc(t)}">${esc(t)} <small>${n}</small></button>`).join("");
  };
  const commit = () => { const ts = splitTags(inp.value); inp.value = ""; if (ts.length) onPick(ts); show(); };
  inp.addEventListener("input", show);
  inp.addEventListener("focus", show);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); commit(); } });
  $(`#${id}Go`).addEventListener("click", commit);
  sug.addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]"); if (!b) return;
    const parts = inp.value.split(/[,，]/); parts.pop();
    inp.value = parts.join(",");
    onPick([...splitTags(inp.value), b.dataset.t]); inp.value = ""; show();
  });
  show();
  return { refresh: show };
}

// ── 화면 ────────────────────────────────────────────────────
// 한 장 화면의 NovelAI 칸. 칸마다 복사.
function naiBox(m) {
  const n = m.nai, p = n.params || {};
  const rows = [["프롬프트", n.prompt], ...(n.chars || []).map((c, i) => [`인물 ${i + 1}`, c.text]), ["빼는 것", n.uc]].filter(([, v]) => v && v.trim());
  const vals = [["시드", p.seed], ["스텝", p.steps], ["강도", p.scale], ["샘플러", p.sampler], ["크기", p.width && `${p.width}×${p.height}`], ["모델", n.model]].filter(([, v]) => v !== undefined && v !== "" && v !== null);
  return `<details class="nai"><summary>NovelAI 생성 정보</summary>
    ${rows.map(([k, v], i) => `<div class="naiRow"><div class="status" style="margin:0"><b class="grow">${k}</b>
      <button type="button" class="ghost" data-copy="${i}">복사</button></div><p class="naiText">${esc(v)}</p></div>`).join("")}
    ${vals.length ? `<p class="info">${vals.map(([k, v]) => `${k} ${esc(v)}`).join(" · ")}</p>` : ""}
    <button type="button" class="ghost" id="naiAdd">프롬프트를 태그로 붙이기</button>
  </details>`;
}
const naiCopyText = (m, i) => {
  const n = m.nai;
  return [n.prompt, ...(n.chars || []).map((c) => c.text), n.uc].filter((v) => v && v.trim())[i] || "";
};

const SCREENS = {
  list() {
    return `
      <div class="search">
        <input id="q" type="search" autocomplete="off" placeholder="태그·이름·메모 찾기" value="${esc(S.q)}">
        <button type="button" class="ghost" id="selBtn">${S.select ? "그만" : "고르기"}</button>
      </div>
      <div class="chips" id="chips"></div>
      <div id="selbar"></div>
      <div class="status" id="status"></div>
      <div class="grid" id="grid" style="--cols:${S.ui.cols}"></div>`;
  },

  add() {
    const n = S.pending.length;
    return `
      <div class="stack">
        <label class="drop" for="files">
          <b>${n ? `${n}장 고름` : "그림 고르기"}</b>
          <span>${n ? `${size(S.pending.reduce((s, f) => s + f.size, 0))} · 다시 누르면 더 고름` : "갤러리에서 여러 장 한꺼번에"}</span>
          <input id="files" type="file" accept="image/*" multiple>
        </label>
        ${n ? `<div class="thumbs" id="pthumbs"></div>` : ""}
        <h2>같이 붙일 태그</h2>
        ${tagInputHTML("addTag")}
        <div class="chips wrap" id="addChips"></div>
        <label class="check2"><input type="checkbox" id="naiTags" ${S.ui.naiTags ? "checked" : ""}>
          NovelAI 그림이면 프롬프트를 태그로 붙이기</label>
        <div class="bar2" id="prog" hidden><i></i></div>
        <button type="button" id="save" ${n && !S.busy ? "" : "disabled"}>${n ? `${n}장 넣기` : "넣기"}</button>
        ${n ? `<button type="button" class="ghost" id="clear">고른 것 비우기</button>` : ""}
        <p class="hint">같은 그림이 이미 있으면 새로 넣지 않고 태그만 더함. 원본 그대로 이 기기에 보관.</p>
      </div>`;
  },

  tags() {
    const list = sortedTags(tagCounts(), S.ui.tagSort);
    const untagged = S.metas.filter((m) => !m.tags.length).length;
    return `
      <div class="seg" style="margin-bottom:10px">
        <button type="button" class="${S.ui.tagSort === "count" ? "" : "ghost"}" data-sort="count">많은 순</button>
        <button type="button" class="${S.ui.tagSort === "name" ? "" : "ghost"}" data-sort="name">가나다순</button>
      </div>
      <input id="tq" type="search" autocomplete="off" placeholder="태그 찾기" style="margin-bottom:10px">
      ${untagged ? `<p class="hint" style="margin-bottom:8px"><a href="#/list" data-untagged="1">태그 없는 그림 ${untagged}장 보기</a></p>` : ""}
      ${list.length ? `<ul class="tags" id="tagList">${list.map(([t, n]) => `
        <li data-t="${esc(t)}"><a href="#/list" data-go="${esc(t)}">${esc(t)}</a><small>${n}</small>
          <button type="button" class="ghost" data-act="rename">이름</button>
          <button type="button" class="ghost" data-act="del" style="color:var(--danger)">지움</button></li>`).join("")}</ul>`
        : `<p class="empty">아직 태그 없음.<br>그림을 넣을 때나 한 장 화면에서 붙임.</p>`}
      <p class="hint" style="margin-top:12px">이름을 이미 있는 태그로 바꾸면 둘이 합쳐짐.</p>`;
  },

  settings() {
    const total = S.metas.reduce((s, m) => s + m.size, 0);
    return `
      <div class="stack">
        <h2>보기</h2>
        <p class="hint">한 줄에 몇 장</p>
        <div class="seg">${[2, 3, 4, 5].map((c) => `<button type="button" class="${S.ui.cols === c ? "" : "ghost"}" data-cols="${c}">${c}</button>`).join("")}</div>
        <p class="hint">순서</p>
        <div class="seg">
          <button type="button" class="${S.ui.sort === "new" ? "" : "ghost"}" data-sortimg="new">새 것부터</button>
          <button type="button" class="${S.ui.sort === "old" ? "" : "ghost"}" data-sortimg="old">옛 것부터</button>
        </div>
        <h2 style="margin-top:10px">저장 공간</h2>
        <p class="hint">그림 ${S.metas.length}장 · 원본 ${size(total)}. 이 기기 이 브라우저에만 있음.</p>
        <p class="hint" id="quota">남은 공간 확인 중…</p>
        <button type="button" class="ghost" id="persist">브라우저가 지우지 않게 요청</button>
        <h2 style="margin-top:10px">백업</h2>
        <p class="hint">ZIP 하나에 원본 그림과 태그·메모(meta.json)를 담음. 다른 폰에서 ‘ZIP 넣기’로 그대로 되살림.</p>
        <div class="bar2" id="prog" hidden><i></i></div>
        <button type="button" id="backup" ${S.metas.length ? "" : "disabled"}>전부 ZIP으로 내려받기</button>
        <label class="drop" for="zip" style="padding:18px 16px"><b>ZIP 넣기</b>
          <span>백업 ZIP이면 태그까지 되살림, 그냥 그림 ZIP이면 그림만 넣음</span>
          <input id="zip" type="file" accept=".zip,application/zip"></label>
        <h2 style="margin-top:10px">NovelAI 그림</h2>
        <p class="hint">PNG 안에 남은 프롬프트를 읽음. 이 기능 전에 넣은 그림은 여기서 한 번 읽어야 함.</p>
        <button type="button" class="ghost" id="naiScan" ${S.metas.length ? "" : "disabled"}>넣어 둔 그림에서 프롬프트 읽기</button>
        <button type="button" class="ghost" id="tagsJson" ${S.metas.length ? "" : "disabled"}>태그 목록만 내려받기 (JSON)</button>
        <h2 style="margin-top:10px">지우기</h2>
        <button type="button" class="danger" id="reset" ${S.metas.length ? "" : "disabled"}>그림 전부 지우기</button>
      </div>`;
  },

  img(id) {
    const m = byId(id);
    if (!m) return `<p class="empty">없는 그림.<br><a href="#/list">창고로</a></p>`;
    return `
      <div class="viewer"><img id="full" alt="${esc(m.name)}"></div>
      <div class="nav2">
        <button type="button" class="ghost" id="prev">‹ 이전</button>
        <button type="button" class="ghost" id="next">다음 ›</button>
      </div>
      <div class="stack">
        <div class="chips wrap" id="myTags"></div>
        ${tagInputHTML("imgTag", "태그 더하기")}
        <label for="memo" class="hint">메모</label>
        <textarea id="memo" placeholder="출처, 쓸 곳 등">${esc(m.memo || "")}</textarea>
        ${m.nai ? naiBox(m) : ""}
        <p class="info">${esc(m.name)}<br>${m.w ? `${m.w}×${m.h} · ` : ""}${size(m.size)} · ${day(m.at)}</p>
        <button type="button" class="ghost" id="dl">원본 내려받기</button>
        <button type="button" class="danger" id="del">이 그림 지우기</button>
      </div>`;
  },
};

// ── 창고 화면 조각 ───────────────────────────────────────────
function drawChips() {
  const box = $("#chips"); if (!box) return;
  const counts = tagCounts();
  const q = normTag(S.q);
  const chosen = [...S.inc, ...S.exc];
  const rest = sortedTags(counts).filter(([t]) => !S.inc.has(t) && !S.exc.has(t) && (!q || t.includes(q))).slice(0, 40);
  const untaggedN = S.metas.filter((m) => !m.tags.length).length;
  box.innerHTML = [
    ...chosen.map((t) => `<button type="button" class="chip ${S.inc.has(t) ? "inc" : "exc"}" data-t="${esc(t)}">${esc(t)} <span class="x">✕</span></button>`),
    untaggedN ? `<button type="button" class="chip ${S.untagged ? "inc" : ""}" data-untagged="1">태그 없음 <small>${untaggedN}</small></button>` : "",
    ...rest.map(([t, n]) => `<button type="button" class="chip" data-t="${esc(t)}">${esc(t)} <small>${n}</small></button>`),
  ].join("");
}
function drawStatus(list) {
  const st = $("#status"); if (!st) return;
  if (!S.metas.length) { st.innerHTML = ""; return; }
  const filt = S.inc.size || S.exc.size || S.untagged || S.q.trim();
  st.innerHTML = `<span class="grow">${filt ? `${list.length}장 / 전체 ${S.metas.length}장` : `${S.metas.length}장`}
    ${S.inc.size || S.exc.size ? " · 태그를 다시 누르면 빼기, 한 번 더 누르면 풀림" : ""}</span>
    ${filt ? `<button type="button" class="ghost" id="clearF">풀기</button>` : ""}`;
}
function drawSelbar(list) {
  const bar = $("#selbar"); if (!bar) return;
  if (!S.select) { bar.innerHTML = ""; return; }
  bar.innerHTML = `<div class="selbar">
    <div class="status" style="margin:0"><span class="grow"><b>${S.picked.size}장</b> 고름</span>
      <button type="button" class="ghost" id="pickAll">${S.picked.size && list.every((m) => S.picked.has(m.id)) ? "전부 풀기" : "보이는 것 전부"}</button></div>
    <input id="bulkTag" type="text" autocomplete="off" autocapitalize="off" enterkeyhint="done" placeholder="태그 (쉼표로 여러 개)">
    <div class="sugg" id="bulkSugg"></div>
    <div class="btns">
      <button type="button" id="bulkAdd" ${S.picked.size ? "" : "disabled"}>붙이기</button>
      <button type="button" class="ghost" id="bulkRm" ${S.picked.size ? "" : "disabled"}>떼기</button>
      <button type="button" class="danger" id="bulkDel" ${S.picked.size ? "" : "disabled"}>지우기</button>
    </div></div>`;
  const inp = $("#bulkTag"), sug = $("#bulkSugg");
  const showSugg = () => {
    const cur = normTag(inp.value.split(/[,，]/).pop());
    const picked = S.metas.filter((m) => S.picked.has(m.id));
    const onPicked = new Map(); picked.forEach((m) => m.tags.forEach((t) => onPicked.set(t, (onPicked.get(t) || 0) + 1)));
    // 비어 있으면 고른 그림에 붙은 태그를 먼저(떼기 편하게), 쓰는 중이면 전체에서 찾기
    const src = cur ? sortedTags().filter(([t]) => t.includes(cur)) : sortedTags(onPicked);
    sug.innerHTML = src.slice(0, 12).map(([t, n]) => `<button type="button" class="chip" data-t="${esc(t)}">${esc(t)} <small>${n}</small></button>`).join("");
  };
  inp.addEventListener("input", showSugg);
  sug.addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]"); if (!b) return;
    const parts = inp.value.split(/[,，]/); parts.pop(); parts.push(b.dataset.t);
    inp.value = parts.filter((s) => s.trim()).join(", ") + ", "; inp.focus(); showSugg();
  });
  const bulk = async (fn, msg) => {
    const ts = splitTags(inp.value);
    if (!ts.length) { toast("태그를 먼저 적음"); inp.focus(); return; }
    const ch = [];
    for (const m of S.metas) if (S.picked.has(m.id)) { const before = m.tags.join("\n"); m.tags = fn(m.tags, ts); if (m.tags.join("\n") !== before) ch.push(m); }
    await putMany(ch);
    toast(`${ch.length}장${msg}`); inp.value = ""; drawList();
  };
  $("#bulkAdd").onclick = () => bulk((a, ts) => [...new Set([...a, ...ts])], "에 붙임");
  $("#bulkRm").onclick = () => bulk((a, ts) => a.filter((t) => !ts.includes(t)), "에서 뗌");
  $("#bulkDel").onclick = async () => {
    if (!confirm(`${S.picked.size}장을 지움. 되돌릴 수 없음.`)) return;
    const ids = [...S.picked]; await delMany(ids); ids.forEach(forget);
    S.metas = S.metas.filter((m) => !S.picked.has(m.id)); S.picked.clear();
    toast(`${ids.length}장 지움`); drawList();
  };
  $("#pickAll").onclick = () => {
    if (S.picked.size && list.every((m) => S.picked.has(m.id))) S.picked.clear(); else list.forEach((m) => S.picked.add(m.id));
    drawList();
  };
  showSugg();
}
let io;
function drawGrid(list) {
  const g = $("#grid"); if (!g) return;
  if (!S.metas.length) { g.style.display = "block"; g.innerHTML = `<p class="empty">아직 그림 없음.<br>아래 ‘넣기’에서 갤러리 그림을 고름.</p>`; return; }
  if (!list.length) { g.style.display = "block"; g.innerHTML = `<p class="empty">맞는 그림 없음.</p>`; return; }
  g.style.display = "";
  g.innerHTML = list.map((m) => `<button type="button" class="cell ${S.picked.has(m.id) ? "picked" : ""}" data-id="${m.id}" aria-label="${esc(m.name)}">
    <img data-src="${m.id}" alt="" decoding="async">${m.tags.length ? "" : `<span class="n">태그 없음</span>`}</button>`).join("");
  io?.disconnect();
  io = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) {
      const img = e.target; io.unobserve(img);
      blobURL(img.dataset.src).then((u) => { if (u) img.src = u; });
    }
  }, { rootMargin: "400px" });
  g.querySelectorAll("img[data-src]").forEach((i) => io.observe(i));
}
function drawList() {
  if (route().name !== "list") return;
  const list = filtered();
  $("#selBtn").textContent = S.select ? "그만" : "고르기";
  drawChips(); drawSelbar(list); drawStatus(list); drawGrid(list);
  setCount();
}

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { list: "이미지창고", add: "넣기", tags: "태그", settings: "설정", img: "한 장" };
function route() {
  const [name, ...rest] = (location.hash.replace(/^#\/?/, "") || "list").split("/");
  return { name: SCREENS[name] ? name : "list", arg: decodeURIComponent(rest.join("/")) };
}
function setCount() {
  const { name } = route();
  $("#count").textContent = name === "list" && S.metas.length ? `${S.metas.length}장` : "";
}
let lastList = "list";
function render() {
  const { name, arg } = route();
  $("#screen").onclick = null;
  $("#screen").innerHTML = SCREENS[name](arg);
  $("#title").textContent = TITLES[name];
  $("#back").hidden = name !== "img";
  $("#back").href = "#/" + lastList;
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === (name === "img" ? "list" : name)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  setCount();
  WIRE[name]?.(arg);
}
// 화면을 바꾸면 맨 위로, 창고로 돌아오면 보던 자리로.
let listScroll = 0;
addEventListener("hashchange", (e) => {
  const from = new URL(e.oldURL).hash.replace(/^#\/?/, "").split("/")[0] || "list";
  if (from === "list") listScroll = scrollY;
  render();
  scrollTo(0, route().name === "list" ? listScroll : 0);
});

// ── 화면마다 연결 ────────────────────────────────────────────
const WIRE = {
  list() {
    drawList();
    const q = $("#q");
    q.addEventListener("input", () => { S.q = q.value; drawList(); });
    $("#selBtn").addEventListener("click", () => { S.select = !S.select; if (!S.select) S.picked.clear(); drawList(); });
    $("#screen").onclick = (e) => {
      const chip = e.target.closest("#chips [data-t]");
      if (chip) { // 없음 → 고름 → 뺌 → 없음
        const t = chip.dataset.t;
        if (S.inc.has(t)) { S.inc.delete(t); S.exc.add(t); }
        else if (S.exc.has(t)) S.exc.delete(t);
        else { S.inc.add(t); S.untagged = false; }
        drawList(); return;
      }
      if (e.target.closest("#chips [data-untagged]")) { S.untagged = !S.untagged; if (S.untagged) S.inc.clear(); drawList(); return; }
      if (e.target.closest("#clearF")) { S.inc.clear(); S.exc.clear(); S.untagged = false; S.q = ""; q.value = ""; drawList(); return; }
      const cell = e.target.closest(".cell");
      if (cell) {
        const id = cell.dataset.id;
        if (S.select) { S.picked.has(id) ? S.picked.delete(id) : S.picked.add(id); cell.classList.toggle("picked"); drawSelbar(filtered()); return; }
        lastList = "list"; location.hash = "#/img/" + id;
      }
    };
    // 길게 누르면 고르기로 들어감
    let lp;
    $("#grid").addEventListener("pointerdown", (e) => {
      const cell = e.target.closest(".cell"); if (!cell || S.select) return;
      lp = setTimeout(() => { S.select = true; S.picked.add(cell.dataset.id); lp = "fired"; drawList(); navigator.vibrate?.(20); }, 500);
    });
    const cancel = () => { if (lp !== "fired") clearTimeout(lp); };
    ["pointerup", "pointerleave", "pointercancel", "pointermove"].forEach((ev) => $("#grid").addEventListener(ev, (e) => {
      if (ev === "pointermove" && Math.abs(e.movementY) + Math.abs(e.movementX) < 3) return; cancel();
    }));
    $("#grid").addEventListener("click", (e) => { if (lp === "fired") { e.stopPropagation(); lp = null; } }, true);
    $("#grid").addEventListener("contextmenu", (e) => { if (e.target.closest(".cell")) e.preventDefault(); });
    if (listScroll) requestAnimationFrame(() => scrollTo(0, listScroll));
  },

  add() {
    const chosen = WIRE.addTags ??= new Set();
    const drawChosen = () => {
      $("#addChips").innerHTML = [...chosen].map((t) => `<button type="button" class="chip inc" data-t="${esc(t)}">${esc(t)} <span class="x">✕</span></button>`).join("");
    };
    const ti = wireTagInput("addTag", (ts) => { ts.forEach((t) => chosen.add(t)); drawChosen(); }, () => [...chosen]);
    $("#addChips").addEventListener("click", (e) => { const b = e.target.closest("[data-t]"); if (b) { chosen.delete(b.dataset.t); drawChosen(); ti.refresh(); } });
    drawChosen();
    $("#naiTags").addEventListener("change", (e) => { S.ui.naiTags = e.target.checked; saveUI(); });
    $("#files").addEventListener("change", (e) => {
      const fs = [...e.target.files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif|avif|webp)$/i.test(f.name));
      S.pending.push(...fs); render();
    });
    const pt = $("#pthumbs");
    if (pt) {
      const show = S.pending.slice(0, 15);
      pt.innerHTML = show.map(() => `<img alt="">`).join("") + (S.pending.length > 15 ? `<p class="hint" style="grid-column:1/-1">외 ${S.pending.length - 15}장</p>` : "");
      pt.querySelectorAll("img").forEach((img, i) => { const u = URL.createObjectURL(show[i]); img.src = u; img.onload = () => URL.revokeObjectURL(u); });
    }
    $("#clear")?.addEventListener("click", () => { S.pending = []; render(); });
    $("#save").addEventListener("click", async () => {
      const typed = splitTags($("#addTag").value); typed.forEach((t) => chosen.add(t));
      const tags = [...chosen];
      S.busy = true; $("#save").disabled = true;
      const prog = $("#prog"); prog.hidden = false;
      let added = 0, dup = 0, bad = 0; addImage.nai = 0;
      for (let i = 0; i < S.pending.length; i++) {
        const f = S.pending[i];
        try { (await addImage(f, f.name, tags, { at: Date.now() - i })) ? added++ : dup++; }
        catch (err) { console.warn("못 넣음", f.name, err); bad++; }
        prog.firstElementChild.style.width = `${((i + 1) / S.pending.length) * 100}%`;
        $("#save").textContent = `넣는 중 ${i + 1}/${S.pending.length}`;
      }
      S.pending = []; S.busy = false; chosen.clear();
      toast([`${added}장 넣음`, dup && `${dup}장은 이미 있음`, addImage.nai && `NovelAI ${addImage.nai}장`, bad && `${bad}장 실패`].filter(Boolean).join(" · "));
      if (bad && !added && !dup) { render(); return; }
      S.inc.clear(); S.exc.clear(); S.untagged = false; S.q = ""; listScroll = 0;
      location.hash = "#/list";
    });
  },

  tags() {
    document.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => { S.ui.tagSort = b.dataset.sort; saveUI(); render(); }));
    const tq = $("#tq");
    tq?.addEventListener("input", () => {
      const q = normTag(tq.value);
      document.querySelectorAll("#tagList li").forEach((li) => { li.hidden = q && !li.dataset.t.includes(q); });
    });
    $("#screen").onclick = async (e) => {
      const go = e.target.closest("[data-go]");
      if (go) { S.inc = new Set([go.dataset.go]); S.exc.clear(); S.untagged = false; S.q = ""; listScroll = 0; return; }
      if (e.target.closest("[data-untagged]")) { S.inc.clear(); S.exc.clear(); S.untagged = true; S.q = ""; listScroll = 0; return; }
      const btn = e.target.closest("[data-act]"); if (!btn) return;
      const t = btn.closest("li").dataset.t;
      const hit = S.metas.filter((m) => m.tags.includes(t));
      if (btn.dataset.act === "rename") {
        const v = prompt(`‘${t}’의 새 이름 (있는 태그면 합쳐짐)`, t); if (v == null) return;
        const nt = normTag(v); if (!nt || nt === t) return;
        hit.forEach((m) => { m.tags = [...new Set(m.tags.map((x) => (x === t ? nt : x)))]; });
        await putMany(hit);
        [S.inc, S.exc].forEach((s) => { if (s.delete(t)) s.add(nt); });
        toast(`${hit.length}장: ${t} → ${nt}`); render();
      }
      if (btn.dataset.act === "del") {
        if (!confirm(`‘${t}’ 태그를 ${hit.length}장에서 뗌. 그림은 남음.`)) return;
        hit.forEach((m) => { m.tags = m.tags.filter((x) => x !== t); });
        await putMany(hit); S.inc.delete(t); S.exc.delete(t);
        toast(`‘${t}’ 지움`); render();
      }
    };
  },

  settings() {
    navigator.storage?.estimate?.().then(({ usage = 0, quota = 0 }) => {
      const el = $("#quota"); if (el) el.textContent = quota ? `브라우저 전체 사용 ${size(usage)} / 쓸 수 있는 한도 약 ${size(quota)}` : "남은 공간을 알 수 없음";
    }).catch(() => { const el = $("#quota"); if (el) el.textContent = "남은 공간을 알 수 없음"; });
    navigator.storage?.persisted?.().then((p) => { if (p) { const b = $("#persist"); if (b) { b.textContent = "지우지 않게 해 둠 ✓"; b.disabled = true; } } });
    $("#persist").addEventListener("click", async () => {
      const ok = await navigator.storage?.persist?.();
      toast(ok ? "브라우저가 받아들임" : "브라우저가 거절함. 홈 화면에 추가하면 받아 줄 때가 많음");
      render();
    });
    document.querySelectorAll("[data-cols]").forEach((b) => b.addEventListener("click", () => { S.ui.cols = +b.dataset.cols; saveUI(); render(); }));
    document.querySelectorAll("[data-sortimg]").forEach((b) => b.addEventListener("click", () => { S.ui.sort = b.dataset.sortimg; saveUI(); render(); }));
    const prog = $("#prog");
    const step = (i, n) => { prog.hidden = false; prog.firstElementChild.style.width = `${(i / n) * 100}%`; };
    $("#backup").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "묶는 중…";
      try {
        const files = [];
        for (const m of S.metas) { const r = await getBlob(m.id); if (r) files.push({ name: `images/${m.id}.${extOf(m.type, m.name)}`, blob: r.full, at: m.at }); }
        const meta = { app: "이미지창고", v: 1, at: Date.now(), items: S.metas.map(({ id, name, type, w, h, tags, memo, at, nai }) => ({ id, name, type, w, h, tags, memo, at, ...(nai ? { nai } : {}), file: `images/${id}.${extOf(type, name)}` })) };
        files.unshift({ name: "meta.json", blob: new Blob([JSON.stringify(meta, null, 1)], { type: "application/json" }) });
        download(await makeZip(files, step), `imagestore-${stamp()}.zip`);
        toast(`${S.metas.length}장 묶음`);
      } catch (err) { console.warn(err); toast("백업 실패: " + err.message); }
      e.target.disabled = false; e.target.textContent = "전부 ZIP으로 내려받기";
    });
    $("#zip").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      let added = 0, dup = 0, bad = 0;
      try {
        const ents = await readZip(f);
        const metaEnt = ents.find((x) => x.name === "meta.json");
        let items;
        if (metaEnt) {
          const j = JSON.parse(await (await metaEnt.blob()).text());
          items = (j.items || []).map((it) => ({ ...it, ent: ents.find((x) => x.name === it.file) })).filter((it) => it.ent);
        } else {
          items = ents.filter((x) => /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i.test(x.name))
            .map((x) => ({ name: x.name.split("/").pop(), tags: [], ent: x }));
        }
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          try {
            let b = await it.ent.blob();
            const type = it.type || guessType(it.name);
            if (b.type !== type) b = new Blob([b], { type });
            const fresh = !(it.id && byId(it.id));
            const keep = { memo: it.memo, at: it.at, ...(it.nai ? { nai: it.nai } : {}) };
            const ok = await addImage(b, it.name, (it.tags || []).map(normTag).filter(Boolean),
              fresh ? { id: it.id, ...keep } : keep, { naiTags: metaEnt ? false : undefined });
            ok ? added++ : dup++;
          } catch (err) { console.warn(it.name, err); bad++; }
          step(i + 1, items.length);
        }
        toast([`${added}장 넣음`, dup && `${dup}장은 이미 있음`, bad && `${bad}장 실패`].filter(Boolean).join(" · "));
      } catch (err) { console.warn(err); toast("ZIP을 못 읽음: " + err.message); }
      render();
    });
    $("#naiScan").addEventListener("click", async (e) => {
      e.target.disabled = true;
      const todo = S.metas.filter((m) => !m.nai && /png/i.test(m.type));
      let found = 0, tagged = 0;
      for (let i = 0; i < todo.length; i++) {
        const m = todo[i];
        e.target.textContent = `읽는 중 ${i + 1}/${todo.length}`;
        try {
          const r = await getBlob(m.id); if (!r) continue;
          const nai = readNai(await r.full.arrayBuffer()); if (!nai) continue;
          m.nai = nai; found++;
          if (S.ui.naiTags) { const n = m.tags.length; m.tags = [...new Set([...m.tags, ...naiTagsOf(nai)])]; if (m.tags.length > n) tagged++; }
          await putMany([m]);
        } catch (err) { console.warn(m.name, err); }
        step(i + 1, todo.length);
      }
      toast(todo.length ? `PNG ${todo.length}장 중 NovelAI ${found}장${S.ui.naiTags && found ? ` · ${tagged}장에 태그 붙임` : ""}` : "새로 읽을 PNG 없음");
      render();
    });
    $("#tagsJson").addEventListener("click", () => {
      const j = S.metas.map(({ name, tags, memo, at }) => ({ name, tags, memo, at }));
      download(new Blob([JSON.stringify(j, null, 2)], { type: "application/json" }), `imagestore-tags-${stamp()}.json`);
    });
    $("#reset").addEventListener("click", async () => {
      if (!confirm(`그림 ${S.metas.length}장을 전부 지움. 되돌릴 수 없음. 백업을 먼저 받았는지 확인.`)) return;
      await delMany(S.metas.map((m) => m.id)); S.metas.forEach((m) => forget(m.id));
      S.metas = []; S.inc.clear(); S.exc.clear(); S.picked.clear();
      toast("전부 지움"); render();
    });
  },

  img(id) {
    const m = byId(id); if (!m) return;
    blobURL(id, "full").then((u) => { const im = $("#full"); if (im && u) im.src = u; });
    const order = filtered(); const i = order.findIndex((x) => x.id === id);
    const prev = order[i - 1], next = order[i + 1];
    $("#prev").disabled = !prev; $("#next").disabled = !next;
    $("#prev").onclick = () => prev && location.replace("#/img/" + prev.id);
    $("#next").onclick = () => next && location.replace("#/img/" + next.id);
    $("#count").textContent = i >= 0 ? `${i + 1} / ${order.length}` : "";
    const drawMine = () => {
      $("#myTags").innerHTML = m.tags.length
        ? m.tags.map((t) => `<button type="button" class="chip inc" data-t="${esc(t)}">${esc(t)} <span class="x">✕</span></button>`).join("")
        : `<span class="hint">태그 없음</span>`;
    };
    drawMine();
    const ti = wireTagInput("imgTag", async (ts) => {
      m.tags = [...new Set([...m.tags, ...ts])]; await putMany([m]); drawMine();
    }, () => m.tags);
    $("#myTags").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-t]"); if (!b) return;
      m.tags = m.tags.filter((t) => t !== b.dataset.t); await putMany([m]); drawMine(); ti.refresh();
    });
    $("#memo").addEventListener("change", async (e) => { m.memo = e.target.value; await putMany([m]); toast("메모 저장"); });
    document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(naiCopyText(m, +b.dataset.copy)); toast("복사함"); }
      catch { toast("복사 못 함 (브라우저가 막음)"); }
    }));
    $("#naiAdd")?.addEventListener("click", async () => {
      const n = m.tags.length; m.tags = [...new Set([...m.tags, ...naiTagsOf(m.nai)])];
      await putMany([m]); drawMine(); ti.refresh(); toast(`태그 ${m.tags.length - n}개 더함`);
    });
    $("#dl").addEventListener("click", async () => {
      const r = await getBlob(id); if (!r) return;
      const base = m.name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
      download(r.full, `${base}.${extOf(m.type, m.name)}`);
    });
    $("#del").addEventListener("click", async () => {
      if (!confirm("이 그림을 지움. 되돌릴 수 없음.")) return;
      await delMany([id]); forget(id); S.metas = S.metas.filter((x) => x.id !== id); S.picked.delete(id);
      toast("지움");
      location.replace(next ? "#/img/" + next.id : prev ? "#/img/" + prev.id : "#/list");
    });
    // 옆으로 밀어 넘기기
    let sx = null, sy = 0;
    const v = $(".viewer");
    v.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    v.addEventListener("touchend", (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? $("#next") : $("#prev")).click();
    });
  },
};

// ── 시작 ────────────────────────────────────────────────────
(async () => {
  try {
    S.metas = (await allMeta()).sort((a, b) => b.at - a.at);
  } catch (err) {
    console.warn("창고를 못 엶", err);
    $("#screen").innerHTML = `<p class="empty">이 브라우저에서 저장소(IndexedDB)를 못 엶.<br>시크릿 창이면 일반 창에서 열기.</p>`;
    return;
  }
  render();
})();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
