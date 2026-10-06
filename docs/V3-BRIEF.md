# V3 执行简报：完整语料全量重扫

> 语料已完成：**3533 条 / 78.2 小时（有效约 76.7h）**，2026-10-06
> 此前所有工作都基于 **部分语料**（v1 时 1511 条 / 28.2 小时）。现在用完整语料重扫。

---

## 〇、为什么重扫是必要的（不是重复劳动）

1. **`aoye28` 的 37 小时直播几乎全是新增** —— 你此前基于的语料里它只占很少。
   `distill-match` 的「心智首选」当时只有 2 条证据，原因就是缺料。
2. **大量「单源」可能升级** —— 现在 99/153 条规则标 `single-source`。语料翻倍后，
   很多会有第二个独立来源 → 自动升级为 `cross-account` 或 `verified`。
   **委托人最关心的可读性问题（灰标太多），大概率靠这一步真实变好，而不是靠放宽标准。**
3. **新增跨账号口径差异** —— 如 7 分可达性（`aoye98` 说不可达 vs `aoye28` 多例直接给 7 分）、
   女身高 172/174「黄金身高」、年龄差 +12/+20。需要系统性重核。

---

## 一、五条硬约束（不变，仍然是最低线）

| # | 约束 |
|---|---|
| **H1** | 每条规则二选一：`machine: {when, then}` 或 `advisory: true` |
| **H2** | `machine.when.field` 只能取 `knowledge/facts.json`（39 字段 + 22 派生 + 18 照片维度） |
| **H3** | 数字阈值只能取 `knowledge/standards.json` 的 hard 项；derived 禁止进硬判定 |
| **H4** | 面向用户的文本过 `knowledge/ethics-policy.json` 门禁（当前 0 命中，保持） |
| **H5** | 证据 `quote` 必须是转写口语原文，可被 `check_rules.mjs` 溯源 |

## 二、主张分类（D25/D27，新增要求）

每条规则必须带 `claimType`：
- `market-norm` —— 市场规律（**经验型需多源才算 hard**）
- `event-rule` —— 主办方/场次准入（**用户可见文案必须写「仅代表该主办方/该场活动」**）
- `marketing` —— 获客话术（**不得作为规律输出，只能进 advisory**）

**D27 关键**：城市矩阵号单条产出的「当地特点」**默认按 marketing 处理**，除非有跨机构或非招募场景的第二来源。机构自制的评分表显示为「评分表口径」。

另加 `kind`：`definitional`（博主陈述的表/门槛，可单源 hard + 公示 sources）/ `empirical`（市场断言，必须多源）。
**不变式：`hard + empirical + 单源` 必须为 0**（当前已成立，保持）。

## 三、其他既定裁定（重扫时必须延续）

- **D6**：名次/位次只输出区间，禁单点精确值
- **D23**：放弃项（`giveUp`）用 `want.*_gap > 0` 的**方向判断**，不用语料阈值
- **D14/D24**：不得输出自创的 S/A/B/C；用 `rules.json` 的 9 条 bands（博主自己的词汇）
- **D21**：定义型可单源 hard 但必须带 `sources: {transcripts, accounts}`
- **D22**：有反例的数字必须删；命中标准有未解决冲突时不得用单一口径进硬判定
- **数字噪声**：`knowledge/evidence-quality-flags.json` 标 `severity: high` 的转写，
  引用其数字前必须回听或换互证来源（`distill-demo` 可协助回听）

## 四、本次重扫的重点动作（按优先级）

1. **提级**：把现有 `single-source` 规则在新语料里找第二来源 → 升 `cross-account` / `verified`。
   **这是本次最高价值动作**——它同时提升正确性与报告可读性。
2. **补新规则**：完整语料（尤其 `aoye28` 直播）里此前没有的判定条件。
3. **重核冲突**：7 分可达性、女身高多口径、年龄差口径、收入城市系数。
4. **修陈旧**：此前基于不完整语料下的结论，若有新证据推翻，改掉并记录。

## 五、产出与验收

- 只改自己的文件（见各人任务书）
- `node tools/check_rules.mjs knowledge/rules.part.0X.json` → **零 error 零 warn**
- `node tools/preview_rules.mjs` → 合并零 error 零 warn
- `node tools/ethics_scan.mjs` → 自己文件零命中
- `node tools/preflight.mjs` → 五项全绿

## 六、汇报要求（统一格式）

1. 本次**提级**了几条（single-source → cross-account/verified），列 id
2. 新增了几条规则、覆盖哪些此前无规则的场景
3. **哪几条被新语料推翻或修改**（比新增更重要）
4. 仍为单源的条数（诚实度指标）
5. 未解决的口径冲突
