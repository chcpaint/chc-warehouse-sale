-- ============================================
-- CHC Warehouse Sale - Token System Migration
-- Run this in Supabase SQL Editor
-- Dashboard > SQL Editor > New Query
-- ============================================

-- 1. Create the tokens table
CREATE TABLE IF NOT EXISTS catalog_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token VARCHAR(20) UNIQUE NOT NULL,
  customer_name VARCHAR(255),
  customer_email VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  used_ip VARCHAR(45),
  is_active BOOLEAN DEFAULT true,
  notes TEXT
);

-- 2. Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_tokens_token ON catalog_tokens(token);
CREATE INDEX IF NOT EXISTS idx_tokens_active ON catalog_tokens(is_active, expires_at);

-- 3. Enable Row Level Security
ALTER TABLE catalog_tokens ENABLE ROW LEVEL SECURITY;

-- 4. Policy for service role access (your backend uses the service key)
CREATE POLICY "Service role full access" ON catalog_tokens
  FOR ALL USING (true);

-- ============================================
-- Token Generation Function
-- Usage: SELECT * FROM generate_catalog_token('John Smith', 'john@example.com', 72, 'Trade show lead');
-- ============================================
CREATE OR REPLACE FUNCTION generate_catalog_token(
  p_customer_name VARCHAR DEFAULT NULL,
  p_customer_email VARCHAR DEFAULT NULL,
  p_expires_hours INTEGER DEFAULT 72,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE(token VARCHAR, expires_at TIMESTAMP WITH TIME ZONE) AS $$
DECLARE
  v_token VARCHAR(20);
  v_expires TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Generate random token: CHC-XXXXX-XXXXX
  v_token := 'CHC-' ||
    UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 5)) || '-' ||
    UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 5));

  v_expires := NOW() + (p_expires_hours || ' hours')::INTERVAL;

  -- Insert the token
  INSERT INTO catalog_tokens (token, customer_name, customer_email, expires_at, notes)
  VALUES (v_token, p_customer_name, p_customer_email, v_expires, p_notes);

  RETURN QUERY SELECT v_token, v_expires;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Token Validation Function (called by your API)
-- ============================================
CREATE OR REPLACE FUNCTION validate_and_use_token(
  p_token VARCHAR,
  p_ip VARCHAR DEFAULT NULL
)
RETURNS TABLE(valid BOOLEAN, message VARCHAR, customer_name VARCHAR) AS $$
DECLARE
  v_record catalog_tokens%ROWTYPE;
BEGIN
  -- Find the token
  SELECT * INTO v_record FROM catalog_tokens ct WHERE ct.token = UPPER(p_token);

  -- Token not found
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Invalid token'::VARCHAR, NULL::VARCHAR;
    RETURN;
  END IF;

  -- Token not active (revoked)
  IF NOT v_record.is_active THEN
    RETURN QUERY SELECT false, 'Token has been revoked'::VARCHAR, NULL::VARCHAR;
    RETURN;
  END IF;

  -- Token expired
  IF v_record.expires_at < NOW() THEN
    RETURN QUERY SELECT false, 'Token has expired'::VARCHAR, NULL::VARCHAR;
    RETURN;
  END IF;

  -- Token already used
  IF v_record.used_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'Token has already been used'::VARCHAR, NULL::VARCHAR;
    RETURN;
  END IF;

  -- Mark token as used
  UPDATE catalog_tokens
  SET used_at = NOW(), used_ip = p_ip
  WHERE id = v_record.id;

  -- Return success
  RETURN QUERY SELECT true, 'Access granted'::VARCHAR, v_record.customer_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Helper View: Token Status Dashboard
-- Usage: SELECT * FROM token_status;
-- ============================================
CREATE OR REPLACE VIEW token_status AS
SELECT
  token,
  customer_name,
  customer_email,
  created_at,
  expires_at,
  used_at,
  CASE
    WHEN NOT is_active THEN 'REVOKED'
    WHEN used_at IS NOT NULL THEN 'USED'
    WHEN expires_at < NOW() THEN 'EXPIRED'
    ELSE 'ACTIVE'
  END as status,
  notes
FROM catalog_tokens
ORDER BY created_at DESC;

-- ============================================
-- Quick Test: Generate a test token (optional)
-- Uncomment the line below to create a test token
-- ============================================
-- SELECT * FROM generate_catalog_token('Test User', 'test@example.com', 24, 'Test token - delete later');
