import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);

function build(outDir, mode) {
  return spawnSync(process.execPath, ["tools/build-static.mjs", "--photos=" + mode, "--out=" + outDir], { cwd: REPO_ROOT, encoding: "utf8" });
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test("静态构建（--photos=off）：产物完整、零密钥、无服务端依赖", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-dist-"));
  const result = build(out, "off");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  ["index.html", "report.html", "assets/app.js", "assets/report.js", "assets/styles.css", "lib/pipeline.mjs", "lib/engine.mjs", "lib/provider.mjs", "data/rules.json", "data/evidence-independence.json"].forEach((rel) => {
    assert.ok(fs.existsSync(path.join(out, rel)), "缺少 " + rel);
  });

  const files = walk(out);
  files.forEach((file) => {
    const rel = path.relative(out, file);
    assert.equal(/(^|[/]).env/.test(rel), false, "不得包含环境文件：" + rel);
    assert.equal(/data[/](video|transcripts)/.test(rel), false, "不得包含语料目录：" + rel);
    const text = fs.readFileSync(file, "utf8");
    assert.equal(/sk-[A-Za-z0-9_-]{8,}/.test(text), false, "不得包含疑似 key：" + rel);
  });

  const appSource = fs.readFileSync(path.join(out, "assets/app.js"), "utf8");
  assert.ok(appSource.indexOf("公开版未开放照片分析") !== -1, "off 模式必须有禁用提示");
  const providerSource = fs.readFileSync(path.join(out, "lib/provider.mjs"), "utf8");
  assert.equal(providerSource.indexOf("fetch("), -1, "off 模式的 provider 不得包含任何网络调用");
  const reportSource = fs.readFileSync(path.join(out, "assets/report.js"), "utf8");
  assert.ok(reportSource.indexOf("localStorage") !== -1, "静态报告页必须从 localStorage 读取");
  assert.equal(reportSource.indexOf("/api/report/"), -1, "静态产物不得依赖服务端 API");
  const pipelineSource = fs.readFileSync(path.join(out, "lib/pipeline.mjs"), "utf8");
  assert.equal(/from "node:/.test(pipelineSource + appSource + fs.readFileSync(path.join(out, "lib/ruleset.mjs"), "utf8")), false, "浏览器产物不得保留 node: 内置模块 import");
});

test("静态构建（--photos=byok）：包含 BYOK 面板与安全警告，仍零密钥", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-dist-byok-"));
  const result = build(out, "byok");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const appSource = fs.readFileSync(path.join(out, "assets/app.js"), "utf8");
  assert.ok(appSource.indexOf("无法保护它的安全") !== -1, "BYOK 必须显示安全警告");
  const providerSource = fs.readFileSync(path.join(out, "lib/provider.mjs"), "utf8");
  assert.ok(providerSource.indexOf("chat/completions") !== -1, "byok 模式允许直连用户服务商");
  const files = walk(out);
  files.forEach((file) => {
    assert.equal(/sk-[A-Za-z0-9_-]{8,}/.test(fs.readFileSync(file, "utf8")), false, "构建产物不得含 key：" + path.relative(out, file));
  });
});
test("静态构建（--photos=proxy）：必须给 --proxy-url；前端不接触任何 key", () => {
  const noUrl = spawnSync(process.execPath, ["tools/build-static.mjs", "--photos=proxy", "--out=" + fs.mkdtempSync(path.join(os.tmpdir(), "aoye-dist-nourl-"))], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(noUrl.status, 2, "缺 --proxy-url 必须构建失败");
  assert.ok((noUrl.stderr + noUrl.stdout).indexOf("--proxy-url") !== -1);

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-dist-proxy-"));
  const result = spawnSync(process.execPath, ["tools/build-static.mjs", "--photos=proxy", "--proxy-url=https://aoye-proxy.example.workers.dev", "--out=" + out], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const providerSource = fs.readFileSync(path.join(out, "lib/provider.mjs"), "utf8");
  assert.ok(providerSource.indexOf("https://aoye-proxy.example.workers.dev") !== -1, "代理地址必须注入");
  assert.ok(providerSource.indexOf("/analyze") !== -1, "必须调用代理端点");
  assert.equal(providerSource.indexOf("authorization"), -1, "前端不得携带任何授权头");
  assert.equal(providerSource.indexOf("__PROXY_URL__"), -1, "占位符必须被替换");
  walk(out).forEach((file) => {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(/sk-[A-Za-z0-9_-]{8,}/.test(text), false, "proxy 产物不得含 key：" + path.relative(out, file));
    assert.equal(text.indexOf("AOYE_LLM_API_KEY"), -1, "前端不得出现服务端密钥变量名：" + path.relative(out, file));
  });
});
