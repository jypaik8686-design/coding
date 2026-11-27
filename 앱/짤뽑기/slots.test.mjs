// 칸 나누기 시험. 돌리기: node --test coding/앱/짤뽑기/slots.test.mjs
// 2026-11-27 사용자 신고 "프롬프트 분류가 안 되고 꼬임"에서 나온 꼴을 그대로 쓴다.
import test from "node:test";
import assert from "node:assert/strict";
import { parseSceneBlock, autoSlots, guessSlot, plainTags, setSlotData, setSlotMemo, learnSlots, splitPerson, sceneKeys } from "./slots.js";

test("정상 꼴은 그대로", () => {
  const o = parseSceneBlock("count: 1girl, solo,\ntraits: blonde hair, long hair,\noutfit: suit,\npose: upper body,\nbg: office,");
  assert.deepEqual(o, { count: "1girl, solo", traits: "blonde hair, long hair", outfit: "suit", pose: "upper body", bg: "office", rest: "" });
});

test("목록 표시(- )와 굵게(**)가 붙어도 칸을 읽고, 칸 이름이 태그로 섞이지 않는다", () => {
  const a = parseSceneBlock("- count: 1girl, solo\n- traits: blonde hair\n- outfit: suit");
  assert.equal(a.count, "1girl, solo"); assert.equal(a.traits, "blonde hair"); assert.equal(a.outfit, "suit"); assert.equal(a.rest, "");
  const b = parseSceneBlock("**count:** 1girl\n**traits:** blonde hair\n**bg:** office");
  assert.equal(b.count, "1girl"); assert.equal(b.traits, "blonde hair"); assert.equal(b.bg, "office"); assert.equal(b.rest, "");
});

test("한국어·다른 영어 칸 이름", () => {
  const o = parseSceneBlock("인원수: 1girl\n캐릭터 특징: red eyes\n의상: dress\n포즈: sitting\n배경: night sky\nbackground: city\nclothes: hat");
  assert.equal(o.count, "1girl"); assert.equal(o.traits, "red eyes"); assert.equal(o.outfit, "dress, hat"); assert.equal(o.pose, "sitting"); assert.equal(o.bg, "night sky, city"); assert.equal(o.rest, "");
  const p = parseSceneBlock("3순위 캐릭터 특징: silver hair\n6순위 배경·조명·분위기·이펙트: rain");
  assert.equal(p.traits, "silver hair"); assert.equal(p.bg, "rain");
});

test("칸 이름 없이 줄이 넘어간 태그도 제 칸으로", () => {
  const o = parseSceneBlock("count: 1girl,\ntraits: blonde hair, long hair,\n  blue eyes, smile,\noutfit: suit,");
  assert.equal(o.traits, "blonde hair, long hair, blue eyes, smile"); assert.equal(o.rest, "");
});

test("칸 이름이 없는 프롬프트도 태그마다 나눈다", () => {
  const o = parseSceneBlock("1girl, solo, blonde hair, blue eyes, smile, black business suit, necktie, hair ornament, looking at viewer, upper body, from below, office, night, sunlight, masterpiece");
  assert.equal(o.count, "1girl, solo");
  assert.equal(o.traits, "blonde hair, blue eyes, smile");
  assert.equal(o.outfit, "black business suit, necktie, hair ornament");
  assert.equal(o.pose, "looking at viewer, upper body, from below");
  assert.equal(o.bg, "office, night, sunlight");
  assert.equal(o.rest, "masterpiece");
});

test("가중치·괄호는 그대로 두고 칸만 고른다, artist: 태그는 칸 이름으로 안 본다", () => {
  assert.equal(guessSlot("{{blonde hair}}"), "traits");
  assert.equal(guessSlot("1.2::white dress::"), "outfit");
  const o = parseSceneBlock("artist:foo, 1girl\ntraits: red eyes");
  assert.equal(o.rest, "artist:foo"); assert.equal(o.count, "1girl"); assert.equal(o.traits, "red eyes");
});

test("autoSlots는 옛 데이터(칸 없는 scene)를 나눈다", () => {
  const o = autoSlots("1girl, red hair, school uniform, sitting, classroom");
  assert.deepEqual(o, { count: "1girl", traits: "red hair", outfit: "school uniform", pose: "sitting", bg: "classroom", rest: "" });
});

test("흔한 태그가 제 칸으로 (2026-11-27 점검에서 빠진 것)", () => {
  const want = { traits: ["sweatdrop", "tongue out"], outfit: ["off shoulder", "see-through", "hair flower", "fur trim", "frills", "lace", "bare shoulders"], pose: ["w", "hand up", "outstretched arm"] };
  for (const [k, ts] of Object.entries(want)) for (const t of ts) assert.equal(guessSlot(t), k, t);
});

test("칸 정보 파일이 틀린 것은 굳은 규칙이 먼저, 그 밖에로 빠지던 몸·행위·효과 태그도 칸으로 (2026-11-27 신고 \"분류를 잘 못해\")", () => {
  setSlotData({ "looking back": "traits", "off-shoulder dress": "traits", "strapless bra": "traits", "depth of field": "pose", pov: "bg", "holding bag": "outfit", collarbone: "outfit", cleavage: "outfit", "wet clothes": "bg", weapon: "bg", "moon print": "outfit", "maid cafe": "bg", "lace background": "bg" });
  try {
    const want = {
      pose: ["looking back", "{looking back}", "pov", "holding bag", "sex", "kiss", "hug", "yuri", "hetero", "spread legs"],
      outfit: ["off-shoulder dress", "strapless bra", "wet clothes", "weapon", "sword", "gun", "moon print"],
      traits: ["collarbone", "cleavage", "navel", "stomach", "nipples", "sweaty"],
      bg: ["depth of field", "maid cafe", "lace background", "motion lines", "speech bubble", "spoken heart", "steaming body", "cat", "coffee"],
      rest: ["masterpiece", "very aesthetic", "artist:abc", "nsfw"],
    };
    for (const [k, ts] of Object.entries(want)) for (const t of ts) assert.equal(guessSlot(t), k, t);
  } finally { setSlotData({}); }
});

test("plainTags는 칸 이름 꼴(- count:, **traits:**, 배경:)을 태그로 세지 않는다", () => {
  assert.deepEqual(plainTags("- count: 1girl\n**traits:** {blue eyes}\n배경: night sky"), ["1girl", "blue eyes", "night sky"]);
});

test("칸 정보 파일(slots.json)이 낱말 짐작보다 먼저", () => {
  setSlotData({ "floating hair": "traits", "v-shaped eyebrows": "traits", miniskirt: "outfit" });
  try {
    assert.equal(guessSlot("floating hair"), "traits");
    assert.equal(guessSlot("{v-shaped eyebrows}"), "traits");
    assert.equal(guessSlot("miniskirt"), "outfit");
    assert.equal(guessSlot("classroom"), "bg"); // 파일에 없으면 낱말 짐작
  } finally { setSlotData({}); }
});

test("내가 옮긴 칸을 기억하고 다음부터 그 칸으로 (파일보다 먼저)", () => {
  const memo = {};
  setSlotData({ "body writing": "outfit" }); setSlotMemo(memo);
  try {
    // 의상 칸에 있던 body writing을 캐릭터 특징 칸으로 옮김. 원래 있던 태그(red eyes)는 배우지 않는다
    const n = learnSlots("red eyes", "red eyes, body writing, {{weird tag}}", "traits");
    assert.equal(n, 2);
    assert.deepEqual(memo, { "body writing": "traits", "weird tag": "traits" });
    assert.equal(guessSlot("body writing"), "traits");
    assert.equal(parseSceneBlock("1girl, body writing, weird tag").traits, "body writing, weird tag");
    assert.equal(learnSlots("", "smile", "traits"), 0); // 이미 그 칸으로 짐작하면 적지 않는다
    assert.equal(learnSlots("", "1girl", "traits"), 0); // 인원수 태그는 배우지 않는다
  } finally { setSlotData({}); setSlotMemo({}); }
});

test("기억은 최대 개수를 넘으면 오래된 것부터 지운다", () => {
  const memo = {}; setSlotMemo(memo);
  try {
    for (let i = 0; i < 5; i++) learnSlots("", `tagx${i}`, "pose", 3);
    assert.deepEqual(Object.keys(memo), ["tagx2", "tagx3", "tagx4"]);
  } finally { setSlotMemo({}); }
});

test("인물 프리셋: 고정(얼굴·머리·몸)과 기본 의상으로 나눈다", () => {
  const o = splitPerson("1girl, solo, {red hair}, high ponytail, {red eyes}, large breasts, {black jersey}, short sleeves, pleated skirt");
  assert.equal(o.fixed, "1girl, solo, {red hair}, high ponytail, {red eyes}, large breasts");
  assert.equal(o.outfit, "{black jersey}, short sleeves, pleated skirt");
  // 내가 기억시킨 칸을 따른다: 티아라를 인물 고정으로 옮겨 두면 고정에 남는다
  const memo = { "gold tiara": "traits" }; setSlotMemo(memo);
  try { assert.equal(splitPerson("silver hair, gold tiara, dress").fixed, "silver hair, gold tiara"); } finally { setSlotMemo({}); }
});

test("sceneKeys: 이름 붙은 칸만, 꼴이 달라도 (짤뽑기최적화가 이것으로 바꿀 칸을 고름)", () => {
  assert.deepEqual(sceneKeys("outfit: suit\npose: arms crossed"), ["outfit", "pose"]);
  assert.deepEqual(sceneKeys("- outfit: suit\n- pose: arms crossed"), ["outfit", "pose"]);
  assert.deepEqual(sceneKeys("**outfit:** suit\n**pose:** arms crossed"), ["outfit", "pose"]);
  assert.deepEqual(sceneKeys("의상: suit\n자세: arms crossed\n배경: office"), ["outfit", "pose", "bg"]);
  assert.deepEqual(sceneKeys("1girl, solo, suit"), []);
  assert.deepEqual(sceneKeys("artist:foo, suit"), []); // 이름표 태그는 칸 이름이 아니다
});
