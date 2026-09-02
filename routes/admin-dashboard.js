/**
 * routes/admin-dashboard.js
 *
 * The console's headline numbers, in one call.
 *
 * Mounted from routes/admin.js at /api/admin/dashboard, so it inherits
 * requireAdminAuth, restrictOrderDesk and requirePasswordCurrent. Order-desk
 * and order-manager accounts never reach it: restrictOrderDesk is an
 * allow-list, and /dashboard is not on it.
 *
 * WHY AGGREGATION HAPPENS HERE AND NOT IN POSTGRES
 * ------------------------------------------------
 * PostgREST cannot GROUP BY, so a pre-aggregated view would have to fix the
 * grain — and the grain a dashboard needs changes with the period the user
 * picks. Reading rows at their true grain and folding them in JS keeps one
 * source of truth (the orders and the ledger) and lets any date range work.
 * Every read is paged, and every total carries the row count it was built
 * from so a truncated read cannot masquerade as a small business.
 *
 * WHAT IS DELIBERATELY NOT COUNTED
 * --------------------------------
 * - Cancelled orders are not sales.
 * - A price-on-request line has no unit price. It contributes UNITS but no
 *   DOLLARS, and the response says how many such lines there were. Treating
 *   them as $0 would quietly under-report every total on this screen.
 * - Stock is valued at each shop's own price, because that is the only price
 *   the system holds. It is labelled that way in the UI; it is not margin.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { isValidUUID } = require('../utils/sanitize');

const router = express.Router();

// Orders that represent money. Anything cancelled is excluded from every
// sales figure on this screen.
const NON_SALE_STATUSES = ['cancelled'];

const PAGE = 1000;      // PostgREST's default ceiling; read in pages of this.
const MAX_ROWS = 60000; // Hard stop. Past this the response says it is partial.

/**
 * Read every row a query matches, a page at a time.
 *
 * `build` is called per page and must return a fresh query — Supabase query
 * objects are single-use, so reusing one silently returns the first page over
 * and over.
 */
async function readAll(build) {
    const out = [];
    let truncated = false;
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
        const { data, error } = await build().range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        out.push(...rows);
        if (rows.length < PAGE) return { rows: out, truncated };
    }
    truncated = true;
    return { rows: out, truncated };
}

/**
 * Resolve a named period into an ISO range. Same vocabulary as the Reports tab
 * and the store's inventory analytics, so the three read alike to a user.
 */
function periodRange(query) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const startOf = (yy, mm, dd) => new Date(yy, mm, dd, 0, 0, 0, 0);
    const endOf = (yy, mm, dd) => new Date(yy, mm, dd, 23, 59, 59, 999);
    const iso = d => d.toISOString();
    const monthLabel = d => d.toLocaleString('en-CA', { month: 'long' }) + ' ' + d.getFullYear();

    switch (String(query.period || 'this_month')) {
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
        case 'all':
        default:
            return { from: null, to: null, label: 'All time' };
    }
}

const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const round2 = n => Math.round(n * 100) / 100;

/**
 * GET /api/admin/dashboard?period=&from=&to=&company_id=
 *
 * One payload for the whole dashboard. Everything on the screen comes from
 * this, so the numbers on it cannot disagree with each other.
 */
router.get('/', async (req, res) => {
    try {
        const isSuper = req.admin.role === 'super_admin';
        const range = periodRange(req.query);

        // Scope. A company admin sees their own company and nothing else,
        // whatever they put in the query string. A super admin may narrow to
        // one company on purpose.
        let scopeIds = null;                       // null = every company
        if (!isSuper) {
            if (!req.admin.company_id) return res.status(403).json({ error: 'No company on this account.' });
            scopeIds = [req.admin.company_id];
        } else if (req.query.company_id && isValidUUID(req.query.company_id)) {
            scopeIds = [req.query.company_id];
        }

        // ---------------------------------------------------------------
        // Companies — names for every row on the screen.
        // ---------------------------------------------------------------
        const { rows: companies } = await readAll(() => {
            let q = supabaseAdmin.from('companies').select('id, name, is_active, settings');
            if (scopeIds) q = q.in('id', scopeIds);
            return q;
        });
        const nameOf = new Map(companies.map(c => [c.id, c.name]));
        const companyIds = companies.map(c => c.id);

        // A company row exists for every company in scope even when it has no
        // activity at all. A customer missing from the table because they
        // bought nothing this month looks like a data fault, not a sales lead.
        const bucket = () => ({
            company_id: null, company_name: '',
            sales_total: 0, order_count: 0, units_ordered: 0, unpriced_lines: 0,
            inventory_value: 0, inventory_units: 0, inventory_skus: 0, inventory_unvalued: 0,
            kits_consumed: 0, kits_value: 0,
            materials_billed: 0, jobs_with_materials: 0
        });
        const byCompany = new Map();
        for (const c of companies) {
            const b = bucket();
            b.company_id = c.id;
            b.company_name = c.name;
            b.is_active = c.is_active !== false;
            byCompany.set(c.id, b);
        }
        const forCompany = id => {
            if (!byCompany.has(id)) {
                const b = bucket();
                b.company_id = id;
                b.company_name = nameOf.get(id) || 'Unknown company';
                byCompany.set(id, b);
            }
            return byCompany.get(id);
        };

        // ---------------------------------------------------------------
        // Sales — from orders, with the lines unfolded for product ranking.
        // ---------------------------------------------------------------
        const { rows: orders, truncated: ordersTruncated } = await readAll(() => {
            let q = supabaseAdmin.from('orders')
                .select('id, company_id, total, status, created_at, items')
                .not('status', 'in', `(${NON_SALE_STATUSES.join(',')})`);
            if (scopeIds) q = q.in('company_id', scopeIds);
            if (range.from) q = q.gte('created_at', range.from);
            if (range.to) q = q.lte('created_at', range.to);
            return q;
        });

        // The fake used in tests, and any client that ignores .not(), can hand
        // back cancelled rows. Filter again here so the guard is in the code
        // that owns the number, not only in the query.
        const saleOrders = orders.filter(o => !NON_SALE_STATUSES.includes(String(o.status)));

        const products = new Map();   // sku -> { sku, name, units, dollars, companies:Set }
        const monthly = new Map();    // YYYY-MM -> { month, sales, orders }
        let salesTotal = 0, unpricedLines = 0, unitsOrdered = 0;

        for (const o of saleOrders) {
            const b = forCompany(o.company_id);
            const total = num(o.total);
            b.sales_total += total;
            b.order_count += 1;
            salesTotal += total;

            const monthKey = String(o.created_at || '').slice(0, 7);
            if (monthKey) {
                const mrow = monthly.get(monthKey) || { month: monthKey, sales: 0, orders: 0 };
                mrow.sales += total;
                mrow.orders += 1;
                monthly.set(monthKey, mrow);
            }

            // items is JSONB. It has been text in older rows, so parse
            // defensively rather than trusting the column's type.
            let lines = o.items;
            if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch { lines = []; } }
            if (!Array.isArray(lines)) lines = [];

            for (const line of lines) {
                const qty = num(line.quantity);
                const sku = String(line.sku || line.product_id || '').trim() || '(no sku)';
                // A quoted line carries a null unit price on purpose. It has
                // real units and no dollars, and it is counted as such.
                const priced = line.unit_price !== null && line.unit_price !== undefined && !line.price_on_request;
                const dollars = priced ? num(line.unit_price) * qty : 0;
                if (!priced) { unpricedLines += 1; b.unpriced_lines += 1; }

                unitsOrdered += qty;
                b.units_ordered += qty;

                const p = products.get(sku) || { sku, name: line.name || sku, units: 0, dollars: 0, companies: new Set() };
                p.units += qty;
                p.dollars += dollars;
                p.companies.add(o.company_id);
                if (!p.name && line.name) p.name = line.name;
                products.set(sku, p);
            }
        }

        // ---------------------------------------------------------------
        // Stock on hand — a point-in-time figure, so the period does not
        // apply to it. Valued at each shop's own price; a price-on-request
        // item is counted in units and left out of the value, and the count
        // of those lines rides along so the total is never quietly short.
        // ---------------------------------------------------------------
        let inventoryTruncated = false;
        if (companyIds.length) {
            const { rows: levels, truncated } = await readAll(() => {
                let q = supabaseAdmin.from('inventory_levels')
                    .select('company_id, on_hand, product_id, products!inner(price, price_on_request, is_active)');
                if (scopeIds) q = q.in('company_id', scopeIds);
                return q;
            });
            inventoryTruncated = truncated;

            for (const lvl of levels) {
                const prod = lvl.products || {};
                if (prod.is_active === false) continue;
                const b = forCompany(lvl.company_id);
                const onHand = num(lvl.on_hand);
                if (onHand === 0) continue;
                b.inventory_units += onHand;
                b.inventory_skus += 1;
                if (prod.price_on_request === true) b.inventory_unvalued += 1;
                else b.inventory_value += onHand * num(prod.price);
            }
        }

        // ---------------------------------------------------------------
        // Repair work — which kits were actually consumed, and for how much.
        // This is the "what is being billed the most" question.
        // ---------------------------------------------------------------
        const { rows: consumptions } = await readAll(() => {
            let q = supabaseAdmin.from('kit_consumptions')
                .select('company_id, kit_name, job_ref, total_cost, line_count, created_at');
            if (scopeIds) q = q.in('company_id', scopeIds);
            if (range.from) q = q.gte('created_at', range.from);
            if (range.to) q = q.lte('created_at', range.to);
            return q;
        });

        const kits = new Map();            // kit_name -> { kit_name, count, value }
        const kitByCompany = new Map();    // `${company_id}|${kit_name}` -> row
        const jobs = new Map();            // company_id -> Set(job_ref)
        let kitsConsumed = 0, kitsValue = 0;

        for (const k of consumptions) {
            const b = forCompany(k.company_id);
            const cost = num(k.total_cost);
            const name = String(k.kit_name || 'Unnamed repair');

            b.kits_consumed += 1;
            b.kits_value += cost;
            b.materials_billed += cost;
            kitsConsumed += 1;
            kitsValue += cost;

            const kit = kits.get(name) || { kit_name: name, count: 0, value: 0 };
            kit.count += 1; kit.value += cost;
            kits.set(name, kit);

            const key = `${k.company_id}|${name}`;
            const ck = kitByCompany.get(key) || {
                company_id: k.company_id, company_name: b.company_name,
                kit_name: name, count: 0, value: 0
            };
            ck.count += 1; ck.value += cost;
            kitByCompany.set(key, ck);

            if (k.job_ref) {
                if (!jobs.has(k.company_id)) jobs.set(k.company_id, new Set());
                jobs.get(k.company_id).add(String(k.job_ref));
            }
        }
        for (const [cid, set] of jobs) forCompany(cid).jobs_with_materials = set.size;

        // ---------------------------------------------------------------
        // Shape the response.
        // ---------------------------------------------------------------
        const companyRows = [...byCompany.values()]
            .map(b => ({
                ...b,
                sales_total: round2(b.sales_total),
                inventory_value: round2(b.inventory_value),
                kits_value: round2(b.kits_value),
                materials_billed: round2(b.materials_billed),
                inventory_units: round2(b.inventory_units),
                units_ordered: round2(b.units_ordered),
                average_order: b.order_count ? round2(b.sales_total / b.order_count) : 0
            }))
            .sort((a, b) => b.sales_total - a.sales_total || a.company_name.localeCompare(b.company_name));

        const productRows = [...products.values()].map(p => ({
            sku: p.sku, name: p.name,
            units: round2(p.units), dollars: round2(p.dollars),
            company_count: p.companies.size
        }));

        const inventoryValue = companyRows.reduce((s, c) => s + c.inventory_value, 0);
        const inventoryUnits = companyRows.reduce((s, c) => s + c.inventory_units, 0);
        const inventoryUnvalued = companyRows.reduce((s, c) => s + c.inventory_unvalued, 0);

        res.json({
            period: { ...range, key: String(req.query.period || 'this_month') },
            scope: {
                is_super: isSuper,
                company_id: scopeIds && scopeIds.length === 1 ? scopeIds[0] : null,
                company_count: companies.length
            },
            totals: {
                sales_total: round2(salesTotal),
                order_count: saleOrders.length,
                average_order: saleOrders.length ? round2(salesTotal / saleOrders.length) : 0,
                units_ordered: round2(unitsOrdered),
                unpriced_lines: unpricedLines,
                customers_ordering: companyRows.filter(c => c.order_count > 0).length,
                companies_total: companies.length,
                inventory_value: round2(inventoryValue),
                inventory_units: round2(inventoryUnits),
                inventory_unvalued_skus: inventoryUnvalued,
                kits_consumed: kitsConsumed,
                kits_value: round2(kitsValue),
                jobs_with_materials: [...jobs.values()].reduce((s, set) => s + set.size, 0)
            },
            by_company: companyRows,
            top_products_by_units: [...productRows].sort((a, b) => b.units - a.units).slice(0, 15),
            top_products_by_dollars: [...productRows].sort((a, b) => b.dollars - a.dollars).slice(0, 15),
            kits: [...kits.values()]
                .map(k => ({ ...k, value: round2(k.value) }))
                .sort((a, b) => b.count - a.count || b.value - a.value),
            kits_by_company: [...kitByCompany.values()]
                .map(k => ({ ...k, value: round2(k.value) }))
                .sort((a, b) => b.count - a.count),
            monthly: [...monthly.values()]
                .map(m => ({ ...m, sales: round2(m.sales) }))
                .sort((a, b) => a.month.localeCompare(b.month)),
            // Truthfulness flags. The UI shows a warning when either is set,
            // rather than presenting a partial read as the whole business.
            partial: { orders: ordersTruncated, inventory: inventoryTruncated }
        });

    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).json({ error: 'Failed to load the dashboard.' });
    }
});

/**
 * GET /api/admin/dashboard/jobs?period=&company_id=&format=csv
 *
 * Materials consumed per repair order, costed — the reconciliation view.
 *
 * WHY THIS EXISTS
 * ---------------
 * The question "does what left the shelf match what we invoiced?" has no
 * industry-standard answer a distributor is obliged to implement. CIECA's EMS
 * export died in 2006 and its BMS successor is an insurer/estimator message
 * set, not a jobber feed. What the collision trade actually accepts is an
 * itemised materials invoice attached to the repair order — so that is what
 * this produces, as JSON for the screen and CSV for anything else. A shop can
 * attach the CSV to a supplement or hand it to their office; it imports into
 * Mitchell, CCC, Audatex, QuickBooks or a spreadsheet without any of them
 * needing to know this system exists.
 */
router.get('/jobs', async (req, res) => {
    try {
        const isSuper = req.admin.role === 'super_admin';
        const range = periodRange(req.query);

        let scopeIds = null;
        if (!isSuper) {
            if (!req.admin.company_id) return res.status(403).json({ error: 'No company on this account.' });
            scopeIds = [req.admin.company_id];
        } else if (req.query.company_id && isValidUUID(req.query.company_id)) {
            scopeIds = [req.query.company_id];
        }

        const { rows, truncated } = await readAll(() => {
            let q = supabaseAdmin.from('v_job_materials')
                .select('company_id, company_name, location_name, job_ref, first_used_at, last_used_at, ' +
                        'distinct_items, units_used, value_billed, items_unpriced, kits_used, kit_movements');
            if (scopeIds) q = q.in('company_id', scopeIds);
            // The view is grouped by job, so its dates are aggregates. Filter
            // on last_used_at: a job is "in" a period if it was still drawing
            // materials during it.
            if (range.from) q = q.gte('last_used_at', range.from);
            if (range.to) q = q.lte('last_used_at', range.to);
            return q;
        });

        const jobs = rows
            .map(r => ({
                company_id: r.company_id,
                company_name: r.company_name,
                location_name: r.location_name,
                job_ref: r.job_ref,
                first_used_at: r.first_used_at,
                last_used_at: r.last_used_at,
                distinct_items: num(r.distinct_items),
                units_used: round2(num(r.units_used)),
                value_billed: round2(num(r.value_billed)),
                items_unpriced: num(r.items_unpriced),
                kits_used: num(r.kits_used),
                // A job with no kit movements was drawn entirely by hand. Not
                // wrong, but it is the case most likely to be under-billed,
                // so the screen can call it out.
                hand_scanned_only: num(r.kit_movements) === 0
            }))
            .sort((a, b) => String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')));

        if (String(req.query.format).toLowerCase() === 'csv') {
            const esc = v => {
                const s = v === null || v === undefined ? '' : String(v);
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const head = ['Customer', 'Location', 'Repair Order', 'First Used', 'Last Used',
                          'Distinct Items', 'Units Used', 'Materials Billed', 'Items Not Priced', 'Kits Used'];
            const body = jobs.map(j => [
                j.company_name, j.location_name, j.job_ref,
                String(j.first_used_at || '').slice(0, 10), String(j.last_used_at || '').slice(0, 10),
                j.distinct_items, j.units_used, j.value_billed.toFixed(2), j.items_unpriced, j.kits_used
            ]);
            const csvText = [head, ...body].map(r => r.map(esc).join(',')).join('\r\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition',
                `attachment; filename="job-materials-${String(range.label).replace(/[^\w]+/g, '-').toLowerCase()}.csv"`);
            // BOM so Excel opens it as UTF-8 rather than mangling accented names.
            return res.send('﻿' + csvText);
        }

        res.json({
            period: { ...range, key: String(req.query.period || 'this_month') },
            totals: {
                job_count: jobs.length,
                value_billed: round2(jobs.reduce((s, j) => s + j.value_billed, 0)),
                units_used: round2(jobs.reduce((s, j) => s + j.units_used, 0)),
                jobs_with_unpriced: jobs.filter(j => j.items_unpriced > 0).length,
                jobs_hand_scanned_only: jobs.filter(j => j.hand_scanned_only).length
            },
            jobs,
            partial: truncated
        });

    } catch (err) {
        console.error('Job materials error:', err);
        res.status(500).json({ error: 'Failed to load job materials.' });
    }
});

module.exports = router;
module.exports.periodRange = periodRange;
