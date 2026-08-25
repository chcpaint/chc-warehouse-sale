const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../utils/supabase');
const { stripHtml, validateEmail } = require('../utils/sanitize');

const router = express.Router();

/**
 * POST /api/auth/company-login
 * Company users log in with slug + access code
 */
router.post('/company-login', async (req, res) => {
    try {
        const slug = stripHtml(req.body.slug);
        const accessCode = req.body.access_code;

        if (!slug || !accessCode) {
            return res.status(400).json({ error: 'Company identifier and access code are required.' });
        }

        // Look up company by slug
        const { data: company, error } = await supabaseAdmin
            .from('companies')
            .select('id, name, slug, access_code, logo_url, is_active, settings')
            .eq('slug', slug)
            .single();

        if (error || !company) {
            return res.status(401).json({ error: 'Invalid company or access code.' });
        }

        if (!company.is_active) {
            return res.status(403).json({ error: 'This company account is currently inactive.' });
        }

        // Verify access code
        const validCode = await bcrypt.compare(accessCode, company.access_code);
        if (!validCode) {
            return res.status(401).json({ error: 'Invalid company or access code.' });
        }

        // Generate JWT
        const token = jwt.sign({
            type: 'company',
            company_id: company.id,
            slug: company.slug,
            company_name: company.name
        }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({
            token,
            company: {
                id: company.id,
                name: company.name,
                slug: company.slug,
                logo_url: company.logo_url,
                settings: company.settings
            }
        });

    } catch (err) {
        console.error('Company login error:', err);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

/**
 * POST /api/auth/admin-login
 * Admin users log in with email + password
 */
router.post('/admin-login', async (req, res) => {
    try {
        const email = stripHtml(req.body.email)?.toLowerCase();
        const password = req.body.password;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format.' });
        }

        // Look up admin
        const { data: admin, error } = await supabaseAdmin
            .from('admin_users')
            .select('id, email, name, role, company_id, branch_id, password_hash, is_active')
            .eq('email', email)
            .single();

        if (error || !admin) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        if (!admin.is_active) {
            return res.status(403).json({ error: 'This admin account is disabled.' });
        }

        // An invited account that has not set a password yet cannot log in.
        if (!admin.password_hash) {
            return res.status(403).json({ error: 'This invite has not been accepted yet. Check your email for the set-password link.' });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, admin.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        // Update last login
        await supabaseAdmin
            .from('admin_users')
            .update({ last_login: new Date().toISOString() })
            .eq('id', admin.id);

        // Generate JWT
        const token = jwt.sign({
            type: 'admin',
            admin_id: admin.id,
            role: admin.role,
            company_id: admin.company_id,
            branch_id: admin.branch_id
        }, process.env.JWT_SECRET, { expiresIn: '12h' });

        res.json({
            token,
            admin: {
                id: admin.id,
                email: admin.email,
                name: admin.name,
                role: admin.role,
                company_id: admin.company_id,
                branch_id: admin.branch_id
            }
        });

    } catch (err) {
        console.error('Admin login error:', err);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

/**
 * POST /api/auth/admin-setup
 * Create first super admin (only works when no admins exist)
 */
router.post('/admin-setup', async (req, res) => {
    try {
        // Check if any admins exist
        const { count } = await supabaseAdmin
            .from('admin_users')
            .select('id', { count: 'exact', head: true });

        if (count > 0) {
            return res.status(403).json({ error: 'Admin setup already completed.' });
        }

        const { email, password, name } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Email, password, and name are required.' });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format.' });
        }

        // Password strength check
        if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
            return res.status(400).json({
                error: 'Password must be at least 8 characters with uppercase, lowercase, and a number.'
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const { data: admin, error } = await supabaseAdmin
            .from('admin_users')
            .insert({
                email: email.toLowerCase(),
                password_hash: passwordHash,
                name: stripHtml(name),
                role: 'super_admin',
                is_active: true
            })
            .select('id, email, name, role')
            .single();

        if (error) {
            console.error('Admin setup error:', error);
            return res.status(500).json({ error: 'Failed to create admin account.' });
        }

        const token = jwt.sign({
            type: 'admin',
            admin_id: admin.id,
            role: 'super_admin',
            company_id: null
        }, process.env.JWT_SECRET, { expiresIn: '12h' });

        res.status(201).json({ token, admin });

    } catch (err) {
        console.error('Admin setup error:', err);
        res.status(500).json({ error: 'Setup failed.' });
    }
});

/** Shared password policy. */
function weakPassword(pw) {
    return !pw || pw.length < 8 || !/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw);
}
const PW_RULE = 'Password must be at least 8 characters with uppercase, lowercase, and a number.';

/**
 * POST /api/auth/admin-accept-invite   Body: { token, password }
 * A CHC staff member sets their password from an invite link and is logged in.
 */
router.post('/admin-accept-invite', async (req, res) => {
    try {
        const token = String(req.body.token || '');
        const password = req.body.password;
        if (!token) return res.status(400).json({ error: 'Missing invite token.' });
        if (weakPassword(password)) return res.status(400).json({ error: PW_RULE });

        const { data: admin } = await supabaseAdmin
            .from('admin_users')
            .select('id, email, name, role, company_id, branch_id, invite_expires_at, is_active')
            .eq('invite_token', token)
            .maybeSingle();

        if (!admin) return res.status(400).json({ error: 'This invite link is invalid or has already been used.' });
        if (!admin.is_active) return res.status(403).json({ error: 'This account is disabled.' });
        if (admin.invite_expires_at && new Date(admin.invite_expires_at) < new Date()) {
            return res.status(400).json({ error: 'This invite has expired. Ask an administrator to resend it.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        await supabaseAdmin.from('admin_users')
            .update({ password_hash: passwordHash, invite_token: null, invite_expires_at: null, last_login: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', admin.id);

        const jwtToken = jwt.sign({
            type: 'admin', admin_id: admin.id, role: admin.role, company_id: admin.company_id, branch_id: admin.branch_id
        }, process.env.JWT_SECRET, { expiresIn: '12h' });

        res.json({
            token: jwtToken,
            admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role, company_id: admin.company_id, branch_id: admin.branch_id }
        });
    } catch (err) {
        console.error('Admin accept-invite error:', err);
        res.status(500).json({ error: 'Could not activate the account.' });
    }
});

/**
 * POST /api/auth/company-user-login   Body: { slug, email, password }
 * Individual customer login, available when the company has the Customer-users
 * module on. The order placed in this session is attributed to this person.
 */
router.post('/company-user-login', async (req, res) => {
    try {
        const slug = stripHtml(req.body.slug);
        const email = stripHtml(req.body.email)?.toLowerCase();
        const password = req.body.password;
        if (!slug || !email || !password) return res.status(400).json({ error: 'Company, email and password are required.' });

        const { data: company } = await supabaseAdmin
            .from('companies')
            .select('id, name, slug, logo_url, is_active, settings')
            .eq('slug', slug)
            .maybeSingle();
        if (!company || !company.is_active) return res.status(401).json({ error: 'Invalid company or credentials.' });

        const usersOn = company.settings?.users?.enabled === true;
        if (!usersOn) return res.status(403).json({ error: 'Individual logins are not enabled for this company.' });

        const { data: user } = await supabaseAdmin
            .from('company_users')
            .select('id, email, name, role, location_id, password_hash, is_active')
            .eq('company_id', company.id)
            .eq('email', email)
            .maybeSingle();

        if (!user || !user.is_active || !user.password_hash) return res.status(401).json({ error: 'Invalid company or credentials.' });
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid company or credentials.' });

        await supabaseAdmin.from('company_users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

        const token = jwt.sign({
            type: 'company_user',
            company_id: company.id, slug: company.slug, company_name: company.name,
            user_id: user.id, user_name: user.name, user_email: user.email, user_role: user.role,
            location_id: user.location_id
        }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({
            token,
            company: { id: company.id, name: company.name, slug: company.slug, logo_url: company.logo_url, settings: company.settings },
            user: { id: user.id, name: user.name, email: user.email, role: user.role, location_id: user.location_id }
        });
    } catch (err) {
        console.error('Company user login error:', err);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

/**
 * POST /api/auth/company-accept-invite   Body: { token, password }
 * A customer user sets their password from an invite and is logged in.
 */
router.post('/company-accept-invite', async (req, res) => {
    try {
        const token = String(req.body.token || '');
        const password = req.body.password;
        if (!token) return res.status(400).json({ error: 'Missing invite token.' });
        if (weakPassword(password)) return res.status(400).json({ error: PW_RULE });

        const { data: user } = await supabaseAdmin
            .from('company_users')
            .select('id, email, name, role, location_id, company_id, invite_expires_at, is_active')
            .eq('invite_token', token)
            .maybeSingle();
        if (!user) return res.status(400).json({ error: 'This invite link is invalid or has already been used.' });
        if (!user.is_active) return res.status(403).json({ error: 'This account is disabled.' });
        if (user.invite_expires_at && new Date(user.invite_expires_at) < new Date()) {
            return res.status(400).json({ error: 'This invite has expired. Ask your administrator to resend it.' });
        }

        const { data: company } = await supabaseAdmin
            .from('companies').select('id, name, slug, logo_url, settings').eq('id', user.company_id).maybeSingle();

        const passwordHash = await bcrypt.hash(password, 12);
        await supabaseAdmin.from('company_users')
            .update({ password_hash: passwordHash, invite_token: null, invite_expires_at: null, last_login: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', user.id);

        const jwtToken = jwt.sign({
            type: 'company_user',
            company_id: company.id, slug: company.slug, company_name: company.name,
            user_id: user.id, user_name: user.name, user_email: user.email, user_role: user.role,
            location_id: user.location_id
        }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({
            token: jwtToken,
            company: { id: company.id, name: company.name, slug: company.slug, logo_url: company.logo_url, settings: company.settings },
            user: { id: user.id, name: user.name, email: user.email, role: user.role, location_id: user.location_id }
        });
    } catch (err) {
        console.error('Company accept-invite error:', err);
        res.status(500).json({ error: 'Could not activate the account.' });
    }
});

module.exports = router;
