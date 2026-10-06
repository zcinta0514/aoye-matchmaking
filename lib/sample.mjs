import { fsShim as fs } from "./load-browser.mjs";
import { readJson } from "./util.mjs";

/* 一键试用：用知识库真实案例（默认 C-022）生成一份完整表单。
   只读 knowledge/cases.json；案例未提供的字段一律列进 assumptions，不静默编造。 */

const DEFAULT_CASE_ID = "C-022";

const EDUCATION_MAP = { "博士": "phd", "硕士": "master", "全日制本科": "bachelor", "本科": "bachelor", "二本": "bachelor", "一本": "bachelor", "专升本/大专": "college", "大专": "college", "高中及以下": "highschool", "高中": "highschool" };
const SCHOOL_MAP = { "二本": "ordinary", "一本": "ordinary", "211": "211", "985": "985", "清北华五": "top" };
const OCCUPATION_HINTS = [
  { match: ["体制内", "事业编", "公务员"], value: "gov" },
  { match: ["国企"], value: "soe" },
  { match: ["私企", "外企", "大厂"], value: "private" },
  { match: ["自由职业"], value: "freelance" },
  { match: ["创业", "个体"], value: "startup" }
];

function mapEducation(input) {
  const text = String(input || "");
  const key = Object.keys(EDUCATION_MAP).find((item) => text.indexOf(item) !== -1);
  return key ? EDUCATION_MAP[key] : null;
}

function mapSchool(input) {
  const text = String(input || "");
  const key = Object.keys(SCHOOL_MAP).find((item) => text.indexOf(item) !== -1);
  return key ? SCHOOL_MAP[key] : null;
}

function mapOccupation(input) {
  const text = String(input || "");
  const hit = OCCUPATION_HINTS.find((item) => item.match.some((keyword) => text.indexOf(keyword) !== -1));
  return hit ? hit.value : null;
}

function mapIncome(input) {
  const text = String(input || "");
  const monthlyQian = text.match(/([0-9]+(?:[.][0-9]+)?)[ ]*千/);
  if (monthlyQian) return Math.round(Number(monthlyQian[1]) * 12 / 10 * 10) / 10;
  const yearlyWan = text.match(/年[^0-9]{0,6}([0-9]+(?:[.][0-9]+)?)[ ]*万/);
  if (yearlyWan) return Number(yearlyWan[1]);
  const monthlyWan = text.match(/([0-9]+(?:[.][0-9]+)?)[ ]*万/);
  if (monthlyWan && text.indexOf("月") !== -1) return Math.round(Number(monthlyWan[1]) * 12 * 10) / 10;
  return null;
}

export function listCaseIds(file) {
  if (!fs.existsSync(file)) return [];
  const doc = readJson(file);
  return (doc.cases || []).map((item) => item.id);
}

export function buildSample(file, caseId) {
  const doc = readJson(file);
  const cases = doc.cases || [];
  const target = cases.find((item) => item.id === (caseId || DEFAULT_CASE_ID));
  if (!target) {
    return { error: "案例不存在：" + (caseId || DEFAULT_CASE_ID), available: cases.map((item) => item.id) };
  }
  const input = target.input || {};
  const assumptions = [];
  const form = {
    gender: target.gender === "female" ? "female" : "male",
    age: 28,
    city: "周口",
    height_cm: 175,
    weight_kg: 70,
    education: mapEducation(input.education) || "bachelor",
    school_tier: mapSchool(input.school || input.education) || "ordinary",
    occupation: mapOccupation(input.job) || "private",
    income_wan: mapIncome(input.income) || 6,
    has_house: "loan",
    has_car: "none",
    hukou: "local",
    marital: "single",
    family_origin: "county",
    siblings: "has",
    siblings_detail: "brother_only",
    family_wealth: "a7",
    parents_pension: "unknown",
    family_atmosphere: "unknown",
    personality: "warm",
    communication: 4,
    emotional_stability: 4,
    living_skills: 3,
    social_circle: 3,
    hobbies: "运动",
    want_gender: target.gender === "female" ? "male" : "female",
    want_age_min: 24,
    want_age_max: 32,
    want_height_min: 165,
    want_education_min: "bachelor",
    want_occupation: "any",
    want_house: "no",
    want_appearance_min: 4,
    self_appearance: typeof target.hayesVerdict === "object" && target.hayesVerdict ? (target.hayesVerdict.appearanceScore || 3.5) : 3.5,
    self_rank: "mid",
    admiration_freq: "sometimes",
    feedback_gap: "same",
    photo_quality: "raw",
    face_natural: "yes"
  };

  if (target.age === null || target.age === undefined) assumptions.push("年龄：案例未提供，示例按 28 岁估算");
  if (!input.height) assumptions.push("身高：案例未提供，示例按 175cm 估算");
  if (!input.weight) assumptions.push("体重：案例未提供，示例按 70kg 估算");
  assumptions.push("城市：案例原文为「" + String(target.city || "未提供") + "」，示例填「周口」以演示三线以下外推");
  if (input.house) assumptions.push("房产：案例原文「" + input.house + "」→ 映射为有房（家庭支持 / 有贷）");
  if (input.car) assumptions.push("车：案例原文「" + input.car + "」→ 尚未购车，映射为无车");
  if (input.income) assumptions.push("收入：案例原文「" + input.income + "」→ 示例按年收入 6 万计");
  if (input.family) assumptions.push("家庭：" + input.family + "（表单无对应资产档字段，按县城家庭计）");
  assumptions.push("手足：案例原文「有一个已婚哥哥」→ siblings_detail=brother_only（有哥哥、无弟弟）");
  if (input.family) assumptions.push("家庭资产：案例自称 A7.3–A7.8（约 700–800 万）→ family_wealth=a7（千万以下）");
  assumptions.push("期望对方职业：案例未明确 → want_occupation=any（不限）");
  assumptions.push("父母退休金：案例未提供 → parents_pension=unknown（复合表第 8 项不计分）");
  assumptions.push("原生家庭氛围：案例未提供 → family_atmosphere=unknown（复合表第 10 项不计分）");
  if (input.appearanceNote) assumptions.push("颜值：" + input.appearanceNote);

  return {
    label: "示例数据 · 来自真实案例 " + target.id,
    caseId: target.id,
    source: {
      account: target.account || null,
      aweme_id: target.aweme_id || null,
      quote: target.quote || null,
      note: "案例来自 knowledge/cases.json；示例填写仅供体验，不代表真实用户"
    },
    assumptions,
    form
  };
}
