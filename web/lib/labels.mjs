/* 用户可见文案映射：内部枚举 / 代码 → 中文人话。
   规则：报告里所有「用户可见」的枚举一律经此表输出；未映射的内部枚举值不得原样出现。
   测试 web/test/report-tokens.test.mjs 会校验本表对 form-fields.json 选项的覆盖（防漂移）：
   form-fields.json 新增选项而本表未同步时，测试会红。 */

export const FIELD_OPTION_LABELS = {
  "gender": { "male": "男", "female": "女" },
  "education": { "highschool": "高中及以下", "college": "大专", "bachelor": "本科", "master": "硕士", "phd": "博士" },
  "school_tier": { "none": "非全日制 / 未提及", "ordinary": "普通院校", "211": "211", "985": "985", "top": "清北华五" },
  "occupation": { "gov": "体制内（公务员 / 事业编）", "soe": "国企", "private": "私企 / 外企", "freelance": "自由职业", "startup": "创业 / 个体", "student": "学生", "other": "其他" },
  "has_house": { "none": "无房", "loan": "有房（有贷）", "paid": "有房（无贷）", "multi": "多套" },
  "has_car": { "none": "无车", "basic": "10 万以下", "mid": "10–30 万", "high": "30 万以上" },
  "hukou": { "local": "本地城镇户口", "urban_other": "外地城镇户口", "rural": "农村户口" },
  "marital": { "single": "未婚", "divorced": "离异无孩", "divorced_kid": "离异有孩" },
  "family_origin": { "urban_upper": "城市中产及以上", "urban_normal": "城市普通", "county": "县城", "rural": "农村" },
  "siblings": { "only": "独生", "has": "非独生" },
  "siblings_detail": { "only_child": "独生子女", "sister_only": "有姐姐（无弟弟）", "brother_only": "有哥哥（无弟弟）", "has_younger_brother": "有弟弟", "has_younger_sister": "有妹妹（无弟弟）", "mixed": "兄弟姐妹都有", "unknown": "不详 / 不愿说" },
  "family_wealth": { "a6": "A6 及以下（无房或仅自住刚需）", "a7": "A7（千万以下，高不成低不就）", "a8": "A8（净资产 1000 万+）", "a9": "A9（亿级）", "unknown": "不详" },
  "parents_pension": { "both": "双方都有退休金", "one": "一方有", "none": "都没有", "unknown": "不详" },
  "family_atmosphere": { "harmonious": "和睦、父母关系好", "ordinary": "一般", "conflict": "有明显矛盾/离异", "unknown": "不详" },
  "personality": { "outgoing": "外向健谈", "warm": "温和内敛", "slow": "慢热", "direct": "强势直率" },
  "want_gender": { "male": "男", "female": "女" },
  "want_education_min": { "highschool": "高中及以下", "college": "大专", "bachelor": "本科", "master": "硕士", "phd": "博士" },
  "want_occupation": { "any": "不限", "gov": "体制内（公务员 / 事业编）", "soe": "国企", "private": "私企 / 外企", "startup": "创业 / 个体", "freelance": "自由职业" },
  "want_house": { "yes": "必须有", "no": "不要求" },
  "self_rank": { "top10": "前 10%", "top25": "前 25%", "mid": "中间", "bottom": "中等偏下" },
  "admiration_freq": { "often": "经常", "sometimes": "偶尔", "rare": "几乎没有" },
  "feedback_gap": { "better": "明显更好", "same": "差不多", "worse": "明显更差", "none": "没有被介绍过" },
  "photo_quality": { "raw": "原相机直出", "light": "轻度美颜", "heavy": "重度精修" },
  "face_natural": { "yes": "原生未整", "minor": "做过轻医美", "no": "做过手术类项目" },
};

export const SCOPE_LABELS = { scoring: "计分", matching: "匹配", advice: "建议", demographic: "人群定位", band: "档位" };
export const VIA_LABELS = { machine: "结构化条件", when: "文本条件" };
export const PHOTO_MODE_LABELS = { none: "未启用", placeholder: "未接入模型", model: "已接入模型", error: "调用失败（已降级为纯表单）" };
export const APPEARANCE_BASIS_LABELS = { "self-report-only": "仅自评", "photo+self": "照片 + 自评", "photo-only": "仅照片", none: "无" };
/* 照片描述置信度：低 ≠ 条件差，只是「这张照片里信息不足、不据此判断」。 */
export const CONFIDENCE_LABELS = { high: "高（描述明确）", medium: "中（可参考）", low: "低（信息不足，未据此判断）" };
export const PHOTO_LEVEL_LABELS = { below: "偏下", average: "一般", above: "偏上", outstanding: "突出" };

const CJK = /[\u4e00-\u9fff]/;

export function optionLabel(field, value) {
  const table = FIELD_OPTION_LABELS[field];
  if (!table || value === null || value === undefined) return null;
  return table[String(value)] || null;
}

/* 用户可见的输入值：数字原样；枚举走中文标签；已是中文的文本（如城市名）原样；
   其余（未映射的内部代码）一律折叠为「—」，不得把内部取值直接给用户看。 */
export function displayValue(field, value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  const label = optionLabel(field, value);
  if (label) return label;
  const text = String(value);
  if (CJK.test(text)) return text;
  return "—";
}

export function scopeLabel(scope) { return SCOPE_LABELS[scope] || "其他"; }
export function viaLabel(via) { return VIA_LABELS[via] || "文本条件"; }
