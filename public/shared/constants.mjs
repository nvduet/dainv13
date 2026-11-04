// Hằng số dùng chung cho Worker (wrangler đóng gói), giao diện (static asset) và kiểm thử.
// Đổi giá trị ở đây là đổi hành vi thật: cập nhật cả index.html, SPEC.md và migrations nếu liên quan.

export const MAX_AMOUNT_VND = 1_000_000_000_000;
export const MAX_MEMBERS = 50;
export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_HISTORY_MESSAGE_LENGTH = 200;
export const MAX_HISTORY_POINTS = 50;
export const MAX_AUDIT_SESSIONS = 999;
export const AUDIT_SESSION_IDLE_MINUTES = 30;
export const ADMIN_SESSION_HOURS = 8;

export const FONT_SIZE = Object.freeze({ min: 75, max: 200, default: 90 });
export const QR_SIZE = Object.freeze({ min: 80, max: 1600, default: 250 });
export const COLUMN_WIDTH = Object.freeze({ min: 24, max: 2000 });

export const DEFAULT_COLUMN_WIDTHS = Object.freeze({
  expense: Object.freeze({
    payer: 100,
    date: 110,
    description: 180,
    amount: 60,
    member: 60,
    count: 70,
    avg: 80,
    actions: 68,
  }),
  summary: Object.freeze({
    label: 120,
    member: 100,
  }),
});

export const DEFAULT_LEDGER = Object.freeze({ slug: "chill-guys", name: "Chill guys" });
