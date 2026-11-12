/**
 * tests/new-look.test.js -- the new look is opt-in per company and inert when off.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modules = require('../utils/modules');

test('the New look module exists, is released, needs nothing else, and is off by default', () => {
    assert.ok(modules.MODULE_NAMES.includes('new_look'));
    assert.equal(modules.moduleEnabled({}, 'new_look'), false);
    assert.equal(modules.moduleEnabled({ new_look: { enabled: true } }, 'new_look'), true);
    const st = modules.moduleStatus({}).find(m => m.name === 'new_look');
    assert.equal(st.released, true);
    assert.deepEqual(st.requires, []);
});

test('the New look is never billed, so a paid-mode company can still have it', () => {
    const paid = { billing: { mode: 'paid', entitled: [] }, new_look: { enabled: true } };
    assert.equal(modules.moduleEnabled(paid, 'new_look'), true);
});

function loadNewLook() {
    const classes = new Set();
    const listeners = [];
    const document = {
        body: { classList: {
            toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
            contains: c => classes.has(c)
        } },
        getElementById: () => null,
        querySelectorAll: () => [],
        addEventListener: (t, f) => listeners.push(t)
    };
    const calls = [];
    const sandbox = {
        document, window: { matchMedia: () => ({ matches: true }) },
        NAV: [], showTab: t => calls.push(['showTab', t]), buildDrawer: () => calls.push(['buildDrawer']),
        state: { company: null }
    };
    sandbox.window.NL = undefined;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/new-look.js'), 'utf8'), sandbox);
    return { NL: sandbox.window.NL, classes, calls, sandbox };
}

test('with the module off, the script changes nothing: no class, no menu change, no navigation', () => {
    const { NL, classes, calls, sandbox } = loadNewLook();
    assert.equal(NL.apply({ settings: {} }), false);
    assert.equal(NL.apply({ settings: { new_look: { enabled: false } } }), false);
    assert.equal(NL.apply(null), false);
    assert.equal(classes.has('nl'), false);
    assert.deepEqual(calls, []);
    assert.deepEqual(sandbox.NAV, []);
});

test('with the module on, Today is added once and opened', () => {
    const { NL, classes, calls, sandbox } = loadNewLook();
    const company = { settings: { new_look: { enabled: true } } };
    assert.equal(NL.apply(company), true);
    NL.apply(company);
    assert.ok(classes.has('nl'));
    assert.equal(sandbox.NAV.filter(g => g.items.some(i => i.tab === 'today')).length, 1);
    assert.ok(calls.some(c => c[0] === 'showTab' && c[1] === 'today'));
});

test('the store page loads the new look and opens it only through the module check', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/store.html'), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\/new-look.css">/);
    assert.match(html, /<script src="\/new-look.js"><\/script>/);
    assert.match(html, /if \(window.NL\) window.NL.apply\(state.company\);/);
    const css = fs.readFileSync(path.join(__dirname, '../public/new-look.css'), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(r => r && !r.startsWith('@import'));
    for (const r of rules) {
        const sel = r.split('{')[0].trim();
        if (!sel || sel.startsWith('@media') || sel.startsWith('@font-face')) continue;
        for (const part of sel.split(',')) assert.match(part.trim(), /^body\.nl\b/, `unscoped rule: ${part.trim()}`);
    }
});

test('the admin console loads its new look, and every rule is scoped so classic is untouched', () => {
    const html = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\/admin-look.css">/);
    assert.match(html, /<script src="\/admin-look.js"><\/script>/);
    const css = fs.readFileSync(path.join(__dirname, '../public/admin-look.css'), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(r => r && !r.startsWith('@import'));
    for (const r of rules) {
        const sel = r.split('{')[0].trim();
        if (!sel || sel.startsWith('@media')) continue;
        for (const part of sel.split(',')) assert.match(part.trim(), /^body\.nla\b/, `unscoped rule: ${part.trim()}`);
    }
    const js = fs.readFileSync(path.join(__dirname, '../public/admin-look.js'), 'utf8');
    assert.ok(!/fetch\(|XMLHttpRequest/.test(js), 'the look makes no requests');
});

test('every page but the kiosk carries the support footer, and it opens an email', () => {
    for (const p of ['public/store.html', 'admin/index.html', 'public/index.html', 'public/set-password.html']) {
        assert.match(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'), /<script src="\/support-footer.js"><\/script>/, p);
    }
    assert.ok(!/support-footer/.test(fs.readFileSync(path.join(__dirname, '../public/kiosk.html'), 'utf8')), 'the kiosk stays locked to scanning');
    const js = fs.readFileSync(path.join(__dirname, '../public/support-footer.js'), 'utf8');
    assert.match(js, /mailto:\$\{EMAIL\}/);
    assert.match(js, /RefinishAI 2026 · Support: Adam Berube/);
    assert.match(js, /adam@chcpaint\.com/);
});

test('Today counts cart items the same way as the cart icon and the menu badge (total quantity)', () => {
    const { NL } = loadNewLook();
    const cart = [{ quantity: 2 }, { quantity: 1 }, { quantity: 4 }, { quantity: 1 }, { quantity: 1 }, { quantity: 1 }, { quantity: 1 }];
    assert.equal(NL.cartItemCount(cart), 11);   // 7 products, 11 items: the number shown is 11 everywhere
    assert.equal(NL.cartItemCount([]), 0);
    assert.equal(NL.cartItemCount(null), 0);
    assert.equal(NL.cartItemCount([{ quantity: '3' }, { quantity: null }]), 3);
    const store = fs.readFileSync(path.join(__dirname, '../public/store.html'), 'utf8');
    assert.match(store, /const count = state\.cart\.reduce\(\(sum, c\) => sum \+ \(Number\(c\.quantity\) \|\| 0\), 0\);/);
    const js = fs.readFileSync(path.join(__dirname, '../public/new-look.js'), 'utf8');
    assert.doesNotMatch(js, /'line', 'lines'/, 'the cart card never counts lines');
});

test('the shop name is shown once when it matches the company name', () => {
    const { NL } = loadNewLook();
    assert.equal(NL.shopLabel('Concord Collision Center', 'Concord Collision Center'), '');
    assert.equal(NL.shopLabel('Concord Collision Center', ' concord  collision center '), '');
    assert.equal(NL.shopLabel('York Mills Group', 'North7'), 'North7');
    assert.equal(NL.shopLabel('Acme', ''), '');
    const store = fs.readFileSync(path.join(__dirname, '../public/store.html'), 'utf8');
    assert.match(store, /textContent = sameName \? '' : loc;/);
});

test('the Today headline counts what needs attention and names each one', () => {
    const { NL } = loadNewLook();
    assert.deepEqual({ ...NL.todayHeadline([]) }, { title: "You're all caught up", sub: 'Nothing needs your attention right now.' });
    const one = NL.todayHeadline([{ label: 'Send your cart (11 items)' }]);
    assert.equal(one.title, '1 thing needs your attention');
    assert.equal(one.sub, 'Send your cart (11 items)');
    const two = NL.todayHeadline([{ label: 'Approve 2 reorders' }, { label: 'Send your cart (11 items)' }]);
    assert.equal(two.title, '2 things need your attention');
    assert.equal(two.sub, 'Approve 2 reorders · Send your cart (11 items)');
    const js = fs.readFileSync(path.join(__dirname, '../public/new-look.js'), 'utf8');
    assert.doesNotMatch(js, /needs you today|No orders waiting at CHC|With CHC now|straight to CHC/);
});
