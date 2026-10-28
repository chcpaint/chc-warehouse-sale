# Billing, subscriptions and regional tax

Everything here is off by default. A distributor that does nothing sees no change:
every customer stays **free** and every tax rate stays at the 13% Ontario default.

## Tax & Region (Canada / USA)

Admin console → **Tax & Region** (super admin). Pick the country (Canada or United States),
the home province or state, and the rate. Optionally save a rate for other provinces/states.
Stored in `distributors.settings.tax`:

```json
{ "country": "US", "region": "TX", "rate": 0.0825, "rates": { "TX": 0.0825, "FL": 0.07 } }
```

Every customer company of that distributor picks it up at checkout. Resolution order
(`utils/tax.js` → `taxSettings`):

1. Company marked **tax exempt** → 0%
2. Company has its **own rate** (Companies → Tax)
3. Company is tagged with a **province/state** the distributor has a saved rate for
4. The distributor's default rate
5. Nothing configured → 13%

Reference rates in `utils/tax-regions.js` only pre-fill the form. They are starting points
(US = state base rate; counties/cities can add more). The distributor confirms the rate with
their accountant. API: `GET/PUT /api/admin/distributor-tax`; company tax: `/api/admin/companies/:id/tax`
(accepts `region`).

## Subscriptions

The **sales portal is always free** (ordering, price list, promotions, order history, individual
logins). The optional parts are sold as items (`utils/billing.js`):

| Item | Unlocks | Charged | Standard price (editable) |
| --- | --- | --- | --- |
| Inventory | `inventory` | per location | $129 / month |
| Repair kits | `kits` (needs Inventory) | per location | $49 / month |
| People & activity | `activity`, `restricted_reports` | per customer | $39 / month |
| ShopSafe | `shopsafe` | per location | $49 / month |
| Complete | all four | per location | $199 / month |

Annual = ten months by default. Prices are defaults, not market quotes. Each distributor can
change any of them (set to 0 to make an item free for everyone).

**The distributor decides who pays.** Admin console → **Billing**:

- **Free** customer: everything switched on keeps working, no charge (default for everyone).
- **Paid** customer: optional modules only work for items they subscribed to, or that were given free.
  Moving a customer who already uses an optional module to Paid warns first and offers to keep
  those items free ("grandfather") or switch them off.
- **Give free…** ($0): a super admin can give any item(s) free, with a required reason and an optional
  end date. Taken away with ×. Never overwrites something the customer is paying for.

The gate: `settings.billing = { mode, entitled }` on the company, read by `utils/modules.js`
(`moduleSettings`/`canSetModule`) so no extra database call is needed. `entitled` is recomputed from
`company_entitlements` whenever anything changes (`utils/billing-db.js` → `syncEntitlements`).

### Customer side

When a customer is on Paid billing, a **Plans & billing** tab appears. They tick items, pick monthly or yearly,
confirm locations, see a live quote, and go to Stripe Checkout. Only the account owner can buy (or the
shared company login when the company does not use individual logins). Card details never touch this app.
"Update card, switch plan or cancel" opens Stripe's billing portal.

### Money flow

- Default: the platform's Stripe account collects.
- If the distributor has a connected Stripe account (`distributors.stripe_account_id`,
  `stripe_connect_status = 'active'`), the subscription is a destination charge to them, with an optional
  platform fee: `distributors.settings.billing.platform_fee_percent`, else env `STRIPE_PLATFORM_FEE_PERCENT`, else 0.
- Tax on subscriptions: set `STRIPE_AUTOMATIC_TAX=true` to have Stripe Tax add it at checkout
  (requires Stripe Tax set up in the Stripe dashboard).

### Webhook

`POST /api/webhooks/stripe` (existing route). Handles `checkout.session.completed` (switches items on once
payment is confirmed) and `customer.subscription.created/updated/deleted` (active, past due → still on
as a grace period, canceled/unpaid → off). Idempotent per Stripe event id (`billing_events`); an event that
fails part-way is not marked done, so Stripe's retry completes it.

In Stripe, send these events to `https://<your domain>/api/webhooks/stripe`:
`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`.

### Setup checklist

1. Run `migrations/049_billing.sql` (also 047, 048 if not yet run).
2. Railway variables: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
   (optional: `STRIPE_PLATFORM_FEE_PERCENT`, `STRIPE_AUTOMATIC_TAX`).
3. Stripe dashboard: add the webhook above; turn on the Customer portal.
4. Admin → Tax & Region (set country/state), then Billing (review prices).

### Data model

- `billing_prices` — price overrides (`distributor_id` null = platform-wide).
- `company_entitlements` — one row per company per item; `source` is `paid`, `comp` ($0 grant) or `free_price`.
- `billing_events` — handled Stripe event ids.

## Tenant isolation

`requireCompanyAccess` now also confines a super admin to companies of their own distributor
(another distributor's company reads as "not found"). The billing routes apply the same rule.
Routes that were never behind `requireCompanyAccess` are unchanged; a full sweep is on the roadmap.

## Tests

`tests/tax-regions.test.js`, `tests/billing.test.js`, `tests/promotion-images.test.js`.
