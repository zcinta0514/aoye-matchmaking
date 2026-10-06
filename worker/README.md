# 模型代理 Worker（Cloudflare Workers）

给 GitHub Pages 静态版（`--photos=proxy`）用的模型代理：**访客不需要填 key，key 存在 Worker 服务端**。

---

## 先做这一步（唯一的可靠保护）

**去你的模型服务商后台，设置月度额度上限（比如 20 元/月）。**

Worker 能让 key 不进仓库、不进前端，但**挡不住有人刷**——本代码里的限流是「尽力而为」：
内存 Map、isolate 级、重启即失效、多 isolate 不共享，任何人都能绕过。
**只有服务商后台的月度额度上限能真正兜住成本。** 请务必先去设，再部署本 Worker。

---

## 部署（全程网页操作，不用 npm / 不用 wrangler）

1. 注册/登录 Cloudflare（免费账号即可）→ 控制台 **Workers & Pages** → **Create** → **Create Worker** → 起个名字（如 `aoye-llm-proxy`）→ **Deploy**。
2. 在 Worker 详情页点 **Edit code**，把本目录的 `index.js` 全量粘贴进去 → **Deploy**。
3. 进入 **Settings → Variables and Secrets**，添加以下变量：

   | 变量名 | 类型 | 说明 |
   |---|---|---|
   | `AOYE_LLM_API_KEY` | **Secret（加密）** | 你的服务商 key。务必选 Secret，不要选 Text |
   | `AOYE_LLM_BASE_URL` | Text | 形如 `https://api.example.com/v1`（OpenAI 兼容） |
   | `AOYE_LLM_MODEL` | Text | 支持图片输入的模型名（会覆盖前端传来的 model） |
   | `ALLOWED_ORIGIN` | Text | 你的 Pages 域名，如 `https://<user>.github.io`（多个用英文逗号分隔）。**不要写 `*`** |
   | `AOYE_LLM_TIMEOUT_MS` | Text（可选） | 默认 60000 |

4. 保存后复制 Worker 域名：`https://<名字>.<账号>.workers.dev`。
5. 构建静态站并指向它：

   ~~~
   node tools/build-static.mjs --photos=proxy --proxy-url=https://<名字>.<账号>.workers.dev
   ~~~

   把 `dist/` 发布到 GitHub Pages 即可（`ALLOWED_ORIGIN` 要填 Pages 的实际来源）。

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/analyze` | 请求体与前端 `provider.mjs` 直连时完全一致（`{model, temperature, messages}`）；Worker 注入密钥后转发到 `{AOYE_LLM_BASE_URL}/chat/completions`，原样返回上游响应 |
| GET | `/health` | 探活（返回是否已配置与量级限制，不含任何密钥） |
| OPTIONS | 任意 | CORS 预检（只对 `ALLOWED_ORIGIN` 返回 ACAO） |

## 硬性限制（代码常量，见 `index.js` 的 `LIMITS`）

- 图片 ≤ **2 张**（比本机版少，降本）
- 图片总量（base64 解码后）≤ **6MB**；单请求体 ≤ **8MB** → 超限 413 + 可读原因
- 每 IP **每小时 3 次**（内存计数，尽力而为）→ 超限 429 + `retryAfterSec`
- 上游超时默认 **60s** → 504

## 防护边界（如实说）

| 能防 | 防不住 |
|---|---|
| key 不进仓库 / 不进前端 / 不进日志 | 有人反复调用（换 IP、清计数、多 isolate 都会绕过内存限流） |
| 前端来源限制（CORS，浏览器侧） | 直接 curl 你的 Worker（CORS 不是访问控制） |
| 单次请求量级（2 张 / 6MB / 8MB） | 长期累计消耗（**只能靠服务商月度额度上限**） |
| 未配置时的 503 明确报错 | 上游服务商自身的故障/限流 |

## 本地测试

~~~
node --test worker/test.mjs
~~~

（mock fetch + mock env：转发正确性、413、429、CORS、密钥不泄漏、/health。）
