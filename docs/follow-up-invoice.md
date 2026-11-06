# Follow-up invoice for backorders

An order that shipped partially with a backorder owes **two** invoices: the first one, and a
follow-up invoice for the backordered items. The follow-up works like the first.

## What staff see (Orders)

1. Set the order to Out for Delivery, tick **Partial / backorder** and pick what is short.
2. Upload the first invoice as usual.
3. The order now shows an orange **Needs Follow-up Invoice** pill with an **Upload Follow-up
   Invoice** button, and a line saying what is short ("2 x Widget"). It is counted under the
   **Needs Invoice** tab. While the backorder has not been marked shipped the row says so;
   the upload button is available either way.
4. When the backorder ships, upload the follow-up invoice. The stage becomes **Awaiting Payment**
   and the row shows two eye icons: the first invoice, and the follow-up (marked with a small 2).
   Replacing either one never touches the other.
5. **Mark Paid & Close** finishes the order. While a follow-up invoice is still owed it is refused;
   staff can close anyway only by confirming (it is written in the order history), or mark
   **Follow-up invoice not needed** (for example, the backorder was cancelled) with an optional
   reason.

## What the customer sees (store, order history)

**Download Invoice** and, once uploaded, **Download Backorder Invoice**. Until then a small
"Backorder invoice to follow" note. The recipients get a "Follow-up invoice ready" email that lists
the backordered items.

## Data

Migration `055_followup_invoice.sql` adds `followup_invoice_*` columns on `orders`. The due flag is
set when a partial shipment is recorded and stays set after the backorder ships (when `backorder_items`
clears) until the follow-up is uploaded or waived; `followup_invoice_items` keeps what was short.
Orders that are partially shipped when the migration runs are backfilled as owing a follow-up.

## Access

Same reach as the first invoice: anyone who can upload or view it (including branch order-desk
accounts for their own branch). Routes: `POST|GET /companies/:id/orders/:id/followup-invoice`,
`PUT .../followup-invoice/waive`; customer: `GET /api/store/:slug/orders/:id/invoice?which=followup`.

Nothing here touches how any company signs in.
