// Workshop types. A workshop picks one at sign-up (or under Settings), and it sets
// what the app calls the things being repaired, whether they run on km or engine hours,
// the inspection checklist, the starter price list and procedures, and the public page
// that sells the app to that kind of workshop.

const PRODUCT = 'Bay Watch';

// What the screens call a vehicle, its ID numbers and its meter.
const ROAD = { asset: 'Vehicle', assets: 'Vehicles', rego: 'Rego', vin: 'VIN', meter: 'Odometer', unit: 'km', arrived: "Car's here: start job" };

const CAR_MAKES = ['Toyota', 'Ford', 'Mazda', 'Hyundai', 'Mitsubishi', 'Kia', 'Nissan', 'Volkswagen', 'Isuzu', 'Subaru', 'Holden', 'Honda', 'MG', 'Tesla', 'BYD', 'GWM', 'Suzuki', 'BMW', 'Mercedes-Benz', 'Audi', 'Land Rover', 'Jeep', 'LDV', 'Lexus'];

// The car inspection every workshop started with.
const CAR_CHECKLIST = `# Under the bonnet
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

// [kind, code, description, price in cents ex GST (null uses the labour rate)]
const CAR_ITEMS = [
  ['labour', 'LAB', 'Labour', null],
  ['labour', 'DIAG', 'Diagnostic time', null],
  ['labour', 'LOG', 'Logbook service', 18000],
  ['labour', 'MINOR', 'Minor service: oil and filter, check over', 12000],
  ['labour', 'MAJOR', 'Major service', 32000],
  ['labour', 'RWC', 'Roadworthy inspection', 9000],
  ['labour', 'ALIGN', 'Wheel alignment', 9900],
  ['labour', 'TYREFIT', 'Tyre fit and balance (each)', 2500],
  ['labour', 'BRAKES', 'Brake pads replacement, front', 15000],
  ['part', 'OIL', 'Engine oil (per litre)', 1200],
  ['part', 'OILF', 'Oil filter', 2500],
  ['part', 'AIRF', 'Air filter', 3500],
  ['part', 'CABF', 'Cabin filter', 3900],
  ['part', 'WIPER', 'Wiper blade', 2800],
  ['part', 'BATT', 'Battery', 22000],
  ['part', 'COOL', 'Coolant (per litre)', 1500],
  ['other', 'SUND', 'Shop supplies and sundries', 1500],
  ['other', 'DISP', 'Waste oil disposal', 500],
];

// Procedures every workshop starts with; each type adds its own.
const GENERAL_PROCEDURES = [
  {
    title: 'Vehicle check-in',
    category: 'Front desk',
    body: `# When the car arrives
Confirm the customer's name, phone and the work they want done
Walk around the car with the customer and note any existing damage on the job card
Record the odometer reading
Ask for the best number to ring for approvals
Put the key tag on and hang the keys on the board
# Before work starts
Open the job card and set the mechanic
Check for a service history and any open reminders on the vehicle`,
  },
  {
    title: 'Estimating extra work',
    category: 'Workshop',
    body: `Stop and photograph the problem before touching it
Write the extra work as separate lines on the job card with a price
Ring the customer, explain what you found and the cost, and get a clear yes or no
Add a note to the job card with who approved it and when
Only then carry on with the extra work`,
  },
  {
    title: 'Vehicle handover',
    category: 'Front desk',
    body: `Make sure the invoice is issued and matches the job card
Check the car is clean inside, seat and mirrors back where they were
Walk the customer through what was done and anything to watch
Take payment or confirm the account terms
Set the next service date on the vehicle
Hand over the keys and thank them`,
  },
];

const TYPES = {
  mechanical: {
    label: 'Auto mechanical workshop',
    slug: 'mechanics',
    icon: '<path d="M14.5 6.5a4 4 0 0 1-5.3 5.3L4 17a1.5 1.5 0 0 0 3 3l5.2-5.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.5-2.5z"/>',
    short: 'Auto mechanical',
    terms: ROAD,
    interval: { months: 12, meter: 15000 },
    makes: CAR_MAKES,
    checklist: CAR_CHECKLIST,
    items: CAR_ITEMS,
    procedures: [],
    page: {
      headline: 'Workshop software for mechanics who would rather be on the tools',
      intro: 'Book the car in, run the job card, and send the invoice before the customer has their keys back. Logbook services, rego and service reminders, and GST done right.',
      points: [
        ['Logbook services without the paperwork', 'Service intervals by months and km on every car. Invoice the service and the next one is worked out for you.'],
        ['Job cards the floor will actually use', 'Clock on and off, add parts from the price list, tick off the inspection and print a customer-friendly report.'],
        ['Reminders that bring cars back', 'Service and rego due lists with call, text and email buttons, and a log of who was contacted.'],
        ['Invoices your accountant likes', 'Tax invoices with GST, payments, overdue tracking, BAS figures and Xero sync.'],
      ],
    },
    demo: {
      business: 'Demo Motors',
      people: [
        ['Sam Taylor', '0412 345 678', 'sam@example.com', '123ABC', 'Toyota', 'Hilux', '2018', 142000],
        ['Alex Nguyen', '0423 456 789', 'alex@example.com', 'XYZ789', 'Mazda', 'CX-5', '2020', 61000],
        ['Jordan Smith', '0434 567 890', '', 'JS4WD', 'Ford', 'Ranger', '2016', 198500],
      ],
      bookings: ['Logbook service 140k', 'Brake noise front left', 'Timing belt'],
      job: {
        description: 'Major service',
        notes: 'Rear pads 30% left, recommend replacing next service.',
        lines: [['labour', 'Labour', 2.5, 12000], ['part', 'Engine oil 15W-40 7L', 1, 6800], ['part', 'Oil filter', 1, 2200], ['part', 'Fuel filter', 1, 5400]],
      },
    },
  },

  electrical: {
    label: 'Auto electrician',
    slug: 'auto-electricians',
    icon: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    short: 'Auto electricians',
    terms: ROAD,
    interval: { months: 12, meter: 15000 },
    makes: CAR_MAKES,
    checklist: `# Battery and charging
Battery state of health and cold cranking amps
Battery terminals and hold-down
Alternator output at idle and under load
Charging warning light
# Starting
Starter motor draw and engagement
Earth straps and main cables
# Lights
Headlights high and low beam, aim
Tail, brake and reverse lights
Indicators and hazards
Trailer plug and wiring
# Cabin and accessories
Dash warning lights and stored fault codes
Horn, wipers and washers
Power windows and central locking
Air conditioning: vent temperature and operation
Aftermarket accessories: dual battery, lights, UHF
# Parasitic draw
Key-off current draw`,
    items: [
      ['labour', 'LAB', 'Auto electrical labour', null],
      ['labour', 'DIAG', 'Electrical fault diagnosis (first hour)', 16500],
      ['labour', 'SCAN', 'Scan tool health check and fault code report', 9900],
      ['labour', 'BATTEST', 'Battery and charging system test', 4900],
      ['labour', 'BATTFIT', 'Battery fit and code reset', 6000],
      ['labour', 'ALT', 'Alternator replacement (labour)', 22000],
      ['labour', 'STARTER', 'Starter motor replacement (labour)', 22000],
      ['labour', 'DUALBAT', 'Dual battery system install', 65000],
      ['labour', 'BRAKECTL', 'Electric brake controller install', 28000],
      ['labour', 'CAMERA', 'Reversing camera install', 32000],
      ['labour', 'DRL', 'Driving lights or light bar install and wiring', 25000],
      ['labour', 'ACREGAS', 'Air conditioning regas and leak test', 19900],
      ['labour', 'DRAW', 'Parasitic battery drain test', 13200],
      ['part', 'BATT', 'Battery', 22000],
      ['part', 'DCDC', 'DC-DC battery charger 25A', 39000],
      ['part', 'AGM', 'AGM deep cycle battery 100Ah', 42000],
      ['part', 'WIRE', 'Cable, lugs and heat shrink', 4500],
      ['part', 'FUSE', 'Fuses and fuse holder', 1500],
      ['part', 'REFRIG', 'Refrigerant (per 100 g)', 2500],
      ['other', 'SUND', 'Shop supplies and sundries', 1500],
    ],
    procedures: [
      {
        title: 'Electrical fault diagnosis',
        category: 'Workshop',
        body: `# Before you start
Get the customer's story: when it happens, how often, hot or cold, what else was on
Scan every module and save the fault code report to the job
Check the battery and charging system first, a weak battery causes ghost faults
# Finding it
Look up the wiring diagram for the circuit
Check power, earth and signal at the component before replacing it
Wiggle test looms and connectors while watching live data
# Before handing it back
Clear the codes, road test and rescan
Write what you found, what you did and the readings on the job card`,
      },
      {
        title: 'Accessory install sign-off',
        category: 'Workshop',
        body: `Fuse every new positive feed as close to the battery as possible
Grommet every hole through the body and seal it
Loom and tie cables away from heat and moving parts
Label new circuits at the fuse box
Test the accessory and everything near the work before handover
Note the fuse ratings and cable routes on the job card`,
      },
    ],
    page: {
      headline: 'Power up your auto electrical workshop',
      intro: 'Diagnostics, accessory fit-outs and air conditioning, all on one job card. Quote the dual battery set-up, clock the hours, and invoice the parts you actually used.',
      points: [
        ['Diagnostic time that gets billed', 'Clock on to the fault-finding, and every quarter hour becomes a labour line at your rate.'],
        ['Fit-out quotes in minutes', 'A starter price list of batteries, DC-DC chargers, brake controllers, cameras and light bars, ready to edit.'],
        ['An electrical inspection checklist', 'Battery health, charging, starting, lights, warning lights and key-off draw, printed as a report for the customer.'],
        ['Fleet and dealer work', 'Company customers, tags and statements for the fleets and car yards that send you their electrical jobs.'],
      ],
    },
    demo: {
      business: 'Demo Auto Electrics',
      people: [
        ['Kelly Brooks', '0412 222 001', 'kelly@example.com', 'KB79LC', 'Toyota', 'LandCruiser 79', '2021', 88000],
        ['Coastal Plumbing Pty Ltd', '07 5555 0144', 'fleet@example.com', 'CPL023', 'Isuzu', 'D-Max', '2022', 54000],
        ['Ravi Patel', '0434 222 003', '', 'RP1CRV', 'Honda', 'CR-V', '2014', 176000],
      ],
      bookings: ['Dual battery and DC-DC charger install', 'Reversing camera and brake controller', 'Battery keeps going flat'],
      job: {
        description: 'Battery keeps going flat overnight',
        notes: 'Key-off draw 480 mA, traced to the aftermarket head unit staying awake. Rewired to ignition feed, now 30 mA.',
        lines: [['labour', 'Parasitic battery drain test', 1, 13200], ['labour', 'Auto electrical labour', 1, 12000], ['part', 'Cable, lugs and heat shrink', 1, 4500], ['part', 'Battery', 1, 22000]],
      },
    },
  },

  motorcycle: {
    label: 'Motorcycle and scooter repairer',
    slug: 'motorcycle-repairers',
    icon: '<circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9 10h5l4.5 6.5M14 10l-2-4h3M9 10l3 6.5h2"/>',
    short: 'Motorcycle and scooter',
    terms: { ...ROAD, asset: 'Bike', assets: 'Bikes', arrived: "Bike's here: start job" },
    interval: { months: 12, meter: 6000 },
    makes: ['Honda', 'Yamaha', 'Kawasaki', 'Suzuki', 'Harley-Davidson', 'BMW', 'KTM', 'Ducati', 'Triumph', 'Royal Enfield', 'Vespa', 'Piaggio', 'Aprilia', 'Husqvarna', 'CFMoto', 'Indian', 'Sym', 'Kymco'],
    replaces: ['Vehicle check-in'],
    checklist: `# Engine
Engine oil level and condition
Coolant level and hoses
Air filter
Spark plugs
Throttle and choke operation
# Drive
Chain or belt wear and tension
Sprockets
Clutch operation and free play
# Brakes
Front pads and disc
Rear pads and disc
Brake fluid level and condition
# Wheels and suspension
Front tyre: tread, pressure and date
Rear tyre: tread, pressure and date
Wheel bearings
Steering head bearings
Fork seals and fork oil
Rear shock
# Controls and lights
Headlight, tail and brake light
Indicators and horn
Cables, levers and kill switch
Side stand switch`,
    items: [
      ['labour', 'LAB', 'Labour', null],
      ['labour', 'DIAG', 'Diagnostic time', null],
      ['labour', 'SVCMINOR', 'Minor service: oil, filter, chain adjust, check over', 18000],
      ['labour', 'SVCMAJOR', 'Major service: valves, plugs, filters, fluids', 45000],
      ['labour', 'SCOOTER', 'Scooter service', 15000],
      ['labour', 'CHAIN', 'Chain and sprocket kit fit', 12000],
      ['labour', 'TYREF', 'Tyre fit and balance, front (wheel off)', 4500],
      ['labour', 'TYRER', 'Tyre fit and balance, rear (wheel off)', 6000],
      ['labour', 'FORKS', 'Fork seal replacement (pair)', 28000],
      ['labour', 'VALVES', 'Valve clearance check and adjust', 30000],
      ['labour', 'PREPURCH', 'Pre-purchase inspection', 15000],
      ['labour', 'RWC', 'Roadworthy inspection', 9000],
      ['part', 'OIL', 'Engine oil 10W-40 (per litre)', 1800],
      ['part', 'OILF', 'Oil filter', 2200],
      ['part', 'CHAINKIT', 'Chain and sprocket kit', 22000],
      ['part', 'PLUG', 'Spark plug', 1800],
      ['part', 'PADS', 'Brake pads (set)', 6500],
      ['part', 'BRAKEF', 'Brake fluid DOT 4', 1800],
      ['other', 'SUND', 'Shop supplies and sundries', 1000],
    ],
    procedures: [
      {
        title: 'Bike check-in',
        category: 'Front desk',
        body: `Confirm the rider's name, phone and what they want done
Note scratches, bent levers and missing parts with photos
Record the odometer, fuel level and tyre dates
Ask about luggage, alarms and immobiliser keys
Tag the keys and put the bike on a paddock stand or in the wheel chock`,
      },
      {
        title: 'Test ride and handover',
        category: 'Workshop',
        body: `Only qualified staff with a licence and full gear test ride
Check tyre pressures, brakes and the throttle closing before you go
Ride the agreed test route and note anything you feel
Clean the bike, put the mirrors back and check the stand switch
Walk the rider through the work and the next service due`,
      },
    ],
    page: {
      headline: 'Stay organised across every bike and scooter',
      intro: 'From quick scooter services to full rebuilds, keep every bike, rider and part in one place, with service reminders by km and months that keep riders coming back.',
      points: [
        ['Built for bikes', 'Bikes, not cars, on every screen. Chain kits, tyres, fork seals and valve checks in the starter price list.'],
        ['A motorcycle inspection checklist', 'Chain, sprockets, tyre dates, steering head bearings, fork seals and controls, printed for the rider.'],
        ['Service reminders by km', 'Set 6,000 km or 12 month intervals and the next service is worked out when you invoice.'],
        ['Busy season sorted', 'A diary and month calendar so spring service rush and race-day prep never double-book a hoist.'],
      ],
    },
    demo: {
      business: 'Demo Moto',
      people: [
        ['Mia Russo', '0412 333 001', 'mia@example.com', 'MR21', 'Vespa', 'GTS 300', '2021', 9800],
        ['Tom Walsh', '0423 333 002', 'tom@example.com', 'TW4DV', 'BMW', 'R 1250 GS', '2020', 41000],
        ['Jake Lee', '0434 333 003', '', 'JL600', 'Yamaha', 'MT-07', '2019', 23500],
      ],
      bookings: ['12,000 km service', 'Chain and sprockets, rear tyre', 'Fork seals leaking'],
      job: {
        description: '24,000 km major service',
        notes: 'Chain at 80% of adjustment, recommend kit at next service. Rear tyre dated 2019.',
        lines: [['labour', 'Major service: valves, plugs, filters, fluids', 1, 45000], ['part', 'Engine oil 10W-40 (per litre)', 3, 1800], ['part', 'Oil filter', 1, 2200], ['part', 'Spark plug', 2, 1800]],
      },
    },
  },

  truck: {
    label: 'Truck and heavy vehicle repairer',
    slug: 'truck-repairers',
    icon: '<path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/><circle cx="6" cy="17.5" r="2"/><circle cx="17" cy="17.5" r="2"/>',
    short: 'Truck repairers',
    terms: { ...ROAD, asset: 'Truck', assets: 'Trucks', arrived: "Truck's here: start job" },
    interval: { months: 6, meter: 25000 },
    makes: ['Isuzu', 'Hino', 'Fuso', 'UD', 'Volvo', 'Kenworth', 'Mack', 'Scania', 'Mercedes-Benz', 'DAF', 'Iveco', 'International', 'Freightliner', 'Western Star', 'MAN'],
    checklist: `# Cab
Seat belts and seats
Mirrors and windscreen
Wipers, washers and horn
Dash warning lights and stored faults
Speed limiter and logbook device
# Engine
Engine oil and coolant
Drive belts and hoses
Air filter and intake
Fuel filters and water separator
Oil, fuel and coolant leaks
# Brakes and air
Air pressure build-up time and governor cut-out
Air leaks with brakes applied
Brake linings, drums and adjusters
Park brake hold
# Driveline and suspension
Clutch and gearbox
Uni joints and tail shaft
Springs, airbags and U-bolts
Steering box, drag link and kingpins
# Wheels
Tyre tread and condition, every position
Wheel nuts and indicators
# Coupling and lights
Fifth wheel or tow coupling
Trailer air and electrical connections
Lights, reflectors and markers`,
    items: [
      ['labour', 'LAB', 'Heavy vehicle labour', null],
      ['labour', 'DIAG', 'Diagnostic time', null],
      ['labour', 'SVCA', 'A service: oil, filters, grease and check', 65000],
      ['labour', 'SVCB', 'B service: A service plus fuel filters and adjust', 95000],
      ['labour', 'GREASE', 'Grease and lube', 15000],
      ['labour', 'HVIS', 'Heavy vehicle inspection preparation', 33000],
      ['labour', 'BRAKEADJ', 'Brake adjustment, all axles', 22000],
      ['labour', 'BRAKEREL', 'Brake reline (per axle)', 45000],
      ['labour', 'AIRLEAK', 'Air leak test and repair', 18000],
      ['labour', 'TACHO', 'Speed limiter check and certificate', 16500],
      ['labour', 'CALLOUT', 'Breakdown call-out', 22000],
      ['part', 'OIL', 'Engine oil 15W-40 (per litre)', 900],
      ['part', 'OILF', 'Oil filter, heavy duty', 6500],
      ['part', 'FUELF', 'Fuel filter', 7500],
      ['part', 'AIRF', 'Air filter element', 18000],
      ['part', 'GREASEC', 'Grease cartridge', 1200],
      ['part', 'ADBLUE', 'AdBlue (per litre)', 250],
      ['other', 'SUND', 'Shop supplies and sundries', 2500],
      ['other', 'DISP', 'Waste oil disposal', 1500],
    ],
    procedures: [
      {
        title: 'Heavy vehicle inspection prep',
        category: 'Workshop',
        body: `# Before the inspection
Book the inspection station and confirm the vehicle's configuration
Check every light, reflector and marker
Check tyre tread and condition at every position
# Brakes and air
Time the air build-up and check governor cut-out
Listen for air leaks with the brakes applied
Measure linings and set the adjusters
# Paperwork
Record readings on the job card checklist
Print the inspection report for the operator`,
      },
      {
        title: 'Fleet service handover',
        category: 'Front desk',
        body: `Match the job to the fleet's order number and put it in the invoice notes
List any defects found and whether they were fixed or quoted
Set the next service by date and km on the truck
Email the inspection report and invoice to the fleet contact`,
      },
    ],
    page: {
      headline: 'Streamline your truck repair shop',
      intro: 'Fleet servicing, inspections and breakdown repairs in one system. Keep every rig on schedule, send fleet managers clear reports, and get paid on account.',
      points: [
        ['Fleet customers built in', 'Company customers with many trucks, tags, order numbers in notes, statements and aged debtors.'],
        ['Heavy vehicle inspection checklist', 'Air build-up, leaks, linings, kingpins, coupling and every tyre position, printed as a report.'],
        ['A and B services on schedule', 'Intervals by months and km per truck, with a due list so nothing runs over.'],
        ['Breakdowns that still get invoiced', 'Start a job from the road, clock the hours, add parts as you go and invoice when it is back.'],
      ],
    },
    demo: {
      business: 'Demo Diesel and Truck',
      people: [
        ['Ridgeline Freight Pty Ltd', '07 5555 0177', 'fleet@ridgeline.example', 'RF01TK', 'Kenworth', 'T610', '2020', 612000],
        ['Ridgeline Freight Pty Ltd', '', '', 'RF07TK', 'Isuzu', 'FVR 165-300', '2018', 344000],
        ['Dave Mercer', '0434 444 003', 'dave@example.com', 'DM900', 'Volvo', 'FH16', '2016', 1040000],
      ],
      bookings: ['B service and grease', 'Brake adjustment and air leak', 'Heavy vehicle inspection prep'],
      job: {
        description: 'A service and grease',
        notes: 'Drive axle linings 40%. Small air leak at trailer service coupling, replaced seal.',
        lines: [['labour', 'A service: oil, filters, grease and check', 1, 65000], ['part', 'Engine oil 15W-40 (per litre)', 38, 900], ['part', 'Oil filter, heavy duty', 2, 6500], ['part', 'Grease cartridge', 2, 1200]],
      },
    },
  },

  farm: {
    label: 'Farm machinery repairer',
    slug: 'farm-machinery',
    icon: '<circle cx="7" cy="16" r="4"/><circle cx="18" cy="17.5" r="2.5"/><path d="M4 12V6h6l2 6h6l1 3M10 6v6"/>',
    short: 'Farm machinery',
    terms: { asset: 'Machine', assets: 'Machines', rego: 'Rego', vin: 'Serial / PIN', meter: 'Engine hours', unit: 'hrs', arrived: "Machine's here: start job" },
    interval: { months: 12, meter: 250 },
    makes: ['John Deere', 'Case IH', 'New Holland', 'Kubota', 'Massey Ferguson', 'Fendt', 'Claas', 'Deutz-Fahr', 'Mahindra', 'Valtra', 'JCB', 'Bobcat', 'Caterpillar', 'Polaris', 'Honda', 'Husqvarna', 'Stihl'],
    checklist: `# Engine
Engine oil and filter
Coolant level and radiator fins
Air filter and pre-cleaner
Fuel filters and water trap
Drive belts and hoses
# Hydraulics and transmission
Hydraulic and transmission oil level
Hydraulic hoses, couplings and leaks
Three-point linkage and drawbar
PTO operation and guards
# Running gear
Front axle and steering
Tyres or tracks
Wheel nuts
Brakes and park brake
# Grease points
All grease points done
# Cab and safety
ROPS or cab mounts
Seat belt and seat switch
Lights, beacon and SMV sign
Warning lights and stored faults
Fire extinguisher`,
    items: [
      ['labour', 'LAB', 'Labour', null],
      ['labour', 'FIELD', 'Field service call-out', 18000],
      ['labour', 'TRAVEL', 'Travel (per km)', 220],
      ['labour', 'SVC250', '250 hour service', 45000],
      ['labour', 'SVC500', '500 hour service', 75000],
      ['labour', 'SVC1000', '1000 hour service incl. hydraulic oil', 140000],
      ['labour', 'PRESEASON', 'Pre-season check: harvester or planter', 60000],
      ['labour', 'HYDHOSE', 'Hydraulic hose made up and fitted', 9500],
      ['labour', 'GREASE', 'Full grease-up', 12000],
      ['labour', 'MOWER', 'Ride-on mower service', 22000],
      ['part', 'OIL', 'Engine oil 15W-40 (per litre)', 950],
      ['part', 'HYD', 'Hydraulic / transmission oil (per litre)', 1100],
      ['part', 'OILF', 'Oil filter', 5500],
      ['part', 'FUELF', 'Fuel filter', 6500],
      ['part', 'AIRF', 'Air filter element', 14000],
      ['part', 'HYDF', 'Hydraulic filter', 9500],
      ['part', 'GREASEC', 'Grease cartridge', 1200],
      ['other', 'SUND', 'Shop supplies and sundries', 2000],
      ['other', 'DISP', 'Waste oil disposal', 1500],
    ],
    procedures: [
      {
        title: 'Field service visit',
        category: 'Workshop',
        body: `# Before you leave
Confirm the machine, serial number, location and gate codes with the farmer
Check the service ute has the filters, oils and hoses for the job
# On site
Park clear of the machine and check for overhead power lines
Isolate the machine: park brake, PTO off, key out, hydraulics lowered
Record the engine hours on the job card
# Before you go
Run the machine and check for leaks
Note the hours, travel km and anything to quote on the job card`,
      },
      {
        title: 'Pre-season check',
        category: 'Workshop',
        body: `Book machines in two months before the season starts
Service by hours and replace belts, bearings and wear parts found worn
Run up the machine under load and check every function
List anything worn but serviceable so the farmer can budget for it
Set the next service by hours on the machine`,
      },
    ],
    page: {
      headline: 'Farm machinery repairs made easy',
      intro: 'Tractors, headers, sprayers and mowers, serviced by engine hours, in the shed or out in the paddock. Know every machine’s history and be ready before the season starts.',
      points: [
        ['Engine hours, not km', 'Every machine tracks hours, with services due at 250, 500 or 1000 hours, worked out when you invoice.'],
        ['Serial numbers and PINs', 'Find a machine by its serial or PIN as fast as a car by its rego.'],
        ['Field service ready', 'Call-out and travel per km in the starter price list, and a field service procedure for the team.'],
        ['Pre-season rush planned', 'A month calendar and reminders list so every header and planter is booked in before harvest or sowing.'],
      ],
    },
    demo: {
      business: 'Demo Ag Machinery',
      people: [
        ['Greenvale Pastoral Co', '02 6555 0199', 'office@greenvale.example', '', 'John Deere', '6155R', '2019', 4210, '1RW6155RLKD012345'],
        ['Greenvale Pastoral Co', '', '', '', 'Case IH', 'Axial-Flow 8250', '2020', 1880, 'YLF223401'],
        ['Pete Doyle', '0434 555 003', '', '', 'Kubota', 'M7060', '2017', 2365, '58712'],
      ],
      bookings: ['500 hour service', 'Pre-season header check', 'Hydraulic leak on loader'],
      job: {
        description: '500 hour service',
        notes: 'Front axle oil slightly low, topped up. Loader pin bushes worn, quote sent.',
        lines: [['labour', '500 hour service', 1, 75000], ['part', 'Engine oil 15W-40 (per litre)', 16, 950], ['part', 'Oil filter', 1, 5500], ['part', 'Fuel filter', 2, 6500], ['part', 'Hydraulic filter', 1, 9500]],
      },
    },
  },

  marine: {
    label: 'Boat and marine mechanic',
    slug: 'boat-maintenance',
    icon: '<path d="M3 15h18l-2.5 4h-13zM12 3v12M12 4l6 8h-6"/><path d="M2 21c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1"/>',
    short: 'Boat maintenance',
    terms: { asset: 'Boat', assets: 'Boats', rego: 'Rego', vin: 'HIN (hull ID)', meter: 'Engine hours', unit: 'hrs', arrived: "Boat's here: start job" },
    interval: { months: 12, meter: 100 },
    makes: ['Yamaha', 'Mercury', 'Suzuki', 'Honda', 'Tohatsu', 'Evinrude', 'Volvo Penta', 'MerCruiser', 'Yanmar', 'Quintrex', 'Stacer', 'Haines Hunter', 'Bar Crusher', 'Sea-Doo', 'Yamaha WaveRunner', 'Riviera', 'Whittley', 'Sea Jay'],
    replaces: ['Vehicle check-in'],
    checklist: `# Engine
Engine oil and filter
Gear oil: water or metal in the oil
Spark plugs
Fuel filter and water separator
Fuel lines and primer bulb
Water pump impeller and tell-tale flow
Thermostats and anodes
Throttle and gear shift cables
Steering and tilt/trim
# Hull and trailer
Hull and transom
Bungs and bilge pump
Propeller and prop shaft seal
Trailer bearings, rollers and winch
Trailer lights and brakes
# Safety gear
Lifejackets
Flares and EPIRB dates
Fire extinguisher
Navigation lights
Battery and isolator switch`,
    items: [
      ['labour', 'LAB', 'Marine labour', null],
      ['labour', 'DIAG', 'Diagnostic time', null],
      ['labour', 'SVC100', '100 hour / annual outboard service', 38000],
      ['labour', 'SVC300', '300 hour outboard service incl. impeller', 75000],
      ['labour', 'IMPELLER', 'Water pump impeller replacement', 25000],
      ['labour', 'STERN', 'Sterndrive service', 85000],
      ['labour', 'PWC', 'Jet ski / PWC service', 35000],
      ['labour', 'TRAILER', 'Trailer bearings repack (per axle)', 16000],
      ['labour', 'WINTER', 'Lay-up and fogging', 22000],
      ['labour', 'SEATRIAL', 'Sea trial', 15000],
      ['labour', 'PICKUP', 'Pick-up and delivery', 9000],
      ['part', 'OIL', 'Outboard engine oil 10W-30 (per litre)', 2200],
      ['part', 'OILF', 'Oil filter', 2800],
      ['part', 'GEAROIL', 'Gear oil (per tube)', 2400],
      ['part', 'PLUG', 'Spark plug', 1600],
      ['part', 'IMPKIT', 'Water pump impeller kit', 9500],
      ['part', 'ANODE', 'Anode', 3500],
      ['part', 'FUELSEP', 'Fuel / water separator filter', 4200],
      ['other', 'SUND', 'Shop supplies and sundries', 1500],
    ],
    procedures: [
      {
        title: 'Boat check-in',
        category: 'Front desk',
        body: `Confirm the owner's name, phone and the work they want done
Record the HIN, engine serial numbers and engine hours
Walk around the hull and trailer and photograph any damage
Check the bungs are out and the battery isolator is off
Tag the keys and note where the boat is parked in the yard`,
      },
      {
        title: 'Test tank and sea trial',
        category: 'Workshop',
        body: `Check the gear oil, prop nut and fuel before running
Run in the test tank: check tell-tale flow and idle temperature
On a sea trial wear a lifejacket and take the safety gear
Check the engine reaches rated RPM at wide open throttle
Flush the engine with fresh water afterwards
Record the hours and WOT RPM on the job card`,
      },
    ],
    page: {
      headline: 'Powerful tools for boat maintenance',
      intro: 'Outboards, sterndrives, jet skis and trailers, serviced by engine hours. Track every hull ID and engine, plan the pre-summer rush, and keep owners on the water.',
      points: [
        ['Boats, hours and HINs', 'Every screen talks boats. Track hull IDs, rego and engine hours, with services due at 100 hours or every year.'],
        ['A marine inspection checklist', 'Impeller, gear oil, anodes, steering, trailer bearings and safety gear dates, printed for the owner.'],
        ['Outboard service menu', 'A starter price list of 100 and 300 hour services, impellers, sterndrives, jet skis and trailer work.'],
        ['Ready for summer', 'Reminders and a month calendar so every owner is booked in before the season, not the long weekend.'],
      ],
    },
    demo: {
      business: 'Demo Marine',
      people: [
        ['Chris Hall', '0412 666 001', 'chris@example.com', 'BX123Q', 'Quintrex', '510 Fishabout / Yamaha F90', '2019', 342, 'AU-QTX51043F919'],
        ['Nina Ford', '0423 666 002', 'nina@example.com', 'BY456Q', 'Bar Crusher', '670C / Mercury 200', '2021', 188, 'AU-BCB67021A121'],
        ['Lee Tran', '0434 666 003', '', 'PW77Q', 'Sea-Doo', 'GTI SE 170', '2022', 96, 'YDV12345K122'],
      ],
      bookings: ['100 hour service and impeller', 'Annual service and trailer bearings', 'Jet ski service'],
      job: {
        description: '300 hour outboard service',
        notes: 'Impeller vanes set and cracked, replaced. Anodes 50%, replaced. WOT 5,900 RPM on sea trial.',
        lines: [['labour', '300 hour outboard service incl. impeller', 1, 75000], ['part', 'Outboard engine oil 10W-30 (per litre)', 5, 2200], ['part', 'Water pump impeller kit', 1, 9500], ['part', 'Anode', 2, 3500]],
      },
    },
  },
};

// The order types appear in pickers and on the public pages.
const TYPE_KEYS = ['mechanical', 'electrical', 'motorcycle', 'truck', 'farm', 'marine'];

const DEFAULT_TYPE = 'mechanical';
const typeKey = (key) => (TYPES[key] ? key : DEFAULT_TYPE);
const typeFor = (key) => TYPES[typeKey(key)];

// The words a screen uses for this workshop's assets, plus the type's key and label.
function termsFor(key) {
  const t = typeFor(key);
  return {
    key: typeKey(key),
    label: t.label,
    ...t.terms,
    assetLower: t.terms.asset.toLowerCase(),
    assetsLower: t.terms.assets.toLowerCase(),
    hours: t.terms.unit === 'hrs',
    makes: t.makes,
    interval: t.interval,
  };
}

// Adds the type's starter price list, skipping codes already there.
async function addStarterItems(db, key) {
  let added = 0;
  for (const [kind, code, description, cents] of typeFor(key).items) {
    if (await db.get('SELECT id FROM price_items WHERE code = $1', [code])) continue;
    await db.run('INSERT INTO price_items (kind, code, description, unit_cents) VALUES ($1, $2, $3, $4)', [kind, code, description, cents || 0]);
    added++;
  }
  return added;
}

// Adds the general procedures plus the type's own, skipping titles already there.
async function addStarterProcedures(db, key, userId) {
  const own = typeFor(key);
  for (const p of [...GENERAL_PROCEDURES.filter((g) => !(own.replaces || []).includes(g.title)), ...own.procedures]) {
    if (await db.get('SELECT id FROM procedures WHERE lower(title) = lower($1)', [p.title])) continue;
    await db.run('INSERT INTO procedures (title, category, body, updated_by) VALUES ($1, $2, $3, $4)', [p.title, p.category, p.body, userId || null]);
  }
}

module.exports = { PRODUCT, TYPES, TYPE_KEYS, DEFAULT_TYPE, CAR_CHECKLIST, CAR_ITEMS, typeKey, typeFor, termsFor, addStarterItems, addStarterProcedures };
