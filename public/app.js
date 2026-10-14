// Small progressive enhancements; every page works without this file.

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-confirm-btn]');
  if (btn && !window.confirm(btn.dataset.confirmBtn)) e.preventDefault();
});

// "Email" and "Text" open the user's own app; the form behind them records that it was sent.
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-then-submit]');
  if (a) setTimeout(() => a.closest('form').submit(), 500);
});

document.addEventListener('submit', (e) => {
  const msg = e.target.dataset && e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

function money(cents) {
  const sign = cents < 0 ? '-' : '';
  return sign + '$' + (Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function num(v) {
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Same rounding as the server: half away from zero, GST rounded per line.
function roundCents(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function recalc(box) {
  let subtotal = 0;
  let gst = 0;
  box.querySelectorAll('tr[data-line]').forEach((row) => {
    const cents = roundCents(num(row.querySelector('[data-qty]').value) * roundCents(num(row.querySelector('[data-price]').value) * 100));
    row.querySelector('[data-amount]').textContent = money(cents);
    subtotal += cents;
    if (row.querySelector('[data-gst]').value === '1') gst += roundCents(cents / 10);
  });
  box.querySelector('[data-total="subtotal"]').textContent = money(subtotal);
  box.querySelector('[data-total="gst"]').textContent = money(gst);
  box.querySelector('[data-total="total"]').textContent = money(subtotal + gst);
}

document.querySelectorAll('[data-lines]').forEach((box) => {
  const tbody = box.querySelector('tbody');
  const template = box.querySelector('[data-line-template]');
  let next = tbody.querySelectorAll('tr').length;

  box.addEventListener('input', () => recalc(box));
  box.addEventListener('change', () => recalc(box));

  box.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add-line]');
    if (add) {
      const html = template.innerHTML.replace(/__i__/g, String(next++));
      tbody.insertAdjacentHTML('beforeend', html);
      const row = tbody.lastElementChild;
      const kind = add.dataset.addLine;
      row.querySelector('[data-kind]').value = kind;
      if (kind === 'labour') {
        row.querySelector('[data-desc]').value = 'Labour';
        row.querySelector('[data-price]').value = box.dataset.labourRate;
      }
      row.querySelector('[data-desc]').focus();
      row.querySelector('[data-desc]').select();
      recalc(box);
      markDirty(box);
    }
    const remove = e.target.closest('[data-remove-line]');
    if (remove) {
      remove.closest('tr').remove();
      recalc(box);
      markDirty(box);
    }
  });
});

// Warn before leaving a job or invoice with unsaved edits.
let dirty = false;
function markDirty(el) {
  if (el.closest('[data-dirty-check]')) dirty = true;
}
document.querySelectorAll('[data-dirty-check]').forEach((form) => {
  form.addEventListener('input', () => (dirty = true));
  form.addEventListener('submit', () => (dirty = false));
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Price list picker: type to search, click or press Enter to add the item as a line.
document.querySelectorAll('[data-lines]').forEach((box) => {
  const picker = box.querySelector('[data-picker]');
  if (!picker) return;
  const input = picker.querySelector('[data-picker-input]');
  const list = picker.querySelector('[data-picker-results]');
  const tbody = box.querySelector('tbody');
  const template = box.querySelector('[data-line-template]');
  let items = [];
  let hot = 0;
  let timer;

  function render() {
    list.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = i === hot ? 'hot' : '';
      li.innerHTML = `<span>${escapeHtml((it.code ? it.code + ' · ' : '') + it.description)}</span><span class="muted">${money(it.unit_cents)}${it.kind === 'labour' ? '/hr' : ''}</span>`;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        add(it);
      });
      list.appendChild(li);
    });
    list.hidden = items.length === 0;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function add(it) {
    const next = tbody.querySelectorAll('tr').length + Math.floor(Math.random() * 1000) + 1000;
    tbody.insertAdjacentHTML('beforeend', template.innerHTML.replace(/__i__/g, String(next)));
    const row = tbody.lastElementChild;
    row.querySelector('[data-kind]').value = it.kind;
    row.querySelector('[data-desc]').value = it.description;
    row.querySelector('[data-price]').value = (it.unit_cents / 100).toFixed(2);
    row.querySelector('[data-gst]').value = it.gst ? '1' : '0';
    recalc(box);
    markDirty(box);
    input.value = '';
    items = [];
    render();
    row.querySelector('[data-qty]').focus();
    row.querySelector('[data-qty]').select();
  }

  async function search() {
    const q = input.value.trim();
    try {
      const res = await fetch('/price-list.json?q=' + encodeURIComponent(q), { headers: { accept: 'application/json' } });
      items = res.ok ? await res.json() : [];
    } catch {
      items = [];
    }
    hot = 0;
    render();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 150);
  });
  input.addEventListener('focus', () => {
    if (!items.length) search();
    else render();
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      hot = Math.min(hot + 1, items.length - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      hot = Math.max(hot - 1, 0);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault(); // never submit the whole form from the picker
      if (items[hot]) add(items[hot]);
    } else if (e.key === 'Escape') {
      list.hidden = true;
    }
  });
});

// Calendar entry form: the "who is off" field only matters for leave.
(() => {
  const kind = document.getElementById('entry-kind');
  if (!kind) return;
  const sync = () => document.querySelectorAll('[data-kind]').forEach((el) => { el.style.display = el.dataset.kind === kind.value ? '' : 'none'; });
  kind.addEventListener('change', sync);
  sync();
})();
