// risu.js — RisuAI 파일(.risup .risum .charx, 카드 JSON·PNG, 플러그인 .js, zip)을 풀고 읽기 쉬운 글로 만든다.
// 브라우저 내장 기능만 쓴다: DecompressionStream, crypto.subtle, TextDecoder. 빌드 없음. node 22에서도 그대로 돈다.
// 파일 안의 코드는 절대 실행하지 않는다. 글로만 읽는다.
//
// 풀이 순서 (공개 문서 rescuetycoon/risup, 올린 파일로 직접 확인):
//   .risup  RPack 풀기 → gzip 풀기 → msgpack → (presetVersion 0·2) AES-256-GCM(키 SHA-256("risupreset"), iv 0 12바이트) → msgpack
//   .risum  0x6f 0x00 + 길이(u32 LE) + RPack으로 푼 JSON, 뒤에 에셋 덩어리
//   .charx  zip: card.json(chara_card_v3), module.risum, assets/

const RPD_HEX =
  "2cf7848bc965fbb69faeb3032d0169741fe4a3ecee5c3421934a0f6ae262029e229cfd3cfc71c7c6ad596705706d8a4412fa24865fafd17a47cefe5063dd51066f18e052a8099d56734cb8536cc3a00e19cf3e0d7e07326846ea48f9992eaba449205e5535380cbcd3b1581679280a1ae1f2cdc439dba2ba6072767d95ef7fc8c0de3794bfb51481922545ace7f566a72b365ac113e34b3ae88d831b7c27b09a42eb87aadc548e7826d25729d4b7f82f8f8975f04177c21effd81511e5049717f331d09b00d7cab44f2a3bd9b26bda5da13f3061bd913d4ee6dfbe4d828c1d23109864f485337b9043bba988f1d6a51cf6cc6eb95b0b96edd5e9c5cb08a68040";
const RPD = Uint8Array.from(RPD_HEX.match(/../g), (h) => parseInt(h, 16));
if (RPD.length !== 256) throw new Error("RPack 표 길이가 256이 아님");

const MAX_OUT = 300 * 1024 * 1024; // 압축을 풀었을 때 이 크기를 넘으면 멈춘다 (압축 폭탄 방지)
const MAX_DEPTH = 4; // zip 안의 zip을 이만큼만 연다
const td = new TextDecoder("utf-8");

export const rpDecode = (u8) => {
  const o = new Uint8Array(u8.length);
  for (let i = 0; i < u8.length; i++) o[i] = RPD[u8[i]];
  return o;
};

// ── 압축 ────────────────────────────────────────────────────
export async function inflate(u8, fmt) {
  fmt ??= u8[0] === 0x1f && u8[1] === 0x8b ? "gzip"
    : (u8[0] & 0x0f) === 8 && ((u8[0] << 8) | u8[1]) % 31 === 0 ? "deflate" : "deflate-raw";
  const ds = new DecompressionStream(fmt);
  const w = ds.writable.getWriter();
  w.write(u8).catch(() => {});
  w.close().catch(() => {});
  const rd = ds.readable.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    total += value.length;
    if (total > MAX_OUT) { rd.cancel().catch(() => {}); throw new Error("압축을 풀면 너무 큼(300MB 초과)"); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of parts) { out.set(c, p); p += c.length; }
  return out;
}

// ── msgpack (읽기만) ────────────────────────────────────────
export function unpack(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const need = (n) => { if (p + n > u8.length) throw new Error("msgpack이 중간에 끊김"); };
  const big = (v) => (v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString());
  const str = (n) => { need(n); const s = td.decode(u8.subarray(p, p + n)); p += n; return s; };
  const bin = (n) => { need(n); const b = u8.slice(p, p + n); p += n; return b; };
  const arr = (n, d) => { const a = []; for (let i = 0; i < n; i++) a.push(rd(d + 1)); return a; };
  const map = (n, d) => {
    const o = Object.create(null);
    for (let i = 0; i < n; i++) { const k = rd(d + 1); o[String(k)] = rd(d + 1); }
    return o;
  };
  const u16 = () => { need(2); const v = dv.getUint16(p); p += 2; return v; };
  const u32 = () => { need(4); const v = dv.getUint32(p); p += 4; return v; };
  function rd(d) {
    if (d > 200) throw new Error("msgpack이 너무 깊음");
    need(1);
    const t = u8[p++];
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 256;
    if (t >= 0xa0 && t <= 0xbf) return str(t & 31);
    if (t >= 0x90 && t <= 0x9f) return arr(t & 15, d);
    if (t >= 0x80 && t <= 0x8f) return map(t & 15, d);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: need(1); return bin(u8[p++]);
      case 0xc5: return bin(u16());
      case 0xc6: return bin(u32());
      case 0xc7: { need(1); const n = u8[p++]; need(1 + n); p += 1 + n; return null; } // 확장형: 값은 버린다
      case 0xc8: { const n = u16(); need(1 + n); p += 1 + n; return null; }
      case 0xc9: { const n = u32(); need(1 + n); p += 1 + n; return null; }
      case 0xca: { need(4); const v = dv.getFloat32(p); p += 4; return v; }
      case 0xcb: { need(8); const v = dv.getFloat64(p); p += 8; return v; }
      case 0xcc: need(1); return u8[p++];
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: { need(8); const v = dv.getBigUint64(p); p += 8; return big(v); }
      case 0xd0: { need(1); const v = dv.getInt8(p); p += 1; return v; }
      case 0xd1: { need(2); const v = dv.getInt16(p); p += 2; return v; }
      case 0xd2: { need(4); const v = dv.getInt32(p); p += 4; return v; }
      case 0xd3: { need(8); const v = dv.getBigInt64(p); p += 8; return big(v); }
      case 0xd4: case 0xd5: case 0xd6: case 0xd7: case 0xd8: {
        const n = 1 << (t - 0xd4); need(1 + n); p += 1 + n; return null;
      }
      case 0xd9: need(1); return str(u8[p++]);
      case 0xda: return str(u16());
      case 0xdb: return str(u32());
      case 0xdc: return arr(u16(), d);
      case 0xdd: return arr(u32(), d);
      case 0xde: return map(u16(), d);
      case 0xdf: return map(u32(), d);
      default: throw new Error("모르는 msgpack 표시 0x" + t.toString(16));
    }
  }
  return rd(0);
}

// ── AES-GCM (.risup 암호) ───────────────────────────────────
async function aesDecrypt(u8, pw = "risupreset") {
  const sub = globalThis.crypto?.subtle;
  if (!sub) throw new Error("이 주소에서는 암호 풀기(crypto.subtle)를 못 씀. https 또는 localhost로 열어야 함");
  const key = await sub.importKey("raw", await sub.digest("SHA-256", new TextEncoder().encode(pw)), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await sub.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, u8));
}

// ── zip (저장·deflate만, zip64·암호 없음) ───────────────────
export async function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error("zip 끝 표시를 못 찾음");
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip 목록이 깨짐");
    const flag = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const lo = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (name.endsWith("/")) continue;
    const ent = { name, size: usize };
    if (flag & 1) ent.error = "암호가 걸린 파일";
    else if (csize === 0xffffffff || usize === 0xffffffff) ent.error = "zip64는 지원 안 함";
    else if (usize > MAX_OUT) ent.error = "너무 큼";
    else if (lo + 30 > u8.length || dv.getUint32(lo, true) !== 0x04034b50) ent.error = "로컬 머리가 깨짐";
    else {
      const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      const raw = u8.subarray(ds, ds + csize);
      try {
        if (method === 0) ent.data = raw.slice();
        else if (method === 8) ent.data = await inflate(raw, "deflate-raw");
        else ent.error = "압축 방식 " + method + "은 지원 안 함";
      } catch (err) { ent.error = "풀기 실패: " + err.message; }
    }
    out.push(ent);
  }
  return out;
}

// ── PNG 안의 캐릭터 카드 (tEXt 'chara' / 'ccv3', base64 JSON) ──
function pngCard(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 8, best = null;
  while (p + 12 <= u8.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    if (type === "tEXt" && p + 8 + len <= u8.length) {
      const body = u8.subarray(p + 8, p + 8 + len);
      const z = body.indexOf(0);
      if (z > 0) {
        const kw = td.decode(body.subarray(0, z));
        if (kw === "ccv3" || (kw === "chara" && !best)) {
          try { best = JSON.parse(td.decode(Uint8Array.from(atob(td.decode(body.subarray(z + 1))), (c) => c.charCodeAt(0)))); } catch { /* 건너뜀 */ }
        }
      }
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return best;
}

// ── NovelAI PNG 안의 생성 정보 ──────────────────────────────
// tEXt 청크 Description(프롬프트)·Software·Source(모델)·Comment(생성 정보 JSON). 청크 이름은 novelai-sdk-unofficial 문서·NAIWeaver 변경 기록(2026-11-19 확인).
// Comment 안의 키 이름은 진짜 파일로 확인 못 해서 변형 여럿을 같이 본다.
export function pngTexts(u8) {
  if (u8.length < 8 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = {};
  for (let p = 8; p + 12 <= u8.length;) {
    const len = dv.getUint32(p), type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    if (p + 12 + len > u8.length) break;
    const body = u8.subarray(p + 8, p + 8 + len);
    if (type === "tEXt") { const z = body.indexOf(0); if (z > 0) out[td.decode(body.subarray(0, z))] = td.decode(body.subarray(z + 1)); }
    else if (type === "iTXt") { // 키\0 압축여부 방식 언어\0 번역키\0 글. 압축된 것은 건너뜀
      const z = body.indexOf(0);
      if (z > 0 && body[z + 1] === 0) { const l = body.indexOf(0, z + 3), t = l >= 0 ? body.indexOf(0, l + 1) : -1; if (t >= 0) out[td.decode(body.subarray(0, z))] = td.decode(body.subarray(t + 1)); }
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return out;
}
export function naiInfo(u8) {
  const t = pngTexts(u8);
  if (!t) return null;
  let c = {};
  try { c = JSON.parse(t.Comment || "{}") || {}; } catch { c = {}; }
  const prompt = String(c.prompt ?? c.v4_prompt?.caption?.base_caption ?? t.Description ?? "").trim();
  const uc = String(c.uc ?? c.negative_prompt ?? c.v4_negative_prompt?.caption?.base_caption ?? "").trim();
  if (!prompt && !uc) return null;
  const cc = c.v4_prompt?.caption?.char_captions, nc = c.v4_negative_prompt?.caption?.char_captions;
  const chars = Array.isArray(cc) ? cc.map((x, i) => ({ text: String(x?.char_caption ?? ""), neg: String(nc?.[i]?.char_caption ?? "") })).filter((x) => x.text.trim()) : [];
  const params = {};
  for (const k of ["seed", "steps", "scale", "sampler", "noise_schedule", "cfg_rescale", "width", "height", "skip_cfg_above_sigma", "strength", "noise"]) if (c[k] !== undefined) params[k] = c[k];
  return { prompt, uc, chars, params, model: String(t.Source || "").slice(0, 80), software: String(t.Software || "").slice(0, 80) };
}

// ── 종류 알아내기 ───────────────────────────────────────────
const looksText = (u8) => {
  const n = Math.min(u8.length, 4096);
  for (let i = 0; i < n; i++) if (u8[i] === 0) return false;
  return true;
};
const imageKind = (u8) => {
  const a = (i, t) => [...t].every((c, k) => u8[i + k] === c.charCodeAt(0));
  if (a(0, "RIFF") && a(8, "WEBP")) return "WEBP";
  if (u8[0] === 0xff && u8[1] === 0xd8) return "JPEG";
  if (a(0, "GIF8")) return "GIF";
  return "";
};
const extOf = (name) => (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [, ""])[1];

function classifyJson(o) {
  if (o && typeof o === "object" && !Array.isArray(o)) {
    if (o.spec === "chara_card_v3" || o.spec === "chara_card_v2" || (o.data && o.data.first_mes !== undefined && o.data.name !== undefined)) return "card";
    if (o.type === "risuModule" || (o.module && o.module.lorebook)) return "module";
    if (o.type === "risu" && o.data?.settings?.summarizationPrompt !== undefined) return "hypa";
    if (Array.isArray(o.promptTemplate) || o.mainPrompt !== undefined) return "preset";
    if (o.type === "preset" && o.preset) return "preset";
    if (Array.isArray(o.lorebook) || (o.name && o.content !== undefined && o.entries)) return "module";
  }
  return "json";
}

const LABEL = {
  nai: "NovelAI 그림 정보", preset: "프리셋", module: "모듈", card: "캐릭터 카드", hypa: "하이파(장기기억) 설정",
  plugin: "플러그인(JS)", zip: "압축 묶음", json: "JSON", text: "글", binary: "바이너리", error: "읽기 실패",
};

let nextId = 1;
const mk = (name, size, kind, extra = {}) => ({ id: String(nextId++), name, size, kind, label: LABEL[kind], ...extra });

function wrapBody(kind, o) {
  if (kind === "card") return o.data && o.spec ? o : { spec: "chara_card_v2", data: o };
  if (kind === "module") return o.module ? o.module : o;
  if (kind === "hypa") return o.data;
  if (kind === "preset") return o.type === "preset" && o.preset && typeof o.preset === "object" ? o.preset : o;
  return o;
}

async function tryRisup(u8) {
  for (const raw of [rpDecode(u8), u8]) {
    let x, de;
    try { x = await inflate(raw); de = unpack(x); } catch { continue; }
    if (!de || typeof de !== "object" || Array.isArray(de)) continue;
    const enc = de.preset ?? de.pres;
    if (enc instanceof Uint8Array) {
      const v = de.presetVersion;
      if (v !== 0 && v !== 2) throw new Error("presetVersion " + v + "은 해독 방법을 확인 못 함");
      de.preset = unpack(await aesDecrypt(enc));
      delete de.pres;
    }
    return de;
  }
  return null;
}

function tryRisum(u8) {
  if (u8.length < 6 || u8[0] !== 111 || u8[1] !== 0) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(2, true);
  if (6 + n > u8.length) return null;
  let obj;
  try { obj = JSON.parse(td.decode(rpDecode(u8.subarray(6, 6 + n)))); } catch { return null; }
  let p = 6 + n, assets = 0;
  while (p < u8.length) {
    const mark = u8[p++];
    if (mark === 0 || p + 4 > u8.length) break;
    const L = dv.getUint32(p, true); p += 4;
    if (p + L > u8.length) break;
    assets++; p += L;
  }
  return { obj, assets };
}

// 파일 하나를 풀어 노드로. 실패해도 던지지 않고 kind "error" 노드를 돌려준다.
export async function parseFile(name, u8, depth = 0) {
  try {
    const ext = extOf(name);
    if (u8.length === 0) return mk(name, 0, "error", { note: "빈 파일" });

    if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 3 && u8[3] === 4) {
      if (depth >= MAX_DEPTH) return mk(name, u8.length, "error", { note: "압축 안의 압축이 " + MAX_DEPTH + "겹을 넘음" });
      const ents = await readZip(u8);
      const children = [];
      for (const en of ents) {
        if (en.error) children.push(mk(en.name, en.size, "error", { note: en.error }));
        else children.push(await parseFile(en.name, en.data, depth + 1));
      }
      return mk(name, u8.length, "zip", { children, charx: ext === "charx" });
    }

    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
      const card = pngCard(u8);
      if (card) return mk(name, u8.length, "card", { body: wrapBody("card", card), note: "PNG 안에 들어 있던 카드" });
      const nai = naiInfo(u8);
      if (nai) return mk(name, u8.length, "nai", { body: nai, note: "NovelAI가 그림에 남긴 생성 정보" });
      return mk(name, u8.length, "binary", { note: "PNG 그림. 카드·NovelAI 정보는 못 찾음" });
    }
    const img = imageKind(u8);
    if (img) return mk(name, u8.length, "binary", { note: img + " 그림. 풀지 않음" });

    if (ext === "risup" || ext === "risupreset") {
      const de = await tryRisup(u8);
      if (de) return mk(name, u8.length, "preset", { body: wrapBody("preset", de), version: de.presetVersion });
    }
    if (ext === "risum" || (u8[0] === 111 && u8[1] === 0)) {
      const r = tryRisum(u8);
      if (r) return mk(name, u8.length, "module", { body: wrapBody("module", r.obj), assets: r.assets, version: r.obj.type });
    }

    if (looksText(u8)) {
      let text = td.decode(u8);
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const t = text.trimStart();
      if (t[0] === "{" || t[0] === "[") {
        try {
          const o = JSON.parse(t);
          const kind = classifyJson(o);
          return mk(name, u8.length, kind, kind === "json" ? { body: o, text } : { body: wrapBody(kind, o) });
        } catch { /* 글로 계속 */ }
      }
      if (/^\s*\/\/@(name|api|display-name|version)\b/m.test(text.slice(0, 2000))) return mk(name, u8.length, "plugin", { text });
      return mk(name, u8.length, "text", { text });
    }

    if (ext === "risup" || ext === "risupreset") return mk(name, u8.length, "error", { note: "프리셋으로 못 풀었음. 파일이 잘렸거나 처음 보는 형식" });
    {
      const de = await tryRisup(u8).catch(() => null);
      if (de) return mk(name, u8.length, "preset", { body: wrapBody("preset", de), version: de.presetVersion, note: "확장자는 다르지만 프리셋 형식" });
    }
    return mk(name, u8.length, "binary", { note: "아는 형식이 아님" });
  } catch (err) {
    return mk(name, u8.length, "error", { note: err.message });
  }
}

// ── 로어북 ──────────────────────────────────────────────────
// 카드(character_book.entries)와 모듈(lorebook)의 모양이 달라서 하나로 맞춘다.
export function loreOf(node) {
  const b = node.body;
  const list = node.kind === "card" ? b?.data?.character_book?.entries : node.kind === "module" ? b?.lorebook : null;
  if (!Array.isArray(list)) return [];
  return list.map((e, i) => {
    const keys = Array.isArray(e.keys) ? e.keys : String(e.key ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return {
      i,
      name: String(e.comment || e.name || "").trim(),
      keys,
      content: String(e.content ?? ""),
      always: !!(e.alwaysActive ?? e.constant),
      folder: e.mode === "folder",
    };
  });
}
export const stripDirectives = (s) => s.replace(/^[ \t]*@@[^\n]*\n?/gm, "");
const loreText = (e, o) => {
  const c = o.strip ? stripDirectives(e.content) : e.content;
  return `## ${e.name || "(이름 없음)"}\n키워드: ${e.keys.join(", ") || "(없음)"}${e.always ? " · 상시 활성" : ""}\n${c.trim()}`;
};
const loreBlock = (node, o) => {
  const real = loreOf(node).filter((e) => !e.folder && e.content.trim());
  return real.length ? real.map((e) => loreText(e, o)).join("\n\n") : "";
};
export { loreText };

// ── 조립: 읽을 수 있는 프롬프트 한 덩어리 ────────────────────
// o = { slots: "mark"|"blank", headers: bool, strip: bool, lore: bool }
export const SLOT_TYPES = new Set(["persona", "description", "lorebook", "memory", "authornote", "postEverything"]);

export function assemble(node, o) {
  const b = node.body;
  const H = (t) => (o.headers ? `### ${t}\n` : "");
  if (node.kind === "preset") {
    const parts = [];
    if (Array.isArray(b.promptTemplate)) {
      for (const k of b.promptTemplate) {
        if (k.type === "cache") continue;
        const title = `${k.name || k.type} (${k.type}${k.role ? "·" + k.role : k.role2 ? "·" + k.role2 : ""})`;
        let text;
        if (SLOT_TYPES.has(k.type)) {
          const inner = String(k.innerFormat ?? "");
          if (inner.includes("{{slot}}")) text = inner.replaceAll("{{slot}}", o.slots === "mark" ? `[[${k.name || k.type}]]` : "");
          else if (inner) text = inner;
          else text = o.slots === "mark" ? `[[${k.name || k.type}]]` : "";
        } else if (k.type === "chat") {
          text = o.slots === "mark" ? `[[대화 기록: ${k.name || "chat"}]]` : "";
        } else {
          text = String(k.text ?? "");
          if (!text && k.type2 === "globalNote" && o.slots === "mark") text = "[[전역 노트]]";
        }
        if (text.trim()) parts.push(H(title) + text);
      }
    } else {
      for (const [f, t] of [["mainPrompt", "메인 프롬프트"], ["jailbreak", "탈옥/후행 프롬프트"], ["globalNote", "전역 노트"]]) {
        if (b[f]) parts.push(H(t) + b[f]);
      }
    }
    return parts.join("\n\n");
  }
  if (node.kind === "card") {
    const d = b.data || {};
    const parts = [];
    const add = (t, v) => { if (typeof v === "string" && v.trim()) parts.push(H(t) + v); };
    add("이름", d.name);
    add("설명", d.description);
    add("성격", d.personality);
    add("시나리오", d.scenario);
    add("시스템 프롬프트", d.system_prompt);
    add("첫 메시지", d.first_mes);
    if (Array.isArray(d.alternate_greetings) && d.alternate_greetings.length)
      parts.push(H("다른 첫 메시지") + d.alternate_greetings.map((s, i) => `(${i + 1}) ${s}`).join("\n\n"));
    add("예시 대화", d.mes_example);
    add("후행 지시", d.post_history_instructions);
    add("만든이 메모", d.creator_notes);
    if (o.lore) { const l = loreBlock(node, o); if (l) parts.push(H("로어북 (전부 이어 붙임. 실제 대화에서는 키워드에 걸린 것만 들어감)") + l); }
    return parts.join("\n\n");
  }
  if (node.kind === "module") {
    const parts = [];
    if (b.name) parts.push(H("모듈 이름") + b.name + (b.description ? "\n" + b.description : ""));
    if (o.lore) { const l = loreBlock(node, o); if (l) parts.push(H("로어북 (전부 이어 붙임. 실제 대화에서는 키워드에 걸린 것만 들어감)") + l); }
    return parts.join("\n\n");
  }
  if (node.kind === "nai") {
    return [H("프롬프트") + b.prompt, H("빼는 것") + b.uc, ...b.chars.map((c, i) => H(`인물 ${i + 1}`) + c.text + (c.neg ? `\n빼는 것: ${c.neg}` : ""))].filter((x) => x.trim().length > 4).join("\n\n");
  }
  if (node.kind === "hypa") {
    const s = b.settings || {};
    return [H("요약(기억 추출) 프롬프트") + (s.summarizationPrompt || ""), H("재요약(기억 합치기) 프롬프트") + (s.reSummarizationPrompt || "")]
      .filter((x) => x.trim().length > 20).join("\n\n");
  }
  return null; // plugin, text, json, zip 등은 프롬프트로 조립하지 않는다
}

// ── 구조 요약 ───────────────────────────────────────────────
export function parseToggles(s) {
  const out = [];
  for (const line of String(s || "").split("\n")) {
    if (!line || line.startsWith("==")) continue;
    if (line.startsWith("=")) { const [, label, type] = line.split("="); if (type === "group") out.push({ group: label }); continue; }
    const [key, label, type, opts] = line.split("=");
    out.push({ key, label, type: type || "check", opts });
  }
  return out;
}

const n0 = (v) => (typeof v === "number" ? v.toLocaleString("ko-KR") : String(v ?? ""));
const cut = (s, n = 90) => { s = String(s ?? "").replace(/\s+/g, " "); return s.length > n ? s.slice(0, n) + "…" : s; };

// [{title, rows:[[칸, 값]...]}] — 화면이 그대로 그린다
export function outline(node) {
  const b = node.body;
  const secs = [];
  if (node.kind === "preset") {
    secs.push({ title: "기본", rows: [
      ["이름", b.name], ["API 종류", b.apiType], ["메인 모델", b.aiModel], ["보조 모델", b.subModel],
      ["최대 컨텍스트", n0(b.maxContext)], ["최대 응답", n0(b.maxResponse)],
      ["온도", n0(b.temperature)], ["top_p", n0(b.top_p)],
      ["열쇠 칸(openAIKey·proxyKey)", (b.openAIKey || b.proxyKey) ? "값이 들어 있음 (표시 안 함)" : "비어 있음"],
      ["프롬프트 블록", Array.isArray(b.promptTemplate) ? b.promptTemplate.length + "개" : "없음(옛 형식)"],
    ] });
    if (Array.isArray(b.promptTemplate)) {
      secs.push({ title: "프롬프트 블록 (위에서 아래로 이어 붙는 순서)", rows: b.promptTemplate.map((k, i) => {
        const len = String(k.text ?? k.innerFormat ?? "").length;
        return [`${i + 1}. ${k.name || k.type}`, `${k.type}${k.role ? " · " + k.role : k.role2 ? " · " + k.role2 : ""}${len ? " · " + n0(len) + "자" : " · 빈 칸"}`];
      }) });
    }
    if (Array.isArray(b.regex) && b.regex.length) {
      secs.push({ title: "정규식 " + b.regex.length + "개", rows: b.regex.map((r) => [r.comment || "(이름 없음)", `${r.type} · ${cut(r.in, 50)}`]) });
    }
    const tg = parseToggles(b.customPromptTemplateToggle);
    if (tg.length) {
      secs.push({ title: "사용자 토글 " + tg.filter((t) => !t.group).length + "개", rows: tg.map((t) => (t.group ? ["▸ " + t.group, ""] : [t.label || t.key, `${t.type}${t.opts ? " · " + cut(t.opts, 60) : ""}`])) });
    }
  } else if (node.kind === "module") {
    const l = loreOf(node);
    secs.push({ title: "모듈", rows: [
      ["이름", b.name], ["설명", b.description], ["id", b.id],
      ["로어북", `${l.filter((e) => !e.folder).length}개 항목 · 폴더 ${l.filter((e) => e.folder).length}개 · 상시 활성 ${l.filter((e) => e.always).length}개`],
      ["로어북 글자 수", n0(l.reduce((a, e) => a + e.content.length, 0))],
      ["정규식", Array.isArray(b.regex) ? b.regex.length + "개" : "없음"],
      ["트리거", Array.isArray(b.trigger) ? b.trigger.length + "개" : "없음"],
      ["에셋", node.assets != null ? node.assets + "개(파일 뒤쪽 덩어리)" : (Array.isArray(b.assets) ? b.assets.length + "개" : "없음")],
    ] });
    if (Array.isArray(b.trigger) && b.trigger.length) {
      secs.push({ title: "트리거", rows: b.trigger.map((t, i) => [`${i + 1}. ${t.comment || t.type}`, `효과 ${Array.isArray(t.effect) ? t.effect.map((x) => x.type).join(", ") : ""}${t.effect?.some((x) => x.type === "triggerlua" && !x.code) ? " (코드 비어 있음)" : ""}`]) });
    }
  } else if (node.kind === "card") {
    const d = b.data || {};
    const l = loreOf(node);
    secs.push({ title: "카드", rows: [
      ["규격", `${b.spec || "?"} ${b.spec_version || ""}`], ["이름", d.name], ["만든이", d.creator], ["버전", d.character_version],
      ["설명", n0(String(d.description || "").length) + "자"], ["성격", n0(String(d.personality || "").length) + "자"],
      ["시나리오", n0(String(d.scenario || "").length) + "자"], ["시스템 프롬프트", n0(String(d.system_prompt || "").length) + "자"],
      ["첫 메시지", n0(String(d.first_mes || "").length) + "자"], ["다른 첫 메시지", (d.alternate_greetings || []).length + "개"],
      ["로어북", `${l.filter((e) => !e.folder).length}개 항목 · ${n0(l.reduce((a, e) => a + e.content.length, 0))}자`],
      ["에셋", (d.assets || []).length + "개"],
    ] });
    const sd = d.extensions?.risuai?.sdData;
    if (Array.isArray(sd)) secs.push({ title: "그림 프롬프트 칸(sdData)", rows: sd.map(([k, v]) => [k, v === "" ? "(비어 있음)" : cut(v, 120)]) });
  } else if (node.kind === "hypa") {
    const s = b.settings || {};
    secs.push({ title: "하이파 설정", rows: [
      ["이름", b.name], ["요약 모델", s.summarizationModel],
      ["기억 비율(memoryTokensRatio)", n0(s.memoryTokensRatio)], ["요약당 채팅 수", n0(s.maxChatsPerSummary)],
      ["최근 기억 비율", n0(s.recentMemoryRatio)], ["유사 기억 비율", n0(s.similarMemoryRatio)],
      ["분당 요약 요청", n0(s.summarizationRequestsPerMinute)], ["요약 프롬프트", n0(String(s.summarizationPrompt || "").length) + "자"],
      ["재요약 프롬프트", n0(String(s.reSummarizationPrompt || "").length) + "자"],
    ] });
  } else if (node.kind === "plugin") {
    const t = node.text;
    const meta = [...t.slice(0, 3000).matchAll(/^\s*\/\/@([\w-]+)\s+(.*)$/gm)].map((m) => [m[1], m[2].trim()]);
    const hosts = new Map();
    for (const m of t.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)(\/[^\s"'`)<>]*)?/g)) hosts.set(m[1], (hosts.get(m[1]) || 0) + 1);
    const sig = (re) => (t.match(re) || []).length;
    secs.push({ title: "플러그인 머리말", rows: meta.length ? meta : [["(없음)", ""]] });
    secs.push({ title: "크기", rows: [["줄 수", n0(t.split("\n").length)], ["글자 수", n0(t.length)]] });
    secs.push({ title: "글에 적힌 주소(호스트별 횟수). 코드는 실행하지 않고 글자만 찾은 것", rows: [...hosts].sort((a, c) => c[1] - a[1]).map(([h, c]) => [h, c + "회"]) });
    secs.push({ title: "코드에 나오는 것(횟수). 있다는 뜻일 뿐 실제로 도는지는 모름", rows: [
      ["fetch(", n0(sig(/\bfetch\s*\(/g))], ["XMLHttpRequest", n0(sig(/XMLHttpRequest/g))], ["WebSocket", n0(sig(/WebSocket/g))],
      ["nativeFetch (RisuAI가 대신 보내는 네트워크 호출)", n0(sig(/nativeFetch/g))],
      ["getDatabase·setDatabase (RisuAI 저장 데이터 읽기·쓰기)", n0(sig(/\b(get|set)Database\w*/g))],
      ["getChatFromIndex·setChatToIndex (채팅 읽기·쓰기)", n0(sig(/\b(getChatFromIndex|setChatToIndex)\b/g))],
      ["saveAsset (에셋 저장)", n0(sig(/saveAsset/g))],
      ["eval(", n0(sig(/\beval\s*\(/g))], ["new Function", n0(sig(/new\s+Function\b/g))],
      ["localStorage", n0(sig(/localStorage/g))], ["document.cookie", n0(sig(/document\.cookie/g))],
    ] });
  } else if (node.kind === "nai") {
    secs.push({ title: "NovelAI 생성 정보", rows: [["모델(Source)", b.model], ["프로그램", b.software], ["프롬프트", n0(b.prompt.length) + "자"], ["빼는 것", n0(b.uc.length) + "자"], ["인물별 프롬프트", b.chars.length + "명"], ...Object.entries(b.params).map(([k, v]) => [k, String(v)])] });
  } else if (node.kind === "zip") {
    secs.push({ title: "묶음 안의 파일 " + node.children.length + "개", rows: node.children.map((c) => [c.name, `${c.label} · ${n0(c.size)}바이트${c.note ? " · " + c.note : ""}`]) });
  } else if (node.kind === "json") {
    secs.push({ title: "JSON", rows: [["최상위", Array.isArray(node.body) ? "배열 " + node.body.length + "칸" : "칸: " + Object.keys(node.body).slice(0, 30).join(", ")]] });
  } else if (node.kind === "text") {
    secs.push({ title: "글", rows: [["글자 수", n0(node.text.length)], ["앞부분", cut(node.text, 300)]] });
  } else {
    secs.push({ title: node.label, rows: [["크기", n0(node.size) + "바이트"], ["사유", node.note || ""]] });
  }
  return secs;
}

// ── 짤뽑기로 이을 재료 ──────────────────────────────────────
// 짤뽑기에 가져오기 칸이 없어서, 붙여 넣을 글을 칸별로 만들어 준다.
export function forJjal(node, o) {
  const out = { pieces: [], note: "" };
  if (node.kind === "card") {
    const d = node.body?.data || {};
    const body = [d.description, d.personality].filter((s) => typeof s === "string" && s.trim()).join("\n\n");
    if (body) {
      out.pieces.push({
        title: "비서 지시문 조각 (짤뽑기 → 비서 → 비서 지시문 고치기 → 내 조각 더하기)",
        text: `## 인물: ${d.name || "(이름 없음)"}\n${body}`.trim(),
      });
    }
    const sd = d.extensions?.risuai?.sdData;
    if (Array.isArray(sd)) {
      const slot = { count: [], traits: [], pose: [], bg: [] };
      let neg = "";
      for (const [kRaw, v] of sd) {
        const val = String(v || "").trim();
        if (!val) continue;
        const k = String(kRaw).replace(/^[|$]+/, "").toLowerCase();
        if (k === "negative") neg = val;
        else if (k === "always") slot.count.push(val);
        else if (k.includes("appearance")) slot.traits.push(val);
        else if (k.includes("pose") || k.includes("emotion")) slot.pose.push(val);
        else if (k.includes("location") || k.includes("situation")) slot.bg.push(val);
      }
      const label = { count: "1순위 인원수·성별", traits: "3순위 캐릭터 특징", pose: "5순위 포즈·시선·구도", bg: "6순위 배경·조명" };
      for (const [f, arr] of Object.entries(slot)) if (arr.length) out.pieces.push({ title: `짤뽑기 뽑기 화면 → ${label[f]} 칸`, text: arr.join(", ") });
      if (neg) out.pieces.push({ title: "짤뽑기 취향 → 빼는 것에 더하기", text: neg });
      if (!out.pieces.some((p) => p.title.startsWith("짤뽑기 "))) out.note = "카드에 그림 프롬프트 칸(sdData)이 있지만 값이 모두 비어 있음.";
      else out.note = "sdData 칸 이름을 보고 칸을 짐작해 나눈 것. 실제 의미가 맞는지는 확인 못 함.";
    } else {
      out.note = "이 카드에는 그림 프롬프트 칸(sdData)이 없음.";
    }
  } else if (node.kind === "module") {
    out.note = "모듈에는 그림 프롬프트 칸이 없음. 로어북 항목을 골라 비서 지시문 조각으로 복사할 수 있음.";
  } else {
    out.note = "이 종류는 짤뽑기에 이을 칸이 없음. 프롬프트 전체를 비서 지시문에 넣으면 지시문이 너무 길어짐.";
  }
  out.lore = node.kind === "card" || node.kind === "module" ? loreOf(node).filter((e) => !e.folder && e.content.trim()) : [];
  return out;
}

// ── 블록으로 펼치기 (보관소) ────────────────────────────────
// 파일이 가진 단위 그대로 하나씩: 프리셋 블록, 카드 칸, 로어북 항목, 정규식, NovelAI 프롬프트 칸 …
// 블록 한 개: { title, kind, text, meta? }. kind는 화면의 배지. text는 복사·넣기에 그대로 쓰는 글.
export function splitText(text) {
  const t = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!t) return [];
  const fences = [...t.matchAll(/```([\w-]*)\n([\s\S]*?)```/g)];
  if (fences.length) {
    const out = [];
    let last = 0;
    for (const m of fences) {
      const before = t.slice(last, m.index).trim();
      if (before) out.push({ title: before.split("\n")[0].slice(0, 40), kind: "글", text: before });
      out.push({ title: m[1] || "코드 블록", kind: m[1] || "블록", text: m[2].trim() });
      last = m.index + m[0].length;
    }
    const rest = t.slice(last).trim();
    if (rest) out.push({ title: rest.split("\n")[0].slice(0, 40), kind: "글", text: rest });
    return out;
  }
  if (/^#{1,3} /m.test(t)) {
    const out = [];
    for (const part of t.split(/\n(?=#{1,3} )/)) {
      const m = part.match(/^#{1,3} (.+)\n?/);
      const body = (m ? part.slice(m[0].length) : part).trim();
      if (m || body) out.push({ title: (m ? m[1] : body.split("\n")[0]).slice(0, 60), kind: m ? "제목" : "글", text: body || (m ? m[1] : "") });
    }
    return out;
  }
  const paras = t.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  return paras.map((x) => ({ title: x.split("\n")[0].slice(0, 40), kind: "글", text: x }));
}

export function blocksOf(node) {
  const b = node.body, out = [];
  const add = (title, kind, text, meta) => { if (typeof text === "string" && text.trim()) out.push({ title: String(title || kind).slice(0, 80), kind, text, ...(meta ? { meta } : {}) }); };
  const lore = () => loreOf(node).filter((e) => !e.folder && e.content.trim()).forEach((e) => add(e.name || "(이름 없음)", e.always ? "로어북·상시" : "로어북", e.content, e.keys.join(", ")));
  if (node.kind === "preset") {
    if (Array.isArray(b.promptTemplate)) for (const k of b.promptTemplate) {
      if (k.type === "cache") continue;
      const text = SLOT_TYPES.has(k.type) ? String(k.innerFormat ?? "") : k.type === "chat" ? "" : String(k.text ?? "");
      add(k.name || k.type, `${k.type}${k.role ? "·" + k.role : k.role2 ? "·" + k.role2 : ""}`, text || (SLOT_TYPES.has(k.type) || k.type === "chat" ? `[[${k.name || k.type}]]` : ""));
    }
    add("mainPrompt 칸", "옛 칸", b.mainPrompt);
    add("jailbreak 칸", "옛 칸", b.jailbreak);
    add("globalNote 칸", "옛 칸", b.globalNote);
    for (const r of Array.isArray(b.regex) ? b.regex : []) add(`정규식: ${r.comment || "(이름 없음)"}`, `정규식·${r.type || ""}`, `찾기: ${r.in ?? ""}\n바꾸기: ${r.out ?? ""}`);
    add("사용자 토글 정의", "토글", b.customPromptTemplateToggle);
    add("토글 기본값", "토글", b.templateDefaultVariables);
  } else if (node.kind === "card") {
    const d = b.data || {};
    for (const [f, t] of [["description", "설명"], ["personality", "성격"], ["scenario", "시나리오"], ["system_prompt", "시스템 프롬프트"], ["first_mes", "첫 메시지"], ["mes_example", "예시 대화"], ["post_history_instructions", "후행 지시"], ["creator_notes", "만든이 메모"]]) add(t, "카드", d[f]);
    (d.alternate_greetings || []).forEach((g, i) => add(`다른 첫 메시지 ${i + 1}`, "카드", g));
    const sd = d.extensions?.risuai?.sdData;
    if (Array.isArray(sd)) add("그림 프롬프트 칸(sdData)", "그림", sd.filter(([, v]) => String(v || "").trim()).map(([k, v]) => `${k}: ${v}`).join("\n"));
    lore();
  } else if (node.kind === "module") {
    add(b.name || "모듈", "모듈", [b.name, b.description].filter(Boolean).join("\n"));
    lore();
    for (const r of Array.isArray(b.regex) ? b.regex : []) add(`정규식: ${r.comment || "(이름 없음)"}`, "정규식", `찾기: ${r.in ?? ""}\n바꾸기: ${r.out ?? ""}`);
    for (const t of Array.isArray(b.trigger) ? b.trigger : []) for (const e of Array.isArray(t.effect) ? t.effect : []) add(`트리거: ${t.comment || t.type || ""} · ${e.type}`, "트리거(실행 안 함)", typeof e.code === "string" ? e.code : JSON.stringify(e));
  } else if (node.kind === "hypa") {
    const st = b.settings || {};
    add("요약(기억 추출) 프롬프트", "하이파", st.summarizationPrompt);
    add("재요약(기억 합치기) 프롬프트", "하이파", st.reSummarizationPrompt);
    const rest = Object.fromEntries(Object.entries(st).filter(([k]) => !/Prompt$/.test(k)));
    add("숫자 설정", "설정", JSON.stringify(rest, null, 2));
  } else if (node.kind === "nai") {
    add("프롬프트", "NAI·프롬프트", b.prompt);
    add("빼는 것", "NAI·빼는 것", b.uc);
    b.chars.forEach((c, i) => { add(`인물 ${i + 1}`, "NAI·인물", c.text); add(`인물 ${i + 1} 빼는 것`, "NAI·빼는 것", c.neg); });
    if (Object.keys(b.params).length) add("생성 설정", "설정", JSON.stringify(b.params, null, 2));
  } else if (node.kind === "plugin") {
    const meta = [...node.text.slice(0, 3000).matchAll(/^\s*\/\/@([\w-]+)\s+(.*)$/gm)].map((m) => `${m[1]}: ${m[2].trim()}`).join("\n");
    add("플러그인 머리말", "플러그인", meta);
    add("코드 전체 (읽기만, 실행 안 함)", "코드", node.text);
  } else if (node.kind === "json") {
    add("JSON", "JSON", JSON.stringify(node.body, null, 2));
  } else if (node.kind === "text") {
    out.push(...splitText(node.text));
  }
  return out;
}

// 보관소에 넣을 것: 묶음(zip)은 안의 파일을 하나씩, 블록이 없는 것(그림·실패)은 뺀다.
export function vaultItems(node, prefix = "") {
  if (node.kind === "zip") return node.children.flatMap((c) => vaultItems(c, prefix + node.name + "/"));
  if (/(^|\/)x_meta\//.test(node.name)) return []; // charx의 그림 종류 표시 한 줄. 보관할 것이 없다
  const blocks = blocksOf(node);
  return blocks.length ? [{ name: prefix + node.name, kind: node.kind, label: node.label, size: node.size, blocks }] : [];
}
