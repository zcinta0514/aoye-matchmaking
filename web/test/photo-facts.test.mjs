import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "../lib/ruleset.mjs";
import { loadCities, cityTierInfo } from "../lib/city.mjs";
import { buildPhotoFacts, buildFacts, generateReport } from "../lib/pipeline.mjs";
import { loadFactsDoc, collectDeclaredPaths, collectInjectablePaths, collectInternalPaths, checkFactsCoverage, inspectFactsCoverage } from "../lib/facts-coverage.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const FACTS_PATH = path.join(REPO_ROOT, "knowledge", "facts.json");
const ruleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
const cities = loadCities(path.join(WEB_DIR, "config", "cities.json"));
const fieldsDoc = JSON.parse(fs.readFileSync(path.join(WEB_DIR, "config", "form-fields.json"), "utf8"));
const factsLoaded = loadFactsDoc(FACTS_PATH);

const FORM = { gender: "female", age: 29, city: "杭州", height_cm: 163, education: "master", school_tier: "211", occupation: "gov", income_wan: 22, has_house: "loan", has_car: "none", hukou: "local", marital: "single", family_origin: "urban_normal", siblings: "only", personality: "warm", communication: 3, emotional_stability: 4, want_gender: "male", want_age_min: 27, want_age_max: 36, want_height_min: 178, want_education_min: "bachelor", want_house: "yes", want_appearance_min: 6, self_appearance: 6, self_rank: "top25", admiration_freq: "sometimes", photo_quality: "raw", face_natural: "yes" };

test("photo.* 注入：观测到才注入，未观测保持 undefined", () => {
  const facts = buildPhotoFacts({ dimensions: [
    { id: "face.three_courts", observed: "三段均衡" },
    { id: "face.nose", observed: null },
    { id: "looks.skin", observed: "   " },
    { id: "face.shape", observed: "鹅蛋脸" }
  ] });
  assert.equal(facts["face.three_courts"], "三段均衡");
  assert.equal(facts["face.shape"], "鹅蛋脸");
  assert.equal("face.nose" in facts, false, "未观测到不得注入键（更不得是 null/0/空串）");
  assert.equal("looks.skin" in facts, false);
  assert.equal(facts["looks.unknown_dim"], undefined);
});

test("buildFacts：photo 与 appearance.photoTrack 标量子路径", () => {
  const photoTrack = { mode: "model", dimensions: [{ id: "face.three_courts", observed: "三段均衡" }], mappedInterval: { low: 3, high: 4 } };
  const facts = buildFacts(FORM, { cityTier: 2 }, { final: null, divergence: null, divergenceAbs: null, selfTrack: null, photoTrack }, { items: [], score: null }, { items: [], score: null });
  assert.equal(facts.photo["face.three_courts"], "三段均衡");
  assert.equal(facts.appearance.photoTrack.low, 3);
  assert.equal(facts.appearance.photoTrack.high, 4);

  const withoutTrack = buildFacts(FORM, { cityTier: 2 }, { final: null, divergence: null, divergenceAbs: null, selfTrack: null, photoTrack: { mode: "placeholder", dimensions: [] } }, { items: [], score: null }, { items: [], score: null });
  assert.deepEqual(withoutTrack.photo, {});
  assert.equal(withoutTrack.appearance.photoTrack.low, undefined);
});

test("facts 内部字段（internalFactsNotForRules）：不注入、不报警、白名单只认声明过的内部字段", () => {
  const internal = collectInternalPaths(factsLoaded.doc);
  assert.ok(internal.has("context.cityMatched"));
  assert.ok(internal.has("context.gender"));

  const injectable = collectInjectablePaths({ formFieldIds: fieldsDoc.fields.map((field) => field.id), hardwareDimensionIds: [], softDimensionIds: [], photoDimensionIds: [] });
  assert.equal(injectable.has("context.cityMatched"), false, "内部字段不得进入注入面（匹配详情放返回值，不放 facts）");
  assert.equal(injectable.has("context.gender"), false, "与 subject.gender 重复的路径必须移除");
  assert.equal(injectable.has("subject.gender"), true, "性别只保留 subject.gender 一条路径");

  const facts = buildFacts(FORM, { cityTier: 2, cityMatched: false }, { final: null, divergence: null, divergenceAbs: null, selfTrack: null, photoTrack: null }, { items: [], score: null }, { items: [], score: null });
  assert.deepEqual(Object.keys(facts.context).sort(), ["city", "cityTier"], "buildFacts 的 context 只注入声明过的字段");
  assert.equal("gender" in facts.context, false);
  assert.equal("cityMatched" in facts.context, false);

  // 合成：声明了内部字段但未注入 → 不报「声明未注入」；未声明的注入 → 仍要报
  const synthetic = checkFactsCoverage({
    factsDoc: { facts: [{ field: "context.internalThing" }, { field: "subject.age" }], photoFacts: [], internalFactsNotForRules: ["context.internalThing（内部说明）"] },
    formFieldIds: ["age"], hardwareDimensionIds: [], softDimensionIds: [], photoDimensionIds: []
  });
  assert.deepEqual(synthetic.declaredNotInjectable, [], "内部字段不要求注入");
  assert.equal(synthetic.injectableNotDeclared.indexOf("subject.age"), -1, "已声明的注入不应进未声明列表");
  const leaked = checkFactsCoverage({
    factsDoc: { facts: [], photoFacts: [] },
    formFieldIds: ["age"], hardwareDimensionIds: [], softDimensionIds: [], photoDimensionIds: []
  });
  assert.ok(leaked.injectableNotDeclared.indexOf("subject.age") !== -1, "未声明注入必须报警");
  assert.ok(leaked.injectableNotDeclared.indexOf("context.internalThing") === -1, "内部字段白名单不适用于未声明的普通字段");
});
test("facts 覆盖检查：photo.* 全部可注入；模板与真实文件双向核对", () => {
  assert.equal(factsLoaded.doc !== null, true, "knowledge/facts.json 必须可读");
  const photoIds = (factsLoaded.doc.photoFacts || []).map((item) => item.id);
  assert.equal(photoIds.length, 18);

  const coverage = checkFactsCoverage({
    factsDoc: factsLoaded.doc,
    formFieldIds: fieldsDoc.fields.map((field) => field.id),
    hardwareDimensionIds: ruleset.dimensions.filter((dim) => dim.group === "hardware" || dim.group === "family").map((dim) => dim.id),
    softDimensionIds: ruleset.dimensions.filter((dim) => dim.group === "soft").map((dim) => dim.id),
    photoDimensionIds: photoIds
  });
  photoIds.forEach((id) => assert.equal(coverage.declaredNotInjectable.indexOf("photo." + id), -1, "photo." + id + " 必须可注入"));
  coverage.declaredNotInjectable.forEach((missing) => {
    assert.ok(missing.startsWith("subject."), "除表单待扩字段外不应有声明未注入：" + missing);
  });
  // D15：三个知识侧新字段已吸收进表单 → 声明侧不应再有缺口
  ["siblings_detail", "family_wealth", "want_occupation"].forEach((id) => {
    assert.ok(fieldsDoc.fields.some((field) => field.id === id), "表单必须包含 " + id);
    assert.equal(coverage.declaredNotInjectable.indexOf("subject." + id), -1, "subject." + id + " 必须可注入");
  });
  assert.deepEqual(coverage.declaredNotInjectable, [], "声明字段应全部可注入（含 D15 新字段）");
  assert.deepEqual(coverage.injectableNotDeclared, [], "注入的字段必须都已在 facts.json 声明");

  const injectable = collectInjectablePaths({ formFieldIds: ["age"], hardwareDimensionIds: ["dim.height"], softDimensionIds: [], photoDimensionIds: ["face.nose"] });
  assert.ok(injectable.has("hardware.breakdown.dim.height"));
  assert.ok(injectable.has("photo.face.nose"));
  assert.equal(collectDeclaredPaths({ facts: [{ field: "a.b" }], photoFacts: [{ field: "photo.x" }] }).has("photo.x"), true);

  const broken = checkFactsCoverage({ factsDoc: { facts: [{ field: "subject.nonexistent_field" }], photoFacts: [] }, formFieldIds: ["age"], hardwareDimensionIds: [], softDimensionIds: [], photoDimensionIds: [] });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.declaredNotInjectable, ["subject.nonexistent_field"]);
});

test("端到端：引用 photo.* 的 machine.when 真的会触发（并有启动期告警兜底）", async () => {
  const evidence = [{ account: "aoye98", aweme_id: "7644902230331542826", quote: "三庭比例，脸型大小" }];
  const doc = {
    version: "9.9",
    generatedAt: "2026-10-06T00:00:00Z",
    scales: [{ id: "appearance", name: "颜值分", min: 1, max: 9, anchors: [{ label: "普通人", score: 3.5, min: 3, max: 4, observable: [] }], evidence }],
    dimensions: [{ id: "face.three_courts", name: "三庭比例", group: "appearance", type: "photo", evidence }],
    rules: [{
      id: "R-PHOTO-001", scope: "advice", title: "三庭均衡提示", when: "三庭均衡", then: "记录",
      machine: { when: { field: "photo.face.three_courts", op: "eq", value: "三段均衡" }, then: [{ kind: "advice", text: "照片维度命中：三庭均衡。" }] },
      confidence: "medium", evidence
    }],
    bands: [],
    glossary: []
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-photo-rules-"));
  const rulesFile = path.join(dir, "rules.json");
  fs.writeFileSync(rulesFile, JSON.stringify(doc));
  const custom = loadRuleset({ mainPath: rulesFile, baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });

  const photoFile = path.join(dir, "face.png");
  fs.writeFileSync(photoFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      dimensions: [{ id: "face.three_courts", observed: "三段均衡", level: "average", confidence: "medium" }],
      anchorFits: [{ label: "普通人", fit: 0.8, reason: "无强记忆点" }],
      dataQuality: { usable: true, issues: [] },
      caveats: []
    }) } }] })
  });
  const config = { configured: true, apiKey: "test", baseUrl: "http://stub.local/v1", model: "stub", vision: "auto", jsonMode: "auto", timeoutMs: 2000 };
  const info = cityTierInfo(FORM.city, cities);

  const withPhoto = await generateReport({ form: FORM, photos: [{ path: photoFile, mime: "image/png" }], ruleset: custom, cities, cityTier: info.tier, cityMatched: info.matched, config, fetchImpl });
  assert.ok(withPhoto.rulesApplied.some((rule) => rule.ruleId === "R-PHOTO-001"), "photo.* 条件必须能命中");
  assert.ok(withPhoto.advice.some((item) => item.text.indexOf("三庭均衡") !== -1));

  const withoutModel = await generateReport({ form: FORM, photos: [], ruleset: custom, cities, cityTier: info.tier, cityMatched: info.matched, config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 } });
  assert.equal(withoutModel.rulesApplied.some((rule) => rule.ruleId === "R-PHOTO-001"), false, "无照片轨道时不得误触发");

  const started = inspectFactsCoverage({
    factsPath: FACTS_PATH,
    formFieldIds: fieldsDoc.fields.map((field) => field.id),
    hardwareDimensionIds: ruleset.dimensions.filter((dim) => dim.group === "hardware" || dim.group === "family").map((dim) => dim.id),
    softDimensionIds: ruleset.dimensions.filter((dim) => dim.group === "soft").map((dim) => dim.id),
    photoDimensionIds: (factsLoaded.doc.photoFacts || []).map((item) => item.id)
  });
  assert.ok(started.coverage.declaredNotInjectable.every((item) => item.indexOf("photo.") !== 0), "启动期不应再出现 photo.* 未注入告警");
  assert.ok(started.warnings.length >= 1, "facts.json 的 warnings 必须被带出来");
});
