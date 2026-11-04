// Cấu hình giao diện dùng chung mọi sổ: độ rộng cột, cỡ chữ, kích thước ảnh QR.
import { api } from "./api.js";
import { defaultColumnWidths, state } from "./state.js";
import { showNotice } from "./ui.js";

export function applyDisplaySettings(data) {
  state.columnWidths = data.columnWidths;
  state.qrSize = data.qrSize;
  state.fontSize = data.fontSize;
  document.querySelector("#font-size-percent").value = data.fontSize;
  document.querySelector("#qr-size-pixels").value = state.qrSize;
  document.documentElement.style.setProperty("--font-scale", String(data.fontSize / 100));
  document.documentElement.style.setProperty("--qr-image-size", `${state.qrSize}px`);
  renderColumnWidths();
}

function renderColumnWidths() {
  for (const [key, value] of Object.entries(state.columnWidths.expense)) {
    document.querySelector(`#col-width-${key}`).value = value;
  }
  for (const [key, value] of Object.entries(state.columnWidths.summary)) {
    document.querySelector(`#col-width-summary-${key}`).value = value;
  }
  document.querySelector("#expense-member-column-count").textContent = `(${state.members.length} cột)`;
  document.querySelector("#summary-member-column-count").textContent = `(${state.members.length} cột)`;
  applyExpenseColumnWidths();
  applySummaryColumnWidths();
}

// Độ rộng đã lưu là px "gốc"; bảng hiển thị px × --table-scale (styles.css: nhỏ hơn trên desktop, 1 trên điện thoại).
// Mỗi quy tắc ghi giá trị gốc trước (dễ đọc khi kiểm tra) rồi tới giá trị đã nhân hệ số.
function scaled(px) {
  return `calc(${px}px * var(--table-scale))`;
}

function fixedWidth(selector, px) {
  return `${selector} { width: ${px}px; width: ${scaled(px)} !important; min-width: ${scaled(px)} !important; max-width: ${scaled(px)} !important; }`;
}

function tableWidth(selector, px) {
  return `${selector} { width: ${px}px; width: ${scaled(px)} !important; min-width: 0 !important; max-width: none !important; table-layout: fixed !important; }`;
}

// Áp dụng độ rộng cột vào bảng chi phí; scroll-padding để ô được focus không nằm dưới cột người chi cố định.
// Cột thao tác (nhân bản, xóa) không hẹp hơn hai nút của nó ở mọi cỡ chữ: mỗi nút rộng ít nhất --row-btn (styles.css)
// và 1.1rem + 8px (đủ cho "×" và biểu tượng nhân bản: chữ 1.43rem, lề 4px), nên cột rộng ra khi tăng cỡ chữ.
export function applyExpenseColumnWidths() {
  const w = state.columnWidths.expense;
  const styleEl = document.getElementById("dynamic-column-widths");
  if (!styleEl) return;
  const others = w.payer + w.date + w.description + w.amount + state.members.length * w.member + w.count + w.avg;
  const actions = `max(${scaled(w.actions)}, 2 * max(var(--row-btn, 26px), 1.1rem + 8px))`;

  styleEl.textContent = `
    .expense-table { width: ${others + w.actions}px; width: calc(${others}px * var(--table-scale) + ${actions}) !important; min-width: 0 !important; max-width: none !important; table-layout: fixed !important; }
    ${fixedWidth(".expense-table .expense-payer", w.payer)}
    ${fixedWidth(".expense-table .expense-date", w.date)}
    ${fixedWidth(".expense-table .expense-description", w.description)}
    ${fixedWidth(".expense-table .expense-amount", w.amount)}
    ${fixedWidth(".expense-table .member-check", w.member)}
    ${fixedWidth(".expense-table .expense-count", w.count)}
    ${fixedWidth(".expense-table .expense-average", w.avg)}
    .expense-table .member-actions { width: ${w.actions}px; width: ${actions} !important; min-width: ${actions} !important; max-width: ${actions} !important; }
    .ledger-card .table-scroll { scroll-padding-left: ${scaled(w.payer)}; }
  `;
}

// Áp dụng độ rộng cột vào bảng summary
export function applySummaryColumnWidths() {
  const w = state.columnWidths.summary;
  const styleEl = document.getElementById("dynamic-summary-widths");
  if (!styleEl) return;
  const memberColumnCount = Math.max(state.members.length, 1);

  styleEl.textContent = `
    ${tableWidth(".summary-table", w.label + memberColumnCount * w.member)}
    ${fixedWidth(".summary-table .summary-label", w.label)}
    ${fixedWidth(".summary-table .summary-member", w.member)}
    .summary-scroll { scroll-padding-left: ${scaled(w.label)}; }
  `;
}

async function saveColumnWidths(updatedWidths, message) {
  try {
    const { columnWidths: savedWidths } = await api("/api/admin/column-widths", {
      method: "PUT",
      body: JSON.stringify(updatedWidths),
    });
    state.columnWidths = savedWidths;
    renderColumnWidths();
    showNotice(message);
  } catch (caught) {
    showNotice(caught.message, "error");
  }
}

function readWidthInputs(group) {
  const inputs = Object.keys(state.columnWidths[group]).map((key) =>
    document.querySelector(`#col-width-${group === "summary" ? "summary-" : ""}${key}`),
  );
  if (inputs.some((input) => !input.checkValidity())) {
    showNotice("Nhập độ rộng từ 24 đến 2.000 px cho tất cả các cột.", "error");
    return null;
  }
  return Object.fromEntries(
    Object.keys(state.columnWidths[group]).map((key, index) => [key, inputs[index].valueAsNumber]),
  );
}

export function applyExpenseWidths() {
  const expense = readWidthInputs("expense");
  if (!expense) return;
  saveColumnWidths(
    { ...state.columnWidths, expense },
    "Đã lưu độ rộng cột bảng chi phí.",
  );
}

export function applySummaryWidths() {
  const summary = readWidthInputs("summary");
  if (!summary) return;
  saveColumnWidths(
    { ...state.columnWidths, summary },
    "Đã lưu độ rộng cột bảng tổng hợp.",
  );
}

export function resetColumnWidths() {
  saveColumnWidths(
    defaultColumnWidths(),
    "Đã đặt lại độ rộng cột mặc định.",
  );
}

export async function applyFontSize() {
  const input = document.querySelector("#font-size-percent");
  if (!input.checkValidity()) {
    showNotice("Cỡ chữ phải nằm trong khoảng 75% đến 200%.", "error");
    return;
  }
  try {
    const { fontSize } = await api("/api/admin/font-size", {
      method: "PUT",
      body: JSON.stringify({ fontSize: input.valueAsNumber }),
    });
    document.documentElement.style.setProperty("--font-scale", String(fontSize / 100));
    state.fontSize = fontSize;
    input.value = fontSize;
    showNotice("Đã lưu cỡ chữ giao diện.");
  } catch (caught) {
    showNotice(caught.message, "error");
  }
}

export async function applyQrSize() {
  const input = document.querySelector("#qr-size-pixels");
  if (!input.checkValidity()) {
    showNotice("Kích thước ảnh QR phải nằm trong khoảng 80px đến 1600px.", "error");
    return;
  }
  try {
    const { qrSize } = await api("/api/admin/qr-size", {
      method: "PUT",
      body: JSON.stringify({ qrSize: input.valueAsNumber }),
    });
    state.qrSize = qrSize;
    input.value = qrSize;
    document.documentElement.style.setProperty("--qr-image-size", `${qrSize}px`);
    showNotice("Đã lưu kích thước ảnh QR.");
  } catch (caught) {
    showNotice(caught.message, "error");
  }
}
