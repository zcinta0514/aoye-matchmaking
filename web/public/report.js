const TOKEN_KEY = "aoye_access_token";

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
    return "<tr><td>" + esc(item.name) + "</td><td>" + esc(String(item.input === undefined ? "—" : item.input)) + "</td><td>"
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
    ? "<div class='card'><h2>男生硬件十项表（语料原话加分制）</h2>" +
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
      "</div>"
    : "";
  const behavior = report.behaviorCheck || null;
  const behaviorCard = behavior
    ? "<div class='card'><h2>相亲现场行为自查（不接入分数）</h2>" +
      "<p class='muted'>" + esc(behavior.name) + "　" + badge(behavior.strength, behavior.strengthLabel) + "　" + esc(behavior.note || "") + "</p>" +
      "<p>" + esc(behavior.description || "") + "</p>" +
      "<table><thead><tr><th>档位</th><th>分数区间</th><th>可观察</th></tr></thead><tbody>" +
      (behavior.anchors || []).map((anchor) => "<tr><td>" + esc(anchor.label) + "</td><td>" + fmt(anchor.min) + "–" + fmt(anchor.max) + "</td><td>" + esc((anchor.observable || []).join("；")) + "</td></tr>").join("") +
      "</tbody></table>" +
      "<p class='muted'>证据：" + (behavior.evidence || []).map((item) => esc(item.account) + "/" + esc(item.aweme_id)).join("、") + "</p></div>"
    : "";

  const cards = [
    scoreCard(
      "颜值分（规则映射区间）",
      appearance.final ? (fmt(final.low) + " – " + fmt(final.high)) : "未提供",
      appearance.final ? ((appearance.finalLabel || "无锚点命中") + "　依据：" + (appearance.basis || "—")) : "未填颜值自评（或数值越界）：不按 0 分计算",
      appearance.strength, appearance.strengthLabel, appearance.strengthProvisional
    ),
    scoreCard("硬件分", fmt(hw.score) + (hw.basis === "corpus-composite" ? "（语料表）" : ""), hwSub, "computed", hw.basisLabel || "计入项加权"),
    scoreCard("软性分", fmt(report.soft.score), (report.soft.label || "") + "　计入 " + softCounted + " 项" + softRef, "computed", "计入项加权"),
    scoreCard(
      "综合水平 / 梯队",
      fmt(report.level) + "　" + bandCell,
      "全量参考 " + fmt(report.levelIfAllCounted) + "　" + bandSub +
        (hw.basis === "corpus-composite" ? "　硬件槽位：语料复合表（定义型单源，D21）" : ""),
      "computed", "仅计入机构内一致项", conf.independence && conf.independence.provisional
    )
  ].join("");

  const extrapolationBanner = extrapolation.active
    ? "<div class='card extrapolation-card'><h2>外推声明（D12）</h2>" + (extrapolation.applied || []).map((item) => "<p>⚠ " + esc(item.message) + "</p>").join("") + "</div>"
    : "";

  const giveUps = (report.giveUps || []).map((item) => "<li>" + esc(item.displayText || item.text) + tag(item.origin) + claimMark(item) + "</li>").join("")
    || "<li class='muted'>按当前条件没有触发『该放弃的幻想项』规则。</li>";
  const advice = (report.advice || []).map((item) => "<li>" + esc(item.displayText || item.text) + tag(item.origin) + claimMark(item) + "</li>").join("")
    || "<li class='muted'>无额外建议。</li>";

  const excluded = (report.excludedItems || []).map((item) =>
    "<tr><td>" + esc(item.name) + "</td><td>" + fmt(item.score) + "</td><td>" + badge(item.strength, item.strengthLabel) + "</td><td>" + esc(item.reason) + "</td></tr>"
  ).join("") || "<tr><td colspan='4' class='muted'>没有因证据不足被排除的计分项。</td></tr>";

  const photoDims = (photo.dimensions || []).map((dim) =>
    "<tr><td>" + esc(dim.name) + "</td><td>" + esc(dim.observed || dim.note || "未分析") + "</td><td>" + esc(dim.level || "—") + "</td><td>" + esc(dim.confidence || "—") + "</td></tr>"
  ).join("") || "<tr><td colspan='4' class='muted'>未启用照片分析。</td></tr>";
  const anchorFits = (photo.anchorFits || []).map((fit) =>
    "<tr><td>" + esc(fit.label) + "</td><td>" + fmt(fit.fit, 2) + "</td><td>" + esc(fit.reason) + "</td></tr>"
  ).join("");

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
    "<tr><td>" + esc(rule.ruleId) + "</td><td>" + esc(rule.title) + "</td><td>" + esc(rule.scope) + "</td><td>" + esc(rule.via) + "</td><td>" + strengthMark(levelFromLabel(rule.strength), rule.strength, rule.strengthProvisional) + "</td></tr>"
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
  const bandStatus = { "matched": "✅ 命中", "not-matched": "—", "input-missing": "输入未提供" };
  const ladderRows = (report.portrait.ladder || []).filter((item) => !item.referenceOnly);
  const referenceRows = (report.portrait.ladder || []).filter((item) => item.referenceOnly);
  const ladder = ladderRows.map((item) =>
    "<tr class='" + (item.active ? "row-active" : "") + "'><td>" + (item.active ? "▶ " : "") + esc(item.name) + tag(item.origin) + strengthMark(item.strength) + "</td><td>" + esc(item.definition) + "</td><td>" + esc((item.entryCriteria || []).join("；")) + "</td><td>" + esc(item.reachableMatch || "—") + "</td><td>" + esc(bandStatus[item.matchStatus] || (item.matchStatus === null ? "—" : item.matchStatus)) + (item.needsField ? "（" + esc(item.needsField) + "）" : "") + "</td></tr>"
  ).join("") || "<tr><td colspan='5' class='muted'>无语料档位可映射。</td></tr>";
  const referenceScale = referenceRows.map((item) => "<tr><td>" + esc(item.name) + badge("engineering-default") + "</td><td>" + esc(item.definition || "—") + "</td><td>" + esc(JSON.stringify(item.range || item.level || "—")) + "</td></tr>").join("");
  const caveats = (report.caveats || []).map((item) => "<li" + (item.level === "warning" ? " class='caveat-warning'" : "") + ">" + esc(item.text) + "</li>").join("");
  const selfReasons = (self.reasons || []).map((reason) => "<li>" + esc(reason) + "</li>").join("");
  const clamps = (appearance.clampsApplied || []).map((item) => esc(item.ruleId) + "（" + esc(item.action) + "）").join("、");
  const photoCaveats = (photo.caveats || []).map(esc).join("　");
  const pendingExtrapolation = (extrapolation.pending || []).map((item) => "<li>" + esc(item.label) + "：缺少表单字段（" + esc(item.needField || "—") + "）</li>").join("");

  document.getElementById("report-root").innerHTML = [
    (report.disclosure && report.disclosure.text ? "<p class='disclosure'>" + esc(report.disclosure.text) + "</p>" : ""),
    "<div class='card'><h1>择偶定位报告</h1>" +
      "<p class='muted'>报告 " + esc(report.id) + "　生成时间 " + esc(report.createdAt) + "　规则集 v" + esc(report.engine.mainRules.version) + "　照片轨道：" + esc(report.engine.photoMode || "none") + "</p>" +
      "<p class='conf-line'>本次 " + (summary.scoredItems === undefined ? "—" : summary.scoredItems) + " 个计分项：" + strongCount + " 项机构内一致（多源/2 源），" + refCount + " 项仅参考（单源 / 外推 / 工程默认）</p>" +
      "<p class='muted'>规则强度来源：" + (conf.independence && conf.independence.source === "audit-rules" ? ("audit-rules 已审计 " + (conf.independenceCoverage ? conf.independenceCoverage.auditedRules : "?") + " 条 / 未覆盖 " + (conf.independenceCoverage ? conf.independenceCoverage.heuristicRules : "?") + " 条走启发式（带 *）") : "启发式（独立性数据未就绪，带 *）") + "；维度强度为启发式（带 *）</p>" +
      "<p class='muted'>" + esc(report.portrait.text) + "<br>" + esc(report.portrait.targetProfile || "") + "</p>" +
      "<div class='legend'>" + ["verified", "cross-account", "single-source", "extrapolated", "engineering-default", "advisory"].map((level) => badge(level)).join("") + "</div></div>",
    extrapolationBanner,
    "<div class='score-grid'>" + cards + "</div>",
    "<div class='card giveup-card'><h2>该放弃的幻想项（先看这个）</h2><ul class='giveup-list'>" + giveUps + "</ul></div>",
    compositeCard,
    behaviorCard,
    "<div class='card'><h2>颜值分：双轨与交叉校准</h2>",
    "<p>自评 " + fmt(self.raw) + " 分 → 校准后 " + fmt(self.adjusted) + " 分（区间 " + fmt(self.low) + "–" + fmt(self.high) + "）" +
      (appearance.divergence === null
        ? "；照片轨道未启用，无法交叉校准。"
        : "；照片维度映射区间 " + (mapped ? fmt(mapped.low) + "–" + fmt(mapped.high) : "无锚点命中") + "，分歧 " + fmt(appearance.divergence) + " 分。") + "</p>",
    "<p class='muted'>区间依据：" + esc(appearance.basis || "—") + "　" + badge(appearance.strength, appearance.strengthLabel, appearance.strengthProvisional) + " " + esc(appearance.strengthReason || "") + "</p>",
    selfReasons ? "<ul>" + selfReasons + "</ul>" : "",
    clamps ? "<p class='muted'>规则闸门：" + clamps + "</p>" : "",
    "<h3>照片维度描述（模型只描述，不打分）</h3>",
    "<table><thead><tr><th>维度</th><th>可观察描述</th><th>档位</th><th>置信度</th></tr></thead><tbody>" + photoDims + "</tbody></table>",
    anchorFits ? "<h3>锚点符合度（规则映射依据）</h3><table><thead><tr><th>锚点</th><th>fit</th><th>依据</th></tr></thead><tbody>" + anchorFits + "</tbody></table>" : "",
    photoCaveats ? "<p class='muted'>照片轨道说明：" + photoCaveats + "</p>" : "",
    "</div>",
    "<div class='card'><h2>择偶上 / 下限与稳妥区间</h2>" +
      (report.matchWindow && report.matchWindow.strength === "engineering-default"
        ? "<p class='caveat-warning'>" + badge("engineering-default") + " " + esc(report.matchWindow.disclaimer || "") + "</p>"
        : "") +
      "<table><thead><tr><th>档位</th><th>分数</th><th>梯队</th><th>说明</th></tr></thead><tbody>" + windowHtml + "</tbody></table></div>",
    "<div class='card'><h2>博主档位阶梯（语料词汇）</h2>" +
      "<p class='conf-line'>" + esc(report.portrait.scaleDisclaimer || "梯队阶梯使用博主本人的分类词汇；本系统不输出自创的 S/A/B/C 档位。") + "</p>" +
      (report.portrait.bandNote ? "<p class='caveat-warning'>" + esc(report.portrait.bandNote) + "</p>" : "<p class='muted'>当前档位描述：" + esc(report.portrait.band ? report.portrait.band.name : "—") + "（" + esc(report.portrait.bandSource || "—") + "）</p>") +
      "<table><thead><tr><th>档位</th><th>定义</th><th>进入条件</th><th>可触达对象</th><th>你的输入</th></tr></thead><tbody>" + ladder + "</tbody></table>" +
      (referenceScale ? "<h3>参照刻度（engineering-default，不作为结论）</h3><p class='muted'>S/A/B/C 是本系统早期自创刻度，语料没有该体系；仅作粗略参照，已不参与任何档位判定。</p><table><thead><tr><th>刻度</th><th>定义</th><th>区间</th></tr></thead><tbody>" + referenceScale + "</tbody></table>" : "") +
      "</div>",
    "<div class='card'><h2>建议</h2>" + claimSummaryLine(report.claimsSummary) + "<ul class='advice-list'>" + advice + "</ul>" +
      (flags ? "<h3>规则标记</h3><ul class='advice-list'>" + flags + "</ul>" : "") +
      (requirements ? "<h3>证据要求（requireEvidence）</h3><ul class='advice-list'>" + requirements + "</ul>" : "") + "</div>",
    "<div class='card'><h2>硬件 / 软性明细</h2><h3>" + (hw.basis === "corpus-composite" ? "工程权重参考（D17：权重为工程默认，仅作对照）" : "硬件（工程权重法，含家庭）") + "</h3>" + renderBreakdown(report.hardware.breakdown) + "<h3>软性（工程权重法）</h3>" + renderBreakdown(report.soft.breakdown) + "</div>",
    "<div class='card'><h2>因证据不足未计入分数</h2><p class='muted'>这些项有得分，但证据强度不够（单条语料 / 外推 / 工程默认），只作参考，不进入综合分。</p>" +
      "<table><thead><tr><th>维度</th><th>得分</th><th>强度</th><th>原因</th></tr></thead><tbody>" + excluded + "</tbody></table>" +
      (pendingExtrapolation ? "<h3>待扩字段的外推场景（D12）</h3><ul class='advice-list'>" + pendingExtrapolation + "</ul>" : "") + "</div>",
    "<div class='card'><h2>提升路径</h2><ul class='advice-list'>" + improvements + "</ul></div>",
    "<div class='card'><h2>命中规则</h2><table><thead><tr><th>规则</th><th>标题</th><th>scope</th><th>via</th><th>强度</th></tr></thead><tbody>" + rulesApplied + "</tbody></table></div>",
    "<div class='card'><details class='section-details'><summary>证据引用（可追溯）</summary><table><thead><tr><th>账号</th><th>aweme_id</th><th>强度</th><th>用于</th></tr></thead><tbody>" + evidence + "</tbody></table></details></div>",
    "<div class='card'><details class='section-details'><summary>体系参考（未自动执行）</summary><p class='muted'>规则标注 advisory：引擎不执行，内容与证据照常列出，供人工参考。</p><ul class='ref-list'>" + advisory + "</ul></details></div>",
    "<div class='card'><details class='section-details'><summary>未结构化规则（需要补 machine）</summary><p class='muted'>按契约 §5.0，规则应二选一：给 machine.when 让引擎执行，或标 advisory:true 声明只给人看。以下规则两者都没有。</p><ul class='ref-list'>" + unstructured + "</ul></details>" + (ruleErrors ? "<h3>求值出错的规则</h3><ul class='advice-list'>" + ruleErrors + "</ul>" : "") + "</div>",
    "<div class='card'><h2>局限与置信度</h2><ul class='caveat'>" + caveats + "</ul></div>",
    "<div class='report-actions'><button class='btn' id='toggle-basis'>展开全部依据</button><button class='btn' id='print-btn'>打印 / 存 PDF</button><a class='btn' href='/'>再测一份</a></div>"
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
  const id = reportId();
  if (!id) {
    document.getElementById("report-root").innerHTML = "<div class='card errors'>缺少报告 id。</div>";
    return;
  }
  const token = getToken();
  fetch("/api/report/" + id, token ? { headers: { "x-aoye-token": token } } : undefined)
    .then((response) => {
      if (response.status === 401) {
        const entered = window.prompt("该服务已开启访问令牌（AOYE_ACCESS_TOKEN）。请输入令牌：", getToken());
        if (entered) {
          setToken(entered.trim());
          window.location.reload();
          return null;
        }
        throw new Error("未授权：需要访问令牌");
      }
      return response.json();
    })
    .then((report) => {
      if (!report) return;
      if (report.error) throw new Error(report.error);
      render(report);
    })
    .catch((error) => {
      document.getElementById("report-root").innerHTML = "<div class='card errors'>报告加载失败：" + esc(error.message) + "</div>";
    });
}

main();
