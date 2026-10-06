# PHOTO-SPEC · 照片维度化分析规范（v1）

> 面向网页项目「鳌烨择偶定位系统」的双轨评分第一轨。
> 配套机器可读定义：knowledge/photo-dimensions.json（18 个维度 / 10 条拒判条件 / 8 道自评题）。
> 语料依据：当前 29.1%（439 / 1511 条）转写；来源账号 aoye98、47590488570、48854385344、33349790582、41252723284。

---

## 0. 红线（先读这一节，任何实现不得越过）

1. **禁止对种族、民族、地域出身、残障、疾病、体型进行任何评判或推测。**
2. **禁止输出绝对颜值分**，禁止人身评价（丑/难看/没救）。只输出可观察的呈现项与可改善项。
3. **禁止把「疑似医美/整容」当作事实断言或贬损**；只能写「形态与面部协调度（存疑）」并给“建议补充原生状态照片”的提示。
4. **敏感项（体重、皮肤、发量）只做中性描述 + 可改善建议**，不得羞辱。
5. **所有分数只能以区间 + 依据 + 置信度出现**，并强制注明：「区间来自规则映射，不是绝对评分」。
6. **镜头/照片相关表述**：用户可见文案一律写「照片/镜头可能低估真实呈现，建议提供自然光正脸照」，禁止出现对外貌的贬损词；原语料用词只允许出现在带「> 【博主原话】」标记的取证行里。

---

## 1. 为什么要双轨

| 轨 | 谁来产出 | 允许输出 | 禁止输出 |
|---|---|---|---|
| 轨 1 视觉描述 | 视觉模型 | 维度取值（有限枚举）、置信度、理由 | 任何分数、任何绝对判断 |
| 轨 2 规则映射 | knowledge/rules.json + 本规范的 rangeAssembly | 区间（≥0.5 宽）、依据、置信度 | 单个数字分数 |
| 轨 3 自评校准 | 用户问卷 | 自评分、位次、行为证据 | — |

分数不允许由模型“感觉”出来；只能由「维度取值 → 确定性规则 → 区间」得到，再和自评交叉校准。

---

## 2. 处理流程（工程实现）

1. **收图与质检**：按 §3 收 3-4 张照片 + 自评/资料卡。先跑 §4 的 10 条 qualityGates。
2. **维度描述**：对每张通过的图，逐维度调用 vision model，输入 = photo-dimensions.json 里该维度的 ask；输出只能是 values 里的一个值 + confidence + reason。
3. **聚合**：同一维度多张照片冲突时，取「可用度最高照片」的结果；两张都是 high 且互相矛盾 → 该维度降为无法判断。
4. **区间计算**：按 photo-dimensions.json 的 rangeAssembly 六步执行，输出 {low, high, confidence, basis[], unresolved[]}。
5. **自评校准**：按 §8 divergencePolicy 输出分歧标记与补充建议。

**严禁**：把自评直接当结果；把模型描述直接当分数；无自评时凭空给区间。

---

## 3. 输入照片要求

| 照片 | 用途 | 拍摄要求 |
|---|---|---|
| 正脸无表情照 | 三庭、五官比例、脸型、眉眼对称、皮肤 | 原相机、无滤镜、镜头与眼同高、距脸 1 米以上 |
| 45° 侧脸照 | 鼻型、侧脸轮廓、下颌线 | 自然侧光，避免顶光 |
| 半身正面照 | 头肩比、身材比例、穿搭、体态 | 含肩到胯，平视不俯拍 |
| 全身照（可选） | 身高观感、身材比例、体态 | 平视、距 2.5 米以上 |

- 同一组照片必须同期、同体型状态。
- 优先原相机直出；滤镜/美颜照只能作为降级证据。
- 戴眼镜可保留，但需补一张摘镜照用于眉眼对称判断。
- 资料卡必填：身高、体重、年龄段、性别、近期体重是否明显变化、是否做过医美/正畸（可拒答）。

---

## 4. 拒判 / 降级 / 重传条件（10 条）

| ID | 条件 | 判定特征 | 处理 |
|---|---|---|---|
| QG-01 | 重度美颜/滤镜 | 皮肤纹理消失、脸型边缘扭曲、五官比例异常、白到无层次 | **拒判**：不给区间，只列可判维度 + 要求重传原相机照 |
| QG-02 | 光源异常/顶光/逆光/过曝 | 头顶强光、阴阳脸、绿光蓝光、高光溢出或全黑 | **降级**：只保留发型/穿搭/体态；提示调光重传 |
| QG-03 | 面部遮挡（口罩/墨镜/手/刘海遮眉眼） | 眉眼、鼻、口任一区域被遮 >1/3 | **重传**：被遮维度返回「无法判断」，提示撩刘海/摘口罩 |
| QG-04 | 多人合影 | 画面内 ≥2 张可识别人脸 | **拒判**：无法确定评估对象 |
| QG-05 | 角度过大（俯仰 >30° 或侧转 >45°） | 俯拍/仰拍、只剩侧脸轮廓 | **降级**：三庭/脸型/头肩比记「无法判断」；纯侧脸只判侧脸轮廓与鼻型 |
| QG-06 | 画面过远/分辨率过低 | 人脸像素 <200×200、五官不可辨 | **重传**：只保留穿搭/体态的粗略描述 |
| QG-07 | 镜头压低观感（媒介固有偏差） | 无画面特征；镜头会放大五官细节 | **降级不拒判**：区间加宽，用户可见文案统一写「照片/镜头可能低估真实呈现，建议提供自然光正脸照」（红线见 §0） |
| QG-08 | 妆容/涂覆遮盖 | 肤色与颈部差异大、无毛孔纹理 | **降级**：皮肤类维度记「无法判断」，其余标注“妆容影响” |
| QG-09 | 表情夸张（大笑、皱眉、鬼脸） | 面部肌肉牵拉、比例无法目测 | **重传**：只保留粗略轮廓描述 |
| QG-10 | 疑似非本人/替照 | 无法技术判定 | **风险标记**：转人工抽检，不下结论 |

对应语料（节选）：
- 「这个美颜把人会感觉弄得会畸形。」— aoye98 / 7640420044572282158
- 「你把头顶的光关了，然后的话把美颜调对，5.2、5.3有了。」— aoye98 / 7641867771478822185
> 【博主原话】「上镜丑三分啊，还是稍微善良一点啊。全地球人只要开摄像头就会变丑，是个地球人就会啊。」（aoye98 / 7636296553589706030）
- 「某一个角度看是好看的。」— aoye98 / 7635582435148696859

---

## 5. 维度清单（18 条）

| # | id | 名称 | 主要照片 | 枚举数 | 可判定性 | weight |
|---|---|---|---|---|---|---|
| 1 | face.three_courts | 三庭比例 | 正脸 | 6 | high | null |
| 2 | face.features_balance | 眉眼唇 / 五官比例与量感 | 正脸 | 5 | medium | null |
| 3 | face.dental_arch | 牙弓 / 牙列（可见部分） | 露齿照 | 4 | low | null |
| 4 | face.head_shoulder_ratio | 头肩比 | 半身 | 4 | medium | null |
| 5 | face.facial_fold | 面部折叠度 | 45°+侧光 | 4 | medium | null |
| 6 | face.craniofacial_ratio | 颅面比例 | 正脸含颅顶 | 4 | medium | null |
| 7 | face.face_size | 脸型 / 脸面大小 | 正脸 | 4 | medium | null |
| 8 | face.nose | 鼻型 / 山根 | 45°+正脸 | 5 | medium | null |
| 9 | face.profile | 侧脸轮廓 / 下颌线 | 45°/90° | 4 | high | null |
| 10 | face.eye_brow_symmetry | 眉眼对称度 | 正脸 | 4 | high | null |
| 11 | face.skin | 皮肤状态 | 正脸 | 4 | high | null |
| 12 | body.height | 身高（自评优先） | 全身（参考） | 6 | low | null |
| 13 | body.weight | 体重 / 胖瘦观感 | 半身+全身 | 5 | medium | null |
| 14 | body.figure | 身材比例 | 半身+全身 | 4 | medium | 0.10 |
| 15 | style.grooming | 穿搭 | 半身 | 4 | medium | 0.10 |
| 16 | style.hair | 发型 | 正脸 | 4 | high | null |
| 17 | style.makeup | 妆容 | 正脸 | 4 | high | null |
| 18 | presence.posture | 体态 / 气质 / 精神状态 | 半身/全身 | 4 | medium | 0.40（女） |

共同约束：
- 每个维度的 values 是**有限枚举**，必带「无法判断」；模型不得自由发挥。
- **语料没给出增减分值的取值，deltaToAppearance = null**（本规范里绝大多数是 null），不得拍脑袋补数。
- 目前唯一有数值依据的加分：体态/状态鲜活 +0.3~+0.4（单例，低置信）；男性身高 <175cm 的封顶：语料可靠表述只有「1 米 75 不给 6 分以上」，硬判定按 0.5 步长取上界 5.5（S-LOOKS-006）。原稿的 5.7 经回听判定不可靠（两次重转写分别得到「5,5,5,5,5.7」与「5.6 / 5.7」），已从硬判定中剔除。

---

## 6. 权重模型

- **女性（语料原话）**：「40% 靠的是自信和体态，20% 靠的是身材比例和穿衣的搭配，15% 是来自于我们的发型还有妆容，剩下的才轮得到自己的五官。」— 48854385344 / 7682010628554231090
  - 体态/自信/精神面貌 = 0.40（对应 presence.posture）
  - 身材比例 + 穿衣搭配 = 0.20（本规范拆成 body.figure 0.10 + style.grooming 0.10，属实现拆分，非语料数字）
  - 发型 + 妆容 = 0.15（style.hair / style.makeup 目前 weight=null，共享该桶）
  - 五官合计 = 0.25（9 个面部维度内部分配无语料，全部 null）
- **男性**：语料只有 checklist 门槛、没有权重分解（五官无硬伤、会穿搭、身材好、皮肤好、光脚 1 米 80），男性各维度 weight 一律 null。

---

## 7. 自评校准题（8 道）

1. **自评颜值分**（1-9 分，0.5 一档）— 区间起点
2. **同龄同性位次**（100 人）：前 3 / 前 10 / 前 20 / 前 40 / 中段 40-60 / 后 40
3. **过去一年被陌生人或异性主动搭讪/示好次数**：0 / 1-2 / 3-5 / 5 次以上
4. **别人主动夸你外形好看的频率**：经常 / 偶尔 / 很少 / 基本没有（只被建议收拾一下）
5. **朋友或同事是否主动给你推荐过异性资源**：有多次 / 有过 1-2 次 / 没有
6. **平时拍照常态**：原相机无滤镜 / 会用滤镜美颜 / 很少拍照
7. **身高体重**（最近一次测量）— 用于男性身高封顶
8. **最想改善的一项**：穿搭 / 发型 / 皮肤 / 体态 / 体重 / 五官 / 没有

行为题的依据：
- 「就通过着装打扮，已经开始，朋友会给你推荐异性资源了。三四分没有人会给你推荐异性资源。」— aoye98 / 7635582435148696859
- 「女生我觉得 4.5 以上干净一点就能收到搭讪（原文：按理按时）。男生起码得高 0.8 分。」— aoye98 / 7641867771478822185
- 「除去亲朋好友滤镜之外，我们在陌生人的眼里呢，到底是怎样的一个形象，怎样的一个评分。」— 47590488570 / 7659752112050837425

---

## 8. 自评与 AI 描述分歧时的输出规则

| ID | 条件 | 输出动作 |
|---|---|---|
| DV-1 | 自评分 > 区间上界 + 1.0 | 标记「自评偏高」，提示可能与滤镜/镜头或参照系偏差有关；区间不变；建议补原相机照片 |
| DV-2 | 自评分 < 区间下界 − 1.0 | 标记「自评偏低」，提示可能受素颜/灯光/状态影响；区间不变；建议正常光线下补拍 |
| DV-3 | 自评分与区间中值相差 ≤1.0 | 视为一致：区间收窄为 自评分 ± 0.25（最小 0.5 宽），置信度升一档 |
| DV-4 | 自评位次与被搭讪频率/被推荐资源矛盾 | **以行为证据为准**；提示自评参照系可能偏差 |
| DV-5 | photoQuality = reject | 不输出区间；只输出可判断维度 + 重传指引；自评分原样展示 |
| DV-6 | 自评 > 身高封顶 | 明确告知「因身高封顶，该自评分不成立」（语料：1 米 75 申报 6 分被否） |

---

## 9. 输出契约

```json
{
  "caseId": "string",
  "photoQuality": {
    "status": "pass | downgrade | reject",
    "photos": [{ "type": "front_neutral", "usable": true, "issues": ["QG-02"] }],
    "notes": ["命中 QG-02：顶光，皮肤与折叠度降级"]
  },
  "dimensions": [
    { "id": "face.three_courts", "value": "三段均衡", "confidence": "high", "reason": "...", "deltaToAppearance": 0 }
  ],
  "unresolved": ["face.dental_arch"],
  "strengths": ["..."],
  "watchItems": ["..."],
  "improvementPriorities": [{ "item": "发型", "reason": "...", "from": "R-LOOKS-023" }],
  "appearanceRange": {
    "low": 5.0, "high": 5.5, "confidence": "medium",
    "basis": ["自评 5.5", "身高封顶未触发", "QG-07 镜头低估已加宽"],
    "disclaimer": "区间来自规则映射，不是绝对评分。"
  },
  "selfCheck": { "selfScore": 5.5, "divergence": "consistent | self_overestimate | self_underestimate | blocked", "note": "..." }
}
```

**硬约束**：appearanceRange 必须是区间；low < high；宽度 ≥0.5；confidence 只能是 high/medium/low；basis 至少 1 条；appearanceRange 允许为 null（拒判时）。


---

## 10. 完整输入输出示例

### 示例 A：女性，三张合规照片（pass，区间收窄）

**输入**：女，28 岁；正脸无表情（原相机/室内自然光）、右侧 45°、半身站姿；自报 166cm / 52kg；自评 5.5；朋友多次推荐过异性资源；年搭讪 3-5 次。全部 18 维可判。

**输出**：
```json
{
  "caseId": "demo-A",
  "photoQuality": { "status": "pass", "photos": [ { "type": "front_neutral", "usable": true, "issues": [] }, { "type": "side_45", "usable": true, "issues": [] }, { "type": "half_body", "usable": true, "issues": [] } ], "notes": [] },
  "dimensions": [
    { "id": "face.three_courts", "value": "三段均衡", "confidence": "high", "reason": "三段目测接近相等", "deltaToAppearance": 0 },
    { "id": "face.features_balance", "value": "眉眼唇组合协调", "confidence": "medium", "reason": "间距与大小关系平衡", "deltaToAppearance": 0 },
    { "id": "face.dental_arch", "value": "无法判断", "confidence": "high", "reason": "无露齿照", "deltaToAppearance": null },
    { "id": "face.head_shoulder_ratio", "value": "头肩比例协调", "confidence": "high", "reason": "肩宽约为头宽 1.8-2 倍", "deltaToAppearance": 0 },
    { "id": "face.facial_fold", "value": "折叠度中等", "confidence": "medium", "reason": "侧向起伏清晰但不夸张", "deltaToAppearance": 0 },
    { "id": "face.craniofacial_ratio", "value": "颅面比例适中", "confidence": "medium", "reason": "颅顶与面部比例平衡", "deltaToAppearance": 0 },
    { "id": "face.face_size", "value": "脸型中等", "confidence": "medium", "reason": "相对肩宽视觉适中", "deltaToAppearance": 0 },
    { "id": "face.nose", "value": "山根中等、形态自然", "confidence": "high", "reason": "鼻背线条平顺、与面部协调", "deltaToAppearance": 0 },
    { "id": "face.profile", "value": "下颌线清晰、侧脸线条利落", "confidence": "high", "reason": "下颌缘与颈部界线清楚", "deltaToAppearance": null },
    { "id": "face.eye_brow_symmetry", "value": "双眼与眉毛对称", "confidence": "high", "reason": "水平与大小一致", "deltaToAppearance": 0 },
    { "id": "face.skin", "value": "皮肤细腻有光泽", "confidence": "high", "reason": "纹理细、肤色均匀", "deltaToAppearance": 0 },
    { "id": "body.height", "value": "同龄均值", "confidence": "medium", "reason": "自报 166cm", "deltaToAppearance": null },
    { "id": "body.weight", "value": "匀称", "confidence": "high", "reason": "腰线与整体比例协调", "deltaToAppearance": 0 },
    { "id": "body.figure", "value": "比例协调", "confidence": "medium", "reason": "肩腰比自然", "deltaToAppearance": 0 },
    { "id": "style.grooming", "value": "穿搭得体在线", "confidence": "high", "reason": "颜色协调、版型合身", "deltaToAppearance": 0 },
    { "id": "style.hair", "value": "发型适配脸型", "confidence": "high", "reason": "有层次、未遮挡眉眼", "deltaToAppearance": null },
    { "id": "style.makeup", "value": "淡妆", "confidence": "high", "reason": "有修饰但五官结构可辨", "deltaToAppearance": 0 },
    { "id": "presence.posture", "value": "体态挺拔、状态鲜活", "confidence": "medium", "reason": "肩背打开、面部有生气", "deltaToAppearance": [0.3, 0.4] }
  ],
  "unresolved": ["face.dental_arch"],
  "strengths": ["三庭与头肩比均衡", "下颌线清晰", "皮肤状态好", "体态挺拔有活力"],
  "watchItems": ["牙列未露齿，无法确认", "妆容程度会影响皮肤判断"],
  "improvementPriorities": [],
  "appearanceRange": { "low": 5.5, "high": 6.0, "confidence": "medium", "basis": ["自评 5.5", "DV-3 一致（差值 ≤1.0）", "5.5 档 checklist 全满足（五官无硬伤/会穿搭/身材好/皮肤好）", "体态鲜活 +0.3~0.4（低置信，单例）"], "disclaimer": "区间来自规则映射，不是绝对评分。" },
  "selfCheck": { "selfScore": 5.5, "divergence": "consistent", "note": "行为证据（朋友多次推荐资源）与自评一致。" }
}
```

### 示例 B：男性，重度美颜自拍（downgrade + 身高封顶）

**输入**：男，30 岁；仅 1 张美颜自拍（磨皮、瘦脸、顶光）；自评 6 分；自报身高 175cm、体重 72kg。

**输出**：
```json
{
  "caseId": "demo-B",
  "photoQuality": { "status": "downgrade", "photos": [ { "type": "selfie_filtered", "usable": false, "issues": ["QG-01", "QG-02", "QG-08"] } ], "notes": ["命中 QG-01：重度美颜；命中 QG-02：顶光；皮肤/折叠度/脸型不可判", "命中 QG-07：镜头可能低估"] },
  "dimensions": [
    { "id": "face.three_courts", "value": "无法判断", "confidence": "high", "reason": "瘦脸滤镜改变比例", "deltaToAppearance": null },
    { "id": "face.features_balance", "value": "眉眼唇组合协调", "confidence": "low", "reason": "滤镜下仍可见眉唇间距协调", "deltaToAppearance": 0 },
    { "id": "face.dental_arch", "value": "无法判断", "confidence": "high", "reason": "无露齿照", "deltaToAppearance": null },
    { "id": "face.head_shoulder_ratio", "value": "无法判断", "confidence": "high", "reason": "非半身照", "deltaToAppearance": null },
    { "id": "face.facial_fold", "value": "无法判断", "confidence": "high", "reason": "磨皮破坏光影层次", "deltaToAppearance": null },
    { "id": "face.craniofacial_ratio", "value": "颅面比例适中", "confidence": "low", "reason": "颅顶高度可见", "deltaToAppearance": 0 },
    { "id": "face.face_size", "value": "无法判断", "confidence": "high", "reason": "瘦脸滤镜不可信", "deltaToAppearance": null },
    { "id": "face.nose", "value": "山根中等、形态自然", "confidence": "low", "reason": "正面鼻部线条可见", "deltaToAppearance": 0 },
    { "id": "face.profile", "value": "无法判断", "confidence": "high", "reason": "无侧脸照", "deltaToAppearance": null },
    { "id": "face.eye_brow_symmetry", "value": "双眼与眉毛对称", "confidence": "medium", "reason": "眼型对称，滤镜影响有限", "deltaToAppearance": 0 },
    { "id": "face.skin", "value": "无法判断", "confidence": "high", "reason": "磨皮无纹理", "deltaToAppearance": null },
    { "id": "body.height", "value": "未提供", "confidence": "medium", "reason": "资料卡自报 175cm（低于 180 门槛）", "deltaToAppearance": null },
    { "id": "body.weight", "value": "无法判断", "confidence": "high", "reason": "仅头部照", "deltaToAppearance": null },
    { "id": "body.figure", "value": "无法判断", "confidence": "high", "reason": "仅头部照", "deltaToAppearance": null },
    { "id": "style.grooming", "value": "无法判断", "confidence": "high", "reason": "仅头部照", "deltaToAppearance": null },
    { "id": "style.hair", "value": "发型普通但不影响", "confidence": "medium", "reason": "短发、未遮挡眉眼", "deltaToAppearance": 0 },
    { "id": "style.makeup", "value": "无法判断", "confidence": "high", "reason": "滤镜叠加", "deltaToAppearance": null },
    { "id": "presence.posture", "value": "无法判断", "confidence": "high", "reason": "无站姿照", "deltaToAppearance": null }
  ],
  "unresolved": ["face.three_courts", "face.face_size", "face.facial_fold", "face.skin", "body.weight", "body.figure", "style.grooming", "presence.posture", "face.profile"],
  "strengths": ["眉眼对称", "面部中性描述无明显硬伤（低置信）"],
  "watchItems": ["美颜与顶光导致 9 项无法判断", "身高 175cm 触发男性封顶（上界 5.5）"],
  "improvementPriorities": [ { "item": "重传原相机照片（正脸 + 侧脸 + 半身）", "reason": "当前证据不足以给出可靠区间", "from": "QG-01/QG-02" } ],
  "appearanceRange": { "low": 5.2, "high": 5.5, "confidence": "low", "basis": ["DV-6：身高 175cm → 封顶 5.5（6 分以下；语料可靠结论仅为不给 6 分以上）", "QG-01 拒判面部结构维度", "QG-02/08 下界 -0.3（工程默认，无语料依据）"], "disclaimer": "区间来自规则映射，不是绝对评分。" },
  "selfCheck": { "selfScore": 6.0, "divergence": "self_overestimate", "note": "自评 6 分被身高封顶否定（语料：1 米 75 不给 6 分以上）；且照片不可判维度过多，建议重传后再评估。" }
}
```

### 示例 C：女性，单张逆光且刘海遮眉（reject，不给区间）

**输入**：女，25 岁；唯一一张照片：逆光过曝 + 刘海遮眉 + 远景；自评 4 分。

**输出**：
```json
{
  "caseId": "demo-C",
  "photoQuality": { "status": "reject", "photos": [ { "type": "backlit_unknown", "usable": false, "issues": ["QG-02", "QG-03", "QG-06"] } ], "notes": ["逆光过曝 + 刘海遮挡眉眼 + 人脸占比过小", "面部结构维度全部不可判，不输出区间"] },
  "dimensions": [
    { "id": "face.three_courts", "value": "无法判断", "confidence": "high", "reason": "刘海遮挡上庭且过曝", "deltaToAppearance": null },
    { "id": "face.features_balance", "value": "无法判断", "confidence": "high", "reason": "眉眼被遮挡", "deltaToAppearance": null },
    { "id": "face.dental_arch", "value": "无法判断", "confidence": "high", "reason": "无露齿照", "deltaToAppearance": null },
    { "id": "face.head_shoulder_ratio", "value": "无法判断", "confidence": "high", "reason": "远景且非半身", "deltaToAppearance": null },
    { "id": "face.facial_fold", "value": "无法判断", "confidence": "high", "reason": "逆光无起伏信息", "deltaToAppearance": null },
    { "id": "face.craniofacial_ratio", "value": "无法判断", "confidence": "high", "reason": "过曝", "deltaToAppearance": null },
    { "id": "face.face_size", "value": "无法判断", "confidence": "high", "reason": "远景", "deltaToAppearance": null },
    { "id": "face.nose", "value": "无法判断", "confidence": "high", "reason": "过曝", "deltaToAppearance": null },
    { "id": "face.profile", "value": "无法判断", "confidence": "high", "reason": "非侧脸照", "deltaToAppearance": null },
    { "id": "face.eye_brow_symmetry", "value": "无法判断", "confidence": "high", "reason": "刘海遮挡", "deltaToAppearance": null },
    { "id": "face.skin", "value": "无法判断", "confidence": "high", "reason": "过曝", "deltaToAppearance": null },
    { "id": "body.height", "value": "未提供", "confidence": "high", "reason": "无资料卡数据", "deltaToAppearance": null },
    { "id": "body.weight", "value": "无法判断", "confidence": "high", "reason": "远景", "deltaToAppearance": null },
    { "id": "body.figure", "value": "无法判断", "confidence": "high", "reason": "远景、逆光", "deltaToAppearance": null },
    { "id": "style.grooming", "value": "整洁普通", "confidence": "low", "reason": "衣着轮廓干净", "deltaToAppearance": null },
    { "id": "style.hair", "value": "发型不适配（遮挡眉眼或显头大）", "confidence": "medium", "reason": "厚刘海遮住眉眼", "deltaToAppearance": null },
    { "id": "style.makeup", "value": "无法判断", "confidence": "high", "reason": "逆光", "deltaToAppearance": null },
    { "id": "presence.posture", "value": "无法判断", "confidence": "high", "reason": "远景", "deltaToAppearance": null }
  ],
  "unresolved": ["全部面部与体型维度"],
  "strengths": [],
  "watchItems": ["照片不满足最低分析条件"],
  "improvementPriorities": [ { "item": "重传：正脸无表情（原相机、顺光）+ 45° 侧脸 + 半身照", "reason": "当前照片无法支撑任何结论", "from": "QG-02/QG-03/QG-06" } ],
  "appearanceRange": null,
  "selfCheck": { "selfScore": 4.0, "divergence": "blocked", "note": "拒判：不输出区间，自评分仅原样展示。" }
}
```

---

## 11. 与 rules.json 的对接

- 本规范只负责「维度取值 → delta / cap / gate」与区间算法；**具体规则 ID 仍以 knowledge/rules.part.01.json 的 R-LOOKS-0xx 为准**（如 R-LOOKS-005 = 5.5 档 checklist、R-LOOKS-012 = 男性身高硬上限、R-LOOKS-019 = 镜头/灯光/美颜影响、R-LOOKS-022 = 可改善项）。
- 维度 id 与 rules.part.01.json 的 dimensions 对齐（face.three_courts 等）；本规范新增 face.profile / face.eye_brow_symmetry / body.figure / style.* / presence.posture 等细分，后续合并时以本文件为准。
- 本文件引用的 46 条唯一证据，全部已用 check_rules.mjs 的引文溯源机制校验通过。

---

## 12. 未解问题（同步 OPEN-QUESTIONS.md）

1. 9 个面部维度如何分配女性 25% 的五官权重 —— 语料无细分，当前全部 null。
2. 男性权重模型 —— 语料只有 checklist 门槛。
3. 镜头低估的幅度：V3 语料有博主自述口径——aoye28「给所有开摄像头的人加 0.5」、aoye98 单例调整后回弹约 0.2，量级 **0.2-0.5**（两个账号，均属自述/单例，soft）。实现上仍按“加宽区间 + 注明低估”处理，区间加宽的 ±0.3 是**工程默认值**，不得对外当测量值。
4. 体重对分数的量化影响 —— 语料只有「别胖就行」。
5. 男性身高 <170cm 的封顶值 —— 无语料。
6. 多人合影、非本人照片等拒判条件属工程约束，无语料对应。
7. 男性身高封顶的精确上界待定：回听显示 1 米 75 男性实际得分在 5.5-5.7 之间波动，当前硬判定保守取 5.5；knowledge/photo-dimensions.json（本轮不在改动范围）仍写着 5.7，需与 rules.part.01.json 同步。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-10-05 | 首版：18 维度 / 10 拒判条件 / 8 自评题 / 3 完整示例；基于 29.1% 语料，全部证据可溯源 |

