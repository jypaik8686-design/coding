// 아이디어지도 — 아이디어 저장소를 열고 글 저장소(원고·인물)·그림 저장소(취향·고정 블록·태그)와 이어 본다.
// 저장소 이름은 설정에서 고른다. 내용은 사용자가 넣은 GitHub 토큰으로 그때그때 읽고, 이 기기에만 둔다. 앱 파일에는 아무 내용도 없다.

const KEY = "아이디어지도/v1";
const GH = "https://api.github.com";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const TAGS_FILE = "태그사전/다른이름.tsv"; // 그림 저장소 안
const MADE_MAX = 30;

// 벽 안쪽. 받을 때도, 그릴 때도 거른다.
const WALL = [/^idea\/일기\//, /^idea\/감정배설\//, /^idea\/진료\//, /^idea\/사서참고\.md$/,
  /^idea\/생활\//, /^idea\/입고기록\//];
const walled = (p) => WALL.some((r) => r.test(p));

// 역할마다 읽을 파일. 받은 파일 경로는 `역할/파일경로`로 둔다 (idea·write·art)
const WANT = {
  idea: (p) => p === "목록.md" || /^서가\/.+\.md$/.test(p) || /^아이디어보관소\/[^/]+\.md$/.test(p),
  write: (p) => p === "novel/WORKS.md" || p === "novel/TASTE.md" ||
    /^novel\/works\/(?!_)[^/]+\/(인물|투입카드|story-bible|00_canon)\.md$/.test(p),
  art: (p) => p === "취향.md" || p === "프롬프트/NAI.md" || /^참고\/[^/]+\.md$/.test(p),
};
const REPO_LABEL = { idea: "아이디어", write: "원고·인물", art: "그림" };

// ── 데이터 모양 ──────────────────────────────────────────────
const SHAPE = () => ({
  settings: { owner: "", ghToken: "", geminiKey: "", model: "gemini-flash-latest", repos: { idea: "", write: "", art: "" } },
  cache: { at: 0, files: {}, errors: [] },
  made: [],
});

const store = {
  data: load(),
  save(again = true) {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
    catch (e) { toast("이 기기에 저장 못 함 (용량 부족일 수 있음): " + e.message); }
    if (again) render();
  },
  addMade(m) {
    this.data.made.unshift({ id: crypto.randomUUID(), at: Date.now(), ...m });
    this.data.made = this.data.made.slice(0, MADE_MAX);
    this.save(false);
  },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return SHAPE();
    const d = JSON.parse(raw), s = SHAPE();
    return {
      settings: { ...s.settings, ...(d.settings || {}), repos: { ...s.settings.repos, ...(d.settings?.repos || {}) } },
      cache: { ...s.cache, ...(d.cache || {}) },
      made: Array.isArray(d.made) ? d.made : [],
    };
  } catch { return SHAPE(); }
}

// ── GitHub에서 받기 ──────────────────────────────────────────
let busy = "";

async function gh(path, raw) {
  const s = store.data.settings;
  const res = await fetch(GH + path, {
    headers: {
      Authorization: `Bearer ${s.ghToken.trim()}`,
      Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    const hint = res.status === 401 ? "토큰이 틀렸거나 만료됨"
      : res.status === 403 ? "토큰에 이 저장소 읽기 권한이 없거나, 요청 한도에 걸림"
      : res.status === 404 ? "저장소를 못 찾음 (토큰의 저장소 목록에 넣었는지 확인)" : "";
    throw new Error(`${res.status} ${hint}`.trim());
  }
  return raw ? res.text() : res.json();
}

const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

async function refresh() {
  const s = store.data.settings;
  if (!s.ghToken.trim() || !s.repos.idea) { location.hash = "#/settings"; toast("설정에서 토큰과 저장소부터 고르기"); return; }
  busy = "목록 받는 중…"; render();
  const files = {}, errors = [];
  for (const repo of Object.keys(WANT)) {
    const name = s.repos[repo];
    if (!name) continue;
    try {
      const tree = await gh(`/repos/${enc(s.owner)}/${enc(name)}/git/trees/HEAD?recursive=1`);
      const paths = (tree.tree || []).filter((t) => t.type === "blob").map((t) => t.path)
        .filter((p) => WANT[repo](p) && !walled(`${repo}/${p}`));
      let n = 0;
      for (const p of paths) {
        busy = `${REPO_LABEL[repo]} 받는 중… ${++n}/${paths.length}`; renderBusy();
        try { files[`${repo}/${p}`] = await gh(`/repos/${enc(s.owner)}/${enc(name)}/contents/${enc(p)}`, true); }
        catch (e) { errors.push(`${repo}/${p}: ${e.message}`); }
      }
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  busy = "";
  if (!Object.keys(files).length && errors.length) {
    store.data.cache.errors = errors; store.save();
    toast("못 받음 — 설정에서 오류 확인"); return;
  }
  store.data.cache = { at: Date.now(), files, errors };
  store.save();
  toast(`${Object.keys(files).length}개 받음${errors.length ? `, 실패 ${errors.length}` : ""}`);
}

// ── 목록.md 읽기 ─────────────────────────────────────────────
function shelves() {
  const files = store.data.cache.files;
  const idx = files["idea/목록.md"] || "";
  const out = []; let cur = null; const seen = new Set();
  for (const line of idx.split("\n")) {
    const h = line.match(/^##\s+(.+)/);
    if (h) { cur = { name: h[1].replace(/^서가\//, "").trim(), books: [] }; out.push(cur); continue; }
    const b = line.match(/^-\s+\[([^\]]+)\]\(<?([^)>]+)>?\)\s*(?:—\s*(.*))?/);
    if (b && cur) {
      const path = "idea/" + decodeURIComponent(b[2]).replace(/^\.\//, "");
      if (walled(path)) continue;
      seen.add(path);
      cur.books.push({ title: b[1], path, note: (b[3] || "").replace(/\s*\(갱신[^)]*\)\s*$/, ""), has: !!files[path] });
    }
  }
  // 목록에 안 적힌 책도 빠뜨리지 않는다
  const extra = Object.keys(files).filter((p) => p.startsWith("idea/") && p !== "idea/목록.md" && !seen.has(p));
  if (extra.length) out.push({ name: "목록에 없는 책", books: extra.map((p) => ({ title: p.split("/").slice(-2).join("/"), path: p, note: "", has: true })) });
  return out.filter((s) => s.books.length);
}

// ── 이어 보기: 낱말 겹침 ─────────────────────────────────────
const STOP = new Set("아니라 아니고 기준 매우 너무 핵심 전제 마지막 처음 들어 들어감 위한 하나 여러 모든 각자 그냥 정말 진짜 이미 아직 다시 따로 함께 그리고 하지만 그래서 있음 없음 같은 것을 것이 하는 했다 한다 있다 없다 이다 입고 갱신 가안 설정 내용 원함 사용자 경우 정도 부분 지금 다음 위해 대한 이번".split(" "));
function words(text) {
  const m = (text || "").replace(/\(입고[^)]*\)|\(갱신[^)]*\)|\(이식[^)]*\)/g, " ")
    .match(/[가-힣]{2,}|[A-Za-z][A-Za-z_-]{3,}/g) || [];
  const set = new Set();
  for (let w of m) {
    w = w.replace(/(으로|에서|에게|까지|부터|처럼|보다|이랑|하고|이나|라는|이라|이며|이고|은|는|이|가|을|를|의|에|와|과|도|만|로)$/, "");
    if (w.length >= 2 && !STOP.has(w)) set.add(w.toLowerCase());
  }
  return set;
}
let wordCache = { at: -1, map: {} };
function wordsOf(path) {
  if (wordCache.at !== store.data.cache.at) wordCache = { at: store.data.cache.at, map: {} };
  return (wordCache.map[path] ||= words(store.data.cache.files[path]));
}
function related(path, limit = 8) {
  const mine = wordsOf(path);
  const out = [];
  for (const p of Object.keys(store.data.cache.files)) {
    if (p === path || walled(p) || p === "idea/목록.md") continue;
    const theirs = wordsOf(p);
    const shared = [...mine].filter((w) => theirs.has(w));
    if (shared.length < 3) continue;
    const score = shared.length / Math.sqrt(theirs.size + 20);
    out.push({ path: p, score, shared: shared.slice(0, 6) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// 인물: 글 저장소 인물.md의 ### 이름이 이 책에 나오면 그 칸을 잇는다
function characters(text) {
  const out = [];
  for (const [p, body] of Object.entries(store.data.cache.files)) {
    if (!/^write\/.+\/인물\.md$/.test(p)) continue;
    for (const part of body.split(/^###\s+/m).slice(1)) {
      const name = part.split("\n")[0].trim();
      const key = name.split(/[\s(（·/]/)[0];
      if (key.length >= 2 && text.includes(key)) out.push({ path: p, name, body: part.split("\n").slice(1).join("\n").trim() });
    }
  }
  return out;
}
// 그림 저장소 NAI.md에서 이 책의 낱말이 들어간 고정 블록 줄
function artLines(path) {
  const nai = store.data.cache.files["art/프롬프트/NAI.md"] || "";
  const mine = wordsOf(path);
  return nai.split("\n").filter((l) => /^-\s/.test(l) && /고정 블록|레시피|저지|옷/.test(l))
    .filter((l) => [...words(l.split(/[—:]/)[0])].some((w) => mine.has(w)));
}

// ── 태그 사전 ────────────────────────────────────────────────
let tagMap = null;
async function loadTags() {
  if (tagMap) return tagMap;
  const s = store.data.settings;
  if (!s.repos.art) throw new Error("설정에서 그림 저장소를 고르지 않음");
  let text = null;
  try {
    const c = await caches.open("아이디어지도-태그");
    const hit = await c.match("tags");
    if (hit) text = await hit.text();
    else {
      text = await gh(`/repos/${enc(s.owner)}/${enc(s.repos.art)}/contents/${enc(TAGS_FILE)}`, true);
      await c.put("tags", new Response(text));
    }
  } catch (e) {
    if (!text) throw new Error(`태그 사전(${TAGS_FILE})을 못 받음: ` + e.message);
  }
  tagMap = new Map();
  for (const line of text.split("\n")) {
    const [name, tag, kind] = line.split("\t");
    if (name && tag && /[가-힣]/.test(name) && !tagMap.has(name)) tagMap.set(name, { tag, kind });
  }
  return tagMap;
}
async function findTags(text) {
  const map = await loadTags();
  const found = new Map();
  const m = (text || "").match(/[가-힣]{2,}/g) || [];
  for (const raw of m) {
    for (const w of [raw, raw.replace(/(으로|에서|에게|은|는|이|가|을|를|의|에|와|과|도|로)$/, "")]) {
      const hit = map.get(w);
      if (hit && !found.has(hit.tag)) found.set(hit.tag, { word: w, ...hit });
    }
  }
  return [...found.values()].slice(0, 60);
}

// ── 제미니로 만들기 ──────────────────────────────────────────
const MAKERS = {
  글: {
    label: "글 초안",
    build(book, files) {
      return [
        "너는 사용자의 소설 공동 작가다. 아래 아이디어 메모로 한국어 장면 초안 하나를 쓴다.",
        "규칙: 헤밍웨이체(짧은 문장, 행동과 사물로 감정을 보여 줌). 1,200자 안팎. 메모에 없는 설정은 최소한만 지어내고, 지어낸 곳은 끝에 '지어낸 것:' 목록으로 따로 적는다.",
        files["write/novel/TASTE.md"] ? "사용자 취향:\n" + files["write/novel/TASTE.md"].slice(0, 6000) : "",
        "아이디어 메모:\n" + book,
      ].filter(Boolean).join("\n\n");
    },
  },
  인물: {
    label: "인물 카드",
    build(book) {
      return [
        "아래 아이디어 메모에 나오는 주요 인물을 인물 카드로 정리한다. 한국어.",
        "인물 한 명당 '### 이름' 하나, 칸은: 한 줄 / 욕망·결함 / 말투 / 관계 / 지금 상태 / 금지. 메모에 없는 것은 '[가안]'을 붙여 제안한다.",
        "아이디어 메모:\n" + book,
      ].join("\n\n");
    },
  },
  그림: {
    label: "NAI 태그",
    build(book, files, tags) {
      return [
        "아래 아이디어의 대표 장면 하나를 NovelAI 이미지 프롬프트로 만든다.",
        "규칙: 단부루 태그를 쉼표로. Prompt와 Undesired를 각각 코드 블록 하나로, 둘 다 끝에 쉼표. 기본 퀄리티 태그와 Undesired는 아래 NAI 규칙을 따른다. 고정 블록이 있는 인물이면 그대로 쓴다. 맨 앞에 어떤 장면인지 한국어 한 줄.",
        files["art/취향.md"] ? "사용자 그림 취향:\n" + files["art/취향.md"].slice(0, 5000) : "",
        files["art/프롬프트/NAI.md"] ? "NAI 규칙과 고정 블록:\n" + files["art/프롬프트/NAI.md"].slice(0, 9000) : "",
        tags?.length ? "태그 사전에서 찾은 후보(한국어=태그): " + tags.map((t) => `${t.word}=${t.tag.replace(/_/g, " ")}`).join(", ") : "",
        "아이디어 메모:\n" + book,
      ].filter(Boolean).join("\n\n");
    },
  },
};

async function make(kind, path) {
  const s = store.data.settings;
  if (!s.geminiKey.trim()) { toast("설정에서 제미니 열쇠부터 넣기"); location.hash = "#/settings"; return; }
  const files = store.data.cache.files;
  const book = files[path];
  if (!book || walled(path)) return;
  let tags = [];
  if (kind === "그림") { try { tags = await findTags(book); } catch { /* 태그 없이도 만든다 */ } }
  const out = document.getElementById("makeOut");
  out.innerHTML = `<p class="hint">${MAKERS[kind].label} 만드는 중…</p>`;
  try {
    const res = await fetch(`${GEMINI}/models/${encodeURIComponent(s.model.trim() || "gemini-flash-latest")}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": s.geminiKey.trim() },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: MAKERS[kind].build(book, files, tags) }] }] }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || res.status);
    const c = j.candidates?.[0];
    const text = (c?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) throw new Error("빈 답 (" + (c?.finishReason || j.promptFeedback?.blockReason || "이유 없음") + ")");
    store.addMade({ path, kind, text });
    out.innerHTML = madeCard(store.data.made[0]);
  } catch (e) {
    out.innerHTML = `<p class="err">못 만듦: ${esc(e.message)}</p>`;
  }
}

// ── 작은 마크다운 ────────────────────────────────────────────
function md(src) {
  const lines = String(src || "").split("\n"); let html = "", inList = false, inCode = false, code = [];
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(<?([^)>]+)>?\)/g, (m, a, href) => `<a class="mdlink" data-href="${href}">${a}</a>`);
  for (const l of lines) {
    if (/^```/.test(l)) { if (inCode) { html += `<pre>${esc(code.join("\n"))}</pre>`; code = []; } inCode = !inCode; continue; }
    if (inCode) { code.push(l); continue; }
    const li = l.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!inList) { html += "<ul class=md>"; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`; continue; }
    if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  if (inList) html += "</ul>";
  if (inCode) html += `<pre>${esc(code.join("\n"))}</pre>`;
  return html;
}

// ── 화면 ────────────────────────────────────────────────────
let query = "";

const SCREENS = {
  list() {
    const { cache, settings } = store.data;
    if (!settings.ghToken || !settings.repos.idea) return `<p class="empty">설정에서 GitHub 토큰을 넣고 저장소 셋을 고른 뒤<br>‘받아 오기’를 누르면 아이디어가 뜬다.</p>
      <a class="btnlink" href="#/settings">설정으로</a>`;
    if (!cache.at) return `<p class="empty">아직 안 받음.</p><button id="pull">받아 오기</button>`;
    const box = `<input id="q" type="search" placeholder="세 저장소에서 찾기" value="${esc(query)}" autocomplete="off">`;
    if (query.trim()) return box + searchHtml(query.trim());
    return box + shelves().map((s) => `
      <h2>${esc(s.name)}</h2>
      <ul class="list">${s.books.map((b) => `
        <li class="row"><a class="text" href="#/view/${enc(b.path)}">
          <strong>${esc(b.title)}</strong>${b.note ? `<small>${esc(b.note)}</small>` : ""}
          ${b.has ? "" : `<small class="err">파일 못 받음</small>`}</a></li>`).join("")}</ul>`).join("") +
      `<p class="hint">받은 때: ${when(cache.at)} · <a href="#" id="pull2">다시 받기</a></p>`;
  },

  view() {
    const path = decodeURIComponent(location.hash.replace(/^#\/view\//, ""));
    const files = store.data.cache.files;
    if (walled(path)) return `<p class="err">여기는 열지 않는 곳.</p>`;
    const body = files[path];
    if (body == null) return `<p class="empty">이 파일을 아직 안 받음.</p><a class="btnlink" href="#/list">목록으로</a>`;
    const repo = path.split("/")[0];
    const rel = related(path);
    const chars = characters(body);
    const art = repo === "idea" ? artLines(path) : [];
    const mine = store.data.made.filter((m) => m.path === path);
    return `
      <p class="crumb"><a href="#/list">목록</a> · ${esc(REPO_LABEL[repo] || repo)} · ${esc(path.split("/").slice(1).join("/"))}</p>
      <details open class="doc"><summary>내용</summary><div class="md">${md(body)}</div></details>
      <h2>이어진 것</h2>
      ${rel.length ? `<ul class="list">${rel.map((r) => `
        <li class="row"><a class="text" href="#/view/${enc(r.path)}"><strong>${esc(r.path.split("/").slice(1).join("/"))}</strong>
        <small>${esc(REPO_LABEL[r.path.split("/")[0]])} · 겹친 낱말: ${esc(r.shared.join(", "))}</small></a></li>`).join("")}</ul>`
        : `<p class="hint">낱말이 많이 겹치는 파일이 없음.</p>`}
      ${chars.length ? `<h2>인물 (글 저장소)</h2>${chars.map((c) => `<details class="doc"><summary>${esc(c.name)}</summary><div class="md">${md(c.body)}</div></details>`).join("")}` : ""}
      ${art.length ? `<h2>그림 고정 블록 (그림 저장소)</h2>${art.map((l) => `<div class="md small">${md(l)}</div>`).join("")}` : ""}
      <h2>태그</h2>
      <div id="tagOut"><button class="ghost" id="tagBtn">이 글에서 단부루 태그 찾기</button>
        <p class="hint">처음 한 번 태그 사전(약 4MB)을 받는다.</p></div>
      <h2>만들기</h2>
      <div class="makes">${Object.entries(MAKERS).map(([k, m]) => `<button data-make="${k}">${m.label}</button>`).join("")}</div>
      <p class="hint">제미니로 뽑는다. 결과는 ‘만든 것’에 남는다. 저장소에 넣으려면 복사해서 Claude에게 넘긴다.</p>
      <div id="makeOut"></div>
      ${mine.length ? `<h2>이 책으로 만든 것</h2>${mine.map(madeCard).join("")}` : ""}`;
  },

  made() {
    const made = store.data.made;
    if (!made.length) return `<p class="empty">아직 만든 것 없음.<br>책을 열고 ‘만들기’를 누른다.</p>`;
    return made.map(madeCard).join("");
  },

  settings() {
    const { settings: s, cache } = store.data;
    return `
      <form id="setForm">
        <label for="ghToken">GitHub 토큰 (읽기 전용)</label>
        <input id="ghToken" type="password" value="${esc(s.ghToken)}" autocomplete="off" placeholder="github_pat_…">
        <p class="hint">GitHub → Settings → Developer settings → Fine-grained tokens. 저장소는 아이디어·글·그림 셋만 고르고, 권한은 Contents: Read-only만. 이 기기에만 저장된다.</p>
        <button type="button" class="ghost" id="loadRepos">내 저장소 불러오기</button>
        <label for="owner">GitHub 계정</label>
        <input id="owner" value="${esc(s.owner)}" autocomplete="off">
        ${Object.entries(REPO_LABEL).map(([k, l]) => `
        <label for="repo-${k}">${l} 저장소</label>
        <select id="repo-${k}">${repoOptions(s.repos[k])}</select>`).join("")}
        <label for="geminiKey">제미니 열쇠 (만들기에만)</label>
        <input id="geminiKey" type="password" value="${esc(s.geminiKey)}" autocomplete="off" placeholder="AIza…">
        <label for="model">제미니 모델</label>
        <input id="model" value="${esc(s.model)}" autocomplete="off" list="models">
        <datalist id="models"><option value="gemini-flash-latest"><option value="gemini-pro-latest"><option value="gemini-4-argon"><option value="gemini-3.8-flash"></datalist>
        <button type="submit">저장</button>
      </form>
      <h2>받은 것</h2>
      <p class="hint">${cache.at ? `${Object.keys(cache.files).length}개, ${when(cache.at)}` : "아직 없음"}</p>
      <button class="ghost" id="pull">지금 받아 오기</button>
      ${cache.errors?.length ? `<details class="doc"><summary class="err">실패 ${cache.errors.length}개</summary><pre>${esc(cache.errors.join("\n"))}</pre></details>` : ""}
      <h2>지우기</h2>
      <button class="danger" id="reset">토큰·받은 것·만든 것 전부 지우기</button>`;
  },
};

let repoList = [];
function repoOptions(cur) {
  const names = [...new Set([...(cur ? [cur] : []), ...repoList])];
  return `<option value="">고르기</option>` + names.map((n) => `<option ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
}

function searchHtml(q) {
  const files = store.data.cache.files; const ql = q.toLowerCase(); const hits = [];
  for (const [p, t] of Object.entries(files)) {
    if (walled(p)) continue;
    const i = t.toLowerCase().indexOf(ql);
    if (i < 0 && !p.toLowerCase().includes(ql)) continue;
    const snip = i < 0 ? "" : t.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, " ");
    hits.push({ p, snip });
  }
  if (!hits.length) return `<p class="empty">‘${esc(q)}’ 없음.</p>`;
  const order = { idea: 0, write: 1, art: 2 };
  hits.sort((a, b) => order[a.p.split("/")[0]] - order[b.p.split("/")[0]]);
  return `<ul class="list">${hits.slice(0, 80).map((h) => `
    <li class="row"><a class="text" href="#/view/${enc(h.p)}"><strong>${esc(h.p.split("/").slice(1).join("/"))}</strong>
    <small>${esc(REPO_LABEL[h.p.split("/")[0]])}${h.snip ? " · …" + esc(h.snip) + "…" : ""}</small></a></li>`).join("")}</ul>`;
}

function madeCard(m) {
  return `<article class="made" data-id="${m.id}">
    <header><strong>${esc(m.kind)}</strong> · <a href="#/view/${enc(m.path)}">${esc(m.path.split("/").slice(-2).join("/"))}</a> · ${when(m.at)}</header>
    <div class="md">${md(m.text)}</div>
    <div class="makes"><button class="ghost" data-act="copy">복사</button><button class="ghost" data-act="del">지우기</button></div>
  </article>`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function when(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
  return new Date(ts).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { list: "아이디어지도", view: "보기", made: "만든 것", settings: "설정" };
const route = () => (location.hash.replace(/^#\/?/, "") || "list").split("/")[0];

function renderBusy() {
  if (busy) document.getElementById("count").textContent = busy;
}
function render() {
  const name = SCREENS[route()] ? route() : "list";
  document.getElementById("screen").innerHTML = SCREENS[name]();
  document.getElementById("title").textContent = TITLES[name];
  document.getElementById("count").textContent = busy || (name === "made" && store.data.made.length ? `${store.data.made.length}개` : "");
  document.querySelectorAll(".tabs a").forEach((a) => {
    const on = a.dataset.tab === name || (name === "view" && a.dataset.tab === "list");
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  wire(name);
}

function wire(name) {
  const $ = (id) => document.getElementById(id);
  $("pull")?.addEventListener("click", refresh);
  $("pull2")?.addEventListener("click", (e) => { e.preventDefault(); refresh(); });
  const q = $("q");
  if (q) {
    q.addEventListener("input", () => {
      query = q.value;
      const pos = q.selectionStart;
      render();
      const n = $("q"); n.focus(); n.setSelectionRange(pos, pos);
    });
  }
  if (name === "view") {
    const path = decodeURIComponent(location.hash.replace(/^#\/view\//, ""));
    document.querySelectorAll("[data-make]").forEach((b) => b.addEventListener("click", () => make(b.dataset.make, path)));
    $("tagBtn")?.addEventListener("click", async () => {
      const out = $("tagOut");
      out.innerHTML = `<p class="hint">태그 사전 받는 중…</p>`;
      try {
        const tags = await findTags(store.data.cache.files[path]);
        out.innerHTML = tags.length
          ? `<p class="tags">${tags.map((t) => `<span class="tag" title="${esc(t.word)} · ${esc(t.kind || "")}">${esc(t.tag.replace(/_/g, " "))}</span>`).join("")}</p>
             <button class="ghost" id="tagCopy">태그 복사</button>`
          : `<p class="hint">글 속 한국어 낱말과 맞는 태그가 없음.</p>`;
        $("tagCopy")?.addEventListener("click", () => copy(tags.map((t) => t.tag.replace(/_/g, " ")).join(", ") + ","));
      } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    });
    // 책 안 링크: 아이디어 저장소의 상대 경로를 앱 안 주소로
    document.querySelectorAll(".mdlink").forEach((a) => {
      const href = a.dataset.href;
      if (/^https?:/.test(href)) { a.href = href; a.target = "_blank"; a.rel = "noopener"; return; }
      const base = path.split("/").slice(0, -1);
      for (const part of decodeURIComponent(href).split("/")) {
        if (part === "..") base.pop(); else if (part && part !== ".") base.push(part);
      }
      const target = base.join("/");
      if (!walled(target)) a.href = "#/view/" + enc(target);
    });
  }
  if (name === "settings") {
    $("setForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const s = store.data.settings;
      for (const k of ["owner", "ghToken", "geminiKey", "model"]) s[k] = $(k).value.trim();
      for (const k of Object.keys(REPO_LABEL)) s.repos[k] = $(`repo-${k}`).value;
      store.save(); toast("저장함");
    });
    $("loadRepos").addEventListener("click", async () => {
      const s = store.data.settings;
      s.ghToken = $("ghToken").value.trim();
      try {
        const me = await gh("/user");
        s.owner = me.login;
        const list = await gh("/user/repos?per_page=100&affiliation=owner&sort=pushed");
        repoList = list.map((r) => r.name);
        store.save(); toast(`저장소 ${repoList.length}개 불러옴 — 셋을 고르고 저장`);
      } catch (e) { toast("못 불러옴: " + e.message); }
    });
    $("reset").addEventListener("click", () => {
      if (!confirm("토큰·받은 것·만든 것을 이 기기에서 전부 지움.")) return;
      store.data = SHAPE(); store.save(); caches.delete("아이디어지도-태그").catch(() => {}); tagMap = null;
    });
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("복사함"); }
  catch { toast("복사 못 함 — 길게 눌러 직접 복사"); }
}

document.getElementById("screen").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const card = btn.closest("[data-id]"); if (!card) return;
  const m = store.data.made.find((x) => x.id === card.dataset.id); if (!m) return;
  if (btn.dataset.act === "copy") copy(m.text);
  if (btn.dataset.act === "del") { store.data.made = store.data.made.filter((x) => x.id !== m.id); store.save(); }
});

addEventListener("hashchange", () => { render(); scrollTo(0, 0); });
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
