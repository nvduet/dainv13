import { DEFAULT_COLUMN_WIDTHS, DEFAULT_LEDGER, FONT_SIZE, QR_SIZE } from "/shared/constants.mjs";

export function defaultColumnWidths() {
  return JSON.parse(JSON.stringify(DEFAULT_COLUMN_WIDTHS));
}

// Dữ liệu dùng chung của trang. state.expenses giữ bản đã lưu trên máy chủ (hợp nhất theo phản hồi lưu);
// thay đổi chưa lưu nằm trong hàng đợi tự lưu và trong các ô của bảng Detail.
export const state = {
  // Đã tải xong dữ liệu lần đầu (xuất Excel chờ tới lúc này).
  loaded: false,
  members: [],
  groups: [],
  expenses: [],
  payments: [],
  isAdmin: false,
  storePasswordVerified: false,
  historyPoints: [],
  auditSessions: [],
  ledger: { ...DEFAULT_LEDGER },
  ledgers: [],
  qrSize: QR_SIZE.default,
  fontSize: FONT_SIZE.default,
  columnWidths: defaultColumnWidths(),
};
