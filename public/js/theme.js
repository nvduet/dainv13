// Giao diện riêng của từng người xem: lưu trên máy này (localStorage), không gọi máy chủ. theme-boot.js (script thường,
// chạy trước khi trang hiện) đọc và áp dụng đúng theo các quy tắc này; tests/frontend-theme.test.mjs kiểm hai bên khớp.
export const SKINS = Object.freeze(["graphite", "rung", "nga", "navy"]);
export const MODES = Object.freeze(["auto", "light", "dark"]);
// Mặc định cho máy chưa từng chọn (chủ dự án chọn 2026-11-05): Ngà & Vàng, Sáng. index.html mang sẵn đúng giá trị này.
export const DEFAULT_THEME = Object.freeze({ skin: "nga", mode: "light" });
export const STORAGE_KEYS = Object.freeze({ skin: "so-chi-skin", mode: "so-chi-mode" });
// Màu nền trang [sáng, tối] của từng giao diện, cho thẻ <meta name="theme-color"> (thanh trình duyệt trên điện thoại).
export const PAGE_COLORS = Object.freeze({
  graphite: ["#f4f4f3", "#0c0c0d"],
  rung: ["#f3f4f6", "#0f1417"],
  nga: ["#f2eee6", "#12100c"],
  navy: ["#edf0f5", "#0a0f1a"],
});

// Giá trị lạ hoặc thiếu: giao diện mặc định (Ngà & Vàng, Sáng).
export function normalizeTheme(skin, mode) {
  return {
    skin: SKINS.includes(skin) ? skin : DEFAULT_THEME.skin,
    mode: MODES.includes(mode) ? mode : DEFAULT_THEME.mode,
  };
}

// storage: localStorage; truy cập có thể ném lỗi (chặn cookie/bộ nhớ trang) nên luôn có giá trị mặc định.
export function readTheme(storage) {
  try {
    return normalizeTheme(storage.getItem(STORAGE_KEYS.skin), storage.getItem(STORAGE_KEYS.mode));
  } catch {
    return { ...DEFAULT_THEME };
  }
}

// true khi đã lưu; false: chỉ áp dụng cho trang đang mở.
export function saveTheme(storage, { skin, mode }) {
  try {
    storage.setItem(STORAGE_KEYS.skin, skin);
    storage.setItem(STORAGE_KEYS.mode, mode);
    return true;
  } catch {
    return false;
  }
}

export function effectiveMode(mode, prefersDark) {
  return mode === "auto" ? (prefersDark ? "dark" : "light") : mode;
}

// Thuộc tính của <html>. data-mode chỉ có khi người xem chọn Sáng hoặc Tối; "Tự động" để CSS theo máy (cả khi tắt
// JavaScript), nên không cần theo dõi máy đổi chế độ.
export function themeAttributes({ skin, mode }) {
  return { "data-skin": skin, "data-mode": mode === "auto" ? null : mode };
}

// Nội dung hai thẻ theme-color [cho máy đang sáng, cho máy đang tối].
export function themeColors({ skin, mode }) {
  return [false, true].map((prefersDark) => PAGE_COLORS[skin][effectiveMode(mode, prefersDark) === "dark" ? 1 : 0]);
}

export function applyTheme(document, theme) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeAttributes(theme))) {
    if (value === null) root.removeAttribute(name);
    else if (root.getAttribute(name) !== value) root.setAttribute(name, value);
  }
  const [light, dark] = themeColors(theme);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", /dark/.test(meta.getAttribute("media") || "") ? dark : light);
  }
}
