// Text messages to customers, through one SMS account for the whole server (like email
// through Resend). Pick the provider with SMS_PROVIDER:
//   clicksend  ClickSend (Australian): CLICKSEND_USERNAME, CLICKSEND_API_KEY
//   twilio     Twilio: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (a number you own)
//   log        test mode: nothing leaves the server, messages are saved and marked as test
// With no provider set, Text buttons open the user's own phone instead. Test sites
// (SEED_DEMO=1) and development default to test mode so the screens can be tried.

function providerName() {
  const p = String(process.env.SMS_PROVIDER || '').toLowerCase();
  if (PROVIDERS[p]) return p;
  if (!p && (process.env.SEED_DEMO === '1' || process.env.NODE_ENV !== 'production')) return 'log';
  return '';
}

function configured() {
  return Boolean(providerName());
}

const isTestMode = () => providerName() === 'log';

// Australian mobiles to +61 form; anything already international is kept.
function normalise(phone) {
  let s = String(phone || '').replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : '';
  if (/^04\d{8}$/.test(s)) return `+61${s.slice(1)}`;
  if (/^614\d{8}$/.test(s)) return `+${s}`;
  if (/^0\d{9}$/.test(s)) return `+61${s.slice(1)}`;
  return '';
}

// A sender name shows instead of a number: up to 11 letters or digits, no spaces needed.
function senderId(name) {
  return String(name || '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 11).trim();
}

const PROVIDERS = {
  log: {
    label: 'Test mode',
    async send({ to, body }) {
      console.log(`[sms test mode] to ${to}: ${body}`);
      return { id: `test_${Date.now().toString(36)}` };
    },
    parseInbound: (req) => ({ from: req.body.from, body: req.body.body }),
  },

  clicksend: {
    label: 'ClickSend',
    async send({ to, body, from }) {
      const auth = Buffer.from(`${process.env.CLICKSEND_USERNAME}:${process.env.CLICKSEND_API_KEY}`).toString('base64');
      const res = await fetch(`${process.env.CLICKSEND_API_URL || 'https://rest.clicksend.com'}/v3/sms/send`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
        // A sender name can't take replies, so two-way texting uses the account's shared number.
        body: JSON.stringify({ messages: [{ source: 'baybos', to, body, from: process.env.CLICKSEND_FROM || from || undefined }] }),
      });
      const data = await res.json().catch(() => ({}));
      const msg = data.data && data.data.messages && data.data.messages[0];
      if (!res.ok || !msg || msg.status !== 'SUCCESS') throw new Error(`Text failed: ${(msg && msg.status) || data.response_msg || res.status}`);
      return { id: msg.message_id };
    },
    // ClickSend inbound rules post the reply as form fields or JSON.
    parseInbound: (req) => ({ from: req.body.from, body: req.body.body || req.body.message }),
  },

  twilio: {
    label: 'Twilio',
    async send({ to, body }) {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const res = await fetch(`${process.env.TWILIO_API_URL || 'https://api.twilio.com'}/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM || '', Body: body }).toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Text failed: ${data.message || res.status}`);
      return { id: data.sid };
    },
    parseInbound: (req) => ({ from: req.body.From, body: req.body.Body }),
  },
};

// Sends a text to a customer and keeps it in their message history.
// Returns the saved message; throws with a plain reason when it can't go.
async function sendToCustomer(store, db, { customerId, phone, body, userId = null, jobId = null, kind = 'message' }) {
  const provider = PROVIDERS[providerName()];
  if (!provider) throw new Error('Texting is not set up on this server.');
  const to = normalise(phone);
  if (!to) throw new Error('That phone number does not look like a mobile.');
  const text = String(body || '').trim().slice(0, 640);
  if (!text) throw new Error('The message is empty.');
  const settings = await db.get('SELECT business_name, sms_sender FROM settings');
  let result;
  let error = '';
  try {
    result = await provider.send({ to, body: text, from: senderId(settings.sms_sender || settings.business_name) });
  } catch (err) {
    error = err.message;
  }
  const row = await db.get(
    `INSERT INTO sms_messages (customer_id, job_id, user_id, direction, phone, body, kind, status, provider_id, error, test)
     VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [customerId || null, jobId, userId, to, text, kind, error ? 'failed' : 'sent', result ? String(result.id || '') : '', error, isTestMode()]
  );
  if (error) throw new Error(error);
  // So a reply to this number finds its way back to this workshop and customer.
  await store.system.run(
    `INSERT INTO sms_routes (phone, workshop_id, customer_id, last_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (phone, workshop_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, last_at = now()`,
    [to, db.workshopId, customerId || null]
  );
  return row;
}

// A reply from a customer: filed with whichever workshop last texted that number.
async function receive(store, req) {
  const provider = PROVIDERS[providerName()];
  if (!provider) return null;
  const { from, body } = provider.parseInbound(req);
  const phone = normalise(from);
  const text = String(body || '').trim().slice(0, 2000);
  if (!phone || !text) return null;
  const route = await store.system.get('SELECT * FROM sms_routes WHERE phone = $1 ORDER BY last_at DESC LIMIT 1', [phone]);
  if (!route) return null;
  const db = store.tenant(route.workshop_id);
  return db.get(
    `INSERT INTO sms_messages (customer_id, direction, phone, body, kind, status, test) VALUES ($1, 'in', $2, $3, 'reply', 'received', $4) RETURNING *`,
    [route.customer_id, phone, text, isTestMode()]
  );
}

// "Mazda 3 (ABC123)" for a message: no dots or symbols that look odd in a text.
function carName(v) {
  const name = [v.make, v.model].filter(Boolean).join(' ');
  const rego = v.rego ? String(v.rego).toUpperCase() : '';
  return name ? (rego ? `${name} (${rego})` : name) : rego || 'car';
}

const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (m, k) => (values[k] !== undefined ? values[k] : m));

const DEFAULT_BOOKING_TEMPLATE = 'Hi {first}, a reminder that your {car} is booked in at {business} on {date}{time}. Reply to this message if you need to change it.';
const DEFAULT_READY_TEMPLATE = 'Hi {first}, your {car} is ready to pick up from {business}. Thanks!';

// Day-before booking texts, for every workshop that has them turned on. Safe to run often:
// each booking is texted once, and only from 8am in the workshop's own timezone.
async function sendBookingReminders(store) {
  const { clock, addDays, fmtDate } = require('./util');
  if (!configured()) return 0;
  const workshops = await store.system.all(`SELECT id FROM workshops WHERE status != 'closed'`);
  let sent = 0;
  for (const w of workshops) {
    const db = store.tenant(w.id);
    const settings = await db.get('SELECT * FROM settings');
    if (!settings || !settings.sms_booking_reminders) continue;
    const c = clock(settings.timezone);
    if (c.time < '08:00') continue;
    const bookings = await db.all(
      `SELECT b.*, cu.name AS customer_name, cu.phone, v.rego, v.make, v.model FROM bookings b
       JOIN customers cu ON cu.id = b.customer_id LEFT JOIN vehicles v ON v.id = b.vehicle_id
       WHERE b.date = $1 AND b.status = 'booked' AND b.reminder_sent_at IS NULL AND cu.phone != ''`,
      [addDays(c.date, 1)]
    );
    for (const b of bookings) {
      // Claim it first, so two servers running the sweep can't both text.
      const claimed = await db.get('UPDATE bookings SET reminder_sent_at = now() WHERE id = $1 AND reminder_sent_at IS NULL RETURNING id', [b.id]);
      if (!claimed) continue;
      const body = fill(settings.sms_booking_template || DEFAULT_BOOKING_TEMPLATE, {
        first: b.customer_name.split(' ')[0],
        car: carName(b),
        business: settings.business_name,
        date: `tomorrow, ${fmtDate(b.date)}`,
        time: b.time ? ` at ${b.time}` : '',
      });
      try {
        await sendToCustomer(store, db, { customerId: b.customer_id, phone: b.phone, body, kind: 'booking' });
        sent++;
      } catch (err) {
        console.error(`Booking reminder ${b.id} for workshop ${w.id}: ${err.message}`);
      }
    }
  }
  return sent;
}

function startSweep(store, everyMs = 15 * 60 * 1000) {
  const run = () => sendBookingReminders(store).catch((err) => console.error('Booking reminders:', err.message));
  setTimeout(run, 30 * 1000).unref();
  setInterval(run, everyMs).unref();
}

module.exports = {
  configured,
  isTestMode,
  providerName,
  providerLabel: () => (PROVIDERS[providerName()] || {}).label || '',
  normalise,
  senderId,
  sendToCustomer,
  receive,
  fill,
  carName,
  sendBookingReminders,
  startSweep,
  DEFAULT_BOOKING_TEMPLATE,
  DEFAULT_READY_TEMPLATE,
};
