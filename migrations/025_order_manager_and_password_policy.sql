-- 025_order_manager_and_password_policy.sql
--
-- Three things: an all-branch order manager, a forced password change, and a
-- record of who handled each order.
--
-- WHY A NEW ROLE RATHER THAN "order_desk WITH NO BRANCH"
--
-- The tempting shortcut is to treat a NULL branch_id as "sees everything". That
-- inverts the safest possible failure: a desk created without a branch — a
-- dropdown left untouched, an import that missed a column — would silently gain
-- access to every customer's orders instead of none. Today a missing branch
-- shows an empty list, which is annoying and obvious. Seeing everything is
-- neither. So all-branch access is its own role, granted on purpose.
--
-- order_manager is fenced to exactly the same screens as order_desk. The only
-- difference is breadth of orders, never breadth of the console.

begin;

-- ==================================================================
-- The role list
-- ==================================================================
--
-- admin_users carries a valid_role CHECK, which is why order_manager has to be
-- admitted here before anything can hold it. Worth keeping: it is the reason a
-- typo in a role name fails loudly at the write instead of producing an account
-- that silently matches no branch of any permission check — which, given those
-- checks mostly read `if role === 'x'`, would deny everything and look like a
-- broken login rather than bad data.

alter table public.admin_users drop constraint if exists valid_role;
alter table public.admin_users add constraint valid_role
    check (role in ('super_admin', 'company_admin', 'admin', 'order_desk', 'order_manager'));

-- ==================================================================
-- Forced password change
-- ==================================================================
--
-- Eight people were given the same starting password. Until each of them
-- replaces it, the audit trail cannot honestly say who did anything: any of
-- them could sign in as any other. This flag is what closes that window, and it
-- is enforced in the API rather than the browser — see requirePasswordCurrent
-- in middleware/auth.js.

alter table public.admin_users
    add column if not exists must_change_password boolean not null default false;

comment on column public.admin_users.must_change_password is
    'Set when an account is issued a password somebody else chose. Until cleared, the API refuses every route except whoami and the password change itself.';

-- Everyone currently holding a password that was set for them, not by them.
update public.admin_users
set must_change_password = true
where lower(email) in (
    'frankg@chcpaint.com','eric@chcpaint.com','carlos@chcpaint.com','lucas@chcpaint.com',
    'gabe@chcpaint.com','francesco@chcpaint.com','sujit@chcpaint.com','assad@chcpaint.com',
    'daniel@chcpaint.com'
);

-- ==================================================================
-- The three head-office order managers
-- ==================================================================
--
-- gabe@ already exists as a Woodbridge desk; he is promoted rather than
-- duplicated, and his branch is cleared so nothing later mistakes him for a
-- single-branch user.

update public.admin_users
set role = 'order_manager', branch_id = null, updated_at = now()
where lower(email) = 'gabe@chcpaint.com';

-- manny@ and frankc@ are new. Password hashes are supplied by the deploy step
-- that runs alongside this migration; this file only guarantees the rows exist
-- with the right shape if they were created by hand.
update public.admin_users
set role = 'order_manager', branch_id = null, updated_at = now()
where lower(email) in ('manny@chcpaint.com', 'frankc@chcpaint.com');

-- ==================================================================
-- Who handled the order
-- ==================================================================
--
-- status_history already records an email against every status change, which is
-- a trail but not an answer — reading it means parsing JSON per row. These
-- columns hold the last person to act, so "who handled this?" is a column on
-- the list rather than an investigation.
--
-- handled_by_name is a snapshot on purpose. If somebody leaves and their
-- account is removed, the order should still say who dealt with it.

alter table public.orders
    add column if not exists handled_by      uuid references admin_users(id) on delete set null,
    add column if not exists handled_by_name text,
    add column if not exists handled_at      timestamptz;

comment on column public.orders.handled_by_name is
    'Snapshot of the handler''s name. Kept even if the account is later deleted, so history stays readable.';

create index if not exists idx_orders_handled_by
    on public.orders (handled_by) where handled_by is not null;

-- Backfill from the trail we already have: the last status change with a name
-- against it.
update public.orders o
set handled_by_name = h.updated_by,
    handled_at      = (h.timestamp)::timestamptz
from (
    select id,
           (jsonb_array_elements(status_history) ->> 'updated_by') as updated_by,
           (jsonb_array_elements(status_history) ->> 'timestamp')  as timestamp
    from public.orders
    where jsonb_typeof(status_history) = 'array'
) h
where h.id = o.id
  and h.updated_by is not null
  and o.handled_by_name is null;

commit;
