// Checklist đầu ra: tick để đánh dấu đã đạt; trạng thái lưu trong trình duyệt của người học.
(function () {
  function load(key) { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  document.querySelectorAll('.checklist[data-cl]').forEach(function (box) {
    var key = 'cl:' + box.getAttribute('data-cl');
    var state = load(key);
    var boxes = [].slice.call(box.querySelectorAll('.cl-item input[type="checkbox"][data-id]'));
    var bar = document.createElement('div');
    bar.className = 'cl-progress';
    bar.innerHTML = '<span class="cl-count"></span><span class="cl-bar"><i></i></span><button type="button" class="cl-reset">Bỏ chọn tất cả</button>';
    box.insertBefore(bar, box.firstChild);
    function refresh() {
      var done = 0;
      boxes.forEach(function (cb) {
        var item = cb.closest('.cl-item');
        if (item) item.classList.toggle('is-done', cb.checked);
        if (cb.checked) done++;
      });
      bar.querySelector('.cl-count').textContent = done + '/' + boxes.length + ' mục đã đạt';
      bar.querySelector('.cl-bar > i').style.width = (boxes.length ? 100 * done / boxes.length : 0) + '%';
    }
    boxes.forEach(function (cb) {
      cb.checked = !!state[cb.getAttribute('data-id')];
      cb.addEventListener('change', function () { state[cb.getAttribute('data-id')] = cb.checked; save(key, state); refresh(); });
    });
    bar.querySelector('.cl-reset').addEventListener('click', function () {
      boxes.forEach(function (cb) { cb.checked = false; }); state = {}; save(key, state); refresh();
    });
    refresh();
  });
})();
