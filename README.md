# Workshop

Simple workshop software for a one-person or small mechanic shop. It replaces the parts of Mechanic Desk most workshops use day to day.

- **Customers and vehicles**: rego, VIN, odometer, rego due date and next service, with full service history per car.
- **Diary**: week view of bookings. Press "Car's here: start job" to turn a booking into a job card.
- **Job cards**: work requested, mechanic's notes, labour and parts. Print a job card for the workshop floor.
- **Quotes**: convert to a job or straight to an invoice.
- **Tax invoices with GST**: ABN, GST breakdown, payments (EFTPOS, cash, transfer), balance owing, overdue tracking. Print or save as PDF.
- **Today screen**: today's bookings, cars in the workshop, unpaid invoices, and services or rego coming due.
- **Reports**: monthly sales, GST collected and payments received, plus a CSV export of invoices for your accountant or BAS.
- **Staff logins**: each person has their own email and password. Owners see reports and settings; staff do everything else. Assign a mechanic to each job.
- **Xero sync**: customers, invoices and payments are sent to Xero automatically. Edits, removed payments and voids follow.

Prices are entered **excluding GST**. GST is 10% of each taxable line, rounded per line the same way Xero does it (set GST to "No" on a line for GST-free items).

## Run it on your computer

Needs Node.js 20 or newer.

```bash
npm install
npm run seed     # optional: adds demo customers so you can try it
npm start        # http://localhost:3000
```

On first visit you create the owner account. The setup code is printed in the server log (or set your own with `SETUP_CODE`). Add staff under **Settings → Staff logins**.

## Put it online (about AU$12 a month)

The cheapest reliable option is [Render](https://render.com):

1. Push this folder to a GitHub repo.
2. In Render, choose **New → Blueprint** and pick the repo. It reads `render.yaml`.
3. When asked, set `SETUP_CODE` to any code you like and `APP_URL` to the address Render gives the service. Leave the Xero ones blank for now.
4. Open the site, enter the setup code, and create your owner login.

That creates a Starter web service (US$7/month) with a 1 GB disk (US$0.25/month) that holds the database, in the Singapore region (closest to Australia). Render takes a daily snapshot of the disk.

## Settings

| Variable | What it does | Default |
| --- | --- | --- |
| `SETUP_CODE` | Code needed to create the first (owner) login. | random, printed in the log |
| `SESSION_SECRET` | Secret for login cookies. | generated and stored in the database |
| `APP_URL` | The app's public address, used for the Xero redirect. | taken from the request |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | From your Xero app. Needed to connect Xero. | none |
| `DB_PATH` | Where the SQLite database file lives. | `data/workshop.db` |
| `TZ` | Timezone for "today", due dates and the diary. | `Australia/Sydney` |
| `PORT` | Port to listen on. | `3000` |

Business name, ABN, bank details, labour rate and the next invoice number are set in the app under **Settings**.

## Connecting Xero

1. Sign in at [developer.xero.com](https://developer.xero.com/app/manage) with your Xero login and create a **Web app** (it's free).
2. Set the redirect URI to `<APP_URL>/xero/callback`, for example `https://workshop-xxxx.onrender.com/xero/callback`.
3. Generate a client secret, then put the Client ID and secret in the server settings as `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`.
4. In the app, go to **Settings → Xero and add-ons → Connect to Xero**.
5. Set the account codes (labour, parts, and the bank account payments go into).

Sync is one way: the app sends to Xero and never reads back. Invoices made before connecting are only sent if you choose "Send older invoices", so invoices already in Xero from Mechanic Desk aren't duplicated.

## Backups

All data is in one file (`DB_PATH`). To back it up, copy that file while the app is stopped, or use `sqlite3 workshop.db ".backup backup.db"` while it runs.

## Development

```bash
npm run dev   # restarts on changes
npm test
```

Stack: Node.js, Express, EJS templates, SQLite (better-sqlite3). No build step.
