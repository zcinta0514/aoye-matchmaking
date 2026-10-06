# Web 端架构决策（鳌烨择偶定位系统 · web/）

> 状态：v0.2（2026-10-05），已按 AUDIT-WEB 修复 P0×2 / P1×2，并接入契约 §5.0 的 machine 可执行层。
> 本文档由 Web Worker 维护，只描述 `web/` 与 `docs/WEB-ARCH.md`。

## 1. 目标与硬约束

1. 用户填表 + 传照片 → 定位报告：颜值分（区间）、硬件分、软性分、择偶上/下限、稳妥区间、该放弃的幻想项、提升路径。
2. **照片不打绝对分**：模型只输出可观察维度描述与锚点符合度；分数由 `knowledge/rules.json` 的确定性规则映射成区间，再与自评交叉校准并说明分歧来源。
3. 规则引擎数据驱动；规则集会从个位数增长到几百条；知识库（v1.2 契约）用 `machine` 提供可执行层。
4. 模型调用可替换；没有 key 时降级为纯表单模式，流程必须跑通。
5. 一条命令起服务，零外部服务（无 Docker、无数据库、不跑 `npm install`）。
6. 报告展示证据引用（account + aweme_id + quote）；**没有证据的结论必须显式标注**。
7. 含未加密个人数据：默认只绑回环，对外监听必须带访问令牌。

## 2. 技术栈选型与理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node v24（标准库） | 本机已有；`node:http / node:fs / node:test` + 全局 `fetch` 足够 |
| 依赖 | **0 个 npm 包** | 约束要求；避免供应链与版本问题 |
| 存储 | JSON 文件（原子写）+ 本地文件 | 单机单用户量级；换 SQLite 只需替换 `lib/store.mjs` |
| 前端 | 原生 HTML/CSS/JS（ES Module） | 无构建步骤，改完刷新即生效 |
| 模型接入 | `fetch` 调 `/chat/completions` | OpenAI 兼容面最广（OpenAI / DeepSeek / Qwen / vLLM / Ollama 网关） |
| 鉴权 | 单一共享令牌（Bearer / 头 / query） | 无用户体系下的最小可用方案；为局域网部署提供基本隔离 |
| 测试 | `node --test` | 内置，无依赖 |

## 3. 数据模型

### 3.1 表单（`web/config/form-fields.json`）

字段定义驱动前端渲染 + 服务端校验（单一来源）。类型 `text | number | select | radio | scale`，含 `min/max/step/options/required/help`。校验是类型严格的：布尔值、非数字字符串、越界数字、非法枚举一律 422；文本超 200 字符会截断并给出 warning。

### 3.2 报告对象（`POST /api/report` 返回并落盘）

~~~
{
  id, createdAt,
  engine: { mainRules{path,version,corpus}, baseline{version}, coverage{knowledge,baseline}, warnings, model, photoMode },
  subject, context{ city, cityTier, gender },
  appearance: {
    final{low,high,mid}, finalLabel, basis, evidenceStatus, evidenceNote,
    clampsApplied[], selfTrack{...}, photoTrack{mode,dimensions,anchorFits,mappedInterval,dataQuality,caveats},
    divergence, divergenceAbs
  },
  hardware{score,label,familyScore,breakdown[{...,evidenceStatus,evidenceNote,counted}]},
  soft{...},
  level, portrait{text,targetProfile,band{id,name,origin,source},bandSource,bandNote,ladder[]},
  matchWindow{upper,stable,lower},
  giveUps[], advice[], notes[], flags[], evidenceRequirements[],
  rulesApplied[{ruleId,scope,origin,via,evidence[]}], ruleErrors[],
  advisoryRules[], unstructuredRules[],
  improvements[], uncoveredFields[],
  evidenceIndex[], evidenceSummary{scoredItems,withEvidence,withoutEvidence,...}, caveats[]
}
~~~

### 3.3 存储

`web/data/reports.json`（原子写）+ `web/data/uploads/<id>.<ext>`。目录 gitignore；照片只在 API 后面（静态目录之外）。当前为单进程串行提交，无并发写锁。

## 4. API 设计

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/health` | 存活 + 规则分层计数 + warnings | 公开 |
| GET | `/api/form` | 表单字段定义 | 令牌 |
| GET | `/api/meta` | 版本 / 覆盖率 / 分层计数 / 模型 / 告警 | 令牌 |
| POST | `/api/photos` | 原始二进制（魔数校验 JPEG/PNG/WebP/HEIC） | 令牌 |
| GET | `/api/photos/:id` | 取回照片 | 令牌 |
| POST | `/api/report` | `{form, photoIds}` → 生成 + 落盘 | 令牌 |
| GET | `/api/report/:id` | 报告 JSON | 令牌 |
| GET | `/api/reports` | 最近 50 条摘要 | 令牌 |
| GET | `/r/:id` | 报告页（数据仍走 API） | 页面公开 |

### 4.1 鉴权与绑定策略（P0-2）

- 默认 `HOST=127.0.0.1`；`HOST` 为非回环地址且未设 `AOYE_ACCESS_TOKEN` 时**进程拒绝启动**（exit 2），启动日志会解释原因。
- 设置令牌后：除 `/api/health` 与静态页面外的所有接口都要令牌，接受 `Authorization: Bearer`、`x-aoye-token`、`?token=` 三种形式；比较用 `crypto.timingSafeEqual`。
- 无令牌访问他人报告 / 照片 / 报告列表 → 401；静态路径 `/uploads/...`、`/data/...` → 404。
- 前端：localStorage 保存令牌，401 时弹窗询问并重试；照片 `<img>` 场景用 query 参数。
- 超限请求（默认 >10MB）返回 413 JSON 而不是断连。

## 5. 规则引擎设计（v1.2）

### 5.1 加载、强校验与合并（`lib/ruleset.mjs`）

- 主规则集（knowledge）严格校验：顶层字段、evidence 形状、rule id 形如 `R-XXX-000`。
- **条件树强校验**：键白名单 `field/op/value/all/any/not`；op 白名单 13 个；`between/in/nin/matches` 的 value 形状；组合键与叶键不得混用。任何一条不合法 → **加载失败、拒绝启动**（不再静默把写错的规则当作不匹配）。
- **动作强校验**：`machine.then[].kind` 必须在 `clampScale | setBand | advice | giveUp | text | flag | requireEvidence` 内，且各自参数齐备。
- 规则三层：
  - `executableRules`：有 `machine.when`（优先）或结构化 `when`；
  - `advisoryRules`：`advisory: true`，只给人看 → 报告「体系参考（未自动执行）」；
  - `unstructuredRules`：两者都没有 → 报告「未结构化规则」+ 启动告警（契约 §5.0 要求二选一）。
- 合并：按 id 逐条合并，knowledge 覆盖同 id 基线；不做整体替换。
- 主规则集 0 条可执行时会同时写入：启动日志、`/api/health` 的 warnings、报告 caveats（红色提示）、首页规则集状态区。

### 5.2 条件 DSL 与动作

~~~
{ "field": "subject.height_cm", "op": "gte", "value": 175 }
{ "all": [...] }  { "any": [...] }  { "not": {...} }
op: eq neq gt gte lt lte in nin between exists missing includes matches
machine.then[].kind: clampScale | setBand | advice | giveUp | text | flag | requireEvidence
~~~

- `clampScale`：给指定标尺的区间设上下限（报告记录 `clampsApplied`）。
- `setBand`：把结果钉到某个梯队（报告 `portrait.band.source = "规则 R-xxx 钉档"`）。
- `flag` / `requireEvidence`：规则标记 / 证据要求（后者若规则自身无语料证据会进入 caveats 告警）。
- 文案支持 `{{path}}` 模板（缺失值渲染「—」）。
- 求值期间单条规则出错不会中断报告：错误进 `ruleErrors` 并在报告里列出。

### 5.3 维度评分（数据驱动）

维度自带 `field + scoring + weight` 即参与打分；`scoring.type` 支持：

| type | 适用 | 数据形状 |
|---|---|---|
| `bands` | 数值（年龄/身高/收入） | `[{min?, max?, score}]`，可 `byGender` / `byCityTier`；区间重叠时取更窄的一档 |
| `options` | 枚举 | `{value: score}` 或 `[{value, score}]` |
| `scale1to5` | 1–5 自评 | `scores:[5 个数字]` 或 `map` |

权重缺失 / 未填写的维度不计入总分，但保留在明细里并标注原因（`counted:false`）。

### 5.4 梯队与择偶窗口

- 有数值 `range/level` 的知识 bands 参与自动落档；没有数值区间的知识 bands **不被强行拟合**，以「梯队阶梯」展示，靠 `setBand` 钉档；都缺失时报告明确写「无法自动映射」。
- 择偶窗口（上限 / 稳妥区间 / 下限）由综合水平 ± 基线 `meta.window` 计算；权重与窗口参数都在 `baseline-rules.json` 的 `meta` 里，可被知识库覆盖。
- 双轨校准阈值同样数据化：`meta.photoTrack`（strongFit/weakFit/weakPad）与 `meta.selfCalibration`（contradictionPenalty/marketSignalBonus/... /maxUnionWidth）。

## 6. 照片双轨流程

~~~
照片(1–3) ──► provider.analyzePhotos ──► 维度描述 + 锚点 fit(0–1)   ← 模型只描述，不打分
                      │ 未配置 / 无照片 / 读图失败 / 超时 / 非法 JSON → 占位降级（流程继续）
                      ▼
        rules.json anchors → mapAnchorsToInterval（strong/weak 阈值来自配置）
                      ▼
              照片轨道区间 ──┐
                             ├─► blendAppearance ─► 最终区间 + 分歧值
   自评分 + 校准题 ──► 自评区间 ──┘（不重叠取并集，宽度封顶，标记 consensus:false）
~~~

- 整个 `analyzePhotos`（含读图 / base64 / 请求 / 解析）都在 try/catch 内：任何异常都降级为 `mode:"error"` 并写 caveat，**报告永远能出**（P0-1 修复点之一）。
- 照片对象字段兼容 `photo.path || photo.file`（store 现在两者都返回）。
- 模型请求体量有上限（`AOYE_LLM_MAX_IMAGE_MB`，默认 8MB）：超出的照片跳过并写 caveat，避免一次 3×10MB 的 base64 打爆 provider。
- 模型 prompt 明确「禁止给出任何绝对分数、档位结论」（有测试断言）；`dataQuality` 的 issues 会进入报告 caveats。

## 7. 证据与可追溯

- `evidenceIndex`：汇总本次用到的知识库出处（标尺锚点 / 维度 / 命中规则），每条 account + aweme_id + quote + usedFor。
- `evidenceSummary`：计分项 X 个、有语料证据 Y 个、无语料依据 Z 个；报告页每个明细行都带证据或 **无语料依据（基线/工程默认）** 标签。
- 命中规则 `rulesApplied` 记录 origin（knowledge / web-baseline）、via（machine / when）、mirrors、证据。
- `advisoryRules` 单列「体系参考（未自动执行）」；`unstructuredRules` 单列「未结构化规则」；`evidenceRequirements` 单列证据要求。
- 演示基线内容全部带「演示基线（未取证）」来源标签 + caveat 声明。

### 7.5 静态版（D31，GitHub Pages）

- 复用引擎：`engine.mjs` 零 Node 依赖；其余库只依赖「读 JSON」。静态版把读文件换成 `web/lib/load-browser.mjs`：`preloadData([...])` 先用 fetch 填模块级缓存，`readJson(file)` 保持**同步签名**从缓存取（引擎/流水线一行未改）。
- 构建（`tools/build-static.mjs`，零依赖）：拷贝 lib/HTML/CSS/data → 改写 import：`node:fs` → `fsShim`、`node:path` → `pathShim`、`node:crypto` → `cryptoShim`、`node:url` → `fileURLToPath`；`pipeline.mjs` 的模块级路径常量按行替换为 `data/*.json`；`util.mjs` 换成浏览器版（readJson→缓存、writeJsonAtomic→localStorage、newId→Math）；`provider.mjs` 按 `--photos=off|byok` 选择 off（无任何 fetch）或浏览器 BYOK 版。
- HTML 资源路径改为相对（`assets/...`）、`href="/"` → `index.html`，保证 GitHub Pages 子路径可用。
- 第三种模式 `--photos=proxy`：前端把同一请求体 POST 到 `{proxyUrl}/analyze`（构建时把 `--proxy-url` 注入 provider），由 `worker/index.js`（Cloudflare Workers，零依赖）在服务端注入密钥并转发；Worker 侧限制 2 张图 / 6MB 图 / 8MB 体 / 每 IP 每小时 3 次（内存、isolate 级、**非可靠限流**），CORS 仅允许 `ALLOWED_ORIGIN`。防护边界如实写在 `worker/README.md`：key 不泄漏可保证，但**成本只能靠服务商后台的月度额度上限**。
- 安全闸：构建结束扫描产物，命中 `sk-` / `.env` / `data/video|transcripts` 直接失败；测试 `web/test/static-build.test.mjs` 对 off/byok 各构建一次并断言以上不变式 + off 模式 provider 无 fetch + 产物无 `node:` import。
- 报告页复用同一渲染器：`web/public/report.js` 的渲染部分原样拷贝，只把 `main()` 换成 localStorage 版本（`web/static/report-main.js`），并带 `?selftest=1` 自检入口。

## 8. 部署方式

- 模型凭据：复制 `.env.local.example` → `.env.local`（仓库根，gitignore）填写；`loadEnvLocal` 只接受 `AOYE_LLM_*` 键、环境变量优先、权限过宽（group/other 可读）时告警建议 `chmod 600`；启动日志与 `/api/meta` 只输出 base_url 的协议+域名与 `key=已设置`，任何位置不回显 key。
- 本机：`node web/server.mjs`（127.0.0.1:8787）。
- 局域网：`HOST=0.0.0.0 AOYE_ACCESS_TOKEN=<随机> node web/server.mjs`；建议前置 Caddy/Nginx 做 HTTPS。
- 备份 = 复制 `web/data/`；迁移 = `web/` + `knowledge/`。
- 公网部署前仍需：真实用户体系（当前是共享口令）、速率限制、照片加密或即弃策略、隐私告知。

## 9. 验证记录（2026-10-05 · v0.2，实际执行）

环境：macOS，`node v24.21.0`，零 npm 依赖。

### 9.1 测试套件

~~~bash
node --test 'web/test/*.test.mjs'
~~~

实际结果（原始输出节选）：

~~~
✔ HTTP 端到端：配 Key + 照片走模型轨道（P0-1），表单/魔数/超限/静态路径全部按预期
✔ P0-2 鉴权：默认回环 + 令牌保护（无令牌 401，带令牌 200）
✔ P0-2 绑定策略：非回环监听必须带令牌，否则拒绝启动
✔ 加载期拒绝非法 op / 未知条件键
✔ 规则执行：machine 动作全类型 + 出处
✔ R-BASE-MATCH-004 回归：颜值门槛不满足时不得触发
✔ 读图失败必须降级而不是抛错（P0-1 回归）
✔ 知识库 v1.2：machine 规则 + 知识维度计分 + setBand 贯通
ℹ tests 53 / pass 53 / fail 0
~~~

覆盖的新回归点：真实 store 照片 + 配 Key + 桩模型 → 200 且 `photoMode=model`（此前 500）；读图失败 → 降级不抛错；R-BASE-MATCH-004 在 `want_appearance_min=3` 时不触发；非法 op / 未知条件键 / 非法 kind → 加载即拒绝；knowledge 维度计分、`setBand`、`flag`、`requireEvidence` 全链路。

### 9.2 鉴权与绑定策略（原始 curl 输出节选）

~~~bash
HOST=127.0.0.1 AOYE_ACCESS_TOKEN=demo-token node web/server.mjs   # 39004
# 带令牌创建：photo=ph_muvegenz64b78ba7 report=rpt_muvegerj8fc0584b
curl -s -i http://127.0.0.1:39004/api/report/rpt_muvegerj8fc0584b
# HTTP/1.1 401 Unauthorized        （未带令牌读他人报告）
curl -s -i http://127.0.0.1:39004/api/photos/ph_muvegenz64b78ba7
# HTTP/1.1 401 Unauthorized        （未带令牌读他人照片）
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:39004/api/reports
# 401
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:39004/uploads/ph_muvegenz64b78ba7.png
# 404（照片不在静态目录）
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:39004/data/reports.json
# 404
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:39004/api/report/rpt_...?token=demo-token"
# 200（带令牌正常）
HOST=0.0.0.0 PORT=39002 node web/server.mjs
# 拒绝启动：HOST=0.0.0.0 是非回环地址（对外监听），必须同时设置 AOYE_ACCESS_TOKEN…（exit=2）
~~~

### 9.3 machine 规则真正参与计算（knowledge 格式规则集，端到端）

用一份符合契约 v1.2 的 knowledge 格式规则集（2 条 machine 规则 + 2 个带 scoring 的知识维度 + 1 条 advisory 规则）启动服务，投放 `height=178 / income=40 / self_appearance=8 / face_natural=no` 的档案：

~~~
rulesApplied: [
  { ruleId: "R-LOOKS-002", via: "machine", origin: "knowledge", evidenceRefs: 1 },
  { ruleId: "R-LOOKS-001", via: "machine", origin: "knowledge", evidenceRefs: 1 }
]
appearance.final: { low: 6.5, high: 6.5 }   clamps: [{ ruleId: "R-LOOKS-002", action: "max=6.5" }]
band: { id: "A", origin: "knowledge" }   bandSource: "规则 R-LOOKS-001 钉档"
flags: ["高个且收入达标"]
advice: ["自评 8 分但非原生脸：区间上限压到 6.5。"]
evidenceRequirements: [{ ruleId: "R-LOOKS-002", satisfied: true }]
hardware.breakdown: [
  { id: "looks.height", score: 6, counted: true, evidenceStatus: "corpus" },
  { id: "looks.income", score: 6.5, counted: true, evidenceStatus: "corpus" }
]
evidenceSummary: { scoredItems: 2, withEvidence: 2, withoutEvidence: 0, knowledgeScoredItems: 2 }
~~~

### 9.4 真实浏览器渲染（headless Chrome `--dump-dom`）

- 默认规则集报告页：无语料依据标签 18 处；汇总行「计分项 17 个：有语料证据 0 个，无语料依据 17 个」；「未结构化规则（需要补 machine）」「知识库结论尚未参与计算」告警均可见。
- 演示规则集报告页：「梯队阶梯」「体系参考（未自动执行）」「未结构化规则」「证据引用（可追溯）」「证据要求（requireEvidence）」「规则 R-LOOKS-001 钉档」全部渲染成功。

### 9.5 规则文件校验

`node tools/check_rules.mjs knowledge/rules.json` → `✓ 校验通过`（0 errors / 1 warn：R-SCORE-001 既无 machine 也未标 advisory——等知识库侧处理；另 1 条 composites 提示）。

### 9.6 C-022 分层可信度改造前后（同一份 knowledge/rules.json）

- 改动前（v0.2 引擎，所有有分项一律计入，共 32 项，含基线占位与同字段双计）：level 4.99 / 硬件 5.54 / 软性 6.59。
- 改动后（D11 严格口径）：level 5.01 / 硬件 5.5（仅 1 项 countable）/ 软性 6.75（3 项）；全量参考口径 level 5.19 / 硬件 6.07 / 软性 6.65。
- C-022 触发外推场景 `exp.tier3-city`（四线县城）：hardware 组全部降级为「外推参考」，因此严格硬件分只由 family 组 1 项支撑并显示「计入 1 项」。
- 18 个有分项：4 项计入（3 有据 + 1 跨账号互证）、14 项仅参考（8 外推 / 3 单条语料 / 3 工程默认）。
- 基线 14 个同字段维度被知识库接管（supersededDimensions），不再双计。

### 9.7 报告页渲染（headless Chrome）

实测通过：顶部汇总行「本次 18 个计分项：4 项有据、14 项仅参考」、六色强度徽标、置顶「该放弃的幻想项（先看这个）」、外推声明（D12）、「因证据不足未计入分数」、「命中规则」、「证据引用（带强度列）」、「体系参考（未自动执行）」、「计入 N 项 / 全量参考」；DOM 中强度徽标 304 处。

## 10. 分层可信度引擎（D11 / D12）

### 10.1 组件

- `web/lib/strength.mjs`：证据强度计算器。
  - `loadIndependence(file)` 优先解析 audit-rules 格式：`ruleEvidence`（152 条预计算强度，含 mirrorAccounts 镜像剔除与模板同源去重）→ `ruleStrength` Map；兼容旧的 `groups` / `accounts` / `sources` 三种形状；文件缺失或解析失败 → 启发式 + `provisional: true`。
  - 规则强度优先取 audit-rules 预计算值（`strengthOfRule`）；维度不在该数据集覆盖范围内，保持启发式并标 `method: heuristic` / `provisional: true`（UI 带 *）。
  - `classifyEvidence(list, independence)`：先去重（同一 `aweme_id` 只算一条；同一句跨账号搬运只算一条），再按「独立条数 + 来源组数」分档：≥3 条且 ≥2 组 → verified；≥2 组 → cross-account；其余 → single-source；空 → engineering-default。
  - 来源组：`aoye98` 与 `aoye28` 默认同组（已知互相搬运），其余账号各自成组；独立性文件就绪后以文件为准。
- `web/lib/extrapolation.mjs` + `web/config/extrapolation-rules.json`：D12 外推场景，14 条（11 条可评估 + 3 条待扩字段），触发条件用现有 DSL 表达。
- `web/lib/sample.mjs` + `GET /api/sample`：读真实案例（默认 C-022）生成示例表单，返回映射假设清单。

### 10.2 计分口径

- 每个计分项带 `strength / strengthLabel / strengthColor / strengthReason / countableForLevel`；数据集外推影响的组（`affectedGroups`）会把 verified / cross-account 降级为 extrapolated。
- headline 分（硬件 / 软性 / 综合 `level`）= 仅 countableForLevel 项加权；`referenceScore` / `levelIfAllCounted` = 全部有分项（含工程默认）加权，即「如果都算上会是多少」。
- 演示基线维度被知识库同字段维度接管时直接让位（`supersededDimensions`），不再双计；未被接管的基线维度按 engineering-default 处理：不进入 headline，只出现在参考值与「因证据不足未计入分数」一节。
- 知识库维度可用 `weightSource` 声明权重来源；`engineering` 会在明细行与 caveat 标出（当前 17/17 个计分维度均为 engineering）。
- `evidenceIndex` 每条引用带 `setStrength`；advisory 规则单独成节。
- **D14 档位降级（2026-10-06）**：语料没有 level → S/A/B/C 的区间证据，基线数值刻度属 engineering-default——报告不再输出「你落在 B 档」这类结论：`portrait.band` 带 `engineeringDefault` 与 D14 说明、`targetProfile` 置空、`portrait.text` 明说「不输出结论档位」；择偶窗口（可达上限/稳妥/下限）同标 engineering-default + 免责声明；知识库 9 条 band 作为「体系参考阶梯」保留，每行带各自证据强度。
### 9.8 BUG-APPEARANCE-NULL 修复与回退护栏（2026-10-05 深夜）

**BUG**：`buildSelfTrack` 对 `self_appearance` 直接 `Number()`：null → 0 → 区间 [1,1]，undefined → NaN → 假区间；两者都会以 0.4 权重进入 `level`。
**修复**：`Number.isFinite` + 区间 [min,max] 校验，未填 / 越界一律返回 `null`（不产出假区间）；`blendAppearance` 跳过缺失轨道；报告新增 `appearance.selfMissing` 与 caveat「未填颜值自评…不按 0 分处理」，颜值卡显示「未提供」。同类隐患一并处理：`scoreDimension` 对 bands / scale1to5 先做数值性校验，非数值不再按 0 计。
**隔离验证**（同一输入：C-022 表单去掉 self_appearance）：修复前 `appearance=[1,1]、level=4.01`；修复后 `appearance=null、level=6.02`（颜值剔除后权重在硬件/软性间重新归一化，Δlevel=+2.01）。
**回归工具口径变化**：修复后 `unsupportedBreakdown` 从 `noInput:11 / noInterval:0` 变为 `noInput:0 / noInterval:11`——11 条缺自评案例从「未触达引擎」变为「引擎明确不产出区间」（诚实结果）。用当前工具版本跑，前后 headline 计数一致（档位比对因基线无数值依据已标 not-comparable）。
**回退护栏**（tools/case_regression.mjs，工作区引擎不可用自动回退到 git 快照时）：
1. 大字横幅告警（78 列 !! 框）写明回退 commit 与失败原因；
2. `knowledge/case-calibration.json` 写入 `degraded:true / fallbackCommit / fallbackLabel / degradedReason`，`knowledge/CASE-CALIBRATION.md` 标题追加「降级运行（DEGRADED）」并在正文顶部单列一节说明，禁止与正常结果混淆；
3. 使用回退时强制 `exit 1`（即使 mismatch 达标），控制台输出 `NOT-VALID（降级运行）`。
实测（clone 内故意破坏 pipeline.mjs）：横幅输出回退 commit d80eea40、JSON degraded=true、MD 顶部有 DEGRADED 段、退出码 1。
### 10.3 facts 字段覆盖自检（photo.* 注入）

**背景**：facts.json 声明了 18 个 `photo.*` 字段，但 buildFacts 未注入 → 引用它的 machine.when 静默失效（P1 陷阱，distill-looks 报出）。

- **注入**：`buildPhotoFacts` 把照片分析结果的 `observed` 以 `photo.<dimId>` 注入（`facts.photo` 用扁平键存储，`getPath` 的扁平键优先逻辑保证 @photo.face.three_courts` 这类路径可解析）；未配置模型 / 未传照片 / 未观测到 → 键不存在（undefined），不注入 null/0/空串。
- **标量子路径**：`appearance.photoTrack.low/high` 由 `mappedInterval` 复制为标量，配合 facts.json 只暴露标量子路径的约定。
- **双向覆盖检查**（`web/lib/facts-coverage.mjs`）：启动时比对 facts.json 声明（含 `hardware.breakdown.<dimId>` 模板，按前缀匹配）与 buildFacts 可注入集合；声明未注入逐条告警、注入未声明汇总告警，完整结果进 `/api/health` 的 `factsCoverage`。
- **D15 落地（2026-10-06）**：`siblings_detail / family_wealth / want_occupation` 已吸收进表单；未声明且未使用的 `context.cityMatched`/`context.gender` 从注入面移除。当前状态：声明 79 / 可注入 104 / **声明未注入 0 / 注入未声明 0**；内部字段（internalFactsNotForRules：context.cityMatched / context.gender）不注入、不报警——性别只保留 subject.gender 一条路径，城市匹配详情放返回值；白名单只认 facts.json 声明过的内部字段。
- **回归测试**：`web/test/photo-facts.test.mjs`（注入语义、模板匹配、真实文件双向核对、端到端「`photo.face.three_courts==三段均衡` 的 machine 规则真的命中」）。
### 10.4a 表单允许「未知」（D28，2026-10-06）

- 19 个自评 / 校准 / 期望字段改为可留空（`web/config/form-fields.json` 的 `required:false` + help 标注），含 `self_appearance`；必填集合 = 14 个客观可查类（有测试锁定，防止与裁定漂移）。
- 颜值三条轨道：无自评无照片 → `appearance.final=null` + caveat「未提供颜值自评与照片：颜值轨道不参与综合分」；有照片无自评 → 仅照片轨道（photo-only）；有自评无照片 → 仅自评轨道（self-report-only）。三种情况都有测试。
- 留空语义：该项 `score=null` / `counted=false`（「未填写，未计分」），不注入 `unknown` 等默认值；报告新增 `missing-inputs` caveat 逐项列出未填未计分项，并注明「不按 0 计、不参与综合分、不作为不利结论」。
- 端到端回归用例从「全字段填写」改为「只填必填」：断言 200 / `rulesApplied` 非空 / caveats 有 missing-inputs / 无 unknown 注入——缺字段路径比全填更能拦住回归。

### 10.4b baseline giveUp 退役（D23 收尾，2026-10-06）

- 删除 `R-BASE-MATCH-001/002/003/004`（阈值 0.5 档 / 有房要求 / 15cm / 年龄差+颜值合取，均无源），基线可执行规则 11 → 7；退役原因写入 `baseline-rules.json` 的 `meta.retiredRules`。**不变式（测试锁定）：基线 giveUp 规则数 = 0，所有放弃项都由知识库驱动**；年龄差由 R-MATCH-041/042（advice）覆盖，颜值门槛部分无接管。
- 接管：知识库 `R-MATCH-040`（`want.appearance_gap > 0`）/ `R-MATCH-049`（男性 `want.height_gap > 0`）/ `R-MATCH-050`（有房要求 ∧ 自身无房，结构矛盾）——同一人设实测只出一条，来源全部为 knowledge。
- 女性身高差 ≥15cm 退役后不再出放弃项：知识库侧按 D23 不做无阈值 giveUp，属预期行为（有测试锁定）。

### 10.4c 报告可读性：A1 折叠灰标（2026-10-06）

- 展示层策略：正文只直显 verified / cross-account / unsupported；single-source 折叠为行尾「▸ 来源」details（内容含强度徽标、supportUnits、account/aweme_id、断言明细）；engineering-default / extrapolated / advisory 仍显示（按裁定保留）。
`- **D30 披露随数据走**`：`/api/report` 顶层返回 `disclosure: { required: true, scope: 证据来源单一机构, text }`（前端只渲染它；UI 测试断言 DOM 文本与 JSON 完全一致），caveats 里带同内容副本；`confidence.independenceCoverage` 输出 `{ totalRules, auditedRules, heuristicRules }`，报告页显示「audit-rules 已审计 X 条 / 未覆盖 Y 条走启发式（带 *）」。
`- **D30 命名与披露**：`内部枚举值不变（verified / cross-account / single-source），显示名改为「机构内多源一致 / 机构内 2 源一致 / 机构内单源」——真实含义是「同一机构多个账号说法一致」，不是跨机构独立验证；报告页顶部与首页各有一条不可折叠、不可被展开开关影响的固定披露（先于任何数字）。
- 计分表在表头给一行聚合（N 项有据 / M 项仅供参考），逐项依据展开可见；证据引用与体系参考改为附录 details（默认折叠）。
- 「展开全部依据」按钮切换所有 details；后端 JSON 不变。headless 实测：可见徽标 304 → 52（全部 330，折叠率 84%）；测试 web/test/report-ui.test.mjs（无 Chrome 时跳过）。

### 10.5a 档位词汇（D24，2026-10-06）

- **停用自创刻度**：S/A/B/C 出自 baseline 的数值区间（engineering-default），语料没有该体系；引擎不再用它做任何档位判定，`portrait.band` 只会指向 knowledge bands。
- **改用博主词汇**：`web/lib/bands.mjs` + `web/config/band-criteria.json` 给 9 条知识库 band 配可判定条件（asset.a7/a8/a9 ← family_wealth；rank/channel/ecosystem 缺表单字段 → `input-missing` + needsField）。报告输出「档位描述：A7 资产档（资产档 · 按表单字段对应博主档位）」，缺输入的档位显式列「输入未提供」。
- **参照刻度**：baseline 的 S/A/B/C 只保留在 `portrait.referenceScale` 与阶梯页的「参照刻度（engineering-default，不作为结论）」小表里，带红标；`portrait.text` 里出现「S/A/B/C」仅为「不输出自创档位」的声明。
- **反向断言（测试）**：知识库 bands 为空时 `portrait.band === null`、只能输出「无语料档位可映射」，且结论句不得出现档位；baseline 只允许以 referenceOnly 出现在参照表里。

### 10.5b 断言级强度（claim-level，2026-10-06）

- 数据源：`evidence-independence.json` 的 `claimLevelStrength`（优先，带 supportUnits）或 `claimIndex`（扁平索引），解析为 `independence.claims`（27 条规则 / 45 条断言：supported-multi 9 / single-source 35 / unsupported 1）。文件缺失或字段缺失 → `provisional` 退回规则级标签。
- 聚合口径：`claimBadgeForRule` 先按文本里的数字 token 匹配该规则的断言，匹配不到则取全部断言，再取**最弱**一条为该行徽标；advice / giveUp 行尾展示徽标，展开可见断言明细（claim + 强度 + 内容单元数）。
- 红线：`unsupported` 的行不删但改口径——`displayText` 前置「（博主曾提及 · 规则内无出处）」，原始 `text` 保留可审计；`claimsSummary` 输出「N 条建议中：X 多源 / Y 单源 / Z 无出处 / K 规则级回退」。
- 梯队与计分项不在 claimIndex 覆盖范围（只有规则有断言），继续用各自已有的规则/维度级徽标。

### 10.5 composites 接入（D17 / D2 / D1）

- **数据质量标记**：`loadQualityFlags` 读 `knowledge/evidence-quality-flags.json`（125 条 / high 21 个 aweme_id）；命中 high 的证据强度降一级（`downgradeLevel`：verified→cross-account→single-source，floor 单源）；同时作用于 audit-rules 预计算强度与启发式判定；文件缺失 → provisional 跳过。报告输出 `confidence.qualityFlags` + 受影响规则清单。
- **表单追补**：`parents_pension / family_atmosphere` 已吸收（enum 与 facts.json 一致），复合表 formGaps 归零，可计算上限 110/110 → 归一化 100；顺带修掉 scoreDimension 在「有 field 无 scoring」维度上的空指针崩溃。

- `knowledge/rules.json` 的 `composites` 由 ruleset 暴露（`getComposite`）；逐项条件放 `web/config/composite-criteria.json`（DSL：身高 175+/本科/有房/有车+加成/年入 10 万+/稳定工作或本市人/体制内/独生子女；父母退休金与原生家庭氛围缺表单字段 → 列 formGaps），映射放 `web/config/composite-mapping.json`（<60→3；60–69.99→4.5；70–79.99→5.5；80–89.99→7；90–100→8.5）。
- `web/lib/composite.mjs`：逐项取分（含车项 +10 加成）→ 相加 → 按 composite.normalize（rawMax 110 → 100）归一 → 映射 1–9；同时输出 computableMax/section gaps 供披露。
- 报告口径：男生 `hardware.basis=corpus-composite`（headline = 复合表分数，标注定义型单源）；女生 `hardware.basis=engineering-weights` + engineering-default 徽标；**综合分 `level` 的硬件槽位：男生用复合表分（single-source，D21 允许为 hard）、女生用工程权重法（engineering-default）**——两块都不合格时选有语料根基的那块（D21 裁定）；`levelComponents` 逐项带 strength/basis/note；`behaviorCheck` 独立成节（standalone-advisory，不进任何分数）。
- 反向断言（有测试）：男十项全达标（可计算 8 项 + 车加成 = 90/110 → 81.8）≥80；十项全缺 = 0 < 60；映射表 81.8→7 分档。

## 11. 下一步实现计划

P0（配合知识库侧）：
1. 把 knowledge/rules.json 的自然语言规则补 `machine` 或标 `advisory:true`（当前 1/1 条未结构化；rules.merged.json 159 条全部未结构化）→ 报告的「未结构化规则」会随之清空，规则开始真正参与计算。
2. 为知识维度补 `field + scoring + weight`（当前 0 个）→ 硬件/软性/匹配的分数将由知识库给出，并可带证据。
3. 知识 bands 补 `range` 或 `setBand` 规则（当前 0 个可数值落档）→ 梯队会自动映射，而不是只做阶梯展示。

P1：报告历史与对比（`/api/reports` 已有）、照片质量前置检查、提升路径复测时间点。
P2：第二 provider 样例（Anthropic / Ollama）、SQLite 存储、PDF 导出、限流与端加密。

## 12. 风险与未决问题

| 风险 | 说明 | 缓解 |
|---|---|---|
| 知识库结构化仍在进行 | 152 条规则中 54 条可执行、98 条 advisory；17 个计分维度的权重仍为工程默认 | 报告按 D11 分层标注；权重来源单独披露；未计入项单列 |
| 演示基线无证据 | 硬件/软性分无语料出处 | 逐项标注「无语料依据（基线/工程默认）」+ 汇总统计 |
| 无用户体系 | 令牌是共享口令，报告之间无归属隔离 | 默认回环；对外必须带令牌；公网需再加反代鉴权 |
| 照片隐私 | 照片落盘、配模型时 base64 外发 | 默认只存本机；请求体量上限；后续加密/即弃 |
| 单文件报告存储 | 全量重写、无分页；merged 模式单份约 107KB | 单机规模可用；上量换 SQLite |
| 端口占用崩溃 | `listen` 的 EADDRINUSE 未被捕获，进程栈溢出退出 | 观察项：建议后续加友好错误提示与端口自动探测 |

## 13. 跨域发现（给知识库 Worker / Lead）

1. `knowledge/rules.json`（默认入口，1 条）与 `rules.merged.json`（159 条）内容差距巨大——线上默认用的是前者。建议明确「哪个文件是发布入口」，或让 merged 成为唯一事实来源。
2. rule id 模式 `^R-[A-Z]+-[0-9]{3}$` 只有一个命名段，Web 基线用 `R-BASE-xxx` 前缀规避；多段 id（如 `R-SCORE-M-001`）需要 schema 放宽。
3. 报告需要硬件/软性/家庭的数值档位锚点（类似颜值 1–9 的 observable）与知识 bands 的 `range`，否则只能用演示标尺以及阶梯展示。
4. 建议知识库导出时顺带跑一次 `node tools/check_rules.mjs`，把「无 machine 也无 advisory」的规则清零。
