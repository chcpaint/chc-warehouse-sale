# Purchase orders

Each company handles purchase orders (POs) one of three ways, set under Modules > Purchase orders:

| Mode | Meaning |
| --- | --- |
| `off` | The company does not use POs. No field, orders go straight through. |
| `manual` (default) | The shop types its own PO. It is required and must be unique per company. |
| `generated` | CHC issues the number from the company's sequence when the order is placed. |

## No PO under a dollar amount (`optional_below`)

A `manual` company can be given a threshold so small orders need no PO:

```json
{ "purchase_orders": { "mode": "manual", "optional_below": 500 } }
```

* The amount is the **priced item total before tax and before any fees**, worked out on the
  server from the database prices (promotions included), never from the cart's figures.
* **Under** the amount: the PO is optional and the order is stored with no PO
  (`po_source = 'none'`). If the shop types one anyway it is kept.
* **At or above** the amount (exactly $500.00 counts as above): a PO is required, as it always was.
  The API answers 400 with `po_required: true`.
* An order containing a price-on-request line always needs a PO: its real value is unknown.
* A missing, zero, negative or non-numeric value turns the feature off. It does nothing for
  `off` or `generated` companies.
* The cart shows "Purchases under $X before tax do not require a PO" for any company that has the
  rule, relaxes the PO field for small carts, and the quote PDF's closing line says so too.
* Set it for Assured with `chc-assured-po-under-500.sql`; remove it with
  `update public.companies set settings = settings #- '{purchase_orders,optional_below}' where slug = 'assured';`.
* Saving the mode in the admin console keeps `optional_below` (it merges into the existing block).

Code: `utils/po.js` (`poSettings`, `resolveOrderPo`), `routes/storefront.js` (order route and
`GET /:slug/po/config`), `public/store.html` (`cartPoWaived`, `applyPoConfig`).
Tests: `tests/orders-po-threshold.test.js`.
