// Quotes/invoices with customer, vehicle, line sums and payments in one query.
// GST is rounded per line (half away from zero), matching lib/util.js and Xero.
const DOC_SELECT = `
  SELECT d.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
    v.rego, v.make, v.model, v.year,
    (SELECT j.number FROM jobs j WHERE j.id = d.job_id) AS job_number,
    COALESCE((SELECT SUM(ROUND((qty * unit_cents)::numeric)) FROM line_items WHERE document_id = d.id), 0) AS subtotal,
    COALESCE((SELECT SUM(ROUND(ROUND((qty * unit_cents)::numeric) / 10)) FROM line_items WHERE document_id = d.id AND gst), 0) AS gst,
    COALESCE((SELECT SUM(amount_cents) FROM payments WHERE document_id = d.id), 0) AS paid
  FROM documents d
  JOIN customers c ON c.id = d.customer_id
  LEFT JOIN vehicles v ON v.id = d.vehicle_id`;

// today: the workshop's current date, for working out what's overdue.
function decorate(d, today) {
  if (!d) return d;
  d.total = d.subtotal + d.gst;
  d.balance = d.total - d.paid;
  if (d.type === 'invoice') {
    if (d.status === 'void') d.state = 'void';
    else if (d.total > 0 && d.balance <= 0) d.state = 'paid';
    else if (d.due_date && today && d.due_date < today) d.state = 'overdue';
    else if (d.paid > 0) d.state = 'part paid';
    else d.state = 'unpaid';
  } else {
    d.state = d.status;
  }
  return d;
}

async function getDoc(db, id, today) {
  return decorate(await db.get(`${DOC_SELECT} WHERE d.id = $1`, [id]), today);
}

async function listDocs(db, today, where = 'true', params = [], tail = 'ORDER BY d.issue_date DESC, d.number DESC') {
  return (await db.all(`${DOC_SELECT} WHERE ${where} ${tail}`, params)).map((d) => decorate(d, today));
}

module.exports = { DOC_SELECT, decorate, getDoc, listDocs };
