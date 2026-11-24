/**
 * utils/item-requests.js
 *
 * Item requests (migration 072): "can you get us X?" in one place, per customer,
 * instead of emails, texts, calls and paper on a desk.
 *
 *   - a customer asks from its store (with up to 3 photos), or CHC staff enter a
 *     request for a customer who called or emailed;
 *   - every new request emails the distributor's request inbox, a list kept in
 *     the console (distributors.settings.item_requests.notify_emails), so
 *     someone can cover when the usual person is away;
 *   - staff close it as Complete (it is on the customer's list now; the customer
 *     is emailed that it is ready to order) or Can't supply (emailed the reason).
 *
 * Photos live in a PRIVATE bucket and are only ever shown through short-lived
 * signed links. A picture is checked by its first bytes, never by its name.
 */

const { supabaseAdmin } = require('./supabase');
const { checkImageUpload } = require('./image-upload');

const BUCKET = 'item-request-photos';
const MAX_PHOTOS = 3;
const PHOTO_BYTES = 5 * 1024 * 1024;
const STATUSES = ['open', 'complete', 'cannot_supply'];
const RECEIVED_VIA = ['phone', 'email', 'text', 'in_person', 'other'];
const FALLBACK_INBOX = ['adam@chcpaint.com'];
const COLUMNS = 'id, request_no, company_id, location_id, status, item_name, part_number, brand, quantity, notes, photos, ' +
    'requested_by_name, requested_by_email, source, received_via, entered_by_name, product_id, staff_note, ' +
    'closed_at, closed_by_name, customer_notified_at, created_at, updated_at';

const clean = (v, max) => String(v === undefined || v === null ? '' : v)
    .replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const isEmail = (e) => /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/.test(String(e || ''));

/** A table or bucket that 072 adds is missing. */
function missingTable(err) {
    return !!err && (err.code === '42P01' || err.code === 'PGRST205' || /item_requests|relation .* does not exist|schema cache/i.test(err.message || ''));
}

/** "IR-1042": the number a person reads out on the phone. */
function refOf(r) { return r && r.request_no ? `IR-${r.request_no}` : ''; }

/**
 * Check what someone typed into a request. Returns { ok, fields } or { ok:false, error }.
 * `staff` allows the "how did it reach us" field.
 */
function normalizeRequest(body, { staff = false } = {}) {
    const b = body || {};
    const item = clean(b.item_name, 200);
    if (!item) return { ok: false, error: 'Say what item you need: a name or a description.' };
    const fields = {
        item_name: item,
        part_number: clean(b.part_number, 80) || null,
        brand: clean(b.brand, 80) || null,
        quantity: clean(b.quantity, 80) || null,
        notes: clean(b.notes, 2000) || null,
        requested_by_name: clean(b.requested_by_name, 120) || null,
        requested_by_email: clean(b.requested_by_email, 160).toLowerCase() || null
    };
    if (fields.requested_by_email && !isEmail(fields.requested_by_email)) {
        return { ok: false, error: 'That email address does not look right.' };
    }
    if (staff) {
        const via = clean(b.received_via, 20).toLowerCase();
        fields.received_via = RECEIVED_VIA.includes(via) ? via : 'other';
    }
    return { ok: true, fields };
}

// ----------------------------------------------------------------------------
// Who is emailed about new requests
// ----------------------------------------------------------------------------

async function distributorFor(companyId) {
    try {
        const { data: co } = await supabaseAdmin.from('companies').select('distributor_id').eq('id', companyId).maybeSingle();
        let q = supabaseAdmin.from('distributors').select('id, settings, support_email, is_default');
        q = co && co.distributor_id ? q.eq('id', co.distributor_id) : q.eq('is_default', true);
        const { data } = await q.maybeSingle();
        return data || null;
    } catch (_) { return null; }
}

/** The request inbox for a distributor's customers. Never empty: falls back to support, then Adam. */
function inboxOf(distributor) {
    const list = distributor && distributor.settings && distributor.settings.item_requests
        && Array.isArray(distributor.settings.item_requests.notify_emails)
        ? distributor.settings.item_requests.notify_emails : [];
    const good = [...new Set(list.map(e => String(e || '').trim().toLowerCase()).filter(isEmail))];
    if (good.length) return good;
    if (distributor && isEmail(distributor.support_email)) return [distributor.support_email.toLowerCase()];
    return FALLBACK_INBOX;
}

async function inboxForCompany(companyId) {
    return inboxOf(await distributorFor(companyId));
}

/** Validate and save the inbox list on a distributor. */
async function saveInbox(distributorId, emails) {
    const list = (Array.isArray(emails) ? emails : String(emails || '').split(/[\s,;]+/))
        .map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
    const bad = list.filter(e => !isEmail(e));
    if (bad.length) return { ok: false, error: `Not an email address: ${bad.slice(0, 3).join(', ')}` };
    const unique = [...new Set(list)];
    if (!unique.length) return { ok: false, error: 'Keep at least one email, or nobody hears about new requests.' };
    if (unique.length > 10) return { ok: false, error: 'Up to 10 emails.' };
    const { data: d, error: readErr } = await supabaseAdmin.from('distributors').select('id, settings').eq('id', distributorId).maybeSingle();
    if (readErr || !d) return { ok: false, error: 'Distributor not found.' };
    const settings = { ...(d.settings || {}), item_requests: { ...((d.settings || {}).item_requests || {}), notify_emails: unique } };
    const { error } = await supabaseAdmin.from('distributors').update({ settings }).eq('id', distributorId);
    if (error) throw error;
    return { ok: true, notify_emails: unique };
}

// ----------------------------------------------------------------------------
// Photos
// ----------------------------------------------------------------------------

/**
 * Check up to three uploaded pictures. Returns { ok, photos:[{file, check}] } or { ok:false, error }.
 */
function checkPhotos(files) {
    const list = Array.isArray(files) ? files : [];
    if (list.length > MAX_PHOTOS) return { ok: false, error: `Up to ${MAX_PHOTOS} photos per request.` };
    const out = [];
    for (const f of list) {
        const c = checkImageUpload(f, PHOTO_BYTES);
        if (!c.ok) return { ok: false, error: c.error };
        out.push({ file: f, check: c });
    }
    return { ok: true, photos: out };
}

/** Store checked pictures under <company>/<request>/. Returns [{ path, mime, bytes }]; skips any that fail. */
async function storePhotos(companyId, requestId, checked) {
    const saved = [];
    for (let i = 0; i < checked.length; i++) {
        const { file, check } = checked[i];
        const path = `${companyId}/${requestId}/${Date.now()}-${i + 1}.${check.ext}`;
        const { error } = await supabaseAdmin.storage.from(BUCKET)
            .upload(path, file.buffer, { contentType: check.mime, upsert: false });
        if (error) { console.error('Item request photo upload failed:', error.message); continue; }
        saved.push({ path, mime: check.mime, bytes: file.buffer.length });
    }
    return saved;
}

/** Short-lived links to a request's photos, for a screen. */
async function signedPhotos(photos, seconds = 600) {
    const list = Array.isArray(photos) ? photos : [];
    const out = [];
    for (const p of list) {
        try {
            const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(p.path, seconds);
            if (!error && data && data.signedUrl) out.push({ url: data.signedUrl, mime: p.mime });
        } catch (_) { /* a missing picture never hides the request */ }
    }
    return out;
}

// ----------------------------------------------------------------------------
// Reading
// ----------------------------------------------------------------------------

/** One request's linked catalog item, for "Add to cart". */
async function productsFor(rows) {
    const ids = [...new Set((rows || []).map(r => r.product_id).filter(Boolean))];
    if (!ids.length) return {};
    const { data } = await supabaseAdmin.from('products')
        .select('id, sku, name, brand, price, price_on_request, is_active').in('id', ids);
    const map = {};
    for (const p of data || []) map[p.id] = p;
    return map;
}

module.exports = {
    BUCKET, MAX_PHOTOS, PHOTO_BYTES, STATUSES, RECEIVED_VIA, COLUMNS, FALLBACK_INBOX,
    clean, isEmail, missingTable, refOf, normalizeRequest,
    distributorFor, inboxOf, inboxForCompany, saveInbox,
    checkPhotos, storePhotos, signedPhotos, productsFor
};
