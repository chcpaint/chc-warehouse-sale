/**
 * utils/image-upload.js
 *
 * Checks a picture a person uploads before it is stored.
 *
 * The browser's file type and the file name are written by the sender, so
 * neither is trusted: the file's first bytes decide what it is. Only PNG, JPEG,
 * GIF and WEBP are accepted. SVG is refused on purpose: it can carry script and
 * is served from a storage domain next to the app.
 */

const MAX_PROMO_IMAGE_BYTES = 3 * 1024 * 1024;

const TYPES = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp'
};

/** The real type of an image buffer, from its first bytes, or null. */
function sniffImage(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
        && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    const head = buf.slice(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

/**
 * Validate an uploaded file (multer memory file).
 * Returns { ok:true, mime, ext } or { ok:false, error }.
 */
function checkImageUpload(file, maxBytes = MAX_PROMO_IMAGE_BYTES) {
    if (!file || !file.buffer || !file.buffer.length) return { ok: false, error: 'Choose a picture to upload.' };
    if (file.buffer.length > maxBytes) {
        return { ok: false, error: `That picture is over ${Math.round(maxBytes / 1048576)} MB. Save it smaller and try again.` };
    }
    const mime = sniffImage(file.buffer);
    if (!mime) return { ok: false, error: 'That file is not a PNG, JPEG, GIF or WEBP picture.' };
    return { ok: true, mime, ext: TYPES[mime] };
}

const multer = require('multer');

/**
 * Multipart reader for ONE picture in the field "image", held in memory (never
 * written to disk). The size cap here is the same as checkImageUpload's.
 */
const promoImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PROMO_IMAGE_BYTES, files: 1, fields: 20 }
});

/**
 * Express middleware: reads a multipart body (with an optional picture) and
 * leaves a plain JSON body alone, so one route serves both. Reports a too-large
 * or malformed upload as a plain-language 4xx instead of an HTML error page.
 */
function optionalImage(field = 'image') {
    const single = promoImageUpload.single(field);
    return (req, res, next) => {
        if (!req.is('multipart/form-data')) return next();
        single(req, res, err => {
            if (!err) return next();
            const big = err.code === 'LIMIT_FILE_SIZE';
            res.status(big ? 413 : 400).json({
                error: big ? `That picture is over ${Math.round(MAX_PROMO_IMAGE_BYTES / 1048576)} MB. Save it smaller and try again.` : 'Could not read the upload.'
            });
        });
    };
}

module.exports = { sniffImage, checkImageUpload, optionalImage, promoImageUpload, MAX_PROMO_IMAGE_BYTES, TYPES };
