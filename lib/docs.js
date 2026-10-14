const { GST_RATE, today } = require('./util');

// Quotes/invoices with customer, vehicle, line sums and payments in one query.
const DOC_SELECT = `
  SELECT d.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
    v.rego, v.make, v.model, v.year,
    COALESCE((SELECT SUM(ROUND(qty * unit_cents)) FROM line_items WHERE document_id = d.id), 0) AS subtotal,
    COALESCE((SELECT SUM(ROUND(qty * unit_cents)) FROM line_items WHERE document_id = d.id AND gst = 1), 0) AS taxable,
    COALESCE((SELECT SUM(amount_cents) FROM payments WHERE document_id = d.id), 0) AS paid
  FROM documents d
  JOIN customers c ON c.id = d.customer_id
  LEFT JOIN vehicles v ON v.id = d.vehicle_id`;

function decorate(d) {
  if (!d) return d;
  d.gst = Math.round(d.taxable * GST_RATE);
  d.total = d.subtotal + d.gst;
  d.balance = d.total - d.paid;
  if (d.type === 'invoice') {
    if (d.status === 'void') d.state = 'void';
    else if (d.total > 0 && d.balance <= 0) d.state = 'paid';
    else if (d.due_date && d.due_date < today()) d.state = 'overdue';
    else if (d.paid > 0) d.state = 'part paid';
    else d.state = 'unpaid';
  } else {
    d.state = d.status;
  }
  return d;
}

function getDoc(db, id) {
  return decorate(db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id));
}

function listDocs(db, where = '1=1', params = [], tail = 'ORDER BY d.issue_date DESC, d.number DESC') {
  return db.prepare(`${DOC_SELECT} WHERE ${where} ${tail}`).all(...params).map(decorate);
}

module.exports = { DOC_SELECT, decorate, getDoc, listDocs };
