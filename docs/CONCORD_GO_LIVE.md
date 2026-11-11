# Inventory go-live: Concord Collision Center

First real shop on the revised Inventory. One shop, shared-code sign-in (no individual
logins), ordering from the scan-out kiosk.

## What is switched on

| Part | State |
|---|---|
| Inventory core (levels, scanning, reorders by min/max with approval) | On |
| Deliveries (receive against a CHC order; damaged / not-ordered / closed short) | On |
| Cycle counts | On |
| Shelf barcode labels (the shop prints its own) | On |
| Repair kits + Insurance kit submissions (numbered PDF to load into Mitchell, CCC ONE) | On |
| Scan-out kiosk | On |
| Transfers, Usage reports | Off (one shop) |

Switch the optional parts from the console: **Companies → Modules → Inventory parts**.
Turning one off hides it in the shop and refuses its routes; nothing is deleted.

## Order of work

1. **Pilot first.** Run `pilot_oakville_chc_shop.sql` (CHC Test, location "Oakville CHC Shop", 25 items).
   Exercise: scan-out at the kiosk, a reorder raised by an item under its minimum, receiving a CHC
   order (including a damaged unit and a close-short), a count and adjustment, a kit PDF, shelf labels.
2. **Apply** `059_receiving_exceptions.sql` (adds damaged / closed-short records) before deploying.
3. **Concord setup.** Run `concord_inventory_setup.sql`. Then, in the console, upload their item list with
   *master upload → seed* for the one location (dry run first) so levels, min/max and bins are created.
4. **Baseline count.** Count the whole stock room and commit it, so the starting numbers are real.
5. **Labels.** Stock tab → *Print shelf labels*. Every stocked item without a barcode gets one first, so
   what is stuck to the shelf scans.
6. **Kiosk.** Console → Concord → Scan-out kiosk: create the tablet link, add people, print badges.
7. **Shadow run** two weeks beside their current process, then switch.

## Receiving exceptions (what staff do at the back door)

* Count what arrived in *Arrived OK*; anything unusable in *Damaged* (kept as evidence, **not** added to
  stock, still owed on the order).
* An item not on the order is scanned in and recorded as *Not ordered*.
* If the rest is not coming, **Close delivery**: the outstanding lines, who closed it and the note are kept.
* *Delivery problems* lists the last 90 days, for credits and replacements.

## Not built yet (agreed order)

Inventory budget and reporting against it; staff / manager / admin authority levels (needs individual
logins, which Concord does not use — Assured-style sign-in is untouched); min/max suggested from
consumption (needs 4–8 weeks of history); reason codes and approval thresholds on adjustments.
