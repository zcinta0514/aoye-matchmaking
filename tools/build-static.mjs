#!/usr/bin/env node
/* 静态版构建：零 npm 依赖，Node 标准库拷贝 + 改写 import 路径。
   node tools/build-static.mjs [--photos=off|byok] [--out=dist] */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WEB = path.join(ROOT, "web");

const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const hit = argv.find((item) => item.indexOf("--" + name + "=") === 0);
  return hit ? hit.split("=").slice(1).join("=") : dflt;
}
const PHOTOS = argValue("photos", "off");
const PROXY_URL = String(argValue("proxy-url", "")).replace(/[/]+$/, "");
const OUT = path.resolve(ROOT, argValue("out", "dist"));
if (["off", "byok", "proxy"].indexOf(PHOTOS) === -1) {
  console.error("用法：node tools/build-static.mjs --photos=off|byok|proxy [--proxy-url=https://xxx.workers.dev]");
  process.exit(2);
}
if (PHOTOS === "proxy" && !/^https:[/][/]/.test(PROXY_URL)) {
  console.error("缺口：--photos=proxy 必须同时给 --proxy-url=https://<你的 worker 域名>（前端不接触任何 key）。");
  process.exit(2);
}

const LIB_FILES = ["engine.mjs", "load-browser.mjs", "city.mjs", "ruleset.mjs", "strength.mjs", "bands.mjs", "composite.mjs", "extrapolation.mjs", "facts-coverage.mjs", "sample.mjs", "validate.mjs", "labels.mjs", "portrait.mjs", "pipeline.mjs"];
const DATA_FILES = [
  ["knowledge", "rules.json"], ["knowledge", "facts.json"], ["knowledge", "evidence-independence.json"],
  ["knowledge", "evidence-quality-flags.json"], ["knowledge", "cases.json"], ["knowledge", "standards.json"],
  ["web/config", "baseline-rules.json"], ["web/config", "form-fields.json"], ["web/config", "cities.json"],
  ["web/config", "band-criteria.json"], ["web/config", "composite-criteria.json"], ["web/config", "composite-mapping.json"],
  ["web/config", "portrait-rules.json"],
  ["web/config", "extrapolation-rules.json"]
];

function shimImports(code) {
  return code
    .replace(/import fs from "node:fs";/g, 'import { fsShim as fs } from "./load-browser.mjs";')
    .replace(/import path from "node:path";/g, 'import { pathShim as path } from "./load-browser.mjs";')
    .replace(/import crypto from "node:crypto";/g, 'import { cryptoShim as crypto } from "./load-browser.mjs";')
    .replace(/import { fileURLToPath } from "node:url";/g, 'import { fileURLToPath } from "./load-browser.mjs";');
}

function rewritePipeline(code) {
  const lines = code.split(String.fromCharCode(10));
  const startIndex = lines.findIndex((line) => line.indexOf("const WEB_DIR = ") === 0);
  const endIndex = lines.findIndex((line) => line.indexOf("const DEFAULT_BAND_CRITERIA = ") === 0);
  if (startIndex === -1 || endIndex === -1) throw new Error("pipeline 路径常量定位失败");
  const constants = [
    "const WEB_DIR = " + JSON.stringify("data") + ";",
    "const REPO_ROOT = " + JSON.stringify("data") + ";",
    "const DEFAULT_INDEPENDENCE = " + JSON.stringify("data/evidence-independence.json") + ";",
    "const DEFAULT_EXTRAPOLATION = " + JSON.stringify("data/extrapolation-rules.json") + ";",
    "const DEFAULT_COMPOSITE_CRITERIA = " + JSON.stringify("data/composite-criteria.json") + ";",
    "const DEFAULT_COMPOSITE_MAPPING = " + JSON.stringify("data/composite-mapping.json") + ";",
    "const DEFAULT_QUALITY_FLAGS = " + JSON.stringify("data/evidence-quality-flags.json") + ";",
    "const DEFAULT_BAND_CRITERIA = " + JSON.stringify("data/band-criteria.json") + ";",
    "const DEFAULT_STANDARDS = " + JSON.stringify("data/standards.json") + ";",
    "const DEFAULT_PORTRAIT_RULES = " + JSON.stringify("data/portrait-rules.json") + ";"
  ];
  let out = lines.slice(0, startIndex).concat(constants, lines.slice(endIndex + 1)).join(String.fromCharCode(10));
  out = out.replace(/import path from "node:path";/g, "").replace(/import { fileURLToPath } from "node:url";/g, "");
  if (out.indexOf("path.") !== -1) throw new Error("pipeline 仍残留 path.* 用法");
  if (out.indexOf("fileURLToPath") !== -1) throw new Error("pipeline 仍残留 fileURLToPath");
  return shimImports(out);
}
function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function write(rel, content) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function main() {
  rmrf(OUT);
  fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "lib"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "data"), { recursive: true });

  // HTML + CSS
  ["index.html", "report.html"].forEach((name) => {
    let html = fs.readFileSync(path.join(WEB, "public", name), "utf8");
    html = html
      .replace(/href="[/]styles.css"/g, 'href="assets/styles.css"')
      .replace(/src="[/]app.js"/g, 'src="assets/app.js"')
      .replace(/src="[/]report.js"/g, 'src="assets/report.js"')
      .replace(/href="[/]"/g, 'href="index.html"'); // GitHub Pages 子路径下 "/" 会跳到站点根
    write(name, html);
  });
  write("assets/styles.css", fs.readFileSync(path.join(WEB, "public", "styles.css"), "utf8"));

  // lib
  LIB_FILES.forEach((name) => {
    let code = fs.readFileSync(path.join(WEB, "lib", name), "utf8");
    code = name === "pipeline.mjs" ? rewritePipeline(code) : shimImports(code);
    write(path.join("lib", name), code);
  });
  write("lib/util.mjs", fs.readFileSync(path.join(WEB, "static", "util-browser.mjs"), "utf8").replace('from "../lib/load-browser.mjs"', 'from "./load-browser.mjs"'));
  const providerFile = PHOTOS === "byok" ? "provider-byok.mjs" : (PHOTOS === "proxy" ? "provider-proxy.mjs" : "provider-off.mjs");
  let providerCode = fs.readFileSync(path.join(WEB, "static", providerFile), "utf8");
  if (PHOTOS === "proxy") providerCode = providerCode.split("__PROXY_URL__").join(PROXY_URL);
  write("lib/provider.mjs", providerCode);

  // 前端入口
  write("assets/app.js", fs.readFileSync(path.join(WEB, "static", "app.js"), "utf8").split("__PHOTOS_MODE__").join(PHOTOS));
  const reportSource = fs.readFileSync(path.join(WEB, "public", "report.js"), "utf8");
  const mainIndex = reportSource.indexOf("function main() {");
  if (mainIndex === -1) throw new Error("report.js 未找到 main()");
  const staticMain = fs.readFileSync(path.join(WEB, "static", "report-main.js"), "utf8");
  // 与 HTML 的 href="/" 改写同因：GitHub Pages 子路径下 "/" 会跳到站点根。
  // 本地版走 /r/<id> 路由必须保留 "/"；仅静态产物改写为 index.html。
  write("assets/report.js", (reportSource.slice(0, mainIndex) + staticMain).replace(/href='[/]'/g, "href='index.html'"));

  // data
  DATA_FILES.forEach(([from, name]) => {
    const src = from === "knowledge" ? path.join(ROOT, "knowledge", name) : path.join(WEB, "config", name);
    if (!fs.existsSync(src)) { console.warn("  [skip] 缺少数据文件：" + src); return; }
    fs.copyFileSync(src, path.join(OUT, "data", name));
  });

  // 安全与体积检查
  const problems = [];
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      files.push(full);
      const rel = path.relative(OUT, full);
      if (/(^|[/]).env/.test(rel)) problems.push("包含环境文件：" + rel);
      if (/^sk-[A-Za-z0-9_-]{8,}/m.test(fs.readFileSync(full, "utf8"))) problems.push("疑似包含 key（sk- 前缀）：" + rel);
      const content = fs.readFileSync(full, "utf8");
      if (content.indexOf("AOYE_ACCESS_CODE") !== -1) problems.push("包含服务端访问码变量名： " + rel);
      if (process.env.AOYE_ACCESS_CODE && content.indexOf(process.env.AOYE_ACCESS_CODE) !== -1) problems.push("包含真实访问码值：" + rel);
      if (/data[/](video|transcripts)/.test(rel)) problems.push("包含语料目录：" + rel);
    });
  })(OUT);

  const bytes = files.reduce((acc, file) => acc + fs.statSync(file).size, 0);
  console.log("=== 静态构建完成 ===");
  console.log("  输出目录 : " + OUT + (fs.existsSync(OUT) ? "" : "（缺失！）"));
  console.log("  照片模式 : " + PHOTOS + (PHOTOS === "off" ? "（公开版不含模型调用）" : (PHOTOS === "byok" ? "（用户自填 key，直连其服务商）" : "（本站 Worker 代理：" + PROXY_URL + "）")));
  console.log("  文件数   : " + files.length + " / 体积 " + (bytes / 1024 / 1024).toFixed(2) + " MB");
  console.log("  数据文件 : " + fs.readdirSync(path.join(OUT, "data")).join(", "));
  if (problems.length) {
    console.error("  [FAIL] 安全检查未通过：");
    problems.forEach((item) => console.error("    - " + item));
    process.exit(1);
  }
  console.log("  安全检查 : ✓ 无 sk- 字符串 / 无 .env / 无语料目录 / 无访问码");
}

main();
