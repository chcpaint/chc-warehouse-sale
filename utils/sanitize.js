/**
 * Input sanitization utilities
 */

/**
 * Strip HTML tags robustly — handles encoded entities, null bytes, and nested tags
 */
function stripHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/\0/g, '')                    // Remove null bytes
        .replace(/&lt;/gi, '<')                // Decode common entities first
        .replace(/&gt;/gi, '>')
        .replace(/&#x?[0-9a-f]+;?/gi, '')     // Remove numeric HTML entities
        .replace(/<[^>]*>?/g, '')              // Strip tags (including unclosed)
        .trim();
}

function sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item));
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            sanitized[key] = stripHtml(value);
        } else if (typeof value === 'object' && value !== null) {
            sanitized[key] = sanitizeObject(value);
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(String(email).toLowerCase());
}

function generateSlug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 100);
}

/**
 * Validate a UUID string to prevent injection in .or() filters
 */
function isValidUUID(str) {
    if (typeof str !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

module.exports = { stripHtml, sanitizeObject, validateEmail, generateSlug, isValidUUID };
