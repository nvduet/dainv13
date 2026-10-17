/* Click-to-explain glossary for CDC/SDV lesson pages.
   Data: window.CDC_GLOSSARY (assets/glossary-data.js) = [{t, aka:[], full, vi, cs}]
     t    – term as displayed in the popover
     aka  – other spellings to match (plural, lower case, hyphen variants…)
     full – expansion for abbreviations (optional)
     vi   – plain Vietnamese explanation (HTML inline allowed)
     cs   – true = match case-sensitively (abbreviations such as "CAN", "SA", "OS")
   Every occurrence inside the lesson article (and the dynamically rendered questions) becomes a button;
   clicking it opens a small popover. Esc / click outside closes it. */
(function () {
  'use strict';
  var DATA = window.CDC_GLOSSARY;
  if (!DATA || !DATA.length) return;
  var me = document.currentScript;
  // whole page body; navigation chrome is skipped below
  var root = document.body;

  // self-contained styles (pages outside Topics/ do not load lesson.css)
  var css = document.createElement('style');
  css.textContent =
    'button.tg-term{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;line-height:inherit;letter-spacing:inherit;text-align:inherit;cursor:help;display:inline;border-radius:0;' +
    'text-decoration-line:underline;text-decoration-style:dotted;text-decoration-thickness:1px;text-underline-offset:3px;text-decoration-color:currentColor}' +
    'button.tg-term:hover,button.tg-term[aria-expanded="true"]{background:rgba(226,189,105,.30)}' +
    'button.tg-term:focus-visible{outline:2px solid #E2BD69;outline-offset:1px}' +
    '.tg-pop{position:absolute;z-index:10000;background:#fff;color:#1c2928;border:1px solid #c9d6d0;border-top:3px solid #174C43;border-radius:10px;box-shadow:0 10px 28px rgba(23,40,38,.2);padding:10px 34px 12px 14px;font:14.5px/1.6 "Segoe UI",Tahoma,Arial,sans-serif;text-align:left;letter-spacing:normal;text-transform:none;font-weight:400}' +
    '.tg-pop .tg-h{margin:0 0 4px;color:#174C43;font-size:15px}' +
    '.tg-pop .tg-full{color:#A64E32;font-weight:600;font-size:13px}' +
    '.tg-pop .tg-vi{color:#2c3b39}' +
    '.tg-pop .tg-x{position:absolute;top:4px;right:6px;width:26px;height:26px;border:0;background:none;color:#596966;font-size:19px;line-height:1;cursor:pointer;border-radius:6px}' +
    '.tg-pop .tg-x:hover{background:#E5EFEB;color:#174C43}' +
    '@media print{button.tg-term{text-decoration:none}.tg-pop{display:none}}';
  document.head.appendChild(css);

  var SKIP = '.gl,.gl-pop,nav,footer,.topbar,.reader-header,.contents-panel,.article-footer,.tapnav,.next-prev,.bai-nav,.lesson-kicker,.kq-type,' +
    'h1,h2,h3,h4,a,button,summary,code,pre,svg,textarea,select,input,script,style,noscript,.tg-term,.tg-pop';
  // sense scope: lesson unit (A.1 … C.4) from the page data, or data-unit on the script tag (e.g. "AI");
  // entries with "u" are scope-specific senses that override the shared meaning
  var UNIT = (me && me.getAttribute('data-unit')) || null;
  try { UNIT = JSON.parse(document.getElementById('unit-assessment').textContent).unit; } catch (e) { /* not a lesson page */ }
  var byKey = {}, ci = [], cs = [];
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function add(e, i, override) {
    [e.t].concat(e.aka || []).forEach(function (form) {
      if (!form) return;
      var k = e.cs ? 'S:' + form : 'I:' + form.toLowerCase();
      if (byKey[k] != null && !override) return;
      if (byKey[k] == null) (e.cs ? cs : ci).push(form);
      byKey[k] = i;
    });
  }
  DATA.forEach(function (e, i) { if (!e.u) add(e, i, false); });
  if (UNIT) DATA.forEach(function (e, i) { if (e.u && e.u.indexOf(UNIT) >= 0) add(e, i, true); });
  var byLen = function (a, b) { return b.length - a.length; };
  ci.sort(byLen); cs.sort(byLen);
  // word boundary that also respects Vietnamese letters
  var B1 = '(?<![\\p{L}\\p{N}_])', B2 = '(?![\\p{L}\\p{N}_])';
  var reCS = cs.length ? new RegExp(B1 + '(' + cs.map(esc).join('|') + ')' + B2, 'gu') : null;
  var reCI = ci.length ? new RegExp(B1 + '(' + ci.map(esc).join('|') + ')' + B2, 'giu') : null;

  function lookup(m) {
    var i = byKey['S:' + m];
    if (i == null) i = byKey['I:' + m.toLowerCase()];
    return i;
  }
  function matches(text) {
    var out = [];
    [reCS, reCI].forEach(function (re) {
      if (!re) return;
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(text))) {
        var idx = lookup(m[1]);
        if (idx != null) out.push({ s: m.index, e: m.index + m[1].length, i: idx });
      }
    });
    out.sort(function (a, b) { return a.s - b.s || (b.e - b.s) - (a.e - a.s); });
    var res = [], end = -1;
    out.forEach(function (x) { if (x.s >= end) { res.push(x); end = x.e; } });
    return res;
  }
  function wrap(scope) {
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !/[A-Za-z]/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (node) {
      var text = node.nodeValue, ms = matches(text);
      if (!ms.length) return;
      var frag = document.createDocumentFragment(), pos = 0;
      ms.forEach(function (m) {
        if (m.s > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.s)));
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'tg-term';
        b.setAttribute('data-tg', m.i);
        b.setAttribute('aria-haspopup', 'dialog');
        b.textContent = text.slice(m.s, m.e);
        frag.appendChild(b);
        pos = m.e;
      });
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  var pop = document.createElement('div');
  pop.className = 'tg-pop';
  pop.setAttribute('role', 'dialog');
  pop.hidden = true;
  document.body.appendChild(pop);
  var current = null;
  function close() { pop.hidden = true; if (current) current.setAttribute('aria-expanded', 'false'); current = null; }
  function open(btn) {
    var e = DATA[+btn.getAttribute('data-tg')];
    if (!e) return;
    if (current === btn) { close(); return; }
    close();
    current = btn;
    btn.setAttribute('aria-expanded', 'true');
    pop.innerHTML = '';
    var h = document.createElement('p'); h.className = 'tg-h';
    var t = document.createElement('b'); t.textContent = e.t; h.appendChild(t);
    if (e.full) { var f = document.createElement('span'); f.className = 'tg-full'; f.textContent = ' · ' + e.full; h.appendChild(f); }
    var x = document.createElement('button'); x.type = 'button'; x.className = 'tg-x'; x.setAttribute('aria-label', 'Đóng'); x.textContent = '×';
    x.addEventListener('click', close);
    pop.appendChild(x); pop.appendChild(h);
    var v = document.createElement('div'); v.className = 'tg-vi'; v.innerHTML = e.vi; pop.appendChild(v);
    pop.hidden = false;
    var r = btn.getBoundingClientRect(), W = Math.min(340, window.innerWidth - 24);
    pop.style.width = W + 'px';
    var left = Math.max(12, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - W - 12));
    var top = r.bottom + window.scrollY + 6;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    var pr = pop.getBoundingClientRect();
    if (pr.bottom > window.innerHeight - 8 && r.top > pr.height + 16) pop.style.top = (r.top + window.scrollY - pr.height - 6) + 'px';
    x.focus({ preventScroll: true });
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('.tg-term');
    if (b) { ev.preventDefault(); open(b); return; }
    if (!pop.hidden && !pop.contains(ev.target)) close();
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !pop.hidden) { var c = current; close(); if (c) c.focus(); } });

  wrap(root);
  // questions/reflection/workshop are rendered by assessment.js; wrap answers lazily when first opened
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (d.tagName === 'DETAILS' && d.open && !d.hasAttribute('data-tg-done')) { d.setAttribute('data-tg-done', ''); wrap(d); }
  }, true);
})();
