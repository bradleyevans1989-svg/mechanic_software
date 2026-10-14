const { parseIntOrNull } = require('./util');

const getCustomer = (db, id) => db.get('SELECT * FROM customers WHERE id = $1', [parseIntOrNull(id)]);
const getVehicle = (db, id) => db.get('SELECT * FROM vehicles WHERE id = $1', [parseIntOrNull(id)]);

// Every vehicle with its owner, for the "which car?" pickers.
function vehicleOptions(db) {
  return db.all(
    `SELECT v.*, c.name AS customer_name FROM vehicles v
     JOIN customers c ON c.id = v.customer_id
     ORDER BY lower(v.rego), lower(c.name)`
  );
}

function customerOptions(db) {
  return db.all('SELECT id, name, phone FROM customers ORDER BY lower(name)');
}

// A form names a vehicle, a customer, or both; the vehicle decides the customer.
// Lookups go through row-level security, so ids from another workshop resolve to nothing.
async function resolveParty(db, body) {
  const vehicleId = parseIntOrNull(body.vehicle_id);
  if (vehicleId) {
    const v = await getVehicle(db, vehicleId);
    if (v) return { customer_id: v.customer_id, vehicle_id: v.id };
  }
  const customerId = parseIntOrNull(body.customer_id);
  if (customerId && (await getCustomer(db, customerId))) return { customer_id: customerId, vehicle_id: null };
  return null;
}

// Staff of this workshop who can be put on a job.
function mechanics(store, workshopId) {
  return store.system.all('SELECT id, name FROM users WHERE workshop_id = $1 AND active ORDER BY lower(name)', [workshopId]);
}

module.exports = { getCustomer, getVehicle, vehicleOptions, customerOptions, resolveParty, mechanics };
