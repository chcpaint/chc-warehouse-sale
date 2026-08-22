# refinishAI Inventory — phases 1–5

The inventory half of the CHC sales console. Everything in this `_deploy` folder
is ready to push. This note covers what is already applied to the database, what
needs a decision, and how the two halves stay separable.

---

## Is it one product or two?

Both, deliberately.

**Separable.** Inventory is off for every company until switched on. With it off:
the Inventory tab never appears, `public/refinishai-inventory.js` is never
fetched, no inventory markup reaches the DOM, and every inventory endpoint
returns 403. The server code lives in six files of its own, mounted by one line
each in `routes/storefront.js` and `routes/admin.js` — delete those two lines and
you have the ordering portal exactly as it was. A customer who only wants to
order downloads none of it.

**Connected.** An approved reorder becomes a real CHC order through the same
path as a hand-placed one: server-side pricing, active promotions with the same
precedence, branch routing by `supplier_branch_id`, the standard notification
email. The console's order history refreshes when one is raised.

The handshake is four things:

```
RAI.init(ctx) -> boolean    ctx = { apiBase, slug, settings, mount,
                                    getToken(), getLocation(), getCompany(),
                                    onOrderPlaced() }
RAI.show()                  the console switched to the Inventory tab
RAI.teardown()              the console left the tab, or logged out
```

Nothing else in the console depends on anything in the module.

---

## Already applied to the database (no action needed)

Six migrations, live on the CHC Sale Site project (`wfarxetqbjzeqjqvlzgp`):

| Migration | What it does |
|---|---|
| `inventory_hardening_columns_and_constraints` | Actor identity on the ledger, the link from a replenishment to its CHC order, snapshot columns, uniqueness, indexes, the `inventory_uploads` audit table |
| `inventory_ledger_triggers_and_recompute` | The trigger keeping `on_hand` equal to the running sum of the ledger; the append-only rule; `recompute_inventory_on_hand()` |
| `inventory_rls_and_status_view` | RLS lockdown and the `inventory_status` view |
| `refinishai_inventory_phase4_counts_transfers_labels` | Count sessions, count lines, transfers, the internal-label flag |
| `refinishai_inventory_phase5_consumption_analytics` | The two consumption views, their indexes, the alert log |
| `refinishai_inventory_harden_trigger_functions` | Advisor follow-ups (see Security) |

`migrations/012`, `013` and `014` are the same thing as idempotent files, kept so
the repo history matches the database.

Everything was verified against the real schema inside transactions that were
rolled back — no test rows survive. Verified: on-hand tracks the ledger exactly
including fractional units; the ledger refuses edits; zero and unknown movement
types are rejected; `recompute` repairs deliberate corruption; one open reorder
queue and one open count per location are enforced; a count line upserts rather
than duplicating; a negative count is refused; a transfer's two legs net to
zero; a self-transfer is refused; the by-job view values consumption correctly;
and deleting a product still cascades cleanly through every new table.

---

## Files in this push

| File | Status | Notes |
|---|---|---|
| `migrations/012_inventory_hardening.sql` | new | Applied; keep for history |
| `migrations/013_refinishai_inventory_phase4.sql` | new | Applied; keep for history |
| `migrations/014_refinishai_inventory_phase5.sql` | new | Applied; keep for history |
| `utils/inventory.js` | new | Barcodes, master-file parsing, movement maths, reorder logic |
| `utils/barcode-128.js` | new | Code 128 encoder → SVG, no dependency |
| `utils/email.js` | **modified** | Adds `sendLowStockAlert` |
| `routes/inventory-store.js` | new | Shop-floor API |
| `routes/inventory-counts.js` | new | Cycle counts and transfers |
| `routes/inventory-analytics.js` | new | Consumption analytics |
| `routes/inventory-admin.js` | new | CHC-side administration |
| `routes/inventory-labels.js` | new | Internal codes and printable cards |
| `routes/storefront.js` | **modified** | One line mounting the store sub-router |
| `routes/admin.js` | **modified** | One line mounting the admin sub-router |
| `public/refinishai-inventory.js` | new | The whole front end, loaded on demand |
| `public/refinishai-inventory-sw.js` | new | Service worker for home-screen install |
| `public/assets/refinishai-*.png` | new | Logo, mark and home-screen icon |
| `public/store.html` | **modified** | Nav tab, PWA meta, ~60-line loader |
| `tests/` | new | 132 tests |

**No change to `server.js` was needed.**

`store.html` grew by about 4 KB, not 57 KB: the tab markup and behaviour live in
the module file, which only companies with inventory ever download.

### Running the tests

```
node --test tests/          # 118 unit + HTTP tests
node tests/browser-smoke.js # 14 real-Chromium tests
```

The built-in Node runner, so there is no framework to add. The HTTP tests need
`supertest` and the browser tests need `playwright`, both dev-only; `express` is
already there. `tests/inventory.test.js` needs nothing and runs standalone.

---

## Turning it on for a customer

```
PUT /api/admin/companies/<companyId>/inventory/settings
{ "enabled": true }
```

or directly:

```sql
update companies
   set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{inventory}',
       '{"enabled":true,"auto_draft":true,"require_approval":true,"allow_negative":false}'::jsonb, true)
 where slug = 'assured';
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Shows the Inventory tab; without it every endpoint returns 403 |
| `auto_draft` | `true` | Queue a reorder line automatically when stock hits its minimum |
| `require_approval` | `true` | A manager approves before it becomes a CHC order |
| `allow_negative` | `false` | Block consuming more than is on hand |
| `scan_sound` | `true` | Beep on a successful scan |
| `alert_emails` | `[]` | Extra recipients for low-stock digests |

**There is no toggle in the admin UI yet** — only this endpoint and the SQL. The
console's admin HTML is not in `_deploy`; add it and the switch can go in.

---

## Seeding the master file

```
POST /api/admin/companies/<companyId>/inventory/master-upload
  multipart: catalog=<file>
  mode=master|seed   location_id=<uuid>  (seed only)   dry_run=1
```

Always send `dry_run=1` first — same response shape, nothing written.

**Why this does not reuse the existing catalogue importer.** The importer in
`routes/admin.js` maps columns by name, and the CHC master file uses headers it
does not recognise: `Item Number (Part #)`, `MSRP (Selling Price)` and
`Product Category` all fall through it. Pushing the file through that path would
import 883 rows with no part number, no price and no category.

### What the real file contains

Parsed against all 883 rows of *CHC Product Database for Skyline 9*:

| | |
|---|---|
| Rows parsed cleanly | **881** |
| Rejected | **2** — rows 877 and 884 have no item name (blank rows) |
| Duplicate part numbers | 0 |
| Rows with a UPC | 565 of 881 (64%) |
| Rows with no case quantity | 448 (51%) |
| Rows with no category | 118 (13%) |

Two data issues worth a decision before seeding:

1. **25 UPCs fail their GS1 check digit.** The importer zero-pads and re-tests
   first (Excel silently drops a leading zero from a numeric UPC column), but
   these fail at every length — typos or private supplier codes, not truncation.
   They import and remain scannable, and come back in `invalid_check_digits`.
   Examples: `ACM708-05` → `06383758783`, `DSSSEP1` → `64678695330`,
   `MMM07194` → `051131071945`.

2. **11 barcodes are shared by more than one part number** — `0096619321841` is
   on both `ACM704-05` and `PRF225`; `0699962077924` on both `DEX403` and
   `DEX412`. A scan of one cannot resolve to a single item, so the API returns
   HTTP 300 with the candidates and the shop floor picks. That is the right
   behaviour, but it is friction on eleven items — if they are genuine
   duplicates, cleaning the file beats living with the prompt.

---

## What each phase gives you

### Phase 1–2 — scan, consume, reorder

Scan-to-consume with a USB or Bluetooth scanner or a phone camera, per-location
on-hand, min/reorder/max points, and auto-drafted replenishment into a
single approval queue per location. Approving raises a real CHC order.

**Keyboard-wedge scanners** work with nothing installed: commodity scanners type
the digits fast and press Enter, and the listener tells that apart from human
typing by the gap between keystrokes (45 ms), so a technician can scan anywhere
on the tab without clicking into a field first.

**Phone camera** uses the browser's native `BarcodeDetector` where it exists
(Chrome, Android). Safari on iOS and iPadOS has no such API, so it falls back to
the `html5-qrcode` WASM decoder, loaded from cdnjs only when that path is taken.

A scan matches whatever form the catalogue stored: a UPC-A off a box finds the
same item recorded as EAN-13, zero-stripped, or padded to GTIN-14. Codes are
stored canonically as 13-digit EAN so one physical barcode never occupies two
rows. A typed or shelf-label part number resolves through the same box.

### Phase 3 — mobile

The tab is responsive and installs on a phone home screen. The manifest is
generated at runtime because `start_url` depends on the company slug; iOS reads
the `apple-mobile-web-app-*` meta tags instead. The service worker is
network-first — a cache-first worker on a live ordering portal would have
technicians looking at yesterday's prices after a deploy — and never caches API
responses, because stale stock levels are worse than none.

This assumes `express.static` serves `public/` at the site root. If not,
`/refinishai-inventory.js` will 404 and the tab simply never appears; if only the
service worker 404s, everything works except home-screen install.

### Phase 4 — counts, transfers, labels, governance

**Cycle counts** are sessions. Staff count a shelf, a category or a bin at their
own pace; nothing touches stock until a supervisor commits. Two details worth
knowing:

- The commit measures against on-hand **at commit time**, not at count time, so
  material that legitimately moved mid-count is not silently reversed.
- Only genuine variances post a movement, so the ledger shows what was actually
  wrong rather than a wall of no-op rows.

One open count per location, enforced by a partial unique index. Cancelling
requires a reason and changes no stock.

**Transfers** write two ledger rows that must agree, plus a header so a
controller sees one event rather than an unexplained loss at one shop and gain at
another. If the inbound leg fails, the outbound leg is reversed with a
compensating movement — the ledger is append-only, so the failed attempt stays
visible rather than being deleted.

**Internal barcodes.** 316 of the 881 master-file items carry no manufacturer
UPC. `POST .../inventory/labels/generate` mints a Code 128 for each, derived from
the part number rather than random, so a label that falls off a shelf can be
regenerated identically and a human can read the code and know what it is.
Idempotent — safe to re-run after every catalogue update.

**Printable cards** at `GET .../inventory/labels/sheet?format=shelf|reorder`.
Self-contained HTML with a print stylesheet, no CDN, so it prints from a shop
computer with no internet. `reorder` produces the scan-to-reorder card in the
spirit of PPG's ColorVision cards.

The Code 128 encoder is `utils/barcode-128.js` — no dependency, because a
barcode is a table lookup and pulling in a package to draw rectangles is not
worth the supply-chain surface on something a scanner has to read first time,
every time. Set C packs digit pairs, so a numeric SKU prints about half the
width.

**Catalog governance** at `POST .../inventory/govern` constrains a company to a
named SKU set: anything active that is not on the list is deactivated, never
deleted, because a product with order or ledger history has to stay resolvable
for reporting.

### Phase 5 — consumption analytics and alerts

The interesting number in a collision shop is not what is on the shelf, it is
what a repair order consumed. Every consume movement can carry a job / RO
reference, so materials cost per job falls straight out of the ledger.

`GET .../inventory/analytics/summary | by-product | by-job | by-location | export`
— period vocabulary matching the console's Reports tab. The Usage view shows a
daily bar chart (inline SVG, no charting library for one series of one number),
top items by value, and materials per job.

**Low-stock digests** at `POST .../inventory/alerts/low-stock`. One email per
company covering every location — a three-site group otherwise gets three emails
every morning and starts ignoring all of them. The send is fingerprinted, so a
scheduler that fires twice, or a retry after a transient failure, does not send
the same list again within 20 hours; pass `force` to override.

There is no scheduler in the stack today. Wire it to whatever runs the host —
for example a daily cron hitting the endpoint with an admin session:

```
0 12 * * 1-5   # 08:00 America/Toronto
```

`dry_run: true` returns the recipient list and item count without sending.

---

## Design decisions worth knowing about

**On-hand is derived, not stored independently.** A database trigger maintains
`inventory_levels.on_hand` as the running sum of the ledger and stamps the
resulting balance onto each movement. A crashed request cannot leave the two
disagreeing, and every movement carries its own balance-after for an auditor.
`recompute_inventory_on_hand()` rebuilds from the ledger if anything ever edits
the table by hand.

**The ledger refuses edits, but allows deletes.** A posted movement is never
changed — a mistake is corrected with an offsetting `adjust`, so both stay
visible. Deletes stay open because products and companies cascade into this
table and the console hard-deletes products; blocking deletes would make product
deletion fail for any SKU with movement history. Those deletions are deliberate
admin actions and are already recorded in `audit_log`.

**Who did it.** Storefront sessions authenticate with a company access code and
carry no user identity, so `created_by uuid` cannot be filled from the shop
floor. Every write takes an `actor_label` — the technician's name, remembered in
the browser — and is refused without one. That is what makes the audit trail
mean anything.

**Ambiguous scans ask.** With 11 shared barcodes in the real file, silently
picking the first match would quietly decrement the wrong item.

**Rejections need a reason,** matching how the CRM handles archiving.

---

## Security notes

- Every route re-applies its own auth guard rather than trusting the parent
  router, so no file can be remounted somewhere less protected.
- Location and product are re-resolved against the authenticated company before
  any write; a client-supplied location or product from another tenant is
  rejected, not queried. Tested explicitly, including cross-tenant approval and
  cross-tenant transfer attempts.
- Prices for an approved replenishment come from the server, never the request.
- All inventory tables have RLS enabled with no permissive policy. Access is
  exclusively through the service-role key in the Express layer, so a leaked
  anon key reads nothing. The `inventory_status` and `inventory_consumption_*`
  views are `security_invoker` so they cannot be used to step around that.
- The two trigger functions had their `search_path` pinned and `EXECUTE` revoked
  from `anon`/`authenticated`, closing two Supabase advisor findings. Verified
  the triggers still fire afterwards.
- CSV exports neutralise leading `=`, `+`, `-` and `@` so an item name cannot
  become a formula in Excel.
- Free-text fields are stripped of HTML and length-capped before storage.
- The label sheet escapes every interpolated value; the barcode SVG escapes its
  human-readable line.

### One thing to fix that is not mine

Supabase still reports four tables with **RLS disabled** — fully readable and
writable by anyone holding the anon key:

```
public.orders_backup_assured_20260615
public.products_category_backup_20260615
public.products_backup_assured_20260715
public.products_backup_removed_20260721
```

Backup copies of real order and product data from June and July. I have not
touched them: enabling RLS without policies would block whatever still reads
them, and dropping them is your call.

```sql
-- check first
select count(*) from public.orders_backup_assured_20260615;

-- then either drop them
drop table public.orders_backup_assured_20260615;
drop table public.products_category_backup_20260615;
drop table public.products_backup_assured_20260715;
drop table public.products_backup_removed_20260721;

-- or keep them and close the hole (no policy = service role only)
alter table public.orders_backup_assured_20260615 enable row level security;
-- repeat for the other three
```

---

## Not built

- **Integration hooks to mixing systems and body-shop management software.** An
  outbound webhook is the obvious shape, but pointing a server at a
  customer-supplied URL is a server-side request forgery hole unless it is built
  with an allowlist, https-only, private-IP blocking and a signed payload. That
  is a piece of work in its own right and I would rather scope it deliberately
  than bolt it on. Today the integration surface is the read APIs and CSV
  exports, which cover a nightly pull.
- **The STRICH SDK upgrade**, which the design doc rightly makes conditional on
  the free decoder disappointing on worn labels. Worth measuring before buying.
- **An admin-UI toggle**, blocked only on the console's admin HTML file.
