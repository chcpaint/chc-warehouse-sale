/**
 * utils/config-check.js
 *
 * Looks at the environment at start-up and returns a list of plain-English
 * warnings. It never stops the server: a console that serves customers must
 * not refuse to boot over a setting, so problems are logged loudly instead.
 * Secrets are never printed, only whether they look usable.
 */
function configWarnings(env = process.env) {
    const out = [];
    const production = env.NODE_ENV === 'production';

    const jwt = env.JWT_SECRET || '';
    if (!jwt) out.push('JWT_SECRET is not set: nobody can sign in.');
    else if (jwt.length < 32) out.push('JWT_SECRET is shorter than 32 characters. Use a long random value (openssl rand -base64 48).');

    if (!env.SUPABASE_URL) out.push('SUPABASE_URL is not set.');
    if (!env.SUPABASE_SERVICE_ROLE_KEY) out.push('SUPABASE_SERVICE_ROLE_KEY is not set.');

    if (production) {
        if (!env.APP_URL) out.push('APP_URL is not set in production: cross-site requests fall back to a built-in address.');
        if (!env.SENDGRID_API_KEY && !env.SMTP_PASS) out.push('Neither SENDGRID_API_KEY nor SMTP_PASS is set: order and reset emails will not send.');
    }
    return out;
}

module.exports = { configWarnings };
