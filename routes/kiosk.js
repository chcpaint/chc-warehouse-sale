/**
 * routes/kiosk.js
 *
 * The scan-out kiosk API, mounted at /api/kiosk.
 *
 * A tablet at the stock room or cage runs /kiosk/<secret> (public/kiosk.html).
 * People scan an ID badge, then scan out what they take. There is no login and
 * no session: the tablet's secret link IS its credential, and that credential
 * can do exactly four things —
 *
 *     GET  /session    what this tablet is (company, location, options)
 *     GET  /resolve    what did that scan hit: a badge, a product, or nothing
 *     POST /scan-out   post a confirmed basket as `consume` movements
 *
 * and, only where a company has switched on stock ordering, two more behind the
 * company's order passcode:
 *
 *     POST /order/unlock    passcode -> a 30-minute order session (scoped token)
 *     POST /order/passcode  change the passcode (needs the current one)
 *
 * The order session is a narrow token (see SCOPED_ROUTES in middleware/auth.js):
 * it can look up an item, read the order-form settings and place an order for
 * this tablet's location, and nothing else. The order itself goes through the
 * store's own order route, so PO rules, tax, fees and branch emails are exactly
 * the store's.
 *
 * It cannot place an order, read prices, list stock levels, see other people,
 * or reach the storefront or admin APIs: those require a company or admin JWT,
 * which a kiosk never holds. A leaked kiosk link is therefore worth "someone can
 * scan out items at one location", and revoking it in the console ends that.
 *
 * This file touches nothing about how any company signs in to its store.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { supabaseAdmin } = require('../utils/supabase');
const { stripHtml, isValidUUID } = require('../utils/sanitize');
const { moduleEnabled } = require('../utils/modules');
const {
    inventorySettings,
    movementDelta,
    barcodeVariants,
    canonicalBarcode
} = require('../utils/inventory');
const {
    hashKioskToken,
    validKioskToken,
    normalizeBadgeCode,
    looksLikeBadge,
    scanOutOptions,
    passcodeProblem,
    hashPasscode,
    verifyPasscode,
    ORDER_MAX_FAILS,
    ORDER_LOCK_MS,
    ORDER_TOKEN_SECONDS
} = require('../utils/scan-out');
const { recordScanException } = require('../utils/scan-exceptions');

const router = express.Router();

const MAX_LINES = 100;
const MAX_QTY = 1000;

// ============================================================
// RATE LIMITS
//
// The site-wide limiter would put a whole shop floor on one anonymous per-IP
// bucket (see server.js, which skips /api/kiosk). These replace it:
//   * a generous per-tablet limit, so real scanning never trips it;
//   * a strict per-IP limit that counts ONLY rejected links (401), which is
//     what stops someone guessing secrets without ever slowing a real tablet.
// ============================================================
const badLinkLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    keyGenerator: req => `ip:${ipKeyGenerator(req.ip)}`,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    skipSuccessfulRequests: true,
    message: { error: 'Too many unrecognised kiosk links. Please wait a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false
});

const tabletLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: parseInt(process.env.RATE_LIMIT_KIOSK_MAX) || 3000,
    keyGenerator: req => `kiosk:${hashKioskToken(tokenFrom(req)).slice(0, 24)}`,
    message: { error: 'This tablet is sending too many requests. Please wait a moment.' },
    standardHeaders: true,
    legacyHeaders: false
});

router.use(badLinkLimiter);
router.use(tabletLimiter);

// ============================================================
// HELPERS
// ============================================================

function text(v, max = 200) {
    return stripHtml(String(v === undefined || v === null ? '' : v)).trim().slice(0, max);
}

function tokenFrom(req) {
    return String(req.headers['x-kiosk-token'] || '').trim();
}

function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
}

function dedupe(list) {
    const seen = new Map();
    for (const p of list) if (p && p.id && !seen.has(p.id)) seen.set(p.id, p);
    return [...seen.values()];
}

// The reorder drafting and on-hand lookup live in the store inventory router;
// reusing them keeps a kiosk scan-out raising reorders exactly as a phone scan
// does. Required lazily so this file stays loadable on its own in tests.
function inventoryHelpers() {
    return require('./inventory-store').helpers;
}

// ============================================================
// GUARD: the secret link
// ============================================================

/**
 * Resolve the tablet from its secret, and confirm the company still has the
 * kiosk switched on. Every failure past this point is a 401/403 with no detail
 * about which part failed, so the response never helps a guesser.
 */
async function requireKiosk(req, res, next) {
    try {
        const token = tokenFrom(req);
        if (!validKioskToken(token)) return res.status(401).json({ error: 'This kiosk link is not valid.' });

        const { data: device } = await supabaseAdmin
            .from('kiosk_devices')
            .select('id, company_id, location_id, name, is_active')
            .eq('token_hash', hashKioskToken(token))
            .maybeSingle();

        if (!device || device.is_active === false) {
            return res.status(401).json({ error: 'This kiosk link is not valid.' });
        }

        const { data: company } = await supabaseAdmin
            .from('companies')
            .select('id, name, slug, is_active, settings, distributor_id')
            .eq('id', device.company_id)
            .maybeSingle();

        if (!company || company.is_active === false) {
            return res.status(401).json({ error: 'This kiosk link is not valid.' });
        }

        if (!moduleEnabled(company.settings, 'inventory') || !moduleEnabled(company.settings, 'scan_out')) {
            return res.status(403).json({ error: 'The scan-out kiosk is switched off for this account.' });
        }

        const { data: location } = await supabaseAdmin
            .from('company_locations')
            .select('id, name, is_active')
            .eq('id', device.location_id)
            .eq('company_id', device.company_id)
            .maybeSingle();

        if (!location || location.is_active === false) {
            return res.status(403).json({ error: 'This kiosk’s location is no longer active.' });
        }

        req.kiosk = {
            device,
            company: { id: company.id, name: company.name, slug: company.slug, distributor_id: company.distributor_id, settings: company.settings },
            location: { id: location.id, name: location.name },
            options: scanOutOptions(company.settings),
            inventory: inventorySettings(company.settings)
        };

        // Best-effort heartbeat so the console can show a tablet that has gone
        // quiet. Never allowed to fail a scan.
        supabaseAdmin
            .from('kiosk_devices')
            .update({ last_seen_at: new Date().toISOString() })
            .eq('id', device.id)
            .then(() => {}, () => {});

        next();
    } catch (err) {
        console.error('Kiosk guard error:', err);
        res.status(500).json({ error: 'The kiosk could not check its link. Try again.' });
    }
}

router.use(requireKiosk);

async function findBadge(companyId, code) {
    const normalized = normalizeBadgeCode(code);
    if (!normalized) return null;
    const { data } = await supabaseAdmin
        .from('kiosk_badges')
        .select('id, name, trade, is_active')
        .eq('company_id', companyId)
        .eq('badge_code', normalized)
        .maybeSingle();
    if (!data || data.is_active === false) return null;
    return { id: data.id, name: data.name, trade: data.trade || null };
}

// ============================================================
// GET /session
// ============================================================
router.get('/session', async (req, res) => {
    const k = req.kiosk;
    res.json({
        company: k.company.name,
        location: k.location.name,
        device: k.device.name,
        require_badge: k.options.require_badge,
        idle_seconds: k.options.idle_seconds,
        // Whether to show the green "Place Stock Order" bar at all.
        ordering: (await orderingState(k)).available
    });
});

// ============================================================
// STOCK ORDERING (behind the company's order passcode)
// ============================================================

/**
 * Can this tablet offer ordering right now, and if not, why not?
 *
 * Ordering is the store's own order flow, which a company that tracks who
 * orders (People & activity) restricts to signed-in individuals — so a kiosk
 * cannot order for those companies. Everything is read defensively: before
 * migration 054 is applied the table is simply missing, and the tablet must
 * carry on scanning out.
 */
async function orderingState(k) {
    try {
        if (!k.options.order_enabled) return { available: false, reason: 'off' };
        if (moduleEnabled(k.company.settings, 'activity')) return { available: false, reason: 'individual_logins' };
        const { data, error } = await supabaseAdmin
            .from('kiosk_order_access').select('company_id').eq('company_id', k.company.id).maybeSingle();
        if (error || !data) return { available: false, reason: 'no_passcode' };
        return { available: true };
    } catch (_) {
        return { available: false, reason: 'error' };
    }
}

/** This tablet's lockout state. A missing column (054 not applied) reads as "not locked, no counter". */
async function lockState(deviceId) {
    const { data } = await supabaseAdmin
        .from('kiosk_devices').select('order_fail_count, order_locked_until').eq('id', deviceId).maybeSingle();
    const until = data && data.order_locked_until ? new Date(data.order_locked_until).getTime() : 0;
    return { fails: Number(data?.order_fail_count || 0), lockedMs: Math.max(0, until - Date.now()) };
}

function lockedReply(res, lockedMs) {
    const mins = Math.max(1, Math.ceil(lockedMs / 60000));
    return res.status(429).json({
        error: `Too many wrong passcodes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        locked_seconds: Math.ceil(lockedMs / 1000)
    });
}

/**
 * Check a passcode against the company's, counting wrong tries against THIS
 * tablet. Returns { ok: true } or sends the response itself and returns { ok: false }.
 */
async function checkPasscode(req, res, passcode) {
    const k = req.kiosk;

    const state = await orderingState(k);
    if (!state.available) {
        res.status(403).json({
            error: state.reason === 'individual_logins'
                ? 'This company\u2019s orders are placed by signed-in people, so the tablet cannot order.'
                : 'Ordering from this tablet is not set up. Ask your manager.',
            code: state.reason
        });
        return { ok: false };
    }

    const lock = await lockState(k.device.id);
    if (lock.lockedMs > 0) { lockedReply(res, lock.lockedMs); return { ok: false }; }

    const code = String(passcode === undefined || passcode === null ? '' : passcode).trim();
    if (!/^\d{1,12}$/.test(code)) {
        res.status(400).json({ error: 'Enter the passcode using numbers.' });
        return { ok: false };
    }

    const { data: access } = await supabaseAdmin
        .from('kiosk_order_access').select('passcode_hash').eq('company_id', k.company.id).maybeSingle();
    const good = access && await verifyPasscode(code, access.passcode_hash);

    if (!good) {
        const fails = lock.fails + 1;
        const locking = fails >= ORDER_MAX_FAILS;
        await supabaseAdmin.from('kiosk_devices').update({
            order_fail_count: locking ? 0 : fails,
            order_locked_until: locking ? new Date(Date.now() + ORDER_LOCK_MS).toISOString() : null
        }).eq('id', k.device.id);
        if (locking) { lockedReply(res, ORDER_LOCK_MS); return { ok: false }; }
        res.status(401).json({
            error: 'That passcode is not right.',
            attempts_left: ORDER_MAX_FAILS - fails
        });
        return { ok: false };
    }

    if (lock.fails) {
        await supabaseAdmin.from('kiosk_devices')
            .update({ order_fail_count: 0, order_locked_until: null }).eq('id', k.device.id);
    }
    return { ok: true };
}

/**
 * POST /order/unlock   Body: { passcode }
 *
 * A right passcode returns an order session: a short-lived token that is valid
 * for the store's lookup / order-form / order endpoints for THIS tablet's
 * location only, plus what the order screen needs to draw itself.
 */
router.post('/order/unlock', async (req, res) => {
    try {
        const k = req.kiosk;
        const check = await checkPasscode(req, res, req.body && req.body.passcode);
        if (!check.ok) return;

        // Who can be named on an order from this location.
        let orderers = [];
        try {
            const { data: loc } = await supabaseAdmin
                .from('company_locations').select('orderer_names')
                .eq('id', k.location.id).eq('company_id', k.company.id).maybeSingle();
            orderers = Array.isArray(loc && loc.orderer_names)
                ? loc.orderer_names.map(n => text(n, 80)).filter(Boolean) : [];
        } catch (_) { /* column not present: no fixed list */ }

        const claims = {
            type: 'company',
            scope: 'kiosk_order',
            company_id: k.company.id,
            slug: k.company.slug,
            company_name: k.company.name,
            location_id: k.location.id,
            device_id: k.device.id
        };
        if (k.company.distributor_id) claims.distributor_id = k.company.distributor_id;

        const token = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: ORDER_TOKEN_SECONDS });

        res.json({
            token,
            expires_in: ORDER_TOKEN_SECONDS,
            slug: k.company.slug,
            location: { id: k.location.id, name: k.location.name },
            device: k.device.name,
            orderer_names: orderers,
            contact: { name: k.options.order_contact_name, email: k.options.order_contact_email },
            hide_pricing: moduleEnabled(k.company.settings, 'hide_pricing')
        });
    } catch (err) {
        console.error('Kiosk unlock error:', err);
        res.status(500).json({ error: 'Could not check the passcode. Try again.' });
    }
});

/**
 * POST /order/passcode   Body: { current, next }
 *
 * Whoever holds the passcode can change it, with no individual login involved.
 * Changing it needs the current one, so a person at an unlocked screen who has
 * never been told the passcode cannot lock the managers out.
 */
router.post('/order/passcode', async (req, res) => {
    try {
        const k = req.kiosk;
        const next = String(req.body && req.body.next !== undefined ? req.body.next : '').trim();

        const problem = passcodeProblem(next);
        if (problem) return res.status(400).json({ error: problem });

        const check = await checkPasscode(req, res, req.body && req.body.current);
        if (!check.ok) return;

        if (String(req.body.current).trim() === next) {
            return res.status(400).json({ error: 'The new passcode must be different from the current one.' });
        }

        const { error } = await supabaseAdmin.from('kiosk_order_access').upsert({
            company_id: k.company.id,
            passcode_hash: await hashPasscode(next),
            changed_at: new Date().toISOString(),
            changed_by: `Tablet: ${k.device.name}`
        }, { onConflict: 'company_id' });
        if (error) throw error;

        res.json({ message: 'The passcode was changed. Give the new one to the people who place orders.' });
    } catch (err) {
        console.error('Kiosk passcode change error:', err);
        res.status(500).json({ error: 'Could not change the passcode. Try again.' });
    }
});

// ============================================================
// GET /resolve?code=
//
// One endpoint for every scan, so the tablet never has to guess whether it was
// handed a badge or a product.
// ============================================================
router.get('/resolve', async (req, res) => {
    try {
        const k = req.kiosk;
        const raw = text(req.query.code, 128);
        if (!raw) return res.status(400).json({ error: 'Nothing was scanned.' });

        if (looksLikeBadge(raw)) {
            const badge = await findBadge(k.company.id, raw);
            if (!badge) return res.status(404).json({ kind: 'none', error: 'That ID badge is not recognised. See your manager.' });
            return res.json({ kind: 'badge', badge });
        }

        const variants = barcodeVariants(raw);
        let products = [];

        if (variants.length) {
            const { data, error } = await supabaseAdmin
                .from('product_barcodes')
                .select('barcode, products!inner(id, name, sku, brand, unit, is_active, company_id)')
                .in('barcode', variants)
                .eq('products.company_id', k.company.id)
                .eq('products.is_active', true)
                .limit(20);
            if (error) throw error;
            products = dedupe((data || []).map(r => r.products));
        }

        // A shelf label or typed part number works the same as a UPC scan.
        if (products.length === 0) {
            const { data } = await supabaseAdmin
                .from('products')
                .select('id, name, sku, brand, unit, is_active')
                .eq('company_id', k.company.id)
                .eq('is_active', true)
                .ilike('sku', raw.replace(/[%_,()]/g, ''))
                .limit(20);
            products = dedupe(data || []);
        }

        if (products.length === 0) {
            // Kept for the manager to put right. Who scanned it comes from the
            // badge the tablet is working under, looked up here, never trusted as text.
            let actor = null;
            if (req.query.badge) {
                const badge = await findBadge(k.company.id, text(req.query.badge, 40)).catch(() => null);
                if (badge) actor = badge.name;
            }
            await recordScanException({
                companyId: k.company.id, locationId: k.location.id, raw,
                context: 'kiosk', contextRef: k.device && k.device.id, intended: 'consume', actor
            });
            return res.status(404).json({ kind: 'none', error: `Nothing matches ${raw}. It has been noted for your manager.`, code: raw, noted: true });
        }

        // No prices, no stock levels: the kiosk only needs to know what it is.
        const shape = p => ({ id: p.id, name: p.name, sku: p.sku, brand: p.brand || null, unit: p.unit || null });

        if (products.length > 1) {
            return res.json({ kind: 'choose', code: canonicalBarcode(raw) || raw, products: products.map(shape) });
        }
        res.json({ kind: 'product', code: canonicalBarcode(raw) || raw, product: shape(products[0]) });
    } catch (err) {
        console.error('Kiosk resolve error:', err);
        res.status(500).json({ error: 'Could not look that up. Try again.' });
    }
});

// ============================================================
// POST /scan-out
//
// Body: { session_id (uuid), badge_code?, items: [{ product_id, quantity, scanned_barcode? }] }
//
// session_id makes a retry safe. A tablet that loses Wi-Fi mid-confirm cannot
// know whether its request landed, so it resends with the same session_id; any
// line already posted under it is reported as done and not posted twice.
// ============================================================
router.post('/scan-out', async (req, res) => {
    try {
        const k = req.kiosk;
        const body = req.body || {};

        const sessionId = String(body.session_id || '');
        if (!isValidUUID(sessionId)) return res.status(400).json({ error: 'This scan session is not valid. Start again.' });

        // Who is taking the stock.
        let badge = null;
        if (body.badge_code) {
            badge = await findBadge(k.company.id, body.badge_code);
            if (!badge) return res.status(400).json({ error: 'That ID badge is not recognised. See your manager.', code: 'bad_badge' });
        } else if (k.options.require_badge) {
            return res.status(400).json({ error: 'Scan your ID badge first.', code: 'badge_required' });
        }

        // Basket: merge repeat scans of one product and check every line's shape
        // before anything is written.
        const rawItems = Array.isArray(body.items) ? body.items : [];
        if (rawItems.length === 0) return res.status(400).json({ error: 'Scan at least one item first.' });
        if (rawItems.length > MAX_LINES) return res.status(400).json({ error: `A session can hold up to ${MAX_LINES} items.` });

        const lines = new Map();
        for (const it of rawItems) {
            const productId = it && it.product_id;
            if (!isValidUUID(productId)) return res.status(400).json({ error: 'One of the scanned items is not valid. Start again.' });
            const qty = Number(it.quantity);
            if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) {
                return res.status(400).json({ error: `Quantity must be between 0 and ${MAX_QTY}.` });
            }
            const cur = lines.get(productId) || { product_id: productId, quantity: 0, scanned_barcode: null };
            cur.quantity = round4(cur.quantity + qty);
            if (!cur.scanned_barcode && it.scanned_barcode) cur.scanned_barcode = canonicalBarcode(text(it.scanned_barcode, 128)) || null;
            lines.set(productId, cur);
        }

        // Anything already posted under this session is a retry.
        const { data: already } = await supabaseAdmin
            .from('stock_movements')
            .select('product_id')
            .eq('company_id', k.company.id)
            .eq('source_doc_id', sessionId);
        const done = new Set((already || []).map(r => r.product_id));

        const { levelsFor, maybeDraftReplenishment } = inventoryHelpers();
        const actor = badge ? badge.name : `Kiosk — ${k.device.name}`;
        const results = [];

        for (const line of lines.values()) {
            if (done.has(line.product_id)) {
                results.push({ product_id: line.product_id, ok: true, duplicate: true });
                continue;
            }

            const { data: product } = await supabaseAdmin
                .from('products')
                .select('id, name, sku, price, is_active')
                .eq('id', line.product_id)
                .eq('company_id', k.company.id)
                .maybeSingle();

            if (!product || product.is_active === false) {
                results.push({ product_id: line.product_id, ok: false, error: 'That item is not available to scan out.' });
                continue;
            }

            const level = (await levelsFor(k.company.id, k.location.id, [product.id]))[product.id] || null;
            const onHand = Number(level?.on_hand ?? 0);

            const delta = movementDelta('consume', line.quantity, onHand);
            if (!delta.ok) {
                results.push({ product_id: product.id, name: product.name, sku: product.sku, ok: false, error: delta.error });
                continue;
            }

            if (!k.inventory.allow_negative && onHand + delta.delta < 0) {
                results.push({
                    product_id: product.id, name: product.name, sku: product.sku, ok: false,
                    error: `Only ${onHand} on hand — see your manager.`
                });
                continue;
            }

            const { data: movement, error } = await supabaseAdmin
                .from('stock_movements')
                .insert({
                    company_id: k.company.id,
                    location_id: k.location.id,
                    product_id: product.id,
                    qty_change: delta.delta,
                    movement_type: 'consume',
                    reason: 'Scanned out at kiosk',
                    scanned_barcode: line.scanned_barcode,
                    actor_type: 'kiosk',
                    actor_label: actor,
                    source_doc_type: 'kiosk_scan',
                    source_doc_id: sessionId,
                    badge_id: badge ? badge.id : null,
                    kiosk_device_id: k.device.id
                })
                .select('id, qty_change, on_hand_after')
                .single();

            // The same basket arrived twice at once (a double tap, a retry that
            // overlapped the first try). The database allows one posting per
            // basket and product (migration 060), so the second is told it is
            // already done, exactly like a sequential retry.
            if (error && error.code === '23505') {
                results.push({ product_id: product.id, name: product.name, sku: product.sku, ok: true, duplicate: true });
                continue;
            }

            if (error) {
                console.error('Kiosk movement insert failed:', error);
                results.push({ product_id: product.id, name: product.name, sku: product.sku, ok: false, error: 'Could not record this item. Try again.' });
                continue;
            }

            if (k.inventory.auto_draft) {
                await maybeDraftReplenishment({
                    companyId: k.company.id,
                    location: k.location,
                    product,
                    actor,
                    onHand: Number(movement.on_hand_after),
                    level
                });
            }

            results.push({
                product_id: product.id, name: product.name, sku: product.sku,
                ok: true, quantity: line.quantity
            });
        }

        const failed = results.filter(r => !r.ok);
        const posted = results.filter(r => r.ok && !r.duplicate);
        const status = failed.length === 0 ? 201 : (posted.length || results.some(r => r.duplicate)) ? 207 : 409;

        res.status(status).json({
            ok: failed.length === 0,
            message: failed.length === 0
                ? 'Scanned out. Thank you.'
                : `${results.length - failed.length} of ${results.length} items were scanned out.`,
            person: badge ? badge.name : null,
            results
        });
    } catch (err) {
        console.error('Kiosk scan-out error:', err);
        res.status(500).json({ error: 'Could not record that. Nothing was lost on screen — try Confirm again.' });
    }
});

module.exports = router;
