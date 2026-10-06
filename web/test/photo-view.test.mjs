import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "../lib/ruleset.mjs";
import { loadCities, cityTierInfo } from "../lib/city.mjs";
import { generateReport } from "../lib/pipeline.mjs";
import { buildSample } from "../lib/sample.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-photo-view-"));
process.env.AOYE_DATA_DIR = DATA_DIR;
const PHOTO_FILE = path.join(DATA_DIR, "test-photo.jpg");
fs.writeFileSync(PHOTO_FILE, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

function stripAllDetails(html) {
  let text = html;
  const pattern = new RegExp("<details\\b[^>]*>[\\s\\S]*?<\\/details>", "g");
  let previous = null;
  while (previous !== text) { previous = text; text = text.replace(pattern, ""); }
  return text;
}

/* 默认视图（折叠关闭）：顶层 details 只留 summary；嵌套 details 整段丢弃。 */
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

function textOf(html) {
  let text = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/g, " ");
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, " ");
  text = text.replace(/<\/(p|li|tr|div|h1|h2|h3|h4|summary|td|blockquote|ul|table)>/g, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
  return text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function visibleWithTitles(dumped) { return textOf(collapseDetails(dumped.replace(/<head\b[^>]*>[\s\S]*?<\/head>/g, " "))); }
function visibleWithoutTitles(dumped) { return textOf(stripAllDetails(dumped.replace(/<head\b[^>]*>[\s\S]*?<\/head>/g, " "))); }

function makePhotoFixture(dims) {
  return {
    dimensions: dims.map((dim, index) => ({
      id: dim.id,
      observed: index < 3 ? "正面清晰，五官比例协调" : (index < 6 ? "可见发型与衣着，整体自然" : "肩部被画面裁切，无法判断完整比例"),
      level: index < 3 ? "above" : null,
      confidence: index < 3 ? "high" : (index < 6 ? "medium" : "low")
    })),
    anchorFits: [{ label: "普通人", fit: 0.6, reason: "五官比例常规" }],
    dataQuality: { usable: false, issues: ["单张近正面近景，缺少侧脸及全身照片", "肩部、躯干与下肢被裁切", "自然光存在局部明暗差异", "无法确认是否使用滤镜或修图", "图像尺寸较小，细节不足", "胡须遮盖部分边界"] },
    caveats: ["身高、体重均不能从此图判断。", "不可观察部分不作肯定匹配。"]
  };
}

async function buildReports() {
  const ruleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
  const cities = loadCities(path.join(WEB_DIR, "config", "cities.json"));
  const sample = buildSample(path.join(REPO_ROOT, "knowledge", "cases.json"), "C-022");
  const appearanceDims = ruleset.dimensions.filter((dim) => dim.group === "appearance");
  const modelDims = appearanceDims.filter((dim) => dim._origin !== "web-baseline");
  const excludedDims = appearanceDims.filter((dim) => dim._origin === "web-baseline");
  /* fixture 必须覆盖「真正送进模型」的那批维度（降本筛掉基线维度后是 18 个）。 */
  const fixture = makePhotoFixture(modelDims);
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(fixture) } }] }) });
  const info = cityTierInfo(sample.form.city, cities);
  const common = {
    ruleset, cities, cityTier: info.tier, cityMatched: info.matched,
    config: { configured: true, apiKey: "test", baseUrl: "https://example.invalid/v1", model: "test-model", vision: "auto", jsonMode: "auto", timeoutMs: 5000, maxVisionBytes: 8 * 1024 * 1024 },
    fetchImpl
  };
  const photoReport = await generateReport(Object.assign({}, common, { form: sample.form, photos: [{ path: PHOTO_FILE, mime: "image/jpeg" }] }));
  const noPhotoReport = await generateReport(Object.assign({}, common, { form: sample.form, photos: [] }));
  return { photoReport, noPhotoReport, appearanceDims, modelDims, excludedDims };
}

function dumpReportPage(baseUrl, id, userDataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + userDataDir, "--virtual-time-budget=4000", "--dump-dom", baseUrl + "/r/" + id]);
    let out = "";
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { child.kill(); } catch { /* ignore */ } resolve(out); };
    child.stdout.on("data", (chunk) => { out += chunk.toString(); if (out.indexOf("</html>") !== -1 && out.indexOf("hero-card") !== -1) finish(); });
    child.on("exit", finish);
    child.on("error", reject);
    setTimeout(() => { child.kill(); }, 15000);
  });
}

test("照片区（有照片）：默认摘要 3 行、明细折入同一个折叠区、低置信度不当负面", { skip: CHROME ? false : "未找到 Chrome（可设 CHROME_PATH）" }, async () => {
  const { photoReport, noPhotoReport, appearanceDims, modelDims, excludedDims } = await buildReports();
  assert.equal(photoReport.appearance.photoTrack.mode, "model", "照片轨道必须走模型（stub）");
  assert.equal(photoReport.appearance.photoTrack.dimensions.length, 18, "降本后送进模型/报告的照片维度应为 18 个");
  const modeledIds = photoReport.appearance.photoTrack.dimensions.map((dim) => dim.id);
  excludedDims.forEach((dim) => assert.equal(modeledIds.indexOf(dim.id), -1, "被筛掉的演示基线维度不得出现在报告：" + dim.id));
  fs.writeFileSync(path.join(DATA_DIR, "reports.json"), JSON.stringify({ [photoReport.id]: photoReport, [noPhotoReport.id]: noPhotoReport }));
  const { startServer } = await import("../server.mjs");
  const { server, baseUrl } = await startServer(0, "127.0.0.1");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-photo-chrome-"));
  try {
    const photoDumped = await dumpReportPage(baseUrl, photoReport.id, userDataDir);
    const noPhotoDumped = await dumpReportPage(baseUrl, noPhotoReport.id, userDataDir);
    const photoVisible = visibleWithTitles(photoDumped).join(" ");
    const photoVisibleNoTitles = visibleWithoutTitles(photoDumped).join(" ");
    const noPhotoVisible = visibleWithTitles(noPhotoDumped).join(" ");
    const noPhotoVisibleNoTitles = visibleWithoutTitles(noPhotoDumped).join(" ");
    for (const [label, text] of [["有照片", photoVisible], ["有照片(无折叠标题)", photoVisibleNoTitles], ["无照片", noPhotoVisible], ["无照片(无折叠标题)", noPhotoVisibleNoTitles]]) {
      assert.equal(/不可见|无法判断|未入镜|截断/.test(text), false, label + " 默认可见文本不得出现「不可见/无法判断/未入镜/截断」");
      assert.equal(text.split("跳过照片分析").length - 1, 0, label + " 默认可见文本不得出现「跳过照片分析」");
    }

    /* 默认摘要 3 行 + 明细折叠都在 DOM 里 */
    assert.ok(photoDumped.indexOf("照片能看出来：") !== -1, "必须有「照片能看出来」摘要行");
    assert.ok(photoDumped.indexOf("项因角度或光线所限，本次不作判断") !== -1, "必须有「不作判断 N 项」一行");
    assert.ok(photoDumped.indexOf("照片质量提醒：") !== -1, "必须有照片质量提醒一行");
    assert.ok(photoDumped.indexOf("照片能看到什么、看不到什么") !== -1, "明细必须折进「照片能看到什么、看不到什么」");
    assert.ok(photoDumped.indexOf("展开查看") !== -1, "「不作判断」的明细必须可展开");
    /* 不丢内容：全部维度、全部 caveats、全部 issues 都在 DOM */
    modelDims.forEach((dim) => assert.ok(photoDumped.indexOf(dim.name) !== -1, "折叠后必须仍能查到维度：" + dim.name));
    assert.ok(photoDumped.indexOf("逐项描述（" + modelDims.length + " 项") !== -1, "逐项描述必须保留全部（保留集的）维度数");
    assert.equal(photoDumped.indexOf("逐项描述（" + appearanceDims.length + " 项"), -1, "不得再渲染 24 维");
    assert.ok(photoDumped.indexOf("需要说明的局限（2 条）") !== -1, "全部 caveats 必须保留");
    assert.ok(photoDumped.indexOf("不可观察部分不作肯定匹配。") !== -1, "caveats 原文不得丢失");
    assert.ok(photoDumped.indexOf("照片质量提示（6 条）") !== -1, "全部 issues 必须保留");
    assert.ok(photoDumped.indexOf("肩部、躯干与下肢被裁切") !== -1, "issues 原文不得丢失");
    /* 低置信度＝信息不足，不是负面：中文标签 + 中性措辞 */
    assert.ok(photoDumped.indexOf("低（信息不足，未据此判断）") !== -1, "低置信度必须用中性人话标注");
    assert.ok(photoDumped.indexOf("高（描述明确）") !== -1 && photoDumped.indexOf("中（可参考）") !== -1, "置信度必须中文标注");
    assert.equal(photoDumped.indexOf(">low<"), -1, "不得直接把 low 原文给用户看");
    assert.equal(photoDumped.indexOf(">high<"), -1, "不得直接把 high 原文给用户看");
    /* 无照片：只留一行 */
    assert.ok(noPhotoDumped.indexOf("本次未做照片分析") !== -1, "无照片必须有一行提示");
    assert.equal(noPhotoDumped.split("逐项描述（").length - 1, 0, "无照片不得渲染逐项描述表");
    assert.equal(noPhotoDumped.split("照片质量提示（").length - 1, 0, "无照片不得渲染质量提示列表");
    console.log("[photo-view] 有照片：默认可见 " + photoVisible.split(" ").join("").length + " 字；无照片：默认可见 " + noPhotoVisible.split(" ").join("").length + " 字");
  } finally {
    server.close();
  }
});
