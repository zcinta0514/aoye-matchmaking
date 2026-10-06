import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function newId(prefix) {
  return (prefix || "id") + "_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 按 step 向下 / 向上取整（浮点安全）。 */
export function floorStep(value, step) {
  return roundTo(Math.floor(value / step + 1e-9) * step, 3);
}

export function ceilStep(value, step) {
  return roundTo(Math.ceil(value / step - 1e-9) * step, 3);
}

export function roundTo(value, digits) {
  const factor = 10 ** (digits === undefined ? 2 : digits);
  return Math.round(value * factor) / factor;
}

export function formatNumber(value, digits) {
  if (typeof value !== "number" || Number.isNaN(value)) return String(value);
  const rounded = roundTo(value, digits === undefined ? 2 : digits);
  let text = String(rounded);
  if (text.indexOf(".") !== -1) {
    while (text.endsWith("0")) text = text.slice(0, -1);
    if (text.endsWith(".")) text = text.slice(0, -1);
  }
  return text;
}

/** {{path.to.value}} 模板渲染；缺失值渲染为「—」。手写解析，避免正则转义噪音。 */
export function renderTemplate(text, facts) {
  const source = String(text === undefined || text === null ? "" : text);
  if (source.indexOf("{{") === -1) return source;
  const parts = source.split("{{");
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const chunk = parts[i];
    const close = chunk.indexOf("}}");
    if (close === -1) {
      out += "{{" + chunk;
      continue;
    }
    const pathExpr = chunk.slice(0, close).trim();
    const value = getPath(facts, pathExpr);
    out += (value === undefined || value === null ? "—" : (typeof value === "number" ? formatNumber(value) : String(value))) + chunk.slice(close + 2);
  }
  return out;
}

export function getPath(obj, pathExpr) {
  if (!pathExpr) return undefined;
  const parts = pathExpr.split(".");
  let current = obj;
  for (let i = 0; i < parts.length; i += 1) {
    if (current === null || current === undefined) return undefined;
    const rest = parts.slice(i).join(".");
    if (typeof current === "object" && rest in current) return current[rest];
    current = current[parts[i]];
  }
  return current;
}

export function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
