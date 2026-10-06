/* 静态版（--photos=proxy）：图片分析由本站 Cloudflare Worker 代理完成，前端不接触任何 key。
   代理地址在构建时注入（https://aoye-proxy.zcinta0514.workers.dev）；请求体与直连 provider 完全一致，由 Worker 侧注入密钥后转发。 */

import { parseJsonLoose, clamp, roundTo } from "./util.mjs";

const PROXY_URL = "https://aoye-proxy.zcinta0514.workers.dev";
const ACCESS_CODE_KEY = "aoye:access_code";

/* 访问码只从本机 localStorage 读；不回显、不落产物、不进日志。 */
function accessCode() {
  try { return window.localStorage.getItem(ACCESS_CODE_KEY) || ""; } catch { return ""; }
}

export function providerConfig(env) {
  const settings = Object.assign({}, env || {});
  const apiKey = "";
  const baseUrl = String(PROXY_URL || "").replace(/[/]+$/, "");
  const model = settings.model || "proxy";
  const vision = String(settings.vision || "auto").toLowerCase();
  const timeoutMs = Number(settings.timeoutMs || 60000);
  const mb = Number(settings.maxImageMb || 8);
  return {
    configured: Boolean(baseUrl),
    apiKey, baseUrl, model, vision, timeoutMs,
    jsonMode: String(settings.jsonMode || "auto").toLowerCase(),
    maxVisionBytes: (Number.isFinite(mb) && mb > 0 ? mb : 8) * 1024 * 1024
  };
}

export function buildPhotoPrompt(dimensions, anchors) {
  const dimLines = dimensions.map((dim) => "- " + dim.id + "（" + dim.name + "）：" + (dim.notes || dim.description || "无补充说明")).join(String.fromCharCode(10));
  const anchorLines = anchors.map((anchor) => "- 「" + anchor.label + "」：" + (anchor.observable || []).join("；")).join(String.fromCharCode(10));
  const system = [
    "你是择偶定位体系里的「照片维度观察员」。",
    "硬性要求：",
    "1) 禁止给出任何绝对分数、档位结论或『几分』的判断；",
    "2) 只输出指定维度的可观察描述（三庭比例、脸型、五官协调、体态、气质、妆造等）；",
    "3) 逐条评估每张照片与给定锚点描述语的符合度 fit（0 到 1 的小数），fit 是『该锚点的描述语与照片特征的吻合程度』，不是分数；",
    "4) 信息不足就降低 confidence 并写进 caveats，不要脑补。",
    "只输出 JSON，不要输出任何其他文字。"
  ].join(String.fromCharCode(10));
  const user = [
    "请观察照片并输出 JSON，结构：",
    "{",
    '  "dimensions": [{ "id": "<维度id>", "observed": "<可观察描述，40字内>", "level": "below|average|above|outstanding", "confidence": "low|medium|high" }],',
    '  "anchorFits": [{ "label": "<锚点标签>", "fit": 0.0, "reason": "<判断依据，30字内>" }],',
    '  "dataQuality": { "usable": true, "issues": ["角度/光线/遮挡/疑似修图"] },',
    '  "caveats": ["<需要说明的局限>"]',
    "}",
    "",
    "观察维度：",
    dimLines,
    "",
    "锚点描述语（用于 fit 评估）：",
    anchorLines || "（无锚点）"
  ].join(String.fromCharCode(10));
  return { system, user };
}

function placeholder(dimensions, reason) {
  return {
    mode: "placeholder",
    reason,
    dimensions: dimensions.map((dim) => ({ id: dim.id, name: dim.name, observed: null, level: null, confidence: null, note: "占位：" + reason })),
    anchorFits: [],
    dataQuality: { usable: null, issues: [] },
    caveats: [reason],
    model: null
  };
}

export async function analyzePhotos(options) {
  const { photos, dimensions, anchors, config } = options;
  if (!dimensions.length) return { mode: "none", dimensions: [], anchorFits: [], dataQuality: { usable: null, issues: [] }, caveats: ["规则集中没有外观维度定义。"], model: null };
  if (!config.configured) return placeholder(dimensions, "代理地址未配置：跳过照片分析。");
  if (!photos.length) return placeholder(dimensions, "未上传照片：跳过照片分析。");
  try {
    const prompt = buildPhotoPrompt(dimensions, anchors);
    const useVision = config.vision !== "off";
    const content = [{ type: "text", text: prompt.user }];
    const caveats = [];
    let bytes = 0;
    if (useVision) {
      photos.forEach((photo) => {
        const dataUrl = photo && photo.dataUrl;
        if (!dataUrl) throw new Error("照片缺少 dataUrl");
        const size = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
        if (bytes + size > config.maxVisionBytes && content.length > 1) {
          caveats.push("照片总量超过模型请求上限，已跳过后续照片。");
          return;
        }
        bytes += size;
        content.push({ type: "image_url", image_url: { url: dataUrl } });
      });
      if (content.length === 1) throw new Error("照片体积超过模型请求上限，未发送任何照片");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const headers = { "content-type": "application/json" };
    const code = accessCode();
    if (code) headers["x-aoye-code"] = code;
    let response;
    try {
      response = await fetch(config.baseUrl + "/analyze", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "system", content: prompt.system }, { role: "user", content }] }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) {
      return Object.assign(placeholder(dimensions, "访问码不正确或已失效：请回首页「访问码」里重新填写后再生成。"), { mode: "error", errorCode: "unauthorized" });
    }
    if (response.status === 503) {
      return Object.assign(placeholder(dimensions, "代理暂不可用（未启用访问码或未配置模型），请稍后重试。"), { mode: "error", errorCode: "not_configured" });
    }
    if (!response.ok) return Object.assign(placeholder(dimensions, "模型调用失败（HTTP " + response.status + "）：已降级为纯表单模式。"), { mode: "error" });
    const envelope = await response.json();
    const text = envelope && envelope.choices && envelope.choices[0] && envelope.choices[0].message ? envelope.choices[0].message.content : "";
    const parsed = parseJsonLoose(text);
    if (!parsed) return Object.assign(placeholder(dimensions, "模型返回不是合法 JSON：已降级为纯表单模式。"), { mode: "error" });
    const byId = new Map((Array.isArray(parsed.dimensions) ? parsed.dimensions : []).map((item) => [item.id, item]));
    return {
      mode: "model",
      dimensions: dimensions.map((dim) => {
        const hit = byId.get(dim.id);
        return hit
          ? { id: dim.id, name: dim.name, observed: hit.observed || null, level: hit.level || null, confidence: hit.confidence || null, note: null }
          : { id: dim.id, name: dim.name, observed: null, level: null, confidence: null, note: "模型未返回该维度。" };
      }),
      anchorFits: (Array.isArray(parsed.anchorFits) ? parsed.anchorFits : []).map((item) => ({ label: item.label, fit: clamp(roundTo(Number(item.fit) || 0, 3), 0, 1), reason: item.reason || "" })),
      dataQuality: parsed.dataQuality || { usable: null, issues: [] },
      caveats: (Array.isArray(parsed.caveats) ? parsed.caveats : []).concat(caveats),
      model: { baseUrl: config.baseUrl, model: config.model, vision: useVision }
    };
  } catch (error) {
    const reason = error && error.name === "AbortError" ? "超时" : String(error && error.message ? error.message : error);
    return Object.assign(placeholder(dimensions, "照片轨道异常（" + reason + "）：已降级为纯表单模式，流程继续。"), { mode: "error", error: reason });
  }
}
