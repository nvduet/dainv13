// Giao diện đã lưu trên máy này (bảng chọn "Đổi giao diện"), áp dụng trước khi trang hiện: script thường chạy đồng bộ
// trong <head>, trước styles.css. Chưa lưu gì hoặc bộ nhớ bị chặn: giữ data-skin="graphite" của index.html và chế độ
// theo máy (CSS). Cùng quy tắc với js/theme.js (tests/frontend-theme.test.mjs kiểm hai bên khớp nhau).
(function () {
  var colors = { graphite: ["#f4f4f3", "#0c0c0d"], rung: ["#f3f4f6", "#0f1417"], nga: ["#f2eee6", "#12100c"], navy: ["#edf0f5", "#0a0f1a"] };
  var skin = null;
  var mode = null;
  try {
    skin = localStorage.getItem("so-chi-skin");
    mode = localStorage.getItem("so-chi-mode");
  } catch (error) {
    // Bộ nhớ bị chặn: giao diện mặc định.
  }
  if (!Object.prototype.hasOwnProperty.call(colors, skin)) skin = "graphite";
  if (mode !== "light" && mode !== "dark") mode = "auto";
  if (skin === "graphite" && mode === "auto") return;
  var root = document.documentElement;
  root.setAttribute("data-skin", skin);
  if (mode !== "auto") root.setAttribute("data-mode", mode);
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i += 1) {
    var dark = mode === "auto" ? /dark/.test(metas[i].getAttribute("media") || "") : mode === "dark";
    metas[i].setAttribute("content", colors[skin][dark ? 1 : 0]);
  }
})();
