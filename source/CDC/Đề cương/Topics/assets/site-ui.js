/* Theme (light/dark) + outline-version switch for the CDC/SDV outline site. Loaded first in <head>.
   The 15 outline pages exist in three folders under Topics/:
     click  – full text, English terms explained in a popover when clicked
     inline – full text, English terms explained in parentheses
     short  – independently written content on the same frame (popover glossary)
   Every other page is shared; its links to outline pages follow the chosen version. */
(function () {
  'use strict';
  var THEME_KEY = 'cdc-theme', MODE_KEY = 'cdc-gloss-mode';
  var ORDER = ['click', 'inline', 'short'];
  var DIRS = { click: 'Bấm để xem giải thích', inline: 'Giải thích trong ngoặc', short: 'Tự biên soạn' };
  var LABEL = { click: 'Bấm xem', inline: 'Trong ngoặc', short: 'Tự biên soạn' };
  var HINT = { click: 'Bản đầy đủ, bấm vào từ chuyên ngành để xem giải thích',
               inline: 'Bản đầy đủ, giải thích nằm trong ngoặc', short: 'Bản tự biên soạn: cùng khung, nội dung viết mới' };
  var root = document.documentElement;
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function seg(m) { return '/Topics/' + DIRS[m] + '/'; }

  // ---- theme: set before first paint ----
  var param = (location.search.match(/[?&]theme=(light|dark)/) || [])[1];
  var theme = param || load(THEME_KEY) || 'dark';
  if (param) save(THEME_KEY, param);
  root.setAttribute('data-theme', theme);

  // ---- version: an outline page decides by its folder, other pages use the saved choice ----
  var path = decodeURIComponent(location.pathname);
  var pageMode = null;
  ORDER.forEach(function (m) { if (path.indexOf(seg(m)) >= 0) pageMode = m; });
  var mode = pageMode || load(MODE_KEY) || 'click';
  if (!DIRS[mode]) mode = 'click';
  if (pageMode) save(MODE_KEY, pageMode);

  var css = document.createElement('style');
  css.textContent =
    'html[data-theme="light"]{color-scheme:light}html[data-theme="dark"]{color-scheme:dark}' +
    '.site-ui{position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;align-items:center;font:600 13px/1.2 "Segoe UI",Tahoma,Arial,sans-serif}' +
    '.site-ui button{display:inline-flex;align-items:center;gap:6px;padding:9px 14px;cursor:pointer;font:inherit;color:#f2f5f4;' +
    'border:1px solid rgba(255,255,255,.25);background:rgba(18,30,28,.9);box-shadow:0 4px 14px rgba(0,0,0,.28);border-radius:999px}' +
    '.site-ui button:hover{background:#24584d;border-color:#8cc6b5}' +
    '.site-ui button:focus-visible{outline:2px solid #e2bd69;outline-offset:2px}' +
    '.site-ui .ver{display:inline-flex;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.28)}' +
    '.site-ui .ver button{box-shadow:none;border-radius:0;padding:9px 12px;margin-left:-1px}' +
    '.site-ui .ver button:first-child{border-radius:999px 0 0 999px;margin-left:0}' +
    '.site-ui .ver button:last-child{border-radius:0 999px 999px 0}' +
    '.site-ui .ver button[aria-pressed="true"]{background:#e2bd69;color:#1b2b27;border-color:#e2bd69;cursor:default}' +
    '@media print{.site-ui{display:none}}';
  document.head.appendChild(css);

  // point every link to an outline page at the folder of the chosen version
  function retarget(m) {
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var abs = decodeURIComponent(links[i].href);
      for (var j = 0; j < ORDER.length; j++) {
        var o = ORDER[j];
        if (o !== m && abs.indexOf(seg(o)) >= 0) { links[i].href = encodeURI(abs.replace(seg(o), seg(m))); break; }
      }
    }
  }
  function withTheme(url) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'theme=' + root.getAttribute('data-theme');
  }

  // ---- keep the reading position when switching versions ----
  // click <-> inline: same blocks in the same order, so "block index + fraction" is exact.
  // to / from short: content differs, so keep the section (nearest h2/h3 above the top of the screen).
  var BLOCKS = 'article h2, article h3, article h4, article p, article li, article tr, article figure, article pre, article .box';
  var TOP_GAP = 12;
  function blockPos() {
    if (window.scrollY < 40) return null;
    var els = document.querySelectorAll(BLOCKS);
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.bottom > TOP_GAP && r.height > 0) {
        return i + '_' + Math.min(1, Math.max(0, (TOP_GAP - r.top) / r.height)).toFixed(3);
      }
    }
    return null;
  }
  function sectionId() {
    if (window.scrollY < 40) return null;
    var hs = document.querySelectorAll('article h2[id], article h3[id]'), id = null;
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].getBoundingClientRect().top <= TOP_GAP + 80) id = hs[i].id; else break;
    }
    return id;
  }
  var wantPos = (location.search.match(/[?&]pos=(\d+)_([\d.]+)/) || []);
  function restorePos() {
    if (!wantPos.length) return;
    var el = document.querySelectorAll(BLOCKS)[+wantPos[1]];
    if (!el) return;
    var r = el.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + r.top + (+wantPos[2]) * r.height - TOP_GAP, behavior: 'instant' });
  }
  if (wantPos.length) {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.addEventListener('load', function () {
      restorePos();
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* file:// quirks */ }
    });
  }

  function go(next) {
    save(MODE_KEY, next);
    if (!pageMode) { mode = next; retarget(mode); paint(); return; }   // shared page: only where outline links go
    var url = withTheme(location.protocol + '//' + location.host + encodeURI(path.replace(seg(pageMode), seg(next))));
    var fullPair = pageMode !== 'short' && next !== 'short';
    var pos = fullPair ? blockPos() : null;
    var sec = fullPair ? null : sectionId();
    location.href = pos ? url + '&pos=' + pos : sec ? url + '#' + sec : url + location.hash;
  }

  var verBtns = {};
  function paint() {
    ORDER.forEach(function (m) {
      verBtns[m].setAttribute('aria-pressed', m === mode ? 'true' : 'false');
      verBtns[m].title = (m === mode ? 'Đang dùng: ' : 'Chuyển sang: ') + HINT[m];
    });
  }
  function build() {
    retarget(mode);
    restorePos();
    var bar = document.createElement('div');
    bar.className = 'site-ui';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Giao diện và phiên bản đề cương');

    var t = document.createElement('button');
    t.type = 'button';
    function paintTheme() {
      var dark = root.getAttribute('data-theme') === 'dark';
      t.textContent = dark ? '☀ Sáng' : '☾ Tối';
      t.title = dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
    }
    t.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next); save(THEME_KEY, next); paintTheme();
    });
    paintTheme();

    var group = document.createElement('div');
    group.className = 'ver';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Phiên bản đề cương');
    ORDER.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = LABEL[m];
      b.addEventListener('click', function () { if (m !== mode) go(m); });
      verBtns[m] = b;
      group.appendChild(b);
    });
    paint();

    bar.appendChild(t);
    bar.appendChild(group);
    document.body.appendChild(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
