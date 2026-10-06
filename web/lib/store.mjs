import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic, newId } from "./util.mjs";

const MIME_EXT = { "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif" };
const EXT_MIME = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif" };

export function createStore(dataDir) {
  const uploadsDir = path.join(dataDir, "uploads");
  const reportsFile = path.join(dataDir, "reports.json");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const reports = fs.existsSync(reportsFile) ? readJson(reportsFile) : {};

  return {
    uploadsDir,
    reportsFile,
    savePhoto(buffer, mime) {
      const ext = MIME_EXT[String(mime || "").toLowerCase()] || ".jpg";
      const id = newId("ph");
      const file = path.join(uploadsDir, id + ext);
      fs.writeFileSync(file, buffer);
      return { id, file, path: file, mime: EXT_MIME[ext] || "application/octet-stream", bytes: buffer.length };
    },
    getPhoto(id) {
      for (const ext of Object.keys(EXT_MIME)) {
        const file = path.join(uploadsDir, id + ext);
        if (fs.existsSync(file)) return { id, file, path: file, mime: EXT_MIME[ext], bytes: fs.statSync(file).size };
      }
      return null;
    },
    saveReport(report) {
      reports[report.id] = report;
      writeJsonAtomic(reportsFile, reports);
      return report;
    },
    getReport(id) {
      return reports[id] || null;
    },
    listReports(limit) {
      return Object.values(reports)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit || 20)
        .map((report) => ({ id: report.id, createdAt: report.createdAt, gender: report.subject.gender, city: report.subject.city, level: report.level }));
    }
  };
}
