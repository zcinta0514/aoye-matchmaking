import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);

/* 模型桩：返回「维度描述 + 锚点 fit」，用于验证配了 Key 的主路径（P0-1 回归）。 */
let stubCalls = 0;
let stubSawImage = false;
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    stubCalls += 1;
    if (body.indexOf("image_url") !== -1) stubSawImage = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      dimensions: [
        { id: "looks.three_courts", observed: "三庭大致均等", level: "average", confidence: "medium" },
        { id: "looks.nose", observed: "鼻梁线条较直", level: "above", confidence: "medium" }
      ],
      anchorFits: [{ label: "普通人", fit: 0.8, reason: "无强记忆点" }],
      dataQuality: { usable: true, issues: [] },
      caveats: ["单张照片，角度有限"]
    }) } }] }));
  });
});
const stubPort = await new Promise((resolve) => stub.listen(0, "127.0.0.1", () => resolve(stub.address().port)));

process.env.AOYE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aoye-web-test-"));
process.env.AOYE_MAX_PHOTO_MB = "1";
process.env.AOYE_LLM_API_KEY = "test-key";
process.env.AOYE_LLM_BASE_URL = "http://127.0.0.1:" + stubPort + "/v1";
process.env.AOYE_LLM_MODEL = "stub-vision";

const { startServer, assertBindPolicy } = await import("../server.mjs");
after(() => { stub.close(); });

const FORM = {
  gender: "female", age: 29, city: "杭州", height_cm: 163, weight_kg: 52,
  education: "master", school_tier: "211", occupation: "gov", income_wan: 22,
  has_house: "loan", has_car: "none", hukou: "local", marital: "single",
  family_origin: "urban_normal", siblings: "only",
  siblings_detail: "brother_only", family_wealth: "a7",
  personality: "warm", communication: 3, emotional_stability: 4, living_skills: 4, social_circle: 3, hobbies: "羽毛球",
  want_gender: "male", want_age_min: 27, want_age_max: 36, want_height_min: 178, want_education_min: "bachelor",
  want_house: "yes", want_appearance_min: 6,
  want_occupation: "any",
  self_appearance: 6, self_rank: "top25", admiration_freq: "sometimes", feedback_gap: "same", photo_quality: "raw", face_natural: "yes"
};
/* D28：只填必填（客观可查 + 颜值自评），其余留空 —— 比全填更能拦住问题 */
const MINIMAL = {
  gender: "male", age: 30, city: "杭州", height_cm: 178,
  education: "bachelor", school_tier: "985", occupation: "private", income_wan: 40,
  has_house: "loan", has_car: "mid", hukou: "local", marital: "single",
  family_origin: "urban_normal", siblings: "only"
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("HTTP 端到端：配 Key + 照片走模型轨道（P0-1），表单/魔数/超限/静态路径全部按预期", async () => {
  const { server, baseUrl } = await startServer(0, "127.0.0.1");
  try {
    const health = await (await fetch(baseUrl + "/api/health")).json();
    assert.equal(health.ok, true);
    assert.equal(health.modelConfigured, true);
    assert.equal(health.auth.tokenRequired, false);

    const page = await fetch(baseUrl + "/");
    assert.equal(page.status, 200);
    assert.ok((await page.text()).indexOf("鳌烨择偶定位系统") !== -1);

    const upload = await fetch(baseUrl + "/api/photos", { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    const photo = await upload.json();
    assert.equal(upload.status, 200, JSON.stringify(photo));
    assert.ok(photo.id);

    const fakeImage = await fetch(baseUrl + "/api/photos", { method: "POST", headers: { "content-type": "image/png" }, body: Buffer.from("not-an-image-at-all") });
    assert.equal(fakeImage.status, 415);
    const oversized = await fetch(baseUrl + "/api/photos", { method: "POST", headers: { "content-type": "image/png" }, body: Buffer.alloc(1.4 * 1024 * 1024, 1) });
    assert.equal(oversized.status, 413);
    const oversizedBody = await oversized.json();
    assert.ok(oversizedBody.error.indexOf("超过上限") !== -1);
    const wrongType = await fetch(baseUrl + "/api/photos", { method: "POST", headers: { "content-type": "text/plain" }, body: PNG });
    assert.equal(wrongType.status, 415);

    const created = await fetch(baseUrl + "/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: FORM, photoIds: [photo.id] })
    });
    const payload = await created.json();
    assert.equal(created.status, 200, JSON.stringify(payload).slice(0, 400));
    const id = payload.id;
    const report = payload.report;

    assert.equal(report.engine.photoMode, "model");
    assert.equal(report.engine.model.model, "stub-vision");
    assert.equal(stubCalls >= 1, true);
    assert.equal(stubSawImage, true);
    assert.deepEqual([report.appearance.photoTrack.mappedInterval.low, report.appearance.photoTrack.mappedInterval.high], [3, 4]);
    assert.equal(report.appearance.basis, "photo+self");
    assert.equal(typeof report.appearance.divergence, "number");
    assert.ok(report.rulesApplied.length >= 1);
    assert.ok(report.rulesApplied.some((rule) => rule.via === "machine"));
    assert.ok(report.appearance.photoTrack.dimensions.find((dim) => dim.id === "looks.nose").observed === "鼻梁线条较直");
    assert.equal(report.appearance.photoTrack.dimensions.some((dim) => dim.id === "face.shape"), false, "降本筛掉的演示基线维度不得出现在报告里");

    assert.ok(report.evidenceSummary.scoredItems > 0);
    assert.equal(report.evidenceSummary.withEvidence + report.evidenceSummary.withoutEvidence, report.evidenceSummary.scoredItems);
    const noEvidenceItem = report.hardware.breakdown.find((item) => item.evidenceStatus === "none");
    assert.ok(noEvidenceItem);
    assert.equal(noEvidenceItem.evidenceNote, "无语料依据（基线/工程默认）");
    assert.ok(report.confidence && report.confidence.summary);
    assert.equal(report.disclosure.required, true, "披露必须随数据返回且不可关闭");
    assert.ok(report.disclosure.text.indexOf("同一商业机构") !== -1);
    assert.ok(report.disclosure.scope);
    assert.ok(report.caveats.some((item) => item.type === "disclosure" && item.text === report.disclosure.text), "caveats 必须含同内容披露");
    assert.ok(report.confidence.independenceCoverage.auditedRules >= 1);
    assert.equal(report.confidence.independenceCoverage.heuristicRules, report.confidence.independenceCoverage.totalRules - report.confidence.independenceCoverage.auditedRules);
    assert.equal(report.confidence.independence.provisional, false);
    assert.equal(report.confidence.independence.source, "audit-rules");
    assert.ok(report.excludedItems.length >= 1);
    assert.ok(report.evidenceIndex.every((item) => item.setStrength));
    assert.ok(typeof report.levelIfAllCounted === "number");
    assert.ok(report.portrait.ladder.length >= 4);
    assert.ok(typeof report.portrait.text === "string" && report.portrait.text.length > 0);

    const readBack = await (await fetch(baseUrl + "/api/report/" + id)).json();
    assert.equal(readBack.id, id);
    const sample = await (await fetch(baseUrl + "/api/sample")).json();
    assert.equal(sample.caseId, "C-022");
    assert.equal(Object.keys(sample.form).length, 39);
    assert.ok(sample.assumptions.length >= 3);
    assert.ok(sample.label.indexOf("真实案例") !== -1);
    const reportPage = await fetch(baseUrl + "/r/" + id);
    assert.equal(reportPage.status, 200);

    const invalid = await fetch(baseUrl + "/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: { gender: "female" }, photoIds: [] })
    });
    assert.equal(invalid.status, 422);
    const booleanAge = await fetch(baseUrl + "/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: Object.assign({}, FORM, { age: true }), photoIds: [] })
    });
    assert.equal(booleanAge.status, 422);

    assert.equal((await fetch(baseUrl + "/data/reports.json")).status, 404);
    assert.equal((await fetch(baseUrl + "/uploads/" + photo.id + ".png")).status, 404);
    assert.equal((await fetch(baseUrl + "/../knowledge/rules.json")).status >= 400, true);
  } finally {
    server.close();
  }
});

test("回归（阻断性，D28）：正式规则集 + 只填必填 → POST /api/report 必须 200 且 rulesApplied 非空", async () => {
  const { server, baseUrl } = await startServer(0, "127.0.0.1");
  try {
    const response = await fetch(baseUrl + "/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: MINIMAL, photoIds: [] })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, "正式规则集 + 只填必填必须 200：" + JSON.stringify(payload).slice(0, 300));
    assert.equal(payload.error, undefined);
    const report = payload.report;
    assert.ok(report.rulesApplied.length > 0, "rulesApplied 不得为空（152 规则 / 54 可执行）");
    assert.ok(report.rulesApplied.some((rule) => rule.via === "machine" && rule.origin === "knowledge"), "必须有知识库 machine 规则命中");
    assert.ok(report.engine.coverage.knowledge.executableRules >= 1);
    assert.ok(report.confidence.independence.source === "audit-rules");
    assert.ok(report.caveats.some((item) => item.type === "missing-inputs"), "未填项必须在 caveats 显式列出");
    assert.ok((report.unscoredItems || []).length > 0, "只填必填时应有未计分项");
    assert.equal(JSON.stringify(report.subject).indexOf("unknown"), -1, "留空不得被注入成 unknown 默认值");
  } finally {
    server.close();
  }
});
test("P0-2 鉴权：默认回环 + 令牌保护（无令牌 401，带令牌 200）", async () => {
  const child = spawn(process.execPath, ["web/server.mjs"], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, {
      PORT: "0", HOST: "127.0.0.1", AOYE_ACCESS_TOKEN: "secret-token",
      AOYE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "aoye-token-test-")),
      AOYE_LLM_API_KEY: "", AOYE_LLM_BASE_URL: "", AOYE_LLM_MODEL: ""
    })
  });
  const baseUrl = await waitForBase(child);
  try {
    assert.equal((await fetch(baseUrl + "/api/health")).status, 200);
    assert.equal((await fetch(baseUrl + "/api/reports")).status, 401);
    const withoutToken = await fetch(baseUrl + "/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ form: FORM, photoIds: [] }) });
    assert.equal(withoutToken.status, 401);
    assert.equal((await withoutToken.json()).error.indexOf("未授权") !== -1, true);

    const authHeaders = { "content-type": "application/json", "x-aoye-token": "secret-token" };
    const created = await fetch(baseUrl + "/api/report", { method: "POST", headers: authHeaders, body: JSON.stringify({ form: FORM, photoIds: [] }) });
    const payload = await created.json();
    assert.equal(created.status, 200, JSON.stringify(payload).slice(0, 300));

    const photoUpload = await fetch(baseUrl + "/api/photos", { method: "POST", headers: { "content-type": "image/png", "x-aoye-token": "secret-token" }, body: PNG });
    const photo = await photoUpload.json();
    assert.equal(photoUpload.status, 200);

    assert.equal((await fetch(baseUrl + "/api/report/" + payload.id)).status, 401);
    assert.equal((await fetch(baseUrl + "/api/report/" + payload.id + "?token=secret-token")).status, 200);
    assert.equal((await fetch(baseUrl + "/api/photos/" + photo.id)).status, 401);
    assert.equal((await fetch(baseUrl + "/api/photos/" + photo.id + "?token=secret-token")).status, 200);
    assert.equal((await fetch(baseUrl + "/api/photos/" + photo.id, { headers: { authorization: "Bearer secret-token" } })).status, 200);
  } finally {
    child.kill();
  }
});

test("P0-2 绑定策略：非回环监听必须带令牌，否则拒绝启动", async () => {
  assert.throws(() => assertBindPolicy("0.0.0.0", ""), /AOYE_ACCESS_TOKEN/);
  assert.doesNotThrow(() => assertBindPolicy("0.0.0.0", "token"));
  assert.doesNotThrow(() => assertBindPolicy("127.0.0.1", ""));

  const child = spawn(process.execPath, ["web/server.mjs"], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { PORT: "0", HOST: "0.0.0.0", AOYE_ACCESS_TOKEN: "" })
  });
  const result = await waitExit(child);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.indexOf("AOYE_ACCESS_TOKEN") !== -1);
});

function waitForBase(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("服务启动超时：" + buffer)), 10000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/http:[/][/]127[.]0[.]0[.]1:([0-9]+)/);
      if (match) {
        clearTimeout(timer);
        resolve("http://127.0.0.1:" + match[1]);
      }
    });
    child.stderr.on("data", (chunk) => { buffer += chunk.toString(); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("服务提前退出 code=" + code + "：" + buffer));
    });
  });
}

function waitExit(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
