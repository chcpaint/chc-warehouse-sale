# Operations runbook: backups, restore drill, monitoring

Written 11 Nov 2026. Nothing here is automatic yet; each step has an owner and a
"done when". Facts about Supabase plans come from its backups documentation on
that date; re-check them before relying on a figure.

## 1. Know what you have

Open Supabase > Project Settings > Billing and write down the plan.

| Plan | Automatic backups (per Supabase docs) |
| --- | --- |
| Free | None. Export it yourself. |
| Pro | Daily, last 7 days kept |
| Team | Daily, last 14 days kept |
| Enterprise | Daily, up to 30 days kept |

Point-in-time recovery (PITR) is a paid add-on (7, 14 or 28 days). It restores to
a chosen second, and turning it on replaces the daily backups. Files in Supabase
Storage (uploaded invoices, promotion images, logos) are **not** in either kind of
backup; only their database rows are.

Proposed targets (change them, but write them down): lose no more than 15 minutes
of orders and stock movements; be back within 4 hours.
Only PITR can meet the first one.

Done when: the plan, PITR on or off, and the chosen targets are written at the top
of this file.

## 2. A copy that lives outside Supabase

A nightly logical dump to storage you control protects against a mistaken
project deletion (which also deletes Supabase's own backups).

    pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --file=chc-$(date +%F).dump

Run it from a scheduled job (GitHub Actions on a schedule, with `SUPABASE_DB_URL`
as a repository secret, or any server you own), keep 30 days, and copy the dump
to a bucket in a different account. The connection string is a credential: it
goes in a secret store, never in the repository.

Also copy the Storage buckets (the Supabase CLI or an S3-compatible client can
list and download them).

Done when: two nights of dumps exist off Supabase and one has been opened.

## 3. The restore drill (do this once, then every quarter)

Never practise on production. Restore to a **new** project.

1. Restore the latest backup (or a PITR time) into a new Supabase project.
2. Point a local copy of the console at it (copy `.env`, change the Supabase keys).
3. Sign in as a test shop and place a test order.
4. Check the stock ledger agrees with on-hand. Every row returned must be 0 (zero corrections needed):

       select public.recompute_inventory_on_hand(company_id)
         from public.companies;

   (Run it in the restored copy only; it rewrites on-hand from the ledger.)
5. Compare row counts of `orders`, `products`, `stock_movements`, `audit_log`
   between production and the restore, within the gap you expected.
6. Write down: minutes from "start" to "a shop can order", and anything surprising.

Done when: steps 1 to 6 are done once and the time taken is written here.

## 4. Watching it

- Uptime monitor on `https://chcsale.com/api/health/ready`. It answers 200 only
  when the server can reach the database, and 503 otherwise. Alert to digital@,
  not to a personal inbox.
- Every error response carries a `request_id`, also printed in the Railway log
  line for that request. Ask a user for it and search the log.
- On boot the server prints `CONFIG WARNING:` lines for weak or missing settings.
  A healthy boot prints none.
- Add an error tracker (Sentry or similar) next; not done yet.

## 5. Before any schema change

1. Run it on the staging project first (not created yet).
2. Take a manual backup the same day.
3. Run it in the SQL editor in one paste; the numbered files in `migrations/`
   are written to be safe to run twice.
