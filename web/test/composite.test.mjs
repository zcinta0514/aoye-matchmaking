import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset, getComposite } from "../lib/ruleset.mjs";
import { loadCities, cityTierInfo } from "../lib/city.mjs";
import { loadCompositeCriteria, loadCompositeMapping, scoreComposite, mapNormalizedToScale } from "../lib/composite.mjs";
import { generateReport } from "../lib/pipeline.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const ruleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
const cities = loadCities(path.join(WEB_DIR, "config", "cities.json"));
const criteria = loadCompositeCriteria(path.join(WEB_DIR, "config", "composite-criteria.json"));
const mapping = loadCompositeMapping(path.join(WEB_DIR, "config", "composite-mapping.json"));
const maleComposite = getComposite(ruleset, "hardware.male");

const BASE = { gender: "male", age: 28, city: "杭州", weight_kg: 70, school_tier: "211", marital: "single", family_origin: "urban_normal", personality: "warm", communication: 4, emotional_stability: 4, living_skills: 4, social_circle: 3, want_gender: "female", want_age_min: 24, want_age_max: 32, want_height_min: 160, want_education_min: "bachelor", want_house: "no", want_appearance_min: 5, self_appearance: 5, self_rank: "mid", admiration_freq: "sometimes", photo_quality: "raw", face_natural: "yes" };
const PERFECT = Object.assign({}, BASE, { height_cm: 180, education: "bachelor", has_house: "paid", has_car: "high", income_wan: 30, occupation: "gov", hukou: "local", siblings: "only", siblings_detail: "only_child", parents_pension: "both", family_atmosphere: "harmonious" });
const EMPTY = Object.assign({}, BASE, { height_cm: 160, education: "highschool", has_house: "none", has_car: "none", income_wan: 2, occupation: "freelance", hukou: "rural", siblings: "has", siblings_detail: "mixed", parents_pension: "none", family_atmosphere: "conflict" });

test("反向断言（D17）：十项全达标 → 归一化 ≥80；十项全缺 → <60", () => {
  const perfect = scoreComposite({ composite: maleComposite, criteria, mapping, form: PERFECT, context: { cityTier: 2 } });
  const empty = scoreComposite({ composite: maleComposite, criteria, mapping, form: EMPTY, context: { cityTier: 3 } });
  assert.equal(perfect.rawMax, 110);
  assert.ok(perfect.normalized >= 80, "全达标必须 ≥80，实际 " + perfect.normalized + "（raw " + perfect.raw + "）");
  assert.equal(perfect.raw, 110, "十项全达标 = 110/110（含车项加成）");
  assert.equal(perfect.normalized, 100);
  assert.ok(perfect.scaleScore >= 7, "按映射表 80+ 应对应 7 分档");
  assert.ok(empty.normalized < 60, "全缺必须 <60，实际 " + empty.normalized);
  assert.ok(empty.scaleScore < 4.5);
  assert.equal(perfect.items.filter((item) => item.hit).length, 10, "十项全部达标");
  assert.equal(perfect.items.find((item) => item.id === "item.car").bonusHit, true, "high 车必须拿到加成");
  assert.equal(perfect.gaps.length, 0, "父母退休金 / 原生家庭氛围字段已吸收，无表单缺口");
  assert.equal(perfect.computableMax, 110);
  assert.equal(perfect.computableMaxNormalized, 100);
});

test("归一化映射表可配置：81.8 → 7 分档", () => {
  const mapped = mapNormalizedToScale(81.8, mapping.bands);
  assert.equal(mapped.score, 7);
  assert.equal(mapNormalizedToScale(59, mapping.bands).score, 3);
  assert.equal(mapNormalizedToScale(100, mapping.bands).score, 8.5);
});

test("pipeline：男生硬件分走语料复合表，工程权重仅作参考；女生走工程权重并标工程默认", async () => {
  const cfg = { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 };
  const male = await generateReport({ form: PERFECT, photos: [], ruleset, cities, cityTier: 2, cityMatched: true, config: cfg });
  assert.equal(male.hardware.basis, "corpus-composite");
  assert.equal(male.hardware.basisStrength, "single-source", "复合表为定义型单源（D21）");
  assert.ok(male.hardware.composite && male.hardware.composite.normalized >= 80);
  assert.equal(male.hardware.score, male.hardware.composite.scaleScore);
  assert.notEqual(male.hardware.engineeringScore, null);
  const hwComponent = male.confidence.levelComponents.find((item) => item.key === "hardware");
  assert.equal(hwComponent.value, male.hardware.composite.scaleScore, "综合分中的硬件槽位必须用复合表（D21：定义型单源允许计入 level）");
  assert.equal(hwComponent.strength, "single-source", "level 基准强度必须标为 single-source");
  assert.ok(hwComponent.note.indexOf("定义型") !== -1);
  assert.equal(hwComponent.rationale.indexOf("定义型单源") !== -1, true);
  assert.ok(male.caveats.some((item) => item.type === "composite-basis"));
  assert.equal(male.caveats.some((item) => item.type === "composite-form-gaps"), false, "字段已补齐，不应再有表单缺口告警");
  assert.ok(male.evidenceIndex.some((item) => item.usedFor === "composite:hardware.male"));

  const femaleForm = Object.assign({}, PERFECT, { gender: "female", want_gender: "male" });
  const female = await generateReport({ form: femaleForm, photos: [], ruleset, cities, cityTier: 2, cityMatched: true, config: cfg });
  assert.equal(female.hardware.basis, "engineering-weights");
  assert.ok(female.hardware.composite === null || female.hardware.composite.available === false, "女生复合表暂不可用时应保持工程权重口径");
  if (ruleset.composites.some((item) => item.id === "hardware.female")) {
    assert.ok(female.caveats.some((item) => item.type === "composite-no-criteria"), "知识库新增复合表但 web 缺逐项条件时必须显式说明");
  }
  assert.equal(female.hardware.basisStrength, "engineering-default");
  assert.equal(female.hardware.composite, null);
  assert.ok(female.caveats.some((item) => item.type === "hardware-basis-engineering"));
});

test("behavior composite：独立展示、不接入任何分数（D1）", async () => {
  const cfg = { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 };
  const report = await generateReport({ form: PERFECT, photos: [], ruleset, cities, cityTier: 2, cityMatched: true, config: cfg });
  assert.ok(report.behaviorCheck);
  assert.equal(report.behaviorCheck.usage, "standalone-advisory");
  assert.ok(report.behaviorCheck.anchors.length >= 3);
  assert.ok(report.evidenceIndex.some((item) => item.usedFor === "composite:behavior"));
  assert.equal(Object.keys(report.confidence.summary.byStrength).indexOf("behavior"), -1);
  const allItems = report.hardware.breakdown.concat(report.soft.breakdown);
  assert.equal(allItems.some((item) => item.id.indexOf("behavior") !== -1), false, "behavior 不得出现在计分项里");
  const counted = report.confidence.levelComponents.filter((item) => item.counted && typeof item.value === "number");
  const expected = counted.reduce((acc, item) => acc + item.value * item.weight, 0) / counted.reduce((acc, item) => acc + item.weight, 0);
  assert.ok(Math.abs(report.level - expected) < 0.01, "level 只能由 levelComponents 的计分项加权而来");
});
