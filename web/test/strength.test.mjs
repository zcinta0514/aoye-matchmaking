import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STRENGTH, loadIndependence, loadQualityFlags, downgradeLevel, accountGroup, classifyEvidence, dedupeEvidence, isCountable, strengthOfRule, strengthOfDimension, summarize, weakestClaimLevel, claimBadgeForRule } from "../lib/strength.mjs";
import { loadExtrapolationRules, evaluateExtrapolations } from "../lib/extrapolation.mjs";
import { loadRuleset } from "../lib/ruleset.mjs";
import { loadCities, cityTierInfo } from "../lib/city.mjs";
import { buildSample } from "../lib/sample.mjs";
import { generateReport } from "../lib/pipeline.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);

const E = (account, aweme_id, quote) => ({ account, aweme_id, quote });
const FIVE = "1234567890123456";

test("strength：独立证据分档（条数 + 来源组）", () => {
  const ind = loadIndependence(null); // 缺失独立性文件 -> 启发式 + provisional
  assert.equal(ind.provisional, true);

  const verified = classifyEvidence([E("aoye98", FIVE + "1", "一"), E("47590488570", FIVE + "2", "二"), E("48854385344", FIVE + "3", "三")], ind);
  assert.equal(verified.level, STRENGTH.VERIFIED);
  assert.equal(verified.provisional, true);

  const cross = classifyEvidence([E("aoye98", FIVE + "1", "一"), E("47590488570", FIVE + "2", "二")], ind);
  assert.equal(cross.level, STRENGTH.CROSS_ACCOUNT);

  const single = classifyEvidence([E("aoye98", FIVE + "1", "一")], ind);
  assert.equal(single.level, STRENGTH.SINGLE_SOURCE);

  const none = classifyEvidence([], ind);
  assert.equal(none.level, STRENGTH.ENGINEERING_DEFAULT);
  assert.equal(isCountable(none.level), false);
});

test("strength：aoye98 与 aoye28 视为同一来源组（搬运去重）", () => {
  const ind = loadIndependence(null);
  assert.equal(accountGroup("aoye98", ind), accountGroup("aoye28", ind));
  const three = classifyEvidence([E("aoye98", FIVE + "1", "甲"), E("aoye28", FIVE + "2", "乙"), E("aoye98", FIVE + "3", "丙")], ind);
  assert.equal(three.level, STRENGTH.SINGLE_SOURCE);
  assert.equal(three.groups.length, 1);
});

test("strength：同一句话跨账号搬运只算一条", () => {
  const ind = loadIndependence(null);
  const quote = "5.5分就是有争议的班草、无争议的校草。100个人里保底成5吧。";
  const deduped = dedupeEvidence([E("aoye98", FIVE + "1", quote), E("aoye28", FIVE + "2", quote), E("aoye28", FIVE + "1", "另一句")]);
  assert.equal(deduped.length, 1); // 同句搬运 + 同 aweme_id 都只算一条
  const result = classifyEvidence([E("aoye98", FIVE + "1", quote), E("aoye28", FIVE + "2", quote)], ind);
  assert.equal(result.count, 1);
  assert.equal(result.level, STRENGTH.SINGLE_SOURCE);
});

test("strength：独立性数据就绪后按文件分组（三种格式）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-ind-"));
  const cases = [
    { groups: { g1: ["aoye98", "aoye28"], g2: ["47590488570"] } },
    { accounts: { aoye98: "g1", aoye28: "g1", "47590488570": "g2" } },
    { sources: [{ id: "g1", accounts: ["aoye98", "aoye28"] }, { id: "g2", accounts: ["47590488570"] }] }
  ];
  cases.forEach((doc, index) => {
    const file = path.join(dir, "ind-" + index + ".json");
    fs.writeFileSync(file, JSON.stringify(doc));
    const ind = loadIndependence(file);
    assert.equal(ind.provisional, false);
    assert.equal(accountGroup("aoye98", ind), accountGroup("aoye28", ind));
    const two = classifyEvidence([E("aoye98", FIVE + "1", "甲"), E("47590488570", FIVE + "2", "乙")], ind);
    assert.equal(two.level, STRENGTH.CROSS_ACCOUNT);
    assert.equal(two.provisional, false);
  });
});

test("extrapolation：14 类场景与触发（含待扩字段）", () => {
  const doc = loadExtrapolationRules(path.join(WEB_DIR, "config", "extrapolation-rules.json")).doc;
  assert.equal(doc.scenarios.length, 14);
  assert.equal(doc.scenarios.filter((item) => item.enabled === false).length, 3);

  const female40 = evaluateExtrapolations({ subject: { gender: "female", age: 42 }, context: { cityTier: 2 } }, doc);
  assert.equal(female40.active, true);
  assert.equal(female40.applied[0].id, "exp.female-40plus");
  assert.ok(female40.applied[0].message.indexOf("误差不可估计") !== -1);
  assert.ok(female40.pending.length === 3);

  const young = evaluateExtrapolations({ subject: { gender: "male", age: 28, education: "bachelor", has_house: "loan", has_car: "mid", family_origin: "urban_normal", height_cm: 178, marital: "single", hukou: "local" }, context: { cityTier: 2 } }, doc);
  assert.equal(young.active, false);
});

test("pipeline：C-022 分层可信度 —— 只算有据项，外推降级，保留全量参考", async () => {
  const ruleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
  const cities = loadCities(path.join(WEB_DIR, "config", "cities.json"));
  const sample = buildSample(path.join(REPO_ROOT, "knowledge", "cases.json"), "C-022");
  const info = cityTierInfo(sample.form.city, cities);
  const report = await generateReport({
    form: sample.form, photos: [], ruleset, cities, cityTier: info.tier, cityMatched: info.matched,
    config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 },
    independencePath: path.join(REPO_ROOT, "knowledge", "evidence-independence.json"),
    extrapolationPath: path.join(WEB_DIR, "config", "extrapolation-rules.json")
  });

  assert.equal(typeof report.level, "number");
  assert.equal(typeof report.levelIfAllCounted, "number");
  assert.ok(report.hardware.referenceScore > 0);
  assert.ok(report.evidenceSummary.countableItems >= 1);
  assert.ok(report.excludedItems.length >= 1);
  assert.ok(report.excludedItems.some((item) => item.strength === STRENGTH.EXTRAPOLATED));
  assert.ok(report.excludedItems.some((item) => item.strength === STRENGTH.ENGINEERING_DEFAULT));
  assert.ok(report.confidence.extrapolation.applied.length >= 1);
  assert.ok(report.evidenceIndex.every((item) => item.setStrength));
  assert.ok(report.supersededDimensions.length >= 10);
  assert.ok(report.hardware.breakdown.every((item) => item.strength && item.strengthLabel));
  assert.equal(isCountable(report.appearance.strength), true);
  assert.equal(report.confidence.independence.source, "audit-rules", "独立性数据已就绪，必须用 audit-rules 预计算强度");
  assert.equal(report.caveats.some((item) => item.type === "independence-provisional"), false, "数据就绪后不应再有启发式 caveat");
  assert.ok(report.caveats.some((item) => item.type === "weight-source"));
});

test("audit-rules 独立性数据：预计算强度覆盖全部规则（33/20/99）", () => {
  const file = path.join(REPO_ROOT, "knowledge", "evidence-independence.json");
  const ind = loadIndependence(file);
  assert.equal(ind.available, true);
  assert.equal(ind.provisional, false);
  assert.equal(ind.source, "audit-rules");
  assert.ok(ind.ruleStrength.size > 0);
  const dist = {};
  ind.ruleStrength.forEach((item) => { dist[item.level] = (dist[item.level] || 0) + 1; });
  assert.equal(dist.verified, ind.summary.verified, "规则级 verified 数必须与文件 summary 一致");
  assert.equal(dist["cross-account"], ind.summary.crossAccount);
  assert.equal(dist["single-source"], ind.summary.singleSource);
  assert.equal(dist.verified + dist["cross-account"] + dist["single-source"], ind.ruleStrength.size, "三档合计 = 有强度数据的规则数（可能少于全部规则）");
  assert.equal(accountGroup("aoye28", ind), accountGroup("aoye98", ind), "镜像账号必须同组");

  const rules = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "knowledge", "rules.json"), "utf8")).rules;
  const verifiedRule = rules.find((rule) => rule.id === "R-LOOKS-001");
  const downgraded = rules.find((rule) => rule.id === "R-DEMO-001");
  assert.equal(strengthOfRule(verifiedRule, ind).level, "verified");
  assert.equal(strengthOfRule(verifiedRule, ind).method, "audit-rules");
  const rawDoc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "knowledge", "evidence-independence.json"), "utf8"));
  const entry = (rawDoc.ruleEvidence || []).find((item) => item.ruleId === "R-DEMO-001");
  if (entry) {
    assert.equal(strengthOfRule(downgraded, ind).level, entry.strengthAfterTemplate || entry.evidenceStrength, "强度必须与 audit-rules 导出一致");
    assert.ok(strengthOfRule(downgraded, ind).reason.indexOf("有效账号") !== -1, "理由必须带有效账号数");
  } else {
    assert.ok(strengthOfRule(downgraded, ind).level, "规则必须有强度");
  }
  const localRuleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
  const dimension = localRuleset.dimensions.find((dim) => dim.id === "dim.height");
  const dimStrength = strengthOfDimension(dimension, ind);
  assert.equal(dimStrength.method, "heuristic");
  assert.equal(dimStrength.provisional, true, "维度未经 audit-rules 审计，必须标启发式");
});

test("质量标记（evidence-quality-flags）：high 命中证据降一级，缺文件则 provisional", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-quality-"));
  const file = path.join(dir, "flags.json");
  fs.writeFileSync(file, JSON.stringify({ flags: [
    { aweme_id: "7669023650187644198", account: "47590488570", kind: "loop-echo", severity: "high", detail: "重复 14 次" },
    { aweme_id: "7551510893993987355", account: "30578719968", kind: "loop-echo", severity: "medium", detail: "重复 18 次" }
  ] }));
  const flags = loadQualityFlags(file);
  assert.equal(flags.available, true);
  assert.equal(flags.highCount, 1);
  assert.equal(flags.provisional, false);

  const missing = loadQualityFlags(path.join(dir, "nope.json"));
  assert.equal(missing.available, false);
  assert.equal(missing.provisional, true);
  assert.equal(missing.highCount, 0);

  assert.equal(downgradeLevel("verified"), "cross-account");
  assert.equal(downgradeLevel("cross-account"), "single-source");
  assert.equal(downgradeLevel("single-source"), "single-source");
  assert.equal(downgradeLevel("engineering-default"), "engineering-default");

  const ind = loadIndependence(null);
  ind.qualityFlags = flags;
  const flagged = classifyEvidence([
    { account: "aoye98", aweme_id: "7669023650187644198", quote: "甲" },
    { account: "47590488570", aweme_id: "111111111111111", quote: "乙" },
    { account: "48854385344", aweme_id: "222222222222222", quote: "丙" }
  ], ind);
  assert.equal(flagged.qualityDowngraded, true);
  assert.equal(flagged.level, "cross-account", "verified 命中 high 必须降为 cross-account");
  assert.deepEqual(flagged.qualityFlagged, ["7669023650187644198"]);

  const clean = classifyEvidence([
    { account: "aoye98", aweme_id: "7669023650187644198", quote: "甲" },
    { account: "47590488570", aweme_id: "111111111111111", quote: "乙" }
  ], Object.assign({}, ind, { qualityFlags: missing }));
  assert.equal(clean.level, "cross-account", "无质量数据时不降级（本来就 cross-account）");
  assert.equal(clean.qualityDowngraded, undefined);

  const real = loadQualityFlags(path.join(REPO_ROOT, "knowledge", "evidence-quality-flags.json"));
  assert.equal(real.available, true);
  const expectedHigh = new Set(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "knowledge", "evidence-quality-flags.json"), "utf8")).flags.filter((flag) => flag.severity === "high").map((flag) => flag.aweme_id));
  assert.equal(real.highCount, expectedHigh.size, "highCount 必须与文件内容一致（不写死具体数字）");
  assert.ok(real.totalFlags > 0);
});

test("pipeline：质量标记进入报告（provisional/可用两种状态）", async () => {
  const ruleset2 = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
  const cities2 = loadCities(path.join(WEB_DIR, "config", "cities.json"));
  const sample2 = buildSample(path.join(REPO_ROOT, "knowledge", "cases.json"), "C-022");
  const info2 = cityTierInfo(sample2.form.city, cities2);
  const report = await generateReport({
    form: sample2.form, photos: [], ruleset: ruleset2, cities: cities2, cityTier: info2.tier, cityMatched: info2.matched,
    config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 }
  });
  assert.equal(report.confidence.qualityFlags.available, true);
  assert.ok(report.confidence.qualityFlags.highCount > 0);
  assert.ok(report.caveats.some((item) => item.type === "quality-flags"));
  assert.ok(report.rulesApplied.every((rule) => typeof rule.qualityDowngraded === "boolean"));
});
test("断言级强度：claimLevelStrength 解析 + 最弱断言聚合 + 徽标口径", () => {
  const ind = loadIndependence(path.join(REPO_ROOT, "knowledge", "evidence-independence.json"));
  assert.equal(ind.claims.available, true);
  assert.ok(ind.claims.mode === "claimLevelStrength" || ind.claims.mode === "claimIndex");
  assert.ok(ind.claims.ruleCount > 0, "必须解析出规则级断言索引");
  const dist = {};
  Array.from(ind.claims.byRule.values()).flat().forEach((claim) => { dist[claim.level] = (dist[claim.level] || 0) + 1; });
  assert.equal((dist["supported-multi"] || 0) + (dist["single-source"] || 0) + (dist.unsupported || 0), ind.claims.claimCount, "三档合计 = 断言总数（不写死具体数字）");

  assert.equal(weakestClaimLevel(["supported-multi", "single-source"]), "single-source");
  assert.equal(weakestClaimLevel(["supported-multi", "single-source", "unsupported"]), "unsupported");
  assert.equal(weakestClaimLevel(["supported-multi"]), "supported-multi");
  assert.equal(weakestClaimLevel([]), null);

  const badgeRuleId = Array.from(ind.claims.byRule.keys())[0];
  const badge = claimBadgeForRule(ind, badgeRuleId, "");
  assert.equal(badge.available, true);
  assert.ok(["supported-multi", "single-source", "unsupported"].indexOf(badge.level) !== -1, "徽标必须落在三档内");
  assert.ok(badge.matched.length >= 1);
  assert.ok(badge.totalClaims >= badge.matched.length);
  const fallback = claimBadgeForRule(ind, "R-NOT-A-REAL-RULE", "x");
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.available, false);
});

test("断言级红线：unsupported 不得以肯定语气输出（前置「博主曾提及」）", async () => {
  const ind = loadIndependence(path.join(REPO_ROOT, "knowledge", "evidence-independence.json"));
  ind.claims = {
    available: true, provisional: false, mode: "test", ruleCount: 1, claimCount: 1,
    byRule: new Map([["R-LOOKS-014", [{ ruleId: "R-LOOKS-014", claim: "自评 0.5 档", level: "unsupported", supportUnits: 0, accounts: [], evidence: [] }]]])
  };
  const ruleset2 = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
  const cities2 = loadCities(path.join(WEB_DIR, "config", "cities.json"));
  const sample2 = buildSample(path.join(REPO_ROOT, "knowledge", "cases.json"), "C-022");
  const info2 = cityTierInfo(sample2.form.city, cities2);
  const report = await generateReport({
    form: sample2.form, photos: [], ruleset: ruleset2, cities: cities2, cityTier: info2.tier, cityMatched: info2.matched,
    independence: ind,
    config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 }
  });
  const advice = report.advice.find((item) => item.ruleId === "R-LOOKS-014");
  assert.ok(advice, "C-022 应当命中 R-LOOKS-014");
  assert.equal(advice.unsupportedClaims, true);
  assert.ok(advice.displayText.indexOf("博主曾提及 · 规则内无出处") !== -1, "unsupported 必须带显式标注");
  assert.equal(advice.displayText.slice(0, 1), "（", "标注必须在最前面");
  assert.equal(advice.text.indexOf("博主曾提及"), -1, "原始 text 保持不动（可审计）");
  assert.ok(report.claimsSummary.unsupported >= 1);
  assert.equal(report.claimsSummary.available, true);
  assert.equal(report.claimsSummary.provisional, false);
  assert.equal(report.claimsSummary.total, report.advice.length + report.giveUps.length);
});

test("断言级数据缺失 → 退回规则级标签并标 provisional", async () => {
  const ind = loadIndependence(null);
  assert.equal(ind.claims.available, false);
  assert.equal(ind.claims.provisional, true);
  const badge = claimBadgeForRule(ind, "R-LOOKS-001", "x");
  assert.equal(badge.fallback, true);
  assert.equal(badge.available, false);
});
test("D24：报告档位只说博主词汇（asset/rank/channel），S/A/B/C 仅参照", async () => {
  const ruleset2 = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
  const cities2 = loadCities(path.join(WEB_DIR, "config", "cities.json"));
  const sample2 = buildSample(path.join(REPO_ROOT, "knowledge", "cases.json"), "C-022");
  const info2 = cityTierInfo(sample2.form.city, cities2);
  const report = await generateReport({
    form: sample2.form, photos: [], ruleset: ruleset2, cities: cities2, cityTier: info2.tier, cityMatched: info2.matched,
    config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 }
  });
  assert.ok(report.portrait.band, "C-022 填了 family_wealth=a7，应命中资产档");
  assert.equal(report.portrait.band.origin, "knowledge", "档位只能来自知识库 bands");
  assert.ok(report.portrait.band.name.indexOf("资产档") !== -1 || report.portrait.band.id.indexOf("asset.") === 0, "命中档位应是资产档（语料词汇）");
  assert.ok(report.portrait.text.indexOf("A7 资产档") !== -1);
  assert.ok(report.portrait.text.indexOf("S/A/B/C") !== -1, "必须声明不输出自创档位");
  assert.equal(report.portrait.text.indexOf("B 档"), -1, "结论句里不得出现自创档位");
  assert.ok(report.portrait.missingBandInputs.some((item) => item.indexOf("打分局名次") !== -1), "缺输入的档位要如实列出");
  const knowledgeRows = report.portrait.ladder.filter((item) => item.origin === "knowledge");
  assert.ok(knowledgeRows.length >= 9, "知识库档位阶梯至少 9 条");
  assert.ok(knowledgeRows.every((item) => item.matchStatus));
  const referenceRows = report.portrait.ladder.filter((item) => item.referenceOnly);
  assert.equal(referenceRows.length, 4);
  assert.equal(report.portrait.referenceScale.length, 4);
});
test("未覆盖规则的启发式回退：method=heuristic 且 provisional（UI 带 *）", () => {
  const ind = loadIndependence(path.join(REPO_ROOT, "knowledge", "evidence-independence.json"));
  const localRuleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
  const baselineRule = localRuleset.rules.find((rule) => rule._origin === "web-baseline");
  assert.ok(baselineRule, "基线规则应存在（它们不在 audit-rules 覆盖内）");
  const measured = strengthOfRule(baselineRule, ind);
  assert.equal(measured.method, "heuristic");
  assert.equal(measured.provisional, true);
  assert.ok(measured.reason.indexOf("不在 audit-rules 覆盖内") !== -1);
});

test("summarize：按标签计数", () => {
  const counts = summarize([{ strength: "verified" }, { strength: "verified" }, { strength: "single-source" }]);
  assert.equal(counts.verified, 2);
  assert.equal(counts["single-source"], 1);
});

test("strengthOfRule：advisory 规则恒为 advisory", () => {
  const ind = loadIndependence(null);
  const strength = strengthOfRule({ advisory: true, evidence: [E("aoye98", FIVE + "1", "一")] }, ind);
  assert.equal(strength.level, STRENGTH.ADVISORY);
});
