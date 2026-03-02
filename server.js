const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const csv = require('csv-parser');
const { Readable } = require('stream');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const BCRYPT_ROUNDS = 12;

// ========================================
// SUPABASE CLIENT
// ========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ========================================
// EMAIL CONFIGURATION
// ========================================
const BRANCH_EMAILS = {
  "Woodbridge": "woodbridge@chcpaint.com",
  "Markham": "markham@chcpaint.com",
  "Ottawa": "ottawa@chcpaint.com",
  "Hamilton": "hamilton@chcpaint.com",
  "Oakville": "oakville@chcpaint.com",
  "St. Catharines": "stcatharines@chcpaint.com"
};

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log('Email transport configured');
} else {
  console.log('SMTP not configured — email notifications disabled');
}

// ========================================
// MIDDLEWARE — Security Hardening
// ========================================

// Trust Railway's proxy for correct IP detection
app.set('trust proxy', 1);

// Helmet: Sets security HTTP headers (CSP disabled — inline scripts used by frontend)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors());

// HTTPS enforcement in production (redirect HTTP to HTTPS)
// Only redirect when x-forwarded-proto header is present (external requests via proxy)
// Railway's internal healthcheck doesn't set this header, so it passes through
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    if (proto && proto !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// Global rate limiter: 100 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', globalLimiter);

// Strict rate limiter for auth endpoints: 10 attempts per 5 minutes
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 5 minutes.' }
});
app.use('/api/admin/auth/', authLimiter);
app.use('/api/auth/', authLimiter);

// Body parsing with size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Static files
app.use(express.static('public'));

// JWT secret validation — warn if using default
if (JWT_SECRET === 'change-this-in-production') {
  console.warn('WARNING: Using default JWT_SECRET. Set JWT_SECRET env variable for production!');
}

// Input sanitization helper — strips HTML tags and trims
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}

// Audit log helper
async function auditLog(action, adminId, details = {}) {
  try {
    console.log(`[AUDIT] ${new Date().toISOString()} | ${action} | admin:${adminId || 'system'} | ${JSON.stringify(details)}`);
    // Future: write to audit_log table in Supabase
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

// File upload (10MB max, memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream'
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(csv|xlsx|xls)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'));
    }
  }
});

// Rate limiting (in-memory)
const authAttempts = new Map();
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes (reduced from 15)

function checkRateLimit(ip, maxAttempts = 20) {
  const now = Date.now();
  const attempts = authAttempts.get(ip) || [];
  const recent = attempts.filter(t => now - t < RATE_LIMIT_WINDOW);
  authAttempts.set(ip, recent);
  return recent.length < maxAttempts;
}

function recordAttempt(ip) {
  const attempts = authAttempts.get(ip) || [];
  attempts.push(Date.now());
  authAttempts.set(ip, attempts);
}

function clearRateLimit(ip) {
  authAttempts.delete(ip);
}

// ========================================
// JWT ADMIN AUTH MIDDLEWARE
// ========================================
async function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify admin still exists and is active
    const { data: admin, error } = await supabase
      .from('admin_users')
      .select('id, email, role, name, is_active')
      .eq('id', decoded.adminId)
      .single();

    if (error || !admin || !admin.is_active) {
      return res.status(401).json({ error: 'Invalid or inactive admin account' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireSuperAdmin(req, res, next) {
  if (req.admin.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

// ========================================
// ADMIN AUTH ROUTES
// ========================================

// Register first admin (super_admin) or additional admins (requires super_admin auth)
app.post('/api/admin/auth/register', async (req, res) => {
  try {
    const rawEmail = req.body.email;
    const password = req.body.password;
    const rawName = req.body.name;

    if (!rawEmail || !password || !rawName) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Sanitize inputs
    const email = sanitize(rawEmail);
    const name = sanitize(rawName);

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Password strength requirements
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain uppercase, lowercase, and a number' });
    }

    // Check if any admins exist
    const { count, error: countError } = await supabase
      .from('admin_users')
      .select('*', { count: 'exact', head: true });

    console.log('Admin count check:', { count, countError });

    let role = 'admin';

    if (!count || count === 0) {
      // First admin registration — becomes super_admin
      role = 'super_admin';
    } else {
      // Subsequent registrations require super_admin auth
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Super admin authentication required to add new admins' });
      }

      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const { data: admin } = await supabase
          .from('admin_users')
          .select('role')
          .eq('id', decoded.adminId)
          .single();

        if (!admin || admin.role !== 'super_admin') {
          return res.status(403).json({ error: 'Only super admins can create new admin accounts' });
        }
      } catch (err) {
        return res.status(401).json({ error: 'Invalid authentication token' });
      }
    }

    // Check for duplicate email
    const { data: existing } = await supabase
      .from('admin_users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) {
      return res.status(409).json({ error: 'An admin with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const { data: newAdmin, error } = await supabase
      .from('admin_users')
      .insert({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        role,
        name,
        is_active: true
      })
      .select('id, email, role, name')
      .single();

    if (error) {
      console.error('Admin registration error:', JSON.stringify(error, null, 2));
      return res.status(500).json({ error: 'Failed to create admin account: ' + (error.message || error.code || 'unknown error') });
    }

    const token = jwt.sign(
      { adminId: newAdmin.id, email: newAdmin.email, role: newAdmin.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`Admin registered: ${newAdmin.email} (${role})`);
    await auditLog('ADMIN_REGISTERED', newAdmin.id, { email: newAdmin.email, role });
    res.json({ success: true, token, admin: newAdmin });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Admin login
app.post('/api/admin/auth/login', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  if (!checkRateLimit(ip, 20)) {
    await auditLog('LOGIN_RATE_LIMITED', null, { ip });
    return res.status(429).json({ error: 'Too many login attempts. Please wait 5 minutes.' });
  }

  recordAttempt(ip);

  try {
    const rawEmail = req.body.email;
    const password = req.body.password;

    if (!rawEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const email = sanitize(rawEmail);

    const { data: admin, error } = await supabase
      .from('admin_users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (error || !admin) {
      await auditLog('LOGIN_FAILED', null, { email, reason: 'not found' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!admin.is_active) {
      await auditLog('LOGIN_FAILED', admin.id, { email, reason: 'inactive' });
      return res.status(401).json({ error: 'Account is disabled. Contact super admin.' });
    }

    const validPassword = await bcrypt.compare(password, admin.password_hash);
    if (!validPassword) {
      await auditLog('LOGIN_FAILED', admin.id, { email, reason: 'wrong password' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last_login
    await supabase
      .from('admin_users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', admin.id);

    const token = jwt.sign(
      { adminId: admin.id, email: admin.email, role: admin.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Clear rate limit on successful login
    clearRateLimit(ip);

    await auditLog('LOGIN_SUCCESS', admin.id, { email: admin.email });
    console.log(`Admin login: ${admin.email}`);
    res.json({
      success: true,
      token,
      admin: { id: admin.id, email: admin.email, role: admin.role, name: admin.name }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify admin token
app.get('/api/admin/auth/me', authenticateAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

// ========================================
// ADMIN USER MANAGEMENT
// ========================================
app.get('/api/admin/users', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('id, email, role, name, is_active, last_login, created_at')
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Fetch admins error:', error);
    res.status(500).json({ error: 'Failed to fetch admin users' });
  }
});

app.patch('/api/admin/users/:id', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active, role } = req.body;

    // Prevent self-demotion
    if (id === req.admin.id && role && role !== 'super_admin') {
      return res.status(400).json({ error: 'Cannot demote yourself' });
    }

    const updates = {};
    if (typeof is_active === 'boolean') updates.is_active = is_active;
    if (role && ['super_admin', 'admin'].includes(role)) updates.role = role;

    const { data, error } = await supabase
      .from('admin_users')
      .update(updates)
      .eq('id', id)
      .select('id, email, role, name, is_active')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Update admin error:', error);
    res.status(500).json({ error: 'Failed to update admin user' });
  }
});

// ========================================
// ADMIN SALES MANAGEMENT
// ========================================
app.get('/api/admin/sales', authenticateAdmin, async (req, res) => {
  try {
    const { data: sales, error } = await supabase
      .from('sales')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Add product counts and order counts for each sale
    const enriched = await Promise.all(sales.map(async (sale) => {
      const [{ count: productCount }, { count: orderCount }] = await Promise.all([
        supabase.from('products').select('*', { count: 'exact', head: true }).eq('sale_id', sale.id),
        supabase.from('orders').select('*', { count: 'exact', head: true }).eq('sale_id', sale.id)
      ]);
      return { ...sale, product_count: productCount || 0, order_count: orderCount || 0 };
    }));

    res.json(enriched);
  } catch (error) {
    console.error('Fetch sales error:', error);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

app.post('/api/admin/sales', authenticateAdmin, async (req, res) => {
  try {
    const rawName = req.body.name;
    const rawSlug = req.body.slug;
    const rawDescription = req.body.description;
    const password = req.body.password;
    const status = req.body.status;
    const start_date = req.body.start_date;
    const end_date = req.body.end_date;

    if (!rawName || !rawSlug || !password) {
      return res.status(400).json({ error: 'Name, slug, and password are required' });
    }

    // Sanitize inputs
    const name = sanitize(rawName);
    const slug = sanitize(rawSlug).toLowerCase();
    const description = rawDescription ? sanitize(rawDescription) : '';

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ error: 'Slug must contain only lowercase letters, numbers, and hyphens' });
    }

    // Validate status
    const validStatus = ['draft', 'active', 'archived'].includes(status) ? status : 'draft';

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const { data, error } = await supabase
      .from('sales')
      .insert({
        name,
        slug,
        description,
        password_hash: passwordHash,
        status: validStatus,
        start_date: start_date || null,
        end_date: end_date || null,
        created_by: req.admin.id
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A sale with this slug already exists' });
      }
      throw error;
    }

    await auditLog('SALE_CREATED', req.admin.id, { saleId: data.id, name, slug });
    console.log(`Sale created: ${name} by ${req.admin.email}`);
    res.json(data);
  } catch (error) {
    console.error('Create sale error:', error);
    res.status(500).json({ error: 'Failed to create sale' });
  }
});

app.get('/api/admin/sales/:id', authenticateAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sales')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Sale not found' });
    res.json(data);
  } catch (error) {
    console.error('Fetch sale error:', error);
    res.status(500).json({ error: 'Failed to fetch sale' });
  }
});

app.patch('/api/admin/sales/:id', authenticateAdmin, async (req, res) => {
  try {
    const updates = {};

    if (req.body.name) updates.name = sanitize(req.body.name);
    if (req.body.description !== undefined) updates.description = sanitize(req.body.description);
    if (req.body.status && ['draft', 'active', 'archived'].includes(req.body.status)) updates.status = req.body.status;
    if (req.body.start_date !== undefined) updates.start_date = req.body.start_date;
    if (req.body.end_date !== undefined) updates.end_date = req.body.end_date;
    if (req.body.password) updates.password_hash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);

    const { data, error } = await supabase
      .from('sales')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    await auditLog('SALE_UPDATED', req.admin.id, { saleId: req.params.id, fields: Object.keys(updates) });
    res.json(data);
  } catch (error) {
    console.error('Update sale error:', error);
    res.status(500).json({ error: 'Failed to update sale' });
  }
});

app.delete('/api/admin/sales/:id', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // Soft delete — archive the sale
    const { data, error } = await supabase
      .from('sales')
      .update({ status: 'archived' })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    await auditLog('SALE_ARCHIVED', req.admin.id, { saleId: req.params.id });
    res.json({ success: true, sale: data });
  } catch (error) {
    console.error('Delete sale error:', error);
    res.status(500).json({ error: 'Failed to archive sale' });
  }
});

// ========================================
// ADMIN PRODUCT MANAGEMENT
// ========================================
app.get('/api/admin/sales/:saleId/products', authenticateAdmin, async (req, res) => {
  try {
    const { brand, category, search } = req.query;
    let query = supabase
      .from('products')
      .select('*')
      .eq('sale_id', req.params.saleId)
      .order('brand')
      .order('category')
      .order('name');

    if (brand) query = query.eq('brand', sanitize(brand));
    if (category) query = query.eq('category', sanitize(category));
    if (search) {
      const cleanSearch = sanitize(search).replace(/[%_]/g, '');  // Strip SQL wildcards
      query = query.or(`sku.ilike.%${cleanSearch}%,name.ilike.%${cleanSearch}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Fetch products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/admin/sales/:saleId/products', authenticateAdmin, async (req, res) => {
  try {
    const { sku, brand, category, name, previous_price, sale_price, promo } = req.body;

    if (!sku || !brand || !name || !previous_price || !sale_price) {
      return res.status(400).json({ error: 'SKU, brand, name, previous_price, and sale_price are required' });
    }

    const { data, error } = await supabase
      .from('products')
      .insert({
        sale_id: req.params.saleId,
        sku,
        brand,
        category: category || '',
        name,
        previous_price: parseFloat(previous_price),
        sale_price: parseFloat(sale_price),
        promo: promo || null
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A product with this SKU already exists in this sale' });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Bulk upload products via CSV or Excel
app.post('/api/admin/sales/:saleId/products/upload', authenticateAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // File upload hardening: validate file size and type
    const maxSize = 5 * 1024 * 1024; // 5MB for data files
    if (req.file.size > maxSize) {
      return res.status(400).json({ error: 'File too large. Maximum 5MB for product uploads.' });
    }

    const allowedExts = ['.csv', '.xlsx', '.xls'];
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!allowedExts.includes(ext)) {
      return res.status(400).json({ error: 'Invalid file type. Only CSV and Excel files allowed.' });
    }

    // Verify sale exists
    const { data: sale, error: saleError } = await supabase
      .from('sales')
      .select('id')
      .eq('id', req.params.saleId)
      .single();

    if (saleError || !sale) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    let rows = [];
    const fileName = req.file.originalname.toLowerCase();

    if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      // Parse Excel
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } else {
      // Parse CSV
      rows = await new Promise((resolve, reject) => {
        const results = [];
        const stream = Readable.from(req.file.buffer.toString());
        stream
          .pipe(csv())
          .on('data', (data) => results.push(data))
          .on('end', () => resolve(results))
          .on('error', reject);
      });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'File is empty or has no data rows' });
    }

    // Limit rows to prevent abuse
    if (rows.length > 10000) {
      return res.status(400).json({ error: 'File too large. Maximum 10,000 product rows per upload.' });
    }

    // Normalize column headers (case-insensitive)
    const normalizeKey = (key) => {
      const k = key.toLowerCase().trim().replace(/\s+/g, '_');
      const aliases = {
        'sku': 'sku', 'sku_code': 'sku', 'product_code': 'sku', 'item_code': 'sku',
        'brand': 'brand', 'manufacturer': 'brand',
        'category': 'category', 'cat': 'category', 'product_category': 'category',
        'name': 'name', 'description': 'name', 'product_name': 'name', 'product_description': 'name',
        'previous_price': 'previous_price', 'previousprice': 'previous_price', 'original_price': 'previous_price',
        'regular_price': 'previous_price', 'msrp': 'previous_price', 'ae_price': 'previous_price',
        'sale_price': 'sale_price', 'saleprice': 'sale_price', 'price': 'sale_price',
        'promo': 'promo', 'promotion': 'promo', 'promo_text': 'promo', 'special': 'promo'
      };
      return aliases[k] || k;
    };

    // Process and validate rows
    const results = { added: 0, updated: 0, failed: [] };
    const products = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const row = {};
      Object.entries(raw).forEach(([key, value]) => {
        row[normalizeKey(key)] = typeof value === 'string' ? value.trim() : value;
      });

      // Validate required fields
      if (!row.sku || !row.brand || !row.name) {
        results.failed.push({ row: i + 2, reason: 'Missing sku, brand, or name', data: raw });
        continue;
      }

      const prevPrice = parseFloat(row.previous_price);
      const salePrice = parseFloat(row.sale_price);

      if (isNaN(prevPrice) || isNaN(salePrice) || prevPrice < 0 || salePrice < 0) {
        results.failed.push({ row: i + 2, reason: 'Invalid price values', data: raw });
        continue;
      }

      products.push({
        sale_id: req.params.saleId,
        sku: sanitize(String(row.sku)).substring(0, 50),
        brand: sanitize(String(row.brand)).substring(0, 100),
        category: sanitize(String(row.category || '')).substring(0, 100),
        name: sanitize(String(row.name)).substring(0, 255),
        previous_price: prevPrice,
        sale_price: salePrice,
        promo: row.promo ? sanitize(String(row.promo)).substring(0, 100) : null
      });
    }

    // Upsert products in batches of 100
    for (let i = 0; i < products.length; i += 100) {
      const batch = products.slice(i, i + 100);
      const { data, error } = await supabase
        .from('products')
        .upsert(batch, { onConflict: 'sale_id,sku', ignoreDuplicates: false })
        .select();

      if (error) {
        console.error('Batch upsert error:', error);
        batch.forEach((p, idx) => {
          results.failed.push({ row: i + idx + 2, reason: error.message, data: p });
        });
      } else {
        // Count adds vs updates (approximate)
        results.added += data.length;
      }
    }

    await auditLog('PRODUCTS_UPLOADED', req.admin.id, {
      saleId: req.params.saleId,
      filename: req.file.originalname,
      totalRows: rows.length,
      added: results.added,
      failed: results.failed.length
    });
    console.log(`Product upload: ${results.added} added/updated, ${results.failed.length} failed by ${req.admin.email}`);
    res.json({
      success: true,
      total_rows: rows.length,
      added: results.added,
      failed: results.failed.length,
      failures: results.failed.slice(0, 20) // Return first 20 failures
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process file upload' });
  }
});

app.patch('/api/admin/sales/:saleId/products/:id', authenticateAdmin, async (req, res) => {
  try {
    const { sku, brand, category, name, previous_price, sale_price, promo } = req.body;
    const updates = {};

    if (sku) updates.sku = sku;
    if (brand) updates.brand = brand;
    if (category !== undefined) updates.category = category;
    if (name) updates.name = name;
    if (previous_price !== undefined) updates.previous_price = parseFloat(previous_price);
    if (sale_price !== undefined) updates.sale_price = parseFloat(sale_price);
    if (promo !== undefined) updates.promo = promo || null;

    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', req.params.id)
      .eq('sale_id', req.params.saleId)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.delete('/api/admin/sales/:saleId/products/:id', authenticateAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', req.params.id)
      .eq('sale_id', req.params.saleId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Delete all products for a sale
app.delete('/api/admin/sales/:saleId/products', authenticateAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('sale_id', req.params.saleId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Delete all products error:', error);
    res.status(500).json({ error: 'Failed to delete products' });
  }
});

// ========================================
// ADMIN ORDER MANAGEMENT
// ========================================
app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
  try {
    const { sale_id, status, branch, from_date, to_date } = req.query;
    let query = supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (sale_id) query = query.eq('sale_id', sale_id);
    if (status) query = query.eq('status', status);
    if (branch) query = query.eq('branch', branch);
    if (from_date) query = query.gte('created_at', from_date);
    if (to_date) query = query.lte('created_at', to_date);

    const { data, error } = await query.limit(500);
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.patch('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') });
    }

    const { data, error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    await auditLog('ORDER_STATUS_UPDATED', req.admin.id, {
      orderId: req.params.id,
      orderCode: data.order_code,
      newStatus: status
    });

    // Send status update email (non-blocking)
    if (transporter && data.email) {
      sendStatusUpdateEmail(data).catch(err => {
        console.error('Status email failed:', err.message);
      });
    }

    res.json(data);
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// Delete order (hard delete — permanent removal)
app.delete('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
  try {
    // Fetch order first for audit trail
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('id, order_code, shop_name, email, branch, total')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const { error: deleteError } = await supabase
      .from('orders')
      .delete()
      .eq('id', req.params.id);

    if (deleteError) throw deleteError;

    await auditLog('ORDER_DELETED', req.admin.id, {
      orderId: order.id,
      orderCode: order.order_code,
      shopName: order.shop_name,
      email: order.email,
      branch: order.branch,
      total: order.total
    });

    console.log(`Order deleted: ${order.order_code} by admin ${req.admin.email}`);
    res.json({ success: true, deletedOrder: order.order_code });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// Admin dashboard stats
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const [
      { count: totalSales },
      { count: activeSales },
      { count: totalOrders },
      { count: pendingOrders }
    ] = await Promise.all([
      supabase.from('sales').select('*', { count: 'exact', head: true }),
      supabase.from('sales').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('orders').select('*', { count: 'exact', head: true }),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'pending')
    ]);

    // Total revenue
    const { data: revenueData } = await supabase
      .from('orders')
      .select('total');

    const totalRevenue = (revenueData || []).reduce((sum, o) => sum + parseFloat(o.total || 0), 0);

    res.json({
      total_sales: totalSales || 0,
      active_sales: activeSales || 0,
      total_orders: totalOrders || 0,
      pending_orders: pendingOrders || 0,
      total_revenue: totalRevenue
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ========================================
// CUSTOMER-FACING ROUTES (public)
// ========================================

// List active sales (for sale picker)
app.get('/api/sales', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sales')
      .select('id, name, slug, description, status, start_date, end_date')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Fetch active sales error:', error);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// Get products for a sale (grouped by brand + category)
app.get('/api/sales/:saleId/products', async (req, res) => {
  try {
    // Verify sale is active
    const { data: sale, error: saleError } = await supabase
      .from('sales')
      .select('id, status')
      .eq('id', req.params.saleId)
      .eq('status', 'active')
      .single();

    if (saleError || !sale) {
      return res.status(404).json({ error: 'Sale not found or not active' });
    }

    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .eq('sale_id', req.params.saleId)
      .order('brand')
      .order('category')
      .order('name');

    if (error) throw error;

    // Group products by brand → category (matching the existing frontend format)
    const grouped = {};
    const brands = [];
    const productCounts = {};

    products.forEach(p => {
      if (!grouped[p.brand]) {
        grouped[p.brand] = { hasCategories: false, categories: {}, products: [] };
        brands.push(p.brand);
        productCounts[p.brand] = 0;
      }
      productCounts[p.brand]++;

      if (p.category && p.category.trim() !== '') {
        grouped[p.brand].hasCategories = true;
        if (!grouped[p.brand].categories[p.category]) {
          grouped[p.brand].categories[p.category] = [];
        }
        grouped[p.brand].categories[p.category].push({
          sku: p.sku,
          name: p.name,
          previousPrice: p.previous_price.toString(),
          salePrice: p.sale_price.toString(),
          promo: p.promo || undefined,
          caseQty: p.case_qty || 1
        });
      } else {
        grouped[p.brand].products.push({
          sku: p.sku,
          name: p.name,
          previousPrice: p.previous_price.toString(),
          salePrice: p.sale_price.toString(),
          promo: p.promo || undefined,
          caseQty: p.case_qty || 1
        });
      }
    });

    // Clean up: brands with only flat products shouldn't have empty categories
    Object.values(grouped).forEach(brand => {
      if (!brand.hasCategories) {
        delete brand.categories;
      } else {
        delete brand.products;
      }
    });

    res.json({ products: grouped, brands, productCounts, total: products.length });
  } catch (error) {
    console.error('Fetch sale products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Customer auth — verify sale password
app.post('/api/auth/verify', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  if (!checkRateLimit(ip, 10)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  recordAttempt(ip);

  try {
    const { sale_id, password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }

    // If sale_id provided, verify against sale password
    if (sale_id) {
      const { data: sale, error } = await supabase
        .from('sales')
        .select('id, password_hash, status')
        .eq('id', sale_id)
        .single();

      if (error || !sale) {
        return res.status(404).json({ error: 'Sale not found' });
      }

      if (sale.status !== 'active') {
        return res.status(403).json({ error: 'This sale is not currently active' });
      }

      const valid = await bcrypt.compare(password, sale.password_hash);
      if (valid) {
        console.log(`Customer auth success for sale ${sale_id} from ${ip}`);
        return res.json({ success: true });
      } else {
        console.log(`Customer auth failed for sale ${sale_id} from ${ip}`);
        return res.status(401).json({ error: 'Invalid password' });
      }
    }

    // Legacy fallback: verify against WAREHOUSE_PASSWORD env var (bcrypt hashed comparison)
    const correctPassword = process.env.WAREHOUSE_PASSWORD;
    if (correctPassword) {
      // Support both hashed and plaintext env values — compare securely either way
      const isHashed = correctPassword.startsWith('$2b$') || correctPassword.startsWith('$2a$');
      if (isHashed) {
        const valid = await bcrypt.compare(password, correctPassword);
        if (valid) return res.json({ success: true });
      } else {
        // Plaintext env var — simple comparison
        if (password === correctPassword) {
          return res.json({ success: true });
        }
      }
    }

    return res.status(401).json({ error: 'Invalid password' });
  } catch (error) {
    console.error('Auth verify error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ========================================
// ONE-TIME TOKEN SYSTEM (Temporary Access Codes)
// ========================================

// Public: Validate a one-time token (rate-limited like auth)
app.post('/api/validate-token', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  if (!checkRateLimit(ip, 10)) {
    return res.status(429).json({ valid: false, message: 'Too many attempts. Please try again later.' });
  }

  recordAttempt(ip);

  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ valid: false, message: 'Token is required' });
  }

  try {
    const { data, error } = await supabase
      .rpc('validate_and_use_token', {
        p_token: token.toUpperCase().trim(),
        p_ip: ip
      });

    if (error) throw error;

    if (data && data.length > 0) {
      const result = data[0];
      if (result.valid) {
        clearRateLimit(ip);
        console.log(`Token auth success: ${token.toUpperCase().trim()} from ${ip}`);
      } else {
        console.log(`Token auth failed: ${token.toUpperCase().trim()} from ${ip} — ${result.message}`);
      }
      return res.json({
        valid: result.valid,
        message: result.message,
        customerName: result.customer_name
      });
    }

    return res.json({ valid: false, message: 'Invalid token' });

  } catch (error) {
    console.error('Token validation error:', error);
    return res.status(500).json({ valid: false, message: 'Server error' });
  }
});

// Admin: Generate a new token
app.post('/api/admin/tokens/generate', authenticateAdmin, async (req, res) => {
  const { customerName, customerEmail, expiresHours = 72, notes } = req.body;

  try {
    const { data, error } = await supabase
      .rpc('generate_catalog_token', {
        p_customer_name: sanitize(customerName) || null,
        p_customer_email: sanitize(customerEmail) || null,
        p_expires_hours: Math.min(Math.max(parseInt(expiresHours) || 72, 1), 8760), // 1 hour to 1 year
        p_notes: sanitize(notes) || null
      });

    if (error) throw error;

    if (data && data.length > 0) {
      await auditLog('TOKEN_GENERATED', req.admin.id, {
        token: data[0].token,
        customer: customerName || 'anonymous',
        expiresAt: data[0].expires_at
      });
      return res.json({
        success: true,
        token: data[0].token,
        expiresAt: data[0].expires_at
      });
    }

    return res.status(500).json({ error: 'Failed to generate token' });

  } catch (error) {
    console.error('Token generation error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Admin: List all tokens
app.get('/api/admin/tokens', authenticateAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('token_status')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return res.json({ tokens: data || [] });

  } catch (error) {
    console.error('Token list error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Revoke a token
app.post('/api/admin/tokens/revoke', authenticateAdmin, async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const { error } = await supabase
      .from('catalog_tokens')
      .update({ is_active: false })
      .eq('token', token.toUpperCase().trim());

    if (error) throw error;

    await auditLog('TOKEN_REVOKED', req.admin.id, { token: token.toUpperCase().trim() });

    return res.json({ success: true, message: 'Token revoked' });

  } catch (error) {
    console.error('Token revoke error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ========================================
// CUSTOMER ORDERS
// ========================================

// Submit order (updated to include sale_id)
app.post('/api/orders', async (req, res) => {
  try {
    const rawShopName = req.body.shopName;
    const rawContactName = req.body.contactName;
    const rawPhone = req.body.phone;
    const rawEmail = req.body.email;
    const rawAddress = req.body.address;
    const rawBranch = req.body.branch;
    const items = req.body.items;
    const total = req.body.total;
    const sale_id = req.body.sale_id;
    const rawOrderNotes = req.body.orderNotes || req.body.notes;

    if (!rawShopName || !rawEmail || !rawBranch || !items || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Sanitize text inputs
    const shopName = sanitize(rawShopName);
    const contactName = rawContactName ? sanitize(rawContactName) : '';
    const phone = rawPhone ? sanitize(rawPhone) : '';
    const email = sanitize(rawEmail);
    const address = rawAddress ? sanitize(rawAddress) : '';
    const branch = sanitize(rawBranch);

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!BRANCH_EMAILS[branch]) {
      return res.status(400).json({ error: 'Invalid branch' });
    }

    // Validate items array
    if (!Array.isArray(items) || items.length > 500) {
      return res.status(400).json({ error: 'Invalid items list' });
    }

    // Sanitize order notes
    const orderNotes = rawOrderNotes ? sanitize(String(rawOrderNotes)).substring(0, 1000) : '';

    // Sanitize each item (supports new formattedItems structure from frontend)
    const sanitizedItems = items.map(item => ({
      sku: sanitize(String(item.sku || '')),
      name: sanitize(String(item.name || '')),
      quantity: Math.max(1, Math.min(9999, parseInt(item.quantity) || 1)),
      salePrice: parseFloat(item.unitPrice || item.salePrice) || 0,
      lineTotal: parseFloat(item.lineTotal) || null,
      paidUnits: parseInt(item.paidUnits) || null,
      freeUnits: parseInt(item.freeUnits) || 0,
      brand: sanitize(String(item.brand || '')),
      caseQty: Math.max(1, parseInt(item.caseQty) || 1),
      promoMessage: (item.promo || item.promoMessage) ? sanitize(String(item.promo || item.promoMessage)).substring(0, 200) : null
    }));

    const orderCode = `ORD-${Date.now().toString(36).toUpperCase()}`;

    const orderData = {
      order_code: orderCode,
      shop_name: shopName,
      contact_name: contactName,
      phone,
      email,
      address,
      branch,
      items: sanitizedItems,
      total: parseFloat(total),
      status: 'pending',
      notes: orderNotes || null
    };

    if (sale_id) orderData.sale_id = sale_id;

    const { data, error } = await supabase
      .from('orders')
      .insert(orderData)
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to save order' });
    }

    console.log('Order saved:', data.order_code);

    if (transporter) {
      sendOrderEmail(data).catch(err => {
        console.error('Email send failed:', err.message);
      });
    }

    res.json({
      success: true,
      orderId: data.order_code,
      message: `Order submitted successfully to ${branch} branch`
    });
  } catch (error) {
    console.error('Order submission error:', error);
    res.status(500).json({ error: 'Failed to submit order' });
  }
});

// ========================================
// EMAIL HELPERS
// ========================================
async function sendOrderEmail(order) {
  const branchEmail = BRANCH_EMAILS[order.branch];
  if (!branchEmail) return;

  // Build plain text items with promo info
  const itemsText = order.items.map(item => {
    const lineTotal = item.lineTotal ? parseFloat(item.lineTotal).toFixed(2) : (parseFloat(item.salePrice) * item.quantity).toFixed(2);
    let line = `${item.sku} - ${item.name}\n    $${parseFloat(item.salePrice).toFixed(2)}/ea | Qty: ${item.quantity}`;
    if (item.paidUnits && item.paidUnits < item.quantity) {
      line += ` (Pay for ${item.paidUnits}, ${item.freeUnits || 0} FREE)`;
    }
    line += ` | Total: $${lineTotal}`;
    if (item.promoMessage) line += `\n    *** PROMO: ${item.promoMessage} ***`;
    return line;
  }).join('\n\n');

  const notesText = order.notes ? `\n\n--- CUSTOMER NOTES ---\n${order.notes}\n----------------------` : '';

  // Build HTML item rows with promo info
  const itemRowsHtml = order.items.map(item => {
    const lineTotal = item.lineTotal ? parseFloat(item.lineTotal).toFixed(2) : (parseFloat(item.salePrice) * item.quantity).toFixed(2);
    let qtyDisplay = `${item.quantity}`;
    if (item.paidUnits && item.paidUnits < item.quantity) {
      qtyDisplay += `<br><span style="font-size: 11px; color: #64748b;">pay ${item.paidUnits}, ${item.freeUnits || 0} free</span>`;
    }
    let promoHtml = '';
    if (item.promoMessage) {
      promoHtml = `<tr><td colspan="5" style="padding: 2px 8px 8px; font-size: 11px; color: #f97316; font-weight: bold;">&#9733; ${item.promoMessage}</td></tr>`;
    }
    return `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 8px; font-family: monospace; color: #2563eb; font-size: 13px;">${item.sku}</td>
        <td style="padding: 8px; font-size: 13px;">${item.name}</td>
        <td style="padding: 8px; text-align: right;">$${parseFloat(item.salePrice).toFixed(2)}</td>
        <td style="padding: 8px; text-align: center;">${qtyDisplay}</td>
        <td style="padding: 8px; text-align: right; font-weight: bold; color: #16a34a;">$${lineTotal}</td>
      </tr>
      ${promoHtml}`;
  }).join('');

  const notesHtml = order.notes ? `
    <div style="background: #fffbeb; border: 1px solid #fbbf24; padding: 12px 16px; border-radius: 8px; margin-top: 16px;">
      <p style="margin: 0 0 4px; font-weight: bold; color: #92400e; font-size: 13px;">Customer Notes:</p>
      <p style="margin: 0; color: #78350f; font-size: 13px;">${order.notes.replace(/\n/g, '<br>')}</p>
    </div>` : '';

  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: branchEmail,
    cc: order.email,
    subject: `New Warehouse Sale Order - ${order.order_code} from ${order.shop_name}`,
    text: `
New Warehouse Sale Order
========================

Order ID: ${order.order_code}
Shop Name: ${order.shop_name}${order.contact_name ? `\nContact: ${order.contact_name}` : ''}${order.phone ? `\nPhone: ${order.phone}` : ''}
Contact Email: ${order.email}${order.address ? `\nAddress: ${order.address}` : ''}
Branch: ${order.branch}
Date: ${new Date(order.created_at).toLocaleString()}

Items Ordered:
${itemsText}${notesText}

Order Total: $${parseFloat(order.total).toFixed(2)}

This order was submitted via the CHC Paint Warehouse Sale catalog.
    `.trim(),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1e293b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; font-size: 20px;">New Warehouse Sale Order</h1>
          <p style="margin: 5px 0 0; color: #94a3b8; font-size: 14px;">CHC Paint Warehouse Sale 2026</p>
        </div>
        <div style="border: 1px solid #e2e8f0; padding: 20px; border-radius: 0 0 8px 8px;">
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
            <tr><td style="padding: 8px 0; color: #64748b; width: 140px;">Order ID</td><td style="padding: 8px 0; font-weight: bold;">${order.order_code}</td></tr>
            <tr><td style="padding: 8px 0; color: #64748b;">Shop Name</td><td style="padding: 8px 0; font-weight: bold;">${order.shop_name}</td></tr>
            ${order.contact_name ? `<tr><td style="padding: 8px 0; color: #64748b;">Contact Name</td><td style="padding: 8px 0;">${order.contact_name}</td></tr>` : ''}
            ${order.phone ? `<tr><td style="padding: 8px 0; color: #64748b;">Phone</td><td style="padding: 8px 0;">${order.phone}</td></tr>` : ''}
            <tr><td style="padding: 8px 0; color: #64748b;">Contact Email</td><td style="padding: 8px 0;">${order.email}</td></tr>
            ${order.address ? `<tr><td style="padding: 8px 0; color: #64748b;">Address</td><td style="padding: 8px 0;">${order.address}</td></tr>` : ''}
            <tr><td style="padding: 8px 0; color: #64748b;">Branch</td><td style="padding: 8px 0; font-weight: bold;">${order.branch}</td></tr>
            <tr><td style="padding: 8px 0; color: #64748b;">Date</td><td style="padding: 8px 0;">${new Date(order.created_at).toLocaleString()}</td></tr>
          </table>
          <h3 style="border-bottom: 2px solid #f97316; padding-bottom: 8px; color: #1e293b;">Items Ordered</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: #f8fafc;">
                <th style="text-align: left; padding: 8px; font-size: 12px; color: #64748b;">SKU</th>
                <th style="text-align: left; padding: 8px; font-size: 12px; color: #64748b;">Product</th>
                <th style="text-align: right; padding: 8px; font-size: 12px; color: #64748b;">Unit Price</th>
                <th style="text-align: center; padding: 8px; font-size: 12px; color: #64748b;">Qty</th>
                <th style="text-align: right; padding: 8px; font-size: 12px; color: #64748b;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${itemRowsHtml}
            </tbody>
          </table>
          ${notesHtml}
          <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin-top: 16px; text-align: right;">
            <span style="font-size: 18px; font-weight: bold; color: #16a34a;">Order Total: $${parseFloat(order.total).toFixed(2)}</span>
          </div>
          <p style="margin-top: 12px; color: #64748b; font-size: 12px;">* Prices quoted before Ontario HST</p>
          <p style="margin-top: 8px; color: #94a3b8; font-size: 12px; text-align: center;">
            This order was submitted via the CHC Paint Warehouse Sale catalog.
          </p>
        </div>
      </div>
    `
  };

  const result = await transporter.sendMail(mailOptions);
  console.log(`Order email sent to ${branchEmail} for ${order.order_code}`);
  return result;
}

async function sendStatusUpdateEmail(order) {
  const statusLabels = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled'
  };

  const statusColors = {
    pending: '#f59e0b',
    confirmed: '#16a34a',
    shipped: '#2563eb',
    delivered: '#16a34a',
    cancelled: '#dc2626'
  };

  const statusLabel = statusLabels[order.status] || order.status;
  const statusColor = statusColors[order.status] || '#16a34a';

  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: order.email,
    subject: `Order ${order.order_code} — Status Update: ${statusLabel}`,
    text: `
Your order status has been updated.

Order ID: ${order.order_code}
Shop Name: ${order.shop_name}
New Status: ${statusLabel}
Branch: ${order.branch}
Order Total: $${parseFloat(order.total).toFixed(2)}

If you have any questions, contact your CHC Paint ${order.branch} branch.
    `.trim(),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1e293b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; font-size: 20px;">Order Status Update</h1>
          <p style="margin: 5px 0 0; color: #94a3b8; font-size: 14px;">CHC Paint Warehouse Sale 2026</p>
        </div>
        <div style="border: 1px solid #e2e8f0; padding: 20px; border-radius: 0 0 8px 8px;">
          <p style="color: #334155;">Your order <strong>${order.order_code}</strong> has been updated:</p>
          <div style="background: ${statusColor}15; border: 2px solid ${statusColor}; padding: 16px; border-radius: 8px; text-align: center; margin: 16px 0;">
            <span style="font-size: 24px; font-weight: bold; color: ${statusColor};">${statusLabel}</span>
          </div>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr><td style="padding: 6px 0; color: #64748b; width: 120px;">Order ID</td><td style="padding: 6px 0; font-weight: bold;">${order.order_code}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;">Shop Name</td><td style="padding: 6px 0;">${order.shop_name}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;">Branch</td><td style="padding: 6px 0;">${order.branch}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;">Order Total</td><td style="padding: 6px 0; font-weight: bold; color: #16a34a;">$${parseFloat(order.total).toFixed(2)}</td></tr>
          </table>
          <p style="color: #64748b; font-size: 14px; margin-top: 16px;">If you have any questions, contact your CHC Paint ${order.branch} branch.</p>
          <p style="margin-top: 16px; color: #94a3b8; font-size: 12px; text-align: center;">
            CHC Paint Warehouse Sale catalog
          </p>
        </div>
      </div>
    `
  };

  const result = await transporter.sendMail(mailOptions);
  console.log(`Status email sent to ${order.email} for ${order.order_code}`);
  return result;
}

// ========================================
// HEALTH / DIAGNOSTIC ENDPOINT
// ========================================
app.get('/api/health', async (req, res) => {
  const checks = {
    server: 'ok',
    supabase_url: supabaseUrl ? 'configured' : 'MISSING',
    supabase_key_length: supabaseServiceKey?.length || 0,
    supabase_key_prefix: supabaseServiceKey?.substring(0, 10) || 'MISSING',
    jwt_secret: JWT_SECRET !== 'change-this-in-production' ? 'configured' : 'using default (insecure)',
    email: transporter ? 'configured' : 'not configured',
    tables: {}
  };

  // Test Supabase connectivity via raw HTTP
  const tables = ['admin_users', 'sales', 'products', 'orders'];
  for (const table of tables) {
    try {
      const url = `${supabaseUrl}/rest/v1/${table}?select=count&limit=0`;
      const response = await fetch(url, {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Prefer': 'count=exact'
        }
      });

      if (response.ok) {
        const range = response.headers.get('content-range');
        const match = range?.match(/\/(\d+)/);
        const count = match ? parseInt(match[1]) : 0;
        checks.tables[table] = `ok (${count} rows)`;
      } else {
        const body = await response.text();
        checks.tables[table] = `HTTP ${response.status}: ${body.substring(0, 100)}`;
      }
    } catch (e) {
      checks.tables[table] = `FETCH ERROR: ${e.message}`;
    }
  }

  checks.supabase_connection = checks.tables.orders?.startsWith('ok') ? 'ok' : 'ERROR';
  res.json(checks);
});

// ========================================
// AUTO-BOOTSTRAP: Create first admin on startup
// ========================================
async function bootstrapAdmin() {
  try {
    console.log('=== STARTUP DIAGNOSTICS ===');
    console.log('Supabase URL:', supabaseUrl);
    console.log('Service key length:', supabaseServiceKey?.length);
    console.log('Service key starts with:', supabaseServiceKey?.substring(0, 20) + '...');

    // Step 1: Test raw HTTP connection to Supabase
    console.log('Testing raw HTTP connection to Supabase...');
    try {
      const testUrl = `${supabaseUrl}/rest/v1/orders?select=count&limit=0`;
      const testRes = await fetch(testUrl, {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'count=exact'
        }
      });
      console.log('Raw HTTP test - Status:', testRes.status, testRes.statusText);
      if (!testRes.ok) {
        const body = await testRes.text();
        console.error('Raw HTTP test - Body:', body);
        console.error('This likely means your SUPABASE_SERVICE_KEY is wrong.');
        console.error('Go to Supabase Dashboard > Settings > API > service_role key');
        return;
      } else {
        console.log('Raw HTTP connection to Supabase: OK');
      }
    } catch (fetchErr) {
      console.error('Raw HTTP fetch failed:', fetchErr.message);
      console.error('Cannot reach Supabase at all. Check SUPABASE_URL.');
      return;
    }

    // Step 2: Check if admin_users table exists via raw HTTP
    console.log('Checking admin_users table via raw HTTP...');
    try {
      const adminUrl = `${supabaseUrl}/rest/v1/admin_users?select=count&limit=0`;
      const adminRes = await fetch(adminUrl, {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'count=exact'
        }
      });
      console.log('admin_users HTTP status:', adminRes.status);

      if (adminRes.status === 404 || adminRes.status === 406) {
        const body = await adminRes.text();
        console.error('admin_users table does NOT exist:', body);
        console.log('Please run the migration SQL in Supabase SQL Editor.');
        return;
      }

      if (!adminRes.ok) {
        const body = await adminRes.text();
        console.error('admin_users table error:', adminRes.status, body);
        return;
      }

      const contentRange = adminRes.headers.get('content-range');
      console.log('admin_users content-range:', contentRange);
      // content-range looks like "0-0/0" or "*/0" for empty table
      const totalMatch = contentRange?.match(/\/(\d+)/);
      const totalCount = totalMatch ? parseInt(totalMatch[1]) : 0;
      console.log('admin_users count:', totalCount);

      if (totalCount > 0) {
        console.log(`Found ${totalCount} admin user(s) — skipping bootstrap.`);
        return;
      }
    } catch (fetchErr) {
      console.error('admin_users check failed:', fetchErr.message);
      return;
    }

    // Step 3: No admins exist — create the default super admin
    const defaultEmail = process.env.ADMIN_EMAIL || 'adamberube@me.com';
    const defaultPassword = process.env.ADMIN_PASSWORD || 'CHCadmin2026!';
    const defaultName = process.env.ADMIN_NAME || 'Adam Berube';

    console.log(`No admins found. Creating default super admin: ${defaultEmail}`);

    const passwordHash = await bcrypt.hash(defaultPassword, BCRYPT_ROUNDS);

    // Use raw HTTP to insert (bypasses any client issues)
    try {
      const insertUrl = `${supabaseUrl}/rest/v1/admin_users`;
      const insertRes = await fetch(insertUrl, {
        method: 'POST',
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          email: defaultEmail.toLowerCase(),
          password_hash: passwordHash,
          role: 'super_admin',
          name: defaultName,
          is_active: true
        })
      });

      console.log('Insert admin HTTP status:', insertRes.status);

      if (!insertRes.ok) {
        const body = await insertRes.text();
        console.error('Failed to insert admin:', insertRes.status, body);
        return;
      }

      const newAdmin = await insertRes.json();
      console.log('=================================================');
      console.log('DEFAULT ADMIN CREATED SUCCESSFULLY');
      console.log(`  Email:    ${defaultEmail}`);
      console.log(`  Password: ${defaultPassword}`);
      console.log(`  Role:     super_admin`);
      console.log('  CHANGE THIS PASSWORD AFTER FIRST LOGIN!');
      console.log('=================================================');
    } catch (insertErr) {
      console.error('Insert fetch failed:', insertErr.message);
    }
  } catch (err) {
    console.error('Bootstrap error:', err.message);
    console.error('Full stack:', err.stack);
  }
}

// ========================================
// AUTO-BOOTSTRAP: Create default sale + products on startup
// ========================================
async function bootstrapSale() {
  try {
    // Check if any sales exist
    const salesUrl = `${supabaseUrl}/rest/v1/sales?select=count&limit=0`;
    const salesRes = await fetch(salesUrl, {
      headers: {
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Prefer': 'count=exact'
      }
    });

    if (!salesRes.ok) {
      console.log('Cannot check sales table — skipping sale bootstrap.');
      return;
    }

    const range = salesRes.headers.get('content-range');
    const match = range?.match(/\/(\d+)/);
    const salesCount = match ? parseInt(match[1]) : 0;

    // Get or create default sale
    let saleId;

    if (salesCount > 0) {
      console.log(`Found ${salesCount} sale(s). Checking for product updates...`);
      // Get the first active sale's ID for product refresh
      const getSaleRes = await fetch(`${supabaseUrl}/rest/v1/sales?status=eq.active&limit=1`, {
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      });
      if (getSaleRes.ok) {
        const sales = await getSaleRes.json();
        if (sales.length > 0) saleId = sales[0].id;
      }
    } else {
      console.log('No sales found. Creating default Warehouse Sale 2026...');

      const salePassword = process.env.SALE_PASSWORD || 'CHC2026!';
      const saleHash = await bcrypt.hash(salePassword, BCRYPT_ROUNDS);

      const createSaleRes = await fetch(`${supabaseUrl}/rest/v1/sales`, {
        method: 'POST',
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          name: 'Warehouse Sale 2026',
          slug: 'warehouse-2026',
          description: 'CHC Paint Annual Warehouse Sale — Exclusive dealer pricing on premium brands.',
          password_hash: saleHash,
          status: 'active',
          start_date: new Date().toISOString(),
          end_date: null
        })
      });

      if (!createSaleRes.ok) {
        const body = await createSaleRes.text();
        console.error('Failed to create default sale:', createSaleRes.status, body);
        return;
      }

      const saleData = await createSaleRes.json();
      saleId = Array.isArray(saleData) ? saleData[0].id : saleData.id;
      console.log(`Default sale created: ${saleId}`);
    }

    if (!saleId) {
      console.log('No active sale found — skipping product load.');
      return;
    }

    // Load products from CSV file (v2 with case_qty)
    const csvPath = path.join(__dirname, 'warehouse-sale-2026-products-v2.csv');
    const fs = require('fs');

    if (!fs.existsSync(csvPath)) {
      console.log('No products CSV found at', csvPath);
      return;
    }

    // Check current product count for this sale
    const prodCountRes = await fetch(`${supabaseUrl}/rest/v1/products?sale_id=eq.${saleId}&select=count&limit=0`, {
      headers: {
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Prefer': 'count=exact'
      }
    });
    const prodRange = prodCountRes.headers.get('content-range');
    const prodMatch = prodRange?.match(/\/(\d+)/);
    const currentProductCount = prodMatch ? parseInt(prodMatch[1]) : 0;

    console.log(`Current products in sale: ${currentProductCount}`);

    console.log('Loading products from CSV v2...');
    const products = [];

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(csvPath);
      stream
        .pipe(csv())
        .on('data', (row) => {
          const prevPrice = parseFloat(row.previous_price);
          const salePrice = parseFloat(row.sale_price);

          if (row.sku && row.brand && row.name && !isNaN(prevPrice) && !isNaN(salePrice)) {
            products.push({
              sale_id: saleId,
              sku: row.sku.trim(),
              brand: row.brand.trim(),
              category: (row.category || '').trim(),
              name: row.name.trim(),
              previous_price: prevPrice,
              sale_price: salePrice,
              promo: row.promo?.trim() || null,
              case_qty: parseInt(row.case_qty) || 1
            });
          }
        })
        .on('end', resolve)
        .on('error', reject);
    });

    console.log(`Parsed ${products.length} products from CSV.`);

    // Skip if product count matches (already loaded)
    if (currentProductCount >= products.length) {
      console.log(`Products already loaded (${currentProductCount} >= ${products.length}) — skipping.`);
      return;
    }

    // Delete old products for this sale and reload
    if (currentProductCount > 0) {
      console.log(`Clearing ${currentProductCount} old products...`);
      await fetch(`${supabaseUrl}/rest/v1/products?sale_id=eq.${saleId}`, {
        method: 'DELETE',
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        }
      });
    }

    // Insert products in batches of 100
    let inserted = 0;
    for (let i = 0; i < products.length; i += 100) {
      const batch = products.slice(i, i + 100);
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/products`, {
        method: 'POST',
        headers: {
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(batch)
      });

      if (insertRes.ok) {
        inserted += batch.length;
      } else {
        const body = await insertRes.text();
        console.error(`Product batch insert failed:`, insertRes.status, body);
      }
    }

    console.log('=================================================');
    console.log('PRODUCTS LOADED SUCCESSFULLY');
    console.log(`  Sale:     Warehouse Sale 2026`);
    console.log(`  Products: ${inserted} loaded (was ${currentProductCount})`);
    console.log(`  Status:   ACTIVE`);
    console.log('=================================================');
  } catch (err) {
    console.error('Sale bootstrap error:', err.message);
  }
}

// ========================================
// GLOBAL ERROR HANDLER
// ========================================
app.use((err, req, res, next) => {
  // Handle Multer errors (file upload)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum 10MB.' });
  }
  if (err.message === 'Only CSV and Excel files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ========================================
// SERVE THE APP
// ========================================

// Admin panel route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// Customer app (catch-all)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`CHC Warehouse Sale server running on port ${PORT}`);
  console.log(`Customer app: http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log(`Supabase connected: ${supabaseUrl}`);
  console.log(`Email notifications: ${transporter ? 'enabled' : 'disabled'}`);

  // Auto-bootstrap first admin, then default sale + products
  await bootstrapAdmin();
  await bootstrapSale();
});
