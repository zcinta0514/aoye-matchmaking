# independence-reconciliation · 作者提级对账（D29 后）

> 权威数据：`knowledge/evidence-independence.json`（本 Worker 维护，唯一独立性口径）
> 快照：`rules.json` md5 `9451c2e7b1eeceaeeea4050fd783966a`（159 条 / 427 证据）
> 触发：D29——同品牌/矩阵**同稿复述**不得升级为 cross-account / verified；definitional 可记 `matrixRepetition`（非独立验证）；market-norm 不适用矩阵复述；event-rule 按 D29.1 可保留但须标注。
> 用途：供 `distill-looks` / `distill-dims` 直接对照修改 `sources` / `sourceCounts` / `matrixRepetition`，消除与权威数据的矛盾。

## 0. 判据（按优先级）

1. **同一 aweme_id**（抖音共创多号分发）→ 只能算 1 个来源；索引见 `evidence-independence.json.coCreationLayer.sharedAwemeIndex`。
2. **同内容 / 同稿骨架复述**（逐字或轻改；runChars ≥14 或骨架相似度 frac ≥0.8）→ 1 个来源。
3. **渠道口径**：`market-norm` 不得用矩阵复述升级；`definitional` 可改记 `matrixRepetition`（只是"该表在用"）；`event-rule` 可按 D29.1 保留（须标注机构矩阵口径）；`marketing` 只能 advisory。
4. 判定方法：在当前 159 条版上做机械重算（同内容/同稿/同 aweme/同模板簇合并；同 author 标签不自动合并）**再人工回读证据**，两边不一致时以人工结论为准并写明原因。

## 1. part.01（distill-looks）—— 字段可识别 10 条（作者报 11 条）

| 规则 | 作者声称 | 我的判定 | 判据（涉及账号 / 证据） | 建议操作 |
|---|---|---|---|---|
| R-LOOKS-002 | 2 账号 | **回退 single-source** | 新增来源 `aoye28/7519240483915238665`「颜值的中位数就是4分」= aoye98 镜像号，按 D29 剔除 | `sources.accounts` 改 1；移除 aoye28 |
| R-LOOKS-006 | 3 账号 | **保留（event-rule）** | 新增 `aoye020/7628250558563308921`「6分=从小到大不缺女生追」为不同账号的独立表述；event-rule 按 D29.1 有效 | 保留 cross-account；文案标注「机构矩阵口径」 |
| R-LOOKS-007 | 2 账号 | **回退** | 新增 `aoye28/7532408578411760942`（"最高有效分5.7/5.8"）为镜像号 | 移除 aoye28 |
| R-LOOKS-009 | 2 账号 | **回退** | 新增 `aoye28/7533706165239205155`（7分靠脸吃饭）为镜像号 | 移除 aoye28 |
| R-LOOKS-010 | 2 账号 | **回退** | 新增 `aoye28/7657152085863058734`（8.5=国花）为镜像号 | 移除 aoye28 |
| R-LOOKS-013 | 3 账号 | **回退（保守）** | 两条新增均为 aoye28 镜像；`aoye184/7691940350286474943`「170,105…黄金身高」是矩阵口头禅式复述（换号同说法），不构成独立标准 | 保留 1 账号；需要第二来源须非矩阵 |
| R-LOOKS-014 | 2 账号 | **回退** | 新增为 aoye28 镜像号 | 移除 aoye28 |
| R-LOOKS-016 | 2 账号 | **回退** | `aoye184/7691940350286474943` 句「身材也很好呀…不止5分」是直播即时夸奖，不是"皮肤/身材/穿搭并列条件"的独立陈述 | 删除该升级 |
| R-LOOKS-023 | 2 账号 | **回退** | `78949694532/7658960500626600441`「男生太胖了没人要」是另一主张（男胖市场价值），不是"高分维持项"的互证 | 删除该升级 |
| R-LOOKS-025 | 2 账号 | **回退** | aoye28 镜像 + 机械检出同稿骨架（script-repeat run15 / frac1.0） | 移除 aoye28 |

> 差额：作者报 11 条，`sources` 字段只能识别出 10 条；**请 distill-looks 补上第 11 条的规则 id**。

## 2. part.02（distill-dims）—— 字段可识别 9 条（作者报 19 条）

这 9 条的"第二来源"全部是 **LRHzixun/7645260387449554533**——对《月老鳌烨·男生硬件评分表》的**逐项复述**（作者自己在 scopeNote 里写作"第二处逐项复述"）。按 D29：**不得计 cross-account / verified，改记 matrixRepetition**（仅表示该表在机构内被实际使用）。

建议字段（全部 9 条通用，按各自 evidence 微调账号）：
```json
"matrixRepetition": {
  "accounts": ["47590488570", "LRHzixun"],
  "note": "《男生硬件评分表》在月老鳌烨矩阵内被 2 个账号实际使用（含 1 处逐项复述）；仅表示该表在用，不代表独立验证。"
}
```

| 规则 | 作者声称 | 新增来源 | 判定 | 备注 |
|---|---|---|---|---|
| R-DIM-002 | 2 账号 | LRHzixun/7645260387449554533 | **matrixRepetition** | 整表逐项复述（60/80、175、本科、100平、车、10万…） |
| R-DIM-011 | 2 账号 | 同上 | **matrixRepetition** | 「全日制本科+10」单项复述；其余 985/211 证据按各自主张另计 |
| R-DIM-014 | 2 账号 | 同上 | **matrixRepetition** | 「体制内+10」单项复述 |
| R-DIM-016 | 2 账号 | 同上 | **matrixRepetition** | 「税后10万+10」单项复述；20–30万口径另有单源文本 |
| R-DIM-017 | 2 账号 | 同上 | **matrixRepetition** | 「100平/全款+10」单项复述 |
| R-DIM-018 | 2 账号 | 同上 | **matrixRepetition** | 「有车+10、20万再+10」单项复述 |
| R-DIM-022 | 2 账号 | 同上 | **matrixRepetition** | 「父母退休金+10」单项复述 |
| R-DIM-023 | 2 账号 | 同上 | **matrixRepetition** | 「原生家庭幸福+10」单项复述 |
| R-DIM-024 | 2 账号 | 同上 | **matrixRepetition** | 「独生子女+10」单项复述（机械重算后仍为单账号） |

> 差额：作者报 19 条，`sourceCounts` 字段只能识别出 9 条；**请 distill-dims 补上其余 10 条的规则 id 与新增账号**，我按同一口径复核。

## 3. 汇总（给 Lead）

| 项 | 数量 |
|---|---|
| 字段可识别的作者提级 | **19**（looks 10 + dims 9） |
| 建议保留 | **1**（R-LOOKS-006，event-rule，D29.1） |
| 建议回退 single-source | **9**（R-LOOKS-002/007/009/010/013/014/016/023/025） |
| 建议改 matrixRepetition（仅定义型） | **9**（R-DIM-002/011/014/016/017/018/022/023/024） |
| 作者报告总数 vs 字段可识别 | 30（19+11） vs 19；**差额 11 条待两位作者提供 id** |

应用本清单后的**有效强度**（全 159 条）：**verified 47 / cross-account 21 / single-source 91**（机械重算原始值为 58/21/80；差值来自本次回退与 matrixRepetition 重标）。

## 4. 附：part.03 / part.04 同口径 watchlist（非本次两作者，建议同样过三门）

同一扫描发现 part.03/04 也有"作者声称 ≥2 账号"的条目，需按同一标准复核：
- **机械回退（6）**：R-MATCH-003（检出 same-aweme 合并）、R-MATCH-004、R-MATCH-026（content-dup run22 + script-repeat run29）、R-DEMO-001、R-DEMO-012、R-DEMO-013。
- **event-rule 保留但须标注（4）**：R-MATCH-012、R-MATCH-013、R-MATCH-014、R-DEMO-006。
- **高风险 keep，建议抽读（6）**：R-MATCH-027（声称 5 账号；"女生真实排序"是矩阵同稿高发句）、R-MATCH-051（组内检出 same-aweme 对）、R-MATCH-029、R-MATCH-036、R-MATCH-044、R-DEMO-007。
- 其余条目的机械判定见 `evidence-independence.json.ruleEvidence[].verdictVsAuthor`。

## 5. 作者操作说明

1. **回退**：把镜像号（aoye28）从 `sources/sourceCounts` 的独立账号计数里移除；若 machine 判定依赖该多账号，同步降级或加 `requireEvidence`。
2. **matrixRepetition**：只加在 `definitional` 规则上，写清"该表在机构内被 N 个账号使用"，**不要**把它算进 `sources.accounts`。
3. **event-rule**：可保留矩阵复述，但用户可见文案必须标注"仅代表该主办方/该场活动"。
4. 修改后跑 `node tools/check_rules.mjs knowledge/rules.part.0X.json` 与本文件对照，保持与 `evidence-independence.json` 一致。
