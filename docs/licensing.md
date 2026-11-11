# Licensing refinishAI to other distributors

refinishAI is the product; CHC is its founding distributor. Any distributor (in Canada or the US)
can be licensed to run its own customers on the same platform, completely separated from CHC's.

## What a licensed distributor gets, and what stays separate

| Theirs alone | Shared refinishAI content (read-only for them) |
| --- | --- |
| Customers, shops, users, orders, invoices, stock, kits used | Master repair kits |
| Staff accounts and branches | The crossover reference sheet |
| Item Library (their supplier catalogue and list prices), its imports and change log | PPG paint / sundries classification |
| Prices, promotions, rebates, fees, tax settings, billing plans | The Help page and help assistant |
| Their own web address (custom domain or `<name>.<platform domain>`) | |

Separation is enforced on the server, not by hiding screens: every staff screen is fenced to the
staff member's distributor (orders by `orders.distributor_id`, staff, branches, companies, the Item
Library), a sign-in is only accepted on the account's own distributor's address, and a request for
another distributor's record is answered as "not found". Only the platform admin and CHC's super
admins can change the shared content. `tests/licensing.test.js` and `tests/multi-tenant.test.js` prove it.

## Licence terms

Recorded per distributor in the platform console: status (trial, active, past due, suspended,
cancelled), plan, monthly or annual, fee and currency (CAD or USD), start, renewal and trial-end
dates, a customer limit, contacts and private notes. Every change is in the audit log.

- **Trial**: 30 days by default. When it ends the distributor is paused until set to active.
- **Past due**: a flag for follow-up; nothing is paused.
- **Suspended / cancelled**: the distributor's console, shops and kiosks answer "This service is
  paused" until reactivated. Data is kept. CHC can never be paused.
- **Customer limit**: adding a customer beyond it is refused with a clear message.

Licence fees are invoiced outside the app for now (Stripe invoice or the accounting system); the
console is the record of what each distributor owes and when it renews.

## One-time setup

1. Run `migrations/066_distributor_licensing.sql` in Supabase (labels existing data; changes nothing).
2. Create the platform admin (use an email that is not your CHC staff login). In Terminal:

       cd ~/Downloads/chc-deploy && railway run node scripts/create-platform-admin.js you@refinishai.example "Adam Berube"

   Open the link it prints, choose a password, sign in at /admin. The menu shows only **Distributors**.
3. Choose how distributors get their web address:
   - **Their own domain** (e.g. `orders.theirco.com`): they add a CNAME to the Railway app, and you add
     the domain in Railway > the service > Settings > Domains. No other setup.
   - **A refinishAI platform domain** (e.g. `theirco.refinishai.app`): buy the domain once, point a
     wildcard DNS record at Railway, add it in Railway, and set `PLATFORM_DOMAIN` in Railway's variables.
   `chcsale.com` stays CHC's address permanently.

## Onboarding a distributor

1. Distributors > Onboard a distributor: name, short name (what its shops see, e.g. "Contact Maritime"),
   web name, domain, contacts, licence terms. It starts on a trial unless you choose otherwise.
2. Staff > Invite super admin. They get an email (and you get the link to send yourself if needed),
   set a password on their own address, and sign in there.
3. They add their branches, staff and customers, and load their supplier catalogue through the
   Master Table, exactly as CHC does.

## Not done yet

- Automatic licence billing (Stripe subscriptions for the licence fee) and distributors collecting
  their shops' payments through their own Stripe accounts (Stripe Connect).
- Per-distributor email sender address and logo on emails (CHC's are used today).
- The Help page's contact email per distributor (it shows refinishAI support today).
