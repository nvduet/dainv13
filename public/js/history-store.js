// Lịch sử "Hoàn tác" / "Làm lại" lưu trên thiết bị, mỗi sổ một khóa localStorage "so-chi:hoan-tac:<slug>": còn sau khi
// tải lại trang, đóng trình duyệt, đăng xuất/đăng nhập; không gửi lên máy chủ, không dùng chung giữa các máy. Tối đa 50
// mục mỗi ngăn (lưu nhiều hơn chỉ tốn bộ nhớ của trình duyệt). Không phụ thuộc DOM (có kiểm thử node:test): storage
// được truyền vào.
//
// Dữ liệu: { v: 1, ledger: <id của sổ>, undo: [mục…], redo: [mục…] }, mục cũ nhất trước (mục: xem undo-history.js).
// Slug được dùng lại khi một sổ bị xóa rồi tạo lại cùng tên, nên lịch sử ghi id của sổ: đọc ra mà khác id (hay thiếu)
// là lịch sử của sổ cũ, coi như trống. Đọc vào thì kiểm tra từng mục, bỏ mục hỏng hay lạ, và bỏ session (số lần focus
// chỉ có nghĩa trong trang đã ghi). Bộ nhớ bị chặn, chế độ riêng tư hay đầy không bao giờ thành lỗi: đầy
// (QuotaExceededError) thì bỏ bớt mục cũ nhất rồi thử lại một lần, không được thì lịch sử chỉ còn trong trang.
import { MAX_AMOUNT_VND, MAX_DESCRIPTION_LENGTH, MAX_EXPENSE_POSITION, MAX_MEMBERS } from "../shared/constants.mjs";

export const HISTORY_STORAGE_VERSION = 1;
export const STORED_HISTORY_LIMIT = 50;

export function historyStorageKey(slug) {
  return `so-chi:hoan-tac:${slug}`;
}

// localStorage của trang, hay null khi trình duyệt chặn (chỉ đọc thuộc tính cũng có thể ném lỗi).
export function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value) => typeof value === "string" && value.length >= 1 && value.length <= 80;
const isKey = (value) => typeof value === "string" && value.length >= 1 && value.length <= 200;
const isTime = (value) => typeof value === "number" && Number.isFinite(value);
const isAmount = (value) => Number.isSafeInteger(value) && Math.abs(value) <= MAX_AMOUNT_VND;
const isIdList = (value) => Array.isArray(value) && value.length <= MAX_MEMBERS && value.every(isId) && new Set(value).size === value.length;
const FIELD_VALUES = Object.freeze({
  payerId: (value) => value === null || isId(value),
  date: (value) => value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)),
  description: (value) => value === null || (typeof value === "string" && value.length <= MAX_DESCRIPTION_LENGTH),
  amountVnd: (value) => value === null || isAmount(value),
});

function readSnapshot(value) {
  if (!isObject(value)) return null;
  const {
    payerId = null, date = null, description = "", amountVnd = 0, participantIds = [], position = null,
    deleted = false, sentAt = null, confirmed = false, attemptedAt = null,
  } = value;
  const valid = FIELD_VALUES.payerId(payerId) && FIELD_VALUES.date(date) && typeof description === "string" &&
    FIELD_VALUES.description(description) && isAmount(amountVnd) && isIdList(participantIds) &&
    (position === null || (Number.isSafeInteger(position) && position >= 0 && position <= MAX_EXPENSE_POSITION)) &&
    typeof deleted === "boolean" && (sentAt === null || isTime(sentAt)) && typeof confirmed === "boolean" &&
    (attemptedAt === null || isTime(attemptedAt));
  return valid ? {
    payerId, date, description, amountVnd, participantIds: [...participantIds], position, deleted, sentAt, confirmed,
    ...(attemptedAt === null ? {} : { attemptedAt }),
  } : null;
}

// Một mục đã lưu, hay null nếu hỏng hoặc lạ.
function readEntry(value) {
  if (!isObject(value) || !["edit", "add", "delete", "transfer"].includes(value.kind) || !isKey(value.id) || !isTime(value.time)) {
    return null;
  }
  const base = {
    id: value.id,
    kind: value.kind,
    label: typeof value.label === "string" && value.label.length <= 400 ? value.label : "",
    time: value.time,
    session: null,
    origin: isKey(value.origin) ? value.origin : "",
    at: isTime(value.at) ? value.at : value.time,
  };
  if (value.kind === "transfer") {
    if (!isId(value.memberId) || !isAmount(value.before) || !isAmount(value.after) || value.before === value.after) return null;
    return { ...base, memberId: value.memberId, before: value.before, after: value.after };
  }
  if (!isId(value.expenseId)) return null;
  if (value.kind === "edit") {
    const added = value.added ?? [];
    const removed = value.removed ?? [];
    if (!isObject(value.fields) || !isIdList(added) || !isIdList(removed)) return null;
    const fields = {};
    for (const [field, change] of Object.entries(value.fields)) {
      const valid = Object.hasOwn(FIELD_VALUES, field) ? FIELD_VALUES[field] : null;
      if (!valid || !isObject(change) || !valid(change.before ?? null) || !valid(change.after ?? null)) return null;
      fields[field] = { before: change.before ?? null, after: change.after ?? null };
    }
    if (Object.keys(fields).length === 0 && added.length === 0 && removed.length === 0) return null;
    return { ...base, expenseId: value.expenseId, fields, added: [...added], removed: [...removed] };
  }
  const snapshot = value.snapshot === undefined ? undefined : readSnapshot(value.snapshot);
  if (snapshot === null || (value.kind === "delete" && !snapshot)) return null;
  if (value.kind === "delete") return { ...base, expenseId: value.expenseId, snapshot };
  return { ...base, expenseId: value.expenseId, duplicate: value.duplicate === true, ...(snapshot ? { snapshot } : {}) };
}

// Chuỗi đã lưu → { undo, redo } hợp lệ (mỗi ngăn tối đa limit mục mới nhất, mỗi mục một lần); dữ liệu hỏng hay phiên
// bản khác thì lịch sử trống. ledger: id của sổ đang mở; lịch sử ghi cho sổ khác (hay không ghi sổ) thì trống, kèm
// foreign: true.
export function parseStoredHistory(text, { limit = STORED_HISTORY_LIMIT, ledger = null } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!isObject(data) || data.v !== HISTORY_STORAGE_VERSION) return { undo: [], redo: [] };
  if ((data.ledger ?? null) !== ledger) return { undo: [], redo: [], foreign: true };
  const seen = new Set();
  const read = (list) => (Array.isArray(list) ? list : []).map(readEntry).filter((entry) => {
    if (!entry || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).slice(-limit);
  return { undo: read(data.undo), redo: read(data.redo) };
}

export function serializeHistory({ undo, redo }, { limit = STORED_HISTORY_LIMIT, ledger = null } = {}) {
  return JSON.stringify({ v: HISTORY_STORAGE_VERSION, ledger, undo: undo.slice(-limit), redo: redo.slice(-limit) });
}

// Lịch sử đã lưu của một sổ (options.ledger: id của sổ đó); null khi không đọc được bộ nhớ (bị chặn). Lịch sử của sổ
// cũ cùng slug được bỏ luôn khỏi bộ nhớ.
export function readStoredHistory(storage, slug, options = {}) {
  if (!storage) return null;
  let text;
  try {
    text = storage.getItem(historyStorageKey(slug));
  } catch {
    return null;
  }
  if (text === null || text === undefined) return { undo: [], redo: [] };
  const { foreign, ...stored } = parseStoredHistory(text, options);
  if (foreign) forgetStoredHistory(storage, slug);
  return stored;
}

// Ghi lịch sử của một sổ (options.ledger: id của sổ đó; lịch sử trống thì bỏ khóa); true nếu đã ghi. Không bao giờ ném
// lỗi.
export function writeStoredHistory(storage, slug, { undo, redo }, { limit = STORED_HISTORY_LIMIT, ledger = null } = {}) {
  if (!storage) return false;
  const key = historyStorageKey(slug);
  const attempt = (keep) => {
    try {
      if (undo.length === 0 && redo.length === 0) storage.removeItem(key);
      else storage.setItem(key, serializeHistory({ undo: undo.slice(-keep), redo: redo.slice(-keep) }, { limit, ledger }));
      return true;
    } catch {
      return false;
    }
  };
  // Bộ nhớ đầy: chỉ giữ nửa mới hơn của mỗi ngăn rồi thử lại một lần.
  return attempt(limit) || attempt(Math.max(1, Math.floor(limit / 2)));
}

// Quên lịch sử đã lưu của một sổ (vd. sổ vừa bị xóa).
export function forgetStoredHistory(storage, slug) {
  try {
    storage?.removeItem(historyStorageKey(slug));
  } catch {}
}
