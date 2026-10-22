# Bay Boss

Bay Boss is workshop software for mechanics, built to be sold to many workshops on one shared system. Each workshop signs up, gets its own logins, and only ever sees its own data.

## What it does

- **Customers and vehicles**: rego, VIN, odometer, rego due date and next service, with full service history per car. Vehicles can change hands, keeping who owned them when. Both lists have search, filters (owing, companies, individuals, deleted; rego or service due), tags, sort and CSV download. Deleting a customer archives them and they can be restored.
- **Invoices and estimates lists**: search, date range, status filters, sort, CSV download and bulk actions (mark sent, void, download).
- **Diary and calendar**: week view of bookings, and a month calendar showing bookings, jobs spanning the days they're in the workshop, staff leave, public holidays, toolbox talks and notes, colour coded. Press "Car's here: start job" to turn a booking into a job card.
- **Job cards**: work requested, mechanic's notes, assigned mechanic, priority and promised time, labour and parts. Print a job card for the floor. A list view sorted by what's promised soonest, a board view by status, and a "My jobs" tab.
- **Inspection checklist**: a workshop-wide checklist (set under Settings) added to any job, marked OK / needs attention / urgent with notes, and printed as a customer-facing inspection report.
- **Time clock**: staff clock on and off jobs or add time by hand; unbilled time becomes a labour line in quarter hours at the workshop rate. Owners see weekly timesheets.
- **Activity log**: every status change, assignment, clock on/off, invoice and note on a job, with who and when.
- **Price list**: saved parts and services with codes and prices, dropped onto any job, estimate or invoice from a search box in the line editor.
- **Parts ordering**: suppliers (Burson, Repco, Capricorn or your local shop) with their trade price files imported from CSV or Excel, a parts search, purchase orders started from the parts on a job card, and receiving that puts parts onto the job or into stock. Low stock makes reorder drafts. The job goes to "Waiting on parts" when ordered and back to "In progress" when everything has arrived.
- **Import from other software**: bring customers, their vehicles, and parts with stock levels across from MechanicDesk, Workshop Software, Auxo or any spreadsheet (CSV or Excel). Columns are matched automatically, then checked row by row before anything is saved, with duplicates found by phone, email or rego.
- **Reminders**: service intervals per vehicle (months and km) set the next service due when a service is invoiced. A Reminders page lists service and rego due or overdue with call, text and email links and a log of who was contacted.
- **Estimates**: convert to a job or straight to an invoice.
- **Your look**: upload your logo, set a brand colour, tagline, website and licence number, then pick one of ten invoice designs and ten job card designs under Settings. Previews show your own details.
- **Tax invoices with GST**: ABN, GST breakdown, payments, balance owing, overdue tracking. Print or save as PDF.
- **Today screen**: today's bookings, cars in the workshop, unpaid invoices, and services or rego coming due.
- **Send to customer**: every estimate and invoice has a private link the customer can open without logging in; estimates can be accepted online. Email and text buttons open your own apps with the message filled in, or set up Resend (below) to email straight from the app.
- **Reports**: monthly sales, GST collected and payments received; who owes you by how overdue; BAS quarter figures (G1 and 1A); sales and hours by mechanic; top customers; printable customer statements; and a CSV export for the accountant.
- **Clocking and roster**: staff start their shift, take breaks and finish from the Today screen or the Clocking page; owners see who's in now and shift hours on the timesheets. A weekly roster with shifts, days off, RDOs and leave, with "my next shift" on the Today screen.
- **Team**: a to-do chat for the team, step-by-step procedures (how we do things, with a print button), and training modules worth points with a points board.
- **Staff logins**: each person has their own email and password. Owners see reports and settings and manage staff; staff do everything else.
- **Xero sync**: customers, invoices and payments are sent to the workshop's own Xero automatically. Edits, removed payments and voids follow.
- **Many workshops**: self-serve sign-up, per-workshop settings, numbering and timezone.
- **Subscriptions**: 14-day free trial, then a monthly plan paid through Stripe. Workshops that stop paying are locked (never deleted) until they subscribe again.

Prices are entered **excluding GST**. GST is 10% of each taxable line, rounded per line the same way Xero does it (set GST to "No" on a line for GST-free items).

## How workshops are kept apart

All workshops share one Postgres database. Every row carries a `workshop_id`, and Postgres **row-level security** only lets a connection see rows for the workshop it is acting for. The app sets that workshop on every database connection from the logged-in user, so even a query that forgot a `WHERE` clause can't return another workshop's data. Links between records (a vehicle's customer, an invoice's job) are checked by the database to belong to the same workshop. `test/tenancy.test.js` tries to read and change one workshop's records from another and checks every attempt fails.

The app must connect as an ordinary database user, not a superuser: Postgres lets superusers bypass row-level security. The app warns at startup if it is connected as one.

## Run it on your computer

Needs Node.js 20+ and Postgres 15+.

```bash
npm install
createdb workshop
export DATABASE_URL=postgres://localhost/workshop
npm run seed     # optional: a demo workshop, log in as demo@example.com / demo-password
npm start        # http://localhost:3000
```

Open `/signup` to create a workshop.

## Put it online (about US$13 a month to start)

[Render](https://render.com) is the simplest:

1. Push this folder to a GitHub repo.
2. In Render choose **New → Blueprint** and pick the repo. It reads `render.yaml` and creates a Starter web service (US$7/month) and a Basic Postgres database (about US$6/month) in Singapore, the closest region to Australia.
3. Set `APP_URL` to the address Render gives the service. Set `SIGNUP_CODE` if you want to control who can sign up while you're testing.

That comfortably runs dozens of workshops. As you grow, move the database to a bigger plan and run more than one web instance; the app keeps no state in memory that matters between requests.

## Settings

| Variable | What it does | Default |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string. | required |
| `SESSION_SECRET` | Secret for login cookies. | required in production |
| `APP_URL` | The app's public address, used for the Xero redirect. | taken from the request |
| `SIGNUP_CODE` | If set, sign-up needs this code. | open sign-up |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | From your Xero app. Needed for any workshop to connect Xero. | none |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Turn on subscription billing (see below). Without them every workshop is free. | none |
| `PLAN_PRICE_LABEL` | Shown on the Subscribe button, e.g. `$49/month`. | none |
| `RESEND_API_KEY`, `EMAIL_FROM` | Send estimates and invoices by email through [Resend](https://resend.com). `EMAIL_FROM` is the sender, e.g. `Bay Boss <invoices@yourdomain.com.au>`, on a domain verified in Resend. Replies go to each workshop's own email. | email buttons open the user's own mail app |
| `PGSSL` | Set to `require` if your database needs SSL from outside its network. | off |
| `PORT` | Port to listen on. | `3000` |

Each workshop sets its business name, ABN, bank details, labour rate, timezone and next invoice number under **Settings**.

## Charging workshops (Stripe)

1. Create a [Stripe](https://stripe.com) account and, under **Product catalogue**, add a product with a recurring monthly price (say AU$49). Copy the price id (`price_...`).
2. Under **Developers → Webhooks**, add an endpoint for `<APP_URL>/stripe/webhook` with these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Copy its signing secret (`whsec_...`).
3. Under **Settings → Billing → Customer portal**, turn the portal on so owners can change cards and cancel.
4. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` and `PLAN_PRICE_LABEL` on the server.

Every new workshop gets a 14-day trial. The owner subscribes under **Settings → Plan and billing**; whatever is left of the trial carries over, so the card isn't charged until it ends. If a payment fails, Stripe retries and the workshop stays open for 7 days. A cancelled or lapsed workshop is locked, with the owner sent to the billing page and staff shown a notice. Nothing is deleted.

To give a workshop free use (your own, or a mate's), set its `status` to `comped` in the `workshops` table.

## Connecting Xero

One Xero app serves every workshop; each workshop connects its own Xero organisation.

1. Sign in at [developer.xero.com](https://developer.xero.com/app/manage) and create a **Web app** (free).
2. Set the redirect URI to `<APP_URL>/xero/callback`.
3. Put the Client ID and a client secret in the server settings as `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`.
4. In the app, a workshop owner goes to **Settings → Xero and add-ons → Connect to Xero** and sets the account codes.

Xero limits an uncertified app to 25 connected organisations. Before more than 25 workshops use Xero, apply to the [Xero App Partner program](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/app-partner-steps/).

Sync is one way: the app sends to Xero and never reads back. Invoices made before connecting are only sent if the owner chooses "Send older invoices", so invoices already in Xero aren't duplicated.

## Importing from other workshop software

Settings → **Import from other software** (or Import on the Customers and Price list pages). Four steps: upload, match columns, check, import. Nothing is saved until the last step, and each step re-reads the uploaded file rather than storing it.

- **Files**: CSV (comma, tab or semicolon), Excel `.xlsx`, and the HTML-table or Excel-XML files some systems save as `.xls`. Old binary `.xls` files need saving as `.xlsx` or CSV first. A title row above the column names is skipped.
- **Customers and vehicles** come from one spreadsheet (a row per customer or per car), from two linked files (customers and vehicles sharing a customer ID, the way Workshop Software and Auxo export them), or from one workbook with a sheet for each.
- **Duplicates**: a row matches an existing customer on mobile/phone (ignoring spaces and +61), email, or a rego already on file. Matches keep their details; only blanks are filled in, and cars already on file aren't added again. Repeats inside the file are merged. Running the same file twice adds nothing.
- **Parts** go into the price list, matched on part number then description, with cost, sell (taking GST off when the file includes it), stock on hand, reorder level and supplier (new suppliers are created by name). Supplier price files share the same reader and part saving.
- **Known layouts** live in `lib/importer.js` (`SOURCES`). Workshop Software and Auxo columns come from their published import templates. MechanicDesk doesn't publish its export columns, so its preset is a best guess until we see a real export; anything not recognised is mapped by hand on the columns step.

Sample files for trying it are in `docs/samples/import/`.

## Parts suppliers (Burson, Repco)

Burson (EzyParts) and Repco (Navigator Pro) don't publish open APIs. Workshop software links to them as an approved partner: the mechanic opens the supplier's catalogue from the job, already filtered to the car, picks parts, and they come back to the job; orders go through electronically and supplier invoices can download automatically. Each workshop then enters its own trade login.

Until this software is approved, suppliers work by hand: import their price file, order from the job, then email, print or phone the order through. Each supplier names a connector in `lib/suppliers.js`; the Burson and Repco ones already save the workshop's login. Once a supplier gives partner access, write its `search`, `placeOrder`, `punchoutUrl` and `parseReturn` there and set `live: true`. Nothing else in the app changes. To apply: Burson EzyParts on ezyparts@burson.com.au or 1300 733 849; for Repco ask your trade rep for the Navigator Pro integration team.

## Development

Tests need a Postgres the test user can create databases on. Each test file makes and drops its own database.

```bash
export TEST_DATABASE_URL=postgres://workshop:workshop@localhost:5432/workshop   # user needs CREATEDB, not superuser
npm test
```

Stack: Node.js, Express, EJS templates, Postgres (`pg`). No build step.
