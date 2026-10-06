import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "../lib/ruleset.mjs";
import { loadCities, cityTierInfo } from "../lib/city.mjs";
import { generateReport } from "../lib/pipeline.mjs";
import { buildSample } from "../lib/sample.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const ruleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
const cities = loadCities(path.join(WEB_DIR, "config", "cities.json"));
const sample = buildSample(path.join(REPO_ROOT, "knowledge", "cases.json"), "C-022");

async function makeReport(form) {
  const info = cityTierInfo(form.city, cities);
  return generateReport({ form: form, photos: [], ruleset: ruleset, cities: cities, cityTier: info.tier, cityMatched: info.matched, config: { configured: false } });
}

function portraitIds(report) {
  return report.portrait.concrete.upper.concat(report.portrait.concrete.lower).map((item) => item.id).sort();
}
function missingDims(report) {
  return report.portrait.concrete.missing.map((item) => item.dimension).sort();
}

test("解锁字段（表单/字典）：存在、可留空、已进 facts 字典", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(WEB_DIR, "config", "form-fields.json"), "utf8"));
  ["self_rank_position", "self_rank_pool", "activity_type"].forEach((id) => {
    const field = cfg.fields.find((item) => item.id === id);
    assert.ok(field, "表单必须有字段：" + id);
    assert.equal(field.required, false, "必须允许留空（D28）：" + id);
  });
  const facts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "knowledge", "facts.json"), "utf8"));
  const declared = new Set((facts.facts || []).map((item) => item.field));
  ["subject.self_rank_position", "subject.self_rank_pool", "subject.activity_type"].forEach((field) => {
    assert.ok(declared.has(field), "facts.json 必须声明字段（规则作者可查）：" + field);
  });
});

test("解锁字段：不填 / 留空 / 未知 → 分数与画像完全一致（D28：留空不等于降级）", async () => {
  const base = await makeReport(sample.form);
  const variants = {
    "空字符串": Object.assign({}, sample.form, { self_rank_position: "", self_rank_pool: "", activity_type: "" }),
    "null": Object.assign({}, sample.form, { self_rank_position: null, self_rank_pool: null, activity_type: null }),
    "unknown": Object.assign({}, sample.form, { self_rank_position: "unknown", self_rank_pool: "unknown", activity_type: "unknown" }),
    "不存在的键": sample.form
  };
  for (const [label, form] of Object.entries(variants)) {
    const report = await makeReport(form);
    assert.equal(report.level, base.level, label + "：分数必须与不填完全一致（" + report.level + " vs " + base.level + "）");
    assert.equal(report.hardware.score, base.hardware.score, label + "：硬件分不得变化");
    assert.deepEqual(portraitIds(report), portraitIds(base), label + "：画像条目不得变化");
    assert.deepEqual(missingDims(report), missingDims(base), label + "：缺口列表不得变化");
    assert.ok(missingDims(report).indexOf("职业/身份") !== -1, label + "：不填时职业身份仍应列在「无法给出」");
  }
  console.log("[unlock] 不填/留空/未知 三种情况：level=" + base.level + "，画像 " + portraitIds(base).length + " 条，缺口 " + missingDims(base).join("、"));
});

test("解锁字段：填了 → rank / channel 档位画像自动接入，分数不变", async () => {
  const base = await makeReport(sample.form);
  const filled = await makeReport(Object.assign({}, sample.form, { self_rank_position: 3, self_rank_pool: 40, activity_type: "three" }));

  assert.equal(filled.level, base.level, "解锁输入不得改变分数（档位只影响画像）");
  assert.equal(filled.hardware.score, base.hardware.score);

  const ids = portraitIds(filled);
  const unlocked = ids.filter((id) => id.indexOf("UP-RANK-BAND") === 0 || id.indexOf("UP-CHANNEL-BAND") === 0);
  assert.ok(ids.some((id) => id.indexOf("UP-RANK-BAND") === 0), "必须解锁打分局名次档画像");
  assert.ok(ids.some((id) => id.indexOf("UP-CHANNEL-BAND") === 0), "必须解锁活动渠道档画像");
  assert.equal(missingDims(filled).indexOf("职业/身份"), -1, "解锁后职业身份不得再列「无法给出」");

  const items = filled.portrait.concrete.upper.filter((item) => unlocked.indexOf(item.id) !== -1);
  items.forEach((item) => {
    assert.equal(item.category, "target-attribute", "解锁条目必须是对方条件类：" + item.id);
    assert.ok((item.evidence || []).length > 0, "解锁条目必须带证据：" + item.id);
  });
  assert.ok(filled.portrait.concrete.self.indexOf("打分局第 3 名（40 人池）") !== -1, "定位行必须显示填入的名次口径");
  console.log("[unlock] 解锁条目：" + items.map((item) => item.id + "（" + item.dimension + "）").join("、"));
  console.log("[unlock] 解锁后的缺口：" + missingDims(filled).join("、") + "（解锁前：" + missingDims(base).join("、") + "）");
});

test("解锁字段（部分填）：只填名次 → 只有 rank 解锁；只填活动 → 只有 channel 解锁", async () => {
  const rankOnly = await makeReport(Object.assign({}, sample.form, { self_rank_position: 3 }));
  const channelOnly = await makeReport(Object.assign({}, sample.form, { activity_type: "three" }));
  assert.ok(portraitIds(rankOnly).some((id) => id.indexOf("UP-RANK-BAND") === 0), "只填名次应解锁 rank");
  assert.equal(portraitIds(rankOnly).some((id) => id.indexOf("UP-CHANNEL-BAND") === 0), false, "未填活动不得解锁 channel");
  assert.ok(portraitIds(channelOnly).some((id) => id.indexOf("UP-CHANNEL-BAND") === 0), "只填活动应解锁 channel");
  assert.equal(portraitIds(channelOnly).some((id) => id.indexOf("UP-RANK-BAND") === 0), false, "未填名次不得解锁 rank");
});
