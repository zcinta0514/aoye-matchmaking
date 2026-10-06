#!/bin/bash
# 转写循环：反复扫描「已有音频但还没转写」的文件，用常驻进程分片转写。
# 没有待办时短暂休眠再扫，直到下载器写完 data/.download_done 且队列空。
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
SHARDS="${SHARDS:-3}"
PY="${PY:-/tmp/aoye_test/venv/bin/python}"
IDLE=0

echo "[transcribe] $(date '+%F %T') 启动，分片 $SHARDS"
while true; do
  node -e "
const fs=require('fs'), path=require('path');
const A='data/audio', T='data/transcripts';
const rows=[];
for (const acct of fs.readdirSync(A)) {
  const dir=path.join(A,acct);
  try { if(!fs.statSync(dir).isDirectory()) continue; } catch(e){ continue; }
  const out=path.join(T,acct); fs.mkdirSync(out,{recursive:true});
  for (const f of fs.readdirSync(dir)) {
    if(!f.endsWith('.wav')) continue;
    const base=f.replace(/\.wav$/,'');
    if (fs.existsSync(path.join(out,base+'.txt'))) continue;
    rows.push([path.resolve(dir,f), path.resolve(out), base].join('\t'));
  }
}
fs.writeFileSync('/tmp/aoye_jobs.list', rows.join('\n')+(rows.length?'\n':''));
console.log(rows.length);
" > /tmp/aoye_jobcount
  TOTAL=$(cat /tmp/aoye_jobcount)
  if [ "$TOTAL" = "0" ]; then
    if [ -f data/.download_done ]; then
      echo "[transcribe] $(date '+%F %T') 队列清空且下载已完成，退出"
      break
    fi
    IDLE=$((IDLE+1))
    [ $((IDLE % 10)) -eq 1 ] && echo "[transcribe] $(date '+%T') 暂无待办，等待下载器…"
    sleep 20
    continue
  fi
  IDLE=0
  echo "[transcribe] $(date '+%T') 本轮 $TOTAL 条"
  pids=()
  for i in $(seq 0 $((SHARDS-1))); do
    NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
      "$PY" tools/transcribe_batch.py --list /tmp/aoye_jobs.list --shard "$i/$SHARDS" \
      >> "logs/transcribe_shard$i.log" 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  grep -h "rate=" "logs/transcribe_shard0.log" 2>/dev/null | tail -1
done
echo "[transcribe] $(date '+%F %T') 结束"
