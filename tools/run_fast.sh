#!/bin/bash
# 两阶段高速流水线：阶段1 高并发下载+转码音频（网络/IO 密集）；
#                 阶段2 常驻进程批量转写（GPU 密集，模型只加载一次）。
# 用法: CONC_DL=10 SHARDS=3 bash tools/run_fast.sh
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
CONC_DL="${CONC_DL:-10}"
SHARDS="${SHARDS:-3}"
PY="${PY:-/tmp/aoye_test/venv/bin/python}"

echo "[run_fast] $(date '+%F %T') 阶段1：下载+转码（并发 $CONC_DL）"
while read -r acct; do
  [ -z "$acct" ] && continue
  [ -f "data/meta/manifests/$acct.json" ] || continue
  node tools/pipeline.mjs --account "$acct" --concurrency "$CONC_DL" --stage audio 2>&1 | tail -1
done < data/meta/priority.txt

echo "[run_fast] $(date '+%F %T') 阶段2：构建转写任务清单"
rm -f /tmp/aoye_jobs.list
node -e "
const fs=require('fs'), path=require('path');
const A='data/audio', T='data/transcripts';
const rows=[];
for (const acct of fs.readdirSync(A)) {
  const dir=path.join(A,acct);
  if(!fs.statSync(dir).isDirectory()) continue;
  const out=path.join(T,acct); fs.mkdirSync(out,{recursive:true});
  for (const f of fs.readdirSync(dir)) {
    if(!f.endsWith('.wav')) continue;
    const base=f.replace(/\.wav$/,'');
    if (fs.existsSync(path.join(out,base+'.txt'))) continue;
    rows.push([path.resolve(dir,f), path.resolve(out), base].join('\t'));
  }
}
fs.writeFileSync('/tmp/aoye_jobs.list', rows.join('\n')+'\n');
console.log('待转写', rows.length);
"
TOTAL=$(wc -l < /tmp/aoye_jobs.list | tr -d ' ')
[ "$TOTAL" = "0" ] && { echo "[run_fast] 无待转写任务，结束"; exit 0; }

echo "[run_fast] $(date '+%F %T') 阶段3：$SHARDS 个常驻进程转写 $TOTAL 条"
pids=()
for i in $(seq 0 $((SHARDS-1))); do
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
    "$PY" tools/transcribe_batch.py --list /tmp/aoye_jobs.list --shard "$i/$SHARDS" \
    > "logs/transcribe_shard$i.log" 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
echo "[run_fast] 全部完成 $(date '+%F %T')"
tail -1 logs/transcribe_shard0.log
