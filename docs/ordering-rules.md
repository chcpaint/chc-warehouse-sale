# Ordering rules and manager approvals

Migration `071_ordering_rules.sql`. Code: `utils/ordering-rules.js`,
`routes/ordering-rules-store.js`, `routes/ordering-rules-admin.js`,
`public/ordering-rules.js`.

## What a shop can switch on

Every rule is **off** until someone turns it on. Set once for the company; any
shop can have its own setting or amount.

| Rule | What it does |
| --- | --- |
| Order limit | An order over $X before tax needs a manager. |
| Stock limit | Stock on the shelf (refinishAI Inventory value) + orders already sent and not yet received + this order may not go over $X without a manager. |
| Orders on hold | Staff can still build orders; nothing goes to the branch until a manager approves it. The shop writes the message staff see. |
| Items that need a manager | Items marked "needs approval" (equipment, tools) need a manager. Staff still see them, with a lock, and can ask for them. |

## Who approves

- **Approval passcodes**: named (e.g. "Mike"), 6 to 12 digits, for every shop
  or one shop. Stored only as a salted scrypt hash. Each approval records which
  passcode gave it. Five wrong tries lock that shop's approvals for five minutes.
  The shop decides how many passcodes exist and who holds them; switching one
  off ends every rules session it opened.
- **Owners** signed in with their own login approve their own orders.

## What happens at checkout

The server prices the order and checks the rules (all order paths: store,
kiosk, refinishAI Inventory reorders). If a rule trips, the screen shows the
order, its total and why, and:

1. a manager types a passcode: the order goes to the branch now, with
   `orders.approval` recording who and why; or
2. **Send for manager approval**: saved in `order_approvals` as *waiting*. It
   is not an order: no email to the branch, no PO number used, not in reports
   or rebates.

A manager opens **Order History**, presses **Review** (the order is re-priced
as it stands now), then **Approve and send** (passcode) or **Decline** (passcode
and a reason). Release replays the order through the normal order path.

A refinishAI Inventory reorder is already a queue, so it asks for the passcode
when approved rather than saving a second waiting copy. The kiosk shows the
reasons on its keypad screen and takes a passcode, or saves the order for a manager.

## Who changes the rules

- CHC console: company list, shield icon (full admins; order-desk cannot).
  Changes are written to the audit log, never with a passcode in them.
- In the store: Order History, **Ordering rules**. An owner goes straight in;
  anyone else enters an approval passcode. A one-shop passcode changes that shop
  only and cannot see or change passcodes or item locks.

Nothing here changes how any company signs in.
