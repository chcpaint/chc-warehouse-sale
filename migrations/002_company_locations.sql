-- ============================================================
-- CHC Multi-Tenant B2B Platform - Migration 002
-- Description: Add company locations table
-- ============================================================

CREATE TABLE IF NOT EXISTS company_locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(255),
    address TEXT,
    contact_name VARCHAR(255),
    contact_phone VARCHAR(50),
    contact_email VARCHAR(255),
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_locations_company ON company_locations(company_id);
CREATE INDEX idx_locations_active ON company_locations(company_id, is_active) WHERE is_active = true;

-- Auto-update timestamp trigger
CREATE TRIGGER company_locations_updated_at BEFORE UPDATE ON company_locations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
