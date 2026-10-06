# 鳌烨择偶定位系统 · Web 端独立验收报告

- 验收人：独立验收 Worker（Orca）
- 验收时间：2026-10-05 23:03–23:08 CST
- 验收对象：web/ 全量项目（只读审计 + 实际启动服务；未修改 web/ 与 knowledge/ 下任何文件）
- 运行环境：macOS，Node v24.21.0，零 npm install；未配置任何 AOYE_* 模型环境变量（降级基线）
- 端口使用：8857 / 8858 / 8861–8868，未触碰 8799 采集器
- 被验版本（sha256）：
  - knowledge/rules.json = 75840c19cbbcabadc7a3b03de9bca4b6851a9e187a0a96d8fd2e758f547adea1（v1.0）
  - knowledge/rules.merged.json = 4008c6cfe07824ce4302eff4b0b842401cc7e20907972e4665481b84419d1e08（v1.1，generatedAt 2026-10-05T15:05:41.723Z）
- 说明：审计期间知识库侧在并发更新（rules.merged.json 从 v1.0 升到 v1.1），merged 相关结论已用 v1.1 复测；复测前后结论一致。

## 0. 总表

| 级别 | 数量 | 一句话摘要 |
| --- | --- | --- |
| P0 | 2 | 配置模型 Key 后「上传照片」直接 500；无鉴权服务可被局域网任意读取全部报告与照片 |
| P1 | 3 | 159 条知识库规则与 43 个知识维度对引擎零影响；DSL 静默忽略未知条件键导致规则误触发；默认配置下实际打分结论都没有证据 |
| P2 | 11 | 超限请求断连、照片不校验魔数、未知城市静默降档、文本静默截断、覆盖率元数据缺失、README 与实测不符、存储规模隐患、dataQuality 未使用、双轨阈值硬编码、静态前缀校验、布尔值数值化 |

验收结论速览：

1. 启动：成功。零依赖，一条命令可起（node web/server.mjs）。
2. 完整流程：跑通（表单 → 提交 → 报告 → 报告页），无 Key 纯表单模式约 5–12ms 出报告。
3. 无 Key 降级：可用，符合硬需求；照片轨道为 placeholder，不阻塞报告。
4. rules.merged.json：能加载、不崩；但 159/159 条规则不可执行、43 个维度 0 个有评分映射、11 个知识档位 0 个符合引擎结构。指向它以后分数与默认 rules.json 完全相同，只有颜值锚点标签与证据列表变了。
5. P0 清单：P0-1（照片 + 模型 Key → HTTP 500）、P0-2（无鉴权 + 可对外监听 → 局域网可读全部报告/照片）。

## 1. 启动与完整流程记录

启动命令（原样）：

    cd /Users/xindong/Documents/aoye
    PORT=8857 node web/server.mjs

启动输出（原样）：

    鳌烨择偶定位系统 · web 骨架已启动
      地址        : http://127.0.0.1:8857
      规则集      : /Users/xindong/Documents/aoye/knowledge/rules.json (v1.0, 覆盖率 23%)
      基线补缺    : /Users/xindong/Documents/aoye/web/config/baseline-rules.json (11 条, 未取证)
      数据目录    : /Users/xindong/Documents/aoye/web/data
      模型        : 未配置（纯表单模式）

健康检查：

    curl -s http://127.0.0.1:8857/api/health
    {
      "ok": true,
      "time": "2026-10-05T15:04:07.244Z",
      "rulesVersion": "1.0",
      "modelConfigured": false
    }

完整流程（照片上传 → 报告 → 回读 → 报告页）：

    curl -s -X POST -H 'content-type: image/png' --data-binary @face.png http://127.0.0.1:8857/api/photos
    { "id": "ph_muvdt14c763cb7e0", "mime": "image/png", "bytes": 70 }

    curl -s -X POST -H 'content-type: application/json' --data-binary @payload.json http://127.0.0.1:8857/api/report
    HTTP 200，耗时 5ms（service 端计时）

报告关键字段（无 Key 模式）：

    {"level":6.14,
     "appearance":{"low":5.5,"high":6.5,"consensus":true,"mid":6,"step":0.5},
     "finalLabel":"班草/校草门槛",
     "hardware":6.12,"soft":6.38,
     "photoMode":"placeholder",
     "photoDimCount":7,"photoDimsAllNull":true,
     "rulesApplied":0,"nonExec":1,"evidenceIndex":4,
     "caveats":["corpus-coverage","unverified-baseline","photo-track","evidence-only"]}

    GET /api/report/<id>  → 200
    GET /r/<id>           → 200（报告页 HTML 壳，客户端拉 JSON 渲染）
    GET /api/photos/<id>  → 200

单元 / e2e 测试（按 README 命令）：

    node --test 'web/test/*.test.mjs'
    ℹ tests 11  ℹ pass 11  ℹ fail 0

注意：README 写的是「9 个测试全绿（引擎 7 + 端到端 2）」，实际是 11 个（引擎 9 + 端到端 2）。

## 2. P0 问题

### P0-1 配置模型 Key 后，上传照片的提交直接 HTTP 500，照片轨道完全不可用

现象：只要同时满足「配置了 AOYE_LLM_API_KEY」「AOYE_LLM_VISION 非 off（默认 auto）」「photoIds 非空」三个条件，POST /api/report 必然 500，报告完全不生成。该失败发生在图像转 base64 阶段，异常没有被降级逻辑捕获。

复现命令与原始输出：

    PORT=8865 AOYE_LLM_API_KEY=sk-test \
      AOYE_LLM_BASE_URL=http://127.0.0.1:9/v1 \
      AOYE_LLM_TIMEOUT_MS=1500 \
      AOYE_DATA_DIR=/tmp/aoye-audit/data-repro \
      node web/server.mjs &

    # 复用验收脚本 /tmp/aoye-audit/harness5.mjs 场景 C
    node /tmp/aoye-audit/harness5.mjs
    #C key+photo=1: {"status":500,
    #  "summary":"error=The \"path\" argument must be of type string or an instance of Buffer or URL. Received undefined"}

服务端日志（原样，Windows 路径不存在，这里是 macOS 栈）：

    [error] TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string or an instance of Buffer or URL. Received undefined
        at Object.openSync (node:fs:622:5)
        at Object.readFileSync (node:fs:487:35)
        at toDataUrl (web/lib/provider.mjs:56:21)
        at web/lib/provider.mjs:113:59
        at Array.forEach (<anonymous>)
        at analyzePhotos (web/lib/provider.mjs:112:12)
        at generateReport (web/lib/pipeline.mjs:64:13)
        at handleApi (web/server.mjs:144:26)

边界确认（同一脚本）：

    #A key+vision=off+photo: 200, photoMode=error（不崩，降级成功）
    #B key+photo=none:      200, photoMode=placeholder
    #C key+photo=1:         500（即默认 vision=auto 时的崩溃）

根因：字段名不一致 + 异常处理位置错误。

- store.getPhoto 返回的对象字段是 file：web/lib/store.mjs:27（return { id, file, mime, bytes }）
- provider 读取的却是 photo.path：web/lib/provider.mjs:113（toDataUrl(photo.path, photo.mime)），toDataUrl 在 :55-57
- 服务端把 store 返回对象原样透传给 pipeline：web/server.mjs:140-142，web/lib/pipeline.mjs:63-65
- 关键的 photos.forEach 块位于 try/catch 之外：web/lib/provider.mjs:112-115 是 forEach，真正包住模型调用的 try 从 :117 才开始。于是读图异常直接穿透 analyzePhotos → generateReport → 500，违背 README:32「调用失败 / 超时 / 返回非法 JSON 都会自动降级…不会中断流程」的承诺。
- 测试为什么没抓到：e2e 用例手工构造 photos: [{ path: file, mime: "image/jpeg" }]（web/test/e2e.test.mjs:119），从未使用真实 store 返回对象；单元测试也绕开了这条生产路径。

修复建议：

1. 统一字段（建议 store.getPhoto 返回 path 或同时保留 file/path），或在 provider 里用 photo.path || photo.file 兼容。
2. 把整个 analyzePhotos 主体（含建 prompt、读图、编码）都放进 try/catch，任何失败都降级为 placeholder/error 模式并写 caveat，保证报告永远能出。
3. 增加回归测试：用 createStore 真实保存一张图 → 构造 store.getPhoto 结果 → 配置 stub fetch → 断言 200 且 photoMode=model；再断言读图失败时降级而非 500。

### P0-2 无鉴权 + 服务可对外监听 → 局域网任意设备可读取全部报告与照片

现象：项目没有任何登录 / token / 会话 / 来源校验（全仓库无鉴权中间件）。GET /api/reports 会返回最近 50 条报告的 id、创建时间、性别、城市、综合分；拿到 id 后 GET /api/report/:id 返回完整报告（含全部个人填写）；GET /api/photos/:id 直接返回照片原文件。默认 HOST=127.0.0.1 限制了暴露面，但 HOST 是环境变量（web/server.mjs:19），一旦按常规部署习惯设为 0.0.0.0，任何同网设备即可读取。

复现命令与原始输出：

    HOST=0.0.0.0 PORT=8867 node web/server.mjs
    # 在另一台/同一台机器上，用本机局域网 IP
    curl http://192.168.1.103:8867/api/reports
    # => 200 {"reports":[{"id":"rpt_...","createdAt":"...","gender":"male","city":"杭州","level":6.14}]}

    # 未提交过报告的攻击者也能提交并读取他人报告
    #D bind 0.0.0.0, en0=192.168.1.103
    #D LAN GET /api/reports -> 200 count=0
    #D LAN POST /api/report -> 200
    #D LAN GET others report -> 200 contains city=true

即使在默认 127.0.0.1 下，同机任意进程 / 任意本地用户也能读取全部报告与照片；由于没有用户体系，报告之间也没有任何归属隔离。

涉及文件与行号：

- 监听地址可被环境变量覆盖：web/server.mjs:19
- 列表接口：web/server.mjs:109-111 → web/lib/store.mjs:39-44（返回 50 条 id/city/gender/level）
- 报告读取：web/server.mjs:157-162（任意 id 直接返回全文）
- 照片读取：web/server.mjs:121-127（任意 id 直接返回文件）

修复建议（二选一或组合）：

1. 若产品定位就是「本机单用户」，删除 HOST 覆盖或仅允许 127.0.0.1，并在 README 用显著位置写明「含未加密个人信息，禁止对外监听」。
2. 若要允许局域网使用，至少加访问口令（启动时生成随机 token 或环境变量 token），所有 /api/report*、/api/photos*、/api/reports 校验 Bearer/Cookie；报告 id 不能当作访问凭证。
3. 给 /api/reports 增加鉴权并考虑默认关闭。

## 3. P1 问题

### P1-1 「数据驱动」名不副实：159 条知识库规则、43 个知识维度全部对引擎零影响

现象：把服务指向 knowledge/rules.merged.json（v1.1）后，服务能加载、不崩，但：

- 159/159 条规则的 when 与 then 都是自然语言字符串，0 条可执行；
- 43 个知识维度中 0 个带 scoring 字段（有 options/bands 原始素材，但不是引擎要求的 scoring 结构），weight 也多为 null；
- 11 个知识档位（bands）0 个带引擎需要的 range/level；
- 知识库 rules.json（默认主文件）只有 1 条自然语言规则。

因此指向 merged 后，报告与默认配置在分数上完全一致（6.14 / 6.12 / 6.38 逐位相同），rulesApplied 仍为 0，梯队仍是 baseline 的「A 档 · 明显优势」；只有颜值锚点标签与证据列表数量变化。

复现与原始数据：

    AOYE_RULES_PATH=knowledge/rules.merged.json PORT=8858 node web/server.mjs
    # 启动输出：
    # 规则集 : .../knowledge/rules.merged.json (v1.1, 覆盖率 ?%)

    # 数据统计（对 v1.1 直接校验）：
    {"rules":159,"nlWhen":159,"executable":0,
     "dims":43,"scoredDims":0,
     "bands":11,"bandsUsable":0,
     "corpus":{},"version":"1.1"}

    # /api/meta：
    counts = { "scales":3, "dimensions":66, "rules":170,
               "executableRules":11, "nonExecutableRules":159, "bands":15 }
    # 11 条可执行全部来自 web/config/baseline-rules.json

    # 同一表单在两种规则集下的报告对比：
    default: level 6.14, hardware 6.12, soft 6.38, rulesApplied 0, nonExec 1, evidenceIndex 4
    merged : level 6.14, hardware 6.12, soft 6.38, rulesApplied 0, nonExec 159, evidenceIndex 115
    # merged 的 40 个打分项中，23 个 knowledge 项 score 全为 null；17 个计分项 100% 为 web-baseline
    # 梯队来源仍为 web-baseline（"A 档 · 明显优势"）

涉及文件与行号：

- 规则分类只按 when 是否为字符串：web/lib/ruleset.mjs:122-123
- 引擎显式跳过字符串 when：web/lib/engine.mjs:278（typeof rule.when !== "object" 直接 return）
- 规则校验只要求 when/then「存在」，不要求是结构化对象：web/lib/ruleset.mjs:65-71
- 维度评分要求 dim.scoring 与 dim.weight：web/lib/engine.mjs:49-83；知识维度没有 scoring → score 全 null
- 档位解析要求 range 或 level：web/lib/engine.mjs:248-253；知识档位没有这两个字段 → 被忽略

这同时也解释了 P1-3：所有实际计分结论都来自演示基线。

修复建议：

1. 知识库导出侧做「结构化转换」：rules 的 when 输出 DSL 对象（all/any/not + field/op/value），then 输出动作对象（clampScale/advice/giveUp/text）；dimensions 输出 scoring（bands/options/scale1to5）与 weight；bands 输出 range/level。
2. 引擎侧改为「载入即报错」或「显著告警」：主规则集若 executableRules === 0，/api/health、/api/meta、报告 caveats 与首页状态区都应出现红色警告，而不是静默用 baseline 打分。
3. 增加集成测试：加载 rules.merged.json，断言 executableRules > 0，且至少一条 knowledge 规则能命中并出现在 rulesApplied。
4. 对未结构化素材提供转换预览工具（把 options/bands 原始素材映射为 scoring 的过程可视化），避免再出现「文件很厚、引擎没用上」。

### P1-2 条件 DSL 静默忽略未知键：规则在必要条件不满足时也会触发

现象：web/config/baseline-rules.json 的 R-BASE-MATCH-004 用了 all2 作为第二个条件键，但引擎的 evalCondition 只识别 all / any / not。all2 被无声忽略，导致这条规则只要年龄差满足就触发，文案宣称的「叠加颜值 ≥6 分门槛」根本没被检查。

复现与原始输出：

    #CASE B-all2-ignored(want_appearance_min=3) status=200
    {"appearance":{"low":5.5,"high":6.5,...},
     "rulesApplied":["R-BASE-MATCH-004"],
     "giveUps":[{"id":"GIVEUP-BASE-004",
       "text":"年龄差要求叠加颜值 ≥6 分门槛，属于双硬约束；其中一项需要放宽，否则匹配周期会显著拉长。",
       "origin":"web-baseline"}]}

输入条件是 gender=female、age=30、want_age_max=38、want_appearance_min=3。规则要求 want_appearance_min ≥ 6 才成立，实际 3 也触发了。

涉及文件与行号：

- 违规规则：web/config/baseline-rules.json:265-269（"all2": [ { "field": "subject.want_appearance_min", "op": "gte", "value": 6 } ]）
- 求值器：web/lib/engine.mjs:13-22（只处理 all/any/not，未知键落到 evalLeaf，返回 false 但不报错；且 cond.any 存在时 all2 完全不参与）
- 规则校验：web/lib/ruleset.mjs:65-71 不校验 when 内部结构

修复建议：

1. 校验 when：允许的键白名单（all/any/not/field/op/value），未知键直接判为校验失败并给出规则 id。
2. 校验 op 白名单与 value 类型（between/in/includes/matches 等各自的形状）。
3. 修正 R-BASE-MATCH-004：all2 改为 all，或把两个条件合并进一个 all 数组。
4. 增加回归测试：want_appearance_min=3 时该 ruleId 不得出现在 rulesApplied。

### P1-3 默认配置下「证据可追溯」只覆盖颜值标尺；全部实际打分结论没有出处

现象：报告结构与渲染都支持证据（account + aweme_id + quote + usedFor），但这只在颜值锚点/维度上生效。默认 rules.json 模式下 evidenceIndex 只有 4 条，全部 usedFor=appearance.anchors / anchor:*；17 个实际计分项（硬件/软性/家庭）全部来自 web-baseline，evidence 为空，报告只能靠「演示基线（未取证）」标签说明。merged 模式下 evidenceIndex 上升到 115 条，但计分项仍全部是 baseline，知识与计分之间没有建立引用关系。

原始数据：

    default: evidenceIndex=4, 明细：
      aoye98/7656724726068301062 … usedFor=appearance.anchors（颜值标尺锚点）
      aoye98/7640777429912538409 … usedFor=appearance.anchors
      aoye98/7648982262922382646 … usedFor=appearance.anchors
    merged: evidenceIndex=115（含 rule:R-LOOKS-* 等），但 hardware/soft 计分项仍 origin=web-baseline、score 来自 baseline

涉及文件与行号：

- 证据收集与 aweme_id 校验：web/lib/pipeline.mjs:42-49
- 证据索引只从外观标尺/维度与命中的规则收集：web/lib/pipeline.mjs:145-162
- 计分维度证据来自 dim.evidence（baseline 为空数组）：web/config/baseline-rules.json 各维度 evidence: []

结论：可追溯机制实现正确，但「报告里的结论能否展示出处」目前只对颜值标尺成立；这是 P1-1 的直接后果，属于发布前必须解决的产品级缺口（不是加一行 UI 能解决的）。

修复建议：

1. 先完成 P1-1 的结构化，让计分维度与规则有 evidence。
2. 报告增加统计「有知识库证据的结论 X/Y」，并在 UI 上让无证据结论显式标注「未取证」而非默认混排。
3. 知识库侧为每个维度/规则补 account + aweme_id + quote，用现有校验器卡住不合格数据。

## 4. P2 问题

### P2-1 超过体积上限的请求直接断连，不返回 413

现象：JSON > 512KB 或照片 > 10MB 时，readBody 先 reject 再 req.destroy()，响应来不及发出，客户端看到的是 ECONNRESET / fetch failed，而不是 413 JSON。

原始输出：

    #RAW 600KB JSON  -> {"status":0,"error":"ECONNRESET read ECONNRESET"}
    #RAW 11MB photo  -> {"status":0,"error":"ECONNRESET read ECONNRESET"}
    # 断连后服务仍存活：GET /api/health -> true，无崩溃

涉及文件与行号：web/server.mjs:48-64（reject + req.destroy）；上限定义 web/server.mjs:25-26。

修复建议：先发送 413 响应（或至少发送后再结束连接，如 res.writeHead(413).end() 再 req.destroy()），前端 catch 显示可读错误；也可在上限内先暂停读取再回包。

### P2-2 照片只校验 content-type，不校验文件魔数

现象：28 字节纯文本以 content-type: image/png 上传 → 200，落盘 .png，回读 content-type image/png。配置模型后这类垃圾文件会被 base64 发给模型（随后多半降级为 error 模式）。

原始输出：

    #JUNK_ACCEPTED id=ph_muvdt15jbc61d2d4 bytes=28 get_status=200 get_ct=image/png

涉及文件与行号：web/server.mjs:113-117；web/lib/store.mjs:5-6、17-22（未知 image/* 一律映射 .jpg）。

修复建议：校验 PNG/JPEG/WebP/HEIC 魔数；或至少在保存后做一次解码校验，失败返回 415。

### P2-3 不存在的城市静默按三线处理，报告不提示

现象：城市是自由文本，任何字符串都能通过；cityTier 查不到时返回 defaultTier=3，收入分档随之按三线标准，但报告没有任何「城市未识别」的警告。

涉及文件与行号：web/lib/city.mjs:19-25；web/config/cities.json:9（defaultTier: 3）。

修复建议：返回 tier=null/unknown 并写 caveat；或在表单加城市下拉/联想（config/cities.json 已有列表）。

### P2-4 文本字段静默截断 200 字符

现象：city 输入 2000 字，存进报告只有 200 字，没有任何提示；用户看到的是被截断的输入。

原始输出：

    reports with long city: 1（截断后长度 200）

涉及文件与行号：web/lib/validate.mjs:35（String(raw).slice(0, 200)）。

修复建议：超长直接 422 报错，或截断时附加 warning 并在报告里显示。

### P2-5 merged 规则集缺少 corpus 元数据，覆盖率显示为问号

现象：rules.merged.json 的 corpus 是空对象，启动日志与报告 caveat 变成「覆盖率 ?%（?/? 条）」。

原始输出：

    规则集 : .../rules.merged.json (v1.1, 覆盖率 ?%)
    caveat: "知识库规则基于当前转写语料 ?%（?/? 条）。"

涉及文件与行号：knowledge/rules.merged.json（数据）；web/lib/pipeline.mjs:213；web/server.mjs:98。

修复建议：合并脚本补 corpus {transcribed, planned, coveragePct, accountsUsed}，或引擎对缺失做显式提示。

### P2-6 README 与实际不符（测试数量）

现象：web/README.md:97 写「9 个测试全绿（引擎 7 + 端到端 2）」，实际 11 个（引擎 9 + 端到端 2），全部通过。文档漂移会误导验收与回归。

修复建议：更新 README，或改为不带数字的描述 + CI 输出为准。

### P2-7 报告存储为单 JSON 全量重写，无上限/分页，merged 模式单份报告 107KB

现象：每次提交都会把整个 reports.json 序列化重写（原子写），报告与照片都无总量上限；merged 规则集下单份报告 JSON 107KB（159 条 nonExecutableRules 全量内联，含证据），1000 份即 100MB 级别，列表接口也会全量 Object.values + sort。

原始数据：

    merged report bytes = 107291；reports.json 每次提交全量重写
    并发 10 次提交：10/10 成功、10/10 可回读、reports.json entries=14 includes_all=true（当前规模无丢失）

涉及文件与行号：web/lib/util.mjs:9-14（writeJsonAtomic 全量写）；web/lib/store.mjs:31-44。

修复建议：报告列表与报告体分离存储；nonExecutableRules 改为引用/分页；设置单用户记录上限或归档策略。

### P2-8 模型返回的 dataQuality 采集后全链路未使用

现象：provider 解析并透出 dataQuality.usable/issues，但引擎、报告、UI 都不消费；即使模型判断照片不可用（usable=false），anchorFits 仍会照常映射出区间。

涉及文件与行号：web/lib/provider.mjs:147；web/lib/pipeline.mjs（无引用）；web/public/report.js（未渲染）。全仓库 grep dataQuality 仅出现在 provider/placeholder 定义处。

修复建议：usable=false 时跳过照片轨道并降级为纯表单 + 提示补图；issues 在报告里展示。

### P2-9 双轨校准阈值硬编码，规则文件无法调整

现象：锚点 fit → 区间的阈值 0.6 / 0.35 写死在引擎里；自评校准的 ±0.5 调整与触发条件也写死。WEB-ARCH 5.3 宣称「维度评分数据驱动，无硬编码阈值」，与实际不符（这些阈值不在知识库中，无法通过规则调整）。

涉及文件与行号：web/lib/engine.mjs:136-138（fit >= 0.6 / >= 0.35）；web/lib/engine.mjs:158-186（自评 ±0.5 规则）。

修复建议：把阈值与校准规则移入规则文件（scale/calibration 配置），引擎解释执行。

### P2-10 静态服务使用 startsWith 前缀校验，缺少路径分隔符

现象：web/server.mjs:70 用 file.startsWith(path.resolve(PUBLIC_DIR)) 判断越界。理论上前缀相同但不同目录（如 web/publicXXX）会通过校验；当前目录结构下不存在这样的兄弟目录，未发现可利用路径（实测穿越均被拦截：/../knowledge/rules.json → 403，编码变体与 web/data 路径 → 404）。

修复建议：改为 file === PUBLIC_DIR || file.startsWith(PUBLIC_DIR + path.sep)。

### P2-11 布尔值会被 Number() 转成 1 通过数字校验

现象：age/height 因为范围检查被拦，但 income_wan: true 被转成 1 万并通过校验（布尔值作为数字写入报告），无任何告警。

原始输出（bool-numbers 用例的 details 只有 age 与 height 两条）：

    {"error":"表单校验失败","details":[{"field":"age",...},{"field":"height_cm",...}]}

涉及文件与行号：web/lib/validate.mjs:15-24。

修复建议：数字字段要求 typeof raw === "number"（或严格数字字符串正则），拒绝 boolean/数组/对象。

## 5. 已经做得对的部分（v2 不要误改）

1. 零依赖与启动：只用 Node 标准库，node web/server.mjs 一条命令起服务，无 npm install、无数据库、无构建步骤；本机 Node v24.21.0 直接可用。
2. 无 Key 降级是真实可用的：photoMode=placeholder，7 个照片维度 observed 全为 null，报告 200 正常返回，速度约 5ms；配置了 Key 但没有照片时同样不阻塞（placeholder）。
3. 服务端校验扎实：空表单 422 且逐字段列出必填；age="abc" / -5 / 1e9、height=0、want_age_min > want_age_max 均 422；不是只靠前端 required。
4. 照片双轨的红线守住了：buildPhotoPrompt 明文禁止模型给绝对分数、档位结论（web/lib/provider.mjs:31），模型只输出定性 observed/level/confidence 与 anchorFits（0–1 符合度，provider.mjs:139-146 强制 clamp 到 [0,1]）；分数区间由引擎确定性映射（web/lib/engine.mjs:129-151），全仓库未发现「把模型输出直接当分」的代码路径。模型输出的 level 只用于展示（web/public/report.js:62），不参与任何计算。
5. 证据链结构正确且可渲染：collectEvidence 强制 account + aweme_id ^[0-9]{15,}$ + quote（web/lib/pipeline.mjs:42-49），报告页有独立「证据引用（可追溯）」表格，去重逻辑按 account/aweme_id/usedFor。
6. XSS / SQL 注入不构成实际漏洞：无 SQL（JSON 文件存储）；注入串会被原样存进 JSON（合理），但报告页所有插值都走 esc()（web/public/report.js:1-4、61-97），实测 HTML 页面中不出现原始 script 标签（raw_script_present=false）。
7. 静态目录穿越被拦截，运行数据不在静态目录：/../knowledge/rules.json → 403，编码变体 → 404，/data/reports.json 与 /uploads/<id>.png → 404；web/data 与 public 分离，尚未发现直接下载他人照片的静态路径。
8. 并发提交在单机规模下安全：10 个并发 POST /api/report 全部 200，10/10 可回读，reports.json 无丢失（Node 单线程 + 同步原子写）。
9. 结构化规则执行机制本身是好的：当规则是 DSL 对象时，clampScale（含 applied 记录）、giveUp、advice 都能正确命中并渲染模板，例如 R-BASE-SCORE-001 把 8 分自评压到 6.5，R-BASE-ADVICE-002 在沟通自评 2 时给出建议；每条效果都带 origin 与 evidence。
10. 报告透明性好：明确标注「演示基线（未取证）」「照片轨道未启用」「语料覆盖率」「可追溯证据 N 条」，页面区分「知识库 / 演示基线」标签。
11. 上传大小上限、content-type 白名单、空文件拒绝、照片 id 带随机串（不可简单枚举）都已实现。

## 6. 测试绿但行为不对的地方（本次重点）

1. e2e 用 photos: [{ path: file }] 手工构造（web/test/e2e.test.mjs:119），生产代码传的是 store.getPhoto 的 { file } 对象 → P0-1 完全在测试盲区里。
2. e2e 只断言 engine.photoMode === "placeholder"（无 Key 路径），从不测「配置 Key + 照片」这条主路径；provider 单测也直接用 stub 绕过读图。
3. 测试从未断言「知识库规则真的执行」：只断言 nonExecutableRules 里存在 R-SCORE-001（e2e.test.mjs:71），恰好把「159 条全部不可执行」当成预期行为放过了。
4. README 与 WEB-ARCH 承诺「模型调用失败/超时/非法 JSON 不中断流程」，但读图异常在 try/catch 之外，直接 500。
5. README 说 9 个测试，实际 11 个。

## 7. 发布前必须修的 5 件事

1. 修 P0-1：统一 store 与 provider 的照片字段（path/file），把 analyzePhotos 全流程包进 try/catch，补一条「真实 store 照片 + stub 模型」的回归测试。
2. 修 P0-2：默认强制 127.0.0.1 或引入访问鉴权；在 README 顶部写明当前版本无鉴权、含个人隐私数据、禁止对外监听；/api/reports 至少需要鉴权。
3. 打通知识库与引擎（P1-1/P1-3）：把 159 条规则、43 个维度、11 个档位转换为引擎 DSL/scoring 结构，或在载入时对「主规则 0 条可执行」直接告警并写入报告；加集成测试断言 knowledge 规则可命中。
4. 让 DSL 严格化（P1-2）：when 未知键/非法 op 必须校验失败；修正 R-BASE-MATCH-004 的 all2；补回归测试。
5. 修 P2-1：超限请求返回 413 JSON 而不是断连，前端能显示可读错误（照片魔数校验与 dataQuality 消费可紧随其后）。

## 附：复现用表单载荷（与 e2e 测试 web/test/e2e.test.mjs 的 FORM 一致）

    {"form":{
      "gender":"male","age":30,"city":"杭州","height_cm":178,"weight_kg":72,
      "education":"master","school_tier":"985","occupation":"private","income_wan":40,
      "has_house":"loan","has_car":"mid","hukou":"local","marital":"single",
      "family_origin":"urban_normal","siblings":"only",
      "personality":"warm","communication":4,"emotional_stability":4,
      "living_skills":3,"social_circle":3,"hobbies":"羽毛球",
      "want_gender":"female","want_age_min":25,"want_age_max":32,"want_height_min":160,
      "want_education_min":"bachelor","want_house":"no","want_appearance_min":6,
      "self_appearance":6,"self_rank":"top25","admiration_freq":"sometimes",
      "feedback_gap":"same","photo_quality":"raw","face_natural":"yes"
    },"photoIds":[]}

    P0-1 复现时把 photoIds 换成 POST /api/photos 返回的 id，并设置：
    AOYE_LLM_API_KEY=sk-test AOYE_LLM_BASE_URL=http://127.0.0.1:9/v1（不可达即可）

