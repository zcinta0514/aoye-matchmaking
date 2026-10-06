# 鳌烨择偶定位系统 · Web 端（v0.2）

独立网页应用：填基本条件 → 上传 1–3 张照片 → 自评校准 → 生成定位报告（颜值区间 / 硬件分 / 软性分 / 梯队阶梯 / 择偶上下限 / 幻想项 / 提升路径 / 证据引用）。

**零依赖**：只用 Node 标准库 + 原生 HTML/CSS/JS，不需要 `npm install`，不需要数据库或 Docker。

## 快速开始

仓库根目录执行（要求 Node ≥ 20.11，本机验证 v24.21.0）：

~~~bash
node web/server.mjs
~~~

打开 http://127.0.0.1:8787 即可。默认**只绑定回环地址**，不做对外监听。
首页的「填示例数据（真实案例 C-022）」按钮会调用 `GET /api/sample`，用 `knowledge/cases.json` 里字段最全的真实案例填表，并列出「案例未提供 / 映射说明」的假设清单。

## 分层可信度（D11 / D12）

每个数字都带证据强度标签，报告页有颜色徽标：

| 标签 | 含义 | 进不进计算 |
|---|---|---|
| 机构内多源一致 verified | 同一机构内 ≥3 条独立证据、跨 ≥2 个账号（**非跨机构独立验证**） | 计入 |
| 机构内 2 源一致 cross-account | 同一机构内 2 个账号表述一致 | 计入 |
| 机构内单源 single-source | 同一机构内仅 1 条语料 | 只展示（行尾「来源」折叠，点开可见） |
| 外推参考 extrapolated | 由相近人群外推（D12），误差不可估计 | 只参考，不参与综合分 |
| 工程默认 engineering-default | 无语料依据的工程默认 / 演示基线 | 不计入 |
| 体系参考 advisory | 规则标注 advisory | 只展示 |

- 综合分 `level` 只由「有据 + 跨账号互证」的计分项加权；同时给出「全量参考」（如果都算上会是多少），差异来源逐项可见。
- 证据独立性读 `knowledge/evidence-independence.json`（audit-rules 产出）：**规则强度用其预计算值**（含镜像账号剔除与模板同源去重，分布随导出更新，代码不写死数字）；维度强度仍是启发式（标 *）。文件缺失时整体回退启发式。
- **全局披露（D30）**：报告页顶部与首页各有一条固定声明——全部证据来自同一商业机构（鳌烨传媒）的公开内容，强度标签只表示「机构内多个账号是否一致」，不代表跨机构或第三方独立验证；该声明不可折叠、位于任何数字之前。 披露**随数据走**：/api/report 顶层返回 disclosure: { required: true, scope: "证据来源单一机构", text }（前端只渲染该字段，不硬编码；caveats 里有同内容副本），报告页还显示「audit-rules 已审计 X 条 / 未覆盖 Y 条走启发式（带 *）」的覆盖计数。
- 回归护栏（阻断性）：正式规则集 + 完整表单 → `POST /api/report` 必须 200 且 `rulesApplied` 非空（含知识库 machine 规则）——此前一次 buildFacts 回归就是被这条测试拦住的同类问题。
- 断言级强度（2026-10-06）：建议 / 放弃项按其规则内**最弱的数字断言**加徽标——绿「多源支持」/ 灰「单源·未独立验证」/ 红「规则内无出处」；红色断言不得以肯定语气输出，自动前置「（博主曾提及 · 规则内无出处）」；无断言级数据时退回规则级标签并标 provisional。报告顶部给出「本报告 N 条建议中：X 条多源支持、Y 条单源未验证、Z 条规则内无出处」。
- 数据质量标记（2026-10-06）：读 `knowledge/evidence-quality-flags.json`（数字粘连/循环回音/单位误读）；被标 `severity: high` 的 `aweme_id` 作为证据时强度**降一级**（verified→cross-account→single-source）；文件缺失则跳过并标 provisional；报告里列出受影响的命中规则。
- D15 追补（2026-10-06）：`parents_pension / family_atmosphere` 两个字段已吸收进表单（枚举取自 facts.json）→ 男生十项表不再有表单缺口（110/110 → 归一化 100，完美档 8.5）。
- 权重来源单独披露：知识库 17 个计分维度的权重当前均为工程默认（`weightSource=engineering`），报告 caveat 与明细里都会标注。
- 外推（D12）：14 类语料不足场景（40+ 女性、低学历男、三线以下、无房无车、农村出身、离异有孩、身高边界、非土著一线等）不拒答，用最相近人群规则外推并显式声明；其中 3 类缺表单字段（单亲、残障、丁克），报告「待扩字段的外推场景」里列出。
- 报告页含「因证据不足未计入分数」「体系参考（未自动执行）」「命中规则」三节，并把「该放弃的幻想项」置顶。

## 安全模型（必读）

- 默认 `HOST=127.0.0.1`：仅本机可访问。
- 如需对外（局域网）监听，**必须同时设置访问令牌**，否则进程拒绝启动：

~~~bash
HOST=0.0.0.0 AOYE_ACCESS_TOKEN="$(openssl rand -hex 16)" node web/server.mjs
~~~

  设置令牌后，除 `/api/health` 与静态页面外的所有接口都需要令牌：
  `Authorization: Bearer <token>`、`x-aoye-token: <token>` 或 `?token=<token>`（`<img>` 场景用后者）。
  网页端首次遇到 401 会弹窗询问令牌并存在浏览器 localStorage。
- 报告与照片都只能通过 API 读取（照片不在静态目录下）：`/uploads/...`、`/data/...` 一律 404；未带令牌访问他人报告 / 照片返回 401。
- `web/data/` 含未加密个人信息，请自行做好目录权限与备份管理；照片默认只存本机（配了模型才会把照片发给你配置的 base_url）。
- 本项目没有用户体系，令牌是单一共享口令；公网部署前请再加反向代理鉴权 / HTTPS。

## 配置模型（可选）

**推荐：本地文件**。复制 `.env.local.example` 为 `.env.local`（仓库根，已 gitignore），填入 base_url / key / model 后启动即可：

~~~bash
cp .env.local.example .env.local
# 编辑 .env.local：KEY=VALUE 每行一条，不加引号
node web/server.mjs
~~~

安全约定：只读取 `AOYE_LLM_*` 前缀的键；**已存在的环境变量优先**（文件不覆盖）；`.env.local` 权限过宽（如 644）会在启动时提示 `chmod 600`；启动日志与 `/api/meta` 只显示 base_url 的协议 + 域名，**不回显 key 的任何部分**。

不配置 = 纯表单模式（不调用模型，只用规则引擎 + 自评校准），功能完整可跑通。配置后照片轨道启用，但模型**只输出可观察维度描述与锚点符合度，不输出任何分数**：

~~~bash
export AOYE_LLM_BASE_URL="https://api.openai.com/v1"   # 任意 OpenAI 兼容接口
export AOYE_LLM_API_KEY="sk-..."
export AOYE_LLM_MODEL="gpt-4o-mini"                     # 需支持图片输入
export AOYE_LLM_VISION="auto"                           # auto | off（off = 只发文字，不传图）
export AOYE_LLM_TIMEOUT_MS="60000"
export AOYE_LLM_MAX_IMAGE_MB="8"                        # 单次请求发给模型的照片总量上限
node web/server.mjs
~~~

调用失败 / 超时 / 读图失败 / 返回非法 JSON 都会自动降级为纯表单模式，报告里写明降级原因，不会中断流程（有测试覆盖）。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 8787 | 监听端口 |
| `HOST` | 127.0.0.1 | 监听地址；非回环必须配 `AOYE_ACCESS_TOKEN` |
| `AOYE_ACCESS_TOKEN` | 空 | 访问令牌；设置后所有 API 需要令牌 |
| `AOYE_RULES_PATH` | knowledge/rules.json | 主规则集（权威，必须含证据） |
| `AOYE_BASELINE_PATH` | web/config/baseline-rules.json | 演示基线（补缺，未取证） |
| `AOYE_DATA_DIR` | web/data | 用户档案 / 上传照片存储目录 |
| `AOYE_MAX_PHOTO_MB` | 10 | 单张照片上传上限（超限返回 413 JSON） |
| `AOYE_LLM_*` | 见上 | 模型接入参数 |

## 规则集：如何替换 / 扩展

1. 主规则集固定是 `knowledge/rules.json`（契约文件，由知识库 Worker 维护）。重启进程即加载最新文件；页面「规则集状态」可看版本、覆盖率、可执行规则数与告警。
2. 加载策略：**按 id 逐条合并，knowledge 覆盖同 id 基线条目**，不是整体替换。
3. 规则二选一（契约 §5.0）：
   - 可执行：`machine: { when: <DSL>, then: [{kind,...}] }`，引擎直接执行；
   - 只给人看：`advisory: true`，报告里进「体系参考（未自动执行）」一节；
   - 两者都没有 → 报告进「未结构化规则」并给出告警。
4. DSL：`{ field, op, value }` 与 `{ all|any|not }` 组合；op 白名单 `eq neq gt gte lt lte in nin between exists missing includes matches`。
   **加载期强校验**：未知键、非法 op、错误 value 形状、非法 then.kind 一律拒绝启动（不会静默跳过）。
5. `machine.then[].kind`：`clampScale | setBand | advice | giveUp | text | flag | requireEvidence`。
6. 知识维度参与打分：维度需带 `field + scoring`（`bands | options | scale1to5`）+ `weight`；缺 scoring 的维度只作展示。缺 weight 的维度不计入总分并标注原因。
7. 知识 bands 没有数值 `range/level` 时不会被强行拟合成分数区间：报告以「梯队阶梯」展示，靠 `setBand` 规则钉档；两者都没有时明确写「无法自动映射」。
8. 证据状态：任何计分项若没有语料证据（`account+aweme_id+quote`），报告明细里逐项标注 **无语料依据（基线/工程默认）**，并在顶部汇总「有证据 X / 无证据 Y」。
9. `web/config/baseline-rules.json` 是演示基线（未取证），只补知识库空缺；目前 11 条已全部迁移到 `machine` 格式，可被引擎执行（但无证据，报告会标注）。

## 字段覆盖自检（facts.json ↔ buildFacts）

- 启动时读 `knowledge/facts.json`：打印它的 warnings，并双向比对「声明的字段」与「buildFacts 实际注入的字段」。
- 声明了但注入不了 → 逐条告警（引用它的 machine.when 会静默失效）；注入了但没声明 → 汇总告警。完整结果在 `/api/health` 的 `factsCoverage`。
- 照片轨道：模型返回 observed 时注入 `photo.<dimId>`（18 个维度）；未配置模型 / 未传照片 / 未观测到 → 保持 undefined，不注入 null/0/空串。
- D28（2026-10-06）：**表单允许「未知 / 不便填写」**——自评类（性格 / 沟通 / 情绪稳定 / 生活能力 / 社交圈）、校准类（自评位次 / 被搭讪频率 / 介绍对象差距 / 照片处理 / 面部原生）、期望类（want_*，8 个）共 19 项改为可留空（含颜值自评 `self_appearance`：留空后颜值轨道不参与综合分）；客观可查类（性别 / 年龄 / 城市 / 身高 / 学历 / 院校 / 职业 / 收入 / 房 / 车 / 户籍 / 婚史 / 家庭 / 手足）+ 颜值自评保持必填。**留空 = 无值，不参与计分、不按 0 算、不作为不利结论**；报告 caveats 会逐项列出「因未填写未计分」（missing-inputs），且绝不把留空注入成 unknown 之类的默认值。只填必填的提交实测 200 / rulesApplied 非空。
- D23 收尾（2026-10-06）：baseline 里 3 条「无源阈值」giveUp（颜值 0.5 档 / 有房要求 / 身高 15cm）已**删除**，改由知识库 R-MATCH-040/049/050 接管（方向 >0 或结构矛盾，硬举证）；同一人设只出一条放弃项。女性身高差 ≥15cm 不再出放弃项（阈值无源，D23 裁定不做，属预期）。退役记录在基线文件 meta.retiredRules 里。
- D23 追补（2026-10-06）：第 4 条（也是最后一条）基线 giveUp `R-BASE-MATCH-004`（「年龄差 7/8 岁 + 对方颜值 ≥6」的合取阈值，无源）已退役；年龄差部分由知识库 R-MATCH-041/042 以 advice 覆盖，颜值门槛部分无接管按 D23 删除。**不变式：基线里 giveUp 规则数量必须为 0（所有放弃项都由知识库驱动），有测试锁定。**
- D24（2026-10-06）：**报告档位只说博主自己的词汇**（打分局名次 / 资产档 / 活动渠道 / 生态位，来自 knowledge/rules.json 的 9 条 bands）。S/A/B/C 是本系统早期自创刻度，语料里不存在：只在「参照刻度（engineering-default）」里出现，**不参与任何判定、不出现在结论句**。缺对应表单字段的档位显示「输入未提供」，不猜。
- D15（2026-10-06）：`siblings_detail / family_wealth / want_occupation` 已吸收进表单（枚举取自 knowledge/extra-fields.json）；启动检查为「声明未注入 0 / 注入未声明 0」。
- D14（2026-10-06）：S/A/B/C 档位刻度无语料依据，落档与择偶窗口都标 `engineering-default` 且不作为结论；知识库 9 条 band 作为「体系参考阶梯」保留（各自带证据强度）。
- D17（2026-10-06）：**男生硬件分改用语料十项加分表**（`composites.hardware.male`，原分 110 → 归一 100 → 映射 1–9，映射口径在 `web/config/composite-mapping.json`，逐项条件在 `web/config/composite-criteria.json`），逐项显示达标/得分/表单缺口；该表为定义型单源（D21，1 条转写 / 1 个账号）——**D21 裁定允许计入 level**：综合分的硬件槽位改用复合表分（基准强度标 single-source），工程权重表保留为参考展示（权重为工程默认，D17）。**女生硬件分与软性分保持工程权重法**并标 `engineering-default`。`behavior` composite 按 D1 只作「相亲现场行为自查」独立展示，不接入任何分数。

- 内部字段（facts.json 的 internalFactsNotForRules）：context.cityMatched / context.gender 不注入、不报警（性别只保留 subject.gender 一条路径；城市匹配详情放在返回值而不是 facts 里）。白名单只认声明过的内部字段，未声明的注入仍会报警。

## 报告可读性（A1 折叠灰标）

- 正文行只直接显示 **绿标（有据）/ 蓝标（跨账号互证）/ 红标（规则内无出处）**；数量最多的「单源·未独立验证」折叠成行尾淡色「依据」，点开可见强度、权重来源、出处与断言明细。
- 顶部仍保留总结句（N 项：X 项有据、Y 项单源未验证、Z 项规则内无出处）；右上角「展开全部依据」一键展开/收起（默认关）。证据引用与体系参考两个附录默认折叠。
- 后端 JSON 结构不变（evidenceIndex / rulesApplied / claimBadge 原样保留），只改默认可见性。实测：默认视图可见徽标 304 → **52**（折叠率 84%）。

## 静态版（GitHub Pages）

`node tools/build-static.mjs --photos=off`（默认）生成 `dist/`：零构建、零 npm 依赖、纯静态（表单 → 本机跑引擎 → 报告存 localStorage，无后端）。

- 照片模式三选一：`--photos=off`（默认，公开版：照片输入禁用并提示）｜`--photos=byok`（用户在本页填 base_url/key/model，存 localStorage、直连其服务商，含安全警告）｜`--photos=proxy --proxy-url=https://<worker 域名>`（图片分析由 Cloudflare Worker 代理完成，前端不接触 key；Worker 见 `worker/`，部署步骤见 `worker/README.md`）。**任何模式下构建产物都不含 key**（构建末扫描 sk- / .env / data/video|transcripts，命中即失败；proxy 模式还会断言前端不出现 `AOYE_LLM_API_KEY` 变量名与 Authorization 头）。
- 数据目录：`?data=./data/` 可指定（默认 `./data/`）；报告页支持 `?id=` 或读 `aoye:lastReportId`。
- 本地预览：`python3 -m http.server 8080 --directory dist` 然后打开 `http://127.0.0.1:8080/`。
- 构建自检：`report.html?selftest=1` 会就地跑一份示例报告并渲染（构建验证用）。
- 结构：`dist/{index.html, report.html, assets/{app,report,styles}, lib/*.mjs, data/*.json}`；体积约 2.06 MB / 32 个文件。

## 目录结构

~~~
web/
  server.mjs               HTTP 服务（鉴权 / 绑定策略 / 上传魔数校验 / API）
  package.json             无依赖；scripts: start / test
  config/
    form-fields.json       表单字段定义（前端渲染 + 服务端校验的单一来源）
    cities.json            城市分档（演示基线）
    baseline-rules.json    演示基线规则（machine 格式，未取证，补缺用）
  lib/
    ruleset.mjs            加载 + 强校验 + 合并 + 规则分层（executable/advisory/unstructured）
    engine.mjs             DSL 求值、维度评分、颜值双轨映射、machine 动作、梯队窗口
    pipeline.mjs           端到端报告（照片轨道 → 自评 → 规则 → 梯队阶梯 → 证据状态）
    provider.mjs           OpenAI 兼容适配层（可替换；未配置/失败时占位降级）
    validate.mjs           表单校验（类型严格）
    store.mjs              JSON 存储（报告 + 照片）
    city.mjs / util.mjs    城市档、原子写、模板、路径解析
  public/
    index.html + app.js    表单 / 上传 / 校准 / 提交（含令牌交互）
    report.html + report.js 报告页（梯队阶梯、证据状态、体系参考）
    styles.css
  test/
    engine.test.mjs        引擎单测（含 machine 动作、DSL 强校验、知识维度计分、降级回归）
    e2e.test.mjs           HTTP 端到端 + 鉴权 + 绑定策略
  data/                    运行时数据（gitignore）：reports.json、uploads/
~~~

## API

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/health` | 健康检查、可执行规则统计、告警 | 公开 |
| GET | `/api/form` | 表单字段与分组 | 需令牌（如已设置） |
| GET | `/api/meta` | 规则集版本 / 覆盖率 / 分层计数 / 模型状态 | 需令牌 |
| POST | `/api/photos` | 原始二进制上传（校验文件魔数），返回 id | 需令牌 |
| GET | `/api/photos/:id` | 取回照片 | 需令牌 |
| POST | `/api/report` | `{form, photoIds}` → 生成并保存报告 | 需令牌 |
| GET | `/api/report/:id` | 报告 JSON | 需令牌 |
| GET | `/api/reports` | 最近报告列表 | 需令牌 |
| GET | `/r/:id` | 报告网页（数据仍需 API 令牌） | 页面公开 |

## 验证

~~~bash
node --test 'web/test/*.test.mjs'   # 53 个测试全绿（含 1 条 headless Chrome 可读性用例；无 Chrome 时自动跳过）
~~~

完整验证记录（命令 + 原始输出）见 `docs/WEB-ARCH.md` 第 9 节。

## 待接入点（TODO）

- `web/lib/provider.mjs#analyzePhotos`：照片分析入口；换模型（Claude / Gemini / 本地模型）只改这一个文件。
- 知识库补齐 `machine` 后，报告里的「未结构化规则」与「无语料依据」标注会自动减少，无需改 Web 代码。
- 报告历史对比、PDF 导出、SQLite 存储（页面侧入口未做，API 已有数据基础）。
