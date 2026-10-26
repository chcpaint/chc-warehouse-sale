/**
 * routes/admin-catalog-image.js
 *
 * POST /api/admin/companies/:companyId/catalog-image
 *
 * Reads a screenshot (PNG / JPG / WEBP) of an item or price update and returns
 * the items it shows. It WRITES NOTHING. The console puts the rows into the
 * Add / Import Products cards so a person can check every field, then the
 * normal Preview -> Apply import saves them (with its PPG rule and audit).
 *
 * Mounted from routes/admin.js behind requireAdminAuth, restrictOrderDesk,
 * requirePasswordCurrent and requireCompanyAccess, so a company admin can only
 * use it for their own company and order-desk accounts cannot reach it at all.
 *
 * Needs ANTHROPIC_API_KEY on the server. Without it the route says so plainly.
 */

const express = require('express');
const multer = require('multer');
const { supabaseAdmin } = require('../utils/supabase');
const { readPriceImage, ImageReadError, MAX_IMAGE_BYTES } = require('../utils/price-image');

const router = express.Router({ mergeParams: true });

// Memory only: the picture is read and dropped, never stored.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 }
});

// Cost control: each read is a paid call. 30 an hour per signed-in admin is
// plenty for real use and stops a stuck loop or a leaked token running up a bill.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map();
function allowed(adminId, now = Date.now()) {
    const list = (hits.get(adminId) || []).filter(t => now - t < WINDOW_MS);
    if (list.length >= MAX_PER_WINDOW) { hits.set(adminId, list); return false; }
    list.push(now);
    hits.set(adminId, list);
    return true;
}

router.post('/', (req, res, next) => {
    upload.single('image')(req, res, err => {
        if (!err) return next();
        const big = err.code === 'LIMIT_FILE_SIZE';
        res.status(big ? 413 : 400).json({ error: big ? 'That picture is over 5 MB. Crop it or save it smaller and try again.' : 'Could not read the upload.' });
    });
}, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose a screenshot to read.' });
        if (!allowed(req.admin.id)) return res.status(429).json({ error: 'That is a lot of screenshots for one hour. Please wait a little and try again.' });

        const result = await readPriceImage(req.file.buffer, {
            apiKey: process.env.ANTHROPIC_API_KEY,
            model: process.env.ANTHROPIC_VISION_MODEL,
            hint: req.body && req.body.hint
        });

        // Record that it happened (who, which company, how many lines) -- not the picture.
        try {
            await supabaseAdmin.from('audit_log').insert({
                admin_id: req.admin.id, action: 'catalog_image_read', entity_type: 'company', entity_id: req.params.companyId,
                details: { items: result.items.length, dropped: result.dropped, bytes: req.file.size, model: result.model },
                ip_address: req.ip
            });
        } catch (e) { console.error('Audit log write failed:', e); }

        res.json({ items: result.items, dropped: result.dropped, notes: result.notes });
    } catch (err) {
        if (err instanceof ImageReadError) {
            const status = { not_configured: 503, bad_image: 400, too_large: 413, upstream: 502, unreadable: 422 }[err.code] || 500;
            if (err.code === 'not_configured') console.error('Screenshot reading is not configured:', err.message);
            return res.status(status).json({ error: err.message, code: err.code });
        }
        console.error('Catalog image read error:', err);
        res.status(500).json({ error: 'Could not read that screenshot.' });
    }
});

module.exports = router;
module.exports._allowed = allowed;
module.exports._reset = () => hits.clear();
