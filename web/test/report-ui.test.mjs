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

process.env.AOYE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-ui-test-"));

function stripDetails(html) {
  let text = html;
  const pattern = new RegExp("<details\\b[^>]*>[\\s\\S]*?<\/details>", "g");
  let previous = null;
  while (previous !== text) {
    previous = text;
    text = text.replace(pattern, "");
  }
  return text;
}

function countBadges(html) {
  const single = html.match(/class='str str-/g) || [];
  const double = html.match(/class="str str-/g) || [];
  return single.length + double.length;
}

test("A1 折叠灰标：默认视图徽标大幅减少，展开后信息完整", { skip: CHROME ? false : "未找到 Chrome（可设 CHROME_PATH）" }, async () => {
  const { startServer } = await import("../server.mjs");
  const { server, baseUrl } = await startServer(0, "127.0.0.1");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-chrome-"));
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
    assert.equal(reportJson.disclosure.required, true);
    const dumped = await new Promise((resolve, reject) => {
      const child = spawn(CHROME, [
        "--headless=new", "--disable-gpu", "--no-first-run",
        "--user-data-dir=" + userDataDir,
        "--virtual-time-budget=4000",
        "--dump-dom",
        baseUrl + "/r/" + id
      ]);
      let out = "";
      let err = "";
      let settled = false;
      const finish = () => { if (settled) return; settled = true; try { child.kill(); } catch { /* ignore */ } resolve(out); };
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
        if (out.indexOf("</html>") !== -1) finish();
      });
      child.stderr.on("data", (chunk) => { err += chunk.toString(); });
      child.on("exit", () => finish());
      child.on("error", reject);
      setTimeout(() => { child.kill(); }, 15000);
    });

    assert.ok(dumped.indexOf("博主档位阶梯") !== -1, "报告页必须渲染（DOM 输出）：" + dumped.slice(0, 200));
    const visibleHtml = stripDetails(dumped);
    const visibleBadges = countBadges(visibleHtml);
    const totalBadges = countBadges(dumped);
    console.log("[A1] 默认视图可见徽标: " + visibleBadges + " / 全部徽标: " + totalBadges + "（折叠率 " + Math.round((1 - visibleBadges / totalBadges) * 100) + "%）");
    assert.ok(visibleBadges < 60, "默认视图可见徽标必须大幅下降（实际 " + visibleBadges + " / 总 " + totalBadges + "）");
    assert.ok(totalBadges > visibleBadges, "折叠内容必须仍然存在于 DOM 中");

    // 展开后信息完整：单源文案、断言明细、出处（aweme_id）都在被折叠的内容里
    assert.ok(dumped.indexOf("机构内单源") !== -1, "折叠内容必须保留机构内单源标注");
    assert.ok(dumped.indexOf("断言明细") !== -1, "折叠内容必须保留断言明细");
    assert.ok(/aweme_id|[0-9]{15,}/.test(dumped), "折叠内容必须保留出处");
    assert.ok(dumped.indexOf("basis-details") !== -1, "必须存在可展开的行内「依据」标记");
    assert.ok(dumped.indexOf("toggle-basis") !== -1, "必须有「展开全部依据」开关");
    assert.ok(dumped.indexOf("section-details") !== -1, "附录（证据/体系参考）默认折叠");
    // D30：全局披露必须直接可见（不在任何 details 里，折叠开关无法隐藏）
    const disclosure = reportJson.disclosure.text;
    assert.ok(disclosure.indexOf("同一商业机构") !== -1);
    assert.ok(dumped.indexOf(disclosure) !== -1, "前端渲染的披露必须与 JSON 完全一致（防漂移）");
    assert.ok(dumped.indexOf("audit-rules 已审计") !== -1, "必须展示已审计/未审计计数");
    assert.ok(visibleHtml.indexOf(disclosure) !== -1, "全局披露不得被折叠隐藏");
    assert.ok(dumped.indexOf(disclosure) < dumped.indexOf("个计分项"), "披露必须出现在任何数字之前");

    // D30：显示名改口径（机构内），旧名不得出现在徽标里
    assert.ok(dumped.indexOf("机构内多源一致") !== -1, "必须使用新显示名");
    assert.equal(dumped.indexOf("单源·未独立验证"), -1, "旧显示名不得出现");
    assert.equal(dumped.indexOf("跨账号互证"), -1, "旧显示名不得出现");
    assert.equal(dumped.indexOf(">有据<"), -1, "旧显示名（有据）不得出现");

    // D30：首页短版披露
    const indexHtml = await (await fetch(baseUrl + "/")).text();
    assert.ok(indexHtml.indexOf("证据均来自同一机构（鳌烨传媒）的公开内容") !== -1, "首页必须有短版披露");
  } finally {
    server.close();
  }
});
