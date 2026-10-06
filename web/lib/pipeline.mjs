import path from "node:path";
import { fileURLToPath } from "node:url";
import { getScale, getBand } from "./ruleset.mjs";
import { buildSelfTrack, blendAppearance, mapAnchorsToInterval, applyClamps, scoreGroup, runRules, labelForScale, labelForInterval, resolveBand, computeWindow } from "./engine.mjs";
import { analyzePhotos } from "./provider.mjs";
import { loadCompositeCriteria, loadCompositeMapping, scoreComposite } from "./composite.mjs";
import { loadBandCriteria, evaluateBands } from "./bands.mjs";
import { newId, roundTo, formatNumber } from "./util.mjs";
import { STRENGTH, loadIndependence, loadQualityFlags, classifyEvidence, strengthOfDimension, strengthOfRule, strengthMeta, isCountable, summarize, claimBadgeForRule } from "./strength.mjs";
import { loadExtrapolationRules, evaluateExtrapolations } from "./extrapolation.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const DEFAULT_INDEPENDENCE = path.join(REPO_ROOT, "knowledge", "evidence-independence.json");
const DEFAULT_EXTRAPOLATION = path.join(WEB_DIR, "config", "extrapolation-rules.json");
const DEFAULT_COMPOSITE_CRITERIA = path.join(WEB_DIR, "config", "composite-criteria.json");
const DEFAULT_COMPOSITE_MAPPING = path.join(WEB_DIR, "config", "composite-mapping.json");
const DEFAULT_QUALITY_FLAGS = path.join(REPO_ROOT, "knowledge", "evidence-quality-flags.json");
const DEFAULT_BAND_CRITERIA = path.join(WEB_DIR, "config", "band-criteria.json");
const CALIBRATION_FIELDS = new Set(["self_appearance", "self_rank", "admiration_freq", "feedback_gap", "photo_quality", "face_natural", "want_gender", "want_age_min", "want_age_max", "want_height_min", "want_education_min", "want_house", "want_appearance_min", "hobbies"]);
const NO_EVIDENCE_NOTE = "无语料依据（基线/工程默认）";

function weightedScore(items) {
  let weightSum = 0;
  let acc = 0;
  items.forEach((item) => {
    if (typeof item.score === "number" && typeof item.weight === "number" && item.weight > 0) {
      weightSum += item.weight;
      acc += item.score * item.weight;
    }
  });
  return weightSum > 0 ? roundTo(acc / weightSum, 2) : null;
}

function sumWeights(items) {
  return items.reduce((acc, item) => acc + (typeof item.weight === "number" ? item.weight : 0), 0);
}

/** 照片可观察维度 → facts.photo.<dimId>；未观测到就不注入（保持 undefined）。 */
export function buildPhotoFacts(photoTrack) {
  const out = {};
  ((photoTrack && photoTrack.dimensions) || []).forEach((dim) => {
    if (!dim || !dim.id) return;
    const observed = typeof dim.observed === "string" ? dim.observed.trim() : "";
    if (observed) out[dim.id] = observed;
  });
  return out;
}

export function buildFacts(form, context, appearance, hardware, soft) {
  const breakdown = {};
  (hardware.items || hardware.breakdown || []).forEach((item) => { breakdown[item.id] = item.score; });
  const softBreakdown = {};
  (soft.items || soft.breakdown || []).forEach((item) => { softBreakdown[item.id] = item.score; });
  const photoTrack = appearance.photoTrack || null;
  const mapped = photoTrack && photoTrack.mappedInterval ? photoTrack.mappedInterval : null;
  return {
    subject: form,
    /* 只注入 facts.json 声明过的 context 字段（cityTier / city）；未声明的键不注入，
       避免「注入了但规则作者发现不了」的反向缺口。 */
    context: { city: context.city, cityTier: context.cityTier },
    appearance: {
      final: appearance.final,
      divergence: appearance.divergence,
      divergenceAbs: appearance.divergenceAbs,
      selfTrack: appearance.selfTrack,
      photoTrack: mapped ? Object.assign({}, photoTrack, { low: mapped.low, high: mapped.high }) : photoTrack
    },
    photo: buildPhotoFacts(photoTrack),
    hardware: { score: hardware.score, breakdown },
    soft: { score: soft.score, breakdown: softBreakdown },
    want: {
      appearance_gap: appearance.final && typeof appearance.final.high === "number" && typeof form.want_appearance_min === "number" ? roundTo(form.want_appearance_min - appearance.final.high, 2) : null,
      height_gap: typeof form.want_height_min === "number" && typeof form.height_cm === "number" ? roundTo(form.want_height_min - form.height_cm, 2) : null,
      age_gap_older: typeof form.want_age_max === "number" && typeof form.age === "number" ? roundTo(form.want_age_max - form.age, 2) : null,
      age_gap_younger: typeof form.age === "number" && typeof form.want_age_min === "number" ? roundTo(form.age - form.want_age_min, 2) : null
    }
  };
}

function collectEvidence(items, usedFor, strength) {
  const out = [];
  (items || []).forEach((item) => {
    if (!item || typeof item.aweme_id !== "string" || !/^[0-9]{15,}$/.test(item.aweme_id)) return;
    out.push({ account: item.account, aweme_id: item.aweme_id, quote: item.quote, srt_ref: item.srt_ref || null, usedFor, setStrength: strength || null });
  });
  return out;
}

export async function generateReport(options) {
  const { form, photos, ruleset, config } = options;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || new Date().toISOString();
  const baselineMeta = ruleset.baseline.meta || {};
  const photoTuning = baselineMeta.photoTrack || {};
  const selfTuning = baselineMeta.selfCalibration || {};

  const independence = options.independence || loadIndependence(options.independencePath || DEFAULT_INDEPENDENCE);
  const auditedRuleCount = independence.ruleStrength ? ruleset.rules.filter((rule) => independence.ruleStrength.has(String(rule.id))).length : 0;
  const totalRuleCount = ruleset.rules.length;
  /* D30：披露是数据集的性质、不是产品选项——跟数据走（顶层字段），前端只负责渲染。 */
  const DISCLOSURE = {
    required: true,
    scope: "证据来源单一机构",
    text: "本系统的全部证据来自同一商业机构（鳌烨传媒）的公开内容。所有强度标签指的是「该机构内多个账号一致表述」，不代表跨机构或第三方独立验证。"
  };
  if (!independence.qualityFlags) {
    independence.qualityFlags = options.qualityFlags || loadQualityFlags(options.qualityFlagsPath || DEFAULT_QUALITY_FLAGS);
  }
  const extrapolationRules = loadExtrapolationRules(options.extrapolationPath || DEFAULT_EXTRAPOLATION);

  const appearanceScale = getScale(ruleset, "appearance");
  const appearanceDims = ruleset.dimensions.filter((dim) => dim.group === "appearance");
  const hardwareDims = ruleset.dimensions.filter((dim) => dim.group === "hardware" || dim.group === "family");
  const softDims = ruleset.dimensions.filter((dim) => dim.group === "soft");
  const dimById = new Map(ruleset.dimensions.map((dim) => [dim.id, dim]));
  const context = { city: form.city, cityTier: options.cityTier, cityMatched: options.cityMatched !== false, gender: form.gender };

  /* 0) D12 外推场景（只看表单事实，先于打分） */
  const extrapolation = evaluateExtrapolations({ subject: form, context }, extrapolationRules.doc);

  /* 1) 照片轨道 */
  const photoTrackRaw = appearanceScale
    ? await analyzePhotos({ photos, dimensions: appearanceDims, anchors: appearanceScale.anchors || [], config, fetchImpl })
    : { mode: "none", dimensions: [], anchorFits: [], caveats: ["规则集缺少 appearance 标尺。"], dataQuality: { usable: null, issues: [] }, model: null };
  const photoInterval = appearanceScale ? mapAnchorsToInterval(photoTrackRaw.anchorFits, appearanceScale.anchors || [], appearanceScale, photoTuning) : null;

  /* 2) 自评轨道 + 交叉校准 */
  const selfTrack = appearanceScale ? buildSelfTrack(form, appearanceScale, selfTuning) : null;
  const blended = appearanceScale ? blendAppearance(appearanceScale, photoInterval, selfTrack, selfTuning) : null;
  let divergence = null;
  let divergenceAbs = null;
  if (photoInterval && selfTrack) {
    const selfMid = (selfTrack.low + selfTrack.high) / 2;
    const photoMid = (photoInterval.low + photoInterval.high) / 2;
    divergence = roundTo(selfMid - photoMid, 2);
    divergenceAbs = Math.abs(divergence);
  }

  /* 3) 维度评分 + 分层可信度标注（D11） */
  const annotateItem = (item) => {
    const dim = dimById.get(item.id) || {};
    const base = strengthOfDimension(dim, independence);
    const extrapolated = extrapolation.affectedGroups.indexOf(item.group) !== -1;
    const strength = extrapolated && isCountable(base.level) ? STRENGTH.EXTRAPOLATED : base.level;
    const meta = strengthMeta(strength);
    const hasWeight = typeof item.weight === "number" && item.weight > 0;
    const scored = typeof item.score === "number";
    const countableForLevel = scored && hasWeight && isCountable(strength);
    return Object.assign({}, item, {
      strength,
      strengthLabel: meta.label,
      strengthColor: meta.color,
      strengthReason: extrapolated && isCountable(base.level) ? base.reason + "；但该人群语料不足，降为外推参考" : base.reason,
      strengthProvisional: base.provisional === true,
      extrapolated,
      weightSource: dim.weightSource || (dim._origin === "web-baseline" ? "engineering" : null),
      evidenceStatus: (item.evidence || []).length ? "corpus" : "none",
      evidenceNote: (item.evidence || []).length ? null : NO_EVIDENCE_NOTE,
      counted: scored && hasWeight,
      countableForLevel
    });
  };

  const hardwareScored = scoreGroup(hardwareDims, form, context);
  const softScored = scoreGroup(softDims, form, context);
  const hardwareBreakdown = hardwareScored.items.map(annotateItem);
  const softBreakdown = softScored.items.map(annotateItem);
  const allItems = hardwareBreakdown.concat(softBreakdown);
  const hardwareItems = hardwareBreakdown.filter((item) => item.group === "hardware" || item.group === "family");
  const softItems = softBreakdown;

  /* composites（D17）：男性硬件分改用语料十项加分表；女性/软性保持工程权重法并标 engineering-default。 */
  const compositeCriteria = loadCompositeCriteria(options.compositeCriteriaPath || DEFAULT_COMPOSITE_CRITERIA);
  const compositeMapping = loadCompositeMapping(options.compositeMappingPath || DEFAULT_COMPOSITE_MAPPING);
  /* 只选「打分表」类 composite（排除 behavior 这类 standalone）；没有 web 侧逐项条件的不用。 */
  const applicableComposite = ruleset.composites.find((item) => item.id !== "behavior" && (item.appliesTo || []).indexOf(form.gender) !== -1) || null;
  const scoredComposite = applicableComposite
    ? scoreComposite({ composite: applicableComposite, criteria: compositeCriteria, mapping: compositeMapping, form, context })
    : null;
  const compositeMissingCriteria = applicableComposite && (!scoredComposite || !scoredComposite.available) ? applicableComposite.id : null;
  const hardwareComposite = scoredComposite && scoredComposite.available ? scoredComposite : null;
  const compositeStrength = applicableComposite ? classifyEvidence(applicableComposite.evidence || [], independence) : null;
  const engineeringScore = weightedScore(hardwareItems.filter((item) => item.countableForLevel));
  const useComposite = Boolean(hardwareComposite && hardwareComposite.available);
  const hardware = {
    basis: useComposite ? "corpus-composite" : "engineering-weights",
    basisLabel: useComposite ? "语料复合表（corpus composite）" : "工程权重（engineering weights）",
    basisStrength: useComposite ? compositeStrength.level : STRENGTH.ENGINEERING_DEFAULT,
    basisStrengthLabel: strengthMeta(useComposite ? compositeStrength.level : STRENGTH.ENGINEERING_DEFAULT).label,
    score: useComposite ? hardwareComposite.scaleScore : engineeringScore,
    engineeringScore,
    /* D21/D11 裁定：两块基准都不合格时选有语料根基的那块——男十项表（定义型单源）计入 level，
       工程权重法（engineering-default）只作参考展示。 */
    levelScore: useComposite ? hardwareComposite.scaleScore : engineeringScore,
    referenceScore: weightedScore(hardwareItems.filter((item) => item.counted)),
    label: null,
    familyScore: null,
    breakdown: hardwareBreakdown,
    composite: hardwareComposite
  };
  const soft = {
    score: weightedScore(softItems.filter((item) => item.countableForLevel)),
    referenceScore: weightedScore(softItems.filter((item) => item.counted)),
    label: null,
    breakdown: softBreakdown
  };
  const familyItems = hardwareBreakdown.filter((item) => item.group === "family" && item.countableForLevel);
  hardware.familyScore = (function () {
    const total = sumWeights(familyItems);
    if (!total) return null;
    return roundTo(familyItems.reduce((acc, item) => acc + (item.score || 0) * (item.weight || 0), 0) / total, 2);
  })();

  const excludedItems = allItems
    .filter((item) => item.counted && !item.countableForLevel)
    .map((item) => ({
      id: item.id,
      name: item.name,
      group: item.group,
      input: item.input,
      score: item.score,
      weight: item.weight,
      strength: item.strength,
      strengthLabel: item.strengthLabel,
      reason: strengthMeta(item.strength).description
    }));
  const unscoredItems = allItems
    .filter((item) => !item.counted)
    .map((item) => ({ id: item.id, name: item.name, input: item.input, note: item.note || "未填写 / 字段缺失" }));

  /* 4) facts v1 → 评分规则 → clamp */
  const factsV1 = buildFacts(form, context, { final: blended, divergence, divergenceAbs, selfTrack, photoTrack: photoTrackRaw }, hardware, soft);
  const scoringRun = runRules(ruleset.executableRules, factsV1, ["scoring"]);
  const clamps = scoringRun.effects.filter((effect) => effect.kind === "clamp");
  const clamped = blended ? applyClamps(blended, clamps, appearanceScale) : { interval: null, applied: [] };
  const finalAppearance = clamped.interval;
  const appearanceLabel = appearanceScale && finalAppearance ? labelForInterval(appearanceScale, finalAppearance) : null;
  const appearanceBasis = photoInterval && selfTrack ? "photo+self" : (selfTrack ? "self-report-only" : (photoInterval ? "photo-only" : "none"));

  const clampRuleIds = clamped.applied.map((item) => item.ruleId);
  const clampRuleEvidence = [];
  scoringRun.applied.forEach((rule) => {
    if (clampRuleIds.indexOf(rule.ruleId) === -1) return;
    (rule.evidence || []).forEach((evidence) => clampRuleEvidence.push(evidence));
  });
  const appearanceStrengthBase = classifyEvidence(
    (appearanceScale ? appearanceScale.evidence || [] : []).concat(clampRuleEvidence),
    independence
  );
  const appearanceExtrapolated = extrapolation.affectedGroups.indexOf("appearance") !== -1;
  const appearanceStrength = appearanceExtrapolated && isCountable(appearanceStrengthBase.level) ? STRENGTH.EXTRAPOLATED : appearanceStrengthBase.level;
  const appearanceMeta = strengthMeta(appearanceStrength);

  const appearance = {
    final: finalAppearance,
    finalLabel: appearanceLabel,
    basis: appearanceBasis,
    selfMissing: selfTrack === null,
    strength: appearanceStrength,
    strengthLabel: appearanceMeta.label,
    strengthColor: appearanceMeta.color,
    strengthReason: appearanceStrengthBase.reason + (appearanceExtrapolated ? "；该人群语料不足，降为外推参考" : ""),
    strengthProvisional: appearanceStrengthBase.provisional === true,
    countableForLevel: Boolean(finalAppearance) && isCountable(appearanceStrength),
    evidenceStatus: appearanceStrengthBase.count > 0 ? "corpus" : "none",
    evidenceNote: appearanceStrengthBase.count > 0 ? null : NO_EVIDENCE_NOTE,
    clampsApplied: clamped.applied,
    selfTrack,
    photoTrack: Object.assign({}, photoTrackRaw, { mappedInterval: photoInterval, dimensions: photoTrackRaw.dimensions || [] }),
    divergence,
    divergenceAbs
  };

  /* 5) facts v2 → 匹配 / 建议 / 梯队规则 */
  const factsV2 = buildFacts(form, context, appearance, hardware, soft);
  const matchRun = runRules(ruleset.executableRules, factsV2, ["matching", "advice", "band", "demographic"]);
  const effects = scoringRun.effects.concat(matchRun.effects);
  const ruleErrors = scoringRun.errors.concat(matchRun.errors);
  /* 断言级强度（claim-level）：每条 advice / giveUp 取其内部最弱的数字断言；
     unsupported 的断言不得以肯定语气输出 → 前置「博主曾提及 · 规则内无出处」。 */
  const withClaims = (effect) => {
    const claimBadge = claimBadgeForRule(independence, effect.ruleId, effect.text);
    const unsupportedClaims = claimBadge.available && claimBadge.level === "unsupported";
    const source = ruleset.rules.find((item) => item.id === effect.ruleId);
    const ruleStrength = strengthMeta(strengthOfRule(source || { id: effect.ruleId, evidence: effect.evidence }, independence).level);
    return Object.assign({}, effect, {
      claimBadge,
      unsupportedClaims,
      ruleStrengthLabel: ruleStrength.label,
      ruleStrengthColor: ruleStrength.color,
      displayText: unsupportedClaims ? "（博主曾提及 · 规则内无出处）" + effect.text : effect.text
    });
  };
  const advice = effects.filter((effect) => effect.kind === "advice").map(withClaims);
  const giveUps = effects.filter((effect) => effect.kind === "giveUp").map(withClaims);
  const claimsSummary = (function () {
    const items = advice.concat(giveUps);
    const counts = { total: items.length, supportedMulti: 0, singleSource: 0, unsupported: 0, ruleLevelFallback: 0 };
    items.forEach((item) => {
      if (!item.claimBadge.available) { counts.ruleLevelFallback += 1; return; }
      if (item.claimBadge.level === "supported-multi") counts.supportedMulti += 1;
      else if (item.claimBadge.level === "single-source") counts.singleSource += 1;
      else if (item.claimBadge.level === "unsupported") counts.unsupported += 1;
    });
    return Object.assign(counts, {
      available: independence.claims ? independence.claims.available : false,
      provisional: independence.claims ? independence.claims.provisional : true,
      mode: independence.claims ? independence.claims.mode : null,
      note: "建议 / 放弃项按其规则内最弱的数字断言计；无断言级数据时退回规则级标签（provisional）。"
    });
  })();
  const notes = effects.filter((effect) => effect.kind === "note");
  const flags = effects.filter((effect) => effect.kind === "flag");
  const evidenceRequirements = effects.filter((effect) => effect.kind === "requireEvidence").map((effect) => ({
    ruleId: effect.ruleId, text: effect.text, satisfied: effect.hasEvidence === true, evidence: effect.evidence || []
  }));

  /* 6) 综合水平（严格口径）与「都算上」参考口径 */
  const levelWeights = baselineMeta.levelWeights || { appearance: 0.4, hardware: 0.35, soft: 0.25 };
  const components = [
    { key: "appearance", value: appearance.final ? appearance.final.mid : null, reference: appearance.final ? appearance.final.mid : null, countable: appearance.countableForLevel, weight: levelWeights.appearance, strength: appearance.strength },
    { key: "hardware", value: hardware.levelScore, reference: hardware.referenceScore, countable: hardware.levelScore !== null, weight: levelWeights.hardware,
      strength: hardware.basis === "corpus-composite" ? "single-source" : "engineering-default",
      basis: hardware.basis, basisLabel: hardware.basisLabel,
      note: hardware.basis === "corpus-composite"
        ? "硬件槽位基于博主自定评分表（定义型，单源）：语料根基优先于工程权重（D21）"
        : "工程权重法：维度证据可计分，权重为工程默认（D17）" },
    { key: "soft", value: soft.score, reference: soft.referenceScore, countable: soft.score !== null, weight: levelWeights.soft,
      strength: soft.score !== null ? "engineering-default" : null,
      note: "软性分用工程权重法（D17：behavior 按 D1 不接入 soft）" }
  ];
  const strictParts = components.filter((item) => item.countable && typeof item.value === "number");
  const strictWeight = strictParts.reduce((acc, item) => acc + item.weight, 0);
  const level = strictWeight > 0 ? roundTo(strictParts.reduce((acc, item) => acc + item.value * item.weight, 0) / strictWeight, 2) : null;
  const refParts = components.filter((item) => typeof item.reference === "number");
  const refWeight = refParts.reduce((acc, item) => acc + item.weight, 0);
  const levelIfAllCounted = refWeight > 0 ? roundTo(refParts.reduce((acc, item) => acc + item.reference * item.weight, 0) / refWeight, 2) : null;
  const levelComponents = components.map((item) => ({
    key: item.key,
    value: item.value,
    reference: item.reference,
    counted: item.countable,
    weight: item.weight,
    strength: item.strength || null,
    basis: item.basis || null,
    note: item.note || null,
    rationale: item.strength === "single-source"
      ? "定义型单源（D21 允许为 hard），已计入综合分"
      : (item.strength === "engineering-default"
        ? "工程默认（D17）：无语料依据，仅作参照/工程口径"
        : (item.countable ? "有证据（verified / cross-account）" : "证据不足，未计入综合分"))
  }));

  /* 7) 梯队 / 择偶窗口 */
  /* D24：档位只用 knowledge/rules.json 的 9 条 bands（博主本人词汇）；
     baseline 的 S/A/B/C 刻度仅作 engineering-default 参照，不参与任何判定、不出现在结论句。 */
  const bandCriteria = loadBandCriteria(options.bandCriteriaPath || DEFAULT_BAND_CRITERIA);
  const bandEvaluation = evaluateBands(ruleset.bands, bandCriteria, form, context);
  const setBandEffect = effects.find((effect) => effect.kind === "setBand");
  let band = null;
  let bandSource = null;
  let bandNote = null;
  if (setBandEffect) {
    const pinned = getBand(ruleset, setBandEffect.bandId);
    if (pinned && pinned._origin === "knowledge") {
      band = { id: pinned.id, name: pinned.name, bandType: pinned.bandType || null, origin: "knowledge" };
      bandSource = "规则 " + setBandEffect.ruleId + " 钉档";
    } else {
      bandNote = "规则 " + setBandEffect.ruleId + " 指定的档位 " + setBandEffect.bandId + " 不存在或非知识库档位（D24：不输出自创档位）。";
    }
  }
  if (!band && bandEvaluation.matched.length) {
    const hit = bandEvaluation.matched[0];
    band = { id: hit.id, name: hit.name, bandType: hit.bandType, origin: "knowledge" };
    bandSource = "按表单字段对应博主档位（corpus band）";
  }
  if (!band && !bandNote) {
    bandNote = bandEvaluation.missingFields.length
      ? "无语料档位可映射：缺少以下输入——" + bandEvaluation.missingFields.join("、") + "；请对照下方博主档位阶梯人工判断。"
      : "无语料档位可映射；请对照下方博主档位阶梯人工判断。";
  }
  const bandStrengthLevel = band ? "verified" : null;
  const bandStrengthLabel = band ? "档位定义（语料词汇）" : null;
  const windowSpec = baselineMeta.window || null;
  const matchWindow = typeof level === "number" ? computeWindow(level, [], windowSpec) : null;
  const ladder = ruleset.bands
    .map((item) => {
      const evaluated = bandEvaluation.knowledge.find((entry) => entry.id === item.id) || null;
      return {
        id: item.id,
        name: item.name,
        bandType: item.bandType || null,
        definition: item.definition,
        entryCriteria: item.entryCriteria || [],
        reachableMatch: item.reachableMatch || null,
        typicalObstacle: item.typicalObstacle || null,
        targetProfile: item.targetProfile || null,
        origin: item._origin,
        strength: item._origin === "knowledge" ? classifyEvidence(item.evidence, independence).level : STRENGTH.ENGINEERING_DEFAULT,
        numeric: Array.isArray(item.range) || typeof item.level === "number",
        referenceOnly: item._origin !== "knowledge",
        matchStatus: evaluated ? evaluated.status : null,
        needsField: evaluated ? evaluated.needsField : null,
        active: band ? band.id === item.id : false
      };
    })
    .sort((a, b) => (a.origin === b.origin ? 0 : (a.origin === "knowledge" ? -1 : 1)));

  /* behavior composite（D1）：只作独立自查展示，不接入任何分数。 */
  const behaviorComposite = ruleset.composites.find((item) => item.id === "behavior") || null;
  const behaviorStrength = behaviorComposite ? classifyEvidence(behaviorComposite.evidence || [], independence) : null;
  const behaviorCheck = behaviorComposite ? {
    id: behaviorComposite.id,
    name: behaviorComposite.name,
    description: behaviorComposite.description || null,
    usage: behaviorComposite.usage || "standalone-advisory",
    strength: behaviorStrength.level,
    strengthLabel: strengthMeta(behaviorStrength.level).label,
    anchors: (behaviorComposite.anchors || []).map((anchor) => ({ label: anchor.label, score: anchor.score, min: anchor.min, max: anchor.max, observable: anchor.observable || [] })),
    evidence: collectEvidence(behaviorComposite.evidence, "composite:" + behaviorComposite.id, behaviorStrength.level),
    note: "D1：只作为独立的「相亲现场行为自查」展示，不接入 soft 槽、不参与 level 计算。"
  } : null;

  /* 8) 提升路径 */
  const playbook = ruleset.improvementPlaybook || {};
  const threshold = baselineMeta.improvementThreshold || 6.5;
  const improvements = allItems
    .filter((item) => typeof item.score === "number" && item.score < threshold && playbook[item.id])
    .sort((a, b) => ((threshold - a.score) * (a.weight || 0.1)) < ((threshold - b.score) * (b.weight || 0.1)) ? 1 : -1)
    .slice(0, 5)
    .map((item) => ({ dimension: item.id, name: item.name, currentScore: item.score, origin: item.origin, strength: item.strength, actions: playbook[item.id] }));
  photoTrackRaw.dimensions.forEach((dim) => {
    if (playbook[dim.id] && improvements.length < 6) improvements.push({ dimension: dim.id, name: dim.name, currentScore: null, origin: "baseline", strength: STRENGTH.ENGINEERING_DEFAULT, actions: playbook[dim.id] });
  });

  /* 9) 证据索引（逐条标注来源组与集合强度） */
  const coveredFields = new Set(ruleset.dimensions.map((dim) => dim.field).filter(Boolean));
  const uncoveredFields = Object.keys(form).filter((key) => !coveredFields.has(key) && !CALIBRATION_FIELDS.has(key) && form[key] !== "" && form[key] !== undefined);
  const referenceShape = (rule) => {
    const measured = strengthOfRule(rule, independence);
    const strength = strengthMeta(measured.level);
    return {
      ruleId: rule.id,
      title: rule.title || "",
      scope: rule.scope,
      when: typeof rule.when === "string" ? rule.when : JSON.stringify(rule.when),
      then: typeof rule.then === "string" ? rule.then : JSON.stringify(rule.then),
      confidence: rule.confidence || null,
      origin: rule._origin,
      strength: strength.label,
      strengthColor: strength.color,
      strengthMethod: measured.method || null,
      evidence: collectEvidence(rule.evidence, "rule:" + rule.id, measured.level)
    };
  };
  const advisoryRules = ruleset.advisoryRules.map(referenceShape);
  const unstructuredRules = ruleset.unstructuredRules.map(referenceShape);
  const evidenceIndex = [];
  const seen = new Set();
  const pushEvidence = (list, usedFor, strength) => {
    collectEvidence(list, usedFor, strength).forEach((item) => {
      const key = item.account + "/" + item.aweme_id + "|" + usedFor;
      if (seen.has(key)) return;
      seen.add(key);
      evidenceIndex.push(item);
    });
  };
  if (appearanceScale) {
    pushEvidence(appearanceScale.evidence, "appearance.anchors（颜值标尺锚点）", appearanceStrength);
    (appearanceScale.anchors || []).forEach((anchor) => pushEvidence(anchor.evidence, "anchor:" + anchor.label, appearanceStrength));
  }
  appearanceDims.forEach((dim) => pushEvidence(dim.evidence, "dimension:" + dim.id, strengthOfDimension(dim, independence).level));
  hardwareBreakdown.concat(softBreakdown).forEach((item) => pushEvidence(item.evidence, "dimension:" + item.id, item.strength));
  scoringRun.applied.concat(matchRun.applied).forEach((rule) => {
    const source = ruleset.rules.find((item) => item.id === rule.ruleId);
    pushEvidence(rule.evidence, "rule:" + rule.ruleId, strengthOfRule(source || { id: rule.ruleId, evidence: rule.evidence }, independence).level);
  });
  if (independence.qualityFlags.available && independence.qualityFlags.highIds.size) {
    evidenceIndex.forEach((item) => {
      if (independence.qualityFlags.highIds.has(String(item.aweme_id))) item.qualityFlag = "high";
    });
  }
  if (applicableComposite) pushEvidence(applicableComposite.evidence, "composite:" + applicableComposite.id, compositeStrength.level);
  if (behaviorComposite) pushEvidence(behaviorComposite.evidence, "composite:behavior", behaviorStrength.level);

  /* 10) 汇总统计 */
  const scoredItems = allItems.filter((item) => typeof item.score === "number");
  const byStrength = summarize(allItems.map((item) => ({ strength: item.strength })));
  const evidenceSummary = {
    scoredItems: scoredItems.length,
    countableItems: allItems.filter((item) => item.countableForLevel).length,
    referenceOnlyItems: excludedItems.length,
    withEvidence: scoredItems.filter((item) => (item.evidence || []).length > 0).length,
    withoutEvidence: scoredItems.filter((item) => !(item.evidence || []).length).length,
    countedItems: scoredItems.filter((item) => item.counted).length,
    knowledgeScoredItems: scoredItems.filter((item) => item.origin === "knowledge").length,
    corpusRefs: evidenceIndex.length,
    byStrength,
    note: "只有 verified / cross-account 进入 headline 分数；single-source / 外推 / 工程默认仅作参考。"
  };

  /* 11) 画像文字 */
  const matchedBandRecord = band ? ruleset.bands.find((item) => item.id === band.id) || null : null;
  const portraitText = band
    ? ("档位描述：" + band.name + "（" + ([bandEvaluation.bandTypeLabels[band.bandType], bandSource].filter(Boolean).join(" · ")) + "）。" + bandEvaluation.disclaimer)
    : (typeof level === "number"
      ? "综合加权 " + formatNumber(level) + " 分；档位：" + (bandNote || "无语料档位可映射。") + " " + bandEvaluation.disclaimer
      : "证据不足：综合分不输出。" + (bandNote || "") + " " + bandEvaluation.disclaimer);
  const targetProfile = matchedBandRecord
    ? ((matchedBandRecord.targetProfile && matchedBandRecord.targetProfile.summary) || matchedBandRecord.reachableMatch || null)
    : null;

  /* 12) caveats */
  const caveats = [
    { type: "disclosure", text: DISCLOSURE.text },
  ];
  if (extrapolation.active) {
    extrapolation.applied.forEach((item) => caveats.push({ type: "extrapolation", level: "warning", text: item.message }));
  }
  if (selfTrack === null) {
    caveats.push({
      type: "appearance-self-missing",
      level: "warning",
      text: photoInterval
        ? "未填颜值自评（或数值越界）：颜值区间仅由照片维度映射得出，仅供参考；不再按 0 分处理。"
        : "未提供颜值自评与照片：颜值轨道不参与综合分（不输出区间、不按 0 分计）。"
    });
  }
  if (independence.provisional) {
    caveats.push({ type: "independence-provisional", text: independence.note });
  }
  caveats.push({ type: "band-vocabulary", text: bandEvaluation.disclaimer + " baseline 的 S/A/B/C 刻度属 engineering-default，只作参照、不作为结论。" });
  if (context.cityMatched === false) {
    caveats.push({ type: "city-tier-fallback", text: "城市「" + String(form.city) + "」不在演示分档表中，收入等按默认档（三线）处理：该档位无语料依据。" });
  }
  caveats.push({ type: "corpus-coverage", text: ruleset.main.corpus ? "知识库规则基于当前转写语料 " + ruleset.main.corpus.coveragePct + "%（" + ruleset.main.corpus.transcribed + "/" + ruleset.main.corpus.planned + " 条）。" : "主规则集未携带 corpus 元数据，语料覆盖率未知。" });
  caveats.push({ type: "evidence-summary", text: "计分项 " + evidenceSummary.scoredItems + " 个：计入综合分 " + evidenceSummary.countableItems + " 个，仅参考 " + evidenceSummary.referenceOnlyItems + " 个。" });
  if (evidenceSummary.withoutEvidence > 0) {
    caveats.push({ type: "no-evidence-items", text: "有 " + evidenceSummary.withoutEvidence + " 个计分项无语料依据（工程默认/基线），已排除出综合分。" });
  }
  caveats.push({ type: "weight-source", text: "计分权重当前全部为工程默认（dimension.weightSource=engineering）：分值排序对权重敏感，知识库给出权重依据后需重算。" });
  caveats.push({ type: "photo-track", text: "照片轨道：" + photoTrackRaw.mode + "。" + (photoTrackRaw.caveats || []).join(" ") });
  if (ruleset.supersededDimensions.length) {
    caveats.push({ type: "superseded", text: "演示基线中有 " + ruleset.supersededDimensions.length + " 个字段已被知识库维度接管（如 " + ruleset.supersededDimensions[0].id + " → " + ruleset.supersededDimensions[0].supersededBy + "），不再重复计分。" });
  }
  if (compositeMissingCriteria) {
    caveats.push({ type: "composite-no-criteria", text: "知识库提供了 " + compositeMissingCriteria + "，但 web/config/composite-criteria.json 还没有逐项条件：本次仍按工程权重法（engineering-default，D17）。" });
  }
  if (hardware.basis === "corpus-composite" && hardware.composite) {
    caveats.push({ type: "composite-basis", text: "男生硬件分采用语料十项加分表（composites.hardware.male）：原分上限 " + hardware.composite.rawMax + " 归一化到 " + hardware.composite.toMax + " 再映射 1–9，并作为综合分的硬件槽位（定义型单源，1 条转写 / 1 个账号，D21 允许为 hard）；工程权重表仅作参考展示（权重为工程默认，D17）。" });
    if (hardware.composite.gaps.length) {
      caveats.push({ type: "composite-form-gaps", level: "warning", text: "复合表有 " + hardware.composite.gaps.length + " 项因表单缺字段暂不计分（" + hardware.composite.gaps.map((gap) => gap.needField).join("、") + "）：当前可计算满分 " + hardware.composite.computableMax + "/" + hardware.composite.rawMax + " → 归一化上限 " + hardware.composite.computableMaxNormalized + "。" });
    }
  }
  if (!useComposite) {
    caveats.push({ type: "hardware-basis-engineering", level: "warning", text: "硬件分采用工程权重法：评分表的维度证据可用，但权重为工程默认（weightSource=engineering，D17）；数字仅供参照。" });
  }
  const dataQuality = photoTrackRaw.dataQuality || {};
  if (Array.isArray(dataQuality.issues) && dataQuality.issues.length) {
    caveats.push({ type: "photo-quality", text: "照片质量提示：usable=" + String(dataQuality.usable) + "，问题：" + dataQuality.issues.join("；") });
  }
  const unsatisfied = evidenceRequirements.filter((item) => !item.satisfied);
  if (unsatisfied.length) {
    caveats.push({ type: "require-evidence", level: "warning", text: "有 " + unsatisfied.length + " 条规则要求结论昭示证据，但规则自身没有语料证据。" });
  }
  if (unscoredItems.length) {
    caveats.push({
      type: "missing-inputs",
      text: "以下 " + unscoredItems.length + " 项因未填写未计分（不按 0 计、不参与综合分，也不作为不利结论）："
        + unscoredItems.map((item) => item.name + "（" + item.note + "）").join("；")
    });
  }
  if (independence.qualityFlags.available) {
    const downgradedRules = scoringRun.applied.concat(matchRun.applied).filter((rule) => {
      const source = ruleset.rules.find((item) => item.id === rule.ruleId);
      const measured = strengthOfRule(source || { id: rule.ruleId, evidence: rule.evidence }, independence);
      return measured.qualityDowngraded === true;
    }).map((rule) => rule.ruleId);
    if (independence.qualityFlags.highCount > 0) {
      caveats.push({
        type: "quality-flags",
        text: "数据质量标记：knowledge/evidence-quality-flags.json 有 " + independence.qualityFlags.totalFlags + " 条（high " + independence.qualityFlags.highCount + " 个 aweme_id：数字粘连/循环回音/单位误读等）；命中 high 的证据强度降一级。本次受影响的命中规则 " + (downgradedRules.length ? downgradedRules.join("、") : "无") + "。"
      });
    }
  } else {
    caveats.push({ type: "quality-flags-provisional", text: independence.qualityFlags.note });
  }
  if (ruleErrors.length) {
    caveats.push({ type: "rule-errors", level: "warning", text: "有 " + ruleErrors.length + " 条规则求值出错并被跳过：" + ruleErrors.map((item) => item.ruleId + "（" + item.message + "）").join("；") });
  }
  extrapolation.errors.forEach((item) => caveats.push({ type: "extrapolation-error", level: "warning", text: "外推场景 " + item.id + " 求值失败：" + item.message }));

  return {
    disclosure: DISCLOSURE,
    id: newId("rpt"),
    createdAt: now,
    engine: {
      mainRules: { path: ruleset.main.path, version: ruleset.main.version, generatedAt: ruleset.main.generatedAt, corpus: ruleset.main.corpus },
      baseline: { path: ruleset.baseline.path, version: ruleset.baseline.version, authoritative: false, used: ruleset.baseline.used },
      coverage: ruleset.coverage,
      warnings: ruleset.warnings,
      model: photoTrackRaw.model,
      photoMode: photoTrackRaw.mode
    },
    confidence: {
      method: "D11 分层可信度",
      independence: { available: independence.available, provisional: independence.provisional, source: independence.source || null, note: independence.note, path: independence.path },
      independenceCoverage: { totalRules: totalRuleCount, auditedRules: auditedRuleCount, heuristicRules: totalRuleCount - auditedRuleCount, audited: independence.ruleStrength ? independence.ruleStrength.size : 0, note: "auditedRules 为有 audit-rules 预计算强度的规则数；其余走启发式（UI 带 *）。" },
      qualityFlags: {
        available: independence.qualityFlags.available,
        provisional: independence.qualityFlags.provisional,
        highCount: independence.qualityFlags.highCount,
        totalFlags: independence.qualityFlags.totalFlags,
        note: independence.qualityFlags.note
      },
      summary: { scoredItems: evidenceSummary.scoredItems, countableItems: evidenceSummary.countableItems, referenceOnlyItems: evidenceSummary.referenceOnlyItems, byStrength },
      levelComponents,
      extrapolation: { active: extrapolation.active, applied: extrapolation.applied, pending: extrapolation.pending, affectedGroups: extrapolation.affectedGroups }
    },
    subject: form,
    context,
    appearance,
    hardware,
    soft,
    level,
    levelIfAllCounted,
    portrait: {
      text: portraitText,
      targetProfile,
      band: band ? {
        id: band.id,
        name: band.name,
        bandType: band.bandType || null,
        origin: "knowledge",
        source: bandSource,
        strength: bandStrengthLevel,
        strengthLabel: bandStrengthLabel,
        engineeringDefault: false
      } : null,
      bandSource,
      bandNote,
      scaleDisclaimer: bandEvaluation.disclaimer,
      missingBandInputs: bandEvaluation.missingFields,
      referenceScale: bandEvaluation.baseline,
      ladder
    },
    matchWindow: matchWindow ? {
      strength: STRENGTH.ENGINEERING_DEFAULT,
      strengthLabel: strengthMeta(STRENGTH.ENGINEERING_DEFAULT).label,
      disclaimer: "可达上限 / 稳妥区间 / 下限由综合分 ± 工程默认窗口参数（window）计算，无语料依据，只作参考。",
      upper: { score: matchWindow.upper.score, bandName: matchWindow.upper.band ? matchWindow.upper.band.name : null, note: "可达上限：需要单项突出或对方刚好偏好你的强项，成功率低。" },
      stable: { low: matchWindow.stable.low, high: matchWindow.stable.high, bandLow: matchWindow.stable.bandLow ? matchWindow.stable.bandLow.name : null, bandHigh: matchWindow.stable.bandHigh ? matchWindow.stable.bandHigh.name : null, note: "稳妥区间：双方条件互不嫌弃，推进成功率最高。" },
      lower: { score: matchWindow.lower.score, bandName: matchWindow.lower.band ? matchWindow.lower.band.name : null, note: "需要妥协的下限：低于这条线你会明显不满，不建议为了结婚硬压。" }
    } : null,
    giveUps,
    advice,
    claimsSummary,
    notes,
    flags,
    evidenceRequirements,
    rulesApplied: scoringRun.applied.concat(matchRun.applied).map((rule) => {
      const source = ruleset.rules.find((item) => item.id === rule.ruleId);
      const measured = strengthOfRule(source || { id: rule.ruleId, evidence: rule.evidence }, independence);
      const strength = strengthMeta(measured.level);
      return {
        ruleId: rule.ruleId, scope: rule.scope, title: rule.title, origin: rule.origin, mirrors: rule.mirrors, via: rule.via,
        strength: strength.label, strengthColor: strength.color, strengthMethod: measured.method || null, strengthReason: measured.reason, strengthProvisional: measured.provisional === true,
        qualityDowngraded: measured.qualityDowngraded === true, qualityFlagged: measured.qualityFlagged || [],
        evidence: collectEvidence(rule.evidence, "rule:" + rule.ruleId, measured.level)
      };
    }),
    ruleErrors,
    advisoryRules,
    behaviorCheck,
    unstructuredRules,
    improvements,
    excludedItems,
    unscoredItems,
    supersededDimensions: ruleset.supersededDimensions,
    uncoveredFields,
    evidenceIndex,
    evidenceSummary,
    caveats
  };
}

export { NO_EVIDENCE_NOTE };
