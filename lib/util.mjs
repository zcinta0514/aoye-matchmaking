/* 静态版 util：保留纯函数；readJson 走预加载缓存；writeJsonAtomic 落 localStorage。 */

export { readJson } from "./load-browser.mjs";

export function writeJsonAtomic(file, value) {
  localStore.set(String(file), JSON.stringify(value));
  return value;
}

export const localStore = {
  set(key, text) { try { window.localStorage.setItem(key, text); } catch { /* 隐私模式 */ } },
  get(key, fallback) {
    try {
      const text = window.localStorage.getItem(key);
      return text === null ? fallback : text;
    } catch {
      return fallback;
    }
  },
  getJson(key, fallback) {
    const text = this.get(key, null);
    if (text === null) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
  },
  setJson(key, value) { this.set(key, JSON.stringify(value)); }
};

export function newId(prefix) {
  return (prefix || "id") + "_" + Date.now().toString(36) + Math.random().toString(16).slice(2, 10);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function roundTo(value, digits) {
  const factor = 10 ** (digits === undefined ? 2 : digits);
  return Math.round(value * factor) / factor;
}

export function floorStep(value, step) {
  return roundTo(Math.floor(value / step + 1e-9) * step, 3);
}

export function ceilStep(value, step) {
  return roundTo(Math.ceil(value / step - 1e-9) * step, 3);
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

export function renderTemplate(text, facts) {
  const source = String(text === undefined || text === null ? "" : text);
  if (source.indexOf("{{") === -1) return source;
  const parts = source.split("{{");
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const chunk = parts[i];
    const close = chunk.indexOf("}}");
    if (close === -1) { out += "{{" + chunk; continue; }
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
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
