// Small progressive enhancements; every page works without this file.

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

// Same rounding as the server: GST is 10% of the taxable subtotal.
function recalc(box) {
  let subtotal = 0;
  let taxable = 0;
  box.querySelectorAll('tr[data-line]').forEach((row) => {
    const cents = Math.round(num(row.querySelector('[data-qty]').value) * Math.round(num(row.querySelector('[data-price]').value) * 100));
    row.querySelector('[data-amount]').textContent = money(cents);
    subtotal += cents;
    if (row.querySelector('[data-gst]').value === '1') taxable += cents;
  });
  const gst = Math.round(taxable * 0.1);
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
