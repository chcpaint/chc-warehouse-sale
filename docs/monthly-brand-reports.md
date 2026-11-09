# Monthly brand sales reports

A monthly report of how much of one brand a customer bought: units, dollars and
an item-by-item breakdown, with the year to date rolled up. The first one is
**Assured, brand 3M**. It is built automatically on the 1st of every month and
downloaded from **Reports > Monthly brand** in the admin console, as Excel or PDF.

It reads orders and writes its own report tables. It never changes an order, a
catalogue, a price, or any company setting, and it has nothing to do with how a
customer signs in (including the Assured access-code flow).

## What counts as a sale

| Rule | Detail |
|---|---|
| Which orders | Out for Delivery or Closed. Pending and Cancelled are never counted. |
| Which date | When it **shipped**, from the order's status history, in Toronto time. An order placed on the 30th and shipped on the 2nd is next month's sale. |
| Partial shipments | Counted for what actually went out. The shipped part counts in the month it shipped; the backordered part counts in the month it later ships. Never twice, never early. |
| Which lines | The brand frozen on the order line. Older lines fall back to the product's brand, then to the part number (`MMM#####`) or a name starting "3M". |
| Dollars | Quantity x the price on the order, before tax, delivery fee and fuel surcharge. |
| Unpriced lines | A line still "price on request" counts its units, not dollars. The report states how many units have no price rather than understating the total quietly. |

## What each file contains

Excel: **Summary**, **Items** (item #, description, category, units, dollars,
average price, orders), **By location**, **Orders**, **Year to date** (a row per
month, then the item breakdown for the year). PDF: a summary and item page, then
a year-to-date page.

The year to date is January through the report month, built by adding the saved
months together.

## When it runs

The app's own scheduler (`utils/scheduler.js`, job `brand_reports`), from
**6 a.m. Toronto time on the 1st**, for the month that just ended. It is also its
own catch-up: if the app was down on the 1st, it runs when the app is next up,
because the work is "is last month saved yet?", not "is it exactly the 1st?".

* When everything is saved a tick costs two small reads and claims nothing.
* When something is missing, one instance per hour wins the claim
  (`scheduler_runs`), so a failure is retried hourly and two instances cannot
  both build the month.
* Missing earlier months of the same year are filled in too, so the year to
  date is complete from the first run.

## Saved months do not move

Every finished month is stored as a snapshot (`monthly_brand_reports.data`) and
the files are rendered from it. A re-download next year is identical to the
first. The month in progress is built live each time and is labelled **month to
date** in the file name and the report; it is never stored.

A super admin can **Rebuild** a finished month (for example after correcting an
order). That replaces the snapshot and is recorded in the audit log, as is every
download.

## Who can use it

| Role | Access |
|---|---|
| Super admin | Every report, download, rebuild |
| Company admin | Their own company's report: list and download only |
| Order desk, order manager, sales director | None (not on the allow-list) |

## Setting it up for another customer or brand

One row in `brand_report_subscriptions` (its own table, deliberately not a
company setting):

```sql
insert into brand_report_subscriptions (company_id, brand)
values ('<company id>', 'PPG');
```

The brand matches the brand on the order lines. The report appears under
Reports > Monthly brand and is built on the next 1st (or use "Build ... now").

## Files

* `migrations/056_monthly_brand_reports.sql` - the two tables; seeds Assured/3M only if exactly one company is named Assured
* `utils/brand-sales-report.js` - counting rules, year-to-date roll-up, Excel and PDF
* `utils/brand-report-data.js` - loading orders, saving snapshots, the scheduled run
* `routes/brand-reports-admin.js` - list, preview, download, rebuild
* `utils/scheduler.js` - `monthlyBrandReportJob`
* `admin/index.html` - Reports > Monthly brand
* `tests/brand-sales-report.test.js` - 29 tests
