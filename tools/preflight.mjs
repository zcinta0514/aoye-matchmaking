#!/usr/bin/env node
// 提交前预检（preflight）：一次跑完「规则集能否加载 + 真实报告能否生成 + 伦理是否干净」。
//
//   node tools/preflight.mjs            # 完整预检
//   node tools/preflight.mjs --quick    # 只验规则集与报告，不跑伦理与回归
//
// 存在理由：本项目已三次出现「单元测试全绿，但真实路径是坏的」：
//   1. R-BASE-MATCH-004 的 all2 拼写错误被静默忽略（规则误触发）
//   2. photo.* 在 facts.json 声明却未注入（引用它的规则永不触发）
//   3. buildFacts 读 hardware.items 而调用方传的对象没有 items（报告 500）
// 共同点：**没有一条测试真正走过「正式规则集 + 完整表单 → 报告」这条路径**。
// 本脚本就是那条路径。提交前必须全绿。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const quick = process.argv.includes('--quick');
const results = [];
let failed = 0;

function step(name, fn) {
  process.stdout.write(`  ${name} … `);
  try {
    const detail = fn();
    console.log(`✓ ${detail || ''}`);
    results.push({ name, ok: true, detail });
  } catch (e) {
    console.log(`✗ ${e.message}`);
    results.push({ name, ok: false, error: e.message });
    failed++;
  }
}

console.log('=== preflight ===');

// 1) 规则集合法性 + 可执行统计
step('规则集校验 (check_rules)', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check_rules.mjs'), 'knowledge/rules.json'], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) throw new Error(out.split('\n').filter((l) => l.includes('✗')).slice(0, 3).join(' | ') || '校验未通过');
  const m = out.match(/"executableRules":\s*(\d+)/);
  const rules = out.match(/"rules":\s*(\d+)/);
  const exec = m ? Number(m[1]) : 0;
  if (exec === 0) throw new Error('可执行规则为 0 —— 知识库未接上，报告将全部来自演示基线');
  return `${rules ? rules[1] : '?'} 条规则 / ${exec} 条可执行`;
});

// 2) facts.json 字段字典存在且与表单一致
step('字段字典 (facts.json)', () => {
  const p = join(ROOT, 'knowledge', 'facts.json');
  if (!existsSync(p)) throw new Error('knowledge/facts.json 不存在，请跑 node tools/build_facts.mjs');
  const d = JSON.parse(readFileSync(p, 'utf8'));
  if (!d.facts || !d.facts.length) throw new Error('facts 为空');
  const warns = (d.warnings || []).length;
  return `${d.counts.subjectFields} 表单字段 + ${d.counts.computedFields} 派生 + ${d.counts.photoDimensions} 照片维度${warns ? `（${warns} 条已知陷阱警告）` : ''}`;
});

if (!quick) {
  // 3) 全库伦理扫描
  step('伦理扫描 (ethics_scan)', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'ethics_scan.mjs')], { cwd: ROOT, encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/"p0":\s*(\d+)/);
    const h = out.match(/"hits":\s*(\d+)/);
    if (r.status !== 0) throw new Error(`存在 ${m ? m[1] : '?'} 处 P0 伦理命中`);
    return `${h ? h[1] : 0} 处非 P0 命中`;
  });

  // 3.5) 护栏不变式：并发改写曾静默吞掉 case_regression 的降级护栏（webapp 报告）
  // 原则：护栏如果可以被静默删除，它就不是护栏。用关键字断言把它锁住。
  step('护栏不变式 (case_regression 降级锁)', () => {
    const p = join(ROOT, 'tools', 'case_regression.mjs');
    if (!existsSync(p)) throw new Error('tools/case_regression.mjs 不存在');
    const src = readFileSync(p, 'utf8');
    const required = ['degraded', 'fallbackCommit', 'NOT-VALID'];
    const missing = required.filter((k) => !src.includes(k));
    if (missing.length) {
      throw new Error(`降级护栏关键字丢失：${missing.join(', ')} —— 可能被重写覆盖。护栏必须保留：用了回退就不得 exit 0、必须标 degraded、必须输出 NOT-VALID`);
    }
    return `降级锁完整（${required.join(' / ')}）`;
  });
}

// 4) 真实端到端：起服务 → POST 报告 → 断言 200 且规则真的命中
const server = spawn(process.execPath, [join(ROOT, 'web', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const port = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('server 启动超时')), 12000);
  server.stdout.on('data', (d) => {
    buf += String(d);
    const m = buf.match(/127\.0\.0\.1:(\d+)/);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
  server.stderr.on('data', (d) => { buf += String(d); });
  server.on('exit', (c) => { clearTimeout(t); reject(new Error(`server 退出 code=${c}\n${buf.slice(-400)}`)); });
}).catch((e) => { console.log(`  server 启动 … ✗ ${e.message}`); failed++; return null; });

if (port) {
  const form = {
    gender: 'male', age: 27, city: '周口', height_cm: 173, weight_kg: 72,
    education: 'bachelor', school_tier: 'ordinary', occupation: 'gov',
    income_wan: 6, has_house: 'multi', has_car: 'none', hukou: 'local',
    marital: 'single', family_origin: 'urban_normal', siblings: 'has',
    family_wealth: 'a7', personality: 'slow', communication: 3,
    emotional_stability: 4, living_skills: 3, social_circle: 3,
    want_gender: 'female', want_age_min: 24, want_age_max: 28, want_height_min: 165,
    want_education_min: 'bachelor', want_house: 'yes', want_appearance_min: 4.5,
    self_appearance: 3.5, self_rank: 'mid', admiration_freq: 'rare',
    feedback_gap: 'same', photo_quality: 'raw', face_natural: 'yes',
  };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ form, photoIds: [] }),
    });
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    const r = j.report || j;
    const applied = (r.rulesApplied || []).length;
    const kRules = (r.rulesApplied || []).filter((x) => x.origin === 'knowledge').length;
    if (!applied) throw new Error('报告 200 但 rulesApplied 为空 —— 规则集没真正参与计算');
    if (!kRules) throw new Error(`报告 200 但无知识库规则命中（只有 ${applied} 条基线）—— 知识库未接通`);
    if (typeof r.level !== 'number') throw new Error('报告缺少数值 level');
    console.log(`  \x1b[?25l`);
    step('真实报告端到端', () => `HTTP 200 / level ${r.level} / 命中 ${applied} 条（知识库 ${kRules} 条）`);
  } catch (e) {
    step('真实报告端到端', () => { throw e; });
  }
  server.kill('SIGTERM');
}

console.log(`\n=== ${failed === 0 ? '全部通过 ✓ 可以提交' : `${failed} 项失败 ✗ 不要提交`} ===`);
if (failed) {
  console.log('提示：本项目已三次出现「单元测试全绿但真实路径是坏的」，本预检就是拦这些的。');
  console.log('若 server 启动相关，先确认没有别的进程占端口（如 tools/collector.mjs 用 8799）。');
}
process.exit(failed ? 1 : 0);
