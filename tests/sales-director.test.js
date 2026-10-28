/**
 * tests/sales-director.test.js
 *
 * The sales_director role: every customer of their distributor, add/edit items,
 * view and adjust customer pricing, work orders -- and nothing that creates or
 * configures anything. The failure these guard against is silent: a role that
 * quietly reaches users, tax, billing or company setup.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

// companies table stub: company-b belongs to another distributor.
const companies = {
    'company-a': { distributor_id: 'dist-1' },
    'company-b': { distributor_id: 'dist-2' }
};
const supabaseStub = {
    from: () => ({
        select: () => ({
            eq: (col, val) => ({
                maybeSingle: async () => ({ data: companies[val] || null }),
                then: res => res({ data: [] })
            })
        })
    })
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && request.startsWith('.')) {
        const resolved = path.resolve(path.dirname(parent.filename), request);
        if (resolved === path.join(ROOT, 'utils/supabase') || resolved === path.join(ROOT, 'utils/supabase.js')) {
            return { supabaseAdmin: supabaseStub };
        }
    }
    return originalLoad.call(this, request, parent, isMain);
};

const auth = require('../middleware/auth');
const { applyOrderScope, orderInScope, companyInScope, isHeadOffice } = require('../utils/order-scope');

function reach(role, method, urlPath) {
    let passed = false, status = null;
    const req = { admin: { role, must_change_password: false }, method, path: urlPath };
    const res = { status: c => { status = c; return res; }, json: () => {} };
    auth.restrictOrderDesk(req, res, () => { passed = true; });
    return { passed, status };
}

test('a sales director reaches the customer list, catalogs, pricing and orders', () => {
    const ok = [
        ['GET', '/orders'], ['GET', '/companies'],
        ['GET', '/companies/c1/products'], ['GET', '/companies/c1/products/filters'],
        ['POST', '/companies/c1/products'], ['PUT', '/companies/c1/products/p1'],
        ['POST', '/companies/c1/catalog-upload'], ['POST', '/companies/c1/catalog-image'],
        ['GET', '/pricing/companies'], ['GET', '/pricing/companies/c1/products'],
        ['PUT', '/pricing/companies/c1/products/p1/price'], ['POST', '/pricing/companies/c1/bulk'],
        ['PUT', '/companies/c1/orders/o1/items']
    ];
    for (const [m, p] of ok) assert.equal(reach('sales_director', m, p).passed, true, `${m} ${p}`);
});

test('a sales director cannot create or configure anything', () => {
    const refused = [
        ['POST', '/companies'], ['PUT', '/companies/c1'], ['DELETE', '/companies/c1'],
        ['POST', '/companies/c1/locations'], ['PUT', '/companies/c1/locations/l1'],
        ['GET', '/users'], ['POST', '/users'], ['POST', '/companies/c1/users'],
        ['PUT', '/distributor-tax'], ['PUT', '/companies/c1/tax'],
        ['PUT', '/companies/c1/modules'], ['GET', '/billing/companies'],
        ['POST', '/companies/c1/fees-rebates/fee-rules'], ['GET', '/audit-log'],
        ['POST', '/branches'], ['POST', '/branding/logo'],
        ['DELETE', '/companies/c1/products/p1'], ['POST', '/companies/c1/products/bulk-delete'],
        ['PUT', '/companies/c1/products/p1/barcode']
    ];
    for (const [m, p] of refused) {
        const r = reach('sales_director', m, p);
        assert.equal(r.passed, false, `sales_director reached ${m} ${p}`);
        assert.equal(r.status, 403);
    }
});

test('the order manager did not gain the sales director\'s extra reach', () => {
    for (const [m, p] of [['GET', '/companies'], ['POST', '/companies/c1/products'], ['PUT', '/companies/c1/products/p1'], ['POST', '/companies/c1/catalog-upload']]) {
        assert.equal(reach('order_manager', m, p).passed, false, `${m} ${p}`);
        assert.equal(reach('order_desk', m, p).passed, false, `desk ${m} ${p}`);
    }
});

test('a sales director sees every order and every company, like head office', () => {
    assert.equal(isHeadOffice('sales_director'), true);
    assert.equal(isHeadOffice('order_desk'), false);
    const calls = [];
    const q = { eq: (...a) => { calls.push(a); return q; }, in: (...a) => { calls.push(a); return q; } };
    applyOrderScope(q, { admin: { role: 'sales_director' } }, null, undefined);
    assert.deepEqual(calls, []);
    applyOrderScope(q, { admin: { role: 'sales_director' } }, null, 'company-a');
    assert.deepEqual(calls, [['company_id', 'company-a']]);
});

test('order and company scope checks pass for a sales director', async () => {
    assert.equal(await companyInScope({ admin: { role: 'sales_director' } }, 'company-a'), true);
});

test('company access is fenced to the director\'s own distributor', async () => {
    const run = async companyId => {
        let passed = false, status = null;
        const req = { admin: { role: 'sales_director', distributor_id: 'dist-1' }, params: { companyId }, body: {} };
        const res = { status: c => { status = c; return res; }, json: () => {} };
        await auth.requireCompanyAccess(req, res, () => { passed = true; });
        return { passed, status };
    };
    assert.equal((await run('company-a')).passed, true);
    const other = await run('company-b');
    assert.equal(other.passed, false);
    assert.equal(other.status, 404);
});

test('a sales director can edit prices but not unlock PPG list prices', () => {
    const pe = require('../routes/price-editor-admin');
    assert.equal(pe.canUnlockPPG({ role: 'sales_director' }), false);
    assert.equal(pe.canUnlockPPG({ role: 'super_admin' }), true);
});

test('the migration admits the role', () => {
    const sql = require('node:fs').readFileSync(path.join(ROOT, 'migrations/050_sales_director_role.sql'), 'utf8');
    assert.match(sql, /sales_director/);
    assert.match(sql, /drop constraint if exists valid_role/);
});
