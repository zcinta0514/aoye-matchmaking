import { clamp, floorStep, ceilStep, roundTo, getPath, renderTemplate } from "./util.mjs";

/* ------------------------------------------------------------------ */
/* 规则条件 DSL                                                       */
/*                                                                    */
/*   { "field": "subject.age", "op": "gte", "value": 30 }             */
/*   { "all": [ ... ] } / { "any": [ ... ] } / { "not": { ... } }     */
/*                                                                    */
/*   ops: eq neq gt gte lt lte in nin between exists missing          */
/*        includes matches                                            */
/* ------------------------------------------------------------------ */

export function evalCondition(cond, facts) {
  if (cond === undefined || cond === null) return true;
  if (typeof cond === "string") return false; // 自然语言条件不自动执行
  if (Array.isArray(cond)) return cond.every((item) => evalCondition(item, facts));
  if (typeof cond !== "object") return false;
  const unknown = Object.keys(cond).filter((key) => ["field", "op", "value", "all", "any", "not"].indexOf(key) === -1);
  if (unknown.length) throw new Error("非法条件键：" + unknown.join("、"));
  if (Array.isArray(cond.all)) return cond.all.every((item) => evalCondition(item, facts));
  if (Array.isArray(cond.any)) return cond.any.some((item) => evalCondition(item, facts));
  if (cond.not !== undefined) return !evalCondition(cond.not, facts);
  if (cond.all !== undefined || cond.any !== undefined) throw new Error("all/any 必须是数组");
  return evalLeaf(cond, facts);
}

function evalLeaf(leaf, facts) {
  const actual = getPath(facts, leaf.field);
  const expected = leaf.value;
  switch (leaf.op) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return typeof actual === "number" && actual > expected;
    case "gte": return typeof actual === "number" && actual >= expected;
    case "lt": return typeof actual === "number" && actual < expected;
    case "lte": return typeof actual === "number" && actual <= expected;
    case "in": return Array.isArray(expected) && expected.includes(actual);
    case "nin": return Array.isArray(expected) && !expected.includes(actual);
    case "between": return Array.isArray(expected) && typeof actual === "number" && actual >= expected[0] && actual <= expected[1];
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    case "missing": return actual === undefined || actual === null || actual === "";
    case "includes": return Array.isArray(actual) ? actual.includes(expected) : String(actual === undefined ? "" : actual).indexOf(String(expected)) !== -1;
    case "matches": { try { return new RegExp(String(expected)).test(String(actual === undefined ? "" : actual)); } catch { return false; } }
    default: throw new Error("非法 op：" + String(leaf.op));
  }
}

/* ------------------------------------------------------------------ */
/* 表驱动维度评分：bands / options / scale1to5                         */
/* ------------------------------------------------------------------ */

export function scoreDimension(dim, form, context) {
  const scoring = dim.scoring;
  const field = dim.field || dim.id.split(".").pop();
  const value = form[field];
  const base = { id: dim.id, name: dim.name, group: dim.group, weight: dim.weight === undefined ? null : dim.weight, field, input: value, origin: dim._origin || "baseline", evidence: dim.evidence || [] };
  if (value === undefined || value === null || value === "") {
    return Object.assign(base, { score: null, note: "未填写，未计分" });
  }
  if (!scoring) {
    return Object.assign(base, { score: null, note: "无评分映射（该维度仅用于描述或人工判断）" });
  }
  const numericValue = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
  const isFiniteNumber = Number.isFinite(numericValue);
  if (!isFiniteNumber && (scoring.type === "bands" || scoring.type === "scale1to5")) {
    return Object.assign(base, { score: null, note: "非数值（已忽略，不按 0 计）" });
  }
  if (scoring.type === "options") {
    let score;
    if (scoring.map) score = scoring.map[value];
    else if (Array.isArray(scoring.options)) {
      const hit = scoring.options.find((item) => item && item.value === value);
      score = hit ? hit.score : undefined;
    }
    return Object.assign(base, { score: score === undefined ? null : score, note: score === undefined ? "取值未在映射表中" : null });
  }
  if (scoring.type === "scale1to5") {
    const index = Math.round(numericValue) - 1;
    const score = Array.isArray(scoring.scores) ? scoring.scores[index] : (scoring.map ? scoring.map[String(value)] : undefined);
    return Object.assign(base, { score: score === undefined ? null : score, note: score === undefined ? "取值超出 1-5" : null });
  }
  if (scoring.type === "bands") {
    let bands = scoring.bands || null;
    if (scoring.byGender && scoring.byGender[context.gender]) bands = scoring.byGender[context.gender];
    if (scoring.byCityTier) {
      const key = String(context.cityTier);
      bands = scoring.byCityTier[key] || scoring.byCityTier["3"] || bands;
    }
    if (!bands) return Object.assign(base, { score: null, note: "缺少适用分档" });
    const numeric = numericValue;
    const normalized = bands.map((item) => ({
      min: typeof item.min === "number" ? item.min : null,
      max: typeof item.max === "number" ? item.max : null,
      score: item.score,
      label: item.label || null
    }));
    const hasMin = normalized.some((item) => item.min !== null);
    const sorted = normalized.slice().sort((a, b) => (hasMin
      ? (b.min === null ? -Infinity : b.min) - (a.min === null ? -Infinity : a.min)
      : (a.max === null ? Infinity : a.max) - (b.max === null ? Infinity : b.max)));
    const band = sorted.find((item) => (item.min === null || numeric >= item.min) && (item.max === null || numeric <= item.max));
    return Object.assign(base, { score: band ? band.score : null, note: band ? (band.label ? "档位：" + band.label : null) : "超出分档范围" });
  }
  return Object.assign(base, { score: null, note: "未知 scoring.type" });
}

export function scoreGroup(dimensions, form, context) {
  const items = dimensions.map((dim) => {
    const item = scoreDimension(dim, form, context);
    const weighted = typeof item.score === "number" && typeof item.weight === "number" && item.weight > 0;
    if (typeof item.score === "number" && !weighted) {
      item.note = item.note || "权重缺失，未计入总分（仅展示）";
    }
    item.counted = weighted;
    return item;
  });
  let weightSum = 0;
  let acc = 0;
  items.forEach((item) => {
    if (typeof item.score === "number" && typeof item.weight === "number" && item.weight > 0) {
      weightSum += item.weight;
      acc += item.score * item.weight;
    }
  });
  const score = weightSum > 0 ? roundTo(acc / weightSum, 2) : null;
  return { score, items };
}

export function labelForScale(scale, value) {
  if (!scale || typeof value !== "number") return null;
  const anchors = scale.anchors || [];
  const exact = anchors.find((anchor) => value >= (anchor.min === null || anchor.min === undefined ? -Infinity : anchor.min) && value <= (anchor.max === null || anchor.max === undefined ? Infinity : anchor.max));
  if (exact) return exact.label;
  if (!anchors.length) return null;
  const nearest = anchors.reduce((best, anchor) => (Math.abs((anchor.score === undefined ? 0 : anchor.score) - value) < Math.abs((best.score === undefined ? 0 : best.score) - value) ? anchor : best));
  return nearest.label;
}

/** 按区间语义给出标签：命中 1 个锚点用其标签，命中 2 个用「A ～ B 之间」，未命中用最近锚点 + 附近。 */
export function labelForInterval(scale, interval) {
  if (!scale || !interval || typeof interval.low !== "number") return null;
  const anchors = scale.anchors || [];
  if (!anchors.length) return null;
  const overlaps = anchors.filter((anchor) => {
    const min = anchor.min === null || anchor.min === undefined ? -Infinity : anchor.min;
    const max = anchor.max === null || anchor.max === undefined ? Infinity : anchor.max;
    return interval.low <= max && interval.high >= min;
  });
  if (overlaps.length === 1) return overlaps[0].label;
  if (overlaps.length === 2) return overlaps[0].label + " ～ " + overlaps[1].label + " 之间";
  if (overlaps.length > 2) return overlaps[0].label + " ～ " + overlaps[overlaps.length - 1].label + " 之间";
  return labelForScale(scale, interval.mid) + "附近";
}

/* ------------------------------------------------------------------ */
/* 颜值双轨：照片维度 → 区间；自评 → 区间；交叉校准                     */
/* ------------------------------------------------------------------ */

export function mapAnchorsToInterval(anchorFits, anchors, scale, options) {
  const tuning = options || {};
  const strongThreshold = typeof tuning.strongFit === "number" ? tuning.strongFit : 0.6;
  const weakThreshold = typeof tuning.weakFit === "number" ? tuning.weakFit : 0.35;
  const pad = typeof tuning.weakPad === "number" ? tuning.weakPad : 0.5;
  if (!Array.isArray(anchorFits) || !anchorFits.length) return null;
  const picked = [];
  anchorFits.forEach((fit) => {
    if (typeof fit.fit !== "number") return;
    const anchor = anchors.find((a) => a.label === fit.label);
    if (!anchor) return;
    if (fit.fit >= strongThreshold) picked.push({ anchor, strong: true });
    else if (fit.fit >= weakThreshold) picked.push({ anchor, strong: false });
  });
  if (!picked.length) return null;
  const lows = picked.map((p) => (p.anchor.min === null || p.anchor.min === undefined ? p.anchor.score : p.anchor.min));
  const highs = picked.map((p) => (p.anchor.max === null || p.anchor.max === undefined ? p.anchor.score : p.anchor.max));
  const hasWeak = picked.some((p) => !p.strong);
  const step = scale.step || 0.5;
  let low = floorStep(Math.min.apply(null, lows) - (hasWeak ? pad : 0), step);
  let high = ceilStep(Math.max.apply(null, highs) + (hasWeak ? pad : 0), step);
  low = clamp(low, scale.min, scale.max);
  high = clamp(high, scale.min, scale.max);
  if (high < low) high = low;
  return { low, high, matchedAnchors: picked.map((p) => ({ label: p.anchor.label, score: p.anchor.score, strength: p.strong ? "strong" : "weak" })) };
}

export function buildSelfTrack(form, scale, options) {
  const tuning = options || {};
  const contradictionPenalty = typeof tuning.contradictionPenalty === "number" ? tuning.contradictionPenalty : 0.5;
  const marketBonus = typeof tuning.marketSignalBonus === "number" ? tuning.marketSignalBonus : 0.5;
  const marketPenalty = typeof tuning.marketSignalPenalty === "number" ? tuning.marketSignalPenalty : 0.5;
  const halfWidth = typeof tuning.selfBandHalfWidth === "number" ? tuning.selfBandHalfWidth : 0.5;
  const rawInput = form ? form.self_appearance : undefined;
  const raw = typeof rawInput === "number" ? rawInput : (typeof rawInput === "string" && rawInput.trim() !== "" ? Number(rawInput) : NaN);
  if (!Number.isFinite(raw) || raw < scale.min || raw > scale.max) return null; // 未填 / 越界：不产出假区间（BUG-APPEARANCE-NULL）
  const reasons = [];
  let adjusted = clamp(raw, scale.min, scale.max);
  if (form.self_rank === "top10" && form.admiration_freq === "rare") {
    adjusted -= contradictionPenalty;
    reasons.push("自评『前 10%』但现实中几乎没有被主动搭讪 / 表达好感：下调 0.5 分。");
  }
  if ((form.self_rank === "mid" || form.self_rank === "bottom") && form.admiration_freq === "often") {
    adjusted += marketBonus;
    reasons.push("自评不高但经常被主动搭讪 / 表达好感：上调 0.5 分（市场反馈强于自评）。");
  }
  if (form.feedback_gap === "worse") {
    adjusted -= marketPenalty;
    reasons.push("介绍给你的对象整体明显更差：下调 0.5 分（中介 / 介绍人按这一档给你定价）。");
  }
  if (form.feedback_gap === "better") {
    reasons.push("介绍给你的对象整体明显更好：市场对你的估价可能高于你的自评（本项暂不计分，仅作提示）。");
  }
  if (form.photo_quality === "heavy") {
    reasons.push("照片为重度精修：自评区间仅供参考，需原相机照片才能验证。");
  }
  const step = scale.step || 0.5;
  const low = clamp(floorStep(adjusted - halfWidth, step), scale.min, scale.max);
  const high = clamp(ceilStep(adjusted + halfWidth, step), scale.min, scale.max);
  return { raw, adjusted: roundTo(clamp(adjusted, scale.min, scale.max), 2), low, high, reasons };
}

export function blendAppearance(scale, photoInterval, selfTrack, options) {
  const tuning = options || {};
  const pad = typeof tuning.consensusPad === "number" ? tuning.consensusPad : 0.25;
  const minWidth = typeof tuning.minConsensusWidth === "number" ? tuning.minConsensusWidth : 1;
  const maxWidth = typeof tuning.maxUnionWidth === "number" ? tuning.maxUnionWidth : 3;
  const step = scale.step || 0.5;
  const notes = [];
  let final = null;
  if (photoInterval && selfTrack) {
    const low = Math.max(photoInterval.low, selfTrack.low);
    const high = Math.min(photoInterval.high, selfTrack.high);
    if (high >= low) {
      final = {
        low: clamp(floorStep(low - pad, step), scale.min, scale.max),
        high: clamp(ceilStep(high + pad, step), scale.min, scale.max),
        consensus: true
      };
      if (final.high < final.low) final.high = final.low;
      if (final.high - final.low < minWidth) {
        final.low = clamp(final.low - 0.5, scale.min, scale.max);
        final.high = clamp(final.high + 0.5, scale.min, scale.max);
      }
      notes.push("照片维度映射区间与自评区间重叠，取共识区间并保留 ±0.25 弹性。");
    } else {
      const lows = Math.min(photoInterval.low, selfTrack.low);
      const highs = Math.max(photoInterval.high, selfTrack.high);
      let low = floorStep(lows, step);
      let high = ceilStep(highs, step);
      if (high - low > maxWidth) {
        const mid = (high + low) / 2;
        low = floorStep(mid - maxWidth / 2, step);
        high = ceilStep(mid + maxWidth / 2, step);
      }
      final = { low: clamp(low, scale.min, scale.max), high: clamp(high, scale.min, scale.max), consensus: false };
      notes.push("两轨区间不重叠：保留并集（宽度封顶 3 分）并标记分歧，建议人工复核或补原相机照片。");
    }
  } else if (photoInterval) {
    final = { low: photoInterval.low, high: photoInterval.high, consensus: true };
    notes.push("仅照片轨道可用（未填写自评时）。");
  } else if (selfTrack) {
    final = { low: selfTrack.low, high: selfTrack.high, consensus: true };
    notes.push("照片轨道未启用，仅按自评校准区间输出。");
  }
  if (!final) return null;
  const mid = roundTo((final.low + final.high) / 2, 2);
  return Object.assign(final, { mid, step });
}

export function applyClamps(interval, clamps, scale) {
  if (!interval || !clamps || !clamps.length) return { interval, applied: [] };
  let low = interval.low;
  let high = interval.high;
  const applied = [];
  clamps.forEach((clampItem) => {
    if (clampItem.scale !== scale.id) return;
    if (typeof clampItem.max === "number" && high > clampItem.max) {
      high = clampItem.max;
      applied.push({ ruleId: clampItem.ruleId, action: "max=" + clampItem.max });
    }
    if (typeof clampItem.min === "number" && low < clampItem.min) {
      low = clampItem.min;
      applied.push({ ruleId: clampItem.ruleId, action: "min=" + clampItem.min });
    }
  });
  if (low > high) low = high;
  return { interval: { low, high, mid: roundTo((low + high) / 2, 2), consensus: interval.consensus, step: interval.step }, applied };
}

/* ------------------------------------------------------------------ */
/* 梯队 / 择偶窗口                                                     */
/* ------------------------------------------------------------------ */

export function resolveBand(bands, level) {
  if (!bands || !bands.length || typeof level !== "number") return null;
  const inRange = bands.find((band) => Array.isArray(band.range) && level >= band.range[0] && level <= band.range[1]);
  if (inRange) return inRange;
  return bands.reduce((best, band) => (Math.abs((band.level || 0) - level) < Math.abs((best.level || 0) - level) ? band : best));
}

export function computeWindow(level, bands, windowSpec) {
  const spec = windowSpec || { upper: 1.5, stableLow: -0.5, stableHigh: 1.0, lower: -2.0 };
  const upper = roundTo(level + spec.upper, 2);
  const lower = roundTo(level + spec.lower, 2);
  const stable = { low: roundTo(level + spec.stableLow, 2), high: roundTo(level + spec.stableHigh, 2) };
  return {
    selfLevel: level,
    band: resolveBand(bands, level),
    upper: { score: clamp(upper, 1, 9), band: resolveBand(bands, clamp(upper, 1, 9)) },
    stable: { low: clamp(stable.low, 1, 9), high: clamp(stable.high, 1, 9), bandLow: resolveBand(bands, clamp(stable.low, 1, 9)), bandHigh: resolveBand(bands, clamp(stable.high, 1, 9)) },
    lower: { score: clamp(lower, 1, 9), band: resolveBand(bands, clamp(lower, 1, 9)) }
  };
}

/* ------------------------------------------------------------------ */
/* 规则执行                                                            */
/* ------------------------------------------------------------------ */

export function runRules(rules, facts, scopeFilter) {
  const effects = [];
  const applied = [];
  const errors = [];
  rules.forEach((rule) => {
    if (scopeFilter && !scopeFilter.includes(rule.scope)) return;
    const condition = ruleCondition(rule);
    if (condition === null) return; // 无 machine.when 且非结构化：不自动执行
    let matched = false;
    try {
      matched = evalCondition(condition, facts);
    } catch (error) {
      errors.push({ ruleId: rule.id, message: String(error && error.message ? error.message : error) });
      return;
    }
    if (!matched) return;
    const record = { ruleId: rule.id, scope: rule.scope, title: rule.title || "", origin: rule._origin || "baseline", evidence: rule.evidence || [], mirrors: rule.mirrors || null, via: rule.machine ? "machine" : "when" };
    applied.push(record);
    try {
      const then = rule.then !== null && typeof rule.then === "object" ? rule.then : {};
      if (then.clampScale) effects.push({ kind: "clamp", ruleId: rule.id, scale: then.clampScale.scale, max: then.clampScale.max, min: then.clampScale.min });
      if (then.advice) effects.push({ kind: "advice", ruleId: rule.id, id: then.advice.id, severity: then.advice.severity || "info", text: renderTemplate(then.advice.text, facts), origin: record.origin, mirrors: record.mirrors, evidence: record.evidence });
      if (then.giveUp) effects.push({ kind: "giveUp", ruleId: rule.id, id: then.giveUp.id, text: renderTemplate(then.giveUp.text, facts), origin: record.origin, evidence: record.evidence });
      if (then.text) effects.push({ kind: "note", ruleId: rule.id, text: renderTemplate(then.text, facts), origin: record.origin, evidence: record.evidence });
      const actions = rule.machine && Array.isArray(rule.machine.then) ? rule.machine.then : [];
      actions.forEach((action) => applyMachineAction(rule, action, facts, effects));
    } catch (error) {
      errors.push({ ruleId: rule.id, message: String(error && error.message ? error.message : error) });
    }
  });
  return { effects, applied, errors };
}

function ruleCondition(rule) {
  if (rule.machine && typeof rule.machine === "object" && rule.machine.when !== undefined) return rule.machine.when;
  if (rule.when !== null && typeof rule.when === "object") return rule.when;
  return null;
}

function applyMachineAction(rule, action, facts, effects) {
  if (action === null || typeof action !== "object") return;
  const origin = rule._origin || "baseline";
  const evidence = rule.evidence || [];
  const kind = action.kind;
  if (kind === "clampScale") {
    effects.push({ kind: "clamp", ruleId: rule.id, origin, scale: action.scale, max: action.max, min: action.min, evidence });
    return;
  }
  if (kind === "setBand") {
    effects.push({ kind: "setBand", ruleId: rule.id, origin, bandId: action.band, text: action.text ? renderTemplate(action.text, facts) : null, note: action.note || null, evidence });
    return;
  }
  if (kind === "advice") {
    effects.push({ kind: "advice", ruleId: rule.id, id: action.id || ("ADV-" + rule.id), severity: action.severity || "info", text: renderTemplate(action.text, facts), origin, mirrors: rule.mirrors || null, evidence });
    return;
  }
  if (kind === "giveUp") {
    effects.push({ kind: "giveUp", ruleId: rule.id, id: action.id || ("GIVEUP-" + rule.id), text: renderTemplate(action.text, facts), origin, evidence });
    return;
  }
  if (kind === "text") {
    effects.push({ kind: "note", ruleId: rule.id, origin, text: renderTemplate(action.text, facts), evidence });
    return;
  }
  if (kind === "flag") {
    effects.push({ kind: "flag", ruleId: rule.id, origin, text: renderTemplate(action.text || action.note, facts), evidence });
    return;
  }
  if (kind === "requireEvidence") {
    effects.push({ kind: "requireEvidence", ruleId: rule.id, origin, text: renderTemplate(action.text || action.note, facts), hasEvidence: evidence.length > 0, evidence });
    return;
  }
  throw new Error("非法 kind：" + String(kind));
}
