-- Company-wide contact notes: a message between a customer and CHC that is
-- not about any one order -- a product they want quoted that isn't in the
-- catalogue yet, a heads-up that a shop is closing early, a general
-- question. The per-order notes_log (see migration 038) stays exactly what
-- it is: a thread on one order. This is the same idea one level up, for
-- everything that has no order to attach to.
create table if not exists company_notes (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references companies(id) on delete cascade,
    location_id uuid references company_locations(id) on delete set null,
    author_type text not null check (author_type in ('customer', 'staff')),
    author_name text,
    author_email text,
    admin_id uuid references admin_users(id) on delete set null,
    text text not null,
    read_at timestamptz,
    read_by uuid references admin_users(id) on delete set null,
    created_at timestamptz not null default now()
);

-- The console's two main listings: "this company's messages" (customer and
-- admin console alike) and "what hasn't been looked at yet" across every
-- company, for a staff-wide triage view.
create index if not exists idx_company_notes_company on company_notes(company_id, created_at desc);
create index if not exists idx_company_notes_unread on company_notes(created_at desc) where read_at is null;
