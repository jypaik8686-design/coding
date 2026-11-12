// {{앱이름}} — 화면 세 개(목록·추가·설정)와 데이터 한 덩어리로 시작하는 틀.
// 바꿀 곳: SHAPE(데이터 모양), SCREENS(화면). 라우터와 저장은 건드릴 일 없음.

const KEY = "{{앱이름}}/v1";

// ── 데이터 모양 ──────────────────────────────────────────────
// 항목 하나: { id, text, done, at }
const SHAPE = () => ({ items: [], settings: { hideDone: false } });

const store = {
  data: load(),
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
    catch (e) { console.warn("저장 실패", e); }
    render();
  },
  add(text) {
    this.data.items.unshift({ id: crypto.randomUUID(), text, done: false, at: Date.now() });
    this.save();
  },
  toggle(id) {
    const it = this.data.items.find((i) => i.id === id);
    if (it) { it.done = !it.done; this.save(); }
  },
  remove(id) {
    this.data.items = this.data.items.filter((i) => i.id !== id);
    this.save();
  },
  reset() { this.data = SHAPE(); this.save(); },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...SHAPE(), ...JSON.parse(raw) } : SHAPE();
  } catch { return SHAPE(); }
}

// ── 화면 ────────────────────────────────────────────────────
const SCREENS = {
  list() {
    const { items, settings } = store.data;
    const shown = settings.hideDone ? items.filter((i) => !i.done) : items;
    if (!shown.length) return `<p class="empty">아직 없음.<br>아래 ‘추가’로 하나 넣어 보기.</p>`;
    return `<ul class="list">${shown.map(row).join("")}</ul>`;
  },

  add() {
    return `
      <form id="addForm">
        <label for="text">무엇을</label>
        <input id="text" name="text" type="text" autocomplete="off"
               enterkeyhint="done" placeholder="한 줄로" required>
        <button type="submit">넣기</button>
        <p class="hint">넣으면 목록으로 돌아감.</p>
      </form>`;
  },

  settings() {
    const { items, settings } = store.data;
    return `
      <h2>보기</h2>
      <label class="row" style="display:flex;gap:10px;align-items:center">
        <input type="checkbox" id="hideDone" ${settings.hideDone ? "checked" : ""}
               style="width:22px;height:22px">
        끝낸 것 숨기기
      </label>
      <h2 style="margin-top:20px">데이터</h2>
      <p class="hint">${items.length}개가 이 기기에만 저장돼 있음.</p>
      <button class="ghost" id="export">내보내기 (JSON)</button>
      <button class="danger" id="reset">전부 지우기</button>`;
  },
};

const row = (i) => `
  <li class="row ${i.done ? "done" : ""}" data-id="${i.id}">
    <button class="check" data-act="toggle" aria-label="${i.done ? "안 끝남으로" : "끝냄으로"}">✓</button>
    <span class="text">${esc(i.text)}</span>
    <time datetime="${new Date(i.at).toISOString()}">${when(i.at)}</time>
    <button class="check" data-act="remove" aria-label="지우기" style="color:var(--dim)">✕</button>
  </li>`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function when(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
  return new Date(ts).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

// ── 라우터 ──────────────────────────────────────────────────
const TITLES = { list: "{{앱이름}}", add: "추가", settings: "설정" };
const route = () => (location.hash.replace(/^#\/?/, "") || "list").split("/")[0];

function render() {
  const name = SCREENS[route()] ? route() : "list";
  document.getElementById("screen").innerHTML = SCREENS[name]();
  document.getElementById("title").textContent = TITLES[name];
  const left = store.data.items.filter((i) => !i.done).length;
  document.getElementById("count").textContent = name === "list" && left ? `${left}개 남음` : "";
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  wire(name);
}

function wire(name) {
  if (name === "add") {
    const f = document.getElementById("addForm");
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = f.text.value.trim();
      if (!v) return;
      store.add(v);
      location.hash = "#/list";
    });
    f.text.focus();
  }
  if (name === "settings") {
    document.getElementById("hideDone").addEventListener("change", (e) => {
      store.data.settings.hideDone = e.target.checked;
      store.save();
    });
    document.getElementById("export").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(store.data, null, 2)],
        { type: "application/json" }));
      a.download = "{{앱이름}}.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    document.getElementById("reset").addEventListener("click", () => {
      if (confirm("전부 지움. 되돌릴 수 없음.")) store.reset();
    });
  }
}

document.getElementById("screen").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest("[data-id]").dataset.id;
  if (btn.dataset.act === "toggle") store.toggle(id);
  if (btn.dataset.act === "remove") store.remove(id);
});

addEventListener("hashchange", render);
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
