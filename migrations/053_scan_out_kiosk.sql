-- 053_scan_out_kiosk.sql
--
-- Scan-out kiosk: a tablet at the stock room or cage where painters and
-- bodymen scan their ID badge and then scan out what they take.
--
-- Nothing here touches sign-in for any company. The kiosk is its own entry
-- point with its own secret link; it cannot reach the ordering app or the
-- admin console. Safe to run more than once.
--
-- Paste the whole file into the Supabase SQL editor and press Run.

-- ----------------------------------------------------------------------------
-- 1. Kiosk devices: one secret link per tablet / location
--
-- Only a SHA-256 hash of the link's secret is stored, so a database read never
-- reveals a working link. The link is shown once, when it is created.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kiosk_devices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id   uuid NOT NULL REFERENCES public.company_locations(id) ON DELETE CASCADE,
    name          text NOT NULL,
    token_hash    text NOT NULL,
    token_hint    text,
    is_active     boolean NOT NULL DEFAULT true,
    last_seen_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS kiosk_devices_token_hash_key
    ON public.kiosk_devices (token_hash);
CREATE INDEX IF NOT EXISTS idx_kiosk_devices_company
    ON public.kiosk_devices (company_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 2. Badge roster: the people who can scan out. No email, no password, and no
--    access to anything except the kiosk.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kiosk_badges (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name        text NOT NULL,
    trade       text,
    badge_code  text NOT NULL,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
    ALTER TABLE public.kiosk_badges
        ADD CONSTRAINT kiosk_badges_code_chk CHECK (badge_code ~ '^[A-Z0-9-]{6,32}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE public.kiosk_badges
        ADD CONSTRAINT kiosk_badges_trade_chk
        CHECK (trade IS NULL OR trade IN ('painter','bodyman','prep','detailer','cage','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A scan has to resolve to exactly one person within a company.
CREATE UNIQUE INDEX IF NOT EXISTS kiosk_badges_company_code_key
    ON public.kiosk_badges (company_id, badge_code);
CREATE INDEX IF NOT EXISTS idx_kiosk_badges_company
    ON public.kiosk_badges (company_id, name);

-- ----------------------------------------------------------------------------
-- 3. Ledger: who scanned and on which tablet
--
-- Plain uuid columns on purpose (no foreign keys): the ledger is append-only,
-- and a SET NULL on delete would be an UPDATE the append-only rule refuses.
-- ----------------------------------------------------------------------------
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS badge_id        uuid;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS kiosk_device_id uuid;

ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_actor_type_chk;
ALTER TABLE public.stock_movements
    ADD CONSTRAINT stock_movements_actor_type_chk
    CHECK (actor_type IS NULL OR actor_type IN ('admin','store','system','kiosk'));

CREATE INDEX IF NOT EXISTS idx_stock_movements_badge_time
    ON public.stock_movements (company_id, badge_id, created_at DESC)
    WHERE badge_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. Lock the new tables down. The server reaches them with the service role,
--    which bypasses RLS; nobody else gets in.
-- ----------------------------------------------------------------------------
ALTER TABLE public.kiosk_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kiosk_badges  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.kiosk_devices, public.kiosk_badges FROM anon, authenticated;
