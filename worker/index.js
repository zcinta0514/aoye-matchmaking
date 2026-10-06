/* 鳌烨择偶定位系统 · 模型代理 Worker（Cloudflare Workers，纯 ES module，零依赖）
 *
 * 职责：前端（GitHub Pages 静态版 --photos=proxy）把与 provider.mjs 相同的请求体发到 POST /analyze，
 *      由 Worker 在服务端注入密钥并转发到 {AOYE_LLM_BASE_URL}/chat/completions。
 *
 * 安全边界（务必如实告知部署者）：
 *  - Worker 能藏住 key（不进仓库、不进前端），但**挡不住有人刷**；
 *  - 这里的内存限流是「尽力而为」：isolate 级、重启即失效，不是可靠限流；
 *  - 唯一可靠的保护是「在模型服务商后台设置月度额度上限」。
 */

const LIMITS = {
  MAX_IMAGES: 2,               // 比本机版（3 张）更少，降本
  MAX_IMAGE_BYTES: 6 * 1024 * 1024, // 所有图片解码后总量
  MAX_BODY_BYTES: 8 * 1024 * 1024,  // 单请求体
  RATE_LIMIT_PER_HOUR: 3,      // 每 IP 每小时（尽力而为）
  RATE_WINDOW_MS: 60 * 60 * 1000,
  DEFAULT_TIMEOUT_MS: 60000
};

/* isolate 级内存限流：IP -> 时间戳数组。重启/换 isolate 即失效，仅作尽力而为的防线。 */
const rateBuckets = new Map();

function allowedOrigins(env) {
  return String((env && env.ALLOWED_ORIGIN) || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  if (!list.length) return {};
  if (origin && list.indexOf(origin) === -1) return {}; // 不允许的来源：不返回 ACAO
  return {
    "Access-Control-Allow-Origin": origin || list[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "3600",
    "Vary": "Origin"
  };
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, extraHeaders || {})
  });
}

/** data URL 解码后的估算字节数（不真正解码，避免内存放大）。 */
function dataUrlBytes(url) {
  const text = String(url || "");
  const comma = text.indexOf(",");
  if (comma === -1) return 0;
  return Math.floor((text.length - comma - 1) * 0.75);
}

function countImages(body) {
  const messages = (body && body.messages) || [];
  let count = 0;
  let bytes = 0;
  messages.forEach((message) => {
    const content = message && message.content;
    if (!Array.isArray(content)) return;
    content.forEach((part) => {
      if (part && part.type === "image_url" && part.image_url && part.image_url.url) {
        count += 1;
        bytes += dataUrlBytes(part.image_url.url);
      }
    });
  });
  return { count, bytes };
}

function rateLimit(ip, now) {
  const windowStart = now - LIMITS.RATE_WINDOW_MS;
  const bucket = (rateBuckets.get(ip) || []).filter((time) => time > windowStart);
  if (bucket.length >= LIMITS.RATE_LIMIT_PER_HOUR) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket[0] + LIMITS.RATE_WINDOW_MS - now) / 1000));
    rateBuckets.set(ip, bucket);
    return { limited: true, retryAfterSec };
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  return { limited: false, remaining: LIMITS.RATE_LIMIT_PER_HOUR - bucket.length };
}

function resetRateBuckets() {
  rateBuckets.clear();
}

async function handleAnalyze(request, env, now) {
  const origin = request.headers.get("origin") || "";
  const cors = corsHeaders(origin, env);

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
  const limit = rateLimit(ip, now);
  if (limit.limited) {
    return json({ error: "rate_limited", reason: "同一来源每小时最多 " + LIMITS.RATE_LIMIT_PER_HOUR + " 次，请稍后重试。", retryAfterSec: limit.retryAfterSec }, 429, Object.assign({ "retry-after": String(limit.retryAfterSec) }, cors));
  }

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared && declared > LIMITS.MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", reason: "请求体超过 " + Math.round(LIMITS.MAX_BODY_BYTES / 1024 / 1024) + "MB 上限。" }, 413, cors);
  }

  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return json({ error: "bad_request", reason: "请求体读取失败。" }, 400, cors);
  }
  if (raw.length > LIMITS.MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", reason: "请求体超过 " + Math.round(LIMITS.MAX_BODY_BYTES / 1024 / 1024) + "MB 上限。" }, 413, cors);
  }
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad_request", reason: "请求体不是合法 JSON。" }, 400, cors);
  }

  const images = countImages(body);
  if (images.count > LIMITS.MAX_IMAGES) {
    return json({ error: "too_many_images", reason: "最多 " + LIMITS.MAX_IMAGES + " 张照片（收到 " + images.count + " 张）。" }, 413, cors);
  }
  if (images.bytes > LIMITS.MAX_IMAGE_BYTES) {
    return json({ error: "images_too_large", reason: "照片总量超过 " + Math.round(LIMITS.MAX_IMAGE_BYTES / 1024 / 1024) + "MB 上限。" }, 413, cors);
  }

  const apiKey = (env && env.AOYE_LLM_API_KEY) || "";
  const baseUrl = String((env && env.AOYE_LLM_BASE_URL) || "").replace(/[/]+$/, "");
  const model = (env && env.AOYE_LLM_MODEL) || body.model || "";
  if (!apiKey || !baseUrl || !model) {
    return json({ error: "not_configured", reason: "代理未配置模型（缺少 AOYE_LLM_API_KEY / AOYE_LLM_BASE_URL / AOYE_LLM_MODEL）。" }, 503, cors);
  }

  const timeoutMs = Number((env && env.AOYE_LLM_TIMEOUT_MS) || LIMITS.DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify(Object.assign({}, body, { model })),
      signal: controller.signal
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: Object.assign({ "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8" }, cors)
    });
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    return json({ error: aborted ? "upstream_timeout" : "upstream_error", reason: aborted ? "上游模型服务超时。" : "上游模型服务调用失败。" }, aborted ? 504 : 502, cors);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      const configured = Boolean((env && env.AOYE_LLM_API_KEY) && (env && env.AOYE_LLM_BASE_URL) && (env && env.AOYE_LLM_MODEL));
      return json({
        ok: true,
        service: "aoye-llm-proxy",
        configured,
        limits: { maxImages: LIMITS.MAX_IMAGES, maxImageMb: LIMITS.MAX_IMAGE_BYTES / 1024 / 1024, maxBodyMb: LIMITS.MAX_BODY_BYTES / 1024 / 1024, perHourPerIp: LIMITS.RATE_LIMIT_PER_HOUR },
        note: "内存限流为尽力而为（isolate 级、重启失效）；可靠保护请在模型服务商后台设置月度额度上限。"
      }, 200, cors);
    }
    if (request.method === "POST" && url.pathname === "/analyze") {
      return handleAnalyze(request, env, Date.now());
    }
    return json({ error: "not_found", reason: "未知路由：" + request.method + " " + url.pathname }, 404, cors);
  }
};

export { LIMITS, countImages, rateLimit, resetRateBuckets, corsHeaders, handleAnalyze };
