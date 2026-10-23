// Finding a car's details from its rego or VIN.
//
// VIN decoding is built in and free: the maker from the first three characters and the
// model year from the tenth. It can't tell the model, so a rego lookup does better.
//
// Rego lookups need a paid data provider; pick it with REGO_PROVIDER:
//   regcheck  Car Registration API Australia (carregistrationapi.com.au): REGCHECK_USERNAME,
//             charged per lookup. Returns make, model, year, VIN, colour, engine and NVIC.
//   demo      test mode: made-up details, nothing leaves the server
// With none set, the Look up button is hidden. Test sites (SEED_DEMO=1) and development default to demo.

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];

// World manufacturer identifiers for the makes common in Australia.
const WMI = {
  JT: 'Toyota', MR0: 'Toyota', MR1: 'Toyota', MR2: 'Toyota', '6T1': 'Toyota', AHT: 'Toyota', '4T1': 'Toyota', '5TD': 'Toyota', '5TF': 'Toyota',
  JTH: 'Lexus', JTJ: 'Lexus',
  JM1: 'Mazda', JMZ: 'Mazda', JM0: 'Mazda', MM0: 'Mazda', MM6: 'Mazda', MM7: 'Mazda', MM8: 'Mazda',
  JMB: 'Mitsubishi', JMY: 'Mitsubishi', JA3: 'Mitsubishi', MMB: 'Mitsubishi', MMC: 'Mitsubishi', MMA: 'Mitsubishi', ML3: 'Mitsubishi', '6MM': 'Mitsubishi',
  JN1: 'Nissan', JN6: 'Nissan', JN8: 'Nissan', JNK: 'Infiniti', MNT: 'Nissan', VSK: 'Nissan', SJN: 'Nissan', '1N4': 'Nissan', '5N1': 'Nissan',
  JHM: 'Honda', JHL: 'Honda', MRH: 'Honda', SHH: 'Honda', SHS: 'Honda', '1HG': 'Honda', '2HG': 'Honda', '5FN': 'Honda', JH2: 'Honda',
  JF1: 'Subaru', JF2: 'Subaru', JF3: 'Subaru', '4S3': 'Subaru', '4S4': 'Subaru',
  JS1: 'Suzuki', JS2: 'Suzuki', JS3: 'Suzuki', JSA: 'Suzuki', MA3: 'Suzuki', TSM: 'Suzuki', MBH: 'Suzuki',
  JAL: 'Isuzu', JAA: 'Isuzu', MPA: 'Isuzu', MP1: 'Isuzu', JAC: 'Isuzu',
  KMH: 'Hyundai', KMJ: 'Hyundai', KMF: 'Hyundai', KM8: 'Hyundai', TMA: 'Hyundai', MAL: 'Hyundai', '5NP': 'Hyundai', '5NM': 'Hyundai',
  KNA: 'Kia', KNC: 'Kia', KND: 'Kia', KNE: 'Kia', KNM: 'Renault Samsung', U5Y: 'Kia', U6Y: 'Kia', '5XY': 'Kia',
  KPT: 'SsangYong', KPA: 'SsangYong', KL1: 'Daewoo', KLA: 'Daewoo', KL3: 'Holden',
  '6FP': 'Ford', '6F1': 'Ford', MNA: 'Ford', MNB: 'Ford', MNC: 'Ford', MAJ: 'Ford', WF0: 'Ford', WF1: 'Ford', '1FA': 'Ford', '1FT': 'Ford', '1FM': 'Ford', '1FD': 'Ford', '2FM': 'Ford', '3FA': 'Ford', NM0: 'Ford',
  '6G1': 'Holden', '6G2': 'Holden', '6G3': 'Holden', '6H8': 'Holden', W0L: 'Opel', W0V: 'Opel', '1G1': 'Chevrolet', '1GC': 'Chevrolet', '3GN': 'Chevrolet', '1GT': 'GMC',
  WVW: 'Volkswagen', WV1: 'Volkswagen', WV2: 'Volkswagen', WV3: 'Volkswagen', '3VW': 'Volkswagen', '9BW': 'Volkswagen', AAV: 'Volkswagen',
  WAU: 'Audi', WA1: 'Audi', TRU: 'Audi', WUA: 'Audi',
  WBA: 'BMW', WBS: 'BMW', WBX: 'BMW', WBY: 'BMW', WMW: 'Mini', WB1: 'BMW Motorrad',
  WDB: 'Mercedes-Benz', WDC: 'Mercedes-Benz', WDD: 'Mercedes-Benz', WDF: 'Mercedes-Benz', W1K: 'Mercedes-Benz', W1N: 'Mercedes-Benz', W1V: 'Mercedes-Benz', WD3: 'Mercedes-Benz', WD4: 'Mercedes-Benz',
  WP0: 'Porsche', WP1: 'Porsche', ZFF: 'Ferrari', ZAR: 'Alfa Romeo', ZFA: 'Fiat', ZFB: 'Fiat', ZFC: 'Fiat', ZHW: 'Lamborghini', ZAM: 'Maserati',
  VF1: 'Renault', VF3: 'Peugeot', VF7: 'Citroen', VF8: 'Citroen', VR3: 'Peugeot', VR1: 'DS', VSS: 'SEAT', VSE: 'Suzuki', TMB: 'Skoda', TMP: 'Skoda',
  YV1: 'Volvo', YV4: 'Volvo', YS3: 'Saab', SAL: 'Land Rover', SAJ: 'Jaguar', SCC: 'Lotus', SCB: 'Bentley', SCA: 'Rolls-Royce', SAR: 'Rover',
  '5YJ': 'Tesla', '7SA': 'Tesla', LRW: 'Tesla', XP7: 'Tesla',
  LGW: 'GWM', LGX: 'BYD', LC0: 'BYD', LSJ: 'MG', LSG: 'Chevrolet', LVV: 'Chery', LNB: 'Chery', LDC: 'Peugeot', LJ1: 'JAC', LZW: 'LDV', LSK: 'LDV', LS5: 'Changan', L6T: 'Geely',
  '1C4': 'Jeep', '1J4': 'Jeep', '1J8': 'Jeep', ZAC: 'Jeep', '1C3': 'Chrysler', '2C3': 'Chrysler', '1C6': 'Ram', '3C6': 'Ram', '1D7': 'Dodge', '3D7': 'Dodge',
  MAT: 'Tata', MA1: 'Mahindra', MAK: 'Honda', MEC: 'Mercedes-Benz', MHF: 'Toyota', MHR: 'Honda',
  JYA: 'Yamaha', JKA: 'Kawasaki', ZDM: 'Ducati', SMT: 'Triumph', '1HD': 'Harley-Davidson', VBK: 'KTM',
  NMT: 'Toyota', NM4: 'Ford', VNK: 'Toyota', SB1: 'Toyota', TW1: 'Toyota',
};

const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function cleanVin(vin) {
  return String(vin || '').toUpperCase().replace(/[\s-]/g, '');
}

// North American VINs carry a check digit in position 9; others often don't.
function checkDigitOk(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    sum += (/\d/.test(c) ? Number(c) : TRANSLIT[c]) * WEIGHTS[i];
  }
  const want = sum % 11 === 10 ? 'X' : String(sum % 11);
  return vin[8] === want;
}

// The model year from position 10: the most recent year with that code, not in the future.
function modelYear(code, thisYear = new Date().getFullYear()) {
  const i = YEAR_CODES.indexOf(code);
  if (i < 0) return null;
  let year = 1980 + i;
  while (year + 30 <= thisYear + 1) year += 30;
  return year;
}

function decodeVin(vin) {
  const v = cleanVin(vin);
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) {
    return { ok: false, error: /[IOQ]/.test(v) ? 'A VIN never has I, O or Q. Check for 1s and 0s.' : 'A VIN is 17 letters and numbers. Older Japanese imports may only have a chassis number.' };
  }
  const make = WMI[v.slice(0, 3)] || WMI[v.slice(0, 2)] || '';
  const northAmerican = /^[1-5]/.test(v);
  // The year in position 10 is reliable for North American VINs and most makers since about 2000;
  // European makers often leave it as a filler, so only trust a valid code.
  const year = modelYear(v[9]);
  return {
    ok: true,
    vehicle: { vin: v, make, year: year ? String(year) : '' },
    checkDigit: northAmerican ? checkDigitOk(v) : null,
    note: make ? '' : "The maker isn't in the built-in list.",
  };
}

function providerName() {
  const p = String(process.env.REGO_PROVIDER || '').toLowerCase();
  if (PROVIDERS[p]) return p;
  if (!p && (process.env.SEED_DEMO === '1' || process.env.NODE_ENV !== 'production')) return 'demo';
  return '';
}

const text = (v) => (v && typeof v === 'object' ? v.CurrentTextValue || v.Value || '' : v || '');

const PROVIDERS = {
  demo: {
    label: 'Test mode',
    async lookup(rego) {
      if (rego.startsWith('ZZ')) return null;
      const cars = [
        ['Toyota', 'Hilux SR5', 'White', 'MR0FB8CD'],
        ['Mazda', 'CX-5 Maxx Sport', 'Soul Red', 'JM0KF4W7'],
        ['Ford', 'Ranger XLT', 'Grey', 'MNAUMFF5'],
        ['Hyundai', 'i30 Active', 'Blue', 'KMHH351E'],
        ['Mitsubishi', 'Triton GLS', 'Silver', 'MMBJJKL1'],
      ];
      const n = [...rego].reduce((s, c) => s + c.charCodeAt(0), 0);
      const [make, model, colour, vinStart] = cars[n % cars.length];
      const year = 2012 + (n % 12);
      const vin = `${vinStart}0${YEAR_CODES[(year - 1980) % 30]}${String(1000000 + n).slice(-7)}`;
      return { make, model, year: String(year), colour, vin, description: `${year} ${make} ${model} (test mode)` };
    },
  },

  regcheck: {
    label: 'Car Registration API',
    async lookup(rego, state) {
      const url = new URL(`${process.env.REGCHECK_API_URL || 'https://www.carregistrationapi.com.au'}/api/reg.asmx/CheckAustralia`);
      url.search = new URLSearchParams({ RegistrationNumber: rego, State: state, username: process.env.REGCHECK_USERNAME || '' }).toString();
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const body = await res.text();
      // A plate it can't find comes back as a server error.
      if (res.status === 500 && /no data|not found|invalid/i.test(body)) return null;
      if (!res.ok) throw new Error(`Rego lookup failed (${res.status}).`);
      const m = body.match(/<vehicleJson>([\s\S]*?)<\/vehicleJson>/i);
      if (!m) return null;
      const json = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
      if (!json) return null;
      const d = JSON.parse(json);
      return {
        make: text(d.CarMake) || d.MakeDescription || '',
        model: [text(d.CarModel) || d.ModelDescription || '', d.Variant || ''].filter(Boolean).join(' ').trim(),
        year: String(d.RegistrationYear || ''),
        colour: d.Colour || '',
        vin: d.VechileIdentificationNumber || d.VehicleIdentificationNumber || '',
        engine: d.EngineSize ? text(d.EngineSize) : '',
        nvic: d.NVIC || '',
        description: d.Description || '',
      };
    },
  },
};

const clip = (s, n) => String(s || '').trim().slice(0, n);

// Looks up a plate; counts the lookup against the workshop so the cost can be passed on.
async function lookupRego(db, rego, state) {
  const provider = PROVIDERS[providerName()];
  if (!provider) return { ok: false, error: 'Rego lookup is not set up on this server.' };
  const plate = String(rego || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!plate) return { ok: false, error: 'Enter the rego first.' };
  const st = STATES.includes(state) ? state : 'NSW';
  let found = null;
  let error = '';
  try {
    found = await provider.lookup(plate, st);
  } catch (err) {
    error = err.name === 'TimeoutError' ? 'The rego lookup took too long. Try again.' : err.message;
  }
  await db.run('INSERT INTO rego_lookups (rego, state, provider, found, error) VALUES ($1, $2, $3, $4, $5)', [plate, st, providerName(), Boolean(found), error]);
  if (error) return { ok: false, error };
  if (!found) return { ok: false, error: `No ${st} vehicle found with rego ${plate}.` };
  return {
    ok: true,
    vehicle: {
      make: clip(found.make, 60),
      model: clip(found.model, 80),
      year: clip(found.year, 4),
      colour: clip(found.colour, 40),
      vin: clip(found.vin, 17).toUpperCase(),
      description: clip(found.description, 200),
    },
  };
}

// The state a workshop most likely registers cars in, from its timezone.
function stateFor(tz) {
  return { 'Australia/Brisbane': 'QLD', 'Australia/Adelaide': 'SA', 'Australia/Darwin': 'NT', 'Australia/Perth': 'WA', 'Australia/Hobart': 'TAS', 'Australia/Melbourne': 'VIC' }[tz] || 'NSW';
}

module.exports = {
  STATES,
  stateFor,
  decodeVin,
  modelYear,
  lookupRego,
  configured: () => Boolean(providerName()),
  isTestMode: () => providerName() === 'demo',
  providerLabel: () => (PROVIDERS[providerName()] || {}).label || '',
};
