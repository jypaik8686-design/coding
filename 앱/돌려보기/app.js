// 돌려보기 — 사진 한 장을 고르면 깊이를 계산해 시점을 움직여 보여 준다.
// 1) 사진을 폰 안에서 줄여 읽는다  2) 깊이 모델(transformers.js)로 깊이맵을 만든다
// 3) WebGL 셰이더가 깊이만큼 화소를 어긋나게 그려 입체처럼 보이게 한다.
// 사진은 어디에도 올라가지 않는다. 모델 파일만 밖에서 받는다(처음 한 번, 이후 브라우저가 저장).

const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0";
const MODEL = "Xenova/depth-anything-small-hf";
const MAX_SIDE = 1024; // 긴 변 상한. 폰 사진(4000px)을 그대로 올리면 메모리가 터진다
const KEY = "돌려보기:세기";

const $ = (s) => document.querySelector(s);
const el = {
  empty: $("#empty"), view: $("#view"), ctl: $("#ctl"), msg: $("#msg"), canvas: $("#gl"),
  file: $("#file"), file2: $("#file2"), amp: $("#amp"), sensor: $("#sensor"), depthview: $("#depthview"),
};

const S = {
  tx: 0, ty: 0,        // 목표 시점 (-1..1)
  x: 0, y: 0,          // 지금 시점 (부드럽게 따라감)
  amp: 0.05, depthView: false, sensorOn: false,
  dragging: false, lastTouch: 0, ready: false, job: 0,
};
try { const v = parseFloat(localStorage.getItem(KEY)); if (v >= 0.02 && v <= 0.14) S.amp = v; } catch {}
el.amp.value = S.amp;

function say(t) { el.msg.textContent = t; }

// ---------- 사진 읽기 ----------
async function readImage(file) {
  // 아이폰 사진의 회전 정보를 지키며 읽는다
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    bmp = await new Promise((ok, no) => {
      const im = new Image(); const u = URL.createObjectURL(file);
      im.onload = () => { URL.revokeObjectURL(u); ok(im); };
      im.onerror = () => { URL.revokeObjectURL(u); no(new Error("이 파일은 그림으로 못 읽음")); };
      im.src = u;
    });
  }
  const w0 = bmp.width, h0 = bmp.height;
  const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(w0 * k)); c.height = Math.max(2, Math.round(h0 * k));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}

// ---------- 깊이 ----------
let depthPipe = null;
async function modelDepth(canvas) {
  if (!depthPipe) {
    const { pipeline, env } = await import(TRANSFORMERS);
    env.allowLocalModels = false;
    depthPipe = await pipeline("depth-estimation", MODEL, {
      progress_callback: (p) => {
        if (p.status === "progress" && p.total > 1e6) say(`깊이 모델 받는 중… ${Math.round(p.loaded / p.total * 100)}%`);
      },
    });
  }
  say("깊이 계산 중…");
  const blob = await new Promise((ok) => canvas.toBlob(ok, "image/png"));
  const url = URL.createObjectURL(blob);
  try {
    const out = await depthPipe(url);
    const d = out.depth; // RawImage, 1채널, 클수록 가까움
    const ch = d.channels || 1, n = d.width * d.height, g = new Uint8Array(n);
    for (let i = 0; i < n; i++) g[i] = d.data[i * ch]; // 1채널만 쓴다
    return { data: g, w: d.width, h: d.height, ch: 1 };
  } finally { URL.revokeObjectURL(url); }
}

// 모델을 못 받을 때의 대비책: 가운데·밝은 곳을 가깝다고 치는 근사. 정확하진 않지만 돌아는 간다
function fakeDepth(canvas) {
  const w = canvas.width, h = canvas.height;
  const px = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const lum = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) / 255;
    const dx = (x / w - 0.5) * 2, dy = (y / h - 0.5) * 2;
    const r = Math.min(1, Math.sqrt(dx * dx * 0.8 + dy * dy));
    out[i] = Math.round(255 * Math.max(0, Math.min(1, (1 - r) * 0.7 + lum * 0.3)));
  }
  return { data: out, w, h, ch: 1 };
}

// 깊이맵의 계단·찢김을 줄이는 상자 흐림 (가로+세로). O(w*h)
function blur(d, r) {
  const { w, h } = d; let a = d.data, b = new Uint8Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    const horiz = pass === 0, n = horiz ? w : h, m = horiz ? h : w;
    for (let l = 0; l < m; l++) {
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) {
          const j = i + k; if (j < 0 || j >= n) continue;
          s += a[horiz ? l * w + j : j * w + l]; c++;
        }
        b[horiz ? l * w + i : i * w + l] = s / c;
      }
    }
    [a, b] = [b, a];
  }
  d.data = a; return d;
}

// ---------- WebGL ----------
const VS = `attribute vec2 p; varying vec2 v; void main(){ v = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;
const FS = `precision mediump float;
varying vec2 v; uniform sampler2D img, dep; uniform vec2 dir; uniform float amp, showDepth;
void main(){
  vec2 uv = (v - 0.5) / 1.08 + 0.5;          // 살짝 키워서 가장자리 빈틈을 가린다
  vec2 o = vec2(0.0);
  for (int i = 0; i < 10; i++) {               // 어긋난 자리의 깊이로 다시 어긋남을 구함
    float d = texture2D(dep, uv + o).r;
    o = dir * amp * (d - 0.45);
  }
  vec2 q = clamp(uv + o, 0.0, 1.0);
  if (showDepth > 0.5) gl_FragColor = vec4(vec3(texture2D(dep, q).r), 1.0);
  else gl_FragColor = vec4(texture2D(img, q).rgb, 1.0);
}`;

let gl, prog, U, texImg, texDep;
function initGL() {
  gl = el.canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("이 브라우저는 WebGL을 못 씀");
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  U = Object.fromEntries(["img", "dep", "dir", "amp", "showDepth"].map((n) => [n, gl.getUniformLocation(prog, n)]));
  texImg = gl.createTexture(); texDep = gl.createTexture();
}
function setTex(t, unit, upload) {
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  upload();
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
}
function upload(canvas, depth) {
  if (!gl) initGL();
  el.canvas.width = canvas.width; el.canvas.height = canvas.height;
  gl.viewport(0, 0, canvas.width, canvas.height);
  setTex(texImg, 0, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, canvas));
  setTex(texDep, 1, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, depth.w, depth.h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, depth.data));
  gl.uniform1i(U.img, 0); gl.uniform1i(U.dep, 1);
  S.ready = true;
}

function frame(t) {
  requestAnimationFrame(frame);
  if (!S.ready) return;
  // 손가락·센서를 안 쓰는 동안은 천천히 흔들려서 입체인 걸 보여 준다
  if (!S.dragging && !S.sensorOn && t - S.lastTouch > 1500) {
    S.tx = Math.sin(t / 1400) * 0.7; S.ty = Math.sin(t / 2100) * 0.35;
  }
  S.x += (S.tx - S.x) * 0.15; S.y += (S.ty - S.y) * 0.15;
  gl.uniform2f(U.dir, S.x, S.y); gl.uniform1f(U.amp, S.amp); gl.uniform1f(U.showDepth, S.depthView ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
requestAnimationFrame(frame);

// ---------- 입력 ----------
const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));
el.canvas.addEventListener("pointerdown", (e) => { S.dragging = true; el.canvas.setPointerCapture(e.pointerId); move(e); });
el.canvas.addEventListener("pointermove", (e) => { if (S.dragging) move(e); });
for (const n of ["pointerup", "pointercancel"]) el.canvas.addEventListener(n, () => { S.dragging = false; S.lastTouch = performance.now(); });
function move(e) {
  const r = el.canvas.getBoundingClientRect();
  S.tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2.4);
  S.ty = clamp(-((e.clientY - r.top) / r.height - 0.5) * 2.4);
  S.lastTouch = performance.now();
}
el.amp.addEventListener("input", () => {
  S.amp = parseFloat(el.amp.value);
  try { localStorage.setItem(KEY, String(S.amp)); } catch {}
});
el.depthview.addEventListener("click", () => {
  S.depthView = !S.depthView; el.depthview.setAttribute("aria-pressed", String(S.depthView));
});

function onTilt(e) {
  if (e.gamma == null || e.beta == null) return;
  S.tx = clamp(e.gamma / 25); S.ty = clamp(-(e.beta - 45) / 25);
}
el.sensor.addEventListener("click", async () => {
  if (S.sensorOn) { S.sensorOn = false; window.removeEventListener("deviceorientation", onTilt); el.sensor.textContent = "기울여 보기"; return; }
  if (!("DeviceOrientationEvent" in window)) { say("이 브라우저엔 기울기 센서가 없음"); return; }
  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const r = await DeviceOrientationEvent.requestPermission(); // 아이폰은 눌러서 허락해야 함
      if (r !== "granted") { say("기울기 센서 허락이 안 됨. 설정에서 모션 접근을 허용해야 함"); return; }
    }
    window.addEventListener("deviceorientation", onTilt);
    S.sensorOn = true; el.sensor.textContent = "기울기 끄기";
  } catch (err) { say("기울기 센서를 못 켬: " + err.message); }
});

// ---------- 흐름 ----------
async function open(file) {
  if (!file) return;
  const job = ++S.job;
  el.empty.hidden = true; el.view.hidden = false; el.ctl.hidden = false; S.ready = false;
  say("사진 읽는 중…");
  let canvas;
  try { canvas = await readImage(file); }
  catch (e) { say("사진을 못 읽음: " + e.message); el.empty.hidden = false; el.view.hidden = true; el.ctl.hidden = true; return; }

  let depth, note = "";
  try { depth = await modelDepth(canvas); }
  catch (e) { console.warn("깊이 모델 실패", e); depth = fakeDepth(canvas); note = "깊이 모델을 못 받아 근사 깊이로 보는 중 (덜 정확함). 인터넷이 되면 다시 고르기"; }
  if (job !== S.job) return; // 그사이 다른 사진을 골랐으면 버린다
  try { upload(canvas, blur(depth, 2)); }
  catch (e) { say("화면에 못 그림: " + e.message); return; }
  say(note || "화면을 손가락으로 끌어 보기");
  window.돌려보기 = { 시점(x, y) { S.dragging = true; S.tx = x; S.ty = y; S.x = x; S.y = y; }, 상태: S }; // 점검용
}
el.file.addEventListener("change", () => open(el.file.files[0]));
el.file2.addEventListener("change", () => open(el.file2.files[0]));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
