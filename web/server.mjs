import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadRuleset, getScale } from "./lib/ruleset.mjs";
import { loadCities, cityTierInfo } from "./lib/city.mjs";
import { providerConfig } from "./lib/provider.mjs";
import { validateSubmission } from "./lib/validate.mjs";
import { generateReport } from "./lib/pipeline.mjs";
import { createStore } from "./lib/store.mjs";
import { buildSample } from "./lib/sample.mjs";
import { loadIndependence } from "./lib/strength.mjs";
import { inspectFactsCoverage, loadFactsDoc } from "./lib/facts-coverage.mjs";
import { loadQualityFlags } from "./lib/strength.mjs";
import { loadEnvLocal, safeBaseUrl } from "./lib/env-file.mjs";
import { readJson } from "./lib/util.mjs";

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(WEB_DIR);
const PUBLIC_DIR = path.join(WEB_DIR, "public");

const env = process.env;
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || "127.0.0.1";
const ACCESS_TOKEN = String(env.AOYE_ACCESS_TOKEN || "").trim();
const DATA_DIR = env.AOYE_DATA_DIR || path.join(WEB_DIR, "data");
const MAIN_RULES = env.AOYE_RULES_PATH || path.join(REPO_ROOT, "knowledge", "rules.json");
const BASELINE_RULES = env.AOYE_BASELINE_PATH || path.join(WEB_DIR, "config", "baseline-rules.json");
const FORM_FIELDS = path.join(WEB_DIR, "config", "form-fields.json");
const CITIES = path.join(WEB_DIR, "config", "cities.json");
const CASES_PATH = env.AOYE_CASES_PATH || path.join(REPO_ROOT, "knowledge", "cases.json");
const INDEPENDENCE_PATH = env.AOYE_INDEPENDENCE_PATH || path.join(REPO_ROOT, "knowledge", "evidence-independence.json");
const EXTRAPOLATION_PATH = env.AOYE_EXTRAPOLATION_PATH || path.join(WEB_DIR, "config", "extrapolation-rules.json");
const FACTS_PATH = env.AOYE_FACTS_PATH || path.join(REPO_ROOT, "knowledge", "facts.json");
const MAX_PHOTO_BYTES = Number(env.AOYE_MAX_PHOTO_MB || 10) * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_PHOTOS = 3;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const ruleset = loadRuleset({ mainPath: MAIN_RULES, baselinePath: BASELINE_RULES });
const cities = loadCities(CITIES);
const fieldsDoc = readJson(FORM_FIELDS);
const store = createStore(DATA_DIR);
/* .env.local：本地模型凭据（环境变量优先；只接受 AOYE_LLM_* 键；不回显内容） */
const ENV_FILE = env.AOYE_ENV_FILE || path.join(REPO_ROOT, ".env.local");
const envLocal = loadEnvLocal(ENV_FILE, env);
const config = providerConfig(env);

const factsDoc = loadFactsDoc(FACTS_PATH).doc;
const qualityFlags = loadQualityFlags(env.AOYE_QUALITY_FLAGS_PATH || path.join(REPO_ROOT, "knowledge", "evidence-quality-flags.json"));
const factsInspection = inspectFactsCoverage({
  factsPath: FACTS_PATH,
  formFieldIds: fieldsDoc.fields.map((field) => field.id),
  hardwareDimensionIds: ruleset.dimensions.filter((dim) => dim.group === "hardware" || dim.group === "family").map((dim) => dim.id),
  softDimensionIds: ruleset.dimensions.filter((dim) => dim.group === "soft").map((dim) => dim.id),
  photoDimensionIds: ((factsDoc && factsDoc.photoFacts) || []).map((item) => item.id).filter(Boolean)
});

/* ------------------------------------------------------------------ */
/* 监听策略：默认只绑回环；对外监听必须显式设置 AOYE_ACCESS_TOKEN      */
/* ------------------------------------------------------------------ */

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host);
}

export function assertBindPolicy(host, token) {
  if (!isLoopbackHost(host) && !token) {
    const error = new Error("拒绝启动：HOST=" + host + " 是非回环地址（对外监听），必须同时设置 AOYE_ACCESS_TOKEN，否则同网任何设备都能读取全部报告与照片。");
    error.code = "BIND_POLICY";
    throw error;
  }
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function tokenFrom(req, url) {
  const header = String(req.headers["authorization"] || "");
  if (header.toLowerCase().indexOf("bearer ") === 0) return header.slice(7).trim();
  const custom = req.headers["x-aoye-token"];
  if (typeof custom === "string" && custom) return custom;
  return url.searchParams.get("token") || "";
}

function isAuthorized(req, url) {
  if (!ACCESS_TOKEN) return true;
  return safeEqual(tokenFrom(req, url), ACCESS_TOKEN);
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload, headers) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, Object.assign({ "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) }, headers || {}));
  res.end(body);
}

function sendText(res, status, text, type) {
  res.writeHead(status, { "content-type": type || "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.resume(); // 继续读完，保证能正常回写 413 JSON
        reject(Object.assign(new Error("请求体超过上限 " + Math.round(limit / 1024 / 1024) + "MB"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on("error", (error) => { if (!done) reject(error); });
  });
}

function serveStatic(res, urlPath) {
  const clean = urlPath.split("?")[0];
  const relative = clean === "/" ? "index.html" : clean.replace(/^[/]+/, "");
  const root = path.resolve(PUBLIC_DIR);
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) return sendText(res, 403, "forbidden");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendText(res, 404, "not found");
  const ext = path.extname(file);
  res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

/** 只认文件魔数，不认 content-type（P2-2）。 */
function sniffImageMime(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.slice(4, 8).toString("ascii") === "ftyp") return "image/heic";
  return null;
}

function rulesSummary() {
  const scale = getScale(ruleset, "appearance");
  return {
    main: ruleset.main,
    baseline: ruleset.baseline,
    coverage: ruleset.coverage,
    counts: {
      scales: ruleset.scales.length,
      dimensions: ruleset.dimensions.length,
      rules: ruleset.rules.length,
      executableRules: ruleset.executableRules.length,
      knowledgeExecutableRules: ruleset.coverage.knowledge.executableRules,
      advisoryRules: ruleset.advisoryRules.length,
      unstructuredRules: ruleset.unstructuredRules.length,
      bands: ruleset.bands.length
    },
    appearanceScale: scale ? { id: scale.id, name: scale.name, min: scale.min, max: scale.max, anchors: scale.anchors } : null,
    warnings: ruleset.warnings,
    provider: { configured: config.configured, baseUrl: safeBaseUrl(config.baseUrl), model: config.model, vision: config.vision },
    auth: { tokenRequired: Boolean(ACCESS_TOKEN), host: HOST }
  };
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const urlPath = url.pathname;
  if (req.method === "GET" && urlPath === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      rulesVersion: ruleset.main.version,
      modelConfigured: config.configured,
      knowledge: {
        rules: ruleset.coverage.knowledge.rules,
        executableRules: ruleset.coverage.knowledge.executableRules,
        scoredDimensions: ruleset.coverage.knowledge.scoredDimensions,
        usableBands: ruleset.coverage.knowledge.usableBands
      },
      evidenceIndependence: (function () {
        const independence = loadIndependence(INDEPENDENCE_PATH);
        return { path: independence.path, available: independence.available, provisional: independence.provisional, note: independence.note };
      })(),
      evidenceQualityFlags: { available: qualityFlags.available, provisional: qualityFlags.provisional, highCount: qualityFlags.highCount, totalFlags: qualityFlags.totalFlags, note: qualityFlags.note },
      baselineExecutableRules: ruleset.coverage.baseline.executableRules,
      factsCoverage: factsInspection.coverage ? {
        ok: factsInspection.coverage.ok,
        declaredCount: factsInspection.coverage.declaredCount,
        injectableCount: factsInspection.coverage.injectableCount,
        internalDeclared: factsInspection.coverage.internalDeclared,
        declaredNotInjectable: factsInspection.coverage.declaredNotInjectable,
        injectableNotDeclared: factsInspection.coverage.injectableNotDeclared
      } : null,
      warnings: ruleset.warnings,
      auth: { tokenRequired: Boolean(ACCESS_TOKEN), bindHost: HOST }
    });
  }
  if (req.method === "GET" && urlPath === "/api/form") {
    return sendJson(res, 200, { fields: fieldsDoc.fields, groups: fieldsDoc.groups, version: fieldsDoc.version });
  }
  if (req.method === "GET" && urlPath === "/api/meta") {
    return sendJson(res, 200, rulesSummary());
  }
  if (req.method === "GET" && urlPath === "/api/sample") {
    const requested = url.searchParams.get("case") || undefined;
    const sample = buildSample(CASES_PATH, requested);
    if (sample.error) return sendJson(res, 404, sample);
    return sendJson(res, 200, sample);
  }
  if (req.method === "GET" && urlPath === "/api/reports") {
    return sendJson(res, 200, { reports: store.listReports(50) });
  }
  if (req.method === "POST" && urlPath === "/api/photos") {
    const declared = String(req.headers["content-type"] || "").split(";")[0];
    if (declared.indexOf("image/") !== 0) return sendJson(res, 415, { error: "只接受图片（image/*）" });
    const body = await readBody(req, MAX_PHOTO_BYTES);
    if (!body.length) return sendJson(res, 400, { error: "空文件" });
    const mime = sniffImageMime(body);
    if (!mime) return sendJson(res, 415, { error: "文件内容不是支持的图片格式（JPEG / PNG / WebP / HEIC）" });
    const photo = store.savePhoto(body, mime);
    return sendJson(res, 200, { id: photo.id, mime: photo.mime, bytes: photo.bytes });
  }
  const photoMatch = urlPath.match(/^[/]api[/]photos[/]([A-Za-z0-9_-]+)$/);
  if (req.method === "GET" && photoMatch) {
    const photo = store.getPhoto(photoMatch[1]);
    if (!photo) return sendJson(res, 404, { error: "照片不存在" });
    res.writeHead(200, { "content-type": photo.mime, "content-length": photo.bytes, "cache-control": "private, max-age=3600" });
    return fs.createReadStream(photo.file).pipe(res);
  }
  if (req.method === "POST" && urlPath === "/api/report") {
    const raw = await readBody(req, MAX_JSON_BYTES);
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "请求体不是合法 JSON" });
    }
    const validation = validateSubmission(payload.form, fieldsDoc);
    if (!validation.ok) return sendJson(res, 422, { error: "表单校验失败", details: validation.errors });
    const photoIds = Array.isArray(payload.photoIds) ? payload.photoIds.slice(0, MAX_PHOTOS) : [];
    const photos = [];
    for (const id of photoIds) {
      const photo = store.getPhoto(String(id));
      if (!photo) return sendJson(res, 422, { error: "照片不存在：" + id });
      photos.push(photo);
    }
    const cityInfo = cityTierInfo(validation.clean.city, cities);
    const report = await generateReport({
      form: validation.clean,
      photos,
      ruleset,
      cities,
      config,
      independencePath: INDEPENDENCE_PATH,
      extrapolationPath: EXTRAPOLATION_PATH,
      cityTier: cityInfo.tier,
      cityMatched: cityInfo.matched
    });
    report.warnings = validation.warnings;
    store.saveReport(report);
    return sendJson(res, 200, { id: report.id, report });
  }
  const reportMatch = urlPath.match(/^[/]api[/]report[/]([A-Za-z0-9_-]+)$/);
  if (req.method === "GET" && reportMatch) {
    const report = store.getReport(reportMatch[1]);
    if (!report) return sendJson(res, 404, { error: "报告不存在" });
    return sendJson(res, 200, report);
  }
  return sendJson(res, 404, { error: "未知接口：" + req.method + " " + urlPath });
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
  const urlPath = url.pathname;
  try {
    if (urlPath.indexOf("/api/") === 0 && urlPath !== "/api/health" && !isAuthorized(req, url)) {
      return sendJson(res, 401, { error: "未授权：需要访问令牌", howTo: "设置 AOYE_ACCESS_TOKEN 后，用 Authorization: Bearer <token>、x-aoye-token 头或 ?token= 参数访问。" }, { "www-authenticate": "Bearer" });
    }
    if (urlPath.indexOf("/api/") === 0) return await handleApi(req, res, url);
    const reportPage = urlPath.match(/^[/]r[/]([A-Za-z0-9_-]+)$/);
    if (reportPage) return serveStatic(res, "/report.html");
    return serveStatic(res, urlPath);
  } catch (error) {
    const status = error && error.statusCode ? error.statusCode : 500;
    if (status === 500) console.error("[error]", error);
    return sendJson(res, status, { error: error && error.message ? error.message : "内部错误" });
  }
}

export function createServer() {
  return http.createServer(handleRequest);
}

export function startServer(port, host) {
  const bindHost = host || HOST;
  assertBindPolicy(bindHost, ACCESS_TOKEN);
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port === undefined ? 0 : port, bindHost, () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port, baseUrl: "http://" + bindHost + ":" + server.address().port });
    });
  });
}

function onListening(actualPort) {
  const base = "http://" + HOST + ":" + actualPort;
  console.log("鳌烨择偶定位系统 · web 骨架已启动");
  console.log("  地址        : " + base);
  console.log("  访问令牌    : " + (ACCESS_TOKEN ? "已启用（所有 API 需带 token）" : "未启用（仅限本机回环访问）"));
  console.log("  规则集      : " + MAIN_RULES + " (v" + ruleset.main.version + ", 覆盖率 " + ((ruleset.main.corpus && ruleset.main.corpus.coveragePct) || "未知") + "%)");
  console.log("  可执行规则  : knowledge " + ruleset.coverage.knowledge.executableRules + " 条 / baseline " + ruleset.coverage.baseline.executableRules + " 条");
  console.log("  参考规则    : advisory " + ruleset.advisoryRules.length + " 条 / 未结构化 " + ruleset.unstructuredRules.length + " 条");
  console.log("  基线补缺    : " + BASELINE_RULES + " (未取证)");
  console.log("  数据目录    : " + DATA_DIR);
  if (envLocal.loaded) {
    console.log("  本地配置    : 已加载 " + envLocal.path + "（生效 " + envLocal.applied.length + " 项，环境变量优先跳过 " + envLocal.skippedExisting.length + " 项）");
  }
  console.log("  模型        : " + (config.configured ? safeBaseUrl(config.baseUrl) + " / " + config.model + " / key=已设置" : "未配置（纯表单模式）"));
  envLocal.warnings.forEach((warning) => console.warn("  [env] " + warning));
  if (factsInspection.coverage) {
    console.log("  字段覆盖    : facts.json 声明 " + factsInspection.coverage.declaredCount + " / 可注入 " + factsInspection.coverage.injectableCount
      + " / 声明未注入 " + factsInspection.coverage.declaredNotInjectable.length
      + " / 注入未声明 " + factsInspection.coverage.injectableNotDeclared.length);
  }
  if (factsInspection.warnings.length) console.log("  （facts.json 的 warnings 是声明方备注；与上面的字段覆盖检查冲突时，以现场检查为准）");
  factsInspection.warnings.forEach((warning) => console.warn("  [facts.json] " + warning));
  ruleset.warnings.forEach((warning) => console.warn("  [warn] " + warning));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    assertBindPolicy(HOST, ACCESS_TOKEN);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const server = createServer();
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      console.error("端口 " + PORT + " 已被占用：请换一个 PORT（如 PORT=8899 node web/server.mjs），或先停止占用该端口的进程。");
      process.exit(3);
    }
    throw error;
  });
  server.listen(PORT, HOST, () => onListening(server.address().port));
}

export { ruleset, store, config, cities, fieldsDoc, ACCESS_TOKEN, HOST, REPO_ROOT, WEB_DIR };
