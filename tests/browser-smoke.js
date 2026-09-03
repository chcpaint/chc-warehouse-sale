/**
 * tests/browser-smoke.js
 *
 * Drives a real Chromium against store.html plus a stub API, to check the
 * things unit tests cannot: that the inventory module is fetched only when the
 * company has it switched on, that the tab mounts, that a keyboard-wedge scan
 * is recognised by typing speed, and that the ordering portal is untouched when
 * the module is off.
 *
 *   node tests/browser-smoke.js
 */

const express = require('express');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');

const COMPANY_ID  = '11111111-1111-4111-8111-111111111111';
const LOCATION_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCT_ID  = '55555555-5555-4555-8555-555555555555';
const KIT_ID      = 'aaaaaaa1-1111-4111-8111-111111111111';

/** A stub console just complete enough to boot the page. */
function makeServer({ inventoryEnabled }) {
    const app = express();
    const hits = { module: 0, lookup: [], movements: [], countSession: null, countLines: [], kitConsumes: [] };

    app.use(express.json());
    app.use('/assets', express.static(path.join(ROOT, 'public/assets')));

    app.get('/refinishai-inventory.js', (req, res) => {
        hits.module++;
        res.sendFile(path.join(ROOT, 'public/refinishai-inventory.js'));
    });

    app.get('/store/:slug', (req, res) => res.sendFile(path.join(ROOT, 'public/store.html')));

    // Served so the module's registration succeeds — which also proves the
    // worker parses and installs rather than only that the file exists.
    app.get('/refinishai-inventory-sw.js', (req, res) =>
        res.sendFile(path.join(ROOT, 'public/refinishai-inventory-sw.js')));

    app.get('/api/store/platform-logo', (req, res) => res.json({ url: '/assets/chc-logo.png' }));

    app.get('/api/store/:slug/info', (req, res) => res.json({
        company: {
            id: COMPANY_ID, name: 'Assured Collision', slug: 'assured', logo_url: null,
            settings: inventoryEnabled
                ? { inventory: { enabled: true, auto_draft: true, scan_sound: false } }
                : {}
        }
    }));

    app.post('/api/auth/company-login', (req, res) => res.json({
        token: 'test-token', company: { id: COMPANY_ID, name: 'Assured Collision', slug: 'assured' }
    }));

    app.get('/api/store/:slug/locations', (req, res) => res.json({
        locations: [{ id: LOCATION_ID, name: 'Burlington', city: 'Burlington', is_active: true }]
    }));

    app.get('/api/store/:slug/products', (req, res) =>
        res.json({ products: [], total: 0, page: 1, limit: 100, filters: { brands: [], categories: [] } }));
    app.get('/api/store/:slug/promotions', (req, res) => res.json({ promotions: [] }));
    app.get('/api/store/:slug/orders', (req, res) => res.json({ orders: [] }));
    app.get('/api/store/:slug/payments/config', (req, res) => res.json({ enabled: false }));

    app.get('/api/store/:slug/inventory/summary', (req, res) => res.json({
        summary: { tracked: 12, ok: 9, low: 2, out: 1, untracked: 0, stock_value: 1234.5 },
        pending_replenishment: 1
    }));

    app.get('/api/store/:slug/inventory/levels', (req, res) => res.json({
        location: { id: LOCATION_ID, name: 'Burlington' },
        levels: [{
            id: 'lvl-1', product_id: PRODUCT_ID, sku: '2PCPSL', product_name: 'Two piece Paint Suit Large',
            brand: 'PPG', on_hand: 3, min_point: 4, max_point: 20, bin_location: 'A-03',
            stock_status: 'low', price: 84.48
        }],
        total: 1, page: 1, limit: 100
    }));

    app.get('/api/store/:slug/inventory/lookup', (req, res) => {
        hits.lookup.push(req.query.code);
        res.json({
            code: req.query.code, matched_by: 'barcode',
            product: { id: PRODUCT_ID, sku: '2PCPSL', name: 'Two piece Paint Suit Large', brand: 'PPG', price: 84.48 },
            level: { on_hand: 3, min_point: 4, max_point: 20 }
        });
    });

    app.post('/api/store/:slug/inventory/movements', (req, res) => {
        hits.movements.push(req.body);
        res.status(201).json({
            message: 'Used on a job recorded.',
            movement: { id: 'mv-1', qty_change: -1, on_hand_after: 2 },
            on_hand: 2,
            product: { id: PRODUCT_ID, name: 'Two piece Paint Suit Large', sku: '2PCPSL' },
            replenishment: { order_id: 'ro-1', line_id: 'rl-1', quantity: 18, reason: 'on-hand 2 at or below min 4' }
        });
    });

    app.get('/api/store/:slug/inventory/movements', (req, res) => res.json({ movements: [] }));
    app.get('/api/store/:slug/inventory/replenishment', (req, res) => res.json({ orders: [] }));

    // ---- phase 4 / 5 ----
    app.get('/api/store/:slug/inventory/counts', (req, res) => res.json({ sessions: hits.countSession ? [hits.countSession] : [] }));
    app.post('/api/store/:slug/inventory/counts', (req, res) => {
        hits.countSession = {
            id: '88888888-8888-4888-8888-888888888888', name: 'Full count', status: 'open',
            opened_by: req.body.actor_label, location_id: LOCATION_ID, created_at: new Date().toISOString()
        };
        res.status(201).json({ session: hits.countSession });
    });
    app.get('/api/store/:slug/inventory/counts/:id', (req, res) => res.json({
        session: hits.countSession,
        lines: hits.countLines,
        summary: { counted: hits.countLines.length, variances: hits.countLines.filter(l => l.live_variance !== 0).length, net_units: 0 }
    }));
    app.post('/api/store/:slug/inventory/counts/:id/lines', (req, res) => {
        hits.countLines.push({
            id: 'cl-' + hits.countLines.length, product_id: PRODUCT_ID, sku: '2PCPSL',
            name: 'Two piece Paint Suit Large', counted_qty: req.body.counted_qty,
            current_on_hand: 3, live_variance: Number(req.body.counted_qty) - 3, counted_by: req.body.actor_label
        });
        res.status(201).json({ line: hits.countLines.at(-1), expected_qty: 3, variance: Number(req.body.counted_qty) - 3 });
    });

    app.get('/api/store/:slug/inventory/transfers', (req, res) => res.json({ transfers: [] }));

    // ---- kits ----
    // One ready kit and one that CHC has not finished mapping, because the
    // "not set up" state is the one a real shop meets first.
    app.get('/api/store/:slug/inventory/kits', (req, res) => res.json({
        kits: [
            { id: KIT_ID, name: 'Door Skin', description: 'Skin swap', is_master: true,
              ready: true, line_count: 2, unresolved_count: 0, excluded_count: 1, estimated_cost: 7 },
            { id: '99999999-9999-4999-8999-999999999999', name: 'Roof Replace', description: null,
              is_master: true, ready: false, line_count: 0, unresolved_count: 3, excluded_count: 0, estimated_cost: 0 }
        ]
    }));

    app.get('/api/store/:slug/inventory/kits/consumptions', (req, res) =>
        res.json({ consumptions: hits.kitConsumes.map((c, i) => ({
            id: 'kc-' + i, kit_name: 'Door Skin', job_ref: c.job_ref, multiplier: c.multiplier || 1,
            line_count: 2, total_cost: 7, actor_label: c.actor_label, created_at: new Date().toISOString()
        })) }));

    app.get('/api/store/:slug/inventory/kits/:kitId/preview', (req, res) => {
        const m = Number(req.query.multiplier) || 1;
        res.json({
            kit: { id: req.params.kitId, name: 'Door Skin', description: 'Skin swap' },
            location: { id: LOCATION_ID, name: 'Burlington' },
            multiplier: m,
            lines: [
                { kit_item_id: 'bbbbbbb1-1111-4111-8111-111111111111', kit_sku: 'PRF611N',
                  product_id: PRODUCT_ID, sku: 'PRF611N', name: 'ProForm Clear Ga', category: 'Paint',
                  unit: 'each', quantity: 0.02 * m, on_hand: 5, shortfall: 0, unit_price: 200,
                  line_cost: 4 * m, would_go_negative: false, category_blocked: false, blocking: false },
                { kit_item_id: 'bbbbbbb2-2222-4222-8222-222222222222', kit_sku: 'MMM08852',
                  product_id: '77777777-7777-4777-8777-777777777777', sku: 'MMM08852', name: '3M Masking Tape',
                  category: 'Masking', unit: 'each', quantity: 0.3 * m, on_hand: 20, shortfall: 0,
                  unit_price: 10, line_cost: 3 * m, would_go_negative: false, category_blocked: false, blocking: false }
            ],
            unresolved: [],
            excluded: [{ kit_item_id: 'bbbbbbb3-3333-4333-8333-333333333333', sku: 'FUS123EZ', note: null }],
            total_cost: 7 * m,
            blocked: false,
            blocked_reason: null
        });
    });

    app.post('/api/store/:slug/inventory/kits/:kitId/consume', (req, res) => {
        hits.kitConsumes.push(req.body);
        res.status(201).json({
            message: '2 items expensed to ' + req.body.job_ref + '.',
            consumption: { id: 'kc-1', kit_name: 'Door Skin', job_ref: req.body.job_ref,
                           multiplier: req.body.multiplier, line_count: 2, total_cost: 7,
                           created_at: new Date().toISOString() },
            movements: [], replenishments_drafted: 0
        });
    });

    app.get('/api/store/:slug/inventory/analytics/summary', (req, res) => res.json({
        period: { label: 'Last 30 days', from: null, to: null },
        totals: { units_used: 42, value_used: 3456.78, movements: 12, active_days: 6, avg_value_per_active_day: 576.13 },
        series: [
            { day: '2026-08-18', units_used: 10, value_used: 800 },
            { day: '2026-08-19', units_used: 14, value_used: 1200 },
            { day: '2026-08-20', units_used: 18, value_used: 1456.78 }
        ]
    }));
    app.get('/api/store/:slug/inventory/analytics/by-product', (req, res) => res.json({
        period: { label: 'Last 30 days' }, total_items: 1,
        items: [{ product_id: PRODUCT_ID, sku: '2PCPSL', product_name: 'Two piece Paint Suit Large',
                  brand: 'PPG', units_used: 20, value_used: 1689.6 }]
    }));
    app.get('/api/store/:slug/inventory/analytics/by-job', (req, res) => res.json({
        period: { label: 'Last 30 days' },
        jobs: [{ job_ref: 'RO-4821', distinct_items: 3, units_used: 9, value_used: 612.4,
                 last_used_at: new Date().toISOString(), location_name: 'Burlington' }],
        totals: { jobs: 1, value_used: 612.4, avg_value_per_job: 612.4 }
    }));

    return { app, hits };
}

function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, () => resolve({ server, port: server.address().port }));
    });
}

/**
 * The console pulls Tailwind, Font Awesome and jsPDF from CDNs. This sandbox has
 * no route to them, and a blocking <script> in <head> that never resolves means
 * DOMContentLoaded never fires. Serve local stand-ins instead: Tailwind is
 * replaced by just enough CSS for the visibility assertions to mean something.
 */
const MINI_TAILWIND = `
    .hidden { display: none !important; }
    .fade-in, .flex, .grid, .block { display: block; }
    /* Real Tailwind's responsive utilities (min-width: 1024px etc.) would
       override .hidden at the desktop viewport size Playwright uses by
       default; without this, "hidden lg:flex" elements like the main nav
       bar stay display:none forever and every visibility-based check on
       what's inside it (#nav-inventory included) times out. */
    .lg\\:flex { display: flex !important; }
    .sm\\:inline { display: inline !important; }
`;

async function stubCdns(page) {
    // Inject the stand-in stylesheet rather than relying on a URL match: the
    // Tailwind tag has no path, which a `host/**` glob does not catch.
    await page.addInitScript((css) => {
        const apply = () => {
            const s = document.createElement('style');
            s.textContent = css;
            (document.head || document.documentElement).appendChild(s);
        };
        if (document.head) apply(); else document.addEventListener('readystatechange', apply, { once: true });
    }, MINI_TAILWIND);

    // Everything off-origin is stubbed or dropped; a blocking <script> in <head>
    // that never resolves would stop DOMContentLoaded firing at all.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, route => {
        const url = route.request().url();
        if (/\.css(\?|$)/.test(url)) return route.fulfill({ contentType: 'text/css', body: '' });
        if (/tailwindcss|\.js(\?|$)/.test(url)) return route.fulfill({ contentType: 'application/javascript', body: '' });
        return route.abort();
    });

    // The real CHC logo lives on the deployed server; serve a stand-in so the
    // markup's onerror fallback does not fire and rewrite the header.
    await page.route('**/assets/chc-logo.png', route =>
        route.fulfill({ contentType: 'image/png', body: PNG_1PX }));
}

/** A valid 1x1 PNG, so <img> onerror handlers stay quiet. */
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

/**
 * Skip the access-code and location-picker UI: seed the session the console
 * itself would have written, so these tests exercise the inventory module
 * rather than re-testing the login flow.
 */
async function login(page, base) {
    await stubCdns(page);
    await page.addInitScript(({ companyId, locationId }) => {
        sessionStorage.setItem('chc_token', 'test-token');
        sessionStorage.setItem('chc_company', JSON.stringify({ id: companyId, name: 'Assured Collision', slug: 'assured' }));
        sessionStorage.setItem('chc_location', JSON.stringify({ id: locationId, name: 'Burlington' }));
    }, { companyId: COMPANY_ID, locationId: LOCATION_ID });

    await page.goto(`${base}/store/assured`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
}

const results = [];
function check(name, fn) { results.push({ name, fn }); }

check('the module is never fetched for a company without inventory', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: false });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForTimeout(600);
        assert.equal(hits.module, 0, 'refinishai-inventory.js must not be requested');
        assert.equal(await page.locator('#nav-inventory').isVisible(), false, 'the tab must stay hidden');
        assert.equal(await page.locator('#tab-inventory').count(), 0, 'no inventory markup in the DOM');
        // and the ordering portal is unaffected
        assert.equal(await page.locator('#tab-products').isVisible(), true);
    } finally { await page.close(); server.close(); }
});

check('the module loads and mounts for a company with inventory', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)', { timeout: 5000 });
        assert.equal(hits.module, 1, 'the module should be fetched exactly once');
        assert.equal(await page.locator('#tab-inventory').count(), 1, 'the tab markup should be mounted');
        assert.ok(await page.locator('#nav-inventory').isVisible());
    } finally { await page.close(); server.close(); }
});

check('the tab is branded refinishAI and carries the logo', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.waitForSelector('#tab-inventory:not(.hidden)');

        const text = await page.locator('#tab-inventory').innerText();
        assert.match(text, /refinishAI Inventory/);

        const logo = page.locator('#tab-inventory img[alt="RefinishAI"]');
        assert.equal(await logo.count(), 1, 'the RefinishAI mark should be present');
        const loaded = await logo.evaluate(el => el.complete && el.naturalWidth > 0);
        assert.ok(loaded, 'the RefinishAI mark should actually load');

        // The CHC mark stays in the console header, as asked.
        const chc = page.locator('header img[alt="CHC Paint"]');
        assert.ok(await chc.count() >= 1, 'the CHC logo should remain in the header');
    } finally { await page.close(); server.close(); }
});

check('the summary strip renders live counters', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.waitForFunction(() => document.getElementById('inv-stat-low')?.textContent === '2', null, { timeout: 5000 });
        assert.equal(await page.locator('#inv-stat-out').innerText(), '1');
        assert.equal(await page.locator('#inv-stat-tracked').innerText(), '12');
    } finally { await page.close(); server.close(); }
});

check('a keyboard-wedge scan is recognised by typing speed', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.waitForSelector('#inv-view-scan:not(.hidden)');

        await page.fill('#inv-actor', 'Sam T');
        await page.click('#tab-inventory h3');            // move focus off any input

        // A scanner types the whole code in a burst, then presses Enter. No
        // per-key delay here, which is what the 45 ms rule is looking for.
        await page.keyboard.type('051131020474', { delay: 0 });
        await page.keyboard.press('Enter');

        await page.waitForFunction(() => document.querySelector('#inv-scan-result')?.textContent?.includes('On hand'), null, { timeout: 5000 });

        assert.deepEqual(hits.lookup, ['051131020474'], 'the wedge scan should reach the lookup endpoint');
        assert.equal(hits.movements.length, 1);
        assert.equal(hits.movements[0].movement_type, 'consume');
        assert.equal(hits.movements[0].actor_label, 'Sam T');
        assert.equal(hits.movements[0].scanned_barcode, '051131020474');

        const result = await page.locator('#inv-scan-result').innerText();
        assert.match(result, /Two piece Paint Suit Large/);
        assert.match(result, /reorder queue/i, 'the replenishment notice should be shown');
    } finally { await page.close(); server.close(); }
});

check('human-speed typing is not mistaken for a scan', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.fill('#inv-actor', 'Sam T');
        await page.click('#tab-inventory h3');

        // 120 ms between keys is ordinary human typing.
        await page.keyboard.type('0511', { delay: 120 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);

        assert.equal(hits.lookup.length, 0, 'slow typing must not fire a scan');
    } finally { await page.close(); server.close(); }
});

// ------------------------------------------------------------
// CAMERA SCANNING
//
// A phone or a MacBook, and a browser with or without the native
// BarcodeDetector API, are four different code paths through
// RAI.startCamera(). Both checks below pin regressions that only ever
// showed up once a real camera was live: a detect loop that referenced
// its own name wrong and died silently after one frame (any BarcodeDetector
// browser — Chrome desktop and Android included), and a hard-coded rear-
// camera request that failed outright on a device with no rear camera (any
// laptop) instead of falling back to the one camera it has.
// ------------------------------------------------------------

check('the camera keeps detecting frames instead of dying after the first one', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.waitForSelector('#inv-view-scan:not(.hidden)');

        const detectCalls = await page.evaluate(async () => {
            let calls = 0;
            window.BarcodeDetector = class {
                static async getSupportedFormats() { return ['code_128']; }
                async detect() { calls++; return []; }
            };
            await RAI.toggleCamera();
            await new Promise((resolve) => {
                let frames = 0;
                (function tick() {
                    frames++;
                    if (frames >= 6) return resolve();
                    requestAnimationFrame(tick);
                })();
            });
            RAI.stopCamera();
            return calls;
        });

        assert.ok(detectCalls >= 3, `detect() should keep firing across animation frames, saw ${detectCalls} call(s)`);
        assert.deepEqual(pageErrors.filter(e => /detectLoop/.test(e)), [], 'no ReferenceError from the detect loop');
    } finally { await page.close(); server.close(); }
});

check('the camera falls back to the front camera when no rear camera is available', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.waitForSelector('#inv-view-scan:not(.hidden)');

        const outcome = await page.evaluate(async () => {
            // No native BarcodeDetector — the path every iPhone/iPad and
            // most desktop Safari installs actually take.
            delete window.BarcodeDetector;
            RAI.loadScriptOnce = async () => {}; // no CDN in this stub server
            window.Html5Qrcode = class {
                constructor() { this.constraintsTried = []; }
                async start(constraint) {
                    this.constraintsTried.push(constraint.facingMode);
                    if (constraint.facingMode === 'environment') throw new Error('OverconstrainedError: no matching camera');
                }
                async stop() {}
                clear() {}
            };
            await RAI.toggleCamera();
            const html5 = RAI.state.camera.html5;
            const started = RAI.state.camera.on === true;
            const hint = document.getElementById('inv-camera-hint').textContent;
            RAI.stopCamera();
            return { constraintsTried: html5 && html5.constraintsTried, started, hint };
        });

        assert.deepEqual(outcome.constraintsTried, ['environment', 'user'], 'should try the rear camera, then fall back to the front one');
        assert.equal(outcome.started, true, 'the camera should end up running, not stuck on the failed rear-camera request');
        assert.match(outcome.hint, /hold the barcode/i);
    } finally { await page.close(); server.close(); }
});

check('opening the camera dismisses the keyboard, and a capture flashes the frame', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.waitForSelector('#inv-view-scan:not(.hidden)');

        // Focus the manual-entry box first, exactly like a phone keyboard
        // left open from a moment ago — the camera view sits below it and
        // a keyboard covers the lower half of a phone screen.
        await page.click('#inv-scan-input');
        const outcome = await page.evaluate(async () => {
            const focusedBefore = document.activeElement && document.activeElement.id;
            window.BarcodeDetector = class {
                static async getSupportedFormats() { return ['code_128']; }
                async detect() { return []; }
            };
            await RAI.toggleCamera();
            const focusedAfter = document.activeElement && document.activeElement.id;
            RAI.onCameraCode('0012345678905'); // simulate a capture directly
            const flashed = document.getElementById('inv-camera-flash').classList.contains('inv-capture-flash');
            RAI.stopCamera();
            return { focusedBefore, focusedAfter, flashed };
        });

        assert.equal(outcome.focusedBefore, 'inv-scan-input', 'the input should have been focused to start with');
        assert.notEqual(outcome.focusedAfter, 'inv-scan-input', 'opening the camera should blur the input so its keyboard closes');
        assert.equal(outcome.flashed, true, 'a capture should flash the camera frame');
    } finally { await page.close(); server.close(); }
});

check('a scan without a name is refused before it reaches the server', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.waitForSelector('#inv-view-scan:not(.hidden)');

        await page.fill('#inv-scan-input', '051131020474');
        await page.press('#inv-scan-input', 'Enter');
        await page.waitForTimeout(400);

        assert.equal(hits.lookup.length, 0);
        assert.match(await page.locator('#inv-scan-result').innerText(), /Enter your name/i);
    } finally { await page.close(); server.close(); }
});

check('the stock view lists levels with a status pill', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.click('[data-invview="stock"]');
        await page.waitForSelector('#inv-stock-body tr', { timeout: 5000 });

        const row = await page.locator('#inv-stock-body tr').first().innerText();
        assert.match(row, /Two piece Paint Suit Large/);
        assert.match(row, /Low/);
        assert.match(row, /A-03/);
    } finally { await page.close(); server.close(); }
});

check('a cycle count can be started and an item counted', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.fill('#inv-actor', 'Dana R');
        await page.click('[data-invview="count"]');
        await page.waitForSelector('#inv-view-count:not(.hidden)');

        await page.click('text=Start count');
        await page.waitForSelector('#inv-count-active:not(.hidden)', { timeout: 5000 });

        await page.fill('#inv-count-qty', '5');
        await page.fill('#inv-count-scan', '051131020474');
        await page.press('#inv-count-scan', 'Enter');

        await page.waitForFunction(
            () => document.querySelector('#inv-count-body')?.textContent?.includes('2PCPSL'),
            null, { timeout: 5000 });

        assert.equal(hits.countLines.length, 1);
        assert.equal(hits.countLines[0].counted_qty, 5);
        // Counted 5 against a system figure of 3 -> the difference is shown, not the raw count.
        assert.match(await page.locator('#inv-count-body').innerText(), /\+2/);
        assert.match(await page.locator('#inv-count-feedback').innerText(), /system had 3/);
    } finally { await page.close(); server.close(); }
});

check('counting without a quantity asks for one before scanning', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.fill('#inv-actor', 'Dana R');
        await page.click('[data-invview="count"]');
        await page.click('text=Start count');
        await page.waitForSelector('#inv-count-active:not(.hidden)');

        await page.fill('#inv-count-scan', '051131020474');
        await page.press('#inv-count-scan', 'Enter');
        await page.waitForTimeout(400);

        assert.equal(hits.countLines.length, 0);
        assert.match(await page.locator('#inv-count-feedback').innerText(), /counted quantity first/i);
    } finally { await page.close(); server.close(); }
});

check('the usage view renders the chart and both tables', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.click('[data-invview="analytics"]');
        await page.waitForSelector('#inv-view-analytics:not(.hidden)');

        await page.waitForFunction(
            () => document.querySelector('#inv-an-chart svg rect'), null, { timeout: 5000 });

        const bars = await page.locator('#inv-an-chart svg rect').count();
        assert.equal(bars, 3, 'one bar per day in the series');

        assert.match(await page.locator('#inv-an-value').innerText(), /3,456\.78/);
        assert.equal(await page.locator('#inv-an-units').innerText(), '42');
        assert.match(await page.locator('#inv-an-products').innerText(), /Two piece Paint Suit Large/);
        assert.match(await page.locator('#inv-an-jobs-body').innerText(), /RO-4821/);
    } finally { await page.close(); server.close(); }
});

check('the transfer view refuses a same-shop move before calling the server', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.fill('#inv-actor', 'Sam T');
        await page.click('[data-invview="transfer"]');
        await page.waitForSelector('#inv-view-transfer:not(.hidden)');
        await page.waitForFunction(() => document.querySelectorAll('#inv-tr-from option').length > 0, null, { timeout: 5000 });

        // The stub company has one location, so from and to are necessarily equal.
        await page.fill('#inv-tr-scan', '051131020474');
        await page.press('#inv-tr-scan', 'Enter');
        await page.waitForTimeout(400);

        assert.equal(hits.lookup.length, 0, 'no lookup should be issued');
        assert.match(await page.locator('#inv-tr-result').innerText(), /must be different/i);
    } finally { await page.close(); server.close(); }
});

check('every view switches without leaving two panes visible', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        for (const v of ['scan', 'stock', 'replen', 'kits', 'count', 'transfer', 'analytics', 'history']) {
            await page.click(`[data-invview="${v}"]`);
            await page.waitForTimeout(150);
            const visible = await page.evaluate(() =>
                ['scan','stock','replen','kits','count','transfer','analytics','history']
                    .filter(k => !document.getElementById('inv-view-' + k).classList.contains('hidden')));
            assert.deepEqual(visible, [v], `expected only ${v} visible, saw ${visible}`);
        }
    } finally { await page.close(); server.close(); }
});

// ==================================================================
// KITS
// ==================================================================

check('a kit that CHC has not finished mapping is shown but cannot be applied', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.click('[data-invview="kits"]');
        await page.waitForSelector('#inv-kit-list button');

        const cards = await page.$$('#inv-kit-list button');
        assert.equal(cards.length, 2, 'both kits are listed, including the unready one');

        // The unready kit says why, rather than silently doing nothing.
        const text = await page.textContent('#inv-kit-list');
        assert.match(text, /Not set up/);
        assert.match(text, /not matched to your catalogue/);

        const disabled = await page.$$eval('#inv-kit-list button', els => els.filter(e => e.disabled).length);
        assert.equal(disabled, 1, 'exactly the unready kit is disabled');
    } finally { await page.close(); server.close(); }
});

check('opening a kit previews the lines and prices them without posting', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.click('[data-invview="kits"]');
        await page.waitForSelector('#inv-kit-list button:not([disabled])');
        await page.click('#inv-kit-list button:not([disabled])');
        await page.waitForSelector('#inv-kit-panel:not(.hidden)');
        await page.waitForFunction(() => document.querySelectorAll('#inv-kit-lines tr').length > 1);

        assert.equal(await page.textContent('#inv-kit-total'), '$7.00');
        // The excluded line is disclosed rather than hidden.
        assert.match(await page.textContent('#inv-kit-lines'), /Not used by your shop/);
        assert.equal(hits.kitConsumes.length, 0, 'previewing must never post');
    } finally { await page.close(); server.close(); }
});

check('the commit button stays disabled until there is a repair order', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.click('[data-invview="kits"]');
        await page.waitForSelector('#inv-kit-list button:not([disabled])');
        await page.click('#inv-kit-list button:not([disabled])');
        await page.waitForFunction(() => document.querySelectorAll('#inv-kit-lines tr').length > 1);

        assert.equal(await page.$eval('#inv-kit-commit', b => b.disabled), true);
        await page.fill('#inv-kit-job', 'RO-4242');
        assert.equal(await page.$eval('#inv-kit-commit', b => b.disabled), false);

        // Clearing it disables the button again — the guard is live, not one-shot.
        await page.fill('#inv-kit-job', '');
        assert.equal(await page.$eval('#inv-kit-commit', b => b.disabled), true);
    } finally { await page.close(); server.close(); }
});

check('the multiplier rescales the preview and its cost', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.click('[data-invview="kits"]');
        await page.waitForSelector('#inv-kit-list button:not([disabled])');
        await page.click('#inv-kit-list button:not([disabled])');
        await page.waitForFunction(() => document.querySelectorAll('#inv-kit-lines tr').length > 1);

        await page.fill('#inv-kit-mult', '2');
        await page.dispatchEvent('#inv-kit-mult', 'change');
        await page.waitForFunction(() => document.getElementById('inv-kit-total').textContent === '$14.00');
    } finally { await page.close(); server.close(); }
});

check('skipping a line drops it from the total and from what is sent', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');

        await page.fill('#inv-actor', 'Sam');
        await page.click('[data-invview="kits"]');
        await page.waitForSelector('#inv-kit-list button:not([disabled])');
        await page.click('#inv-kit-list button:not([disabled])');
        await page.waitForFunction(() => document.querySelectorAll('#inv-kit-lines tr').length > 1);

        // Untick the $4 clear line; $3 of tape should remain.
        await page.uncheck('#inv-kit-lines tr:first-child input[type="checkbox"]');
        await page.waitForFunction(() => document.getElementById('inv-kit-total').textContent === '$3.00');

        await page.fill('#inv-kit-job', 'RO-77');
        await page.click('#inv-kit-commit');
        await page.waitForFunction(() => document.getElementById('inv-kit-result').textContent.includes('RO-77'));

        assert.equal(hits.kitConsumes.length, 1);
        const sent = hits.kitConsumes[0];
        assert.equal(sent.job_ref, 'RO-77');
        assert.equal(sent.actor_label, 'Sam');
        const skipped = sent.lines.filter(l => l.skip);
        assert.equal(skipped.length, 1, 'the unticked line is sent as skipped, not silently dropped');
    } finally { await page.close(); server.close(); }
});

check('a kit cannot be expensed without a name to attribute it to', async (browser) => {
    const { app, hits } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    let alerted = false;
    page.on('dialog', d => { alerted = true; d.dismiss(); });
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        await page.fill('#inv-actor', '');
        await page.click('[data-invview="kits"]');
        await page.waitForSelector('#inv-kit-list button:not([disabled])');
        await page.click('#inv-kit-list button:not([disabled])');
        await page.waitForFunction(() => document.querySelectorAll('#inv-kit-lines tr').length > 1);

        await page.fill('#inv-kit-job', 'RO-1');
        await page.click('#inv-kit-commit');
        await page.waitForTimeout(300);

        assert.equal(hits.kitConsumes.length, 0, 'nothing is posted anonymously');
        assert.ok(alerted, 'the operator is told why');
    } finally { await page.close(); server.close(); }
});

check('the page reports no console errors while the module runs', async (browser) => {
    const { app } = makeServer({ inventoryEnabled: true });
    const { server, port } = await listen(app);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    try {
        await login(page, `http://127.0.0.1:${port}`);
        await page.waitForSelector('#nav-inventory:not(.hidden)');
        await page.click('#nav-inventory');
        for (const v of ['stock', 'replen', 'count', 'transfer', 'analytics', 'history', 'scan']) {
            await page.click(`[data-invview="${v}"]`);
            await page.waitForTimeout(250);
        }
        // Ignore the noise a stub server cannot avoid.
        const real = errors.filter(e =>
            !/favicon|tailwind|Failed to load resource|service ?worker|manifest|autocomplete/i.test(e));
        assert.deepEqual(real, [], 'no page errors expected: ' + JSON.stringify(errors));
    } finally { await page.close(); server.close(); }
});

(async () => {
    // The container ships a pinned Chromium; use it rather than downloading one.
    const pinned = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    const launchOpts = { args: [
        '--no-sandbox',
        // A synthetic camera device, auto-granted, so the camera checks below
        // exercise a real getUserMedia()/MediaStream round trip rather than a
        // hand-rolled stand-in.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream'
    ] };
    if (require('node:fs').existsSync(pinned)) launchOpts.executablePath = pinned;
    const browser = await chromium.launch(launchOpts);
    let pass = 0, fail = 0;
    // SMOKE_FILTER=<substring> runs just the matching check(s) -- handy since
    // the full file, one Chromium page per check, is slow to run end to end.
    const filter = process.env.SMOKE_FILTER;
    const toRun = filter ? results.filter(r => r.name.includes(filter)) : results;
    for (const { name, fn } of toRun) {
        try {
            await Promise.race([
                fn(browser),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 30s')), 30000))
            ]);
            console.log(`ok   ${name}`);
            pass++;
        } catch (err) {
            console.log(`FAIL ${name}\n     ${err.message.split('\n')[0]}`);
            fail++;
        }
    }
    await browser.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
