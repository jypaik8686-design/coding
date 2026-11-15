// 짤뽑기 — 취향 프롬프트를 늘 붙여 NovelAI로 한 장씩 뽑고, 고른 것과 버린 것에서 취향을 쌓는다.
// 화면 셋: 뽑기 / 보관함 / 취향. 글자 데이터는 localStorage, 그림은 IndexedDB.

const KEY = "짤뽑기/v1";
const API = "https://image.novelai.net/ai/generate-image";
const LOG_MAX = 400;

const SIZES = { 세로: [832, 1216], 가로: [1216, 832], 정사각: [1024, 1024] };
// 품질 태그는 NovelAI 문서(docs.novelai.net/en/image/qualitytags, 2026-11-15 확인)의 모델별 문구 그대로.
const MODELS = {
  "nai-diffusion-5-full": { 이름: "V5 Full", 품질: ", very aesthetic, masterpiece, no text" },
  "nai-diffusion-4-5-full": { 이름: "V4.5 Full", 품질: ", location, very aesthetic, masterpiece, no text" },
};
const DEFAULT_NEG = "lowres, bad anatomy, bad hands, extra digits, jpeg artifacts, signature, watermark, username, blurry";

// ── 데이터 모양 ──────────────────────────────────────────────
// log 항목 하나: { id, scene, style, negative, seed, model, w, h, steps, scale, at, verdict }
//   verdict: null(안 고름) | "keep"(보관) | "drop"(버림)
const SHAPE = () => ({
  settings: { token: "", model: "nai-diffusion-5-full", customModel: "", size: "세로", steps: 28, scale: 5, quality: true },
  taste: { style: "", negative: DEFAULT_NEG },
  draft: { scene: "", seedLock: false, seed: null },
  log: [],
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
    return {
      settings: { ...base.settings, ...(raw.settings || {}) },
      taste: { ...base.taste, ...(raw.taste || {}) },
      draft: { ...base.draft, ...(raw.draft || {}) },
      log: Array.isArray(raw.log) ? raw.log.filter((r) => r && r.id) : [],
    };
  } catch { return base; }
}

// ── 그림 저장 (IndexedDB) ────────────────────────────────────
let dbp = null;
function db() {
  dbp ??= new Promise((ok, no) => {
    const q = indexedDB.open("짤뽑기", 1);
    q.onupgradeneeded = () => q.result.createObjectStore("img", { keyPath: "id" });
    q.onsuccess = () => ok(q.result);
    q.onerror = () => no(q.error);
  });
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((ok, no) => {
    const tx = d.transaction("img", mode);
    const q = fn(tx.objectStore("img"));
    tx.oncomplete = () => ok(q?.result);
    tx.onerror = tx.onabort = () => no(tx.error);
  });
}
const imgPut = (row) => idb("readwrite", (s) => s.put(row));
const imgGet = (id) => idb("readonly", (s) => s.get(id));
const imgDel = (id) => idb("readwrite", (s) => s.delete(id));
const imgClear = () => idb("readwrite", (s) => s.clear());

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

// 요청 몸통은 V5에서 200이 확인된 꼴 그대로 (명세.md '밖에 나가는 것' 참고). v4_prompt 둘을 빼면 500이 난다.
function requestBody(prompt, negative, rec) {
  const cap = (t) => ({ use_coords: false, use_order: false, caption: { base_caption: t, char_captions: [] } });
  return {
    input: prompt, model: rec.model, action: "generate",
    parameters: {
      params_version: 4, width: rec.w, height: rec.h, scale: rec.scale, sampler: "k_euler_ancestral",
      steps: rec.steps, seed: rec.seed, n_samples: 1, ucPreset: 3, qualityToggle: false,
      sm: false, sm_dyn: false, dynamic_thresholding: false, controlnet_strength: 1,
      legacy: false, add_original_image: false, cfg_rescale: 0, noise_schedule: "karras",
      legacy_v3_extend: false, uncond_scale: 1, negative_prompt: negative, prompt,
      reference_image_multiple: [], reference_information_extracted_multiple: [], reference_strength_multiple: [],
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

  busy = new AbortController();
  render();
  try {
    const res = await fetch(API, {
      method: "POST", signal: busy.signal,
      headers: { Authorization: `Bearer ${s.token.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody(prompt, rec.negative, rec)),
    });
    if (!res.ok) {
      let said = "";
      try { const t = await res.text(); said = (JSON.parse(t).message ?? t).toString().slice(0, 200); } catch { /* 본문 없음 */ }
      const hint = res.status === 401 ? "토큰이 틀렸거나 만료됨. ‘취향’ 탭에서 다시 넣기."
        : res.status === 429 ? "요청이 너무 잦거나 다른 생성이 돌고 있음. 잠시 뒤 직접 다시 누르기."
        : "";
      throw new Error(`${hint} (서버 ${res.status}${said ? `: ${said}` : ""})`.trim());
    }
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

// ── 화면 ────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SCREENS = {
  gen() {
    const { settings: s, taste, draft } = store.data;
    const styleLen = tidy(taste.style).length;
    return `
      ${s.token.trim() ? "" : `<p class="notice">NovelAI 토큰이 아직 없음. <a href="#/taste">‘취향’ 탭 맨 아래</a>에서 넣어야 뽑힘.</p>`}
      <label for="scene">이번 그림 <span class="hint">영어 태그, 쉼표로</span></label>
      <textarea id="scene" rows="4" autocapitalize="off" autocomplete="off" spellcheck="false"
        placeholder="1girl, silver hair, looking at viewer, upper body">${esc(draft.scene)}</textarea>
      <p class="hint">${styleLen ? `여기에 취향 프롬프트(${styleLen}자)` : `취향 프롬프트는 아직 비어 있고,`}${s.quality ? " 품질 태그가" : ""} 뒤에 붙음.</p>
      <div class="seg" role="group" aria-label="크기">
        ${Object.keys(SIZES).map((k) => `<button type="button" class="${s.size === k ? "on" : ""}" data-size="${k}">${k}<small>${SIZES[k].join("×")}</small></button>`).join("")}
      </div>
      <label class="line"><input type="checkbox" id="seedLock" ${draft.seedLock ? "checked" : ""}>
        같은 시드로 다시 <span class="hint">${Number.isInteger(draft.seed) ? `시드 ${draft.seed}` : "아직 뽑은 적 없음"}</span></label>
      ${busy
        ? `<button type="button" id="stop" class="ghost big">뽑는 중… 눌러서 취소</button>`
        : `<button type="button" id="go" class="big">뽑기</button>`}
      ${errMsg ? `<p class="error" role="alert">${esc(errMsg)}</p>` : ""}
      ${now ? `
        <figure class="result">
          <img src="${now.url}" alt="방금 뽑은 그림" width="${now.rec.w}" height="${now.rec.h}">
          <figcaption class="hint">시드 ${now.rec.seed} · ${now.rec.w}×${now.rec.h} · ${esc(now.rec.model)}</figcaption>
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

  keep(id) {
    const kept = store.data.log.filter((r) => r.verdict === "keep");
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
          <dt>값</dt><dd>시드 ${r.seed} · ${r.w}×${r.h} · ${r.steps}스텝 · 강도 ${r.scale} · ${esc(r.model)}</dd>
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
      <p class="hint">한 번에 한 장, 28스텝 이하, 위 세 크기만 씀. 이 범위를 Opus 구독은 Anlas 없이 뽑고, 다른 구독은 Anlas가 듦.</p>

      <h2>데이터</h2>
      <p class="hint">기록 ${log.length}건, 보관 ${log.filter((r) => r.verdict === "keep").length}장이 이 기기에만 있음.</p>
      <button type="button" class="ghost" id="export">기록 내보내기 (JSON, 토큰·그림 제외)</button>
      <button type="button" class="danger" id="reset">전부 지우기</button>`;
  },
};

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { gen: "짤뽑기", keep: "보관함", taste: "취향" };
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
    on("steps", "change", (e) => { d.settings.steps = clamp(e.target.value, 1, 28, 28); e.target.value = d.settings.steps; store.persist(); });
    on("scale", "change", (e) => { d.settings.scale = clamp(e.target.value, 0, 10, 5); e.target.value = d.settings.scale; store.persist(); });
    document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => {
      d.taste.style = [tidy(d.taste.style), b.dataset.add].filter(Boolean).join(", ");
      store.save();
    }));
    on("export", "click", () => {
      const out = { ...d, settings: { ...d.settings, token: "" } };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
      a.download = "짤뽑기.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    on("reset", "click", async () => {
      if (!confirm("취향, 기록, 보관한 그림, 토큰을 전부 지움. 되돌릴 수 없음.")) return;
      await imgClear().catch(() => {});
      if (now) { URL.revokeObjectURL(now.url); now = null; }
      store.data = SHAPE();
      store.save();
    });
  }
}

addEventListener("hashchange", () => { errMsg = ""; render(); });
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
