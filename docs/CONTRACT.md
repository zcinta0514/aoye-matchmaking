# 鳌烨择偶定位体系 —— 项目契约（所有 Worker 必读）

> 本文件是团队的**唯一事实来源**。任何产出必须遵守这里的路径、格式与质量标准。
> 最后更新：2026-10-05

---

## 一、项目目标

做一个**独立网页项目**：相亲/择偶需求方填写基本条件 + 上传照片，系统输出

1. **评分**：颜值分、硬件分、软性分（按鳌烨体系标尺）
2. **定位**：在择偶市场中的位置（属于哪一档，谁是 TA 的"心智首选"）
3. **择偶上下限**：可达上限、稳妥区间、需要放弃的幻想项
4. **提升路径**：可优化的具体项

参考体系来自抖音/小红书博主 **鳌烨（月老鳌烨）** 及其矩阵号的公开内容。

---

## 二、语料现状

| 项 | 值 |
|---|---|
| 已枚举账号 | 51（38 个有效） |
| 唯一作品 | 1511 条 |
| 总时长 | 约 28.2 小时 |
| 转写进度 | 见 `node tools/corpus.mjs stats`（后台持续跑，最终覆盖 100%） |
| 转写产物 | `data/transcripts/<account>/<aweme_id>.txt`（+ `.srt`） |
| 作品元数据 | `data/meta/manifests/<account>.json`（含 desc/时长/点赞/播放地址） |

**重要**：转写是机器识别结果，**有错字**（例："5.5文"=5.5分、"摄草"=校草、"心智首选"正确、"国企里"常被识别成"国阳气"）。
引用时**必须按语义判断**，遇到可疑词用 `--ctx` 看上下文还原，**不要把错字当成原文写进知识库**。

---

## 三、已知的体系骨架（初步侦察结论，需 Worker 用语料证实/修正/扩展）

这些是从少量样本中已确认的概念，**是起点不是终点**：

- **颜值分标尺（1–9 分制）**：
  - 3–4 分 = 普通人（"三到四分是普通人"）
  - 5.5 分 = "有争议的班草、无争议的校草；100 个人里保底成 5"（原文）
  - 7 分 = 极高档位（"全中国就你一个男生，你也不可能是 7 分"），且**脸必须是原生未整**
  - 判分依据提及"三庭比例""脸型大小""鼻子"
- **婚恋画像**：博主给客户画一个"画像"，告诉 TA "你是谁的**心智首选**/第一选择"
  - 实例：*"找个土著、独生子、1米72、140斤、形象一般、房车全、211本硕、体制内事业编、不太会聊天"* → *"你是他的心智首选"*
- **硬件 / 软件** 二分法；**上嫁 / 下娶 / 向下兼容**；**天花板 / 兜底**
- 明确区分**男女**两套评判与换算逻辑
- 矩阵号按城市分布（北京/上海/广州/深圳/杭州/成都/西安/南昌/苏州…）→ 存在**地域差异**规则

---

## 四、产出物与路径（严格按此命名）

### 4.1 知识库（人读，Markdown）

```
knowledge/
  01-appearance-scale.md      颜值分标尺：每一分档的可观察特征、正例反例、边界条件
  02-dimensions.md            维度体系：硬件/软性/家庭 各维度的取值与权重
  03-matching-rules.md        匹配与定位规则：心智首选、上下限、梯队划分
  04-demographics.md          地域 / 年龄 / 性别 差异规则
  05-glossary.md              术语表（含 ASR 常见错字对照）
  06-casebook.md              真实案例库（结构化案例，作为测试集）
```

### 4.2 机器可读规则

```
knowledge/rules.json          符合 knowledge/rules.schema.json 的规则集
knowledge/rules.schema.json   已由 Lead 定稿，不得修改；有意见写进 knowledge/OPEN-QUESTIONS.md
```

### 4.3 Web 项目

```
web/                          独立网页应用（前后端）
```

---

## 五、质量标准（硬性）

0. **可执行性（2026-10-05 新增，最高优先）**：每条规则必须二选一——
   - 给 `machine: { when: <结构化条件>, then: [{kind,...}] }`，引擎才跑得动；
   - 或者 显式标 `advisory: true`，声明它只能给人看、引擎不执行。
   只写自然语言 `when`/`then` 而不标 `advisory` 的规则，校验器会告警。
   **背景**：v1 的 159 条规则全是自然语言，导致知识库对引擎零影响（实测两套规则集算出的分数逐位相同）。这是本次审计的 P1-1，v2 必须修。

   `machine.when` 的 DSL（与 web/lib/engine.mjs 一致）：
   ```json
   { "field": "subject.height", "op": "gte", "value": 175 }
   { "all": [ ... ] } / { "any": [ ... ] } / { "not": { ... } }
   ```
   ops：`eq neq gt gte lt lte in nin between exists missing includes matches`
   `machine.then[].kind`：`clampScale | setBand | advice | giveUp | text | flag | requireEvidence`

   **维度同理**：知识维度想参与打分，必须有 `field` + `scoring`（`type: bands|options|scale1to5`）+ `weight`；否则它只能当描述项。

   **字段名只能取权威字典**：`knowledge/facts.json`（由 `node tools/build_facts.mjs` 从 `web/config/form-fields.json` 自动生成，含 34 个表单字段 + 17 个派生字段 + 18 个照片维度）。写 `machine.when.field` 前先查它；缺字段就往字段源加、重新生成，**不要在规则里发明字段名**。引用不存在的字段校验器会报错（因为引擎只会静默不触发，不报错）。
   常用：`subject.gender`（male/female）、`subject.age`、`subject.city`、`subject.height_cm`、`subject.weight_kg`、`subject.education`、`subject.school_tier`、`subject.occupation`、`subject.income_wan`、`subject.has_house`、`subject.has_car`、`subject.hukou`、`subject.marital`、`subject.family_origin`、`subject.siblings`、`appearance.final.high`、`hardware.score`、`soft.score`、`want.appearance_gap`。

1. **每条规则必须带证据**：`{account, aweme_id, quote}`，`quote` 必须是**转写里的口语原文片段**，不是视频标题/desc。仅当确实无转写时才可退而用标题，并标注 `quoteSource: "desc"`。
2. **不得编造**：语料里没说的，不许凭常识补。补不出来就写进 `knowledge/OPEN-QUESTIONS.md`。
3. **区分置信度**：`high` = 至少 3 条独立语料/跨 ≥2 个账号一致；`medium` = 1–2 条；`low` = 单条且含糊。
4. **覆盖度透明**：写每个结论时说明基于多少条语料。转写未完成时，注明"基于当前 N% 语料"。
5. **不确定就标注冲突**：不同语料互相矛盾时**两边都写**，标 `conflict: true`，不要强行统一。
6. **数字要具体**：能写成"身高 <170 在北方市场降 0.5 档"就不要写"身高偏矮会有影响"。

### 5.1 证据归属规则（已踩过的坑）

- **抖音“共创视频”会让同一个 `aweme_id` 同时出现在多个矩阵号的作品页**。因此 `account` 写哪个账号都算合法，只要该账号的作品列表里确实有这条。
- **权威归属是视频的 `author` 字段**，不是列表所属账号。`data/meta/manifests/<account>.json` 里同时保留 `author`（作者昵称）与 `ownerAccount`（列表所属账号），取证时以 `author` 为准。
- `tools/check_rules.mjs` 会同时校验「aweme_id 真实存在」「属于该账号」「引文能在转写里找到」，三项任一不通过就报错/告警。

### 5.2 合并策略（多 part 合并时的 id 冲突）

所有 part 的 id 必须全局唯一，前缀按域划分，**同一含义不得建两个 id**：

| 前缀 | 域 | 归属 part |
|---|---|---|
| `R-LOOKS-*` / `looks.*` | 颜值判分（给照片/视觉模型用） | 01 |
| `R-DIM-*` / `dim.*` | 市场定位维度（给表单+规则引擎用） | 02 |
| `R-MATCH-*` | 匹配定位 | 03 |
| `R-DEMO-*` | 地域/年龄/性别差异 | 04 |
| `R-CASE-*` | 案例库 | 06 |

已存在的语义邻近对：`looks.height`/`dim.height`、`looks.weight`/`dim.weight`。**两者都保留**：
- `looks.*` 是「判分时观察到的呈现项」（照片可判断），只影响颜值分；
- `dim.*` 是「婚恋市场里的可量化条件」（用户自填），影响整体定位。
- 当一条规则同时涉及两者时，显式写明引用的是哪一个。

`scales` 只由 01 产出，`bands` 只由 03 产出，其余 part 留空——避免重复 id。

---

## 六、工具用法（省 context，务必用）

```bash
node tools/corpus.mjs stats                          # 语料总览/覆盖率
node tools/corpus.mjs accounts                       # 各账号条数与时长
node tools/corpus.mjs search "心智首选" --ctx 5 --limit 30   # 关键词检索（带上下文）
node tools/corpus.mjs grep "身高1[6-7][0-9]" --limit 30     # 正则检索
node tools/corpus.mjs read aoye98 7649728311765060883       # 读单条转写全文
node tools/corpus.mjs sample 15 --min-dur 60                # 稳定抽样（均匀覆盖）
```

**音频未转写时的应急取证**：`data/meta/manifests/<account>.json` 里有 `desc`（视频标题）。标题可用来**定位**候选视频，但**不能当 quote 用**——先把该条转写出来（`python3 tools/transcribe_batch.py`）再取证。

**禁止**用 `cat`/`read` 直接吞整份语料（会撑爆上下文）。一律走检索工具，按需读单条。

### 6.1 自检与预览合并（Worker 专用）

```bash
# 只校验自己的 part
node tools/check_rules.mjs knowledge/rules.part.0X.json

# 合并各 part 到预览集（**不会**碰 Lead 独占的 rules.json，见 D7）
node tools/preview_rules.mjs

# 合并后直接对预览集跑回归（验证自己的改动是否真的生效）
node tools/preview_rules.mjs --regress

# 全库伦理扫描（覆盖 md + 所有 JSON 的用户可见字段，比自己只看规则 JSON 严）
node tools/ethics_scan.mjs
```

**为什么需要预览集：** 回归工具默认读 `knowledge/rules.json`（Lead 独占）。Worker 若直接跑，拿到的是**未包含自己改动**的旧快照，会得出误导结论（已发生两次）。

**注意：** `case_regression.mjs` 会覆写 `knowledge/CASE-CALIBRATION.md`（Lead 产物）。跑之前先看它当前是否是有效记录；若被覆盖，告知 Lead 用 git 恢复（见 D10）。

高价值账号（优先看）：
`aoye98`（主号，368 条 / 714 分钟）、`47590488570` 木木说媒、`weipingxiaotao52` 陈太阳、`aoye306` 晚卿定位、`89534406513` 康康北京、`Jerry4098` 杭州杰瑞。

---

## 七、协作纪律

- **地盘划分**：只写自己负责的文件，**绝不修改**别人的产出文件。跨域发现写进 `knowledge/OPEN-QUESTIONS.md` 并点名给谁。
- **进度报告**：每完成一个阶段，用 `node tools/corpus.mjs stats` 报当前覆盖率 + 自己产出的规则条数。
- **提交前自检**：`node tools/check_rules.mjs knowledge/rules.json`（Lead 提供的校验器，必须通过）。
