/**
 * utils/promotion-images.js
 *
 * Stores and removes the picture that goes with a promotion. The file lives in
 * the public `promotion-images` Storage bucket (migration 048) under
 * <promotion id>/<timestamp>.<ext>; the promotion row keeps the public URL and
 * the path so a replaced or deleted promotion can clean up after itself.
 */

const BUCKET = 'promotion-images';

class PromotionImageError extends Error {
    constructor(message, status = 500) { super(message); this.status = status; }
}

/**
 * Upload one already-validated picture. Returns { url, path }.
 * `check` is the result of checkImageUpload() ({ mime, ext }).
 */
async function storePromotionImage(supabase, promotionId, file, check) {
    const path = `${promotionId}/${Date.now()}.${check.ext}`;
    const { error } = await supabase.storage.from(BUCKET)
        .upload(path, file.buffer, { contentType: check.mime, upsert: false, cacheControl: '31536000' });
    if (error) {
        const missing = /bucket not found|not found/i.test(error.message || '');
        throw new PromotionImageError(missing
            ? 'The picture store is not set up yet. Run migration 048_promotion_images.sql in Supabase, then try again.'
            : 'Could not store that picture. Please try again.', missing ? 409 : 500);
    }
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return { url: data.publicUrl, path };
}

/** Best effort: a picture that can not be removed must never block the change that orphaned it. */
async function removePromotionImage(supabase, path) {
    if (!path) return;
    try { await supabase.storage.from(BUCKET).remove([path]); }
    catch (err) { console.error('Promotion image cleanup failed:', err && err.message); }
}

/** Is this database error "the migration has not been run yet"? */
function missingImageColumns(err) {
    return !!err && /image_url|image_path/i.test(err.message || '');
}

module.exports = { BUCKET, PromotionImageError, storePromotionImage, removePromotionImage, missingImageColumns };
