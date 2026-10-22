// Rego lookup through the provider, and the built-in VIN decoder.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { startApp } = require('./helpers');
const lookup = require('../lib/vehicle-lookup');

let t;
let a;
let b;
let fake;
const asked = [];

before(async () => {
  const f = express();
  f.get('/api/reg.asmx/CheckAustralia', (req, res) => {
    asked.push({ ...req.query });
    if (req.query.RegistrationNumber === 'NOPE1') return res.status(500).send('No data found for this registration');
    const json = JSON.stringify({
      Description: '2019 TOYOTA HILUX SR5', RegistrationYear: '2019', CarMake: { CurrentTextValue: 'TOYOTA' }, CarModel: { CurrentTextValue: 'HILUX' },
      Variant: 'SR5', Colour: 'WHITE', VechileIdentificationNumber: 'MR0FB8CD103456789', NVIC: 'ABC12',
    }).replace(/"/g, '&quot;');
    res.type('text/xml').send(`<?xml version="1.0"?><Vehicle xmlns="http://regcheck.org.uk"><vehicleJson>${json}</vehicleJson><vehicleData /></Vehicle>`);
  });
  const url = await new Promise((r) => {
    fake = f.listen(0, () => r(`http://localhost:${fake.address().port}`));
  });
  Object.assign(process.env, { REGO_PROVIDER: 'regcheck', REGCHECK_USERNAME: 'baybos', REGCHECK_API_URL: url });
  t = await startApp({ autoSync: false });
  a = await t.signup('Lookup Motors', 'lookup@example.com');
  b = await t.signup('Other Lookup', 'otherlookup@example.com');
});

after(async () => {
  for (const k of ['REGO_PROVIDER', 'REGCHECK_USERNAME', 'REGCHECK_API_URL']) delete process.env[k];
  if (t) await t.stop();
  if (fake) fake.close();
});

test('VINs decode to a maker and model year without any account', () => {
  let r = lookup.decodeVin('mr0fb8cd103456789');
  assert.equal(r.ok, true);
  assert.equal(r.vehicle.make, 'Toyota');
  assert.equal(r.vehicle.vin, 'MR0FB8CD103456789');
  r = lookup.decodeVin('1HGCM82633A004352');
  assert.equal(r.vehicle.make, 'Honda');
  assert.equal(r.vehicle.year, '2003');
  assert.equal(r.checkDigit, true);
  assert.equal(lookup.decodeVin('1HGCM82643A004352').checkDigit, false);
  assert.equal(lookup.decodeVin('6FPPXXMJ2PNM12345').vehicle.make, 'Ford');
  assert.equal(lookup.decodeVin('WVWZZZAUZLP012345').vehicle.year, '2020');
  assert.equal(lookup.decodeVin('GRX130-6012345').ok, false);
  assert.match(lookup.decodeVin('1HGCM82633AOO4352').error, /never has I, O or Q/);
  assert.equal(lookup.modelYear('A', 2026), 2010);
  assert.equal(lookup.modelYear('Y', 2026), 2000);
  assert.equal(lookup.modelYear('T', 2026), 2026);
});

test('a rego lookup fills in the car and is counted for the workshop', async () => {
  let r = JSON.parse((await a.get('/lookup/rego?rego=abc 123&state=QLD')).text);
  assert.equal(r.ok, true);
  assert.deepEqual(asked.at(-1), { RegistrationNumber: 'ABC123', State: 'QLD', username: 'baybos' });
  assert.equal(r.vehicle.make, 'TOYOTA');
  assert.equal(r.vehicle.model, 'HILUX SR5');
  assert.equal(r.vehicle.year, '2019');
  assert.equal(r.vehicle.vin, 'MR0FB8CD103456789');

  r = JSON.parse((await a.get('/lookup/rego?rego=NOPE1&state=XX')).text);
  assert.equal(r.ok, false);
  assert.match(r.error, /No NSW vehicle found with rego NOPE1/);
  assert.equal(JSON.parse((await a.get('/lookup/rego?rego=')).text).error, 'Enter the rego first.');

  const rows = await a.db.all('SELECT * FROM rego_lookups ORDER BY id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].found, true);
  assert.equal(rows[1].found, false);
  assert.equal((await b.db.all('SELECT * FROM rego_lookups')).length, 0);
  assert.match((await a.get('/integrations')).text, /This month: 2 lookups, 1 found/);

  assert.equal(JSON.parse((await a.get('/lookup/vin?vin=JM0KF4W7101234567')).text).vehicle.make, 'Mazda');
  assert.equal((await t.client().get('/lookup/rego?rego=ABC123')).status, 302, 'needs a login');
});

test('the vehicle forms have the lookup buttons', async () => {
  const page = await a.get('/customers/new');
  assert.match(page.text, /data-lookup="v_"/);
  assert.match(page.text, /Look up rego/);
  assert.match(page.text, /<option selected>NSW<\/option>/);
});
