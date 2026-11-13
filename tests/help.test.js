/**
 * tests/help.test.js -- the Help page, the help assistant and the published
 * AI statement.
 *
 * The assistant must stay non-AI (no network calls, nothing sent anywhere),
 * otherwise the "AI is used in two places" statement stops being true. When it
 * cannot answer it must offer info@chcpaint.com.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Load help-content.js and help-bot.js into a bare window and return its search. */
function loadSearch() {
    const listeners = [];
    const window = {};
    const document = {
        readyState: 'loading',
        addEventListener: (ev, fn) => listeners.push(fn),
        querySelector: () => null,
        getElementById: () => null,
        body: { dataset: {} }
    };
    const ctx = vm.createContext({ window, document, sessionStorage: { getItem: () => null, setItem() {} } });
    vm.runInContext(read('public/help-content.js'), ctx);
    vm.runInContext(read('public/help-bot.js'), ctx);
    return { search: window.RAI_HELP_SEARCH, help: window.RAI_HELP };
}

test('help content is complete: every area has questions with answers and keywords', () => {
    const { help } = loadSearch();
    const ids = help.areas.map(a => a.id);
    for (const id of ['start', 'ordering', 'inventory', 'kiosk', 'kits', 'reports', 'account', 'chc']) assert.ok(ids.includes(id), id);
    const qs = new Set();
    for (const a of help.areas) {
        assert.ok(['shop', 'chc'].includes(a.audience), a.id);
        for (const it of a.items) {
            assert.ok(it.q.endsWith('?'), it.q);
            assert.ok(it.a.length > 30, it.q);
            assert.ok(it.k && it.k.length > 3, it.q);
            assert.ok(!qs.has(it.q), `duplicate question: ${it.q}`);
            qs.add(it.q);
            assert.ok(!/<|>/.test(it.a + it.q), 'plain text only');
        }
    }
});

test('the assistant finds the right answer for everyday wording', () => {
    const { search } = loadSearch();
    const top = (q, aud = 'shop') => (search(q, aud).find(h => h.score >= 2 && h.cover >= 0.5) || {}).it?.q;
    assert.equal(top('how do i receive a delivery'), 'How do I receive a delivery?');
    assert.equal(top('the truck arrived'), 'How do I receive a delivery?');
    assert.equal(top('place an order'), 'How do I place an order?');
    assert.equal(top('forgot my password'), 'I forgot my password. How do I reset it?');
    assert.equal(top('print shelf labels'), 'How do I print shelf labels?');
    assert.equal(top('stocktake'), 'How do I count stock?');
    assert.equal(top('turn on insights for a customer', 'all'), 'How do I switch features on or off for a customer?');
});

test('shops never get CHC staff answers; CHC staff get both', () => {
    const { search, help } = loadSearch();
    const chcQs = new Set(help.areas.filter(a => a.audience === 'chc').flatMap(a => a.items.map(i => i.q)));
    assert.ok(search('add a new customer company', 'shop').every(h => !chcQs.has(h.it.q)));
    assert.ok(search('add a new customer company', 'all').some(h => chcQs.has(h.it.q)));
});

test('nonsense finds nothing good, so the assistant offers the email', () => {
    const { search } = loadSearch();
    const good = h => h.score >= 2 && h.cover >= 0.5;
    assert.ok(!search('xylophone weather tomorrow', 'shop').some(good));
    // a shop asking a CHC-only question gets the email, not a near-miss answer
    assert.ok(!search('how do I add a new customer', 'shop').some(good));
    assert.ok(search('how do I add a new customer', 'all').some(good));
    const bot = read('public/help-bot.js');
    assert.match(bot, /FALLBACK_EMAIL = 'info@chcpaint\.com'/);
    assert.match(bot, /mailto:\$\{FALLBACK_EMAIL\}/);
});

test('the assistant is not AI: it makes no network calls of any kind', () => {
    for (const f of ['public/help-bot.js', 'public/help-content.js']) {
        const src = read(f);
        assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\(/.test(src), `${f} must not call out`);
    }
    assert.match(read('public/help-bot.js'), /not AI/);
});

test('the assistant escapes what people type before showing it', () => {
    const bot = read('public/help-bot.js');
    assert.match(bot, /say\(esc\(q\), 'me'\)/);
    assert.match(bot, /\$\{esc\(best\.it\.a\)\}/);
});

test('menus link to the Help page, and the assistant is on store and admin but not the kiosk', () => {
    const store = read('public/store.html');
    const admin = read('admin/index.html');
    assert.match(store, /class="drawer-foot">\s*<a href="\/help"/);
    assert.match(admin, /<a href="\/help"[^>]*>\s*<i class="fas fa-circle-question mr-2"><\/i> Help, security &amp; AI/);
    for (const html of [store, admin, read('public/help.html')]) {
        assert.match(html, /<script src="\/help-content.js"><\/script>\s*<script src="\/help-bot.js"><\/script>/);
    }
    assert.ok(!/help-bot/.test(read('public/kiosk.html')), 'the kiosk stays locked to scanning');
});

test('server serves /help and the public AI list', () => {
    const server = read('server.js');
    assert.match(server, /app\.get\('\/help', \(req, res\) => \{\s*res\.sendFile\(path\.join\(__dirname, 'public', 'help\.html'\)\)/);
    assert.match(server, /app\.use\('\/api\/help', require\('\.\/routes\/help'\)\)/);
});

test('GET /api/help/ai lists exactly the AI register, without internal setting names', async () => {
    const { AI_FEATURES } = require('../utils/ai-usage');
    const app = express();
    app.use('/api/help', require('../routes/help'));
    const srv = app.listen(0);
    try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/help/ai`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.count, AI_FEATURES.length);
        assert.deepEqual(body.features.map(f => f.key), AI_FEATURES.map(f => f.key));
        const text = JSON.stringify(body);
        assert.ok(!/key_setting|ANTHROPIC_|API_KEY/.test(text), 'no internal setting names');
        for (const f of body.features) {
            assert.equal(f.can_change_data, false);
            assert.ok(f.sends && f.where && f.who && f.human_in_the_loop);
        }
    } finally {
        srv.close();
    }
});

test('the Help page covers security, AI use and the contact email', () => {
    const html = read('public/help.html');
    for (const id of ['how-to', 'security', 'ai', 'contact']) assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, /mailto:info@chcpaint\.com/);
    assert.match(html, /fetch\('\/api\/help\/ai'\)/);
    assert.match(html, /Being put in place/);
    assert.ok(!/<link[^>]+fonts\.googleapis/.test(html), 'fonts are self-hosted');
});

test('every question in the guide finds itself first', () => {
    const { search, help } = loadSearch();
    for (const a of help.areas) for (const it of a.items) {
        const best = search(it.q, 'all').find(h => h.score >= 2 && h.cover >= 0.5);
        assert.equal(best && best.it.q, it.q);
    }
});

test('scan issue terms: every reason the app shows is explained on the Help page and found by the assistant', () => {
    const { search, help } = loadSearch();
    const area = help.areas.find(a => a.id === 'scanissues');
    assert.ok(area && area.audience === 'shop');
    const { REASONS } = require('../utils/scan-exception-terms');
    for (const r of Object.values(REASONS)) {
        assert.ok(area.items.some(i => i.q === `What does "${r.label}" mean?`), r.label);
    }
    const top = (q, aud = 'shop') => (search(q, aud).find(h => h.score >= 2 && h.cover >= 0.5) || {}).it?.q;
    assert.equal(top('what does missing barcode mean'), 'What does "Missing barcode" mean?');
    assert.equal(top('not in catalog'), 'What does "Not in catalogue" mean?');
    assert.equal(top('misread barcode'), 'What does "Misread barcode" mean?');
    assert.equal(top('unknown code'), 'What does "Unknown code" mean?');
    assert.equal(top('item switched off'), 'What does "Item switched off" mean?');
    assert.equal(top('what is a scan issue'), 'What is a scan issue?');
    assert.equal(top('put a scan issue right', 'all'), 'How do I put a scan issue right?');
});
