import test from "node:test";
import assert from "node:assert/strict";
import worker, { LIMITS, countImages, rateLimit, resetRateBuckets } from "./index.js";

const FAKE_KEY = "sk-test-DEADBEEF-1234567890";
const ORIGIN = "https://aoye-pages.pages.dev";

function envOf(extra) {
  return Object.assign({
    AOYE_LLM_API_KEY: FAKE_KEY,
    AOYE_LLM_BASE_URL: "https://api.example-provider.test/v1",
    AOYE_LLM_MODEL: "env-model",
    ALLOWED_ORIGIN: ORIGIN
  }, extra || {});
}

function requestOf(pathname, init) {
  return new Request("https://proxy.example.workers.dev" + pathname, init);
}

function analyzeRequest(body, headers) {
  return requestOf("/analyze", {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7", origin: ORIGIN }, headers || {}),
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

test("超限：3 张图 / 图片总量 >6MB / 请求体 >8MB → 413", async () => {
  resetRateBuckets();
  const three = await worker.fetch(analyzeRequest(chatBody(3, 16)), envOf());
  assert.equal(three.status, 413);
  assert.equal((await three.json()).error, "too_many_images");

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

test("未配置模型 → 503；未知路由 → 404；countImages 统计正确", async () => {
  resetRateBuckets();
  const unconfigured = await worker.fetch(analyzeRequest(chatBody(1)), { ALLOWED_ORIGIN: ORIGIN });
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).error, "not_configured");

  const notFound = await worker.fetch(requestOf("/nope", { method: "GET" }), envOf());
  assert.equal(notFound.status, 404);

  const stats = countImages(chatBody(2, 100));
  assert.equal(stats.count, 2);
  assert.ok(stats.bytes > 0);
});
