import { fsShim as fs } from "./load-browser.mjs";
import { readJson, renderTemplate } from "./util.mjs";
import { evalCondition } from "./engine.mjs";

let cache = null;

export function loadExtrapolationRules(file) {
  if (!cache || cache.file !== file) {
    if (!file || !fs.existsSync(file)) {
      cache = { file: file || null, doc: { scenarios: [], message: "" }, warning: "未找到外推规则文件：" + file };
    } else {
      cache = { file, doc: readJson(file), warning: null };
    }
  }
  return cache;
}

/** 依据 D12 评估外推场景：命中即声明「该人群语料不足，结论由相近人群外推」。 */
export function evaluateExtrapolations(facts, doc) {
  const applied = [];
  const pending = [];
  const errors = [];
  (doc && doc.scenarios ? doc.scenarios : []).forEach((scenario) => {
    if (scenario.enabled === false) {
      pending.push({ id: scenario.id, label: scenario.label, needField: scenario.needField || null });
      return;
    }
    try {
      if (!evalCondition(scenario.trigger, facts)) return;
    } catch (error) {
      errors.push({ id: scenario.id, message: String(error && error.message ? error.message : error) });
      return;
    }
    applied.push({
      id: scenario.id,
      label: scenario.label,
      basis: scenario.basis || null,
      affectedGroups: scenario.affectedGroups || [],
      message: renderTemplate(doc.message, { label: scenario.label, basis: scenario.basis || "相近人群" })
    });
  });
  const affectedGroups = [];
  applied.forEach((item) => item.affectedGroups.forEach((group) => {
    if (affectedGroups.indexOf(group) === -1) affectedGroups.push(group);
  }));
  return { applied, pending, errors, affectedGroups, active: applied.length > 0 };
}
