/**
 * routes/admin-adoption.js
 *
 * The weekly adoption report: which shops entered the ordering console each
 * week, what they ordered, and who ordered it. See utils/adoption.js for what
 * each number means and what it is built from.
 *
 * Mounted from routes/admin.js at /api/admin/adoption, so it inherits
 * requireAdminAuth, restrictOrderDesk and requirePasswordCurrent. Order-desk and
 * order-manager accounts never reach it: restrictOrderDesk is an allow-list and
 * /adoption is not on it.
 *
 *   GET /api/admin/adoption?weeks=8&company_id=     the report
 *   GET /api/admin/adoption/csv?weeks=8&company_id= the same, one row per shop per week
 *
 * A company admin sees their own company only, whatever they put in the query.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { isValidUUID } = require('../utils/sanitize');
const { weekRanges, buildAdoption } = require('../utils/adoption');

const router = express.Router();

const PAGE = 1000;
const MAX_ROWS = 60000;

async function readAll(build) {
    const out = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
        const { data, error } = await build().range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        out.push(...rows);
        if (rows.length < PAGE) return { rows: out, truncated: false };
    }
    return { rows: out, truncated: true };
}

/**
 * Like readAll, but a table that does not exist yet (a migration not applied)
 * yields no rows and a note rather than failing the whole report.
 */
async function readOptional(build, note, notes) {
    try {
        return (await readAll(build)).rows;
    } catch (err) {
        console.error(`[adoption] ${note}:`, err.message || err.code);
        notes.push(note);
        return [];
    }
}

async function load(req) {
    const isSuper = req.admin.role === 'super_admin';
    let scopeIds = null;
    if (!isSuper) {
        if (!req.admin.company_id) return { status: 403, body: { error: 'No company on this account.' } };
        scopeIds = [req.admin.company_id];
    } else if (req.query.company_id && isValidUUID(req.query.company_id)) {
        scopeIds = [req.query.company_id];
    }

    const ranges = weekRanges(req.query.weeks, new Date());
    const from = ranges[0].start;
    const to = new Date().toISOString();
    const notes = [];

    const { rows: companies } = await readAll(() => {
        let q = supabaseAdmin.from('companies').select('id, name, is_active, settings');
        if (req.distributor) q = q.eq('distributor_id', req.distributor.id);
        if (scopeIds) q = q.in('id', scopeIds);
        return q;
    });
    const live = companies.filter(c => c.is_active !== false);
    const ids = live.map(c => c.id);
    if (!ids.length) {
        return { status: 200, body: { ...buildAdoption({ ranges }), notes, generated_at: to } };
    }

    const [{ rows: locations }, { rows: branches }] = await Promise.all([
        readAll(() => supabaseAdmin.from('company_locations')
            .select('id, company_id, name, city, is_active, supplier_branch_id').in('company_id', ids)),
        readAll(() => supabaseAdmin.from('supplier_branches').select('id, name'))
    ]);

    const [orders, visits, userLogins] = await Promise.all([
        readAll(() => supabaseAdmin.from('orders')
            .select('id, company_id, location_id, total, status, created_at, contact_name, placed_by_name')
            .in('company_id', ids)
            .not('status', 'in', '(cancelled)')
            .gte('created_at', from).lte('created_at', to)).then(r => r.rows),
        readOptional(() => supabaseAdmin.from('console_visits')
            .select('company_id, location_id, event, session_id, created_at')
            .in('company_id', ids).in('event', ['enter', 'login'])
            .gte('created_at', from).lte('created_at', to),
            'Store visit tracking is not available yet, so shop sign-ins show as zero.', notes),
        readOptional(() => supabaseAdmin.from('company_user_logins')
            .select('company_id, user_id, email, name, event, created_at')
            .in('company_id', ids).eq('event', 'login')
            .gte('created_at', from).lte('created_at', to),
            'Named sign-ins are not available yet.', notes)
    ]);

    const report = buildAdoption({ companies: live, locations, branches, visits, orders, userLogins, ranges });
    return { status: 200, body: { ...report, notes, generated_at: to } };
}

router.get('/', async (req, res) => {
    try {
        const out = await load(req);
        res.status(out.status).json(out.body);
    } catch (err) {
        console.error('Adoption report error:', err);
        res.status(500).json({ error: 'Could not build the adoption report.' });
    }
});

const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    // A spreadsheet treats a leading = + - @ as a formula. These are customer
    // typed names, so neutralise them.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
};

router.get('/csv', async (req, res) => {
    try {
        const out = await load(req);
        if (out.status !== 200) return res.status(out.status).json(out.body);
        const { weeks, locations } = out.body;
        const head = ['Company', 'Shop', 'City', 'CHC branch', 'Week starting', 'Week', 'Store entries',
            'Sessions', 'Orders', 'Order dollars', 'Active that week', 'Status now', 'Last seen', 'Who ordered (all weeks)'];
        const lines = [head.map(esc).join(',')];
        for (const l of locations) {
            const who = l.people.map(p => `${p.name} (${p.orders})`).join('; ');
            weeks.forEach((w, k) => {
                lines.push([
                    l.company_name, l.location, l.city, l.branch,
                    w.start.slice(0, 10), w.label + (w.current ? ' (so far)' : ''),
                    l.entries[k], l.sessions[k], l.orders[k], l.dollars[k].toFixed(2),
                    l.active_weeks[k] ? 'Yes' : 'No', l.status.replace(/_/g, ' '),
                    l.last_seen || '', k === 0 ? who : ''
                ].map(esc).join(','));
            });
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="weekly-adoption-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(lines.join('\n'));
    } catch (err) {
        console.error('Adoption CSV error:', err);
        res.status(500).json({ error: 'Could not build the adoption CSV.' });
    }
});

module.exports = router;
