/**
 * tests/price-note.test.js
 *
 * An item can carry a short note under its price (metadata.price_note), for example
 * "Price is shown as list less 45%". The note is CHC-set text, shown as text only,
 * and never on a Call-for-price item (there is no price for it to explain).
 *
 * The storefront is one HTML file, so the function is lifted out of it and run
 * here rather than re-implemented, so the test cannot drift from the real code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'store.html'), 'utf8');
const m = html.match(/function priceNoteHtml\(p\) \{[\s\S]*?\n    \}\n/);
assert.ok(m, 'priceNoteHtml must exist in store.html');
const ctx = { escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
vm.createContext(ctx);
vm.runInContext(m[0], ctx);
const note = p => ctx.priceNoteHtml(p);

test('a priced item with a note shows it', () => {
    const out = note({ price: 55, metadata: { price_note: 'Price is shown as list less 45%' } });
    assert.match(out, /Price is shown as list less 45%/);
    assert.match(out, /data-price-note/);
});

test('no note, no metadata, or a blank note shows nothing', () => {
    assert.equal(note({ price: 5 }), '');
    assert.equal(note({ price: 5, metadata: {} }), '');
    assert.equal(note({ price: 5, metadata: { price_note: '   ' } }), '');
    assert.equal(note({ price: 5, metadata: { price_note: 42 } }), '');
});

test('a Call-for-price item never shows the note', () => {
    assert.equal(note({ price: 0, price_on_request: true, metadata: { price_note: 'x' } }), '');
});

test('the note is escaped, never treated as markup', () => {
    const out = note({ price: 5, metadata: { price_note: '<img src=x onerror=alert(1)>' } });
    assert.ok(!out.includes('<img'), out);
    assert.match(out, /&lt;img/);
});
