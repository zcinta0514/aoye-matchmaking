import { fsShim as fs } from "./load-browser.mjs";
import { readJson } from "./util.mjs";

const REQUIRED_TOP_KEYS = ["version", "generatedAt", "scales", "dimensions", "rules", "bands"];
const GROUPS = new Set(["hardware", "soft", "family", "appearance", "other"]);
const CONDITION_KEYS = new Set(["field", "op", "value", "all", "any", "not"]);
export const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "between", "exists", "missing", "includes", "matches"]);
export const THEN_KINDS = new Set(["clampScale", "setBand", "advice", "giveUp", "text", "flag", "requireEvidence"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkEvidence(list, where, problems) {
  if (!Array.isArray(list)) {
    problems.push(where + ": evidence 必须是数组");
    return;
  }
  list.forEach((item, index) => {
    const at = where + ".evidence[" + index + "]";
    if (!isObject(item)) return problems.push(at + ": 必须是对象");
    if (typeof item.account !== "string" || !item.account) problems.push(at + ": 缺 account");
    if (typeof item.aweme_id !== "string" || !/^[0-9]{15,}$/.test(item.aweme_id)) problems.push(at + ": aweme_id 不合法");
    if (typeof item.quote !== "string" || item.quote.length < 4) problems.push(at + ": quote 缺失或过短");
  });
}

/** 严格校验条件树：未知键、非法 op、value 形状不正确都算错误（加载期即拒绝）。 */
export function validateCondition(cond, where, problems) {
  if (!isObject(cond)) {
    problems.push(where + ": 条件必须是对象（当前 " + JSON.stringify(cond) + "）");
    return;
  }
  Object.keys(cond).forEach((key) => {
    if (!CONDITION_KEYS.has(key)) problems.push(where + ": 未知条件键「" + key + "」（可用：field/op/value/all/any/not）");
  });
  const hasCombinator = cond.all !== undefined || cond.any !== undefined || cond.not !== undefined;
  const hasLeafKey = cond.field !== undefined || cond.op !== undefined;
  if (hasCombinator && hasLeafKey) {
    problems.push(where + ": 组合键（all/any/not）不能与 field/op 混用");
  }
  if (cond.all !== undefined) {
    if (!Array.isArray(cond.all) || cond.all.length === 0) problems.push(where + ".all: 必须是非空数组");
    else cond.all.forEach((item, index) => validateCondition(item, where + ".all[" + index + "]", problems));
  }
  if (cond.any !== undefined) {
    if (!Array.isArray(cond.any) || cond.any.length === 0) problems.push(where + ".any: 必须是非空数组");
    else cond.any.forEach((item, index) => validateCondition(item, where + ".any[" + index + "]", problems));
  }
  if (cond.not !== undefined) validateCondition(cond.not, where + ".not", problems);
  if (hasCombinator) return;
  if (typeof cond.field !== "string" || !cond.field) problems.push(where + ": 叶条件缺少 field");
  if (typeof cond.op !== "string" || !OPS.has(cond.op)) {
    problems.push(where + ": 非法 op「" + String(cond.op) + "」（可用：" + Array.from(OPS).join(" ") + "）");
    return;
  }
  const value = cond.value;
  if (cond.op === "exists" || cond.op === "missing") return;
  if (value === undefined) {
    problems.push(where + ": op=" + cond.op + " 缺少 value");
    return;
  }
  if (cond.op === "between" && (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "number")) {
    problems.push(where + ": between 的 value 必须是 [数字, 数字]");
  }
  if ((cond.op === "in" || cond.op === "nin") && !Array.isArray(value)) {
    problems.push(where + ": " + cond.op + " 的 value 必须是数组");
  }
  if (cond.op === "matches" && typeof value !== "string") {
    problems.push(where + ": matches 的 value 必须是字符串（正则）");
  }
}

function validateMachineAction(action, where, problems) {
  if (!isObject(action)) {
    problems.push(where + ": 动作必须是对象");
    return;
  }
  if (typeof action.kind !== "string" || !THEN_KINDS.has(action.kind)) {
    problems.push(where + ": 非法 kind「" + String(action.kind) + "」（可用：" + Array.from(THEN_KINDS).join(" ") + "）");
    return;
  }
  const hasText = typeof action.text === "string" && action.text.length > 0;
  const hasNote = typeof action.note === "string" && action.note.length > 0;
  if (action.kind === "clampScale") {
    if (typeof action.scale !== "string" || !action.scale) problems.push(where + ": clampScale 缺少 scale");
    if (typeof action.min !== "number" && typeof action.max !== "number") problems.push(where + ": clampScale 至少需要 min 或 max（数字）");
  }
  if (action.kind === "setBand" && (typeof action.band !== "string" || !action.band)) problems.push(where + ": setBand 缺少 band");
  if ((action.kind === "advice" || action.kind === "giveUp" || action.kind === "text") && !hasText) problems.push(where + ": " + action.kind + " 缺少 text");
  if ((action.kind === "flag" || action.kind === "requireEvidence") && !hasText && !hasNote) problems.push(where + ": " + action.kind + " 至少需要 text 或 note");
}

export function validateRulesDoc(doc, options) {
  const opts = options || {};
  const label = opts.label || "rules";
  const strict = opts.strict !== false;
  const problems = [];
  const warnings = [];

  if (!isObject(doc)) throw new Error(label + ": 顶层必须是对象");
  if (strict) {
    REQUIRED_TOP_KEYS.forEach((key) => {
      if (!(key in doc)) problems.push(label + ": 缺少顶层字段 " + key);
    });
  }
  const origin = isObject(doc.meta) ? doc.meta.origin : undefined;
  const isBaseline = origin === "web-baseline";
  if (!strict && !isBaseline) {
    problems.push(label + ": 非严格模式下也必须声明 meta.origin=web-baseline");
  }

  (doc.scales || []).forEach((scale, index) => {
    const at = label + ".scales[" + index + "]";
    ["id", "name", "min", "max"].forEach((key) => {
      if (scale[key] === undefined) problems.push(at + ": 缺 " + key);
    });
    if (!Array.isArray(scale.anchors) || scale.anchors.length === 0) problems.push(at + ": 缺 anchors");
    if (strict) checkEvidence(scale.evidence, at, problems);
  });

  (doc.dimensions || []).forEach((dim, index) => {
    const at = label + ".dimensions[" + index + "]";
    ["id", "name", "group", "type"].forEach((key) => {
      if (dim[key] === undefined) problems.push(at + ": 缺 " + key);
    });
    if (dim.group && !GROUPS.has(dim.group)) problems.push(at + ": 未知 group " + dim.group);
    if (dim.scoring !== undefined) validateDimensionScoring(dim, at, problems);
    if (strict) checkEvidence(dim.evidence, at, problems);
  });

  (doc.rules || []).forEach((rule, index) => {
    const at = label + ".rules[" + index + "]";
    if (typeof rule.id !== "string" || (strict ? !/^R-[A-Z]+-[0-9]{3}$/.test(rule.id) : rule.id.length < 4)) {
      problems.push(at + ": id 不合法（知识库须匹配 R-XXX-000）");
    }
    if (rule.when === undefined) problems.push(at + ": 缺 when");
    if (rule.then === undefined) problems.push(at + ": 缺 then");
    if (strict) checkEvidence(rule.evidence, at, problems);

    if (rule.machine !== undefined) {
      if (!isObject(rule.machine)) {
        problems.push(at + ".machine: 必须是对象");
      } else {
        if (rule.machine.when === undefined) problems.push(at + ".machine: 缺 when");
        else if (Array.isArray(rule.machine.when)) rule.machine.when.forEach((cond, i) => validateCondition(cond, at + ".machine.when[" + i + "]", problems));
        else validateCondition(rule.machine.when, at + ".machine.when", problems);
        if (rule.machine.then !== undefined) {
          if (!Array.isArray(rule.machine.then)) problems.push(at + ".machine.then: 必须是数组");
          else rule.machine.then.forEach((action, i) => validateMachineAction(action, at + ".machine.then[" + i + "]", problems));
        }
      }
    } else if (typeof rule.when === "object") {
      validateCondition(rule.when, at + ".when", problems);
    } else if (rule.advisory !== true) {
      warnings.push(at + " (" + rule.id + "): 既没有 machine、也没有 advisory:true —— 引擎不会执行它");
    }
  });

  (doc.bands || []).forEach((band, index) => {
    const at = label + ".bands[" + index + "]";
    ["id", "name", "definition"].forEach((key) => {
      if (band[key] === undefined) problems.push(at + ": 缺 " + key);
    });
    if (band.range !== undefined && (!Array.isArray(band.range) || band.range.length !== 2)) problems.push(at + ": range 必须是 [min,max]");
    if (strict) checkEvidence(band.evidence, at, problems);
  });

  if (problems.length) {
    const error = new Error(label + " 校验失败:\n- " + problems.join("\n- "));
    error.problems = problems;
    error.warnings = warnings;
    throw error;
  }
  return { ok: true, origin: isBaseline ? "web-baseline" : "knowledge", warnings };
}

/** 维度 scoring 结构：type ∈ bands|options|scale1to5，且对应的数据形状必须齐备。 */
function validateDimensionScoring(dim, at, problems) {
  const scoring = dim.scoring;
  if (!isObject(scoring)) return problems.push(at + ".scoring: 必须是对象");
  const type = scoring.type;
  if (["bands", "options", "scale1to5"].indexOf(type) === -1) {
    return problems.push(at + ".scoring.type: 未知类型「" + String(type) + "」（可用：bands options scale1to5）");
  }
  if (type === "bands") {
    const list = scoring.bands || (scoring.byGender && Object.values(scoring.byGender)[0]) || (scoring.byCityTier && Object.values(scoring.byCityTier)[0]);
    if (!Array.isArray(list)) problems.push(at + ".scoring: bands 类型必须是数组");
    else list.forEach((band, i) => {
      if (!isObject(band) || typeof band.score !== "number") problems.push(at + ".scoring.bands[" + i + "]: 需要数值 score");
      if (band && band.min !== undefined && typeof band.min !== "number") problems.push(at + ".scoring.bands[" + i + "].min 必须是数字");
      if (band && band.max !== undefined && typeof band.max !== "number") problems.push(at + ".scoring.bands[" + i + "].max 必须是数字");
    });
  }
  if (type === "options") {
    const map = scoring.map;
    const list = scoring.options;
    const okMap = isObject(map) && Object.values(map).every((value) => typeof value === "number");
    const okList = Array.isArray(list) && list.every((item) => isObject(item) && typeof item.value === "string" && typeof item.score === "number");
    if (!okMap && !okList) problems.push(at + ".scoring: options 类型需要 map（值→分数）或 options=[{value,score}]");
  }
  if (type === "scale1to5") {
    const okList = Array.isArray(scoring.scores) && scoring.scores.length >= 5 && scoring.scores.every((value) => typeof value === "number");
    const okMap = isObject(scoring.map) && Object.keys(scoring.map).length >= 5;
    if (!okList && !okMap) problems.push(at + ".scoring: scale1to5 需要 scores（5 个数字）或 map");
  }
  if (dim.weight !== undefined && dim.weight !== null && typeof dim.weight !== "number") {
    problems.push(at + ".weight: 必须是数字或 null");
  }
}

function mergeById(mainList, baselineList) {
  const out = new Map();
  (baselineList || []).forEach((item) => out.set(item.id, Object.assign({}, item, { _origin: "web-baseline" })));
  (mainList || []).forEach((item) => out.set(item.id, Object.assign({}, item, { _origin: "knowledge" })));
  return Array.from(out.values());
}

export function getRuleCondition(rule) {
  if (rule.machine && isObject(rule.machine) && rule.machine.when !== undefined) return rule.machine.when;
  if (isObject(rule.when)) return rule.when;
  return null;
}

export function loadRuleset(options) {
  const opts = options || {};
  const mainPath = opts.mainPath;
  const baselinePath = opts.baselinePath;
  const warnings = [];

  const mainDoc = readJson(mainPath);
  const mainValidation = validateRulesDoc(mainDoc, { label: "knowledge", strict: true });
  mainValidation.warnings.forEach((warning) => warnings.push("knowledge: " + warning));

  let baselineDoc = { version: "none", meta: {}, scales: [], dimensions: [], rules: [], bands: [], improvementPlaybook: {}, glossary: [] };
  if (baselinePath && fs.existsSync(baselinePath)) {
    baselineDoc = readJson(baselinePath);
    const baselineValidation = validateRulesDoc(baselineDoc, { label: "web-baseline", strict: false });
    baselineValidation.warnings.forEach((warning) => warnings.push("baseline: " + warning));
  } else {
    warnings.push("未找到 web 基线规则文件：" + baselinePath);
  }

  const scales = mergeById(mainDoc.scales, baselineDoc.scales);
  const mergedDimensions = mergeById(mainDoc.dimensions, baselineDoc.dimensions);
  /* 知识库维度已覆盖的字段：基线占位维度直接让位（避免同字段双计），而不是当成「缺证据计分项」。 */
  const knowledgeFieldToDim = new Map();
  mergedDimensions.forEach((dim) => {
    if (dim._origin === "knowledge" && dim.field && dim.scoring && !knowledgeFieldToDim.has(dim.field)) {
      knowledgeFieldToDim.set(dim.field, dim.id);
    }
  });
  const supersededDimensions = [];
  const dimensions = mergedDimensions.filter((dim) => {
    if (dim._origin === "web-baseline" && dim.field && dim.scoring && knowledgeFieldToDim.has(dim.field)) {
      supersededDimensions.push({ id: dim.id, field: dim.field, supersededBy: knowledgeFieldToDim.get(dim.field) });
      return false;
    }
    return true;
  });
  const rules = mergeById(mainDoc.rules, baselineDoc.rules);
  const bands = mergeById(mainDoc.bands, baselineDoc.bands);
  const composites = (mainDoc.composites || []).map((item) => Object.assign({}, item, { _origin: "knowledge" }));

  const executableRules = rules.filter((rule) => getRuleCondition(rule) !== null);
  const advisoryRules = rules.filter((rule) => getRuleCondition(rule) === null && rule.advisory === true);
  const unstructuredRules = rules.filter((rule) => getRuleCondition(rule) === null && rule.advisory !== true);
  const knowledgeExecutable = executableRules.filter((rule) => rule._origin === "knowledge").length;
  const baselineExecutable = executableRules.filter((rule) => rule._origin === "web-baseline").length;
  const knowledgeScoredDimensions = dimensions.filter((dim) => dim._origin === "knowledge" && dim.scoring && typeof dim.weight === "number" && dim.weight > 0).length;
  const knowledgeUsableBands = bands.filter((band) => band._origin === "knowledge" && (Array.isArray(band.range) || typeof band.level === "number")).length;

  if (knowledgeExecutable === 0 && (mainDoc.rules || []).length > 0) {
    warnings.push("主规则集 " + (mainDoc.rules || []).length + " 条规则中没有可执行规则（缺 machine.when）：知识库结论尚未参与计算，当前打分全部来自演示基线。");
  }
  if (unstructuredRules.length > 0) {
    warnings.push(unstructuredRules.length + " 条规则既无 machine 也未标 advisory:true（按契约 §5.0 应二选一）。");
  }

  return {
    main: {
      path: mainPath,
      version: mainDoc.version,
      generatedAt: mainDoc.generatedAt,
      corpus: mainDoc.corpus || null
    },
    baseline: {
      path: baselinePath,
      version: baselineDoc.version,
      meta: baselineDoc.meta || {},
      used: baselineDoc.version !== "none"
    },
    scales,
    dimensions,
    supersededDimensions,
    rules,
    executableRules,
    advisoryRules,
    unstructuredRules,
    bands,
    composites,
    improvementPlaybook: baselineDoc.improvementPlaybook || {},
    glossary: (mainDoc.glossary || []).concat(baselineDoc.glossary || []),
    coverage: {
      knowledge: {
        scales: (mainDoc.scales || []).length,
        dimensions: (mainDoc.dimensions || []).length,
        rules: (mainDoc.rules || []).length,
        bands: (mainDoc.bands || []).length,
        executableRules: knowledgeExecutable,
        advisoryRules: advisoryRules.filter((rule) => rule._origin === "knowledge").length,
        unstructuredRules: unstructuredRules.filter((rule) => rule._origin === "knowledge").length,
        scoredDimensions: knowledgeScoredDimensions,
        usableBands: knowledgeUsableBands
      },
      baseline: {
        scales: (baselineDoc.scales || []).length,
        dimensions: (baselineDoc.dimensions || []).length,
        rules: (baselineDoc.rules || []).length,
        bands: (baselineDoc.bands || []).length,
        executableRules: baselineExecutable
      }
    },
    warnings
  };
}

export function getScale(ruleset, id) {
  return ruleset.scales.find((scale) => scale.id === id) || null;
}

export function getDimension(ruleset, id) {
  return ruleset.dimensions.find((dim) => dim.id === id) || null;
}

export function getBand(ruleset, id) {
  return ruleset.bands.find((band) => band.id === id) || null;
}

export function getComposite(ruleset, id) {
  return ruleset.composites.find((item) => item.id === id) || null;
}
