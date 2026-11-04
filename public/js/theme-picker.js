// Nút "Đổi giao diện" ở đầu trang: hai nhóm lựa chọn (giao diện, chế độ) trong ô nổi dưới nút, trên điện thoại là tấm
// dưới đáy (modal, nền trong suốt). Chọn là áp dụng ngay và lưu trên máy này; không gọi máy chủ. Mũi tên đổi lựa chọn
// trong nhóm, Esc đóng và trả focus về nút, bấm hay Tab ra ngoài thì đóng.
import { STORAGE_KEYS, applyTheme, readTheme, saveTheme } from "./theme.js";

// Chuyển màu khi đổi (styles.css mục 23, ≤ 200 ms): lớp theme-fade chỉ có trong lúc đổi, không có khi tải trang.
const FADE_MS = 250;
const PHONE_QUERY = "(max-width: 760px)";
let current = readTheme(storage());
let modal = false;
let fadeTimer;

const themeButton = () => document.querySelector("#theme-button");
const panel = () => document.querySelector("#theme-panel");

// Đọc localStorage có thể ném lỗi khi trình duyệt chặn bộ nhớ trang; theme.js coi như chưa lưu gì.
function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function syncRadios() {
  for (const radio of panel().querySelectorAll('[role="radio"]')) {
    const checked = radio.dataset.skin ? radio.dataset.skin === current.skin : radio.dataset.mode === current.mode;
    radio.setAttribute("aria-checked", String(checked));
    radio.tabIndex = checked ? 0 : -1;
  }
}

function choose(change) {
  const next = { ...current, ...change };
  if (next.skin === current.skin && next.mode === current.mode) return;
  current = next;
  saveTheme(storage(), current);
  const root = document.documentElement;
  root.classList.add("theme-fade");
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => root.classList.remove("theme-fade"), FADE_MS);
  applyTheme(document, current);
  syncRadios();
}

function openPanel() {
  const dialog = panel();
  if (dialog.open) return;
  modal = matchMedia(PHONE_QUERY).matches;
  if (modal) dialog.showModal();
  else dialog.show();
  themeButton().setAttribute("aria-expanded", "true");
  dialog.querySelector('.theme-skins [aria-checked="true"]')?.focus();
}

function closePanel(returnFocus) {
  const dialog = panel();
  if (!dialog.open) return;
  dialog.close();
  if (returnFocus) themeButton().focus();
}

function handlePanelClick(event) {
  const radio = event.target.closest('[role="radio"]');
  if (radio) {
    choose(radio.dataset.skin ? { skin: radio.dataset.skin } : { mode: radio.dataset.mode });
    return;
  }
  // Tấm dưới đáy: bấm vào nền (ngoài khung) là đóng, không bấm xuyên xuống trang.
  if (modal && event.target === panel()) {
    const box = panel().getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) closePanel(true);
  }
}

const STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
function handlePanelKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closePanel(true);
    return;
  }
  const radio = event.target.closest('[role="radio"]');
  if (!radio || event.altKey || event.ctrlKey || event.metaKey) return;
  const group = [...radio.parentElement.querySelectorAll('[role="radio"]')];
  const index = group.indexOf(radio);
  const target = event.key in STEPS ? group[(index + STEPS[event.key] + group.length) % group.length]
    : event.key === "Home" ? group[0] : event.key === "End" ? group.at(-1) : null;
  if (!target) return;
  event.preventDefault();
  target.focus();
  choose(target.dataset.skin ? { skin: target.dataset.skin } : { mode: target.dataset.mode });
}

// Ô nổi (máy tính): bấm ra ngoài là đóng, cú bấm vẫn tới chỗ được bấm.
function closeOnOutsidePointer(event) {
  const dialog = panel();
  if (!dialog.open || modal || dialog.contains(event.target) || themeButton().contains(event.target)) return;
  closePanel(false);
}

// Tab ra khỏi ô nổi (focus sang phần tử khác ngoài nút) cũng đóng. relatedTarget rỗng (bấm chuột trên Safari, rời cửa
// sổ) thì giữ nguyên.
function closeOnFocusAway(event) {
  const next = event.relatedTarget;
  if (modal || !next || panel().contains(next) || next === themeButton()) return;
  closePanel(false);
}

// Thẻ khác của trình duyệt này vừa đổi giao diện.
function followOtherTab(event) {
  if (event.key !== null && event.key !== STORAGE_KEYS.skin && event.key !== STORAGE_KEYS.mode) return;
  current = readTheme(storage());
  applyTheme(document, current);
  syncRadios();
}

// Gắn một lần khi trang mở (app.js). Áp dụng lại lựa chọn đã lưu (giống theme-boot.js) để các ô chọn khớp với trang.
export function initThemePicker() {
  applyTheme(document, current);
  syncRadios();
  themeButton().addEventListener("click", () => (panel().open ? closePanel(true) : openPanel()));
  // Focus đang ở nút (Shift+Tab từ ô nổi): Esc vẫn đóng ô nổi trước, thông báo (nếu có) đóng ở lần Esc sau.
  themeButton().addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !panel().open) return;
    event.preventDefault();
    closePanel(false);
  });
  panel().addEventListener("click", handlePanelClick);
  panel().addEventListener("keydown", handlePanelKeydown);
  panel().addEventListener("focusout", closeOnFocusAway);
  panel().addEventListener("close", () => themeButton().setAttribute("aria-expanded", "false"));
  document.addEventListener("pointerdown", closeOnOutsidePointer);
  window.addEventListener("storage", followOtherTab);
}
