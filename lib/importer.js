const { parseDollars, parseIntOrNull, roundCents, now } = require('./util');
const { insertVehicle } = require('./records');
const { isBlank } = require('./sheets');

// Moving a workshop's customers, vehicles and parts across from the software
// they used before. Each system exports spreadsheets with its own column
// names; the fields below list the names we know, and the presets add each
// system's own so its files are recognised and mapped without any fiddling.
// Anything else is mapped by hand on the column step.

// Header text compared without case, spaces or punctuation: "PH. NUMB" -> "phnumb".
const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const VEHICLE_FIELDS = [
  { key: 'rego', label: 'Rego', aliases: ['rego', 'registration', 'numberplate', 'registrationno', 'registrationnumber', 'regono', 'regonumber', 'plate', 'plateno', 'platenumber', 'licenceplate', 'licenseplate', 'vehiclerego'] },
  { key: 'make', label: 'Make', aliases: ['make', 'vehiclemake', 'manufacturer'] },
  { key: 'model', label: 'Model', aliases: ['model', 'vehiclemodel', 'modelname'] },
  { key: 'year', label: 'Year', aliases: ['year', 'yr', 'modelyear', 'yearofmanufacture', 'buildyear', 'yearmade'] },
  { key: 'build_date', label: 'Build date (for the year)', aliases: ['builddate', 'proddate', 'productiondate', 'compliancedate', 'firstregdate'] },
  { key: 'vin', label: 'VIN', aliases: ['vin', 'vinnumber', 'vinno', 'chassis', 'chassisnumber', 'chassisno'] },
  { key: 'colour', label: 'Colour', aliases: ['colour', 'color', 'vehiclecolour'] },
  { key: 'odometer', label: 'Odometer', aliases: ['odometer', 'odo', 'odometerreading', 'kms', 'km', 'mileage', 'lastodometer'] },
  { key: 'rego_due', label: 'Rego due', aliases: ['regodue', 'regoduedate', 'registrationduedate', 'registrationdue', 'regoexpiry', 'registrationexpiry', 'platerenewaldate', 'regorenewal'] },
  { key: 'next_service_date', label: 'Next service date', aliases: ['nextservice', 'nextservicedate', 'nextservicedue', 'servicedue', 'serviceduedate', 'serviceexpiry'] },
  { key: 'last_service_date', label: 'Last service date', aliases: ['lastservice', 'lastservicedate', 'lastindate', 'lastvisit'] },
];

const KINDS = {
  // One row per customer, or per customer and car. Vehicle columns are optional.
  customers: {
    label: 'Customers',
    fields: [
      { key: 'ref', label: 'Customer ID in the old system', hint: 'Links vehicles in a separate file to their owner', aliases: ['importedid', 'customerid', 'customerno', 'customernumber', 'customercode', 'clientid', 'clientno', 'accountno', 'accountnumber', 'cardid', 'id', 'uuid'] },
      { key: 'name', label: 'Full name', aliases: ['name', 'customername', 'fullname', 'displayname', 'customer', 'clientname', 'client', 'contactname'] },
      { key: 'first_name', label: 'First name', aliases: ['firstname', 'first', 'givenname', 'forename', 'contact1first'] },
      { key: 'last_name', label: 'Last name', aliases: ['lastname', 'last', 'surname', 'familyname', 'contact1last'] },
      { key: 'company', label: 'Company name', aliases: ['companyname', 'company', 'businessname', 'business', 'tradingname', 'organisation', 'organization'] },
      { key: 'kind', label: 'Individual or company', hint: 'I or C, or the words', aliases: ['customertype', 'type', 'kind', 'individualorcompany'] },
      { key: 'mobile', label: 'Mobile', aliases: ['mobile', 'mobilenumber', 'mobilephone', 'mobileno', 'mob', 'cell', 'cellphone', 'contact1phone'] },
      { key: 'phone', label: 'Phone', aliases: ['phone', 'phonenumber', 'phnumb', 'phno', 'telephone', 'tel', 'homephone', 'workphone', 'businessphone', 'landline', 'ph'] },
      { key: 'email', label: 'Email', aliases: ['email', 'emailaddress', 'contact1email', 'emailaddr'] },
      { key: 'address', label: 'Street address', aliases: ['address', 'address1', 'addressline1', 'street', 'streetaddress', 'billingaddress', 'postaladdress', 'postaladdressline1'] },
      { key: 'address2', label: 'Address line 2', aliases: ['address2', 'addressline2', 'postaladdressline2'] },
      { key: 'suburb', label: 'Suburb', aliases: ['suburb', 'city', 'town', 'locality', 'postalsuburb'] },
      { key: 'state', label: 'State', aliases: ['state', 'postalstate'] },
      { key: 'postcode', label: 'Postcode', aliases: ['postcode', 'postalcode', 'pcode', 'zip', 'zipcode', 'postalpostcode'] },
      { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comments', 'comment', 'customernotes'] },
      ...VEHICLE_FIELDS.map((f) => ({ ...f, vehicle: true })),
    ],
  },
  // A separate vehicles file, linked to the customers file by the old customer ID.
  vehicles: {
    label: 'Vehicles',
    fields: [
      { key: 'ref', label: 'Owner\'s customer ID', hint: 'The same ID as in the customers file', aliases: ['importedcustomerid', 'customerid', 'customerno', 'customernumber', 'customercode', 'clientid', 'ownerid', 'accountno', 'customeruuid'] },
      ...VEHICLE_FIELDS,
      { key: 'notes', label: 'Vehicle notes', aliases: ['notes', 'note', 'comments', 'comment', 'vehiclenotes'] },
    ],
  },
  parts: {
    label: 'Parts and stock',
    fields: [
      { key: 'code', label: 'Part number', aliases: ['itemcode', 'partnumber', 'partno', 'stocknumber', 'stockno', 'stockcode', 'code', 'part', 'itemno', 'itemnumber', 'sku', 'productcode', 'partcode'] },
      { key: 'description', label: 'Description', aliases: ['description', 'desc', 'itemdescription', 'partdescription', 'productname', 'itemname', 'name', 'product', 'item'] },
      { key: 'brand', label: 'Brand', aliases: ['brand', 'manufacturer', 'make'] },
      { key: 'supplier', label: 'Supplier name', aliases: ['supplier', 'suppliername', 'vendor', 'vendorname', 'preferredsupplier'] },
      { key: 'kind', label: 'Product type', hint: 'Workshop Software codes: S stock, J labour, A sublet', aliases: ['producttype', 'itemtype', 'type'] },
      { key: 'qty', label: 'Quantity on hand', aliases: ['qtyonhand', 'quantityonhand', 'onhand', 'soh', 'stockonhand', 'qoh', 'instock', 'stockqty', 'stocklevel', 'quantity', 'qty', 'stock'] },
      { key: 'reorder', label: 'Reorder level', aliases: ['minimum', 'min', 'minqty', 'minstock', 'minimumstock', 'reorderlevel', 'reorderpoint', 'reorder'] },
      { key: 'cost', label: 'Cost price', aliases: ['costexcludingtax', 'costex', 'costexgst', 'cost', 'costprice', 'buy', 'buyprice', 'trade', 'tradeprice', 'nett', 'net', 'unitcost', 'averagecost', 'avgcost', 'lastcost'] },
      { key: 'sell', label: 'Sell price', aliases: ['retailpriceex', 'retailprice', 'retail', 'sellprice', 'sell', 'sellex', 'sellexgst', 'rrp', 'listprice', 'list', 'price', 'unitprice', 'price1'] },
      { key: 'gst_free', label: 'GST free', hint: 'Yes/No or Y/N', aliases: ['gstfree', 'taxfree', 'gstexempt', 'nogst'] },
    ],
  },
};

// The software workshops are moving from. `signature` is the column names that
// give each export away; `aliases` maps that system's own names onto our fields
// first, before the general names above.
const SOURCES = {
  mechanicdesk: {
    name: 'MechanicDesk',
    howto: 'In MechanicDesk go to Settings, then Data Export. Tick Customers, Vehicles and Inventory, choose Excel, enter your password and press Export. Download the files when they\'re ready.',
    sellIncGst: true,
    // MechanicDesk doesn't publish its export layout; stock exports carry a UUID and a stock number.
    signature: {
      customers: ['uuid', 'firstname', 'lastname', 'mobile', 'phone', 'email', 'suburb', 'postcode'],
      vehicles: ['uuid', 'customeruuid', 'registration', 'make', 'model', 'vin'],
      parts: ['uuid', 'stocknumber', 'description', 'quantity', 'costprice', 'sellprice'],
    },
    aliases: { customers: { ref: ['uuid'] }, vehicles: { ref: ['customeruuid', 'customer'] } },
  },
  workshopsoftware: {
    name: 'Workshop Software',
    howto: 'In Workshop Software open Actions, then Export. Export Customers, Vehicles and Products one at a time with the green button.',
    sellIncGst: true,
    signature: {
      customers: ['importedid', 'firstname', 'lastname', 'companyname', 'customertype', 'address1', 'phnumb', 'mobile', 'cashoraccount', 'customersource', 'preferredcontactmethod', 'postalsuburb'],
      vehicles: ['importedcustomerid', 'numberplate', 'modelcode', 'modelseries', 'vinnumber', 'registrationduedate', 'lastindate', 'fleetcode', 'registeredvehiclestate'],
      parts: ['itemcode', 'importedvendorid', 'description2', 'producttype', 'qtyonhand', 'dontupdqty', 'retailprice', 'price2', 'costexcludingtax', 'gstfree', 'productgroupname', 'jobcardcomment'],
    },
    aliases: { customers: { phone: ['phnumb'] } },
  },
  auxo: {
    name: 'Auxo Workshop',
    howto: 'Ask Auxo support for an export of your customers, vehicles and parts, or use the files you prepared with Auxo\'s data conversion templates.',
    sellIncGst: false,
    signature: {
      customers: ['customertype', 'customerid', 'firstname', 'lastname', 'companyname', 'mobilenumber', 'phonenumber', 'emailaddress', 'billingaddress', 'deliveryaddress', 'externalguid', 'taxnumber'],
      vehicles: ['customerid', 'registration', 'variant', 'classtype', 'vinnumber', 'chassisnumber', 'unitsodo', 'hubometer', 'serviceexpiry', 'wofexpiry'],
      parts: ['partnumber', 'category', 'barcode', 'supplierid', 'retailpriceex', 'costex', 'quantityonhand', 'binlocation', 'unitofmeasure', 'supplierpartno'],
    },
    aliases: {},
  },
  other: {
    name: 'Something else',
    howto: 'Most systems (Megabus Marlin, MYOB, Protractor and others) can save their customer list and stock list from a report as Excel or CSV. Any spreadsheet works as long as the first row names the columns.',
    sellIncGst: false,
    signature: {},
    aliases: {},
  },
};

// Which system a sheet came from, judged by how many of its column names it shares.
function detectSource(headers, kind) {
  const have = new Set(headers.map(norm));
  let best = null;
  let bestScore = 0;
  for (const [key, s] of Object.entries(SOURCES)) {
    const sig = (s.signature && s.signature[kind]) || [];
    const score = sig.filter((h) => have.has(h)).length;
    // MechanicDesk's names are common ones, so it needs its UUID column to count.
    if (key === 'mechanicdesk' && !have.has('uuid') && !have.has('customeruuid')) continue;
    if (score >= 4 && score > bestScore) { best = key; bestScore = score; }
  }
  return best || 'other';
}

// How well a row reads as the column names of this kind of file.
function headerScore(row, kind) {
  const names = new Set(KINDS[kind].fields.flatMap((f) => f.aliases));
  return row.filter((h) => names.has(norm(h))).length;
}

// Reports often put a title or date above the column names; take the likeliest row from the top ten.
function headerRow(rows, kind) {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const s = headerScore(rows[i], kind);
    if (s > bestScore) { best = i; bestScore = s; }
  }
  return best;
}

// The sheet of a workbook that best fits a kind of file (MechanicDesk can put everything in one workbook).
function pickSheet(sheets, kind) {
  let best = 0;
  let bestScore = -1;
  sheets.forEach((s, i) => {
    const nameHint = new RegExp({ customers: 'customer|client|contact', vehicles: 'vehicle|car|fleet', parts: 'stock|inventory|product|part|item' }[kind], 'i').test(s.name) ? 3 : 0;
    const score = nameHint + Math.max(0, ...s.rows.slice(0, 10).map((r) => headerScore(r, kind)));
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

// Column index for each field, from the source's own names first, then the general ones.
function autoMap(headers, kind, source) {
  const cols = headers.map(norm);
  const used = new Set();
  const map = {};
  const extra = (SOURCES[source] && SOURCES[source].aliases[kind]) || {};
  for (const f of KINDS[kind].fields) {
    for (const alias of [...(extra[f.key] || []), ...f.aliases]) {
      const i = cols.findIndex((c, idx) => c === alias && !used.has(idx));
      if (i >= 0) { map[f.key] = i; used.add(i); break; }
    }
  }
  return map;
}

// A mapped sheet: header row found, columns assigned (or taken from the form).
function prepare(sheet, kind, source, posted) {
  const h = headerRow(sheet.rows, kind);
  const headers = sheet.rows[h] || [];
  let map;
  if (posted) {
    map = {};
    for (const f of KINDS[kind].fields) {
      const i = parseIntOrNull(posted[f.key]);
      if (i !== null && i >= 0 && i < headers.length) map[f.key] = i;
    }
  } else {
    map = autoMap(headers, kind, source);
  }
  const rows = sheet.rows.slice(h + 1);
  return { headers, headerIndex: h, map, rows, count: rows.filter((r) => !isBlank(r)).length, firstLine: h + 2 };
}

// ---- Cleaning values ----

const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Australian dates in whatever shape an export uses: 2026-10-22, 22/10/2026, 22-10-26, 22 Oct 2026.
function parseDate(v) {
  const s = String(v || '').trim();
  if (!s) return { value: null };
  let y;
  let m;
  let d;
  let match;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) [, y, m, d] = match.map(Number);
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(s))) [, d, m, y] = match.map(Number);
  else if ((match = /^(\d{1,2})[\s-]+([a-z]{3,9})[\s-]+(\d{2,4})\b/i.exec(s)) && MONTHS[match[2].slice(0, 3).toLowerCase()]) {
    [d, m, y] = [Number(match[1]), MONTHS[match[2].slice(0, 3).toLowerCase()], Number(match[3])];
  } else if (/^\d{5}$/.test(s)) {
    // An Excel day number that lost its date format on the way to CSV.
    return { value: new Date(Math.round((Number(s) - 25569) * 86400000)).toISOString().slice(0, 10) };
  } else return { value: null, bad: true };
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || y < 1900 || y > 2200) return { value: null, bad: true };
  return { value: date.toISOString().slice(0, 10) };
}

// Excel drops the leading 0 from Australian numbers: 412345678 -> 0412 345 678.
function cleanPhone(v) {
  let s = String(v || '').trim();
  if (/^[2-478]\d{8}$/.test(s.replace(/\s/g, ''))) s = '0' + s.replace(/\s/g, '');
  return s.slice(0, 50);
}

// Phone numbers compared on their last nine digits, so +61 412... and 0412... match.
const phoneKey = (v) => {
  const digits = String(v || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-9) : '';
};
const emailKey = (v) => String(v || '').trim().toLowerCase();
const regoKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const yes = (v) => /^(y|yes|true|1|x|t)$/i.test(String(v || '').trim());

function vehicleFromRow(get, warn) {
  const date = (k) => {
    const r = parseDate(get(k));
    if (r.bad) warn(`${get(k)} isn't a date we can read, so ${k.replace(/_/g, ' ')} was left blank`);
    return r.value;
  };
  let year = clip(get('year'), 10);
  if (!/^\d{4}$/.test(year)) {
    const m = /\b(19|20)\d{2}\b/.exec(get('year') || get('build_date'));
    year = m ? m[0] : year;
  }
  const odo = parseIntOrNull(String(get('odometer') || '').replace(/km$/i, ''));
  return {
    rego: clip(get('rego'), 20).toUpperCase(),
    make: clip(get('make'), 60),
    model: clip(get('model'), 60),
    year,
    vin: clip(get('vin'), 40).toUpperCase(),
    colour: clip(get('colour'), 40),
    odometer: odo !== null && odo >= 0 ? odo : null,
    rego_due: date('rego_due'),
    next_service_date: date('next_service_date'),
    last_service_date: date('last_service_date'),
    next_service_km: null,
    service_interval_months: 0,
    service_interval_km: 0,
    notes: clip(get('notes'), 5000),
  };
}

const hasVehicle = (v) => Boolean(v.rego || v.vin || v.make || v.model);
const vehicleLabel = (v) => [v.rego, [v.year, v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');

function customerFromRow(get, warn) {
  const person = clip(get('name'), 200) || [get('first_name'), get('last_name')].map((s) => clip(s, 100)).filter(Boolean).join(' ');
  const company = clip(get('company'), 200);
  const type = String(get('kind') || '').trim().toLowerCase();
  // An explicit type wins; otherwise a company name with no person's name is a company.
  const isCompany = /^(c|company|business|fleet|commercial)$/.test(type) || (!/^(i|individual|person|private)$/.test(type) && Boolean(company) && !person);
  const notes = [];
  let mobile = cleanPhone(get('mobile'));
  let phone = cleanPhone(get('phone'));
  if (!mobile) { mobile = phone; phone = ''; }
  if (phone && phoneKey(phone) !== phoneKey(mobile)) notes.push(`Other phone: ${phone}`);
  if (isCompany && person && person !== company) notes.push(`Contact: ${person}`);
  let email = clip(get('email'), 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    warn(`${email} isn't an email address, so it went into the notes`);
    notes.push(`Email from old system: ${email}`);
    email = '';
  }
  const street = [get('address'), get('address2')].map((s) => clip(s, 200)).filter(Boolean).join(', ');
  const place = [get('suburb'), get('state'), get('postcode')].map((s) => clip(s, 60)).filter(Boolean).join(' ');
  const old = clip(get('notes'), 4000);
  return {
    name: (isCompany ? company : person) || company || person,
    kind: isCompany ? 'company' : 'individual',
    phone: mobile,
    email,
    address: [street, place].filter(Boolean).join(', ').slice(0, 500),
    notes: [old, ...notes].filter(Boolean).join('\n').slice(0, 5000),
  };
}

// ---- Customers and vehicles ----

// What's already in the workshop, for spotting duplicates.
async function existingCustomers(db) {
  const customers = await db.all('SELECT id, name, phone, email, address, notes FROM customers');
  const vehicles = await db.all('SELECT v.id, v.rego, v.customer_id FROM vehicles v');
  const idx = { byId: new Map(), byPhone: new Map(), byEmail: new Map(), byName: new Map(), byRego: new Map() };
  for (const c of customers) {
    idx.byId.set(c.id, c);
    if (phoneKey(c.phone)) idx.byPhone.set(phoneKey(c.phone), c);
    if (emailKey(c.email)) idx.byEmail.set(emailKey(c.email), c);
    idx.byName.set(c.name.trim().toLowerCase(), c);
  }
  for (const v of vehicles) if (regoKey(v.rego)) idx.byRego.set(regoKey(v.rego), v);
  return idx;
}

// Works out what an import would do, without changing anything. Used for the
// preview and again, from the same files, when the workshop presses Import.
function planCustomers(customersSheet, vehiclesSheet, existing) {
  const rows = [];
  const groups = [];
  const byRef = new Map();
  const byPhone = new Map();
  const byEmail = new Map();
  const seenRego = new Map();
  const counts = { customers: 0, matched: 0, vehicles: 0, skipped: 0, errors: 0, warnings: 0 };

  function addVehicle(group, v, line, out) {
    if (!hasVehicle(v)) return;
    const key = regoKey(v.rego);
    if (key && seenRego.has(key)) {
      out.warnings.push(`Rego ${v.rego} is also on line ${seenRego.get(key)}, so this car was skipped`);
      return;
    }
    if (key) seenRego.set(key, line);
    const onFile = key && existing.byRego.get(key);
    if (onFile) {
      if (onFile.customer_id === group.existingId) out.note = [out.note, `${v.rego} is already on file for them`].filter(Boolean).join('. ');
      else {
        const owner = existing.byId.get(onFile.customer_id);
        out.warnings.push(`Rego ${v.rego} is already on file${owner ? ` for ${owner.name}` : ''}, so it was left there`);
      }
      return;
    }
    group.vehicles.push({ line, v });
    out.vehicle = vehicleLabel(v);
    counts.vehicles++;
  }

  const c = customersSheet;
  c.rows.forEach((r, i) => {
    if (isBlank(r)) return;
    const line = c.firstLine + i;
    const get = (k) => (c.map[k] === undefined ? '' : r[c.map[k]] ?? '');
    const out = { line, status: 'new', name: '', phone: '', email: '', vehicle: '', note: '', warnings: [] };
    const warn = (m) => out.warnings.push(m);
    const cust = customerFromRow(get, warn);
    const vehicle = vehicleFromRow(get, warn);
    Object.assign(out, { name: cust.name, phone: cust.phone, email: cust.email });
    const ref = clip(get('ref'), 100);

    // The same customer again: a flat export repeats them once per car.
    let group = (ref && byRef.get(ref)) || (phoneKey(cust.phone) && byPhone.get(phoneKey(cust.phone))) || (emailKey(cust.email) && byEmail.get(emailKey(cust.email)));
    if (group) {
      out.status = 'same';
      out.note = `Same customer as line ${group.line}`;
      if (ref && !byRef.has(ref)) byRef.set(ref, group);
    } else {
      if (!cust.name && !cust.phone && !cust.email) {
        if (!hasVehicle(vehicle) && !ref) return; // a blank or subtotal row
        out.status = 'error';
        out.note = 'No name, phone or email';
        counts.errors++;
        rows.push(out);
        return;
      }
      if (!cust.name) cust.name = cust.phone || cust.email;
      const match =
        (phoneKey(cust.phone) && existing.byPhone.get(phoneKey(cust.phone)) && ['phone', existing.byPhone.get(phoneKey(cust.phone))]) ||
        (emailKey(cust.email) && existing.byEmail.get(emailKey(cust.email)) && ['email', existing.byEmail.get(emailKey(cust.email))]) ||
        (regoKey(vehicle.rego) && existing.byRego.get(regoKey(vehicle.rego)) && ['rego', existing.byId.get(existing.byRego.get(regoKey(vehicle.rego)).customer_id)]) ||
        (!cust.phone && !cust.email && existing.byName.get(cust.name.toLowerCase()) && ['name', existing.byName.get(cust.name.toLowerCase())]);
      group = { line, customer: cust, existingId: match ? match[1].id : null, vehicles: [] };
      groups.push(group);
      if (match) {
        out.status = 'existing';
        out.note = `Already a customer: ${match[1].name} (same ${match[0]})`;
        counts.matched++;
      } else counts.customers++;
      if (ref) byRef.set(ref, group);
      if (phoneKey(cust.phone)) byPhone.set(phoneKey(cust.phone), group);
      if (emailKey(cust.email)) byEmail.set(emailKey(cust.email), group);
    }
    addVehicle(group, vehicle, line, out);
    if (out.status === 'same' && !out.vehicle) {
      out.status = 'skip';
      counts.skipped++;
    }
    rows.push(out);
  });

  if (vehiclesSheet) {
    const v = vehiclesSheet;
    v.rows.forEach((r, i) => {
      if (isBlank(r)) return;
      const line = v.firstLine + i;
      const get = (k) => (v.map[k] === undefined ? '' : r[v.map[k]] ?? '');
      const out = { line, file: 'vehicles', status: 'vehicle', name: '', phone: '', email: '', vehicle: '', note: '', warnings: [] };
      const vehicle = vehicleFromRow(get, (m) => out.warnings.push(m));
      if (!hasVehicle(vehicle)) return;
      const ref = clip(get('ref'), 100);
      const group = ref && byRef.get(ref);
      out.vehicle = vehicleLabel(vehicle);
      if (!group) {
        out.status = 'error';
        out.note = ref ? `No customer with ID ${ref} in the customers file` : 'No customer ID to link this car to';
        counts.errors++;
      } else {
        out.name = group.customer.name;
        const before = group.vehicles.length;
        addVehicle(group, vehicle, line, out);
        if (group.vehicles.length > before) out.note = `Goes to line ${group.line} of the customers file`;
        else {
          out.status = 'skip';
          counts.skipped++;
        }
      }
      rows.push(out);
    });
  }

  counts.warnings = rows.filter((r) => r.warnings.length).length;
  return { groups, rows, counts };
}

// Saves a customer plan. Matching customers keep what they have; only their blank details are filled in.
async function applyCustomers(db, plan, { tag = '', tz } = {}) {
  let customers = 0;
  let vehicles = 0;
  let updated = 0;
  for (const g of plan.groups) {
    let id = g.existingId;
    const c = g.customer;
    if (id) {
      const r = await db.run(
        `UPDATE customers SET
           phone = CASE WHEN phone = '' THEN $1 ELSE phone END,
           email = CASE WHEN email = '' THEN $2 ELSE email END,
           address = CASE WHEN address = '' THEN $3 ELSE address END
         WHERE id = $4 AND ((phone = '' AND $1 != '') OR (email = '' AND $2 != '') OR (address = '' AND $3 != ''))`,
        [c.phone, c.email, c.address, id]
      );
      updated += r.rowCount;
    } else {
      const row = await db.get(
        `INSERT INTO customers (name, phone, email, address, notes, kind, tags, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [c.name, c.phone, c.email, c.address, c.notes, c.kind, tag, now(tz)]
      );
      id = row.id;
      customers++;
    }
    for (const { v } of g.vehicles) {
      const row = await insertVehicle(db, id, v, tz);
      if (v.last_service_date) await db.run('UPDATE vehicles SET last_service_date = $1 WHERE id = $2', [v.last_service_date, row.id]);
      vehicles++;
    }
  }
  return { customers, vehicles, updated };
}

// ---- Parts and stock ----

// Adds a part to the price list, or updates the one given. Fields left undefined keep what's there.
// Shared with the supplier price file import.
async function savePart(db, part, existingId) {
  if (existingId) {
    await db.run(
      `UPDATE price_items SET
         description = COALESCE($1, description), cost_cents = COALESCE($2, cost_cents), unit_cents = COALESCE($3, unit_cents),
         stock_qty = COALESCE($4, stock_qty), reorder_level = COALESCE($5, reorder_level), supplier_id = COALESCE($6, supplier_id),
         gst = COALESCE($7, gst), code = CASE WHEN code = '' THEN COALESCE($8, '') ELSE code END
       WHERE id = $9`,
      [part.description ?? null, part.cost_cents ?? null, part.sell_cents ?? null, part.stock_qty ?? null, part.reorder_level ?? null,
        part.supplier_id ?? null, part.gst ?? null, part.code || null, existingId]
    );
    return existingId;
  }
  const row = await db.get(
    `INSERT INTO price_items (kind, code, description, unit_cents, cost_cents, supplier_id, stock_qty, reorder_level, gst)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [part.kind || 'part', part.code || '', part.description, part.sell_cents || 0, part.cost_cents || 0, part.supplier_id || null,
      part.stock_qty || 0, part.reorder_level || 0, part.gst ?? true]
  );
  return row.id;
}

async function existingParts(db) {
  const items = await db.all('SELECT id, kind, code, description FROM price_items');
  const suppliers = await db.all('SELECT id, name FROM suppliers');
  const idx = { byCode: new Map(), byDesc: new Map(), suppliers: new Map() };
  for (const i of items) {
    if (i.code) idx.byCode.set(i.code.toUpperCase(), i);
    idx.byDesc.set(i.description.trim().toLowerCase(), i);
  }
  for (const s of suppliers) idx.suppliers.set(s.name.trim().toLowerCase(), s);
  return idx;
}

const KIND_CODES = { j: 'labour', labour: 'labour', labor: 'labour', a: 'other', sublet: 'other', w: 'other' };

function planParts(sheet, existing, { sellIncGst = false, costIncGst = false, markup = 0, setStock = true } = {}) {
  const rows = [];
  const parts = [];
  const seen = new Map();
  const counts = { added: 0, updated: 0, skipped: 0, errors: 0, warnings: 0, suppliers: 0 };
  const newSuppliers = new Set();
  const money = (v, inc) => {
    const s = String(v ?? '').trim();
    if (!s) return undefined;
    const cents = Math.max(parseDollars(s), 0);
    return inc ? roundCents(cents / 1.1) : cents;
  };
  sheet.rows.forEach((r, i) => {
    const line = sheet.firstLine + i;
    const get = (k) => (sheet.map[k] === undefined ? '' : r[sheet.map[k]] ?? '');
    const code = clip(get('code'), 30).toUpperCase();
    const brand = clip(get('brand'), 60);
    let description = clip(get('description'), 300);
    if (brand && description && !description.toLowerCase().includes(brand.toLowerCase())) description = `${brand} ${description}`.slice(0, 300);
    const out = { line, status: 'new', code, description: description || code, warnings: [], note: '' };
    if (!description && !code) return;
    if (!description) out.warnings.push('No description, so the part number is used');
    const key = code || description.toLowerCase();
    if (seen.has(key)) {
      out.status = 'skip';
      out.note = `Same part as line ${seen.get(key)}`;
      counts.skipped++;
      rows.push(out);
      return;
    }
    seen.set(key, line);

    const cost = money(get('cost'), costIncGst);
    let sell = money(get('sell'), sellIncGst);
    if (sell === undefined && cost !== undefined && markup > 0) sell = roundCents(cost * (1 + markup / 100));
    const qtyText = String(get('qty') ?? '').trim();
    let qty = qtyText ? parseFloat(qtyText.replace(/,/g, '')) : undefined;
    if (qty !== undefined && !Number.isFinite(qty)) { out.warnings.push(`Quantity "${qtyText}" isn't a number`); qty = undefined; }
    if (qty !== undefined && qty < 0) { out.warnings.push(`Stock was ${qty}, so it starts at 0`); qty = 0; }
    const reorderText = String(get('reorder') ?? '').trim();
    const reorder = reorderText && Number.isFinite(parseFloat(reorderText)) ? Math.max(parseFloat(reorderText), 0) : undefined;
    const supplierName = clip(get('supplier'), 200);
    const gstText = String(get('gst_free') ?? '').trim();
    const kind = KIND_CODES[String(get('kind') || '').trim().toLowerCase()] || 'part';

    const match = (code && existing.byCode.get(code)) || (description && existing.byDesc.get(description.toLowerCase()));
    if (match) {
      out.status = 'update';
      out.note = `Updates ${match.code ? match.code + ' ' : ''}${match.description}`;
      counts.updated++;
    } else counts.added++;
    if (supplierName && !existing.suppliers.has(supplierName.toLowerCase()) && !newSuppliers.has(supplierName.toLowerCase())) {
      newSuppliers.add(supplierName.toLowerCase());
      counts.suppliers++;
      out.warnings.push(`New supplier ${supplierName} will be added`);
    }
    Object.assign(out, { cost_cents: cost, sell_cents: sell, qty, supplier: supplierName });
    parts.push({
      line,
      existingId: match ? match.id : null,
      supplierName,
      part: {
        kind,
        code,
        description: description || code,
        cost_cents: cost,
        sell_cents: sell,
        stock_qty: setStock && kind === 'part' ? qty : undefined,
        reorder_level: reorder,
        gst: gstText ? !yes(gstText) : undefined,
      },
    });
    rows.push(out);
  });
  counts.warnings = rows.filter((r) => r.warnings.length).length;
  return { parts, rows, counts };
}

async function applyParts(db, plan, existing) {
  let added = 0;
  let updated = 0;
  let suppliers = 0;
  const supplierIds = new Map([...existing.suppliers].map(([k, s]) => [k, s.id]));
  for (const p of plan.parts) {
    if (p.supplierName) {
      const k = p.supplierName.toLowerCase();
      if (!supplierIds.has(k)) {
        const s = await db.get('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [p.supplierName]);
        supplierIds.set(k, s.id);
        suppliers++;
      }
      p.part.supplier_id = supplierIds.get(k);
    }
    await savePart(db, p.part, p.existingId);
    if (p.existingId) updated++;
    else added++;
  }
  return { added, updated, suppliers };
}

module.exports = {
  KINDS, SOURCES, norm, detectSource, headerRow, pickSheet, autoMap, prepare,
  parseDate, cleanPhone, phoneKey, regoKey,
  existingCustomers, planCustomers, applyCustomers,
  existingParts, planParts, applyParts, savePart,
};
