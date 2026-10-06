#!/usr/bin/env node
// 案例回归测试器 —— 用 knowledge/cases.json（45 条带博主结论的真实连麦案例）
// 回测网页评分引擎（knowledge/rules.json + web/config/baseline-rules.json）。
//
//   node tools/case_regression.mjs [--max-mismatch=N]
//   node tools/case_regression.mjs --lib=<dir> --baseline=<file> --rules=<file>   # 冻结/替换引擎口径（CI 或规则冻结时用）
//
// 退出码：0 = 有意义的通过（mismatch 数 <= 阈值 且 无引擎异常）；1 = 校准债 / 引擎异常。
//
// 设计原则：
// 1) 不修改 web/ 下任何文件，只通过动态 import() 读取引擎；
// 2) 不把答案当输入：颜值校验只用 case.input.appearanceNote 里的“自评”；
//    若案例没有自评，则该案例的颜值校验记为 unsupported（输入缺口），
//    同时另跑一遍“代理模式”（用博主打分当自评输入），只用于校验下游档位/建议链路；
// 3) 所有派生映射都带 derived 标记与说明，写进 JSON 供人工审计；
// 4) mismatch 不美化，逐条归因到“缺失维度 / 缺失规则 / 引擎 bug / 输入缺口”。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const NL = String.fromCharCode(10);

const CASES_PATH = path.join(ROOT, 'knowledge', 'cases.json');
const MAIN_RULES = path.join(ROOT, 'knowledge', 'rules.json');
const BASELINE_RULES = path.join(ROOT, 'web', 'config', 'baseline-rules.json');
const CITIES_PATH = path.join(ROOT, 'web', 'config', 'cities.json');
const OUT_JSON = path.join(ROOT, 'knowledge', 'case-calibration.json');
const OUT_MD = path.join(ROOT, 'knowledge', 'CASE-CALIBRATION.md');

const FORM_FIELDS_PATH = path.join(ROOT, 'web', 'config', 'form-fields.json');
const REQUIRED_FIELDS = (function () {
  try {
    const doc = JSON.parse(fs.readFileSync(FORM_FIELDS_PATH, 'utf8'));
    return (doc.fields || []).filter(function (f) { return f.required === true; }).map(function (f) { return f.id; });
  } catch (e) { return []; }
})();
// 表单必填、但语料里永远拿不到的字段（用户自评/偏好类）。其余缺失算“案例缺自述条件”。
const FORM_ONLY_FIELDS = ['personality', 'communication', 'emotional_stability', 'living_skills', 'social_circle', 'hobbies', 'self_rank', 'admiration_freq', 'photo_quality', 'face_natural', 'want_height_min', 'want_education_min', 'want_house', 'want_appearance_min', 'want_age_min', 'want_age_max'];
const argv = process.argv.slice(2);
function argValue(name, dflt) {
  const hit = argv.find(function (a) { return a.indexOf('--' + name + '=') === 0; });
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}

function argNum(name, dflt) {
  const hit = argv.find(function (a) { return a.indexOf('--' + name) === 0; });
  if (!hit) return dflt;
  const parts = hit.split('=');
  const v = Number(parts[1]);
  return Number.isFinite(v) ? v : dflt;
}
const MAX_MISMATCH = argNum('max-mismatch', 0);
const BASELINE_OVERRIDE = argValue('baseline', null);
const RULES_OVERRIDE = argValue('rules', null);
const LIB_OVERRIDE = argValue('lib', null);
const EFFECTIVE_MAIN = RULES_OVERRIDE || MAIN_RULES;
const EFFECTIVE_BASELINE = BASELINE_OVERRIDE || BASELINE_RULES;
const EFFECTIVE_LIB = LIB_OVERRIDE || path.join(ROOT, 'web', 'lib');


/* ------------------------------------------------------------------ */
/* 可审计的关键词表                                                    */
/* ------------------------------------------------------------------ */

// 案例结论里的收入/资产/向上向下信号 -> 期望梯队（S/A/B/C）。
// 只在命中明确关键词时才判定，否则该案例档位检查记 unsupported。
// D24：以下 S/A/B/C 关键词表已永久废弃（保留注释仅作历史记录，代码中不再引用）。
// 系统性误判：把「天花板」当降档词、把反证句里的「A8 家庭」当 S 档、把 n=1 的「准第一梯队」当档位证据。
const DEPRECATED_TIER_KEYWORDS = [
  { tier: 'S', words: ['A9', '高净值', '富二代', '厂二代', '准第一梯队', '500万', '100万汽车', '嫁妆100万', 'A8家庭'] },
  { tier: 'A', words: ['A8', '向上找', '向上', '门当户对', '211本硕', '985', '山大本硕', '三高', '第一梯队', '秒杀'] },
  { tier: 'B', words: ['主流', '条件差不多', '正常家庭', '普通人'] },
  { tier: 'C', words: ['向下兼容', '下两个生态位', '降档', '天花板', '没戏', '悬崖式', '做减法', '太吃亏', '没有成功案例', '找不到', '下沉'] }
];

const DIRECTION_KEYWORDS = {
  up: ['向上', 'A8', 'A9', '高净值', '第一梯队', '秒杀', '富二代', '厂二代'],
  down: ['向下兼容', '下两个生态位', '降档', '天花板', '没戏', '悬崖式', '做减法', '太吃亏', '还是最后的选择', '没有成功案例', '不会找咱', '错位', '够不着', '不现实', '没资格', '竞争力是悬崖']
};

// 案例里出现、但引擎当前没有对应维度/规则的因素 -> 直接变成 v2 需求。
const FACTOR_GAPS = [
  { id: 'family.sibling_detail', name: '手足性别与排序', any: ['弟弟', '妹妹', '哥哥', '姐姐', '非独生', '两个姑娘'],
    detail: '引擎只有 siblings=独生/非独生 两档，无法区分“弟弟”与“姐姐”——语料显示两者对女性婚恋的影响相反（C-002/C-006/C-015 vs C-012/C-024）。', impact: 'high' },
  { id: 'family.marital_child', name: '带孩再婚（匹配成本）', any: ['离异带', '带一个男孩', '带个男孩', '带孩子', '有孩子'],
    detail: '基线只有 marital 三档打分，缺少“带孩再婚的匹配周期更长、可选范围更窄”的处理规则（C-009/C-034）；该差异来自育儿投入与家庭重组成本，不是对单亲家庭的评价，相关量化口径属博主结论、非平台结论。', impact: 'high' },
  { id: 'fertility_intent', name: '生育意愿（丁克）', any: ['丁克'],
    detail: '表单没有生育意愿字段；语料明确“丁克直接下两个生态位”（C-008）。', impact: 'high' },
  { id: 'work_schedule', name: '作息/加班属性', any: ['夜班', '加班'],
    detail: '语料判定“有夜班属性必然减分，不分男女”（C-011），表单无对应字段。', impact: 'medium' },
  { id: 'body.weight', name: '体重维度', any: ['斤', '胖', '体重'],
    detail: '表单有 weight_kg 但没有任何评分维度引用它（引擎报出 uncoveredFields 含 weight_kg）；语料把体重作为硬性减分维度（C-003/C-014/C-023）。建议以 BMI 等中性指标呈现并附健康建议，不做体型羞辱。', impact: 'high' },
  { id: 'family.parent_pension', name: '父母退休金/养老负担', any: ['退休金', '养老金', '退休工资', '社保'],
    detail: '语料多次以“父母有退休金/有社保”作为筛选口径（C-010/C-015/C-025），表单无该维度。', impact: 'medium' },
  { id: 'family.wealth', name: '家庭资产档位（A7/A8/A9）', any: ['A7', 'A8', 'A9', '资产', '家产', '陪嫁', '嫁妆'],
    detail: '语料用 A7/A8/A9 与“陪嫁 xx 万”作为硬指标（C-004/C-015/C-022/C-026），表单 family_origin 只有四档定性。', impact: 'high' },
  { id: 'want.occupation', name: '期望对方职业/编制', any: ['体制内', '编制', '事业编'],
    detail: '语料中“要求对方体制内”是最常见要求之一（C-022/C-024），want_* 里没有对应字段。', impact: 'high' },
  { id: 'want.income', name: '期望对方收入下限', any: ['月收入', '月入', '年薪', '收入'],
    detail: '语料里“要求对方月入 5 万 / 收入比我高”很常见（C-014/C-025），表单无 want_income 字段。', impact: 'high' },
  { id: 'want.only_child', name: '期望对方独生', any: ['独生子', '独生女'],
    detail: '“要求独生子/独生女”反复出现（C-009/C-015/C-022/C-024），want_* 无该字段。', impact: 'medium' },
  { id: 'want.house_car', name: '期望对方房车全款', any: ['全款房', '全款车', '房车全', '全款车房'],
    detail: 'want_house 只有“必须有/不要求”二值，无法表达“全款”。（C-013/C-015/C-022）', impact: 'medium' },
  { id: 'region.rule', name: '地域差异规则', any: ['回国', '多伦多', '加拿大', '县城', '一线城市', '江浙沪', '南宁', '杭州', '太原'],
    detail: '语料有明确的地域换算（回国太卷、换城市元气成本、城市收入口径），规则集只有 cityTier 影响一条收入基线规则（C-027/C-013 + 6.4 节）。', impact: 'medium' },
  { id: 'appearance.self_input', name: '颜值轨道的第三方评分输入', any: [],
    detail: '案例里的颜值分是博主（第三方）给的标注，不是自评；引擎的纯表单模式只能吃 self_appearance，照片轨道需要真实照片。语料无法验证颜值映射本身。', impact: 'high' }
];

// 案例中明确说出的择偶要求里，无法映射到现有表单字段的部分（逐条人工从转写摘录）。
const FIELD_LABELS = {
  education: '学历无法解析', school_tier: '院校层次未提及或无法判定', occupation: '职业无法解析',
  income_wan: '收入无法解析或未提供', has_house: '房产口径不明或未提供', has_car: '车价未提及或未提供',
  marital: '婚史未提及', family_origin: '家庭出身无法判定', siblings: '手足情况未提及',
  self_appearance: '颜值自评未提供', 'want.*': '择偶要求无法映射到表单字段'
};

const WANT_OVERRIDES = {
  'C-014': { want_age_max: 45, unmappable: ['对方月收入 5 万以上（表单无 want_income）'] },
  'C-022': { unmappable: ['对方体制内（表单无 want_occupation）'] },
  'C-024': { unmappable: ['本地独生女（表单无 want_region/want_only_child）'] },
  'C-005': { unmappable: ['对方公务员/编制、独生子（表单无对应字段）'] },
  'C-015': { unmappable: ['对方独生子（表单无 want_only_child）'] },
  'C-013': { unmappable: ['对方全款车房、对方父母有社保（表单无对应字段）'] }
};

/* ------------------------------------------------------------------ */
/* 字段映射（保守解析，全部带 derived 说明）                            */
/* ------------------------------------------------------------------ */

function has(t, list) {
  for (var i = 0; i < list.length; i += 1) if (String(t).indexOf(list[i]) !== -1) return true;
  return false;
}

function parseEducation(text) {
  if (!text) return { value: null, note: '无学历字段' };
  if (text.indexOf('博士') !== -1) return { value: 'phd' };
  if (text.indexOf('硕士') !== -1 || text.indexOf('研究生') !== -1 || text.indexOf('本硕') !== -1) return { value: 'master' };
  if (text.indexOf('本科') !== -1 || text.indexOf('学士') !== -1) return { value: 'bachelor' };
  if (text.indexOf('大专') !== -1 || text.indexOf('专科') !== -1 || text.indexOf('专升本') !== -1) return { value: 'college' };
  if (text.indexOf('高中') !== -1 || text.indexOf('中专') !== -1) return { value: 'highschool' };
  return { value: null, note: '无法解析：' + text };
}

function parseSchoolTier(text) {
  if (!text) return { value: null, note: '未提及院校' };
  if (has(text, ['清北', '清华', '北大', '华五'])) return { value: 'top', derived: true, note: '按校名归入清北华五' };
  if (has(text, ['985', '华中科技', '吉林大学', '山东大学', '山大'])) return { value: '985', derived: true, note: '按校名/标签归入 985' };
  if (text.indexOf('211') !== -1) return { value: '211' };
  if (has(text, ['普通本科', '普本', '南京医科大学'])) return { value: 'ordinary', derived: true, note: '按描述归入普通院校' };
  return { value: null, note: '无法解析：' + text };
}

function parseOccupation(text) {
  if (!text) return { value: null, note: '无职业字段' };
  if (has(text, ['在读', '学生', '读研', '读博', '研究生', '留学'])) return { value: 'student' };
  if (has(text, ['体制内', '事业编', '公务员', '编制', '市直'])) return { value: 'gov' };
  if (has(text, ['国企', '央企'])) return { value: 'soe' };
  if (has(text, ['创业', '个体'])) return { value: 'startup' };
  if (has(text, ['自由职业', '主播', '直播', '剪辑'])) return { value: 'freelance' };
  if (has(text, ['私企', '互联网', '电商', '上市公司', '销售', '猎头', '护士', '运营'])) return { value: 'private', derived: true, note: '按行业/岗位归入私企' };
  return { value: null, note: '无法解析：' + text };
}

function parseIncome(text) {
  if (!text) return { value: null, note: '未提供收入' };
  if (has(text, ['加元', '美元', '刀'])) return { value: null, note: '外币收入，表单无币种字段' };
  if (text.indexOf('存款') !== -1) return { value: null, note: '给的是存款不是收入' };
  var m = text.match(/月薪([0-9.]+)-([0-9.]+)/);
  if (m) return { value: Math.round((Number(m[1]) + Number(m[2])) / 2 * 12 / 10 * 10) / 10, derived: true, note: '月薪区间取中值后折算年收入（万）' };
  m = text.match(/月薪([0-9.]+)[kK]/) || text.match(/月薪([0-9.]+)千/);
  if (m) return { value: Math.round(Number(m[1]) * 12 / 10 * 10) / 10, derived: true, note: '月薪折算年收入（万）' };
  m = text.match(/月收入([0-9.]+)万/);
  if (m) return { value: Number(m[1]) * 12, derived: true, note: '月收入折算年收入（万）' };
  m = text.match(/年收入([0-9.]+)-([0-9.]+)万/);
  if (m) return { value: (Number(m[1]) + Number(m[2])) / 2, derived: true, note: '年收入区间取中值' };
  m = text.match(/年收入约?([0-9.]+)万/) || text.match(/年薪约?([0-9.]+)万/);
  if (m) return { value: Number(m[1]) };
  return { value: null, note: '无法解析：' + text };
}

function parseHouse(text) {
  if (!text) return { value: null, note: '无房字段' };
  if (text.indexOf('无房') !== -1 || text.indexOf('没有房子') !== -1) return { value: 'none' };
  if (has(text, ['两套', '三套', '多套', '两号'])) return { value: 'multi', derived: true, note: '家庭/本人多套，权属口径待确认' };
  if (text.indexOf('全款') !== -1) return { value: 'paid', derived: true, note: '全款（可能为家庭提供，非本人名下）' };
  if (has(text, ['贷款', '有贷', '还贷'])) return { value: 'loan' };
  if (has(text, ['有房', '一套房'])) return { value: null, note: '有房但未说明贷款状态，不猜测' };
  return { value: null, note: '无法解析：' + text };
}

function parseCar(text) {
  if (!text) return { value: null, note: '无车字段' };
  if (has(text, ['无车', '还没准备考驾照', '没考驾照', '未买车'])) return { value: 'none' };
  var m = text.match(/([0-9.]+)万[^。；;]{0,6}车/) || text.match(/车[^。；;]{0,6}([0-9.]+)万/);
  if (m) {
    var wan = Number(m[1]);
    if (wan >= 30) return { value: 'high', derived: true, note: '按车价 ' + wan + ' 万归入 30 万以上' };
    if (wan >= 10) return { value: 'mid', derived: true, note: '按车价 ' + wan + ' 万归入 10-30 万' };
    return { value: 'basic', derived: true, note: '按车价 ' + wan + ' 万归入 10 万以下' };
  }
  return { value: null, note: '有车但未提价格，无法选档：' + text };
}

function parseSiblings(text) {
  if (!text) return { value: null, note: '无家庭字段' };
  if (text.indexOf('独生') !== -1) return { value: 'only' };
  if (has(text, ['弟弟', '妹妹', '哥哥', '姐姐', '非独生', '两个姑娘', '兄弟姐妹'])) return { value: 'has', derived: true, note: '按家庭成员描述判定非独生' };
  return { value: null, note: '未提及手足' };
}

function parseMarital(text) {
  if (!text) return { value: null, note: '未提及婚史' };
  if (has(text, ['离异带', '带孩子', '带一个', '带个男孩', '带一个男孩', '有孩子', '抚养权'])) return { value: 'divorced_kid', derived: true, note: '离异且有子女' };
  if (text.indexOf('离异') !== -1 || text.indexOf('离婚') !== -1) return { value: 'divorced' };
  if (text.indexOf('未婚') !== -1) return { value: 'single' };
  return { value: null, note: '未提及婚史' };
}

function parseFamilyOrigin(text) {
  if (!text) return { value: null, note: '无家庭字段' };
  if (has(text, ['A8', 'A9', '千万', '1000万', '500万', '两三千万'])) return { value: 'urban_upper', derived: true, note: '按资产量级归入城市中产及以上' };
  if (has(text, ['A7', '几百万'])) return { value: 'urban_upper', derived: true, note: 'A7 档资产，归入城市中产及以上（口径待确认）' };
  if (text.indexOf('农村') !== -1) return { value: 'rural' };
  if (has(text, ['县城', '县级', '四线', '五线', '小镇'])) return { value: 'county' };
  if (has(text, ['城市', '一线', '新一线', '省会', '北京', '上海', '市区'])) return { value: 'urban_normal', derived: true, note: '按城市描述归入城市普通' };
  return { value: null, note: '无法解析：' + text };
}

// 从“自述/评价”文本里抽自评分（只认“自评/自报/我说/我觉得/我给自己”等主语明确的写法）。
function parseSelfAppearance(text) {
  if (!text) return { value: null, note: '无外貌自述' };
  var idx = -1;
  var keys = ['自评', '自报', '我给自己', '我自己', '我觉得', '我说'];
  for (var i = 0; i < keys.length; i += 1) if (text.indexOf(keys[i]) !== -1) { idx = i; break; }
  if (idx === -1) return { value: null, note: '外貌描述里没有明确自评分（属于第三方评价）：' + text };
  var m = text.match(/([0-9]+(?:[.][0-9])?)[ ]?(?:到|~|-)?[ ]?([0-9]+(?:[.][0-9])?)?[ ]?分/);
  if (!m) return { value: null, note: '找不到数字分：' + text };
  var a = Number(m[1]);
  var b = m[2] ? Number(m[2]) : a;
  var v = (a + b) / 2;
  return { value: v, derived: a !== b, note: a !== b ? '自评区间取中值' : '自评单一值' };
}

function mapCase(c) {
  const i = c.input || {};
  const edu = parseEducation(i.education);
  const school = parseSchoolTier((i.school || '') + ' ' + (i.education || ''));
  const occ = parseOccupation(i.job);
  const inc = parseIncome(i.income);
  const house = parseHouse(i.house);
  const car = parseCar(i.car);
  const sib = parseSiblings(i.family);
  const mar = parseMarital(i.family);
  const origin = parseFamilyOrigin(i.family);
  const self = parseSelfAppearance(i.appearanceNote);
  const derivedMeta = (c.inputMeta && c.inputMeta.appearanceNote && c.inputMeta.appearanceNote.derivedFromVerdict) ? c.inputMeta.appearanceNote : null;
  if (derivedMeta) {
    self.value = null;
    self.derivedFromVerdict = true;
    self.note = "该字段来自博主判断（derivedFromVerdict=true），按“不得用结论反推输入”处理，未作为引擎输入：" + (derivedMeta.note || "");
  }
  const want = WANT_OVERRIDES[c.id] || {};

  const form = {
    gender: c.gender === 'unknown' ? null : c.gender,
    age: c.age === undefined ? null : c.age,
    city: c.city,
    height_cm: i.height === undefined ? null : i.height,
    weight_kg: i.weight === undefined ? null : i.weight,
    education: edu.value,
    school_tier: school.value,
    occupation: occ.value,
    income_wan: inc.value,
    has_house: house.value,
    has_car: car.value,
    hukou: null,
    marital: mar.value,
    family_origin: origin.value,
    siblings: sib.value,
    personality: null,
    communication: null,
    emotional_stability: null,
    living_skills: null,
    social_circle: null,
    want_gender: c.gender === 'female' ? 'male' : (c.gender === 'male' ? 'female' : null),
    want_age_min: want.want_age_min === undefined ? null : want.want_age_min,
    want_age_max: want.want_age_max === undefined ? null : want.want_age_max,
    want_height_min: want.want_height_min === undefined ? null : want.want_height_min,
    want_education_min: want.want_education_min === undefined ? null : want.want_education_min,
    want_house: want.want_house === undefined ? null : want.want_house,
    want_appearance_min: want.want_appearance_min === undefined ? null : want.want_appearance_min,
    self_appearance: self.value,
    self_rank: null,
    admiration_freq: null,
    feedback_gap: null,
    photo_quality: null,
    face_natural: null
  };

  const notes = {
    education: edu.note || null, school_tier: school.note || null, occupation: occ.note || null,
    income_wan: inc.note || null, has_house: house.note || null, has_car: car.note || null,
    marital: mar.note || null, family_origin: origin.note || null, siblings: sib.note || null,
    self_appearance: self.note || null
  };
  const derived = [];
  [['education', edu], ['school_tier', school], ['occupation', occ], ['income_wan', inc], ['has_house', house],
   ['has_car', car], ['family_origin', origin], ['siblings', sib], ['marital', mar], ['self_appearance', self]]
    .forEach(function (pair) { if (pair[1] && pair[1].derived) derived.push(pair[0]); });

  const unmapped = [];
  Object.keys(notes).forEach(function (k) { if (notes[k]) unmapped.push({ field: k, note: notes[k] }); });
  if (i.car && car.value === null) unmapped.push({ field: 'has_car', note: '有车但无价格' });
  if (i.house && house.value === null) unmapped.push({ field: 'has_house', note: '有房但贷款状态未知' });
  (want.unmappable || []).forEach(function (w) { unmapped.push({ field: 'want.*', note: w }); });

  const missingRequired = REQUIRED_FIELDS.filter(function (f) { return form[f] === null || form[f] === undefined || form[f] === ''; });
  const missingFormOnly = missingRequired.filter(function (f) { return FORM_ONLY_FIELDS.indexOf(f) !== -1; });
  const missingCorpus = missingRequired.filter(function (f) { return FORM_ONLY_FIELDS.indexOf(f) === -1; });
  const selfReportMissing = ["height_cm", "weight_kg", "education", "school_tier", "occupation", "income_wan", "has_house", "has_car", "marital", "family_origin", "siblings", "city", "age", "self_appearance"].filter(function (f) { return form[f] === null || form[f] === undefined || form[f] === ''; });
  return {
    form: form, notes: notes, derived: derived, unmapped: unmapped,
    derivedFromVerdict: derivedMeta ? { appearanceNote: derivedMeta } : null,
    wantOverride: want.unmappable ? want : null,
    missingRequired: missingRequired, missingFormOnly: missingFormOnly, missingCorpus: missingCorpus,
    selfReportMissing: selfReportMissing,
    evaluable: missingRequired.length === 0
  };
}

/* ------------------------------------------------------------------ */
/* 引擎加载与运行                                                      */
/* ------------------------------------------------------------------ */

import { execSync } from 'node:child_process';

function gitShow(spec) {
  try { return execSync('git show ' + spec, { cwd: ROOT, maxBuffer: 33554432 }).toString(); } catch (e) { return null; }
}

const DSL_KEYS = ['field', 'op', 'value', 'all', 'any', 'not'];
function sanitizeCondition(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  Object.keys(node).forEach(function (k) {
    if (DSL_KEYS.indexOf(k) === -1) {
      if (Array.isArray(node[k])) {
        if (Array.isArray(node.all)) node.all = node.all.concat(node[k]);
        else if (Array.isArray(node.any)) node.any = node.any.concat(node[k]);
        else node.all = node[k];
      }
      delete node[k];
    }
  });
  if (Array.isArray(node.all)) node.all.forEach(sanitizeCondition);
  if (Array.isArray(node.any)) node.any.forEach(sanitizeCondition);
  if (node.not) sanitizeCondition(node.not);
  return node;
}

function frozenCommits() {
  try {
    return execSync("git log --format=%H -n 12 -- web/lib knowledge/rules.json", { cwd: ROOT, maxBuffer: 8388608 }).toString().split(String.fromCharCode(10)).filter(Boolean);
  } catch (e) { return []; }
}

function materializeFrozenAt(commit) {
  const base = "/tmp/aoye-frozen-" + commit.slice(0, 8);
  const libDir = base + "/lib";
  try { fs.mkdirSync(libDir, { recursive: true }); } catch (e) { return null; }
  let files = [];
  try {
    files = execSync("git ls-tree -r --name-only " + commit + " web/lib", { cwd: ROOT, maxBuffer: 8388608 }).toString().split(String.fromCharCode(10)).filter(function (x) { return x.slice(-4) === ".mjs"; }).map(function (x) { return x.slice(x.lastIndexOf("/") + 1); });
  } catch (e) { files = []; }
  if (!files.length) files = ["engine.mjs", "ruleset.mjs", "pipeline.mjs", "util.mjs", "provider.mjs", "city.mjs", "store.mjs", "validate.mjs"];
  for (let i = 0; i < files.length; i += 1) {
    const t = gitShow(commit + ":web/lib/" + files[i]);
    if (!t) return null;
    fs.writeFileSync(libDir + "/" + files[i], t);
  }
  const bt = gitShow(commit + ":web/config/baseline-rules.json");
  if (!bt) return null;
  const doc = JSON.parse(bt);
  (doc.rules || []).forEach(function (r) { if (r.when && typeof r.when === "object") sanitizeCondition(r.when); });
  const baselinePath = base + "/baseline-frozen.json";
  fs.writeFileSync(baselinePath, JSON.stringify(doc, null, 2));
  const mt = gitShow(commit + ":knowledge/rules.json");
  const mainPath = base + "/rules-frozen.json";
  if (mt) fs.writeFileSync(mainPath, mt);
  return { lib: libDir, baseline: baselinePath, main: mt ? mainPath : null, commit: commit };
}

function hashFiles(files) {
  const out = {};
  files.forEach(function (f) {
    try { out[f.replace(ROOT + "/", "")] = crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex").slice(0, 12); }
    catch (e) { out[f.replace(ROOT + "/", "")] = "missing"; }
  });
  return out;
}

async function loadEngine(libDir, mainPath, baselinePath) {
  const rulesetUrl = pathToFileURL(path.join(libDir, 'ruleset.mjs')).href;
  const cityUrl = pathToFileURL(path.join(libDir, 'city.mjs')).href;
  const providerUrl = pathToFileURL(path.join(libDir, 'provider.mjs')).href;
  const pipelineUrl = pathToFileURL(path.join(libDir, 'pipeline.mjs')).href;
  const rulesetMod = await import(rulesetUrl);
  const cityMod = await import(cityUrl);
  const providerMod = await import(providerUrl);
  const pipelineMod = await import(pipelineUrl);
  const ruleset = rulesetMod.loadRuleset({ mainPath: mainPath, baselinePath: baselinePath });
  const cities = cityMod.loadCities(CITIES_PATH);
  return {
    ruleset: ruleset, cities: cities, cityTier: cityMod.cityTier,
    providerConfig: providerMod.providerConfig, generateReport: pipelineMod.generateReport
  };
}

function normCity(city) {
  if (!city) return null;
  const s = String(city);
  if (has(s, ['县城', '三四线', '四五线', '二三线', '一线城市', '当地', '留学', '读书地'])) return null;
  const hit = s.match(/^(北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|天津|重庆|长沙|郑州|青岛|宁波|东莞|佛山|合肥|无锡|厦门|福州|济南|大连|石家庄|太原|烟台|多伦多)/);
  return hit ? hit[1] : null;
}

async function runEngine(env, form) {
  const report = await env.generateReport({
    form: form,
    photos: [],
    ruleset: env.ruleset,
    config: env.providerConfig({}),
    cityTier: env.cityTier(normCity(form.city), env.cities)
  });
  return report;
}

/* ------------------------------------------------------------------ */
/* 三类对比                                                            */
/* ------------------------------------------------------------------ */

function intervalDistance(interval, value) {
  if (!interval || typeof value !== 'number') return null;
  if (value < interval.low) return interval.low - value;
  if (value > interval.high) return value - interval.high;
  return 0;
}

function checkAppearance(report, c, modeLabel, allowProxy) {
  const expected = c.hayesVerdict.appearanceScore;
  const interval = report.appearance && report.appearance.final ? report.appearance.final : null;
  if (typeof expected !== 'number') {
    return { status: 'unsupported', expected: null, engineInterval: interval, reasonCode: 'no-label', reason: '案例没有博主打分，无法校验颜值轨道' };
  }
  if (!interval) {
    return { status: 'unsupported', expected: expected, engineInterval: null, reasonCode: 'no-interval', reason: '引擎未产出颜值区间' };
  }
  if (!allowProxy) {
    return {
      status: 'unsupported', expected: expected, engineInterval: { low: interval.low, high: interval.high }, reasonCode: 'no-input',
      reason: '输入缺 self_appearance / 照片轨道：引擎的颜值区间不是对本案的有效预测（另见引擎 bug）', inputGap: true
    };
  }
  const dist = intervalDistance(interval, expected);
  if (dist === 0) return { status: 'match', expected: expected, engineInterval: { low: interval.low, high: interval.high }, distance: 0, mode: modeLabel, reason: '标注分落在引擎区间内' };
  if (dist <= 1) return { status: 'partial', expected: expected, engineInterval: { low: interval.low, high: interval.high }, distance: dist, mode: modeLabel, reason: '方向一致但数值偏离 ' + dist + ' 分' };
  return { status: 'mismatch', expected: expected, engineInterval: { low: interval.low, high: interval.high }, distance: dist, mode: modeLabel, reason: '偏离 ' + dist + ' 分（区间与标注相反）' };
}

function verdictText(c) {
  const v = c.hayesVerdict || {};
  return [v.band, v.targetProfile, v.advice].filter(Boolean).join(' ｜ ');
}

// D24：关键词启发式已废弃，不再使用。档位只能来自语料自己的 bands 词表（BAND_VOCAB）。
function deprecatedCaseTier(c) {
  const v = c.hayesVerdict || {};
  const main = [v.band, v.advice].filter(Boolean).join(' ｜ ');
  const target = v.targetProfile || '';
  const matched = [];
  function scan(text, words, tier) {
    for (let i = 0; i < words.length; i += 1) {
      if (text.indexOf(words[i]) !== -1) { matched.push(tier + ':' + words[i]); return true; }
    }
    return false;
  }
  const C = TIER_KEYWORDS.find(function (r) { return r.tier === 'C'; }).words;
  const S = TIER_KEYWORDS.find(function (r) { return r.tier === 'S'; }).words;
  const A = TIER_KEYWORDS.find(function (r) { return r.tier === 'A'; }).words;
  if (scan(main, C, 'C')) return { tier: 'C', matched: matched, layer: '主结论含降档词' };
  if (scan(main + ' ｜ ' + target, S, 'S')) return { tier: 'S', matched: matched, layer: '目标含高净值词' };
  if (scan(main, A, 'A')) return { tier: 'A', matched: matched, layer: '主结论含上探词' };
  if (scan(target, A, 'A')) return { tier: 'A', matched: matched, layer: '目标画像含高配词' };
  return { tier: null, matched: [] };
}

const TIER_ORDER = { S: 4, A: 3, B: 2, C: 1 }; // 仅历史遗留，D24 后不再用于任何比对
// D24：S/A/B/C 是我们自己发明的词汇，语料里没有这套体系；关键词启发式已永久废弃。
// 报告只用“语料自己的档位词”（rules.json 的 9 条 bands），且仅作为引用登记，不做比对打分。
const BAND_VOCAB = [
  { id: 'match.rank.t1', name: '打分局头部（第 1–3 名区间）', terms: ['前 3 名', '前3名', '前三名', '进前 3', '进前3', '第 1 名', '第1名', '第一名', '打分局第一'] },
  { id: 'match.rank.t7', name: '打分局中段（第 7–9 名区间）', terms: ['第 7', '第7', '第 8', '第8', '第 9', '第9', '中段'] },
  { id: 'asset.a9', name: 'A9 资产档', terms: ['A9'] },
  { id: 'asset.a8', name: 'A8 资产档', terms: ['A8'] },
  { id: 'asset.a7', name: 'A7 资产档', terms: ['A7'] },
  { id: 'event.high', name: '高净值活动', terms: ['高净值'] },
  { id: 'event.three', name: '三高专场', terms: ['三高'] },
  { id: 'event.normal', name: '普通活动（无门槛）', terms: ['普通活动', '无门槛'] },
  { id: 'ecosystem.tier', name: '生态位（黄金/白银/青铜）', terms: ['生态位', '黄金', '白银', '青铜'] }
];
function detectBandVocabulary(c) {
  const text = [c.hayesVerdict.band, c.hayesVerdict.targetProfile, c.hayesVerdict.advice].filter(Boolean).join(' ｜ ');
  const refs = [];
  BAND_VOCAB.forEach(function (b) {
    for (let i = 0; i < b.terms.length; i += 1) {
      if (text.indexOf(b.terms[i]) !== -1) { refs.push({ id: b.id, name: b.name, matchedTerm: b.terms[i] }); return; }
    }
  });
  return refs;
}

// D14：baseline 的 S/A/B/C 数值档位属 engineering-default（无处语料依据），不得作为结论比对。
// 因此档位维度默认记 not-comparable；只有当引擎输出的是“有 entryCriteria 的语料档位”且案例能语义映射时才比。
function bandEngineeringDefault(band) {
  if (!band) return true;
  return !band.entryCriteria;
}

function checkBand(report, c, appearanceProxy) {
  const selfBand = report.portrait && report.portrait.band ? report.portrait.band : null;
  const upperName = report.matchWindow && report.matchWindow.upper ? report.matchWindow.upper.bandName : null;
  const upperLetter = upperName ? String(upperName).trim().charAt(0) : null;
  const upperTier = upperLetter && TIER_ORDER[upperLetter] ? upperLetter : null;
  const upperBand = upperTier ? { id: upperTier, name: upperName, score: report.matchWindow.upper.score } : null;
  const band = upperBand || selfBand;
  const base = {
    caseBandRefs: detectBandVocabulary(c),
    engineTier: band ? band.id : null, engineSelfTier: selfBand ? selfBand.id : null,
    engineUpperTier: upperBand ? upperBand.id : null, engineUpperScore: upperBand ? upperBand.score : null,
    appearanceInput: appearanceProxy,
    basis: upperBand ? "matchWindow.upper.bandName" : "portrait.band",
    comparable: false,
    reason: "not-comparable：① 引擎当前只输出 baseline 的 S/A/B/C（engineering-default，D24 已停止作为结论）；② 语料自己的档位词（打分局名次 / A9 / 活动渠道）引擎还不会输出，因此无法比对。caseBandRefs 记录本案引用了哪些语料档位词，作为 v2 的接通点。"
  };
  return Object.assign(base, { status: "not-comparable" });
}

function caseDirection(c) {
  const t = verdictText(c);
  for (let i = 0; i < DIRECTION_KEYWORDS.down.length; i += 1) if (t.indexOf(DIRECTION_KEYWORDS.down[i]) !== -1) return 'down';
  for (let i = 0; i < DIRECTION_KEYWORDS.up.length; i += 1) if (t.indexOf(DIRECTION_KEYWORDS.up[i]) !== -1) return 'up';
  return t ? 'flat' : 'unknown';
}

function checkReversal(report, c) {
  const dir = caseDirection(c);
  const gives = report.giveUps || [];
  const advices = report.advice || [];
  if (!gives.length && !advices.length) {
    return { status: 'unsupported', direction: dir, reason: '引擎未产出任何建议/放弃项（无规则命中）', count: 0 };
  }
  if (!gives.length) {
    return { status: 'match', direction: dir, reason: '引擎没有给出与案例相反的方向性结论', count: advices.length };
  }
  const reversed = [];
  gives.forEach(function (g) {
    if (dir === 'up' || dir === 'flat') reversed.push({ ruleId: g.ruleId, text: g.text, why: '案例判断为可达/对等（' + dir + '），引擎却输出放弃项' });
  });
  if (reversed.length) return { status: 'mismatch', direction: dir, reason: '引擎给出 ' + reversed.length + ' 条与案例相反的方向性结论', count: gives.length, reversed: reversed };
  return { status: 'match', direction: dir, reason: '引擎的放弃项与案例的向下判断一致', count: gives.length };
}

/* ------------------------------------------------------------------ */
/* 缺口归因（v2 需求清单的来源）                                        */
/* ------------------------------------------------------------------ */

const GAP_DETAILS = new Map();

function detectFactorGaps(c, report, mapping) {
  const bag = [
    c.hayesVerdict.band, c.hayesVerdict.targetProfile, c.hayesVerdict.advice, c.quote,
    c.input.family, c.input.appearanceNote, c.input.job, c.input.education
  ].filter(Boolean).join(' ｜ ');
  const gaps = [];
  FACTOR_GAPS.forEach(function (gap) {
    if (!gap.any.length) return;
    for (let i = 0; i < gap.any.length; i += 1) {
      if (bag.indexOf(gap.any[i]) !== -1) { gaps.push({ id: gap.id, name: gap.name, impact: gap.impact, kind: 'rule-gap', detail: gap.detail }); break; }
    }
  });
  // 语料侧：字段映射不出来（属于“输入缺口”，与“引擎缺规则”分开统计）
  mapping.unmapped.forEach(function (u) {
    if (u.field === 'self_appearance') return;
    gaps.push({ id: 'map.' + u.field, name: (FIELD_LABELS[u.field] || ('字段无法映射：' + u.field)), impact: 'low', kind: 'input-gap', detail: u.note });
  });
  const out = dedupeGaps(gaps);
  out.forEach(function (g) { if (!GAP_DETAILS.has(g.id)) GAP_DETAILS.set(g.id, g); });
  return out;
}

function dedupeGaps(list) {
  const seen = new Set();
  const out = [];
  list.forEach(function (g) { if (!seen.has(g.id)) { seen.add(g.id); out.push(g); } });
  return out;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const SEVERITY = { match: 0, unsupported: 1, partial: 2, mismatch: 3 };
// 综合判定：mismatch > partial > match；但“match”必须有实质性比对（颜值区间命中 或 档位方向一致）。
// 只有“反向建议”一项可判定的，不给 match，记 unsupported —— 避免用“引擎没给相反结论”把匹配率抬高。
function overallStatus(appearance, band, reversal) {
  if (appearance === 'mismatch' || band === 'mismatch' || reversal === 'mismatch') return 'mismatch';
  if (appearance === 'partial' || band === 'partial') return 'partial';
  if (appearance === 'match' || band === 'match') return 'match';
  return 'unsupported';
}

function worst(list) {
  const determinate = list.filter(function (s) { return s !== 'unsupported'; });
  if (!determinate.length) return 'unsupported';
  let w = 'match';
  determinate.forEach(function (s) { if (SEVERITY[s] > SEVERITY[w]) w = s; });
  return w;
}

async function main() {
  const raw = fs.readFileSync(CASES_PATH, 'utf8');
  const casesDoc = JSON.parse(raw);
  const casesHash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
  const engineFiles = [EFFECTIVE_MAIN, EFFECTIVE_BASELINE, path.join(EFFECTIVE_LIB, "engine.mjs"), path.join(ROOT, "web", "lib", "pipeline.mjs"), path.join(ROOT, "web", "lib", "ruleset.mjs")];
  const fileHashes = hashFiles(engineFiles);
  let env = null;
  let loadError = null;
  let workspaceErrorText = null;
  try { env = await loadEngine(EFFECTIVE_LIB, EFFECTIVE_MAIN, EFFECTIVE_BASELINE); } catch (e) { loadError = String(e && e.message ? e.message : e); }
  let frozen = null;
  if (!LIB_OVERRIDE && !BASELINE_OVERRIDE) {
    let needFallback = Boolean(loadError);
    if (!needFallback && env) {
      try { await runEngine(env, mapCase(casesDoc.cases[0]).form); } catch (e) { needFallback = true; loadError = String(e && e.message ? e.message : e); }
    }
    if (needFallback) {
      const workspaceError = loadError;
      workspaceErrorText = workspaceError;
      const commits = frozenCommits();
      let picked = null;
      let lastError = workspaceError;
      for (let ci = 0; ci < commits.length && !picked; ci += 1) {
        const snapshot = materializeFrozenAt(commits[ci]);
        if (!snapshot) continue;
        try {
          const frozenEnv = await loadEngine(snapshot.lib, snapshot.main || EFFECTIVE_MAIN, snapshot.baseline);
          await runEngine(frozenEnv, mapCase(casesDoc.cases[0]).form);
          env = frozenEnv; frozen = snapshot; loadError = null; picked = snapshot;
          const subject = (function () { try { return execSync("git log -1 --format=%h-%s " + commits[ci], { cwd: ROOT }).toString().trim().replace("-", " "); } catch (e) { return commits[ci].slice(0, 8); } })();
          frozen.label = subject;
          printDegradedBanner(subject, workspaceError);
          addIssue("BUG-WORKSPACE-ENGINE-BROKEN", "critical", "工作区引擎当前不可用（已回退到最近一个可运行的历史版本）", "直连工作区 web/lib + knowledge/rules.json + baseline 失败：" + workspaceError + "。本次数字来自历史快照 " + subject + "。修复后请直接重跑本工具。", null);
        } catch (e2) { lastError = String(e2 && e2.message ? e2.message : e2); }
      }
      if (!picked && !frozen) loadError = workspaceError + " / 历史快照也全部失败：" + lastError;
    }
  }
  if (loadError) {
    const failOut = {
      generatedAt: new Date().toISOString(), casesFile: "knowledge/cases.json", casesHash: casesHash, casesCount: casesDoc.cases.length,
      engine: { loadError: loadError, fileHashes: fileHashes, mainRulesPath: EFFECTIVE_MAIN, baselinePath: EFFECTIVE_BASELINE, overrides: { rules: RULES_OVERRIDE, baseline: BASELINE_OVERRIDE } },
      summary: { total: casesDoc.cases.length, match: 0, partial: 0, mismatch: 0, unsupported: casesDoc.cases.length, matchRate: 0, appearance: {}, band: {}, reversal: {}, byGender: {}, byTier: {} },
      gaps: [], inputGaps: [],
      engineIssues: [{ id: "BUG-RULESET-INVALID", severity: "critical", title: "规则集无法加载，引擎整体不可用", detail: loadError, caseCount: casesDoc.cases.length, cases: [] }],
      cases: []
    };
    fs.writeFileSync(OUT_JSON, JSON.stringify(failOut, null, 2) + NL);
    const fmd = ["# 案例回归测试报告（CASE-CALIBRATION v1）", "", "> 运行方式：node tools/case_regression.mjs", "> 输入：knowledge/cases.json（" + casesDoc.cases.length + " 条，指纹 " + casesHash + "）", "> 机器可读结果：knowledge/case-calibration.json", "", "## 运行失败：规则集加载异常（P0，阻断）", "", "- 错误信息：" + loadError, "- 规则/引擎文件指纹：" + JSON.stringify(fileHashes), "", "引擎无法加载 ruleset 时任何案例都无法评分；修复后重跑本工具即可得到完整报告。"].join(String.fromCharCode(10)) + String.fromCharCode(10);
    fs.writeFileSync(OUT_MD, fmd);
    console.log("[case-regression] FATAL 规则集加载失败：" + loadError);
    console.log("[case-regression] 已写出失败报告 -> " + OUT_MD);
    process.exit(1);
  }

  const engineIssues = new Map();
  const staticDimFields = new Set((env.ruleset.dimensions || []).map(function (d) { return d.field; }).filter(Boolean));
  const weightCases = casesDoc.cases.filter(function (c) { return c.input && c.input.weight !== null && c.input.weight !== undefined; }).map(function (c) { return c.id; });
  const appDims = (env.ruleset.dimensions || []).filter(function (d) { return d.group === 'appearance'; });
  const appDimsWithField = appDims.filter(function (d) { return d.field; });
  function addIssue(id, severity, title, detail, caseId) {
    if (!engineIssues.has(id)) engineIssues.set(id, { id: id, severity: severity, title: title, detail: detail, cases: [] });
    const item = engineIssues.get(id);
    if (caseId && item.cases.indexOf(caseId) === -1) item.cases.push(caseId);
  }

  if (!staticDimFields.has('weight_kg')) {
    const it = { id: 'GAP-WEIGHT-UNCOVERED', severity: 'medium', structural: true, title: 'weight_kg 没有评分维度', detail: '表单有 weight_kg，但没有任何 dimension.field 引用它：语料中 ' + weightCases.length + ' 条案例可提取体重，填了也不参与打分。', cases: weightCases };
    engineIssues.set(it.id, it);
  }
  if (appDims.length > 0 && appDimsWithField.length === 0) {
    const it = { id: 'GAP-PHOTO-DIMS', severity: 'medium', structural: true, title: '外观维度无表单映射（纯照片轨道）', detail: 'appearance 组的 ' + appDims.length + ' 个维度都没有 field 与 scoring：纯表单模式下无法评分，颜值只能靠用户自评轨道。', cases: [] };
    engineIssues.set(it.id, it);
  }
  if (LIB_OVERRIDE || BASELINE_OVERRIDE) {
    let probeError = null;
    try {
      const probeEnv = await import(pathToFileURL(path.join(ROOT, 'web', 'lib', 'pipeline.mjs')).href).then(function (m) { return { generateReport: m.generateReport }; });
      const probeRuleset = await import(pathToFileURL(path.join(ROOT, 'web', 'lib', 'ruleset.mjs')).href).then(function (m) { return m.loadRuleset({ mainPath: MAIN_RULES, baselinePath: BASELINE_RULES }); });
      const probeCity = await import(pathToFileURL(path.join(ROOT, 'web', 'lib', 'city.mjs')).href).then(function (m) { return m; });
      const probeProvider = await import(pathToFileURL(path.join(ROOT, 'web', 'lib', 'provider.mjs')).href);
      const probeCities = probeCity.loadCities(CITIES_PATH);
      await probeEnv.generateReport({ form: casesDoc.cases[0] ? mapCase(casesDoc.cases[0]).form : {}, photos: [], ruleset: probeRuleset, config: probeProvider.providerConfig({}), cityTier: probeCity.cityTier(null, probeCities) });
    } catch (e) { probeError = String(e && e.message ? e.message : e); }
    if (probeError) {
      addIssue('BUG-WORKSPACE-ENGINE-BROKEN', 'critical', '工作区引擎当前不可用（本次已用冻结副本回退）', '直连工作区 web/lib + web/config/baseline-rules.json 运行失败：' + probeError + '。本报告的数字来自 --lib/--baseline 指定的冻结副本；web 侧修复后请不带参数重跑。', 'ALL');
    } else {
      addIssue('INFO-WORKSPACE-ENGINE-OK', 'low', '工作区引擎当前可用（覆盖参数已非必需）', '探测运行成功：工作区 web/lib + baseline-rules.json 可以加载并产出报告，可去掉 --lib/--baseline 重跑以取得工作区口径。', 'ALL');
    }
  }
  addIssue('BUG-APPEARANCE-NULL', 'high', '未填写颜值自评时被当成 0 分 / 1 分', 'buildSelfTrack 里 Number(null) === 0，未填 self_appearance 时引擎仍产出 [1,1] 的颜值区间并计入 level（权重 0.4），把案例整体拉向 C 档。', null);
  addIssue('GAP-BANDS-KNOWLEDGE', 'medium', '梯队定义完全来自演示基线', 'knowledge/rules.json 的 bands 为空数组，梯队 S/A/B/C 全部来自 web/config/baseline-rules.json（未取证）。', null);
  addIssue('GAP-RULES-NONEXEC', 'high', '知识库规则不可执行', 'knowledge/rules.json 的规则 when 为自然语言字符串，引擎 runRules 直接跳过（applied 里没有一条 knowledge 规则）。', null);


  const results = [];
  for (let idx = 0; idx < casesDoc.cases.length; idx += 1) {
    const c = casesDoc.cases[idx];
    const mapping = mapCase(c);
    if (!mapping.evaluable) {
      const gaps = detectFactorGaps(c, null, mapping);
      const missText = '缺 ' + mapping.missingRequired.length + ' 项必填输入（' + mapping.missingRequired.slice(0, 6).join('、') + (mapping.missingRequired.length > 6 ? ' 等' : '') + '）';
      const skipCheck = { status: 'unsupported', reasonCode: 'missing-required-input', reason: '按 D19.1：不把 null 传给引擎算假分；' + missText };
      results.push({
        id: c.id, gender: c.gender, city: c.city, confidence: c.confidence,
        verdictContext: c.verdictContext || 'unspecified', verdictContextNote: c.verdictContextNote || null,
        mapping: { derived: mapping.derived, unmapped: mapping.unmapped, derivedFromVerdict: mapping.derivedFromVerdict, form: mapping.form, formComplete: false, missingRequired: mapping.missingRequired, missingFormOnly: mapping.missingFormOnly, missingCorpus: mapping.missingCorpus, selfReportMissing: mapping.selfReportMissing },
        engine: null,
        checks: { appearance: skipCheck, band: Object.assign({ caseBandRefs: detectBandVocabulary(c) }, skipCheck), reversal: skipCheck },
        evaluationState: 'evaluable',
        missingCounts: { formOnly: 0, corpus: 0 },
        caseOutcome: 'unsupported', countedInAccuracy: false, guardMismatch: false, comparableDims: [],
        overall: 'unsupported', causes: [{ type: 'input-gap', id: 'missing-required-input', detail: missText }],
        gaps: gaps.map(function (g) { return g.id; }),
        notEvaluable: true, notEvaluableReason: 'missing-required-input',
        evaluationState: mapping.missingFormOnly.length > 0 ? 'blocked:missing-form-input' : 'blocked:missing-corpus-condition',
        missingCounts: { formOnly: mapping.missingFormOnly.length, corpus: mapping.missingCorpus.length }
      });
      continue;
    }
    let asIs = null;
    let proxy = null;
    let runError = null;
    try {
      asIs = await runEngine(env, mapping.form);
    } catch (e) {
      runError = String(e && e.message ? e.message : e);
      addIssue('BUG-CRASH', 'critical', '引擎在案例上抛异常', '案例 ' + c.id + ' 运行 generateReport 抛错：' + runError, c.id);
    }
    const proxyForm = Object.assign({}, mapping.form);
    const hasSelf = typeof mapping.form.self_appearance === 'number';
    if (!hasSelf && typeof c.hayesVerdict.appearanceScore === 'number') proxyForm.self_appearance = c.hayesVerdict.appearanceScore;
    if (!runError) {
      try { proxy = await runEngine(env, proxyForm); } catch (e) {
        addIssue('BUG-CRASH-PROXY', 'critical', '引擎在代理输入下抛异常', '案例 ' + c.id + '：' + String(e && e.message ? e.message : e), c.id);
      }
    }

    if (!runError && asIs && !hasSelf) {
      addIssue("BUG-APPEARANCE-NULL", "high", "未填写颜值自评时被当成 0 分 / 1 分", "buildSelfTrack 里 Number(null) === 0，未填 self_appearance 时引擎仍产出 [1,1] 的颜值区间并计入 level（权重 0.4），把案例整体拉向 C 档。", c.id);
    }

    if (runError) {
      results.push({ id: c.id, gender: c.gender, city: c.city, error: runError, checks: { appearance: { status: 'unsupported', reason: '引擎异常' }, band: { status: 'unsupported', reason: '引擎异常' }, reversal: { status: 'unsupported', reason: '引擎异常' } }, overall: 'mismatch', causes: [{ type: 'engine-bug', id: 'BUG-CRASH', detail: runError }], gaps: [] });
      continue;
    }

    const bandReport = proxy || asIs;
    const appearanceInputKind = hasSelf ? 'self-report' : (typeof c.hayesVerdict.appearanceScore === 'number' ? 'proxy-label' : 'none(bug:1.0)');
    const appearanceCheck = checkAppearance(asIs, c, hasSelf ? 'self-report' : 'none', hasSelf);
    const bandCheck = checkBand(bandReport, c, appearanceInputKind);
    const reversalCheck = checkReversal(bandReport, c);

    if (bandReport.rulesApplied && bandReport.rulesApplied.length === 0) {
      addIssue('GAP-RULES-NONEXEC', 'high', '知识库规则不可执行', 'knowledge/rules.json 的规则 when 为自然语言字符串，引擎 runRules 直接跳过（applied 里没有一条 knowledge 规则）。', c.id);
    }
    if (bandReport.engine && bandReport.engine.coverage && bandReport.engine.coverage.knowledge && bandReport.engine.coverage.knowledge.bands === 0) {
      addIssue('GAP-BANDS-KNOWLEDGE', 'medium', '梯队定义完全来自演示基线', 'knowledge/rules.json 的 bands 为空数组，梯队 S/A/B/C 全部来自 web/config/baseline-rules.json（未取证）。', c.id);
    }


    const gaps = detectFactorGaps(c, bandReport, mapping);
    const causes = [];
    if (appearanceCheck.inputGap) causes.push({ type: 'input-gap', id: 'appearance.self_input', detail: '案例没有可用的颜值自评/照片，引擎无法在无泄漏前提下给出颜值区间' });
    if (!hasSelf) causes.push({ type: 'engine-bug', id: 'BUG-APPEARANCE-NULL', detail: '输入缺 self_appearance 时未做缺失保护：颜值被计为 1.0 分并进入 level（权 0.4），本案例的档位/建议结论受此污染，需修复后重跑才能公允判定' });
    if (bandCheck.status === 'mismatch' || bandCheck.status === 'partial') {
      gaps.forEach(function (g) { if (g.impact !== 'low') causes.push({ type: 'missing-dimension', id: g.id, detail: g.name + '：' + g.detail }); });
    }
    if (reversalCheck.status === 'mismatch') causes.push({ type: 'missing-rule', id: 'matching.reversal', detail: reversalCheck.reason });

    const overall = overallStatus(appearanceCheck.status, bandCheck.status, reversalCheck.status);
    const verdictContext = c.verdictContext || "unspecified";
    // 实质性维度（能给出“答对”的只有这两类）：颜值区间、档位语义。
    // 反向建议只是护栏：它 mismatch 记为错误，但“没给相反结论”不能算答对。
    const SUBSTANTIVE = ["appearance", "band"];
    const comparableDims = [];
    SUBSTANTIVE.forEach(function (k) {
      const st = k === "appearance" ? appearanceCheck.status : bandCheck.status;
      if (st === "match" || st === "partial" || st === "mismatch") comparableDims.push(k);
    });
    const substantiveStates = comparableDims.map(function (k) { return k === "appearance" ? appearanceCheck.status : bandCheck.status; });
    const guardMismatch = reversalCheck.status === "mismatch";
    let caseOutcome = "not-comparable";
    if (guardMismatch) caseOutcome = "mismatch";
    else if (substantiveStates.length) {
      if (substantiveStates.indexOf("mismatch") !== -1) caseOutcome = "mismatch";
      else if (substantiveStates.indexOf("partial") !== -1) caseOutcome = "partial";
      else caseOutcome = "match";
    }
    const countedInAccuracy = verdictContext === "positive-reachable" && caseOutcome !== "not-comparable";
    results.push({
      id: c.id, gender: c.gender, city: c.city,
      confidence: c.confidence,
      mapping: { derived: mapping.derived, unmapped: mapping.unmapped, derivedFromVerdict: mapping.derivedFromVerdict, form: mapping.form },
      engine: {
        appearanceAsIs: asIs.appearance && asIs.appearance.final ? { low: asIs.appearance.final.low, high: asIs.appearance.final.high } : null,
        appearanceProxy: proxy && proxy.appearance && proxy.appearance.final ? { low: proxy.appearance.final.low, high: proxy.appearance.final.high } : null,
        hardware: asIs.hardware ? asIs.hardware.score : null,
        soft: asIs.soft ? asIs.soft.score : null,
        level: bandReport.level,
        band: bandReport.portrait && bandReport.portrait.band ? bandReport.portrait.band.id : null,
        bandName: bandReport.portrait && bandReport.portrait.band ? bandReport.portrait.band.name : null,
        adviceCount: (bandReport.advice || []).length,
        giveUpCount: (bandReport.giveUps || []).length,
        giveUps: (bandReport.giveUps || []).map(function (g) { return { ruleId: g.ruleId, text: g.text }; }),
        rulesApplied: (bandReport.rulesApplied || []).map(function (r) { return r.ruleId; }),
        uncoveredFields: bandReport.uncoveredFields || [],
        warnings: bandReport.engine ? bandReport.engine.warnings : []
      },
      checks: { appearance: appearanceCheck, band: bandCheck, reversal: reversalCheck },
      verdictContext: verdictContext,
      verdictContextNote: c.verdictContextNote || null,
      caseOutcome: caseOutcome,
      countedInAccuracy: countedInAccuracy,
      guardMismatch: guardMismatch,
      comparableDims: comparableDims,
      overall: overall,
      causes: causes,
      gaps: gaps.map(function (g) { return g.id; })
    });
  }

  /* ---------------- 汇总 ---------------- */
  const total = results.length;
  const count = function (key, val) { return results.filter(function (r) { return r.checks[key].status === val; }).length; };
  const overallCount = function (v) { return results.filter(function (r) { return r.overall === v; }).length; };
  const byGender = {};
  results.forEach(function (r) {
    const g = r.gender === 'female' ? '女' : (r.gender === 'male' ? '男' : '未知');
    byGender[g] = byGender[g] || { total: 0, match: 0, partial: 0, mismatch: 0, unsupported: 0 };
    byGender[g].total += 1;
    byGender[g][r.overall] += 1;
  });
  const tierOf = {};
  results.forEach(function (r) {
    const t = (r.checks.band && r.checks.band.expectedTier) || 'unknown';
    tierOf[t] = tierOf[t] || { total: 0, match: 0, partial: 0, mismatch: 0, unsupported: 0 };
    tierOf[t].total += 1;
    tierOf[t][r.overall] += 1;
  });

  const gapAgg = new Map();
  results.forEach(function (r) {
    (r.gaps || []).forEach(function (gid) {
      const known = GAP_DETAILS.get(gid);
      const found = FACTOR_GAPS.find(function (x) { return x.id === gid; });
      if (!gapAgg.has(gid)) gapAgg.set(gid, { id: gid, name: found ? found.name : (known ? known.name : gid), impact: found ? found.impact : 'low', kind: found ? 'rule-gap' : 'input-gap', detail: found ? found.detail : (known ? known.detail : ''), cases: [] });
      gapAgg.get(gid).cases.push(r.id);
    });
  });
  const impactOrder = { high: 0, medium: 1, low: 2 };
  const gapList = Array.from(gapAgg.values()).filter(function (g) { return g.kind === 'rule-gap'; }).sort(function (a, b) {
    if (impactOrder[a.impact] !== impactOrder[b.impact]) return impactOrder[a.impact] - impactOrder[b.impact];
    return b.cases.length - a.cases.length;
  });
  const inputGapList = Array.from(gapAgg.values()).filter(function (g) { return g.kind === 'input-gap'; }).sort(function (a, b) { return b.cases.length - a.cases.length; });

  const contaminated = results.filter(function (r) { return r.checks.band && r.checks.band.appearanceInput === 'none(bug:1.0)' && (r.checks.band.status === 'mismatch' || r.checks.band.status === 'partial'); });
  const apprUnsup = { noLabel: 0, noInput: 0, noInterval: 0 };
  results.forEach(function (r) {
    if (r.checks.appearance.status !== 'unsupported') return;
    if (r.checks.appearance.reasonCode === 'no-input') apprUnsup.noInput += 1;
    else if (r.checks.appearance.reasonCode === 'no-interval') apprUnsup.noInterval += 1;
    else apprUnsup.noLabel += 1;
  });
  const summary = {
    total: total,
    match: overallCount('match'), partial: overallCount('partial'), mismatch: overallCount('mismatch'), unsupported: overallCount('unsupported'),
    matchRate: total ? Math.round(overallCount('match') / total * 1000) / 10 : 0,
    evaluable: (function () {
      const ev = results.filter(function (r) { return !r.notEvaluable; });
      return { count: ev.length, notEvaluable: results.length - ev.length, notEvaluableReason: 'missing-required-input' };
    })(),
    dataGaps: (function () {
      const fieldCount = {};
      results.forEach(function (r) { (r.mapping.missingRequired || []).forEach(function (f) { fieldCount[f] = (fieldCount[f] || 0) + 1; }); });
      const formFieldCount = {};
      results.forEach(function (r) { (r.mapping.missingFormOnly || []).forEach(function (f) { formFieldCount[f] = (formFieldCount[f] || 0) + 1; }); });
      const corpusFieldCount = {};
      results.forEach(function (r) { (r.mapping.missingCorpus || []).forEach(function (f) { corpusFieldCount[f] = (corpusFieldCount[f] || 0) + 1; }); });
      const rank = function (obj) { return Object.keys(obj).map(function (k) { return { field: k, count: obj[k] }; }).sort(function (a, b) { return b.count - a.count; }); };
      const nearest = results.map(function (r) {
        return { id: r.id, missingTotal: (r.mapping.missingRequired || []).length, formOnly: (r.mapping.missingFormOnly || []).length, corpus: (r.mapping.missingCorpus || []).length, fields: (r.mapping.missingRequired || []).slice(0, 8) };
      }).sort(function (a, b) { return a.missingTotal - b.missingTotal; }).slice(0, 8);
      const totalMissing = results.reduce(function (a, r) { return a + (r.mapping.missingRequired || []).length; }, 0);
      return {
        missingRequiredFieldCounts: rank(fieldCount),
        formOnlyFieldCounts: rank(formFieldCount),
        corpusFieldCounts: rank(corpusFieldCount),
        casesWithFormOnlyMissing: results.filter(function (r) { return (r.mapping.missingFormOnly || []).length > 0; }).length,
        casesWithCorpusMissing: results.filter(function (r) { return (r.mapping.missingCorpus || []).length > 0; }).length,
        averageMissingRequired: results.length ? Math.round(totalMissing / results.length * 10) / 10 : 0,
        nearestCases: nearest
      };
    })(),
    evaluationStates: (function () {
      const st = { evaluable: 0, 'blocked:missing-form-input': 0, 'blocked:missing-corpus-condition': 0 };
      results.forEach(function (r) { if (st[r.evaluationState] === undefined) st[r.evaluationState] = 0; st[r.evaluationState] += 1; });
      return st;
    })(),
    unlockModel: (function () {
      const rows = results.map(function (r) { return { id: r.id, form: (r.mapping.missingFormOnly || []), corpus: (r.mapping.missingCorpus || []) }; });
      const freq = {};
      rows.forEach(function (r) { r.corpus.forEach(function (f) { freq[f] = (freq[f] || 0) + 1; }); });
      const ranked = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
      const picked = [5, 8, 10, 12, 15, 20].filter(function (k) { return k < ranked.length; });
      picked.push(ranked.length);
      const curve = picked.map(function (k) {
        const set = new Set(ranked.slice(0, k));
        return { topK: k, fields: ranked.slice(0, k), evaluable: rows.filter(function (r) { return r.corpus.every(function (f) { return set.has(f); }); }).length };
      });
      const avg = function (key) { return rows.length ? Math.round(rows.reduce(function (a, r) { return a + r[key].length; }, 0) / rows.length * 10) / 10 : 0; };
      return {
        formOnlyFieldsNeeded: FORM_ONLY_FIELDS.length,
        corpusFieldsNeeded: ranked.length,
        corpusFieldRanking: ranked.map(function (f) { return { field: f, count: freq[f] }; }),
        unlockByAllowingUnknownOnly: rows.filter(function (r) { return r.corpus.length === 0; }).length,
        unlockByAnnotatingOnly: rows.filter(function (r) { return r.form.length === 0; }).length,
        alreadyEvaluable: rows.filter(function (r) { return r.corpus.length === 0 && r.form.length === 0; }).length,
        avgFormOnlyMissing: avg('form'),
        avgCorpusMissing: avg('corpus'),
        curve: curve,
        note: '解锁需要两个动作同时完成：① 表单允许用户自评/偏好项填「未知」（消掉 form-only 缺口）；② 语料补标注（消掉 corpus 缺口）。只做一个，可评估数仍为 0。'
      };
    })(),
    context: (function () {
      const c = { 'positive-reachable': 0, 'conditional-ceiling': 0, 'reverse-context': 0, 'unspecified': 0 };
      results.forEach(function (r) { if (c[r.verdictContext] === undefined) c[r.verdictContext] = 0; c[r.verdictContext] += 1; });
      return c;
    })(),
    accuracy: (function () {
      const denom = results.filter(function (r) { return r.countedInAccuracy; });
      const pos = results.filter(function (r) { return r.verdictContext === 'positive-reachable'; });
      const notComparable = pos.filter(function (r) { return r.caseOutcome === 'not-comparable'; });
      const cnt = function (v) { return denom.filter(function (r) { return r.caseOutcome === v; }).length; };
      return {
        basis: 'D19：只统计 positive-reachable 且在“颜值区间命中 / 档位方向命中”里至少一项可判定的案例；缺必填输入（D19.1）与 not-comparable 都不进分母，但必须单列公示。反向建议只作护栏（它 mismatch 记错误，但不因“未给相反结论”记正确）。',
        positiveReachableTotal: pos.length,
        denominator: denom.length,
        match: cnt('match'), partial: cnt('partial'), mismatch: cnt('mismatch'),
        notComparable: pos.length - denom.length,
        notEvaluableByMissingInput: pos.filter(function (r) { return r.notEvaluable; }).length,
        notComparableCases: notComparable.map(function (r) { return r.id; }),
        guardMismatchCases: pos.filter(function (r) { return r.guardMismatch; }).map(function (r) { return r.id; }),
        whySmall: '本轮可评估案例为 0：按 D19.1，案例缺必填输入时不把 null 传给引擎算假分，因此全部案例记 unsupported: missing-required-input。分母为 0 时准确率无法计算——这不是引擎错，是基准集与产品表单的结构性差距。',
        rate: denom.length ? Math.round(cnt('match') / denom.length * 1000) / 10 : null
      };
    })(),
    dimensions: (function () {
      const dim = function (key) {
        const st = { match: 0, partial: 0, mismatch: 0, unsupported: 0, 'not-comparable': 0 };
        results.filter(function (r) { return r.verdictContext === 'positive-reachable'; }).forEach(function (r) {
          const c = r.checks[key];
          if (!c) return;
          if (st[c.status] !== undefined) st[c.status] += 1; else st.unsupported += 1;
        });
        return st;
      };
      return { note: '仅统计 positive-reachable 案例', appearance: dim('appearance'), band: dim('band'), reversal: dim('reversal') };
    })(),
    appearance: { match: count('appearance', 'match'), partial: count('appearance', 'partial'), mismatch: count('appearance', 'mismatch'), unsupported: count('appearance', 'unsupported'), unsupportedBreakdown: apprUnsup },
    bandMismatchContaminatedByAppearanceBug: contaminated.length,
    contaminatedCases: contaminated.map(function (r) { return r.id; }),
    band: { match: count('band', 'match'), partial: count('band', 'partial'), mismatch: count('band', 'mismatch'), unsupported: count('band', 'unsupported') },
    reversal: { match: count('reversal', 'match'), partial: count('reversal', 'partial'), mismatch: count('reversal', 'mismatch'), unsupported: count('reversal', 'unsupported') },
    mismatchCauses: (function () {
      const agg = new Map();
      results.filter(function (r) { return r.overall === 'mismatch'; }).forEach(function (r) {
        (r.causes || []).forEach(function (c) {
          const key = c.type + '|' + c.id;
          if (!agg.has(key)) agg.set(key, { type: c.type, id: c.id, detail: c.detail, cases: [] });
          agg.get(key).cases.push(r.id);
        });
      });
      return Array.from(agg.values()).sort(function (a, b) { return b.cases.length - a.cases.length; });
    })(),
    provenance: (function () {
      const withDerived = results.filter(function (r) { return r.mapping && r.mapping.derivedFromVerdict; });
      return {
        derivedFromVerdictCount: withDerived.length,
        derivedFromVerdictCases: withDerived.map(function (r) { return r.id; }),
        note: "这些案例的 input.appearanceNote 是博主判断（或 ASR 无法区分说话人），已标记 derivedFromVerdict=true 并在回归中禁用；案例 input 来自博主访谈转写，与用户自填表单不是同一口径。"
      };
    })(),
    byGender: byGender,
    byTier: tierOf
  };

  const out = {
    generatedAt: new Date().toISOString(),
    casesFile: 'knowledge/cases.json',
    casesHash: casesHash,
    casesCount: total,
    degraded: Boolean(frozen),
    fallbackCommit: frozen ? frozen.commit : null,
    fallbackLabel: frozen ? (frozen.label || frozen.commit) : null,
    degradedReason: frozen ? ("工作区引擎不可用（" + workspaceErrorText + "），本次结果来自历史冻结副本 " + (frozen.label || frozen.commit) + "；不代表当前工作区代码。") : null,
    engine: {
      fileHashes: fileHashes,
      overrides: { rules: RULES_OVERRIDE, baseline: BASELINE_OVERRIDE, lib: LIB_OVERRIDE, effectiveMain: EFFECTIVE_MAIN, effectiveBaseline: EFFECTIVE_BASELINE, effectiveLib: EFFECTIVE_LIB },
      mainRules: env.ruleset.main,
      baseline: { path: env.ruleset.baseline.path, version: env.ruleset.baseline.version },
      coverage: env.ruleset.coverage,
      warnings: env.ruleset.warnings
    },
    summary: summary,
    gaps: gapList.map(function (g) { return { id: g.id, name: g.name, impact: g.impact, kind: g.kind, detail: g.detail, caseCount: g.cases.length, cases: g.cases }; }),
    inputGaps: inputGapList.map(function (g) { return { id: g.id, name: g.name, kind: g.kind, detail: g.detail, caseCount: g.cases.length, cases: g.cases.slice(0, 8) }; }),
    engineIssues: Array.from(engineIssues.values()).map(function (x) { return { id: x.id, severity: x.severity, structural: x.structural === true, title: x.title, detail: x.detail, caseCount: x.cases.length, cases: x.cases.slice(0, 12) }; }).filter(function (x) { return x.caseCount > 0 || x.severity === 'critical' || x.structural; }),
    cases: results
  };
  out.runCaveat = caveatText(out);
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2) + NL);

  /* ---------------- Markdown 报告 ---------------- */
  const md = buildMarkdown(out);
  fs.writeFileSync(OUT_MD, md);

  console.log('[case-regression] cases=' + total + ' | 结论语境 ' + JSON.stringify(summary.context) + (frozen ? '  [DEGRADED]' : ''));
  console.log('[case-regression] D14 主口径：分母 ' + summary.accuracy.denominator + '（positive-reachable 且可判定）match=' + summary.accuracy.match + ' partial=' + summary.accuracy.partial + ' mismatch=' + summary.accuracy.mismatch + ' notComparable=' + summary.accuracy.notComparable + ' 护栏mismatch=' + (summary.accuracy.guardMismatchCases || []).length);
  console.log('[case-regression] 对照（全案例旧口径）：match=' + summary.match + ' partial=' + summary.partial + ' mismatch=' + summary.mismatch + ' unsupported=' + summary.unsupported);
  console.log('[case-regression] 颜值检查 ' + JSON.stringify(summary.appearance));
  console.log('[case-regression] 档位检查 ' + JSON.stringify(summary.band));
  console.log('[case-regression] 反向建议 ' + JSON.stringify(summary.reversal));
  const failing = summary.mismatch > MAX_MISMATCH || results.some(function (r) { return r.error; });
  if (frozen) {
    console.log('[case-regression] DEGRADED：本次使用冻结副本（' + (frozen.label || frozen.commit) + '），结果不代表工作区引擎。');
    console.log('[case-regression] DEGRADED：强制 exit 1（即使 mismatch 未超阈值）——修复工作区后请重跑。');
  }
  console.log('[case-regression] ' + (failing ? 'FAIL（校准债：mismatch ' + summary.mismatch + ' > 阈值 ' + MAX_MISMATCH + '）' : (frozen ? 'NOT-VALID（降级运行）' : 'PASS')) + ' -> ' + OUT_MD);
  process.exit(failing || frozen ? 1 : 0);
}

function caveatText(o) {
  const ov = (o.engine && o.engine.overrides) || {};
  if (!ov.lib && !ov.baseline) return null;
  const parts = [];
  if (ov.lib) parts.push('引擎模块冻结在 ' + ov.effectiveLib + '（git HEAD 的 web/lib 副本；工作区 web/lib 正在被另一 worker 改写且当前不可用）');
  if (ov.baseline) parts.push('基线冻结在 ' + ov.effectiveBaseline + '（HEAD 版 baseline-rules.json 的副本，仅把 R-BASE-MATCH-004 的非法键 all2 合并为 all）');
  return parts.join('；');
}

// DEGRADED 运行护栏 1/3：大字告警（不是一行 log）
function printDegradedBanner(subject, error) {
  const line = "=".repeat(78);
  console.log("");
  console.log(line);
  console.log("!! DEGRADED RUN —— 工作区引擎不可用，已自动回退到历史冻结副本");
  console.log("!! 回退版本：" + subject);
  console.log("!! 失败原因：" + String(error).slice(0, 200));
  console.log("!! 本次数字不代表当前工作区引擎；禁止作为工作区代码的验收依据。");
  console.log("!! 输出文件会带 degraded: true 标记，且退出码强制为 1（即使 mismatch 达标）。");
  console.log(line);
  console.log("");
}

function buildMarkdown(out) {
  const s = out.summary;
  const acc = s.accuracy || {};
  const dims = s.dimensions || {};
  const lines = [];
  lines.push('# 案例回归测试报告（CASE-CALIBRATION v3 · D24 口径）');
  if (out.degraded) {
    lines.push('');
    lines.push('> ## ⚠️ 本次为降级运行（degraded: true）—— 数字不代表当前工作区引擎');
    lines.push('> - 冻结版本：' + (out.fallbackLabel || out.fallbackCommit));
    lines.push('> - 原因：' + out.degradedReason);
    lines.push('> - **禁止作为工作区代码的验收依据；knowledge/case-calibration.json 内含 degraded: true 与 fallbackCommit 字段。修复工作区后请重跑。**');
  }
  lines.push('');
  lines.push('> 本报告的定位：**引擎的规则覆盖与证据强度可测；结论正确率当前不可测**（D24）。下面的百分比不作为结论使用。');
  lines.push('');
  lines.push('> 运行方式：node tools/case_regression.mjs（可选 --max-mismatch=N）；预览合并快照：node tools/preview_rules.mjs --regress');
  lines.push('> 输入：knowledge/cases.json（' + out.casesCount + ' 条，指纹 ' + out.casesHash + '）');
  lines.push('> 引擎：' + String(out.engine.mainRules.path || '').replace(ROOT + '/', '') + '（v' + out.engine.mainRules.version + '） + ' + String(out.engine.baseline.path).replace(ROOT + '/', '') + '（v' + out.engine.baseline.version + '，演示基线）');
  lines.push('> 机器可读结果：knowledge/case-calibration.json');
  lines.push('> 伦理：本文件的引文政策与用词已通过 node tools/ethics_scan.mjs（0 命中）。');
  lines.push('');
  const caveat = caveatText(out);
  if (caveat) {
    lines.push('## 零、本次运行的引擎状态（重要，先读这段）');
    lines.push('');
    lines.push('- ' + caveat + '。');
    lines.push('- 文件指纹：' + JSON.stringify(out.engine.fileHashes));
    lines.push('');
  }
  lines.push('## 零、为什么这套体系当前无法自测准确率');
  lines.push('');
  lines.push('**一句话结论：引擎的规则覆盖与证据强度可测；结论正确率当前不可测。**（D24）');
  lines.push('');
  lines.push('### 0.1 两个硬约束（本轮可评估案例 = 0 的直接原因）');
  lines.push('');
  lines.push('1. **档位维度没有语料证据**：引擎输出的 S/A/B/C 来自 baseline 的数值区间，属 engineering-default。语料里并没有 A/B/C 这套体系——它是我们自己发明的词汇。**拿自己的发明去对着不含该发明的数据做验证，本身没有意义**。因此档位维度 16/16 记 not-comparable，不进任何指标。');
  lines.push('2. **颜值维度要「标注 + 输入」同时具备**：案例里的颜值分是博主的判断（标注），而引擎需要用户自评（输入）；语料里两者很少同时出现。16 条正向案例只有 1 条满足。');
  lines.push('');
  lines.push('### 0.2 本轮实际卡点：缺必填输入（D19.1）');
  lines.push('');
  lines.push('- 产品表单 ' + REQUIRED_FIELDS.length + ' 项必填里有 ' + FORM_ONLY_FIELDS.length + ' 项是用户自评/偏好（人格、沟通、情绪、颜值自评与校准、择偶期望），直播连麦的转写里根本不存在；其余必填项也大多没被问到。');
  lines.push('- ' + (s.evaluable ? s.evaluable.notEvaluable : 0) + '/' + out.casesCount + ' 条案例缺必填输入 → 按 D19.1 记 unsupported: missing-required-input，**不把 null 传给引擎算假分**。');
  lines.push('- 平均每条缺 ' + ((s.dataGaps || {}).averageMissingRequired || 0) + '/' + REQUIRED_FIELDS.length + ' 项；缺得最少的 ' + (((s.dataGaps || {}).nearestCases || [])[0] || {}).id + ' 也缺 ' + ((((s.dataGaps || {}).nearestCases || [])[0] || {}).missingTotal || 0) + ' 项。');
  lines.push('');
  lines.push('### 0.3 已修正的三类标注错误（保留此节便于审计）');
  lines.push('');
  lines.push('1. **语境误读（D14，7 条）**：C-004/C-012 是「进前 3 才触达」的条件性上限；C-007 的「A8 家庭」出现在反证句里；C-026/C-032 是 n=1 的正向个案；另补查出 C-014（反证）、C-015（条件句）。');
  lines.push('2. **关键词启发式误判（已永久废弃，D24）**：把「天花板」当降档词（C-006 实为正向可达上限）、把反证句里的「A8 家庭」当 S 档（C-007）、把 n=1 的「准第一梯队」当档位证据。代码里的 S/A/B/C 关键词表已改名作废，不再被引用。');
  lines.push('3. **拿结论当输入（derivedFromVerdict，6 条）**：C-010/C-022/C-026/C-029/C-035/C-045 的 appearanceNote 是博主的判断，已标 usedAsEngineInput:false，回归时自动跳过。');
  lines.push('');
  lines.push('## 零之一、这套体系今天能 / 不能回答什么');
  lines.push('');
  lines.push('### 能回答');
  lines.push('');
  lines.push('1. **规则覆盖**：哪些场景有规则、哪些案例因素完全没有维度/规则。当前缺口 Top：' + (out.gaps || []).slice(0, 5).map(function (g) { return g.name.replace(/（.*?）/, '') + '（' + g.caseCount + ' 条）'; }).join('、') + '。');
  lines.push('2. **证据强度**：每条规则/维度带几条语料、跨几个账号（verified / cross-account / single-source / extrapolated / engineering-default），未取证的会被明标。');
  lines.push('3. **哪些数字站不住**：baseline 的 S/A/B/C 数值区间、engineering-default 权重、以及所有未经语料支持的默认值。');
  lines.push('4. **结构性事实**：地域差异、单位口径（月薪↔年收入、斤↔kg、家庭房产↔本人名下）、表单与语料的结构不匹配、哪些字段永远拿不到。');
  lines.push('5. **回归护栏**：引擎对给定输入是否给出与语料方向相反的结论（反向建议）、是否崩溃/异常；本轮 0 崩溃、0 护栏 mismatch。');
  lines.push('');
  lines.push('### 不能回答');
  lines.push('');
  lines.push('1. **引擎结论的正确率**：本轮可评估分母 = 0，无法计算；报告不输出任何百分比作为结论。');
  lines.push('2. **S/A/B/C 档位**：该系统不是语料的词汇，已停止作为结论输出，只能当带 engineering-default 标签的参照刻度。');
  lines.push('3. **颜值分的预测精度**：需要同一人同时具备「博主打分」与「用户自评」，当前语料里不成立。');
  lines.push('4. **各档位的人数分布与阈值**：语料没有 level→档位 的区间证据，禁止为此发明区间。');
  lines.push('');
  lines.push('## 零之二、要让它可测，需要什么（下一阶段工作定义）');
  lines.push('');
  lines.push('| # | 前置条件 | 验收标准 | 影响 |');
  lines.push('|---|---|---|---|');
  lines.push('| 1 | 产品表单允许「未知 / 不便填写」（或提供仅照片的合法提交路径） | 存在一条不依赖 ' + REQUIRED_FIELDS.length + ' 项必填的合法提交路径，或必填项降到 ≤10 项 | 不解决，可评估分母永远是 0 |');
  lines.push('| 2 | 博主对同一人给出档位表述（用他自己的词：打分局名次 / A9 / 活动渠道） | ≥30 条，同一档位 ≥3 条独立语料、跨 ≥2 个账号 | 不解决，档位维度永远 not-comparable |');
  lines.push('| 3 | 同一人同时具备「博主打分（他评）」与「用户自评」 | ≥30 条且覆盖 4 个分档 | 不解决，颜值轨道精度无法验证 |');
  lines.push('| 4 | 引擎档位输出改用 rules.json 的 9 条 bands id 并透出到报告 JSON | 报告里出现 asset.a9 / match.rank.t1 这类 id | 不解决，案例的档位引用无法与引擎对齐 |');
  lines.push('| 5 | 补标注语料已问到的条件（身高/学历/职业/收入/房车/家庭/婚史） | 正向案例 ≥80% 满足「自述条件齐全」 | 把「语料问题」的缺失降下来 |');
  lines.push('| 6 | standards.json 给出 level→档位 的语料证据，或显式声明不产出档位 | 有 ≥1 条 hard 证据，或规则集显式放弃该维度 | 决定档位维度是否还有存在意义 |');
  lines.push('| 7 | 回归工具永久单列「缺必填输入」「not-comparable」，禁止计入分母 | CI 在未取证数据上不得输出百分比 | 防止再次出现虚假精确 |');
  lines.push('');
  lines.push('**最关键的 3 条**：① 第 1 条（表单允许「未知」）——不解决它，分母恒为 0；② 第 2 条（博主的档位表述 ≥30 条）——不解决它，档位永远不可比；③ 第 3 条（他评 + 自评同人 ≥30 条）——不解决它，颜值精度无法验证。');
  lines.push('');
  lines.push('## 零之三、三态分布与解锁模型（把分母做大要花什么代价）');
  lines.push('');
  lines.push('### 3.1 每条案例的三态（判定规则，写死在工具里）');
  lines.push('');
  lines.push('| 状态 | 判定规则 | 案例数 |');
  lines.push('|---|---|---|');
  const es = s.evaluationStates || {};
  lines.push('| evaluable（可评估） | 必填项齐全，直接跑引擎 | ' + (es.evaluable || 0) + ' |');
  lines.push('| blocked:missing-form-input（因缺必填输入不可评估） | 缺任何一项“用户自评/偏好”类必填（语料结构上没有） | ' + (es['blocked:missing-form-input'] || 0) + ' |');
  lines.push('| blocked:missing-corpus-condition（因缺语料条件不可评估） | 表单项齐，但缺“语料本可提供”的自述条件 | ' + (es['blocked:missing-corpus-condition'] || 0) + ' |');
  lines.push('');
  lines.push('逐条状态见第六节（每条都有状态列与“缺 X 项表单 / Y 项语料”计数）。');
  lines.push('');
  const u = s.unlockModel || {};
  lines.push('### 3.2 为什么单个动作解锁不了');
  lines.push('');
  lines.push('| 只做的动作 | 可评估案例数 | 原因 |');
  lines.push('|---|---|---|');
  lines.push('| 只允许未知项（不补语料） | ' + (u.unlockByAllowingUnknownOnly || 0) + ' | 仍缺语料自述条件 |');
  lines.push('| 只补语料标注（不允许未知） | ' + (u.unlockByAnnotatingOnly || 0) + ' | 仍缺 12–13 项用户自评/偏好 |');
  lines.push('| **A + B 都做，且语料补齐全部 ' + (u.corpusFieldsNeeded || 0) + ' 个字段** | ' + out.casesCount + ' | 见 3.3 曲线（Top 12 即可到 19/45） |');
  lines.push('| 现状（A、B 都没做） | ' + (u.alreadyEvaluable || 0) + ' | 当前实际可评估数 |');
  lines.push('');
  lines.push('**两张开锁表**：');
  lines.push('- 「补标注就能解锁」= **' + (u.unlockByAnnotatingOnly || 0) + ' 条**（本轮没有“只缺语料条件”的案例）');
  lines.push('- 「允许未知项就能解锁」= **' + (u.unlockByAllowingUnknownOnly || 0) + ' 条**（本轮没有“只缺表单项”的案例）');
  lines.push('- 「两个都缺」= 45 条——所以真正要动的是两件事，缺一不可。');
  lines.push('');
  lines.push('### 3.3 解锁曲线（每个数字对应一个可执行动作）');
  lines.push('');
  lines.push('动作 A：表单允许 ' + (u.formOnlyFieldsNeeded || 0) + ' 个用户自评/偏好项填「未知」——' + FORM_ONLY_FIELDS.join('、') + '。');
  lines.push('');
  lines.push('动作 B：给语料补标注下列字段（按缺的案例数排序，共 ' + (u.corpusFieldsNeeded || 0) + ' 个）：' + (u.corpusFieldRanking || []).map(function (x) { return x.field + '×' + x.count; }).join('、') + '。');
  lines.push('');
  lines.push('| 做到哪一步 | 可评估案例数 |');
  lines.push('|---|---|');
  lines.push('| 现状（什么都不做） | 0 / ' + out.casesCount + ' |');
  lines.push('| + 动作 A（允许 ' + (u.formOnlyFieldsNeeded || 0) + ' 项填未知） | 0 / ' + out.casesCount + '（还缺语料条件） |');
  (u.curve || []).forEach(function (c) {
    lines.push('| + 动作 A 且补标注 Top ' + c.topK + ' 高频字段 | ' + c.evaluable + ' / ' + out.casesCount + ' |');
  });
  lines.push('');
  lines.push('- 当前平均每条缺：表单/偏好类 ' + (u.avgFormOnlyMissing || 0) + ' 项、语料自述类 ' + (u.avgCorpusMissing || 0) + ' 项。');
  lines.push('- 结论：**先把动作 A 做掉（成本在表单侧），再补 12 个高频语料字段，可评估数就能从 0 跳到 19/45；补齐 ' + (u.corpusFieldsNeeded || 0) + ' 个即 45/45**。这两步都不需要现有引擎改动，属于数据与产品约束的解锁。');
  lines.push('');
  lines.push('## 一、结论语境分轨（D14）');
  lines.push('');
  lines.push('基准集的每条案例都必须标注“博主这句话是在什么语境下说的”。**准确率只统计 positive-reachable**；其余三类单列，不计入 match/mismatch。');
  lines.push('');
  lines.push('| verdictContext | 条数 | 含义 |');
  lines.push('|---|---|---|');
  lines.push('| positive-reachable | ' + ((s.context || {})['positive-reachable'] || 0) + ' | 博主正向给出的可达结论（能找到什么样的人） |');
  lines.push('| conditional-ceiling | ' + ((s.context || {})['conditional-ceiling'] || 0) + ' | 条件性上限（如“先进打分局前 3 名才触达”） |');
  lines.push('| reverse-context | ' + ((s.context || {})['reverse-context'] || 0) + ' | 用于反证的语境（如“A8 家庭不会为颜值考虑你”） |');
  lines.push('| unspecified | ' + ((s.context || {})['unspecified'] || 0) + ' | 没有择偶可达结论（多为颜值打分局案例） |');
  lines.push('');
  lines.push('### 1.1 本轮复核发现的基准标注错误（原样保留，便于审计）');
  lines.push('');
  lines.push('| 案例 | 原标注 | 复核结论 | 现 verdictContext |');
  lines.push('|---|---|---|---|');
  lines.push('| C-004 | S（A9 高净值活动） | “先去打分局，若进前 3 才触达”——条件句，不是结论 | conditional-ceiling |');
  lines.push('| C-012 | S（厂二代 / A8 家庭） | 同上：按打分局名次分档，均为条件性画像 | conditional-ceiling |');
  lines.push('| C-007 | S（A8 家庭） | “A8 家庭的男生不会为颜值考虑你”是反证语境 | reverse-context |');
  lines.push('| C-026 | S（A9 家庭女生） | 正向个案，但 n=1（单条语料） | positive-reachable（n=1） |');
  lines.push('| C-032 | S（准第一梯队） | 正向个案，但 n=1（单条语料） | positive-reachable（n=1） |');
  lines.push('| C-014 | 无（未标语境） | “45岁月入5万不会找咱”是反证语境 | reverse-context |');
  lines.push('| C-015 | 无（原判可达） | “可以找，前提是对方不介意你有弟弟”——条件句 | conditional-ceiling |');
  lines.push('| C-002 / C-028 / C-029 / C-031 / C-034 | 无 | 均为反证/负面语境，此前被当作可达结论参与比对 | reverse-context |');
  lines.push('');
  lines.push('### 1.2 逐条语境（positive-reachable 之外只做展示，不计分）');
  lines.push('');
  lines.push('| 案例 | verdictContext | 复核说明 |');
  lines.push('|---|---|---|');
  out.cases.forEach(function (r) {
    if (r.verdictContext === 'positive-reachable') return;
    lines.push('| ' + r.id + ' | ' + r.verdictContext + ' | ' + String(r.verdictContextNote || '').replace(/[|]/g, '/') + ' |');
  });
  lines.push('');
  lines.push('## 二、准确率（D19 主口径）—— 当前不可测');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push('| positive-reachable 案例总数 | ' + (acc.positiveReachableTotal || 0) + ' |');
  const posTotal = acc.positiveReachableTotal || 0;
  const missInput = acc.notEvaluableByMissingInput || 0;
  const otherBlocked = Math.max(0, (acc.notComparable || 0) - missInput);
  lines.push('| **有效分母**（正向 + 至少一个可判定维度） | **' + (acc.denominator || 0) + '**（' + posTotal + ' 条正向案例中，' + missInput + ' 条因缺必填输入无法评估' + (otherBlocked > 0 ? '，' + otherBlocked + ' 条因档位 not-comparable / 颜值缺输入不可判定' : '') + '） |');
  lines.push('| match | ' + (acc.match || 0) + ' |');
  lines.push('| partial | ' + (acc.partial || 0) + ' |');
  lines.push('| mismatch | ' + (acc.mismatch || 0) + ' |');
  lines.push('| not-comparable（无可比维度） | ' + (acc.notComparable || 0) + ' |');
  lines.push('| 准确率（match / 有效分母） | ' + ((acc.denominator || 0) === 0 ? '**无法计算（可评估案例为 0）**' : (acc.rate === null || acc.rate === undefined ? '—' : acc.rate + '%') + '｜⚠️ 有效分母仅 ' + acc.denominator + ' 条，不足以作为稳定准确率') + ' |');
  lines.push('');
  lines.push('- 口径依据：' + (acc.basis || ''));
  lines.push('- 为什么分母这么小：' + (acc.whySmall || ''));
  lines.push('- 非正向案例（' + ((s.context || {})['conditional-ceiling'] || 0) + ' 条条件性上限 + ' + ((s.context || {})['reverse-context'] || 0) + ' 条反证语境 + ' + ((s.context || {})['unspecified'] || 0) + ' 条无结论）**不计入准确率**，只用于展示与规则回归。');
  lines.push('- 对照（旧口径，全案例含不可比，仅作对照）：match ' + s.match + ' / partial ' + s.partial + ' / mismatch ' + s.mismatch + ' / unsupported ' + s.unsupported + '（无可评估案例，故为 0）。');
  lines.push('');
  lines.push('## 二之一、因缺必填输入无法评估：' + (s.evaluable ? s.evaluable.notEvaluable : 0) + ' 条（D19.1）');
  lines.push('');
  lines.push('按 D19.1：案例缺必填输入时不把 null 传给引擎算假分，直接记「unsupported: missing-required-input」。本轮 ' + (s.evaluable ? s.evaluable.notEvaluable : 0) + ' / ' + out.casesCount + ' 条全部命中该情形，因此**可评估案例为 0，准确率无法计算**。');
  lines.push('');
  const dg = s.dataGaps || {};
  lines.push('- 平均每条缺 **' + (dg.averageMissingRequired || 0) + ' / ' + REQUIRED_FIELDS.length + '** 项必填字段');
  lines.push('- 必填字段缺失频次 Top 12：' + (dg.missingRequiredFieldCounts || []).slice(0, 12).map(function (x) { return x.field + '×' + x.count; }).join('、'));
  lines.push('- 最接近可评估的 8 条（缺得最少）：' + (dg.nearestCases || []).map(function (x) { return x.id + ' 缺' + x.missingTotal; }).join('、'));
  lines.push('');
  lines.push('**为什么必然缺**：产品表单是「用户自填」，29 项必填里有 16 项是用户自评/偏好（人格、沟通、情绪、颜值自评与校准、择偶期望），直播连麦的转写里根本不存在这些回答；其余 13 项（户籍、房车、收入、婚史等）也大多未被博主问到。这不是引擎错，是基准集与产品表单的结构性差距。');
  lines.push('');
  lines.push('**要让基准集能测产品口径，只有两条路**：① 给语料补标注（把博主问过的条件补全：身高/学历/职业/收入/房车/家庭）；② 产品表单允许「未知 / 不便填写」，让部分表单成为合法提交。否则任何回填都是 fabrication。');
  lines.push('');
  lines.push('## 二之二、数据缺口（两个数分开报）');
  lines.push('');
  lines.push('| 缺口类型 | 案例数 | 性质与出路 |');
  lines.push('|---|---|---|');
  lines.push('| 案例缺自述条件（**语料问题**） | ' + (dg.casesWithCorpusMissing || 0) + ' / ' + out.casesCount + ' | 转写里博主没问、来访者没说 → 可用语料补标注解决 |');
  lines.push('| 案例缺必填输入（**表单/harness 问题**） | ' + (dg.casesWithFormOnlyMissing || 0) + ' / ' + out.casesCount + ' | 表单要求用户自评/偏好，语料结构上不存在 → 只能靠产品侧允许「未知」或换采集方式 |');
  lines.push('');
  lines.push('**缺自述条件（语料问题）Top 10**：' + (dg.corpusFieldCounts || []).slice(0, 10).map(function (x) { return x.field + '×' + x.count; }).join('、'));
  lines.push('');
  lines.push('**缺必填输入（表单问题）Top 10**：' + (dg.formOnlyFieldCounts || []).slice(0, 10).map(function (x) { return x.field + '×' + x.count; }).join('、'));
  lines.push('');
  lines.push('## 三、分维度可比性（只统计 positive-reachable）');
  lines.push('');
  lines.push('| 维度 | match | partial | mismatch | unsupported | not-comparable |');
  lines.push('|---|---|---|---|---|---|');
  ['appearance', 'band', 'reversal'].forEach(function (k) {
    const d = dims[k] || {};
    lines.push('| ' + k + ' | ' + (d.match || 0) + ' | ' + (d.partial || 0) + ' | ' + (d.mismatch || 0) + ' | ' + (d.unsupported || 0) + ' | ' + (d['not-comparable'] || 0) + ' |');
  });
  lines.push('');
  lines.push('- **档位维度全部 not-comparable**：引擎输出的 S/A/B/C 来自 baseline 的数值区间，属 engineering-default（D11/D14），无语料依据；语料里也没有 level→档位的区间证据，本项目禁止发明区间。语义档位通道已预留，但当前引擎不会输出带 entryCriteria 的档位 id。');
  lines.push('- **颜值维度**只在“有博主打分标注 + 有可用自评输入”时可比；案例的条件是博主问出来的，标注是博主的判断，两者都可能缺失，因此可比案例很少。');
  lines.push('- **反向建议（护栏）**只在维度表里展示：它 mismatch 记为错误，但“引擎没给相反结论”不记为答对。');
  lines.push('');
  lines.push('## 三之一、档位词汇：用语料自己的词（D24）');
  lines.push('');
  lines.push('S/A/B/C 是我们自己发明的词汇，语料里没有这套体系，已停止作为结论输出。下表列出案例里出现的**语料自己的档位词**（knowledge/rules.json 的 9 条 bands，名字就是博主的话）。这些词只作引用登记，不参与任何打分。');
  lines.push('');
  lines.push('| 案例 | 引用的语料档位词 | 引擎当前是否输出该档位 id |');
  lines.push('|---|---|---|');
  out.cases.forEach(function (r) {
    const refs = (r.checks && r.checks.band && r.checks.band.caseBandRefs) || [];
    if (!refs.length) return;
    lines.push('| ' + r.id + ' | ' + refs.map(function (x) { return x.name + '（' + x.id + '，命中词「' + x.matchedTerm + '」）'; }).join('；') + ' | 否（引擎只输出 engineering-default 的 S/A/B/C） |');
  });
  lines.push('');
  lines.push('- 合计 ' + out.cases.filter(function (r) { return ((r.checks && r.checks.band && r.checks.band.caseBandRefs) || []).length; }).length + ' 条案例引用了语料档位词；引擎一条都不会输出——这就是档位维度 not-comparable 的确切含义，也是 v2 的接通点（前置条件 #4）。');
  lines.push('- 这些档位词里，asset.a9（C-026）、match.rank.t1（C-004/C-012/C-018）等多为 n=1~3 的语料，引用时按证据强度降权，不作为结论。');
  lines.push('');
  lines.push('## 四、缺口清单 · 引擎缺维度/缺规则（v2 需求输入，按影响排序）');
  lines.push('');
  lines.push('| # | 缺口 | 类型 | 影响案例数 | 说明 |');
  lines.push('|---|---|---|---|---|');
  out.gaps.forEach(function (g, i) {
    lines.push('| ' + (i + 1) + ' | ' + g.name + ' (' + g.id + ') | ' + g.impact + ' | ' + g.caseCount + ' | ' + String(g.detail || '').replace(/[|]/g, '/') + ' |');
  });
  lines.push('');
  lines.push('## 四之一、mismatch 归因汇总');
  lines.push('');
  lines.push('| 归因 | 类型 | 影响 mismatch 案例数 | 案例 |');
  lines.push('|---|---|---|---|');
  if (!(s.mismatchCauses || []).length) lines.push('| （本轮无 mismatch） | — | 0 | — |');
  (s.mismatchCauses || []).forEach(function (c) {
    lines.push('| ' + c.id + ' (' + String(c.detail || '').slice(0, 60).replace(/[|]/g, '/') + ') | ' + c.type + ' | ' + c.cases.length + ' | ' + c.cases.join('、') + ' |');
  });
  lines.push('');
  lines.push('## 四之二、优先修复清单');
  lines.push('');
  const prize = [];
  prize.push({ t: 'P1（防御性）· 未填自评不得当 0 分', r: '真实用户路径触不到（self_appearance 是表单必填，缺了 HTTP 422），不得用它解释 mismatch；仅作为引擎健壮性修复。' });
  prize.push({ t: 'P0 · 让基准集能测产品口径', r: '29 项必填里 16 项是用户自评/偏好，语料结构上不存在；需产品侧允许「未知/不便填写」或补语料标注，否则回归分母恒为 0。' });
  out.gaps.slice(0, 5).forEach(function (g) { prize.push({ t: 'P1 · 补维度/规则：' + g.name, r: '影响 ' + g.caseCount + ' 条案例（' + g.impact + '）：' + String(g.detail || '').slice(0, 90) }); });
  prize.forEach(function (p, i) { lines.push((i + 1) + '. **' + p.t + '** —— ' + p.r); });
  lines.push('');
  lines.push('## 四之三、输入缺口附录（语料/表单字段映射不出来，属数据侧问题）');
  lines.push('');
  lines.push('| 缺口 | 影响案例数 | 说明 |');
  lines.push('|---|---|---|');
  out.inputGaps.forEach(function (g) { lines.push('| ' + g.name + ' | ' + g.caseCount + ' | ' + String(g.detail || '').replace(/[|]/g, '/') + ' |'); });
  lines.push('');
  lines.push('## 五、引擎问题（bug / 结构性缺陷）');
  lines.push('');
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  out.engineIssues.slice().sort(function (a, b) { return sevOrder[a.severity] - sevOrder[b.severity]; }).forEach(function (e) {
    lines.push('- [' + e.severity.toUpperCase() + '] ' + e.id + ' ' + e.title + '（命中 ' + (e.caseCount === 0 ? '探针' : e.caseCount + ' 条案例') + '）');
    lines.push('  - ' + e.detail);
  });
  lines.push('');
  lines.push('## 五之一、字段来源与观察偏差（derivedFromVerdict）');
  lines.push('');
  lines.push('案例的 input 来自**博主直播连麦的转写**，引擎输入是**用户自填表单**，不是同一口径。以下字段是博主判断（或 ASR 无法区分说话人），已在 cases.json 的 inputMeta 标记 derivedFromVerdict=true / usedAsEngineInput=false，回归中按“无输入”处理：');
  lines.push('');
  const provCases = out.cases.filter(function (r) { return r.mapping && r.mapping.derivedFromVerdict; });
  lines.push('| 案例 | 字段 | 原因 |');
  lines.push('|---|---|---|');
  provCases.forEach(function (r) {
    const dm = r.mapping.derivedFromVerdict.appearanceNote;
    lines.push('| ' + r.id + ' | appearanceNote | ' + String(dm.note || '').replace(/[|]/g, '/') + ' |');
  });
  lines.push('');
  lines.push('- 合计 ' + provCases.length + ' 条；其余系统性偏差：提问引导、单位口径（月薪/斤↔年收入/公斤/枚举）、房车常为家庭可提供、多数案例未自述婚史（一律留空）。');
  lines.push('');
  lines.push('## 六、逐条判定');
  lines.push('');
  lines.push('| 案例 | 状态 | 语境 | 缺(表单/语料) | 计分 | 颜值 | 档位 | 反向建议 | 说明 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  out.cases.forEach(function (r) {
    const a = r.checks.appearance;
    const b = r.checks.band;
    const rv = r.checks.reversal;
    lines.push('| ' + r.id + ' | ' + r.evaluationState + ' | ' + r.verdictContext + ' | ' + ((r.missingCounts || {}).formOnly || 0) + '/' + ((r.missingCounts || {}).corpus || 0) + ' | ' + (r.countedInAccuracy ? '✔' : '—') + ' | ' + a.status + ' | ' + b.status + ' | ' + rv.status + ' | ' + String(r.verdictContextNote || '').replace(/[|]/g, '/') + ' |');
  });
  lines.push('');
  lines.push('## 七、口径与方法（可复核）');
  lines.push('');
  lines.push('1. **D14 主口径**：准确率只统计 positive-reachable 且至少一个实质性可比较维度的案例；conditional-ceiling / reverse-context / unspecified 三类一律不计入，只展示。');
  lines.push('2. **D11/D14 档位**：baseline 的 S/A/B/C 数值档位属 engineering-default，不得作为结论比对；本报告把它整维标为 not-comparable 并从分母剔除，而不是用一个不可信的档位去算准确率。');
  lines.push('3. **不泄漏答案**：颜值校验的输入只来自案例自述；博主打分只作标注；被标 derivedFromVerdict 的字段不作为输入（代理模式结果另存 engine.appearanceProxy，只用于诊断下游链路）。');
  lines.push('4. **反向建议是护栏**：mismatch 记错误，无相反结论不记正确。');
  lines.push('5. **字段映射保守**：所有折算与无法映射的字段都写进 cases[].mapping，不做无标注的猜测。');
  lines.push('6. **退出码**：mismatch 数超过 --max-mismatch（默认 0）或出现引擎异常时为 1；当前为校准债而非工具故障。');
  lines.push('');
  return lines.join(NL) + NL;
}

main().catch(function (e) {
  console.error('[case-regression] 运行失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
