#!/usr/bin/env node
/* tools/portrait-coverage.mjs —— 画像覆盖率报表（可重复运行）
   1) 抽取候选：standards / rules / bands 中「可能描述对方」的条目（对策词检索 + 维度×方向检索 + band）；
   2) 逐条分类：target-attribute / target-preference / subject-requirements / channel / none（附未建入原因）；
   3) 对照 web/config/portrait-rules.json 统计建入 / 未建入与原因分布；
   4) 打印覆盖率报表 + GAP 清单；--trace 附带 C-022 的逐条溯源表。
   用法：node tools/portrait-coverage.mjs [--trace] */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const standards = read("knowledge/standards.json").standards || [];
const rulesDoc = read("knowledge/rules.json");
const rules = rulesDoc.rules || [];
const bands = rulesDoc.bands || [];
const portrait = read("web/config/portrait-rules.json");

/* ---------- 1) 候选抽取 ---------- */
const COUNTERPART = /对方|女方|男方|门当户对|同层/;
const DIRECTION = /看|要求|优先|排序|门槛|画像|找|审查/;
const TARGET_DIMS = new Set(["asset", "income", "education", "occupation", "height", "looks", "weight", "age", "family", "matching", "demographics"]);
const candidates = [];
standards.forEach((item) => {
  const text = (item.condition || "") + " " + (item.meaning || "");
  const strict = COUNTERPART.test(text);
  const extended = TARGET_DIMS.has(item.dimension) && DIRECTION.test(text);
  if (strict || extended) candidates.push({ id: item.id, type: "standard", dimension: item.dimension, strict: strict, text: text });
});
rules.forEach((item) => {
  const text = (JSON.stringify(item.then || "") + " " + JSON.stringify(item.when || "")).split(String.fromCharCode(92, 34)).join(String.fromCharCode(34));
  if (COUNTERPART.test(text)) candidates.push({ id: item.id, type: "rule", scope: item.scope, strict: true, text: text });
});
bands.forEach((item) => {
  const text = JSON.stringify(item.targetProfile || "") + " " + JSON.stringify(item.reachableMatch || "");
  if (COUNTERPART.test(text)) candidates.push({ id: item.id, type: "band", bandType: item.bandType, strict: true, text: text });
});
const strictCount = candidates.filter((c) => c.strict).length;

/* ---------- 2) 分类 ---------- */
/* 顺序即优先级；命中即返回。 */
const CLASSIFY_RULES = [
  { test: (c) => c.type === "band", category: (c) => (c.bandType === "ecosystem" ? "none" : (c.bandType === "channel" ? "channel" : "target-attribute")), reason: (c) => (c.bandType === "ecosystem" ? "需「生态位」字段才能判定" : "档位机制已接入（bandProfile：按匹配到的档位取 whoYouCanReach）") },
  { test: (c) => /个案|孤例|单条|内部不自洽|营销|不构成互证|待复核/.test(c.text), category: () => "none", reason: () => "个案 / 单条 / 存疑口径，不足以做画像" },
  { test: (c) => /男生硬件|评分表|本人|自查|行为评分|封顶|微胖阈值|独生子女 \+10|编制|收入基准/.test(c.text), category: () => "none", reason: () => "本人侧评分 / 自查口径（不是对方画像）" },
  { test: (c) => /要求对方|要求独生|把「对方|需求侧|看似没门槛/.test(c.text), category: () => "subject-requirements", reason: () => "需求侧要求成本（归 subject-requirements 或建议）" },
  { test: (c) => /对方会审查|看你|看重|第一价值|首看|排序|优先找|会重点看|市场看|会查家庭|向下兼容|不看女方/.test(c.text), category: () => "target-preference", reason: () => "对方 / 市场看重什么（偏好类）" },
  { test: (c) => /对方[^。]{0,20}(资产|收入|房|退休金|家庭|学历|年龄|身高|工作|氛围)|条件好|门当户对|典型可得画像|可要求/.test(c.text), category: () => "target-attribute", reason: () => "对方本人的条件口径" },
  { test: () => true, category: () => "none", reason: () => "机制 / 建议 / 结论类，不是画像口径" }
];
const OVERRIDES = {
  "S-HEIGHT-004": { category: "none", reason: "个案边界样例（单条画像锚点，非普适口径）" },
  "S-AGE-010": { category: "none", reason: "内部数字不自洽（6-8 年 vs 例子里 3 岁），不可用" },
  "S-MATCH-002": { category: "target-attribute", reason: "打分局条件下的对方要求（前 3：95 后与情绪稳定）" },
  "S-MATCH-008": { category: "target-attribute", reason: "男方向下兼容的典型可得画像" },
  "S-OCC-001": { category: "target-preference", reason: "女性编制与市场竞争力（偏好类）" },
  "S-HEIGHT-005": { category: "target-preference", reason: "链条转述（女性侧偏好）" },
  "R-DIM-020": { category: "target-attribute", reason: "「条件好」三要素（对方条件口径）" },
  "R-DIM-023": { category: "target-attribute", reason: "对方原生家庭氛围检查项" },
  "R-DIM-026": { category: "target-preference", reason: "对方会审查「弟弟是否拖累」" },
  "R-DIM-044": { category: "target-preference", reason: "男生形象的市场回报（偏好类）" },
  "R-MATCH-006": { category: "target-attribute", reason: "底线清单里「对方须具备」的行为条件" },
  "R-MATCH-021": { category: "target-preference", reason: "A8+ 对颜值下调学历门槛" },
  "R-MATCH-028": { category: "target-preference", reason: "年龄窗口（市场怎么看）" },
  "R-MATCH-013": { category: "none", reason: "与 rank 档位条目重复（match.rank.t1 已覆盖同一口径）" },
  "R-MATCH-014": { category: "none", reason: "与 rank 档位条目重复（match.rank.t7 已覆盖）" },
  "R-DIM-010": { category: "none", reason: "体重审美阈值：语气与身体评价风险，产品不输出" },
  "S-LOOKS-006": { category: "none", reason: "本人侧颜值门槛（男生 checklist）" },
  "S-LOOKS-008": { category: "none", reason: "本人侧门槛（直播连麦准入）" },
  "S-LOOKS-011": { category: "none", reason: "本人侧核验要求（申报 ≥7 分先核原生）" },
  "S-LOOKS-015": { category: "none", reason: "市场观察（颜值供给密度），不是对方条件" },
  "S-WEIGHT-003": { category: "none", reason: "真人个案画像样例，已被个体案例规则禁止" },
  "S-AGE-001": { category: "none", reason: "活动级单条口径（长沙女生卡 30），需按具体活动接入" },
  "S-AGE-002": { category: "none", reason: "活动级单条口径（精英群 98 后）" },
  "S-AGE-004": { category: "none", reason: "婚龄窗口对照（单条），不可外推" },
  "S-AGE-006": { category: "none", reason: "活动级单条口径（深圳专场 85/90 后）" },
  "S-AGE-012": { category: "none", reason: "推算值（36 岁换算），标准自身禁止作硬阈值" },
  "S-INCOME-005": { category: "none", reason: "反讽语境单条（体制内 12 万），不作口径" },
  "S-FAM-004": { category: "none", reason: "孤例体系（生态位降档），标准自身标注不可外推" },
  "S-MATCH-003": { category: "none", reason: "机制类（打分局的可达说明）" },
  "S-MATCH-007": { category: "none", reason: "与 PREF-PERSONALITY-F 重复（同源口径）" },
  "S-DEMO-004": { category: "none", reason: "标准明确标注：产品不输出地域排序" },
  "S-DEMO-005": { category: "none", reason: "省内异地接受度，需按地域接入，本期暂缓" },
  "S-DEMO-001": { category: "none", reason: "本地专场准入（上海），需按城市/活动接入，本期暂缓" },
  "S-DEMO-002": { category: "none", reason: "本地专场准入（深圳），同上" },
  "S-ASSET-010": { category: "none", reason: "营销语境（供需叙事），不作规律" },
  "S-EDU-003": { category: "none", reason: "单条口径（学历相关个案），不足以做画像" },
  "R-DIM-022": { category: "none", reason: "与 S-FAM-002 / UP-FAM-PENSION 重复" },
  "R-DIM-033": { category: "none", reason: "本人行为自查（报告已有独立一节）" },
  "R-DIM-040": { category: "none", reason: "与 rank 档位机制重复" },
  "R-DIM-025": { category: "none", reason: "需求侧成本；解锁需「期望对方独生」字段" },
  "R-DEMO-040": { category: "none", reason: "需求侧成本；解锁需「期望对方独生」字段" },
  "R-MATCH-003": { category: "none", reason: "机制（心智首选判定流程）" },
  "R-MATCH-004": { category: "none", reason: "机制（竞争池检验）" },
  "R-MATCH-017": { category: "none", reason: "本人评分表（composite 已接入）" },
  "R-MATCH-019": { category: "none", reason: "内部建模口径（要求中性表述，不面向用户）" },
  "R-MATCH-023": { category: "none", reason: "策略建议（向上找互补项）" },
  "R-MATCH-032": { category: "none", reason: "识人建议（资产≠现金流）" },
  "R-MATCH-044": { category: "none", reason: "个案建议（对方会追加验证）" },
  "R-MATCH-047": { category: "none", reason: "本人评分项（独生子女 +10）" },
  "R-MATCH-049": { category: "none", reason: "建议/放弃项（已由建议与放弃项输出）" },
  "R-MATCH-050": { category: "none", reason: "建议/放弃项（同上）" },
  "R-MATCH-051": { category: "none", reason: "本人准入清单（建议类）" },
  "R-MATCH-005": { category: "none", reason: "本人侧评分口径" },
  "R-DIM-032": { category: "none", reason: "行为建议（沟通能力定义）" }
};
function classify(candidate) {
  if (OVERRIDES[candidate.id]) return Object.assign({}, OVERRIDES[candidate.id], { method: "人工复核" });
  for (const rule of CLASSIFY_RULES) {
    if (rule.test(candidate)) return { category: rule.category(candidate), reason: rule.reason(candidate), method: "启发式" };
  }
  return { category: "none", reason: "未分类", method: "启发式" };
}

/* ---------- 2b) 建入判定 ---------- */
const builtSources = new Set();
portrait.items.forEach((item) => {
  if (item.standard) builtSources.add(item.standard);
  (item.rules || []).forEach((id) => builtSources.add(id));
  if (item.band) builtSources.add(item.band);
});
const bandMechanism = new Map([["rank", "UP-RANK-BAND"], ["asset", "UP-ASSET-BAND"], ["channel", "UP-CHANNEL-BAND"]]);
/* 建入项的类别以画像配置为准（配置是权威），并标出去向条目 id。 */
const configBySource = new Map();
portrait.items.forEach((item) => {
  if (item.standard) configBySource.set(item.standard, item);
  (item.rules || []).forEach((id) => configBySource.set(id, item));
});
const rows = candidates.map((candidate) => {
  const result = classify(candidate);
  let built = builtSources.has(candidate.id);
  let via = built ? "画像条目" : null;
  if (!built && candidate.type === "band" && bandMechanism.has(candidate.bandType)) { built = true; via = bandMechanism.get(candidate.bandType) + "（档位机制）"; }
  const configItem = configBySource.get(candidate.id);
  const category = configItem ? configItem.category : result.category;
  const reason = configItem ? "建入「" + configItem.id + "」" : result.reason;
  return Object.assign({}, candidate, result, { category: category, reason: reason, built: built, via: built ? (via || "画像条目") : null });
});

/* ---------- 3) 报表 ---------- */
const byCategory = {};
rows.forEach((row) => { byCategory[row.category] = (byCategory[row.category] || 0) + 1; });
const builtRows = rows.filter((row) => row.built);
const notBuilt = rows.filter((row) => !row.built);
const reasonBuckets = {};
notBuilt.forEach((row) => {
  const key = /活动级|地域级|需按城市|需按具体活动/.test(row.reason) ? "活动/地域级单条口径（需按场次接入）"
    : /个案|单条|存疑|孤例|不自洽|推算|反讽|采样/.test(row.reason) ? "个案/单条/存疑"
    : /本人侧|自查|评分表|评分项/.test(row.reason) ? "本人侧口径"
    : /重复/.test(row.reason) ? "与已有条目重复"
    : /字段/.test(row.reason) ? "需新字段"
    : /风险/.test(row.reason) ? "语气/合规风险"
    : /需求侧/.test(row.reason) ? "需求侧要求成本"
    : /机制|建议|结论|策略|准入清单/.test(row.reason) ? "机制/建议/结论"
    : /营销|市场观察|不输出|建模|供给密度/.test(row.reason) ? "市场观察/内部建模（不面向用户）"
    : "其他";
  reasonBuckets[key] = (reasonBuckets[key] || 0) + 1;
});
console.log("=== 画像覆盖率报表（工具可重复运行）===");
console.log("候选（对策词检索）: " + strictCount + " ｜ 扩展候选（维度×方向）: " + (rows.length - strictCount) + " ｜ 合计: " + rows.length);
console.log("分类分布: " + Object.keys(byCategory).sort().map((key) => key + "=" + byCategory[key]).join(" / "));
console.log("建入画像: " + builtRows.length + " ｜ 未建入: " + notBuilt.length);
console.log("未建入原因分布: " + Object.keys(reasonBuckets).sort().map((key) => key + "=" + reasonBuckets[key]).join(" / "));
console.log("");
console.log("--- 明细（id | 类型 | 分类 | 是否建入 | 原因/去向）---");
rows.forEach((row) => {
  console.log(row.id + " | " + row.type + " | " + row.category + " | " + (row.built ? "已建入" : "未建入") + " | " + (row.via || row.reason) + "（" + row.method + "）");
});
console.log("");
console.log("--- GAP 清单（缺字段 / 语料无口径）---");
portrait.items.filter((item) => item.gap).forEach((item) => {
  console.log(item.dimension + " | " + item.gap.reason + " | " + item.gap.detail);
});
console.log("需要新字段才能解锁的画像：生态位（黄金/白银/青铜，ecosystem.tier 档）、期望对方独生（R-DIM-025 / R-DEMO-040 的需求侧成本）");

/* ---------- 4) 可选：逐条溯源（C-022）---------- */
if (process.argv.indexOf("--trace") !== -1) {
  const { loadRuleset } = await import("../web/lib/ruleset.mjs");
  const { loadCities, cityTierInfo } = await import("../web/lib/city.mjs");
  const { generateReport } = await import("../web/lib/pipeline.mjs");
  const { buildSample } = await import("../web/lib/sample.mjs");
  const ruleset = loadRuleset({ mainPath: path.join(ROOT, "knowledge", "rules.json"), baselinePath: path.join(ROOT, "web", "config", "baseline-rules.json") });
  const cities = loadCities(path.join(ROOT, "web", "config", "cities.json"));
  const sample = buildSample(path.join(ROOT, "knowledge", "cases.json"), "C-022");
  const info = cityTierInfo(sample.form.city, cities);
  const report = await generateReport({ form: sample.form, photos: [], ruleset: ruleset, cities: cities, cityTier: info.tier, cityMatched: info.matched, config: { configured: false } });
  const c = report.portrait.concrete;
  console.log("");
  console.log("--- 逐条溯源（C-022）---");
  const dump = (title, list) => (list || []).forEach((item) => console.log("[" + title + " / " + item.category + "] " + item.id + " ｜ 来源 " + item.sourceIds.join("/") + " ｜ 证据 " + item.evidence.length + " 条 ｜ " + item.text));
  dump("能配上的", c.upper);
  dump("保底的", c.lower);
  dump("去哪遇到这些人", c.channels);
  dump("看重你什么", c.preferences);
  console.log("无法给出: " + c.missing.map((item) => item.dimension + "(" + item.reason + ")").join("、"));
}
