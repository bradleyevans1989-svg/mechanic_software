// Outgoing email through Resend (https://resend.com): one API key serves every workshop,
// and replies go to the workshop's own address. Without RESEND_API_KEY and EMAIL_FROM
// the app falls back to opening the user's own email program.
const apiBase = () => process.env.RESEND_API_URL || 'https://api.resend.com';

function configured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

async function send({ to, subject, text, html, replyTo }) {
  const res = await fetch(`${apiBase()}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text, html, reply_to: replyTo || undefined }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Email failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

module.exports = { configured, send, escapeHtml };
