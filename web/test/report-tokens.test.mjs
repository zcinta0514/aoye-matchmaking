import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FIELD_OPTION_LABELS } from "../lib/labels.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;

process.env.AOYE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-tokens-test-"));

/* 可见文本基线（同一提取口径，去空白计字数）：
   - 34 行 / 553 字：内部术语清理前；
   - 40 行 / 1040 字：具象画像上线后（hero 新增「你的定位/能配上的/保底的」，作为交换，稳妥区间与 hero note 折叠）；
   - 40 行 / 1112 字：画像 v2 覆盖面扩充（新条目默认只显示前 2 条，其余进「其余 N 条画像」折叠，行数仍 40）；
   以后新增可见内容必须显式调整这两个数字并说明理由。 */
const BASELINE_LINES = 40;
const BASELINE_CHARS = 1124;

/* 默认视图提取（用户不展开任何折叠时能读到的文字）：
   - 顶层 details 只保留 <summary>（折叠标题用户看得到），正文删除；
   - 嵌套 details 连同 summary 一起删除（父级关闭时不可见）。 */
function collapseDetails(html) {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("<details", i);
    if (open === -1) { out += html.slice(i); break; }
    out += html.slice(i, open);
    let depth = 1, j = open + 8, end = -1;
    while (j < html.length) {
      const no = html.indexOf("<details", j);
      const nc = html.indexOf("</details>", j);
      if (nc === -1) break;
      if (no !== -1 && no < nc) { depth++; j = no + 8; }
      else { depth--; if (depth === 0) { end = nc; break; } j = nc + 10; }
    }
    if (end === -1) { out += html.slice(open); break; }
    const inner = html.slice(open, end);
    const s = inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/);
    out += (s ? s[1] : "") + "\n";
    i = end + 10;
  }
  return out;
}

/* “整段去掉 details”口径（连折叠标题也去掉），两套口径都要干净。
   注意：不能用非贪婪正则 <details...>.*?</details> —— 遇到嵌套 details 时它只吃到第一个内层闭合，
   会把折叠正文的残段当成“可见文本”泄漏出来（本项目早期报告行数因此被高估）。这里用配对扫描器整段丢弃。 */
function dropAllDetails(html) {
  let out = "";
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("<details", i);
    if (open === -1) { out += html.slice(i); break; }
    out += html.slice(i, open);
    let depth = 1, j = open + 8, end = -1;
    while (j < html.length) {
      const no = html.indexOf("<details", j);
      const nc = html.indexOf("</details>", j);
      if (nc === -1) break;
      if (no !== -1 && no < nc) { depth++; j = no + 8; }
      else { depth--; if (depth === 0) { end = nc; break; } j = nc + 10; }
    }
    if (end === -1) { out += html.slice(open); break; }
    i = end + 10;
  }
  return out;
}

function toLines(html) {
  let text = html;
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/g, " ");
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, " ");
  text = text.replace(/<\/(p|li|tr|div|h1|h2|h3|h4|summary|td|blockquote|ul|table)>/g, "\n");
  text = text.replace(/<br\s*\/?>/g, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
  return text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function visibleWithTitles(dumped) {
  let html = dumped;
  html = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/g, " ");
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ");
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, " ");
  return toLines(collapseDetails(html));
}

function visibleWithoutTitles(dumped) {
  let html = dumped;
  html = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/g, " ");
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ");
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, " ");
  return toLines(dropAllDetails(html));
}

function count(plain, needle) {
  return plain.split(needle).length - 1;
}

function dumpReportPage(baseUrl, id, userDataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-first-run",
      "--user-data-dir=" + userDataDir,
      "--virtual-time-budget=4000",
      "--dump-dom",
      baseUrl + "/r/" + id
    ]);
    let out = "";
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { child.kill(); } catch { /* ignore */ } resolve(out); };
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.indexOf("</html>") !== -1 && out.indexOf("hero-card") !== -1) finish();
    });
    child.on("exit", finish);
    child.on("error", reject);
    setTimeout(() => { child.kill(); }, 15000);
  });
}

test("枚举映射表覆盖 form-fields.json 全部选项（防漂移）", () => {
  const config = JSON.parse(fs.readFileSync(path.join(WEB_DIR, "config", "form-fields.json"), "utf8"));
  const missing = [];
  (config.fields || []).forEach((field) => {
    (field.options || []).forEach((option) => {
      const table = FIELD_OPTION_LABELS[field.id];
      if (!table || !table[option.value] || table[option.value] !== option.label) {
        missing.push(field.id + "=" + option.value);
      }
    });
  });
  assert.equal(missing.length, 0, "以下选项缺少同步的中文标签：" + missing.join("、"));
});

test("报告默认可见文本不得泄漏内部术语 / 枚举 / 规则编号（A–F 清理）", { skip: CHROME ? false : "未找到 Chrome（可设 CHROME_PATH）" }, async () => {
  const { startServer } = await import("../server.mjs");
  const { server, baseUrl } = await startServer(0, "127.0.0.1");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-tokens-chrome-"));
  try {
    const sample = await (await fetch(baseUrl + "/api/sample")).json();
    const created = await fetch(baseUrl + "/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: sample.form, photoIds: [] })
    });
    assert.equal(created.status, 200);
    const id = (await created.json()).id;

    const dumped = await dumpReportPage(baseUrl, id, userDataDir);
    assert.ok(dumped.indexOf("hero-card") !== -1, "报告必须渲染");
    const lines = visibleWithTitles(dumped);
    const plain = lines.join(" ");
    const plainNoTitles = visibleWithoutTitles(dumped).join(" ");

    const tokenChecks = [
      ["决策编号", /\bD\d{1,2}\b/],
      ["engineering-default", /engineering-default/],
      ["corpus", /corpus/],
      ["scoring", /scoring/],
      ["machine", /machine/],
      ["placeholder", /placeholder/],
      ["self-report-only", /self-report-only/],
      ["audit-rules", /audit-rules/],
      ["heuristic", /heuristic/],
      ["规则编号", /\bR-[A-Z]+-\d{1,3}\b/],
      ["S 档", /S 档/],
      ["A 档", /A 档/],
      ["B 档", /B 档/],
      ["C 档", /C 档/],
      ["向下（兼容/找/向下）", /向下/],
      ["向上兼容", /向上兼容/],
      ["工程默认（需人话说明或只留图例）", /工程默认/],
      ["外推参考（需人话说明或只留图例）", /外推参考/]
    ];
    for (const [label, pattern] of tokenChecks) {
      assert.equal(pattern.test(plain), false, "可见文本（含折叠标题）不得出现「" + label + "」：" + (plain.match(pattern) || [""])[0]);
      assert.equal(pattern.test(plainNoTitles), false, "可见文本（不含折叠标题）不得出现「" + label + "」");
    }
    const rawEnums = ["has", "bachelor", "ordinary", "gov", "loan", "none", "local", "unknown", "a7", "brother_only", "single", "county", "warm"];
    for (const value of rawEnums) {
      const pattern = new RegExp("(^|[^A-Za-z0-9_])" + value + "([^A-Za-z0-9_]|$)");
      assert.equal(pattern.test(plain), false, "可见文本不得出现原始枚举值「" + value + "」");
    }
    /* 同一批枚举也不得作为文本节点出现在折叠内容里（打印视图 / 展开视图同样不该给用户看原文）。
       注意：带点号的来源 id（如 asset.a7）不是原始枚举泄漏，扫描时排除。 */
    const textNodes = Array.from(dumped.matchAll(/>([^<>]+)</g)).map((match) => match[1]);
    for (const value of rawEnums) {
      const nodePattern = new RegExp("(^|[^A-Za-z0-9_.])" + value + "([^A-Za-z0-9_]|$)");
      const hit = textNodes.find((text) => nodePattern.test(text));
      assert.equal(hit, undefined, "折叠内容里也不得把枚举原文当文本渲染：" + (hit ? hit.trim().slice(0, 60) : ""));
    }

    assert.ok(lines.length <= BASELINE_LINES, "可见行数不得增加（基线 " + BASELINE_LINES + "，实际 " + lines.length + "）");
    const chars = plain.replace(/\s/g, "").length;
    assert.ok(chars <= BASELINE_CHARS, "可见字数不得增加（基线 " + BASELINE_CHARS + "，实际 " + chars + "）");
    assert.ok(count(plain, "输入未提供") <= 1, "「输入未提供」可见次数必须 ≤ 1（实际 " + count(plain, "输入未提供") + "）");

    /* 三级呈现：hero 不得出现成串缺口；必须有一行可行动提示，且能点进「覆盖说明」折叠节。 */
    assert.equal(plain.indexOf("语料没有对应口径——"), -1, "hero 不得出现成串的「语料没有对应口径」");
    assert.ok(/补上「[^」]+」.*可解锁/.test(plain), "hero 必须有把缺口翻译成路径的提示：" + plain.slice(0, 400));
    assert.ok(plain.indexOf("覆盖说明") !== -1, "hero 提示必须指向「覆盖说明」");
    assert.ok(dumped.indexOf('href="#coverage-notes"') !== -1 || dumped.indexOf("href='#coverage-notes'") !== -1, "提示必须可点击到折叠节");
    assert.ok(dumped.indexOf('id="coverage-notes"') !== -1 || dumped.indexOf("id='coverage-notes'") !== -1, "「覆盖说明」折叠节必须存在");
    assert.ok(dumped.indexOf("完整原因都在这里") !== -1, "折叠节必须声明完整保留原因（不得简化）");
    assert.ok(dumped.indexOf("语料没有口径") !== -1, "折叠节里必须保留每个维度的原因分类");
    assert.ok(dumped.indexOf("语料只有方向性口径") !== -1, "折叠节里必须保留具体原因原文（不得只写「语料没有」）");

    /* 画像折叠：新增条目默认只显示前 2 条，其余必须在 DOM 里、且不出现在默认可见文本。 */
    assert.ok(dumped.indexOf("条画像（展开查看）") !== -1, "必须有「其余 N 条画像」折叠");
    const hiddenMarker = "语料里的「条件好」三要素";
    assert.ok(dumped.indexOf(hiddenMarker) !== -1, "折叠的画像条目必须仍在 DOM：" + hiddenMarker);
    assert.equal(plain.indexOf(hiddenMarker), -1, "折叠的画像条目不得出现在默认可见文本");
    assert.ok(count(plain, "跳过照片分析") <= 1, "「跳过照片分析」可见次数必须 ≤ 1（实际 " + count(plain, "跳过照片分析") + "）");

    /* 自创 S/A/B/C 表下沉到「关于本报告」：默认不可见、DOM 里可查。 */
    assert.equal(plain.indexOf("参照刻度"), -1, "参照刻度不得出现在默认可见文本");
    assert.ok(dumped.indexOf("参照刻度") !== -1, "参照刻度必须仍在 DOM（「关于本报告」折叠区）");
    assert.ok(dumped.indexOf("本系统的全部证据来自同一商业机构") !== -1, "披露仍在（D30）");

    console.log("[report-tokens] 可见行数 " + lines.length + " / 字数 " + chars + "（基线 " + BASELINE_LINES + " / " + BASELINE_CHARS + "）");
    console.log("[report-tokens] 可见全文：\n" + lines.map((line, index) => String(index + 1).padStart(3) + "| " + line).join("\n"));
  } finally {
    server.close();
  }
});
