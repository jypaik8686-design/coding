// 프롬프트 칸 나누기. app.js에서 옮겨 와 시험(slots.test.mjs)을 붙였다 (2026-11-27, 사용자 신고 "분류가 안 되고 꼬임").
// NovelAI로 가는 글은 칸을 이 순서로 이어 붙인다: 1 인원수·성별 → 2 화풍·작가(취향 프롬프트) → 3 캐릭터 특징 → 4 의상·장신구 → 5 포즈·시선·구도 → 6 배경·조명·분위기·이펙트 → (그 밖에) → 7 품질 태그.
// draft.slots에 담기는 칸은 SLOT_KEYS. 2순위는 taste.style, 7순위는 settings.qualityText에 있다.
export const SLOT_KEYS = ["count", "traits", "outfit", "pose", "bg", "rest"];
export const SLOT_NAMES = { count: "인원수·성별", traits: "캐릭터 특징", outfit: "의상·장신구", pose: "포즈·시선·구도", bg: "배경·조명·분위기·이펙트", rest: "그 밖에" };
export const DEFAULT_SLOTS = { count: "1girl, solo", traits: "blonde hair, long hair, east asian, mature female, elegant", outfit: "business suit, formal", pose: "looking at viewer, upper body", bg: "", rest: "" };
export const COUNT_RE = /^(\d+\+?(girl|boy|girls|boys|other|others)|solo|no humans)$/i;

export function tg(t) { return String(t || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join(", "); }
export function joinTags(parts) { // 칸 글들을 이어 붙이되 같은 태그는 먼저 나온 것만 남긴다
  const seen = new Set(), out = [];
  for (const part of parts) for (const t of tg(part).split(", ")) { if (!t) continue; const k = t.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(t); }
  return out.join(", ");
}
export function sceneOf(sl) { return joinTags(SLOT_KEYS.map((k) => sl?.[k])); }
export function splitCount(text) { // 인원수·성별 태그(1girl, solo 등)만 따로 뽑는다
  const c = [], r = [];
  for (const t of tg(text).split(", ")) { if (!t) continue; (COUNT_RE.test(t.replace(/[{}\[\]]/g, "")) ? c : r).push(t); }
  return { count: c.join(", "), rest: r.join(", ") };
}

// ── 태그 하나가 어느 칸인지 짐작 ─────────────────────────────
// 낱말로 고른다. 위에서부터 먼저 걸린 칸이다 (hair ornament는 의상, upper body는 구도가 먼저). 못 고르면 rest.
const W = (s) => new RegExp(`\\b(${s})\\b`, "i");
const GUESS = [
  ["outfit", W("jersey|hair flower|flower hair ornament|off shoulder|off-shoulder|bare shoulders|see-through|fur trim|frills|frilled|lace|lace trim|dress|shirt|t-shirt|skirt|suit|uniform|jacket|coat|pants|shorts|jeans|hat|cap|gloves|boots|shoes|heels|sandals|sneakers|socks|thighhighs|pantyhose|stockings|kneehighs|necktie|tie|bowtie|ribbon|bow|earrings|necklace|jewelry|bracelet|ring|choker|glasses|eyewear|sunglasses|bikini|swimsuit|kimono|yukata|hanfu|qipao|china dress|sweater|hoodie|vest|cape|cloak|robe|scarf|bra|panties|underwear|lingerie|armor|apron|belt|bag|hair ornament|hairband|hairclip|hair bow|hair ribbon|headband|crown|tiara|mask|veil|sleeves|sleeveless|collar|leotard|bodysuit|cardigan|blouse|tank top|crop top|nude|naked|topless|barefoot|maid|serafuku|blazer|overcoat|trench coat|gown|wedding dress|formal|casual|outfit|costume|clothes|clothing|attire|headwear|footwear|legwear|epaulettes|cufflinks|watch|holster|sash|obi|corset|garter|tights|leggings|loafers|uniform")],
  ["pose", W("looking|from below|from above|from side|from behind|from front|sitting|standing|lying|kneeling|squatting|leaning|crossed arms|crossed legs|arms up|arms behind|arm up|hands? on|hand in|hand to|hands? up|arms? up|outstretched|w|holding|upper body|full body|lower body|cowboy shot|portrait|close-up|closeup|profile|pov|walking|running|jumping|head tilt|head rest|reaching|pointing|waving|hugging|spread|dutch angle|wide shot|straddling|on back|on stomach|on side|all fours|peace sign|salute|stretching|sleeping|pose|posing|facing|turning|bent over|arched back|contrapposto|v|eye contact|dynamic angle|foreshortening|selfie|carrying|fighting stance|crouching|floating|dancing|sitting on|sideways|three-quarter view")],
  ["traits", W("sweatdrop|tongue|tongue out|hair|eyes|eyebrows|eyelashes|pupils|skin|breasts|ears|tail|horns|wings|halo|lips|teeth|fang|fangs|mole|freckles|female|male|mature|young|smile|smiling|grin|blush|expression|open mouth|closed mouth|tears|crying|angry|annoyed|smug|frown|pout|expressionless|serious|sad|happy|embarrassed|surprised|scared|trembling|jitome|tall|petite|muscular|slim|curvy|abs|thighs|face|makeup|lipstick|eyeshadow|nail polish|tattoo|scar|elf|catgirl|dark-skinned|pale|tan|east asian|asian|elegant|beautiful|cute|chubby|bangs|ponytail|twintails|braid|bun|ahoge|sidelocks|heterochromia|eyepatch|bandage|bandaid|sweat|drool|wink|bishounen|bishoujo|milf|onee-san|gyaru|kemonomimi|animal ears|fox ears|cat ears|beard|stubble|glare|calm|confident|shy|flustered|crazy|yandere|tsundere|evil|seductive|sleepy|tired|bored|excited|nervous|determined")],
  ["bg", W("background|indoors|outdoors|sky|city|cityscape|room|office|street|night|day|sunset|sunrise|dusk|dawn|rain|raining|snow|snowing|light|lighting|lights|shadow|shadows|sunlight|moonlight|backlighting|rim light|bokeh|depth of field|blurry|cloud|clouds|forest|beach|ocean|sea|water|window|classroom|bedroom|bed|throne|flower|flowers|petals|scenery|landscape|atmosphere|fog|mist|smoke|sparkle|sparkles|glow|glowing|particles|fire|flames|lens flare|chromatic aberration|light rays|neon|cherry blossoms|building|buildings|cafe|library|castle|church|school|park|garden|lake|mountain|field|alley|rooftop|bathroom|kitchen|car|train|stage|palace|temple|ruins|space|stars|starry|moon|sun|wind|leaves|autumn|winter|summer|spring|underwater|bubbles|dark|darkness|dim|cinematic|dramatic|horror|gloomy|vivid|colorful|monochrome|greyscale|sepia|vignette|motion blur|speed lines|effect|aura|magic|lightning|explosion|blood|confetti|steam|reflection|mirror|indoor|outdoor|desk|chair|sofa|couch|table|curtains|wall|floor|ceiling|tree|trees|grass|road|bridge|night sky|evening|morning|afternoon")],
];
// 가중치(1.2::…::, {…}, […], (…))와 밑줄을 떼고 낱말만 본다
const bare = (t) => String(t).replace(/-?\d*\.?\d+::|::/g, " ").replace(/[{}\[\]()]/g, " ").replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
// 고르는 순서: 1 내가 옮겨서 기억한 칸(MEMO) → 2 인원수 → 3 칸 정보 파일(DATA, slots.json: 단부루 태그 묶음에서 만듦) → 4 아래 낱말 짐작.
let DATA = {}, memoOf = () => ({});
export function setSlotData(o) { DATA = o && typeof o === "object" ? o : {}; }
export function setSlotMemo(o) { memoOf = typeof o === "function" ? o : () => o; } // 객체, 또는 객체를 돌려주는 함수(저장 데이터가 통째로 바뀌어도 따라가게). learnSlots가 거기에 적는다
const okSlot = (k) => SLOT_KEYS.includes(k);
export function guessSlot(tag) {
  const b = bare(tag);
  if (!b) return "rest";
  const memo = memoOf() || {};
  if (okSlot(memo[b])) return memo[b];
  if (COUNT_RE.test(b)) return "count";
  if (okSlot(DATA[b])) return DATA[b];
  if (b.includes(":")) return "rest"; // artist:… 같은 이름표 태그는 짐작하지 않는다
  for (const [k, re] of GUESS) if (re.test(b)) return k;
  return "rest";
}
// 칸 글을 고친 뒤 부른다: before에 없던 태그가 칸 k에 새로 들어왔고, 앱이 다른 칸으로 짐작하던 것이면 k로 기억한다.
// 인원수 태그는 배우지 않는다. 돌려주는 것은 새로 기억한 수. max를 넘으면 오래된 것부터 지운다.
export function learnSlots(before, after, k, max = 500) {
  const MEMO = memoOf();
  if (!okSlot(k) || !MEMO || typeof MEMO !== "object") return 0;
  const had = new Set(tg(before).split(", ").map(bare));
  let n = 0;
  for (const t of tg(after).split(", ")) {
    const b = bare(t);
    if (!b || had.has(b) || COUNT_RE.test(b) || guessSlot(t) === k) continue;
    delete MEMO[b]; MEMO[b] = k; n++; // 지웠다 다시 넣어 맨 뒤(가장 새것)로
  }
  const keys = Object.keys(MEMO);
  for (const old of keys.slice(0, Math.max(0, keys.length - max))) delete MEMO[old];
  return n;
}
// 칸 이름이 없는 글을 태그마다 나눈다
export function autoSlots(text) {
  const out = Object.fromEntries(SLOT_KEYS.map((k) => [k, ""]));
  for (const t of tg(text).split(", ")) { if (!t) continue; const k = guessSlot(t); out[k] = joinTags([out[k], t]); }
  return out;
}

// ── scene 블록 읽기 ──────────────────────────────────────────
// 한 줄에 칸 하나(`count:` `traits:` `outfit:` `pose:` `bg:`). 비서가 `- count:`, `**count:**`, `배경:`, `3순위 캐릭터 특징:`처럼 써도 읽는다.
// 칸 이름이 없는 줄(줄이 넘어간 것, 이름 없는 프롬프트)은 태그마다 칸을 짐작한다. 블록이 이번 그림 전체를 대신하므로 블록에 없는 칸은 비워진다.
const LABELS = [
  ["count", /^(count|people|number|인원수?|성별|인원수·성별|인원·성별)$/],
  ["traits", /^(traits?|character|characters|appearance|features?|body|face|expression|캐릭터|캐릭터 특징|캐릭터 고유 특징|특징|외모|인물|표정)$/],
  ["outfit", /^(outfit|outfits|clothes|clothing|costume|attire|wear|accessories|의상|옷|복장|장신구|의상·장신구)$/],
  ["pose", /^(pose|poses|posture|composition|camera|angle|framing|action|포즈|자세|구도|시선|포즈·시선·구도|자세·구도)$/],
  ["bg", /^(bg|background|backgrounds|setting|scene|scenery|lighting|light|mood|atmosphere|effects?|environment|배경|조명|분위기|이펙트|배경·조명·분위기·이펙트)$/],
  ["rest", /^(rest|other|others|misc|etc|그 밖에|기타)$/],
];
const cleanLine = (raw) => raw.replace(/^\s*(?:[-*•>·]|\d+[.)])\s+/, "").replace(/[`*_]{2,}|`/g, "").trim(); // 목록 표시·굵게·코드 표시를 뗀다
const LABEL_LINE = /^([^,:{}\[\]()]{1,30}?)\s*[:：]\s*(?!:)(.*)$/;
function labelOf(name) {
  const n = name.replace(/^\d+\s*순위\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
  for (const [k, re] of LABELS) if (re.test(n)) return k;
  return null;
}
// 블록에 이름이 적힌 칸들 (parseSceneBlock과 같은 읽기). 이름 붙은 칸만 바꾸는 쪽(짤뽑기최적화)이 쓴다.
export function sceneKeys(v) {
  const keys = new Set();
  for (const raw of String(v).split("\n")) {
    const line = cleanLine(raw);
    const m = line.match(LABEL_LINE);
    const k = m ? labelOf(m[1]) : null;
    if (k) keys.add(k);
  }
  return [...keys];
}
export function parseSceneBlock(v) {
  const out = Object.fromEntries(SLOT_KEYS.map((k) => [k, ""]));
  const put = (k, text) => { out[k] = joinTags([out[k], text]); };
  for (const raw of String(v).split("\n")) {
    const line = cleanLine(raw);
    if (!line) continue;
    const m = line.match(LABEL_LINE);
    const k = m ? labelOf(m[1]) : null;
    if (k) { put(k, m[2]); continue; }
    const auto = autoSlots(line);
    for (const s of SLOT_KEYS) if (auto[s]) put(s, auto[s]);
  }
  return out;
}

// 사전 검사용: 칸 이름 줄을 떼고, 가중치·괄호를 떼고, 소문자 태그 목록으로 (artist:… 같은 이름표 태그와 @는 뺀다)
export function plainTags(t) {
  return sceneOf(parseSceneBlock(t)).replace(/-?\d*\.?\d+::|::/g, ",").replace(/[{}\[\]()]/g, "").split(/[,\n]/)
    .map((x) => x.trim().toLowerCase()).filter((x) => x && !x.includes(":") && !x.includes("@"));
}

// 인물 프리셋을 고정(인원수·얼굴·머리·몸)과 기본 의상으로 나눈다. 의상 칸으로 짐작되는 태그만 의상으로, 나머지는 다 고정 (2026-11-27, 사용자: 인물은 같은 사람으로 묶되 의상은 바뀌게)
export function splitPerson(text) {
  const fixed = [], outfit = [];
  for (const t of tg(text).split(", ")) { if (!t) continue; (guessSlot(t) === "outfit" ? outfit : fixed).push(t); }
  return { fixed: fixed.join(", "), outfit: outfit.join(", ") };
}
