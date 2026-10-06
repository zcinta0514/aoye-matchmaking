import { fsShim as fs } from "./load-browser.mjs";
import { readJson } from "./util.mjs";

/* ------------------------------------------------------------------ */
/* facts.json（声明） ↔ buildFacts（注入）双向覆盖检查                   */
/*   声明了但注入不了 → machine.when 静默失效（本文件要堵的口子）        */
/*   注入了但没声明   → 规则作者查不到，也是隐患                        */
/* ------------------------------------------------------------------ */

export function loadFactsDoc(file) {
  if (!file || !fs.existsSync(file)) {
    return { doc: null, path: file || null, warnings: [], note: "未找到 facts.json：" + String(file) };
  }
  try {
    const doc = readJson(file);
    return { doc, path: file, warnings: Array.isArray(doc.warnings) ? doc.warnings : [], note: null };
  } catch (error) {
    return { doc: null, path: file, warnings: [], note: "facts.json 解析失败：" + String(error && error.message ? error.message : error) };
  }
}

export function collectDeclaredPaths(factsDoc) {
  const paths = new Set();
  if (!factsDoc) return paths;
  (factsDoc.facts || []).forEach((item) => { if (item && item.field) paths.add(String(item.field)); });
  (factsDoc.photoFacts || []).forEach((item) => { if (item && item.field) paths.add(String(item.field)); });
  return paths;
}

/**
 * facts.json 的 internalFactsNotForRules：引擎内部字段，规则不得依赖、也不要求注入。
 * 条目形如 "context.cityMatched（说明文字）"，只取括号前的字段名。
 */
export function collectInternalPaths(factsDoc) {
  const paths = new Set();
  if (!factsDoc || !Array.isArray(factsDoc.internalFactsNotForRules)) return paths;
  factsDoc.internalFactsNotForRules.forEach((entry) => {
    const text = String(entry || "").trim();
    if (!text) return;
    const cut = text.search(/[（(]/);
    const name = (cut === -1 ? text : text.slice(0, cut)).trim();
    if (name) paths.add(name);
  });
  return paths;
}

/**
 * buildFacts 实际能注入的键（与 pipeline.mjs#buildFacts 保持同步）。
 * 任何新增注入点都必须加进来，否则检查会说谎。
 */
export function collectInjectablePaths(options) {
  const formFieldIds = options.formFieldIds || [];
  const hardwareDimensionIds = options.hardwareDimensionIds || [];
  const softDimensionIds = options.softDimensionIds || [];
  const photoDimensionIds = options.photoDimensionIds || [];
  const paths = new Set();
  formFieldIds.forEach((id) => paths.add("subject." + id));
  ["want.appearance_gap", "want.height_gap", "want.age_gap_older", "want.age_gap_younger"].forEach((p) => paths.add(p));
  [
    "appearance.final.low", "appearance.final.high", "appearance.final.mid", "appearance.final.consensus",
    "appearance.divergence", "appearance.divergenceAbs",
    "appearance.selfTrack.raw", "appearance.selfTrack.adjusted", "appearance.selfTrack.low", "appearance.selfTrack.high",
    "appearance.photoTrack.low", "appearance.photoTrack.high",
    "hardware.score", "soft.score",
    "context.city", "context.cityTier"
  ].forEach((p) => paths.add(p));
  hardwareDimensionIds.forEach((id) => paths.add("hardware.breakdown." + id));
  softDimensionIds.forEach((id) => paths.add("soft.breakdown." + id));
  photoDimensionIds.forEach((id) => paths.add("photo." + id));
  return paths;
}

/** facts.json 里形如 hardware.breakdown.<dimId> 的模板：前缀命中即算覆盖。 */
function isSatisfied(declaredPath, injectable) {
  if (injectable.has(declaredPath)) return true;
  const lt = declaredPath.indexOf("<");
  if (lt === -1) return false;
  const prefix = declaredPath.slice(0, lt);
  for (const path of injectable) {
    if (path.indexOf(prefix) === 0) return true;
  }
  return false;
}

export function checkFactsCoverage(options) {
  const declared = collectDeclaredPaths(options.factsDoc);
  const internal = collectInternalPaths(options.factsDoc);
  const injectable = collectInjectablePaths(options);
  const declaredNotInjectable = [];
  const injectableNotDeclared = [];
  declared.forEach((path) => {
    if (internal.has(path)) return; // 内部字段：不要求注入、也不报警
    if (!isSatisfied(path, injectable)) declaredNotInjectable.push(path);
  });
  const declaredPatterns = [];
  declared.forEach((path) => {
    const lt = path.indexOf("<");
    if (lt !== -1) declaredPatterns.push(path.slice(0, lt));
  });
  injectable.forEach((path) => {
    if (declared.has(path)) return;
    if (internal.has(path)) return; // 白名单：仅限 facts.json 声明为内部的字段
    if (declaredPatterns.some((prefix) => path.indexOf(prefix) === 0)) return;
    injectableNotDeclared.push(path);
  });
  return {
    ok: declaredNotInjectable.length === 0,
    declaredCount: declared.size,
    internalDeclared: Array.from(internal).sort(),
    injectableCount: injectable.size,
    declaredNotInjectable: declaredNotInjectable.sort(),
    injectableNotDeclared: injectableNotDeclared.sort()
  };
}

/** 启动期：读 facts.json、打印其 warnings、跑双向覆盖检查并逐条告警。 */
export function inspectFactsCoverage(options) {
  const facts = loadFactsDoc(options.factsPath);
  const warnings = facts.warnings.slice();
  if (facts.note) warnings.push(facts.note);
  let coverage = null;
  if (facts.doc) {
    coverage = checkFactsCoverage({
      factsDoc: facts.doc,
      formFieldIds: options.formFieldIds || [],
      hardwareDimensionIds: options.hardwareDimensionIds || [],
      softDimensionIds: options.softDimensionIds || [],
      photoDimensionIds: options.photoDimensionIds || []
    });
    coverage.declaredNotInjectable.slice(0, 12).forEach((path) => {
      const detail = path.indexOf("subject.") === 0
        ? "web/config/form-fields.json 里没有这个字段（表单扩字段后才会注入）"
        : "buildFacts 没有注入这个键";
      warnings.push("facts.json 声明了 " + path + " 但运行时拿不到 —— " + detail + "；引用它的 machine.when 会静默失效。");
    });
    if (coverage.declaredNotInjectable.length > 12) {
      warnings.push("（声明未注入字段还有 " + (coverage.declaredNotInjectable.length - 12) + " 条，完整列表见 /api/health 的 factsCoverage）");
    }
    if (coverage.injectableNotDeclared.length) {
      warnings.push("buildFacts 注入了 " + coverage.injectableNotDeclared.length + " 个 facts.json 未声明的字段（" + coverage.injectableNotDeclared.slice(0, 6).join("、") + " 等）—— 规则作者发现不了，完整列表见 /api/health 的 factsCoverage。");
    }
  }
  return { factsPath: facts.path, warnings, coverage };
}
