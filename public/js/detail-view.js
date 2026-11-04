// Cách hiển thị bảng Detail: thanh tìm/lọc/sắp xếp, dòng trạng thái khi lọc, gợi ý vuốt ngang khi bảng tràn.
// Chỉ ẩn/hiện và đổi chỗ các dòng có sẵn (không dựng lại dòng nào, ô đang gõ và hàng đợi tự lưu không bị ảnh hưởng);
// dữ liệu, Summary và tổng đầu trang vẫn tính trên mọi khoản chi.
import {
  computeExpenseView,
  DEFAULT_SORT,
  EMPTY_FILTER,
  hasActiveFilter,
  isDefaultView,
  isSortKey,
  panelBadgeCount,
  viewSummary,
} from "./expense-view.js";
import { escapeHtml, formatVnd, parseAmountOrZero } from "./format.js";
import { state } from "./state.js";

const view = {
  filter: { ...EMPTY_FILTER },
  sort: DEFAULT_SORT,
  // Sổ đã đọc cách sắp xếp đã nhớ (localStorage, theo sổ).
  sortLedger: null,
  // Dòng thêm (hoặc nhân bản) trên trang này từ lần đổi bộ lọc gần nhất: luôn hiện, ở cuối.
  pinned: [],
  // Bảng đang khác thứ tự nhập hoặc có dòng ẩn.
  arranged: false,
  // Có dòng bị lọc ẩn (dòng hiện cuối cùng cần lớp last-shown để không kẻ đáy, styles.css).
  hasHidden: false,
  memberOptions: "",
};
// Gõ ô tìm: áp lọc sau khi ngừng gõ chừng này (bảng dài thì mỗi lần lọc tốn công); các ô lọc khác áp ngay.
const SEARCH_DEBOUNCE_MS = 200;
let searchTimer = null;

const tbody = () => document.querySelector("#expense-body");
const sortStorageKey = (slug) => `so-chi:sap-xep:${slug}`;

// Giá trị đang hiển thị của một dòng (kể cả thay đổi chưa lưu): dùng cho xem trước số liệu, lọc, xuất CSV.
export function readExpenseRow(row) {
  return {
    id: row.dataset.expenseId,
    payerId: row.querySelector(".payer-input").value || null,
    date: row.querySelector(".date-input").value || null,
    description: row.querySelector(".description-input").value.trim(),
    amountVnd: parseAmountOrZero(row.querySelector(".amount-input").value),
    participantIds: [...row.querySelectorAll("input[type=checkbox]:checked")]
      .map((checkbox) => checkbox.dataset.memberId),
    hidden: row.hidden,
  };
}

function dataRows() {
  return [...tbody().querySelectorAll("tr[data-expense-id]")];
}

function focusedRowId() {
  return document.activeElement?.closest?.("#expense-body tr[data-expense-id]")?.dataset.expenseId ?? null;
}

function viewItems(rows) {
  const positions = new Map(state.expenses.map((expense, index) => [expense.id, index]));
  return rows.map((row, index) => ({ ...readExpenseRow(row), position: positions.get(row.dataset.expenseId) ?? state.expenses.length + index }));
}

// Áp thứ tự và ẩn/hiện lên bảng: một lần đọc các dòng, chỉ đổi ẩn/hiện của dòng cần đổi, đổi chỗ bằng một lần chèn.
// Trả về giá trị đang hiển thị của các dòng (hidden đã cập nhật) để dòng trạng thái khỏi đọc lại bảng; null nếu bảng
// đang theo mặc định (không có gì để áp).
function arrange({ focusedId = null, previous = null } = {}) {
  if (!view.arranged && isDefaultView(view.filter, view.sort)) {
    view.hasHidden = false;
    return null;
  }
  const rows = dataRows();
  const items = viewItems(rows);
  const { order, visible } = computeExpenseView(items, {
    filter: view.filter, sort: view.sort, pinned: view.pinned, focusedId, previous,
  });
  rows.forEach((row, index) => {
    const hide = !visible.has(row.dataset.expenseId);
    if (row.hidden !== hide) row.hidden = hide;
    items[index].hidden = hide;
  });
  if (rows.some((row, index) => row.dataset.expenseId !== order[index])) {
    const byId = new Map(rows.map((row) => [row.dataset.expenseId, row]));
    tbody().append(...order.map((id) => byId.get(id)));
  }
  view.hasHidden = items.some((item) => item.hidden);
  view.arranged = !isDefaultView(view.filter, view.sort);
  return items;
}

// Dòng hiện cuối cùng (có dòng bị ẩn phía sau nó) không kẻ đáy, như dòng cuối của bảng.
function markLastShown() {
  const body = tbody();
  let last = null;
  if (view.hasHidden) {
    for (let row = body.lastElementChild; row && !last; row = row.previousElementSibling) {
      if (row.dataset.expenseId && !row.hidden) last = row;
    }
  }
  const current = body.querySelector("tr.last-shown");
  if (current === last) return;
  current?.classList.remove("last-shown");
  last?.classList.add("last-shown");
}

function loadSortFor(slug) {
  if (view.sortLedger === slug) return;
  view.sortLedger = slug;
  let stored = null;
  try {
    stored = localStorage.getItem(sortStorageKey(slug));
  } catch {}
  view.sort = isSortKey(stored) ? stored : DEFAULT_SORT;
  document.querySelector("#filter-sort").value = view.sort;
}

function saveSort() {
  if (!view.sortLedger) return;
  try {
    if (view.sort === DEFAULT_SORT) localStorage.removeItem(sortStorageKey(view.sortLedger));
    else localStorage.setItem(sortStorageKey(view.sortLedger), view.sort);
  } catch {}
}

// Danh sách thành viên của hai ô lọc; thành viên đang chọn đã bị xóa thì bỏ lọc theo người đó.
function renderMemberOptions() {
  const signature = state.members.map((member) => `${member.id}\t${member.name}`).join("\n");
  if (signature === view.memberOptions) return false;
  view.memberOptions = signature;
  const options = state.members.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}</option>`).join("");
  let changed = false;
  for (const [selector, field, label] of [["#filter-payer", "payerId", "Mọi người chi"], ["#filter-participant", "participantId", "Mọi người tham gia"]]) {
    const select = document.querySelector(selector);
    select.innerHTML = `<option value="">${label}</option>${options}`;
    if (state.members.some((member) => member.id === view.filter[field])) {
      select.value = view.filter[field];
    } else if (view.filter[field]) {
      view.filter[field] = "";
      changed = true;
    }
  }
  return changed;
}

export function captureDetailView() {
  const rows = dataRows();
  return {
    focusedId: focusedRowId(),
    previous: {
      order: rows.map((row) => row.dataset.expenseId),
      hidden: new Set(rows.filter((row) => row.hidden).map((row) => row.dataset.expenseId)),
    },
  };
}

// Bảng vừa dựng lại (theo thứ tự nhập, mọi dòng hiện): áp lại cách xem. Có dòng đang được sửa thì giữ thứ tự và
// ẩn/hiện như trước để dòng đó không nhảy chỗ; sắp xếp lại khi focus rời bảng.
export function arrangeRenderedExpenses({ focusedId = null, previous = null } = {}) {
  loadSortFor(state.ledger.slug);
  const filterChanged = renderMemberOptions();
  view.arranged = false;
  if (filterChanged) view.pinned = [];
  arrange({ focusedId: filterChanged ? null : focusedId, previous });
}

export function pinExpenseRow(id) {
  view.pinned.push(id);
}

export function renamePinnedRow(oldId, newId) {
  const index = view.pinned.indexOf(oldId);
  if (index !== -1) view.pinned[index] = newId;
}

// Focus rời bảng Detail (không sang một dòng khác của bảng): áp lại lọc/sắp xếp cho các dòng vừa sửa.
export function handleDetailFocusOut() {
  if (!view.arranged && isDefaultView(view.filter, view.sort)) return;
  setTimeout(() => {
    if (focusedRowId() !== null) return;
    renderDetailViewStatus(arrange());
  }, 0);
}

function readControls() {
  return {
    filter: {
      search: document.querySelector("#filter-search").value,
      payerId: document.querySelector("#filter-payer").value,
      participantId: document.querySelector("#filter-participant").value,
      from: document.querySelector("#filter-from").value,
      to: document.querySelector("#filter-to").value,
      incomplete: document.querySelector("#filter-incomplete").checked,
    },
    sort: document.querySelector("#filter-sort").value,
  };
}

function writeControls() {
  document.querySelector("#filter-search").value = view.filter.search;
  document.querySelector("#filter-payer").value = view.filter.payerId;
  document.querySelector("#filter-participant").value = view.filter.participantId;
  document.querySelector("#filter-from").value = view.filter.from;
  document.querySelector("#filter-to").value = view.filter.to;
  document.querySelector("#filter-incomplete").checked = view.filter.incomplete;
}

function filtersChanged() {
  view.pinned = [];
  view.arranged = true;
  renderDetailViewStatus(arrange());
}

// Ô tìm, các ô lọc và ô sắp xếp (sự kiện input và change của thanh công cụ). Gõ ô tìm thì chờ ngừng gõ.
export function handleFilterInput(event) {
  if (!event.target.closest("#filter-search, #filter-panel")) return;
  clearTimeout(searchTimer);
  if (event.type === "input" && event.target.id === "filter-search") {
    searchTimer = setTimeout(applyFilterControls, SEARCH_DEBOUNCE_MS);
    return;
  }
  applyFilterControls();
}

function applyFilterControls() {
  searchTimer = null;
  const { filter, sort } = readControls();
  const sortChanged = isSortKey(sort) && sort !== view.sort;
  if (JSON.stringify(filter) === JSON.stringify(view.filter) && !sortChanged) return;
  view.filter = filter;
  if (sortChanged) {
    view.sort = sort;
    saveSort();
  }
  filtersChanged();
}

// Bàn phím: con trỏ về ô tìm. Chạm trên màn hình cảm ứng: về nút "Lọc & sắp xếp", không bật bàn phím ảo che bảng.
export function clearFilters(event) {
  clearTimeout(searchTimer);
  view.filter = { ...EMPTY_FILTER };
  writeControls();
  filtersChanged();
  const tapped = event?.detail > 0 && matchMedia("(pointer: coarse)").matches;
  document.querySelector(tapped ? "#filter-toggle" : "#filter-search").focus();
}

// Điện thoại: chỉ ô tìm và nút "Lọc & sắp xếp" luôn hiện, nút mở/đóng phần còn lại.
export function toggleFilterPanel() {
  const toggle = document.querySelector("#filter-toggle");
  const open = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", String(open));
  document.querySelector("#filter-panel").classList.toggle("is-open", open);
}

// Vùng đọc cho trình đọc màn hình (luôn có trên trang nên lần lọc đầu tiên cũng được đọc); chỉ ghi khi chữ đổi.
function announce(text) {
  const region = document.querySelector("#filter-announce");
  if (region.textContent !== text) region.textContent = text;
}

// Dòng trạng thái khi lọc ("Đang hiển thị x/y dòng" và tổng tiền các dòng đang hiện), số bộ lọc trên nút
// "Lọc & sắp xếp" và lời nhắn khi không dòng nào khớp. preview: giá trị đang hiển thị của mọi dòng (readExpenseRow);
// không có thì đọc bảng (chỉ khi đang lọc).
export function renderDetailViewStatus(preview = null) {
  markLastShown();
  const active = hasActiveFilter(view.filter);
  const status = document.querySelector("#filter-status");
  const badge = document.querySelector("#filter-badge");
  const count = panelBadgeCount(view.filter, view.sort);
  if (badge.hidden !== !count || (count && badge.textContent !== String(count))) {
    badge.hidden = !count;
    badge.textContent = count ? String(count) : "";
    const toggle = document.querySelector("#filter-toggle");
    if (count) toggle.setAttribute("aria-label", `Lọc & sắp xếp, đang bật ${count}`);
    else toggle.removeAttribute("aria-label");
  }
  const body = tbody();
  const empty = body.querySelector("tr.filter-empty");
  if (!active) {
    if (!status.hidden) {
      status.hidden = true;
      announce(`Đang hiển thị tất cả ${dataRows().length} dòng`);
    }
    empty?.remove();
    return;
  }
  // "dòng", không phải "khoản": số và tổng tính mọi dòng đang hiện, kể cả dòng chưa đủ thông tin mà phần tổng quan
  // đầu trang không đếm.
  const { shown, total, subtotalVnd } = viewSummary(preview ?? dataRows().map(readExpenseRow));
  const countText = `Đang hiển thị ${shown}/${total} dòng`;
  const subtotalText = `Tổng ${formatVnd(subtotalVnd)}`;
  const countElement = document.querySelector("#filter-count");
  const subtotalElement = document.querySelector("#filter-subtotal");
  if (countElement.textContent !== countText) countElement.textContent = countText;
  if (subtotalElement.textContent !== subtotalText) subtotalElement.textContent = subtotalText;
  if (status.hidden) status.hidden = false;
  announce(countText);
  if (shown === 0 && total > 0) {
    if (!empty) {
      body.insertAdjacentHTML("beforeend", `<tr class="filter-empty"><td class="empty-cell" colspan="${state.members.length + 7}"><span class="empty-state">Không có khoản chi nào khớp bộ lọc.</span></td></tr>`);
    } else if (empty !== body.lastElementChild) {
      body.append(empty);
    }
  } else {
    empty?.remove();
  }
}

// "↔ Vuốt ngang…" chỉ hiện khi bảng thật sự tràn ngang. Một ResizeObserver theo dõi khung cuộn (đổi cỡ màn hình,
// thanh cuộn) và bảng (thêm cột, đổi độ rộng, cỡ chữ); nó chạy sau khi bố cục xong nên đọc kích thước không ép
// trình duyệt tính lại bố cục. Lệch 1px do làm tròn không tính là tràn.
// Có chuột hay bàn di chuột thì gợi ý "Cuộn ngang…", màn hình cảm ứng: "Vuốt ngang…".
export function watchTableOverflow() {
  const scroller = document.querySelector(".ledger-card .table-scroll");
  const table = scroller?.querySelector(".expense-table");
  const hint = document.querySelector(".ledger-card .table-hint");
  const words = hint?.lastChild;
  if (words?.nodeType === Node.TEXT_NODE) {
    const touchWords = words.data;
    const finePointer = matchMedia("(pointer: fine)");
    const showWords = () => {
      const next = finePointer.matches ? touchWords.replace("Vuốt", "Cuộn") : touchWords;
      if (words.data !== next) words.data = next;
    };
    showWords();
    finePointer.addEventListener("change", showWords);
  }
  if (!table || !hint || typeof ResizeObserver !== "function") return;
  const observer = new ResizeObserver(() => {
    hint.classList.toggle("is-overflowing", scroller.scrollWidth - scroller.clientWidth > 1);
  });
  observer.observe(scroller);
  observer.observe(table);
}
