import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
const PROXY_URL = "https://proxy.test.example";
const CODE_KEY = "aoye:access_code";

function buildProxy(outDir) {
  const result = spawnSync(process.execPath, ["tools/build-static.mjs", "--photos=proxy", "--proxy-url=" + PROXY_URL, "--out=" + outDir], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); }
  };
}

test("静态代理适配层：带 x-aoye-code；401/503 有可读提示；产物不含访问码", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-access-"));
  buildProxy(out);
  const providerSource = fs.readFileSync(path.join(out, "lib", "provider.mjs"), "utf8");
  assert.ok(providerSource.indexOf("x-aoye-code") !== -1, "代理适配层必须发送访问码头");
  assert.equal(/x-aoye-code["']\s*:\s*["'][A-Za-z0-9_-]{6,}["']/.test(providerSource), false, "产物不得内联任何具体访问码");

  globalThis.window = { localStorage: fakeStorage() };
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: Object.assign({}, init && init.headers) });
    const status = Number(globalThis.__mockStatus || 200);
    const payload = status === 200
      ? JSON.stringify({ choices: [{ message: { content: JSON.stringify({ dimensions: [], anchorFits: [], dataQuality: { usable: true, issues: [] }, caveats: [] }) } }] })
      : JSON.stringify({ error: status === 401 ? "unauthorized" : "not_configured", reason: "x" });
    return new Response(payload, { status, headers: { "content-type": "application/json" } });
  };
  try {
    const provider = await import(path.join(out, "lib", "provider.mjs"));
    const options = {
      photos: [{ dataUrl: "data:image/jpeg;base64,AAAA" }],
      dimensions: [{ id: "looks.three_courts", name: "三庭比例" }],
      anchors: [],
      config: provider.providerConfig({})
    };

    globalThis.__mockStatus = 200;
    let result = await provider.analyzePhotos(options);
    assert.equal(requests[0].url, PROXY_URL + "/analyze");
    assert.equal(requests[0].headers["x-aoye-code"], undefined, "没存码时不得带空头");
    assert.equal(result.mode, "model");

    globalThis.window.localStorage.setItem(CODE_KEY, "my-secret-code");
    requests.length = 0;
    await provider.analyzePhotos(options);
    assert.equal(requests[0].headers["x-aoye-code"], "my-secret-code", "存了码必须带上");

    globalThis.__mockStatus = 401;
    result = await provider.analyzePhotos(options);
    assert.equal(result.mode, "error");
    assert.ok(result.caveats.join(" ").indexOf("访问码不正确") !== -1, "401 必须提示访问码不对");
    assert.equal(JSON.stringify(result).indexOf("my-secret-code"), -1, "结果/日志不得回显访问码");

    globalThis.__mockStatus = 503;
    result = await provider.analyzePhotos(options);
    assert.equal(result.mode, "error");
    assert.ok(result.caveats.join(" ").indexOf("代理暂不可用") !== -1, "503 必须给可读提示");
  } finally {
    delete globalThis.__mockStatus;
  }
});

function staticServer(rootDir) {
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8" };
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.join(rootDir, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(rootDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

function dumpDom(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + fs.mkdtempSync(path.join(os.tmpdir(), "aoye-access-chrome-")), "--virtual-time-budget=6000", "--dump-dom", url]);
    let out = "";
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { child.kill(); } catch { /* ignore */ } resolve(out); };
    child.stdout.on("data", (chunk) => { out += chunk.toString(); if (out.indexOf("</html>") !== -1 && out.indexOf("access-code-panel") !== -1) finish(); });
    child.on("exit", finish);
    child.on("error", reject);
    setTimeout(() => { child.kill(); finish(); }, 15000);
  });
}

test("dist 表单页（proxy）：首次使用显示访问码输入框、入口可重填、照片单选一张", { skip: CHROME ? false : "未找到 Chrome（可设 CHROME_PATH）" }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-access-ui-"));
  buildProxy(out);
  const indexHtml = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.ok(indexHtml.indexOf("这个工具是私人的") !== -1, "首页必须包含访问码提示文案");
  const appSource = fs.readFileSync(path.join(out, "assets", "app.js"), "utf8");
  assert.ok(appSource.indexOf("首次使用：这个工具是私人的") !== -1, "首次使用必须出现输入框");
  assert.ok(appSource.indexOf("slice(0, 1)") !== -1, "前端照片数必须限为 1 张");

  const server = staticServer(out);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const dom = await dumpDom("http://127.0.0.1:" + server.address().port + "/index.html");
    assert.ok(dom.indexOf('id="access-code-panel"') !== -1, "必须渲染访问码面板");
    assert.equal(dom.indexOf('id="access-code-panel" class="card hidden"'), -1, "首次使用面板不得隐藏");
    assert.equal(dom.indexOf('id="access-code-link" class="hidden"'), -1, "访问码入口必须可见（可重填/重置）");
    assert.equal(/id="photo-input"[^>]*multiple/.test(dom), false, "照片输入不得再支持多选");
    assert.ok(dom.indexOf("照片（1 张") !== -1, "照片文案必须写清单张");
  } finally {
    server.close();
  }
});
