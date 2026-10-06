import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "../lib/ruleset.mjs";
import { loadCities, cityTierInfo } from "../lib/city.mjs";
import { generateReport } from "../lib/pipeline.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const ruleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
const cities = loadCities(path.join(WEB_DIR, "config", "cities.json"));

const BASE = {
  gender: "female", age: 30, city: "杭州", height_cm: 163, weight_kg: 52,
  education: "bachelor", school_tier: "ordinary", occupation: "private", income_wan: 18,
  has_house: "loan", has_car: "mid", hukou: "local", marital: "single",
  family_origin: "urban_normal", siblings: "only", personality: "warm",
  communication: 4, emotional_stability: 4, living_skills: 4, social_circle: 3,
  want_gender: "male", want_age_min: 28, want_age_max: 32, want_height_min: 170,
  want_education_min: "bachelor", want_house: "no", want_appearance_min: 5,
  self_appearance: 5, self_rank: "mid", admiration_freq: "sometimes", photo_quality: "raw", face_natural: "yes"
};

async function run(overrides) {
  const form = Object.assign({}, BASE, overrides);
  const info = cityTierInfo(form.city, cities);
  return generateReport({
    form, photos: [], ruleset, cities, cityTier: info.tier, cityMatched: info.matched,
    config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 }
  });
}

test("D23 退役：三条无源基线 giveUp 不再触发，知识库三条各出且只出一条", async () => {
  ["R-BASE-MATCH-001", "R-BASE-MATCH-002", "R-BASE-MATCH-003", "R-BASE-MATCH-004"].forEach((id) => {
    assert.equal(ruleset.rules.find((rule) => rule.id === id), undefined, id + " 必须已删除（不是 enabled:false）");
  });
  assert.ok(ruleset.baseline.meta.retiredRules.length >= 3, "meta.retiredRules 必须记录退役原因");

  const appearance = await run({ want_appearance_min: 8, self_appearance: 5 });
  assert.equal(appearance.giveUps.length, 1, "颜值要求超上限应只出一条");
  assert.equal(appearance.giveUps[0].ruleId, "R-MATCH-040");
  assert.equal(appearance.giveUps[0].origin, "knowledge");
  assert.equal(appearance.giveUps.some((item) => item.id === "GIVEUP-BASE-001"), false);

  const height = await run({ gender: "male", want_gender: "female", height_cm: 175, want_height_min: 180, want_appearance_min: 5 });
  assert.equal(height.giveUps.length, 1, "男性要求更高应只出一条");
  assert.equal(height.giveUps[0].ruleId, "R-MATCH-049");
  assert.equal(height.giveUps.some((item) => item.id === "GIVEUP-BASE-003"), false);

  const house = await run({ want_house: "yes", has_house: "none" });
  assert.equal(house.giveUps.length, 1, "有房要求与自身无房只出一条（不重复）");
  assert.equal(house.giveUps[0].ruleId, "R-MATCH-050");
  assert.equal(house.giveUps.some((item) => item.id === "GIVEUP-BASE-002"), false);
  assert.equal(house.giveUps.length, 1, "GIVEUP-HOUSE-STRUCTURE 不得与 GIVEUP-BASE-002 重复");
});

test("D23 不变式：基线里 giveUp 规则数量必须为 0（所有放弃项都由知识库驱动）", () => {
  const baselineGiveUps = ruleset.rules.filter((rule) => rule._origin === "web-baseline" && JSON.stringify(rule.machine || {}).indexOf("giveUp") !== -1);
  assert.deepEqual(baselineGiveUps.map((rule) => rule.id), [], "基线不得再有任何 giveUp 规则");
  assert.equal(ruleset.coverage.baseline.executableRules, 7);
  assert.equal(ruleset.baseline.meta.retiredRules.length >= 4, true);
});

test("D23：年龄差 8 岁 → 知识库 advice；基线 004 不再出现（它的合取阈值已退役）", async () => {
  // 纯年龄差人设（颜值要求在自己可达范围内），排除 R-MATCH-040 的干扰
  const report = await run({ age: 30, want_age_max: 38, want_appearance_min: 5, self_appearance: 5 });
  assert.equal(report.giveUps.length, 0, "年龄差本身只应由知识库 advice 覆盖，不出放弃项");
  assert.ok(report.advice.some((item) => item.ruleId === "R-MATCH-041"), "年龄差 7–8 岁应由知识库 advice 覆盖");
  assert.equal(report.rulesApplied.some((rule) => rule.ruleId === "R-BASE-MATCH-004"), false);

  // 原始人设（颜值要求也超出可达上限时）：只允许知识库的 R-MATCH-040 出放弃项，仍不得有基线条目
  const withAppearance = await run({ age: 30, want_age_max: 38, want_appearance_min: 6, self_appearance: 5 });
  assert.ok(withAppearance.giveUps.every((item) => item.origin === "knowledge"), "放弃项必须全部来自知识库");
  assert.equal(withAppearance.giveUps.some((item) => item.id === "GIVEUP-BASE-004"), false);
  assert.ok(withAppearance.advice.some((item) => item.ruleId === "R-MATCH-041"));
});
test("D23 退役：女性身高差 ≥15cm 不再出放弃项（预期行为，不是回归）", async () => {
  const report = await run({ gender: "female", height_cm: 160, want_height_min: 182 });
  assert.equal(report.giveUps.length, 0, "女性身高差不做知识库 giveUp（阈值无源），退役后应完全不出");
  const base003 = ruleset.rules.find((rule) => rule.id === "R-BASE-MATCH-003");
  assert.equal(base003, undefined, "R-BASE-MATCH-003 必须已删除（不是 enabled:false）");
  assert.ok(ruleset.baseline.meta.retiredRules.some((item) => item.id === "R-BASE-MATCH-003"));
});
