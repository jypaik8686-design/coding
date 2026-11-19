// 해체기 — RisuAI 파일(.risup .risum .charx 카드·모듈·플러그인·zip)을 열어 구조를 보고 AI 프롬프트 글로 뽑는다.
// 파일은 이 기기 안에서만 풀린다(밖으로 안 나감). 불러온 파일은 메모리에만 있고, 저장하는 것은 설정뿐이다.
// 바꿀 곳: SHAPE(저장하는 설정), SCREENS(화면). 풀이 로직은 risu.js.

import { parseFile, assemble, outline, forJjal, loreText } from "./risu.js";

const KEY = "해체기/v1";

// ── 데이터 모양 ──────────────────────────────────────────────
// 저장: 조립 설정만. 불러온 파일(files)은 크기가 커서(수 MB) 저장하지 않고 메모리에만 둔다.
const SHAPE = () => ({ settings: { slots: "mark", headers: true, strip: false, lore: true } });

const ui = { busy: false, saveFail: false, loreQ: "", loreShow: 30 };

const store = {
  data: load(),
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); ui.saveFail = false; }
    catch (e) { ui.saveFail = true; console.warn("저장 실패", e); }
    render();
  },
  reset() { this.data = SHAPE(); this.save(); },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const d = raw ? JSON.parse(raw) : {};
    return { ...SHAPE(), ...d, settings: { ...SHAPE().settings, ...(d.settings || {}) } };
  } catch { return SHAPE(); }
}

// 메모리에만 있는 것
const files = []; // 최상위 노드(가장 나중에 연 것이 앞)
const byId = new Map();
const copyBuf = {};
const memo = new Map();

const indexNode = (n) => { byId.set(n.id, n); (n.children || []).forEach(indexNode); };
const flat = (n, depth = 0) => [{ n, depth }, ...(n.children || []).flatMap((c) => flat(c, depth + 1))];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => Number(v).toLocaleString("ko-KR");
const size = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + "MB" : b >= 1024 ? Math.round(b / 1024) + "KB" : b + "B");

const asmOf = (n) => {
  const k = n.id + JSON.stringify(store.data.settings);
  if (!memo.has(k)) memo.set(k, assemble(n, store.data.settings));
  return memo.get(k);
};

// ── 화면 ────────────────────────────────────────────────────
const SCREENS = {
  list() {
    if (!files.length) {
      return `<p class="empty">열어 본 파일이 없음.<br>아래 ‘파일 열기’에서 .risup · .risum · .charx<br>· 카드 JSON/PNG · .js · .zip 을 고르기.</p>`;
    }
    return `<ul class="list">${files.map((root) => `
      <li class="group">
        ${flat(root).map(({ n, depth }) => `
          <a class="row item" href="#/view/${n.id}" style="margin-left:${depth * 14}px">
            <span class="badge k-${n.kind}">${esc(n.label)}</span>
            <span class="text">${esc(n.name)}</span>
            <span class="sz">${size(n.size)}</span>
          </a>`).join("")}
        <button class="ghost small" data-act="drop" data-id="${root.id}">이 묶음 닫기</button>
      </li>`).join("")}</ul>`;
  },

  add() {
    const noCrypto = !globalThis.crypto?.subtle;
    return `
      ${noCrypto ? `<p class="warn">이 주소에서는 .risup 암호를 못 풂. https 또는 localhost 주소로 열어야 함.</p>` : ""}
      <form id="addForm">
        <label for="file">파일 고르기 (여러 개 가능)</label>
        <input id="file" type="file" multiple>
        <p class="hint" id="status">${ui.busy ? "읽는 중…" : "고르면 바로 풀어서 보여 줌."}</p>
      </form>
      <h2>되는 것</h2>
      <ul class="plain">
        <li><b>.risup</b> 프리셋 (암호·압축 풀기)</li>
        <li><b>.risum</b> 모듈, <b>.charx</b> 카드 묶음</li>
        <li><b>카드</b> JSON, PNG 안의 카드</li>
        <li><b>하이파</b> 설정 JSON</li>
        <li><b>플러그인 .js</b> — 읽기만 함, 실행 안 함</li>
        <li><b>.zip</b> (안의 파일 전부 풀어서 각각 판별)</li>
      </ul>
      <p class="hint">파일은 이 기기 안에서만 풀리고 어디로도 안 나감. 닫으면 불러온 것은 사라짐.</p>`;
  },

  view(id, sub) {
    const n = byId.get(id);
    if (!n) return `<p class="empty">그 파일이 없음. 새로 고치면 불러온 것이 사라짐.<br><a href="#/add">다시 열기</a></p>`;
    const asm = n.kind !== "zip" ? asmOf(n) : null;
    const hasJjal = n.kind === "card" || n.kind === "module";
    const tabs = [["outline", "구조"], asm != null && ["asm", "조립 글"], hasJjal && ["jjal", "짤뽑기로"]].filter(Boolean);
    const cur = tabs.some(([k]) => k === sub) ? sub : "outline";
    const head = `
      <div class="vhead">
        <span class="badge k-${n.kind}">${esc(n.label)}</span> <span class="sz">${size(n.size)}</span>
        <div class="vname">${esc(n.name)}</div>
        ${n.note ? `<p class="hint">${esc(n.note)}</p>` : ""}
      </div>
      ${tabs.length > 1 ? `<div class="seg">${tabs.map(([k, t]) => `<a href="#/view/${n.id}/${k}" ${k === cur ? 'aria-current="true"' : ""}>${t}</a>`).join("")}</div>` : ""}`;
    if (cur === "asm") return head + asmView(n, asm);
    if (cur === "jjal") return head + jjalView(n);
    return head + outlineView(n);
  },

  settings() {
    const s = store.data.settings;
    const radio = (name, val, label) => `<label class="opt"><input type="radio" name="${name}" value="${val}" ${s[name] === val ? "checked" : ""}> ${label}</label>`;
    const check = (name, label) => `<label class="opt"><input type="checkbox" name="${name}" ${s[name] ? "checked" : ""}> ${label}</label>`;
    return `
      ${ui.saveFail ? `<p class="warn">설정을 저장하지 못함(저장 공간이 찼거나 막혀 있음). 이 화면을 닫으면 설정이 처음 값으로 돌아감.</p>` : ""}
      <h2>조립할 때 RisuAI가 채우는 자리(슬롯)는</h2>
      ${radio("slots", "mark", "<code>[[이름]]</code>으로 표시해 둠")}
      ${radio("slots", "blank", "그냥 비움")}
      <h2 style="margin-top:20px">글에 넣을 것</h2>
      ${check("headers", "블록 이름 줄(### 이름) 넣기")}
      ${check("lore", "카드·모듈의 로어북 이어 붙이기")}
      ${check("strip", "로어북 지시어 줄(@@depth, @@unrecursive 등) 지우기")}
      <p class="hint">로어북은 전부 이어 붙이면 실제 대화에서 AI에 가는 글과 다름. 실제로는 키워드에 걸린 항목만 들어감.</p>
      <h2 style="margin-top:20px">데이터</h2>
      <p class="hint">저장되는 것은 위 설정뿐. 불러온 파일 ${files.length}묶음은 메모리에만 있음.</p>
      <button class="ghost" id="closeAll" ${files.length ? "" : "disabled"}>불러온 파일 모두 닫기</button>
      <button class="danger" id="reset">설정 처음 값으로</button>`;
  },
};

// 긴 글은 화면에 일부만 그린다(폰이 느려짐). 복사·저장은 전체.
const SHOW = 12000;
function textBox(key, text, extra = "") {
  copyBuf[key] = text;
  const shown = text.length > SHOW ? text.slice(0, SHOW) : text;
  return `
    <pre class="out">${esc(shown)}</pre>
    ${text.length > SHOW ? `<p class="hint">전체 ${num(text.length)}자 중 앞 ${num(SHOW)}자만 보임. 복사·저장은 전체.</p>` : `<p class="hint">${num(text.length)}자</p>`}
    <div class="btns">
      <button data-act="copy" data-key="${key}">전체 복사</button>
      ${extra}
    </div>`;
}

function outlineView(n) {
  if (n.kind === "zip") {
    return `<h2>묶음 안의 파일 ${n.children.length}개</h2><ul class="list">${n.children.map((c) => `
      <li><a class="row item" href="#/view/${c.id}">
        <span class="badge k-${c.kind}">${esc(c.label)}</span><span class="text">${esc(c.name)}</span><span class="sz">${size(c.size)}</span>
      </a>${c.note ? `<p class="hint pad">${esc(c.note)}</p>` : ""}</li>`).join("")}</ul>`;
  }
  return outline(n).map((sec) => {
    const rows = sec.rows.length > 60 ? sec.rows.slice(0, 60) : sec.rows;
    return `<section><h2>${esc(sec.title)}</h2><div class="kv">${rows.map(([k, v]) => `
      <div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join("")}</div>
      ${sec.rows.length > 60 ? `<p class="hint">…외 ${sec.rows.length - 60}줄은 줄임</p>` : ""}</section>`;
  }).join("");
}

function asmView(n, text) {
  const hasSlot = n.kind === "preset";
  const filename = esc(n.name.replace(/[\\/:*?"<>|]/g, "_"));
  return `
    ${hasSlot ? `<p class="hint"><code>[[…]]</code>는 RisuAI가 채우는 자리, <code>{{…}}</code>는 RisuAI 매크로. 매크로는 풀지 않고 그대로 둠(RisuAI와 결과가 다름).</p>` : ""}
    ${n.kind === "card" || n.kind === "module" ? `<p class="hint">로어북 포함 여부와 지시어 지우기는 설정에서 바꿈.</p>` : ""}
    ${text.trim() ? textBox("asm", text, `<button class="ghost" data-act="save" data-key="asm" data-name="${filename}.md">.md로 저장</button>`) : `<p class="empty">조립할 글이 없음.</p>`}`;
}

function jjalView(n) {
  const r = forJjal(n, store.data.settings);
  const pieces = r.pieces.map((p, i) => `<h2>${esc(p.title)}</h2>${textBox("jj" + i, p.text)}`).join("");
  const q = ui.loreQ.trim().toLowerCase();
  const lore = !q ? r.lore : r.lore.filter((e) => (e.name + " " + e.keys.join(" ") + " " + e.content).toLowerCase().includes(q));
  return `
    <p class="hint">짤뽑기에는 파일 가져오기가 없어서, 붙여 넣을 글을 칸별로 만들어 줌. 복사해서 짤뽑기 해당 칸에 붙여 넣기.</p>
    ${r.note ? `<p class="hint">${esc(r.note)}</p>` : ""}
    ${pieces}
    ${r.lore.length ? `
      <h2>로어북 항목 ${num(r.lore.length)}개 — 비서 지시문 조각(내 조각)으로 복사</h2>
      <input id="loreQ" type="text" placeholder="이름·키워드·내용에서 찾기" value="${esc(ui.loreQ)}" autocomplete="off">
      <div id="lore">${loreList(n, lore)}</div>` : ""}`;
}

function loreList(n, lore) {
  const shown = lore.slice(0, ui.loreShow);
  shown.forEach((e) => { copyBuf["lr" + e.i] = loreText(e, store.data.settings); });
  return `
    <p class="hint">${num(lore.length)}개 중 ${num(shown.length)}개 보임</p>
    <ul class="list">${shown.map((e) => `
      <li class="row lore">
        <div class="text"><b>${esc(e.name || "(이름 없음)")}</b>${e.always ? ' <span class="badge">상시</span>' : ""}
          <div class="hint">${esc(e.keys.slice(0, 6).join(", "))} · ${num(e.content.length)}자</div></div>
        <button class="ghost small" data-act="copy" data-key="lr${e.i}">복사</button>
      </li>`).join("")}</ul>
    ${lore.length > shown.length ? `<button class="ghost" data-act="more">더 보기</button>` : ""}`;
}

// ── 라우터 ──────────────────────────────────────────────────
const parts = () => location.hash.replace(/^#\/?/, "").split("/");
const route = () => (parts()[0] || "list");

function render() {
  const [name, id, sub] = parts();
  const screen = SCREENS[name] ? name : "list";
  const warn = ui.saveFail && screen !== "settings" ? `<p class="warn">설정을 저장하지 못함. 닫으면 처음 값으로 돌아감.</p>` : "";
  document.getElementById("screen").innerHTML = warn + SCREENS[screen](id, sub);
  const node = screen === "view" ? byId.get(id) : null;
  document.getElementById("title").textContent =
    screen === "view" ? (node ? "내용 보기" : "없음") : { list: "해체기", add: "파일 열기", settings: "설정" }[screen];
  document.getElementById("count").textContent = screen === "list" && files.length ? `${files.length}묶음` : "";
  const tab = screen === "view" ? "list" : screen;
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  wire(screen);
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("on"), 1800);
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.cssText = "position:fixed;opacity:0;top:0";
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* 아래에서 알림 */ }
    ta.remove();
    return ok;
  }
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const MAX_FILE = 150 * 1024 * 1024;

async function openFiles(list) {
  const picked = [...list];
  if (!picked.length) return;
  ui.busy = true;
  const st = document.getElementById("status");
  const made = [];
  for (let i = 0; i < picked.length; i++) {
    const f = picked[i];
    if (st) st.textContent = `읽는 중 ${i + 1}/${picked.length} · ${f.name}`;
    let node;
    if (f.size > MAX_FILE) {
      node = { id: "big" + Date.now() + i, name: f.name, size: f.size, kind: "error", label: "읽기 실패", note: "150MB를 넘어서 열지 않음" };
    } else {
      try { node = await parseFile(f.name, new Uint8Array(await f.arrayBuffer())); }
      catch (e) { node = { id: "e" + Date.now() + i, name: f.name, size: f.size, kind: "error", label: "읽기 실패", note: e.message }; }
    }
    made.push(node);
  }
  ui.busy = false;
  for (const n of made.reverse()) { files.unshift(n); indexNode(n); }
  location.hash = made.length === 1 ? `#/view/${made[0].id}` : "#/list"; // 열기 화면에서 오므로 해시가 바뀌어 hashchange가 그린다
}

function wire(screen) {
  if (screen === "add") {
    document.getElementById("file").addEventListener("change", (e) => openFiles(e.target.files));
  }
  if (screen === "settings") {
    document.querySelectorAll("#screen input").forEach((el) => el.addEventListener("change", () => {
      const s = store.data.settings;
      if (el.type === "radio") s[el.name] = el.value;
      else s[el.name] = el.checked;
      memo.clear();
      store.save();
    }));
    document.getElementById("closeAll").addEventListener("click", () => {
      if (!confirm("불러온 파일을 모두 닫음. 다시 보려면 파일을 다시 골라야 함.")) return;
      files.length = 0; byId.clear(); memo.clear(); render();
    });
    document.getElementById("reset").addEventListener("click", () => {
      if (confirm("설정을 처음 값으로 되돌림.")) { memo.clear(); store.reset(); }
    });
  }
  if (screen === "view") {
    const q = document.getElementById("loreQ");
    if (q) {
      q.addEventListener("input", () => {
        ui.loreQ = q.value; ui.loreShow = 30;
        const n = byId.get(parts()[1]);
        const r = forJjal(n, store.data.settings);
        const s = ui.loreQ.trim().toLowerCase();
        const lore = !s ? r.lore : r.lore.filter((e) => (e.name + " " + e.keys.join(" ") + " " + e.content).toLowerCase().includes(s));
        document.getElementById("lore").innerHTML = loreList(n, lore);
      });
    }
  }
}

document.getElementById("screen").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "copy") toast((await copyText(copyBuf[btn.dataset.key] ?? "")) ? "복사함" : "복사 못 함. 글을 길게 눌러 직접 선택");
  else if (act === "save") download(btn.dataset.name || "해체기.md", copyBuf[btn.dataset.key] ?? "");
  else if (act === "drop") {
    const i = files.findIndex((f) => f.id === btn.dataset.id);
    if (i >= 0) { files.splice(i, 1); byId.clear(); files.forEach(indexNode); memo.clear(); render(); }
  } else if (act === "more") {
    ui.loreShow += 30;
    const n = byId.get(parts()[1]);
    const r = forJjal(n, store.data.settings);
    const s = ui.loreQ.trim().toLowerCase();
    const lore = !s ? r.lore : r.lore.filter((e) => (e.name + " " + e.keys.join(" ") + " " + e.content).toLowerCase().includes(s));
    document.getElementById("lore").innerHTML = loreList(n, lore);
  }
});

addEventListener("hashchange", () => { ui.loreQ = ""; ui.loreShow = 30; render(); window.scrollTo(0, 0); });
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
