const express = require('express');
const bcrypt = require('bcrypt');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const fs = require('fs');
const fspath = require('path');
const { Readable } = require('stream');
const { supabaseAdmin } = require('../utils/supabase');
const { requireAdminAuth, requireSuperAdmin, requireCompanyAccess } = require('../middleware/auth');
const { catalogUpload, logoUpload } = require('../middleware/upload');
const { stripHtml, sanitizeObject, generateSlug, validateEmail, isValidUUID } = require('../utils/sanitize');

const router = express.Router();

// All admin routes require admin authentication
router.use(requireAdminAuth);

// ============================================================
// DASHBOARD STATS
// ============================================================

/**
 * GET /api/admin/stats
 */
router.get('/stats', async (req, res) => {
    try {
        const isSuper = req.admin.role === 'super_admin';
        const companyFilter = isSuper ? {} : { company_id: req.admin.company_id };

        let companiesQuery = supabaseAdmin.from('companies').select('id', { count: 'exact', head: true });
        if (!isSuper) companiesQuery = companiesQuery.eq('id', req.admin.company_id);
        const { count: totalCompanies } = await companiesQuery;

        let productsQuery = supabaseAdmin.from('products').select('id', { count: 'exact', head: true });
        if (!isSuper) productsQuery = productsQuery.eq('company_id', req.admin.company_id);
        const { count: totalProducts } = await productsQuery;

        const now = new Date().toISOString();
        let activePromos = 0;
        if (isSuper) {
            const { count } = await supabaseAdmin.from('promotions').select('id', { count: 'exact', head: true })
                .eq('is_active', true).lte('starts_at', now).gte('ends_at', now);
            activePromos = count;
        } else {
            // Separate queries to avoid .or() interpolation
            const { count: companyCount } = await supabaseAdmin.from('promotions').select('id', { count: 'exact', head: true })
                .eq('is_active', true).lte('starts_at', now).gte('ends_at', now).eq('company_id', req.admin.company_id);
            const { count: globalCount } = await supabaseAdmin.from('promotions').select('id', { count: 'exact', head: true })
                .eq('is_active', true).lte('starts_at', now).gte('ends_at', now).is('company_id', null);
            activePromos = (companyCount || 0) + (globalCount || 0);
        }

        // Orders this month
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        let ordersQuery = supabaseAdmin.from('orders').select('id, total', { count: 'exact' })
            .gte('created_at', monthStart.toISOString());
        if (!isSuper) ordersQuery = ordersQuery.eq('company_id', req.admin.company_id);
        const { data: monthOrders, count: ordersThisMonth } = await ordersQuery;

        const monthRevenue = (monthOrders || []).reduce((sum, o) => sum + parseFloat(o.total || 0), 0);

        res.json({
            total_companies: totalCompanies || 0,
            total_products: totalProducts || 0,
            active_promotions: activePromos || 0,
            orders_this_month: ordersThisMonth || 0,
            revenue_this_month: monthRevenue.toFixed(2)
        });

    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to load stats.' });
    }
});

// ============================================================
// COMPANY MANAGEMENT (Super Admin)
// ============================================================

/**
 * GET /api/admin/companies
 */
router.get('/companies', async (req, res) => {
    try {
        let query = supabaseAdmin
            .from('companies')
            .select('id, name, slug, logo_url, contact_email, is_active, created_at, updated_at')
            .order('name');

        if (req.admin.role !== 'super_admin') {
            query = query.eq('id', req.admin.company_id);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({ companies: data || [] });
    } catch (err) {
        console.error('Companies list error:', err);
        res.status(500).json({ error: 'Failed to load companies.' });
    }
});

/**
 * POST /api/admin/companies
 */
router.post('/companies', requireSuperAdmin, async (req, res) => {
    try {
        const { name, contact_email, contact_phone, address, access_code, email_config, settings } = sanitizeObject(req.body);

        if (!name || !access_code) {
            return res.status(400).json({ error: 'Company name and access code are required.' });
        }

        const slug = generateSlug(name);

        // Check slug uniqueness
        const { data: existing } = await supabaseAdmin
            .from('companies')
            .select('id')
            .eq('slug', slug)
            .single();

        if (existing) {
            return res.status(409).json({ error: 'A company with a similar name already exists.' });
        }

        const hashedCode = await bcrypt.hash(access_code, 12);

        const { data: company, error } = await supabaseAdmin
            .from('companies')
            .insert({
                name,
                slug,
                access_code: hashedCode,
                contact_email: contact_email || null,
                contact_phone: contact_phone || null,
                address: address || null,
                email_config: email_config || {},
                settings: settings || {},
                is_active: true
            })
            .select()
            .single();

        if (error) throw error;

        // Log action
        await logAction(req.admin.id, 'company_created', 'company', company.id, { name }, req.ip);

        res.status(201).json({
            company: { ...company, access_code: undefined },
            access_code_set: true,
            store_url: `/store/${slug}`
        });

    } catch (err) {
        console.error('Create company error:', err);
        res.status(500).json({ error: 'Failed to create company.' });
    }
});

/**
 * PUT /api/admin/companies/:companyId
 */
router.put('/companies/:companyId', requireCompanyAccess, async (req, res) => {
    try {
        const { companyId } = req.params;
        const updates = sanitizeObject(req.body);
        const allowedFields = ['name', 'contact_email', 'contact_phone', 'address', 'email_config', 'settings', 'is_active'];

        const filtered = {};
        for (const key of allowedFields) {
            if (updates[key] !== undefined) filtered[key] = updates[key];
        }

        // If updating access code, hash it
        if (updates.access_code) {
            filtered.access_code = await bcrypt.hash(updates.access_code, 12);
        }

        // If updating name, update slug too
        if (filtered.name) {
            filtered.slug = generateSlug(filtered.name);
        }

        const { data, error } = await supabaseAdmin
            .from('companies')
            .update(filtered)
            .eq('id', companyId)
            .select('id, name, slug, logo_url, contact_email, is_active')
            .single();

        if (error) throw error;

        await logAction(req.admin.id, 'company_updated', 'company', companyId, filtered, req.ip);

        res.json({ company: data });

    } catch (err) {
        console.error('Update company error:', err);
        res.status(500).json({ error: 'Failed to update company.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/logo
 */
router.post('/companies/:companyId/logo', requireCompanyAccess, logoUpload.single('logo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No logo file provided.' });
        }

        const { companyId } = req.params;
        const ext = req.file.originalname.split('.').pop().toLowerCase();
        const filePath = `company-logos/${companyId}/logo.${ext}`;

        // Upload to Supabase Storage
        const { error: uploadError } = await supabaseAdmin.storage
            .from('company-logos')
            .upload(filePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true
            });

        if (uploadError) throw uploadError;

        // Get public URL
        const { data: urlData } = supabaseAdmin.storage
            .from('company-logos')
            .getPublicUrl(filePath);

        // Update company record
        await supabaseAdmin
            .from('companies')
            .update({ logo_url: urlData.publicUrl })
            .eq('id', companyId);

        await logAction(req.admin.id, 'logo_uploaded', 'company', companyId, { filePath }, req.ip);

        res.json({ logo_url: urlData.publicUrl });

    } catch (err) {
        console.error('Logo upload error:', err);
        res.status(500).json({ error: 'Failed to upload logo.' });
    }
});

// ============================================================
// BRANDING (CHC Master Logo)
// ============================================================

/**
 * GET /api/admin/branding/logo
 * Get current master logo info
 */
router.get('/branding/logo', async (req, res) => {
    try {
        const logoPath = fspath.join(__dirname, '..', 'public', 'assets', 'chc-logo.png');
        const exists = fs.existsSync(logoPath);
        const stats = exists ? fs.statSync(logoPath) : null;
        res.json({
            exists,
            url: '/assets/chc-logo.png',
            size: stats ? stats.size : 0,
            updated: stats ? stats.mtime.toISOString() : null
        });
    } catch (err) {
        console.error('Branding logo info error:', err);
        res.status(500).json({ error: 'Failed to get logo info.' });
    }
});

/**
 * POST /api/admin/branding/logo
 * Upload/replace the CHC master logo (super_admin only)
 */
router.post('/branding/logo', requireSuperAdmin, logoUpload.single('logo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No logo file provided.' });
        }

        const assetsDir = fspath.join(__dirname, '..', 'public', 'assets');

        // Ensure assets directory exists
        if (!fs.existsSync(assetsDir)) {
            fs.mkdirSync(assetsDir, { recursive: true });
        }

        // Save as chc-logo.png (overwrite existing)
        const logoPath = fspath.join(assetsDir, 'chc-logo.png');
        fs.writeFileSync(logoPath, req.file.buffer);

        await logAction(req.admin.id, 'master_logo_uploaded', 'branding', null, {
            originalName: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype
        }, req.ip);

        res.json({
            message: 'Master logo updated successfully.',
            url: '/assets/chc-logo.png',
            size: req.file.size
        });

    } catch (err) {
        console.error('Master logo upload error:', err);
        res.status(500).json({ error: 'Failed to upload master logo.' });
    }
});

// ============================================================
// CATALOG / PRODUCT MANAGEMENT
// ============================================================

/**
 * GET /api/admin/companies/:companyId/products
 */
router.get('/companies/:companyId/products', requireCompanyAccess, async (req, res) => {
    try {
        const { page = 1, limit = 100, brand, category, search, includeInactive } = req.query;

        let query = supabaseAdmin
            .from('products')
            .select('*', { count: 'exact' })
            .eq('company_id', req.params.companyId)
            .order('brand')
            .order('name');

        if (!includeInactive) query = query.eq('is_active', true);
        if (brand) query = query.eq('brand', brand);
        if (category) query = query.eq('category', category);
        if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);

        const offset = (parseInt(page) - 1) * parseInt(limit);
        query = query.range(offset, offset + parseInt(limit) - 1);

        const { data, error, count } = await query;
        if (error) throw error;

        res.json({ products: data || [], total: count, page: parseInt(page), limit: parseInt(limit) });

    } catch (err) {
        console.error('Admin products error:', err);
        res.status(500).json({ error: 'Failed to load products.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/products
 * Create a single product
 */
router.post('/companies/:companyId/products', requireCompanyAccess, async (req, res) => {
    try {
        const product = sanitizeObject(req.body);
        product.company_id = req.params.companyId;

        const { data, error } = await supabaseAdmin
            .from('products')
            .insert(product)
            .select()
            .single();

        if (error) throw error;

        await logAction(req.admin.id, 'product_created', 'product', data.id, { name: data.name }, req.ip);
        res.status(201).json({ product: data });

    } catch (err) {
        console.error('Create product error:', err);
        res.status(500).json({ error: 'Failed to create product.' });
    }
});

/**
 * PUT /api/admin/companies/:companyId/products/:productId
 */
router.put('/companies/:companyId/products/:productId', requireCompanyAccess, async (req, res) => {
    try {
        const updates = sanitizeObject(req.body);
        delete updates.id;
        delete updates.company_id;

        const { data, error } = await supabaseAdmin
            .from('products')
            .update(updates)
            .eq('id', req.params.productId)
            .eq('company_id', req.params.companyId)
            .select()
            .single();

        if (error) throw error;

        await logAction(req.admin.id, 'product_updated', 'product', data.id, updates, req.ip);
        res.json({ product: data });

    } catch (err) {
        console.error('Update product error:', err);
        res.status(500).json({ error: 'Failed to update product.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/catalog-upload
 * Bulk upload products via CSV or XLSX
 */
router.post('/companies/:companyId/catalog-upload', requireCompanyAccess, catalogUpload.single('catalog'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No catalog file provided.' });
        }

        const { companyId } = req.params;
        const ext = req.file.originalname.split('.').pop().toLowerCase();

        // Log the upload
        const { data: upload } = await supabaseAdmin
            .from('catalog_uploads')
            .insert({
                company_id: companyId,
                admin_id: req.admin.id,
                filename: req.file.originalname,
                file_type: ext,
                status: 'processing'
            })
            .select()
            .single();

        let rows = [];
        const errors = [];

        // Parse file
        if (ext === 'csv') {
            rows = await parseCSV(req.file.buffer);
        } else if (ext === 'xlsx' || ext === 'xls') {
            rows = parseExcel(req.file.buffer);
        } else {
            return res.status(400).json({ error: 'Unsupported file type for catalog import. Use CSV or XLSX.' });
        }

        if (rows.length === 0) {
            return res.status(400).json({ error: 'No data rows found in the file.' });
        }

        if (rows.length > 10000) {
            return res.status(400).json({ error: 'Maximum 10,000 rows per upload.' });
        }

        // Normalize column headers
        const normalizedRows = rows.map((row, idx) => {
            try {
                return normalizeProductRow(row);
            } catch (e) {
                errors.push({ row: idx + 2, error: e.message });
                return null;
            }
        }).filter(Boolean);

        // Upsert products (by SKU if available, otherwise insert new)
        let inserted = 0, updated = 0;

        for (const row of normalizedRows) {
            row.company_id = companyId;

            if (row.sku) {
                // Try to find existing product by SKU
                const { data: existing } = await supabaseAdmin
                    .from('products')
                    .select('id')
                    .eq('company_id', companyId)
                    .eq('sku', row.sku)
                    .single();

                if (existing) {
                    await supabaseAdmin.from('products').update(row).eq('id', existing.id);
                    updated++;
                } else {
                    await supabaseAdmin.from('products').insert(row);
                    inserted++;
                }
            } else {
                await supabaseAdmin.from('products').insert(row);
                inserted++;
            }
        }

        // Update upload record
        await supabaseAdmin
            .from('catalog_uploads')
            .update({
                row_count: normalizedRows.length,
                status: errors.length > 0 ? 'completed_with_errors' : 'completed',
                error_details: errors
            })
            .eq('id', upload.id);

        await logAction(req.admin.id, 'catalog_uploaded', 'company', companyId, {
            filename: req.file.originalname, inserted, updated, errors: errors.length
        }, req.ip);

        res.json({
            message: 'Catalog upload processed.',
            inserted,
            updated,
            errors: errors.length,
            error_details: errors.slice(0, 20) // Show first 20 errors
        });

    } catch (err) {
        console.error('Catalog upload error:', err);
        res.status(500).json({ error: 'Failed to process catalog upload.' });
    }
});

// ============================================================
// PROMOTIONS MANAGEMENT
// ============================================================

/**
 * GET /api/admin/promotions
 */
router.get('/promotions', async (req, res) => {
    try {
        let query = supabaseAdmin
            .from('promotions')
            .select(`
                *,
                products (id, name, sku, brand, price),
                companies (id, name)
            `)
            .order('created_at', { ascending: false });

        if (req.admin.role !== 'super_admin') {
            // Separate queries to avoid .or() interpolation
            const baseSelect = `*, products (id, name, sku, brand, price), companies (id, name)`;
            const { data: compPromos } = await supabaseAdmin.from('promotions').select(baseSelect)
                .eq('company_id', req.admin.company_id).order('created_at', { ascending: false });
            const { data: globPromos } = await supabaseAdmin.from('promotions').select(baseSelect)
                .is('company_id', null).order('created_at', { ascending: false });
            return res.json({ promotions: [...(compPromos || []), ...(globPromos || [])] });
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({ promotions: data || [] });

    } catch (err) {
        console.error('Promotions list error:', err);
        res.status(500).json({ error: 'Failed to load promotions.' });
    }
});

/**
 * POST /api/admin/promotions
 */
router.post('/promotions', async (req, res) => {
    try {
        const promo = sanitizeObject(req.body);

        if (!promo.product_id || !promo.promo_price || !promo.starts_at || !promo.ends_at) {
            return res.status(400).json({ error: 'Product, promotional price, start date, and end date are required.' });
        }

        // Non-super admins can only create promotions for their own company
        if (req.admin.role !== 'super_admin') {
            promo.company_id = req.admin.company_id;
        }

        const { data, error } = await supabaseAdmin
            .from('promotions')
            .insert({
                company_id: promo.company_id || null, // null = global
                product_id: promo.product_id,
                promo_price: parseFloat(promo.promo_price),
                promo_label: promo.promo_label || null,
                description: promo.description || null,
                starts_at: promo.starts_at,
                ends_at: promo.ends_at,
                is_active: true
            })
            .select(`*, products (id, name, sku, brand, price)`)
            .single();

        if (error) throw error;

        await logAction(req.admin.id, 'promotion_created', 'promotion', data.id, {
            product: promo.product_id, promo_price: promo.promo_price
        }, req.ip);

        res.status(201).json({ promotion: data });

    } catch (err) {
        console.error('Create promotion error:', err);
        res.status(500).json({ error: 'Failed to create promotion.' });
    }
});

/**
 * PUT /api/admin/promotions/:promotionId
 */
router.put('/promotions/:promotionId', async (req, res) => {
    try {
        // Authorization: verify admin has access to this promotion
        const { data: existing } = await supabaseAdmin
            .from('promotions').select('id, company_id').eq('id', req.params.promotionId).single();
        if (!existing) return res.status(404).json({ error: 'Promotion not found.' });
        if (req.admin.role !== 'super_admin' && existing.company_id !== req.admin.company_id) {
            return res.status(403).json({ error: 'Access denied for this promotion.' });
        }

        const updates = sanitizeObject(req.body);
        const allowedFields = ['promo_price', 'promo_label', 'description', 'starts_at', 'ends_at', 'is_active'];
        const filtered = {};
        for (const key of allowedFields) {
            if (updates[key] !== undefined) filtered[key] = updates[key];
        }

        if (filtered.promo_price) filtered.promo_price = parseFloat(filtered.promo_price);

        const { data, error } = await supabaseAdmin
            .from('promotions')
            .update(filtered)
            .eq('id', req.params.promotionId)
            .select()
            .single();

        if (error) throw error;

        await logAction(req.admin.id, 'promotion_updated', 'promotion', data.id, filtered, req.ip);
        res.json({ promotion: data });

    } catch (err) {
        console.error('Update promotion error:', err);
        res.status(500).json({ error: 'Failed to update promotion.' });
    }
});

/**
 * DELETE /api/admin/promotions/:promotionId
 */
router.delete('/promotions/:promotionId', async (req, res) => {
    try {
        // Authorization: verify admin has access to this promotion
        const { data: existing } = await supabaseAdmin
            .from('promotions').select('id, company_id').eq('id', req.params.promotionId).single();
        if (!existing) return res.status(404).json({ error: 'Promotion not found.' });
        if (req.admin.role !== 'super_admin' && existing.company_id !== req.admin.company_id) {
            return res.status(403).json({ error: 'Access denied for this promotion.' });
        }

        const { error } = await supabaseAdmin
            .from('promotions')
            .delete()
            .eq('id', req.params.promotionId);

        if (error) throw error;

        await logAction(req.admin.id, 'promotion_deleted', 'promotion', req.params.promotionId, {}, req.ip);
        res.json({ message: 'Promotion deleted.' });

    } catch (err) {
        console.error('Delete promotion error:', err);
        res.status(500).json({ error: 'Failed to delete promotion.' });
    }
});

// ============================================================
// ORDER MANAGEMENT
// ============================================================

/**
 * GET /api/admin/orders
 */
router.get('/orders', async (req, res) => {
    try {
        const { company_id, status, from_date, to_date, page = 1, limit = 50 } = req.query;

        let query = supabaseAdmin
            .from('orders')
            .select(`*, companies (id, name)`, { count: 'exact' })
            .order('created_at', { ascending: false });

        if (req.admin.role !== 'super_admin') {
            query = query.eq('company_id', req.admin.company_id);
        } else if (company_id) {
            query = query.eq('company_id', company_id);
        }

        if (status) query = query.eq('status', status);
        if (from_date) query = query.gte('created_at', from_date);
        if (to_date) query = query.lte('created_at', to_date);

        const offset = (parseInt(page) - 1) * parseInt(limit);
        query = query.range(offset, offset + parseInt(limit) - 1);

        const { data, error, count } = await query;
        if (error) throw error;

        res.json({ orders: data || [], total: count, page: parseInt(page), limit: parseInt(limit) });

    } catch (err) {
        console.error('Admin orders error:', err);
        res.status(500).json({ error: 'Failed to load orders.' });
    }
});

/**
 * PUT /api/admin/orders/:orderId/status
 */
router.put('/orders/:orderId/status', async (req, res) => {
    try {
        const { status, note } = req.body;
        const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }

        // Get current order
        const { data: order } = await supabaseAdmin
            .from('orders')
            .select('status_history')
            .eq('id', req.params.orderId)
            .single();

        const statusHistory = order?.status_history || [];
        statusHistory.push({
            status,
            timestamp: new Date().toISOString(),
            note: stripHtml(note || ''),
            updated_by: req.admin.email
        });

        const { data, error } = await supabaseAdmin
            .from('orders')
            .update({ status, status_history: statusHistory })
            .eq('id', req.params.orderId)
            .select()
            .single();

        if (error) throw error;

        await logAction(req.admin.id, 'order_status_updated', 'order', data.id, { status, note }, req.ip);
        res.json({ order: data });

    } catch (err) {
        console.error('Order status update error:', err);
        res.status(500).json({ error: 'Failed to update order status.' });
    }
});

// ============================================================
// ADMIN USER MANAGEMENT (Super Admin only)
// ============================================================

/**
 * GET /api/admin/users
 */
router.get('/users', requireSuperAdmin, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('admin_users')
            .select('id, email, name, role, company_id, is_active, last_login, created_at, companies (name)')
            .order('name');

        if (error) throw error;
        res.json({ admins: data || [] });

    } catch (err) {
        console.error('Admin users error:', err);
        res.status(500).json({ error: 'Failed to load admin users.' });
    }
});

/**
 * POST /api/admin/users
 */
router.post('/users', requireSuperAdmin, async (req, res) => {
    try {
        const { email, password, name, role, company_id } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Email, password, and name are required.' });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format.' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const { data, error } = await supabaseAdmin
            .from('admin_users')
            .insert({
                email: email.toLowerCase(),
                password_hash: passwordHash,
                name: stripHtml(name),
                role: role || 'company_admin',
                company_id: company_id || null,
                is_active: true
            })
            .select('id, email, name, role, company_id, is_active')
            .single();

        if (error) {
            if (error.code === '23505') {
                return res.status(409).json({ error: 'An admin with this email already exists.' });
            }
            throw error;
        }

        await logAction(req.admin.id, 'admin_created', 'admin', data.id, { email, role }, req.ip);
        res.status(201).json({ admin: data });

    } catch (err) {
        console.error('Create admin error:', err);
        res.status(500).json({ error: 'Failed to create admin user.' });
    }
});

// ============================================================
// AUDIT LOG
// ============================================================

/**
 * GET /api/admin/audit-log
 */
router.get('/audit-log', requireSuperAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const { data, error, count } = await supabaseAdmin
            .from('audit_log')
            .select(`*, admin_users (name, email)`, { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + parseInt(limit) - 1);

        if (error) throw error;
        res.json({ logs: data || [], total: count, page: parseInt(page) });

    } catch (err) {
        console.error('Audit log error:', err);
        res.status(500).json({ error: 'Failed to load audit log.' });
    }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function logAction(adminId, action, entityType, entityId, details, ip) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: adminId,
            action,
            entity_type: entityType,
            entity_id: entityId,
            details,
            ip_address: ip
        });
    } catch (err) {
        console.error('Audit log write failed:', err);
    }
}

function parseCSV(buffer) {
    return new Promise((resolve, reject) => {
        const rows = [];
        const stream = Readable.from(buffer.toString());
        stream
            .pipe(csv())
            .on('data', row => rows.push(row))
            .on('end', () => resolve(rows))
            .on('error', reject);
    });
}

function parseExcel(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet);
}

function normalizeProductRow(row) {
    // Flexible column name mapping
    const mappings = {
        brand: ['brand', 'manufacturer', 'mfg', 'make'],
        name: ['name', 'product', 'product_name', 'productname', 'description', 'item'],
        sku: ['sku', 'item_number', 'itemnumber', 'item_no', 'part_number', 'partnumber', 'part_no', 'upc'],
        description: ['description', 'desc', 'details', 'product_description'],
        category: ['category', 'cat', 'type', 'product_type', 'group'],
        price: ['price', 'sale_price', 'saleprice', 'unit_price', 'cost'],
        previous_price: ['previous_price', 'previousprice', 'regular_price', 'regularprice', 'msrp', 'list_price', 'listprice', 'was_price'],
        case_qty: ['case_qty', 'caseqty', 'case_quantity', 'casequantity', 'qty_per_case', 'pack_size', 'packsize'],
        unit: ['unit', 'uom', 'unit_of_measure'],
        image_url: ['image_url', 'imageurl', 'image', 'photo', 'picture']
    };

    const normalized = {};
    const lowerRow = {};
    for (const [key, val] of Object.entries(row)) {
        lowerRow[key.toLowerCase().trim().replace(/\s+/g, '_')] = val;
    }

    for (const [field, aliases] of Object.entries(mappings)) {
        for (const alias of aliases) {
            if (lowerRow[alias] !== undefined && lowerRow[alias] !== '') {
                normalized[field] = lowerRow[alias];
                break;
            }
        }
    }

    // Validate required fields
    if (!normalized.name) throw new Error('Missing product name');
    if (!normalized.brand) normalized.brand = 'Uncategorized';
    if (!normalized.price || isNaN(parseFloat(normalized.price))) throw new Error('Invalid or missing price');

    // Type conversions
    normalized.price = parseFloat(normalized.price);
    if (normalized.previous_price) normalized.previous_price = parseFloat(normalized.previous_price);
    if (normalized.case_qty) normalized.case_qty = parseInt(normalized.case_qty) || 1;
    normalized.is_active = true;

    return normalized;
}

module.exports = router;
