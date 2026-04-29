-- ============================================================
-- CHC Multi-Tenant B2B Platform - Database Migration
-- Version: 1.0
-- Description: Complete multi-tenant schema with RLS policies
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. COMPANIES TABLE (Tenants)
-- ============================================================
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    access_code VARCHAR(255) NOT NULL, -- bcrypt hashed
    logo_url TEXT,
    contact_email VARCHAR(255),
    contact_phone VARCHAR(50),
    address TEXT,
    email_config JSONB DEFAULT '{}', -- EmailJS routing per location
    settings JSONB DEFAULT '{}', -- company-specific settings
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_companies_slug ON companies(slug);
CREATE INDEX idx_companies_active ON companies(is_active) WHERE is_active = true;

-- ============================================================
-- 2. PRODUCTS TABLE (Per-company catalog)
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    brand VARCHAR(255) NOT NULL,
    name VARCHAR(500) NOT NULL,
    sku VARCHAR(100),
    description TEXT,
    category VARCHAR(255),
    price DECIMAL(10,2) NOT NULL,
    previous_price DECIMAL(10,2), -- for showing "was $X, now $Y"
    case_qty INTEGER DEFAULT 1,
    unit VARCHAR(50) DEFAULT 'each',
    image_url TEXT,
    metadata JSONB DEFAULT '{}', -- flexible extra fields
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_company ON products(company_id);
CREATE INDEX idx_products_brand ON products(company_id, brand);
CREATE INDEX idx_products_category ON products(company_id, category);
CREATE INDEX idx_products_sku ON products(company_id, sku);
CREATE INDEX idx_products_active ON products(company_id, is_active) WHERE is_active = true;

-- ============================================================
-- 3. PROMOTIONS TABLE (Global + per-company)
-- ============================================================
CREATE TABLE IF NOT EXISTS promotions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE, -- NULL = global
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    promo_price DECIMAL(10,2) NOT NULL,
    promo_label VARCHAR(255), -- "Spring Sale", "Clearance", etc.
    description TEXT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_date_range CHECK (ends_at > starts_at),
    CONSTRAINT valid_promo_price CHECK (promo_price >= 0)
);

CREATE INDEX idx_promotions_company ON promotions(company_id);
CREATE INDEX idx_promotions_product ON promotions(product_id);
CREATE INDEX idx_promotions_active ON promotions(is_active, starts_at, ends_at)
    WHERE is_active = true;
CREATE INDEX idx_promotions_global ON promotions(company_id) WHERE company_id IS NULL;

-- ============================================================
-- 4. ORDERS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    order_number VARCHAR(50) NOT NULL UNIQUE,
    contact_name VARCHAR(255) NOT NULL,
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(50),
    company_name VARCHAR(255), -- snapshot at order time
    location VARCHAR(255), -- branch/shop location
    items JSONB NOT NULL, -- [{product_id, name, sku, qty, price, subtotal}]
    subtotal DECIMAL(10,2) NOT NULL,
    tax DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    notes TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    status_history JSONB DEFAULT '[]', -- [{status, timestamp, note}]
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_company ON orders(company_id);
CREATE INDEX idx_orders_status ON orders(company_id, status);
CREATE INDEX idx_orders_date ON orders(company_id, created_at DESC);
CREATE INDEX idx_orders_number ON orders(order_number);

-- ============================================================
-- 5. ADMIN USERS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, -- bcrypt
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'company_admin',
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL, -- NULL = super_admin
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_role CHECK (role IN ('super_admin', 'company_admin'))
);

CREATE INDEX idx_admin_email ON admin_users(email);
CREATE INDEX idx_admin_company ON admin_users(company_id);

-- ============================================================
-- 6. AUDIT LOG TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID REFERENCES admin_users(id),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL, -- company, product, promotion, order
    entity_id UUID,
    details JSONB DEFAULT '{}',
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_admin ON audit_log(admin_id);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_date ON audit_log(created_at DESC);

-- ============================================================
-- 7. CATALOG UPLOADS TABLE (track import history)
-- ============================================================
CREATE TABLE IF NOT EXISTS catalog_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    admin_id UUID REFERENCES admin_users(id),
    filename VARCHAR(500) NOT NULL,
    file_type VARCHAR(20) NOT NULL, -- csv, xlsx, pdf
    file_url TEXT,
    row_count INTEGER DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'processing', -- processing, completed, failed
    error_details JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_uploads_company ON catalog_uploads(company_id);

-- ============================================================
-- 8. ROW LEVEL SECURITY POLICIES
-- ============================================================

-- Enable RLS on all tenant tables
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_uploads ENABLE ROW LEVEL SECURITY;

-- Companies: viewable by authenticated users matching the company
CREATE POLICY companies_select ON companies
    FOR SELECT USING (true); -- companies list is public (for login slug lookup)

CREATE POLICY companies_admin ON companies
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM admin_users
            WHERE admin_users.id = auth.uid()
            AND (admin_users.role = 'super_admin' OR admin_users.company_id = companies.id)
        )
    );

-- Products: viewable by company members, manageable by admins
CREATE POLICY products_select ON products
    FOR SELECT USING (
        is_active = true
        AND EXISTS (SELECT 1 FROM companies WHERE companies.id = products.company_id AND companies.is_active = true)
    );

CREATE POLICY products_admin ON products
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM admin_users
            WHERE admin_users.id = auth.uid()
            AND (admin_users.role = 'super_admin' OR admin_users.company_id = products.company_id)
        )
    );

-- Promotions: viewable when active and within date range
CREATE POLICY promotions_select ON promotions
    FOR SELECT USING (
        is_active = true
        AND NOW() BETWEEN starts_at AND ends_at
    );

CREATE POLICY promotions_admin ON promotions
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM admin_users
            WHERE admin_users.id = auth.uid()
            AND (admin_users.role = 'super_admin' OR admin_users.company_id = promotions.company_id)
        )
    );

-- Orders: viewable by owning company, manageable by admins
CREATE POLICY orders_select ON orders
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM admin_users
            WHERE admin_users.id = auth.uid()
            AND (admin_users.role = 'super_admin' OR admin_users.company_id = orders.company_id)
        )
    );

CREATE POLICY orders_insert ON orders
    FOR INSERT WITH CHECK (true); -- customers can place orders

CREATE POLICY orders_admin ON orders
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM admin_users
            WHERE admin_users.id = auth.uid()
            AND (admin_users.role = 'super_admin' OR admin_users.company_id = orders.company_id)
        )
    );

-- ============================================================
-- 9. HELPER FUNCTIONS
-- ============================================================

-- Generate unique order numbers
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER AS $$
BEGIN
    NEW.order_number := 'CHC-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' ||
                        UPPER(SUBSTRING(NEW.id::TEXT, 1, 6));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_order_number
    BEFORE INSERT ON orders
    FOR EACH ROW
    EXECUTE FUNCTION generate_order_number();

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER promotions_updated_at BEFORE UPDATE ON promotions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER admin_users_updated_at BEFORE UPDATE ON admin_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 10. STORAGE BUCKETS (run via Supabase dashboard or API)
-- ============================================================
-- Note: Execute these via Supabase Storage API or dashboard:
--
-- Bucket: company-logos (public read, admin write)
-- Bucket: catalog-files (private, admin only)
-- Bucket: product-images (public read, admin write)
--
-- Storage policies should restrict uploads to admin users only
-- and allow public read access for logos and product images.

-- ============================================================
-- 11. SEED DATA - First super admin placeholder
-- ============================================================
-- Run after deployment:
-- INSERT INTO admin_users (email, password_hash, name, role)
-- VALUES ('admin@chcpaint.com', '<bcrypt_hash>', 'CHC Admin', 'super_admin');
