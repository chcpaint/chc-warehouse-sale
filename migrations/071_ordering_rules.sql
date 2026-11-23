-- 071_ordering_rules.sql
--
-- Optional ordering rules a shop (or CHC for it) can switch on, per company with
-- per-shop overrides:
--
--   1. Order limit      - an order over $X (before tax) needs a manager.
--   2. Stock ceiling    - stock on the shelf + stock on the way + this order may
--                         not go over $X without a manager.
--   3. Orders on hold   - staff can build orders, but nothing goes to the
--                         distributor until a manager releases it.
--   4. Staff items      - items marked "needs approval" (equipment, tools) need
--                         a manager; everything else staff can order freely.
--
-- A manager approves with a named approval passcode. An order that hits a rule
-- and is not approved on the spot is saved in order_approvals as "waiting". It
-- is NOT an order: it is not sent to the distributor, not in reports, not in
-- rebates, and has no PO number, until a manager releases it. Release runs it
-- through the normal order path, prices and all, at that moment.
--
-- Every rule is off unless someone turns it on. Nothing here changes how any
-- company signs in (Assured's three-step sign-in is untouched).
--
-- Safe to re-run. Run in the Supabase SQL editor BEFORE deploying the code.

-- ----------------------------------------------------------------------------
-- 1. The rules. location_id NULL is the company default; a row with a
--    location_id overrides it for that shop. A NULL column means "same as the
--    company default".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ordering_rules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id         uuid REFERENCES public.company_locations(id) ON DELETE CASCADE,
    order_limit_on      boolean,
    order_limit         numeric(12,2),
    stock_ceiling_on    boolean,
    stock_ceiling       numeric(12,2),
    hold_on             boolean,
    hold_message        text,
    staff_items_on      boolean,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by          text,
    CONSTRAINT ordering_rules_limit_chk   CHECK (order_limit   IS NULL OR order_limit   >= 0),
    CONSTRAINT ordering_rules_ceiling_chk CHECK (stock_ceiling IS NULL OR stock_ceiling >= 0),
    CONSTRAINT ordering_rules_msg_chk     CHECK (hold_message  IS NULL OR char_length(hold_message) <= 300)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ordering_rules_company
    ON public.ordering_rules (company_id) WHERE location_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ordering_rules_location
    ON public.ordering_rules (company_id, location_id) WHERE location_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Named approval passcodes. Stored only as a salted scrypt hash. A passcode
--    with a location_id works for that shop only.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.approval_passcodes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id     uuid REFERENCES public.company_locations(id) ON DELETE CASCADE,
    name            text NOT NULL,
    passcode_hash   text NOT NULL,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      text,
    changed_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz,
    use_count       integer NOT NULL DEFAULT 0,
    CONSTRAINT approval_passcodes_name_chk CHECK (char_length(name) BETWEEN 1 AND 60)
);
CREATE INDEX IF NOT EXISTS idx_approval_passcodes_company ON public.approval_passcodes (company_id) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_passcodes_name
    ON public.approval_passcodes (company_id, lower(name)) WHERE is_active;

-- Wrong-passcode lockout, per company and shop: five wrong tries lock that
-- shop's approvals for a few minutes; a right one clears the count.
CREATE TABLE IF NOT EXISTS public.approval_lockouts (
    company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    scope_key     text NOT NULL,
    fail_count    integer NOT NULL DEFAULT 0,
    locked_until  timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, scope_key)
);

-- ----------------------------------------------------------------------------
-- 3. Orders waiting for a manager.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_approvals (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id         uuid NOT NULL REFERENCES public.company_locations(id) ON DELETE CASCADE,
    status              text NOT NULL DEFAULT 'waiting',
    request             jsonb NOT NULL,           -- what was sent, replayed on release
    requested_by        jsonb,                    -- the individual login, if any
    contact_name        text,
    contact_email       text,
    items               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- priced lines when sent
    subtotal            numeric(12,2),
    total               numeric(12,2),
    reasons             jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    decided_at          timestamptz,
    decided_by_name     text,
    decided_by_passcode uuid REFERENCES public.approval_passcodes(id) ON DELETE SET NULL,
    decision_reason     text,
    order_id            uuid REFERENCES public.orders(id) ON DELETE SET NULL,
    CONSTRAINT order_approvals_status_chk CHECK (status IN ('waiting', 'released', 'declined'))
);
CREATE INDEX IF NOT EXISTS idx_order_approvals_waiting
    ON public.order_approvals (company_id, location_id, created_at DESC) WHERE status = 'waiting';

-- ----------------------------------------------------------------------------
-- 4. Items that need a manager, and how an order was approved.
-- ----------------------------------------------------------------------------
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT false;
ALTER TABLE public.orders   ADD COLUMN IF NOT EXISTS approval jsonb;

-- ----------------------------------------------------------------------------
-- 5. Lock the new tables down. The server uses the service role (bypasses RLS);
--    nothing reaches them from the browser directly.
-- ----------------------------------------------------------------------------
ALTER TABLE public.ordering_rules     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_passcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_lockouts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_approvals    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ordering_rules     FROM anon, authenticated;
REVOKE ALL ON public.approval_passcodes FROM anon, authenticated;
REVOKE ALL ON public.approval_lockouts  FROM anon, authenticated;
REVOKE ALL ON public.order_approvals    FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
