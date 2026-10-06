#!/bin/bash
# 批量跑完所有账号的采集+转写。后台执行，可断点续跑（pipeline.mjs 有 state 记录）。
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
CONC="${CONC:-4}"
echo "[run_all] start $(date '+%F %T')"
for f in data/meta/manifests/*.json; do
  base=$(basename "$f" .json)
  [ "$base" = "_index" ] && continue
  n=$(node -e "console.log(require('./$f').length)")
  [ "$n" -eq 0 ] && continue
  echo "=== $base ($n clips) ==="
  node tools/pipeline.mjs --account "$base" --concurrency "$CONC" 2>&1 | tail -3
done
echo "[run_all] done $(date '+%F %T')"
