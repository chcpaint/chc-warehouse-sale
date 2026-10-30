/**
 * utils/kit-submission-pdf.js
 *
 * The PDF for one Insurance Kit Submission: a numbered, itemized materials
 * document a body shop loads into Mitchell / CCC ONE / Audatex as backup for
 * the materials line on an estimate.
 *
 * Built with pdfkit (pure JavaScript, no browser or native library), so it runs
 * the same on Railway as on a laptop. Nothing here touches the database: the
 * caller passes in the frozen submission row, which is why a re-download years
 * later is identical to the first.
 *
 * The header logo belongs to the SUPPLIER the shop buys from -- CHC's logo for a
 * CHC customer, another distributor's own logo for a customer on that
 * distributor. The shop's name is printed as the submitter.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const CHC_LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'chc-logo.png');
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_TIMEOUT_MS = 4000;

const INK = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const ACCENT = '#1d4ed8';

/** pdfkit embeds PNG and JPEG only; anything else is refused up front. */
function isPngOrJpeg(buf) {
    if (!buf || buf.length < 4) return false;
    const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const jpg = buf[0] === 0xff && buf[1] === 0xd8;
    return png || jpg;
}

/**
 * The supplier's logo as a Buffer, or null (the header then prints the
 * supplier's name instead). Never throws: a missing or slow logo must not stop
 * a document being produced.
 *
 * Order: the distributor's own logo_url (https only), then, for the platform's
 * default distributor (CHC), the logo shipped with the app.
 */
async function loadSupplierLogo(distributor, { fetchImpl = globalThis.fetch } = {}) {
    try {
        const url = distributor && distributor.logo_url;
        if (url && /^https:\/\//i.test(url) && typeof fetchImpl === 'function') {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), LOGO_TIMEOUT_MS);
            try {
                const resp = await fetchImpl(url, { signal: ctrl.signal, redirect: 'error' });
                if (resp.ok) {
                    const declared = Number(resp.headers.get('content-length') || 0);
                    if (!declared || declared <= LOGO_MAX_BYTES) {
                        const buf = Buffer.from(await resp.arrayBuffer());
                        if (buf.length <= LOGO_MAX_BYTES && isPngOrJpeg(buf)) return buf;
                    }
                }
            } finally {
                clearTimeout(timer);
            }
        }
    } catch (_) { /* fall through to the shipped logo */ }

    const isChc = distributor && (distributor.is_default === true || distributor.slug === 'chc');
    if (isChc) {
        try {
            const buf = fs.readFileSync(CHC_LOGO_PATH);
            if (isPngOrJpeg(buf)) return buf;
        } catch (_) { /* name only */ }
    }
    return null;
}

const money = n => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = n => {
    const v = Number(n || 0);
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

/** "RO-1234" stays as typed; a bare "1234" reads "RO 1234". */
const roLabel = ro => (/^ro\b/i.test(String(ro || '').trim()) ? String(ro).trim() : `RO ${ro}`);

/** The one-line note an estimator can paste next to the attachment. */
function suggestedNote(submission) {
    return `Non-included materials — ${submission.kit_name} — itemized backup attached (Submission ${submission.submission_no}, ${roLabel(submission.ro_number)})`;
}

/**
 * @param {Object} args
 * @param {Object} args.submission   a kit_submissions row
 * @param {Object} args.company      { name }
 * @param {Object|null} args.location { name, city }
 * @param {Object|null} args.distributor { name, slug, is_default, contact_phone, contact_email }
 * @param {Buffer|null} args.logo
 * @returns {Promise<Buffer>}
 */
function buildKitSubmissionPdf({ submission, company, location, distributor, logo }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: { top: 48, bottom: 56, left: 48, right: 48 },
            bufferPages: true,
            info: {
                Title: `Materials itemization ${submission.submission_no}`,
                Author: company && company.name ? company.name : 'Shop',
                Subject: `Repair order ${submission.ro_number}`
            }
        });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const left = doc.page.margins.left;
        const right = doc.page.width - doc.page.margins.right;
        const width = right - left;
        const supplierName = (distributor && distributor.name) || 'Supplier';

        // ---------------- header ----------------
        let top = doc.page.margins.top;
        let logoDrawn = false;
        if (logo) {
            try {
                doc.image(logo, left, top, { fit: [170, 54] });
                logoDrawn = true;
            } catch (_) { /* unreadable image: use the name */ }
        }
        if (!logoDrawn) {
            doc.font('Helvetica-Bold').fontSize(15).fillColor(INK)
                .text(supplierName, left, top + 8, { width: 250 });
        }

        doc.font('Helvetica-Bold').fontSize(17).fillColor(INK)
            .text('Materials itemization', left, top, { width, align: 'right' });
        doc.font('Helvetica').fontSize(9).fillColor(MUTED)
            .text('Backup for the materials / kit line on the estimate or invoice', left, top + 22, { width, align: 'right' });
        doc.font('Helvetica-Bold').fontSize(12).fillColor(ACCENT)
            .text(`Submission ${submission.submission_no}`, left, top + 38, { width, align: 'right' });

        top += 66;
        doc.moveTo(left, top).lineTo(right, top).lineWidth(1.5).strokeColor(INK).stroke();
        top += 12;

        // ---------------- details ----------------
        const created = submission.created_at ? new Date(submission.created_at) : new Date();
        const dateText = created.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Toronto' });
        const shopLine = location && location.name && location.name !== company.name
            ? `${company.name} — ${location.name}` : company.name;

        const fields = [
            ['Repair order', submission.ro_number],
            ['Claim number', submission.claim_no || '—'],
            ['Insurer', submission.insurer || '—'],
            ['Date', dateText],
            ['Vehicle', submission.vehicle || '—'],
            ['VIN', submission.vin || '—'],
            ['Kit', `${submission.kit_name}${Number(submission.multiplier) !== 1 ? `  ×${qtyText(submission.multiplier)}` : ''}`],
            ['Submitted by', shopLine]
        ];
        const colW = width / 2;
        doc.fontSize(8).fillColor(MUTED);
        for (let i = 0; i < fields.length; i += 2) {
            const rowTop = top;
            for (let c = 0; c < 2; c++) {
                const f = fields[i + c];
                if (!f) continue;
                const x = left + c * colW;
                doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
                    .text(f[0].toUpperCase(), x, rowTop, { width: colW - 12, characterSpacing: 0.4 });
                doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
                    .text(String(f[1]), x, rowTop + 10, { width: colW - 12, ellipsis: true, height: 14, lineBreak: false });
            }
            top = rowTop + 32;
        }

        // ---------------- table ----------------
        const cols = [
            { key: 'brand',      label: 'Brand',       w: 66,  align: 'left' },
            { key: 'sku',        label: 'Part number', w: 88,  align: 'left' },
            { key: 'name',       label: 'Description', w: 0,   align: 'left' },
            { key: 'qty',        label: 'Qty',         w: 52,  align: 'right' },
            { key: 'unit_price', label: 'Unit price',  w: 62,  align: 'right' },
            { key: 'line_cost',  label: 'Extended',    w: 66,  align: 'right' }
        ];
        const fixed = cols.reduce((s, c) => s + c.w, 0);
        cols.find(c => c.key === 'name').w = width - fixed;
        let x = left;
        for (const c of cols) { c.x = x; x += c.w; }
        const pad = 4;

        const drawTableHead = y => {
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
            for (const c of cols) {
                doc.text(c.label.toUpperCase(), c.x + pad, y, { width: c.w - pad * 2, align: c.align, characterSpacing: 0.3, lineBreak: false });
            }
            doc.moveTo(left, y + 12).lineTo(right, y + 12).lineWidth(1).strokeColor(INK).stroke();
            return y + 18;
        };

        const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 24;
        let y = drawTableHead(top + 4);
        const lines = Array.isArray(submission.lines_snapshot) ? submission.lines_snapshot : [];

        for (const l of lines) {
            const cells = {
                brand: l.brand || '—',
                sku: l.sku || l.kit_sku || '—',
                name: l.name || '',
                qty: `${qtyText(l.quantity)} ${l.unit || 'each'}`,
                unit_price: money(l.unit_price),
                line_cost: money(l.line_cost)
            };
            doc.font('Helvetica').fontSize(9);
            const nameCol = cols.find(c => c.key === 'name');
            const rowH = Math.max(
                14,
                doc.heightOfString(cells.name, { width: nameCol.w - pad * 2 }) + 6,
                doc.heightOfString(cells.sku, { width: cols[1].w - pad * 2 }) + 6,
                doc.heightOfString(cells.brand, { width: cols[0].w - pad * 2 }) + 6
            );
            if (y + rowH > bottomLimit()) {
                doc.addPage();
                y = drawTableHead(doc.page.margins.top);
            }
            doc.font('Helvetica').fontSize(9).fillColor(INK);
            for (const c of cols) {
                const face = c.key === 'sku' ? 'Courier' : (c.key === 'line_cost' ? 'Helvetica-Bold' : 'Helvetica');
                doc.font(face).fontSize(c.key === 'sku' ? 8.5 : 9)
                    .text(cells[c.key], c.x + pad, y + 2, { width: c.w - pad * 2, align: c.align });
            }
            y += rowH;
            doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
        }

        // ---------------- total ----------------
        if (y + 40 > bottomLimit()) { doc.addPage(); y = doc.page.margins.top; }
        y += 8;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(INK).stroke();
        doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
            .text(`Total (${lines.length} line item${lines.length === 1 ? '' : 's'})`, left + pad, y + 8, { width: width - 140, lineBreak: false });
        doc.text(money(submission.total_amount), right - 120, y + 8, { width: 120 - pad, align: 'right', lineBreak: false });
        y += 34;

        // ---------------- estimate note + statement ----------------
        const note = suggestedNote(submission);
        doc.font('Helvetica').fontSize(8.5);
        const noteH = doc.heightOfString(note, { width: width - 24 }) + 28;
        const stmt = `This is an itemized breakdown of the materials applied to repair order ${String(submission.ro_number).replace(/^ro[\s-]+/i, '')} under the "${submission.kit_name}" kit, provided as backup documentation for the corresponding materials line on the shop's estimate or invoice. Prices are those charged to the shop for this submission and do not change if a part, brand or price is later updated.`;
        const stmtH = doc.heightOfString(stmt, { width }) + 8;
        const notesText = submission.notes ? String(submission.notes) : '';
        const notesH = notesText ? doc.heightOfString(notesText, { width }) + 22 : 0;

        if (y + noteH + stmtH + notesH > bottomLimit()) { doc.addPage(); y = doc.page.margins.top; }

        doc.roundedRect(left, y, width, noteH, 4).fillAndStroke('#eff6ff', '#bfdbfe');
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(ACCENT)
            .text('PASTE INTO THE ESTIMATE’S ATTACHMENT NOTE', left + 12, y + 8, { characterSpacing: 0.4, lineBreak: false });
        doc.font('Courier').fontSize(8.5).fillColor(INK)
            .text(note, left + 12, y + 20, { width: width - 24 });
        y += noteH + 10;

        if (notesText) {
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('SHOP NOTES', left, y, { characterSpacing: 0.4, lineBreak: false });
            doc.font('Helvetica').fontSize(9).fillColor(INK).text(notesText, left, y + 11, { width });
            y += notesH;
        }

        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(stmt, left, y, { width });

        // ---------------- footer on every page ----------------
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            doc.page.margins.bottom = 0;     // else pdfkit starts a new page for text below the margin
            const fy = doc.page.height - 42;
            doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
            doc.text(`${submission.submission_no}  ·  ${roLabel(submission.ro_number)}  ·  Supplier: ${supplierName}`,
                left, fy, { width: width - 80, lineBreak: false });
            doc.text(`Page ${i - range.start + 1} of ${range.count}`, right - 80, fy, { width: 80, align: 'right', lineBreak: false });
        }

        doc.end();
    });
}

module.exports = { buildKitSubmissionPdf, loadSupplierLogo, suggestedNote, isPngOrJpeg, roLabel };
