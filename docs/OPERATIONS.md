# Operations runbook: backups, restore, monitoring

Updated 11 Nov 2026.

## 1. What protects the data

| Layer | What | Where it lives | Kept |
| --- | --- | --- | --- |
| Supabase daily backups | Whole database, taken by Supabase (Pro plan) | Supabase | 7 days |
| Nightly off-site backup | Database (public schema, every app table, view, function, trigger, policy and row) **and every stored file** (invoices, images, logos, ShopSafe attachments), encrypted with AES-256 | GitHub (workflow artifact), plus an optional S3-compatible bucket in another account | 30 days |
| Nightly restore drill | The backup just taken is restored into a throwaway Postgres and every table's row count is checked against the count taken at backup time | GitHub Actions | every night |

Workflow: `.github/workflows/backup.yml` (2:17 a.m. Toronto). Scripts: `scripts/backup/`. Each night's drill result is recorded in `backup_runs` (migration 065) and shown in Reports > Uptime and on the Help page.

**Targets today:** lose at most one day of changes (recovery point), back within 4 hours (recovery time).
Supabase's point-in-time recovery add-on would cut the recovery point to minutes; it is about
US$100 a month for 7 days of history (Supabase pricing, Nov 2026). Decision: not enabled yet;
revisit when the first licensed distributor or a customer contract needs a tighter recovery point.

### One-time setup (repository secrets)

GitHub > the repository > Settings > Secrets and variables > Actions > New repository secret:

| Secret | Where to get it |
| --- | --- |
| `SUPABASE_DB_URL` | Supabase > Connect > **Session pooler** connection string, with the database password filled in. (The direct connection is IPv6-only and GitHub's runners cannot reach it.) |
| `SUPABASE_URL` | Supabase > Project Settings > API > Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase > Project Settings > API > `service_role` key |
| `BACKUP_PASSPHRASE` | Make a long random one (24+ characters). Keep a copy offline (password manager). **Without it no backup can be opened.** |

Optional second copy in another account (Cloudflare R2's free tier works): `BACKUP_S3_BUCKET`,
`BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`.

Then Actions > "Nightly backup and restore drill" > Run workflow, and confirm both jobs are green
and the summary says **Restore drill: PASSED**. In the GitHub mobile app, turn on notifications for
Actions so a failed night reaches you as a push.

### Restoring for real

Never restore over production. Restore into a **new** Supabase project, check it, then point the app at it.

1. Actions > the night you want > Artifacts: download `chc-backup-YYYY-MM-DD`.
2. Decrypt and unpack (Terminal):

       gpg --decrypt chc-backup-YYYY-MM-DD.tar.gz.gpg > backup.tar.gz
       mkdir restore && tar -xzf backup.tar.gz -C restore

3. Create a new Supabase project (same region), then:

       pg_restore --dbname="<new project's session pooler URL>" --no-owner --no-privileges --clean --if-exists restore/db.dump

4. Stored files: `SUPABASE_URL=<new> SUPABASE_SERVICE_ROLE_KEY=<new> node scripts/backup/storage.js upload restore/storage`
5. Re-create what is not in a backup: Supabase Vault secrets (the SendGrid key for uptime alerts) and
   migration 064's schedule (run `migrations/064_uptime_monitor.sql` again).
6. In Railway, change `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to the new project, and redeploy.
7. Sign in as a test shop, place a test order, and compare row counts with `restore/manifest.json`.

For losing recent minutes only (not the whole project), Supabase's own daily backups
(Project > Database > Backups) are quicker.

## 2. Watching it

| Check | How often | From | Alerts |
| --- | --- | --- | --- |
| Uptime monitor (migration 064) | every minute | inside Supabase (pg_cron + pg_net), separate from Railway | email via SendGrid to the alert list (default adam@chcpaint.com) and an optional Slack/Teams/Discord webhook, after 2 failures in a row; again on recovery |
| Watchdog (`.github/workflows/watchdog.yml`) | hourly | GitHub | a failed run (GitHub notification / mobile push) if the app is not ready or the monitor has stopped |

Pages watched: the health check (`/api/health/ready`, which answers 200 only when the app can reach
the database), the shop sign-in page, the admin console and the help page. Add or remove pages in
`public.uptime_targets`. Results: admin console > Reports > Uptime (24 h, 7 day and 30 day uptime, incidents,
alert list).

After running migration 064, add the SendGrid key to Vault once (SQL editor):

    select vault.create_secret('<SendGrid API key>', 'sendgrid_api_key', 'Uptime alert email');

The From address (`uptime_settings.from_email`, default promo@chcpaint.com) must be a verified sender in SendGrid.

Other signals:

- Every error response carries a `request_id`, also printed in the Railway log line for that request.
- On boot the server prints `CONFIG WARNING:` lines for weak or missing settings. A healthy boot prints none.
- Add an error tracker (Sentry or similar) next; not done yet.

## 3. Before any schema change

1. Run it on the staging project first (not created yet).
2. Run the backup workflow by hand the same day (Actions > Run workflow).
3. Run it in the SQL editor in one paste; the numbered files in `migrations/`
   are written to be safe to run twice.
