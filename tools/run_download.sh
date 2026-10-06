#!/bin/bash
# 下载器：按优先级逐个账号下载视频并转码为 16k 单声道 wav（网络/IO 密集，高并发）。
# 与 run_transcribe_loop.sh 通过文件系统协作：谁先完成都行。
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
CONC_DL="${CONC_DL:-12}"
echo "[download] $(date '+%F %T') 启动，并发 $CONC_DL"
while read -r acct; do
  [ -z "$acct" ] && continue
  [ -f "data/meta/manifests/$acct.json" ] || continue
  n=$(node -e "console.log(require('./data/meta/manifests/$acct.json').length)")
  [ "$n" -eq 0 ] && continue
  echo "[download] $(date '+%T') $acct ($n 条)"
  node tools/pipeline.mjs --account "$acct" --concurrency "$CONC_DL" --stage audio 2>&1 | tail -1
done < data/meta/priority.txt
touch data/.download_done
echo "[download] $(date '+%F %T') 全部下载完成"
