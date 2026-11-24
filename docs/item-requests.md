# Item requests

Customers asking for an item to be **added to their catalog**, kept in one
place by customer instead of in emails, texts, phone calls and notes. Nothing
else goes through here: prices and orders are handled as before.

## Customers (store)

**Request an Item** (Ordering menu) asks for an item with its name, part
number, brand, quantity, notes and up to three photos (5 MB each, resized on the
phone before sending). Every request they've made is listed with its status:

| Status | Meaning |
| --- | --- |
| Waiting | CHC has it and is working on it |
| Ready to order | Added to their list; an **Add to cart** button appears when staff linked the item |
| Can't supply | Not available, with the reason |

A person tied to one shop sees that shop's requests plus any not tied to a shop.
A kiosk session can't reach requests. Each customer can send 30 an hour.

## CHC staff (console)

**Item requests** in the sidebar (amber badge = waiting). Filter by status,
customer or text.

- **Enter a request** when a customer calls, emails, texts or asks in person:
  choose the customer and shop, record how it came in.
- Add the item to the customer's list (Products or Customer Pricing), then
  **Complete** and link it. The customer is emailed "Ready to order" with a
  button to their store.
- **Can't supply** needs a reason; the customer is emailed it.
- **Reopen** puts a closed request back on the waiting list.

Order desk, operations manager and sales director accounts can work the list
for the customers they can already see (the same scope as Orders).

## Who is emailed

Every new request emails the request inbox, with photos attached. It starts as
adam@chcpaint.com. **Who is emailed** (on the Item requests screen) shows the
list; a full admin can change it, for example to add someone while Adam is
away. The list can't be empty; up to 10 addresses. Changes are in the audit log.

## Setup

Run `migrations/072_item_requests.sql` in the Supabase SQL editor. It creates
the `item_requests` table (RLS on, server-only), the private
`item-request-photos` storage bucket, and sets the default inbox.
