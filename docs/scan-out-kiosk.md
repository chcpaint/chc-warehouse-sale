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

## Stock ordering from the tablet

The same tablet can place stock orders. A large green **Place Stock Order** bar sits at the
bottom of the scan-out screen. Staff never need it; managers use it.

1. Tap the bar, enter the company's **order passcode** on the keypad (a USB or Bluetooth
   keyboard or scanner wedge works too).
2. Scan items in the stock room. Each scan adds a line; rescans raise the quantity; the
   +/- buttons and the trash button fix mistakes. Prices show unless the company has the
   hide-pricing module on.
3. Choose who is ordering (or use the default name), add a PO if the company's PO rules
   ask for one, add notes, and tap **Send Order**.
4. A pop-up asks **Return to Scan Out Kiosk?** (Yes / Not yet). If nobody taps, the tablet
   goes back to scan-out mode on its own 60 seconds after the order is sent.

The order is the store's own order: the same route, prices, promotions, tax, delivery-fee
rules, PO rules (including "no PO under $500" for Assured), orderer-name list and
notification emails as an order placed on the website. It is placed at the tablet's own
location and its notes say it came from the stock-room tablet.

**Passcode.** Six to twelve digits, not a repeated digit or a simple run. Stored only as a
salted scrypt hash in `kiosk_order_access` (never in company settings, which the storefront
sends to browsers). Anyone with the current passcode can change it from the order screen
(**Change passcode**); CHC can set, replace or remove it in the console (Modules > Scan-out
kiosk > Stock ordering). Five wrong tries lock that tablet's order screen for 5 minutes.
Scanning out is never affected.

**Console settings** (per company): allow ordering on/off, default order contact name and
email (the confirmation goes to that email; people at the tablet cannot redirect it), and
the passcode. The bar appears only when ordering is on **and** a passcode is set.

**Not available** for companies that order as signed-in individuals (People & activity),
because their orders must be tied to a named person.

**Order session.** A correct passcode returns a 30-minute token that can do exactly five
things in the store (look up a product, read the PO, tax and delivery-fee settings, and
place an order) and only for its own company and its tablet's location. Everything else
returns 403, enforced in `middleware/auth.js` (default-deny allowlist, `SCOPED_ROUTES`).
The order screen locks itself after 5 minutes without activity and discards its cart.

Known limits: the on-screen subtotal is before tax, fees and promotions (the server
computes the final total); switching a tablet off ends scanning at once, but an order
session already opened can last up to 30 minutes.

## Files

| | |
|---|---|
| `migrations/053_scan_out_kiosk.sql` | tables, ledger columns, RLS |
| `migrations/054_kiosk_ordering.sql` | order passcode table, per-tablet lockout |
| `routes/kiosk.js` | tablet API |
| `routes/scan-out-admin.js` | console API: settings, tablets, people, badge sheet, activity |
| `utils/scan-out.js` | badge codes, link secrets, options |
| `public/kiosk.html` | the tablet screen (served at `/kiosk/<secret>`) |
| `admin/index.html` | console panel |
| `tests/scan-out-kiosk.test.js` | 49 tests |
| `tests/kiosk-ordering.test.js` | 32 tests: passcode, lockout, narrow order session, real order placement, console |
