/**
 * utils/adoption-data.js
 *
 * Reads the rows the weekly adoption report is built from and hands them to
 * utils/adoption.js. Shared by the console screen (routes/admin-adoption.js)
 * and the Monday email (utils/adoption-digest.js), so the two can never
 * disagree about a number.
 */

const { supabaseAdmin } = require('./supabase');
const { weekRanges, buildAdoption } = require('./adoption');

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
 * A table that does not exist yet (a migration not applied) yields no rows and
 * a note rather than failing the whole report.
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

/**
 * @param {Object}   o
 * @param {string[]} [o.companyIds]     null/undefined = every company
 * @param {string}   [o.distributorId]  limit to one distributor's companies
 * @param {number}   [o.weeks]
 * @param {Date}     [o.asOf]           report as of this moment. The last week is
 *                                      the one containing it. Pass a moment in the
 *                                      past (the end of last week) for a report
 *                                      on a week that has finished.
 */
async function loadAdoptionReport({ companyIds = null, distributorId = null, weeks = 8, asOf = new Date() } = {}) {
    const ranges = weekRanges(weeks, asOf);
    const from = ranges[0].start;
    const to = new Date(Math.min(Date.now(), new Date(ranges[ranges.length - 1].end).getTime())).toISOString();
    const notes = [];

    const { rows: companies } = await readAll(() => {
        let q = supabaseAdmin.from('companies').select('id, name, is_active, settings');
        if (distributorId) q = q.eq('distributor_id', distributorId);
        if (companyIds) q = q.in('id', companyIds);
        return q;
    });
    const live = companies.filter(c => c.is_active !== false);
    const ids = live.map(c => c.id);
    if (!ids.length) return { ...buildAdoption({ ranges }), notes, generated_at: new Date().toISOString() };

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
    return { ...report, notes, generated_at: new Date().toISOString() };
}

module.exports = { loadAdoptionReport, readAll };
