/* 测试纪律：
   - CORS 类断言必须模拟浏览器预检（OPTIONS + Access-Control-Request-Headers），不能用 curl 思维——
     真实浏览器会先预检；预检少放行一个自定义头，整个请求会被浏览器拦下，而 curl 永远测不出来。
   - 自定义头清单从 web/static/provider-proxy.mjs 的实际源码扫描，不写死字符串：
     前端新增头而 Worker 没同步时，本文件必须变红。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import worker, { LIMITS, countImages, rateLimit, resetRateBuckets, secureCompare } from "./index.js";

const FAKE_KEY = "sk-test-DEADBEEF-1234567890";
const ACCESS_CODE = "test-access-code-NOT-A-SECRET";
const ORIGIN = "https://aoye-pages.pages.dev";

function envOf(extra) {
  return Object.assign({
    AOYE_LLM_API_KEY: FAKE_KEY,
    AOYE_LLM_BASE_URL: "https://api.example-provider.test/v1",
    AOYE_LLM_MODEL: "env-model",
    AOYE_ACCESS_CODE: ACCESS_CODE,
    ALLOWED_ORIGIN: ORIGIN
  }, extra || {});
}

function requestOf(pathname, init) {
  return new Request("https://proxy.example.workers.dev" + pathname, init);
}

function analyzeRequest(body, headers) {
  return requestOf("/analyze", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7", origin: ORIGIN, "x-aoye-code": ACCESS_CODE }, headers || {}),
    body: JSON.stringify(body)
  });
}

function chatBody(imageCount, imageChars) {
  const content = [{ type: "text", text: "观察照片" }];
  for (let i = 0; i < (imageCount || 0); i += 1) {
    content.push({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + "A".repeat(imageChars || 16) } });
  }
  return { model: "client-model", temperature: 0.2, messages: [{ role: "user", content }] };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("GET /health 返回 200、不泄露 key；未配置时 configured=false", async () => {
  resetRateBuckets();
  const response = await worker.fetch(requestOf("/health"), envOf());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.configured, true);
  assert.equal(JSON.stringify(body).indexOf(FAKE_KEY), -1);

  const unconfigured = await worker.fetch(requestOf("/health"), {});
  assert.equal((await unconfigured.json()).configured, false);
});

test("正常转发：URL / Authorization / 模型覆盖 / 请求体透传 / 响应透传", async () => {
  resetRateBuckets();
  const stub = stubFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    const response = await worker.fetch(analyzeRequest(chatBody(1)), envOf());
    assert.equal(response.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "https://api.example-provider.test/v1/chat/completions");
    assert.equal(stub.calls[0].init.headers.authorization, "Bearer " + FAKE_KEY);
    const sent = JSON.parse(stub.calls[0].init.body);
    assert.equal(sent.model, "env-model", "Worker 侧模型配置应覆盖请求体");
    assert.equal(sent.messages[0].content[1].type, "image_url", "请求体应原样透传");
  } finally {
    stub.restore();
  }
});

test("超限：2 张图（上限已降为 1 张）/ 图片总量 >6MB / 请求体 >8MB → 413", async () => {
  resetRateBuckets();
  assert.equal(LIMITS.MAX_IMAGES, 1, "图片上限必须为 1 张（降本）");
  const two = await worker.fetch(analyzeRequest(chatBody(2, 16)), envOf());
  assert.equal(two.status, 413);
  assert.equal((await two.json()).error, "too_many_images");

  const bigImageBody = chatBody(1, Math.ceil((LIMITS.MAX_IMAGE_BYTES + 1024) / 0.75));
  assert.ok(countImages(bigImageBody).bytes > LIMITS.MAX_IMAGE_BYTES, "构造的图片总量必须超过图片上限");
  const bigImages = await worker.fetch(analyzeRequest(bigImageBody), envOf());
  assert.equal(bigImages.status, 413, "超量图片必须 413");
  assert.ok(["images_too_large", "payload_too_large"].indexOf((await bigImages.json()).error) !== -1, "必须是体积类拒绝（base64 膨胀下先命中请求体上限也属正常）");

  const bigBody = await worker.fetch(analyzeRequest({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(LIMITS.MAX_BODY_BYTES + 1024) }] }] }), envOf());
  assert.equal(bigBody.status, 413);
  assert.equal((await bigBody.json()).error, "payload_too_large");
});

test("限流：同 IP 第 4 次 429（带 retryAfterSec），不同 IP 不受影响", async () => {
  resetRateBuckets();
  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    for (let i = 0; i < 3; i += 1) {
      const ok = await worker.fetch(analyzeRequest(chatBody(1), { "CF-Connecting-IP": "198.51.100.1" }), envOf());
      assert.equal(ok.status, 200, "第 " + (i + 1) + " 次应通过");
    }
    const limited = await worker.fetch(analyzeRequest(chatBody(1), { "CF-Connecting-IP": "198.51.100.1" }), envOf());
    assert.equal(limited.status, 429);
    const limitedBody = await limited.json();
    assert.equal(limitedBody.error, "rate_limited");
    assert.ok(limitedBody.retryAfterSec > 0);
    assert.ok(limited.headers.get("retry-after"));

    const otherIp = await worker.fetch(analyzeRequest(chatBody(1), { "CF-Connecting-IP": "198.51.100.2" }), envOf());
    assert.equal(otherIp.status, 200, "不同 IP 不应受影响");
  } finally {
    stub.restore();
  }

  const direct = rateLimit("10.0.0.9", Date.now());
  assert.equal(direct.limited, false);
  const exhausted = [1, 2, 3].map(() => rateLimit("10.0.0.9", Date.now()));
  assert.equal(exhausted[2].limited, true);
});

test("CORS：预检允许来源返 ACAO；不允许来源不返 ACAO", async () => {
  resetRateBuckets();
  const ok = await worker.fetch(requestOf("/analyze", { method: "OPTIONS", headers: { origin: ORIGIN } }), envOf());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  assert.ok(ok.headers.get("access-control-allow-methods").indexOf("POST") !== -1);

  const bad = await worker.fetch(requestOf("/analyze", { method: "OPTIONS", headers: { origin: "https://evil.example.com" } }), envOf());
  assert.equal(bad.status, 204);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  assert.equal(bad.headers.get("access-control-allow-origin") === "*", false, "不得使用通配来源");

  const stub = stubFetch(async () => new Response("{}", { status: 200 }));
  try {
    const post = await worker.fetch(analyzeRequest(chatBody(1), { origin: "https://evil.example.com", "CF-Connecting-IP": "198.51.100.3" }), envOf());
    assert.equal(post.headers.get("access-control-allow-origin"), null);
  } finally {
    stub.restore();
  }
});

test("泄漏检查：错误路径与 console 输出都不包含 key", async () => {
  resetRateBuckets();
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.error = (...args) => logs.push(args.join(" "));
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  const stub = stubFetch(async () => { throw new Error("upstream boom: " + FAKE_KEY); });
  try {
    const response = await worker.fetch(analyzeRequest(chatBody(1), { "CF-Connecting-IP": "198.51.100.4" }), envOf());
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(text.indexOf(FAKE_KEY), -1, "响应不得包含 key");
    assert.equal(text.indexOf("sk-"), -1, "响应不得包含 key 片段");
    assert.equal(logs.join(" ").indexOf(FAKE_KEY), -1, "日志不得包含 key");
  } finally {
    stub.restore();
    console.error = originalError;
    console.log = originalLog;
    console.warn = originalWarn;
  }
});

test("未配置访问码或模型 → 503（fail-closed）；未知路由 → 404；countImages 统计正确", async () => {
  resetRateBuckets();
  const noCodeEnv = await worker.fetch(analyzeRequest(chatBody(1)), { AOYE_LLM_API_KEY: FAKE_KEY, AOYE_LLM_BASE_URL: "https://api.example-provider.test/v1", AOYE_LLM_MODEL: "m", ALLOWED_ORIGIN: ORIGIN });
  assert.equal(noCodeEnv.status, 503, "未配访问码必须拒绝一切");
  assert.equal((await noCodeEnv.json()).error, "not_configured");

  const noModel = await worker.fetch(analyzeRequest(chatBody(1), { "CF-Connecting-IP": "203.0.113.21" }), { AOYE_ACCESS_CODE: ACCESS_CODE, ALLOWED_ORIGIN: ORIGIN });
  assert.equal(noModel.status, 503, "未配模型必须拒绝");
  assert.equal((await noModel.json()).error, "not_configured");

  const notFound = await worker.fetch(requestOf("/nope", { method: "GET" }), envOf());
  assert.equal(notFound.status, 404);

  const stats = countImages(chatBody(2, 100));
  assert.equal(stats.count, 2);
  assert.ok(stats.bytes > 0);
});

test("secureCompare：正确 / 错误 / 不同长度 / 空值", async () => {
  assert.equal(await secureCompare("abc", "abc"), true);
  assert.equal(await secureCompare("abc", "abd"), false);
  assert.equal(await secureCompare("abc", "abcd"), false, "长度不同也必须不等");
  assert.equal(await secureCompare("", ""), true);
});

test("访问码门禁：无码/错码 401、对码放行、回包与日志不含码", async () => {
  resetRateBuckets();
  const stub = stubFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
  const logs = [];
  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  try {
    const rawBody = JSON.stringify(chatBody(1));
    const bare = (ip, headers) => requestOf("/analyze", { method: "POST", headers: Object.assign({ "content-type": "application/json", "CF-Connecting-IP": ip, origin: ORIGIN }, headers || {}), body: rawBody });

    const noCode = await worker.fetch(bare("203.0.113.31"), envOf());
    assert.equal(noCode.status, 401, "无码必须 401");
    const noCodeBody = await noCode.text();
    assert.ok(noCodeBody.indexOf("访问码不正确") !== -1, "必须给可读原因");
    assert.equal(noCodeBody.indexOf(ACCESS_CODE), -1, "不得回显正确码");

    const wrong = await worker.fetch(bare("203.0.113.32", { "x-aoye-code": "wrong-code" }), envOf());
    assert.equal(wrong.status, 401, "错码必须 401");
    const wrongBody = await wrong.text();
    assert.equal(wrongBody.indexOf(ACCESS_CODE), -1);
    assert.equal(wrongBody.indexOf("wrong-code"), -1, "不得回显用户提交的码");

    const right = await worker.fetch(bare("203.0.113.33", { "x-aoye-code": ACCESS_CODE }), envOf());
    assert.equal(right.status, 200, "对码必须放行");
    assert.equal(stub.calls.length, 1, "只有对码才会发起上游调用");

    assert.equal(logs.join(" ").indexOf(ACCESS_CODE), -1, "日志不得包含访问码");
    assert.equal(logs.join(" ").indexOf("wrong-code"), -1, "日志不得包含用户提交的码");
  } finally {
    stub.restore();
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
  }
});

test("CORS 回归（防漂移）：前端实际发送的每个自定义头都必须被预检放行、且 Worker 真的会读", async () => {
  resetRateBuckets();
  const providerSource = fs.readFileSync(new URL("../web/static/provider-proxy.mjs", import.meta.url), "utf8");
  const workerSource = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const customHeaders = Array.from(new Set((providerSource.match(/headers\["([^"]+)"\]\s*=/g) || []).map((text) => text.match(/\["([^"]+)"\]/)[1])));
  assert.ok(customHeaders.length >= 1, "必须从 provider-proxy.mjs 扫到至少一个自定义头");
  assert.ok(customHeaders.indexOf("x-aoye-code") !== -1, "前端代理必须发送 x-aoye-code");

  const preflight = await worker.fetch(requestOf("/analyze", {
    method: "OPTIONS",
    headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type, " + customHeaders.join(", ") }
  }), envOf());
  assert.equal(preflight.status, 204);
  const allow = String(preflight.headers.get("access-control-allow-headers") || "").toLowerCase();
  assert.ok(allow.indexOf("content-type") !== -1, "预检必须放行 content-type");
  customHeaders.forEach((name) => {
    assert.ok(allow.indexOf(name.toLowerCase()) !== -1, "预检必须放行前端实际发送的自定义头：" + name);
    assert.ok(workerSource.indexOf('headers.get("' + name + '")') !== -1, "Worker 必须真的读取该头（不能只声明不读）：" + name);
  });

  /* 元断言：模拟前端以后新增一个头——检测逻辑必须能发现它没被放行，保证本测试真的会拦漂移。 */
  const hypothetical = customHeaders.concat("x-aoye-future");
  const missing = hypothetical.filter((name) => allow.indexOf(name.toLowerCase()) === -1);
  assert.deepEqual(missing, ["x-aoye-future"], "新增自定义头若未同步到 ACAH，本测试必须判定为缺失");
});
