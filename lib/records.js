const { parseIntOrNull } = require('./util');

const getCustomer = (db, id) => db.get('SELECT * FROM customers WHERE id = $1', [parseIntOrNull(id)]);
const getVehicle = (db, id) => db.get('SELECT * FROM vehicles WHERE id = $1', [parseIntOrNull(id)]);

// Every vehicle with its owner, for the "which car?" pickers.
function vehicleOptions(db) {
  return db.all(
    `SELECT v.*, c.name AS customer_name FROM vehicles v
     JOIN customers c ON c.id = v.customer_id
     WHERE c.archived_at IS NULL
     ORDER BY lower(v.rego), lower(c.name)`
  );
}

function customerOptions(db) {
  return db.all('SELECT id, name, phone FROM customers WHERE archived_at IS NULL ORDER BY lower(name)');
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
  return store.system.all('SELECT id, name, role FROM users WHERE workshop_id = $1 AND active ORDER BY lower(name)', [workshopId]);
}

// Something that happened on a job, for its activity log.
function logEvent(db, jobId, userId, kind, text = '') {
  return db.run('INSERT INTO job_events (job_id, user_id, kind, text) VALUES ($1, $2, $3, $4)', [jobId, userId || null, kind, String(text).slice(0, 2000)]);
}

// The inspection a workshop starts with; "# Heading" lines group the items.
const DEFAULT_CHECKLIST = `# Under the bonnet
Engine oil level and condition
Coolant level, hoses and radiator
Brake fluid
Power steering fluid
Drive belts
Battery and terminals
Air filter
# Under the car
Front brake pads and rotors
Rear brake pads and rotors
Suspension and steering
Exhaust
Oil and fluid leaks
CV boots and driveshafts
# Tyres
Front tyres: tread and pressure
Rear tyres: tread and pressure
Spare tyre
# Lights and cabin
Headlights, tail lights and indicators
Wipers and washers
Horn
Cabin filter
Dash warning lights`;

const CHECK_RESULTS = { ok: 'OK', attention: 'Needs attention', urgent: 'Urgent', na: 'N/A' };

// Turns the settings text into checklist rows.
function checklistItems(text) {
  return String(text || DEFAULT_CHECKLIST)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 200)
    .map((l) => ({ item: l.replace(/^#+\s*/, '').slice(0, 200), heading: /^#/.test(l) }));
}

module.exports = {
  getCustomer, getVehicle, vehicleOptions, customerOptions, resolveParty, mechanics,
  logEvent, DEFAULT_CHECKLIST, CHECK_RESULTS, checklistItems,
};

// Step-by-step text: "# Heading" lines group, "- " or "1. " prefixes are dropped, blank lines skipped.
function stepBlocks(text) {
  const blocks = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      current = { heading: line.replace(/^#+\s*/, ''), steps: [] };
      blocks.push(current);
      continue;
    }
    if (!current) {
      current = { heading: '', steps: [] };
      blocks.push(current);
    }
    current.steps.push(line.replace(/^(?:[-*]|\d+[.)])\s+/, ''));
  }
  return blocks;
}
module.exports.stepBlocks = stepBlocks;
