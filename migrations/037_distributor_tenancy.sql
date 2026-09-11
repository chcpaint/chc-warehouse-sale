-- Adds a distributor layer above `companies`. Today the whole platform is
-- implicitly one distributor (CHC); this makes that explicit and gives every
-- table that assumed "there is only one seller" a real foreign key instead,
-- so a second distributor (its own staff, branches, catalog and shops) can
-- be onboarded without touching CHC's data or behaviour.
--
-- CHC's row is fixed at a known id so application code and this migration
-- agree on it without a round trip:
--   4d763514-3a41-45f2-b31d-e38756ba1595
--
-- Every new column is added with DEFAULT = CHC's id (nullable only on
-- admin_users, to leave room for a distributor-less platform_admin role).
-- That default is deliberately left in place rather than dropped after
-- backfill: it means any row created by code that doesn't yet know about
-- distributors still lands correctly under CHC, which matters because the
-- app is redeployed after this migration runs, not atomically with it.

CREATE TABLE IF NOT EXISTS public.distributors (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  varchar(200) NOT NULL,
    slug                  varchar(80) NOT NULL,
    custom_domain         varchar(255),
    logo_url              text,
    contact_email         varchar(255),
    contact_phone         varchar(50),
    settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
    stripe_account_id     text,
    stripe_connect_status varchar(20) NOT NULL DEFAULT 'not_connected',
    is_active             boolean NOT NULL DEFAULT true,
    is_default            boolean NOT NULL DEFAULT false,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT distributors_slug_key UNIQUE (slug),
    CONSTRAINT distributors_custom_domain_key UNIQUE (custom_domain),
    CONSTRAINT distributors_stripe_connect_status_chk CHECK (
        stripe_connect_status IN ('not_connected', 'pending', 'active', 'restricted')
    )
);

-- Only one distributor may be the fallback tenant (the one a request maps to
-- when its Host header doesn't match anyone's custom domain or subdomain --
-- i.e. every request today, and chcsale.com forever per Adam).
CREATE UNIQUE INDEX IF NOT EXISTS idx_distributors_single_default
    ON public.distributors (is_default) WHERE is_default;

ALTER TABLE public.distributors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.distributors FROM anon;

INSERT INTO public.distributors (id, name, slug, custom_domain, is_default, is_active)
VALUES ('4d763514-3a41-45f2-b31d-e38756ba1595', 'CHC Paint & Auto Body Supplies', 'chc', 'chcsale.com', true, true)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------
-- Thread distributor_id through the tables that assumed a single seller.
-- ------------------------------------------------------------------

ALTER TABLE public.admin_users
    ADD COLUMN IF NOT EXISTS distributor_id uuid
        REFERENCES public.distributors(id) ON DELETE SET NULL
        DEFAULT '4d763514-3a41-45f2-b31d-e38756ba1595';
CREATE INDEX IF NOT EXISTS idx_admin_users_distributor ON public.admin_users (distributor_id);

ALTER TABLE public.supplier_branches
    ADD COLUMN IF NOT EXISTS distributor_id uuid NOT NULL
        REFERENCES public.distributors(id) ON DELETE RESTRICT
        DEFAULT '4d763514-3a41-45f2-b31d-e38756ba1595';
CREATE INDEX IF NOT EXISTS idx_supplier_branches_distributor ON public.supplier_branches (distributor_id);

ALTER TABLE public.item_library
    ADD COLUMN IF NOT EXISTS distributor_id uuid NOT NULL
        REFERENCES public.distributors(id) ON DELETE RESTRICT
        DEFAULT '4d763514-3a41-45f2-b31d-e38756ba1595';
CREATE INDEX IF NOT EXISTS idx_item_library_distributor ON public.item_library (distributor_id);

-- The master catalog was one shared SKU space; it becomes one per distributor.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_library_sku_key_unique') THEN
        ALTER TABLE public.item_library DROP CONSTRAINT item_library_sku_key_unique;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_library_distributor_sku_key_unique') THEN
        ALTER TABLE public.item_library
            ADD CONSTRAINT item_library_distributor_sku_key_unique UNIQUE (distributor_id, sku_key);
    END IF;
END $$;

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS distributor_id uuid NOT NULL
        REFERENCES public.distributors(id) ON DELETE RESTRICT
        DEFAULT '4d763514-3a41-45f2-b31d-e38756ba1595';
CREATE INDEX IF NOT EXISTS idx_companies_distributor ON public.companies (distributor_id);

-- Company slugs were globally unique (one login namespace); they become
-- unique per distributor, since two distributors can each have an "acme".
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_slug_key') THEN
        ALTER TABLE public.companies DROP CONSTRAINT companies_slug_key;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_distributor_slug_key') THEN
        ALTER TABLE public.companies
            ADD CONSTRAINT companies_distributor_slug_key UNIQUE (distributor_id, slug);
    END IF;
END $$;

-- A platform-level role that sits above every distributor's own super_admin.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_role') THEN
        ALTER TABLE public.admin_users DROP CONSTRAINT valid_role;
    END IF;
    ALTER TABLE public.admin_users
        ADD CONSTRAINT valid_role CHECK (
            (role)::text = ANY (ARRAY['platform_admin', 'super_admin', 'company_admin', 'admin', 'order_desk', 'order_manager']::text[])
        );
END $$;
