-- Which line(s) on a "Partial Shipment with Backorder" order are actually
-- short, and by how much -- so what the portal shows matches what the
-- branch is already writing on the AccountEdge invoice, rather than the
-- order-wide flag from migration 038 standing alone with no detail behind
-- it.
alter table orders
    add column if not exists backorder_items jsonb not null default '[]'::jsonb;
