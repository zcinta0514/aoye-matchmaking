export function validateSubmission(form, fieldsDoc) {
  const errors = [];
  const warnings = [];
  const clean = {};
  if (form === null || typeof form !== "object") {
    return { ok: false, errors: [{ field: "_", message: "表单必须是对象" }], warnings, clean };
  }
  fieldsDoc.fields.forEach((field) => {
    const raw = form[field.id];
    const empty = raw === undefined || raw === null || raw === "";
    if (empty) {
      if (field.required) errors.push({ field: field.id, message: "必填：" + field.label });
      return;
    }
    if (field.type === "number" || field.type === "scale") {
      if (typeof raw === "boolean" || (typeof raw !== "number" && typeof raw !== "string")) {
        errors.push({ field: field.id, message: field.label + " 类型必须是数字" });
        return;
      }
      const text = String(raw).trim();
      const num = Number(text);
      if (text === "" || !Number.isFinite(num)) {
        errors.push({ field: field.id, message: field.label + " 必须是数字" });
        return;
      }
      if (field.min !== undefined && num < field.min) errors.push({ field: field.id, message: field.label + " 不能小于 " + field.min });
      if (field.max !== undefined && num > field.max) errors.push({ field: field.id, message: field.label + " 不能大于 " + field.max });
      clean[field.id] = num;
      return;
    }
    if (field.type === "radio" || field.type === "select") {
      const allowed = (field.options || []).map((option) => option.value);
      if (allowed.indexOf(raw) === -1) {
        errors.push({ field: field.id, message: field.label + " 取值不在选项中" });
        return;
      }
      clean[field.id] = raw;
      return;
    }
    if (typeof raw !== "string" && typeof raw !== "number") {
      errors.push({ field: field.id, message: field.label + " 类型必须是文本" });
      return;
    }
    const text = String(raw);
    if (text.length > 200) warnings.push(field.label + " 超过 200 字符，已截断（原长 " + text.length + "）");
    clean[field.id] = text.slice(0, 200);
  });
  if (typeof clean.want_age_min === "number" && typeof clean.want_age_max === "number" && clean.want_age_min > clean.want_age_max) {
    errors.push({ field: "want_age_range", message: "期望对方年龄下限不能大于上限" });
  }
  if (clean.want_gender && clean.gender && clean.want_gender === clean.gender) {
    warnings.push("期望对方性别与本人性别相同：请确认这是有意填写。");
  }
  return { ok: errors.length === 0, errors, warnings, clean };
}
