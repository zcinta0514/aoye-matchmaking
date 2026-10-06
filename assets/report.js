const TOKEN_KEY = "aoye_access_token";

/* 展示层措辞中性化：语料原文里的「向下/向上兼容」不直接露给用户；证据引文保持原文。 */
function neutralizeWording(text) {
  return String(text === undefined || text === null ? "" : text)
    .split("向下兼容").join("放宽一档")
    .split("向上兼容").join("提升一档")
    .split("向下找").join("放宽去找")
    .split("向下").join("放宽");
}

function getToken() {
  try { return window.localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function setToken(value) {
  try { window.localStorage.setItem(TOKEN_KEY, value); } catch { /* 忽略 */ }
}

function esc(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tag(origin) {
  if (origin === "knowledge") return "<span class='tag tag-knowledge'>知识库</span>";
  return "<span class='tag tag-baseline'>演示基线（未取证）</span>";
}

const STRENGTH_COLORS = { verified: "green", "cross-account": "blue", "single-source": "gray", extrapolated: "yellow", "engineering-default": "red", advisory: "purple" };
const STRENGTH_LABELS = { verified: "机构内多源一致", "cross-account": "机构内 2 源一致", "single-source": "机构内单源", extrapolated: "外推参考", "engineering-default": "工程默认", advisory: "体系参考" };

function badge(strength, label, provisional) {
  const color = STRENGTH_COLORS[strength] || "gray";
  return "<span class='str str-" + color + "'>" + esc(label || STRENGTH_LABELS[strength] || strength || "—") + (provisional ? "*" : "") + "</span>";
}

const BASIS_VISIBLE = { verified: true, "cross-account": true, unsupported: true, "engineering-default": true, extrapolated: true, advisory: true, "single-source": false };
const LABEL_TO_LEVEL = { "机构内多源一致": "verified", "机构内 2 源一致": "cross-account", "机构内单源": "single-source", "单条语料": "single-source", "外推参考": "extrapolated", "工程默认": "engineering-default", "体系参考": "advisory" };

function levelFromLabel(label) { return LABEL_TO_LEVEL[label] || "single-source"; }
function isVisibleStrength(level) { return BASIS_VISIBLE[level] !== false; }

function strengthMark(level, label, provisional) {
  const inner = badge(level, label, provisional);
  if (isVisibleStrength(level)) return inner;
  return "<details class='basis-details'><summary></summary>" + inner + "</details>";
}

function claimMark(item) {
  const claim = item.claimBadge;
  if (claim && claim.available) {
    const inner = badge(claim.color, claim.label) + claimDetails(item);
    if (claim.level === "single-source") return "<details class='basis-details'><summary></summary>" + inner + "</details>";
    return inner;
  }
  return strengthMark(levelFromLabel(item.ruleStrengthLabel), item.ruleStrengthLabel);
}
function fmt(value, digits) {
  if (typeof value !== "number") return "—";
  const factor = 10 ** (digits === undefined ? 1 : digits);
  const rounded = Math.round(value * factor) / factor;
  let text = String(rounded);
  if (text.indexOf(".") !== -1) {
    while (text.endsWith("0")) text = text.slice(0, -1);
    if (text.endsWith(".")) text = text.slice(0, -1);
  }
  return text;
}

function reportId() {
  const fromPath = window.location.pathname.match(new RegExp("^/r/([A-Za-z0-9_-]+)$"));
  if (fromPath) return fromPath[1];
  return new URLSearchParams(window.location.search).get("id");
}

function scoreCard(key, value, sub, strength, label, provisional) {
  return "<div class='score-card'><div class='k'>" + esc(key) + "</div><div class='v'>" + value + (strength ? badge(strength, label, provisional) : "") + "</div><div class='s'>" + esc(sub || "") + "</div></div>";
}

function renderBreakdown(items) {
  const strong = items.filter((item) => item.strength === "verified" || item.strength === "cross-account").length;
  const rows = items.map((item) => {
    const evidence = (item.evidence || []).map((entry) => esc(entry.account) + "/" + esc(entry.aweme_id)).join("、");
    const detail = badge(item.strength, item.strengthLabel, item.strengthProvisional)
      + (item.weightSource === "engineering" ? " <span class='tag tag-nonevidence'>权重工程默认</span>" : "")
      + (item.evidenceNote ? "<div class='caveat'>" + esc(item.evidenceNote) + "</div>" : "")
      + (evidence ? "<div class='muted'>证据：" + evidence + "</div>" : "");
    const cell = (item.strength === "verified" || item.strength === "cross-account")
      ? badge(item.strength, item.strengthLabel, item.strengthProvisional)
      : "<details class='basis-details'><summary></summary>" + detail + "</details>";
    return "<tr><td>" + esc(item.name) + "</td><td>" + esc(item.inputText === undefined ? "—" : item.inputText) + "</td><td>"
      + (typeof item.score === "number" ? fmt(item.score) : esc(item.note || "—")) + "</td><td>" + cell + "</td></tr>";
  }).join("");
  const summary = "<p class='conf-line'>本表 " + items.length + " 项：" + strong + " 项机构内一致（绿/蓝标直接可见），"
    + (items.length - strong) + " 项仅供参考（单源 / 工程默认 / 外推）——行尾「依据」展开可看强度、权重来源与出处。</p>";
  return summary + "<table><thead><tr><th>维度</th><th>你的填写</th><th>得分</th><th>依据</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

function claimBadge(item) {
  const claim = item && item.claimBadge;
  if (claim && claim.available) {
    return "<span class='str str-" + (claim.color || "gray") + "'>" + esc(claim.label) + "</span>";
  }
  return "<span class='str str-" + (item.ruleStrengthColor || "gray") + "'>" + esc(item.ruleStrengthLabel || "规则级标签") + "</span><span class='tag tag-muted'>规则级</span>";
}

function claimDetails(item) {
  const claim = item && item.claimBadge;
  if (!claim || !claim.available || !claim.matched.length) return "";
  return "<details class='claim-details'><summary>断言明细（" + claim.matched.length + "/" + claim.totalClaims + "）</summary><ul>" +
    claim.matched.map((c) => "<li>" + esc(c.claim) + "　<span class='str str-" + (c.color || "gray") + "'>" + esc(c.label) + "</span>" + (c.supportUnits ? "　" + c.supportUnits + " 个内容单元" : "") + "</li>").join("") +
    "</ul></details>";
}

function claimSummaryLine(summary) {
  if (!summary || !summary.total) return "";
  const parts = [];
  if (summary.supportedMulti) parts.push(summary.supportedMulti + " 条多源支持");
  if (summary.singleSource) parts.push(summary.singleSource + " 条单源未验证");
  if (summary.unsupported) parts.push(summary.unsupported + " 条规则内无出处");
  if (summary.ruleLevelFallback) parts.push(summary.ruleLevelFallback + " 条仅规则级标签");
  return "<p class='conf-line'>本报告 " + summary.total + " 条建议 / 放弃项中：" + parts.join("、") + "。" + (summary.provisional ? "（断言级数据未就绪，已退回规则级）" : "") + "</p>";
}
function render(report) {
  const appearance = report.appearance;
  const final = appearance.final || { low: null, high: null, mid: null };
  const photo = appearance.photoTrack || {};
  const mapped = photo.mappedInterval;
  const self = appearance.selfTrack || {};
  const conf = report.confidence || {};
  const summary = report.evidenceSummary || {};
  const byStrength = (conf.summary && conf.summary.byStrength) || {};
  const extrapolation = conf.extrapolation || {};
  const strongCount = (byStrength.verified || 0) + (byStrength["cross-account"] || 0);
  const refCount = (byStrength["single-source"] || 0) + (byStrength.extrapolated || 0) + (byStrength["engineering-default"] || 0);

  const hardwareRef = report.hardware.referenceScore !== null && report.hardware.referenceScore !== undefined && report.hardware.referenceScore !== report.hardware.score
    ? "　全量参考 " + fmt(report.hardware.referenceScore)
    : "";
  const softRef = report.soft.referenceScore !== null && report.soft.referenceScore !== undefined && report.soft.referenceScore !== report.soft.score
    ? "　全量参考 " + fmt(report.soft.referenceScore)
    : "";
  const hardwareCounted = (report.hardware.breakdown || []).filter((item) => item.countableForLevel).length;
  const softCounted = (report.soft.breakdown || []).filter((item) => item.countableForLevel).length;
  const bandInfo = report.portrait.band || null;
  const bandCell = bandInfo
    ? (esc(bandInfo.name) + (bandInfo.engineeringDefault ? " " + badge("engineering-default") : ""))
    : "—";
  const bandSub = bandInfo && bandInfo.engineeringDefault
    ? "档位刻度无语料依据（工程默认），不作为结论"
    : (report.portrait.bandSource || "");
  const hw = report.hardware || {};
  const hwComposite = hw.composite || null;
  const hwBasisBadge = hw.basis === "corpus-composite"
    ? badge(hw.basisStrength, hw.basisStrengthLabel)
    : badge("engineering-default", "工程默认");
  const hwSub = (hw.basisLabel || "") + "　计入 " + hardwareCounted + " 项　家庭分 " + fmt(hw.familyScore) + hardwareRef;
  const compositeCard = hwComposite && hwComposite.available
    ? "" +
      "<p class='muted'>" + esc(hwComposite.name || "") + "　" + badge(hw.basisStrength, hw.basisStrengthLabel) +
      "　原分 " + fmt(hwComposite.raw) + "/" + fmt(hwComposite.rawMax) + " → 归一化 " + fmt(hwComposite.normalized) + " → 1–9 标尺 " + fmt(hwComposite.scaleScore) + "（" + esc(hwComposite.scaleLabel || "") + "）</p>" +
      "<table><thead><tr><th>项</th><th>语料条件</th><th>是否达标</th><th>得分</th></tr></thead><tbody>" +
      (hwComposite.items || []).map((item) =>
        "<tr><td>" + esc(item.label) + "</td><td>" + esc(item.criterion) + (item.approximation ? "　<span class='tag tag-muted'>" + esc(item.approximation) + "</span>" : "") +
        "</td><td>" + (item.computable ? (item.hit ? "✅" + (item.bonusHit ? "（含加成）" : "") : "—") : "<span class='tag tag-nonevidence'>表单缺字段</span>") +
        "</td><td>" + fmt(item.points) + " / " + fmt(item.maxPoints) + "</td></tr>").join("") +
      "</tbody></table>" +
      (hwComposite.mapping && hwComposite.mapping.disclosure ? "<p class='muted'>" + esc(hwComposite.mapping.disclosure) + "</p>" : "") +
      ((hwComposite.gaps || []).length ? "<p class='caveat-warning'>表单缺口：" + hwComposite.gaps.map((gap) => esc(gap.needField || gap.item)).join("、") + "（暂不计分，归一化分母按 " + fmt(hwComposite.rawMax) + " 计）</p>" : "") +
      ""
    : "";
  const behavior = report.behaviorCheck || null;
  const behaviorCard = behavior
    ? "" +
      "<p class='muted'>" + esc(behavior.name) + "　" + badge(behavior.strength, behavior.strengthLabel) + "　" + esc(behavior.note || "") + "</p>" +
      "<p>" + esc(behavior.description || "") + "</p>" +
      "<table><thead><tr><th>档位</th><th>分数区间</th><th>可观察</th></tr></thead><tbody>" +
      (behavior.anchors || []).map((anchor) => "<tr><td>" + esc(anchor.label) + "</td><td>" + fmt(anchor.min) + "–" + fmt(anchor.max) + "</td><td>" + esc((anchor.observable || []).join("；")) + "</td></tr>").join("") +
      "</tbody></table>" +
      "<p class='muted'>证据：" + (behavior.evidence || []).map((item) => esc(item.account) + "/" + esc(item.aweme_id)).join("、") + "</p>"
    : "";

  const cards = [
    scoreCard(
      "颜值分（规则映射区间）",
      appearance.final ? (fmt(final.low) + " – " + fmt(final.high)) : "未提供",
      appearance.final ? ((appearance.finalLabel || "无锚点命中") + "　依据：" + (appearance.basisLabel || appearance.basis || "—")) : "未填颜值自评（或数值越界）：不按 0 分计算",
      appearance.strength, appearance.strengthLabel, appearance.strengthProvisional
    ),
    scoreCard("硬件分", fmt(hw.score) + (hw.basis === "corpus-composite" ? "（语料表）" : ""), hwSub, "computed", hw.basisLabel || "计入项加权"),
    scoreCard("软性分", fmt(report.soft.score), (report.soft.label || "") + "　计入 " + softCounted + " 项" + softRef, "computed", "计入项加权"),
    scoreCard(
      "综合水平 / 梯队",
      fmt(report.level) + "　" + bandCell,
      "全量参考 " + fmt(report.levelIfAllCounted) + "　" + bandSub +
        (hw.basis === "corpus-composite" ? "　硬件槽位：语料十项表（定义型单源）" : ""),
      "computed", "仅计入机构内一致项", conf.independence && conf.independence.provisional
    )
  ].join("");

  const extrapolationBanner = extrapolation.active
    ? "<div class='card extrapolation-card'><p><strong>外推说明</strong>：" + (extrapolation.applied || []).map((item) => "⚠ " + esc(item.message)).join(" ") + "</p></div>"
    : "";

  const giveUps = (report.giveUps || []).map((item) => "<li>" + esc(item.displayText || item.text) + tag(item.origin) + claimMark(item) + "</li>").join("")
    || "<li class='muted'>按当前条件没有触发『该放弃的幻想项』规则。</li>";
  const advice = (report.advice || []).map((item) => "<li>" + esc(item.displayText || item.text) + tag(item.origin) + claimMark(item) + "</li>").join("")
    || "<li class='muted'>无额外建议。</li>";

  const excluded = (report.excludedItems || []).map((item) =>
    "<tr><td>" + esc(item.name) + "</td><td>" + fmt(item.score) + "</td><td>" + badge(item.strength, item.strengthLabel) + "</td><td>" + esc(item.reason) + "</td></tr>"
  ).join("") || "<tr><td colspan='4' class='muted'>没有因证据不足被排除的计分项。</td></tr>";

  const photoDims = (photo.dimensions || []).map((dim) =>
    "<tr><td>" + esc(dim.name) + "</td><td>" + esc(dim.observed || dim.note || "未分析") + "</td><td>" + esc(dim.levelLabel || "—") + "</td><td>" + esc(dim.confidenceLabel || "—") + "</td></tr>"
  ).join("") || "<tr><td colspan='4' class='muted'>未启用照片分析。</td></tr>";
  const anchorFits = (photo.anchorFits || []).map((fit) =>
    "<tr><td>" + esc(fit.label) + "</td><td>" + fmt(fit.fit, 2) + "</td><td>" + esc(fit.reason) + "</td></tr>"
  ).join("");
  const photoAnalyzed = (photo.dimensions || []).some((dim) => dim.observed);
  /* 照片区只做展示减法：默认 3 行摘要；18 维表 / 全部 caveats / 全部质量提示折进同一个折叠区，一行不删。 */
  const photoJudged = (photo.dimensions || []).filter((dim) => dim.observed && (dim.confidence === "high" || dim.confidence === "medium"));
  const photoUndecided = (photo.dimensions || []).filter((dim) => photoJudged.indexOf(dim) === -1);
  const photoIssues = (photo.dataQuality && Array.isArray(photo.dataQuality.issues) ? photo.dataQuality.issues : []).filter(Boolean);
  const photoCaveatList = photo.caveats || [];
  /* 6+ 条质量提示归约成一句人话：按关键词归纳，归纳不出来就不展开细节（细节在折叠区里）。 */
  const condensePhotoIssues = (issues) => {
    const rules = [
      [/侧脸|侧视|侧面/, "缺侧脸视角"],
      [/全身|下肢|腰部|下身|腿|半身/, "缺全身视角"],
      [/光/, "光照不均"],
      [/遮挡|遮/, "有遮挡"],
      [/修图|美颜|滤镜|修饰/, "疑似有修饰"],
      [/角度|机位|姿势|坐姿|前倾/, "机位角度单一"],
      [/截断|裁剪|取景|边缘|出画/, "取景不完整"],
      [/单张|一张|仅一/, "只有一张照片"],
      [/背景|环境/, "背景信息少"],
      [/清晰|分辨率|模糊|像素/, "清晰度有限"]
    ];
    const hits = [];
    issues.forEach((issue) => {
      const hit = rules.find((item) => item[0].test(String(issue)));
      if (hit && hits.indexOf(hit[1]) === -1) hits.push(hit[1]);
    });
    if (!hits.length) return "照片条件有限（" + issues.length + " 条提示，展开可看明细）";
    return hits.slice(0, 3).join("；");
  };
  /* 摘要只写「看出来的部分」：观察文本里夹带的「无法判断 / 未知」半句留在折叠明细里，不进摘要。 */
  const NEGATIVE_CLAUSE = /无法判断|不可见|未入镜|截断|未知|不明|受限|看不到|难确认|难以确认/;
  const positiveClauses = (text) => String(text || "").split(/[；;。]/).map((part) => part.trim()).filter((part) => part && !NEGATIVE_CLAUSE.test(part)).join("；");
  const photoHeadlineSorted = photoJudged
    .map((dim) => ({ dim, text: positiveClauses(dim.observed) }))
    .filter((item) => item.text)
    .sort((a, b) => (b.dim.confidence === "high" ? 1 : 0) - (a.dim.confidence === "high" ? 1 : 0));
  const photoHeadline = photoHeadlineSorted.length
    ? "照片能看出来：" + photoHeadlineSorted.slice(0, 3).map((item) => esc(item.dim.name) + "：" + esc(item.text.replace(/。+$/, ""))).join("；") + "。"
    : "照片能看出来：本次照片里可明确判定的项不多。";
  const photoUndecidedLine = photoUndecided.length
    ? "<div class='muted'>另有 " + photoUndecided.length + " 项因角度或光线所限，本次不作判断：<details class='inline-details'><summary>展开查看</summary><ul>" + photoUndecided.map((dim) => "<li>" + esc(dim.name) + "：" + esc(dim.observed || dim.note || "无描述") + "</li>").join("") + "</ul></details></div>"
    : "";
  const photoQualityLine = photoIssues.length ? "<p class='muted'>照片质量提醒：" + esc(condensePhotoIssues(photoIssues)) + "</p>" : "";
  const photoDetailFold = "<details class='section-details photo-detail'><summary>照片能看到什么、看不到什么</summary>" +
    "<h4>逐项描述（" + (photo.dimensions || []).length + " 项，模型只描述不打分）</h4>" +
    "<table><thead><tr><th>维度</th><th>可观察描述</th><th>描述倾向</th><th>描述置信度</th></tr></thead><tbody>" + photoDims + "</tbody></table>" +
    (anchorFits ? "<h4>锚点符合度（规则映射依据）</h4><table><thead><tr><th>锚点</th><th>fit</th><th>依据</th></tr></thead><tbody>" + anchorFits + "</tbody></table>" : "") +
    (photoCaveatList.length ? "<h4>需要说明的局限（" + photoCaveatList.length + " 条）</h4><ul>" + photoCaveatList.map((text) => "<li>" + esc(text) + "</li>").join("") + "</ul>" : "") +
    (photoIssues.length ? "<h4>照片质量提示（" + photoIssues.length + " 条）</h4><ul>" + photoIssues.map((text) => "<li>" + esc(text) + "</li>").join("") + "</ul>" : "") +
    "</details>";
  const photoSkipReason = photo.mode === "error"
    ? "本次未做照片分析：照片分析调用失败，已降级为纯表单模式。"
    : (/未上传照片/.test(photo.reason || "") ? "本次未做照片分析。上传照片可启用照片维度描述。" : "本次未做照片分析。");
  const photoSummaryLine = "<p class='muted'>" + esc(photoSkipReason) + "</p>";

  const window = report.matchWindow || {};
  const windowHtml = report.matchWindow ? [
    "<tr><td>可达上限</td><td>" + fmt(window.upper.score) + "</td><td>" + esc(window.upper.bandName || "—") + "</td><td>" + esc(window.upper.note) + "</td></tr>",
    "<tr><td>稳妥区间</td><td>" + fmt(window.stable.low) + " – " + fmt(window.stable.high) + "</td><td>" + esc(window.stable.bandLow || "") + " ～ " + esc(window.stable.bandHigh || "") + "</td><td>" + esc(window.stable.note) + "</td></tr>",
    "<tr><td>需要妥协的下限</td><td>" + fmt(window.lower.score) + "</td><td>" + esc(window.lower.bandName || "—") + "</td><td>" + esc(window.lower.note) + "</td></tr>"
  ].join("") : "<tr><td colspan='4' class='muted'>证据不足，不输出择偶窗口。</td></tr>";

  const improvements = (report.improvements || []).map((item) =>
    "<li><strong>" + esc(item.name) + "</strong>（当前 " + fmt(item.currentScore) + "）" + tag(item.origin) +
    "<ul>" + item.actions.map((action) => "<li>" + esc(action) + "</li>").join("") + "</ul></li>"
  ).join("") || "<li class='muted'>无。</li>";

  const evidence = (report.evidenceIndex || []).map((item) =>
    "<tr><td>" + esc(item.account) + "</td><td>" + esc(item.aweme_id) + "</td><td>" + badge(item.setStrength) + "</td><td>" + esc(item.usedFor) + "</td></tr>" +
    "<tr><td colspan='4'><blockquote>" + esc(item.quote) + "</blockquote></td></tr>"
  ).join("") || "<tr><td colspan='4' class='muted'>本次没有引用知识库证据。</td></tr>";

  const rulesApplied = (report.rulesApplied || []).map((rule) =>
    "<tr><td>" + esc(rule.ruleId) + "</td><td>" + esc(rule.title) + "</td><td>" + esc(rule.scopeLabel || rule.scope) + "</td><td>" + esc(rule.viaLabel || rule.via) + "</td><td>" + strengthMark(levelFromLabel(rule.strength), rule.strength, rule.strengthProvisional) + "</td></tr>"
  ).join("") || "<tr><td colspan='5' class='muted'>本次没有规则命中。</td></tr>";

  const advisory = (report.advisoryRules || []).map((rule) =>
    "<li><strong>" + esc(rule.ruleId) + "</strong>　" + esc(rule.title) + tag(rule.origin) + badge("advisory") +
    "<div class='ref-when'>条件：" + esc(rule.when) + "</div><div class='ref-then'>结论：" + esc(rule.then) + "</div>" +
    (rule.evidence.length ? "<div class='muted'>证据：" + rule.evidence.map((entry) => esc(entry.account) + "/" + esc(entry.aweme_id)).join("、") + "</div>" : "<div class='muted'>无语料证据</div>") +
    "</li>"
  ).join("") || "<li class='muted'>无。</li>";
  const unstructured = (report.unstructuredRules || []).map((rule) =>
    "<li><strong>" + esc(rule.ruleId) + "</strong>　" + esc(rule.title) + "<div class='ref-when'>条件：" + esc(rule.when) + "</div><div class='ref-then'>结论：" + esc(rule.then) + "</div></li>"
  ).join("") || "<li class='muted'>无。</li>";
  const flags = (report.flags || []).map((item) => "<li>" + esc(item.text) + tag(item.origin) + "</li>").join("");
  const requirements = (report.evidenceRequirements || []).map((item) =>
    "<li>" + esc(item.text) + (item.satisfied ? " <span class='tag tag-knowledge'>证据已附</span>" : " <span class='tag tag-nonevidence'>规则自身无语料证据</span>") + "</li>"
  ).join("");
  const ruleErrors = (report.ruleErrors || []).map((item) => "<li>" + esc(item.ruleId) + "：" + esc(item.message) + "</li>").join("");
  const bandStatus = { "matched": "✅ 命中", "not-matched": "—" };
  const ladderRows = (report.portrait.ladder || []).filter((item) => !item.referenceOnly);
  const referenceRows = (report.portrait.ladder || []).filter((item) => item.referenceOnly);
  /* 同一句「活动口径」在渠道类档位里重复出现：抽出来统一声明一次，避免每行都挂一遍。 */
  const sharedNotice = { channel: 0 };
  const stripChannelNotice = (text) => {
    const source = String(text === undefined || text === null ? "" : text);
    const match = source.match(/（[^（）]*仅代表该主办方[^（）]*）\s*$/);
    if (!match) return source;
    sharedNotice.channel++;
    return source.slice(0, match.index).trim();
  };
  const evaluableRows = ladderRows.filter((item) => item.matchStatus !== "input-missing");
  const missingRows = ladderRows.filter((item) => item.matchStatus === "input-missing");
  const ladder = evaluableRows.map((item) =>
    "<tr class='" + (item.active ? "row-active" : "") + "'><td>" + (item.active ? "▶ " : "") + esc(item.name) + tag(item.origin) + strengthMark(item.strength) + "</td><td>" + esc(neutralizeWording(stripChannelNotice(item.definition))) + "</td><td>" + esc(neutralizeWording((item.entryCriteria || []).join("；"))) + "</td><td>" + esc(neutralizeWording(item.reachableMatch || "—")) + "</td><td>" + esc(bandStatus[item.matchStatus] || (item.matchStatus === null ? "—" : item.matchStatus)) + "</td></tr>"
  ).join("") || "<tr><td colspan='5' class='muted'>无语料档位可映射。</td></tr>";
  const ladderFootnotes =
    (missingRows.length ? "<div class='muted'>另有 " + missingRows.length + " 档因你未提供相关输入而未评估：<details class='inline-details'><summary>展开查看</summary><ul>" + missingRows.map((item) => "<li>" + esc(item.name) + "：需要「" + esc(item.needsField || "—") + "」</li>").join("") + "</ul></details></div>" : "") +
    (sharedNotice.channel ? "<p class='muted'>标注“机构活动”的档位只代表该主办方 / 该场活动的口径，不外推为市场普遍门槛。</p>" : "");
  const referenceScale = referenceRows.map((item) => "<tr><td>" + esc(item.name) + badge("engineering-default") + "</td><td>" + esc(item.definition || "—") + "</td><td>" + esc(JSON.stringify(item.range || item.level || "—")) + "</td></tr>").join("");
  const caveats = (report.caveats || []).map((item) => "<li" + (item.level === "warning" ? " class='caveat-warning'" : "") + ">" + esc(item.text) + "</li>").join("");
  const selfReasons = (self.reasons || []).map((reason) => "<li>" + esc(reason) + "</li>").join("");
  const clamps = (appearance.clampsApplied || []).map((item) => esc(item.ruleId) + "（" + esc(item.action) + "）").join("、");
  const pendingExtrapolation = (extrapolation.pending || []).map((item) => "<li>" + esc(item.label) + "：缺少表单字段（" + esc(item.needField || "—") + "）</li>").join("");

  const hero = report.summary || {};
  const heroUpper = hero.upper === undefined ? (report.matchWindow ? report.matchWindow.upper.score : null) : hero.upper;
  const heroLower = hero.lower === undefined ? (report.matchWindow ? report.matchWindow.lower.score : null) : hero.lower;
  const heroStable = hero.stable || (report.matchWindow ? { low: report.matchWindow.stable.low, high: report.matchWindow.stable.high } : null);
  const heroAnalysis = (hero.analysis || []).map((line) => "<li>" + esc(line) + "</li>").join("");
  const portrait = report.portrait.concrete || null;
  const portraitItemInner = (item) => {
    const sources = (item.sourceIds || []).map(esc).join(" / ");
    const evidence = (item.evidence || []).map((entry) => "<blockquote>" + esc(entry.quote) + "（" + esc(entry.account) + "）</blockquote>").join("");
    return esc(item.text) +
      (item.sourceLabel ? " <span class='tag tag-muted'>" + esc(item.sourceLabel) + "</span>" : "") +
      "<details class='basis-details'><summary></summary><div class='muted'>来源：" + sources + "</div>" + evidence + "</details>";
  };
  const portraitItem = (item) => "<li>" + portraitItemInner(item) + "</li>";
  /* 无法给出的维度按原因分组：缺输入（补上可解锁）与语料没有口径，不能混成一句。 */
  const missingInput = portrait ? portrait.missing.filter((item) => item.reason === "missing-input") : [];
  const missingCorpus = portrait ? portrait.missing.filter((item) => item.reason !== "missing-input") : [];
  /* 三级呈现：hero 只留一行可行动提示（跳转到「覆盖说明」折叠节），完整原因全部保留在折叠节里。 */
  const unlockFields = Array.from(new Set(missingInput.reduce((acc, item) => acc.concat(item.unlockFields || []), [])));
  const unlockHint = portrait && portrait.missing.length
    ? "<p class='muted portrait-gap-hint'>" +
      (unlockFields.length
        ? "补上「" + esc(unlockFields.join("」「")) + "」，可解锁" + esc(missingInput.map((item) => item.dimension).join("、")) + "画像；"
        : "") +
      "其余维度语料没有口径的原因见 <a href='#coverage-notes'>「覆盖说明」</a></p>"
    : "";
  const coverageNotes = portrait && portrait.missing.length
    ? "<details class='section-details card-fold' id='coverage-notes'><summary>覆盖说明：为什么有些维度没有</summary><div class='card'>" +
      "<p class='muted'>每个维度「给不了」的完整原因都在这里（不做简化）；补上标注的输入即可解锁对应画像。</p><ul class='advice-list'>" +
      portrait.missing.map((item) =>
        "<li><strong>" + esc(item.dimension) + "</strong>（" + (item.reason === "missing-input" ? "缺输入" : "语料没有口径") + "）：" + esc(item.detail || "") +
        ((item.unlockFields || []).length ? "　<span class='tag tag-knowledge'>补上：" + esc((item.unlockFields || []).join(" / ")) + "</span>" : "") +
        "</li>").join("") +
      "</ul></div></details>"
    : "";
  /* 覆盖面上来之后：每节默认只显示前 2 条，其余合并进一个折叠，保证可见行数不涨。 */
  const PORTRAIT_SHOW_LIMIT = 2;
  const hiddenPortrait = [];
  const portraitSection = (title, items) => {
    const list = items || [];
    if (!list.length) return "";
    list.slice(PORTRAIT_SHOW_LIMIT).forEach((item) => hiddenPortrait.push({ title: title, item: item }));
    return "<div class='portrait-head'>" + title + "</div><ul class='portrait-list'>" + list.slice(0, PORTRAIT_SHOW_LIMIT).map(portraitItem).join("") + "</ul>";
  };
  const portraitBounds = portrait ? [
    portraitSection("能配上的（参考）", portrait.upper),
    portraitSection("保底的（参考）", portrait.lower),
    portraitSection("去哪遇到这些人（参考）", portrait.channels),
    portraitSection("对方 / 市场更看重你什么（参考）", portrait.preferences)
  ].join("") : "";
  const portraitMoreLine = hiddenPortrait.length
    ? "<div class='muted'><details class='portrait-more'><summary>其余 " + hiddenPortrait.length + " 条画像（展开查看）</summary><ul class='portrait-list'>" +
      hiddenPortrait.map((entry) => "<li><span class='muted'>[" + esc(entry.title) + "]</span> " + portraitItemInner(entry.item) + "</li>").join("") +
      "</ul></details></div>"
    : "";
  const portraitBlock = portrait
    ? "<div class='hero-portrait'>" +
      (portrait.self ? "<p class='portrait-self'><span class='portrait-key'>你的定位</span>：" + esc(portrait.self) + "</p>" : "") +
      portraitBounds +
      portraitMoreLine +
      unlockHint +
      "</div>"
    : "";
  const heroCard = "<div class='card hero-card'>" +
    "<h1>择偶定位报告</h1>" +
    "<p class='hero-positioning'>" + esc(hero.positioning || "本次可用的信息不足以给出综合分") + "</p>" +
    "<p class='hero-numbers-inline'>择偶上限（参考） <b>" + fmt(heroUpper) + "</b> · 需要妥协的下限（参考） <b>" + fmt(heroLower) + "</b>　<span class='muted'>" + esc(hero.note || "区间为语料口径 + 工程窗口参数算出的参考，不是预测") + "</span></p>" +
    portraitBlock +
    (heroAnalysis ? "<p class='hero-analysis-line'>" + esc((hero.analysis || []).join("　")) + "</p>" : "") +
    "</div>";

  const fold = (title, body, extraClass) =>
    "<details class='section-details card-fold" + (extraClass ? " " + extraClass : "") + "'><summary>" + esc(title) + "</summary><div class='card'>" + body + "</div></details>";

  const giveupFold = fold("该放弃的幻想项（先看这个）", "<ul class='giveup-list'>" + giveUps + "</ul>", "giveup-fold");
  const scoreFold = fold("分项得分（颜值 / 硬件 / 软性 / 综合）", "<div class='score-grid'>" + cards + "</div>");
  const appearanceFold = fold("颜值分：双轨与交叉校准",
    "<p>自评 " + fmt(self.raw) + " 分 → 校准后 " + fmt(self.adjusted) + " 分（区间 " + fmt(self.low) + "–" + fmt(self.high) + "）" +
      (appearance.divergence === null
        ? "；照片轨道未启用，无法交叉校准。"
        : "；照片维度映射区间 " + (mapped ? fmt(mapped.low) + "–" + fmt(mapped.high) : "无锚点命中") + "，分歧 " + fmt(appearance.divergence) + " 分。") + "</p>" +
    "<p class='muted'>区间依据：" + esc(appearance.basisLabel || appearance.basis || "—") + "　" + badge(appearance.strength, appearance.strengthLabel, appearance.strengthProvisional) + " " + esc(appearance.strengthReason || "") + "</p>" +
    (selfReasons ? "<ul>" + selfReasons + "</ul>" : "") +
    (clamps ? "<p class='muted'>规则闸门：" + clamps + "</p>" : "") +
    (photoAnalyzed
      ? "<p>" + photoHeadline + "</p>" + photoUndecidedLine + photoQualityLine + photoDetailFold
      : photoSummaryLine));
  const windowFold = fold("择偶上 / 下限与稳妥区间",
    (report.matchWindow && report.matchWindow.strength === "engineering-default"
      ? "<p class='caveat-warning'>" + badge("engineering-default") + " " + esc(report.matchWindow.disclaimer || "") + "</p>"
      : "") +
    "<table><thead><tr><th>档位</th><th>分数</th><th>梯队</th><th>说明</th></tr></thead><tbody>" + windowHtml + "</tbody></table>");
  const ladderFold = fold("博主档位阶梯（语料词汇）",
    "<p class='conf-line'>" + esc(report.portrait.text) + (report.portrait.targetProfile ? "　" + esc(report.portrait.targetProfile) : "") + "</p>" +
    "<p class='muted'>" + esc(report.portrait.scaleDisclaimer || "梯队阶梯使用博主本人的分类词汇；本系统不输出自创的 S/A/B/C 档位。") + "</p>" +
    (report.portrait.bandNote ? "<p class='caveat-warning'>" + esc(report.portrait.bandNote) + "</p>" : "<p class='muted'>当前档位描述：" + esc(report.portrait.band ? report.portrait.band.name : "—") + "（" + esc(report.portrait.bandSource || "—") + "）</p>") +
    "<table><thead><tr><th>档位</th><th>定义</th><th>进入条件</th><th>可触达对象</th><th>是否命中</th></tr></thead><tbody>" + ladder + "</tbody></table>" +
    ladderFootnotes);
  const adviceFold = fold("建议", claimSummaryLine(report.claimsSummary) + "<ul class='advice-list'>" + advice + "</ul>" +
    (flags ? "<h3>规则标记</h3><ul class='advice-list'>" + flags + "</ul>" : "") +
    (requirements ? "<h3>证据要求</h3><ul class='advice-list'>" + requirements + "</ul>" : ""));
  const breakdownFold = fold("硬件 / 软性明细",
    "<h3>" + (hw.basis === "corpus-composite" ? "另一套算法参考（权重为系统默认，仅作对照）" : "硬件项明细（权重为系统默认）") + "</h3>" +
    renderBreakdown(report.hardware.breakdown) + "<h3>软性项明细</h3>" + renderBreakdown(report.soft.breakdown));
  const compositeFold = compositeCard ? fold("男生硬件十项表（语料原话加分制）", compositeCard) : "";
  const behaviorFold = behaviorCard ? fold("相亲现场行为自查（不接入分数）", behaviorCard) : "";
  const excludedFold = fold("因证据不足未计入分数", "<p class='muted'>这些项有得分，但证据强度不够（单条语料 / 外推 / 工程默认），只作参考，不进入综合分。</p>" +
    "<table><thead><tr><th>维度</th><th>得分</th><th>强度</th><th>原因</th></tr></thead><tbody>" + excluded + "</tbody></table>" +
    (pendingExtrapolation ? "<h3>缺少输入、暂未评估的场景</h3><ul class='advice-list'>" + pendingExtrapolation + "</ul>" : ""));
  const improvementsFold = fold("提升路径", "<ul class='advice-list'>" + improvements + "</ul>");
  const rulesFold = fold("命中规则", "<table><thead><tr><th>编号</th><th>说明</th><th>范围</th><th>执行方式</th><th>证据强度</th></tr></thead><tbody>" + rulesApplied + "</tbody></table>");
  const evidenceFold = fold("证据引用（可追溯）", "<table><thead><tr><th>账号</th><th>aweme_id</th><th>强度</th><th>用于</th></tr></thead><tbody>" + evidence + "</tbody></table>");
  const advisoryFold = fold("体系参考（未自动执行）", "<p class='muted'>这些条目只作人工参考、不参与自动执行；内容与证据照常列出。</p><ul class='ref-list'>" + advisory + "</ul>");
  const unstructuredFold = (report.unstructuredRules || []).length || ruleErrors
    ? fold("尚未结构化的规则", "<p class='muted'>每条规则应二选一：写明可自动执行的条件，或声明为仅供人工参考。以下规则两者都没有。</p><ul class='ref-list'>" + unstructured + "</ul>" +
      (ruleErrors ? "<h3>求值出错的规则</h3><ul class='advice-list'>" + ruleErrors + "</ul>" : ""))
    : "";
  const caveatsFold = fold("局限与置信度", "<ul class='caveat'>" + caveats + "</ul>");
  const ledgerFold = fold("关于本报告",
    "<p class='muted'>报告 " + esc(report.id) + "　生成时间 " + esc(report.createdAt) + "　规则集 v" + esc(report.engine.mainRules.version) + "　照片轨道：" + esc(report.engine.photoModeLabel || report.engine.photoMode || "未启用") + "</p>" +
    "<p class='conf-line'>本次 " + (summary.scoredItems === undefined ? "—" : summary.scoredItems) + " 个计分项：" + strongCount + " 项机构内一致（多源/2 源），" + refCount + " 项仅参考（单源 / 外推 / 工程默认）</p>" +
    "<p class='muted'>规则强度来源：" + (conf.independence && conf.independence.source === "audit-rules" ? ("audit-rules 已审计 " + (conf.independenceCoverage ? conf.independenceCoverage.auditedRules : "?") + " 条 / 未覆盖 " + (conf.independenceCoverage ? conf.independenceCoverage.heuristicRules : "?") + " 条走启发式（带 *）") : "启发式（独立性数据未就绪，带 *）") + "；维度强度为启发式（带 *）</p>" +
    "<div class='legend'>" + ["verified", "cross-account", "single-source", "extrapolated", "engineering-default", "advisory"].map((level) => badge(level)).join("") + "</div>" +
    (referenceScale ? "<h3>参照刻度（本系统早期自创，语料没有该体系，不参与判定）</h3><p class='muted'>本系统早期自创的 S/A/B/C 刻度，语料里没有该体系；仅作历史参照，不参与任何判定。</p><table><thead><tr><th>刻度</th><th>定义</th><th>区间</th></tr></thead><tbody>" + referenceScale + "</tbody></table>" : ""));

  document.getElementById("report-root").innerHTML = [
    (report.disclosure && report.disclosure.text ? "<p class='disclosure'>" + esc(report.disclosure.text) + "</p>" : ""),
    heroCard,
    extrapolationBanner,
    "<div class='report-actions'><button class='btn' id='toggle-basis'>展开全部依据</button><button class='btn' id='print-btn'>打印 / 存 PDF</button><a class='btn' href='index.html'>再测一份</a></div>",
    coverageNotes,
    giveupFold,
    scoreFold,
    appearanceFold,
    windowFold,
    ladderFold,
    adviceFold,
    breakdownFold,
    compositeFold,
    behaviorFold,
    excludedFold,
    improvementsFold,
    rulesFold,
    evidenceFold,
    advisoryFold,
    unstructuredFold,
    caveatsFold,
    ledgerFold
  ].join("");

  const printButton = document.getElementById("print-btn");
  if (printButton) printButton.addEventListener("click", () => window.print());
  const toggleBasis = document.getElementById("toggle-basis");
  if (toggleBasis) toggleBasis.addEventListener("click", () => {
    const opened = toggleBasis.getAttribute("data-open") === "1";
    document.querySelectorAll("details.basis-details, details.claim-details, details.section-details").forEach((node) => { node.open = !opened; });
    toggleBasis.setAttribute("data-open", opened ? "0" : "1");
    toggleBasis.textContent = opened ? "展开全部依据" : "收起全部依据";
  });
  document.title = "择偶定位报告 " + report.id;
}

function main() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("selftest") === "1") {
    runSelfTest(params).catch((error) => {
      document.getElementById("report-root").innerHTML = "<div class='card errors'>自检失败：" + esc(error && error.message ? error.message : error) + "</div>";
    });
    return;
  }
  const id = params.get("id") || window.localStorage.getItem("aoye:lastReportId") || "";
  const root = document.getElementById("report-root");
  if (!id) {
    root.innerHTML = "<div class='card errors'>没有找到本地报告：请先在首页生成一份。</div>";
    return;
  }
  const raw = window.localStorage.getItem("aoye:report:" + id);
  if (!raw) {
    root.innerHTML = "<div class='card errors'>本地没有找到报告 " + esc(id) + "（可能换了浏览器或清了缓存）。</div>";
    return;
  }
  try {
    render(JSON.parse(raw));
  } catch (error) {
    root.innerHTML = "<div class='card errors'>报告解析失败：" + esc(error && error.message ? error.message : error) + "</div>";
  }
}

/* 构建自检：就地跑一份示例报告并渲染（用 ?selftest=1 触发；不依赖表单交互）。 */
async function runSelfTest(params) {
  const { preloadData, setDataDir } = await import("../lib/load-browser.mjs");
  const { loadRuleset } = await import("../lib/ruleset.mjs");
  const { loadCities, cityTierInfo } = await import("../lib/city.mjs");
  const { generateReport } = await import("../lib/pipeline.mjs");
  const { buildSample } = await import("../lib/sample.mjs");
  const { providerConfig } = await import("../lib/provider.mjs");
  const dataDir = params.get("data") || "./data/";
  setDataDir(dataDir);
  await preloadData([
    "data/rules.json", "data/baseline-rules.json", "data/form-fields.json", "data/cities.json",
    "data/facts.json", "data/evidence-independence.json", "data/evidence-quality-flags.json",
    "data/cases.json", "data/band-criteria.json", "data/composite-criteria.json",
    "data/composite-mapping.json", "data/extrapolation-rules.json",
    "data/standards.json", "data/portrait-rules.json"
  ], dataDir);
  const sample = buildSample("data/cases.json", "C-022");
  const ruleset = loadRuleset({ mainPath: "data/rules.json", baselinePath: "data/baseline-rules.json" });
  const cities = loadCities("data/cities.json");
  const info = cityTierInfo(sample.form.city, cities);
  const report = await generateReport({
    form: sample.form, photos: [], ruleset, cities, cityTier: info.tier, cityMatched: info.matched,
    config: providerConfig({}),
    independencePath: "data/evidence-independence.json",
    extrapolationPath: "data/extrapolation-rules.json",
    bandCriteriaPath: "data/band-criteria.json",
    compositeCriteriaPath: "data/composite-criteria.json",
    compositeMappingPath: "data/composite-mapping.json",
    qualityFlagsPath: "data/evidence-quality-flags.json"
  });
  window.localStorage.setItem("aoye:report:" + report.id, JSON.stringify(report));
  window.localStorage.setItem("aoye:lastReportId", report.id);
  render(report);
}

main();
