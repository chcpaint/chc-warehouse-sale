#!/usr/bin/env node
/**
 * scripts/create-platform-admin.js -- create the refinishAI platform admin
 * account (the one that opens the Distributors console to license other
 * distributors). Run once, with the app's own settings:
 *
 *   railway run node scripts/create-platform-admin.js you@example.com "Your Name"
 *
 * It prints a one-time link (valid 7 days) where the person chooses their own
 * password; nothing secret is typed on the command line. The account belongs to
 * no distributor, so it is separate from any CHC staff login: use a different
 * email address from your CHC console account.
 */
const crypto = require('crypto');
const { supabaseAdmin } = require('../utils/supabase');
const { validateEmail } = require('../utils/sanitize');

(async () => {
    const [, , emailArg, ...nameParts] = process.argv;
    const email = String(emailArg || '').trim().toLowerCase();
    const name = nameParts.join(' ').trim();
    if (!validateEmail(email) || !name) {
        console.error('Usage: railway run node scripts/create-platform-admin.js you@example.com "Your Name"');
        process.exit(2);
    }
    const { data: existing } = await supabaseAdmin.from('admin_users').select('id, role').eq('email', email).maybeSingle();
    if (existing) {
        console.error(`That email already has an account (role: ${existing.role}). Use a different email for the platform admin.`);
        process.exit(1);
    }
    const token = crypto.randomBytes(32).toString('hex');
    const { error } = await supabaseAdmin.from('admin_users').insert({
        email, name, role: 'platform_admin', distributor_id: null, company_id: null, branch_id: null,
        password_hash: null, is_active: true, invite_token: token,
        invite_expires_at: new Date(Date.now() + 7 * 864e5).toISOString()
    });
    if (error) { console.error('Could not create the account:', error.message); process.exit(1); }
    const base = (process.env.APP_URL || process.env.PUBLIC_URL || 'https://chcsale.com').replace(/\/$/, '');
    console.log(`\nPlatform admin created for ${name} <${email}>.`);
    console.log(`Open this link within 7 days to choose a password:\n\n  ${base}/set-password.html?token=${token}&kind=admin\n`);
    console.log(`Then sign in at ${base}/admin. The menu shows only "Distributors".`);
})().catch(err => { console.error(err.message || err); process.exit(1); });
