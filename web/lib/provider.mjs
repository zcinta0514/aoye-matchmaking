import fs from "node:fs";
import { parseJsonLoose, clamp, roundTo } from "./util.mjs";

/* OpenAI 兼容适配层：base_url + api_key + model 全部走环境变量。
   未配置 key 时不报错，返回 placeholder（纯表单模式）。 */

export function providerConfig(env) {
  const e = env || process.env;
  const apiKey = e.AOYE_LLM_API_KEY || "";
  const baseUrl = String(e.AOYE_LLM_BASE_URL || "https://api.openai.com/v1").replace(/[/]+$/, "");
  const model = e.AOYE_LLM_MODEL || "gpt-4o-mini";
  const vision = String(e.AOYE_LLM_VISION || "auto").toLowerCase();
  const timeoutMs = Number(e.AOYE_LLM_TIMEOUT_MS || 60000);
  return {
    configured: Boolean(apiKey && baseUrl && model),
    apiKey,
    baseUrl,
    model,
    vision,
    timeoutMs,
    jsonMode: String(e.AOYE_LLM_JSON_MODE || "auto").toLowerCase(),
    maxVisionBytes: (function () {
      const mb = Number(e.AOYE_LLM_MAX_IMAGE_MB || 8);
      return (Number.isFinite(mb) && mb > 0 ? mb : 8) * 1024 * 1024;
    })()
  };
}

export function buildPhotoPrompt(dimensions, anchors) {
  const dimLines = dimensions.map((dim) => "- " + dim.id + "（" + dim.name + "）：" + (dim.notes || dim.description || "无补充说明")).join("\n");
  const anchorLines = anchors.map((anchor) => "- 「" + anchor.label + "」：" + (anchor.observable || []).join("；")).join("\n");
  const system = [
    "你是择偶定位体系里的「照片维度观察员」。",
    "硬性要求：",
    "1) 禁止给出任何绝对分数、档位结论或『几分』的判断；",
    "2) 只输出指定维度的可观察描述（三庭比例、脸型、五官协调、体态、气质、妆造等）；",
    "3) 逐条评估每张照片与给定锚点描述语的符合度 fit（0 到 1 的小数），fit 是『该锚点的描述语与照片特征的吻合程度』，不是分数；",
    "4) 信息不足就降低 confidence 并写进 caveats，不要脑补。",
    "只输出 JSON，不要输出任何其他文字。"
  ].join("\n");
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
  ].join("\n");
  return { system, user };
}

function toDataUrl(file, mime) {
  try {
    const buffer = fs.readFileSync(file);
    return "data:" + (mime || "image/jpeg") + ";base64," + buffer.toString("base64");
  } catch (error) {
    throw new Error("读取照片失败（" + file + "）：" + String(error && error.message ? error.message : error));
  }
}

function placeholderResult(dimensions, reason) {
  return {
    mode: "placeholder",
    reason,
    dimensions: dimensions.map((dim) => ({
      id: dim.id,
      name: dim.name,
      observed: null,
      level: null,
      confidence: null,
      note: "占位：本次未调用模型。"
    })),
    anchorFits: [],
    dataQuality: { usable: null, issues: [] },
    caveats: [reason],
    model: null
  };
}

async function callChatCompletions(config, messages, fetchImpl, useJsonMode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const body = { model: config.model, messages, temperature: 0.2 };
    if (useJsonMode) body.response_format = { type: "json_object" };
    const response = await fetchImpl(config.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + config.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzePhotos(options) {
  const { photos, dimensions, anchors, config } = options;
  const fetchImpl = options.fetchImpl || fetch;
  if (!dimensions.length) return { mode: "none", dimensions: [], anchorFits: [], dataQuality: { usable: null, issues: [] }, caveats: ["规则集中没有外观维度定义。"], model: null };
  if (!config.configured) {
    return placeholderResult(dimensions, "未配置模型：跳过照片分析，仅用表单自评 + 规则引擎。");
  }
  if (!photos.length) {
    return placeholderResult(dimensions, "未上传照片：跳过照片分析，仅用表单自评 + 规则引擎。");
  }
  try {
    const prompt = buildPhotoPrompt(dimensions, anchors);
    const useVision = config.vision !== "off";
    const content = [{ type: "text", text: prompt.user }];
    const caveats = [];
    let payloadBytes = 0;
    if (useVision) {
      photos.forEach((photo) => {
        const file = photo && (photo.path || photo.file);
        if (!file) throw new Error("照片对象缺少文件路径（photo.path / photo.file 均为空）");
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch (error) {
          throw new Error("读取照片失败（" + file + "）：" + String(error && error.message ? error.message : error));
        }
        const limit = config.maxVisionBytes || 8 * 1024 * 1024;
        if (payloadBytes + size > limit && content.length > 1) {
          caveats.push("照片总量超过模型请求上限（" + Math.round(limit / 1024 / 1024) + "MB），已跳过后续照片。");
          return;
        }
        payloadBytes += size;
        content.push({ type: "image_url", image_url: { url: toDataUrl(file, photo.mime) } });
      });
      if (content.length === 1) {
        throw new Error("照片体积超过模型请求上限（" + Math.round((config.maxVisionBytes || 0) / 1024 / 1024) + "MB），未发送任何照片");
      }
    }
    const messages = [{ role: "system", content: prompt.system }, { role: "user", content }];
    let result = useVision && config.jsonMode !== "off"
      ? await callChatCompletions(config, messages, fetchImpl, true)
      : await callChatCompletions(config, messages, fetchImpl, false);
    if (!result.ok && result.status === 400 && result.text.indexOf("response_format") !== -1) {
      result = await callChatCompletions(config, messages, fetchImpl, false);
    }
    if (!result.ok) {
      return Object.assign(placeholderResult(dimensions, "模型调用失败（HTTP " + result.status + "）：已降级为纯表单模式。"), { mode: "error", error: result.text.slice(0, 400) });
    }
    const envelope = JSON.parse(result.text);
    const parsed = parseJsonLoose(envelope.choices && envelope.choices[0] && envelope.choices[0].message ? envelope.choices[0].message.content : result.text);
    if (!parsed) {
      return Object.assign(placeholderResult(dimensions, "模型返回不是合法 JSON：已降级为纯表单模式。"), { mode: "error" });
    }
    const dims = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
    const byId = new Map(dims.map((item) => [item.id, item]));
    return {
      mode: "model",
      dimensions: dimensions.map((dim) => {
        const hit = byId.get(dim.id);
        return hit
          ? { id: dim.id, name: dim.name, observed: hit.observed || null, level: hit.level || null, confidence: hit.confidence || null, note: null }
          : { id: dim.id, name: dim.name, observed: null, level: null, confidence: null, note: "模型未返回该维度。" };
      }),
      anchorFits: (Array.isArray(parsed.anchorFits) ? parsed.anchorFits : []).map((item) => ({
        label: item.label,
        fit: clamp(roundTo(Number(item.fit) || 0, 3), 0, 1),
        reason: item.reason || ""
      })),
      dataQuality: parsed.dataQuality || { usable: null, issues: [] },
      caveats: (Array.isArray(parsed.caveats) ? parsed.caveats : []).concat(caveats),
      model: { baseUrl: config.baseUrl, model: config.model, vision: useVision }
    };
  } catch (error) {
    const reason = error && error.name === "AbortError" ? "超时" : String(error && error.message ? error.message : error);
    return Object.assign(placeholderResult(dimensions, "照片轨道异常（" + reason + "）：已降级为纯表单模式，流程继续。"), { mode: "error", error: reason });
  }
}
