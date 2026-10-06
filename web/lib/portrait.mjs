import { evalCondition } from "./engine.mjs";
import { displayValue } from "./labels.mjs";

/* 「具象画像」构建层（结论文本来自语料，不编造）：
   - 输入：portrait-rules.json（条目表）+ 已算出的档位阶梯 + standards/rules/bands 原文；
   - 输出：self（你的定位）/ upper（能配上的）/ lower（保底的）/ missing（无法给出的维度）；
   - 每条 item 都带 sourceIds 与 evidence，前端折叠可查；筛选条件走与规则引擎相同的 DSL。 */

const TRIM_MAX = 64;

/* 展示层措辞中性化：语料原文里的「向下/向上兼容」这类词不在产品里露出；
   证据引文（quote）不走这里，保持原文可追溯。 */
export function neutralizeWording(text) {
  return String(text === undefined || text === null ? "" : text)
    .split("向下兼容").join("放宽一档")
    .split("向上兼容").join("提升一档")
    .split("向下找").join("放宽去找")
    .split("向下").join("放宽");
}

/* 语义类别（v1.3）：主语会被骗过去，语义不会。
   target-attribute=对方本人的条件；target-preference=对方/市场看重你什么；
   subject-requirements=对你自己的要求或建议；channel=去哪遇到这些人；none=缺口记录。 */
const CATEGORIES = new Set(["target-attribute", "target-preference", "subject-requirements", "channel", "none"]);
const CATEGORY_TEXT_RULES = {
  "target-attribute": { forbid: /看重你|要求你|你的|看男方|看女方|对男性的排序/, require: null },
  "target-preference": { forbid: null, require: /看|优先|首看|排序/ },
  "subject-requirements": { forbid: null, require: /要求|建议/ },
  "channel": { forbid: null, require: /活动|渠道|专场|池/ }
};
function assertCategoryText(item) {
  const rule = CATEGORY_TEXT_RULES[item.category];
  if (!rule) throw new Error("画像条目 category 非法：" + item.id + " → " + item.category);
  const text = item.text + " " + (item.fullText || "");
  if (rule.forbid && rule.forbid.test(text)) throw new Error("语义校验失败（target-attribute 含偏好/要求类词）：" + item.id + " → " + text.slice(0, 60));
  if (rule.require && !rule.require.test(text)) throw new Error("语义校验失败（" + item.category + " 必须含方向词）：" + item.id);
}
const GAP_REASONS = new Set(["missing-input", "corpus-no-basis"]);

/* 个体案例拦截（硬规则）：身高 / 体重 / 收入 / 年龄 / 学历 五类里命中 ≥3 类 → 直接抛错。
   理由：把某个真人的条件单摆进产品当「上限/保底」既不体面也不准；画像只能是区间 / 类型描述。 */
const BASE_CASE_CATEGORIES = [
  { label: "身高", pattern: /(1\s*米\s*\d|\d+\s*(cm|厘米|公分))/ },
  { label: "体重", pattern: /\d+\s*(斤|公斤|kg|KG)/ },
  { label: "收入", pattern: /(月入|月薪|年入|年薪|收入|税后)[^\d]{0,6}\d+/ },
  { label: "年龄", pattern: /(\d+\s*岁|\d{2}\s*后|\d{2}\s*[/／、]\s*\d{2}\s*年)/ },
  { label: "学历", pattern: /(本科|硕士|博士|大专|专升本)/ }
];
/* 扩展维度：条件单最容易漏的是「肤色/身材/相貌/性格/家庭结构/地域」。
   只对「对方条件 / 渠道」类条目启用；偏好类是排序/口径句，天然会枚举多个维度，用全维度会误伤。 */
const EXTENDED_CASE_CATEGORIES = BASE_CASE_CATEGORIES.concat([
  { label: "肤色", pattern: /(肤色|皮肤|白皙|白净|(^|[、，,；;：:\s])白([、，,；;。\s]|$))/ },
  { label: "身材", pattern: /(身材好|身材|体型|微胖|偏胖|胖|瘦)/ },
  { label: "相貌", pattern: /(颜值|长相|五官|好看|帅|漂亮)/ },
  { label: "性格/情绪", pattern: /(性格好|情绪稳定|温柔|脾气好)/ },
  { label: "家庭结构", pattern: /(独生|兄弟姐妹|弟弟|姐姐|哥哥|妹妹)/ },
  { label: "地域", pattern: /(本地人|土著|户口)/ }
]);
export function individualCaseCategories(text, options) {
  const list = options && options.extended === true ? EXTENDED_CASE_CATEGORIES : BASE_CASE_CATEGORIES;
  const source = String(text === undefined || text === null ? "" : text);
  return list.filter((item) => item.pattern.test(source)).map((item) => item.label);
}
export function assertPortraitTextAllowed(text, id, options) {
  const hit = individualCaseCategories(text, options);
  if (hit.length >= 3) throw new Error("画像条目含个体案例数字组合（" + hit.join("/") + "），已拒绝构建：" + id);
  return true;
}


function trimText(text, max) {
  const source = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
  if (source.length <= max) return source;
  const slice = source.slice(0, max);
  const cut = Math.max(
    slice.lastIndexOf("、"), slice.lastIndexOf("，"), slice.lastIndexOf("；"),
    slice.lastIndexOf("。"), slice.lastIndexOf("：")
  );
  return (cut > max * 0.5 ? slice.slice(0, cut) : slice) + "…";
}

function collectEvidence(list, usedFor) {
  const out = [];
  (list || []).forEach((item) => {
    if (!item || typeof item.aweme_id !== "string" || !/^[0-9]{15,}$/.test(item.aweme_id)) return;
    if (out.some((entry) => entry.aweme_id === item.aweme_id && entry.quote === item.quote)) return;
    out.push({ account: item.account, aweme_id: item.aweme_id, quote: item.quote, usedFor: usedFor });
  });
  return out.slice(0, 3);
}

/* 定位行要紧凑：枚举标签取括号前的短形（如「体制内（公务员 / 事业编）」→「体制内」）。 */
function shortLabel(field, value) {
  const label = displayValue(field, value);
  const cut = String(label).indexOf("（");
  return cut > 0 ? String(label).slice(0, cut) : label;
}

function buildSelfLine(input) {
  const form = input.form || {};
  const parts = [];
  if (form.age) parts.push(form.age + " 岁");
  if (form.height_cm) parts.push(form.height_cm + "cm");
  if (form.education) parts.push(displayValue("education", form.education));
  if (form.occupation) parts.push(shortLabel("occupation", form.occupation));
  if (typeof form.income_wan === "number") parts.push("年入 " + form.income_wan + " 万");
  if (form.has_house) parts.push(displayValue("has_house", form.has_house));
  const matchedBand = (input.ladder || []).find((row) => row.matchStatus === "matched" && row.bandType && !row.referenceOnly);
  /* 去重：档位名里已经带了资产档（如「A7 资产档」）时，不再重复写「家庭资产 A7 档」。 */
  const wealthLabel = form.family_wealth ? shortLabel("family_wealth", form.family_wealth) : "";
  const wealthDuplicated = matchedBand && matchedBand.id.indexOf("asset.") === 0 && wealthLabel && String(matchedBand.name).indexOf(wealthLabel) === 0;
  if (form.family_wealth && !wealthDuplicated) parts.push("家庭资产 " + wealthLabel + " 档");
  if (input.appearance && typeof input.appearance.low === "number" && typeof input.appearance.high === "number") {
    parts.push("颜值 " + input.appearance.low + "–" + input.appearance.high + (input.appearanceLabel ? "（" + input.appearanceLabel + "）" : ""));
  }
  if (form.self_rank_position) parts.push("打分局第 " + form.self_rank_position + " 名" + (form.self_rank_pool ? "（" + form.self_rank_pool + " 人池）" : ""));
  if (form.activity_type) parts.push(shortLabel("activity_type", form.activity_type));
  if (form.city) {
    const tier = input.cityTier === 1 ? "一线" : (input.cityTier === 2 ? "二线" : "三线及以下");
    parts.push(tier + "（" + form.city + "）");
  }
  if (matchedBand) parts.push("档位 " + matchedBand.name);
  return parts.join(" · ");
}

export function buildPortrait(options) {
  const doc = options.doc || {};
  const form = options.form || {};
  const facts = options.facts || {};
  const ladder = options.ladder || [];
  const standardById = new Map((options.standards || []).map((item) => [item.id, item]));
  const ruleById = new Map((((options.ruleset || {}).rules) || []).map((item) => [item.id, item]));
  const bandById = new Map((options.ruleset && options.ruleset.bands ? options.ruleset.bands : []).map((item) => [item.id, item]));
  const upper = [];
  const lower = [];
  const missingReasons = new Map();
  const gaps = new Map();
  const channels = [];
  const preferences = [];
  /* 按语义类别路由：只有 target-attribute 进「能配上的/保底的」；channel 与 preference 各自分节。 */
  const push = (rule, item) => {
    assertPortraitTextAllowed(item.text, item.id, { extended: rule.category === "target-attribute" || rule.category === "channel" });
    const section = rule.category === "target-attribute"
      ? (rule.side === "lower" ? "attribute-lower" : "attribute-upper")
      : (rule.category === "channel" ? "channel" : "preference");
    const enriched = Object.assign({}, item, { section: section });
    assertCategoryText(enriched);
    if (section === "attribute-upper") upper.push(enriched);
    else if (section === "attribute-lower") lower.push(enriched);
    else if (section === "channel") channels.push(enriched);
    else preferences.push(enriched);
  };

  (doc.items || []).forEach((rule) => {
    /* 语义校验：每条必须声明合法类别；非 none 的条目按类别路由，none 只作缺口记录。 */
    if (!CATEGORIES.has(rule.category)) throw new Error("画像条目缺少合法的 category（target-attribute|target-preference|subject-requirements|channel|none）：" + rule.id);
    if (rule.gap) {
      if (!GAP_REASONS.has(rule.gap.reason)) throw new Error("缺口条目 reason 非法：" + rule.id);
      gaps.set(rule.dimension, rule.gap);
      return;
    }
    if (rule.category === "none") return;
    if (rule.when !== undefined && rule.when !== null) {
      let matched = false;
      try { matched = evalCondition(rule.when, facts); } catch { matched = false; }
      if (!matched) return;
    }
    if (rule.bandType) {
      const matchedRow = ladder.find((row) => row.bandType === rule.bandType && row.matchStatus === "matched" && !row.referenceOnly);
      if (matchedRow) {
        const band = bandById.get(matchedRow.id) || {};
        const texts = [];
        (rule.fields || []).forEach((field) => {
          const raw = field === "reachableMatch"
            ? matchedRow.reachableMatch
            : (matchedRow.targetProfile ? matchedRow.targetProfile[field] : null);
          const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
          list.forEach((text) => { if (text && texts.length < (rule.maxItems || 2)) texts.push(text); });
        });
        const evidence = collectEvidence((band.evidence || []).concat(band.targetProfileEvidence || []), "portrait:" + rule.id);
        texts.forEach((text, index) => {
          push(rule, {
            id: rule.id + "-" + (index + 1),
            side: rule.side,
            category: rule.category,
            dimension: rule.dimension,
            text: trimText(neutralizeWording(text), TRIM_MAX),
            fullText: neutralizeWording(text),
            sourceLabel: String(rule.sourceLabel || "依据：{bandName}（语料档位）").split("{bandName}").join(matchedRow.name || matchedRow.id),
            sourceIds: [matchedRow.id],
            evidence: evidence
          });
        });
        return;
      }
      const blocked = ladder.find((row) => row.bandType === rule.bandType && row.matchStatus === "input-missing");
      if (blocked) missingReasons.set(rule.dimension, "缺输入（" + (blocked.needsField || "对应表单字段") + "）");
      return;
    }
    if (rule.standard) {
      const standard = standardById.get(rule.standard);
      if (!standard) return;
      push(rule, {
        id: rule.id,
        side: rule.side,
        category: rule.category,
        dimension: rule.dimension,
        text: trimText(rule.display || standard.meaning, TRIM_MAX),
        fullText: rule.display || standard.meaning,
        sourceLabel: rule.sourceLabel || ("依据：" + standard.condition + "（语料）"),
        sourceIds: [standard.id].concat(rule.rules || []),
        evidence: collectEvidence(standard.evidence, "portrait:" + rule.id)
      });
      return;
    }
    if ((rule.rules || []).length && !rule.standard && !rule.band && !rule.bandType) {
      /* 只引用规则（无 standard / band）：文本用 display，证据取自规则本身。 */
      /* 裁剪过的规则集（测试/局部场景）里可能查不到源：文本仍来自配置，证据可缺；
         配置里写错 id 的情况由 profile-portrait 测试（全量规则集下证据必须 ≥1）与覆盖率工具兜底。 */
      const sources = rule.rules.map((id) => ruleById.get(id)).filter(Boolean);
      push(rule, {
        id: rule.id,
        side: rule.side,
        category: rule.category,
        dimension: rule.dimension,
        text: trimText(rule.display || sources[0].then && sources[0].then.text, TRIM_MAX),
        fullText: rule.display || "",
        sourceLabel: rule.sourceLabel || "依据：语料规则",
        sourceIds: rule.rules.slice(),
        evidence: collectEvidence(sources.reduce((acc, item) => acc.concat(item.evidence || []), []), "portrait:" + rule.id)
      });
      return;
    }
    if (rule.band) {
      const band = bandById.get(rule.band);
      if (!band) return;
      push(rule, {
        id: rule.id,
        side: rule.side,
        category: rule.category,
        dimension: rule.dimension,
        text: trimText(rule.display || band.reachableMatch || band.targetProfile.summary, TRIM_MAX),
        fullText: (rule.display || "") + (band.reachableMatch ? "｜档位口径：" + band.reachableMatch : ""),
        sourceLabel: rule.sourceLabel || ("依据：" + band.name + "（语料）"),
        sourceIds: [band.id],
        evidence: collectEvidence((band.evidence || []).concat(band.targetProfileEvidence || []), "portrait:" + rule.id)
      });
    }
  });

  /* 缺口覆盖只看「对方条件」与渠道；偏好（对你/市场）不算对方条件的覆盖。 */
  const covered = new Set(upper.concat(lower, channels).map((item) => item.dimension));
  const missing = (doc.dimensions || [])
    .filter((dimension) => !covered.has(dimension))
    .map((dimension) => {
      const gap = gaps.get(dimension);
      if (gap) return { dimension: dimension, reason: gap.reason, detail: gap.detail, unlockFields: gap.unlockFields || [] };
      const fromBand = missingReasons.get(dimension);
      return { dimension: dimension, reason: "missing-input", detail: fromBand || "缺输入或语料没有对应口径" };
    });

  return {
    self: buildSelfLine({ form: form, cityTier: options.cityTier, ladder: ladder, appearance: options.appearance, appearanceLabel: options.appearanceLabel }),
    upper: upper,
    lower: lower,
    channels: channels,
    preferences: preferences,
    missing: missing
  };
}
