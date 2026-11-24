// Lịch sử "Hoàn tác" / "Làm lại" các thay đổi đã lưu của một sổ, tối đa 50 bước mỗi ngăn. Lịch sử được lưu trên thiết bị
// (history-store.js) nên còn sau khi tải lại trang hay mở lại trình duyệt; các tab cùng sổ dùng chung.
// Không phụ thuộc DOM (có kiểm thử node:test); expense-history.js gắn nó vào bảng Detail và hàng đợi tự lưu.
//
// Mục lịch sử:
//   { kind: "edit", expenseId, fields: { [trường]: { before, after } }, added: [memberId], removed: [memberId] }
//   { kind: "add", expenseId, duplicate, snapshot? } — dòng thêm bằng "Add line" hoặc nút nhân bản
//   { kind: "delete", expenseId, snapshot } — dòng bị xóa: đang chờ xóa, hoặc đã xóa hẳn (hoàn tác = tạo lại dòng)
//   { kind: "transfer", memberId, before, after } — tổng "Đã chuyển khoản" của một người (ô Summary hoặc nút Done)
// Mỗi mục còn có id, label (nội dung khoản chi, hay tên thành viên, lúc ghi), time, session (lần focus ô nhập đã tạo
// thay đổi; chỉ có nghĩa trong trang đã ghi), origin và at (trang đã ghi hay chuyển mục lần gần nhất, và lúc đó).
// snapshot: dòng lúc bị xóa { payerId, date, description, amountVnd, participantIds } (bản đã lưu), position (chỗ của
// dòng trên máy chủ, null nếu không biết), deleted (DELETE đã gửi, lúc sentAt) và confirmed (máy chủ đã trả lời là
// xóa xong). Mục xóa ở ngăn "Hoàn tác" và mục "Thêm dòng" ở ngăn "Làm lại" có snapshot.deleted thì tạo lại được dòng
// (cùng id, giá trị và chỗ cũ).
import { formatThousandInput, formatVnd } from "./format.js";

export const HISTORY_LIMIT = 50;
export const COALESCE_MS = 3000;
// Lần xóa đã gửi mà máy chủ chưa trả lời (trang khác, trang vừa đóng) có thể chưa tới: trong khoảng này kể từ lúc gửi,
// lần tải dữ liệu còn thấy dòng chưa có nghĩa là DELETE đã thất bại.
export const DELETE_SETTLE_MS = 60_000;
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
  if (entry.snapshot) copy.snapshot = { ...entry.snapshot, participantIds: [...entry.snapshot.participantIds] };
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

// origin: mã của trang (mục do trang ghi hay chuyển mang mã này); mục của trang khác (tab khác, lần mở trước) không
// bao giờ gộp với thay đổi mới của trang này.
export function createUndoHistory({
  now = () => Date.now(),
  limit = HISTORY_LIMIT,
  coalesceMs = COALESCE_MS,
  onChange = () => {},
  origin = "",
  newId = null,
} = {}) {
  const undoStack = [];
  const redoStack = [];
  let counter = 0;
  const makeId = newId ?? (() => `${origin || "h"}.${now().toString(36)}.${(counter += 1).toString(36)}`);

  // Một mục chỉ nằm một chỗ (mục nhận từ tab khác có thể trùng mục trang đang hoàn tác dở).
  function push(stack, entry) {
    for (const other of [undoStack, redoStack]) {
      const index = other.findIndex((item) => item.id === entry.id);
      if (index !== -1) other.splice(index, 1);
    }
    stack.push(entry);
    if (stack.length > limit) stack.splice(0, stack.length - limit);
  }

  // Thao tác mới của người dùng: xóa "Làm lại". Hai lần lưu liên tiếp cùng khoản chi, cùng (các) trường trong 3 giây
  // hoặc trong cùng một lần focus ô nhập thành một mục, giữ giá trị trước đó cũ nhất.
  function record(change) {
    const time = now();
    redoStack.length = 0;
    const top = undoStack.at(-1);
    const own = top?.origin === origin;
    // Tổng chuyển khoản của cùng một người sửa liên tiếp trong 3 giây: một mục, giữ tổng trước đó cũ nhất; sửa về
    // đúng tổng ban đầu thì mục biến mất.
    if (change.kind === "transfer" && own && top.kind === "transfer" && top.memberId === change.memberId &&
        time - top.time <= coalesceMs) {
      top.after = change.after;
      top.time = time;
      top.at = time;
      if (change.label !== undefined) top.label = change.label;
      if (top.before === top.after) undoStack.pop();
    } else if (change.kind === "transfer") {
      if (change.before !== change.after) push(undoStack, { ...change, id: makeId(), session: null, time, origin, at: time });
    } else if (change.kind === "edit" && own && top.kind === "edit" && top.expenseId === change.expenseId &&
        keyOf(top) === keyOf(change) &&
        (time - top.time <= coalesceMs || (change.session != null && change.session === top.session))) {
      mergeEdit(top, change);
      top.time = time;
      top.at = time;
      top.session = change.session ?? null;
      if (change.label !== undefined) top.label = change.label;
      if (isEmptyEdit(top)) undoStack.pop();
    } else if (change.kind !== "edit" || !isEmptyEdit(change)) {
      push(undoStack, { ...cloneEntry(change), id: makeId(), session: change.session ?? null, time, origin, at: time });
    }
    onChange();
  }

  function take(stack) {
    const entry = stack.pop() ?? null;
    if (entry) onChange();
    return entry;
  }

  // Mục vừa hoàn tác/làm lại xong thuộc về trang này từ lúc đó (session của trang khác không còn nghĩa).
  function moved(entry) {
    if (entry.origin !== origin) entry.session = null;
    entry.origin = origin;
    entry.at = now();
    return entry;
  }

  // Bỏ các mục thỏa điều kiện ở cả hai ngăn (vd. lần chờ xóa đã được hoàn tác).
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

  // Sửa tại chỗ các mục thỏa điều kiện (vd. ảnh chụp khi DELETE đã gửi); change(entry, "undo" | "redo") trả về true
  // nếu có đổi.
  function update(predicate, change) {
    let changed = 0;
    for (const [name, stack] of [["undo", undoStack], ["redo", redoStack]]) {
      for (const entry of stack) {
        if (predicate(entry, name) && change(entry, name)) changed += 1;
      }
    }
    if (changed) onChange();
    return changed;
  }

  return {
    record,
    peekUndo: () => undoStack.at(-1) ?? null,
    peekRedo: () => redoStack.at(-1) ?? null,
    takeUndo: () => take(undoStack),
    takeRedo: () => take(redoStack),
    // Hoàn tác xong (máy chủ đã lưu): mục sang ngăn "Làm lại"; làm lại xong: về ngăn "Hoàn tác" (không xóa "Làm lại").
    pushRedo(entry) {
      push(redoStack, moved(entry));
      onChange();
    },
    pushUndo(entry) {
      push(undoStack, moved(entry));
      onChange();
    },
    remove,
    update,
    // Bỏ các mục không còn áp được vào dữ liệu trang vừa tải (pruneHistory).
    prune(context) {
      const kept = pruneHistory({ undo: undoStack, redo: redoStack }, { origin, ...context });
      if (!kept.removed) return 0;
      undoStack.splice(0, undoStack.length, ...kept.undo);
      redoStack.splice(0, redoStack.length, ...kept.redo);
      onChange();
      return kept.removed;
    },
    // Hai ngăn (cũ nhất trước), để lưu lại.
    entries: () => ({ undo: [...undoStack], redo: [...redoStack] }),
    // Thay cả hai ngăn bằng lịch sử đã lưu (lần mở trang, tab khác vừa đổi); không gọi onChange (không lưu lại).
    replace({ undo = [], redo = [] }) {
      undoStack.splice(0, undoStack.length, ...undo.slice(-limit));
      redoStack.splice(0, redoStack.length, ...redo.slice(-limit));
    },
    get sizes() {
      return { undo: undoStack.length, redo: redoStack.length };
    },
  };
}

// Hai ngăn để lưu lại, cộng các bước đã lấy ra và đang chờ máy chủ ({ entry, direction }) ghi trở lại ngăn của chúng:
// trang đóng giữa chừng không mất bước nào.
export function stacksToStore({ undo, redo }, steps = []) {
  const stored = { undo: [...undo], redo: [...redo] };
  for (const { entry, direction } of steps) stored[direction === "undo" ? "undo" : "redo"].push(entry);
  return stored;
}

// Lịch sử đọc lại (lần mở trang) hay sau mỗi lần tải dữ liệu: bỏ các mục không còn áp được, trả về hai ngăn mới và số
// mục bị bỏ. context: expenseIds (khoản chi đang có trên trang), memberIds, deletingIds (dòng trang đang chờ xóa),
// origin (mã trang) và loadedAt (lúc gửi GET /api/state): mục trang khác ghi sau lúc đó có thể dựa trên dữ liệu trang
// chưa có, nên được giữ nguyên.
// - Chuyển khoản: thành viên còn trong sổ.
// - Xóa, ngăn "Hoàn tác": DELETE đã gửi (snapshot.deleted) thì giữ khi dòng không còn (tạo lại được); dòng vẫn còn thì
//   bỏ khi máy chủ đã xác nhận lần xóa (điểm khôi phục đưa dòng về), còn chưa xác nhận thì giữ tới DELETE_SETTLE_MS sau
//   lúc gửi (DELETE của trang khác hay của trang vừa đóng có thể chưa tới), quá hạn mới coi là DELETE không xảy ra.
//   Đang chờ xóa ở trang này thì giữ, ở trang khác thì giữ (tab đó vẫn có thể đang chờ), còn của chính trang này mà
//   không còn chờ (đã hiện lại) thì bỏ.
// - Xóa, ngăn "Làm lại" (làm lại = xóa lại): giữ khi dòng còn, hay khi một mục khác tạo lại được dòng đó.
// - "Thêm dòng": giữ khi dòng còn; ở ngăn "Làm lại" với ảnh chụp (hoàn tác đã xóa dòng) thì tạo lại được.
// - Sửa (và "Thêm dòng" ở ngăn "Hoàn tác"): giữ khi dòng còn, hay khi một mục khác tạo lại được dòng đó (mục cũ hơn của
//   dòng đã xóa lại dùng được sau khi dòng được tạo lại).
// - recreatingIds (dòng trang này đang tạo lại, POST chưa trả lời) và mục tạo lại đã gửi POST (snapshot.attemptedAt:
//   phản hồi có thể đã mất trong khi dòng đã có lại) được giữ; step() hoàn tất mục đó khi thấy dòng.
export function pruneHistory({ undo, redo }, { expenseIds, memberIds, deletingIds = new Set(), recreatingIds = new Set(), origin = "", loadedAt = Infinity }) {
  const judged = (entry) => entry.origin === origin || !(entry.at > loadedAt);
  const shown = (id) => expenseIds.has(id) || deletingIds.has(id);
  const restorable = new Set(recreatingIds);
  const keepRow = (entry, stack) => {
    const id = entry.expenseId;
    if (deletingIds.has(id) || recreatingIds.has(id)) return true;
    if (entry.kind === "delete") {
      if (stack === "redo") return expenseIds.has(id) || restorable.has(id);
      if (entry.snapshot?.attemptedAt != null) return true;
      if (entry.snapshot?.deleted) {
        if (!expenseIds.has(id)) return true;
        const { confirmed, sentAt } = entry.snapshot;
        return !confirmed && sentAt != null && loadedAt - sentAt < DELETE_SETTLE_MS;
      }
      return entry.origin !== origin;
    }
    return expenseIds.has(id) || (stack === "redo" && Boolean(entry.snapshot) &&
      (entry.snapshot.deleted || entry.snapshot.attemptedAt != null || entry.origin !== origin));
  };
  for (const [stack, entries] of [["undo", undo], ["redo", redo]]) {
    for (const entry of entries) {
      const recreates = (entry.kind === "delete" && stack === "undo") || (entry.kind === "add" && stack === "redo");
      if (recreates && !shown(entry.expenseId) && (!judged(entry) || keepRow(entry, stack))) restorable.add(entry.expenseId);
    }
  }
  const keep = (stack) => (entry) => {
    if (!judged(entry)) return true;
    if (entry.kind === "transfer") return memberIds.has(entry.memberId);
    if (entry.kind === "delete" || (entry.kind === "add" && stack === "redo")) return keepRow(entry, stack);
    return shown(entry.expenseId) || restorable.has(entry.expenseId);
  };
  const keptUndo = undo.filter(keep("undo"));
  const keptRedo = redo.filter(keep("redo"));
  return { undo: keptUndo, redo: keptRedo, removed: undo.length - keptUndo.length + redo.length - keptRedo.length };
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

// Hoàn tác (hoặc làm lại) một mục "transfer" với tổng hiện tại trang biết: chỉ khi tổng vẫn đúng như mục đã ghi (không
// ai sửa tiếp); null nghĩa là dữ liệu đã thay đổi. Kết quả là tổng cần lưu.
export function planTransferStep(entry, currentVnd, direction) {
  const from = direction === "undo" ? entry.after : entry.before;
  return currentVnd === from ? (direction === "undo" ? entry.before : entry.after) : null;
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
  if (entry.kind === "transfer") {
    const name = memberName(entry.memberId) ?? entry.label ?? "(thành viên đã xóa)";
    const [from, to] = inverse ? [entry.after, entry.before] : [entry.before, entry.after];
    return `Đã chuyển khoản '${shorten(name)}' ${formatVnd(from)} → ${formatVnd(to)}`;
  }
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
