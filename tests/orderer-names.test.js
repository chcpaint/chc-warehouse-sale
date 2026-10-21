/**
 * tests/orderer-names.test.js
 *
 * "Who is ordering" as a fixed drop-down for shops on the shared access code
 * (company_locations.orderer_names, migration 046).
 *
 * The drop-down is a convenience in the browser. The properties worth defending
 * are the ones a browser cannot enforce:
 *
 *   - a hand-built request cannot put any other name on an order
 *   - a shop WITHOUT a list orders exactly as before (typed name)
 *   - the match is forgiving (case, spacing) but the stored name is always the
 *     configured spelling, so reports group one person once
 *   - a signed-in individual keeps their own account name, drop-down or not
 *   - before the migration has been run, nobody is locked out of ordering
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { createFakeSupabase } = require('./helpers/fake-supabase');

const ROOT = path.resolve(__dirname, '..');
let fake = createFakeSupabase();
let authCompany = null;
let authUser = null;
const sent = { orders: [] };

const supabaseProxy = new Proxy({}, {
    get: (_t, prop) => {
        const v = fake[prop];
        return typeof v === 'function' ? v.bind(fake) : v;
    }
});

const stubs = {
    [path.join(ROOT, 'utils/supabase.js')]: { supabaseAdmin: supabaseProxy },
    [path.join(ROOT, 'middleware/auth.js')]: {
        requireCompanyAuth: (req, res, next) => {
            if (!authCompany) return res.status(401).json({ error: 'Not authenticated.' });
            req.company = authCompany;
            if (authUser) req.companyUser = authUser;
            next();
        },
        requireAdminAuth: (req, res, next) => next(),
        requireSuperAdmin: (req, res, next) => next(),
        requireCompanyAccess: (req, res, next) => next(),
        // Added when per-company customer users landed. The storefront now pulls
        // in company-users-store, which calls router.use() with these at module
        // load — so a stub missing one of them is not a failing assertion, it is
        // the whole file refusing to load.
        requireCompanyUser: (req, res, next) => next(),
        requireCompanyOwner: (req, res, next) => next(),
        requireFullAdmin: (req, res, next) => next(),
        restrictOrderDesk: (req, res, next) => next(),
        requireOrderAccess: (req, res, next) => next()
    },
    [path.join(ROOT, 'utils/sanitize.js')]: {
        stripHtml: (s) => String(s === undefined || s === null ? '' : s).replace(/<[^>]*>/g, ''),
        sanitizeObject: (o) => o,
        isValidUUID: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
        generateSlug: (s) => s,
        validateEmail: () => true
    },
    [path.join(ROOT, 'utils/recipients.js')]: {
        resolveOrderRecipients: async () => ({ to: ['branch@example.invalid'], replyTo: null }),
        validEmails: (l) => l
    },
    [path.join(ROOT, 'utils/email.js')]: {
        sendOrderNotification: async (o) => { sent.orders.push(o); return { sent: true }; },
        sendInvoiceReady: async () => {}, sendOrderClosed: async () => {},
        sendLowStockAlert: async () => ({ sent: true }), sendReorderRaised: async () => ({ sent: true })
    },
    [path.join(ROOT, 'utils/payments.js')]: {
        paymentsEnabled: () => false,
        publicPaymentConfig: () => ({ enabled: false }),
        getStripe: () => null
    },
    [path.join(ROOT, 'middleware/upload.js')]: {
        catalogUpload: { single: () => (req, res, next) => next() },
        logoUpload: { single: () => (req, res, next) => next() },
        invoiceUpload: { single: () => (req, res, next) => next() }
    }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        for (const key of Object.keys(stubs)) {
            if (key === resolved || key === resolved + '.js') return stubs[key];
        }
    }
    return originalLoad.call(this, request, parent, isMain);
};

const express = require('express');
const request = require('supertest');
const storefront = require('../routes/storefront');



const CO      = '11111111-1111-4111-8111-111111111111';
const LOC_YM  = '33333333-3333-4333-8333-333333333331';
const LOC_N7  = '33333333-3333-4333-8333-333333333332';
const LOC_OPEN = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const USER    = '66666666-6666-4666-8666-666666666666';

function seed(opts = {}) {
    const withCol = opts.withColumn !== false;
    const loc = (id, name, names) => ({
        id, company_id: CO, name, is_active: true, restrict_to_category: null,
        ...(withCol ? { orderer_names: names } : {})
    });
    return createFakeSupabase({
        companies: [{
            id: CO, name: "Louie's", slug: 'louies', is_active: true,
            contact_email: 'shop@example.invalid', email_config: {}, settings: {}
        }],
        company_locations: [
            loc(LOC_YM, 'York Mills', ['Bav Mehan', 'Kartik Mehan']),
            loc(LOC_N7, 'North Seven', ['Julio Mendez', 'Frank Gulli', 'Marco Marsili']),
            loc(LOC_OPEN, 'Open Shop', [])
        ],
        company_users: [{ id: USER, company_id: CO, name: 'Dana Account', email: 'dana@example.invalid', role: 'member', is_active: true }],
        products: [{ id: PRODUCT, company_id: CO, sku: 'X-1', name: 'Widget', category: 'Misc', price: 10, is_active: true, price_on_request: false }],
        company_po_sequences: []
    });
}

function reset(opts) {
    fake = seed(opts);
    authCompany = { id: CO, name: "Louie's", slug: 'louies' };
    authUser = null;
    sent.orders = [];
}

function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/store', storefront);
    return a;
}

const order = (location_id, contact_name) => ({
    contact_name, contact_email: 'sam@example.invalid', contact_phone: '000',
    location_id, location: 'x', po_number: 'PO-1',
    items: [{ product_id: PRODUCT, quantity: 2 }]
});

test('the locations list carries each shop\'s names', async () => {
    reset();
    const res = await request(app()).get('/api/store/louies/locations');
    assert.equal(res.status, 200);
    const ym = res.body.locations.find(l => l.id === LOC_YM);
    assert.deepEqual(ym.orderer_names, ['Bav Mehan', 'Kartik Mehan']);
});

test('a listed name can order', async () => {
    reset();
    const res = await request(app()).post('/api/store/louies/orders').send(order(LOC_YM, 'Bav Mehan'));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(fake.db.orders[0].contact_name, 'Bav Mehan');
});

test('a name that is not on the list is refused', async () => {
    reset();
    const res = await request(app()).post('/api/store/louies/orders').send(order(LOC_YM, 'Someone Else'));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /choose who is ordering/i);
    assert.equal((fake.db.orders || []).length, 0, 'no order may be created');
});

test('an empty name is refused where there is a list', async () => {
    reset();
    const res = await request(app()).post('/api/store/louies/orders').send(order(LOC_N7, '  '));
    assert.equal(res.status, 400);
});

test('each shop has its own list: a York Mills name cannot order for North Seven', async () => {
    reset();
    const res = await request(app()).post('/api/store/louies/orders').send(order(LOC_N7, 'Bav Mehan'));
    assert.equal(res.status, 400);
});

test('the match ignores case and spacing, and stores the configured spelling', async () => {
    reset();
    const res = await request(app()).post('/api/store/louies/orders').send(order(LOC_N7, '  marco   marsili'.replace(/\s+/g, ' ')));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(fake.db.orders[0].contact_name, 'Marco Marsili');
});

test('a shop with no list still takes a typed name', async () => {
    reset();
    const res = await request(app()).post('/api/store/louies/orders').send(order(LOC_OPEN, 'Anyone Typed'));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(fake.db.orders[0].contact_name, 'Anyone Typed');
});

test('a signed-in individual keeps their own name, list or not', async () => {
    reset();
    authUser = { id: USER, role: 'member' };
    const res = await request(app()).post('/api/store/louies/orders').send(order(LOC_YM, 'Bav Mehan'));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(fake.db.orders[0].contact_name, 'Dana Account');
});

test('before the migration is run, ordering and the location list still work', async () => {
    reset({ withColumn: false });
    // The real database errors on an unknown column; make the fake do the same.
    const realFrom = fake.from.bind(fake);
    fake.from = (t) => {
        const q = realFrom(t);
        if (t !== 'company_locations') return q;
        const realSelect = q.select.bind(q);
        q.select = (cols, ...rest) => {
            if (String(cols).includes('orderer_names')) {
                const failing = realSelect('id');
                failing.then = (res) => Promise.resolve({ data: null, error: { code: '42703', message: 'column company_locations.orderer_names does not exist' } }).then(res);
                return failing;
            }
            return realSelect(cols, ...rest);
        };
        return q;
    };
    const list = await request(app()).get('/api/store/louies/locations');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.locations.length >= 1);
    const res = await request(app()).post('/api/store/louies/orders').send(order(LOC_YM, 'Anyone Typed'));
    assert.equal(res.status, 201, JSON.stringify(res.body));
});
