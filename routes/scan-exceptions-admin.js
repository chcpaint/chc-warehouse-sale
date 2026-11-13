/**
 * routes/scan-exceptions-admin.js -- putting scan issues right (migration 067).
 *
 * Mounted at /api/admin/scan-exceptions. Full-console roles only (no order desk).
 *
 *   GET  /                  ?status=open|resolved|dismissed|all&company_id=
 *   GET  /count             { open } for the menu badge
 *   POST /:id/resolve       { action, product_id?, library_id?, stock?, qty? }
 *
 * Actions:
 *   attach_barcode    attach the scanned code to an item in the shop's catalogue
 *   add_from_library  add the Item Library item to the shop's catalogue (list
 *                     price, or price on request when it has none) with its barcode
 *   reactivate        switch the item back on for that shop
 *   close             the code scans now (fixed elsewhere); just close it
 *   dismiss           a mis-scan; nothing to put right
 *
 * Any of the first four can also post what was on the shelf to stock at the
 * issue's location, so the count or receiving run ends up complete:
 *   stock: 'receive' (added), 'consume' (taken out), 'count' (on hand set to qty), 'none'
 *
 * Catalogue changes are for the distributor's super admins. A company admin
 * sees their own company's issues and can dismiss them. A super admin sees only
 * their own distributor's companies; another distributor's issue is "not found".
 */
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireFullAdmin } = require('../middleware/auth');
const { isValidUUID, stripHtml } = require('../utils/sanitize');
const { staffDistributorId } = require('../utils/order-scope');
const { libraryTableForCompany } = require('../utils/library-scope');
const { canonicalBarcode, cleanBarcode, detectSymbology, movementDelta, inventorySettings } = require('../utils/inventory');
const { shapeException, lookupForms, REASONS, CONTEXTS, NOT_INSTALLED } = require('../utils/scan-exceptions');

const router = express.Router();
router.use(requireFullAdmin);

const STATUSES = ['open', 'resolved', 'dismissed'];
const ACTIONS = ['attach_barcode', 'add_from_library', 'reactivate', 'close', 'dismiss'];
const STOCK = ['receive', 'consume', 'count', 'none'];
const text = (v, max) => stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);
const isSuper = req => req.admin.role === 'super_admin';

/** The company ids this account may see issues for. */
async function visibleCompanyIds(req) {
    if (!isSuper(req)) return req.admin.company_id ? [req.admin.company_id] : [];
    let q = supabaseAdmin.from('companies').select('id');
    const dist = staffDistributorId(req);
    if (dist) q = q.eq('distributor_id', dist);
    const { data } = await q;
    return (data || []).map(c => c.id);
}

async function logAction(req, action, entityId, details) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin.id, action, entity_type: 'scan_exception', entity_id: entityId, details, ip_address: req.ip
        });
    } catch (err) { console.error('Audit log write failed:', err); }
}

// ------------------------------------------------------------------
// GET /count
// ------------------------------------------------------------------
router.get('/count', async (req, res) => {
    try {
        const ids = await visibleCompanyIds(req);
        if (!ids.length) return res.json({ open: 0 });
        const { count, error } = await supabaseAdmin.from('scan_exceptions')
            .select('id', { count: 'exact', head: true }).in('company_id', ids).eq('status', 'open');
        if (error) { if (NOT_INSTALLED.test(error.message || '')) return res.json({ open: 0, installed: false }); throw error; }
        res.json({ open: count || 0 });
    } catch (err) {
        console.error('Scan issue count error:', err);
        res.status(500).json({ error: 'Could not count scan issues.' });
    }
});

// ------------------------------------------------------------------
// GET /
// ------------------------------------------------------------------
router.get('/', async (req, res) => {
    try {
        let ids = await visibleCompanyIds(req);
        if (req.query.company_id) {
            ids = isValidUUID(req.query.company_id) && ids.includes(req.query.company_id) ? [req.query.company_id] : [];
        }
        const status = STATUSES.includes(req.query.status) ? req.query.status : (req.query.status === 'all' ? 'all' : 'open');
        if (!ids.length) return res.json({ installed: true, issues: [], counts: { open: 0 }, can_fix: isSuper(req) });

        let q = supabaseAdmin.from('scan_exceptions').select('*').in('company_id', ids);
        if (status !== 'all') q = q.eq('status', status);
        const { data: rows, error } = await q.order('last_seen_at', { ascending: false }).limit(1000);
        if (error) {
            if (NOT_INSTALLED.test(error.message || '')) {
                return res.json({ installed: false, issues: [], counts: { open: 0 }, message: 'Run migration 067_scan_exceptions.sql in Supabase to start keeping scan issues.' });
            }
            throw error;
        }
        const issues = rows || [];

        // Names for companies, locations, suggested items.
        const coIds = [...new Set(issues.map(r => r.company_id))];
        const locIds = [...new Set(issues.map(r => r.location_id).filter(Boolean))];
        const prodIds = [...new Set(issues.flatMap(r => [r.suggested_product_id, r.resolved_product_id]).filter(Boolean))];
        const libIds = [...new Set(issues.map(r => r.suggested_library_id).filter(Boolean))];
        const [cos, locs, prods] = await Promise.all([
            coIds.length ? supabaseAdmin.from('companies').select('id, name, settings').in('id', coIds) : { data: [] },
            locIds.length ? supabaseAdmin.from('company_locations').select('id, name').in('id', locIds) : { data: [] },
            prodIds.length ? supabaseAdmin.from('products').select('id, sku, name, price, is_active').in('id', prodIds) : { data: [] }
        ]);
        let libs = [];
        if (libIds.length) {
            const { data } = await supabaseAdmin.from('item_library').select('id, sku, name, brand, list_price, barcode, distributor_id').in('id', libIds);
            libs = data || [];
        }
        const coName = new Map((cos.data || []).map(c => [c.id, c.name]));
        const coAllowNeg = new Map((cos.data || []).map(c => [c.id, inventorySettings(c.settings).allow_negative]));
        const locName = new Map((locs.data || []).map(l => [l.id, l.name]));
        const prodBy = new Map((prods.data || []).map(p => [p.id, p]));
        const libBy = new Map(libs.map(l => [l.id, l]));

        // Does the code scan now (fixed since, e.g. by another issue)? Only for open ones.
        const open = issues.filter(r => r.status === 'open');
        const nowScans = new Map();
        if (open.length) {
            const formsByIssue = new Map(open.map(r => [r.id, lookupForms(r.code)]));
            const allForms = [...new Set([...formsByIssue.values()].flat())];
            const found = [];
            for (let i = 0; i < allForms.length; i += 300) {
                const { data } = await supabaseAdmin.from('product_barcodes')
                    .select('barcode, products!inner(id, sku, name, company_id, is_active)')
                    .in('barcode', allForms.slice(i, i + 300))
                    .eq('products.is_active', true);
                found.push(...(data || []));
            }
            for (const r of open) {
                const forms = new Set(formsByIssue.get(r.id));
                const hit = found.find(f => forms.has(f.barcode) && f.products && f.products.company_id === r.company_id);
                if (hit) nowScans.set(r.id, { id: hit.products.id, sku: hit.products.sku, name: hit.products.name });
            }
        }

        const out = issues.map(r => {
            const p = r.suggested_product_id ? prodBy.get(r.suggested_product_id) : null;
            const l = r.suggested_library_id ? libBy.get(r.suggested_library_id) : null;
            const rp = r.resolved_product_id ? prodBy.get(r.resolved_product_id) : null;
            return {
                ...shapeException(r),
                company_id: r.company_id,
                company_name: coName.get(r.company_id) || '',
                location_name: r.location_id ? (locName.get(r.location_id) || '') : '',
                allow_negative: !!coAllowNeg.get(r.company_id),
                suggested_product: p ? { id: p.id, sku: p.sku, name: p.name, is_active: p.is_active !== false } : null,
                suggested_library: l ? { id: l.id, sku: l.sku, name: l.name, brand: l.brand, list_price: l.list_price } : null,
                resolved_product: rp ? { id: rp.id, sku: rp.sku, name: rp.name } : null,
                scans_now: nowScans.get(r.id) || null
            };
        });

        const { count } = await supabaseAdmin.from('scan_exceptions')
            .select('id', { count: 'exact', head: true }).in('company_id', ids).eq('status', 'open');
        res.json({ installed: true, issues: out, counts: { open: count || 0 }, can_fix: isSuper(req),
            reasons: REASONS, contexts: Object.fromEntries(Object.entries(CONTEXTS).map(([k, v]) => [k, v.label])) });
    } catch (err) {
        console.error('Scan issues admin list error:', err);
        res.status(500).json({ error: 'Could not load scan issues.' });
    }
});

// ------------------------------------------------------------------
// POST /:id/resolve
// ------------------------------------------------------------------
router.post('/:id/resolve', async (req, res) => {
    try {
        const id = req.params.id;
        if (!isValidUUID(id)) return res.status(404).json({ error: 'That scan issue was not found.' });
        const { data: issue } = await supabaseAdmin.from('scan_exceptions').select('*').eq('id', id).maybeSingle();
        const ids = issue ? await visibleCompanyIds(req) : [];
        if (!issue || !ids.includes(issue.company_id)) return res.status(404).json({ error: 'That scan issue was not found.' });
        if (issue.status !== 'open') return res.status(409).json({ error: 'That scan issue has already been dealt with.' });

        const action = String(req.body?.action || '');
        if (!ACTIONS.includes(action)) return res.status(400).json({ error: 'Choose what to do with this scan.' });
        if (action !== 'dismiss' && !isSuper(req)) {
            return res.status(403).json({ error: 'Changing the catalogue is done by your distributor. You can dismiss a mis-scan.' });
        }
        const who = req.admin.name || req.admin.email || 'Admin';
        const now = new Date().toISOString();

        if (action === 'dismiss') {
            const note = text(req.body?.note, 300);
            const { data } = await supabaseAdmin.from('scan_exceptions').update({
                status: 'dismissed', resolution: 'dismissed', resolved_at: now,
                resolved_by: req.admin.id, resolved_by_label: who, ...(note ? { note } : {})
            }).eq('id', issue.id).select('*').single();
            await logAction(req, 'scan_exception_dismissed', issue.id, { code: issue.code, company_id: issue.company_id });
            return res.json({ message: 'Dismissed.', issue: shapeException(data) });
        }

        const companyId = issue.company_id;
        const { data: company } = await supabaseAdmin.from('companies').select('id, name, settings').eq('id', companyId).single();
        const invSettings = inventorySettings(company && company.settings);

        // ---- what stock to post, checked before anything changes ----
        const stock = STOCK.includes(req.body?.stock) ? req.body.stock : 'none';
        let qty = req.body?.qty !== undefined ? Number(req.body.qty) : Number(issue.qty);
        if (stock !== 'none') {
            if (!Number.isFinite(qty) || qty < 0 || qty > 100000 || (stock !== 'count' && qty === 0)) {
                return res.status(400).json({ error: 'Enter the quantity to post.' });
            }
            if (!issue.location_id) return res.status(400).json({ error: 'This scan has no location, so it cannot be posted to stock. Choose "Don’t change stock".' });
            const { data: loc } = await supabaseAdmin.from('company_locations').select('id')
                .eq('id', issue.location_id).eq('company_id', companyId).eq('is_active', true).maybeSingle();
            if (!loc) return res.status(400).json({ error: 'That location is no longer active, so stock cannot be posted there.' });
        }

        // ---- which product, and the catalogue change ----
        const code = cleanBarcode(issue.code) || issue.code;
        let productId = null;
        let resolution = null;
        const details = { code: issue.code, company_id: companyId, reason: issue.reason };

        const ownProduct = async pid => {
            if (!isValidUUID(pid)) return null;
            const { data } = await supabaseAdmin.from('products').select('id, sku, name, is_active')
                .eq('id', pid).eq('company_id', companyId).maybeSingle();
            return data || null;
        };
        const codeHolders = async () => {
            const { data } = await supabaseAdmin.from('product_barcodes')
                .select('product_id, barcode, products!inner(id, company_id)')
                .in('barcode', lookupForms(issue.code)).eq('products.company_id', companyId);
            return (data || []).map(r => r.product_id);
        };
        const currentOnHand = async pid => {
            if (!pid || !issue.location_id) return 0;
            const { data } = await supabaseAdmin.from('inventory_levels').select('on_hand')
                .eq('location_id', issue.location_id).eq('product_id', pid).maybeSingle();
            return Number(data && data.on_hand) || 0;
        };
        const checkStock = async pid => {
            if (stock === 'none') return null;
            const onHand = await currentOnHand(pid);
            if (stock === 'count' && Number(qty) === onHand) return null;   // already right; nothing to post
            const delta = movementDelta(stock, qty, onHand);
            if (!delta.ok) return delta.error || 'That quantity cannot be posted.';
            if (!invSettings.allow_negative && onHand + delta.delta < 0) return `Only ${onHand} on hand, so ${qty} cannot be taken out.`;
            return null;
        };

        if (action === 'attach_barcode') {
            const p = await ownProduct(req.body?.product_id || issue.suggested_product_id);
            if (!p) return res.status(400).json({ error: 'Choose the item this barcode belongs to.' });
            const holders = await codeHolders();
            if (holders.some(h => h !== p.id)) return res.status(409).json({ error: 'That barcode is already on another item in this catalogue.' });
            const problem = await checkStock(p.id); if (problem) return res.status(400).json({ error: problem });
            if (!holders.includes(p.id)) {
                const { error } = await supabaseAdmin.from('product_barcodes').insert({
                    product_id: p.id, barcode: code, symbology: detectSymbology(code),
                    is_primary: false, is_internal: false, source: 'scan_issue'
                });
                if (error) throw error;
            }
            if (p.is_active === false) await supabaseAdmin.from('products').update({ is_active: true }).eq('id', p.id).eq('company_id', companyId);
            productId = p.id; resolution = 'barcode_added';
            Object.assign(details, { product: p.sku });
        }

        if (action === 'add_from_library') {
            const libId = req.body?.library_id || issue.suggested_library_id;
            if (!isValidUUID(libId)) return res.status(400).json({ error: 'Choose the Item Library item to add.' });
            const lib = await libraryTableForCompany(companyId);
            const { data: item } = await lib.select('id, sku, name, brand, category, unit, case_qty, list_price, barcode').eq('id', libId).maybeSingle();
            if (!item) return res.status(404).json({ error: 'That Item Library item was not found.' });

            const { data: same } = await supabaseAdmin.from('products').select('id, sku, is_active')
                .eq('company_id', companyId).ilike('sku', String(item.sku).replace(/[%_,()]/g, '')).limit(1);
            if (same && same[0]) {
                return res.status(409).json({ error: `This shop already has ${same[0].sku}${same[0].is_active === false ? ' (switched off)' : ''}. Attach the barcode to it instead.` });
            }
            // The same commercial rules as a Master Table push.
            const [{ data: excl }, { data: policy }] = await Promise.all([
                supabaseAdmin.from('company_catalogue_exclusions').select('brand, category, sku_key, reason').eq('company_id', companyId),
                supabaseAdmin.from('company_catalogue_policy').select('push_mode, reason').eq('company_id', companyId).maybeSingle()
            ]);
            if (policy && policy.push_mode === 'closed') return res.status(409).json({ error: policy.reason || 'This shop’s catalogue is closed to new items.' });
            const lc = v => String(v || '').toLowerCase();
            const rule = (excl || []).find(r => (r.brand && lc(r.brand) === lc(item.brand)) || (r.category && lc(r.category) === lc(item.category)) || (r.sku_key && r.sku_key === item.sku));
            if (rule) return res.status(409).json({ error: rule.reason || 'This item is excluded from this shop’s catalogue.' });
            if (code && (await codeHolders()).length) return res.status(409).json({ error: 'That barcode is already on another item in this catalogue.' });
            const problem = await checkStock(null); if (problem) return res.status(400).json({ error: problem });

            const onRequest = !(Number(item.list_price) > 0);
            const { data: created, error } = await supabaseAdmin.from('products').insert({
                company_id: companyId, sku: item.sku, name: String(item.name || item.sku).replace(/^\*\s*/, ''),
                brand: item.brand || null, category: item.category || null,
                price: onRequest ? 0 : item.list_price, price_on_request: onRequest,
                case_qty: item.case_qty || 1, unit: item.unit || 'each', is_active: true
            }).select('id, sku').single();
            if (error) throw error;
            const codes = [...new Set([item.barcode && cleanBarcode(item.barcode), code].filter(Boolean))];
            for (const [i, c] of codes.entries()) {
                await supabaseAdmin.from('product_barcodes').insert({
                    product_id: created.id, barcode: c, symbology: detectSymbology(c),
                    is_primary: i === 0, is_internal: false, source: 'scan_issue'
                });
            }
            productId = created.id; resolution = 'added_to_catalogue';
            Object.assign(details, { product: item.sku, price: onRequest ? 'on request' : Number(item.list_price) });
        }

        if (action === 'reactivate') {
            const p = await ownProduct(req.body?.product_id || issue.suggested_product_id);
            if (!p) return res.status(400).json({ error: 'Choose the item to switch back on.' });
            const problem = await checkStock(p.id); if (problem) return res.status(400).json({ error: problem });
            await supabaseAdmin.from('products').update({ is_active: true }).eq('id', p.id).eq('company_id', companyId);
            productId = p.id; resolution = 'reactivated';
            Object.assign(details, { product: p.sku });
        }

        if (action === 'close') {
            const holders = await codeHolders();
            const p = await ownProduct(req.body?.product_id || holders[0]);
            if (!p || !holders.includes(p.id)) return res.status(400).json({ error: 'This code does not scan to an item yet. Attach it to an item first.' });
            const problem = await checkStock(p.id); if (problem) return res.status(400).json({ error: problem });
            productId = p.id; resolution = 'scans_now';
        }

        // ---- post what was on the shelf ----
        let movementId = null, stockNote = null;
        if (stock !== 'none' && productId) {
            const onHand = await currentOnHand(productId);
            const delta = movementDelta(stock, qty, onHand);
            if (delta.ok && delta.delta !== 0) {
                const { data: mv, error: mvErr } = await supabaseAdmin.from('stock_movements').insert({
                    company_id: companyId, location_id: issue.location_id, product_id: productId,
                    qty_change: delta.delta, movement_type: stock,
                    reason: `Scan issue put right: ${(REASONS[issue.reason] || REASONS.unknown_code).label} (${(CONTEXTS[issue.context] || CONTEXTS.other).label.toLowerCase()})`,
                    scanned_barcode: canonicalBarcode(issue.code) || null,
                    actor_type: 'admin', actor_label: who,
                    source_doc_type: 'scan_exception', source_doc_id: issue.id
                }).select('id, on_hand_after').single();
                if (mvErr) stockNote = 'The item is fixed, but the stock could not be posted: ' + mvErr.message;
                else { movementId = mv.id; details.stock = { type: stock, qty, on_hand_after: Number(mv.on_hand_after) }; }
            } else if (stock === 'count') {
                stockNote = 'On hand was already ' + qty + ', so no stock change was needed.';
            }
        }

        const { data: updated } = await supabaseAdmin.from('scan_exceptions').update({
            status: 'resolved', resolution, resolved_product_id: productId, stock_movement_id: movementId,
            resolved_at: now, resolved_by: req.admin.id, resolved_by_label: who
        }).eq('id', issue.id).select('*').single();
        await logAction(req, 'scan_exception_resolved', issue.id, { ...details, action });

        const labels = {
            barcode_added: 'Barcode attached', added_to_catalogue: 'Added to the catalogue',
            reactivated: 'Item switched back on', scans_now: 'Closed'
        };
        const stockMsg = details.stock ? ` and ${details.stock.type === 'count' ? 'on hand set to ' + qty : (details.stock.type === 'consume' ? qty + ' taken out of stock' : qty + ' added to stock')}` : '';
        res.json({ message: `${labels[resolution]}${stockMsg}.`, note: stockNote, issue: shapeException(updated) });
    } catch (err) {
        console.error('Scan issue resolve error:', err);
        res.status(500).json({ error: 'Could not put that scan issue right.' });
    }
});

module.exports = router;
