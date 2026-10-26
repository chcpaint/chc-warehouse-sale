/**
 * tests/price-sheet.test.js
 *
 * Vendor price sheets as they really arrive: a company block above the column
 * headings, prices typed as "$3.69", a tab called "Sheet1". Every one of these
 * used to fail the whole upload with "invalid price".
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const ps = require('../utils/price-sheet');

function workbook(sheets) {
    const wb = XLSX.utils.book_new();
    for (const [name, grid] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), name);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const TITLE_BLOCK = [
    [null],
    ['CHC Wholesale Inc.'], ['1200 Speers Road, Unit 15'], ['Oakville, Ontario'], ['L6L 2X4'], ['PH# 289-837-0123'],
    ['Items List [Summary]'], [''], [''],
];

test('parsePrice reads dollars, commas, spaces and accounting negatives, and never guesses', () => {
    assert.equal(ps.parsePrice('$3.69'), 3.69);
    assert.equal(ps.parsePrice(' $1,234.50 '), 1234.5);
    assert.equal(ps.parsePrice('CAD 12'), 12);
    assert.equal(ps.parsePrice(7.25), 7.25);
    assert.equal(ps.parsePrice('(12.50)'), -12.5);
    for (const bad of ['N/A', 'call', '', null, undefined, '$', '12abc', NaN]) {
        assert.ok(Number.isNaN(ps.parsePrice(bad)), `${String(bad)} must not become a number`);
    }
});

test('the header row is found below a company and title block', () => {
    const grid = [...TITLE_BLOCK, ['', 'Item #', 'Item Name', 'Current Price', 'Item Description'], ['', 'MMM1', 'Tape', '$3.69', '']];
    assert.equal(ps.findHeaderRow(grid), TITLE_BLOCK.length);
});

test('a plain table with headers on row 1 behaves exactly as before', () => {
    const rows = ps.parseExcel(workbook({ 'Sheet1': [['SKU', 'Item Name', 'Price'], ['A1', 'Thing', 5]] }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].SKU, 'A1');
    assert.equal(ps.normalizeProductRow(rows[0]).price, 5);
});

test('a real vendor sheet: title block, $ prices, generic tab name', () => {
    const buf = workbook({
        Sheet1: [
            ...TITLE_BLOCK,
            ['', 'Item #', 'Item Name', 'Current Price', 'Item Description'],
            ['', 'MMM00344', '3M Yellow Spreader 3x4', '$3.69', ''],
            ['', 'MMM01160', '3M Short Strand Body Filler Ga', '$79.99', '3M Short Strand Body Filler Ga'],
            ['', '', '', '', ''],
            ['', 'MMM02071', '3M Particulate Filter P95', '$1,015.99', 'Filters']
        ]
    });
    const rows = ps.parseExcel(buf);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].__row, 11, 'errors must quote the line number the person sees in Excel');
    const n = rows.map(r => ps.normalizeProductRow(r, { vendor: '3M' }));
    assert.deepEqual(n.map(x => x.price), [3.69, 79.99, 1015.99]);
    assert.deepEqual(n.map(x => x.sku), ['MMM00344', 'MMM01160', 'MMM02071']);
    assert.ok(n.every(x => x.brand === '3M'), 'the vendor typed into the upload is the brand');
    assert.equal(n[1].description, undefined, 'a description that just repeats the name is dropped');
    assert.equal(n[2].description, 'Filters');
});

test('"Sheet1" is never used as a brand, a real tab name still is', () => {
    const generic = ps.parseExcel(workbook({ Sheet1: [['SKU', 'Name', 'Price'], ['A', 'X', 1]] }));
    assert.equal(ps.normalizeProductRow(generic[0]).brand, 'Uncategorized');
    const named = ps.parseExcel(workbook({ '3M': [['SKU', 'Name', 'Price'], ['A', 'X', 1]] }));
    assert.equal(ps.normalizeProductRow(named[0]).brand, '3M');
});

test("the sheet's own Brand column beats the vendor field", () => {
    const rows = ps.parseExcel(workbook({ Sheet1: [['SKU', 'Name', 'Brand', 'Price'], ['A', 'X', 'Norton', 1], ['B', 'Y', '', 2]] }));
    assert.equal(ps.normalizeProductRow(rows[0], { vendor: '3M' }).brand, 'Norton');
    assert.equal(ps.normalizeProductRow(rows[1], { vendor: '3M' }).brand, '3M');
});

test('a bad price says which text it could not read, and a missing one says so', () => {
    assert.throws(() => ps.normalizeProductRow({ SKU: 'A', Name: 'X', Price: 'call us' }), /"call us" is not a number/);
    assert.throws(() => ps.normalizeProductRow({ SKU: 'A', Name: 'X' }), /No price on this line/);
    assert.throws(() => ps.normalizeProductRow({ SKU: 'A', Price: 3 }), /Missing product name/);
});

test('a numeric SKU stays text and keeps its leading zeros', () => {
    const rows = ps.parseExcel(workbook({ Sheet1: [['SKU', 'Name', 'Price'], ['00344', 'X', 1]] }));
    assert.equal(ps.normalizeProductRow(rows[0]).sku, '00344');
});

test('a CSV with a title block above the headings is read the same way', async () => {
    const csv = 'CHC Wholesale Inc.\n"Oakville, Ontario"\nItems List\n\nItem #,Item Name,Current Price\nMMM1,Tape,"$1,003.50"\nMMM2,Filler,$79.99\n';
    const rows = await ps.parseCSV(Buffer.from('﻿' + csv));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].__row, 6);
    assert.equal(ps.normalizeProductRow(rows[0]).price, 1003.5);
});

test('totals and note rows with no product name are skipped, not reported as errors', () => {
    const rows = ps.parseExcel(workbook({ Sheet1: [['SKU', 'Name', 'Price'], ['A', 'X', 1], ['', '', 99], ['Total', '', 100]] }));
    assert.equal(rows.length, 1);
});
