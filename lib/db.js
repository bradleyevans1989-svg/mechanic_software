const { Pool, types } = require('pg');

// Counts and sums come back as numbers, not strings.
types.setTypeParser(20, Number); // bigint
types.setTypeParser(1700, Number); // numeric

// Every workshop's rows live in the same tables, tagged with workshop_id.
// Postgres row-level security only shows rows whose workshop_id matches the
// app.workshop_id setting of the connection, so one workshop can never read
// or write another's data, even if a query forgets a WHERE clause.
const TENANT_TABLES = [
  'settings',
  'customers',
  'vehicles',
  'jobs',
  'bookings',
  'documents',
  'line_items',
  'payments',
  'integrations',
  'sync_links',
];

const WS = `workshop_id integer NOT NULL DEFAULT current_workshop_id() REFERENCES workshops(id) ON DELETE CASCADE`;

// Row-level security for a table added after the first migration.
const rls = (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_only ON ${t}
    USING (workshop_id = current_workshop_id()) WITH CHECK (workshop_id = current_workshop_id());`;

const MIGRATIONS = [
  // 1: the whole schema.
  `
  CREATE FUNCTION current_workshop_id() RETURNS integer LANGUAGE sql STABLE AS
    $$ SELECT NULLIF(current_setting('app.workshop_id', true), '')::integer $$;

  CREATE TABLE workshops (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'trial',
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE users (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workshop_id integer NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'staff',
    active boolean NOT NULL DEFAULT true,
    session_version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX ON users (workshop_id);

  CREATE TABLE settings (
    ${WS} PRIMARY KEY,
    business_name text NOT NULL DEFAULT 'My Workshop',
    abn text NOT NULL DEFAULT '',
    address text NOT NULL DEFAULT '',
    phone text NOT NULL DEFAULT '',
    email text NOT NULL DEFAULT '',
    bank_details text NOT NULL DEFAULT '',
    invoice_terms text NOT NULL DEFAULT 'Thank you for your business.',
    labour_rate_cents integer NOT NULL DEFAULT 12000,
    payment_days integer NOT NULL DEFAULT 7,
    timezone text NOT NULL DEFAULT 'Australia/Sydney',
    next_invoice_no integer NOT NULL DEFAULT 1001,
    next_quote_no integer NOT NULL DEFAULT 1001,
    next_job_no integer NOT NULL DEFAULT 1001
  );

  CREATE TABLE customers (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    name text NOT NULL,
    phone text NOT NULL DEFAULT '',
    email text NOT NULL DEFAULT '',
    address text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    created_at text NOT NULL,
    UNIQUE (workshop_id, id)
  );
  CREATE INDEX ON customers (workshop_id, lower(name));

  CREATE TABLE vehicles (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    customer_id integer NOT NULL,
    rego text NOT NULL DEFAULT '',
    make text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    year text NOT NULL DEFAULT '',
    vin text NOT NULL DEFAULT '',
    colour text NOT NULL DEFAULT '',
    odometer integer,
    rego_due text,
    next_service_date text,
    next_service_km integer,
    notes text NOT NULL DEFAULT '',
    created_at text NOT NULL,
    UNIQUE (workshop_id, id),
    FOREIGN KEY (workshop_id, customer_id) REFERENCES customers (workshop_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ON vehicles (workshop_id, customer_id);
  CREATE INDEX ON vehicles (workshop_id, rego);

  CREATE TABLE jobs (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    number integer NOT NULL,
    customer_id integer NOT NULL,
    vehicle_id integer,
    mechanic_id integer REFERENCES users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'open',
    description text NOT NULL DEFAULT '',
    tech_notes text NOT NULL DEFAULT '',
    odometer integer,
    created_at text NOT NULL,
    completed_at text,
    UNIQUE (workshop_id, id),
    UNIQUE (workshop_id, number),
    FOREIGN KEY (workshop_id, customer_id) REFERENCES customers (workshop_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workshop_id, vehicle_id) REFERENCES vehicles (workshop_id, id) ON DELETE SET NULL (vehicle_id)
  );
  CREATE INDEX ON jobs (workshop_id, status);

  CREATE TABLE bookings (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    customer_id integer NOT NULL,
    vehicle_id integer,
    job_id integer,
    date text NOT NULL,
    time text NOT NULL DEFAULT '',
    duration_hours double precision NOT NULL DEFAULT 1,
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'booked',
    created_at text NOT NULL,
    FOREIGN KEY (workshop_id, customer_id) REFERENCES customers (workshop_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workshop_id, vehicle_id) REFERENCES vehicles (workshop_id, id) ON DELETE SET NULL (vehicle_id),
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE SET NULL (job_id)
  );
  CREATE INDEX ON bookings (workshop_id, date);

  -- Quotes and invoices share one table; type says which.
  CREATE TABLE documents (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    type text NOT NULL CHECK (type IN ('quote', 'invoice')),
    number integer NOT NULL,
    customer_id integer NOT NULL,
    vehicle_id integer,
    job_id integer,
    issue_date text NOT NULL,
    due_date text,
    status text NOT NULL,
    odometer integer,
    notes text NOT NULL DEFAULT '',
    created_at text NOT NULL,
    UNIQUE (workshop_id, id),
    UNIQUE (workshop_id, type, number),
    FOREIGN KEY (workshop_id, customer_id) REFERENCES customers (workshop_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workshop_id, vehicle_id) REFERENCES vehicles (workshop_id, id) ON DELETE SET NULL (vehicle_id),
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE SET NULL (job_id)
  );
  CREATE INDEX ON documents (workshop_id, type, issue_date);

  -- Prices are in cents, excluding GST.
  CREATE TABLE line_items (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    job_id integer,
    document_id integer,
    kind text NOT NULL DEFAULT 'part',
    description text NOT NULL DEFAULT '',
    qty double precision NOT NULL DEFAULT 1,
    unit_cents integer NOT NULL DEFAULT 0,
    gst boolean NOT NULL DEFAULT true,
    sort integer NOT NULL DEFAULT 0,
    CHECK ((job_id IS NULL) <> (document_id IS NULL)),
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workshop_id, document_id) REFERENCES documents (workshop_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ON line_items (job_id);
  CREATE INDEX ON line_items (document_id);

  CREATE TABLE payments (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    document_id integer NOT NULL,
    date text NOT NULL,
    amount_cents integer NOT NULL,
    method text NOT NULL DEFAULT '',
    created_at text NOT NULL,
    FOREIGN KEY (workshop_id, document_id) REFERENCES documents (workshop_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ON payments (document_id);

  -- Accounting connections (Xero now, MYOB later).
  CREATE TABLE integrations (
    ${WS},
    provider text NOT NULL,
    tenant_id text NOT NULL DEFAULT '',
    tenant_name text NOT NULL DEFAULT '',
    access_token text NOT NULL DEFAULT '',
    refresh_token text NOT NULL DEFAULT '',
    expires_at bigint NOT NULL DEFAULT 0,
    config text NOT NULL DEFAULT '{}',
    connected_at text,
    PRIMARY KEY (workshop_id, provider)
  );

  CREATE TABLE sync_links (
    ${WS},
    provider text NOT NULL,
    entity text NOT NULL,
    local_id integer NOT NULL,
    parent_id integer,
    remote_id text NOT NULL DEFAULT '',
    hash text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending',
    error text NOT NULL DEFAULT '',
    synced_at text,
    PRIMARY KEY (workshop_id, provider, entity, local_id)
  );

  ${TENANT_TABLES.map(
    (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_only ON ${t}
    USING (workshop_id = current_workshop_id()) WITH CHECK (workshop_id = current_workshop_id());`
  ).join('\n  ')}
  `,

  // 2: subscription billing per workshop (Stripe).
  `
  ALTER TABLE workshops
    ADD COLUMN trial_ends_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
    ADD COLUMN stripe_customer_id text NOT NULL DEFAULT '',
    ADD COLUMN stripe_subscription_id text NOT NULL DEFAULT '',
    ADD COLUMN subscription_status text NOT NULL DEFAULT '',
    ADD COLUMN current_period_end timestamptz,
    ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;
  CREATE UNIQUE INDEX workshops_stripe_customer ON workshops (stripe_customer_id) WHERE stripe_customer_id <> '';
  CREATE TABLE stripe_events (
    id text PRIMARY KEY,
    type text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
  );
  `,

  // 3: price list of saved parts and services.
  `
  CREATE TABLE price_items (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    kind text NOT NULL DEFAULT 'part',
    code text NOT NULL DEFAULT '',
    description text NOT NULL,
    unit_cents integer NOT NULL DEFAULT 0,
    cost_cents integer NOT NULL DEFAULT 0,
    gst boolean NOT NULL DEFAULT true,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workshop_id, id)
  );
  CREATE INDEX ON price_items (workshop_id, lower(description));
  ${rls('price_items')}
  `,

  // 4: job card depth: promised time, priority, inspection checklist, time clock, activity log.
  `
  ALTER TABLE jobs
    ADD COLUMN due_date text,
    ADD COLUMN due_time text NOT NULL DEFAULT '',
    ADD COLUMN priority text NOT NULL DEFAULT 'normal',
    ADD COLUMN is_service boolean NOT NULL DEFAULT false;
  ALTER TABLE settings ADD COLUMN checklist text NOT NULL DEFAULT '';
  ALTER TABLE vehicles
    ADD COLUMN service_interval_months integer NOT NULL DEFAULT 0,
    ADD COLUMN service_interval_km integer NOT NULL DEFAULT 0,
    ADD COLUMN last_service_date text;

  CREATE TABLE job_checks (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    job_id integer NOT NULL,
    item text NOT NULL,
    heading boolean NOT NULL DEFAULT false,
    result text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    sort integer NOT NULL DEFAULT 0,
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ON job_checks (job_id);
  ${rls('job_checks')}

  CREATE TABLE time_entries (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    job_id integer NOT NULL,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    note text NOT NULL DEFAULT '',
    billed boolean NOT NULL DEFAULT false,
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ON time_entries (job_id);
  CREATE INDEX ON time_entries (workshop_id, user_id, started_at);
  ${rls('time_entries')}

  CREATE TABLE job_events (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    job_id integer NOT NULL,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    at timestamptz NOT NULL DEFAULT now(),
    kind text NOT NULL DEFAULT 'note',
    text text NOT NULL DEFAULT '',
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ON job_events (job_id);
  ${rls('job_events')}
  `,

  // 5: service and rego reminders: who was contacted, when, how.
  `
  CREATE TABLE reminder_log (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    vehicle_id integer NOT NULL,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    kind text NOT NULL,
    method text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workshop_id, vehicle_id) REFERENCES vehicles (workshop_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ON reminder_log (vehicle_id, at);
  ${rls('reminder_log')}
  `,

  // 6: share links for sending quotes and invoices to customers.
  `
  -- Looked up by token before any workshop is known, so no row-level security here;
  -- the token is the secret, and the document is then read as its own workshop.
  CREATE TABLE share_links (
    token text PRIMARY KEY,
    workshop_id integer NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    document_id integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workshop_id, document_id)
  );
  ALTER TABLE documents
    ADD COLUMN customer_accepted_at timestamptz,
    ADD COLUMN sent_at timestamptz,
    ADD COLUMN sent_to text NOT NULL DEFAULT '',
    ADD COLUMN sent_via text NOT NULL DEFAULT '';
  `,

  // 7: month calendar entries: staff leave, public holidays, toolbox talks, notes.
  `
  CREATE TABLE calendar_entries (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    kind text NOT NULL DEFAULT 'note',
    title text NOT NULL DEFAULT '',
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    start_date text NOT NULL,
    end_date text NOT NULL,
    note text NOT NULL DEFAULT '',
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX ON calendar_entries (start_date, end_date);
  ${rls('calendar_entries')}
  `,

  // 8: staff clocking (start, breaks, finish) and the roster.
  `
  CREATE TABLE shifts (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date text NOT NULL,
    kind text NOT NULL DEFAULT 'shift',
    start_time text NOT NULL DEFAULT '',
    end_time text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    UNIQUE (workshop_id, user_id, date)
  );
  ${rls('shifts')}
  CREATE TABLE clock_entries (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    note text NOT NULL DEFAULT ''
  );
  CREATE INDEX ON clock_entries (user_id, started_at);
  ${rls('clock_entries')}
  CREATE TABLE clock_breaks (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    entry_id integer NOT NULL REFERENCES clock_entries(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
  );
  ${rls('clock_breaks')}
  `,

  // 9: procedures, training modules with points, team to-do chat.
  `
  CREATE TABLE procedures (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    title text NOT NULL,
    category text NOT NULL DEFAULT '',
    body text NOT NULL DEFAULT '',
    updated_by integer REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ${rls('procedures')}
  CREATE TABLE training_modules (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    body text NOT NULL DEFAULT '',
    points integer NOT NULL DEFAULT 10,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ${rls('training_modules')}
  CREATE TABLE training_completions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    module_id integer NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    completed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workshop_id, module_id, user_id)
  );
  ${rls('training_completions')}
  CREATE TABLE team_posts (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    text text NOT NULL,
    kind text NOT NULL DEFAULT 'todo',
    done_at timestamptz,
    done_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX ON team_posts (created_at);
  ${rls('team_posts')}
  `,

  // 10: branding: logo, brand colour, extra business details, chosen print templates.
  `
  ALTER TABLE settings
    ADD COLUMN invoice_template text NOT NULL DEFAULT 'classic',
    ADD COLUMN jobcard_template text NOT NULL DEFAULT 'classic',
    ADD COLUMN brand_colour text NOT NULL DEFAULT '#111111',
    ADD COLUMN tagline text NOT NULL DEFAULT '',
    ADD COLUMN website text NOT NULL DEFAULT '',
    ADD COLUMN licence text NOT NULL DEFAULT '',
    ADD COLUMN has_logo boolean NOT NULL DEFAULT false;
  CREATE TABLE logos (
    ${WS} PRIMARY KEY,
    data bytea NOT NULL,
    content_type text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ${rls('logos')}
  `,

  // 11: customers can be companies, tagged and archived; vehicles keep an ownership history.
  `
  ALTER TABLE customers
    ADD COLUMN kind text NOT NULL DEFAULT 'individual',
    ADD COLUMN tags text NOT NULL DEFAULT '',
    ADD COLUMN archived_at text;
  CREATE TABLE vehicle_owners (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    vehicle_id integer NOT NULL,
    customer_id integer NOT NULL,
    from_at text NOT NULL,
    to_at text,
    note text NOT NULL DEFAULT '',
    FOREIGN KEY (workshop_id, vehicle_id) REFERENCES vehicles (workshop_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workshop_id, customer_id) REFERENCES customers (workshop_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ON vehicle_owners (workshop_id, vehicle_id);
  -- Backfill across every workshop: lift forced RLS on vehicles for this one statement
  -- (the migrating role owns the table, so without FORCE it sees every row).
  ALTER TABLE vehicles NO FORCE ROW LEVEL SECURITY;
  INSERT INTO vehicle_owners (workshop_id, vehicle_id, customer_id, from_at)
    SELECT workshop_id, id, customer_id, created_at FROM vehicles;
  ALTER TABLE vehicles FORCE ROW LEVEL SECURITY;
  ${rls('vehicle_owners')}
  `,

  // 12: how long an estimate stays valid.
  `
  ALTER TABLE settings ADD COLUMN quote_days integer NOT NULL DEFAULT 7;
  `,

  // 13: parts suppliers, purchase orders against them, and stock on hand.
  `
  CREATE TABLE suppliers (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    name text NOT NULL,
    connector text NOT NULL DEFAULT 'manual',
    account_no text NOT NULL DEFAULT '',
    phone text NOT NULL DEFAULT '',
    email text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    -- Connector login details (account, site code, username...), as JSON.
    config text NOT NULL DEFAULT '{}',
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workshop_id, id)
  );
  ${rls('suppliers')}

  ALTER TABLE price_items
    ADD COLUMN supplier_id integer,
    ADD COLUMN stock_qty double precision NOT NULL DEFAULT 0,
    ADD COLUMN reorder_level double precision NOT NULL DEFAULT 0,
    ADD FOREIGN KEY (workshop_id, supplier_id) REFERENCES suppliers (workshop_id, id) ON DELETE SET NULL (supplier_id);
  CREATE INDEX ON price_items (workshop_id, supplier_id, code);

  ALTER TABLE settings ADD COLUMN next_po_no integer NOT NULL DEFAULT 1001;

  -- Prices are in cents, excluding GST.
  CREATE TABLE purchase_orders (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    number integer NOT NULL,
    supplier_id integer NOT NULL,
    job_id integer,
    status text NOT NULL DEFAULT 'draft',
    reference text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    -- The supplier's own order number, and their invoice number once the parts arrive.
    supplier_ref text NOT NULL DEFAULT '',
    supplier_invoice text NOT NULL DEFAULT '',
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    ordered_at timestamptz,
    received_at timestamptz,
    UNIQUE (workshop_id, id),
    UNIQUE (workshop_id, number),
    FOREIGN KEY (workshop_id, supplier_id) REFERENCES suppliers (workshop_id, id),
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE SET NULL (job_id)
  );
  CREATE INDEX ON purchase_orders (workshop_id, status);
  CREATE INDEX ON purchase_orders (job_id);
  ${rls('purchase_orders')}

  CREATE TABLE purchase_order_lines (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    order_id integer NOT NULL,
    price_item_id integer,
    code text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    qty double precision NOT NULL DEFAULT 1,
    received_qty double precision NOT NULL DEFAULT 0,
    cost_cents integer NOT NULL DEFAULT 0,
    sell_cents integer NOT NULL DEFAULT 0,
    gst boolean NOT NULL DEFAULT true,
    -- Already a line on the job card, so receiving it adds nothing to the job or to stock.
    from_job boolean NOT NULL DEFAULT false,
    sort integer NOT NULL DEFAULT 0,
    FOREIGN KEY (workshop_id, order_id) REFERENCES purchase_orders (workshop_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workshop_id, price_item_id) REFERENCES price_items (workshop_id, id) ON DELETE SET NULL (price_item_id)
  );
  CREATE INDEX ON purchase_order_lines (order_id);
  ${rls('purchase_order_lines')}
  `,

  // 14: text messages to and from customers, and day-before booking reminders.
  `
  CREATE TABLE sms_messages (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    customer_id integer,
    job_id integer,
    user_id integer REFERENCES users(id) ON DELETE SET NULL,
    direction text NOT NULL,
    phone text NOT NULL,
    body text NOT NULL,
    -- message, booking, reminder, document, ready or reply.
    kind text NOT NULL DEFAULT 'message',
    status text NOT NULL DEFAULT 'sent',
    provider_id text NOT NULL DEFAULT '',
    error text NOT NULL DEFAULT '',
    -- Sent in test mode, so it never reached a phone.
    test boolean NOT NULL DEFAULT false,
    read_at timestamptz,
    at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workshop_id, customer_id) REFERENCES customers (workshop_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE SET NULL (job_id)
  );
  CREATE INDEX ON sms_messages (workshop_id, customer_id, at);
  CREATE INDEX ON sms_messages (workshop_id, direction, read_at);
  ${rls('sms_messages')}

  -- Which workshop last texted a number, so a reply can be filed before any workshop
  -- is known. No row-level security, like share_links; only the inbound handler reads it.
  CREATE TABLE sms_routes (
    phone text NOT NULL,
    workshop_id integer NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    customer_id integer,
    last_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (phone, workshop_id)
  );
  CREATE INDEX ON sms_routes (phone, last_at);

  ALTER TABLE settings
    ADD COLUMN sms_sender text NOT NULL DEFAULT '',
    ADD COLUMN sms_booking_reminders boolean NOT NULL DEFAULT false,
    ADD COLUMN sms_booking_template text NOT NULL DEFAULT '',
    ADD COLUMN sms_ready_template text NOT NULL DEFAULT '';
  ALTER TABLE bookings ADD COLUMN reminder_sent_at timestamptz;
  `,

  // 15: online booking: a public page per workshop, and the requests it collects.
  `
  -- Looked up by its address before any workshop is known, so no row-level security.
  CREATE TABLE booking_pages (
    slug text PRIMARY KEY,
    workshop_id integer NOT NULL UNIQUE REFERENCES workshops(id) ON DELETE CASCADE
  );

  ALTER TABLE settings
    ADD COLUMN online_booking boolean NOT NULL DEFAULT false,
    ADD COLUMN booking_intro text NOT NULL DEFAULT '',
    ADD COLUMN booking_services text NOT NULL DEFAULT '',
    -- Days of the week taking bookings, 0 = Sunday, as digits ('12345' is Monday to Friday).
    ADD COLUMN booking_days text NOT NULL DEFAULT '12345',
    ADD COLUMN booking_notice_days integer NOT NULL DEFAULT 1,
    ADD COLUMN booking_max_per_day integer NOT NULL DEFAULT 0;

  ALTER TABLE bookings ADD UNIQUE (workshop_id, id);
  CREATE TABLE booking_requests (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    name text NOT NULL,
    phone text NOT NULL DEFAULT '',
    email text NOT NULL DEFAULT '',
    rego text NOT NULL DEFAULT '',
    car text NOT NULL DEFAULT '',
    service text NOT NULL DEFAULT '',
    date text NOT NULL,
    drop_off text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    -- pending, accepted or declined.
    status text NOT NULL DEFAULT 'pending',
    booking_id integer,
    handled_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    handled_at timestamptz,
    FOREIGN KEY (workshop_id, booking_id) REFERENCES bookings (workshop_id, id) ON DELETE SET NULL (booking_id)
  );
  CREATE INDEX ON booking_requests (workshop_id, status, date);
  ${rls('booking_requests')}
  `,

  // 16: inspections sent to the customer to approve or decline each item.
  `
  ALTER TABLE job_checks
    -- The quote for fixing a flagged item, excluding GST.
    ADD COLUMN price_cents integer,
    -- approved or declined by the customer; empty until they answer.
    ADD COLUMN decision text NOT NULL DEFAULT '',
    ADD COLUMN decided_at timestamptz,
    ADD COLUMN added_to_job boolean NOT NULL DEFAULT false;

  -- Looked up by token before any workshop is known, like share_links.
  CREATE TABLE inspection_links (
    token text PRIMARY KEY,
    workshop_id integer NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    job_id integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    viewed_at timestamptz,
    responded_at timestamptz,
    UNIQUE (workshop_id, job_id),
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE CASCADE
  );
  `,

  // 17: loan cars: the workshop's courtesy vehicles and who has had them when.
  `
  CREATE TABLE loan_cars (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    rego text NOT NULL,
    make text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    colour text NOT NULL DEFAULT '',
    odometer integer,
    notes text NOT NULL DEFAULT '',
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workshop_id, id)
  );
  ${rls('loan_cars')}

  CREATE TABLE loans (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    loan_car_id integer NOT NULL,
    customer_id integer NOT NULL,
    job_id integer,
    start_date text NOT NULL,
    due_date text NOT NULL,
    -- booked, out, returned or cancelled.
    status text NOT NULL DEFAULT 'booked',
    licence_no text NOT NULL DEFAULT '',
    licence_expiry text,
    terms_agreed_at timestamptz,
    out_at timestamptz,
    out_odometer integer,
    out_fuel text NOT NULL DEFAULT '',
    out_notes text NOT NULL DEFAULT '',
    out_by integer REFERENCES users(id) ON DELETE SET NULL,
    back_at timestamptz,
    back_odometer integer,
    back_fuel text NOT NULL DEFAULT '',
    back_notes text NOT NULL DEFAULT '',
    back_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workshop_id, loan_car_id) REFERENCES loan_cars (workshop_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workshop_id, customer_id) REFERENCES customers (workshop_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workshop_id, job_id) REFERENCES jobs (workshop_id, id) ON DELETE SET NULL (job_id)
  );
  CREATE INDEX ON loans (workshop_id, loan_car_id, start_date);
  CREATE INDEX ON loans (job_id);
  ${rls('loans')}

  ALTER TABLE settings ADD COLUMN loan_terms text NOT NULL DEFAULT '';
  `,

  // 18: rego lookups, counted per workshop so the provider's charge can be passed on.
  `
  CREATE TABLE rego_lookups (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    rego text NOT NULL,
    state text NOT NULL DEFAULT '',
    provider text NOT NULL DEFAULT '',
    found boolean NOT NULL DEFAULT false,
    error text NOT NULL DEFAULT '',
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX ON rego_lookups (workshop_id, at);
  ${rls('rego_lookups')}
  `,

  // 19: customers paying invoices online, into the workshop's own Stripe account.
  `
  ALTER TABLE settings
    -- '', 'stripe' or 'test'.
    ADD COLUMN pay_provider text NOT NULL DEFAULT '',
    ADD COLUMN pay_stripe_key text NOT NULL DEFAULT '';

  CREATE TABLE online_payments (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${WS},
    document_id integer NOT NULL,
    provider text NOT NULL,
    session_id text NOT NULL UNIQUE,
    amount_cents integer NOT NULL,
    -- pending, paid or expired.
    status text NOT NULL DEFAULT 'pending',
    payment_id integer REFERENCES payments(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    paid_at timestamptz,
    FOREIGN KEY (workshop_id, document_id) REFERENCES documents (workshop_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ON online_payments (workshop_id, document_id, status);
  ${rls('online_payments')}
  `,

  // 20: asking happy customers for a Google review once their invoice is paid.
  `
  ALTER TABLE settings
    ADD COLUMN review_url text NOT NULL DEFAULT '',
    ADD COLUMN review_auto boolean NOT NULL DEFAULT false,
    ADD COLUMN review_message text NOT NULL DEFAULT '';
  ALTER TABLE documents
    ADD COLUMN review_requested_at timestamptz,
    ADD COLUMN review_via text;
  `,
];

async function migrate(pool) {
  const client = await pool.connect();
  try {
    // One app instance migrates at a time.
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = (await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')).rows[0].v;
    for (let v = done + 1; v <= MIGRATIONS.length; v++) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[v - 1]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

// A handle that runs queries as one workshop (or as no workshop for null).
function handleFor(client) {
  const h = {
    all: async (sql, params = []) => (await client.query(sql, params)).rows,
    get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
    run: async (sql, params = []) => client.query(sql, params),
    tx: async (fn) => fn(h), // already inside a transaction
  };
  return h;
}

function createStore(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX) || 10,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  });

  async function withClient(workshopId, fn) {
    const client = await pool.connect();
    try {
      // Set on every checkout, so a pooled connection never carries another workshop's id.
      await client.query(`SELECT set_config('app.workshop_id', $1, false)`, [workshopId ? String(workshopId) : '']);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  function tenant(workshopId) {
    return {
      workshopId,
      all: (sql, params = []) => withClient(workshopId, async (c) => (await c.query(sql, params)).rows),
      get: (sql, params = []) => withClient(workshopId, async (c) => (await c.query(sql, params)).rows[0]),
      run: (sql, params = []) => withClient(workshopId, (c) => c.query(sql, params)),
      tx: (fn) =>
        withClient(workshopId, async (c) => {
          await c.query('BEGIN');
          try {
            const out = await fn({ ...handleFor(c), workshopId });
            await c.query('COMMIT');
            return out;
          } catch (err) {
            await c.query('ROLLBACK');
            throw err;
          }
        }),
    };
  }

  return {
    pool,
    tenant,
    // For workshops and users, which sit outside the per-workshop tables.
    system: tenant(null),
    migrate: () => migrate(pool),
    close: () => pool.end(),
    async isSuperuser() {
      const r = await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
      return Boolean(r.rows[0] && r.rows[0].rolsuper);
    },
  };
}

// Takes the next number from this workshop's counter (invoice, quote, job or purchase order).
async function nextNumber(db, counter) {
  const col = { invoice: 'next_invoice_no', quote: 'next_quote_no', job: 'next_job_no', po: 'next_po_no' }[counter];
  const row = await db.get(`UPDATE settings SET ${col} = ${col} + 1 RETURNING ${col} - 1 AS n`);
  return row.n;
}

async function getLines(db, parent, id) {
  const col = parent === 'job' ? 'job_id' : 'document_id';
  return db.all(`SELECT * FROM line_items WHERE ${col} = $1 ORDER BY sort, id`, [id]);
}

async function saveLines(db, parent, id, lines) {
  const col = parent === 'job' ? 'job_id' : 'document_id';
  await db.run(`DELETE FROM line_items WHERE ${col} = $1`, [id]);
  for (const [i, l] of lines.entries()) {
    await db.run(
      `INSERT INTO line_items (${col}, kind, description, qty, unit_cents, gst, sort) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, l.kind, l.description, l.qty, l.unit_cents, Boolean(l.gst), i]
    );
  }
}

module.exports = { createStore, nextNumber, getLines, saveLines, TENANT_TABLES };
