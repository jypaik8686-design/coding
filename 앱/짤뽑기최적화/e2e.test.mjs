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

test("뽑기 전 점검: 프롬프트가 바뀐 뒤 첫 뽑기는 멈추고, 한 번 더 누르면 뽑는다", async () => {
  const { p, errs, gens } = await open({ settings: { token: "pst-x" }, draft: { slots: { ...slots, count: "1girl, solo, 2girls" } } });
  await p.click("#go"); await p.waitForTimeout(500);
  assert.equal(gens.length, 0); assert.equal(await p.locator(".diag").count(), 1);
  await p.click("#go"); await p.waitForTimeout(800);
  assert.equal(gens.length, 1);
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
