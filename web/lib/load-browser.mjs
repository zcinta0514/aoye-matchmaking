/* 浏览器加载层：与 Node 版 readJson 同为同步签名，但数据来自预加载缓存。
   静态版启动时先 await preloadData([...])，之后所有引擎代码照常同步运行。 */

const cache = new Map();
let dataDir = "./data/";

export function setDataDir(dir) {
  if (dir) dataDir = dir.indexOf("/") === 0 || dir.indexOf(".") === 0 || dir.indexOf("http") === 0 ? dir : "./" + dir + "/";
}

export function getDataDir() {
  return dataDir;
}

function normalize(file) {
  const text = String(file);
  if (text.indexOf("http://") === 0 || text.indexOf("https://") === 0) return text;
  if (text.indexOf("data/") === 0) return dataDir.replace(/[/]+$/, "") + "/" + text.slice(5);
  const base = text.split("/").pop();
  return dataDir.replace(/[/]+$/, "") + "/" + base;
}

export async function preloadData(files, dir) {
  if (dir) setDataDir(dir);
  const results = [];
  for (const file of files) {
    const url = normalize(file);
    if (cache.has(url)) continue;
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error("加载数据失败：" + url + "（HTTP " + response.status + "）");
    const json = await response.json();
    cache.set(url, json);
    const plain = file.split("/").pop();
    cache.set(dataDir.replace(/[/]+$/, "") + "/" + plain, json);
    results.push(url);
  }
  return results;
}

export function readJson(file) {
  const url = normalize(file);
  if (cache.has(url)) return cache.get(url);
  const plain = String(file).split("/").pop();
  for (const key of cache.keys()) {
    if (key.endsWith("/" + plain)) return cache.get(key);
  }
  throw new Error("readJson: " + file + " 未预加载（静态版需先 preloadData）");
}

export function hasData(file) {
  try {
    readJson(file);
    return true;
  } catch {
    return false;
  }
}

export const fsShim = {
  existsSync: (file) => hasData(file),
  readFileSync: () => { throw new Error("静态版无文件系统（readFileSync 不可用）"); },
  statSync: () => ({ mode: 0o600, size: 0 }),
  mkdirSync: () => {},
  writeFileSync: () => { throw new Error("静态版无文件系统（writeFileSync 不可用）"); }
};

export const pathShim = {
  join: function () { return Array.prototype.slice.call(arguments).join("/").replace(/[/]{2,}/g, "/"); },
  dirname: (p) => { const parts = String(p).split("/"); parts.pop(); return parts.join("/") || "."; },
  resolve: (p) => String(p),
  extname: (p) => { const m = /(.[^./]*)$/.exec(String(p)); return m ? m[1] : ""; },
  sep: "/"
};

export const cryptoShim = {
  randomBytes: (size) => ({
    toString: () => {
      let out = "";
      while (out.length < size * 2) out += Math.floor(Math.random() * 16).toString(16);
      return out.slice(0, size * 2);
    }
  })
};

export function fileURLToPath(url) {
  return String(url);
}
