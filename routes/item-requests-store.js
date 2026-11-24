/**
 * routes/item-requests-store.js -- Item requests, in a customer's store.
 *
 * Mounted from routes/storefront.js at /api/store/:slug/item-requests.
 *
 *   GET  /   this company's requests, newest first (a person tied to one shop
 *            sees that shop's, plus any not tied to a shop)
 *   POST /   ask for an item: item_name (required), part_number, brand, quantity,
 *            notes, location_id, requested_by_name, requested_by_email, and up to
 *            three photos in the multipart field "photos"
 *
 * Every new request emails the distributor's request inbox. Available to every
 * customer: there is no module to switch on. A kiosk's scoped session cannot
 * reach it (requireCompanyAuth refuses scoped tokens on routes they don't list).
 */

const express = require('express');
const multer = require('multer');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { isValidUUID } = require('../utils/sanitize');
const IR = require('../utils/item-requests');
const { sendItemRequestNew } = require('../utils/email');

const router = express.Router({ mergeParams: true });
router.use(requireCompanyAuth);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: IR.PHOTO_BYTES, files: IR.MAX_PHOTOS, fields: 20 }
});

/** Read a multipart body with up to three photos; leave a JSON body alone. */
function photosIn(req, res, next) {
    if (!req.is('multipart/form-data')) return next();
    upload.array('photos', IR.MAX_PHOTOS)(req, res, err => {
        if (!err) return next();
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A photo is over 5 MB. Take it again or choose a smaller one.'
            : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Up to ${IR.MAX_PHOTOS} photos per request.`
            : 'Could not read the photos.';
        res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
    });
}

const appUrl = () => (process.env.APP_URL || process.env.PUBLIC_URL || 'https://chcsale.com').replace(/\/$/, '');

router.get('/', async (req, res) => {
    try {
        let q = supabaseAdmin.from('item_requests').select(IR.COLUMNS)
            .eq('company_id', req.company.id).order('created_at', { ascending: false }).limit(200);
        const own = req.companyUser && req.companyUser.location_id;
        if (own) q = q.or(`location_id.eq.${own},location_id.is.null`);
        const { data, error } = await q;
        if (error) {
            if (IR.missingTable(error)) return res.json({ requests: [], ready: false });
            throw error;
        }
        const products = await IR.productsFor(data);
        const { data: locs } = await supabaseAdmin.from('company_locations').select('id, name').eq('company_id', req.company.id);
        const locName = {}; (locs || []).forEach(l => { locName[l.id] = l.name; });
        const requests = [];
        for (const r of data || []) {
            const p = r.product_id ? products[r.product_id] : null;
            requests.push({
                id: r.id, ref: IR.refOf(r), status: r.status,
                item_name: r.item_name, part_number: r.part_number, brand: r.brand, quantity: r.quantity, notes: r.notes,
                location_name: r.location_id ? locName[r.location_id] || '' : '',
                requested_by_name: r.requested_by_name, source: r.source,
                staff_note: r.status === 'open' ? null : r.staff_note,
                closed_at: r.closed_at, created_at: r.created_at,
                photos: await IR.signedPhotos(r.photos),
                product: p && p.is_active !== false ? { id: p.id, sku: p.sku, name: p.name, price: p.price_on_request ? null : p.price } : null
            });
        }
        res.json({ requests, ready: true });
    } catch (err) {
        console.error('Item requests list error:', err);
        res.status(500).json({ error: 'Could not load your item requests.' });
    }
});

router.post('/', photosIn, async (req, res) => {
    try {
        const companyId = req.company.id;
        const v = IR.normalizeRequest(req.body);
        if (!v.ok) return res.status(400).json({ error: v.error });
        const photos = IR.checkPhotos(req.files);
        if (!photos.ok) return res.status(400).json({ error: photos.error });

        // A person tied to one shop asks for that shop; otherwise the shop chosen at sign-in.
        let locationId = (req.companyUser && req.companyUser.location_id) || req.body.location_id || null;
        let location = null;
        if (locationId) {
            if (!isValidUUID(locationId)) return res.status(400).json({ error: 'Invalid location.' });
            const { data } = await supabaseAdmin.from('company_locations').select('id, name')
                .eq('id', locationId).eq('company_id', companyId).maybeSingle();
            if (!data) return res.status(400).json({ error: 'That location is not on this account.' });
            location = data;
        }

        // A runaway form or script cannot flood the inbox: 30 requests an hour per company.
        const since = new Date(Date.now() - 3600e3).toISOString();
        const { count } = await supabaseAdmin.from('item_requests').select('id', { count: 'exact', head: true })
            .eq('company_id', companyId).gte('created_at', since);
        if ((count || 0) >= 30) return res.status(429).json({ error: 'That is a lot of requests in one hour. Please try again a little later.' });

        const who = req.companyUser || {};
        const row = {
            company_id: companyId,
            location_id: location ? location.id : null,
            ...v.fields,
            requested_by_name: v.fields.requested_by_name || who.name || null,
            requested_by_email: v.fields.requested_by_email || (who.email ? String(who.email).toLowerCase() : null),
            requested_by_user_id: who.id || null,
            source: 'store',
            status: 'open'
        };
        const { data: created, error } = await supabaseAdmin.from('item_requests').insert(row).select(IR.COLUMNS).single();
        if (error) {
            if (IR.missingTable(error)) return res.status(503).json({ error: 'Item requests are not set up yet. Please contact CHC.' });
            throw error;
        }

        let saved = [];
        if (photos.photos.length) {
            saved = await IR.storePhotos(companyId, created.id, photos.photos);
            if (saved.length) {
                await supabaseAdmin.from('item_requests').update({ photos: saved }).eq('id', created.id);
                created.photos = saved;
            }
        }

        // The inbox hears about it; email trouble never loses the request.
        IR.inboxForCompany(companyId).then(to => sendItemRequestNew({
            to, ref: IR.refOf(created), companyName: req.company.name, locationName: location ? location.name : '',
            request: created, replyTo: created.requested_by_email || undefined,
            photos: photos.photos.map(p => ({ buffer: p.file.buffer, mime: p.check.mime, ext: p.check.ext })),
            consoleUrl: `${appUrl()}/admin`
        })).catch(e => console.error('Item request email failed (non-blocking):', e.message));

        res.status(201).json({
            message: 'Request sent. You will get an email when it is ready to order.',
            request: { id: created.id, ref: IR.refOf(created), status: created.status, item_name: created.item_name,
                photos_saved: saved.length, photos_sent: photos.photos.length }
        });
    } catch (err) {
        console.error('Item request create error:', err);
        res.status(500).json({ error: 'Could not send your request. Please try again.' });
    }
});

module.exports = router;
