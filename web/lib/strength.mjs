import fs from "node:fs";
import { readJson } from "./util.mjs";

/* ------------------------------------------------------------------ */
/* D11 分层可信度                                                      */
/*   verified            >=3 条独立证据 + >=2 个来源组  -> 算分          */
/*   cross-account       2 个来源组互证                  -> 算分          */
/*   single-source       仅 1 条语料 / 单来源组           -> 只展示        */
/*   extrapolated        相近人群外推（D12）              -> 只作参考      */
/*   engineering-default 无语料依据的工程默认             -> 不计入        */
/*   advisory            规则标了 advisory                -> 只展示        */
/* ------------------------------------------------------------------ */

export const STRENGTH = {
  VERIFIED: "verified",
  CROSS_ACCOUNT: "cross-account",
  SINGLE_SOURCE: "single-source",
  EXTRAPOLATED: "extrapolated",
  ENGINEERING_DEFAULT: "engineering-default",
  ADVISORY: "advisory"
};

export const STRENGTH_META = {
  verified: { label: "机构内多源一致", color: "green", countable: true, description: "同一机构内 ≥3 条独立证据、跨 ≥2 个账号（非跨机构独立验证）" },
  "cross-account": { label: "机构内 2 源一致", color: "blue", countable: true, description: "同一机构内 2 个账号表述一致（非跨机构独立验证）" },
  "single-source": { label: "机构内单源", color: "gray", countable: false, description: "同一机构内仅 1 条语料，只展示不算分" },
  extrapolated: { label: "外推参考", color: "yellow", countable: false, description: "由相近人群规则外推，误差不可估计，不参与综合分" },
  "engineering-default": { label: "工程默认", color: "red", countable: false, description: "无语料依据的工程默认值，不计入结论" },
  advisory: { label: "体系参考", color: "purple", countable: false, description: "标注 advisory：仅供人工阅读" }
};

export function strengthMeta(level) {
  return STRENGTH_META[level] || { label: String(level), color: "gray", countable: false, description: "" };
}

export function isCountable(level) {
  return level === STRENGTH.VERIFIED || level === STRENGTH.CROSS_ACCOUNT;
}

/** aoye98 与 aoye28 已知互相搬运内容：独立性数据缺失时归为同一来源组。 */
const MAIN_GROUP = { aoye98: "grp.aoye-main", aoye28: "grp.aoye-main" };

export function loadIndependence(file) {
  if (!file || !fs.existsSync(file)) {
    return {
      available: false,
      provisional: true,
      path: file || null,
      note: "knowledge/evidence-independence.json 尚未就绪：使用启发式（独立证据条数 + 去重来源组；aoye98/aoye28 视为同一来源组）",
      accountGroup: new Map(),
      claims: { available: false, provisional: true, mode: null, byRule: new Map(), ruleCount: 0, claimCount: 0 }
    };
  }
  try {
    const doc = readJson(file);
    const parsedClaims = parseClaims(doc);
    const claimsBundle = {
      available: parsedClaims.byRule.size > 0,
      provisional: parsedClaims.byRule.size === 0,
      mode: parsedClaims.mode,
      byRule: parsedClaims.byRule,
      ruleCount: parsedClaims.byRule.size,
      claimCount: Array.from(parsedClaims.byRule.values()).reduce((acc, list) => acc + list.length, 0)
    };
    /* 格式 A（audit-rules 产出）：ruleEvidence 为每条规则预计算的强度（权威口径）。 */
    if (doc && Array.isArray(doc.ruleEvidence)) {
      const ruleStrength = new Map();
      doc.ruleEvidence.forEach((item) => {
        if (!item || !item.ruleId) return;
        const level = normalizeLevel(item.strengthAfterTemplate || item.evidenceStrength);
        if (!level) return;
        ruleStrength.set(String(item.ruleId), {
          level,
          units: typeof item.uniqueAfterDedup === "number" ? item.uniqueAfterDedup : null,
          rawCount: typeof item.rawEvidence === "number" ? item.rawEvidence : null,
          accounts: Array.isArray(item.accountsAfterDedup) ? item.accountsAfterDedup : [],
          reason: item.downgradeReason || null,
          templateLinked: item.templateLinked === true,
          source: "audit-rules"
        });
      });
      const accountGroup = new Map();
      const mirrors = doc.params && Array.isArray(doc.params.mirrorAccounts) ? doc.params.mirrorAccounts : [];
      mirrors.forEach((pair) => {
        const parts = String(pair).split("->");
        if (parts.length !== 2) return;
        const from = parts[0].trim();
        const to = parts[1].trim();
        accountGroup.set(from, "grp." + to);
        if (!accountGroup.has(to)) accountGroup.set(to, "grp." + to);
      });
      return {
        available: true,
        provisional: false,
        source: "audit-rules",
        path: file,
        note: "使用 knowledge/evidence-independence.json（audit-rules）：规则强度为预计算值（" + (doc.summary ? ("verified " + doc.summary.verified + " / cross-account " + doc.summary.crossAccount + " / single-source " + doc.summary.singleSource) : "distribution unknown") + "）；维度强度仍为启发式（该数据集只审计规则）。",
        accountGroup,
        ruleStrength,
        summary: doc.summary || null,
        claims: claimsBundle
      };
    }
    const accountGroup = new Map();
    if (doc && typeof doc === "object") {
      if (doc.groups && typeof doc.groups === "object" && !Array.isArray(doc.groups)) {
        Object.keys(doc.groups).forEach((groupId) => {
          (doc.groups[groupId] || []).forEach((account) => accountGroup.set(String(account), String(groupId)));
        });
      }
      if (doc.accounts && typeof doc.accounts === "object" && !Array.isArray(doc.accounts)) {
        Object.keys(doc.accounts).forEach((account) => accountGroup.set(String(account), String(doc.accounts[account])));
      }
      if (Array.isArray(doc.sources)) {
        doc.sources.forEach((source, index) => {
          const groupId = String(source.id || ("src-" + index));
          (source.accounts || []).forEach((account) => accountGroup.set(String(account), groupId));
        });
      }
    }
    const usable = accountGroup.size > 0;
    return {
      available: usable,
      provisional: !usable,
      path: file,
      note: usable ? "使用 knowledge/evidence-independence.json 的账号独立性分组" : "独立性文件存在但无法解析出账号分组：回退启发式",
      accountGroup,
      claims: claimsBundle
    };
  } catch (error) {
    return {
      available: false,
      provisional: true,
      path: file,
      note: "独立性文件解析失败（" + String(error && error.message ? error.message : error) + "）：回退启发式",
      accountGroup: new Map(),
      claims: { available: false, provisional: true, mode: null, byRule: new Map(), ruleCount: 0, claimCount: 0 }
    };
  }
}

export function accountGroup(account, independence) {
  if (independence && independence.available && independence.accountGroup && independence.accountGroup.has(account)) {
    return independence.accountGroup.get(account);
  }
  return MAIN_GROUP[account] || ("solo:" + account);
}

const PUNCT = " ，。、！？；：（）()【】[]·,.!?;:「」《》…—"
  + String.fromCharCode(9) + String.fromCharCode(10)
  + String.fromCharCode(8220, 8221, 8216, 8217);

export function normalizeQuote(quote) {
  let text = String(quote || "");
  for (const ch of PUNCT) text = text.split(ch).join("");
  return text.slice(0, 28);
}

/* ------------------------------------------------------------------ */
/* 数据质量标记（knowledge/evidence-quality-flags.json，distill-demo 产出） */
/*   被标 severity: high 的 aweme_id 作为证据时，该证据强度降一级。        */
/*   文件不存在 → 跳过并标 provisional（不阻塞）。                        */
/* ------------------------------------------------------------------ */

export function loadQualityFlags(file) {
  const empty = {
    available: false,
    provisional: true,
    path: file || null,
    highIds: new Set(),
    byAweme: new Map(),
    highCount: 0,
    totalFlags: 0,
    note: "knowledge/evidence-quality-flags.json 未就绪：跳过质量降级（provisional）"
  };
  if (!file || !fs.existsSync(file)) return empty;
  try {
    const doc = readJson(file);
    const flags = Array.isArray(doc && doc.flags) ? doc.flags : [];
    const highIds = new Set();
    const byAweme = new Map();
    flags.forEach((flag) => {
      if (!flag || !flag.aweme_id) return;
      const id = String(flag.aweme_id);
      if (!byAweme.has(id)) byAweme.set(id, []);
      byAweme.get(id).push(flag);
      if (String(flag.severity) === "high") highIds.add(id);
    });
    return {
      available: true,
      provisional: false,
      path: file,
      highIds,
      byAweme,
      highCount: highIds.size,
      totalFlags: flags.length,
      note: "使用 " + String(file).replace(/^.*knowledge[/]/, "knowledge/") + "：" + flags.length + " 条标记，其中 high " + highIds.size + " 个 aweme_id（命中即降一级）"
    };
  } catch (error) {
    return Object.assign(empty, { note: "质量标记文件解析失败（" + String(error && error.message ? error.message : error) + "）：跳过质量降级（provisional）" });
  }
}

const DOWNGRADE_CHAIN = { verified: "cross-account", "cross-account": "single-source", "single-source": "single-source" };

export function downgradeLevel(level, steps) {
  let current = level;
  const count = steps === undefined ? 1 : steps;
  for (let i = 0; i < count; i += 1) {
    if (!DOWNGRADE_CHAIN[current]) break;
    current = DOWNGRADE_CHAIN[current];
  }
  return current;
}

function qualityHits(evidenceList, independence) {
  const flags = independence && independence.qualityFlags;
  if (!flags || !flags.available || !flags.highIds || !flags.highIds.size) return [];
  const hits = [];
  (evidenceList || []).forEach((item) => {
    if (!item || !item.aweme_id) return;
    if (flags.highIds.has(String(item.aweme_id))) hits.push(String(item.aweme_id));
  });
  return hits;
}

function applyQualityDowngrade(result, evidenceList, independence) {
  const hits = qualityHits(evidenceList, independence);
  if (!hits.length) return result;
  const downgraded = downgradeLevel(result.level, 1);
  if (downgraded === result.level) {
    return Object.assign(result, { qualityDowngraded: false, qualityFlagged: hits, reason: result.reason + "；含 high 质量标记证据但已是最低档" });
  }
  return Object.assign(result, {
    level: downgraded,
    qualityDowngraded: true,
    qualityFlagged: hits,
    reason: result.reason + "；因 high 质量标记（" + hits.join("、") + "）降一级：" + result.level + " → " + downgraded
  });
}

/** 独立证据去重：同一 aweme_id 只算一条；同一句话跨账号搬运只算一条。 */
export function dedupeEvidence(evidenceList) {
  const unique = [];
  const seenIds = new Set();
  const seenQuotes = new Set();
  (evidenceList || []).forEach((item) => {
    if (!item || typeof item.account !== "string" || typeof item.aweme_id !== "string") return;
    const quoteKey = normalizeQuote(item.quote);
    if (seenIds.has(item.aweme_id)) return;
    if (quoteKey && seenQuotes.has(quoteKey)) return;
    seenIds.add(item.aweme_id);
    if (quoteKey) seenQuotes.add(quoteKey);
    unique.push(item);
  });
  return unique;
}

export function classifyEvidence(evidenceList, independence, options) {
  const opts = options || {};
  const provisional = independence ? independence.provisional !== false : true;
  if (opts.advisory === true) {
    return { level: STRENGTH.ADVISORY, count: 0, rawCount: (evidenceList || []).length, groups: [], provisional, reason: "规则标注 advisory：只展示不执行" };
  }
  const unique = dedupeEvidence(evidenceList);
  if (!unique.length) {
    return { level: STRENGTH.ENGINEERING_DEFAULT, count: 0, rawCount: 0, groups: [], provisional, reason: "无语料证据（工程默认 / 基线占位）" };
  }
  const groups = [];
  unique.forEach((item) => {
    const group = accountGroup(item.account, independence);
    if (groups.indexOf(group) === -1) groups.push(group);
  });
  let level;
  if (unique.length >= 3 && groups.length >= 2) level = STRENGTH.VERIFIED;
  else if (unique.length >= 2 && groups.length >= 2) level = STRENGTH.CROSS_ACCOUNT;
  else level = STRENGTH.SINGLE_SOURCE;
  const reason = unique.length + " 条独立证据 · " + groups.length + " 个来源组"
    + (groups.length === 1 ? "（同源：重复表述 / 同场直播不算独立）" : "")
    + (provisional ? "（独立性数据未就绪，启发式判定）" : "");
  return applyQualityDowngrade({ level, count: unique.length, rawCount: (evidenceList || []).length, groups, provisional, reason }, unique, independence);
}

export function strengthOfDimension(dim, independence) {
  if (dim && dim._origin === "web-baseline") {
    return { level: STRENGTH.ENGINEERING_DEFAULT, count: 0, rawCount: 0, groups: [], provisional: true, reason: "演示基线维度：无语料依据，仅用于补缺" };
  }
  const result = classifyEvidence(dim ? dim.evidence : [], independence);
  return Object.assign(result, {
    method: "heuristic",
    provisional: true,
    reason: result.reason + "（维度未经 audit-rules 审计，启发式判定）"
  });
}

export function strengthOfRule(rule, independence) {
  if (rule && rule.advisory === true) {
    return { level: STRENGTH.ADVISORY, count: (rule.evidence || []).length, rawCount: (rule.evidence || []).length, groups: [], provisional: true, reason: "规则标注 advisory：只展示不执行" };
  }
  const audited = independence && independence.ruleStrength && rule ? independence.ruleStrength.get(String(rule.id)) : null;
  if (audited) {
    return applyQualityDowngrade({
      level: audited.level,
      count: audited.units,
      rawCount: audited.rawCount,
      groups: audited.accounts,
      provisional: false,
      method: "audit-rules",
      reason: "audit-rules：" + (audited.units === null ? "" : audited.units + " 个内容单元 · ") + audited.accounts.length + " 个有效账号"
        + (audited.templateLinked ? "（含模板同源去重）" : "")
        + (audited.reason ? "；降级说明：" + audited.reason : "")
    }, rule ? rule.evidence : [], independence);
  }
  const fallback = classifyEvidence(rule ? rule.evidence : [], independence);
  return Object.assign(fallback, {
    method: "heuristic",
    provisional: true,
    reason: fallback.reason + "（该规则不在 audit-rules 覆盖内，启发式判定）"
  });
}

/* ------------------------------------------------------------------ */
/* 断言级强度（claim-level）：evidence-independence.json 的               */
/*   claimLevelStrength（按规则索引，带 supportUnits）或 claimIndex（扁平） */
/*   supported-multi / single-source / unsupported                       */
/* ------------------------------------------------------------------ */

export const CLAIM_META = {
  "supported-multi": { label: "机构内多源支持", color: "green", description: "同一机构内 ≥2 个内容单元支撑该数字" },
  "single-source": { label: "机构内单源", color: "gray", description: "同一机构内仅 1 个内容单元" },
  unsupported: { label: "规则内无出处", color: "red", description: "该数字在规则引用的转写里找不到出处" }
};

export const CLAIM_WEAKEST_ORDER = { "supported-multi": 2, "single-source": 1, unsupported: 0 };

export function weakestClaimLevel(levels) {
  const list = (levels || []).filter((level) => CLAIM_WEAKEST_ORDER[level] !== undefined);
  if (!list.length) return null;
  return list.reduce((worst, level) => (CLAIM_WEAKEST_ORDER[level] < CLAIM_WEAKEST_ORDER[worst] ? level : worst), "supported-multi");
}

function normalizeClaimLevel(level) {
  const text = String(level || "");
  if (text === "supported-multi" || text === "supportedMulti") return "supported-multi";
  if (text === "single-source" || text === "singleSource") return "single-source";
  if (text === "unsupported") return "unsupported";
  return null;
}

function parseClaims(doc) {
  const byRule = new Map();
  let mode = null;
  if (doc && Array.isArray(doc.claimLevelStrength) && doc.claimLevelStrength.length) {
    mode = "claimLevelStrength";
    doc.claimLevelStrength.forEach((entry) => {
      if (!entry || !entry.ruleId) return;
      const claims = (entry.claims || []).map((claim) => ({
        ruleId: String(entry.ruleId),
        claim: claim.claim || "",
        level: normalizeClaimLevel(claim.status),
        supportUnits: typeof claim.supportUnits === "number" ? claim.supportUnits : null,
        accounts: claim.supportAccounts || [],
        evidence: (claim.supportingEvidence || []).map((item) => ({ account: item.account, aweme_id: item.aweme_id, snippet: item.snippet || "" }))
      })).filter((claim) => claim.level);
      if (claims.length) byRule.set(String(entry.ruleId), claims);
    });
  }
  if (!byRule.size && doc && doc.claimIndex && typeof doc.claimIndex === "object") {
    mode = "claimIndex";
    Object.keys(doc.claimIndex).forEach((ruleId) => {
      const claims = (doc.claimIndex[ruleId] || []).map((claim) => {
        const evidence = [];
        (claim.tokenAttribution || []).forEach((attribution) => {
          (attribution.evidence || []).forEach((item) => evidence.push({ account: item.account, aweme_id: item.aweme_id, snippet: item.snippet || "" }));
        });
        (claim.supportAccounts || []).forEach((account) => {
          if (!evidence.some((item) => item.account === account)) evidence.push({ account, aweme_id: null, snippet: "" });
        });
        return {
          ruleId: String(ruleId),
          claim: claim.claim || "",
          level: normalizeClaimLevel(claim.level),
          supportUnits: null,
          accounts: claim.supportAccounts || [],
          evidence
        };
      }).filter((claim) => claim.level);
      if (claims.length) byRule.set(String(ruleId), claims);
    });
  }
  return { byRule, mode };
}

export function claimsForRule(independence, ruleId) {
  const claims = independence && independence.claims;
  if (!claims || !claims.available || !claims.byRule) return [];
  return claims.byRule.get(String(ruleId)) || [];
}

/** 规则内的断言按文本里的数字 token 匹配；匹配不到就退回该规则的全部断言（取最弱）。 */
export function matchClaimsForText(claims, text) {
  const source = String(text || "");
  const matched = (claims || []).filter((claim) => {
    const token = claim.claim ? claim.claim.match(/[0-9]+(?:[.][0-9]+)?/g) : null;
    if (!token) return false;
    return token.some((num) => source.indexOf(num) !== -1);
  });
  return matched.length ? matched : (claims || []);
}

export function claimBadgeForRule(independence, ruleId, text) {
  const claims = claimsForRule(independence, ruleId);
  if (!claims.length) {
    return { available: false, fallback: true, level: null, label: "规则级标签（无断言级数据）", color: "gray", matched: [], totalClaims: 0 };
  }
  const matched = matchClaimsForText(claims, text);
  const weakest = weakestClaimLevel(matched.map((claim) => claim.level)) || matched[0].level;
  const meta = CLAIM_META[weakest] || { label: weakest, color: "gray", description: "" };
  return {
    available: true,
    fallback: false,
    level: weakest,
    label: meta.label,
    color: meta.color,
    description: meta.description,
    matched: matched.map((claim) => ({
      claim: claim.claim,
      level: claim.level,
      label: (CLAIM_META[claim.level] || {}).label || claim.level,
      color: (CLAIM_META[claim.level] || {}).color || "gray",
      supportUnits: claim.supportUnits,
      accounts: claim.accounts,
      evidence: claim.evidence
    })),
    totalClaims: claims.length
  };
}

export function normalizeLevel(level) {
  const text = String(level || "").trim();
  if (text === "verified") return STRENGTH.VERIFIED;
  if (text === "cross-account" || text === "crossAccount") return STRENGTH.CROSS_ACCOUNT;
  if (text === "single-source" || text === "singleSource") return STRENGTH.SINGLE_SOURCE;
  if (text === "extrapolated") return STRENGTH.EXTRAPOLATED;
  if (text === "engineering-default" || text === "engineeringDefault") return STRENGTH.ENGINEERING_DEFAULT;
  if (text === "advisory") return STRENGTH.ADVISORY;
  return null;
}

export function summarize(items) {
  const counts = { verified: 0, "cross-account": 0, "single-source": 0, extrapolated: 0, "engineering-default": 0, advisory: 0 };
  (items || []).forEach((item) => {
    const level = item && item.strength ? item.strength : item;
    if (counts[level] === undefined) counts[level] = 0;
    counts[level] += 1;
  });
  return counts;
}
