function main() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("selftest") === "1") {
    runSelfTest(params).catch((error) => {
      document.getElementById("report-root").innerHTML = "<div class='card errors'>自检失败：" + esc(error && error.message ? error.message : error) + "</div>";
    });
    return;
  }
  const id = params.get("id") || window.localStorage.getItem("aoye:lastReportId") || "";
  const root = document.getElementById("report-root");
  if (!id) {
    root.innerHTML = "<div class='card errors'>没有找到本地报告：请先在首页生成一份。</div>";
    return;
  }
  const raw = window.localStorage.getItem("aoye:report:" + id);
  if (!raw) {
    root.innerHTML = "<div class='card errors'>本地没有找到报告 " + esc(id) + "（可能换了浏览器或清了缓存）。</div>";
    return;
  }
  try {
    render(JSON.parse(raw));
  } catch (error) {
    root.innerHTML = "<div class='card errors'>报告解析失败：" + esc(error && error.message ? error.message : error) + "</div>";
  }
}

/* 构建自检：就地跑一份示例报告并渲染（用 ?selftest=1 触发；不依赖表单交互）。 */
async function runSelfTest(params) {
  const { preloadData, setDataDir } = await import("../lib/load-browser.mjs");
  const { loadRuleset } = await import("../lib/ruleset.mjs");
  const { loadCities, cityTierInfo } = await import("../lib/city.mjs");
  const { generateReport } = await import("../lib/pipeline.mjs");
  const { buildSample } = await import("../lib/sample.mjs");
  const { providerConfig } = await import("../lib/provider.mjs");
  const dataDir = params.get("data") || "./data/";
  setDataDir(dataDir);
  await preloadData([
    "data/rules.json", "data/baseline-rules.json", "data/form-fields.json", "data/cities.json",
    "data/facts.json", "data/evidence-independence.json", "data/evidence-quality-flags.json",
    "data/cases.json", "data/band-criteria.json", "data/composite-criteria.json",
    "data/composite-mapping.json", "data/extrapolation-rules.json",
    "data/standards.json", "data/portrait-rules.json"
  ], dataDir);
  const sample = buildSample("data/cases.json", "C-022");
  const ruleset = loadRuleset({ mainPath: "data/rules.json", baselinePath: "data/baseline-rules.json" });
  const cities = loadCities("data/cities.json");
  const info = cityTierInfo(sample.form.city, cities);
  const report = await generateReport({
    form: sample.form, photos: [], ruleset, cities, cityTier: info.tier, cityMatched: info.matched,
    config: providerConfig({}),
    independencePath: "data/evidence-independence.json",
    extrapolationPath: "data/extrapolation-rules.json",
    bandCriteriaPath: "data/band-criteria.json",
    compositeCriteriaPath: "data/composite-criteria.json",
    compositeMappingPath: "data/composite-mapping.json",
    qualityFlagsPath: "data/evidence-quality-flags.json"
  });
  window.localStorage.setItem("aoye:report:" + report.id, JSON.stringify(report));
  window.localStorage.setItem("aoye:lastReportId", report.id);
  render(report);
}

main();
