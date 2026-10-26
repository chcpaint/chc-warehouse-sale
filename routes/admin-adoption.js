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
const { isValidUUID } = require('../utils/sanitize');
const { loadAdoptionReport } = require('../utils/adoption-data');
const { digestInfo, sendDigestNow } = require('../utils/adoption-digest');

const router = express.Router();

async function load(req) {
    const isSuper = req.admin.role === 'super_admin';
    let companyIds = null;
    if (!isSuper) {
        if (!req.admin.company_id) return { status: 403, body: { error: 'No company on this account.' } };
        companyIds = [req.admin.company_id];
    } else if (req.query.company_id && isValidUUID(req.query.company_id)) {
        companyIds = [req.query.company_id];
    }
    const report = await loadAdoptionReport({
        companyIds, distributorId: req.distributor ? req.distributor.id : null, weeks: req.query.weeks
    });
    // The email list is CHC's business, not a customer's.
    const body = isSuper ? { ...report, digest: digestInfo() } : report;
    return { status: 200, body };
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

/**
 * POST /api/admin/adoption/email-now   {test: true}
 * Super admin only. Sends last week's report right now: to the standing list,
 * or, with {test: true}, only to the person asking.
 */
router.post('/email-now', async (req, res) => {
    try {
        if (req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Only a super admin can send the report.' });
        let to;
        if (req.body && req.body.test === true) {
            if (!req.admin.email) return res.status(400).json({ error: 'Your account has no email address to send a test to.' });
            to = [req.admin.email];
        }
        const result = await sendDigestNow({ to });
        if (!result.sent) {
            return res.status(502).json({
                error: result.reason === 'not_configured'
                    ? 'Email is not set up on the server, so nothing was sent.'
                    : `The email could not be sent${result.error ? ': ' + result.error : '.'}`
            });
        }
        res.json({ message: `Sent the report for ${result.week} to ${result.to.join(', ')}.`, to: result.to });
    } catch (err) {
        console.error('Adoption email-now error:', err);
        res.status(500).json({ error: 'Could not send the report.' });
    }
});

module.exports = router;
