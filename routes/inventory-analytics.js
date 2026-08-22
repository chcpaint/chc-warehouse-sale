/**
 * routes/inventory-analytics.js
 *
 * refinishAI Inventory, phase 5 — consumption analytics.
 * Mounted from routes/inventory-store.js at
 *   /api/store/:slug/inventory/analytics
 *
 * The interesting number in a collision shop is not what is on the shelf, it is
 * what a repair order consumed. Every `consume` movement can carry a job / RO
 * reference, so materials cost per job falls straight out of the ledger.
 *
 * Aggregation happens in Postgres (see the inventory_consumption_* views);
 * this file is date handling, shaping and access control.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { isValidUUID } = require('../utils/sanitize');

const router = express.Router({ mergeParams: true });

// requireCompanyAuth and requireInventoryEnabled are applied by the parent.

/**
 * Resolve a named period, or an explicit from/to pair, into an ISO range.
 * Mirrors the period vocabulary the console's Reports tab already uses, so the
 * two read the same way to a user.
 */
function periodRange(query) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const startOf = (yy, mm, dd) => new Date(yy, mm, dd, 0, 0, 0, 0);
    const endOf = (yy, mm, dd) => new Date(yy, mm, dd, 23, 59, 59, 999);
    const iso = d => d.toISOString();

    switch (String(query.period || 'this_month')) {
        case 'last_7':
            return { from: iso(new Date(now.getTime() - 7 * 864e5)), to: iso(now), label: 'Last 7 days' };
        case 'last_30':
            return { from: iso(new Date(now.getTime() - 30 * 864e5)), to: iso(now), label: 'Last 30 days' };
        case 'this_month':
            return { from: iso(startOf(y, m, 1)), to: iso(now), label: monthLabel(now) };
        case 'last_month': {
            const d = new Date(y, m - 1, 1);
            return { from: iso(startOf(d.getFullYear(), d.getMonth(), 1)), to: iso(endOf(y, m, 0)), label: monthLabel(d) };
        }
        case 'this_quarter': {
            const q = Math.floor(m / 3);
            return { from: iso(startOf(y, q * 3, 1)), to: iso(now), label: `Q${q + 1} ${y}` };
        }
        case 'this_year':
            return { from: iso(startOf(y, 0, 1)), to: iso(now), label: `Year ${y}` };
        case 'last_year':
            return { from: iso(startOf(y - 1, 0, 1)), to: iso(endOf(y - 1, 11, 31)), label: `Year ${y - 1}` };
        case 'custom': {
            const parse = (v, end) => {
                if (!v) return null;
                const parts = String(v).split('-').map(Number);
                if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
                const [yy, mm, dd] = parts;
                return iso(end ? endOf(yy, mm - 1, dd) : startOf(yy, mm - 1, dd));
            };
            return {
                from: parse(query.from, false),
                to: parse(query.to, true),
                label: `${query.from || '…'} to ${query.to || '…'}`
            };
        }
        default:
            return { from: null, to: null, label: 'All time' };
    }
}

function monthLabel(d) {
    return d.toLocaleString('en-CA', { month: 'long' }) + ' ' + d.getFullYear();
}

function applyRange(query, range, column = 'day') {
    if (range.from) query = query.gte(column, range.from);
    if (range.to) query = query.lte(column, range.to);
    return query;
}

/**
 * GET /analytics/summary?period=&location_id=
 *
 * Headline consumption numbers plus a daily series for the chart.
 */
router.get('/summary', async (req, res) => {
    try {
        const companyId = req.company.id;
        const range = periodRange(req.query);

        let query = supabaseAdmin
            .from('inventory_consumption_daily')
            .select('day, units_used, value_used, movement_count, location_id')
            .eq('company_id', companyId);

        if (req.query.location_id && isValidUUID(req.query.location_id)) {
            query = query.eq('location_id', req.query.location_id);
        }
        query = applyRange(query, range).order('day', { ascending: true }).limit(20000);

        const { data, error } = await query;
        if (error) throw error;

        const byDay = new Map();
        let units = 0, value = 0, movements = 0;
        for (const row of data || []) {
            const key = String(row.day).slice(0, 10);
            const entry = byDay.get(key) || { day: key, units_used: 0, value_used: 0 };
            entry.units_used += Number(row.units_used || 0);
            entry.value_used += Number(row.value_used || 0);
            byDay.set(key, entry);
            units += Number(row.units_used || 0);
            value += Number(row.value_used || 0);
            movements += Number(row.movement_count || 0);
        }

        const series = [...byDay.values()].map(d => ({
            day: d.day,
            units_used: round2(d.units_used),
            value_used: round2(d.value_used)
        }));

        const activeDays = series.filter(d => d.units_used > 0).length;

        res.json({
            period: { label: range.label, from: range.from, to: range.to },
            totals: {
                units_used: round2(units),
                value_used: round2(value),
                movements,
                active_days: activeDays,
                avg_value_per_active_day: activeDays ? round2(value / activeDays) : 0
            },
            series
        });
    } catch (err) {
        console.error('Analytics summary error:', err);
        res.status(500).json({ error: 'Failed to load consumption analytics.' });
    }
});

/**
 * GET /analytics/by-product?period=&location_id=&limit=
 * What the shop actually burns through, by value.
 */
router.get('/by-product', async (req, res) => {
    try {
        const companyId = req.company.id;
        const range = periodRange(req.query);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 25));

        let query = supabaseAdmin
            .from('inventory_consumption_daily')
            .select('product_id, sku, product_name, brand, category, units_used, value_used, location_id')
            .eq('company_id', companyId);

        if (req.query.location_id && isValidUUID(req.query.location_id)) {
            query = query.eq('location_id', req.query.location_id);
        }
        query = applyRange(query, range).limit(20000);

        const { data, error } = await query;
        if (error) throw error;

        const byProduct = new Map();
        for (const row of data || []) {
            const cur = byProduct.get(row.product_id) || {
                product_id: row.product_id, sku: row.sku, product_name: row.product_name,
                brand: row.brand, category: row.category, units_used: 0, value_used: 0
            };
            cur.units_used += Number(row.units_used || 0);
            cur.value_used += Number(row.value_used || 0);
            byProduct.set(row.product_id, cur);
        }

        const items = [...byProduct.values()]
            .map(p => ({ ...p, units_used: round2(p.units_used), value_used: round2(p.value_used) }))
            .sort((a, b) => b.value_used - a.value_used);

        res.json({
            period: { label: range.label, from: range.from, to: range.to },
            total_items: items.length,
            items: items.slice(0, limit)
        });
    } catch (err) {
        console.error('Analytics by-product error:', err);
        res.status(500).json({ error: 'Failed to load consumption by product.' });
    }
});

/**
 * GET /analytics/by-job?period=&location_id=&limit=
 * Materials consumed per repair order — the number that reconciles against what
 * was billed to the insurer.
 */
router.get('/by-job', async (req, res) => {
    try {
        const companyId = req.company.id;
        const range = periodRange(req.query);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));

        let query = supabaseAdmin
            .from('inventory_consumption_by_job')
            .select('*')
            .eq('company_id', companyId);

        if (req.query.location_id && isValidUUID(req.query.location_id)) {
            query = query.eq('location_id', req.query.location_id);
        }
        // The view aggregates over the whole history, so the period filter goes
        // on the last-used timestamp rather than on a day column.
        query = applyRange(query, range, 'last_used_at')
            .order('last_used_at', { ascending: false })
            .limit(limit);

        const { data, error } = await query;
        if (error) throw error;

        const jobs = (data || []).map(j => ({
            ...j,
            units_used: round2(Number(j.units_used || 0)),
            value_used: round2(Number(j.value_used || 0)),
            // Items on this job the branch prices at purchase. value_used
            // excludes them, so this is what turns a possibly-misleading number
            // into an honest one on screen.
            items_unpriced: Number(j.items_unpriced || 0)
        }));

        const jobsWithUnpriced = jobs.filter(j => j.items_unpriced > 0).length;

        res.json({
            period: { label: range.label, from: range.from, to: range.to },
            jobs,
            totals: {
                jobs: jobs.length,
                value_used: round2(jobs.reduce((s, j) => s + j.value_used, 0)),
                avg_value_per_job: jobs.length
                    ? round2(jobs.reduce((s, j) => s + j.value_used, 0) / jobs.length) : 0,
                jobs_with_unpriced_items: jobsWithUnpriced
            }
        });
    } catch (err) {
        console.error('Analytics by-job error:', err);
        res.status(500).json({ error: 'Failed to load consumption by job.' });
    }
});

/**
 * GET /analytics/by-location?period=
 * Shop-versus-shop comparison for a multi-site group.
 */
router.get('/by-location', async (req, res) => {
    try {
        const companyId = req.company.id;
        const range = periodRange(req.query);

        let query = supabaseAdmin
            .from('inventory_consumption_daily')
            .select('location_id, location_name, units_used, value_used')
            .eq('company_id', companyId);
        query = applyRange(query, range).limit(20000);

        const { data, error } = await query;
        if (error) throw error;

        const byLoc = new Map();
        for (const row of data || []) {
            const cur = byLoc.get(row.location_id) ||
                { location_id: row.location_id, location_name: row.location_name, units_used: 0, value_used: 0 };
            cur.units_used += Number(row.units_used || 0);
            cur.value_used += Number(row.value_used || 0);
            byLoc.set(row.location_id, cur);
        }

        const locations = [...byLoc.values()]
            .map(l => ({ ...l, units_used: round2(l.units_used), value_used: round2(l.value_used) }))
            .sort((a, b) => b.value_used - a.value_used);

        res.json({ period: { label: range.label, from: range.from, to: range.to }, locations });
    } catch (err) {
        console.error('Analytics by-location error:', err);
        res.status(500).json({ error: 'Failed to load consumption by location.' });
    }
});

/**
 * GET /analytics/export?period=&location_id=&group=product|job
 * The same figures as CSV, for a controller who wants them in a spreadsheet.
 */
router.get('/export', async (req, res) => {
    try {
        const group = req.query.group === 'job' ? 'job' : 'product';
        const range = periodRange(req.query);
        const companyId = req.company.id;

        let rows, header, toLine;
        if (group === 'job') {
            let q = supabaseAdmin.from('inventory_consumption_by_job').select('*').eq('company_id', companyId);
            if (req.query.location_id && isValidUUID(req.query.location_id)) q = q.eq('location_id', req.query.location_id);
            const { data } = await applyRange(q, range, 'last_used_at').limit(20000);
            rows = data || [];
            header = ['Job / RO', 'Location', 'Items', 'Units used', 'Value used', 'First used', 'Last used'];
            toLine = r => [r.job_ref, r.location_name, r.distinct_items, round2(r.units_used),
                           round2(r.value_used), r.first_used_at, r.last_used_at];
        } else {
            let q = supabaseAdmin.from('inventory_consumption_daily').select('*').eq('company_id', companyId);
            if (req.query.location_id && isValidUUID(req.query.location_id)) q = q.eq('location_id', req.query.location_id);
            const { data } = await applyRange(q, range).limit(20000);
            const byProduct = new Map();
            for (const row of data || []) {
                const cur = byProduct.get(row.product_id) || { ...row, units_used: 0, value_used: 0 };
                cur.units_used += Number(row.units_used || 0);
                cur.value_used += Number(row.value_used || 0);
                byProduct.set(row.product_id, cur);
            }
            rows = [...byProduct.values()].sort((a, b) => b.value_used - a.value_used);
            header = ['Part #', 'Item', 'Brand', 'Category', 'Location', 'Units used', 'Value used'];
            toLine = r => [r.sku, r.product_name, r.brand, r.category, r.location_name,
                           round2(r.units_used), round2(r.value_used)];
        }

        const lines = [header.join(',')];
        for (const r of rows) lines.push(toLine(r).map(csvCell).join(','));

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="refinishai-consumption-${group}-${new Date().toISOString().slice(0, 10)}.csv"`);
        // The BOM keeps Excel from mangling accented product names.
        res.send('﻿' + lines.join('\n'));
    } catch (err) {
        console.error('Analytics export error:', err);
        res.status(500).json({ error: 'Failed to export consumption data.' });
    }
});

function csvCell(v) {
    const s = String(v === null || v === undefined ? '' : v);
    // Neutralise spreadsheet formula injection on export.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function round2(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

module.exports = router;
module.exports.periodRange = periodRange;
