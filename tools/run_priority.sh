#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
CONC="${CONC:-6}"
echo "[run_priority] start $(date '+%F %T')"
while read -r acct; do
  [ -z "$acct" ] && continue
  [ -f "data/meta/manifests/$acct.json" ] || continue
  n=$(node -e "console.log(require('./data/meta/manifests/$acct.json').length)")
  [ "$n" -eq 0 ] && continue
  node tools/pipeline.mjs --account "$acct" --concurrency "$CONC" 2>&1 | tail -2
done < data/meta/priority.txt
echo "[run_priority] done $(date '+%F %T')"
