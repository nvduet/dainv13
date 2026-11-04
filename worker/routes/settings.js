import { FONT_SIZE, QR_SIZE } from "../../public/shared/constants.mjs";
import { audit } from "../audit.js";
import { error, json, readJson } from "../http.js";
import { validColumnWidths } from "../validation.js";

function integerSetting(field, range, message) {
  return {
    message,
    parse: (body) => Number.isSafeInteger(body[field]) && body[field] >= range.min && body[field] <= range.max
      ? body[field]
      : undefined,
    valueJson: String,
    auditAfter: (value) => ({ [field]: value }),
    response: (value) => ({ [field]: value }),
  };
}

// Global settings (global_app_settings), shared by every ledger and audited in the default audit_log.
const SETTINGS = Object.freeze({
  "column-widths": {
    message: "Độ rộng cột không hợp lệ hoặc nằm ngoài giới hạn cho phép.",
    parse: (body) => validColumnWidths(body) ? body : undefined,
    valueJson: JSON.stringify,
    auditAfter: (value) => value,
    response: (value) => ({ columnWidths: value }),
  },
  "font-size": integerSetting("fontSize", FONT_SIZE,
    `Cỡ chữ phải nằm trong khoảng ${FONT_SIZE.min}% đến ${FONT_SIZE.max}%.`),
  "qr-size": integerSetting("qrSize", QR_SIZE,
    `Kích thước ảnh QR phải nằm trong khoảng ${QR_SIZE.min}px đến ${QR_SIZE.max}px.`),
});

export function settingHandler(key) {
  const setting = SETTINGS[key];
  return async ({ request, globalDB, auditActor }) => {
    const body = await readJson(request);
    const value = setting.parse(body);
    if (value === undefined) return error(setting.message);
    await globalDB.batch([
      globalDB.prepare(`
        INSERT INTO global_app_settings (key, value_json) VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json
      `).bind(key, setting.valueJson(value)),
      audit(globalDB, auditActor, "configure", "settings", key, null, setting.auditAfter(value)),
    ]);
    return json(setting.response(value));
  };
}
