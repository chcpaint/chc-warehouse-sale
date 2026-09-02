const express = require('express');
const bcrypt = require('bcrypt');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const { Readable } = require('stream');
const { supabaseAdmin } = require('../utils/supabase');
const { requireAdminAuth, requireSuperAdmin, requireCompanyAccess, requireFullAdmin, restrictOrderDesk, requirePasswordCurrent, requireOrderAccess } = require('../middleware/auth');
const { catalogUpload, logoUpload, invoiceUpload } = require('../middleware/upload');
const { stripHtml, sanitizeObject, generateSlug, validateEmail, isValidUUID } = require('../utils/sanitize');
const { resolveOrderRecipients } = require('../utils/recipients');
const { sendInvoiceReady, sendOrderClosed } = require('../utils/email');
const { orderScopeIds, applyOrderScope, orderInScope } = require('../utils/order-scope');

const router = express.Router();

// All admin routes require admin authentication
router.use(requireAdminAuth);

// Order-desk accounts are fenced to order-management endpoints only. This runs
// before every route below, so isolation holds even if a request bypasses the
// UI. Full admins pass straight through.
router.use(restrictOrderDesk);

// An account still on a password somebody else chose reaches nothing but
// whoami and the password change itself, whatever its role.
router.use(requirePasswordCurrent);

// Password change / reset. Mounted before the order-desk fence's other routes
// because it must stay reachable during a forced change.
router.use('/', require('./admin-password'));

// CHC staff accounts (super-admin only) and per-company customer users.
router.use('/users', require('./admin-users'));
router.use('/companies/:companyId/users', require('./company-users-admin'));

// Identity bootstrap — lets the console (including an order-desk account) render
// the right view without exposing anything the account cannot already see.
router.get('/whoami', (req, res) => {
    res.json({
        id: req.admin.id, name: req.admin.name, email: req.admin.email,
        role: req.admin.role, company_id: req.admin.company_id, branch_id: req.admin.branch_id
    });
});

// ============================================================
// refinishAI INVENTORY (optional module, per company)
//
// Mounted here rather than in server.js so the whole module can be added or
// removed without touching application bootstrap. The sub-router re-applies
// requireCompanyAccess itself.
// ============================================================
router.use('/companies/:companyId/inventory', require('./inventory-admin'));
router.use('/companies/:companyId/modules', require('./modules-admin'));
router.use('/companies/:companyId/po', require('./po-admin'));
router.use('/companies/:companyId/library', require('./item-library'));

// ============================================================
// DASHBOARD STATS
// ============================================================

// The full dashboard — sales, stock and repair work in one payload. Kept in
// its own file because it is read-only aggregation and shares nothing with the
// CRUD below. Order-desk accounts never reach it: restrictOrderDesk above is
// an allow-list and /dashboard is not on it.
router.use('/dashboard', require('./admin-dashboard'));

// The master table — maintaining item_library rather than only reading it.
// Super-admin only, enforced inside that router. Mounted before the
// company-scoped routes so /master is never read as a company id.
router.use('/master', require('./master-table'));

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
            .select('id, name, slug, logo_url, contact_email, email_config, settings, is_active, created_at, updated_at')
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

        // Merge email_config with existing values instead of overwriting
        if (filtered.email_config) {
            const { data: existing } = await supabaseAdmin
                .from('companies')
                .select('email_config')
                .eq('id', companyId)
                .single();
            filtered.email_config = { ...(existing?.email_config || {}), ...filtered.email_config };
        }

        const { data, error } = await supabaseAdmin
            .from('companies')
            .update(filtered)
            .eq('id', companyId)
            .select('id, name, slug, logo_url, contact_email, email_config, is_active')
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
 * Get current master logo info from Supabase Storage
 */
router.get('/branding/logo', async (req, res) => {
    try {
        const { data: urlData } = supabaseAdmin.storage
            .from('company-logos')
            .getPublicUrl('platform/master-logo.png');

        // Check if the file actually exists by listing
        const { data: files } = await supabaseAdmin.storage
            .from('company-logos')
            .list('platform', { limit: 1, search: 'master-logo' });

        const exists = files && files.length > 0;
        res.json({
            exists,
            url: exists ? urlData.publicUrl + '?t=' + Date.now() : null,
            size: exists && files[0].metadata ? files[0].metadata.size : 0,
            updated: exists ? files[0].updated_at : null
        });
    } catch (err) {
        console.error('Branding logo info error:', err);
        res.status(500).json({ error: 'Failed to get logo info.' });
    }
});

/**
 * POST /api/admin/branding/logo
 * Upload/replace the CHC master logo to Supabase Storage (super_admin only)
 */
router.post('/branding/logo', requireSuperAdmin, logoUpload.single('logo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No logo file provided.' });
        }

        const filePath = 'platform/master-logo.png';

        // Upload to Supabase Storage (upsert to overwrite)
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

        await logAction(req.admin.id, 'master_logo_uploaded', 'branding', null, {
            originalName: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
            url: urlData.publicUrl
        }, req.ip);

        res.json({
            message: 'Master logo updated successfully.',
            url: urlData.publicUrl,
            size: req.file.size
        });

    } catch (err) {
        console.error('Master logo upload error:', err);
        res.status(500).json({ error: 'Failed to upload master logo.' });
    }
});

// ============================================================
// COMPANY LOCATIONS MANAGEMENT
// ============================================================

/**
 * GET /api/admin/companies/:companyId/locations
 */
router.get('/companies/:companyId/locations', requireCompanyAccess, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('company_locations')
            .select('*')
            .eq('company_id', req.params.companyId)
            .order('sort_order')
            .order('city')
            .order('name');

        if (error) throw error;
        res.json({ locations: data || [] });
    } catch (err) {
        console.error('Locations list error:', err);
        res.status(500).json({ error: 'Failed to load locations.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/locations
 * Create a single location
 */
router.post('/companies/:companyId/locations', requireCompanyAccess, async (req, res) => {
    try {
        const location = sanitizeObject(req.body);
        location.company_id = req.params.companyId;

        if (!location.name) {
            return res.status(400).json({ error: 'Location name is required.' });
        }

        const { data, error } = await supabaseAdmin
            .from('company_locations')
            .insert(location)
            .select()
            .single();

        if (error) throw error;

        await logAction(req.admin.id, 'location_created', 'location', data.id, { name: data.name, city: data.city }, req.ip);
        res.status(201).json({ location: data });
    } catch (err) {
        console.error('Create location error:', err);
        res.status(500).json({ error: 'Failed to create location.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/locations/bulk
 * Create multiple locations at once
 */
router.post('/companies/:companyId/locations/bulk', requireCompanyAccess, async (req, res) => {
    try {
        const { locations } = req.body;
        if (!locations || !Array.isArray(locations) || locations.length === 0) {
            return res.status(400).json({ error: 'No locations provided.' });
        }

        const companyId = req.params.companyId;
        const records = locations
            .map(l => typeof l === 'string' ? { name: l.trim() } : sanitizeObject(l))
            .filter(l => l.name)
            .map(l => ({ ...l, company_id: companyId }));

        if (records.length === 0) {
            return res.status(400).json({ error: 'No valid locations found.' });
        }

        const { data, error } = await supabaseAdmin
            .from('company_locations')
            .insert(records)
            .select();

        if (error) throw error;

        await logAction(req.admin.id, 'locations_bulk_created', 'location', null, {
            company_id: companyId, count: data.length
        }, req.ip);

        res.status(201).json({ locations: data, count: data.length });
    } catch (err) {
        console.error('Bulk create locations error:', err);
        res.status(500).json({ error: 'Failed to create locations.' });
    }
});

/**
 * PUT /api/admin/companies/:companyId/locations/:locationId
 */
router.put('/companies/:companyId/locations/:locationId', requireCompanyAccess, async (req, res) => {
    try {
        const updates = sanitizeObject(req.body);
        delete updates.id;
        delete updates.company_id;
        if (updates.supplier_branch_id === '') updates.supplier_branch_id = null;

        const { data, error } = await supabaseAdmin
            .from('company_locations')
            .update(updates)
            .eq('id', req.params.locationId)
            .eq('company_id', req.params.companyId)
            .select()
            .single();

        if (error) throw error;

        await logAction(req.admin.id, 'location_updated', 'location', data.id, updates, req.ip);
        res.json({ location: data });
    } catch (err) {
        console.error('Update location error:', err);
        res.status(500).json({ error: 'Failed to update location.' });
    }
});

/**
 * DELETE /api/admin/companies/:companyId/locations/:locationId
 */
router.delete('/companies/:companyId/locations/:locationId', requireCompanyAccess, async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('company_locations')
            .delete()
            .eq('id', req.params.locationId)
            .eq('company_id', req.params.companyId);

        if (error) throw error;

        await logAction(req.admin.id, 'location_deleted', 'location', req.params.locationId, {}, req.ip);
        res.json({ message: 'Location deleted.' });
    } catch (err) {
        console.error('Delete location error:', err);
        res.status(500).json({ error: 'Failed to delete location.' });
    }
});

// ============================================================
// CHC SUPPLIER BRANCHES (servicing branches + their notification emails)
// ============================================================
function parseBranchEmails(raw) {
    const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/);
    return [...new Set(arr.map(e => String(e || '').trim().toLowerCase())
        .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))];
}

/** GET /api/admin/branches — list all CHC branches */
router.get('/branches', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('supplier_branches')
            .select('id, name, emails, city, is_active')
            .order('name');
        if (error) throw error;
        res.json({ branches: data || [] });
    } catch (err) {
        console.error('Branches list error:', err);
        res.status(500).json({ error: 'Failed to load branches.' });
    }
});

/** POST /api/admin/branches — create a branch */
router.post('/branches', requireSuperAdmin, async (req, res) => {
    try {
        const name = stripHtml(req.body.name);
        if (!name) return res.status(400).json({ error: 'Branch name is required.' });
        const { data, error } = await supabaseAdmin
            .from('supplier_branches')
            .insert({ name, city: stripHtml(req.body.city || '') || null, emails: parseBranchEmails(req.body.emails) })
            .select()
            .single();
        if (error) throw error;
        await logAction(req.admin.id, 'branch_created', 'branch', data.id, { name }, req.ip);
        res.status(201).json({ branch: data });
    } catch (err) {
        console.error('Create branch error:', err);
        res.status(500).json({ error: 'Failed to create branch.' });
    }
});

/** PUT /api/admin/branches/:id — update a branch (name/city/emails/is_active) */
router.put('/branches/:id', requireSuperAdmin, async (req, res) => {
    try {
        const updates = { updated_at: new Date().toISOString() };
        if (req.body.name !== undefined) updates.name = stripHtml(req.body.name);
        if (req.body.city !== undefined) updates.city = stripHtml(req.body.city || '') || null;
        if (req.body.emails !== undefined) updates.emails = parseBranchEmails(req.body.emails);
        if (req.body.is_active !== undefined) updates.is_active = !!req.body.is_active;
        const { data, error } = await supabaseAdmin
            .from('supplier_branches')
            .update(updates)
            .eq('id', req.params.id)
            .select()
            .single();
        if (error) throw error;
        await logAction(req.admin.id, 'branch_updated', 'branch', data.id, updates, req.ip);
        res.json({ branch: data });
    } catch (err) {
        console.error('Update branch error:', err);
        res.status(500).json({ error: 'Failed to update branch.' });
    }
});

/** DELETE /api/admin/branches/:id — delete a branch (locations are unassigned via FK) */
router.delete('/branches/:id', requireSuperAdmin, async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from('supplier_branches').delete().eq('id', req.params.id);
        if (error) throw error;
        await logAction(req.admin.id, 'branch_deleted', 'branch', req.params.id, {}, req.ip);
        res.json({ message: 'Branch deleted.' });
    } catch (err) {
        console.error('Delete branch error:', err);
        res.status(500).json({ error: 'Failed to delete branch.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/orders/:orderId/invoice
 * A CHC employee uploads an invoice for an order; stores it privately and
 * emails the same recipients as the order confirmation.
 */
router.post('/companies/:companyId/orders/:orderId/invoice', requireOrderAccess, invoiceUpload.single('invoice'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No invoice file provided.' });
        const { companyId, orderId } = req.params;

        const { data: order, error: oErr } = await supabaseAdmin
            .from('orders').select('id, order_number, company_id, location_id, contact_email')
            .eq('id', orderId).eq('company_id', companyId).single();
        if (oErr || !order) return res.status(404).json({ error: 'Order not found for this company.' });

        const ext = (req.file.originalname.split('.').pop() || 'pdf').toLowerCase();
        const storagePath = `${companyId}/${orderId}/invoice-${Date.now()}.${ext}`;
        const { error: upErr } = await supabaseAdmin.storage.from('invoices')
            .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype || 'application/octet-stream', upsert: true });
        if (upErr) { console.error('Invoice storage error:', upErr); return res.status(500).json({ error: 'Failed to store invoice file.' }); }

        const { data: updated, error: updErr } = await supabaseAdmin.from('orders').update({
            invoice_path: storagePath,
            invoice_filename: stripHtml(req.file.originalname),
            invoice_uploaded_at: new Date().toISOString(),
            invoice_uploaded_by: req.admin.id,
            handled_by: req.admin.id,
            handled_by_name: req.admin.name || req.admin.email,
            handled_at: new Date().toISOString()
        }).eq('id', orderId).select('id, order_number, invoice_filename, invoice_uploaded_at').single();
        if (updErr) throw updErr;

        await logAction(req.admin.id, 'invoice_uploaded', 'order', orderId, { filename: req.file.originalname }, req.ip);

        // Notify the same recipients as the order confirmation (company + managers + branch)
        try {
            const { to: recipients, replyTo } = await resolveOrderRecipients(order);
            if (recipients.length) {
                const { data: company } = await supabaseAdmin.from('companies').select('name, slug').eq('id', companyId).single();
                const retrieveUrl = `${process.env.APP_URL || ''}/store/${company?.slug || ''}`;
                sendInvoiceReady({ to: recipients, replyTo, order: { order_number: order.order_number, id: order.id }, companyName: company?.name || '', retrieveUrl })
                    .catch(e => console.error('Invoice email failed (non-blocking):', e.message));
            }
        } catch (e) { console.error('Invoice recipients error:', e.message); }

        res.json({ message: 'Invoice uploaded and recipients notified.', order: updated });
    } catch (err) {
        console.error('Invoice upload error:', err);
        res.status(500).json({ error: 'Failed to upload invoice.' });
    }
});

/**
 * GET /api/admin/companies/:companyId/orders/:orderId/invoice
 * Short-lived signed URL so branch staff can view/verify the uploaded invoice.
 */
router.get('/companies/:companyId/orders/:orderId/invoice', requireOrderAccess, async (req, res) => {
    try {
        const { companyId, orderId } = req.params;
        const { data: order, error } = await supabaseAdmin
            .from('orders').select('invoice_path, invoice_filename')
            .eq('id', orderId).eq('company_id', companyId).single();
        if (error || !order || !order.invoice_path) return res.status(404).json({ error: 'No invoice on file for this order.' });
        const { data: signed, error: sErr } = await supabaseAdmin.storage.from('invoices')
            .createSignedUrl(order.invoice_path, 300);  // inline: opens the PDF in the browser instead of forcing a desktop download
        if (sErr || !signed) return res.status(500).json({ error: 'Failed to prepare invoice download.' });
        res.json({ url: signed.signedUrl, filename: order.invoice_filename });
    } catch (err) {
        console.error('Admin invoice fetch error:', err);
        res.status(500).json({ error: 'Failed to get invoice.' });
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

        // Barcodes live in their own table because one product can carry
        // several (a manufacturer code and an inner-pack code, or one we
        // generated). They were never joined here, so the catalogue screen
        // could not show a barcode and nobody could tell which items were
        // ready to scan. Fetched separately rather than embedded so a failure
        // to read them degrades to "no barcode shown" instead of failing the
        // whole catalogue.
        const products = data || [];
        if (products.length) {
            const { data: codes } = await supabaseAdmin
                .from('product_barcodes')
                .select('product_id, barcode, symbology, is_primary, is_internal')
                .in('product_id', products.map(p => p.id));
            const byProduct = new Map();
            for (const c of codes || []) {
                if (!byProduct.has(c.product_id)) byProduct.set(c.product_id, []);
                byProduct.get(c.product_id).push(c);
            }
            for (const p of products) {
                const list = byProduct.get(p.id) || [];
                p.barcodes = list;
                const primary = list.find(c => c.is_primary) || list[0] || null;
                p.barcode = primary ? primary.barcode : null;
                p.barcode_is_internal = primary ? !!primary.is_internal : false;
            }
        }

        res.json({ products, total: count, page: parseInt(page), limit: parseInt(limit) });

    } catch (err) {
        console.error('Admin products error:', err);
        res.status(500).json({ error: 'Failed to load products.' });
    }
});

/**
 * PUT /api/admin/companies/:companyId/products/:productId/barcode
 *
 * Set or replace the barcode a scanner will find for this product.
 *
 * Scoped to the company on purpose: two customers may legitimately hold the
 * same manufacturer barcode on their own copy of the same part, but within one
 * customer a code must identify exactly one product or scanning is a coin
 * toss. That is the only uniqueness this enforces.
 */
router.put('/companies/:companyId/products/:productId/barcode', requireCompanyAccess, async (req, res) => {
    try {
        const { companyId, productId } = req.params;
        if (!isValidUUID(productId)) return res.status(400).json({ error: 'Invalid product id.' });

        const { data: product } = await supabaseAdmin.from('products')
            .select('id, company_id, sku, name').eq('id', productId).maybeSingle();
        if (!product || product.company_id !== companyId) {
            return res.status(404).json({ error: 'That product is not in this company\'s catalogue.' });
        }

        const raw = stripHtml(String(req.body.barcode || '')).trim();

        // An empty value removes the barcode. Deliberate and explicit — the
        // caller has to send an empty string, so it cannot happen by omission.
        if (!raw) {
            await supabaseAdmin.from('product_barcodes').delete().eq('product_id', productId);
            await logAction(req.admin.id, 'product_barcode_cleared', 'product', productId,
                            { sku: product.sku }, req.ip);
            return res.json({ message: `Barcode removed from ${product.sku}.`, barcode: null });
        }

        if (!/^[0-9A-Za-z\-]{4,48}$/.test(raw)) {
            return res.status(400).json({ error: 'A barcode should be 4–48 characters, digits and letters only.' });
        }

        // Refuse a code already on a different product in this catalogue.
        //
        // Deliberately two plain queries rather than one embedded select. An
        // embed here silently returns nothing when the relation cannot be
        // resolved, and a uniqueness check that silently finds nothing is a
        // uniqueness check that always passes — which is exactly how the first
        // version of this shipped and let a duplicate through.
        const { data: holders } = await supabaseAdmin.from('product_barcodes')
            .select('product_id').eq('barcode', raw);
        const otherIds = [...new Set((holders || [])
            .map(h => h.product_id).filter(id => id && id !== productId))];
        if (otherIds.length) {
            const { data: owners } = await supabaseAdmin.from('products')
                .select('id, sku, name, company_id').in('id', otherIds);
            const inThisCompany = (owners || []).find(o => o.company_id === companyId);
            if (inThisCompany) {
                return res.status(409).json({
                    error: `${raw} is already on ${inThisCompany.sku} — ${inThisCompany.name}. ` +
                           'One code cannot mean two products, or a scan cannot tell them apart.'
                });
            }
        }

        await supabaseAdmin.from('product_barcodes').delete().eq('product_id', productId).eq('is_primary', true);
        const { data, error } = await supabaseAdmin.from('product_barcodes')
            .insert({
                product_id: productId, barcode: raw,
                // Length is the only honest signal we have about the symbology.
                symbology: raw.length === 13 ? 'EAN_13' : raw.length === 12 ? 'UPC_A' : 'OTHER',
                is_primary: true, source: 'manual',
                // An internal code is one we invented for an item with no
                // manufacturer barcode. A typed one is assumed real.
                is_internal: false
            })
            .select().single();
        if (error) throw error;

        await logAction(req.admin.id, 'product_barcode_set', 'product', productId,
                        { sku: product.sku, barcode: raw }, req.ip);
        res.json({ message: `${raw} set on ${product.sku}.`, barcode: data });

    } catch (err) {
        console.error('Set barcode error:', err);
        res.status(500).json({ error: 'Failed to set that barcode.' });
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
 * GET /api/admin/companies/:companyId/products/filters
 * Get distinct brands and categories for filter UI
 */
router.get('/companies/:companyId/products/filters', requireCompanyAccess, async (req, res) => {
    try {
        const companyId = req.params.companyId;

        const { data: brandData } = await supabaseAdmin
            .from('products')
            .select('brand')
            .eq('company_id', companyId)
            .order('brand');

        const { data: categoryData } = await supabaseAdmin
            .from('products')
            .select('category')
            .eq('company_id', companyId)
            .not('category', 'is', null)
            .order('category');

        const brands = [...new Set((brandData || []).map(r => r.brand).filter(Boolean))];
        const categories = [...new Set((categoryData || []).map(r => r.category).filter(Boolean))];

        res.json({ brands, categories });
    } catch (err) {
        console.error('Product filters error:', err);
        res.status(500).json({ error: 'Failed to load filters.' });
    }
});

/**
 * POST /api/admin/companies/:companyId/products/bulk-delete
 * Delete multiple products by IDs
 */
router.post('/companies/:companyId/products/bulk-delete', requireCompanyAccess, async (req, res) => {
    try {
        const { product_ids, delete_all, filters } = req.body;
        const companyId = req.params.companyId;

        if (delete_all) {
            // Delete all products matching current filters
            let query = supabaseAdmin
                .from('products')
                .delete()
                .eq('company_id', companyId);

            if (filters) {
                if (filters.brand) query = query.eq('brand', filters.brand);
                if (filters.category) query = query.eq('category', filters.category);
                if (filters.search) query = query.or(`name.ilike.%${filters.search}%,sku.ilike.%${filters.search}%`);
            }

            const { data, error } = await query.select('id');
            if (error) throw error;

            const count = data ? data.length : 0;
            await logAction(req.admin.id, 'products_bulk_deleted', 'product', null, {
                company_id: companyId, count, filters: filters || 'all'
            }, req.ip);

            return res.json({ message: `${count} products deleted.`, count });
        }

        if (!product_ids || !Array.isArray(product_ids) || product_ids.length === 0) {
            return res.status(400).json({ error: 'No product IDs provided.' });
        }

        if (product_ids.length > 500) {
            return res.status(400).json({ error: 'Maximum 500 products per bulk delete.' });
        }

        const { data, error } = await supabaseAdmin
            .from('products')
            .delete()
            .eq('company_id', companyId)
            .in('id', product_ids)
            .select('id');

        if (error) throw error;

        const count = data ? data.length : 0;
        await logAction(req.admin.id, 'products_bulk_deleted', 'product', null, {
            company_id: companyId, count, product_ids: product_ids.slice(0, 10)
        }, req.ip);

        res.json({ message: `${count} products deleted.`, count });

    } catch (err) {
        console.error('Bulk delete error:', err);
        res.status(500).json({ error: 'Failed to delete products.' });
    }
});

/**
 * DELETE /api/admin/companies/:companyId/products/:productId
 * Delete a single product
 */
router.delete('/companies/:companyId/products/:productId', requireCompanyAccess, async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('products')
            .delete()
            .eq('id', req.params.productId)
            .eq('company_id', req.params.companyId);

        if (error) throw error;

        await logAction(req.admin.id, 'product_deleted', 'product', req.params.productId, {}, req.ip);
        res.json({ message: 'Product deleted.' });

    } catch (err) {
        console.error('Delete product error:', err);
        res.status(500).json({ error: 'Failed to delete product.' });
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
        // Preview mode (dry run): analyze and report, write nothing.
        const dryRun = ['1', 'true', 'yes'].includes(String(req.body.dry_run || req.query.preview || '').toLowerCase());
        const mode = String(req.body.mode || 'merge').toLowerCase() === 'replace' ? 'replace' : 'merge';
        // PPG LIST-PRICE RULE
        //
        // PPG prices are not per customer: one list price applies everywhere.
        // That rule used to be sourced from ONE customer's catalogue by
        // hard-coded id — so a price was only correct for as long as that
        // customer's own list was, and nobody else could see where the number
        // came from. The master table is the source now: it is the thing
        // everyone already agrees is authoritative, it is editable on its own
        // screen, and every change to it is logged.
        //
        // Matched on sku_key, not on the raw SKU, so MMM-06652 and MMM06652
        // are the same part here as they are everywhere else.
        //
        // unlock_ppg still lets an admin upload a deliberate exception.
        const unlockPPG = ['1','true','yes'].includes(String(req.body.unlock_ppg || '').toLowerCase());
        const masterPPG = {};
        {
            for (let from = 0; ; from += 1000) {
                const { data: mp } = await supabaseAdmin.from('item_library')
                    .select('sku_key, list_price')
                    .ilike('brand', 'ppg')
                    .range(from, from + 999);
                const batch = mp || [];
                batch.forEach(r => {
                    if (r.sku_key && Number(r.list_price) > 0) masterPPG[r.sku_key] = Number(r.list_price);
                });
                if (batch.length < 1000) break;
            }
        }
        const skuKeyOf = v => String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

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
        let inserted = 0, updated = 0, priceChanges = 0, skipped = 0;
        const sampleChanges = [];

        // Replace mode: wipe the company's existing catalog first (product_barcodes cascade on delete).
        let deleted = 0;
        if (mode === 'replace') {
            const { count } = await supabaseAdmin.from('products')
                .select('id', { count: 'exact', head: true }).eq('company_id', companyId);
            deleted = count || 0;
            if (!dryRun) await supabaseAdmin.from('products').delete().eq('company_id', companyId);
        }

        for (const row of normalizedRows) {
            row.company_id = companyId;

            // Every company gets the master's PPG list price — including the
            // one that used to be the source of it. One rule, one place, no
            // customer who is quietly special.
            const skuK = skuKeyOf(row.sku);
            if (!unlockPPG && skuK && masterPPG[skuK] !== undefined) {
                row.price = masterPPG[skuK];
                if (!row.brand || row.brand === 'Uncategorized') row.brand = 'PPG';
            }

            // Skip rows with no positive price (e.g. blank/0 in source) — keep existing price untouched
            if (!(Number(row.price) > 0)) { skipped++; continue; }

            let existing = null;
            if (row.sku) {
                const { data } = await supabaseAdmin
                    .from('products')
                    .select('id, price')
                    .eq('company_id', companyId)
                    .eq('sku', row.sku)
                    .maybeSingle();
                existing = data || null;
            }

            if (existing) {
                const changed = Math.round(Number(existing.price) * 100) !== Math.round(Number(row.price) * 100);
                if (changed) {
                    priceChanges++;
                    if (sampleChanges.length < 15) {
                        sampleChanges.push({ sku: row.sku, name: row.name, old_price: Number(existing.price), new_price: Number(row.price) });
                    }
                }
                updated++;
                if (!dryRun) await supabaseAdmin.from('products').update(row).eq('id', existing.id);
            } else {
                inserted++;
                if (!dryRun) await supabaseAdmin.from('products').insert(row);
            }
        }

        // Propagation used to happen here as a side effect of one customer's
        // upload — a price change across every catalogue, triggered by a file
        // somebody dropped on one screen, with no preview and no record.
        //
        // It is now its own action: edit the price in the master, then run
        // "Apply master prices" from the Master Table screen, where it is
        // previewed per customer and every change is logged. Same outcome,
        // visible before it happens.
        let ppgPropagated = 0;

        // Only record the upload + audit entry when actually importing
        if (!dryRun) {
            const { data: upload } = await supabaseAdmin
                .from('catalog_uploads')
                .insert({
                    company_id: companyId,
                    admin_id: req.admin.id,
                    filename: req.file.originalname,
                    file_type: ext,
                    row_count: normalizedRows.length,
                    status: errors.length > 0 ? 'completed_with_errors' : 'completed',
                    error_details: errors
                })
                .select()
                .single();

            await logAction(req.admin.id, 'catalog_uploaded', 'company', companyId, {
                filename: req.file.originalname, mode, deleted, inserted, updated, price_changes: priceChanges, skipped, errors: errors.length
            }, req.ip);
        }

        res.json({
            preview: dryRun,
            message: dryRun ? 'Preview only — no changes were written.' : 'Catalog upload processed.',
            inserted,
            updated,
            price_changes: priceChanges,
            skipped,
            errors: errors.length,
            error_details: errors.slice(0, 20),
            sample_changes: sampleChanges,
            mode,
            deleted,
            ppg_propagated: (typeof ppgPropagated !== 'undefined' ? ppgPropagated : 0),
            ppg_unlocked: unlockPPG
        });

    } catch (err) {
        console.error('Catalog upload error:', err);
        res.status(500).json({ error: 'Failed to process catalog upload.' });
    }
});

// ============================================================
// EMAIL RECIPIENTS (consolidated per-customer email setup)
// ============================================================
router.get('/companies/:companyId/email-setup', requireCompanyAccess, async (req, res) => {
    try {
        const { companyId } = req.params;
        const { data: company } = await supabaseAdmin.from('companies').select('name, contact_email, email_config').eq('id', companyId).single();
        const { data: branches } = await supabaseAdmin.from('supplier_branches').select('id, name, emails, is_active').order('name');
        const branchMap = {};
        (branches || []).forEach(b => { branchMap[b.id] = b; });
        const { data: locations } = await supabaseAdmin
            .from('company_locations').select('id, name, city, notify_emails, supplier_branch_id')
            .eq('company_id', companyId).order('name');
        const locs = (locations || []).map(l => ({
            id: l.id, name: l.name, city: l.city,
            notify_emails: Array.isArray(l.notify_emails) ? l.notify_emails : [],
            supplier_branch_id: l.supplier_branch_id,
            branch_name: l.supplier_branch_id && branchMap[l.supplier_branch_id] ? branchMap[l.supplier_branch_id].name : null,
            branch_emails: l.supplier_branch_id && branchMap[l.supplier_branch_id] ? (branchMap[l.supplier_branch_id].emails || []) : []
        }));
        res.json({
            company_name: company?.name || '',
            contact_email: company?.contact_email || '',
            manager_emails: Array.isArray(company?.email_config?.manager_emails) ? company.email_config.manager_emails : [],
            branches: (branches || []).filter(b => b.is_active !== false).map(b => ({ id: b.id, name: b.name })),
            locations: locs
        });
    } catch (err) { console.error('Email-setup load error:', err); res.status(500).json({ error: 'Failed to load email setup.' }); }
});

// ============================================================
// COMPANY MODULES + PURCHASE ORDERS
// ------------------------------------------------------------
// The module on/off switch (GET/PUT .../modules[/:name]) and the PO settings
// (GET/PUT .../po) are served by the mounted sub-routers near the top of this
// file:  require('./modules-admin')  and  require('./po-admin'), which are
// driven by the registries in utils/modules.js and utils/po.js. The earlier
// inline copies of those routes were removed to keep a single source of truth
// (they were shadowed by the mounts and never executed).
// ============================================================

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
        const { company_id, status, from_date, to_date, location_id, page = 1, limit = 50 } = req.query;

        let query = supabaseAdmin
            .from('orders')
            .select(`*, companies (id, name), company_locations (id, name, supplier_branches (id, name))`, { count: 'exact' })
            .order('created_at', { ascending: false });

        const _scopeIds = await orderScopeIds(req);
        query = applyOrderScope(query, req, _scopeIds, company_id);

        if (status) query = query.eq('status', status);
        if (location_id) query = query.eq('location_id', location_id);
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
 * GET /api/admin/orders/export
 * CSV export of orders. Respects role scoping and the same filters as GET /orders.
 */
router.get('/orders/export', async (req, res) => {
    try {
        const { company_id, status, from_date, to_date, location_id } = req.query;
        let query = supabaseAdmin
            .from('orders')
            .select('order_number, created_at, company_name, location, po_number, contact_name, contact_email, contact_phone, status, subtotal, total, items, companies(name), company_locations(name)')
            .order('created_at', { ascending: false });

        const _scopeIds = await orderScopeIds(req);
        query = applyOrderScope(query, req, _scopeIds, company_id);
        if (status) query = query.eq('status', status);
        if (location_id) query = query.eq('location_id', location_id);
        if (from_date) query = query.gte('created_at', from_date);
        if (to_date) query = query.lte('created_at', to_date);

        const { data, error } = await query.limit(10000);
        if (error) throw error;

        const esc = (v) => {
            if (v === null || v === undefined) v = '';
            v = String(v);
            return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        };
        const headers = ['Order #', 'Date', 'Company', 'Location', 'PO Number', 'Contact', 'Email', 'Phone', 'Status', 'Item Count', 'Subtotal', 'Total'];
        const rows = (data || []).map(o => {
            const itemCount = Array.isArray(o.items) ? o.items.reduce((n, i) => n + (parseInt(i.quantity) || 0), 0) : '';
            const locName = (o.company_locations && o.company_locations.name) || o.location || '';
            const compName = (o.companies && o.companies.name) || o.company_name || '';
            return [o.order_number, o.created_at, compName, locName, o.po_number, o.contact_name, o.contact_email, o.contact_phone, o.status, itemCount, o.subtotal, o.total].map(esc).join(',');
        });
        const csvText = [headers.map(esc).join(','), ...rows].join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="orders-export-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(csvText);
    } catch (err) {
        console.error('Orders export error:', err);
        res.status(500).json({ error: 'Failed to export orders.' });
    }
});

/**
 * GET /api/admin/reports/by-location
 * Per-location order count + revenue. Respects role scoping and date/company/status filters.
 */
router.get('/reports/by-location', async (req, res) => {
    try {
        const { company_id, from_date, to_date, status } = req.query;
        let query = supabaseAdmin
            .from('orders')
            .select('total, location, location_id, company_locations(name)');

        const _scopeIds = await orderScopeIds(req);
        query = applyOrderScope(query, req, _scopeIds, company_id);
        if (status) query = query.eq('status', status);
        if (from_date) query = query.gte('created_at', from_date);
        if (to_date) query = query.lte('created_at', to_date);

        const { data, error } = await query.limit(10000);
        if (error) throw error;

        const map = new Map();
        for (const o of (data || [])) {
            const key = o.location_id || 'unassigned';
            const name = (o.company_locations && o.company_locations.name) || o.location || 'Unassigned';
            const cur = map.get(key) || { location_id: o.location_id || null, location: name, order_count: 0, revenue: 0 };
            cur.order_count += 1;
            cur.revenue += parseFloat(o.total || 0);
            map.set(key, cur);
        }
        const report = Array.from(map.values())
            .map(r => ({ ...r, revenue: Math.round(r.revenue * 100) / 100 }))
            .sort((a, b) => b.revenue - a.revenue);

        res.json({ report, total_locations: report.length });
    } catch (err) {
        console.error('By-location report error:', err);
        res.status(500).json({ error: 'Failed to build location report.' });
    }
});

/**
 * GET /api/admin/reports/orders
 * Filtered orders (with line items) for the console Reports view. Respects role scoping.
 */
router.get('/reports/orders', async (req, res) => {
    try {
        const { company_id, location_id, from, to } = req.query;
        let q = supabaseAdmin
            .from('orders')
            .select('id, order_number, contact_name, po_number, status, total, location, location_id, company_id, created_at, items, companies (id, name)')
            .order('created_at', { ascending: false })
            .limit(5000);
        const _scopeIds = await orderScopeIds(req);
        q = applyOrderScope(q, req, _scopeIds, company_id);
        if (location_id) q = q.eq('location_id', location_id);
        if (from) q = q.gte('created_at', from);
        if (to) q = q.lte('created_at', to);
        const { data, error } = await q;
        if (error) throw error;
        res.json({ orders: data || [] });
    } catch (err) {
        console.error('Admin reports/orders error:', err);
        res.status(500).json({ error: 'Failed to load report data.' });
    }
});

/**
 * PUT /api/admin/orders/:orderId/status
 */
router.put('/orders/:orderId/status', async (req, res) => {
    try {
        const { status, note } = req.body;
        const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'closed', 'cancelled'];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        }

        // Scope: super admins pass; company admins are held to their company;
        // order-desk users to orders in their branch.
        const scope = await orderInScope(req, req.params.orderId);
        if (!scope.ok) {
            return res.status(scope.code).json({ error: scope.code === 404 ? 'Order not found.' : 'Access denied for this order.' });
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
            .update({
                status, status_history: statusHistory,
                // Who dealt with this. status_history is the full trail; these
                // columns answer the question without parsing JSON per row.
                handled_by: req.admin.id,
                handled_by_name: req.admin.name || req.admin.email,
                handled_at: new Date().toISOString()
            })
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

/**
 * PUT /api/admin/companies/:companyId/orders/:orderId/close
 * Step 3 of the branch workflow: payment received -> mark paid + close the order.
 * Records timestamps, appends status history, notifies recipients, and audit-logs.
 */
router.put('/companies/:companyId/orders/:orderId/close', requireOrderAccess, async (req, res) => {
    try {
        const { companyId, orderId } = req.params;
        const note = stripHtml(req.body?.note || '');

        const { data: order, error: oErr } = await supabaseAdmin
            .from('orders')
            .select('id, order_number, company_id, location_id, contact_email, status, payment_status, invoice_filename, status_history')
            .eq('id', orderId).eq('company_id', companyId).single();
        if (oErr || !order) return res.status(404).json({ error: 'Order not found for this company.' });

        if (order.status === 'closed' || order.payment_status === 'paid') {
            return res.status(409).json({ error: 'This order is already closed / marked paid.' });
        }

        const now = new Date().toISOString();
        const statusHistory = order.status_history || [];
        statusHistory.push({
            status: 'closed',
            timestamp: now,
            note: note || 'Payment received — order closed',
            updated_by: req.admin.email
        });

        const { data: updated, error: updErr } = await supabaseAdmin
            .from('orders')
            .update({
                status: 'closed',
                payment_status: 'paid',
                paid_at: now,
                closed_at: now,
                closed_by: req.admin.id,
                status_history: statusHistory,
                handled_by: req.admin.id,
                handled_by_name: req.admin.name || req.admin.email,
                handled_at: now
            })
            .eq('id', orderId)
            .select('id, order_number, status, payment_status, paid_at, closed_at')
            .single();
        if (updErr) throw updErr;

        await logAction(req.admin.id, 'order_closed', 'order', orderId, { note }, req.ip);

        // Non-blocking payment-received confirmation to the same recipients as the order.
        try {
            const { to: recipients, replyTo } = await resolveOrderRecipients(order);
            if (recipients.length) {
                const { data: company } = await supabaseAdmin.from('companies').select('name').eq('id', companyId).single();
                sendOrderClosed({ to: recipients, replyTo, order: { order_number: order.order_number, id: order.id }, companyName: company?.name || '' })
                    .catch(e => console.error('Order-closed email failed (non-blocking):', e.message));
            }
        } catch (e) { console.error('Order-closed recipients error:', e.message); }

        res.json({ message: 'Order marked paid and closed. Recipients notified.', order: updated });
    } catch (err) {
        console.error('Order close error:', err);
        res.status(500).json({ error: 'Failed to close order.' });
    }
});

// NOTE: CHC staff management (list/create/invite/role/branch) now lives in
// routes/admin-users.js, mounted at /users near the top of this file. The old
// inline GET/POST /users were removed to keep a single source of truth.

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
    const allRows = [];

    // Sheets to skip (internal/reference data, not product catalogs)
    const skipSheets = ['itemswb11926', 'lastcost'];

    for (const sheetName of workbook.SheetNames) {
        if (skipSheets.includes(sheetName.trim().toLowerCase())) continue;

        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet);

        // Use sheet name as brand if no brand column exists
        const brandFromSheet = sheetName.trim();

        for (const row of rows) {
            // Skip empty rows (no SKU and no item name)
            const sku = row['SKU'] || row['sku'] || row['Item #'] || row['item_number'];
            const name = row['Item Name'] || row['item_name'] || row['Name'] || row['name'] || row['Product'];
            if (!sku && !name) continue;
            if (!name || String(name).trim() === '') continue;

            // Inject sheet name as brand if not present
            if (!row['Brand'] && !row['brand'] && !row['Manufacturer']) {
                row['_sheet_brand'] = brandFromSheet;
            }
            allRows.push(row);
        }
    }
    return allRows;
}

function normalizeProductRow(row) {
    // Flexible column name mapping
    const mappings = {
        brand: ['brand', 'manufacturer', 'mfg', 'make', '_sheet_brand'],
        name: ['item_name', 'name', 'product', 'product_name', 'productname', 'description', 'item'],
        sku: ['sku', 'item_#', 'item_number', 'itemnumber', 'item_no', 'part_number', 'partnumber', 'part_no', 'upc'],
        description: ['description', 'desc', 'details', 'product_description'],
        category: ['category', 'cat', 'type', 'product_type', 'group', 'custom_list_#1'],
        price: ['warehouse_sale_price', 'price', 'sale_price', 'saleprice', 'unit_price', 'selling_price', 'ae_selling_price', 'current_price'],
        previous_price: ['previous_price', 'previousprice', 'regular_price', 'regularprice', 'msrp', 'list_price', 'listprice', 'was_price'],
        case_qty: ['case_quantity', 'case_qty', 'caseqty', 'casequantity', 'qty_per_case', 'pack_size', 'packsize'],
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
            const val = lowerRow[alias];
            if (val !== undefined && val !== null && String(val).trim() !== '') {
                normalized[field] = val;
                break;
            }
        }
    }

    // Validate required fields
    if (!normalized.name) throw new Error('Missing product name');
    if (!normalized.brand) normalized.brand = 'Uncategorized';

    // Price required; allow 0 through (the import step skips non-positive prices).
    if (normalized.price === undefined || normalized.price === null || String(normalized.price).trim() === '' || isNaN(parseFloat(normalized.price))) {
        if (normalized.previous_price && !isNaN(parseFloat(normalized.previous_price))) {
            normalized.price = normalized.previous_price;
        } else {
            throw new Error('Invalid or missing price');
        }
    }

    // Type conversions
    normalized.price = parseFloat(normalized.price);
    if (normalized.previous_price) normalized.previous_price = parseFloat(normalized.previous_price);
    if (normalized.case_qty) normalized.case_qty = parseInt(normalized.case_qty) || 1;
    normalized.is_active = true;

    return normalized;
}

module.exports = router;
