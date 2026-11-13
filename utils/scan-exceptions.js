/**
 * utils/scan-exceptions.js -- scans that found nothing, kept with a reason.
 *
 * Every screen that scans (Stock, Receive, Deliveries, Counts, Transfers and
 * the scan-out kiosk) calls recordScanException() when a code matches no item.
 * The scan is kept with a reason so it can be put right straight afterwards,
 * and so a product that was on the shelf is never lost because its barcode
 * did not scan.
 *
 * Reasons, decided on the server from what the code does match:
 *
 *   missing_barcode  the item IS in this shop's catalogue (found through the
 *                    Item Library by its barcode), only this barcode is not
 *                    attached to it. Fix: attach the barcode.
 *   not_in_catalog   the Item Library knows the barcode, but the shop's
 *                    catalogue does not carry the item. Fix: add it.
 *   inactive_item    the barcode or part number belongs to an item that has
 *                    been switched off for this shop.
 *   invalid_code     a numeric code of barcode length whose check digit is
 *                    wrong: almost always a misread. Scan it again.
 *   unknown_code     nothing anywhere matches. Someone needs to read the
 *                    package and say what it is.
 *
 * A case or box code (a 14-digit GTIN starting 1-8) is also tried as the code
 * of the single item inside it, so a box scan can still point at its item.
 *
 * Recording never blocks a scan: any failure here is logged and swallowed,
 * and an install without migration 067 simply records nothing.
 */
const { supabaseAdmin } = require('./supabase');
const { barcodeVariants, canonicalBarcode, cleanBarcode, gs1CheckDigit, isValidGs1 } = require('./inventory');
const { libraryTableForCompany } = require('./library-scope');

const REASONS = {
    missing_barcode: { label: 'Missing barcode', help: 'The item is in this shop’s catalogue; this barcode just is not attached to it yet.' },
    not_in_catalog:  { label: 'Not in catalogue', help: 'The Item Library knows this barcode, but this shop’s catalogue does not carry the item.' },
    inactive_item:   { label: 'Item switched off', help: 'This barcode belongs to an item that has been switched off for this shop.' },
    invalid_code:    { label: 'Misread barcode', help: 'The barcode’s check digit is wrong, so it was almost certainly misread. Scan it again.' },
    unknown_code:    { label: 'Unknown code', help: 'Nothing matches this code. Note what the item is so it can be identified.' }
};
const REASON_NAMES = Object.keys(REASONS);

const CONTEXTS = {
    scan:     { label: 'Stock scan', intended: 'receive' },
    receive:  { label: 'Receiving', intended: 'receive' },
    delivery: { label: 'Delivery check-in', intended: 'receive' },
    count:    { label: 'Count', intended: 'count' },
    transfer: { label: 'Transfer', intended: 'none' },
    kiosk:    { label: 'Scan-out kiosk', intended: 'consume' },
    other:    { label: 'Other', intended: 'none' }
};
const CONTEXT_NAMES = Object.keys(CONTEXTS);
const INTENDED = ['receive', 'consume', 'count', 'none'];

/** How many open issues one company may hold before new codes stop being recorded (a flood guard). */
const MAX_OPEN_PER_COMPANY = 2000;

const NOT_INSTALLED = /scan_exceptions|relation .* does not exist|schema cache/i;

function clean(v, max) {
    return String(v === undefined || v === null ? '' : v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function contextOf(v) { return CONTEXT_NAMES.includes(v) ? v : 'other'; }
function intendedOf(v, context) {
    if (INTENDED.includes(v)) return v;
    return CONTEXTS[contextOf(context)].intended;
}

/** A numeric code of barcode length whose check digit fails: a misread, not an unknown item. */
function isMisread(raw) {
    const s = cleanBarcode(raw);
    return /^\d+$/.test(s) && [8, 12, 13, 14].includes(s.length) && !isValidGs1(s);
}

/**
 * The single-item code inside a case/box GTIN-14 (indicator 1-8), or null.
 * GTIN-14 = indicator + the first 12 digits of the item's GTIN-13 + a new check digit.
 */
function innerItemCode(raw) {
    const s = cleanBarcode(raw);
    if (!/^[1-8]\d{13}$/.test(s) || !isValidGs1(s)) return null;
    const body = s.slice(1, 13);
    return body + String(gs1CheckDigit(body));
}

/** Every stored form a code (and, for a case code, its inner item) could be saved under. */
function lookupForms(raw) {
    const forms = new Set(barcodeVariants(raw));
    const inner = innerItemCode(raw);
    if (inner) for (const v of barcodeVariants(inner)) forms.add(v);
    return [...forms];
}

/**
 * Decide why a code found nothing. Read-only. Returns
 *   { reason, suggested_product_id, suggested_library_id, suggested_label }
 */
async function classifyScan(companyId, raw) {
    const out = { reason: 'unknown_code', suggested_product_id: null, suggested_library_id: null, suggested_label: null };
    const forms = lookupForms(raw);

    // 1. Switched off in this shop's catalogue (by barcode, then by part number).
    if (forms.length) {
        const { data } = await supabaseAdmin
            .from('product_barcodes')
            .select('barcode, products!inner(id, name, sku, company_id, is_active)')
            .in('barcode', forms)
            .eq('products.company_id', companyId)
            .eq('products.is_active', false)
            .limit(5);
        const p = (data || []).map(r => r.products).find(Boolean);
        if (p) return { ...out, reason: 'inactive_item', suggested_product_id: p.id, suggested_label: `${p.sku} ${p.name}`.trim() };
    }
    {
        const { data } = await supabaseAdmin
            .from('products').select('id, name, sku')
            .eq('company_id', companyId).eq('is_active', false)
            .ilike('sku', clean(raw, 128).replace(/[%_,()]/g, ''))
            .limit(1);
        const p = (data || [])[0];
        if (p) return { ...out, reason: 'inactive_item', suggested_product_id: p.id, suggested_label: `${p.sku} ${p.name}`.trim() };
    }

    // 2. Known to the distributor's Item Library?
    if (forms.length) {
        const lib = await libraryTableForCompany(companyId);
        const { data: libRows } = await lib.select('id, sku, name, brand, barcode').in('barcode', forms).limit(5);
        const item = (libRows || [])[0];
        if (item) {
            // Does this shop already carry it, under the same part number or an approved alias?
            let product = null;
            const { data: viaMaster } = await supabaseAdmin
                .from('v_product_master')
                .select('product_id, company_sku, company_name_for_item, match_type, is_active')
                .eq('company_id', companyId)
                .eq('master_sku', item.sku)
                .limit(5);
            const m = (viaMaster || []).find(r => (r.match_type === 'exact' || r.match_type === 'alias') && r.is_active !== false);
            if (m) product = { id: m.product_id, sku: m.company_sku, name: m.company_name_for_item };
            if (!product) {
                const { data: same } = await supabaseAdmin
                    .from('products').select('id, sku, name')
                    .eq('company_id', companyId).eq('is_active', true)
                    .ilike('sku', String(item.sku).replace(/[%_,()]/g, ''))
                    .limit(1);
                if (same && same[0]) product = same[0];
            }
            if (product) {
                return { reason: 'missing_barcode', suggested_product_id: product.id, suggested_library_id: item.id,
                    suggested_label: `${product.sku} ${product.name || ''}`.trim() };
            }
            return { ...out, reason: 'not_in_catalog', suggested_library_id: item.id,
                suggested_label: `${item.sku} ${item.name || ''}`.trim() };
        }
    }

    // 3. A misread (bad check digit), or simply unknown.
    if (isMisread(raw)) return { ...out, reason: 'invalid_code' };
    return out;
}

/** The shape every screen gets back. */
function shapeException(row) {
    if (!row) return null;
    const r = REASONS[row.reason] || REASONS.unknown_code;
    return {
        id: row.id,
        code: row.code,
        reason: row.reason,
        reason_label: r.label,
        reason_help: r.help,
        context: row.context,
        context_label: (CONTEXTS[row.context] || CONTEXTS.other).label,
        intended_movement: row.intended_movement,
        suggested_label: row.suggested_label || null,
        attempts: row.attempts,
        qty: Number(row.qty),
        note: row.note || '',
        actor_label: row.actor_label || '',
        location_id: row.location_id,
        status: row.status,
        resolution: row.resolution || null,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        resolved_at: row.resolved_at || null,
        resolved_by_label: row.resolved_by_label || null
    };
}

/**
 * Keep a failed scan. Never throws.
 * @returns {Promise<object|null>} the shaped issue, or null if nothing was recorded
 */
async function recordScanException({ companyId, locationId, raw, context, contextRef, intended, actor, qty, _retried }) {
    try {
        const code = clean(raw, 128);
        if (!companyId || !code) return null;
        const canonical = canonicalBarcode(code) || code.toUpperCase();
        const ctx = contextOf(context);
        // A count scan carries the quantity counted; anything else starts at 1.
        const n = Number(qty);
        const givenQty = Number.isFinite(n) && n > 0 && n <= 100000 ? Math.round(n * 1000) / 1000 : null;

        // Already open for this shop and code? Count the attempt.
        let q = supabaseAdmin.from('scan_exceptions').select('*')
            .eq('company_id', companyId).eq('code_canonical', canonical).eq('status', 'open');
        q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
        const { data: existing, error: readErr } = await q.limit(1);
        if (readErr) throw readErr;
        if (existing && existing[0]) {
            const row = existing[0];
            const patch = { attempts: (row.attempts || 1) + 1, last_seen_at: new Date().toISOString() };
            const who = clean(actor, 80);
            if (who) patch.actor_label = who;
            if (givenQty && ctx === 'count') patch.qty = givenQty;
            const { data: updated } = await supabaseAdmin.from('scan_exceptions')
                .update(patch).eq('id', row.id).select('*').single();
            return shapeException(updated || { ...row, ...patch });
        }

        // Flood guard: a company cannot pile up unlimited new codes.
        const { count } = await supabaseAdmin.from('scan_exceptions')
            .select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'open');
        if ((count || 0) >= MAX_OPEN_PER_COMPANY) return null;

        const why = await classifyScan(companyId, code);
        const insert = {
            company_id: companyId,
            location_id: locationId || null,
            code, code_canonical: canonical,
            reason: why.reason,
            context: ctx,
            context_ref: clean(contextRef, 80) || null,
            intended_movement: intendedOf(intended, ctx),
            suggested_product_id: why.suggested_product_id,
            suggested_library_id: why.suggested_library_id,
            suggested_label: why.suggested_label ? clean(why.suggested_label, 200) : null,
            actor_label: clean(actor, 80) || null,
            ...(givenQty ? { qty: givenQty } : {})
        };
        const { data: created, error } = await supabaseAdmin.from('scan_exceptions').insert(insert).select('*').single();
        if (error) {
            // Two scans of the same code at the same instant: the other one won; count this as an attempt.
            if (!_retried && /duplicate|unique/i.test(error.message || '')) {
                return recordScanException({ companyId, locationId, raw, context, contextRef, intended, actor, qty, _retried: true });
            }
            throw error;
        }
        return shapeException(created);
    } catch (err) {
        if (!NOT_INSTALLED.test(err && err.message || '')) console.error('Scan issue not recorded:', err.message || err);
        return null;
    }
}

module.exports = {
    REASONS, REASON_NAMES, CONTEXTS, CONTEXT_NAMES, INTENDED, MAX_OPEN_PER_COMPANY, NOT_INSTALLED,
    isMisread, innerItemCode, lookupForms, classifyScan, shapeException, recordScanException, contextOf, intendedOf
};
