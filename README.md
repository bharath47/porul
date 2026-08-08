# Porul — Personal Finance Dashboard

A **100% client-side** static web app that turns a folder of bank statements (PDF /
Excel / CSV) into filterable dashboards. Your financial data is read and analysed
**only in your browser** — nothing is ever uploaded to a server.

## Features

- **Bring your own folder** — pick a local folder, including a synced **OneDrive** or
  **Google Drive** folder, via the browser File System Access API. A
  `porul-data.json` file is written back into that folder so your categories,
  rules and settings persist between sessions.
- **Multi-format parsing** — CSV, Excel (`.xls`/`.xlsx`) and PDF. Includes tuned
  parsers for **AMEX**, **ANZ (NZ)** and **Kiwibank (NZ)** statements plus a generic
  fallback. PDFs are read with positional (x/y) text reconstruction, and ANZ/Kiwibank
  withdrawals vs. deposits are resolved by **running-balance reconciliation**
  (Kiwibank multi-line transaction details are merged, and loan/offset accounts with
  negative balances are handled).
- **Automatic categorisation** — a keyword rule engine ships with sensible NZ
  defaults (groceries, fuel, insurance, extracurriculars, etc.). Anything it can't
  classify appears in **Categorisation → Needs your input** for one-click assignment.
- **Custom categories & rules** — add your own (e.g. `EC-Violin`, `EC-UWH`,
  `School Fee`) and keyword rules. Manual assignments are remembered.
- **Duplicate detection** — the same transaction appearing across overlapping files
  (bank + account + date + amount + description) is detected and ignored in every
  total and chart. Toggle **Show duplicates** in Transactions to inspect them.
- **Global filters** — Bank, Account (Bank selection narrows Accounts), Date range
  (From/To month), a **Credit / Debit** type filter, and a **category** tray
  (Select all / Clear) that applies across *all* dashboards and tables.
  *Interbank Transfers* is excluded by default to avoid double-counting internal moves.
- **Dashboards** — spending over time, by category, top merchants, by bank/account,
  income vs. spending, and a category breakdown table, plus KPI cards.
- **Login + guest** — an on-device PIN profile (hashed with WebCrypto) or a guest
  session. On first sign-in you choose where to keep data: a local/synced-cloud
  folder, this browser, or load from a cloud link. This is a local access gate, not
  server authentication.
- **Backup/restore** — export or import all app data as JSON; export the filtered
  transactions as CSV.

## Run locally

Because it uses ES modules, serve it over HTTP (don't open `index.html` via `file://`):

```powershell
cd "Products/Personal Finance"
python -m http.server 5173
# then open http://localhost:5173
```

The File System Access API (folder picker + write-back) needs a Chromium-based
browser (Chrome/Edge). In other browsers, use **Add individual files**; data is then
saved in the browser (localStorage) or via **Export backup**.

## Quick start

1. Open the app and create a PIN profile (or continue as guest).
2. **Data Sources → Choose folder** and select your statements folder, e.g.
   `OneDrive/_Bharath/Finance/Statements`. Grant read/write when prompted.
3. Review the **Dashboard**; fix any items under **Categorisation**.
4. Click **💾 Save** to write `porul-data.json` into the folder.

## Deploy to Azure Static Web Apps

This folder is deploy-ready (`staticwebapp.config.json` included). App location `/`,
no build step, no API.

## Notes & limitations

- PDF layouts vary; AMEX PDFs are messy to extract — if you have the AMEX **CSV**
  activity export, prefer it (cleaner and de-duped against PDFs automatically).
  Always sanity-check the **Transactions** table after import.
- Direct OneDrive/Google Drive *API* sign-in is intentionally omitted to keep the app
  serverless and private; synced local folders cover the same need.

## Suggested future enhancements

Budgets & alerts per category, recurring-subscription detection, month-over-month
variance, net-worth tracking across accounts, savings-goal progress, CSV rule import,
multi-currency FX normalisation, and PDF statement-balance reconciliation warnings.
