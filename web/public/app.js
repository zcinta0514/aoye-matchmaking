const state = { fields: [], groups: [], files: [], meta: null };

const TOKEN_KEY = "aoye_access_token";

function getToken() {
  try { return window.localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function setToken(value) {
  try { window.localStorage.setItem(TOKEN_KEY, value); } catch { /* 忽略隐私模式限制 */ }
}

function authHeaders(extra) {
  const token = getToken();
  return Object.assign({}, token ? { "x-aoye-token": token } : {}, extra || {});
}

/** 带令牌请求；401 时询问一次访问令牌并重试。 */
async function authFetch(url, options, allowRetry) {
  const opts = Object.assign({}, options || {}, { headers: authHeaders(options && options.headers) });
  const response = await fetch(url, opts);
  if (response.status === 401 && allowRetry !== false) {
    const entered = window.prompt("该服务已开启访问令牌（AOYE_ACCESS_TOKEN）。请输入令牌：", getToken());
    if (entered) {
      setToken(entered.trim());
      return authFetch(url, options, false);
    }
  }
  return response;
}

let sampleCache = null;

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
    control.setAttribute("data-field-wrapper", field.id);
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
    control = el("input", {
      type: field.type === "number" ? "number" : "text",
      id: "f-" + field.id, name: field.id,
      min: field.min === undefined || field.min === null ? undefined : field.min, max: field.max === undefined || field.max === null ? undefined : field.max, step: field.step || "any",
      placeholder: field.placeholder || ""
    });
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
    (state.fields.filter((field) => field.group === group.id)).forEach((field) => section.appendChild(renderField(field)));
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

async function fillSample() {
  const note = document.getElementById("sample-note");
  note.classList.remove("hidden");
  if (!sampleCache) {
    note.textContent = "加载示例数据…";
    const response = await authFetch("/api/sample");
    sampleCache = await response.json();
    if (sampleCache.error) {
      note.textContent = "示例数据加载失败：" + sampleCache.error;
      return;
    }
  }
  const sample = sampleCache;
  Object.keys(sample.form).forEach((key) => {
    const value = sample.form[key];
    const field = state.fields.find((item) => item.id === key);
    if (!field) return;
    if (field.type === "radio" || field.type === "scale") {
      const selector = 'input[name="' + key + '"][value="' + value + '"]';
      const input = document.querySelector(selector);
      if (input) input.checked = true;
    } else {
      const input = document.getElementById("f-" + key);
      if (input) input.value = value;
    }
  });
  note.innerHTML = "<strong>" + sample.label + "</strong>　案例 " + sample.caseId + "（" + sample.source.account + " / " + sample.source.aweme_id + "）" +
    "<br>示例填写中的假设（案例未提供 / 映射说明）：" +
    "<ul>" + sample.assumptions.map((item) => "<li>" + item + "</li>").join("") + "</ul>";
}

function renderPhotoPreviews() {
  const box = document.getElementById("photo-previews");
  box.innerHTML = "";
  state.files.forEach((file) => {
    const figure = el("figure");
    figure.appendChild(el("img", { src: URL.createObjectURL(file), alt: file.name }));
    figure.appendChild(el("figcaption", { text: file.name + " · " + Math.round(file.size / 1024) + "KB" }));
    box.appendChild(figure);
  });
}

async function uploadPhotos() {
  const ids = [];
  for (const file of state.files) {
    const response = await authFetch("/api/photos", {
      method: "POST",
      headers: { "content-type": file.type || "image/jpeg" },
      body: file
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "照片上传失败");
    ids.push(payload.id);
  }
  return ids;
}

async function submit(event) {
  event.preventDefault();
  const button = document.getElementById("submit-btn");
  const status = document.getElementById("form-status");
  const errors = document.getElementById("form-errors");
  errors.classList.add("hidden");
  errors.innerHTML = "";
  button.disabled = true;
  try {
    status.textContent = state.files.length ? "上传照片…" : "跳过照片（纯表单模式）…";
    const photoIds = await uploadPhotos();
    status.textContent = "计算中（规则引擎 + 交叉校准）…";
    const response = await authFetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: collectForm(), photoIds })
    });
    const payload = await response.json();
    if (!response.ok) {
      errors.classList.remove("hidden");
      const details = (payload.details || []).map((item) => "<li>" + item.field + ": " + item.message + "</li>").join("");
      errors.innerHTML = "<strong>" + (payload.error || "生成失败") + "</strong>" + (details ? "<ul>" + details + "</ul>" : "");
      status.textContent = "";
      button.disabled = false;
      return;
    }
    status.textContent = "完成，跳转报告…";
    window.location.href = "/r/" + payload.id;
  } catch (error) {
    errors.classList.remove("hidden");
    errors.textContent = String(error.message || error);
    status.textContent = "";
    button.disabled = false;
  }
}

async function showMeta() {
  const panel = document.getElementById("meta-panel");
  if (!state.meta) {
    const response = await authFetch("/api/meta");
    state.meta = await response.json();
  }
  panel.classList.toggle("hidden");
  const meta = state.meta;
  const provider = meta.provider.configured ? meta.provider.baseUrl + " / " + meta.provider.model : "未配置（纯表单模式）";
  panel.innerHTML =
    "<strong>规则集</strong>　knowledge v" + meta.main.version + "（覆盖率 " + ((meta.main.corpus && meta.main.corpus.coveragePct) || "?") + "%）" +
    "　基线补缺 v" + meta.baseline.version + "<br>" +
    "规则 " + meta.counts.rules + " 条（知识库可执行 " + meta.counts.knowledgeExecutableRules + " / 基线可执行 " + meta.counts.executableRules + " / 参考 " + meta.counts.advisoryRules + " / 未结构化 " + meta.counts.unstructuredRules + "）" +
    "，维度 " + meta.counts.dimensions + " 个，梯队 " + meta.counts.bands + " 个<br>" +
    "模型：" + provider + "　访问令牌：" + (meta.auth && meta.auth.tokenRequired ? "已启用" : "未启用（仅本机）") +
    ((meta.warnings && meta.warnings.length) ? "<br><span class='warn-line'>⚠ " + meta.warnings.join("<br>⚠ ") + "</span>" : "");
}

async function main() {
  const response = await fetch("/api/form");
  const doc = await response.json();
  state.fields = doc.fields;
  state.groups = doc.groups;
  renderForm();
  document.getElementById("photo-input").addEventListener("change", (event) => {
    state.files = Array.from(event.target.files).slice(0, 1);
    renderPhotoPreviews();
  });
  document.getElementById("fill-sample").addEventListener("click", fillSample);
  document.getElementById("report-form").addEventListener("submit", submit);
  document.getElementById("meta-link").addEventListener("click", (event) => { event.preventDefault(); showMeta(); });
}

main();
