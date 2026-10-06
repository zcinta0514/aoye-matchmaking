import fs from "node:fs";
import { readJson, roundTo, clamp } from "./util.mjs";
import { evalCondition } from "./engine.mjs";

/* composites（knowledge/rules.json）在网页侧的落地：
   knowledge 侧只给了 composedOf + 文字描述 + normalize + anchors；
   逐项可取分条件放在 web/config/composite-criteria.json（DSL），映射口径放在 web/config/composite-mapping.json。 */

const cache = new Map();

export function loadCompositeCriteria(file) {
  if (!cache.has(file)) {
    cache.set(file, file && fs.existsSync(file) ? readJson(file) : { composites: {} });
  }
  return cache.get(file);
}

export function loadCompositeMapping(file) {
  if (!cache.has(file)) {
    cache.set(file, file && fs.existsSync(file) ? readJson(file) : { bands: [] });
  }
  return cache.get(file);
}

function safeEval(condition, facts) {
  if (!condition) return false;
  try {
    return evalCondition(condition, facts);
  } catch {
    return false;
  }
}

export function mapNormalizedToScale(normalized, bands) {
  const list = bands || [];
  if (!list.length) return { score: null, label: null };
  const band = list.find((item) => normalized >= (item.min === undefined ? 0 : item.min) && normalized <= (item.max === undefined ? Infinity : item.max));
  const picked = band || list[list.length - 1];
  return { score: picked.score, label: picked.label };
}

/**
 * 按 composite.composedOf 的语料口径逐项计分（criteria.items），相加后用 composite.normalize 归一，
 * 再按 mapping.bands 映射到 1–9。返回的 items/gaps/mapping 都用于报告披露。
 */
export function scoreComposite(options) {
  const { composite, criteria, mapping, form, context } = options;
  if (!composite) return null;
  const spec = (criteria && criteria.composites && criteria.composites[composite.id]) || null;
  if (!spec || !Array.isArray(spec.items)) {
    return {
      id: composite.id,
      name: composite.name,
      available: false,
      note: "缺少逐项条件（composite-criteria.json）",
      raw: null,
      rawMax: composite.normalize ? composite.normalize.rawMax : composite.max,
      normalized: null,
      scaleScore: null
    };
  }
  const facts = { subject: form, context: context || {} };
  const items = spec.items.map((def) => {
    const computable = def.when !== null && def.when !== undefined;
    const hit = computable ? safeEval(def.when, facts) : false;
    const bonusHit = computable && def.bonus ? safeEval(def.bonus.when, facts) : false;
    const maxPoints = (def.points || 0) + (def.bonus ? def.bonus.points : 0);
    const points = (hit ? def.points : 0) + (bonusHit && def.bonus ? def.bonus.points : 0);
    return {
      id: def.id,
      dim: def.dim,
      label: def.label,
      criterion: def.criterion,
      computable,
      hit,
      bonusHit,
      points,
      maxPoints,
      approximation: def.approximation || (def.bonus ? def.bonus.note || null : null)
    };
  });
  const raw = items.reduce((acc, item) => acc + item.points, 0);
  const normalize = composite.normalize || { rawMax: composite.max || 110, toMax: 100 };
  const rawMax = normalize.rawMax || composite.max || 110;
  const toMax = normalize.toMax || 100;
  const normalized = roundTo(clamp((raw / rawMax) * toMax, 0, toMax), 1);
  const mapped = mapNormalizedToScale(normalized, mapping ? mapping.bands : []);
  const computableMax = items.reduce((acc, item) => acc + (item.computable ? item.maxPoints : 0), 0);
  return {
    id: composite.id,
    name: composite.name,
    available: true,
    appliesTo: composite.appliesTo || [],
    description: composite.description || null,
    raw,
    rawMax,
    toMax,
    normalized,
    scaleScore: mapped.score,
    scaleLabel: mapped.label,
    computableMax,
    computableMaxNormalized: roundTo(clamp((computableMax / rawMax) * toMax, 0, toMax), 1),
    anchors: composite.anchors || [],
    normalize,
    mapping: mapping ? { scale: mapping.scale, disclosure: mapping.disclosure, bands: mapping.bands } : null,
    items,
    gaps: (spec.formGaps || []).map((gap) => Object.assign({}, gap))
  };
}
