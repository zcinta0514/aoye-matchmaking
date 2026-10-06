import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "../lib/ruleset.mjs";

const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(WEB_DIR);
const ruleset = loadRuleset({ mainPath: path.join(REPO_ROOT, "knowledge", "rules.json"), baselinePath: path.join(WEB_DIR, "config", "baseline-rules.json") });

/* 降本筛选的防漂移锁：被删的维度必须「不影响任何规则/分数」。
   —— 若以后有人给这些基线维度接上规则、或知识库把权重/评分补到它们身上，本测试会红。 */
test("照片维度前置筛选：只删不影响任何规则/分数的演示基线维度（24 → 18）", () => {
  const appearance = ruleset.dimensions.filter((dim) => dim.group === "appearance");
  const excluded = appearance.filter((dim) => dim._origin === "web-baseline");
  const kept = appearance.filter((dim) => dim._origin !== "web-baseline");
  assert.equal(appearance.length, 24, "外观维度总数应为 24（6 演示基线 + 18 知识库）");
  assert.equal(excluded.length, 6, "被筛掉的演示基线维度应为 6 个");
  assert.equal(kept.length, 18, "送进模型的维度应为 18 个");

  const refs = new Set();
  (ruleset.rules || []).forEach((rule) => {
    const text = JSON.stringify(rule.machine || "") + JSON.stringify(rule.then || "");
    (text.match(/photo\.[A-Za-z0-9_.]+/g) || []).forEach((field) => refs.add(field));
  });

  excluded.forEach((dim) => {
    assert.equal(refs.has("photo." + dim.id), false, "被删维度不得被任何规则引用：" + dim.id);
    assert.ok(!dim.scoring, "被删维度不得带评分定义：" + dim.id);
    assert.ok(!(typeof dim.weight === "number" && dim.weight > 0), "被删维度不得带权重：" + dim.id);
  });
  /* 反向：规则真正引用到的（且能注入的）维度必须留在保留集合里，防止把有用的维度删掉。 */
  const keptIds = new Set(kept.map((dim) => dim.id));
  const allIds = new Set(appearance.map((dim) => dim.id));
  refs.forEach((field) => {
    const id = field.slice("photo.".length);
    if (allIds.has(id)) assert.ok(keptIds.has(id), "被规则引用的维度不得被删：" + id);
  });
});
