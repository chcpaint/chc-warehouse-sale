/**
 * tests/field-outlines.test.js
 *
 * Every screen shares one stylesheet that darkens the pale default outline on
 * text boxes, drop-downs and text areas. This keeps it from being dropped from a
 * page, and keeps it from overriding state colours or non-text controls.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the storefront, admin and landing pages load the shared field-outline stylesheet', () => {
    for (const page of ['public/store.html', 'admin/index.html', 'public/index.html']) {
        assert.match(read(page), /<link rel="stylesheet" href="\/field-outlines\.css">/, page);
    }
});

test('the stylesheet is served from the public folder', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'public/field-outlines.css')));
});

test('the outline is dark enough: at least 3:1 against white (WCAG 1.4.11)', () => {
    const css = read('public/field-outlines.css');
    const hex = css.match(/border-color:\s*(#[0-9a-f]{6})/i)[1];
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    assert.ok(1.05 / (L + 0.05) >= 3, `${hex} is too pale`);
});

test('tick boxes, radios and buttons are left alone, and no !important overrides state colours', () => {
    const css = read('public/field-outlines.css');
    for (const t of ['checkbox', 'radio', 'button', 'submit', 'file', 'range']) {
        assert.ok(css.includes(`[type="${t}"]`), `${t} should be excluded`);
    }
    assert.ok(!/!important/.test(css), 'must not use !important');
});

test('the set-password page uses the darker outline too', () => {
    assert.match(read('public/set-password.html'), /border: 1px solid #6b7280/);
});
