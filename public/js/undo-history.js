// Lịch sử "Hoàn tác" / "Làm lại" các thay đổi khoản chi đã lưu trong phiên này (mất khi tải lại trang hay đổi sổ).
// Không phụ thuộc DOM (có kiểm thử node:test); expense-history.js gắn nó vào bảng Detail và hàng đợi tự lưu.
//
// Mục lịch sử:
//   { kind: "edit", expenseId, fields: { [trường]: { before, after } }, added: [memberId], removed: [memberId] }
//   { kind: "add", expenseId, duplicate } — dòng thêm bằng "Add line" hoặc nút nhân bản
//   { kind: "delete", expenseId }         — dòng đang chờ xóa (bỏ khỏi lịch sử khi DELETE đã gửi)
// Mỗi mục còn có label (nội dung khoản chi lúc ghi), time và session (lần focus ô nhập đã tạo thay đổi).
import { formatThousandInput } from "./format.js";

export const HISTORY_LIMIT = 50;
export const COALESCE_MS = 3000;
const FIELD_LABELS = { payerId: "Người chi", date: "Ngày", description: "Nội dung", amountVnd: "Chi phí" };

export function sameValue(field, left, right) {
  if (field === "description") return String(left ?? "").trim() === String(right ?? "").trim();
  if (field === "amountVnd") return Number(left ?? 0) === Number(right ?? 0);
  return (left || null) === (right || null);
}

function keyOf(entry) {
  const keys = Object.keys(entry.fields).sort();
  if (entry.added.length || entry.removed.length) keys.push("participants");
  return keys.join(",");
}

function isEmptyEdit(entry) {
  return keyOf(entry) === "";
}

function cloneEntry(entry) {
  const copy = { ...entry };
  if (entry.kind === "edit") {
    copy.fields = Object.fromEntries(Object.entries(entry.fields).map(([field, change]) => [field, { ...change }]));
    copy.added = [...entry.added];
    copy.removed = [...entry.removed];
  }
  return copy;
}

// Gộp thay đổi mới vào mục trên cùng: giữ giá trị cũ nhất; tick rồi bỏ tick cùng một người thì triệt tiêu.
function mergeEdit(top, change) {
  for (const [field, { after }] of Object.entries(change.fields)) {
    top.fields[field].after = after;
    if (sameValue(field, top.fields[field].before, after)) delete top.fields[field];
  }
  for (const memberId of change.added) {
    if (top.removed.includes(memberId)) top.removed = top.removed.filter((id) => id !== memberId);
    else if (!top.added.includes(memberId)) top.added.push(memberId);
  }
  for (const memberId of change.removed) {
    if (top.added.includes(memberId)) top.added = top.added.filter((id) => id !== memberId);
    else if (!top.removed.includes(memberId)) top.removed.push(memberId);
  }
}

export function createUndoHistory({ now = () => Date.now(), limit = HISTORY_LIMIT, coalesceMs = COALESCE_MS, onChange = () => {} } = {}) {
  const undoStack = [];
  const redoStack = [];

  function push(stack, entry) {
    stack.push(entry);
    if (stack.length > limit) stack.splice(0, stack.length - limit);
  }

  // Thao tác mới của người dùng: xóa "Làm lại". Hai lần lưu liên tiếp cùng khoản chi, cùng (các) trường trong 3 giây
  // hoặc trong cùng một lần focus ô nhập thành một mục, giữ giá trị trước đó cũ nhất.
  function record(change) {
    const time = now();
    redoStack.length = 0;
    const top = undoStack.at(-1);
    if (change.kind === "edit" && top?.kind === "edit" && top.expenseId === change.expenseId &&
        keyOf(top) === keyOf(change) &&
        (time - top.time <= coalesceMs || (change.session != null && change.session === top.session))) {
      mergeEdit(top, change);
      top.time = time;
      top.session = change.session ?? null;
      if (change.label !== undefined) top.label = change.label;
      if (isEmptyEdit(top)) undoStack.pop();
    } else if (change.kind !== "edit" || !isEmptyEdit(change)) {
      push(undoStack, { ...cloneEntry(change), session: change.session ?? null, time });
    }
    onChange();
  }

  function take(stack) {
    const entry = stack.pop() ?? null;
    if (entry) onChange();
    return entry;
  }

  // Bỏ các mục thỏa điều kiện ở cả hai ngăn (vd. khoản chi đã bị xóa hẳn).
  function remove(predicate) {
    let removed = 0;
    for (const stack of [undoStack, redoStack]) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (!predicate(stack[index])) continue;
        stack.splice(index, 1);
        removed += 1;
      }
    }
    if (removed) onChange();
    return removed;
  }

  return {
    record,
    peekUndo: () => undoStack.at(-1) ?? null,
    peekRedo: () => redoStack.at(-1) ?? null,
    takeUndo: () => take(undoStack),
    takeRedo: () => take(redoStack),
    // Hoàn tác xong (máy chủ đã lưu): mục sang ngăn "Làm lại"; làm lại xong: về ngăn "Hoàn tác" (không xóa "Làm lại").
    pushRedo(entry) {
      push(redoStack, entry);
      onChange();
    },
    pushUndo(entry) {
      push(undoStack, entry);
      onChange();
    },
    remove,
    get sizes() {
      return { undo: undoStack.length, redo: redoStack.length };
    },
  };
}

// Một lần lưu thành công thành mục "edit": before = bản đã lưu trước đó, after = phản hồi của máy chủ, sent = { fields,
// toggles } vừa gửi. write: giá trị một lần hoàn tác/làm lại (hoặc lần điền bản sao) đang chờ lưu, { fields: Map,
// toggles: Map }; những gì lần lưu này mang đúng như write là của nó (không phải thay đổi của người dùng) và được gạch
// khỏi write. Trường máy chủ lưu ra đúng giá trị cũ (vd. chỉ khác khoảng trắng) không tính.
export function diffSavedExpense(id, before, after, sent, write = null) {
  const change = { kind: "edit", expenseId: id, fields: {}, added: [], removed: [], label: after.description };
  const keys = [];
  for (const [field, value] of Object.entries(sent.fields)) {
    if (write?.fields.has(field) && Object.is(write.fields.get(field), value)) {
      write.fields.delete(field);
      continue;
    }
    if (sameValue(field, before[field], after[field])) continue;
    change.fields[field] = { before: before[field] ?? null, after: after[field] ?? null };
    keys.push(field);
  }
  const wasIn = new Set(before.participantIds ?? []);
  const isIn = new Set(after.participantIds ?? []);
  for (const [memberId, checked] of sent.toggles) {
    if (write?.toggles.get(memberId) === checked) {
      write.toggles.delete(memberId);
      continue;
    }
    if (wasIn.has(memberId) !== isIn.has(memberId)) (isIn.has(memberId) ? change.added : change.removed).push(memberId);
  }
  if (change.added.length || change.removed.length) keys.push("participants");
  return { change, keys };
}

// Hoàn tác (hoặc làm lại) một mục "edit" với giá trị hiện tại của khoản chi: chỉ những trường vẫn đúng như mục đã
// ghi (không ai sửa tiếp) mới được đặt lại; trường khác bị bỏ qua (skipped). Người chi hay người tham gia đã bị xóa
// khỏi sổ cũng bị bỏ qua. Kết quả: giá trị cần lưu (fields, add, remove) và phần đã áp dụng (applied).
export function planHistoryStep(entry, current, direction, memberIds = null) {
  const undoing = direction === "undo";
  const exists = (memberId) => !memberIds || memberIds.has(memberId);
  const fields = {};
  const appliedFields = {};
  let skipped = 0;
  for (const [field, change] of Object.entries(entry.fields)) {
    const from = undoing ? change.after : change.before;
    const to = undoing ? change.before : change.after;
    if (!sameValue(field, current[field], from) || (field === "payerId" && to && !exists(to))) {
      skipped += 1;
      continue;
    }
    fields[field] = to ?? (field === "description" ? "" : field === "amountVnd" ? 0 : null);
    appliedFields[field] = { ...change };
  }
  const participating = new Set(current.participantIds ?? []);
  const add = [];
  const remove = [];
  const added = [];
  const removed = [];
  // Người được thêm: hoàn tác thì bỏ tick (nếu vẫn đang tick), làm lại thì tick lại (nếu vẫn chưa tick).
  for (const memberId of entry.added) {
    if (!exists(memberId) || participating.has(memberId) !== undoing) {
      skipped += 1;
      continue;
    }
    (undoing ? remove : add).push(memberId);
    added.push(memberId);
  }
  for (const memberId of entry.removed) {
    if (!exists(memberId) || participating.has(memberId) === undoing) {
      skipped += 1;
      continue;
    }
    (undoing ? add : remove).push(memberId);
    removed.push(memberId);
  }
  return {
    fields,
    add,
    remove,
    skipped,
    empty: Object.keys(fields).length === 0 && add.length === 0 && remove.length === 0,
    applied: { ...entry, fields: appliedFields, added, removed },
  };
}

function shorten(text, max = 40) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value || "(trống)";
}

function formatValue(field, value, memberName) {
  if (field === "payerId") return value ? memberName(value) ?? "(thành viên đã xóa)" : "(trống)";
  if (field === "date") return formatDate(value);
  if (field === "amountVnd") return formatThousandInput(value ?? 0);
  return String(value ?? "").trim() ? `'${shorten(String(value).trim())}'` : "(trống)";
}

// Mô tả một mục cho nút, chú thích và thông báo, ví dụ "Chi phí 'Ăn trưa' 360 → 999". description: nội dung hiện
// tại của khoản chi (mặc định: nội dung lúc ghi); memberName(id): tên thành viên; inverse: mô tả chiều ngược lại (sau
// khi hoàn tác: "999 → 360", "−An" thay cho "+An").
export function describeEntry(entry, { description = entry.label, memberName = () => null, inverse = false } = {}) {
  const text = String(description ?? "").trim();
  const quoted = text ? `'${shorten(text)}'` : null;
  if (entry.kind === "add") {
    if (entry.duplicate) return `Nhân bản ${quoted ?? "dòng chưa có nội dung"}`;
    return quoted ? `Thêm dòng ${quoted}` : "Thêm dòng mới";
  }
  if (entry.kind === "delete") return `Xóa ${quoted ?? "dòng chưa có nội dung"}`;
  const label = quoted ?? "(dòng chưa có nội dung)";
  const parts = Object.entries(entry.fields).map(([field, { before, after }]) => ({
    field,
    change: `${formatValue(field, inverse ? after : before, memberName)} → ${formatValue(field, inverse ? before : after, memberName)}`,
  }));
  const [added, removed] = inverse ? [entry.removed, entry.added] : [entry.added, entry.removed];
  if (added.length || removed.length) {
    const names = [
      ...added.map((id) => `+${memberName(id) ?? "?"}`),
      ...removed.map((id) => `−${memberName(id) ?? "?"}`),
    ];
    parts.push({ field: "participants", change: names.join(", ") });
  }
  const name = (field) => (field === "participants" ? "Người tham gia" : FIELD_LABELS[field]);
  if (parts.length === 1) {
    const [{ field, change }] = parts;
    return field === "description" ? `Nội dung ${change}` : `${name(field)} ${label} ${change}`;
  }
  return `${label}: ${parts.map(({ field, change }) => `${name(field)} ${change}`).join("; ")}`;
}
