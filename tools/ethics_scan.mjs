#!/usr/bin/env node
// 全库伦理扫描：覆盖 rules.*.json、knowledge/*.md、standards.json、cases.json 等**所有用户可见文本**。
//
// 为什么需要它：报告会把 advisory 规则与知识库内容展示给用户，md / standards / cases 同样是用户可见面，
// 而 check_rules.mjs 的伦理门禁只查规则 JSON，属于漏网（distill-dims 报告发现的）。
//
//   node tools/ethics_scan.mjs            # 扫描，P0 命中则 exit 1
//   node tools/ethics_scan.mjs --json     # 输出机器可读结果
//
// 豁免：任何名为 quote / snippet / evidence 的字段（取证原文不得删改，否则溯源就断了）。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const policy = JSON.parse(readFileSync(join(ROOT, 'knowledge', 'ethics-policy.json'), 'utf8'));
const RE = policy.bannedPatterns.map((b) => ({ id: b.id, level: b.level, re: new RegExp(b.pattern, 'g'), fix: b.fix }));

const DIRS = [join(ROOT, 'knowledge'), join(ROOT, 'docs')];
const SKIP_FILES = new Set(['rules.merged.json', 'AUDIT-v1.md', 'AUDIT-WEB.md', 'ethics-policy.json', 'OPEN-QUESTIONS.md']);
// 内部字段豁免：这些**不得被报告渲染**（如果哪天要渲染，先过伦理门禁）。
// evidence.quote 同属豁免——取证原文改了溯源就断了。
const INTERNAL_KEYS = new Set(['internalNote', 'quote', 'snippet', 'evidence', 'conflictNote', 'conflicts', 'representativeQuote']);
const USER_VISIBLE_KEYS = new Set([
  'title', 'then', 'when', 'text', 'notes', 'note', 'definition', 'meaning', 'summary', 'name',
  'description', 'reachableMatch', 'typicalObstacle', 'label',
  'advice', 'giveUp', 'userFacingText', 'entryCriteria',
]);

const hits = [];
const exemptQuotes = [];
let filesScanned = 0;
let jsonFieldsScanned = 0;

function scanText(text, where) {
  for (const e of RE) {
    e.re.lastIndex = 0;
    let m;
    while ((m = e.re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({
        where, line, level: e.level, id: e.id,
        snippet: text.slice(Math.max(0, m.index - 25), m.index + 45).replace(/\s+/g, ' ').trim(),
        fix: e.fix,
      });
      if (m.index === e.re.lastIndex) e.re.lastIndex++;
    }
  }
}

// md 里的「已标记引文」标准写法（豁免扫描，但必须带 aweme_id 才能追溯）：
//   > 【博主原话】……（aoye98 / 7644902230331542826）
// 设计意图：不得让有害表述以「作者自己的结论」的口吻出现在文档里；
// 但语料原文是可追溯的证据，不应逼作者从文档里删除。
const QUOTE_LINE = /^\s*>\s*【(?:博主原话|原话)】/;
function scanMarkdown(text, where) {
  const lines = text.split('\n');
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (QUOTE_LINE.test(ln) && /\d{15,}/.test(ln)) { skipped++; continue; }
    scanText(ln, where);
  }
  if (skipped) exemptQuotes.push({ where, skipped });
}

function walkJson(v, path) {
  if (Array.isArray(v)) return v.forEach((x, i) => walkJson(x, `${path}[${i}]`));
  if (!v || typeof v !== 'object') return;
  for (const [k, val] of Object.entries(v)) {
    if (INTERNAL_KEYS.has(k)) continue; // 内部字段 / 取证原文：豁免扫描，但不得被报告渲染
    if (typeof val === 'string') {
      if (USER_VISIBLE_KEYS.has(k) || k.endsWith('Text')) { jsonFieldsScanned++; scanText(val, `${path}.${k}`); }
    } else walkJson(val, `${path}.${k}`);
  }
}

for (const dir of DIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (SKIP_FILES.has(f)) continue;
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    if (!/\.(md|json)$/.test(f)) continue;
    const raw = readFileSync(p, 'utf8');
    filesScanned++;
    const rel = p.replace(ROOT, '');
    if (f.endsWith('.json')) {
      let doc; try { doc = JSON.parse(raw); } catch { continue; }
      walkJson(doc, rel);
    } else {
      scanMarkdown(raw, rel);
    }
  }
}

const p0 = hits.filter((h) => h.level === 'P0');
const byId = {};
for (const h of hits) byId[h.id] = (byId[h.id] || 0) + 1;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ filesScanned, jsonFieldsScanned, hits, byId }, null, 2));
} else {
  console.log(JSON.stringify({ filesScanned, jsonFieldsScanned, hits: hits.length, p0: p0.length, exemptQuoteLines: exemptQuotes.reduce((a, b) => a + b.skipped, 0) }, null, 2));
  console.log('按模式分布:', JSON.stringify(byId));
  console.log('\n--- 命中明细 ---');
  for (const h of hits.slice(0, 40)) {
    console.log(`  [${h.level}/${h.id}] ${h.where}:${h.line}`);
    console.log(`      「${h.snippet.slice(0, 90)}」`);
    console.log(`      → ${h.fix}`);
  }
  if (hits.length > 40) console.log(`  … 其余 ${hits.length - 40} 处略（用 --json 看全量）`);
}
process.exit(p0.length ? 1 : 0);
