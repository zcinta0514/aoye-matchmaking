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
import { assertPortraitTextAllowed, individualCaseCategories } from "../lib/portrait.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;

const ruleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
const cities = loadCities(path.join(WEB_DIR, "config", "cities.json"));
const standards = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "knowledge", "standards.json"), "utf8")).standards || [];
const standardIds = new Set(standards.map((item) => item.id));
const bandIds = new Set((ruleset.bands || []).map((item) => item.id));
const ruleIds = new Set((ruleset.rules || []).map((item) => item.id));
const portraitDoc = JSON.parse(fs.readFileSync(path.join(WEB_DIR, "config", "portrait-rules.json"), "utf8"));

async function makeReport(form) {
  const info = cityTierInfo(form.city, cities);
  return generateReport({ form: form, photos: [], ruleset: ruleset, cities: cities, cityTier: info.tier, cityMatched: info.matched, config: { configured: false } });
}

test("语义类别校验：条件 / 偏好 / 渠道分节，回归用例必须离开「能配上的」", async () => {
  /* 每条条目必须声明合法语义类别；文本特征也要过校验（不能只靠主语声明）。 */
  const VALID = ["target-attribute", "target-preference", "subject-requirements", "channel", "none"];
  portraitDoc.items.forEach((item) => assert.ok(VALID.indexOf(item.category) !== -1, "条目必须声明合法 category：" + item.id));
  assert.ok(portraitDoc.items.some((item) => item.category === "target-preference"), "配置里必须保留「对方/市场看重你什么」类条目");
  assert.ok(portraitDoc.items.some((item) => item.category === "channel"), "配置里必须保留渠道类条目");

  const sample = buildSample(path.join(REPO_ROOT, "knowledge", "cases.json"), "C-022");
  const report = await makeReport(sample.form);
  const c = report.portrait.concrete;
  /* 条件段只能出现 target-attribute，且不得含偏好/要求用语（旧版那两条就在这里骗过了校验）。 */
  c.upper.concat(c.lower).forEach((item) => {
    assert.equal(item.category, "target-attribute", "「能配上的/保底的」只能出现对方条件条目：" + item.id);
    assert.equal(/看重你|要求你|你的|看男方|看女方|对男性的排序/.test(item.text + item.fullText), false, "条件条目不得含偏好/要求用语：" + item.id);
  });
  const attributeText = c.upper.concat(c.lower).map((item) => item.text + item.fullText).join(" ");
  assert.equal(attributeText.indexOf("女方侧的外形与颜值是市场的显性定价维度"), -1, "回归：市场定价口径不得出现在「能配上的」");
  assert.equal(attributeText.indexOf("对男性的排序"), -1, "回归：「她看重你什么」不得出现在「能配上的」");
  assert.equal(attributeText.indexOf("想找的是 1 米 65"), -1, "回归：需求侧链条转述不得出现在「能配上的」");

  /* 新节：对方 / 市场更看重你什么——必须承接上面被拦下的两条，且带方向词。 */
  assert.ok(c.preferences.length >= 2, "新节必须承接偏好类条目，实际 " + c.preferences.length);
  c.preferences.forEach((item) => {
    assert.ok(["target-preference", "subject-requirements"].indexOf(item.category) !== -1, "偏好节类别非法：" + item.id);
    assert.ok(/看|优先|首看|排序|要求|建议/.test(item.text + item.fullText), "偏好类条目必须含方向词：" + item.id);
  });
  const prefIds = c.preferences.map((item) => item.id).join(",");
  const prefText = c.preferences.map((item) => item.text + item.fullText).join(" ");
  assert.ok(prefIds.indexOf("PREF-MARKET-VALUE") !== -1, "市场看你的条目必须在新节：" + prefIds);
  assert.ok(prefIds.indexOf("UP-HEIGHT-DIRECTION") !== -1, "她看你的排序条目必须在新节：" + prefIds);
  assert.ok(prefText.indexOf("对男性的排序") !== -1, "回归：「她看重你什么」必须出现在新节");
  assert.ok(prefText.indexOf("市场看你的第一维度") !== -1, "市场口径必须落到「看你」的措辞上");

  /* 渠道单独一节，不与条件混排。 */
  assert.ok(c.channels.length >= 1, "渠道类必须单独成节");
  c.channels.forEach((item) => assert.equal(item.category, "channel", "渠道节类别非法：" + item.id));
  assert.equal(c.lower.some((item) => item.category !== "target-attribute"), false, "保底的不得混入渠道条目");
});

test("个体案例拦截（扩展维度）：真人条件单含肤色/身材/年龄组合也必须构建失败", () => {
  /* 上一轮漏网的条目：02/03 年（年龄）+ 1 米 7 多（身高）+ 白（肤色）+ 身材好（身材）——
     旧的五维检测只命中 2 类，放过了；扩展后必须拦住。 */
  const leaked = "男方向下兼容的典型可得画像（语料口径）：02/03 年、普通条件、1 米 7 多、白、性格好、身材好——只需不负债、不拖累";
  const extendedHits = individualCaseCategories(leaked, { extended: true });
  assert.ok(extendedHits.indexOf("身高") !== -1 && extendedHits.indexOf("年龄") !== -1, "必须命中身高与年龄：" + JSON.stringify(extendedHits));
  assert.ok(extendedHits.indexOf("肤色") !== -1 && extendedHits.indexOf("身材") !== -1, "必须命中肤色与身材：" + JSON.stringify(extendedHits));
  assert.ok(extendedHits.length >= 3, "命中类别必须 ≥3：" + JSON.stringify(extendedHits));
  assert.throws(() => assertPortraitTextAllowed(leaked, "LOW-DOWNWARD-PROFILE", { extended: true }), /个体案例数字组合/, "条件单必须被拒绝构建");

  /* 措辞类排除：偏好/排序句天然枚举多个维度，用基础维度检测、不得误伤。 */
  const ranking = "30 岁以上事业有成的男性把性格列第一（择偶排序）；性格好在婚恋市场上大于颜值、学历、工作能力甚至家庭";
  assert.deepEqual(individualCaseCategories(ranking), ["年龄"], "排序句在基础检测下只应命中年龄");
  assert.equal(assertPortraitTextAllowed(ranking, "PREF-PERSONALITY-F"), true, "排序句不得被误伤");

  /* 改后的机制条目（不含条件单）必须放行。 */
  const mechanism = "语料里提到一条机制：当一方条件明显占优时，可以只要求对方「不负债、不拖累」，其余项不设硬条件——不列具体条件单";
  assert.equal(assertPortraitTextAllowed(mechanism, "LOW-DOWNWARD-PROFILE", { extended: true }), true, "机制条目必须放行");
});

test("个体案例拦截：真人条件单（身高+体重+学历+收入）必须构建失败", () => {
  const bad = "语料里的「普通画像」实例：本地独生女、1 米 68 / 100 斤、专升本文凭、月入 3500、物欲低 / 情绪稳定";
  assert.deepEqual(individualCaseCategories(bad), ["身高", "体重", "收入", "学历"], "必须先识别出四类数字条件");
  assert.throws(() => assertPortraitTextAllowed(bad, "LOW-SAMPLE"), /个体案例数字组合/, "命中 ≥3 类必须直接抛错");

  const typeLevel = "A7.2 登记口径：独生女 + 父母央企退休 + 全款房车级别的家庭";
  assert.equal(assertPortraitTextAllowed(typeLevel, "UP-ASSET-BAND-1"), true, "类型/等级描述不应被拦");
  const chain = "有车有房、1 米 75 以上的男生，想找的是 1 米 65 以上、工作稳定、长相过得去的女生";
  assert.equal(assertPortraitTextAllowed(chain, "UP-HEIGHT-CHAIN"), true, "链条转述只含身高一类，由方向校验拦截而不是个体案例校验");
});

test("具象画像：条目可溯源、缺输入 / 语料无口径必须区分", async () => {
  const sample = buildSample(path.join(REPO_ROOT, "knowledge", "cases.json"), "C-022");
  const report = await makeReport(sample.form);
  const portrait = report.portrait.concrete;
  assert.ok(portrait && portrait.self.length > 10, "必须有「你的定位」");
  assert.ok(portrait.upper.length >= 2 && portrait.upper.length <= 5, "上限画像（对方条件）应为 2–5 条，实际 " + portrait.upper.length);
  assert.ok(portrait.lower.length >= 1 && portrait.lower.length <= 5, "保底画像（对方条件）应为 1–5 条，实际 " + portrait.lower.length);

  portrait.upper.concat(portrait.lower).forEach((item) => {
    assert.ok(item.text && item.text.length > 0, "条目必须有文本：" + item.id);
    assert.ok((item.sourceIds || []).length > 0, "条目必须有来源 id：" + item.id);
    const resolvable = item.sourceIds.some((id) => standardIds.has(id) || bandIds.has(id) || ruleIds.has(id));
    assert.ok(resolvable, "来源必须对到 standards/rules/bands：" + item.id);
    assert.ok((item.evidence || []).length > 0, "条目必须带语料证据：" + item.id);
    assert.equal(/[SABC] 档/.test(item.text + item.fullText), false, "不得出现自创 S/A/B/C 分级：" + item.id);
    assert.equal(/\bD\d{1,2}\b/.test(item.text + item.fullText), false, "不得出现内部决策编号：" + item.id);
    assert.equal(item.text.length <= 68, true, "条目文本必须紧凑（≤68 字）：" + item.id);
  });

  /* 长相：方向性口径在「对方/市场更看重你什么」一节（v1.3 修正，见 OPEN-QUESTIONS §07 修正） */
  const prefLooks = portrait.preferences.filter((item) => item.dimension === "身高/长相");
  assert.ok(prefLooks.length >= 1, "男性侧必须有身高/长相的偏好类条目，实际 " + prefLooks.length);
  assert.ok(prefLooks.some((item) => item.id.indexOf("UP-HEIGHT-DIRECTION") === 0), "必须有「女看男排序」方向条目");
  assert.ok(!/\d+\s*米\s*\d|厘米|cm/.test(prefLooks.map((item) => item.text).join(" ")), "方向性条目不得编造数字门槛");

  /* 缺口必须区分「缺输入」与「语料没有口径」，并给出可解锁的提示 */
  const missing = portrait.missing;
  assert.ok(missing.length > 0, "无法给出的维度必须显式列出");
  missing.forEach((item) => assert.ok(["missing-input", "corpus-no-basis"].indexOf(item.reason) !== -1, "缺口原因必须是两类之一：" + item.dimension));
  const occupation = missing.find((item) => item.dimension === "职业/身份");
  assert.ok(occupation && occupation.reason === "missing-input", "职业身份必须归为「缺输入」");
  assert.ok(/打分局名次|活动类型/.test(occupation.detail), "职业身份缺口必须点出缺哪个输入");
  const looksGap = missing.find((item) => item.dimension === "身高/长相");
  assert.ok(looksGap && looksGap.reason === "corpus-no-basis", "对方长相没有条件口径，必须留在缺口里");
  assert.ok(/方向性口径|看不出来/.test(looksGap.detail) || looksGap.detail.indexOf("对方 / 市场更看重你什么") !== -1, "缺口说明必须指点到偏好节");
  /* 定位行去重：不得同时出现「家庭资产 A7 档」与「档位 A7 资产档」 */
  assert.equal(portrait.self.indexOf("家庭资产 A7"), -1, "档位名已含资产档时不得重复输出家庭资产");
  assert.ok(portrait.self.indexOf("档位 A7 资产档") !== -1);
  console.log("[portrait] 条件 " + portrait.upper.length + "+" + portrait.lower.length + " / 渠道 " + portrait.channels.length + " / 偏好 " + portrait.preferences.length + " / 缺口 " + missing.length);
});

test("具象画像（女性侧）：长相没有可用方向条目时仍标「语料没有对应口径」", async () => {
  const woman = { gender: "female", age: 29, city: "杭州", height_cm: 163, weight_kg: 52, education: "master", school_tier: "211", occupation: "gov", income_wan: 22, has_house: "loan", has_car: "none", hukou: "local", marital: "single", family_origin: "urban_normal", siblings: "only", family_wealth: "a7", want_gender: "male" };
  const report = await makeReport(woman);
  const missing = report.portrait.concrete.missing;
  const looks = missing.find((item) => item.dimension === "身高/长相");
  assert.ok(looks && looks.reason === "corpus-no-basis", "女性侧长相必须归为「语料没有口径」");
  assert.ok(/方向|数字门槛/.test(looks.detail), "缺口说明必须写明「只有方向、没有数字门槛」");
  assert.ok(report.portrait.concrete.preferences.some((item) => item.id.indexOf("UP-VALUE-DIRECTION") === 0), "女性侧应有「市场看你的第一组维度」偏好条目");
});

test("具象画像：缺家庭资产输入时门当户对条目不出现，但缺口照实列出", async () => {
  const minimal = {
    gender: "male", age: 30, city: "杭州", height_cm: 178, education: "bachelor", school_tier: "985",
    occupation: "private", income_wan: 40, has_house: "loan", has_car: "mid", hukou: "local", marital: "single",
    family_origin: "urban_normal", siblings: "only", want_gender: "female"
  };
  const report = await makeReport(minimal);
  const portrait = report.portrait.concrete;
  assert.ok(portrait.upper.concat(portrait.lower).every((item) => item.id.indexOf("LOW-DOOR") === -1), "没有家庭资产输入时不得输出门当户对量化条目");
  assert.ok(portrait.missing.length > 0, "无法给出的维度必须显式列出");
  assert.ok(portrait.lower.length >= 0 && portrait.channels.length >= 1, "缺家庭资产时条件段可为空，但渠道节仍应有通用条目");
});

function dumpReportPage(baseUrl, id, userDataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + userDataDir, "--virtual-time-budget=4000", "--dump-dom", baseUrl + "/r/" + id]);
    let out = "";
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { child.kill(); } catch { /* ignore */ } resolve(out); };
    child.stdout.on("data", (chunk) => { out += chunk.toString(); if (out.indexOf("</html>") !== -1 && out.indexOf("hero-portrait") !== -1) finish(); });
    child.on("exit", finish);
    child.on("error", reject);
    setTimeout(() => { child.kill(); }, 15000);
  });
}

test("具象画像：报告页 hero 区必须渲染定位 / 两段画像 / 缺口说明", { skip: CHROME ? false : "未找到 Chrome（可设 CHROME_PATH）" }, async () => {
  const sample = buildSample(path.join(REPO_ROOT, "knowledge", "cases.json"), "C-022");
  const report = await makeReport(sample.form);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-portrait-data-"));
  fs.writeFileSync(path.join(dir, "reports.json"), JSON.stringify({ [report.id]: report }));
  process.env.AOYE_DATA_DIR = dir;
  const { startServer } = await import("../server.mjs");
  const { server, baseUrl } = await startServer(0, "127.0.0.1");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-portrait-chrome-"));
  try {
    const dumped = await dumpReportPage(baseUrl, report.id, userDataDir);
    ["你的定位", "能配上的（参考）", "保底的（参考）", "覆盖说明：为什么有些维度没有", "补上「", "可解锁"].forEach((text) => {
      assert.ok(dumped.indexOf(text) !== -1, "报告页必须渲染：" + text);
    });
    assert.ok(dumped.indexOf("basis-details") !== -1, "溯源必须可展开");
    assert.ok(dumped.indexOf("S-ASSET-006") !== -1, "折叠里必须能查到来源 id");
    assert.ok(dumped.indexOf("可以找他们家的家庭是你们家100%到200%的。") !== -1, "折叠里必须能查到证据原文");
  } finally {
    server.close();
  }
});
