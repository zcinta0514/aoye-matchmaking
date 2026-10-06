import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset, validateRulesDoc, getScale } from "../lib/ruleset.mjs";
import { loadCities, cityTier, cityTierInfo } from "../lib/city.mjs";
import { evalCondition, mapAnchorsToInterval, buildSelfTrack, blendAppearance, applyClamps, scoreGroup, scoreDimension, runRules, resolveBand } from "../lib/engine.mjs";
import { getPath } from "../lib/util.mjs";
import { generateReport } from "../lib/pipeline.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const ruleset = loadRuleset({
  mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"),
  baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json")
});
const cities = loadCities(path.join(WEB_DIR, "config", "cities.json"));

function writeTempRules(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-rules-"));
  const file = path.join(dir, "rules.json");
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

function baseRulesDoc(rules, dimensions) {
  return {
    version: "9.9",
    generatedAt: "2026-10-05T00:00:00Z",
    scales: [{ id: "appearance", name: "颜值分", min: 1, max: 9, anchors: [{ label: "普通人", score: 3.5, min: 3, max: 4, observable: [] }], evidence: [] }],
    dimensions: dimensions || [],
    rules: rules || [],
    bands: [],
    evidence: []
  };
}

test("ruleset: knowledge 优先、基线补缺、machine 分层统计", () => {
  assert.ok(/^[0-9]+[.][0-9]+/.test(ruleset.main.version));
  const knowledgeDim = ruleset.dimensions.find((dim) => dim.id === "face.three_courts");
  assert.equal(knowledgeDim._origin, "knowledge");
  const baselineDim = ruleset.dimensions.find((dim) => dim._origin === "web-baseline");
  assert.ok(baselineDim);
  assert.equal(ruleset.coverage.baseline.executableRules, 7, "D23 退役 4 条无源 giveUp 后基线可执行规则应为 7");
  assert.ok(ruleset.coverage.knowledge.executableRules >= 1);
  assert.ok(ruleset.coverage.knowledge.advisoryRules >= 1);
  assert.ok(ruleset.executableRules.filter((rule) => rule.machine).length >= 11);
  assert.ok(ruleset.supersededDimensions.length >= 10);
});

test("ruleset: 主规则集 0 条可执行时必须告警", () => {
  const doc = baseRulesDoc([{ id: "R-AAA-001", scope: "scoring", when: "自然语言条件", then: "自然语言结论", confidence: "low", evidence: [{ account: "aoye98", aweme_id: "7644902230331542826", quote: "三庭比例" }] }]);
  const custom = loadRuleset({ mainPath: writeTempRules(doc), baselinePath: null });
  assert.equal(custom.coverage.knowledge.executableRules, 0);
  assert.ok(custom.warnings.some((warning) => warning.indexOf("没有可执行规则") !== -1));
  assert.ok(custom.unstructuredRules.length === 1);
});

test("cityTier: 一线 / 新一线 / 其它", () => {
  assert.equal(cityTier("北京", cities), 1);
  assert.equal(cityTier("杭州市", cities), 2);
  assert.equal(cityTier("南昌", cities), 3);
  assert.equal(cityTierInfo("南昌", cities).matched, false);
  assert.equal(cityTierInfo("杭州市", cities).matched, true);
  assert.equal(cityTierInfo("北京", cities).tier, 1);
});

test("DSL 严格化：未知键、未知 op、非法形状一律报错", () => {
  const facts = { subject: { age: 30 }, want: { appearance_gap: 1.5 } };
  assert.equal(evalCondition({ field: "subject.age", op: "gte", value: 30 }, facts), true);
  assert.equal(evalCondition({ all: [{ field: "subject.age", op: "lt", value: 40 }, { field: "want.appearance_gap", op: "gte", value: 1 }] }, facts), true);
  assert.equal(evalCondition({ any: [{ field: "subject.age", op: "gt", value: 40 }] }, facts), false);
  assert.equal(evalCondition({ not: { field: "subject.age", op: "eq", value: 18 } }, facts), true);
  assert.throws(() => evalCondition({ all2: [] }, facts), /非法条件键/);
  assert.throws(() => evalCondition({ field: "subject.age", op: "gtte", value: 1 }, facts), /非法 op/);

  assert.throws(
    () => validateRulesDoc(baseRulesDoc([{ id: "R-AAA-001", scope: "scoring", when: "x", then: "y", machine: { when: { field: "subject.age", op: "eqq", value: 1 } }, evidence: [] }]), { label: "t", strict: false }),
    /非法 op/
  );
});

test("加载期拒绝非法 op / 未知条件键", () => {
  const badOp = writeTempRules(baseRulesDoc([{ id: "R-AAA-001", scope: "scoring", when: "x", then: "y", confidence: "low", machine: { when: { field: "subject.age", op: "wat", value: 1 } }, evidence: [] }]));
  assert.throws(() => loadRuleset({ mainPath: badOp, baselinePath: null }), /非法 op/);
  const badKey = writeTempRules(baseRulesDoc([{ id: "R-AAA-002", scope: "scoring", when: "x", then: "y", confidence: "low", machine: { when: { all2: [] } }, evidence: [] }]));
  assert.throws(() => loadRuleset({ mainPath: badKey, baselinePath: null }), /未知条件键/);
  const badKind = writeTempRules(baseRulesDoc([{ id: "R-AAA-003", scope: "scoring", when: "x", then: "y", confidence: "low", machine: { when: { field: "subject.age", op: "gte", value: 1 }, then: [{ kind: "explode" }] }, evidence: [] }]));
  assert.throws(() => loadRuleset({ mainPath: badKind, baselinePath: null }), /非法 kind/);
  // 非法主规则集绝不静默回退到基线：
  assert.throws(() => loadRuleset({ mainPath: badOp, baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") }), /非法 op/);
  assert.throws(() => loadRuleset({ mainPath: badKey, baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") }), /未知条件键/);
});

test("BUG-APPEARANCE-NULL：未填自评不得伪造区间", async () => {
  const scale = getScale(ruleset, "appearance");
  [null, undefined, "", "abc", 0, 10, NaN].forEach((value) => {
    const track = buildSelfTrack({ self_appearance: value }, scale);
    assert.equal(track, null, "self_appearance=" + String(value) + " 必须返回 null");
  });
  assert.ok(buildSelfTrack({ self_appearance: 6 }, scale));
  assert.equal(blendAppearance(scale, null, null), null);

  const formWithoutSelf = { gender: "female", age: 29, city: "杭州", height_cm: 163, education: "master", school_tier: "211", occupation: "gov", income_wan: 22, has_house: "loan", has_car: "none", hukou: "local", marital: "single", family_origin: "urban_normal", siblings: "only", personality: "warm", communication: 3, emotional_stability: 4, want_gender: "male", want_age_min: 27, want_age_max: 36, want_height_min: 178, want_education_min: "bachelor", want_house: "yes", want_appearance_min: 6, self_rank: "top25", admiration_freq: "sometimes", photo_quality: "raw", face_natural: "yes" };
  const report = await generateReport({
    form: formWithoutSelf, photos: [], ruleset, cities, cityTier: 2, cityMatched: true,
    config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 }
  });
  assert.equal(report.appearance.final, null);
  assert.equal(report.appearance.selfMissing, true);
  assert.equal(report.appearance.countableForLevel, false);
  assert.ok(report.caveats.some((item) => item.type === "appearance-self-missing"));
  assert.equal(report.confidence.levelComponents.find((item) => item.key === "appearance").counted, false);
  if (typeof report.level === "number") {
    const countable = report.confidence.levelComponents.filter((item) => item.counted && typeof item.value === "number");
    const expected = countable.reduce((acc, item) => acc + item.value * item.weight, 0) / countable.reduce((acc, item) => acc + item.weight, 0);
    assert.ok(Math.abs(report.level - expected) < 0.02, "level 必须在排除颜值后重新归一化");
  }
});

test("颜值：锚点映射区间 → 自评区间 → 交叉校准（阈值可配置）", () => {
  const scale = getScale(ruleset, "appearance");
  const anchors = scale.anchors;
  const [ordinaryAnchor, upperAnchor] = anchors;

  const ordinary = mapAnchorsToInterval([{ label: ordinaryAnchor.label, fit: 0.8 }], anchors, scale);
  assert.deepEqual([ordinary.low, ordinary.high], [ordinaryAnchor.min, ordinaryAnchor.max]);

  const strong = mapAnchorsToInterval([{ label: upperAnchor.label, fit: 0.9 }, { label: ordinaryAnchor.label, fit: 0.4 }], anchors, scale);
  assert.deepEqual([strong.low, strong.high], [Math.max(ordinaryAnchor.min - 0.5, scale.min), Math.min(upperAnchor.max + 0.5, scale.max)]);

  const tuned = mapAnchorsToInterval([{ label: upperAnchor.label, fit: 0.9 }, { label: ordinaryAnchor.label, fit: 0.4 }], anchors, scale, { weakPad: 0 });
  assert.deepEqual([tuned.low, tuned.high], [ordinaryAnchor.min, upperAnchor.max]);

  assert.equal(mapAnchorsToInterval([{ label: ordinaryAnchor.label, fit: 0.1 }], anchors, scale), null);

  const selfHigh = buildSelfTrack({ self_appearance: 7, self_rank: "top10", admiration_freq: "rare", photo_quality: "raw" }, scale);
  assert.equal(selfHigh.adjusted, 6.5);
  const noPenalty = buildSelfTrack({ self_appearance: 7, self_rank: "top10", admiration_freq: "rare", photo_quality: "raw" }, scale, { contradictionPenalty: 0 });
  assert.equal(noPenalty.adjusted, 7);

  const consensus = blendAppearance(scale, ordinary, buildSelfTrack({ self_appearance: 4, self_rank: "mid", admiration_freq: "sometimes" }, scale));
  assert.ok(consensus.low >= scale.min && consensus.high <= 4.5);

  const divergent = blendAppearance(scale, ordinary, buildSelfTrack({ self_appearance: 7, self_rank: "mid", admiration_freq: "often" }, scale), { maxUnionWidth: 2 });
  assert.equal(divergent.consensus, false);
  assert.ok(divergent.high - divergent.low <= 2);

  const clamped = applyClamps(divergent, [{ ruleId: "R-BASE-SCORE-001", scale: "appearance", max: 6 }], scale);
  assert.equal(clamped.interval.high, 6);
  assert.equal(clamped.applied.length, 1);
});

test("维度评分：bands / options / scale1to5 / 知识维度计分", () => {
  const legacyHeight = ruleset.dimensions.find((dim) => dim.id === "hardware.height");
  assert.equal(legacyHeight, undefined, "知识库 dim.height 接管后，基线 hardware.height 应被移除");

  const knowledgeHeight = ruleset.dimensions.find((dim) => dim.id === "dim.height");
  const maleLow = scoreDimension(knowledgeHeight, { height_cm: 165 }, { gender: "male", cityTier: 2 }).score;
  const maleHigh = scoreDimension(knowledgeHeight, { height_cm: 180 }, { gender: "male", cityTier: 2 }).score;
  const femaleMid = scoreDimension(knowledgeHeight, { height_cm: 178 }, { gender: "female", cityTier: 2 }).score;
  [maleLow, maleHigh, femaleMid].forEach((score) => assert.ok(typeof score === "number" && score >= 1 && score <= 9, "知识维度分数必须在 1–9"));
  assert.ok(maleHigh >= maleLow, "身高分档必须单调（180 ≥ 165）");

  const legacyAge = ruleset.dimensions.find((dim) => dim.id === "hardware.age");
  assert.equal(scoreDimension(legacyAge, { age: 28 }, { gender: "male", cityTier: 2 }).score, 6);

  const tierDim = {
    id: "demo.income", field: "income_wan", name: "收入", group: "hardware", weight: 0.1,
    scoring: { type: "bands", byCityTier: { "1": [{ max: 30, score: 5 }], "3": [{ max: 30, score: 6.5 }] } }
  };
  assert.equal(scoreDimension(tierDim, { income_wan: 25 }, { gender: "male", cityTier: 1 }).score, 5);
  assert.equal(scoreDimension(tierDim, { income_wan: 25 }, { gender: "male", cityTier: 3 }).score, 6.5);

  const scaleDim = { id: "demo.communication", field: "communication", name: "沟通", group: "soft", weight: 0.3, scoring: { type: "scale1to5", scores: [1, 3, 5, 7, 9] } };
  assert.equal(scoreDimension(scaleDim, { communication: 5 }, { gender: "male", cityTier: 2 }).score, 9);

  const knowledgeDim = {
    id: "looks.height", field: "height_cm", name: "身高档", group: "hardware", weight: 0.2, _origin: "knowledge",
    scoring: { type: "bands", bands: [{ min: 175, max: 190, score: 6 }, { min: 165, max: 175, score: 5 }, { min: 100, max: 165, score: 3 }] }
  };
  assert.equal(scoreDimension(knowledgeDim, { height_cm: 178 }, { gender: "male", cityTier: 2 }).score, 6);
  assert.equal(scoreDimension(knowledgeDim, { height_cm: 170 }, { gender: "male", cityTier: 2 }).score, 5);

  const optionsDim = { id: "x", field: "education", name: "学历", group: "hardware", weight: 0.1, scoring: { type: "options", options: [{ value: "bachelor", score: 5 }] } };
  assert.equal(scoreDimension(optionsDim, { education: "bachelor" }, { gender: "male", cityTier: 2 }).score, 5);
  const noWeight = scoreGroup([optionsDim], { education: "bachelor" }, { gender: "male", cityTier: 2 });
  assert.equal(noWeight.items[0].counted, true);
  const missingWeightDim = Object.assign({}, optionsDim, { weight: null });
  const groupScore = scoreGroup([missingWeightDim], { education: "bachelor" }, { gender: "male", cityTier: 2 });
  assert.equal(groupScore.items[0].counted, false);
  assert.ok(groupScore.items[0].note.indexOf("权重缺失") !== -1);
});

test("规则执行：machine 动作全类型 + 出处", () => {
  const rules = [{
    id: "R-TEST-001", scope: "scoring", title: "合成测试规则",
    when: "自然语言", then: "自然语言",
    machine: { when: { all: [{ field: "subject.self_appearance", op: "gte", value: 7 }, { field: "subject.face_natural", op: "neq", value: "yes" }] }, then: [
      { kind: "clampScale", scale: "appearance", max: 6.5 },
      { kind: "advice", text: "自评 {{subject.self_appearance}} 分需要原生脸证明。" },
      { kind: "giveUp", text: "7 分档暂不成立。" },
      { kind: "text", text: "补充说明" },
      { kind: "flag", text: "需要人工复核" },
      { kind: "requireEvidence", text: "7 分档必须有语料证据" }
    ] },
    confidence: "low", evidence: [{ account: "aoye98", aweme_id: "7644902230331542826", quote: "你脸没动过是吧？" }]
  }];
  const facts = { subject: { self_appearance: 8, face_natural: "no" }, appearance: { final: { low: 6, high: 8 } } };
  const run = runRules(rules, facts, ["scoring"]);
  assert.equal(run.applied.length, 1);
  assert.equal(run.applied[0].via, "machine");
  const kinds = run.effects.map((effect) => effect.kind);
  ["clamp", "advice", "giveUp", "note", "flag", "requireEvidence"].forEach((kind) => assert.ok(kinds.indexOf(kind) !== -1, "missing " + kind));
  assert.equal(run.effects.find((effect) => effect.kind === "clamp").max, 6.5);
  assert.equal(run.effects.find((effect) => effect.kind === "requireEvidence").hasEvidence, true);
  assert.equal(run.errors.length, 0);
});


test("梯队解析 / 路径解析 / 低沟通建议", () => {
  assert.equal(resolveBand(ruleset.bands, 5.2).id, "B");
  const facts = { soft: { breakdown: { "soft.communication": 3 }, score: 5 } };
  assert.equal(getPath(facts, "soft.breakdown.soft.communication"), 3);
  assert.equal(getPath(facts, "soft.score"), 5);
  const run = runRules(ruleset.executableRules, {
    subject: { gender: "female", city: "南昌", communication: 3 },
    context: { cityTier: 3 },
    hardware: { breakdown: { "hardware.height": 5 } },
    soft: { breakdown: { "soft.communication": 3 } },
    appearance: { final: { low: 5, high: 6, mid: 5.5 }, divergence: 0, divergenceAbs: 0, photoTrack: {} },
    want: {}
  }, ["matching", "advice"]);
  assert.ok(run.effects.some((effect) => effect.kind === "advice" && effect.id === "ADV-BASE-012"));
});

test("读图失败必须降级而不是抛错（P0-1 回归）", async () => {
  const missingPhoto = { id: "ph_x", path: "/tmp/definitely-not-exists-aoye.jpg", mime: "image/jpeg" };
  const report = await generateReport({
    form: { gender: "female", age: 29, city: "杭州", height_cm: 163, education: "master", school_tier: "211", occupation: "gov", income_wan: 22, has_house: "loan", has_car: "none", hukou: "local", marital: "single", family_origin: "urban_normal", siblings: "only", personality: "warm", communication: 3, emotional_stability: 4, want_gender: "male", want_age_min: 27, want_age_max: 36, want_height_min: 178, want_education_min: "bachelor", want_house: "yes", want_appearance_min: 6, self_appearance: 6, self_rank: "top25", admiration_freq: "sometimes", photo_quality: "raw", face_natural: "yes" },
    photos: [missingPhoto],
    ruleset,
    cities,
    cityTier: 2,
    fetchImpl: async () => { throw new Error("should not be called"); },
    config: { configured: true, apiKey: "test", baseUrl: "http://stub.local/v1", model: "stub", vision: "auto", jsonMode: "auto", timeoutMs: 1000 }
  });
  assert.equal(report.engine.photoMode, "error");
  assert.ok(report.appearance.photoTrack.caveats.join(" ").indexOf("读取照片失败") !== -1);
  assert.ok(report.appearance.final.low <= report.appearance.final.high);
});

test("D24：无语料档位时不得输出档位结论（baseline 仅作参照刻度）", async () => {
  const evidence = [
    { account: "aoye98", aweme_id: "7644902230331542826", quote: "三庭比例，脸型大小" },
    { account: "47590488570", aweme_id: "7664928566988175995", quote: "1-9分的外表男生评价" }
  ];
  const doc = {
    version: "9.9", generatedAt: "2026-10-06T00:00:00Z",
    scales: [{ id: "appearance", name: "颜值分", min: 1, max: 9, anchors: [{ label: "普通人", score: 3.5, min: 3, max: 4, observable: [] }], evidence }],
    dimensions: [{ id: "dim.height", name: "身高", group: "hardware", type: "numeric", field: "height_cm", weight: 0.5, scoring: { type: "bands", bands: [{ max: 200, score: 6 }] }, evidence }],
    rules: [],
    bands: [],
    glossary: []
  };
  const custom = loadRuleset({ mainPath: writeTempRules(doc), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
  const form = { gender: "male", age: 28, city: "杭州", height_cm: 178, education: "bachelor", school_tier: "ordinary", occupation: "private", income_wan: 20, has_house: "loan", has_car: "mid", hukou: "local", marital: "single", family_origin: "urban_normal", siblings: "only", personality: "warm", communication: 4, emotional_stability: 4, want_gender: "female", want_age_min: 24, want_age_max: 32, want_height_min: 160, want_education_min: "bachelor", want_house: "no", want_appearance_min: 5, self_appearance: 5, self_rank: "mid", admiration_freq: "sometimes", photo_quality: "raw", face_natural: "yes" };
  const report = await generateReport({
    form, photos: [], ruleset: custom, cities, cityTier: 2, cityMatched: true,
    config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 }
  });
  assert.equal(report.portrait.band, null, "知识库 bands 为空时不得输出任何档位结论");
  assert.ok(report.portrait.bandNote.indexOf("无语料档位可映射") !== -1);
  assert.ok(report.portrait.text.indexOf("无语料档位可映射") !== -1);
  assert.ok(report.portrait.text.indexOf("S/A/B/C") !== -1, "必须显式声明不输出自创档位");
  assert.equal(report.portrait.text.indexOf("落在"), -1, "不得出现「落在 X 档」这类结论句");
  assert.ok(report.caveats.some((item) => item.type === "band-vocabulary"));
  const reference = report.portrait.referenceScale || [];
  assert.equal(reference.length, 4, "baseline 只能作为参照刻度保留");
  assert.ok(reference.every((item) => item.referenceOnly === true));
  assert.equal(report.matchWindow.strength, "engineering-default");
});
test("知识库 v1.2：machine 规则 + 知识维度计分 + setBand 贯通", async () => {
  const evidence = [{ account: "aoye98", aweme_id: "7644902230331542826", quote: "但是细看还行，就您的三庭比例，脸型大小，你的鼻子是你自己的吗？" }];
  const doc = {
    version: "2.0",
    generatedAt: "2026-10-05T00:00:00Z",
    scales: [{ id: "appearance", name: "颜值分", min: 1, max: 9, anchors: [{ label: "普通人", score: 3.5, min: 3, max: 4, observable: ["无记忆点"] }], evidence }],
    dimensions: [{
      id: "looks.height", name: "身高档", group: "hardware", type: "numeric", field: "height_cm", weight: 0.5,
      scoring: { type: "bands", bands: [{ min: 100, max: 170, score: 3 }, { min: 170, max: 200, score: 6 }] },
      evidence
    }],
    rules: [{
      id: "R-LOOKS-001", scope: "band", title: "身高 175+ 进入高个梯队",
      when: "身高 ≥175cm", then: "钉到 B 档并打标记",
      machine: { when: { field: "subject.height_cm", op: "gte", value: 175 }, then: [{ kind: "setBand", band: "B" }, { kind: "flag", text: "高个标签" }] },
      confidence: "medium", evidence
    }],
    bands: [{ id: "B", name: "B 档 · 主流", definition: "主流可匹配", range: [4, 6], evidence }],
    glossary: []
  };
  const file = writeTempRules(doc);
  const custom = loadRuleset({ mainPath: file, baselinePath: null });
  assert.equal(custom.coverage.knowledge.executableRules, 1);
  const report = await generateReport({
    form: { gender: "male", age: 30, city: "杭州", height_cm: 178, weight_kg: 72, education: "bachelor", school_tier: "ordinary", occupation: "private", income_wan: 30, has_house: "loan", has_car: "mid", hukou: "local", marital: "single", family_origin: "urban_normal", siblings: "only", personality: "warm", communication: 4, emotional_stability: 4, want_gender: "female", want_age_min: 25, want_age_max: 32, want_height_min: 160, want_education_min: "bachelor", want_house: "no", want_appearance_min: 5, self_appearance: 5, self_rank: "mid", admiration_freq: "sometimes", photo_quality: "raw", face_natural: "yes" },
    photos: [],
    ruleset: custom,
    cities,
    cityTier: 2,
    config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 },
    fetchImpl: async () => { throw new Error("模型不应被调用"); }
  });
  const heightItem = report.hardware.breakdown.find((item) => item.id === "looks.height");
  assert.equal(heightItem.score, 6);
  assert.equal(heightItem.origin, "knowledge");
  assert.equal(heightItem.evidence.length, 1);
  assert.equal(report.evidenceSummary.knowledgeScoredItems >= 1, true);
  assert.equal(report.rulesApplied.some((rule) => rule.ruleId === "R-LOOKS-001" && rule.via === "machine"), true);
  assert.equal(report.portrait.band.id, "B");
  assert.equal(report.portrait.band.engineeringDefault, false, "setBand 钉到知识库梯队时不得标工程默认");
  assert.ok(report.portrait.bandSource.indexOf("R-LOOKS-001") !== -1);
  assert.equal(report.flags.some((flag) => flag.text === "高个标签"), true);
  assert.equal(report.engine.coverage.knowledge.executableRules, 1);
});
