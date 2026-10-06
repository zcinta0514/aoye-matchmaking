/* 静态版表单页：无后端。数据预加载后在本机跑同一套引擎，报告存 localStorage。 */

import { preloadData, setDataDir } from "../lib/load-browser.mjs";
import { localStore } from "../lib/util.mjs";
import { loadRuleset } from "../lib/ruleset.mjs";
import { loadCities, cityTierInfo } from "../lib/city.mjs";
import { generateReport } from "../lib/pipeline.mjs";
import { buildSample } from "../lib/sample.mjs";
import { providerConfig } from "../lib/provider.mjs";

const BUILD_PHOTOS_MODE = "__PHOTOS_MODE__";
const ACCESS_CODE_KEY = "aoye:access_code";

const DATA_FILES = [
  "data/rules.json", "data/baseline-rules.json", "data/form-fields.json", "data/cities.json",
  "data/facts.json", "data/evidence-independence.json", "data/evidence-quality-flags.json",
  "data/cases.json", "data/band-criteria.json", "data/composite-criteria.json",
  "data/composite-mapping.json", "data/extrapolation-rules.json",
  "data/standards.json", "data/portrait-rules.json"
];

const state = { fields: [], groups: [], files: [], ruleset: null, cities: null, sample: null };

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((key) => {
      if (key === "text") node.textContent = attrs[key];
      else if (key === "html") node.innerHTML = attrs[key];
      else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, attrs[key]);
    });
  }
  (children || []).forEach((child) => node.appendChild(child));
  return node;
}

function renderField(field) {
  const row = el("div", { class: "field" });
  const label = el("label", { for: "f-" + field.id, text: field.label + (field.unit ? "（" + field.unit + "）" : "") });
  if (field.required) label.appendChild(el("span", { class: "req", text: "*" }));
  row.appendChild(label);
  let control;
  if (field.type === "select") {
    control = el("select", { id: "f-" + field.id, name: field.id });
    control.appendChild(el("option", { value: "", text: "请选择" }));
    (field.options || []).forEach((option) => control.appendChild(el("option", { value: option.value, text: option.label })));
  } else if (field.type === "radio") {
    control = el("div", { class: "radio-row" });
    (field.options || []).forEach((option, index) => {
      const id = "f-" + field.id + "-" + index;
      const item = el("label", { for: id });
      item.appendChild(el("input", { type: "radio", id, name: field.id, value: option.value, "data-field": field.id }));
      item.appendChild(el("span", { text: option.label }));
      control.appendChild(item);
    });
  } else if (field.type === "scale") {
    control = el("div", { class: "scale-row" });
    for (let value = field.min; value <= field.max; value += 1) {
      const id = "f-" + field.id + "-" + value;
      const item = el("label", { for: id });
      item.appendChild(el("input", { type: "radio", id, name: field.id, value: String(value), "data-field": field.id }));
      item.appendChild(el("span", { text: String(value) }));
      control.appendChild(item);
    }
  } else {
    control = el("input", { type: field.type === "number" ? "number" : "text", id: "f-" + field.id, name: field.id, min: field.min === undefined || field.min === null ? undefined : field.min, max: field.max === undefined || field.max === null ? undefined : field.max, step: field.step || "any", placeholder: field.placeholder || "" });
  }
  row.appendChild(control);
  if (field.help) row.appendChild(el("div", { class: "help", text: field.help }));
  return row;
}

function renderForm() {
  const container = document.getElementById("form-sections");
  container.innerHTML = "";
  state.groups.forEach((group) => {
    const section = el("section", { class: "card" });
    section.appendChild(el("h2", { text: group.title }));
    state.fields.filter((field) => field.group === group.id).forEach((field) => section.appendChild(renderField(field)));
    container.appendChild(section);
  });
}

function collectForm() {
  const form = {};
  state.fields.forEach((field) => {
    if (field.type === "radio" || field.type === "scale") {
      const checked = document.querySelector('input[name="' + field.id + '"]:checked');
      if (checked) form[field.id] = checked.value;
    } else {
      const input = document.getElementById("f-" + field.id);
      if (input && input.value !== "") form[field.id] = input.value;
    }
  });
  return form;
}

function fillSample(sample) {
  Object.keys(sample.form).forEach((key) => {
    const value = sample.form[key];
    const field = state.fields.find((item) => item.id === key);
    if (!field) return;
    if (field.type === "radio" || field.type === "scale") {
      const input = document.querySelector('input[name="' + key + '"][value="' + value + '"]');
      if (input) input.checked = true;
    } else {
      const input = document.getElementById("f-" + key);
      if (input) input.value = value;
    }
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataUrl: String(reader.result), mime: file.type || "image/jpeg" });
    reader.onerror = () => reject(new Error("照片读取失败"));
    reader.readAsDataURL(file);
  });
}

function ensureNote(text) {
  let note = document.getElementById("photo-mode-note");
  if (!note) {
    note = el("p", { id: "photo-mode-note", class: "muted" });
    const input = document.getElementById("photo-input");
    if (input && input.parentNode) input.parentNode.insertBefore(note, input.nextSibling);
  }
  note.textContent = text;
  return note;
}

function ensureByokPanel() {
  let panel = document.getElementById("byok-panel");
  if (panel) return panel;
  panel = el("div", { id: "byok-panel", class: "card sample-note" });
  panel.innerHTML = "<strong>照片分析（BYOK）</strong>" +
    "<p class=caveat-warning>你的 key 存在本浏览器本地，请求直连你填的服务商；本静态站无后端，无法保护它的安全。</p>" +
    "<div class=field><label for=llm-base-url>base_url</label><input id=llm-base-url type=text /></div>" +
    "<div class=field><label for=llm-key>API key</label><input id=llm-key type=password /></div>" +
    "<div class=field><label for=llm-model>model</label><input id=llm-model type=text /></div>" +
    "<button type=button class=btn id=llm-save>保存到本浏览器</button> <span id=llm-status class=muted></span>";
  const form = document.getElementById("report-form");
  if (form) form.appendChild(panel);
  return panel;
}

function applyPhotoModeUi() {
  const input = document.getElementById("photo-input");
  if (BUILD_PHOTOS_MODE === "off") {
    input.disabled = true;
    ensureNote("公开版未开放照片分析：本页只跑表单自评 + 规则引擎。自建部署可用 --photos=byok / --photos=proxy 重新构建。");
  } else if (BUILD_PHOTOS_MODE === "proxy") {
    ensureNote("图像分析由本站代理完成，无需自备 key；每日总量有限，失败请稍后重试。照片只用于本次分析，不保存在服务器。");
    setupAccessCode();
  } else {
    ensureNote("BYOK：直接在浏览器里调用你自己填写的服务商。你的 key 存在本浏览器本地，请求直连你填的服务商；本静态站无后端，无法保护它的安全。");
    const panel = ensureByokPanel();
    const saved = localStore.getJson("aoye:llm", {});
    document.getElementById("llm-base-url").value = saved.baseUrl || "";
    document.getElementById("llm-key").value = saved.apiKey || "";
    document.getElementById("llm-model").value = saved.model || "";
    panel.classList.remove("hidden");
  }
}
/* 访问码：只存在本浏览器（localStorage），不写进产物 / 日志 / 链接。 */
function getAccessCode() {
  try { return window.localStorage.getItem(ACCESS_CODE_KEY) || ""; } catch { return ""; }
}
function setAccessCode(value) {
  try {
    const text = String(value || "").trim();
    if (text) window.localStorage.setItem(ACCESS_CODE_KEY, text);
    else window.localStorage.removeItem(ACCESS_CODE_KEY);
  } catch { /* 隐私模式等：忽略 */ }
}
function refreshAccessButtons() {
  const clear = document.getElementById("access-code-clear");
  if (clear) clear.classList.toggle("hidden", !getAccessCode());
}
function openAccessPanel(message) {
  const panel = document.getElementById("access-code-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
  const status = document.getElementById("access-code-status");
  if (status) status.textContent = message || "";
  const input = document.getElementById("access-code-input");
  if (input) { input.value = getAccessCode(); input.focus(); }
  refreshAccessButtons();
}
function closeAccessPanel() {
  const panel = document.getElementById("access-code-panel");
  if (panel) panel.classList.add("hidden");
  const status = document.getElementById("access-code-status");
  if (status) status.textContent = "";
}
function setupAccessCode() {
  const panel = document.getElementById("access-code-panel");
  if (!panel) return;
  const link = document.getElementById("access-code-link");
  if (link) {
    link.classList.remove("hidden");
    link.addEventListener("click", (event) => { event.preventDefault(); openAccessPanel(""); });
  }
  document.getElementById("access-code-save").addEventListener("click", () => {
    setAccessCode(document.getElementById("access-code-input").value);
    const saved = Boolean(getAccessCode());
    document.getElementById("access-code-status").textContent = saved
      ? "已保存在本浏览器（localStorage），生成报告时会自动带上。"
      : "已清除访问码。";
    refreshAccessButtons();
    if (saved) setTimeout(closeAccessPanel, 1200);
  });
  document.getElementById("access-code-clear").addEventListener("click", () => {
    setAccessCode("");
    openAccessPanel("已清除访问码，请重新输入。");
  });
  if (!getAccessCode()) openAccessPanel("首次使用：这个工具是私人的，请先填写访问码。");
  else { refreshAccessButtons(); closeAccessPanel(); }
}

function saveByok() {
  const settings = {
    baseUrl: document.getElementById("llm-base-url").value.trim(),
    apiKey: document.getElementById("llm-key").value.trim(),
    model: document.getElementById("llm-model").value.trim(),
    vision: "auto"
  };
  localStore.setJson("aoye:llm", settings);
  globalThis.AOYE_LLM_SETTINGS = settings;
  return settings;
}

async function runReport(form, photos) {
  const info = cityTierInfo(form.city, state.cities);
  const config = BUILD_PHOTOS_MODE === "byok" ? providerConfig(saveByok()) : providerConfig({});
  return generateReport({
    form, photos, ruleset: state.ruleset, cities: state.cities,
    cityTier: info.tier, cityMatched: info.matched, config,
    independencePath: "data/evidence-independence.json",
    extrapolationPath: "data/extrapolation-rules.json",
    bandCriteriaPath: "data/band-criteria.json",
    compositeCriteriaPath: "data/composite-criteria.json",
    compositeMappingPath: "data/composite-mapping.json",
    qualityFlagsPath: "data/evidence-quality-flags.json"
  });
}

async function submit(event) {
  event.preventDefault();
  const button = document.getElementById("submit-btn");
  const status = document.getElementById("form-status");
  const errors = document.getElementById("form-errors");
  errors.classList.add("hidden");
  button.disabled = true;
  try {
    const form = collectForm();
    const fieldsDoc = state.fields;
    const missing = fieldsDoc.filter((field) => field.required && !form[field.id]).map((field) => field.label);
    if (missing.length) {
      errors.classList.remove("hidden");
      errors.innerHTML = "<strong>表单校验失败</strong><ul>" + missing.map((label) => "<li>" + label + "：必填</li>").join("") + "</ul>";
      button.disabled = false;
      return;
    }
    if (BUILD_PHOTOS_MODE === "proxy" && state.files.length && !getAccessCode()) {
      openAccessPanel("照片分析需要访问码，请先填写后再生成。");
      status.textContent = "";
      button.disabled = false;
      return;
    }
    status.textContent = "本地计算中（规则引擎 + 交叉校准）…";
    const photos = BUILD_PHOTOS_MODE !== "off" && state.files.length ? await Promise.all(state.files.map(readAsFile)) : [];
    const report = await runReport(form, photos);
    localStore.setJson("aoye:report:" + report.id, report);
    localStore.set("aoye:lastReportId", report.id);
    status.textContent = "完成，跳转报告…";
    window.location.href = "report.html?id=" + encodeURIComponent(report.id);
  } catch (error) {
    errors.classList.remove("hidden");
    errors.textContent = String(error && error.message ? error.message : error);
    status.textContent = "";
    button.disabled = false;
  }
}

async function readAsFile(file) {
  const result = await readAsDataUrl(file);
  return { dataUrl: result.dataUrl, mime: result.mime };
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  const dataDir = params.get("data") || "./data/";
  setDataDir(dataDir);
  await preloadData(DATA_FILES, dataDir);
  const fieldsDoc = (await import("../lib/load-browser.mjs")).readJson("data/form-fields.json");
  state.fields = fieldsDoc.fields;
  state.groups = fieldsDoc.groups;
  state.ruleset = loadRuleset({ mainPath: "data/rules.json", baselinePath: "data/baseline-rules.json" });
  state.cities = loadCities("data/cities.json");
  renderForm();
  applyPhotoModeUi();
  document.getElementById("photo-input").addEventListener("change", (event) => {
    state.files = Array.from(event.target.files).slice(0, 1);
    const box = document.getElementById("photo-previews");
    box.innerHTML = "";
    state.files.forEach((file) => {
      const figure = el("figure");
      figure.appendChild(el("img", { src: URL.createObjectURL(file), alt: file.name }));
      figure.appendChild(el("figcaption", { text: file.name + " · " + Math.round(file.size / 1024) + "KB" }));
      box.appendChild(figure);
    });
  });
  document.getElementById("fill-sample").addEventListener("click", async () => {
    const note = document.getElementById("sample-note");
    note.classList.remove("hidden");
    if (!state.sample) state.sample = buildSample("data/cases.json", "C-022");
    fillSample(state.sample);
    note.innerHTML = "<strong>" + state.sample.label + "</strong>　案例 " + state.sample.caseId + "；示例填写中的假设：" +
      "<ul>" + state.sample.assumptions.map((item) => "<li>" + item + "</li>").join("") + "</ul>";
  });
  document.getElementById("report-form").addEventListener("submit", submit);
  if (BUILD_PHOTOS_MODE === "byok") {
    ensureByokPanel();
    document.getElementById("llm-save").addEventListener("click", () => {
      saveByok();
      document.getElementById("llm-status").textContent = "已保存在本浏览器（localStorage），不会发给任何第三方服务器。";
    });
  }
  if (params.get("selftest") === "1") {
    state.sample = buildSample("data/cases.json", "C-022");
    fillSample(state.sample);
    await submit(new Event("submit"));
  }
}

main().catch((error) => {
  const box = document.getElementById("form-status");
  if (box) box.textContent = "静态版启动失败：" + String(error && error.message ? error.message : error);
});
