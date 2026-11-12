#!/usr/bin/env node
// 폰 화면으로 띄워서 찍는다. 콘솔 오류도 같이 주워 온다.
//
//   node tools/shot.mjs http://127.0.0.1:8000/ --out 화면/지금.png
//   node tools/shot.mjs 앱/할일/index.html --out 화면/파일.png --전체
//   node tools/shot.mjs http://127.0.0.1:8000/ --out 화면/넣고.png \
//        --누르기 ".tabs a[data-tab=add]" --적기 "#text=우유 사기" --누르기 "button[type=submit]"
//   node tools/shot.mjs http://127.0.0.1:8000/ --out 화면/옛데이터.png --심기 화면/옛데이터.json
//   node tools/shot.mjs --비교 화면/전.png 화면/후.png --out 화면/비교.png
//   node tools/shot.mjs --점검          # 브라우저가 열리는지만 본다
//
// 매번 새 브라우저로 연다. 저장된 데이터가 없는 상태에서 시작한다는 뜻이다.
// 이미 데이터가 있는 폰을 흉내 내려면 --심기 로 localStorage를 채우고 연다.
// 심는 파일 꼴: { "<localStorage 키>": <값>, ... }  (값이 글자가 아니면 JSON으로 바꿔 넣는다)

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// playwright는 전역에 깔려 있을 수도, 저장소 안에 깔려 있을 수도 있다.
// ESM import는 NODE_PATH를 보지 않으므로 require로 찾는다.
const require = createRequire(import.meta.url);
let chromium, devices;
try {
  ({ chromium, devices } = require("playwright"));
} catch {
  console.error(
    "playwright를 못 찾음.\n" +
    "  이 저장소에 깔려면:  npm i -D playwright && npx playwright install chromium\n" +
    "  이미 전역에 있으면:  NODE_PATH=$(npm root -g) node tools/shot.mjs ..."
  );
  process.exit(2);
}

const 기본기기 = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

function 인자(argv) {
  const a = { 동작: [], 기다려: 250, 전체: false, out: null, 비교: null, 기기: null, target: null, 엄격: false, 심기: null, 점검: false };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--out" || v === "-o") a.out = argv[++i];
    else if (v === "--비교" || v === "--compare") a.비교 = [argv[++i], argv[++i]];
    else if (v === "--누르기" || v === "--click") a.동작.push({ 종류: "누르기", 셀: argv[++i] });
    else if (v === "--적기" || v === "--fill") {
      const 쌍 = argv[++i] ?? "";
      const 칼 = 쌍.indexOf("=");
      if (칼 < 1) { console.error(`--적기 는 "선택자=값" 꼴로 주세요: ${쌍}`); process.exit(2); }
      a.동작.push({ 종류: "적기", 셀: 쌍.slice(0, 칼), 값: 쌍.slice(칼 + 1) });
    }
    else if (v === "--기다려" || v === "--wait") a.기다려 = Number(argv[++i]);
    else if (v === "--기기" || v === "--device") a.기기 = argv[++i];
    else if (v === "--심기" || v === "--seed") a.심기 = argv[++i];
    else if (v === "--help" || v === "-h") {
      // 이 파일 맨 위의 설명을 그대로 보여 준다
      const 줄 = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
      console.log(줄.slice(0, 줄.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(0);
    }
    else if (v === "--점검" || v === "--check") a.점검 = true;
    else if (v === "--전체" || v === "--full") a.전체 = true;
    else if (v === "--엄격" || v === "--strict") a.엄격 = true;
    else if (v.startsWith("-")) { console.error(`모르는 옵션: ${v}`); process.exit(2); }
    else if (!a.target) a.target = v;
  }
  return a;
}

const 브라우저열기 = () =>
  chromium.launch({
    args: ["--no-sandbox"],
    ...(existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {}),
  });

const 주소로 = (t) =>
  /^https?:\/\/|^file:\/\//.test(t) ? t : pathToFileURL(resolve(t)).href;

async function 찍기(a) {
  if (!a.target) { console.error("찍을 주소나 파일을 주세요"); process.exit(2); }
  if (!a.out) { console.error("--out 으로 저장할 파일을 주세요"); process.exit(2); }
  mkdirSync(dirname(resolve(a.out)), { recursive: true });

  const browser = await 브라우저열기();
  const 설정 = a.기기 ? devices[a.기기] : 기본기기;
  if (a.기기 && !설정) {
    console.error(`그런 기기 없음: ${a.기기}`);
    await browser.close();
    process.exit(2);
  }
  const ctx = await browser.newContext({ ...설정, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  if (a.심기) {
    let 씨;
    try { 씨 = JSON.parse(readFileSync(resolve(a.심기), "utf8")); }
    catch (e) { console.error(`심을 파일을 못 읽음: ${a.심기} — ${e.message}`); await browser.close(); process.exit(2); }
    // 페이지 스크립트보다 먼저 돈다. 이미 있는 키는 덮지 않는다.
    await ctx.addInitScript((씨) => {
      for (const [k, v] of Object.entries(씨)) {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
      }
    }, 씨);
  }
  const page = await ctx.newPage();

  const 오류 = [];
  const 실패 = [];
  page.on("console", (m) => { if (m.type() === "error") 오류.push(m.text()); });
  page.on("pageerror", (e) => 오류.push(`${e.name}: ${e.message}`));
  page.on("requestfailed", (r) => 실패.push(`${r.url()} — ${r.failure()?.errorText ?? "실패"}`));

  let 결과 = 0;
  try {
    const res = await page.goto(주소로(a.target), { waitUntil: "load", timeout: 20000 });
    if (res && !res.ok() && res.status() >= 400) 오류.push(`HTTP ${res.status()}`);
    for (const 동 of a.동작) {
      if (동.종류 === "누르기") await page.click(동.셀, { timeout: 5000 });
      else await page.fill(동.셀, 동.값, { timeout: 5000 });
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(a.기다려);
    await page.screenshot({ path: a.out, fullPage: a.전체 });
    const { width, height } = page.viewportSize();
    const 제목 = await page.title();
    console.log(`찍었음  ${a.out}  ${width}x${height}${a.전체 ? " (전체)" : ""}  «${제목}»`);
  } catch (e) {
    console.error(`못 찍었음: ${e.message}`);
    결과 = 1;
  }

  if (오류.length) {
    console.log(`\n⚠ 콘솔 오류 ${오류.length}개`);
    오류.slice(0, 10).forEach((t) => console.log(`  - ${t}`));
    if (a.엄격) 결과 = 1;
  }
  if (실패.length) {
    console.log(`\n⚠ 못 받아온 파일 ${실패.length}개`);
    실패.slice(0, 10).forEach((t) => console.log(`  - ${t}`));
    if (a.엄격) 결과 = 1;
  }
  if (!오류.length && !실패.length && 결과 === 0) console.log("콘솔 깨끗함");

  await browser.close();
  return 결과;
}

async function 비교(a) {
  const [전, 후] = a.비교;
  for (const f of [전, 후]) {
    if (!existsSync(f)) { console.error(`그런 파일 없음: ${f}`); process.exit(2); }
  }
  if (!a.out) { console.error("--out 으로 저장할 파일을 주세요"); process.exit(2); }
  mkdirSync(dirname(resolve(a.out)), { recursive: true });

  // about:blank 페이지는 file:// 이미지를 못 불러온다. 통째로 박아 넣는다.
  const 박기 = (f) => `data:image/png;base64,${readFileSync(resolve(f)).toString("base64")}`;

  const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; background:#15171a; color:#e9ebee; font:14px/1.4 system-ui, sans-serif; }
  .wrap { display:inline-flex; gap:16px; padding:16px; }
  figure { margin:0; }
  figcaption { padding:0 0 8px; font-weight:600; }
  img { display:block; border:1px solid #2a2e34; border-radius:8px; max-height:1000px; }
</style>
<div class="wrap">
  <figure><figcaption>전 · ${전}</figcaption><img src="${박기(전)}"></figure>
  <figure><figcaption>후 · ${후}</figcaption><img src="${박기(후)}"></figure>
</div>`;

  const browser = await 브라우저열기();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.locator(".wrap").screenshot({ path: a.out });
  console.log(`붙였음  ${a.out}  (왼쪽 ${전}, 오른쪽 ${후})`);
  await browser.close();
  return 0;
}

// 이 세션에서 브라우저가 실제로 열리는지만 본다. tools/ready.py 가 부른다.
async function 점검() {
  try {
    const browser = await 브라우저열기();
    const page = await browser.newPage();
    await page.setContent("<p>ok</p>");
    await browser.close();
    console.log(`playwright ${require("playwright/package.json").version} · 크로미움 열림`);
    return 0;
  } catch (e) {
    console.error(`크로미움이 안 열림: ${e.message.split("\n")[0]}`);
    return 1;
  }
}

const a = 인자(process.argv);
process.exit(await (a.점검 ? 점검() : a.비교 ? 비교(a) : 찍기(a)));
