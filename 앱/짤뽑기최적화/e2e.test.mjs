// 짤뽑기최적화 화면 시험. 돌리기: node --test coding/앱/짤뽑기최적화/e2e.test.mjs
// 2026-11-27 사용자 "하드코딩, 결함 체크 테스트": 이 세션에서 넣은 기능을 크로미움(390x844)으로 눌러 본다.
// 제미니·NovelAI는 가짜 응답으로 대신한다(밖으로 안 나가고 돈이 안 든다). coding/ 폴더를 이 파일이 직접 띄운다.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
// ESM import는 전역에 깐 playwright를 못 찾아서 require로 부른다 (coding/tools/shot.mjs와 같음)
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."); // coding/
const KEY = "짤뽑기최적화/v1";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png" };
let server, base, browser;

test.before(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = fs.existsSync(f) && fs.statSync(f).isDirectory() ? path.join(f, "index.html") : f;
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/앱/짤뽑기최적화/`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); server?.close(); });

// seed: 처음 저장 데이터(한 번만 심음). reply: 가짜 비서 답(글 또는 함수). 돌려주는 것: page, 오류 목록, 비서에게 간 요청들, 뽑기 요청들
async function open(seed = {}, reply = "응") {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs = [], asks = [], gens = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/status of 500/.test(m.text())) errs.push(m.text()); });
  await p.route(/generativelanguage/, (r) => { const b = JSON.parse(r.request().postData()); asks.push(b); const t = typeof reply === "function" ? reply(asks.length, b) : reply; r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }) }); });
  await p.route(/encode-vibe/, (r) => r.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from("VIBE") }));
  await p.route(/generate-image/, (r) => { gens.push(JSON.parse(r.request().postData())); r.fulfill({ status: 500, body: "test" }); });
  await p.route(/danbooru/, (r) => r.abort());
  await p.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem("seeded", "1"); } }, [KEY, seed]);
  await p.goto(`${base}#/gen`); await p.waitForTimeout(900);
  const data = () => p.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  const ask = async (q) => { await p.fill("#qask", q); await p.click("#qsend"); await p.waitForSelector(".qreply"); await p.waitForTimeout(200); };
  return { p, errs, asks, gens, data, ask };
}
const slots = { count: "1girl, solo", traits: "blonde hair, red eyes", outfit: "business suit", pose: "standing", bg: "office", rest: "" };

test("칸 읽기: `- outfit:`·`**pose:**`·한국어 칸 이름은 그 칸만 바꾸고 고정 캐릭터는 남긴다", async () => {
  const { p, errs, data, ask } = await open({ settings: { aiKey: "x" }, draft: { slots } }, "```scene\n- outfit: red dress\n**pose:** sitting\n배경: night city\n```");
  await ask("a"); await p.click('.qreply [data-kind="scene"]'); await p.waitForTimeout(200);
  const s = (await data()).draft.slots;
  assert.equal(s.traits, "blonde hair, red eyes"); assert.equal(s.outfit, "red dress"); assert.equal(s.pose, "sitting"); assert.equal(s.bg, "night city");
  assert.deepEqual(errs, []); await p.close();
});

test("칩: 겹친 태그가 있는 칩(Heavy·Light)을 하나 빼도 다른 칩은 켜진 채 남는다", async () => {
  const { p, errs } = await open({});
  const nc = p.locator(".slot:has(#slot-neg) [data-pchip]");
  await nc.nth(0).click(); await nc.nth(1).click(); await nc.nth(0).click(); await p.waitForTimeout(200);
  assert.equal(await nc.nth(1).getAttribute("aria-pressed"), "true");
  assert.deepEqual(errs, []); await p.close();
});

test("칩: 다른 칩에 통째로 든 칩(Heavy ⊂ Human Focus)은 넣지 않으면 꺼져 보인다", async () => {
  const { p, errs } = await open({});
  const nc = p.locator(".slot:has(#slot-neg) [data-pchip]");
  await nc.nth(2).click(); await p.waitForTimeout(200);
  assert.equal(await nc.nth(0).getAttribute("aria-pressed"), "false");
  await nc.nth(0).click(); await p.waitForTimeout(200);
  assert.equal(await nc.nth(0).getAttribute("aria-pressed"), "true");
  assert.deepEqual(errs, []); await p.close();
});

test("배경 깔기: 꺼지면 배경 칸 대신 simple background, 켜면 배경 칸이 간다", async () => {
  const { p, errs } = await open({ draft: { slots } });
  const full = () => p.evaluate(() => document.getElementById("sprevtxt")?.textContent || "");
  assert.match(await full(), /simple background/); assert.doesNotMatch(await full(), /office/);
  await p.click("#bgOn"); await p.waitForTimeout(200);
  assert.match(await full(), /office/);
  assert.deepEqual(errs, []); await p.close();
});

test("그림체 칩: 하나만 켜지고 바꿔 넣어도 작가 태그는 남는다", async () => {
  const { p, errs, data } = await open({ taste: { style: "painterly, artist:foo" } });
  const sb = p.locator(".stylebar [data-pchip]");
  await sb.nth(1).click(); await p.waitForTimeout(200);
  const st = (await data()).taste.style;
  assert.match(st, /artist:foo/); assert.doesNotMatch(st, /^painterly/);
  assert.equal((await sb.evaluateAll((els) => els.filter((e) => e.getAttribute("aria-pressed") === "true"))).length, 1);
  assert.deepEqual(errs, []); await p.close();
});

test("비서 인물: 프리셋 이름이면 그 인물로, 새 인물은 프리셋으로 저장된다", async () => {
  let n = 0;
  const { p, errs, data, ask } = await open({ settings: { aiKey: "x" } }, () => (++n === 1 ? "```person\n키아나\n```" : "```person\nname: 분홍\n1girl, pink hair, twintails, maid, apron\n```"));
  p.on("dialog", (d) => d.accept(d.defaultValue()));
  await ask("키아나로"); await p.click('.qreply [data-kind="person"]'); await p.waitForTimeout(200);
  assert.match((await data()).draft.slots.traits, /silver hair/);
  await ask("새 인물"); await p.click('.qreply [data-kind="person"]'); await p.click(".qreply [data-pcsave]"); await p.waitForTimeout(300);
  const d = await data();
  assert.equal(d.presets[0].name, "분홍"); assert.match(d.presets[0].outfit, /maid/); assert.doesNotMatch(d.presets[0].text, /maid/);
  assert.deepEqual(errs, []); await p.close();
});

test("인물 모두 넣기: 인물이 든 장면 블록 둘은 인물별 프롬프트에 한 명씩 들어간다", async () => {
  const { p, errs, data, ask } = await open({ settings: { aiKey: "x", model: "nai-diffusion-4-5-full" } }, "```scene\ncount: 1girl\ntraits: pink hair\noutfit: maid\npose: standing\n```\n```scene\ncount: 1boy\ntraits: black hair\noutfit: suit\n```");
  await ask("둘"); await p.click(".qreply [data-blkall]"); await p.waitForTimeout(300);
  const d = (await data()).draft;
  assert.equal(d.slots.count, "1girl, 1boy"); assert.equal(d.chars.length, 2); assert.equal(d.slots.traits, "");
  assert.deepEqual(errs, []); await p.close();
});

test("비서 설정: 시드·크기·모델을 바꾸고 되돌리기로 돌아온다, v4는 V4.5로 읽지 않는다", async () => {
  let n = 0;
  const { p, errs, data, ask } = await open({ settings: { aiKey: "x" } }, () => (++n === 1 ? '```params\n{"seed": 123, "width": 1000, "height": 1500, "model": "v4.5"}\n```' : "```params\nmodel: v4\n```"));
  await ask("a"); await p.click('.qreply [data-kind="params"]'); await p.waitForTimeout(200);
  let d = await data();
  assert.equal(d.draft.seed, 123); assert.equal(d.settings.customW, 1024); assert.equal(d.settings.customH, 1472); assert.equal(d.settings.model, "nai-diffusion-4-5-full");
  await p.getByRole("button", { name: "되돌리기" }).first().click(); await p.waitForTimeout(200);
  d = await data(); assert.equal(d.draft.seed, null); assert.equal(d.settings.model, "nai-diffusion-5-full");
  await ask("b"); await p.click('.qreply [data-kind="params"]'); await p.waitForTimeout(200);
  assert.equal((await data()).settings.model, "nai-diffusion-5-full");
  assert.deepEqual(errs, []); await p.close();
});

test("비서 요청: 차단 기준 끔, 지난 태그 검색 결과는 한 줄로, 평소 질문에는 서랍 목록이 안 간다", async () => {
  const big = "[태그 검색 결과] (앱이 찾음)\n‘silver hair’: " + "silver trim(2), ".repeat(40);
  const { errs, asks, ask } = await open({ settings: { aiKey: "x" }, chat: [{ role: "user", text: "q", at: 1 }, { role: "model", text: "a", at: 2 }, { role: "user", text: big, at: 3 }, { role: "model", text: "b", at: 4 }] });
  await ask("앉게");
  const b = asks[0];
  assert.ok(b.safetySettings.every((x) => x.threshold === "OFF"));
  assert.equal(b.contents[2].parts[0].text, "[태그 검색 결과 생략: silver hair]");
  assert.doesNotMatch(b.systemInstruction.parts[0].text, /고를 때는 refs 블록/);
  assert.deepEqual(errs, []);
});

// 시험 바꾼 이유: 사용자가 뽑기 전 점검이 멈춰 세우는 것을 싫어함(2026-11-27). 처음엔 끄고, 켜도 멈추지 않고 알림만.
test("뽑기 전 점검: 처음엔 꺼져 있어 바로 뽑고, 켜면 멈추지 않고 알림만 띄운다", async () => {
  const { p, errs, gens } = await open({ settings: { token: "pst-x" }, draft: { slots: { ...slots, count: "1girl, solo, 2girls" } } });
  await p.click("#go"); await p.waitForTimeout(800);
  assert.equal(gens.length, 1); assert.equal(await p.locator(".diag").count(), 0);
  await p.evaluate((k) => { const x = JSON.parse(localStorage.getItem(k)); x.settings.preCheck = true; x.draft.slots.pose = "kneeling"; localStorage.setItem(k, JSON.stringify(x)); }, KEY);
  await p.reload(); await p.waitForTimeout(900);
  await p.click("#go"); await p.waitForTimeout(800);
  assert.equal(gens.length, 2); assert.match(await p.locator(".toast").innerText().catch(() => ""), /점검: \d+개 걸림|뽑기 실패/);
  assert.deepEqual(errs, []); await p.close();
});

test("모든 화면: 콘솔 오류가 없고 폰 폭(390)을 넘치지 않는다", async () => {
  const { p, errs } = await open({ settings: { aiKey: "x" }, draft: { slots } });
  for (const r of ["gen", "ai", "keep", "vault", "taste", "set"]) {
    await p.evaluate((h) => { location.hash = h; }, `#/${r}`); await p.waitForTimeout(400);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > 390), false, `${r} 화면이 옆으로 넘침`);
  }
  assert.deepEqual(errs, []); await p.close();
});

// 시험용 PNG (한 가지 색, 가로세로 n). 앱은 너무 작은 그림을 서랍에 안 넣어서 64로 쓴다.
import zlib from "node:zlib";
function pngOf(n) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(n, 0); ih.writeUInt32BE(n, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.concat(Array.from({ length: n }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(n * 3, 0x60)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ── 종합 점검 (2026-11-27 사용자: 종합 점검 및 개선): 실제 폰에서 터질 만한 저장 데이터 ──
async function openRaw(raw) {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await p.addInitScript(([k, v]) => { if (!sessionStorage.getItem("seeded")) { if (v != null) localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, [KEY, raw]);
  const t0 = Date.now(); await p.goto(`${base}#/gen`); await p.waitForSelector("#go", { timeout: 8000 }).catch(() => {}); const ms = Date.now() - t0;
  return { p, errs, ms };
}
for (const [name, raw] of [
  ["저장 데이터 없음", null],
  ["망가진 저장 데이터(JSON 아님)", "{이건 JSON이 아님"],
  ["옛 꼴(칸 없이 scene 글만, 새 칸 없음)", JSON.stringify({ settings: { token: "", model: "nai-diffusion-4-5-full" }, taste: { style: "painterly" }, draft: { scene: "1girl, solo, red dress, sitting, office" }, log: [{ id: "a", scene: "1girl", seed: 1, verdict: "keep", at: 1 }], presets: [{ id: "p1", name: "옛 프리셋", text: "1girl, silver hair, maid", to: "scene" }], chat: [{ role: "user", text: "옛 질문" }, { role: "model", text: "옛 답\n```scene\n1girl, smile\n```" }] })],
  ["값 꼴이 틀림(숫자 자리에 글, 배열 자리에 null)", JSON.stringify({ settings: { steps: "많이", scale: null, size: "없는크기", customW: "x" }, draft: { slots: null, chars: null, neg: 3 }, chat: null, presets: "x", log: {} })],
]) {
  test(`저장 데이터: ${name} — 열리고 뽑기 버튼이 보이며 콘솔 오류가 없다`, async () => {
    const { p, errs } = await openRaw(raw);
    assert.equal(await p.locator("#go").count(), 1, "뽑기 버튼이 안 보임");
    for (const r of ["ai", "keep", "taste", "set", "gen"]) { await p.evaluate((h) => { location.hash = h; }, `#/${r}`); await p.waitForTimeout(250); }
    assert.deepEqual(errs, []); await p.close();
  });
}
test("많이 쌓인 데이터(기록 400·대화 40·프리셋 60): 열리고, 칩 하나 누르는 데 폰 기준(CPU 4배 느리게) 0.4초 안", async () => {
  const log = Array.from({ length: 400 }, (_, i) => ({ id: `l${i}`, scene: "1girl, solo, smile", style: "painterly", seed: i, verdict: i % 3 ? "drop" : "keep", at: 1e12 + i, w: 832, h: 1216, steps: 28, scale: 5, model: "nai-diffusion-5-full" }));
  const chat = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: i % 2 ? "답\n```scene\npose: sitting\n```" : `질문 ${i}`, at: i }));
  const presets = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `내 자세 ${i}`, text: `pose${i}, sitting`, to: "scene", kind: "자세·구도", slot: "pose" }));
  const { p, errs } = await openRaw(JSON.stringify({ log, chat, presets }));
  const cdp = await p.context().newCDPSession(p); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const chip = p.locator(".slot:has(#slot-pose) [data-pchip]").first();
  const t0 = Date.now(); await chip.click(); await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))); const ms = Date.now() - t0;
  assert.ok(ms < 400, `칩 하나에 ${ms}ms`);
  assert.deepEqual(errs, []); await p.close();
});
test("그림 저장(IndexedDB)이 실패하면 알리고 화면 위에 경고가 뜬다", async () => {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.addInitScript(([k]) => {
    if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, JSON.stringify({ settings: { model: "nai-diffusion-4-5-full" } })); sessionStorage.setItem("seeded", "1"); }
    const put = IDBObjectStore.prototype.put; // 서랍(ref)에 쓰는 것만 실패시킨다 (저장 공간이 찬 것처럼)
    IDBObjectStore.prototype.put = function (...a) { const q = put.apply(this, a); if (this.name === "ref") queueMicrotask(() => { try { this.transaction.abort(); } catch {} }); return q; };
  }, [KEY]);
  await p.goto(`${base}#/gen`); await p.waitForTimeout(900);
  await p.locator('button.tool[data-tool="ref"]').click(); await p.waitForTimeout(200);
  const png = pngOf(64);
  await p.setInputFiles("#refFile", { name: "a.png", mimeType: "image/png", buffer: png });
  await p.waitForFunction(() => /저장이 실패했음/.test(document.getElementById("screen").innerText), null, { timeout: 5000 }).catch(() => {});
  const scr = await p.locator("#screen").innerText();
  assert.match(scr, /저장이 실패했음/, `화면: ${scr.slice(0, 200)} | 알림: ${await p.locator(".toast").innerText().catch(() => "없음")}`);
  assert.deepEqual(errs, []); await p.close();
});
test("처음 기본값: 기본 그림체와 기본 빼는 것이 서로 지우는 태그가 없다", async () => {
  const { p, errs } = await open({});
  await p.click("#go"); await p.waitForTimeout(400);
  const txt = await p.locator(".diag").innerText().catch(() => "");
  assert.doesNotMatch(txt, /기본 빼는 것에 둘 다/);
  assert.deepEqual(errs, []); await p.close();
});
test("보관함 프리셋으로 찾기: 그 프리셋 태그가 다 든 그림만 보인다", async () => {
  const rec = (id, scene) => ({ id, scene, style: "", negative: "", seed: 1, verdict: "keep", at: 1e12, w: 832, h: 1216, steps: 28, scale: 5, model: "nai-diffusion-5-full" });
  const { p, errs } = await open({ presets: [{ id: "m1", name: "메이드", text: "maid, apron", to: "scene", kind: "의상", slot: "outfit" }],
    log: [rec("a", "1girl, {maid}, apron, smile"), rec("b", "1girl, maid, apron, sitting"), rec("c", "1girl, suit"), ...Array.from({ length: 5 }, (_, i) => rec(`x${i}`, "1girl, dress"))] });
  await p.evaluate(() => { location.hash = "#/keep"; }); await p.waitForTimeout(500);
  await p.selectOption("#kpreset", "own:m1"); await p.waitForTimeout(200);
  const shown = await p.locator(".kgrid a[data-thumb]:not([hidden])").evaluateAll((els) => els.map((e) => e.dataset.thumb).sort());
  assert.deepEqual(shown, ["a", "b"]);
  assert.match(await p.locator("#kqN").innerText(), /2장 찾음/);
  assert.deepEqual(errs, []); await p.close();
});
test("태그 사전: 뽑기 화면에서 찾고 눌러 맞는 칸에 넣는다, 비서 검색 결과도 대화에서 눌러 넣는다", async () => {
  const res = "[태그 검색 결과] (앱이 찾음)\n‘은발’: 앱 사전: 은발 → grey hair, white hair | 비슷한 태그: grey hair(312,000), silver trim(2,253)\n이 결과로 고른 태그를 블록으로 내 줘.";
  const { p, errs, data } = await open({ settings: { aiKey: "x" }, draft: { slots }, chat: [{ role: "user", text: "은발", at: 1 }, { role: "model", text: "```search\n은발\n```", at: 2 }, { role: "user", text: res, at: 3 }, { role: "model", text: "grey hair로.", at: 4 }] });
  await p.locator('button.tool[data-tool="dict"]').click(); await p.waitForTimeout(300);
  await p.fill("#dq", "smile"); await p.waitForTimeout(1500);
  await p.locator('#dres [data-dadd="smile"]').first().click(); await p.waitForTimeout(200);
  assert.match((await data()).draft.slots.traits, /smile/);
  await p.evaluate(() => { location.hash = "#/ai"; }); await p.waitForTimeout(500);
  const card = p.locator(".msg.srch"); assert.equal(await card.count(), 1);
  await card.locator("summary").click(); await card.locator('[data-tagadd="grey hair"]').click(); await p.waitForTimeout(200);
  assert.match((await data()).draft.slots.traits, /grey hair/);
  assert.deepEqual(errs, []); await p.close();
});
test("그 밖에 칸 ‘칸마다 나누기’: 아는 태그는 맞는 칸으로, 모르는 태그만 남고 되돌리기로 돌아온다", async () => {
  const { p, errs, data } = await open({ draft: { slots: { ...slots, rest: "red dress, sitting, night sky, zzqtag" } } });
  await p.click("#restSplit"); await p.waitForTimeout(200);
  let s = (await data()).draft.slots;
  assert.match(s.outfit, /red dress/); assert.match(s.pose, /sitting/); assert.match(s.bg, /night sky/); assert.equal(s.rest, "zzqtag");
  await p.getByRole("button", { name: "되돌리기" }).first().click(); await p.waitForTimeout(200);
  s = (await data()).draft.slots; assert.equal(s.rest, "red dress, sitting, night sky, zzqtag"); assert.equal(s.outfit, "business suit");
  assert.deepEqual(errs, []); await p.close();
});
test("설정의 ‘그림 zip 내보내기’가 오류 없이 돈다 (고른 것만 zip 기능을 넣으며 깨졌던 것)", async () => {
  const { p, errs } = await open({ log: [{ id: "a", scene: "1girl", seed: 1, verdict: "keep", at: 1 }] });
  await p.evaluate(() => { location.hash = "#/set"; }); await p.waitForTimeout(400);
  await p.evaluate(() => document.getElementById("exportImg").click()); await p.waitForTimeout(600);
  assert.deepEqual(errs, []);
  assert.match(await p.locator(".toast").innerText(), /그림|보관/);
  await p.close();
});
