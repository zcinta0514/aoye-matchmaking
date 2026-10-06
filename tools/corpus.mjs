#!/usr/bin/env node
// 语料查询工具 —— 让 Agent/Worker 高效检索转写语料，不用把全文灌进上下文。
//
//   node tools/corpus.mjs stats                     语料总览（账号/条数/时长/覆盖率）
//   node tools/corpus.mjs search "关键词" [--ctx 3] [--limit 40] [--account aoye98] [--json]
//   node tools/corpus.mjs grep "正则"    [--ctx 3] [--limit 40]
//   node tools/corpus.mjs read <account> <aweme_id>
//   node tools/corpus.mjs sample <n> [--account X] [--min-dur 60]
//   node tools/corpus.mjs accounts
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, diffs, escapeRegex, expandQuery, expandRegexSource } from './asr_normalize.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = join(ROOT, 'data');
const T_DIR = join(DATA, 'transcripts');
const M_DIR = join(DATA, 'meta', 'manifests');

function argv(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const flag = (n) => process.argv.includes(`--${n}`);

// --fix：输出时把错字换成正字，并在行尾标注原文错字（只作用于输出，不修改磁盘上的转写文件）
function withFix(text) {
  const fixed = normalize(text);
  if (fixed === text) return text;
  const seen = new Map();
  for (const d of diffs(text)) { if (!seen.has(d.from)) seen.set(d.from, d.to); }
  const note = [...seen].slice(0, 6).map(function (p) { return p[0] + '→' + p[1]; }).join('；');
  return fixed + ' [原:' + note + ']';
}

function accounts() {
  if (!existsSync(T_DIR)) return [];
  return readdirSync(T_DIR).filter((d) => !d.startsWith('.'));
}

function meta(account) {
  const p = join(M_DIR, `${account}.json`);
  if (!existsSync(p)) return new Map();
  const m = new Map();
  for (const it of JSON.parse(readFileSync(p, 'utf8'))) m.set(String(it.aweme_id), it);
  return m;
}

function docs() {
  const out = [];
  for (const a of accounts()) {
    for (const f of readdirSync(join(T_DIR, a))) {
      if (!f.endsWith('.txt')) continue;
      const id = basename(f, '.txt');
      const text = readFileSync(join(T_DIR, a, f), 'utf8');
      out.push({ account: a, aweme_id: id, text });
    }
  }
  return out;
}

const cmd = process.argv[2];

if (cmd === 'stats') {
  const ds = docs();
  let chars = 0;
  const per = {};
  for (const d of ds) { chars += d.text.length; per[d.account] = (per[d.account] || 0) + 1; }
  const idx = existsSync(join(M_DIR, '_index.json')) ? JSON.parse(readFileSync(join(M_DIR, '_index.json'), 'utf8')) : { totalUnique: 0 };
  console.log(JSON.stringify({
    transcribed: ds.length,
    planned: idx.totalUnique,
    coverage: (ds.length / (idx.totalUnique || 1) * 100).toFixed(1) + '%',
    chars, approxTokens: Math.round(chars / 1.5),
    accounts: Object.entries(per).sort((a, b) => b[1] - a[1]),
  }, null, 2));
} else if (cmd === 'accounts') {
  for (const a of accounts()) {
    const ds = readdirSync(join(T_DIR, a)).filter((f) => f.endsWith('.txt'));
    const m = meta(a);
    let min = 0;
    for (const f of ds) { const it = m.get(basename(f, '.txt')); if (it) min += (it.duration || 0); }
    console.log(String(ds.length).padStart(4), (min / 60000).toFixed(0).padStart(5) + 'min', a);
  }
} else if (cmd === 'read') {
  const [, , , acct, id] = process.argv;
  const p = join(T_DIR, acct, `${id}.txt`);
  if (!existsSync(p)) { console.error('not found:', p); process.exit(1); }
  const m = meta(acct).get(String(id));
  if (m) console.log(`# ${acct} / ${id}\n# desc: ${m.desc || ''}\n# likes: ${m.digg || 0}  duration: ${((m.duration || 0) / 1000).toFixed(0)}s\n`);
  console.log(flag('fix') ? withFix(readFileSync(p, 'utf8')) : readFileSync(p, 'utf8'));
} else if (cmd === 'search' || cmd === 'grep') {
  const pat = process.argv[3];
  if (!pat) { console.error('usage: corpus.mjs search "关键词"'); process.exit(1); }
  const ctx = Number(argv('ctx', 2));
  const limit = Number(argv('limit', 40));
  const acc = argv('account', null);
  const re = cmd === 'grep'
    ? new RegExp(flag('normalize') ? expandRegexSource(pat) : pat, 'g')
    : new RegExp(flag('normalize') ? expandQuery(pat) : escapeRegex(pat), 'g');
  let hits = 0;
  for (const d of docs()) {
    if (acc && d.account !== acc) continue;
    const lines = d.text.split('\n');
    const marked = [];
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        re.lastIndex = 0;
        marked.push(i);
      }
    }
    if (!marked.length) continue;
    const m = meta(d.account).get(d.aweme_id) || {};
    console.log(`\n=== ${d.account} / ${d.aweme_id} | ${(m.desc || '').slice(0, 60)} | ${(m.duration || 0) / 1000}s | likes=${m.digg || 0}`);
    const shown = new Set();
    for (const i of marked) {
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
        if (shown.has(j)) continue;
        shown.add(j);
        console.log('  ' + (j === i ? '>>' : '  ') + (flag('fix') ? withFix(lines[j]) : lines[j]));
      }
      if (flag('json')) {}
    }
    hits++;
    if (hits >= limit) break;
  }
  console.error(`\n[corpus] ${hits} 条作品命中 "${pat}"${hits >= limit ? ' (已达 limit，可调大 --limit)' : ''}`);
} else if (cmd === 'sample') {
  const n = Number(process.argv[3] || 10);
  const acc = argv('account', null);
  const minDur = Number(argv('min-dur', 30));
  let all = docs().filter((d) => !acc || d.account === acc);
  all = all.filter((d) => { const m = meta(d.account).get(d.aweme_id); return m && (m.duration || 0) >= minDur * 1000; });
  // 稳定抽样：按 aweme_id 排序后均匀取 n 条
  all.sort((a, b) => a.aweme_id.localeCompare(b.aweme_id));
  const step = Math.max(1, Math.floor(all.length / n));
  const picked = [];
  for (let i = 0; i < all.length && picked.length < n; i += step) picked.push(all[i]);
  for (const p of picked) {
    const m = meta(p.account).get(p.aweme_id) || {};
    console.log(`\n=== ${p.account} / ${p.aweme_id} | ${(m.desc || '').slice(0, 70)} | ${(m.duration || 0) / 1000}s`);
    console.log(p.text.split('\n').slice(0, 60).join('\n'));
    console.log('  ...');
  }
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n'));
}
