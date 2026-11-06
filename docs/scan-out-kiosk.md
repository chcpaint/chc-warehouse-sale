# Scan-out kiosk

A tablet at the stock room or cage where painters and bodymen scan an ID badge,
scan what they take, and confirm. No login on the tablet, and nothing else in
the console is reachable from it.

## How it works

1. CHC turns on the **Scan-out kiosk** module for a company (Modules screen; needs
   refinishAI Inventory).
2. In **Set up the scan-out kiosk**: add the people (name, optional trade), print
   their ID badges, and add a tablet. Each tablet gets a private link, shown once.
3. Open the link on the tablet and bookmark it. USB scanners work as a keyboard:
   set the scanner to send Enter after each scan.
4. A person scans their badge, scans items (rescan = +1, or use the +/- buttons),
   then taps **Confirm & Done** or scans their own badge again.
5. An unconfirmed session clears itself after a quiet spell (default 60 s) so the
   next person never inherits a basket.

## Turning the ID scan off

**Ask people to scan their ID badge first** is a per-company switch. Off: the
tablet goes straight to scanning and records only the tablet. If someone does
scan a badge anyway, it is still recorded.

## What gets recorded

Each line is a `consume` movement in the stock ledger (`stock_movements`):
`actor_type = 'kiosk'`, `actor_label` = the person (or `Kiosk — <tablet>`),
`badge_id`, `kiosk_device_id`, and `source_doc_id` = the scan session. Stock on
hand, reorder drafting and reports work exactly as for any other consume.

## Security model

- The tablet's link carries a 256-bit secret. Only its SHA-256 hash is stored.
- The kiosk API (`/api/kiosk`) can do four things: describe the tablet, resolve a
  scan, and post a scan-out. It never returns prices, stock levels or other people.
- It holds no company or admin JWT, so it cannot reach the storefront, ordering
  or admin APIs.
- **Switch off** or **New link** in the console ends a link at once. Removing a
  person switches their badge off; history keeps their name.
- Bad links are rate-limited per IP; each tablet has its own generous limit.
- A retry after a Wi-Fi drop is safe: scan-outs are idempotent per session.
- Nothing here reads or writes company sign-in settings (access code, individual
  logins, people & activity).

## Files

| | |
|---|---|
| `migrations/053_scan_out_kiosk.sql` | tables, ledger columns, RLS |
| `routes/kiosk.js` | tablet API |
| `routes/scan-out-admin.js` | console API: settings, tablets, people, badge sheet, activity |
| `utils/scan-out.js` | badge codes, link secrets, options |
| `public/kiosk.html` | the tablet screen (served at `/kiosk/<secret>`) |
| `admin/index.html` | console panel |
| `tests/scan-out-kiosk.test.js` | 49 tests |
