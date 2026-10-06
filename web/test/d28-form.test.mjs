import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "../lib/ruleset.mjs";
import { loadCities, cityTierInfo } from "../lib/city.mjs";
import { generateReport } from "../lib/pipeline.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const fieldsDoc = JSON.parse(fs.readFileSync(path.join(WEB_DIR, "config", "form-fields.json"), "utf8"));
const ruleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });
const cities = loadCities(path.join(WEB_DIR, "config", "cities.json"));

/* D28：客观可查类保持必填；自评 / 校准 / 期望类允许留空（留空 = 无值，不是默认值）。 */
const REQUIRED_BY_D28 = ["gender", "age", "city", "height_cm", "education", "school_tier", "occupation", "income_wan", "has_house", "has_car", "hukou", "marital", "family_origin", "siblings"];
const OPTIONAL_BY_D28 = ["personality", "communication", "emotional_stability", "living_skills", "social_circle", "self_rank", "admiration_freq", "feedback_gap", "photo_quality", "face_natural", "want_gender", "want_age_min", "want_age_max", "want_height_min", "want_education_min", "want_house", "want_appearance_min", "want_occupation", "self_appearance"];

const MINIMAL = { gender: "male", age: 30, city: "杭州", height_cm: 178, education: "bachelor", school_tier: "985", occupation: "private", income_wan: 40, has_house: "loan", has_car: "mid", hukou: "local", marital: "single", family_origin: "urban_normal", siblings: "only" };

test("D28：必填集合与可留空集合与裁定一致（防两边漂移）", () => {
  const required = fieldsDoc.fields.filter((field) => field.required).map((field) => field.id).sort();
  assert.deepEqual(required, REQUIRED_BY_D28.slice().sort(), "必填集合必须是 D28 的客观可查类 + self_appearance");
  OPTIONAL_BY_D28.forEach((id) => {
    const field = fieldsDoc.fields.find((item) => item.id === id);
    assert.ok(field, "表单必须包含 " + id);
    assert.equal(field.required, false, id + " 必须允许留空（D28）");
  });
});

test("D28：只填必填 —— 未填项不参与计分、显式列入 caveats、不注入 unknown", async () => {
  const info = cityTierInfo(MINIMAL.city, cities);
  const report = await generateReport({
    form: MINIMAL, photos: [], ruleset, cities, cityTier: info.tier, cityMatched: info.matched,
    config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 }
  });
  assert.ok(report.rulesApplied.length > 0, "只填必填也必须能出结论（rulesApplied 非空）");
  assert.equal(report.appearance.final, null, "无照片且未填自评 → 颜值区间必须为 null（不得伪造）");
  assert.equal(report.appearance.selfMissing, true);
  const appearanceCaveat = report.caveats.find((item) => item.type === "appearance-self-missing");
  assert.ok(appearanceCaveat && appearanceCaveat.text.indexOf("未提供颜值自评与照片") !== -1, "必须显式说明颜值轨道不参与综合分");
  assert.ok((report.unscoredItems || []).length > 0, "留空项应进入 unscoredItems");
  const caveat = report.caveats.find((item) => item.type === "missing-inputs");
  assert.ok(caveat, "必须有 missing-inputs caveat 列出未填未计分项");
  assert.ok(caveat.text.indexOf("不按 0 计") !== -1, "必须写明不按 0 计");
  assert.equal(JSON.stringify(report.subject).indexOf("unknown"), -1, "留空不得被注入成 unknown 默认值");

  const personality = report.soft.breakdown.find((item) => item.id === "dim.personality");
  assert.ok(personality, "性格维度应存在于明细");
  assert.equal(personality.score, null, "未填不得计分");
  assert.equal(personality.counted, false);
  assert.ok(String(personality.note).indexOf("未填写") !== -1);
  const social = report.soft.breakdown.find((item) => item.id === "dim.social_circle" || item.id === "soft.social_circle");
  if (social) assert.equal(social.score, null, "未填自评不得按任何默认值计分");
});
test("D28：颜值三条轨道的留空语义（无自评无照片 / 仅照片 / 仅自评）", async () => {
  const info = cityTierInfo(MINIMAL.city, cities);
  const base = { ruleset, cities, cityTier: info.tier, cityMatched: info.matched };
  const stubConfig = { configured: true, apiKey: "test", baseUrl: "http://stub.local/v1", model: "stub", vision: "auto", jsonMode: "auto", timeoutMs: 2000 };
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      dimensions: [{ id: "looks.three_courts", observed: "三段均衡", level: "average", confidence: "medium" }],
      anchorFits: [{ label: "普通人", fit: 0.8, reason: "无强记忆点" }],
      dataQuality: { usable: true, issues: [] }, caveats: []
    }) } }] })
  });

  // 1) 无自评 + 无照片
  const none = await generateReport(Object.assign({ form: MINIMAL, photos: [], config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 } }, base));
  assert.equal(none.appearance.final, null);
  assert.equal(none.appearance.basis, "none");
  assert.ok(none.caveats.find((item) => item.type === "appearance-self-missing").text.indexOf("未提供颜值自评与照片") !== -1);
  assert.equal(none.confidence.levelComponents.find((item) => item.key === "appearance").counted, false);

  // 2) 仅照片（有照片、未填自评）
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "aoye-d28-photo-"));
  const photoFile = pathMod.join(dir, "face.png");
  fs.writeFileSync(photoFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const photoOnly = await generateReport(Object.assign({ form: MINIMAL, photos: [{ path: photoFile, mime: "image/png" }], config: stubConfig, fetchImpl }, base));
  assert.ok(photoOnly.appearance.final, "有照片时应产出照片轨道区间");
  assert.equal(photoOnly.appearance.basis, "photo-only");
  assert.equal(photoOnly.appearance.selfMissing, true);
  assert.ok(photoOnly.caveats.find((item) => item.type === "appearance-self-missing").text.indexOf("仅由照片维度映射") !== -1);

  // 3) 仅自评（有自评、无照片）
  const selfOnly = await generateReport(Object.assign({ form: Object.assign({}, MINIMAL, { self_appearance: 6 }), photos: [], config: { configured: false, apiKey: "", baseUrl: "", model: "", vision: "auto", jsonMode: "auto", timeoutMs: 1000 } }, base));
  assert.ok(selfOnly.appearance.final);
  assert.equal(selfOnly.appearance.basis, "self-report-only");
  assert.equal(selfOnly.appearance.selfMissing, false);
});
