#!/usr/bin/env node
// 校验 knowledge/rules.json：结构合规 + 证据可追溯（aweme_id 必须真实存在于语料清单）。
//   node tools/check_rules.mjs [path]   /   --merge 把 knowledge/rules.part.*.json 合并成 rules.json 再校验
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const M_DIR = join(ROOT, 'data', 'meta', 'manifests');
const T_DIR = join(ROOT, 'data', 'transcripts');

// 转写全文缓存（用于引文溯源）
const txCache = new Map();
function transcript(account, aweme_id) {
  const k = account + '/' + aweme_id;
  if (txCache.has(k)) return txCache.get(k);
  const p = join(T_DIR, account, `${aweme_id}.txt`);
  const t = existsSync(p) ? readFileSync(p, 'utf8') : null;
  txCache.set(k, t);
  return t;
}
// 归一化：去标点/空白，只留汉字与基本字符
const norm = (s) => String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');

// 滑窗字符集匹配：对转写中每个长度≈片段长度的窗口，算字符多重集交集比例，取最大。
// 对 ASR 替换字（庭→平）和局部乱序宽容，但对“完全不同的内容”仍然低分。
function windowCoverage(seg, text) {
  const q = norm(seg), t = norm(text);
  if (!q) return 1;
  if (t.includes(q)) return 1;
  const need = new Map();
  for (const ch of q) need.set(ch, (need.get(ch) || 0) + 1);
  // q 内去重后的字符需求（多重集）
  const totalNeeded = q.length;
  const wLen = Math.min(t.length, Math.max(q.length, Math.ceil(q.length * 1.6)));
  let best = 0;
  const step = t.length > 20000 ? 2 : 1;
  for (let i = 0; i + 1 <= t.length; i += step) {
    const win = t.slice(i, i + wLen);
    const have = new Map();
    for (const ch of win) have.set(ch, (have.get(ch) || 0) + 1);
    let inter = 0;
    for (const [ch, n] of need) inter += Math.min(n, have.get(ch) || 0);
    const cov = inter / totalNeeded;
    if (cov > best) best = cov;
    if (best > 0.97) break;
  }
  return best;
}

// 引文溯源：拆掉作者的补充说明（括号）与省略号，分片各自溯源，按长度加权。
function quoteCoverage(quote, text) {
  let s = String(quote || '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '');
  const segs = s.split(/…+|\.{3,}|。+|；+|;+/).map((x) => norm(x)).filter((x) => x.length >= 4);
  if (!segs.length) {
    const only = norm(s);
    return only ? windowCoverage(only, text) : 0;
  }
  let wsum = 0, tot = 0, worst = 1;
  for (const sg of segs) {
    const c = windowCoverage(sg, text);
    wsum += c * sg.length; tot += sg.length;
    if (c < worst) worst = c;
  }
  // 整体分：加权平均与最差分片的一个乐观组合（防止单句被生造）
  return Math.max(worst * 0.75 + (wsum / tot) * 0.25, worst);
}

// 1) 建立 aweme_id -> 所属账号集合 的真实索引
//    注：抖音共创视频会同时出现在多个矩阵号的作品页，故一个 aweme_id 可能映射多个账号。
const known = new Map();
if (existsSync(M_DIR)) {
  for (const f of readdirSync(M_DIR).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    const acct = f.replace(/\.json$/, '');
    try {
      for (const it of JSON.parse(readFileSync(join(M_DIR, f), 'utf8'))) {
        const k = String(it.aweme_id);
        if (!known.has(k)) known.set(k, new Set());
        known.get(k).add(acct);
      }
    } catch {}
  }
}

// 2) 可选：合并 part 文件
const merge = process.argv.includes('--merge');
let target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(ROOT, 'knowledge', 'rules.json');

if (merge) {
  const parts = readdirSync(join(ROOT, 'knowledge')).filter((f) => /^rules\.part\..*\.json$/.test(f)).sort();
  if (!parts.length) { console.error('没有找到 knowledge/rules.part.*.json'); process.exit(1); }
  const merged = { version: '1.1', generatedAt: new Date().toISOString(), corpus: {}, scales: [], dimensions: [], composites: [], rules: [], bands: [], glossary: [] };
  // 回填语料元数据（否则网页会显示 undefined%）
  {
    const T_DIR2 = join(ROOT, 'data', 'transcripts');
    let transcribed = 0;
    const accts = [];
    if (existsSync(T_DIR2)) {
      for (const a of readdirSync(T_DIR2)) {
        let n = 0;
        try { n = readdirSync(join(T_DIR2, a)).filter((f) => f.endsWith('.txt')).length; } catch {}
        if (n) { transcribed += n; accts.push(a); }
      }
    }
    merged.corpus = {
      transcribed,
      planned: known.size,
      coveragePct: known.size ? Math.round((transcribed / known.size) * 1000) / 10 : 0,
      accountsUsed: accts,
      generatedAt: new Date().toISOString(),
    };
  }
  const seenRule = new Set();
  for (const p of parts) {
    const d = JSON.parse(readFileSync(join(ROOT, 'knowledge', p), 'utf8'));
    for (const k of ['scales', 'dimensions', 'composites', 'rules', 'bands', 'glossary']) {
      for (const item of d[k] || []) {
        const key = k + ':' + (item.id || item.term || item.name);
        if (seenRule.has(key)) { console.error(`  ! 重复项 ${key} (来自 ${p})，已跳过`); continue; }
        seenRule.add(key);
        merged[k].push(Object.assign({}, item, { _source: p }));
      }
    }
  }
  writeFileSync(target, JSON.stringify(merged, null, 2));
  console.log(`[merge] ${parts.length} 个 part -> ${target}`);
}

if (!existsSync(target)) { console.error('找不到', target); process.exit(1); }
const doc = JSON.parse(readFileSync(target, 'utf8'));

const errors = [];
const warns = [];
const seenIds = new Set();
let machineExec = 0;
const advisoryMissing = [];
const badFields = [];
const ethicsHits = [];

// 输出伦理策略（knowledge/ethics-policy.json）——命中禁用模式的文本不得直接渲染给用户
let ethicsRe = [];
{
  const p = join(ROOT, 'knowledge', 'ethics-policy.json');
  if (existsSync(p)) {
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      ethicsRe = (d.bannedPatterns || []).map((b) => ({ id: b.id, level: b.level, re: new RegExp(b.pattern, 'g'), fix: b.fix }));
    } catch {}
  }
}
// 只扫“会渲染给用户”的自段；不扫 evidence.quote（那是内部取证原文，不应被删改）
function scanUserText(text, where) {
  if (!text || typeof text !== 'string') return;
  for (const e of ethicsRe) {
    e.re.lastIndex = 0;
    if (e.re.test(text)) ethicsHits.push({ where, level: e.level, id: e.id, snippet: text.slice(0, 40) });
  }
}

// 权威字段字典（knowledge/facts.json）——machine.when.field 只能取其中的路径
let validFields = null;
{
  const p = join(ROOT, 'knowledge', 'facts.json');
  if (existsSync(p)) {
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      validFields = new Set([...(d.facts || []), ...(d.photoFacts || [])].map((f) => f.field));
    } catch {}
  }
}
function isValidField(field) {
  if (!validFields) return true; // 字典缺失时不阻断
  if (validFields.has(field)) return true;
  if (/^(hardware|soft)\.breakdown\./.test(field)) return true; // 动态维度 id
  if (/^photo\./.test(field)) return true;
  return false;
}

function checkEvidence(list, where) {
  if (!Array.isArray(list) || !list.length) { errors.push(`${where}: 缺少 evidence`); return; }
  for (const e of list) {
    if (!e || !e.account || !e.aweme_id || !e.quote) { errors.push(`${where}: evidence 字段不全 ${JSON.stringify(e).slice(0, 120)}`); continue; }
    const realSet = known.get(String(e.aweme_id));
    if (!realSet || !realSet.size) { errors.push(`${where}: 伪造/不存在的 aweme_id ${e.aweme_id}`); continue; }
    if (!realSet.has(e.account)) {
      warns.push(`${where}: aweme_id ${e.aweme_id} 不在 ${e.account} 的作品列表中（实际属于 ${[...realSet].join('/')}）`);
    }
    if (String(e.quote).length < 4) errors.push(`${where}: quote 过短`);

    // —— 引文溯源：引文必须能在该条转写里找到 ——
    const realAcct = realSet.has(e.account) ? e.account : [...realSet][0];
    const tx = transcript(realAcct, String(e.aweme_id));
    if (tx === null) {
      warns.push(`${where}: aweme_id ${e.aweme_id} 尚无转写，引文无法核验`);
    } else {
      const cov = quoteCoverage(e.quote, tx);
      if (cov >= 0.72) { /* 通过 */ }
      else if (cov >= 0.45) warns.push(`${where}: 引文与转写仅似合 ${(cov * 100).toFixed(0)}%（ASR 差异可接受，建议核对） aweme=${e.aweme_id}`);
      else errors.push(`${where}: 引文无法在转写中找到（契合度 ${(cov * 100).toFixed(0)}%）aweme=${e.aweme_id} quote="${String(e.quote).slice(0, 40)}…"`);
    }
  }
}

for (const k of ['scales', 'dimensions', 'rules', 'bands']) {
  if (!Array.isArray(doc[k])) { errors.push(`顶层缺少数组字段 ${k}`); continue; }
}
if (!Array.isArray(doc.composites)) warns.push('缺少 composites（硬件/软性/家庭/综合分标尺）——网页只能用演示基线');
for (const s of doc.scales || []) {
  if (seenIds.has(s.id)) errors.push(`scales 重复 id ${s.id}`);
  seenIds.add(s.id);
  checkEvidence(s.evidence, `scale:${s.id}`);
  if (!Array.isArray(s.anchors) || !s.anchors.length) warns.push(`scale:${s.id} 没有 anchors（分档锚点）`);
}
for (const d of doc.dimensions || []) {
  if (seenIds.has(d.id)) errors.push(`dimensions 重复 id ${d.id}`);
  seenIds.add(d.id);
  checkEvidence(d.evidence, `dim:${d.id}`);
  if (!['hardware', 'soft', 'family', 'appearance', 'other'].includes(d.group)) errors.push(`dim:${d.id} group 非法: ${d.group}`);
}
for (const r of doc.rules || []) {
  if (seenIds.has(r.id)) errors.push(`rules 重复 id ${r.id}`);
  seenIds.add(r.id);
  if (!/^R-[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-[0-9]{3}$/.test(r.id || '')) errors.push(`rule id 格式错误: ${r.id}`);
  if (!['scoring', 'matching', 'band', 'demographic', 'advice'].includes(r.scope)) errors.push(`rule:${r.id} scope 非法: ${r.scope}`);
  if (!['high', 'medium', 'low'].includes(r.confidence)) errors.push(`rule:${r.id} confidence 非法: ${r.confidence}`);
  // —— 可执行性：要么给 machine，要么显式 advisory ——
  const hasMachine = r.machine && r.machine.when && typeof r.machine.when === 'object';
  if (hasMachine) {
    const ops = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'between', 'exists', 'missing', 'includes', 'matches']);
    const walk = (c, path) => {
      if (!c || typeof c !== 'object') { errors.push(`rule:${r.id} machine.when${path} 不是对象`); return; }
      // 组合键与叶键不得混用（与 web/lib/ruleset.mjs validateCondition 保持一致）
      const hasComb = c.all !== undefined || c.any !== undefined || c.not !== undefined;
      const hasLeafKey = c.field !== undefined || c.op !== undefined;
      if (hasComb && hasLeafKey) {
        errors.push(`rule:${r.id} machine.when${path}: 组合键（all/any/not）不能与 field/op 混用 —— 引擎会拒绝加载整个规则集`);
        return;
      }
      if (Array.isArray(c.all)) return c.all.forEach((x, i) => walk(x, `${path}.all[${i}]`));
      if (Array.isArray(c.any)) return c.any.forEach((x, i) => walk(x, `${path}.any[${i}]`));
      if (c.not !== undefined) return walk(c.not, `${path}.not`);
      if (!c.field) { errors.push(`rule:${r.id} machine.when${path} 缺 field`); return; }
      if (!ops.has(c.op)) errors.push(`rule:${r.id} machine.when${path} op 非法: ${c.op}`);
      // —— 字段名必须存在于权威字典 knowledge/facts.json ——
      if (validFields && !isValidField(String(c.field))) {
        badFields.push(`rule:${r.id} -> ${c.field}`);
      }
    };
    walk(r.machine.when, '');
    const kinds = new Set(['clampScale', 'setBand', 'advice', 'giveUp', 'text', 'flag', 'requireEvidence']);
    for (const t of r.machine.then || []) {
      if (!kinds.has(t.kind)) errors.push(`rule:${r.id} machine.then kind 非法: ${t.kind}`);
      // 面向用户的措辞必须过伦理门禁
      if (['advice', 'giveUp', 'text'].includes(t.kind)) scanUserText(t.text, `rule:${r.id}.machine.then.${t.kind}`);
    }
    machineExec++;
  } else if (r.advisory !== true) {
    advisoryMissing.push(r.id);
  }
  checkEvidence(r.evidence, `rule:${r.id}`);
  scanUserText(typeof r.then === 'string' ? r.then : '', `rule:${r.id}.then`);
  scanUserText(r.title, `rule:${r.id}.title`);
  if (r.confidence === 'high' && (r.evidence || []).length < 3) warns.push(`rule:${r.id} 标 high 但只有 ${(r.evidence || []).length} 条证据`);
  if (r.confidence === 'high') {
    const accts = new Set((r.evidence || []).map((e) => e.account));
    if (accts.size < 2) warns.push(`rule:${r.id} 标 high 但仅来自 1 个账号`);
  }
}
for (const b of doc.bands || []) {
  if (seenIds.has('band:' + b.id)) errors.push(`bands 重复 id ${b.id}`);
  seenIds.add('band:' + b.id);
  checkEvidence(b.evidence, `band:${b.id}`);
  if (!b.targetProfile) warns.push(`band:${b.id} 缺少结构化 targetProfile（心智首选画像），网页只能渲染自由文本`);
}
for (const c of doc.composites || []) {
  if (seenIds.has('composite:' + c.id)) errors.push(`composites 重复 id ${c.id}`);
  seenIds.add('composite:' + c.id);
  checkEvidence(c.evidence, `composite:${c.id}`);
  if (!Array.isArray(c.anchors) || !c.anchors.length) warns.push(`composite:${c.id} 缺少 anchors（分档锚点），网页只能用演示基线`);
}

const stats = {
  scales: (doc.scales || []).length,
  dimensions: (doc.dimensions || []).length,
  rules: (doc.rules || []).length,
  executableRules: machineExec,
  missingAdvisoryFlag: advisoryMissing.length,
  ethicsHits: ethicsHits.length,
  bands: (doc.bands || []).length,
  composites: (doc.composites || []).length,
  glossary: (doc.glossary || []).length,
  evidenceTotal: ['scales', 'dimensions', 'rules', 'bands', 'composites'].reduce((a, k) => a + (doc[k] || []).reduce((x, i) => x + (i.evidence || []).length, 0), 0),
};
console.log(JSON.stringify({ stats, errors: errors.length, warns: warns.length }, null, 2));
if (advisoryMissing.length) {
  warns.push(`有 ${advisoryMissing.length} 条规则既没有 machine 可执行层，也没标 advisory: true —— 引擎会跳过它们，知识库等于白写。前 10 条：${advisoryMissing.slice(0, 10).join(', ')}`);
}
if (badFields.length) {
  errors.push(`有 ${badFields.length} 处 machine.when.field 引用了 knowledge/facts.json 里不存在的字段（这类规则不会报错，只会静默不触发）：${badFields.slice(0, 8).join(' | ')}`);
}
if (ethicsHits.length) {
  const p0 = ethicsHits.filter((h) => h.level === 'P0');
  const msg = `有 ${ethicsHits.length} 处文本命中伦理禁用模式（P0 ${p0.length} 处）。这些文本不得直接渲染给用户，必须改写或用 userFacingText 覆盖。前 8 处：` +
    ethicsHits.slice(0, 8).map((h) => `${h.where}[${h.id}]「${h.snippet}」`).join(' | ');
  if (p0.length) errors.push(msg); else warns.push(msg);
}
if (warns.length) { console.log('\n--- 警告 ---'); warns.slice(0, 40).forEach((w) => console.log('  ~', w)); }
if (errors.length) {
  console.log('\n--- 错误 ---');
  errors.slice(0, 40).forEach((e) => console.log('  ✗', e));
  process.exit(1);
}
console.log('\n✓ 校验通过');
