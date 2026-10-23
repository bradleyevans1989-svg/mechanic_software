// Asking customers for a Google review: by email (through Resend) or a text from the user's phone,
// by hand from the invoice, or by email on its own once an invoice is paid in full.
const mail = require('./mail');
const { getDoc } = require('./docs');

const DEFAULT_MESSAGE =
  'Hi {first}, thanks for choosing {business}. If you were happy with the work on your {car}, a quick Google review would really help us out: {link}';

// Don't ask the same customer again within this many days.
const QUIET_DAYS = 180;

// A review link: any https address, or a Google Place ID turned into Google's "write a review" link.
function reviewLink(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^ChI[\w-]{10,}$/.test(s)) return `https://search.google.com/local/writereview?placeid=${s}`;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function message(settings, doc) {
  const car = [doc.make, doc.model].filter(Boolean).join(' ') || (doc.rego ? doc.rego.toUpperCase() : 'car');
  return (settings.review_message || DEFAULT_MESSAGE)
    .replace(/\{first\}/g, String(doc.customer_name || '').split(' ')[0] || 'there')
    .replace(/\{business\}/g, settings.business_name)
    .replace(/\{car\}/g, car)
    .replace(/\{link\}/g, settings.review_url);
}

const smsHref = (phone, text) => `sms:${String(phone).replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(text)}`;

async function sendEmail(settings, doc, to) {
  const text = message(settings, doc);
  const link = mail.escapeHtml(settings.review_url);
  const html = `<p>${mail.escapeHtml(text).replace(link, `<a href="${link}">${link}</a>`)}</p><p>Thanks,<br>${mail.escapeHtml(settings.business_name)}</p>`;
  await mail.send({ to, subject: `How did we go? ${settings.business_name}`, text: `${text}\n\nThanks,\n${settings.business_name}`, html, replyTo: settings.email || undefined });
}

const markAsked = (db, docId, via) => db.run('UPDATE documents SET review_requested_at = now(), review_via = $1 WHERE id = $2', [via, docId]);

// Whether this customer was asked recently, on any of their invoices.
async function askedRecently(db, customerId) {
  const row = await db.get(
    `SELECT 1 FROM documents WHERE customer_id = $1 AND review_requested_at > now() - make_interval(days => $2) LIMIT 1`,
    [customerId, QUIET_DAYS]
  );
  return Boolean(row);
}

// After a payment: ask by email if the workshop has it switched on and the invoice is now paid.
async function afterPayment(db, settings, docId, today) {
  if (!settings.review_auto || !settings.review_url || !mail.configured()) return false;
  const doc = await getDoc(db, docId, today);
  if (!doc || doc.type !== 'invoice' || doc.state === 'void' || doc.total <= 0 || doc.balance > 0) return false;
  if (doc.review_requested_at || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(doc.customer_email || '')) return false;
  if (await askedRecently(db, doc.customer_id)) return false;
  // Claim it first so two payments at once don't both send.
  const claimed = await db.get(
    `UPDATE documents SET review_requested_at = now(), review_via = 'auto' WHERE id = $1 AND review_requested_at IS NULL RETURNING id`,
    [doc.id]
  );
  if (!claimed) return false;
  try {
    await sendEmail(settings, doc, doc.customer_email);
    return true;
  } catch (err) {
    await db.run('UPDATE documents SET review_requested_at = NULL, review_via = NULL WHERE id = $1', [doc.id]);
    console.error(`Review request for document ${doc.id} failed: ${err.message}`);
    return false;
  }
}

module.exports = { DEFAULT_MESSAGE, QUIET_DAYS, reviewLink, message, smsHref, sendEmail, markAsked, askedRecently, afterPayment };
