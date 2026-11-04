// Tìm, lọc và sắp xếp bảng Detail: chỉ là cách xem (dữ liệu, Summary và tổng đầu trang luôn dùng mọi khoản chi).
// Không phụ thuộc DOM (có kiểm thử node:test); detail-view.js đọc các dòng và áp kết quả lên bảng.

export const SORTS = Object.freeze([
  Object.freeze({ key: "position", label: "Thứ tự nhập" }),
  Object.freeze({ key: "date-desc", label: "Ngày mới nhất" }),
  Object.freeze({ key: "date-asc", label: "Ngày cũ nhất" }),
  Object.freeze({ key: "amount-desc", label: "Số tiền lớn nhất" }),
  Object.freeze({ key: "amount-asc", label: "Số tiền nhỏ nhất" }),
  Object.freeze({ key: "description", label: "Nội dung A→Z" }),
]);
export const DEFAULT_SORT = "position";
export const EMPTY_FILTER = Object.freeze({ search: "", payerId: "", participantId: "", from: "", to: "", incomplete: false });

export function isSortKey(key) {
  return SORTS.some((sort) => sort.key === key);
}

// Không phân biệt hoa thường và dấu: "an trua" tìm được "Ăn trưa", "d" tìm được "đ".
export function normalizeSearchText(text) {
  return String(text ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d")
    .replace(/\s+/g, " ").trim();
}

// Mỗi từ của ô tìm phải có trong nội dung (thứ tự tùy ý).
export function searchTokens(query) {
  const normalized = normalizeSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

// "Thiếu thông tin": thiếu người chi, ngày, nội dung, số tiền (0) hoặc chưa ai tham gia.
export function isIncompleteExpense(item) {
  return !item.payerId || !item.date || !String(item.description ?? "").trim() || !item.amountVnd ||
    !(item.participantIds?.length > 0);
}

function dateRange(filter) {
  const { from, to } = filter;
  return from && to && from > to ? [to, from] : [from, to];
}

export function matchesFilter(item, filter = EMPTY_FILTER, tokens = searchTokens(filter.search)) {
  if (filter.payerId && item.payerId !== filter.payerId) return false;
  if (filter.participantId && !(item.participantIds ?? []).includes(filter.participantId)) return false;
  const [from, to] = dateRange(filter);
  if ((from || to) && !item.date) return false;
  if (from && item.date < from) return false;
  if (to && item.date > to) return false;
  if (filter.incomplete && !isIncompleteExpense(item)) return false;
  if (tokens.length) {
    const description = normalizeSearchText(item.description);
    if (!tokens.every((token) => description.includes(token))) return false;
  }
  return true;
}

// Số bộ lọc đang bật trong bảng "Lọc & sắp xếp" (ô tìm luôn hiện nên không tính); khoảng ngày tính là một.
export function panelFilterCount(filter = EMPTY_FILTER) {
  return [filter.payerId, filter.participantId, filter.from || filter.to, filter.incomplete].filter(Boolean).length;
}

// Số trên nút "Lọc & sắp xếp" (điện thoại): bộ lọc đang bật + 1 nếu đang sắp xếp khác thứ tự nhập (cách sắp xếp
// được nhớ theo sổ, nên người xem cần thấy là nó đang bật).
export function panelBadgeCount(filter = EMPTY_FILTER, sort = DEFAULT_SORT) {
  return panelFilterCount(filter) + (sort !== DEFAULT_SORT ? 1 : 0);
}

export function hasActiveFilter(filter = EMPTY_FILTER) {
  return panelFilterCount(filter) > 0 || searchTokens(filter.search).length > 0;
}

export function isDefaultView(filter, sort) {
  return !hasActiveFilter(filter) && (sort ?? DEFAULT_SORT) === DEFAULT_SORT;
}

const collator = new Intl.Collator("vi", { sensitivity: "base", numeric: true });

// So sánh theo cách sắp xếp đã chọn; bằng nhau (hoặc thiếu ngày, thiếu nội dung: xếp cuối) thì theo thứ tự nhập.
function comparator(sort) {
  const byPosition = (left, right) => left.position - right.position;
  const missingLast = (read, compare) => (left, right) => {
    const a = read(left);
    const b = read(right);
    if (!a || !b) return (a ? 0 : 1) - (b ? 0 : 1) || byPosition(left, right);
    return compare(a, b) || byPosition(left, right);
  };
  switch (sort) {
    case "date-desc": return missingLast((item) => item.date, (a, b) => (a < b ? 1 : a > b ? -1 : 0));
    case "date-asc": return missingLast((item) => item.date, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    case "amount-desc": return (left, right) => (right.amountVnd || 0) - (left.amountVnd || 0) || byPosition(left, right);
    case "amount-asc": return (left, right) => (left.amountVnd || 0) - (right.amountVnd || 0) || byPosition(left, right);
    case "description": return missingLast((item) => String(item.description ?? "").trim(), (a, b) => collator.compare(a, b));
    default: return byPosition;
  }
}

// Thứ tự và tập dòng hiện của bảng. items: { id, position (thứ tự nhập), payerId, date, description, amountVnd,
// participantIds }. pinned: dòng vừa thêm (theo thứ tự thêm) luôn hiện, ở cuối, tới khi bộ lọc đổi.
// focusedId + previous ({ order, hidden }): bảng dựng lại khi một dòng đang được sửa, nên giữ nguyên thứ tự và
// dòng ẩn/hiện cũ (dòng đang sửa không biến mất, không nhảy chỗ); dòng mới từ máy chủ thêm vào cuối nếu khớp lọc.
export function computeExpenseView(items, { filter = EMPTY_FILTER, sort = DEFAULT_SORT, pinned = [], focusedId = null, previous = null } = {}) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const pinnedIds = [...new Set(pinned)].filter((id) => byId.has(id));
  const pinnedSet = new Set(pinnedIds);
  const tokens = searchTokens(filter.search);
  const shows = (item) => pinnedSet.has(item.id) || item.id === focusedId || matchesFilter(item, filter, tokens);
  if (focusedId !== null && previous) {
    const known = previous.order.filter((id) => byId.has(id));
    const knownSet = new Set(known);
    const fresh = items.filter((item) => !knownSet.has(item.id)).sort((left, right) => left.position - right.position);
    const order = [...known, ...fresh.map((item) => item.id)];
    const visible = new Set(order.filter((id) => (knownSet.has(id)
      ? !previous.hidden.has(id) || id === focusedId
      : shows(byId.get(id)))));
    return { order, visible };
  }
  const sorted = items.filter((item) => !pinnedSet.has(item.id)).sort(comparator(sort)).map((item) => item.id);
  const order = [...sorted, ...pinnedIds];
  return { order, visible: new Set(order.filter((id) => shows(byId.get(id)))) };
}

// Dòng trạng thái khi đang lọc: số dòng hiện / tổng số dòng và tổng tiền của các dòng đang hiện.
export function viewSummary(items) {
  const shown = items.filter((item) => !item.hidden);
  return {
    shown: shown.length,
    total: items.length,
    subtotalVnd: shown.reduce((sum, item) => sum + (Number.isSafeInteger(item.amountVnd) ? item.amountVnd : 0), 0),
  };
}
