/**
 * tests/inventory.test.js
 *
 * Unit tests for the inventory module's pure logic. Uses the Node built-in test
 * runner, so there is no new dependency to add to package.json.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inv = require('../utils/inventory');

// ============================================================
// BARCODES
// ============================================================

test('cleanBarcode strips scanner and spreadsheet noise', () => {
    assert.equal(inv.cleanBarcode('  051131020474 '), '051131020474');
    assert.equal(inv.cleanBarcode('051131020474.0'), '051131020474');   // Excel numeric coercion
    assert.equal(inv.cleanBarcode('051-131-020474'), '051131020474');
    assert.equal(inv.cleanBarcode(' 051131020474 '), '051131020474'); // non-breaking space
    assert.equal(inv.cleanBarcode(null), '');
    assert.equal(inv.cleanBarcode(undefined), '');
    assert.equal(inv.cleanBarcode(51131020474), '51131020474');
});

test('gs1 check digit matches known-good UPCs from the CHC master file', () => {
    // 051131020474 is a real 3M/PPG UPC-A out of the master file.
    assert.ok(inv.isValidGs1('051131020474'));
    assert.equal(inv.gs1CheckDigit('05113102047'), 4);
    // Flip a digit and it must fail.
    assert.ok(!inv.isValidGs1('051131020475'));
});

test('isValidGs1 rejects wrong lengths and non-numerics', () => {
    assert.ok(!inv.isValidGs1('12345'));
    assert.ok(!inv.isValidGs1('ABC123456789'));
    assert.ok(!inv.isValidGs1(''));
});

test('barcodeVariants matches a UPC-A scan against its EAN-13 record', () => {
    const variants = inv.barcodeVariants('051131020474');
    assert.ok(variants.includes('051131020474'));       // as scanned (UPC-A)
    assert.ok(variants.includes('0051131020474'));      // as EAN-13 in the catalogue
    assert.ok(variants.includes('51131020474'));        // zero-stripped
    assert.ok(variants.includes('00051131020474'));     // GTIN-14 from a supplier file
});

test('barcodeVariants handles internal alphanumeric labels', () => {
    const variants = inv.barcodeVariants('chc-2pcpsl');
    // The hyphen is a real Code-39 character, so it survives; only the case is folded.
    assert.ok(variants.includes('CHC-2PCPSL'));
});

test('canonicalBarcode collapses UPC-A and EAN-13 to one row', () => {
    assert.equal(inv.canonicalBarcode('051131020474'), inv.canonicalBarcode('0051131020474'));
    assert.equal(inv.canonicalBarcode('051131020474'), '0051131020474');
    assert.equal(inv.canonicalBarcode('051-131-020474'), '0051131020474');
    // Alphanumeric labels keep their separators — CHC-PAINT-001 is not CHCPAINT001.
    assert.equal(inv.canonicalBarcode('abc-123'), 'ABC-123');
});

test('detectSymbology labels the formats the scanners emit', () => {
    assert.equal(inv.detectSymbology('051131020474'), 'upc_a');
    assert.equal(inv.detectSymbology('0051131020474'), 'ean_13');
    assert.equal(inv.detectSymbology('12345670'), 'ean_8');
    assert.equal(inv.detectSymbology('CHC-PAINT-001'), 'code_39');
});

// ============================================================
// MASTER FILE PARSING — the real CHC "Skyline 9" header set
// ============================================================

const CHC_ROW = {
    'Item Number (Part #)': '2PCPSL',
    'Item Name': 'Two piece Paint Suit Large',
    'Product Category': 'Masks/Suits',
    'Sub-Category': 'PPG Sundries',
    'Brand': 'PPG',
    'Vendor Item Number': '',
    'MSRP (Selling Price)': '$84.48',
    'UPC': '051131020474',
    'Case Qty': '20',
    'Notes': ''
};

test('normalizeMasterRow reads every field of the real CHC master file', () => {
    const r = inv.normalizeMasterRow(CHC_ROW);
    assert.ok(r.ok, r.error);
    assert.equal(r.value.sku, '2PCPSL');
    assert.equal(r.value.name, 'Two piece Paint Suit Large');
    assert.equal(r.value.category, 'Masks/Suits');
    assert.equal(r.value.sub_category, 'PPG Sundries');
    assert.equal(r.value.brand, 'PPG');
    assert.equal(r.value.price, 84.48);
    assert.equal(r.value.case_qty, 20);
    assert.equal(r.value.barcode, '0051131020474');
    assert.equal(r.value.barcode_checksum_ok, true);
});

test('normalizeMasterRow survives the BOM on an Excel-exported CSV', () => {
    const withBom = { '﻿Item Number (Part #)': 'X1', 'Item Name': 'Widget', 'MSRP (Selling Price)': '$1.00' };
    const r = inv.normalizeMasterRow(withBom);
    assert.ok(r.ok, r.error);
    assert.equal(r.value.sku, 'X1');
});

test('normalizeMasterRow tolerates the sparse columns in the real file', () => {
    // 36% of rows have no UPC, 51% no case qty, 13% no category.
    const r = inv.normalizeMasterRow({
        'Item Number (Part #)': '920-121',
        'Item Name': 'Quart Can w/Lid / 56 per box',
        'Product Category': 'Colour',
        'Sub-Category': '',
        'Brand': 'PPG',
        'MSRP (Selling Price)': '$180.75',
        'UPC': '',
        'Case Qty': ''
    });
    assert.ok(r.ok, r.error);
    assert.equal(r.value.barcode, undefined);
    assert.equal(r.value.case_qty, null);
    assert.equal(r.value.sub_category, null);
    assert.equal(r.value.price, 180.75);
});

test('normalizeMasterRow defaults a missing brand rather than failing the row', () => {
    const r = inv.normalizeMasterRow({ 'Item Number (Part #)': 'Z9', 'Item Name': 'Mystery item', 'MSRP (Selling Price)': '5' });
    assert.ok(r.ok);
    assert.equal(r.value.brand, 'Uncategorized');
});

test('normalizeMasterRow reports bad rows instead of throwing', () => {
    assert.equal(inv.normalizeMasterRow({ 'Item Name': 'No part number' }).ok, false);
    assert.equal(inv.normalizeMasterRow({ 'Item Number (Part #)': 'A1' }).ok, false);
    assert.equal(inv.normalizeMasterRow({}).ok, false);
});

test('normalizeMasterRow flags a bad UPC without rejecting the row', () => {
    const r = inv.normalizeMasterRow({ ...CHC_ROW, UPC: '051131020475' });
    assert.ok(r.ok);
    assert.equal(r.value.barcode_checksum_ok, false);
});

test('normalizeMasterRow reads optional per-location seeding columns', () => {
    const r = inv.normalizeMasterRow({
        'Item Number (Part #)': 'A1', 'Item Name': 'Thing', 'MSRP (Selling Price)': '10',
        'On Hand': '12', 'Min': '4', 'Max': '20', 'Bin': 'A-03'
    });
    assert.ok(r.ok, r.error);
    assert.equal(r.value.on_hand, 12);
    assert.equal(r.value.min_point, 4);
    assert.equal(r.value.max_point, 20);
    assert.equal(r.value.bin_location, 'A-03');
});

test('normalizeMasterRow rejects a max below the min', () => {
    const r = inv.normalizeMasterRow({
        'Item Number (Part #)': 'A1', 'Item Name': 'Thing', 'MSRP (Selling Price)': '10',
        'Min': '10', 'Max': '2'
    });
    assert.equal(r.ok, false);
});

test('parseMoney handles the formats a price column actually contains', () => {
    assert.equal(inv.parseMoney('$84.48'), 84.48);
    assert.equal(inv.parseMoney('1,234.50'), 1234.50);
    assert.equal(inv.parseMoney(84.48), 84.48);
    assert.equal(inv.parseMoney('84.48 CAD'), 84.48);
    assert.equal(inv.parseMoney(''), null);
    assert.equal(inv.parseMoney('n/a'), null);
    assert.equal(inv.parseMoney(null), null);
});

// ============================================================
// MOVEMENT ARITHMETIC
// ============================================================

test('consume writes a negative delta, receive a positive one', () => {
    assert.deepEqual(inv.movementDelta('consume', 3), { ok: true, delta: -3 });
    assert.deepEqual(inv.movementDelta('receive', 12), { ok: true, delta: 12 });
    assert.deepEqual(inv.movementDelta('transfer_out', 2), { ok: true, delta: -2 });
});

test('a cycle count posts the difference from current on-hand', () => {
    assert.deepEqual(inv.movementDelta('count', 8, 10), { ok: true, delta: -2 });
    assert.deepEqual(inv.movementDelta('count', 14, 10), { ok: true, delta: 4 });
    assert.deepEqual(inv.movementDelta('count', 0, 3), { ok: true, delta: -3 });
});

test('a count matching on-hand posts nothing', () => {
    assert.equal(inv.movementDelta('count', 10, 10).ok, false);
});

test('adjust accepts a signed quantity, but not zero', () => {
    assert.deepEqual(inv.movementDelta('adjust', -2), { ok: true, delta: -2 });
    assert.deepEqual(inv.movementDelta('adjust', 5), { ok: true, delta: 5 });
    assert.equal(inv.movementDelta('adjust', 0).ok, false);
});

test('movementDelta rejects junk input', () => {
    assert.equal(inv.movementDelta('consume', 0).ok, false);
    assert.equal(inv.movementDelta('consume', -1).ok, false);
    assert.equal(inv.movementDelta('consume', 'abc').ok, false);
    assert.equal(inv.movementDelta('consume', NaN).ok, false);
    assert.equal(inv.movementDelta('consume', Infinity).ok, false);
    assert.equal(inv.movementDelta('consume', 2e9).ok, false);
    assert.equal(inv.movementDelta('teleport', 1).ok, false);
    assert.equal(inv.movementDelta('count', -1, 5).ok, false);
});

test('fractional units do not drift', () => {
    assert.equal(inv.movementDelta('consume', 0.1).delta, -0.1);
    assert.equal(inv.movementDelta('count', 0.3, 0.1).delta, 0.2);
});

// ============================================================
// REPLENISHMENT
// ============================================================

test('nothing is ordered while stock is above the minimum', () => {
    assert.equal(inv.replenishmentFor({ on_hand: 10, min_point: 4, max_point: 20 }).trigger, false);
});

test('hitting the minimum orders up to the max', () => {
    const r = inv.replenishmentFor({ on_hand: 4, min_point: 4, max_point: 20 });
    assert.equal(r.trigger, true);
    assert.equal(r.qty, 16);
});

test('below the minimum orders up to the max', () => {
    assert.equal(inv.replenishmentFor({ on_hand: 1, min_point: 4, max_point: 20 }).qty, 19);
});

test('a negative on-hand still orders back to the max', () => {
    assert.equal(inv.replenishmentFor({ on_hand: -2, min_point: 4, max_point: 20 }).qty, 22);
});

test('with no max, the fixed reorder quantity is used', () => {
    const r = inv.replenishmentFor({ on_hand: 2, min_point: 5, reorder_qty: 12 });
    assert.equal(r.qty, 12);
});

test('with neither max nor reorder qty, top up to the minimum', () => {
    assert.equal(inv.replenishmentFor({ on_hand: 2, min_point: 5 }).qty, 3);
    // At exactly the minimum there is nothing to top up, so order one.
    assert.equal(inv.replenishmentFor({ on_hand: 5, min_point: 5 }).qty, 1);
});

test('order quantities are whole units', () => {
    assert.equal(inv.replenishmentFor({ on_hand: 1.5, min_point: 2, max_point: 5 }).qty, 4);
});

test('a level with no minimum never auto-orders', () => {
    assert.equal(inv.replenishmentFor({ on_hand: 0, max_point: 20 }).trigger, false);
    assert.equal(inv.replenishmentFor({ on_hand: 0, min_point: null }).trigger, false);
});

test('untracked levels never auto-order', () => {
    assert.equal(inv.replenishmentFor({ on_hand: 0, min_point: 5, max_point: 20, is_tracked: false }).trigger, false);
});

test('a max at or below on-hand falls through to the next rule', () => {
    // Misconfigured: min 5, max 3, on-hand 2. Max is above on-hand so it applies.
    assert.equal(inv.replenishmentFor({ on_hand: 2, min_point: 5, max_point: 3 }).qty, 1);
});

// ============================================================
// STATUS + SETTINGS
// ============================================================

test('stockStatus matches the inventory_status view', () => {
    assert.equal(inv.stockStatus({ on_hand: 0, min_point: 4 }), 'out');
    assert.equal(inv.stockStatus({ on_hand: -1, min_point: 4 }), 'out');
    assert.equal(inv.stockStatus({ on_hand: 4, min_point: 4 }), 'low');
    assert.equal(inv.stockStatus({ on_hand: 5, min_point: 4 }), 'ok');
    assert.equal(inv.stockStatus({ on_hand: 5 }), 'ok');
    assert.equal(inv.stockStatus({ on_hand: 0, is_tracked: false }), 'untracked');
});

test('inventorySettings defaults to off for companies that have not opted in', () => {
    assert.equal(inv.inventorySettings({}).enabled, false);
    assert.equal(inv.inventorySettings(null).enabled, false);
    assert.equal(inv.inventorySettings(undefined).enabled, false);
    assert.deepEqual(inv.inventorySettings({}).alert_emails, []);
});

test('inventorySettings merges a partial saved block over the defaults', () => {
    const s = inv.inventorySettings({ inventory: { enabled: true, alert_emails: ['a@b.com'] } });
    assert.equal(s.enabled, true);
    assert.equal(s.require_approval, true);      // default preserved
    assert.deepEqual(s.alert_emails, ['a@b.com']);
});

test('inventorySettings ignores a malformed alert_emails value', () => {
    assert.deepEqual(inv.inventorySettings({ inventory: { alert_emails: 'nope' } }).alert_emails, []);
});

// ============================================================
// GTIN RECOVERY — leading zeros eaten by Excel
// ============================================================

test('recoverGs1 restores a leading zero Excel dropped', () => {
    // 051131020474 stored as a number comes back as 51131020474.
    const r = inv.recoverGs1('51131020474');
    assert.equal(r.valid, true);
    assert.equal(r.recovered, true);
    assert.equal(r.code, '051131020474');
});

test('recoverGs1 leaves an already-valid code alone', () => {
    const r = inv.recoverGs1('051131020474');
    assert.equal(r.valid, true);
    assert.equal(r.recovered, false);
    assert.equal(r.code, '051131020474');
});

test('recoverGs1 gives up honestly on a genuinely bad code', () => {
    // 123456789012 is a structurally valid GTIN-12, so use one that is not:
    const r = inv.recoverGs1('123456789013');
    assert.equal(r.valid, false);
    assert.equal(r.recovered, false);
});

test('recoverGs1 ignores non-numeric codes', () => {
    assert.equal(inv.recoverGs1('CHC-PAINT-001').valid, false);
});

test('normalizeMasterRow recovers a UPC whose leading zero was lost', () => {
    const r = inv.normalizeMasterRow({
        'Item Number (Part #)': 'MMM02074', 'Item Name': 'Masking tape',
        'MSRP (Selling Price)': '$9.99', 'UPC': '51131020474'
    });
    assert.ok(r.ok, r.error);
    assert.equal(r.value.barcode_recovered, true);
    assert.equal(r.value.barcode_checksum_ok, true);
    assert.equal(r.value.barcode, '0051131020474');
});

test('an uncorrectable code is imported but flagged, not dropped', () => {
    // ACM708-05 in the real CHC master file carries 06383758783, which fails its
    // check digit at every padding. The row must still import.
    const r = inv.normalizeMasterRow({
        'Item Number (Part #)': 'ACM708-05', 'Item Name': 'Acme thing',
        'MSRP (Selling Price)': '$9.99', 'UPC': '06383758783'
    });
    assert.ok(r.ok, r.error);
    assert.equal(r.value.barcode_checksum_ok, false);
    assert.equal(r.value.barcode_recovered, false);
    assert.equal(r.value.barcode, '0006383758783');   // still stored and scannable
});

test('symbology describes the stored code, not the raw spreadsheet cell', () => {
    // ACM708-05 carries an 11-digit code that no padding rescues. It is stored
    // as a 13-digit EAN, so that is what the symbology must say.
    const r = inv.normalizeMasterRow({
        'Item Number (Part #)': 'ACM708-05', 'Item Name': 'Rubber dressing',
        'MSRP (Selling Price)': '$225.00', 'UPC': '06383758783'
    });
    assert.equal(r.value.barcode, '0006383758783');
    assert.equal(r.value.barcode_symbology, 'ean_13');

    // And a clean 12-digit UPC-A is stored as EAN-13 too, so it reports ean_13.
    const upc = inv.normalizeMasterRow({ ...CHC_ROW });
    assert.equal(upc.value.barcode, '0051131020474');
    assert.equal(upc.value.barcode_symbology, 'ean_13');
});
