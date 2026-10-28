# Fees and rebates

Per-company delivery fees, fuel surcharges and rebates. Set in the console
(Companies > the green % button); applied by `utils/fee-rules.js` (orders) and
`utils/rebates.js` (reporting). Needs `migrations/047_fee_rules_and_rebates.sql`.

## Fees

A fee rule says: charge a flat dollar amount or a percent of the order, on every
order or only orders below / at-or-above a dollar amount, for everyone ordering
for the company or only chosen user groups. Each rule that applies adds one line
to the order (`orders.fee_lines`; totals in `delivery_fee` and `fuel_surcharge`).

- Judged on the priced item subtotal before tax. Price-on-request lines do not count.
- Fees are not taxed. Total = subtotal + tax + fees.
- A company with **no** fee rules keeps the old behaviour: $10 under $300, unless
  turned off with the switch on the Orders screen (`companies.settings.delivery_fee`).
  Once a company has any rule, the rules are the whole story and that switch is
  ignored (the Orders screen says so). Deleting the last rule leaves the company
  with no fees, not the old fee.
- `resolveFees()` is the only place that decides fees. Checkout, the replenishment
  approval path and the console's price edit all call it. The cart shows a preview
  using the same rules; the order is always priced on the server.
- A rule limited to user groups only charges people signed in with their own login
  in that group. The shared access code has no group.

## Rebates

A rebate rule is a percent of what the company paid for goods, on item dollars
before tax. It covers everything or selected categories and/or brands, and has its
own frequency (monthly, quarterly, annual) and optional start/end dates.

- Report-only: never applied at checkout, never changes an order or a price. CHC
  credits it outside the portal.
- Cancelled orders and price-on-request lines are excluded.
- Where two rebates cover the same item the highest percent wins; nothing is paid twice.
- Periods are calendar months/quarters/years in Toronto time.
- Brand and category are frozen on each order line from now on; older orders fall
  back to the product's current brand and category.
- Customers see their own rebate on the store Reports tab (location-scoped under
  Restricted reports; hidden when pricing is hidden). CHC sees every company in
  Reports > Rebates (super admin only).

## Who can change it

Admin and super admin write; other staff roles can read the rules for a company
they can reach. Order-desk accounts cannot reach the rule editor or the CHC rebate
report at all. Every change is written to the audit log.
