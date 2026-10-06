/* 静态版（--photos=off）：公开站点不含任何模型调用路径。照片轨道永远占位。 */

export function providerConfig() {
  return { configured: false, apiKey: "", baseUrl: "", model: "", vision: "off", timeoutMs: 0, jsonMode: "off", maxVisionBytes: 0 };
}

export async function analyzePhotos({ dimensions }) {
  return {
    mode: "placeholder",
    reason: "公开版未开放照片分析（构建参数 --photos=off）：仅用表单自评 + 规则引擎。",
    dimensions: dimensions.map((dim) => ({
      id: dim.id,
      name: dim.name,
      observed: null,
      level: null,
      confidence: null,
      note: "占位：公开版未开放照片分析。"
    })),
    anchorFits: [],
    dataQuality: { usable: null, issues: [] },
    caveats: ["公开版未开放照片分析：如自建部署，可用 --photos=byok 重新构建。"],
    model: null
  };
}
