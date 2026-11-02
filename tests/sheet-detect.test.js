/**
 * tests/sheet-detect.test.js
 *
 * Price lists as different suppliers really send them. The importer must work
 * out the columns by itself, realign rows that drifted, and never invent a price.
 *
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const ps = require('../utils/price-sheet');
const sd = require('../utils/sheet-detect');

const read = async (csv, opts) => {
    const rows = await ps.parseCSV(Buffer.isBuffer(csv) ? csv : Buffer.from(csv), opts);
    return { rows, meta: rows.meta, n: rows.map(r => { try { return ps.normalizeProductRow(r, { vendor: '3M' }); } catch (e) { return { error: e.message }; } }) };
};

test('different heading names for the same things', async () => {
    const { n, meta } = await read('Part Number,Desc.,Your Net,List Price,UOM\n05916,3M Masking Tape 3/4in,"$3.10",$4.50,EA\n02012,3M Body Filler Gallon,$19.99,$29.99,EA\n');
    assert.equal(meta.ok, true);
    assert.deepEqual(n.map(x => x.sku), ['05916', '02012'], 'leading zeros kept');
    assert.deepEqual(n.map(x => x.price), [3.1, 19.99], 'the net price is the price, list is the was-price');
    assert.deepEqual(n.map(x => x.previous_price), [4.5, 29.99]);
    assert.equal(n[0].name, '3M Masking Tape 3/4in');
    assert.equal(n[0].unit, 'EA');
});

test('semicolon separated with decimal commas', async () => {
    const { n, meta } = await read('Artikel;Bezeichnung;Preis\nA-100;Schleifpapier P80;3,69\nA-200;Spachtel gross;12,50\nA-300;Klebeband;1.234,50\n');
    assert.equal(meta.delimiter, ';');
    assert.deepEqual(n.map(x => x.price), [3.69, 12.5, 1234.5]);
});

test('tab separated, headings under a title block, Windows-1252 text', async () => {
    const text = 'Assured Auto Body\nPrice file\n\nItem #\tItem Name\tPrice\nX1\tCaf\xe9 tape 3M\t$2.00\nX2\tFiller\t$5.00\n';
    const { n, meta } = await read(Buffer.from(text, 'latin1'));
    assert.equal(meta.delimiter, '\t');
    assert.equal(n[0].name, 'Café tape 3M');
    assert.deepEqual(n.map(x => x.price), [2, 5]);
});

test('unquoted commas in the description push cells right; the lines are realigned', async () => {
    const csv = [
        'Item #,Item Name,Price',
        'MMM001,3M Tape,3.69',
        'MMM002,3M Filler, Gallon, Short Strand,79.99',
        'MMM003,Sandpaper, Red, 80 grit, Box of 50,12.40',
        'MMM004,Spreader,1.99'
    ].join('\n');
    const { n, meta } = await read(csv);
    assert.equal(meta.repaired, 2);
    assert.deepEqual(n.map(x => x.price), [3.69, 79.99, 12.4, 1.99]);
    assert.equal(n[1].name, '3M Filler, Gallon, Short Strand');
    assert.equal(n[2].sku, 'MMM003');
});

test('a quote inside a field (3" tape) does not swallow the rest of the file', async () => {
    const csv = 'SKU,Name,Price\nA1,3" Masking Tape,2.50\nA2,"Quoted, name",3.50\nA3,Other,4.50\nA4,Last,5.50\n';
    const { n } = await read(csv);
    assert.equal(n.length, 4);
    assert.equal(n[0].name, '3" Masking Tape');
    assert.equal(n[1].name, 'Quoted, name');
});

test('an unclosed opening quote only ruins its own line', async () => {
    const lines = ['SKU,Name,Price'];
    for (let i = 1; i <= 30; i++) lines.push(i === 5 ? `A${i},"Broken name,9.99` : `A${i},Item ${i},${i}.50`);
    const { n } = await read(lines.join('\n'));
    assert.ok(n.filter(x => !x.error).length >= 29);
});

test('no headings at all: columns are found from what they hold', async () => {
    const { n, meta } = await read('MMM00344,3M Yellow Spreader 3x4,3.69\nMMM01160,3M Short Strand Body Filler Gallon,79.99\nMMM02071,3M Particulate Filter P95 Pair,15.99\n');
    assert.equal(meta.ok, true);
    assert.equal(meta.header_row, 0);
    assert.equal(meta.sources.price, 'content');
    assert.deepEqual(n.map(x => x.sku), ['MMM00344', 'MMM01160', 'MMM02071']);
    assert.deepEqual(n.map(x => x.price), [3.69, 79.99, 15.99]);
    assert.ok(meta.warnings.some(w => /No heading row/.test(w)));
});

test('headings offset from the data (an extra leading column) are matched up by content', async () => {
    const csv = 'Item #,Item Name,Price\n1,MMM001,3M Masking Tape Roll,3.69\n2,MMM002,3M Body Filler Gallon,79.99\n3,MMM003,3M Spreader Kit Large,1.99\n4,MMM004,3M Sanding Disc Box,22.10\n';
    const { n, meta } = await read(csv);
    assert.equal(meta.ok, true);
    assert.deepEqual(n.map(x => x.sku), ['MMM001', 'MMM002', 'MMM003', 'MMM004']);
    assert.deepEqual(n.map(x => x.price), [3.69, 79.99, 1.99, 22.1]);
});

test('a price column full of words is never used as the price', async () => {
    const { meta } = await read('SKU,Name,Price\nA1,Thing one,call\nA2,Thing two,call us\nA3,Thing three,ask\n');
    assert.equal(meta.ok, false);
    assert.deepEqual(meta.missing, ['price']);
    assert.ok(meta.columns.length >= 3 && meta.preview.length === 3, 'the columns come back so a person can choose');
});

test('quantities are not mistaken for the price, ids are not mistaken for money', async () => {
    const { n } = await read('Item #,Name,Qty,Price\nA1,Thing one,12,3.69\nA2,Thing two,24,4.99\nA3,Thing three,6,5.49\n');
    assert.deepEqual(n.map(x => x.price), [3.69, 4.99, 5.49]);
    const noHead = await read('1000234,Big thing for the shop,12.99\n1000235,Another big thing here,7.49\n1000236,Third big thing here,8.00\n');
    assert.equal(noHead.n[0].sku, '1000234');
    assert.equal(noHead.n[0].price, 12.99);
});

test('cost is only used as the price when nothing else is', async () => {
    const both = await read('SKU,Name,Cost,Price\nA1,Thing one,1.00,3.69\nA2,Thing two,2.00,4.99\n');
    assert.deepEqual(both.n.map(x => x.price), [3.69, 4.99]);
    const costOnly = await read('SKU,Name,Cost\nA1,Thing one,1.00\nA2,Thing two,2.00\n');
    assert.deepEqual(costOnly.n.map(x => x.price), [1, 2]);
});

test('a person can say which column is which, and where the headings are', async () => {
    const csv = 'Code,Label,Amt A,Amt B\nA1,Thing one,10.00,3.69\nA2,Thing two,20.00,4.99\n';
    const auto = await read(csv);
    const manual = await read(csv, { columnMap: { sku: 0, name: 1, price: 3, previous_price: 2 } });
    assert.deepEqual(manual.n.map(x => x.price), [3.69, 4.99]);
    assert.equal(manual.meta.sources.price, 'manual');
    assert.deepEqual(manual.n.map(x => x.previous_price), [10, 20]);
    assert.ok(auto.meta, 'auto detection still answers');
    const hr = await read('A1,Thing one,3.69\nA2,Thing two,4.99\n', { headerRow: 0 });
    assert.equal(hr.n.length, 2);
    const forced = await read('junk line\nSKU,Name,Price\nA1,Thing one,3.69\n', { headerRow: 2 });
    assert.equal(forced.n[0].price, 3.69);
    const none = await read(csv, { columnMap: { previous_price: null, price: 3 } });
    assert.equal(none.n[0].previous_price, undefined, 'null means "not in this file"');
});

test('a manual choice cannot be defeated by a look-alike heading', async () => {
    const r = await read('SKU,Name,Price,Cost\nA1,Thing,9.99,1.00\nA2,Thing 2,8.99,2.00\n', { columnMap: { price: 3 } });
    assert.deepEqual(r.n.map(x => x.price), [1, 2]);
});

test('Excel: numeric part numbers keep their leading zeros and a different layout is read', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Distributor price list'], [], ['Part #', 'Description', 'Dealer Price'], [5916, 'Masking Tape Roll 3/4', 3.1], [2012, 'Body Filler Gallon', 19.99]]);
    ws.A4.z = '00000'; ws.A5.z = '00000';
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '3M');
    const rows = ps.parseExcel(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const n = rows.map(r => ps.normalizeProductRow(r));
    assert.deepEqual(n.map(x => x.sku), ['05916', '02012']);
    assert.deepEqual(n.map(x => x.price), [3.1, 19.99]);
    assert.equal(n[0].brand, '3M');
    assert.equal(rows.meta.header_row, 3);
});

test('Excel with several tabs: each is read on its own terms', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['SKU', 'Name', 'Price'], ['A', 'Alpha thing', 1]]), '3M');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Part Number', 'Product', 'Cost'], ['B', 'Beta thing', 2]]), 'Norton');
    const rows = ps.parseExcel(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const n = rows.map(r => ps.normalizeProductRow(r));
    assert.deepEqual(n.map(x => [x.sku, x.price, x.brand]), [['A', 1, '3M'], ['B', 2, 'Norton']]);
});

test('the earlier AccountEdge-style export still reads exactly as before', async () => {
    const csv = 'CHC Wholesale Inc.\n"Oakville, Ontario"\nItems List\n\nItem #,Item Name,Current Price,Item Description\nMMM1,Tape,"$1,003.50",\nMMM2,Filler,$79.99,Filler\n';
    const { n, rows } = await read(csv);
    assert.equal(rows[0].__row, 6);
    assert.deepEqual(n.map(x => x.price), [1003.5, 79.99]);
    assert.equal(n[1].description, undefined);
});

test('empty and junk files do not crash', async () => {
    for (const body of ['', '\n\n', 'just one line', ',,,\n,,,\n']) {
        const rows = await ps.parseCSV(Buffer.from(body));
        assert.equal(rows.length, 0);
        assert.equal(rows.meta.ok, false);
    }
});

test('UTF-16 files (Excel "Unicode Text") are decoded', async () => {
    const text = 'SKU\tName\tPrice\nA1\tThing one\t3.69\nA2\tThing two\t4.99\n';
    const buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
    const { n } = await read(buf);
    assert.deepEqual(n.map(x => x.price), [3.69, 4.99]);
});

test('sd.parsePrice agrees with the importer', () => {
    assert.equal(sd.parsePrice('$1,234.50'), 1234.5);
    assert.ok(Number.isNaN(sd.parsePrice('N/A')));
});

test('every description has a comma: the whole file is wider than its heading and is still realigned', async () => {
    const csv = 'Item Number,Description,List Price,Net Price\n05916,Tape, masking, 3/4,4.50,3.10\n02012,Filler, gallon,29.99,19.99\n06000,Disc, 6in, 80 grit,9.99,6.50\n';
    const { n, meta } = await read(csv);
    assert.equal(meta.repaired, 3);
    assert.deepEqual(n.map(x => x.sku), ['05916', '02012', '06000']);
    assert.deepEqual(n.map(x => x.price), [3.1, 19.99, 6.5]);
    assert.deepEqual(n.map(x => x.previous_price), [4.5, 29.99, 9.99]);
    assert.equal(n[2].name, 'Disc, 6in, 80 grit');
});

test('discount percentages and quantities are not taken for prices', async () => {
    const { n } = await read('Part No,Description,Qty,List,Discount %,Net\nA1,Thing one,1,10.00,20%,8.00\nA2,Thing two,1,20.00,10%,18.00\n');
    assert.deepEqual(n.map(x => [x.price, x.previous_price]), [[8, 10], [18, 20]]);
});

test('the real 3M "new items" export (no headings, every price $0.00) is read: 64 parts, no prices', async () => {
    const buf = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', '3M_New_Items_Import.csv'));
    const rows = await ps.parseCSV(buf);
    assert.equal(rows.length, 64);
    assert.equal(rows.meta.no_price, true);
    assert.equal(rows.meta.mapping.sku, 0);
    assert.equal(rows.meta.mapping.name, 1);
    assert.equal(rows.meta.mapping.price, undefined, 'a column of $0.00 is not a price column');
    const n = rows.map(r => ps.normalizeProductRow(r, { vendor: '3M', allowNoPrice: true }));
    assert.equal(n[0].sku, 'MMM02604');
    assert.equal(n[0].name, '3M Softback Sanding Sponge Fine');
    assert.equal(n[63].sku, 'MMMPBC005');
    assert.ok(n.every(x => x.price === 0 && x.brand === '3M'));
});
