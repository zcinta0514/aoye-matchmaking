import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;

process.env.AOYE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-order-test-"));

function stripDetails(html) {
  let text = html;
  const pattern = new RegExp("<details\\b[^>]*>[\\s\\S]*?<\\/details>", "g");
  let previous = null;
  while (previous !== text) {
    previous = text;
    text = text.replace(pattern, "");
  }
  return text;
}

/* 默认「可见文本」= 用户不点开任何折叠时能读到的文字（含页面顶栏，不含 head/脚本/样式）。 */
function visibleText(dumped) {
  let html = dumped;
  html = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/g, " ");
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ");
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, " ");
  html = stripDetails(html);
  html = html.replace(/<[^>]+>/g, " ");
  html = html.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
  return html.replace(/\s+/g, " ").trim();
}

/* 与 web/public/report.js 的 fmt() 保持同一口径（1 位小数、去尾零），防两边漂移。 */
function fmtLike(value, digits) {
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
      if (out.indexOf("</html>") !== -1) finish();
    });
    child.on("exit", () => finish());
    child.on("error", reject);
    setTimeout(() => { child.kill(); }, 15000);
  });
}

test("结论先行（D32）：报告默认可见文本先结论、后账本，证据仍可折叠追溯", { skip: CHROME ? false : "未找到 Chrome（可设 CHROME_PATH）" }, async () => {
  const { startServer } = await import("../server.mjs");
  const { server, baseUrl } = await startServer(0, "127.0.0.1");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-order-chrome-"));
  try {
    const sample = await (await fetch(baseUrl + "/api/sample")).json();
    const created = await fetch(baseUrl + "/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: sample.form, photoIds: [] })
    });
    assert.equal(created.status, 200);
    const id = (await created.json()).id;
    const reportJson = await (await fetch(baseUrl + "/api/report/" + id)).json();
    assert.ok(reportJson.summary, "报告 JSON 必须带 summary（结论先行字段）");

    const dumped = await dumpReportPage(baseUrl, id, userDataDir);
    const visible = visibleText(dumped);
    console.log("[report-order] 可见文本前 400 字: " + visible.slice(0, 400));
    const summaryTitles = (dumped.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g) || [])
      .map((item) => item.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);
    console.log("[report-order] 默认折叠分区（" + summaryTitles.length + " 个）: " + summaryTitles.slice(0, 30).join(" | "));

    // 断言 0：报告真的渲染了（防空白页误判为通过）
    assert.ok(visible.indexOf("择偶定位报告") !== -1, "报告必须渲染：可见文本 " + visible.slice(0, 120));

    // 断言 1：前 200 字不得出现工程账本词汇
    const head200 = visible.slice(0, 200);
    ["规则集", "审计", "计分项", "placeholder", "heuristic", "版"].forEach((word) => {
      assert.equal(head200.indexOf(word), -1, "报告前 200 字不得出现工程词「" + word + "」；实际：" + head200);
    });

    // 断言 2：上限 / 下限数字出现在前 500 字内
    const upperText = fmtLike(reportJson.summary.upper);
    const lowerText = fmtLike(reportJson.summary.lower);
    assert.ok(typeof reportJson.summary.upper === "number" && typeof reportJson.summary.lower === "number", "样本必须能算出上/下限");
    const upperIndex = visible.indexOf(upperText);
    const lowerIndex = visible.indexOf(lowerText);
    assert.ok(upperIndex !== -1, "可见文本必须含上限数字 " + upperText);
    assert.ok(lowerIndex !== -1, "可见文本必须含下限数字 " + lowerText);
    assert.ok(upperIndex < 500, "上限数字须在前 500 字（实际 " + upperIndex + "）");
    assert.ok(lowerIndex < 500, "下限数字须在前 500 字（实际 " + lowerIndex + "）");
    assert.ok(visible.indexOf("择偶上限") !== -1 && visible.indexOf("下限") !== -1, "上限/下限必须有可读标签");

    // 断言 3：披露在最前，早于任何数字
    const disclosure = reportJson.disclosure.text;
    const discIndex = visible.indexOf(disclosure);
    const firstDigit = visible.search(/[0-9]/);
    assert.ok(discIndex !== -1, "披露必须在默认可见文本里");
    assert.ok(firstDigit !== -1, "默认可见文本应至少有一个数字（上/下限）");
    assert.ok(discIndex < firstDigit, "披露必须早于任何数字（披露 " + discIndex + " vs 首个数字 " + firstDigit + "）");

    // 断言 4：折叠关闭时证据仍在 DOM，但不在可见文本
    assert.ok(dumped.indexOf("断言明细") !== -1, "折叠内容必须保留断言明细（DOM）");
    assert.ok(dumped.indexOf("aweme_id") !== -1, "折叠内容必须保留出处字段（DOM）");
    assert.equal(visible.indexOf("断言明细"), -1, "断言明细不得出现在默认可见文本");
    assert.equal(visible.indexOf("aweme_id"), -1, "aweme_id 不得出现在默认可见文本");

    // 断言 5：工程账本（规则集、计分项统计、审计计数、照片轨道）已下沉——可见文本无、DOM 有
    ["规则集", "计分项", "audit-rules 已审计", "照片轨道"].forEach((word) => {
      assert.equal(visible.indexOf(word), -1, "工程账本词「" + word + "」不得出现在默认可见文本");
      assert.ok(dumped.indexOf(word) !== -1, "工程账本词「" + word + "」必须仍在 DOM 里可展开查看");
    });

    // 断言 6：不得输出自创 S/A/B/C 结论句（D24）——默认可见文本不得出现「落在【X 档」式自创档位
    assert.equal(/落在【[SABC] 档/.test(visible), false, "默认可见文本不得出现自创 S/A/B/C 档位结论");
  } finally {
    server.close();
  }
});
