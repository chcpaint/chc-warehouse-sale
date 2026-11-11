require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Route modules
const authRoutes = require('./routes/auth');
const storefrontRoutes = require('./routes/storefront');
const adminRoutes = require('./routes/admin');
const { resolveDistributor } = require('./utils/tenant');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway (required for rate limiting and correct IP detection)
app.set('trust proxy', 1);

// A short id on every request, echoed in X-Request-Id and in error logs.
app.use(require('./utils/request-id').requestId);

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

// Helmet for security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // 'wasm-unsafe-eval' is required by the html5-qrcode decoder, which is the
            // camera path refinishAI Inventory falls back to on iOS and iPadOS (Safari
            // has no BarcodeDetector). Without it the decoder is blocked by CSP and
            // phone scanning fails silently on every iPhone.
            scriptSrc: ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://*.supabase.co"],
            connectSrc: ["'self'", "https://*.supabase.co"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
            // Each of these would otherwise fall back to defaultSrc ('self'), which
            // happens to be right — but the inventory module depends on all three, so
            // they are stated rather than inherited.
            workerSrc: ["'self'"],          // the inventory service worker
            manifestSrc: ["'self'"],        // the per-company home-screen manifest
            mediaSrc: ["'self'", "blob:"],  // the camera preview stream
        }
    },
    crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? [process.env.APP_URL || 'https://chc-sale-console-production.up.railway.app']
        : '*',
    credentials: true
}));

// ============================================================
// STRIPE WEBHOOK (raw body required for signature verification)
// Registered BEFORE express.json so the raw payload is intact.
// Inert until STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET are configured.
// ============================================================
const { getStripe: _getStripe } = require('./utils/payments');
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const stripe = _getStripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) {
        return res.status(503).json({ error: 'Payments webhook not configured.' });
    }
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
    } catch (err) {
        console.error('Stripe webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
        const { supabaseAdmin } = require('./utils/supabase');
        if (event.type === 'payment_intent.succeeded') {
            const pi = event.data.object;
            await supabaseAdmin.from('orders').update({
                payment_status: 'paid',
                amount_paid: (pi.amount_received || pi.amount || 0) / 100,
                paid_at: new Date().toISOString()
            }).eq('payment_intent_id', pi.id);
        } else if (event.type === 'payment_intent.payment_failed') {
            await supabaseAdmin.from('orders').update({ payment_status: 'failed' })
                .eq('payment_intent_id', event.data.object.id);
        } else if (event.type === 'checkout.session.completed' || event.type.startsWith('customer.subscription.')) {
            // Console subscriptions (utils/billing-db.js). Idempotent per event id.
            await require('./utils/billing-db').handleStripeEvent(supabaseAdmin, event);
        }
        res.json({ received: true });
    } catch (err) {
        console.error('Stripe webhook handler error:', err);
        res.status(500).json({ error: 'Webhook handling failed.' });
    }
});

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const { keyGenerator: rlKey, maxFor: rlMax } = require('./utils/rate-limit');
const apiLimiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    // Per signed-in person with a realistic ceiling; per IP and strict for anonymous traffic.
    // See utils/rate-limit.js.
    limit: rlMax,
    keyGenerator: rlKey,
    // The scan-out kiosk has no signed-in person for this limiter to key on, so it
    // would put a whole shop floor in one anonymous per-IP bucket. routes/kiosk.js
    // applies its own limits instead (per tablet, plus strict on bad links).
    skip: (req) => req.originalUrl.startsWith('/api/kiosk/'),
    message: { error: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,   // 5 minutes
    max: 10,                    // 10 attempts
    message: { error: 'Too many login attempts. Please wait 5 minutes.' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

// HTTPS redirect in production
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.headers['x-forwarded-proto'] !== 'https') {
            return res.redirect(301, `https://${req.headers.host}${req.url}`);
        }
        next();
    });
}

// ============================================================
// STATIC FILES
// ============================================================

app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// ============================================================
// API ROUTES
// ============================================================

// Readiness: the server is up AND can reach the database. Point the uptime
// monitor at this one. Registered before the tenant lookup on purpose, so it
// reports the database itself rather than a cached answer. Returns only
// ok / not ok and a timing, never data.
app.get('/api/health/ready', async (req, res) => {
    const { supabaseAdmin } = require('./utils/supabase');
    const db = await require('./utils/health').checkDatabase(supabaseAdmin);
    res.status(db.ok ? 200 : 503).json({
        status: db.ok ? 'ready' : 'unavailable',
        database: db.ok ? 'ok' : db.error,
        ms: db.ms,
        timestamp: new Date().toISOString()
    });
});

// Every API request resolves to the distributor (CHC today; others once
// onboarded) whose domain/subdomain it arrived on, before it reaches auth
// or any route. See utils/tenant.js for the resolution order and the
// permanent chcsale.com -> CHC fallback.
app.use('/api/', resolveDistributor);

app.use('/api/auth', authRoutes);
app.use('/api/store', require('./routes/shopsafe-launch'));
app.use('/api/store', storefrontRoutes);
app.use('/api/kiosk', require('./routes/kiosk'));
app.use('/api/help', require('./routes/help'));
app.use('/api/admin', adminRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), version: '3.0.0' });
});

// ============================================================
// PAGE ROUTES
// ============================================================

// Admin dashboard
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/admin/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// refinishAI Inventory — per-company home-screen manifest.
//
// Served rather than built as a data: URL in the page, because start_url has to
// point at this company's store and the site's CSP (correctly) refuses data:
// manifests. Registered before /store/:slug/* so the catch-all does not swallow
// it. Public on purpose: it carries a slug and nothing else, and the browser
// fetches a manifest without the session's Authorization header.
app.get('/store/:slug/manifest.webmanifest', (req, res) => {
    const slug = String(req.params.slug || '').replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    if (!slug) return res.status(404).json({ error: 'Not found.' });
    res.type('application/manifest+json');
    res.json({
        name: 'refinishAI Inventory',
        short_name: 'refinishAI',
        start_url: `/store/${slug}`,
        scope: '/',
        display: 'standalone',
        background_color: '#f9fafb',
        theme_color: '#1e40af',
        icons: [{ src: '/assets/refinishai-icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }]
    });
});

// Scan-out kiosk page. The secret in the URL is read by the page and sent as a
// header; it is never logged here, never cached, and never sent on to another
// site (no external links on the page, and Referrer-Policy says so anyway).
app.get(['/kiosk', '/kiosk/:token'], (req, res) => {
    res.set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow'
    });
    res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

// Company storefront (slug-based routing)
app.get('/store/:slug', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'store.html'));
});

app.get('/store/:slug/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'store.html'));
});

// Help: how-to answers, security and data protection, where AI is used.
// Public on purpose: a buyer's IT team should be able to read it before signing in.
app.get('/help', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

// Landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// ERROR HANDLING
// ============================================================

// Multer error handling
app.use((err, req, res, next) => {
    if (err.name === 'MulterError') {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large.' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err.message && /^Invalid (file|image|invoice) type/.test(err.message)) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

// Global error handler
app.use((err, req, res, next) => {
    console.error(`Unhandled error [request ${req.id || 'n/a'}] ${req.method} ${req.originalUrl.split('?')[0]}:`, err);
    res.status(500).json({
        error: process.env.NODE_ENV === 'production'
            ? 'An unexpected error occurred.'
            : err.message,
        request_id: req.id || undefined
    });
});

// 404 handler
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Endpoint not found.' });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// START SERVER
// ============================================================

const server = app.listen(PORT, () => {
    console.log(`\n🏭 CHC B2B Platform running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Store: http://localhost:${PORT}/store/{company-slug}`);
    console.log(`   Admin: http://localhost:${PORT}/admin`);
    console.log(`   API:   http://localhost:${PORT}/api/health\n`);

    // Plain-English warnings about the environment. Never stops the server.
    try {
        for (const w of require('./utils/config-check').configWarnings()) console.warn(`   CONFIG WARNING: ${w}`);
    } catch (_) { /* a check must never take the console down */ }

    // Scheduled work — currently the refinishAI low-stock digest, which goes
    // out in the morning of the shop's own time zone. Runs in this process
    // rather than an external cron, so there is no service token and no public
    // endpoint whose job is to make the server send email. Safe with several
    // instances: the jobs claim their work through a unique constraint.
    // Disabled automatically under NODE_ENV=test, or with SCHEDULER_ENABLED=false.
    try {
        const scheduler = require('./utils/scheduler');
        const outcome = scheduler.start();
        if (!outcome.started) console.log(`   Scheduler: not started (${outcome.reason})`);
    } catch (err) {
        // A broken scheduler must not stop the console from serving orders.
        console.error('   Scheduler failed to start (the app is unaffected):', err.message);
    }
});

// Stop taking new work before the process goes, so a digest half-sent on a
// redeploy does not look like a hang.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        console.log(`\n${signal} received — shutting down.`);
        try { require('./utils/scheduler').stop(); } catch (_) { /* never block the exit */ }
        server.close(() => process.exit(0));
        // Do not wait forever on a lingering connection.
        setTimeout(() => process.exit(0), 10000).unref();
    });
}
