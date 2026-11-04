// Định dạng/chuyển đổi số tiền và chuỗi hiển thị, không phụ thuộc DOM (có kiểm thử node:test).
import { parseThousandInput } from "../accounting.mjs";

const viNumber = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export function formatVnd(amount) {
  return `${viNumber.format(amount)}đ`;
}

// Ô "Đã chuyển khoản": giữ dấu "-" vừa gõ khi chưa có chữ số nào.
export function formatVndInput(value) {
  const text = String(value);
  const negative = /^\s*-/.test(text);
  const digits = text.replace(/\D/g, "");
  if (!digits) return negative ? "-" : "";
  return `${negative ? "-" : ""}${BigInt(digits).toLocaleString("vi-VN")}đ`;
}

// Định dạng lại ô chuyển khoản khi đang gõ; con trỏ đứng sau đúng số chữ số đã gõ trước nó (và sau dấu "-").
export function formatTransferInput(value, cursor = value.length) {
  const beforeCursor = value.slice(0, cursor);
  const digitsBeforeCursor = beforeCursor.replace(/\D/g, "").length;
  const formatted = formatVndInput(value);
  let nextCursor = /^\s*-/.test(beforeCursor) && formatted.startsWith("-") ? 1 : 0;
  let digitCount = 0;
  while (nextCursor < formatted.length && digitCount < digitsBeforeCursor) {
    if (/\d/.test(formatted[nextCursor])) digitCount += 1;
    nextCursor += 1;
  }
  return { value: formatted, cursor: nextCursor };
}

export function parseTransferInput(value) {
  const text = String(value);
  const digits = text.replace(/\D/g, "");
  return digits ? BigInt(digits) * (/^\s*-/.test(text) ? -1n : 1n) : 0n;
}

export function formatThousandInput(amountVnd) {
  return (amountVnd / 1000).toFixed(3).replace(/\.?0+$/, "");
}

export function formatAverageThousand(amountVnd, count) {
  const text = (amountVnd / count / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 0 });
  return text === "-0" ? "0" : text;
}

// Ô Chi phí khi gõ: ô trống hoặc số làm tròn thành 0 đồng là 0; chữ sai định dạng hoặc vượt giới hạn ném lỗi.
// Ô cũng nhận phép tính nghìn đồng ("120+45"): xem trước và lưu theo kết quả.
export function parseAmountInput(text) {
  return text.trim() ? parseThousandInput(text, { allowZero: true }) : 0;
}

// Ô trống hoặc chưa hợp lệ được tính là 0 khi xem trước số dư.
export function parseAmountOrZero(text) {
  try {
    return parseAmountInput(text);
  } catch {
    return 0;
  }
}

// "-(…)" bọc trọn cả phép tính (dấu ngoặc mở thứ hai khớp với dấu ngoặc đóng cuối cùng).
function wrappedNegation(text) {
  if (!text.startsWith("-(") || !text.endsWith(")")) return false;
  let depth = 0;
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    if (text[index] === ")") depth -= 1;
    if (depth === 0) return index === text.length - 1;
  }
  return false;
}

// Nút "±" của ô Chi phí (bàn phím số iPhone không có dấu trừ): thêm/bỏ dấu "-" đầu ô như khi gõ,
// con trỏ giữ nguyên vị trí so với các chữ số. Ô đang là phép tính ("120+45") thì đổi dấu cả phép tính:
// "-(120+45)", bấm lại thì về "120+45".
export function toggleAmountSign(value, selectionStart = value.length, selectionEnd = selectionStart) {
  const text = value.trimStart();
  const trimmed = value.length - text.length;
  if (/[-+*/()−×÷]/.test(text.slice(1)) || /[+*/()−×÷]/.test(text[0] ?? "")) {
    const unwrap = wrappedNegation(text);
    const next = unwrap ? text.slice(2, -1) : `-(${text})`;
    const offset = unwrap ? -2 : 2;
    const move = (position) => Math.min(Math.max(0, position - trimmed + offset), next.length - (unwrap ? 0 : 1));
    return { value: next, selectionStart: move(selectionStart), selectionEnd: move(selectionEnd) };
  }
  const shift = text.startsWith("-") ? -1 : 1;
  const move = (position) => Math.max(0, position - trimmed + shift);
  return {
    value: shift < 0 ? text.slice(1) : `-${text}`,
    selectionStart: move(selectionStart),
    selectionEnd: move(selectionEnd),
  };
}

// Máy chủ lưu giờ UTC dạng "YYYY-MM-DD HH:MM:SS"; hiển thị theo giờ của máy người xem (Việt Nam: UTC+7).
export function formatLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(`${String(value).replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number, length = 2) => String(number).padStart(length, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Ngày khoản chi "YYYY-MM-DD" theo định dạng ngày của trình duyệt, như ô Date của bảng Detail ("01/10/2026" ở vi-VN).
export function formatLocalDate(value, locale = undefined) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return value ? String(value) : "";
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toLocaleDateString(locale, { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
}

// Ngày giờ giữa câu không bị xuống dòng ở dấu "-" hay khoảng trắng (gạch nối, khoảng trắng không ngắt dòng).
export function unbreakable(text) {
  return String(text).replaceAll("-", "\u2011").replaceAll(" ", "\u00a0");
}

export function balanceClass(amountVnd) {
  return amountVnd > 0 ? "balance-positive" : amountVnd < 0 ? "balance-negative" : "balance-zero";
}

export function groupColorClass(index) {
  return `group-color-${index % 6}`;
}
