import fs from "node:fs";

/* .env.local：本地模型凭据（KEY=VALUE，无引号；忽略空行与 # 注释）。
   安全约束：
   - 只导入 AOYE_LLM_* 前缀的键，绝不把文件里的任意键写进进程环境；
   - 已存在的真实环境变量优先，文件值不覆盖；
   - 权限过宽时告警（不阻止启动）。 */

const ALLOWED_PREFIX = "AOYE_LLM_";

export function loadEnvLocal(file, env) {
  const target = env || process.env;
  const result = { loaded: false, path: file || null, applied: [], skippedExisting: [], ignoredKeys: [], warnings: [] };
  if (!file || !fs.existsSync(file)) return result;

  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    result.warnings.push(".env.local 读取失败：" + String(error && error.message ? error.message : error));
    return result;
  }
  result.loaded = true;

  text.split(String.fromCharCode(10)).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.indexOf("#") === 0) return;
    const eq = line.indexOf("=");
    if (eq === -1) return;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) return;
    if (key.indexOf(ALLOWED_PREFIX) !== 0) {
      result.ignoredKeys.push(key);
      return;
    }
    if (target[key] !== undefined && target[key] !== "") {
      result.skippedExisting.push(key);
      return;
    }
    target[key] = value;
    result.applied.push(key);
  });

  try {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      result.warnings.push(".env.local 权限过宽（" + mode.toString(8) + "）：同机其他用户可读，建议 chmod 600 " + file);
    }
  } catch {
    /* 取不到权限就不告警 */
  }
  return result;
}

/** 启动日志/接口只暴露 base_url 的协议 + 主机名，不带路径与 query。 */
export function safeBaseUrl(baseUrl) {
  if (!baseUrl) return "(未设置)";
  try {
    const url = new URL(String(baseUrl));
    return url.protocol + "//" + url.host;
  } catch {
    return "(无法解析的 base_url)";
  }
}
