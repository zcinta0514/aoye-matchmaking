#!/bin/bash
# 把 worker/index.js 部署到 Cloudflare Workers。
#
# 用法：
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy bash tools/deploy_worker.sh [worker名]
#
# 设计原则：
#   - 本脚本**不接收、不写入任何模型密钥**。AOYE_LLM_API_KEY 由委托人在 Cloudflare
#     后台自行填写（Secret 类型），脚本全程不接触。
#   - 只注入 3 个非敏感明文变量：AOYE_LLM_BASE_URL / AOYE_LLM_MODEL / ALLOWED_ORIGIN
#     （可由环境变量覆盖；未提供则用下方默认值）。
#   - 密钥只从环境变量读；不落盘、不回显、不进 shell history（调用方用 read -s 传）。

set -uo pipefail

API="https://api.cloudflare.com/client/v4"
SCRIPT_NAME="${1:-aoye-proxy}"
CODE_FILE="${CODE_FILE:-worker/index.js}"

ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://zcinta0514.github.io}"
BASE_URL="${AOYE_LLM_BASE_URL:-}"
MODEL="${AOYE_LLM_MODEL:-}"

die() { echo "✗ $*" >&2; exit 1; }

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "缺少 CLOUDFLARE_API_TOKEN"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "缺少 CLOUDFLARE_ACCOUNT_ID"
[ -f "$CODE_FILE" ] || die "找不到代码文件 $CODE_FILE"

# 防呆：绝不能把密钥写进这个脚本或提交进仓库
if grep -qE 'sk-[A-Za-z0-9]{16,}' "$CODE_FILE"; then
  die "$CODE_FILE 里疑似有真实密钥，停止部署"
fi

echo "=== 部署 Worker: $SCRIPT_NAME ==="
echo "  账号   : ${CLOUDFLARE_ACCOUNT_ID:0:6}……"
echo "  代码   : $CODE_FILE ($(wc -l < "$CODE_FILE" | tr -d ' ') 行)"
echo "  来源白名单: $ALLOWED_ORIGIN"
echo

# ── 构造 bindings（只含明文变量，不含任何密钥）──────────────────────────
BINDINGS="[{\"type\":\"plain_text\",\"name\":\"ALLOWED_ORIGIN\",\"text\":\"$ALLOWED_ORIGIN\"}"
[ -n "$BASE_URL" ] && BINDINGS="$BINDINGS,{\"type\":\"plain_text\",\"name\":\"AOYE_LLM_BASE_URL\",\"text\":\"$BASE_URL\"}"
[ -n "$MODEL" ]    && BINDINGS="$BINDINGS,{\"type\":\"plain_text\",\"name\":\"AOYE_LLM_MODEL\",\"text\":\"$MODEL\"}"
BINDINGS="$BINDINGS]"

METADATA="{\"main_module\":\"index.js\",\"compatibility_date\":\"2025-01-01\",\"bindings\":$BINDINGS}"

# ── 上传脚本 ────────────────────────────────────────────────────────────
RESP=$(curl -sS -X PUT \
  "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$SCRIPT_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "metadata=$METADATA;type=application/json" \
  -F "index.js=@$CODE_FILE;type=application/javascript+module" \
  --max-time 120 2>&1)

echo "$RESP" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('✗ 无法解析响应：', sys.stdin.read()[:300]); sys.exit(1)
if not d.get('success'):
    print('✗ 上传失败：')
    for e in d.get('errors',[])[:4]: print('   ', e.get('code'), e.get('message'))
    sys.exit(1)
print('✓ 脚本已上传')
"

# ── 打开 workers.dev 子域名 ─────────────────────────────────────────────
echo
echo "=== 启用 workers.dev 子域名 ==="
curl -sS -X POST \
  "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$SCRIPT_NAME/subdomain" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"enabled":true,"previews_enabled":false}' \
  --max-time 60 2>&1 | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('  ⚠ 响应异常，稍后用 /health 实测确认'); sys.exit(0)
print('  ✓ 已启用' if d.get('success') else '  ⚠ 启用失败（可能已启用过）')
"

# ── 拿访问地址 ─────────────────────────────────────────────────────────
echo
echo "=== 访问地址 ==="
SUB=$(curl -sS "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --max-time 60 2>/dev/null \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('result',{}).get('subdomain',''))" 2>/dev/null)
if [ -n "$SUB" ]; then
  echo "  https://$SCRIPT_NAME.$SUB.workers.dev"
  echo "$SUB" > /tmp/aoye_worker_subdomain.txt
else
  echo "  未能自动获取；请在 Cloudflare 后台查看"
fi

echo
echo "── 下一步（委托人操作）──────────────────────────────────────"
echo "  在 Cloudflare 后台该 Worker 的 Settings → Variables and Secrets 填："
echo "    AOYE_LLM_API_KEY   (类型选 Secret)"
echo "    AOYE_LLM_BASE_URL  （脚本已代填，可改为你的服务商）"
echo "    AOYE_LLM_MODEL     （脚本已代填）"
echo
echo "  填完用下面这条自检（configured 应为 true，且不出现 key）："
echo "    curl -sS https://$SCRIPT_NAME.${SUB:-<你的子域>}.workers.dev/health"
