#!/usr/bin/env node
// 预览合并：把各 Worker 的 rules.part.*.json 合并到一个**临时预览文件**，让 Worker 能跑回归自检，
// 而不必（也不允许）碰 Lead 独占的 knowledge/rules.json（见 DECISIONS D7）。
//
//   node tools/preview_rules.mjs              # 合并到 knowledge/_rules.preview.json 并打印统计
//   node tools/preview_rules.mjs --regress    # 合并后直接对预览集跑回归
//
// 产出文件带下划线前缀且被 .gitignore 覆盖（不会入库、不会被 savepoint 当真产物）。
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = 'knowledge/_rules.preview.json';

const args = process.argv.slice(2);
const regress = args.includes('--regress');

const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check_rules.mjs'), OUT, '--merge'], {
  cwd: ROOT, encoding: 'utf8',
});
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status !== 0) {
  console.error('\n✗ 预览合并失败（先修上方的校验错误）。');
  process.exit(r.status || 1);
}

console.log(`\n预览集: ${OUT}`);
console.log('注意：这是各 part 的合并快照，**不是** Lead 的正式 rules.json。');

if (regress) {
  console.log('\n对预览集跑回归…\n');
  const g = spawnSync(process.execPath, [join(ROOT, 'tools', 'case_regression.mjs'), `--rules=${OUT}`], {
    cwd: ROOT, encoding: 'utf8',
  });
  process.stdout.write(g.stdout || '');
  process.stderr.write(g.stderr || '');
  // 回归工具默认会把结果写到 knowledge/CASE-CALIBRATION.md（Lead 地盘）——
  // 预览模式不应覆盖它。若发现被覆盖，用 git checkout 恢复（见 DECISIONS D10）。
  console.log('\n提示：回归工具默认会覆盖 knowledge/CASE-CALIBRATION.md。');
  console.log('如果那是 Lead 的正式记录而不是你的预览结果，请告知 Lead 用 git 恢复。');
  process.exit(g.status || 0);
}
