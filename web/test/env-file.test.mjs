import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnvLocal, safeBaseUrl } from "../lib/env-file.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);

function writeEnvLocal(lines, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-env-"));
  const file = path.join(dir, ".env.local");
  fs.writeFileSync(file, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
  fs.chmodSync(file, mode === undefined ? 0o600 : mode);
  return file;
}

test(".env.local：解析、只收 AOYE_LLM_*、环境变量优先、忽略注释与空行", () => {
  const file = writeEnvLocal([
    "# 注释",
    "",
    "AOYE_LLM_BASE_URL=https://api.example-provider.test/v1",
    "AOYE_LLM_API_KEY=sk-file-value",
    "AOYE_LLM_MODEL=file-model",
    "PATH=/evil/bin",
    "OTHER_SECRET=nope"
  ]);
  const env = { AOYE_LLM_MODEL: "env-wins-model" };
  const result = loadEnvLocal(file, env);
  assert.equal(result.loaded, true);
  assert.equal(env.AOYE_LLM_API_KEY, "sk-file-value", "文件键应生效");
  assert.equal(env.AOYE_LLM_BASE_URL, "https://api.example-provider.test/v1");
  assert.equal(env.AOYE_LLM_MODEL, "env-wins-model", "已存在的环境变量优先");
  assert.deepEqual(result.applied.sort(), ["AOYE_LLM_API_KEY", "AOYE_LLM_BASE_URL"]);
  assert.deepEqual(result.skippedExisting, ["AOYE_LLM_MODEL"]);
  assert.deepEqual(result.ignoredKeys, ["PATH", "OTHER_SECRET"], "只允许 AOYE_LLM_* 注入");
  assert.equal(env.PATH === "/evil/bin", false, "非 AOYE_LLM_* 键不得注入进程环境");
});

test(".env.local：文件缺失不报错；权限过宽只告警不阻止", () => {
  const missing = loadEnvLocal(path.join(os.tmpdir(), "definitely-missing-" + Date.now() + ".env.local"), {});
  assert.equal(missing.loaded, false);
  assert.deepEqual(missing.warnings, []);

  const loose = writeEnvLocal(["AOYE_LLM_API_KEY=sk-x"], 0o644);
  const result = loadEnvLocal(loose, {});
  assert.equal(result.loaded, true);
  assert.ok(result.warnings.some((warning) => warning.indexOf("chmod 600") !== -1), "644 必须提示 chmod 600");

  const tight = writeEnvLocal(["AOYE_LLM_API_KEY=sk-x"], 0o600);
  assert.deepEqual(loadEnvLocal(tight, {}).warnings, []);
});

test("safeBaseUrl：只保留协议 + 域名（路径与 query 不回显）", () => {
  assert.equal(safeBaseUrl("https://api.example.com/v1/secret?token=abc"), "https://api.example.com");
  assert.equal(safeBaseUrl("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080");
  assert.equal(safeBaseUrl("not a url"), "(无法解析的 base_url)");
});

test("启动日志：不回显 key 与 base_url 路径", async () => {
  const fakeKey = "sk-test-DEADBEEF-1234567890";
  const file = writeEnvLocal([
    "AOYE_LLM_BASE_URL=https://api.example-provider.test/v1/secret-path?token=hidden",
    "AOYE_LLM_API_KEY=" + fakeKey,
    "AOYE_LLM_MODEL=stub-model"
  ]);
  const child = spawn(process.execPath, ["web/server.mjs"], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, {
      PORT: "0", HOST: "127.0.0.1",
      AOYE_ENV_FILE: file,
      AOYE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "aoye-env-data-")),
      AOYE_LLM_API_KEY: "", AOYE_LLM_BASE_URL: "", AOYE_LLM_MODEL: ""
    })
  });
  const output = await new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buffer); } };
    const timer = setTimeout(() => { child.kill(); finish(); }, 8000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.indexOf("http://127.0.0.1:") !== -1) { clearTimeout(timer); child.kill(); finish(); }
    });
    child.stderr.on("data", (chunk) => { buffer += chunk.toString(); });
    child.on("exit", () => { clearTimeout(timer); finish(); });
  });
  assert.ok(output.indexOf("已加载") !== -1, "必须打印已加载 .env.local");
  assert.equal(output.indexOf(fakeKey), -1, "启动日志不得出现 key 的任何部分");
  assert.equal(output.indexOf("DEADBEEF"), -1);
  assert.equal(output.indexOf("secret-path"), -1, "base_url 路径不得回显");
  assert.equal(output.indexOf("hidden"), -1, "base_url query 不得回显");
  assert.ok(output.indexOf("api.example-provider.test") !== -1, "只回显域名");
});
