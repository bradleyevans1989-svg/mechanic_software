# Workshop

Simple workshop software for a one-person or small mechanic shop. It replaces the parts of Mechanic Desk most workshops use day to day.

- **Customers and vehicles**: rego, VIN, odometer, rego due date and next service, with full service history per car.
- **Diary**: week view of bookings. Press "Car's here: start job" to turn a booking into a job card.
- **Job cards**: work requested, mechanic's notes, labour and parts. Print a job card for the workshop floor.
- **Quotes**: convert to a job or straight to an invoice.
- **Tax invoices with GST**: ABN, GST breakdown, payments (EFTPOS, cash, transfer), balance owing, overdue tracking. Print or save as PDF.
- **Today screen**: today's bookings, cars in the workshop, unpaid invoices, and services or rego coming due.
- **Reports**: monthly sales, GST collected and payments received, plus a CSV export of invoices for your accountant or BAS.

Prices are entered **excluding GST**; GST is 10% of the taxable lines (untick GST on a line for GST-free items).

## Run it on your computer

Needs Node.js 20 or newer.

```bash
npm install
npm run seed     # optional: adds demo customers so you can try it
npm start        # http://localhost:3000
```

Set a password before putting it online:

```bash
APP_PASSWORD=choose-a-password npm start
```

## Put it online (about AU$12 a month)

The cheapest reliable option is [Render](https://render.com):

1. Push this folder to a GitHub repo.
2. In Render, choose **New → Blueprint** and pick the repo. It reads `render.yaml`.
3. When asked, set `APP_PASSWORD` to the password you'll log in with.

That creates a Starter web service (US$7/month) with a 1 GB disk (US$0.25/month) that holds the database, in the Singapore region (closest to Australia). Render takes a daily snapshot of the disk.

## Settings

| Variable | What it does | Default |
| --- | --- | --- |
| `APP_PASSWORD` | Password to log in. Without it the app is open to anyone. | none |
| `SESSION_SECRET` | Extra secret for login cookies. | none |
| `DB_PATH` | Where the SQLite database file lives. | `data/workshop.db` |
| `TZ` | Timezone for "today", due dates and the diary. | `Australia/Sydney` |
| `PORT` | Port to listen on. | `3000` |

Business name, ABN, bank details, labour rate and the next invoice number are set in the app under **Settings**.

## Backups

All data is in one file (`DB_PATH`). To back it up, copy that file while the app is stopped, or use `sqlite3 workshop.db ".backup backup.db"` while it runs.

## Development

```bash
npm run dev   # restarts on changes
npm test
```

Stack: Node.js, Express, EJS templates, SQLite (better-sqlite3). No build step.
