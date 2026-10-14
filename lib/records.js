const { parseIntOrNull } = require('./util');

function getCustomer(db, id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

function getVehicle(db, id) {
  return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
}

// Every vehicle with its owner, for the "which car?" pickers.
function vehicleOptions(db) {
  return db
    .prepare(
      `SELECT v.*, c.name AS customer_name FROM vehicles v
       JOIN customers c ON c.id = v.customer_id
       ORDER BY v.rego COLLATE NOCASE, c.name COLLATE NOCASE`
    )
    .all();
}

function customerOptions(db) {
  return db.prepare('SELECT id, name, phone FROM customers ORDER BY name COLLATE NOCASE').all();
}

// A form names a vehicle, a customer, or both; the vehicle decides the customer.
function resolveParty(db, body) {
  const vehicleId = parseIntOrNull(body.vehicle_id);
  if (vehicleId) {
    const v = getVehicle(db, vehicleId);
    if (v) return { customer_id: v.customer_id, vehicle_id: v.id };
  }
  const customerId = parseIntOrNull(body.customer_id);
  if (customerId && getCustomer(db, customerId)) return { customer_id: customerId, vehicle_id: null };
  return null;
}

module.exports = { getCustomer, getVehicle, vehicleOptions, customerOptions, resolveParty };
