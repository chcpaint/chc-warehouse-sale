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
            .select('id, email, name, role, company_id, password_hash, is_active')
            .eq('email', email)
            .single();

        if (error || !admin) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        if (!admin.is_active) {
            return res.status(403).json({ error: 'This admin account is disabled.' });
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
            company_id: admin.company_id
        }, process.env.JWT_SECRET, { expiresIn: '12h' });

        res.json({
            token,
            admin: {
                id: admin.id,
                email: admin.email,
                name: admin.name,
                role: admin.role,
                company_id: admin.company_id
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

/**
 * POST /api/auth/reset-admin-pw
 * Temporary endpoint to reset admin password using server-side bcrypt
 * REMOVE AFTER USE
 */
router.post('/reset-admin-pw', async (req, res) => {
    try {
        const secret = req.body.setup_secret;
        if (secret !== 'CHC-TEMP-SETUP-2026') {
            return res.status(403).json({ error: 'Invalid setup secret.' });
        }

        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        console.log('[TEMP] Resetting password for', email, '- hash prefix:', passwordHash.substring(0, 15));

        const { data, error } = await supabaseAdmin
            .from('admin_users')
            .update({ password_hash: passwordHash })
            .eq('email', email.toLowerCase())
            .select('id, email')
            .single();

        if (error || !data) {
            return res.status(500).json({ error: 'Failed to reset password.', detail: error?.message });
        }

        // Verify immediately
        const valid = await bcrypt.compare(password, passwordHash);
        res.json({ message: 'Password reset', email: data.email, verified: valid });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
