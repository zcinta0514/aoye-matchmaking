#!/usr/bin/env node
// tools/asr_normalize.mjs —— ASR 语料纠错层（只读，不修改 data/transcripts 原文件）
//
// 设计原则：
//   1) 原始转写文件绝不改写；本模块只在"检索 / 阅读 / 输出"时做归一化。
//   2) 每条纠错来自 knowledge/asr-fixes.json，错字 → 正字可解释，且带语料证据。
//   3) 有歧义的变体必须带护栏（context / counterContext），护栏不过就不替换。
//
// API：
//   normalize(text)       → 归一化后的文本
//   annotate(text)        → [{start, end, surface, correct, kind}] 供 UI 高亮
//   expandQuery(term)     → 把正字/变体展开成正则源串，用于检索召回
//   expandRegexSource(src)→ 对已是正则源的字符串做同样的词面展开
//
// CLI：
//   node tools/asr_normalize.mjs --check [--json]     扫全库统计每组变体命中（区分 raw / applied）
//   node tools/asr_normalize.mjs --expand "校草"      查看检索展开结果
//   node tools/asr_normalize.mjs --normalize "…"      查看归一化结果
//   node tools/asr_normalize.mjs --annotate "…"       查看修正位置
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXES_PATH = join(ROOT, 'knowledge', 'asr-fixes.json');
const T_DIR = join(ROOT, 'data', 'transcripts');

if (!existsSync(FIXES_PATH)) throw new Error('缺少 ' + FIXES_PATH);
const DOC = JSON.parse(readFileSync(FIXES_PATH, 'utf8'));
export const fixes = DOC.fixes;

const WINDOW = 24;

function buildEntries() {
  const entries = [];
  for (const f of fixes) {
    const contextual = new Set(f.contextual || []);
    for (const v of f.variants) {
      entries.push({
        variant: v,
        correct: f.correct,
        kind: f.kind,
        requireContext: f.context && contextual.has(v) ? new RegExp(f.context) : null,
        counter: f.counterContext ? new RegExp(f.counterContext) : null,
      });
    }
  }
  // 长变体优先，避免"情价值"被"情价"先吃掉
  entries.sort((a, b) => b.variant.length - a.variant.length || a.variant.localeCompare(b.variant));
  return entries;
}
const ENTRIES = buildEntries();

export function escapeRegex(s) {
  return s.replace(/[.*+?^$\u007B\u007D()|[\]\\]/g, function (m) { return '\\' + m; });
}

/** 找出文本里所有可应用的替换位置（含护栏判定），按位置排序且互不重叠 */
export function scan(text) {
  const cands = [];
  for (const e of ENTRIES) {
    let i = text.indexOf(e.variant);
    while (i !== -1) {
      const win = text.slice(Math.max(0, i - WINDOW), i + e.variant.length + WINDOW);
      const blocked = e.counter ? e.counter.test(win) : false;
      const needCtx = e.requireContext ? e.requireContext.test(win) : true;
      if (!blocked && needCtx) {
        cands.push({ start: i, end: i + e.variant.length, surface: e.variant, correct: e.correct, kind: e.kind });
      }
      i = text.indexOf(e.variant, i + e.variant.length);
    }
  }
  cands.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  let last = -1;
  for (const c of cands) { if (c.start >= last) { out.push(c); last = c.end; } }
  return out;
}

export function normalize(text) {
  if (!text) return text;
  const hits = scan(text);
  if (!hits.length) return text;
  let out = '';
  let pos = 0;
  for (const h of hits) { out += text.slice(pos, h.start) + h.correct; pos = h.end; }
  return out + text.slice(pos);
}

export function annotate(text) {
  return scan(text).map(function (h) { return { start: h.start, end: h.end, surface: h.surface, correct: h.correct, kind: h.kind }; });
}

/** 归一化产生的成对替换（用于 --fix 的行尾 [原:…] 标注） */
export function diffs(text) {
  return scan(text).map(function (h) { return { from: h.surface, to: h.correct }; });
}

// ---- 检索展开 ----
let TOKENS = null;
function tokens() {
  if (TOKENS) return TOKENS;
  const groups = new Map(); // correct -> Set(surfaces)
  for (const f of fixes) {
    if (!groups.has(f.correct)) groups.set(f.correct, new Set());
    groups.get(f.correct).add(f.correct);
    for (const v of f.variants) groups.get(f.correct).add(v);
  }
  const list = [];
  for (const [correct, set] of groups) {
    const alt = '(?:' + [...set].sort((a, b) => b.length - a.length).map(escapeRegex).join('|') + ')';
    for (const s of set) list.push({ surface: s, alt: alt });
  }
  list.sort((a, b) => b.surface.length - a.surface.length);
  TOKENS = list;
  return list;
}

/** 把纯文本检索词展开成正则源串（未识别的字符按字面转义） */
export function expandQuery(term) {
  const list = tokens();
  let out = '';
  let i = 0;
  while (i < term.length) {
    let hit = null;
    for (const t of list) { if (term.startsWith(t.surface, i)) { hit = t; break; } }
    if (hit) { out += hit.alt; i += hit.surface.length; }
    else { out += escapeRegex(term[i]); i += 1; }
  }
  return out;
}

/** 对已经写成正则源的字符串做同样的词面展开（保留其原有正则语法） */
export function expandRegexSource(src) {
  const list = tokens();
  let out = '';
  let i = 0;
  while (i < src.length) {
    let hit = null;
    for (const t of list) { if (src.startsWith(t.surface, i)) { hit = t; break; } }
    if (hit) { out += hit.alt; i += hit.surface.length; }
    else { out += src[i]; i += 1; }
  }
  return out;
}

// ---- CLI ----
function corpusDocs() {
  if (!existsSync(T_DIR)) return [];
  const docs = [];
  for (const a of readdirSync(T_DIR).filter((d) => !d.startsWith('.'))) {
    let files = [];
    try { files = readdirSync(join(T_DIR, a)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.txt')) continue;
      docs.push({ account: a, aweme_id: f.replace(/\.txt$/, ''), text: readFileSync(join(T_DIR, a, f), 'utf8') });
    }
  }
  return docs;
}

function countOccurrences(text, needle) {
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) { n += 1; i = text.indexOf(needle, i + needle.length); }
  return n;
}

export function check() {
  const docs = corpusDocs();
  const rows = [];
  for (const f of fixes) {
    for (const v of f.variants) {
      let raw = 0;
      let applied = 0;
      for (const d of docs) {
        raw += countOccurrences(d.text, v);
        for (const h of scan(d.text)) if (h.surface === v && h.correct === f.correct) applied += 1;
      }
      const status = raw === 0 ? 'UNUSED' : applied === 0 ? 'GUARDED' : applied < raw ? 'PARTIAL' : 'OK';
      rows.push({ correct: f.correct, variant: v, kind: f.kind, raw, applied, status });
    }
  }
  const summary = {
    fixes: fixes.length,
    variants: rows.length,
    variantsHit: rows.filter((r) => r.raw > 0).length,
    variantsUnused: rows.filter((r) => r.status === 'UNUSED').length,
    variantsGuarded: rows.filter((r) => r.status === 'GUARDED').length,
    rawTotal: rows.reduce((a, r) => a + r.raw, 0),
    appliedTotal: rows.reduce((a, r) => a + r.applied, 0),
    corpus: { transcribed: docs.length },
  };
  return { summary, rows };
}

// ---- 数字噪声检测（只检测，不替换） ----
// 设计：数字错读对规则阈值影响最大，但无法安全地自动改写；本函数只做分类计数 + 抽样，
// 供人工判定是否要把某条引文从阈值依据里剔除。
const NUMBER_PATTERNS = [
  { id: 'height_merge', label: '身高/体重粘连（如 1米6390斤）', src: '[0-9]米[0-9]{3,}' },
  { id: 'height_unit_confuse', label: '单位误读（如 1亿8三 = 1米83）', src: '[0-9]亿[0-9一二三四五六七八九十]' },
  { id: 'weight_merge', label: '体重位数异常（4位以上，如 体重7100斤）', src: '(体重|斤)[0-9]{4,}' },
  { id: 'money_ge', label: '金额用「个」代「万」（如 30个，后接停顿）', src: '[0-9]{1,3}个(?=[，。,.、\\s])' },
  { id: 'height_style_cm', label: '身高写法：裸数字（如 175）', src: '(身高|高)[是为]?[0-9]{3}' },
  { id: 'height_style_meter', label: '身高写法：1米XX / 一米X / 1.XX米', src: '(1米|一米|1\.[五六七八九]米)[0-9一二三四五六七八九十]{0,3}' },
  { id: 'age_digit', label: '年龄写法：数字+岁', src: '[0-9]{2}岁' },
  { id: 'age_cn', label: '年龄写法：中文数字+岁', src: '[一二三四五六七八九十]{2,3}岁' },
  { id: 'income_wan', label: '收入写法：数字+万', src: '[0-9]+(\.[0-9]+)?万' },
  { id: 'income_w', label: '收入写法：数字+w/k', src: '[0-9]+(w|W|k|K)(?![a-zA-Z])' },
  { id: 'loop_repeat', label: '转写循环回音（同一短语连续>=6次）', src: 'x' }
];

export function numberScan(docs) {
  const rows = [];
  for (const def of NUMBER_PATTERNS) {
    if (def.id === 'loop_repeat') continue;
    const re = new RegExp(def.src, "g");
    let count = 0; const examples = []; const docsHit = new Set();
    for (const d of docs || corpusDocs()) {
      let m; re.lastIndex = 0;
      while ((m = re.exec(d.text))) {
        count += 1; docsHit.add(d.account + "/" + d.aweme_id);
        if (examples.length < 5) examples.push({ account: d.account, aweme_id: d.aweme_id, snippet: d.text.slice(Math.max(0, m.index - 22), m.index + m[0].length + 22).replace(/\s+/g, " ") });
      }
    }
    rows.push({ id: def.id, label: def.label, count, docs: docsHit.size, examples });
  }
  // 循环回音检测：连续 6 次以上重复的短句
  const loops = [];
  for (const d of docs || corpusDocs()) {
    const segs = d.text.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    let run = 1;
    for (let i = 1; i <= segs.length; i += 1) {
      const same = i < segs.length && segs[i] === segs[i - 1] && segs[i].length >= 4;
      if (same) { run += 1; continue; }
      if (run >= 6) loops.push({ account: d.account, aweme_id: d.aweme_id, repeat: run, text: segs[i - 1].slice(0, 40) });
      run = 1;
    }
  }
  return { rows, loops };
}
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (IS_MAIN) {
const cmd = process.argv[2];
if (cmd === '--check') {
  const { summary, rows } = check();
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ summary, rows }, null, 2)); }
  else {
    console.log('correct'.padEnd(14) + 'variant'.padEnd(12) + 'kind'.padEnd(11) + 'raw'.padStart(5) + 'applied'.padStart(9) + '  status');
    console.log('-'.repeat(64));
    for (const r of rows) {
      console.log(r.correct.padEnd(14) + r.variant.padEnd(12) + r.kind.padEnd(11) + String(r.raw).padStart(5) + String(r.applied).padStart(9) + '  ' + r.status);
    }
    console.log('');
    console.log(JSON.stringify(summary, null, 2));
  }
} else if (cmd === '--numbers') {
  const r = numberScan(corpusDocs());
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r, null, 2)); }
  else {
    for (const row of r.rows) {
      console.log("[" + row.id + "] " + row.label + "  命中 " + row.count + " 次 / " + row.docs + " 条作品");
      for (const e of row.examples.slice(0, 3)) console.log("    " + e.account + "/" + e.aweme_id + "  " + e.snippet);
    }
    console.log("[loop_repeat] 转写循环回音  命中 " + r.loops.length + " 处");
    for (const l of r.loops.slice(0, 3)) console.log("    " + l.account + "/" + l.aweme_id + "  ×" + l.repeat + "  " + l.text);
  }
} else if (cmd === '--expand') {
  console.log(expandQuery(process.argv[3] || ''));
} else if (cmd === '--normalize') {
  console.log(normalize(process.argv[3] || ''));
} else if (cmd === '--annotate') {
  console.log(JSON.stringify(annotate(process.argv[3] || ''), null, 2));
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'));
}
}
