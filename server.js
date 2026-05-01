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

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway (required for rate limiting and correct IP detection)
app.set('trust proxy', 1);

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

// Helmet for security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://*.supabase.co"],
            connectSrc: ["'self'", "https://*.supabase.co"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
        }
    },
    crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? [process.env.APP_URL || 'https://chc-warehouse-sale-production.up.railway.app']
        : '*',
    credentials: true
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
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

app.use('/api/auth', authRoutes);
app.use('/api/store', storefrontRoutes);
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

// Company storefront (slug-based routing)
app.get('/store/:slug', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'store.html'));
});

app.get('/store/:slug/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'store.html'));
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
    if (err.message && err.message.includes('Invalid file type')) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: process.env.NODE_ENV === 'production'
            ? 'An unexpected error occurred.'
            : err.message
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

app.listen(PORT, () => {
    console.log(`\n🏭 CHC B2B Platform running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Store: http://localhost:${PORT}/store/{company-slug}`);
    console.log(`   Admin: http://localhost:${PORT}/admin`);
    console.log(`   API:   http://localhost:${PORT}/api/health\n`);
});
