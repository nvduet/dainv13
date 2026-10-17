// Bấm/chạm vào thuật ngữ có gạch chân chấm (.gl) để xem giải nghĩa tiếng Việt.
(function () {
  var pop = document.createElement('div');
  pop.className = 'gl-pop';
  pop.setAttribute('role', 'tooltip');
  pop.id = 'gl-pop';
  pop.hidden = true;
  document.body.appendChild(pop);
  var current = null;

  function close() {
    if (!current) return;
    current.classList.remove('is-open');
    current.setAttribute('aria-expanded', 'false');
    current = null;
    pop.hidden = true;
  }

  function open(el) {
    if (current === el) { close(); return; }
    close();
    current = el;
    el.classList.add('is-open');
    el.setAttribute('aria-expanded', 'true');
    pop.innerHTML = '';
    var term = document.createElement('span');
    term.className = 'gl-term';
    term.textContent = el.textContent;
    pop.appendChild(term);
    pop.appendChild(document.createTextNode(el.getAttribute('data-tip')));
    pop.hidden = false;
    place(el);
  }

  function place(el) {
    var r = el.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight, m = 12;
    var left = Math.min(Math.max(m, r.left), window.innerWidth - pw - m);
    var top = r.bottom + 6;
    if (top + ph > window.innerHeight - m && r.top - ph - 6 > m) top = r.top - ph - 6;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('.gl') : null;
    if (el) { e.preventDefault(); e.stopPropagation(); open(el); return; }
    if (!pop.contains(e.target)) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { close(); return; }
    var el = document.activeElement;
    if (el && el.classList && el.classList.contains('gl') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); open(el);
    }
  });
  window.addEventListener('scroll', function () { if (current) place(current); }, { passive: true });
  window.addEventListener('resize', function () { if (current) place(current); });
  document.querySelectorAll('.gl').forEach(function (el) {
    el.setAttribute('aria-expanded', 'false');
    el.setAttribute('aria-controls', 'gl-pop');
  });
})();
