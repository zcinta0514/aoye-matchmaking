# 案例回归测试报告（CASE-CALIBRATION v3 · D24 口径）

> 本报告的定位：**引擎的规则覆盖与证据强度可测；结论正确率当前不可测**（D24）。下面的百分比不作为结论使用。

> 运行方式：node tools/case_regression.mjs（可选 --max-mismatch=N）；预览合并快照：node tools/preview_rules.mjs --regress
> 输入：knowledge/cases.json（45 条，指纹 94765ba079d8）
> 引擎：knowledge/rules.json（v1.1） + web/config/baseline-rules.json（v0.1.0-baseline，演示基线）
> 机器可读结果：knowledge/case-calibration.json
> 伦理：本文件的引文政策与用词已通过 node tools/ethics_scan.mjs（0 命中）。

## 零、为什么这套体系当前无法自测准确率

**一句话结论：引擎的规则覆盖与证据强度可测；结论正确率当前不可测。**（D24）

### 0.1 两个硬约束（本轮可评估案例 = 0 的直接原因）

1. **档位维度没有语料证据**：引擎输出的 S/A/B/C 来自 baseline 的数值区间，属 engineering-default。语料里并没有 A/B/C 这套体系——它是我们自己发明的词汇。**拿自己的发明去对着不含该发明的数据做验证，本身没有意义**。因此档位维度 16/16 记 not-comparable，不进任何指标。
2. **颜值维度要「标注 + 输入」同时具备**：案例里的颜值分是博主的判断（标注），而引擎需要用户自评（输入）；语料里两者很少同时出现。16 条正向案例只有 1 条满足。

### 0.2 本轮实际卡点：缺必填输入（D19.1）

- 产品表单 29 项必填里有 16 项是用户自评/偏好（人格、沟通、情绪、颜值自评与校准、择偶期望），直播连麦的转写里根本不存在；其余必填项也大多没被问到。
- 45/45 条案例缺必填输入 → 按 D19.1 记 unsupported: missing-required-input，**不把 null 传给引擎算假分**。
- 平均每条缺 23/29 项；缺得最少的 C-003 也缺 19 项。

### 0.3 已修正的三类标注错误（保留此节便于审计）

1. **语境误读（D14，7 条）**：C-004/C-012 是「进前 3 才触达」的条件性上限；C-007 的「A8 家庭」出现在反证句里；C-026/C-032 是 n=1 的正向个案；另补查出 C-014（反证）、C-015（条件句）。
2. **关键词启发式误判（已永久废弃，D24）**：把「天花板」当降档词（C-006 实为正向可达上限）、把反证句里的「A8 家庭」当 S 档（C-007）、把 n=1 的「准第一梯队」当档位证据。代码里的 S/A/B/C 关键词表已改名作废，不再被引用。
3. **拿结论当输入（derivedFromVerdict，6 条）**：C-010/C-022/C-026/C-029/C-035/C-045 的 appearanceNote 是博主的判断，已标 usedAsEngineInput:false，回归时自动跳过。

## 零之一、这套体系今天能 / 不能回答什么

### 能回答

1. **规则覆盖**：哪些场景有规则、哪些案例因素完全没有维度/规则。当前缺口 Top：体重维度（11 条）、手足性别与排序（10 条）、期望对方职业/编制（9 条）、家庭资产档位（9 条）、期望对方收入下限（7 条）。
2. **证据强度**：每条规则/维度带几条语料、跨几个账号（verified / cross-account / single-source / extrapolated / engineering-default），未取证的会被明标。
3. **哪些数字站不住**：baseline 的 S/A/B/C 数值区间、engineering-default 权重、以及所有未经语料支持的默认值。
4. **结构性事实**：地域差异、单位口径（月薪↔年收入、斤↔kg、家庭房产↔本人名下）、表单与语料的结构不匹配、哪些字段永远拿不到。
5. **回归护栏**：引擎对给定输入是否给出与语料方向相反的结论（反向建议）、是否崩溃/异常；本轮 0 崩溃、0 护栏 mismatch。

### 不能回答

1. **引擎结论的正确率**：本轮可评估分母 = 0，无法计算；报告不输出任何百分比作为结论。
2. **S/A/B/C 档位**：该系统不是语料的词汇，已停止作为结论输出，只能当带 engineering-default 标签的参照刻度。
3. **颜值分的预测精度**：需要同一人同时具备「博主打分」与「用户自评」，当前语料里不成立。
4. **各档位的人数分布与阈值**：语料没有 level→档位 的区间证据，禁止为此发明区间。

## 零之二、要让它可测，需要什么（下一阶段工作定义）

| # | 前置条件 | 验收标准 | 影响 |
|---|---|---|---|
| 1 | 产品表单允许「未知 / 不便填写」（或提供仅照片的合法提交路径） | 存在一条不依赖 29 项必填的合法提交路径，或必填项降到 ≤10 项 | 不解决，可评估分母永远是 0 |
| 2 | 博主对同一人给出档位表述（用他自己的词：打分局名次 / A9 / 活动渠道） | ≥30 条，同一档位 ≥3 条独立语料、跨 ≥2 个账号 | 不解决，档位维度永远 not-comparable |
| 3 | 同一人同时具备「博主打分（他评）」与「用户自评」 | ≥30 条且覆盖 4 个分档 | 不解决，颜值轨道精度无法验证 |
| 4 | 引擎档位输出改用 rules.json 的 9 条 bands id 并透出到报告 JSON | 报告里出现 asset.a9 / match.rank.t1 这类 id | 不解决，案例的档位引用无法与引擎对齐 |
| 5 | 补标注语料已问到的条件（身高/学历/职业/收入/房车/家庭/婚史） | 正向案例 ≥80% 满足「自述条件齐全」 | 把「语料问题」的缺失降下来 |
| 6 | standards.json 给出 level→档位 的语料证据，或显式声明不产出档位 | 有 ≥1 条 hard 证据，或规则集显式放弃该维度 | 决定档位维度是否还有存在意义 |
| 7 | 回归工具永久单列「缺必填输入」「not-comparable」，禁止计入分母 | CI 在未取证数据上不得输出百分比 | 防止再次出现虚假精确 |

**最关键的 3 条**：① 第 1 条（表单允许「未知」）——不解决它，分母恒为 0；② 第 2 条（博主的档位表述 ≥30 条）——不解决它，档位永远不可比；③ 第 3 条（他评 + 自评同人 ≥30 条）——不解决它，颜值精度无法验证。

## 零之三、三态分布与解锁模型（把分母做大要花什么代价）

### 3.1 每条案例的三态（判定规则，写死在工具里）

| 状态 | 判定规则 | 案例数 |
|---|---|---|
| evaluable（可评估） | 必填项齐全，直接跑引擎 | 0 |
| blocked:missing-form-input（因缺必填输入不可评估） | 缺任何一项“用户自评/偏好”类必填（语料结构上没有） | 45 |
| blocked:missing-corpus-condition（因缺语料条件不可评估） | 表单项齐，但缺“语料本可提供”的自述条件 | 0 |

逐条状态见第六节（每条都有状态列与“缺 X 项表单 / Y 项语料”计数）。

### 3.2 为什么单个动作解锁不了

| 只做的动作 | 可评估案例数 | 原因 |
|---|---|---|
| 只允许未知项（不补语料） | 0 | 仍缺语料自述条件 |
| 只补语料标注（不允许未知） | 0 | 仍缺 12–13 项用户自评/偏好 |
| **A + B 都做，且语料补齐全部 14 个字段** | 45 | 见 3.3 曲线（Top 12 即可到 19/45） |
| 现状（A、B 都没做） | 0 | 当前实际可评估数 |

**两张开锁表**：
- 「补标注就能解锁」= **0 条**（本轮没有“只缺语料条件”的案例）
- 「允许未知项就能解锁」= **0 条**（本轮没有“只缺表单项”的案例）
- 「两个都缺」= 45 条——所以真正要动的是两件事，缺一不可。

### 3.3 解锁曲线（每个数字对应一个可执行动作）

动作 A：表单允许 16 个用户自评/偏好项填「未知」——personality、communication、emotional_stability、living_skills、social_circle、hobbies、self_rank、admiration_freq、photo_quality、face_natural、want_height_min、want_education_min、want_house、want_appearance_min、want_age_min、want_age_max。

动作 B：给语料补标注下列字段（按缺的案例数排序，共 14 个）：hukou×45、has_car×42、marital×41、income_wan×39、school_tier×38、self_appearance×38、family_origin×37、has_house×34、siblings×31、education×28、occupation×24、height_cm×21、age×18、city×16。

| 做到哪一步 | 可评估案例数 |
|---|---|
| 现状（什么都不做） | 0 / 45 |
| + 动作 A（允许 16 项填未知） | 0 / 45（还缺语料条件） |
| + 动作 A 且补标注 Top 5 高频字段 | 0 / 45 |
| + 动作 A 且补标注 Top 8 高频字段 | 1 / 45 |
| + 动作 A 且补标注 Top 10 高频字段 | 5 / 45 |
| + 动作 A 且补标注 Top 12 高频字段 | 19 / 45 |
| + 动作 A 且补标注 Top 14 高频字段 | 45 / 45 |

- 当前平均每条缺：表单/偏好类 13 项、语料自述类 10 项。
- 结论：**先把动作 A 做掉（成本在表单侧），再补 12 个高频语料字段，可评估数就能从 0 跳到 19/45；补齐 14 个即 45/45**。这两步都不需要现有引擎改动，属于数据与产品约束的解锁。

## 一、结论语境分轨（D14）

基准集的每条案例都必须标注“博主这句话是在什么语境下说的”。**准确率只统计 positive-reachable**；其余三类单列，不计入 match/mismatch。

| verdictContext | 条数 | 含义 |
|---|---|---|
| positive-reachable | 16 | 博主正向给出的可达结论（能找到什么样的人） |
| conditional-ceiling | 3 | 条件性上限（如“先进打分局前 3 名才触达”） |
| reverse-context | 7 | 用于反证的语境（如“A8 家庭不会为颜值考虑你”） |
| unspecified | 19 | 没有择偶可达结论（多为颜值打分局案例） |

### 1.1 本轮复核发现的基准标注错误（原样保留，便于审计）

| 案例 | 原标注 | 复核结论 | 现 verdictContext |
|---|---|---|---|
| C-004 | S（A9 高净值活动） | “先去打分局，若进前 3 才触达”——条件句，不是结论 | conditional-ceiling |
| C-012 | S（厂二代 / A8 家庭） | 同上：按打分局名次分档，均为条件性画像 | conditional-ceiling |
| C-007 | S（A8 家庭） | “A8 家庭的男生不会为颜值考虑你”是反证语境 | reverse-context |
| C-026 | S（A9 家庭女生） | 正向个案，但 n=1（单条语料） | positive-reachable（n=1） |
| C-032 | S（准第一梯队） | 正向个案，但 n=1（单条语料） | positive-reachable（n=1） |
| C-014 | 无（未标语境） | “45岁月入5万不会找咱”是反证语境 | reverse-context |
| C-015 | 无（原判可达） | “可以找，前提是对方不介意你有弟弟”——条件句 | conditional-ceiling |
| C-002 / C-028 / C-029 / C-031 / C-034 | 无 | 均为反证/负面语境，此前被当作可达结论参与比对 | reverse-context |

### 1.2 逐条语境（positive-reachable 之外只做展示，不计分）

| 案例 | verdictContext | 复核说明 |
|---|---|---|
| C-002 | reverse-context | 结论是“有弟弟+非独生→门当户对变难”，对标画像是用来反证“别人比你好找”的比较对象。 |
| C-004 | conditional-ceiling | “先去打分局，若进前 3 才触达三高/A9 场”，是条件性潜在上限，不是承诺结论。 |
| C-007 | reverse-context | “A8家庭的男生不会为颜值考虑你”是反证语境（此前被误读为 S 档依据）；本案例另有正向画像（92年/存款200万/山东人），但不属 S 档声明。 |
| C-011 | unspecified | 只有“夜班减分”的通用判断与“去香港/雕琢自己”的建议，没有可达结论。 |
| C-012 | conditional-ceiling | “先去打分局，按名次对号入座”，第 1 名/前 3 名的画像都是条件性上限。 |
| C-014 | reverse-context | “45岁有房有车月入5万不会找咱”是反证语境。 |
| C-015 | conditional-ceiling | “独生子当然可以找，前提是对方不介意你有弟弟”——条件性结论。 |
| C-016 | unspecified | 只有自我介绍，没有博主结论。 |
| C-017 | unspecified | 只有“先找个班上/改值钱”，不是择偶可达结论。 |
| C-018 | unspecified | 只有颜值分，没有择偶结论。 |
| C-019 | unspecified | 只有颜值分与身高判断，没有择偶结论。 |
| C-020 | unspecified | 只有颜值分，没有择偶结论。 |
| C-021 | unspecified | 只有颜值分，没有择偶结论。 |
| C-028 | reverse-context | “那你做梦了，洗洗睡吧”是反证语境。 |
| C-029 | reverse-context | “出镜类型工作不用问上限”是反证语境（说明上限够不着）。 |
| C-030 | unspecified | 只有“不要为了结婚而结婚”的劝告，没有可达结论。 |
| C-031 | reverse-context | 结论是“期望与条件错配”，并劝其再沉淀（反证语境）。 |
| C-033 | unspecified | 只有“先谈恋爱、把自信心长出来”的建议，无可达结论。 |
| C-034 | reverse-context | 结论是带孩再婚更难（负面预期），属反证语境。 |
| C-036 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |
| C-037 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |
| C-038 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |
| C-039 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |
| C-040 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |
| C-041 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |
| C-042 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |
| C-043 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |
| C-044 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |
| C-045 | unspecified | 只有颜值分（打分局），没有择偶可达结论。 |

## 二、准确率（D19 主口径）—— 当前不可测

| 指标 | 值 |
|---|---|
| positive-reachable 案例总数 | 16 |
| **有效分母**（正向 + 至少一个可判定维度） | **0**（16 条正向案例中，16 条因缺必填输入无法评估） |
| match | 0 |
| partial | 0 |
| mismatch | 0 |
| not-comparable（无可比维度） | 16 |
| 准确率（match / 有效分母） | **无法计算（可评估案例为 0）** |

- 口径依据：D19：只统计 positive-reachable 且在“颜值区间命中 / 档位方向命中”里至少一项可判定的案例；缺必填输入（D19.1）与 not-comparable 都不进分母，但必须单列公示。反向建议只作护栏（它 mismatch 记错误，但不因“未给相反结论”记正确）。
- 为什么分母这么小：本轮可评估案例为 0：按 D19.1，案例缺必填输入时不把 null 传给引擎算假分，因此全部案例记 unsupported: missing-required-input。分母为 0 时准确率无法计算——这不是引擎错，是基准集与产品表单的结构性差距。
- 非正向案例（3 条条件性上限 + 7 条反证语境 + 19 条无结论）**不计入准确率**，只用于展示与规则回归。
- 对照（旧口径，全案例含不可比，仅作对照）：match 0 / partial 0 / mismatch 0 / unsupported 45（无可评估案例，故为 0）。

## 二之一、因缺必填输入无法评估：45 条（D19.1）

按 D19.1：案例缺必填输入时不把 null 传给引擎算假分，直接记「unsupported: missing-required-input」。本轮 45 / 45 条全部命中该情形，因此**可评估案例为 0，准确率无法计算**。

- 平均每条缺 **23 / 29** 项必填字段
- 必填字段缺失频次 Top 12：hukou×45、personality×45、communication×45、emotional_stability×45、want_age_min×45、want_height_min×45、want_education_min×45、want_house×45、want_appearance_min×45、self_rank×45、admiration_freq×45、photo_quality×45
- 最接近可评估的 8 条（缺得最少）：C-003 缺19、C-008 缺19、C-010 缺20、C-011 缺20、C-024 缺20、C-032 缺20、C-035 缺20、C-002 缺21

**为什么必然缺**：产品表单是「用户自填」，29 项必填里有 16 项是用户自评/偏好（人格、沟通、情绪、颜值自评与校准、择偶期望），直播连麦的转写里根本不存在这些回答；其余 13 项（户籍、房车、收入、婚史等）也大多未被博主问到。这不是引擎错，是基准集与产品表单的结构性差距。

**要让基准集能测产品口径，只有两条路**：① 给语料补标注（把博主问过的条件补全：身高/学历/职业/收入/房车/家庭）；② 产品表单允许「未知 / 不便填写」，让部分表单成为合法提交。否则任何回填都是 fabrication。

## 二之二、数据缺口（两个数分开报）

| 缺口类型 | 案例数 | 性质与出路 |
|---|---|---|
| 案例缺自述条件（**语料问题**） | 45 / 45 | 转写里博主没问、来访者没说 → 可用语料补标注解决 |
| 案例缺必填输入（**表单/harness 问题**） | 45 / 45 | 表单要求用户自评/偏好，语料结构上不存在 → 只能靠产品侧允许「未知」或换采集方式 |

**缺自述条件（语料问题）Top 10**：hukou×45、has_car×42、marital×41、income_wan×39、school_tier×38、self_appearance×38、family_origin×37、has_house×34、siblings×31、education×28

**缺必填输入（表单问题）Top 10**：personality×45、communication×45、emotional_stability×45、want_age_min×45、want_height_min×45、want_education_min×45、want_house×45、want_appearance_min×45、self_rank×45、admiration_freq×45

## 三、分维度可比性（只统计 positive-reachable）

| 维度 | match | partial | mismatch | unsupported | not-comparable |
|---|---|---|---|---|---|
| appearance | 0 | 0 | 0 | 16 | 0 |
| band | 0 | 0 | 0 | 16 | 0 |
| reversal | 0 | 0 | 0 | 16 | 0 |

- **档位维度全部 not-comparable**：引擎输出的 S/A/B/C 来自 baseline 的数值区间，属 engineering-default（D11/D14），无语料依据；语料里也没有 level→档位的区间证据，本项目禁止发明区间。语义档位通道已预留，但当前引擎不会输出带 entryCriteria 的档位 id。
- **颜值维度**只在“有博主打分标注 + 有可用自评输入”时可比；案例的条件是博主问出来的，标注是博主的判断，两者都可能缺失，因此可比案例很少。
- **反向建议（护栏）**只在维度表里展示：它 mismatch 记为错误，但“引擎没给相反结论”不记为答对。

## 三之一、档位词汇：用语料自己的词（D24）

S/A/B/C 是我们自己发明的词汇，语料里没有这套体系，已停止作为结论输出。下表列出案例里出现的**语料自己的档位词**（knowledge/rules.json 的 9 条 bands，名字就是博主的话）。这些词只作引用登记，不参与任何打分。

| 案例 | 引用的语料档位词 | 引擎当前是否输出该档位 id |
|---|---|---|
| C-004 | 打分局头部（第 1–3 名区间）（match.rank.t1，命中词「前3名」）；打分局中段（第 7–9 名区间）（match.rank.t7，命中词「第8」）；A9 资产档（asset.a9，命中词「A9」）；高净值活动（event.high，命中词「高净值」）；三高专场（event.three，命中词「三高」） | 否（引擎只输出 engineering-default 的 S/A/B/C） |
| C-007 | A8 资产档（asset.a8，命中词「A8」） | 否（引擎只输出 engineering-default 的 S/A/B/C） |
| C-008 | 生态位（黄金/白银/青铜）（ecosystem.tier，命中词「生态位」） | 否（引擎只输出 engineering-default 的 S/A/B/C） |
| C-012 | 打分局头部（第 1–3 名区间）（match.rank.t1，命中词「前3名」）；A8 资产档（asset.a8，命中词「A8」） | 否（引擎只输出 engineering-default 的 S/A/B/C） |
| C-018 | 打分局头部（第 1–3 名区间）（match.rank.t1，命中词「前三名」） | 否（引擎只输出 engineering-default 的 S/A/B/C） |
| C-024 | A7 资产档（asset.a7，命中词「A7」） | 否（引擎只输出 engineering-default 的 S/A/B/C） |
| C-026 | A9 资产档（asset.a9，命中词「A9」） | 否（引擎只输出 engineering-default 的 S/A/B/C） |
| C-032 | 生态位（黄金/白银/青铜）（ecosystem.tier，命中词「黄金」） | 否（引擎只输出 engineering-default 的 S/A/B/C） |

- 合计 8 条案例引用了语料档位词；引擎一条都不会输出——这就是档位维度 not-comparable 的确切含义，也是 v2 的接通点（前置条件 #4）。
- 这些档位词里，asset.a9（C-026）、match.rank.t1（C-004/C-012/C-018）等多为 n=1~3 的语料，引用时按证据强度降权，不作为结论。

## 四、缺口清单 · 引擎缺维度/缺规则（v2 需求输入，按影响排序）

| # | 缺口 | 类型 | 影响案例数 | 说明 |
|---|---|---|---|---|
| 1 | 体重维度 (body.weight) | high | 11 | 表单有 weight_kg 但没有任何评分维度引用它（引擎报出 uncoveredFields 含 weight_kg）；语料把体重作为硬性减分维度（C-003/C-014/C-023）。建议以 BMI 等中性指标呈现并附健康建议，不做体型羞辱。 |
| 2 | 手足性别与排序 (family.sibling_detail) | high | 10 | 引擎只有 siblings=独生/非独生 两档，无法区分“弟弟”与“姐姐”——语料显示两者对女性婚恋的影响相反（C-002/C-006/C-015 vs C-012/C-024）。 |
| 3 | 期望对方职业/编制 (want.occupation) | high | 9 | 语料中“要求对方体制内”是最常见要求之一（C-022/C-024），want_* 里没有对应字段。 |
| 4 | 家庭资产档位（A7/A8/A9） (family.wealth) | high | 9 | 语料用 A7/A8/A9 与“陪嫁 xx 万”作为硬指标（C-004/C-015/C-022/C-026），表单 family_origin 只有四档定性。 |
| 5 | 期望对方收入下限 (want.income) | high | 7 | 语料里“要求对方月入 5 万 / 收入比我高”很常见（C-014/C-025），表单无 want_income 字段。 |
| 6 | 带孩再婚（匹配成本） (family.marital_child) | high | 3 | 基线只有 marital 三档打分，缺少“带孩再婚的匹配周期更长、可选范围更窄”的处理规则（C-009/C-034）；该差异来自育儿投入与家庭重组成本，不是对单亲家庭的评价，相关量化口径属博主结论、非平台结论。 |
| 7 | 生育意愿（丁克） (fertility_intent) | high | 1 | 表单没有生育意愿字段；语料明确“丁克直接下两个生态位”（C-008）。 |
| 8 | 期望对方独生 (want.only_child) | medium | 12 | “要求独生子/独生女”反复出现（C-009/C-015/C-022/C-024），want_* 无该字段。 |
| 9 | 期望对方房车全款 (want.house_car) | medium | 5 | want_house 只有“必须有/不要求”二值，无法表达“全款”。（C-013/C-015/C-022） |
| 10 | 地域差异规则 (region.rule) | medium | 5 | 语料有明确的地域换算（回国太卷、换城市元气成本、城市收入口径），规则集只有 cityTier 影响一条收入基线规则（C-027/C-013 + 6.4 节）。 |
| 11 | 父母退休金/养老负担 (family.parent_pension) | medium | 2 | 语料多次以“父母有退休金/有社保”作为筛选口径（C-010/C-015/C-025），表单无该维度。 |
| 12 | 作息/加班属性 (work_schedule) | medium | 2 | 语料判定“有夜班属性必然减分，不分男女”（C-011），表单无对应字段。 |

## 四之一、mismatch 归因汇总

| 归因 | 类型 | 影响 mismatch 案例数 | 案例 |
|---|---|---|---|
| （本轮无 mismatch） | — | 0 | — |

## 四之二、优先修复清单

1. **P1（防御性）· 未填自评不得当 0 分** —— 真实用户路径触不到（self_appearance 是表单必填，缺了 HTTP 422），不得用它解释 mismatch；仅作为引擎健壮性修复。
2. **P0 · 让基准集能测产品口径** —— 29 项必填里 16 项是用户自评/偏好，语料结构上不存在；需产品侧允许「未知/不便填写」或补语料标注，否则回归分母恒为 0。
3. **P1 · 补维度/规则：体重维度** —— 影响 11 条案例（high）：表单有 weight_kg 但没有任何评分维度引用它（引擎报出 uncoveredFields 含 weight_kg）；语料把体重作为硬性减分维度（C-003/C-014/C-0
4. **P1 · 补维度/规则：手足性别与排序** —— 影响 10 条案例（high）：引擎只有 siblings=独生/非独生 两档，无法区分“弟弟”与“姐姐”——语料显示两者对女性婚恋的影响相反（C-002/C-006/C-015 vs C-012/C-024）。
5. **P1 · 补维度/规则：期望对方职业/编制** —— 影响 9 条案例（high）：语料中“要求对方体制内”是最常见要求之一（C-022/C-024），want_* 里没有对应字段。
6. **P1 · 补维度/规则：家庭资产档位（A7/A8/A9）** —— 影响 9 条案例（high）：语料用 A7/A8/A9 与“陪嫁 xx 万”作为硬指标（C-004/C-015/C-022/C-026），表单 family_origin 只有四档定性。
7. **P1 · 补维度/规则：期望对方收入下限** —— 影响 7 条案例（high）：语料里“要求对方月入 5 万 / 收入比我高”很常见（C-014/C-025），表单无 want_income 字段。

## 四之三、输入缺口附录（语料/表单字段映射不出来，属数据侧问题）

| 缺口 | 影响案例数 | 说明 |
|---|---|---|
| 院校层次未提及或无法判定 | 43 | 无法解析： 硕士 |
| 收入无法解析或未提供 | 43 | 未提供收入 |
| 房产口径不明或未提供 | 43 | 无房字段 |
| 车价未提及或未提供 | 43 | 无车字段 |
| 婚史未提及 | 43 | 未提及婚史 |
| 家庭出身无法判定 | 42 | 按资产量级归入城市中产及以上 |
| 手足情况未提及 | 39 | 按家庭成员描述判定非独生 |
| 职业无法解析 | 30 | 无职业字段 |
| 学历无法解析 | 28 | 无学历字段 |
| 择偶要求无法映射到表单字段 | 6 | 对方公务员/编制、独生子（表单无对应字段） |

## 五、引擎问题（bug / 结构性缺陷）

- [MEDIUM] GAP-PHOTO-DIMS 外观维度无表单映射（纯照片轨道）（命中 探针）
  - appearance 组的 24 个维度都没有 field 与 scoring：纯表单模式下无法评分，颜值只能靠用户自评轨道。

## 五之一、字段来源与观察偏差（derivedFromVerdict）

案例的 input 来自**博主直播连麦的转写**，引擎输入是**用户自填表单**，不是同一口径。以下字段是博主判断（或 ASR 无法区分说话人），已在 cases.json 的 inputMeta 标记 derivedFromVerdict=true / usedAsEngineInput=false，回归中按“无输入”处理：

| 案例 | 字段 | 原因 |
|---|---|---|
| C-010 | appearanceNote | 被指‘漂亮但不精致、不高级感’：博主判断，非来访者自述。 |
| C-022 | appearanceNote | 自评颜值3.5：ASR 分句无法确定是谁说的，保守按博主判断处理。 |
| C-026 | appearanceNote | 被评‘长得正派’：博主判断。 |
| C-029 | appearanceNote | 纯面部美学被评‘6分以上’：博主判断。 |
| C-035 | appearanceNote | 被评‘挺帅的’：博主判断。 |
| C-045 | appearanceNote | ‘宿舍校草’档：博主判断，且未给出分数。 |

- 合计 6 条；其余系统性偏差：提问引导、单位口径（月薪/斤↔年收入/公斤/枚举）、房车常为家庭可提供、多数案例未自述婚史（一律留空）。

## 六、逐条判定

| 案例 | 状态 | 语境 | 缺(表单/语料) | 计分 | 颜值 | 档位 | 反向建议 | 说明 |
|---|---|---|---|---|---|---|---|---|
| C-001 | blocked:missing-form-input | positive-reachable | 13/9 | — | unsupported | unsupported | unsupported | 博主直接给出正向画像并称“你是他的心智首选”。 |
| C-002 | blocked:missing-form-input | reverse-context | 13/8 | — | unsupported | unsupported | unsupported | 结论是“有弟弟+非独生→门当户对变难”，对标画像是用来反证“别人比你好找”的比较对象。 |
| C-003 | blocked:missing-form-input | positive-reachable | 13/6 | — | unsupported | unsupported | unsupported | 博主正向给出“找有感情的路子 / 农村家庭男生”的结论。 |
| C-004 | blocked:missing-form-input | conditional-ceiling | 13/10 | — | unsupported | unsupported | unsupported | “先去打分局，若进前 3 才触达三高/A9 场”，是条件性潜在上限，不是承诺结论。 |
| C-005 | blocked:missing-form-input | positive-reachable | 13/8 | — | unsupported | unsupported | unsupported | 博主正向给出具体可达画像（大7岁/老北京/公务员）。 |
| C-006 | blocked:missing-form-input | positive-reachable | 13/9 | — | unsupported | unsupported | unsupported | 博主正向给出“95年独生子…就是你的天花板”。 |
| C-007 | blocked:missing-form-input | reverse-context | 13/10 | — | unsupported | unsupported | unsupported | “A8家庭的男生不会为颜值考虑你”是反证语境（此前被误读为 S 档依据）；本案例另有正向画像（92年/存款200万/山东人），但不属 S 档声明。 |
| C-008 | blocked:missing-form-input | positive-reachable | 13/6 | — | unsupported | unsupported | unsupported | 博主正向给出具体可达画像（92年/北京土著/公务员/有全款房）。 |
| C-009 | blocked:missing-form-input | positive-reachable | 13/11 | — | unsupported | unsupported | unsupported | 博主对现实中正在接触的具体对象给出正面背书（建议继续推进）。 |
| C-010 | blocked:missing-form-input | positive-reachable | 13/7 | — | unsupported | unsupported | unsupported | 博主正向给出具体可达画像（山大本硕/大4岁/山东独生子）。 |
| C-011 | blocked:missing-form-input | unspecified | 13/7 | — | unsupported | unsupported | unsupported | 只有“夜班减分”的通用判断与“去香港/雕琢自己”的建议，没有可达结论。 |
| C-012 | blocked:missing-form-input | conditional-ceiling | 13/8 | — | unsupported | unsupported | unsupported | “先去打分局，按名次对号入座”，第 1 名/前 3 名的画像都是条件性上限。 |
| C-013 | blocked:missing-form-input | positive-reachable | 13/9 | — | unsupported | unsupported | unsupported | “上嫁没戏，但正常可找大4岁/专科/有全款房，这是极限了”——博主正向给出的低位可达上限。 |
| C-014 | blocked:missing-form-input | reverse-context | 12/10 | — | unsupported | unsupported | unsupported | “45岁有房有车月入5万不会找咱”是反证语境。 |
| C-015 | blocked:missing-form-input | conditional-ceiling | 13/9 | — | unsupported | unsupported | unsupported | “独生子当然可以找，前提是对方不介意你有弟弟”——条件性结论。 |
| C-016 | blocked:missing-form-input | unspecified | 13/8 | — | unsupported | unsupported | unsupported | 只有自我介绍，没有博主结论。 |
| C-017 | blocked:missing-form-input | unspecified | 13/13 | — | unsupported | unsupported | unsupported | 只有“先找个班上/改值钱”，不是择偶可达结论。 |
| C-018 | blocked:missing-form-input | unspecified | 13/11 | — | unsupported | unsupported | unsupported | 只有颜值分，没有择偶结论。 |
| C-019 | blocked:missing-form-input | unspecified | 13/12 | — | unsupported | unsupported | unsupported | 只有颜值分与身高判断，没有择偶结论。 |
| C-020 | blocked:missing-form-input | unspecified | 13/10 | — | unsupported | unsupported | unsupported | 只有颜值分，没有择偶结论。 |
| C-021 | blocked:missing-form-input | unspecified | 13/13 | — | unsupported | unsupported | unsupported | 只有颜值分，没有择偶结论。 |
| C-022 | blocked:missing-form-input | positive-reachable | 13/8 | — | unsupported | unsupported | unsupported | 博主正向给出两条可选路径（体制内+4-4.5分 / 985-211独生女）。 |
| C-023 | blocked:missing-form-input | positive-reachable | 13/10 | — | unsupported | unsupported | unsupported | 博主正向给出具体可达画像（专科/私企数据运营/4.7-4.8分）。 |
| C-024 | blocked:missing-form-input | positive-reachable | 13/7 | — | unsupported | unsupported | unsupported | 博主正向给出具体可达画像（本地独生女/168cm/会计）。 |
| C-025 | blocked:missing-form-input | positive-reachable | 13/9 | — | unsupported | unsupported | unsupported | 博主正向给出具体可达画像（1米65/100斤/4.5-5分/私企项目负责人）。 |
| C-026 | blocked:missing-form-input | positive-reachable | 13/10 | — | unsupported | unsupported | unsupported | 博主正向给出 A9 家庭女生画像（三选一路径之一），但为单条语料（n=1）。 |
| C-027 | blocked:missing-form-input | positive-reachable | 13/10 | — | unsupported | unsupported | unsupported | 博主正向给出结论“绝对是在加拿大找”，但结论是地域而非档位。 |
| C-028 | blocked:missing-form-input | reverse-context | 13/10 | — | unsupported | unsupported | unsupported | “那你做梦了，洗洗睡吧”是反证语境。 |
| C-029 | blocked:missing-form-input | reverse-context | 13/11 | — | unsupported | unsupported | unsupported | “出镜类型工作不用问上限”是反证语境（说明上限够不着）。 |
| C-030 | blocked:missing-form-input | unspecified | 13/11 | — | unsupported | unsupported | unsupported | 只有“不要为了结婚而结婚”的劝告，没有可达结论。 |
| C-031 | blocked:missing-form-input | reverse-context | 13/13 | — | unsupported | unsupported | unsupported | 结论是“期望与条件错配”，并劝其再沉淀（反证语境）。 |
| C-032 | blocked:missing-form-input | positive-reachable | 13/7 | — | unsupported | unsupported | unsupported | 博主正向给出“准第一梯队/上限非常高”，但为单条语料（n=1）。 |
| C-033 | blocked:missing-form-input | unspecified | 13/10 | — | unsupported | unsupported | unsupported | 只有“先谈恋爱、把自信心长出来”的建议，无可达结论。 |
| C-034 | blocked:missing-form-input | reverse-context | 13/13 | — | unsupported | unsupported | unsupported | 结论是带孩再婚更难（负面预期），属反证语境。 |
| C-035 | blocked:missing-form-input | positive-reachable | 13/7 | — | unsupported | unsupported | unsupported | 博主正向给出“能找，颜值5.5分已经能吃到颜值红利”。 |
| C-036 | blocked:missing-form-input | unspecified | 13/12 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |
| C-037 | blocked:missing-form-input | unspecified | 13/10 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |
| C-038 | blocked:missing-form-input | unspecified | 13/13 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |
| C-039 | blocked:missing-form-input | unspecified | 13/13 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |
| C-040 | blocked:missing-form-input | unspecified | 13/12 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |
| C-041 | blocked:missing-form-input | unspecified | 13/11 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |
| C-042 | blocked:missing-form-input | unspecified | 13/13 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |
| C-043 | blocked:missing-form-input | unspecified | 13/14 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |
| C-044 | blocked:missing-form-input | unspecified | 13/11 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |
| C-045 | blocked:missing-form-input | unspecified | 13/13 | — | unsupported | unsupported | unsupported | 只有颜值分（打分局），没有择偶可达结论。 |

## 七、口径与方法（可复核）

1. **D14 主口径**：准确率只统计 positive-reachable 且至少一个实质性可比较维度的案例；conditional-ceiling / reverse-context / unspecified 三类一律不计入，只展示。
2. **D11/D14 档位**：baseline 的 S/A/B/C 数值档位属 engineering-default，不得作为结论比对；本报告把它整维标为 not-comparable 并从分母剔除，而不是用一个不可信的档位去算准确率。
3. **不泄漏答案**：颜值校验的输入只来自案例自述；博主打分只作标注；被标 derivedFromVerdict 的字段不作为输入（代理模式结果另存 engine.appearanceProxy，只用于诊断下游链路）。
4. **反向建议是护栏**：mismatch 记错误，无相反结论不记正确。
5. **字段映射保守**：所有折算与无法映射的字段都写进 cases[].mapping，不做无标注的猜测。
6. **退出码**：mismatch 数超过 --max-mismatch（默认 0）或出现引擎异常时为 1；当前为校准债而非工具故障。

