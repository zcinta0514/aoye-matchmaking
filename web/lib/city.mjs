import { readJson } from "./util.mjs";

let cache = null;

export function loadCities(file) {
  if (!cache || cache.file !== file) {
    const doc = readJson(file);
    const normalize = (list) => list.map((name) => String(name).replace(/[市区县]$/, ""));
    cache = {
      file,
      tier1: new Set(normalize(doc.tier1 || [])),
      tier2: new Set(normalize(doc.tier2 || [])),
      defaultTier: doc.defaultTier || 3
    };
  }
  return cache;
}

export function cityTier(city, cities) {
  return cityTierInfo(city, cities).tier;
}

/** 返回 { tier, matched, name }：matched=false 表示城市不在分档表里（按默认档处理，报告需提示）。 */
export function cityTierInfo(city, cities) {
  if (!city) return { tier: cities.defaultTier, matched: false, name: "" };
  const name = String(city).trim().replace(/[市区县]$/, "");
  if (cities.tier1.has(name)) return { tier: 1, matched: true, name };
  if (cities.tier2.has(name)) return { tier: 2, matched: true, name };
  return { tier: cities.defaultTier, matched: false, name };
}
