/**
 * routes/item-requests-admin.js -- Item requests, in the console.
 *
 * Mounted from routes/admin.js at /api/admin/item-requests.
 *
 *   GET  /                    requests across every customer this account can see
 *                             (?status=open|complete|cannot_supply|all, ?company_id=, ?q=)
 *   POST /                    enter a request for a customer who called, emailed or texted
 *   PUT  /:id                 close it: { status: complete|cannot_supply|open, product_id?, staff_note?, notify? }
 *   GET  /count               how many are waiting (sidebar badge)
 *   GET  /customers           customers + shops for the request form's pickers
 *   GET  /products            search a customer's list to link the item (?company_id=, ?q=)
 *   GET  /settings            who is emailed about new requests
 *   PUT  /settings            change that list (full admins)
 *
 * Any CHC staff account may work the list -- order desk included, so someone
 * can cover -- but only for customers it can already see: the same scope as
 * the Orders screen (utils/order-scope.js). The allow-list in middleware/auth.js
 * lets order-only roles reach these paths and nothing more.
 */

const express = require('express');
const multer = require('multer');
const { supabaseAdmin } = require('../utils/supabase');
const { requireFullAdmin } = require('../middleware/auth');
const { isValidUUID } = require('../utils/sanitize');
const { companyInScope, staffLocationIds, staffDistributorId, isHeadOffice } = require('../utils/order-scope');
const { resolveOrderRecipients } = require('../utils/recipients');
const { sendItemRequestNew, sendItemRequestClosed } = require('../utils/email');
const IR = require('../utils/item-requests');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IR.PHOTO_BYTES, files: IR.MAX_PHOTOS, fields: 20 } });
function photosIn(req, res, next) {
    if (!req.is('multipart/form-data')) return next();
    upload.array('photos', IR.MAX_PHOTOS)(req, res, err => {
        if (!err) return next();
        res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
            error: err.code === 'LIMIT_FILE_SIZE' ? 'A photo is over 5 MB.' : `Up to ${IR.MAX_PHOTOS} photos per request.`
        });
    });
}

const appUrl = () => (process.env.APP_URL || process.env.PUBLIC_URL || 'https://chcsale.com').replace(/\/$/, '');
const staffName = (req) => (req.admin && (req.admin.name || req.admin.email)) || 'CHC staff';

async function logAction(req, action, entityId, details) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: req.admin && req.admin.id, action, entity_type: 'item_request', entity_id: entityId, details, ip_address: req.ip
        });
    } catch (err) { console.error('Audit log write failed:', err.message); }
}

/** The companies this account may see, or null for "every company of its distributor". */
async function visibleCompanyIds(req) {
    const role = req.admin.role;
    if (role === 'super_admin' || role === 'platform_admin' || isHeadOffice(role)) return null;
    if (role === 'order_desk') {
        const locIds = await staffLocationIds(req.admin);
        if (!locIds.length) return [];
        const { data } = await supabaseAdmin.from('company_locations').select('company_id').in('id', locIds);
        return [...new Set((data || []).map(l => l.company_id))];
    }
    return req.admin.company_id ? [req.admin.company_id] : [];
}

async function canSee(req, companyId) {
    if (!isValidUUID(companyId)) return false;
    if (req.admin.role === 'platform_admin') return true;
    return companyInScope(req, companyId);
}

async function loadRequest(req) {
    if (!isValidUUID(req.params.id)) return null;
    const { data } = await supabaseAdmin.from('item_requests').select(IR.COLUMNS).eq('id', req.params.id).maybeSingle();
    if (!data || !(await canSee(req, data.company_id))) return null;
    return data;
}

// ----------------------------------------------------------------------------
// SETTINGS -- who hears about new requests
// ----------------------------------------------------------------------------
async function staffDistributor(req) {
    const id = staffDistributorId(req);
    let q = supabaseAdmin.from('distributors').select('id, name, settings, support_email, is_default');
    q = id ? q.eq('id', id) : q.eq('is_default', true);
    const { data } = await q.maybeSingle();
    return data || null;
}

router.get('/settings', async (req, res) => {
    try {
        const d = await staffDistributor(req);
        if (!d) return res.status(404).json({ error: 'Distributor not found.' });
        const set = d.settings && d.settings.item_requests && Array.isArray(d.settings.item_requests.notify_emails)
            ? d.settings.item_requests.notify_emails : null;
        res.json({ notify_emails: IR.inboxOf(d), is_default: !set,
            can_edit: ['super_admin', 'admin', 'platform_admin'].includes(req.admin.role) });
    } catch (err) {
        console.error('Item request settings error:', err);
        res.status(500).json({ error: 'Could not load the settings.' });
    }
});

router.put('/settings', requireFullAdmin, async (req, res) => {
    try {
        const d = await staffDistributor(req);
        if (!d) return res.status(404).json({ error: 'Distributor not found.' });
        const out = await IR.saveInbox(d.id, req.body && req.body.notify_emails);
        if (!out.ok) return res.status(400).json({ error: out.error });
        await logAction(req, 'item_request_inbox_changed', d.id, { notify_emails: out.notify_emails });
        res.json({ message: 'Saved. New requests now email: ' + out.notify_emails.join(', '), notify_emails: out.notify_emails });
    } catch (err) {
        console.error('Item request settings save error:', err);
        res.status(500).json({ error: 'Could not save the emails.' });
    }
});

// ----------------------------------------------------------------------------
// LIST
// ----------------------------------------------------------------------------
/** The customers this account works requests for, inside its distributor. */
async function scopedCompanies(req) {
    const ids = await visibleCompanyIds(req);
    if (Array.isArray(ids) && !ids.length) return [];
    let companies = supabaseAdmin.from('companies').select('id, name, slug, distributor_id').order('name');
    if (ids) companies = companies.in('id', ids);
    const dist = staffDistributorId(req);
    const { data: coRows } = await companies;
    return (coRows || []).filter(c => !dist || !c.distributor_id || c.distributor_id === dist);
}

/** The customers (and their shops) this account can enter a request for: the form's pickers. */
router.get('/customers', async (req, res) => {
    try {
        const coList = await scopedCompanies(req);
        const coIds = coList.map(c => c.id);
        const shops = {};
        if (coIds.length) {
            const { data: locs } = await supabaseAdmin.from('company_locations').select('id, name, company_id, is_active')
                .in('company_id', coIds).order('name');
            (locs || []).filter(l => l.is_active !== false).forEach(l => { (shops[l.company_id] = shops[l.company_id] || []).push({ id: l.id, name: l.name }); });
        }
        res.json({ companies: coList.map(c => ({ id: c.id, name: c.name, locations: shops[c.id] || [] })) });
    } catch (err) {
        console.error('Item request customers error:', err);
        res.status(500).json({ error: 'Could not load customers.' });
    }
});

/** How many are waiting: the sidebar badge. */
router.get('/count', async (req, res) => {
    try {
        const coIds = (await scopedCompanies(req)).map(c => c.id);
        if (!coIds.length) return res.json({ open: 0 });
        const { count, error } = await supabaseAdmin.from('item_requests').select('id', { count: 'exact', head: true })
            .in('company_id', coIds).eq('status', 'open');
        if (error) return res.json({ open: 0 });
        res.json({ open: count || 0 });
    } catch (err) {
        res.json({ open: 0 });
    }
});

router.get('/', async (req, res) => {
    try {
        const status = String(req.query.status || 'open');
        const coList = await scopedCompanies(req);
        const coIds = coList.map(c => c.id);
        if (!coIds.length) return res.json({ requests: [], counts: { open: 0 }, companies: [] });

        let q = supabaseAdmin.from('item_requests').select(IR.COLUMNS).in('company_id', coIds)
            .order('created_at', { ascending: false }).limit(300);
        if (IR.STATUSES.includes(status)) q = q.eq('status', status);
        if (req.query.company_id && coIds.includes(req.query.company_id)) q = q.eq('company_id', req.query.company_id);
        const term = IR.clean(req.query.q, 60).replace(/[%,()*\\]/g, ' ').trim();
        if (term) q = q.or(`item_name.ilike.%${term}%,part_number.ilike.%${term}%,brand.ilike.%${term}%`);
        const { data, error } = await q;
        if (error) {
            if (IR.missingTable(error)) return res.status(503).json({ error: 'Item requests are not set up in the database yet. Run migration 072_item_requests.sql in Supabase first.' });
            throw error;
        }

        const { count: openCount } = await supabaseAdmin.from('item_requests').select('id', { count: 'exact', head: true })
            .in('company_id', coIds).eq('status', 'open');

        const coName = {}; coList.forEach(c => { coName[c.id] = c.name; });
        const locIds = [...new Set((data || []).map(r => r.location_id).filter(Boolean))];
        const locName = {};
        if (locIds.length) {
            const { data: locs } = await supabaseAdmin.from('company_locations').select('id, name').in('id', locIds);
            (locs || []).forEach(l => { locName[l.id] = l.name; });
        }
        const products = await IR.productsFor(data);
        const out = [];
        for (const r of data || []) {
            out.push({ ...r, ref: IR.refOf(r), company_name: coName[r.company_id] || '',
                location_name: r.location_id ? locName[r.location_id] || '' : '',
                photos: await IR.signedPhotos(r.photos),
                product: r.product_id && products[r.product_id] ? products[r.product_id] : null });
        }
        // The shops of each customer, for the "enter a request" form (order-only
        // roles cannot reach the locations endpoint, so they come with the list).
        const { data: allLocs } = await supabaseAdmin.from('company_locations').select('id, name, company_id, is_active')
            .in('company_id', coIds).order('name');
        const shops = {};
        (allLocs || []).filter(l => l.is_active !== false).forEach(l => { (shops[l.company_id] = shops[l.company_id] || []).push({ id: l.id, name: l.name }); });
        res.json({ requests: out, counts: { open: openCount || 0 },
            companies: coList.map(c => ({ id: c.id, name: c.name, locations: shops[c.id] || [] })) });
    } catch (err) {
        console.error('Item requests admin list error:', err);
        res.status(500).json({ error: 'Could not load item requests.' });
    }
});

// ----------------------------------------------------------------------------
// ENTER A REQUEST FOR A CUSTOMER
// ----------------------------------------------------------------------------
router.post('/', photosIn, async (req, res) => {
    try {
        const companyId = req.body && req.body.company_id;
        if (!(await canSee(req, companyId))) return res.status(403).json({ error: 'Choose one of your customers.' });
        const v = IR.normalizeRequest(req.body, { staff: true });
        if (!v.ok) return res.status(400).json({ error: v.error });
        const photos = IR.checkPhotos(req.files);
        if (!photos.ok) return res.status(400).json({ error: photos.error });

        const { data: company } = await supabaseAdmin.from('companies').select('id, name').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Customer not found.' });
        let location = null;
        if (req.body.location_id) {
            const { data } = await supabaseAdmin.from('company_locations').select('id, name')
                .eq('id', req.body.location_id).eq('company_id', companyId).maybeSingle();
            if (!data) return res.status(400).json({ error: 'That shop is not on this customer.' });
            location = data;
        }

        const { data: created, error } = await supabaseAdmin.from('item_requests').insert({
            company_id: companyId, location_id: location ? location.id : null, ...v.fields,
            source: 'staff', status: 'open', entered_by_admin_id: req.admin.id, entered_by_name: staffName(req)
        }).select(IR.COLUMNS).single();
        if (error) {
            if (IR.missingTable(error)) return res.status(503).json({ error: 'Run migration 072_item_requests.sql in Supabase first.' });
            throw error;
        }
        if (photos.photos.length) {
            const saved = await IR.storePhotos(companyId, created.id, photos.photos);
            if (saved.length) await supabaseAdmin.from('item_requests').update({ photos: saved }).eq('id', created.id);
        }
        await logAction(req, 'item_request_entered', created.id, { company: company.name, item: created.item_name, via: created.received_via });

        // The inbox hears about it too, so whoever covers sees every request in one place.
        IR.inboxForCompany(companyId).then(to => sendItemRequestNew({
            to, ref: IR.refOf(created), companyName: company.name, locationName: location ? location.name : '',
            request: created, consoleUrl: `${appUrl()}/admin`,
            photos: photos.photos.map(p => ({ buffer: p.file.buffer, mime: p.check.mime, ext: p.check.ext }))
        })).catch(e => console.error('Item request email failed (non-blocking):', e.message));

        res.status(201).json({ message: `Request ${IR.refOf(created)} added for ${company.name}.`, request: { ...created, ref: IR.refOf(created) } });
    } catch (err) {
        console.error('Item request staff create error:', err);
        res.status(500).json({ error: 'Could not add the request.' });
    }
});

// ----------------------------------------------------------------------------
// CLOSE (or reopen)
// ----------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
    try {
        const row = await loadRequest(req);
        if (!row) return res.status(404).json({ error: 'Request not found.' });
        const b = req.body || {};
        const status = String(b.status || '');
        if (!IR.STATUSES.includes(status)) return res.status(400).json({ error: 'Choose Complete, Can’t supply, or reopen it.' });
        const note = IR.clean(b.staff_note, 1000) || null;
        if (status === 'cannot_supply' && !note) return res.status(400).json({ error: 'Say why it can’t be supplied; the customer sees this.' });

        let product = null;
        if (b.product_id) {
            if (!isValidUUID(b.product_id)) return res.status(400).json({ error: 'Choose an item from this customer’s list.' });
            const { data } = await supabaseAdmin.from('products').select('id, sku, name, is_active, company_id')
                .eq('id', b.product_id).eq('company_id', row.company_id).maybeSingle();
            if (!data) return res.status(400).json({ error: 'That item is not on this customer’s list.' });
            product = data;
        }

        const now = new Date().toISOString();
        const update = status === 'open'
            ? { status, closed_at: null, closed_by_admin_id: null, closed_by_name: null, updated_at: now }
            : { status, staff_note: note, product_id: product ? product.id : (status === 'complete' ? row.product_id : null),
                closed_at: now, closed_by_admin_id: req.admin.id, closed_by_name: staffName(req), updated_at: now };
        const { data: saved, error } = await supabaseAdmin.from('item_requests').update(update).eq('id', row.id).select(IR.COLUMNS).single();
        if (error) throw error;
        await logAction(req, 'item_request_' + status, row.id, { item: row.item_name, product: product ? product.sku : null });

        // Tell the customer, unless the person closing it said not to.
        let notified = false;
        if (status !== 'open' && b.notify !== false) {
            let to = saved.requested_by_email ? [saved.requested_by_email] : [];
            if (!to.length) {
                try { ({ customerTo: to } = await resolveOrderRecipients({ company_id: row.company_id, location_id: row.location_id })); }
                catch (_) { to = []; }
            }
            const { data: company } = await supabaseAdmin.from('companies').select('name, slug').eq('id', row.company_id).maybeSingle();
            const d = await IR.distributorFor(row.company_id);
            if (to && to.length) {
                const linked = product || (saved.product_id ? (await IR.productsFor([saved]))[saved.product_id] : null);
                const r = await sendItemRequestClosed({
                    to, ref: IR.refOf(saved), companyName: company ? company.name : '', request: saved, outcome: status,
                    product: linked, staffNote: note, distName: d && d.is_default ? 'CHC' : (d && d.name) || 'CHC',
                    storeUrl: company ? `${appUrl()}/store/${company.slug}` : null, replyTo: IR.inboxOf(d)[0]
                }).catch(() => ({ sent: false }));
                notified = !!(r && r.sent);
                if (notified) await supabaseAdmin.from('item_requests').update({ customer_notified_at: new Date().toISOString() }).eq('id', row.id);
            }
        }

        res.json({
            message: status === 'open' ? 'Reopened.' : (notified ? 'Done. The customer has been emailed.' : 'Done. No customer email was sent (no address on file, or email is not set up).'),
            request: { ...saved, ref: IR.refOf(saved) }, notified
        });
    } catch (err) {
        console.error('Item request close error:', err);
        res.status(500).json({ error: 'Could not update the request.' });
    }
});

// ----------------------------------------------------------------------------
// FIND THE ITEM ON THE CUSTOMER'S LIST
// ----------------------------------------------------------------------------
router.get('/products', async (req, res) => {
    try {
        const companyId = req.query.company_id;
        if (!(await canSee(req, companyId))) return res.status(403).json({ error: 'Choose one of your customers.' });
        const term = IR.clean(req.query.q, 60).replace(/[%,()*\\]/g, ' ').trim();
        if (term.length < 2) return res.json({ products: [] });
        const { data, error } = await supabaseAdmin.from('products')
            .select('id, sku, name, brand, price, price_on_request, is_active')
            .eq('company_id', companyId).eq('is_active', true)
            .or(`name.ilike.%${term}%,sku.ilike.%${term}%`).order('name').limit(20);
        if (error) throw error;
        res.json({ products: data || [] });
    } catch (err) {
        console.error('Item request product search error:', err);
        res.status(500).json({ error: 'Could not search the list.' });
    }
});

module.exports = router;
