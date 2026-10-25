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
  let cost = 0;
  box.querySelectorAll('tr[data-line]').forEach((row) => {
    const qty = num(row.querySelector('[data-qty]').value);
    const cents = roundCents(qty * roundCents(num(row.querySelector('[data-price]').value) * 100));
    row.querySelector('[data-amount]').textContent = money(cents);
    subtotal += cents;
    if (row.querySelector('[data-gst]').value === '1') gst += roundCents(cents / 10);
    const costInput = row.querySelector('[data-cost]');
    if (costInput) cost += roundCents(qty * roundCents(num(costInput.value) * 100));
  });
  box.querySelector('[data-total="subtotal"]').textContent = money(subtotal);
  box.querySelector('[data-total="gst"]').textContent = money(gst);
  box.querySelector('[data-total="total"]').textContent = money(subtotal + gst);
  const costCell = box.querySelector('[data-total="cost"]');
  if (costCell) {
    costCell.textContent = money(cost);
    box.querySelector('[data-total="profit"]').textContent = money(subtotal - cost);
  }
}

// Cost and markup work out the sell price; typing a price instead works the markup back out.
function pct(n) {
  return String(Math.round(n * 10) / 10);
}

function priceFromCost(box, row, input) {
  const costInput = row.querySelector('[data-cost]');
  if (!costInput) return;
  const markupInput = row.querySelector('[data-markup]');
  const priceInput = row.querySelector('[data-price]');
  const cost = roundCents(num(costInput.value) * 100);
  if (input === priceInput) {
    if (cost > 0 && priceInput.value.trim() !== '') markupInput.value = pct((roundCents(num(priceInput.value) * 100) / cost - 1) * 100);
    return;
  }
  if (input === costInput && markupInput.value.trim() === '') markupInput.value = box.dataset.defaultMarkup || '0';
  if (cost > 0) priceInput.value = (roundCents(cost * (1 + num(markupInput.value) / 100)) / 100).toFixed(2);
}

document.querySelectorAll('[data-lines]').forEach((box) => {
  const tbody = box.querySelector('tbody');
  const template = box.querySelector('[data-line-template]');
  let next = tbody.querySelectorAll('tr').length;

  box.addEventListener('input', (e) => {
    const row = e.target.closest('tr[data-line]');
    if (row && e.target.matches('[data-cost], [data-markup], [data-price]')) priceFromCost(box, row, e.target);
    recalc(box);
  });
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
    const costInput = row.querySelector('[data-cost]');
    if (costInput && it.cost_cents > 0) {
      costInput.value = (it.cost_cents / 100).toFixed(2);
      row.querySelector('[data-markup]').value = pct((it.unit_cents / it.cost_cents - 1) * 100);
    }
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

// Logo upload: shrink the picture in the browser and send it as a data URL.
(() => {
  const file = document.querySelector('[data-logo-file]');
  if (!file) return;
  const hidden = document.querySelector('[data-logo-data]');
  const submit = document.querySelector('[data-logo-submit]');
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 900 / img.width, 360 / img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      hidden.value = c.toDataURL('image/png');
      submit.disabled = false;
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
  });
})();

// Job photos: shrink the picture from the phone's camera to a JPEG and send it straight away.
document.querySelectorAll('[data-photo-form]').forEach((form) => {
  const file = form.querySelector('[data-photo-file]');
  const hidden = form.querySelector('[data-photo-data]');
  const btn = file.closest('label');
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    btn.firstChild.textContent = 'Uploading…';
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      hidden.value = c.toDataURL('image/jpeg', 0.82);
      URL.revokeObjectURL(img.src);
      form.submit();
    };
    img.src = URL.createObjectURL(f);
  });
});

// Dropdowns that save as soon as they change, and table rows that open a link.
document.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-auto-submit]');
  if (!sel) return;
  if (sel.value === 'invoice' && !window.confirm('Make an invoice from this job? It copies the labour and parts across and marks the job invoiced.')) {
    sel.value = sel.dataset.was || sel.querySelector('option[selected]')?.value || sel.options[0].value;
    return;
  }
  sel.closest('form').submit();
});
document.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-href]');
  if (!row || e.target.closest('a, button, select, input, label, form')) return;
  if (window.getSelection && String(window.getSelection())) return;
  window.location = row.dataset.href;
});

// Tick rows, and a bar appears with the bulk actions.
(() => {
  const bar = document.querySelector('[data-bulk-bar]');
  if (!bar) return;
  const all = document.querySelector('[data-check-all]');
  const boxes = () => Array.from(document.querySelectorAll('[data-check]'));
  const sync = () => {
    const n = boxes().filter((b) => b.checked).length;
    bar.hidden = n === 0;
    bar.querySelector('[data-bulk-count]').textContent = n;
  };
  document.addEventListener('change', (e) => {
    if (e.target === all) boxes().forEach((b) => { b.checked = all.checked; });
    if (e.target === all || e.target.matches('[data-check]')) sync();
  });
  bar.closest('form').addEventListener('submit', (e) => { if (!bar.querySelector('select').value) { e.preventDefault(); window.alert('Choose an action first.'); } });
  sync();
})();

// Live board: tick the clocks every second, and fetch a fresh board every 20 seconds.
(() => {
  const root = document.querySelector('[data-liveboard]');
  if (!root) return;
  const clock = document.querySelector('[data-bw-clock]');
  const fmtNow = new Intl.DateTimeFormat('en-AU', { timeZone: root.dataset.tz || undefined, hour: 'numeric', minute: '2-digit' });
  const hm = (m) => { m = Math.round(m); const h = Math.floor(m / 60); return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
  const hms = (s) => { s = Math.floor(s); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const PACE = { ok: ['✓', 'On track'], nearing: ['!', 'Nearly at estimate'], over: ['▲', 'Over estimate'] };
  let loadedAt = Date.now();

  function tick() {
    if (clock) clock.textContent = fmtNow.format(new Date());
    const gone = (Date.now() - loadedAt) / 1000;
    root.querySelectorAll('.bay').forEach((bay) => {
      const running = Number(bay.dataset.running);
      if (!running) return;
      const secs = Number(bay.dataset.sec) + running * gone;
      bay.querySelector('[data-elapsed]').textContent = hms(secs);
      const est = Number(bay.dataset.est);
      if (!est) return;
      const mins = Math.floor(secs / 60);
      const pace = mins > est ? 'over' : mins >= est * 0.8 ? 'nearing' : 'ok';
      const left = bay.querySelector('[data-left]');
      if (left) left.textContent = mins > est ? `${hm(mins - est)} over` : `${hm(est - mins)} left`;
      if (!bay.classList.contains(`pace-${pace}`)) {
        bay.classList.remove('pace-ok', 'pace-nearing', 'pace-over');
        bay.classList.add(`pace-${pace}`);
        bay.querySelector('[data-pace]').innerHTML = `<span aria-hidden="true">${PACE[pace][0]}</span> ${PACE[pace][1]}`;
      }
    });
  }

  async function refresh() {
    try {
      const res = await fetch('/live-board?part=board', { headers: { accept: 'text/html' } });
      // A redirect to the login page means the session ended; reload so it shows.
      if (res.redirected || !res.ok) return res.status === 401 || res.redirected ? location.reload() : undefined;
      root.innerHTML = await res.text();
      loadedAt = Date.now();
      tick();
    } catch {
      // Offline for a moment: keep ticking and try again next time.
    }
  }

  tick();
  setInterval(tick, 1000);
  setInterval(refresh, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  // Keep a workshop screen from going to sleep while the board is up.
  if (document.body.classList.contains('bw-tv') && navigator.wakeLock) {
    const lock = () => navigator.wakeLock.request('screen').catch(() => {});
    lock();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) lock(); });
  }
})();

// The menu button folds the sidebar to icons on a wide screen, and slides it in over the page on a phone.
document.addEventListener('click', (e) => {
  const root = document.documentElement;
  if (e.target.closest('[data-side-toggle]')) {
    if (window.matchMedia('(max-width: 900px)').matches) {
      root.classList.toggle('side-open');
    } else {
      const mini = root.classList.toggle('side-mini');
      try { localStorage.setItem('side-mini', mini ? '1' : '0'); } catch (err) { /* private mode: just this page */ }
    }
  } else if (e.target.closest('[data-side-close]')) {
    root.classList.remove('side-open');
  }
  // Close the notifications menu when clicking anywhere else.
  for (const d of document.querySelectorAll('details.bell[open]')) if (!d.contains(e.target)) d.open = false;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.documentElement.classList.remove('side-open');
});


// Spreadsheet uploads (CSV or Excel) travel as base64 in hidden fields, so a
// multi-step form can carry them from step to step without storing anything.
document.querySelectorAll('[data-file-into]').forEach((input) => {
  input.addEventListener('change', () => {
    const slot = input.dataset.fileInto;
    const form = input.form;
    const name = form.querySelector(`[data-file-name="${slot}"]`);
    const data = form.querySelector(`[data-file-data="${slot}"]`);
    const file = input.files && input.files[0];
    if (!file) { name.value = ''; data.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { name.value = file.name; data.value = String(reader.result).replace(/^data:[^,]*,/, ''); };
    reader.readAsDataURL(file);
  });
});

// The import's upload step shows the file pickers for what's being imported.
document.querySelectorAll('[data-import-upload]').forEach((form) => {
  const show = () => {
    const kind = (form.querySelector('[name="kind"]:checked') || {}).value || 'customers';
    form.querySelectorAll('[data-kind-show]').forEach((el) => { el.hidden = el.dataset.kindShow !== kind; });
  };
  form.addEventListener('change', show);
  show();
  form.addEventListener('submit', (e) => {
    const kind = (form.querySelector('[name="kind"]:checked') || {}).value;
    const main = form.querySelector(`[data-file-data="${kind}"]`);
    if (main && !main.value) { e.preventDefault(); alert(kind === 'parts' ? 'Choose your parts or stock file first.' : 'Choose your customers file first.'); }
  });
});

// Row filter on the import check step.
document.querySelectorAll('[data-import-filter]').forEach((tabs) => {
  const rows = document.querySelectorAll('.import-rows tbody tr, .import-rows tr[data-status]');
  tabs.addEventListener('click', (e) => {
    const a = e.target.closest('[data-show]');
    if (!a) return;
    e.preventDefault();
    tabs.querySelectorAll('a').forEach((x) => x.classList.toggle('active', x === a));
    const want = a.dataset.show;
    rows.forEach((r) => {
      r.hidden = want === 'note' ? r.dataset.note !== '1' : Boolean(want) && r.dataset.status !== want;
    });
  });
});

// Long-running form posts say so and can't be pressed twice.
document.querySelectorAll('form[data-busy]').forEach((form) => {
  form.addEventListener('submit', () => {
    const b = form.querySelector('button');
    if (b) { b.disabled = true; b.textContent = form.dataset.busy; }
  });
});

// Look up rego / Decode VIN on the vehicle forms: fills in make, model, year, colour and VIN.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-lookup-rego], [data-lookup-vin]');
  if (!btn) return;
  const bar = btn.closest('[data-lookup]');
  const form = bar.closest('form');
  const prefix = bar.dataset.lookup;
  const field = (n) => form.querySelector(`[name="${prefix}${n}"]`);
  const msg = bar.querySelector('[data-lookup-msg]');
  const state = bar.querySelector('[data-lookup-state]');
  const byRego = btn.hasAttribute('data-lookup-rego');
  const value = (byRego ? field('rego') : field('vin'))?.value.trim();
  if (!value) {
    msg.textContent = byRego ? 'Enter the rego first.' : 'Enter the VIN first.';
    return;
  }
  if (state) try { localStorage.setItem('rego-state', state.value); } catch (err) {}
  btn.disabled = true;
  msg.textContent = 'Looking up…';
  try {
    const url = byRego ? `/lookup/rego?rego=${encodeURIComponent(value)}&state=${state ? state.value : ''}` : `/lookup/vin?vin=${encodeURIComponent(value)}`;
    const r = await (await fetch(url, { headers: { accept: 'application/json' } })).json();
    if (!r.ok) {
      msg.textContent = r.error;
      return;
    }
    const filled = [];
    for (const k of ['make', 'model', 'year', 'colour', 'vin']) {
      const input = field(k);
      if (input && r.vehicle[k] && input.value !== r.vehicle[k] && !(k === 'vin' && !byRego)) {
        input.value = r.vehicle[k];
        filled.push(k === 'vin' ? 'VIN' : k);
      }
    }
    msg.textContent = (r.vehicle.description ? r.vehicle.description + '. ' : '') + (filled.length ? `Filled in ${filled.join(', ')}.` : 'Nothing new to fill in.') + (r.note ? ' ' + r.note : '') + (r.checkDigit === false ? ' The check digit looks wrong; check the VIN.' : '');
  } catch (err) {
    msg.textContent = 'The lookup failed. Try again.';
  } finally {
    btn.disabled = false;
  }
});

// Remember the state picked for rego lookups.
document.querySelectorAll('[data-lookup-state]').forEach((s) => {
  try {
    const saved = localStorage.getItem('rego-state');
    if (saved && [...s.options].some((o) => o.value === saved)) s.value = saved;
  } catch (err) {}
});
