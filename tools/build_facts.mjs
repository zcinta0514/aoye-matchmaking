#!/usr/bin/env node
// 从 web/config/form-fields.json + 引擎的 buildFacts 结构，生成权威字段字典 knowledge/facts.json。
// 目的：规则里的 machine.when.field 只能引用这里的路径，彻底避免"字段名对不上导致规则不执行"。
//   node tools/build_facts.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FF = join(ROOT, 'web', 'config', 'form-fields.json');
const OUT = join(ROOT, 'knowledge', 'facts.json');

const ff = JSON.parse(readFileSync(FF, 'utf8'));
const facts = [];

for (const f of ff.fields) {
  const enumVals = f.options ? f.options.map((o) => o.value) : null;
  const valueLabels = f.options ? Object.fromEntries(f.options.map((o) => [o.value, o.label])) : null;
  facts.push({
    field: `subject.${f.id}`,
    id: f.id,
    label: f.label,
    group: f.group,
    type: f.type === 'number' || f.type === 'scale' ? 'number' : f.type === 'radio' || f.type === 'select' ? 'enum' : 'string',
    required: !!f.required,
    unit: f.unit || null,
    min: typeof f.min === 'number' ? f.min : null,
    max: typeof f.max === 'number' ? f.max : null,
    values: enumVals,
    valueLabels,
    source: 'web/config/form-fields.json',
  });
}

// 知识侧补充字段（案例回归校准量化出的缺口）。
// 动态告警：只对「表单仍未吸收」的补充字段告警——一旦 webapp 吸收进表单，告警自动消失。
// （静态告警会过期：此前 photo.* 与 D15 三字段的告警都曾变成「喊狼来了」。）
const webFormIds = new Set(ff.fields.map((f) => f.id));
const pendingAbsorption = [];
let extraCount = 0;
const EF = join(ROOT, 'knowledge', 'extra-fields.json');
if (existsSync(EF)) {
  try {
    const ef = JSON.parse(readFileSync(EF, 'utf8'));
    for (const f of ef.fields || []) {
      if (facts.some((x) => x.field === `subject.${f.id}`)) continue;
      if (!webFormIds.has(f.id)) pendingAbsorption.push(f.id);
      facts.push({
        field: `subject.${f.id}`,
        id: f.id,
        label: f.label,
        group: f.group,
        type: f.type === 'number' ? 'number' : f.type === 'select' || f.type === 'radio' ? 'enum' : 'string',
        required: !!f.required,
        values: f.options ? f.options.map((o) => o.value) : null,
        valueLabels: f.options ? Object.fromEntries(f.options.map((o) => [o.value, o.label])) : null,
        gapImpact: f.gapImpact || null,
        note: f.note || null,
        source: 'knowledge/extra-fields.json',
        formAbsorbed: webFormIds.has(f.id),
      });
      extraCount++;
    }
  } catch (e) { console.error('   ! extra-fields.json 解析失败:', e.message); }
}

// 引擎 buildFacts 额外暴露的派生字段（见 web/lib/pipeline.mjs buildFacts）
const computed = [
  { field: 'appearance.final.low', label: '颜值分区间下界', type: 'number', note: '照片+自评校准后的区间' },
  { field: 'appearance.final.high', label: '颜值分区间上界', type: 'number' },
  { field: 'appearance.final.mid', label: '颜值分区间中值', type: 'number' },
  { field: 'appearance.final.consensus', label: '自评与照片是否一致', type: 'boolean' },
  { field: 'appearance.divergence', label: '自评分−照片分', type: 'number' },
  { field: 'appearance.divergenceAbs', label: '分歧绝对值', type: 'number' },
  // ⚠️ selfTrack / photoTrack 在运行时是**对象**（{raw, adjusted, low, high, reasons}），不是数字。
  // 之前这里标成 number，任何拿它做数值比较的规则都会静默失效。现改为仅暴露标量子路径。
  { field: 'appearance.selfTrack.raw', label: '自评轨道原始分', type: 'number' },
  { field: 'appearance.selfTrack.adjusted', label: '自评轨道校准后分', type: 'number' },
  { field: 'appearance.selfTrack.low', label: '自评轨道区间下界', type: 'number' },
  { field: 'appearance.selfTrack.high', label: '自评轨道区间上界', type: 'number' },
  { field: 'appearance.photoTrack.low', label: '照片轨道区间下界', type: 'number' },
  { field: 'appearance.photoTrack.high', label: '照片轨道区间上界', type: 'number' },
  { field: 'hardware.score', label: '硬件总分', type: 'number', note: '受 composites 定义影响' },
  { field: 'hardware.breakdown.<dimId>', label: '单个硬件维度得分', type: 'number', note: '<dimId> 取 knowledge/rules.json 中 dimensions[].id' },
  { field: 'soft.score', label: '软性总分', type: 'number' },
  { field: 'soft.breakdown.<dimId>', label: '单个软性维度得分', type: 'number' },
  { field: 'context.cityTier', label: '城市档（一线/新一线/二三线等）', type: 'enum' },
  { field: 'context.city', label: '引擎解析后的城市名', type: 'string', note: '与 subject.city 的区别：这是引擎规范化后的值（含别名匹配）。规则优先用 subject.city。' },
  { field: 'want.appearance_gap', label: '期望颜值 − 实际颜值上界', type: 'number', note: '正数=期望过高' },
  { field: 'want.height_gap', label: '期望身高 − 实际身高', type: 'number', note: '正数=要求比自己高' },
  { field: 'want.age_gap_older', label: '可接受最大年龄 − 实际年龄', type: 'number' },
  { field: 'want.age_gap_younger', label: '实际年龄 − 可接受最小年龄', type: 'number' },
];
for (const c of computed) facts.push(Object.assign({ source: 'web/lib/pipeline.mjs buildFacts' }, c));

// 照片维度：以**运行期真正会注入的键**为准。
// pipeline.buildPhotoFacts 注入 photo.<ruleset dimension id>（group=appearance，且排除 web-baseline 维度）。
// facts.json 必须与运行期一致，否则规则会引用到"声明过但永不注入"的字段（本项目踩过的坑）。
let photoDims = [];
const photoWarnings = [];
{
  const RJ = join(ROOT, 'knowledge', 'rules.json');
  if (existsSync(RJ)) {
    try {
      const rd = JSON.parse(readFileSync(RJ, 'utf8'));
      photoDims = (rd.dimensions || [])
        .filter((d) => d.group === 'appearance')
        .map((d) => ({ field: `photo.${d.id}`, id: d.id, label: d.name || d.id, type: 'enum', values: null, source: 'knowledge/rules.json dimension(group=appearance) → 运行期注入键 photo.<id>' }));
      photoWarnings.push('photo 维度以 knowledge/rules.json 的 appearance 维度为准（运行期注入键）；knowledge/photo-dimensions.json 中未在 ruleset 定义的 face.eye_brow_symmetry / style.hair / style.makeup 不会注入，已从字典剔除。');
    } catch {}
  }
}

const doc = {
  version: '1.0',
  generatedAt: new Date().toISOString(),
  purpose: '规则中 machine.when.field 的唯一合法取值来源。写规则前先查这里；缺字段就往这里加，不要在规则里发明字段名。',
  counts: {
    subjectFields: facts.filter((f) => f.field.startsWith('subject.')).length,
    fromWebForm: facts.filter((f) => f.source === 'web/config/form-fields.json').length,
    fromKnowledgeExtra: extraCount,
    computedFields: computed.length,
    photoDimensions: photoDims.length,
  },
  facts,
  photoFacts: photoDims,
  ops: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'between', 'exists', 'missing', 'includes', 'matches'],
  actions: ['clampScale', 'setBand', 'advice', 'giveUp', 'text', 'flag', 'requireEvidence'],
  internalFactsNotForRules: [
    'context.cityMatched（引擎内部的城市匹配细节，规则不得依赖它）',
    'context.gender（与 subject.gender 重复——两条路径指向同一事实是陷阱，已要求 webapp 移除）',
  ],
  warnings: [
    'appearance.selfTrack / photoTrack 是对象（{raw, adjusted, low, high, reasons}），只能用其标量子路径（.raw/.adjusted/.low/.high）做数值比较。',
    ...photoWarnings,
    ...(pendingAbsorption.length
      ? [`补充字段待表单吸收（引用它们的 machine 规则目前静默失效）：${pendingAbsorption.join(' / ')}`]
      : []),
  ],
};

writeFileSync(OUT, JSON.stringify(doc, null, 2));
console.log(`[facts] 生成 ${OUT}`);
console.log(`  subject 字段 ${doc.counts.subjectFields} 个（表单 ${doc.counts.fromWebForm} + 知识补充 ${doc.counts.fromKnowledgeExtra}）/ 派生 ${doc.counts.computedFields} 个 / 照片维度 ${doc.counts.photoDimensions} 个`);
if (pendingAbsorption.length) {
  console.log(`  ⚠ 待表单吸收 ${pendingAbsorption.length} 个（规则引用它们会静默失效）：${pendingAbsorption.join(' / ')}`);
} else if (doc.counts.fromKnowledgeExtra) {
  console.log('  ✓ 知识补充字段已全部被表单吸收');
}
