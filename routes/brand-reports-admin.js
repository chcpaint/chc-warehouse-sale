/**
 * routes/brand-reports-admin.js
 *
 * Monthly brand sales reports in the admin console (first one: Assured, 3M).
 * See utils/brand-sales-report.js for exactly what is counted and
 * migrations/056_monthly_brand_reports.sql for what is stored.
 *
 * Mounted from routes/admin.js at /api/admin/brand-reports, so it inherits
 * requireAdminAuth, restrictOrderDesk and requirePasswordCurrent. Order-desk
 * and order-manager accounts never reach it: restrictOrderDesk is an allow-list
 * and /brand-reports is not on it.
 *
 *   GET  /                                          the reports each customer receives
 *   GET  /:companyId/:brand/preview?period=YYYY-MM  the month and year to date as JSON
 *   GET  /:companyId/:brand/download?period=&format=xlsx|pdf
 *   POST /:companyId/:brand/generate  {period}      (re)build a finished month, super admin
 *
 * A super admin sees every customer that has a subscription; a company admin
 * sees their own company only, whatever they put in the URL. This route only
 * READS orders and writes report snapshots; it never changes an order, a
 * catalogue, or any company setting.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { isValidUUID } = require('../utils/sanitize');
const R = require('../utils/brand-sales-report');
const D = require('../utils/brand-report-data');

const router = express.Router();

const MIME = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pdf: 'application/pdf'
};

function role(req) { return req.admin && req.admin.role; }

/** super_admin: any customer (within their distributor). company_admin: their own only. */
async function resolveSubscription(req, res) {
    const { companyId } = req.params;
    const brand = String(req.params.brand || '').trim();
    if (!isValidUUID(companyId) || !brand || brand.length > 60) {
        res.status(400).json({ error: 'That report could not be found.' });
        return null;
    }
    if (role(req) !== 'super_admin') {
        if (role(req) !== 'company_admin' || req.admin.company_id !== companyId) {
            res.status(403).json({ error: 'Access denied for this report.' });
            return null;
        }
    }
    const { data: sub } = await supabaseAdmin.from('brand_report_subscriptions')
        .select('company_id, brand').eq('company_id', companyId).ilike('brand', brand).eq('is_enabled', true).maybeSingle();
    if (!sub) { res.status(404).json({ error: 'That report is not set up for this customer.' }); return null; }

    const { data: company } = await supabaseAdmin.from('companies').select('id, name, distributor_id').eq('id', companyId).maybeSingle();
    if (!company || (req.distributor && company.distributor_id !== req.distributor.id)) {
        res.status(404).json({ error: 'That report could not be found.' });
        return null;
    }
    return { companyId, brand: sub.brand, companyName: company.name };
}

function readPeriod(req, res) {
    const period = String(req.query.period || req.body && req.body.period || '').trim() || R.previousPeriod();
    if (!R.isPeriod(period)) {
        res.status(400).json({ error: 'Choose a month as YYYY-MM, for example 2026-10.' });
        return null;
    }
    if (period > R.currentPeriod()) {
        res.status(400).json({ error: 'That month has not started yet.' });
        return null;
    }
    return period;
}

router.get('/', async (req, res) => {
    try {
        let q = supabaseAdmin.from('brand_report_subscriptions').select('company_id, brand').eq('is_enabled', true);
        if (role(req) !== 'super_admin') {
            if (role(req) !== 'company_admin' || !req.admin.company_id) return res.json({ reports: [], current_period: R.currentPeriod() });
            q = q.eq('company_id', req.admin.company_id);
        }
        const { data: subs, error } = await q;
        if (error) {
            if (/brand_report_subscriptions|does not exist|schema cache/i.test(error.message || '')) {
                return res.json({ reports: [], current_period: R.currentPeriod(), not_installed: true });
            }
            throw error;
        }
        const out = [];
        for (const s of subs || []) {
            const { data: company } = await supabaseAdmin.from('companies').select('id, name, distributor_id').eq('id', s.company_id).maybeSingle();
            if (!company || (req.distributor && company.distributor_id !== req.distributor.id)) continue;
            out.push({
                company_id: company.id, company_name: company.name, brand: s.brand,
                months: await D.listReports({ companyId: s.company_id, brand: s.brand })
            });
        }
        out.sort((a, b) => a.company_name.localeCompare(b.company_name));
        res.json({
            reports: out, current_period: R.currentPeriod(), current_label: R.periodLabel(R.currentPeriod()),
            previous_period: R.previousPeriod(), schedule: 'The 1st of every month, about 6 a.m. Toronto time, for the month that just ended.',
            can_generate: role(req) === 'super_admin'
        });
    } catch (err) {
        console.error('Brand reports list error:', err);
        res.status(500).json({ error: 'Could not load the monthly reports.' });
    }
});

router.get('/:companyId/:brand/preview', async (req, res) => {
    try {
        const sub = await resolveSubscription(req, res); if (!sub) return;
        const period = readPeriod(req, res); if (!period) return;
        const report = await D.buildReport({ companyId: sub.companyId, companyName: sub.companyName, brand: sub.brand, period, adminId: req.admin.id });
        res.json({ ...report, basis: R.BASIS_TEXT });
    } catch (err) {
        console.error('Brand report preview error:', err);
        res.status(500).json({ error: 'Could not build that report.' });
    }
});

router.get('/:companyId/:brand/download', async (req, res) => {
    try {
        const sub = await resolveSubscription(req, res); if (!sub) return;
        const period = readPeriod(req, res); if (!period) return;
        const format = String(req.query.format || 'xlsx').toLowerCase();
        if (!MIME[format]) return res.status(400).json({ error: 'Choose xlsx or pdf.' });

        const report = await D.buildReport({ companyId: sub.companyId, companyName: sub.companyName, brand: sub.brand, period, adminId: req.admin.id });
        const body = format === 'pdf' ? await R.renderPdf(report) : R.renderXlsx(report);
        const name = `${R.fileBase({ company: sub.companyName, brand: sub.brand, period })}${report.partial ? '-month-to-date' : ''}.${format}`;

        res.setHeader('Content-Type', MIME[format]);
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(body);

        supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'brand_report_downloaded', entity_type: 'brand_report', entity_id: sub.companyId,
            details: { brand: sub.brand, period, format }, ip_address: req.ip
        }).then(() => {}, () => {});
    } catch (err) {
        console.error('Brand report download error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Could not build that report file.' });
    }
});

router.post('/:companyId/:brand/generate', async (req, res) => {
    try {
        if (role(req) !== 'super_admin') return res.status(403).json({ error: 'Only a super admin can generate a report.' });
        const sub = await resolveSubscription(req, res); if (!sub) return;
        const period = readPeriod(req, res); if (!period) return;
        if (period >= R.currentPeriod()) {
            return res.status(400).json({ error: 'That month is still in progress. It is saved on the 1st of next month; the Month to date download is always up to the minute.' });
        }
        const snaps = await D.ensureSnapshots({
            companyId: sub.companyId, brand: sub.brand, periods: [period], source: 'manual', adminId: req.admin.id, force: true
        });
        const t = snaps[period].totals;
        supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action: 'brand_report_generated', entity_type: 'brand_report', entity_id: sub.companyId,
            details: { brand: sub.brand, period, ...t }, ip_address: req.ip
        }).then(() => {}, () => {});
        res.json({ message: `${R.periodLabel(period)} rebuilt: ${t.qty} units, $${t.amount.toFixed(2)}.`, period, totals: t });
    } catch (err) {
        console.error('Brand report generate error:', err);
        res.status(500).json({ error: 'Could not build that month.' });
    }
});

module.exports = router;
