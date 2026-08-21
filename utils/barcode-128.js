/**
 * utils/barcode-128.js
 *
 * A Code 128 encoder that renders straight to SVG. No dependency, because a
 * barcode is a well-specified table lookup and pulling a package in to draw
 * rectangles is not worth the supply-chain surface — this module is used to
 * print labels that a scanner has to read the first time, every time.
 *
 * Code 128 was chosen over Code 39 for internal labels: it is denser, it
 * carries the full ASCII range, and its Set C packs digit pairs into one
 * symbol, so a numeric internal SKU prints roughly half the width.
 *
 * Used by both the server (printable label sheets) and, via the same source,
 * anything that needs a bar pattern.
 */

// The 107 Code 128 symbols, as bar/space module widths. Index = symbol value.
const PATTERNS = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112'
];

const START_A = 103, START_B = 104, START_C = 105, STOP = 106;

/** Set B value for a printable ASCII character (space..DEL). */
function setBValue(ch) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return null;
    return code - 32;
}

/**
 * Encode a string to Code 128 symbol values, switching to Set C for runs of
 * digits long enough to pay for the switch symbol.
 *
 * @param {string} text printable ASCII
 * @returns {number[]} symbol values, including start, checksum and stop
 */
function encode(text) {
    const s = String(text);
    for (const ch of s) {
        if (setBValue(ch) === null) {
            throw new Error(`Code 128 cannot encode character ${JSON.stringify(ch)}`);
        }
    }

    const digitRunAt = (i) => {
        let n = 0;
        while (i + n < s.length && s[i + n] >= '0' && s[i + n] <= '9') n++;
        return n;
    };

    const values = [];
    let mode = null;
    let i = 0;

    // Starting in Set C pays off for a 4+ digit lead, or a fully numeric even-
    // length string.
    const lead = digitRunAt(0);
    if ((s.length % 2 === 0 && lead === s.length && s.length >= 2) || lead >= 4) {
        values.push(START_C); mode = 'C';
    } else {
        values.push(START_B); mode = 'B';
    }

    while (i < s.length) {
        if (mode === 'C') {
            const run = digitRunAt(i);
            if (run >= 2) {
                const pairs = Math.floor(run / 2);
                for (let p = 0; p < pairs; p++) {
                    values.push(parseInt(s.substr(i, 2), 10));
                    i += 2;
                }
                continue;
            }
            values.push(100);            // CODE B
            mode = 'B';
            continue;
        }

        // mode B
        const run = digitRunAt(i);
        const evenRunToEnd = (i + run === s.length) && run % 2 === 0 && run >= 4;
        if (run >= 6 || evenRunToEnd) {
            if (run % 2 === 1) {         // keep the pairing aligned
                values.push(setBValue(s[i])); i++;
            }
            values.push(99);             // CODE C
            mode = 'C';
            continue;
        }
        values.push(setBValue(s[i]));
        i++;
    }

    // Modulo-103 checksum, weighted by position from the start symbol.
    let sum = values[0];
    for (let k = 1; k < values.length; k++) sum += values[k] * k;
    values.push(sum % 103);
    values.push(STOP);

    return values;
}

/** Bar/space module widths for the whole symbol, starting with a bar. */
function moduleWidths(text) {
    return encode(text).flatMap(v => PATTERNS[v].split('').map(Number));
}

/**
 * Render a Code 128 barcode as a standalone SVG string.
 *
 * @param {string} text
 * @param {{moduleWidth?:number, height?:number, quietZone?:number,
 *          showText?:boolean, fontSize?:number, color?:string}} [opts]
 * @returns {string} SVG markup
 */
function toSvg(text, opts = {}) {
    const mw    = opts.moduleWidth ?? 2;
    const h     = opts.height ?? 60;
    // The spec asks for at least 10 modules of quiet zone either side; skimping
    // here is the most common reason a printed label will not scan.
    const quiet = opts.quietZone ?? 10;
    const showText = opts.showText !== false;
    const fontSize = opts.fontSize ?? 11;
    const color = opts.color || '#111827';

    const widths = moduleWidths(text);
    const modules = widths.reduce((a, b) => a + b, 0);
    const width = (modules + quiet * 2) * mw;
    const textH = showText ? fontSize + 4 : 0;
    const height = h + textH;

    let x = quiet * mw;
    let bars = '';
    widths.forEach((w, idx) => {
        if (idx % 2 === 0) {                       // even index = bar
            bars += `<rect x="${round(x)}" y="0" width="${round(w * mw)}" height="${h}" fill="${color}"/>`;
        }
        x += w * mw;
    });

    const label = showText
        ? `<text x="${round(width / 2)}" y="${h + fontSize}" text-anchor="middle" fill="${color}" ` +
          `font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${fontSize}">${escapeXml(text)}</text>`
        : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" ` +
           `viewBox="0 0 ${round(width)} ${round(height)}" role="img" aria-label="Barcode ${escapeXml(text)}">` +
           `<rect width="100%" height="100%" fill="#ffffff"/>${bars}${label}</svg>`;
}

function round(n) { return Math.round(n * 100) / 100; }

function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

module.exports = { encode, moduleWidths, toSvg, PATTERNS };
