/**
 * utils/catalogue-add.js -- add one CHC master (Item Library) item to a shop's
 * catalogue, with its barcode. Used by the console's Scan issues ("Add to
 * catalogue") and by the shop's own screens when a scan is not on their list
 * but is on the master ("Add to my list").
 *
 * The same commercial rules as a Master Table push: a catalogue closed to new
 * items, or a brand / category / part number excluded for this shop, is
 * refused. The price is the master list price; with no list price the item is
 * added as price on request.
 */
const { supabaseAdmin } = require('./supabase');
const { libraryTableForCompany } = require('./library-scope');
const { cleanBarcode, detectSymbology } = require('./inventory');
const { lookupForms } = require('./scan-exceptions');

/** A code that is a real barcode (not a typed part number), so it can be attached. */
function isBarcodeLike(code) {
    return /^\d{8,14}$/.test(cleanBarcode(code) || '');
}

/** The master item a shop could add, or null. Read-only. */
async function masterItem(companyId, libraryId) {
    if (!libraryId) return null;
    const lib = await libraryTableForCompany(companyId);
    const { data } = await lib.select('id, sku, name, brand, category, unit, case_qty, list_price, barcode').eq('id', libraryId).maybeSingle();
    return data || null;
}

/** What the shop sees on the offer: part number, name, brand, price (null = on request). */
function offerOf(item) {
    if (!item) return null;
    const price = Number(item.list_price) > 0 ? Number(item.list_price) : null;
    return { library_id: item.id, sku: item.sku, name: String(item.name || item.sku).replace(/^\*\s*/, ''), brand: item.brand || null, price };
}

/**
 * Add it. Returns { ok: true, product, price, on_request } or { ok: false, status, error }.
 * `code` is the scanned code; it is attached as a barcode only when it is one.
 */
async function addFromMaster({ companyId, libraryId, code }) {
    const item = await masterItem(companyId, libraryId);
    if (!item) return { ok: false, status: 404, error: 'That item was not found on the master list.' };

    const { data: same } = await supabaseAdmin.from('products').select('id, sku, is_active')
        .eq('company_id', companyId).ilike('sku', String(item.sku).replace(/[%_,()]/g, '')).limit(1);
    if (same && same[0]) {
        return { ok: false, status: 409, error: `This shop already has ${same[0].sku}${same[0].is_active === false ? ' (switched off)' : ''}.`, existing: same[0] };
    }
    const [{ data: excl }, { data: policy }] = await Promise.all([
        supabaseAdmin.from('company_catalogue_exclusions').select('brand, category, sku_key, reason').eq('company_id', companyId),
        supabaseAdmin.from('company_catalogue_policy').select('push_mode, reason').eq('company_id', companyId).maybeSingle()
    ]);
    if (policy && policy.push_mode === 'closed') return { ok: false, status: 409, error: policy.reason || 'This shop’s catalogue is closed to new items.' };
    const lc = v => String(v || '').toLowerCase();
    const rule = (excl || []).find(r => (r.brand && lc(r.brand) === lc(item.brand)) || (r.category && lc(r.category) === lc(item.category)) || (r.sku_key && r.sku_key === item.sku));
    if (rule) return { ok: false, status: 409, error: rule.reason || 'This item is excluded from this shop’s catalogue.' };

    const scanned = isBarcodeLike(code) ? cleanBarcode(code) : null;
    const codes = [...new Set([item.barcode && cleanBarcode(item.barcode), scanned].filter(Boolean))];
    if (codes.length) {
        const { data: holders } = await supabaseAdmin.from('product_barcodes')
            .select('product_id, products!inner(id, company_id)')
            .in('barcode', [...new Set(codes.flatMap(c => lookupForms(c)))]).eq('products.company_id', companyId);
        if ((holders || []).length) return { ok: false, status: 409, error: 'That barcode is already on another item in this catalogue.' };
    }

    const onRequest = !(Number(item.list_price) > 0);
    const { data: created, error } = await supabaseAdmin.from('products').insert({
        company_id: companyId, sku: item.sku, name: String(item.name || item.sku).replace(/^\*\s*/, ''),
        brand: item.brand || null, category: item.category || null,
        price: onRequest ? 0 : item.list_price, price_on_request: onRequest,
        case_qty: item.case_qty || 1, unit: item.unit || 'each', is_active: true
    }).select('id, sku, name, price, price_on_request').single();
    if (error) throw error;
    for (const [i, c] of codes.entries()) {
        await supabaseAdmin.from('product_barcodes').insert({
            product_id: created.id, barcode: c, symbology: detectSymbology(c),
            is_primary: i === 0, is_internal: false, source: 'scan_issue'
        });
    }
    return { ok: true, product: created, price: onRequest ? null : Number(item.list_price), on_request: onRequest, item };
}

module.exports = { addFromMaster, masterItem, offerOf, isBarcodeLike };
