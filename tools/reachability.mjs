#!/usr/bin/env node
// 可达字段扫描器（reachability）：找出 machine.when / then 里引用了「永远不可能被赋值」的字段。
//
//   node tools/reachability.mjs            # 生成 knowledge/reachable-fields.json 并扫描 rules.json
//   node tools/reachability.mjs --json     # 输出机器可读结果
//   node tools/reachability.mjs --strict   # 存在死条件时 exit 1（供 CI/preflight 选用）
//   node tools/reachability.mjs <rules.json 路径>
//
// 存在理由：check_rules 只验「字段在 facts.json 里声明过」，而声明过 ≠ 运行期会注入。
// R-LOOKS-014 的 5 个 photo.face.* 就是「声明过但永不注入」的典型：规则看起来可执行，实际靠兜底才触发。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const K = join(ROOT, 'knowledge');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const strict = args.includes('--strict');
const noWrite = args.includes('--no-write');
const target = args.find((a) => !a.startsWith('--')) || join(K, 'rules.json');

const { loadRuleset } = await import('file://' + join(ROOT, 'web', 'lib', 'ruleset.mjs'));
const form = JSON.parse(readFileSync(join(ROOT, 'web', 'config', 'form-fields.json'), 'utf8'));
const ruleset = loadRuleset({
  mainPath: join(K, 'rules.json'),
  baselinePath: join(ROOT, 'web', 'config', 'baseline-rules.json'),
});
const dims = ruleset.dimensions || [];

// —— 可达字段的权威构造（与 web/lib/pipeline.mjs#buildFacts / buildPhotoFacts 保持同步）——
// 1) 表单直接可赋值
const formPaths = (form.fields || []).map((f) => 'subject.' + f.id);
// 2) 派生字段（buildFacts 计算注入）
const derivedPaths = [
  'want.appearance_gap', 'want.height_gap', 'want.age_gap_older', 'want.age_gap_younger',
  'appearance.final.low', 'appearance.final.high', 'appearance.final.mid', 'appearance.final.consensus',
  'appearance.divergence', 'appearance.divergenceAbs',
  'appearance.selfTrack.raw', 'appearance.selfTrack.adjusted', 'appearance.selfTrack.low', 'appearance.selfTrack.high',
  'appearance.photoTrack.low', 'appearance.photoTrack.high',
  'hardware.score', 'soft.score', 'context.city', 'context.cityTier',
];
const breakdownPrefixes = ['hardware.breakdown.', 'soft.breakdown.'];
// 3) 照片轨道注入：pipeline 只把 group=appearance 且非 web-baseline 的维度送进模型，注入键 photo.<dimId>
const photoKeys = dims
  .filter((d) => d.group === 'appearance' && d._origin !== 'web-baseline')
  .map((d) => 'photo.' + d.id);
// 4) 旧命名/内部字段：永不注入
const legacyMap = {
  'photo.face.three_courts': 'photo.looks.three_courts',
  'photo.face.features_balance': 'photo.looks.features_balance',
  'photo.face.dental_arch': 'photo.looks.dental_arch',
  'photo.face.head_shoulder_ratio': 'photo.looks.head_shoulder_ratio',
  'photo.face.facial_fold': 'photo.looks.facial_fold',
  'photo.face.craniofacial_ratio': 'photo.looks.craniofacial_ratio',
  'photo.face.face_size': 'photo.looks.face_size',
  'photo.face.nose': 'photo.looks.nose',
  'photo.face.profile': 'photo.looks.profile',
  'photo.face.eye_brow_symmetry': null,
  'photo.face.skin': 'photo.looks.skin',
  'photo.body.height': 'photo.looks.height',
  'photo.body.weight': 'photo.looks.weight',
  'photo.body.figure': 'photo.looks.figure_ratio',
  'photo.style.grooming': 'photo.looks.grooming',
  'photo.style.hair': null,
  'photo.style.makeup': null,
  'photo.presence.posture': 'photo.looks.posture_presence',
};
const canonicalSet = new Set(photoKeys);
const aliasMap = {};
const neverPaths = ['context.cityMatched', 'context.gender'];
for (const [legacy, canon] of Object.entries(legacyMap)) {
  if (canon && canonicalSet.has(canon)) aliasMap[legacy] = canon;
  else { aliasMap[legacy] = null; neverPaths.push(legacy); }
}

const reachableDoc = {
  version: '1.0',
  generatedAt: new Date().toISOString(),
  purpose: 'machine.when / then 可引用字段的可达性权威清单（tools/reachability.mjs 生成）。判据=运行期真正会注入的键，而非"声明过"的键。',
  sources: {
    form: 'web/config/form-fields.json',
    derived: 'web/lib/pipeline.mjs#buildFacts（want/appearance/hardware/soft/context）',
    photo: 'ruleset dimensions(group=appearance, 非 web-baseline) → 运行期注入键 photo.<dimId>',
  },
  categories: {
    'form-direct': formPaths,
    'derived': derivedPaths,
    'breakdown-prefixes': breakdownPrefixes,
    'photo-track': photoKeys,
    'never': neverPaths,
  },
  aliasMap,
  counts: {
    form: formPaths.length,
    derived: derivedPaths.length,
    breakdownPrefixes: breakdownPrefixes.length,
    photo: photoKeys.length,
    never: neverPaths.length,
  },
  notes: [
    'photo 轨道只注入 ruleset appearance 维度的 id；facts.json 的 photoFacts 以 rules.json appearance 维度为准。',
    'photo.face.*/photo.body.*/photo.style.*/photo.presence.* 是 photo-dimensions.json 的历史命名，除 three_courts 外与运行期不一致 → 见 aliasMap（null=永不注入）。',
    'photo.dim.face_score / photo.dim.body_shape / photo.dim.grooming 因 group=appearance 也会被注入（可达但非 canonical，不建议新规则引用）。',
    'hardware.breakdown.* / soft.breakdown.* 为动态前缀，引擎按前缀匹配。',
  ],
};
if (!noWrite) writeFileSync(join(K, 'reachable-fields.json'), JSON.stringify(reachableDoc, null, 2));

// —— 扫描 ——
const reachable = new Set([...formPaths, ...derivedPaths, ...photoKeys]);
const isReachable = (field) =>
  reachable.has(field) || breakdownPrefixes.some((p) => String(field).startsWith(p));

function collectRefs(node, out) {
  if (node == null) return;
  if (Array.isArray(node)) return node.forEach((x) => collectRefs(x, out));
  if (typeof node === 'string') {
    if (/^(subject|context|appearance|hardware|soft|want|photo).[A-Za-z0-9_.<>]+$/.test(node)) out.add(node);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'field' && typeof v === 'string') out.add(v);
    else collectRefs(v, out);
  }
}

function satisfiable(cond) {
  if (cond == null) return true;
  if (typeof cond === 'string') return false; // 引擎对字符串条件直接返回 false
  if (Array.isArray(cond)) return cond.every(satisfiable);
  if (typeof cond !== 'object') return false;
  if (cond.field !== undefined) return isReachable(String(cond.field));
  if (Array.isArray(cond.all)) return cond.all.every(satisfiable);
  if (Array.isArray(cond.any)) return cond.any.some(satisfiable);
  if (cond.not !== undefined) return true; // 保守：not 视为可满足
  return true;
}

const rules = JSON.parse(readFileSync(target, 'utf8')).rules || [];
const rows = [];
let execTotal = 0, clean = 0, partial = 0, full = 0;
for (const r of rules) {
  const isExec = !!(r.machine && r.machine.when !== undefined);
  const whenRefs = new Set();
  const thenRefs = new Set();
  if (isExec) collectRefs(r.machine.when, whenRefs);
  if (r.machine && r.machine.then !== undefined) collectRefs(r.machine.then, thenRefs);
  const deadWhen = [...whenRefs].filter((f) => !isReachable(f));
  const deadThen = [...thenRefs].filter((f) => !isReachable(f));
  let cls = 'advisory';
  if (isExec) {
    execTotal++;
    if (!satisfiable(r.machine.when)) { cls = 'fully-unreachable'; full++; }
    else if (deadWhen.length || deadThen.length) { cls = 'partial'; partial++; }
    else { cls = 'clean'; clean++; }
  }
  if (deadWhen.length || deadThen.length || cls === 'fully-unreachable') {
    rows.push({
      ruleId: r.id, scope: r.scope, executable: isExec, class: cls,
      whenSatisfiable: isExec ? satisfiable(r.machine.when) : null,
      deadWhenFields: deadWhen, deadThenFields: deadThen,
      whenFields: [...whenRefs], thenFields: [...thenRefs],
    });
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  rulesFile: target,
  counts: { rules: rules.length, executable: execTotal, clean, partial, fullyUnreachable: full, trueExecutable: execTotal - full },
  rows,
};
if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  console.log('=== reachability ===');
  console.log(`rules ${rules.length} | executable ${execTotal} | clean ${clean} | partial ${partial} | fully-unreachable ${full} | true-executable ${execTotal - full}`);
  for (const r of rows) {
    console.log(`  [${r.class}] ${r.ruleId}`);
    if (r.deadWhenFields.length) console.log('    dead-when: ' + r.deadWhenFields.join(', '));
    if (r.deadThenFields.length) console.log('    dead-then: ' + r.deadThenFields.join(', '));
  }
  console.log('reachable-fields.json → knowledge/reachable-fields.json');
}

if (strict && (partial || full)) process.exit(1);
