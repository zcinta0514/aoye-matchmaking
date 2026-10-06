import { fsShim as fs } from "./load-browser.mjs";
import { readJson, getPath } from "./util.mjs";
import { evalCondition } from "./engine.mjs";

/* D24：只用 knowledge/rules.json 的 bands（博主本人词汇）做档位描述；
   判定条件放 web/config/band-criteria.json；缺字段的 band 明确标「输入未提供」。 */

/* 条件里引用的叶子字段（用于区分「评估为假」与「字段没填」）。
   字段缺失或值为 unknown 时按「输入未提供」处理（D28：未知不是值）。 */
function conditionFields(cond, out) {
  if (!cond || typeof cond !== "object") return out;
  if (cond.field) out.push(cond.field);
  ["all", "any"].forEach((key) => { if (Array.isArray(cond[key])) cond[key].forEach((child) => conditionFields(child, out)); });
  if (cond.not) conditionFields(cond.not, out);
  return out;
}
function hasMissingField(fields, facts) {
  return fields.some((field) => {
    const value = getPath(facts, field);
    return value === undefined || value === null || value === "" || value === "unknown";
  });
}

const cache = new Map();

export function loadBandCriteria(file) {
  if (!cache.has(file)) {
    cache.set(file, file && fs.existsSync(file) ? readJson(file) : { bands: {}, disclaimer: "" });
  }
  return cache.get(file);
}

export function evaluateBands(bands, criteriaDoc, form, context) {
  const facts = { subject: form, context: context || {} };
  const knowledgeBands = (bands || []).filter((band) => band._origin === "knowledge");
  const baselineBands = (bands || []).filter((band) => band._origin !== "knowledge");
  const missingFields = [];
  const results = knowledgeBands.map((band) => {
    const spec = (criteriaDoc && criteriaDoc.bands && criteriaDoc.bands[band.id]) || null;
    let status = "input-missing";
    let needsField = null;
    if (spec && spec.when) {
      let hit = false;
      try {
        hit = evalCondition(spec.when, facts);
      } catch {
        hit = false;
      }
      if (hit) {
        status = "matched";
      } else if (hasMissingField(conditionFields(spec.when, []), facts)) {
        /* 条件在，但输入没填：保持「输入未提供」，不能静默成「不匹配」。 */
        status = "input-missing";
        needsField = spec.needsField || "缺少对应表单输入";
        if (missingFields.indexOf(needsField) === -1) missingFields.push(needsField);
      } else {
        status = "not-matched";
      }
    } else {
      needsField = (spec && spec.needsField) || "缺少对应表单字段";
      if (missingFields.indexOf(needsField) === -1) missingFields.push(needsField);
    }
    return {
      id: band.id,
      name: band.name,
      bandType: band.bandType || null,
      bandTypeLabel: (criteriaDoc && criteriaDoc.bandTypeLabels && criteriaDoc.bandTypeLabels[band.bandType]) || null,
      definition: band.definition || null,
      entryCriteria: band.entryCriteria || [],
      reachableMatch: band.reachableMatch || null,
      typicalObstacle: band.typicalObstacle || null,
      targetProfile: band.targetProfile || null,
      status,
      needsField,
      origin: band._origin
    };
  });
  return {
    knowledge: results,
    baseline: baselineBands.map((band) => ({
      id: band.id,
      name: band.name,
      origin: band._origin,
      referenceOnly: true,
      definition: band.definition || null,
      range: band.range || null,
      level: typeof band.level === "number" ? band.level : null
    })),
    matched: results.filter((item) => item.status === "matched"),
    missingFields,
    disclaimer: (criteriaDoc && criteriaDoc.disclaimer) || "本系统不输出自创的 S/A/B/C 档位。"
    ,
    bandTypeLabels: (criteriaDoc && criteriaDoc.bandTypeLabels) || {}
  };
}
