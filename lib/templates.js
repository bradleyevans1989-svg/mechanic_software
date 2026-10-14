// Print designs for invoices/quotes and job cards. Each workshop picks one of each in Settings.
// The markup is the same for every design; the design is a body class styled in public/print.css.

const INVOICE_TEMPLATES = {
  classic: { name: 'Classic', blurb: 'Black rule under the header, plain and tidy. Works with or without a logo.' },
  band: { name: 'Colour band', blurb: 'A solid band in your brand colour across the top, white business name on it.' },
  minimal: { name: 'Minimal', blurb: 'Lots of white space, light grey labels, hairline rules. Quiet and modern.' },
  modern: { name: 'Modern', blurb: 'Brand-colour stripe down the left and a big total box the customer cannot miss.' },
  boxed: { name: 'Boxed', blurb: 'Every section in its own bordered box. Easy to scan on a busy counter.' },
  compact: { name: 'Compact', blurb: 'Smaller type and tighter rows, so long invoices fit on one page.' },
  letterhead: { name: 'Letterhead', blurb: 'Centred logo and business details up top like printed stationery, serif type.' },
  ledger: { name: 'Ledger', blurb: 'Ruled rows, tabular figures and a stamped title. Old-school bookkeeping feel.' },
  contrast: { name: 'Contrast', blurb: 'Dark title block on the right in your brand colour, bold totals.' },
  workshop: { name: 'Workshop', blurb: 'Heavy black bars and condensed capitals. Looks at home on a tool chest.' },
};

const JOBCARD_TEMPLATES = {
  classic: { name: 'Classic', blurb: 'Customer and vehicle up top, work requested, parts, inspection and notes.' },
  floor: { name: 'Floor copy', blurb: 'Large print and a big job number you can read from across the bay.' },
  split: { name: 'Split', blurb: 'Customer and vehicle down the left, work and notes on the right.' },
  checklist: { name: 'Checklist', blurb: 'Tick boxes beside every line and inspection item, with room for a note.' },
  compact: { name: 'Compact', blurb: 'Tight rows and small type, for jobs with long parts lists.' },
  boxed: { name: 'Boxed', blurb: 'Bordered sections and a sign-off grid for mechanic, time and date.' },
  timecard: { name: 'Time card', blurb: 'Adds a clock-on and clock-off grid for each mechanic who touches the job.' },
  notes: { name: 'Notes first', blurb: 'A large ruled notes area for diagnosis, with the work list underneath.' },
  band: { name: 'Colour band', blurb: 'Brand-colour header band matching the Colour band invoice.' },
  inspection: { name: 'Inspection first', blurb: 'The inspection checklist at the top of the page, work and parts below.' },
};

function pick(table, key) {
  return table[key] ? key : 'classic';
}

// Sample data for the previews in Settings.
function sampleDocument(today) {
  const lines = [
    { description: 'Logbook service 100,000 km', kind: 'labour', qty: 2.5, unit_cents: 12000, gst: true },
    { description: 'Engine oil 5W-30 full synthetic 6L', kind: 'part', qty: 1, unit_cents: 6800, gst: true },
    { description: 'Oil filter', kind: 'part', qty: 1, unit_cents: 2200, gst: true },
    { description: 'Air filter', kind: 'part', qty: 1, unit_cents: 3900, gst: true },
    { description: 'Front brake pads, ceramic', kind: 'part', qty: 1, unit_cents: 11500, gst: true },
    { description: 'Fit front brake pads and machine rotors', kind: 'labour', qty: 1.5, unit_cents: 12000, gst: true },
    { description: 'Environmental levy', kind: 'other', qty: 1, unit_cents: 500, gst: false },
  ];
  const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * l.unit_cents), 0);
  const gst = lines.reduce((s, l) => s + (l.gst ? Math.round(Math.round(l.qty * l.unit_cents) / 10) : 0), 0);
  return {
    doc: { id: 0, type: 'invoice', number: 1042, status: 'issued', state: 'unpaid', issue_date: today, due_date: today, notes: 'Thanks for bringing the Ranger in. Rear pads have about 30% left; we recommend replacing them at the next service.', odometer: 102350, subtotal, gst, total: subtotal + gst, paid: 0, balance: subtotal + gst },
    lines,
    customer: { name: 'Jordan Smith', phone: '0434 567 890', email: 'jordan@example.com', address: '12 Harbour Rd\nSpringfield QLD 4000' },
    vehicle: { rego: 'JS4WD', year: 2016, make: 'Ford', model: 'Ranger', vin: 'MNAUMEF50GW123456' },
    payments: [],
  };
}

function sampleJob(today) {
  return {
    job: { id: 0, number: 1042, created_at: today, description: 'Logbook service 100,000 km. Customer reports a squeal from the front when braking at low speed. Check wiper blades.', tech_notes: '', odometer: 102350, mechanic_name: 'Mick', due_date: today, due_time: '16:00', priority: 'normal' },
    lines: [
      { description: 'Logbook service 100,000 km', qty: 2.5 },
      { description: 'Engine oil 5W-30 full synthetic 6L', qty: 1 },
      { description: 'Oil filter', qty: 1 },
      { description: 'Air filter', qty: 1 },
    ],
    checks: [
      { item: 'Under the bonnet', heading: true }, { item: 'Engine oil level and condition', result: '' }, { item: 'Coolant level', result: '' }, { item: 'Brake fluid', result: '' }, { item: 'Drive belts', result: '' },
      { item: 'Brakes and tyres', heading: true }, { item: 'Front pads', result: '' }, { item: 'Rear pads', result: '' }, { item: 'Tyre tread and pressure', result: '' },
      { item: 'Lights and wipers', heading: true }, { item: 'Headlights, indicators, brake lights', result: '' }, { item: 'Wiper blades', result: '' },
    ],
    customer: { name: 'Jordan Smith', phone: '0434 567 890', email: 'jordan@example.com', address: '12 Harbour Rd\nSpringfield QLD 4000' },
    vehicle: { rego: 'JS4WD', year: 2016, make: 'Ford', model: 'Ranger', vin: 'MNAUMEF50GW123456' },
  };
}

module.exports = { INVOICE_TEMPLATES, JOBCARD_TEMPLATES, pick, sampleDocument, sampleJob };
