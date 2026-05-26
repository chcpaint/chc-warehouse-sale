const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { stripHtml, sanitizeObject, isValidUUID } = require('../utils/sanitize');
const { sendOrderNotification } = require('../utils/email');

const router = express.Router();

/**
 * GET /api/store/platform-logo
 * Public - get the CHC master logo URL from Supabase Storage
 */
router.get('/platform-logo', async (req, res) => {
    try {
        const { data: files } = await supabaseAdmin.storage
            .from('company-logos')
            .list('platform', { limit: 1, search: 'master-logo' });

        if (files && files.length > 0) {
            const { data: urlData } = supabaseAdmin.storage
                .from('company-logos')
                .getPublicUrl('platform/master-logo.png');
            return res.json({ url: urlData.publicUrl });
        }

        // Fallback to local asset
        res.json({ url: '/assets/chc-logo.png' });
    } catch (err) {
        console.error('Platform logo error:', err);
        res.json({ url: '/assets/chc-logo.png' });
    }
});

/**
 * GET /api/store/:slug/info
 * Public - get company info for login page (name, logo)
 */
router.get('/:slug/info', async (req, res) => {
    try {
        const { data: company, error } = await supabaseAdmin
            .from('companies')
            .select('id, name, slug, logo_url, settings')
            .eq('slug', req.params.slug)
            .eq('is_active', true)
            .single();

        if (error || !company) {
            return res.status(404).json({ error: 'Company not found.' });
        }

        res.json({ company });
    } catch (err) {
        console.error('Company info error:', err);
        res.status(500).json({ error: 'Failed to load company info.' });
    }
});

/**
 * POST /api/store/:slug/backfill-categories
 * TEMPORARY - populate category column from known SKU mapping
 */
router.post('/:slug/backfill-categories', requireCompanyAuth, async (req, res) => {
    try {
        const companyId = req.company.id;

        // SKU → category mapping from the original product data
        const skuCategoryMap = {
            // 3M - Abrasives & Sanding
            "MMM02021": "Abrasives & Sanding", "MMM02022": "Abrasives & Sanding", "MMM02023": "Abrasives & Sanding",
            "MMM02035": "Abrasives & Sanding", "MMM02036": "Abrasives & Sanding", "MMM02038": "Abrasives & Sanding",
            "MMM02044": "Abrasives & Sanding", "MMM02045": "Abrasives & Sanding", "MMM02085": "Abrasives & Sanding",
            "MMM02087": "Abrasives & Sanding", "MMM30662": "Abrasives & Sanding", "MMM30666": "Abrasives & Sanding",
            "MMM31370": "Abrasives & Sanding", "MMM31371": "Abrasives & Sanding", "MMM31372": "Abrasives & Sanding",
            "MMM31373": "Abrasives & Sanding", "MMM33538": "Abrasives & Sanding", "MMM33539": "Abrasives & Sanding",
            "MMM36170": "Abrasives & Sanding", "MMM36172": "Abrasives & Sanding", "MMM36174": "Abrasives & Sanding",
            "MMM36176": "Abrasives & Sanding", "MMM36180": "Abrasives & Sanding",
            // 3M - Polishing & Compounding
            "MMM05706": "Polishing & Compounding", "MMM05707": "Polishing & Compounding", "MMM05708": "Polishing & Compounding",
            "MMM06068": "Polishing & Compounding", "MMM06094": "Polishing & Compounding", "MMM33279": "Polishing & Compounding",
            "MMM36060": "Polishing & Compounding",
            // 3M - Body Fillers & Repair
            "MMM01131": "Body Fillers & Repair", "MMM04240": "Body Fillers & Repair", "MMM04247": "Body Fillers & Repair",
            "MMM04248": "Body Fillers & Repair", "MMM05887": "Body Fillers & Repair", "MMM05860": "Body Fillers & Repair",
            "MMM05861": "Body Fillers & Repair", "MMM20382": "Body Fillers & Repair",
            // 3M - Adhesives & Seam Sealers
            "MMM07333": "Adhesives & Seam Sealers", "MMM08115": "Adhesives & Seam Sealers", "MMM08194": "Adhesives & Seam Sealers",
            "MMM08308": "Adhesives & Seam Sealers", "MMM08323": "Adhesives & Seam Sealers", "MMM08522": "Adhesives & Seam Sealers",
            "MMM08524": "Adhesives & Seam Sealers", "MMM08526": "Adhesives & Seam Sealers", "MMM08528": "Adhesives & Seam Sealers",
            "MMM08852": "Adhesives & Seam Sealers", "MMM06382": "Adhesives & Seam Sealers", "MMM06383": "Adhesives & Seam Sealers",
            "MMM06386": "Adhesives & Seam Sealers",
            // 3M - Masking & Surface Protection
            "MMM06349": "Masking & Surface Protection", "MMM06652": "Masking & Surface Protection", "MMM06654": "Masking & Surface Protection",
            "MMM06656": "Masking & Surface Protection", "MMM06718": "Masking & Surface Protection", "MMM06724": "Masking & Surface Protection",
            "MMM26334": "Masking & Surface Protection", "MMM26338": "Masking & Surface Protection", "MMM36852": "Masking & Surface Protection",
            "MMM05916": "Masking & Surface Protection", "MMM05917": "Masking & Surface Protection", "MMM07847": "Masking & Surface Protection",
            "MMM07848": "Masking & Surface Protection",
            // 3M - Spray Guns & PPS Systems
            "MMM26000": "Spray Guns & PPS Systems", "MMM26024": "Spray Guns & PPS Systems", "MMM26112": "Spray Guns & PPS Systems",
            "MMM26114": "Spray Guns & PPS Systems", "MMM26163": "Spray Guns & PPS Systems", "MMM26164": "Spray Guns & PPS Systems",
            "MMM26301": "Spray Guns & PPS Systems", "MMM26689": "Spray Guns & PPS Systems", "MMM26832": "Spray Guns & PPS Systems",
            "MMM26712": "Spray Guns & PPS Systems", "MMM26713": "Spray Guns & PPS Systems", "MMM26714": "Spray Guns & PPS Systems",
            // SEM - Seam Sealers
            "SEM29362": "Seam Sealers", "SEM29372": "Seam Sealers", "SEM29382": "Seam Sealers", "SEM29392": "Seam Sealers",
            "SEM29462": "Seam Sealers", "SEM29472": "Seam Sealers", "SEM29482": "Seam Sealers", "SEM29492": "Seam Sealers",
            // SEM - Primers & Coatings
            "SEM39143": "Primers & Coatings", "SEM39144-LV": "Primers & Coatings", "SEM39673": "Primers & Coatings",
            "SEM39683": "Primers & Coatings", "SEM39863": "Primers & Coatings", "SEM40773": "Primers & Coatings",
            "SEM62213": "Primers & Coatings", "SEM62243": "Primers & Coatings",
            // SEM - Body Fillers & Glazes
            "SEM40561": "Body Fillers & Glazes", "SEM39592": "Body Fillers & Glazes", "SEM40482": "Body Fillers & Glazes",
            // SEM - Bed Liners & Protective Coatings
            "SEM56650": "Bed Liners & Protective Coatings", "SEM56670": "Bed Liners & Protective Coatings",
            // SEM - Abrasives
            "SA6080": "Abrasives", "SA6120": "Abrasives", "SA6180": "Abrasives",
            "SA6240": "Abrasives", "SA6320": "Abrasives", "SA6400": "Abrasives",
            // SEM - Aerosols & Specialty
            "SEM61993": "Aerosols & Specialty",
            // PPG - Clearcoats
            "EC520": "Clearcoats", "EC530": "Clearcoats", "EC550": "Clearcoats",
            "UT500": "Clearcoats", "UT501": "Clearcoats", "UT502": "Clearcoats",
            // PPG - Base Coats
            "BC600": "Base Coats", "BC700": "Base Coats", "BT100": "Base Coats", "BT200": "Base Coats",
            // PPG - Primers & Surfacers
            "AP200": "Primers & Surfacers", "AP300": "Primers & Surfacers", "EP400": "Primers & Surfacers", "EP500": "Primers & Surfacers",
            // Tamco - Clearcoats
            "TAM900": "Clearcoats", "TAM950": "Clearcoats",
            // Tamco - Base Coats
            "TAM100": "Base Coats", "TAM200": "Base Coats",
            // Tamco - Primers
            "TAM500": "Primers", "TAM600": "Primers",
            // Henkel - Adhesives & Sealants
            "HEN2568787": "Adhesives & Sealants", "HEN2568797": "Adhesives & Sealants", "HEN2568817": "Adhesives & Sealants",
            "HEN2568818": "Adhesives & Sealants", "HEN2816502": "Adhesives & Sealants", "HEN2820041": "Adhesives & Sealants",
            "HEN1434516": "Adhesives & Sealants", "HEN1585815": "Adhesives & Sealants",
        };

        // Fetch all products for this company
        const { data: products } = await supabaseAdmin
            .from('products')
            .select('id, sku, category')
            .eq('company_id', companyId);

        let updated = 0;
        let skipped = 0;
        let notFound = 0;
        const errors = [];

        for (const product of (products || [])) {
            const category = skuCategoryMap[product.sku];
            if (category && product.category !== category) {
                const { error } = await supabaseAdmin
                    .from('products')
                    .update({ category })
                    .eq('id', product.id);
                if (error) {
                    errors.push({ sku: product.sku, error: error.message });
                } else {
                    updated++;
                }
            } else if (category) {
                skipped++;
            } else {
                notFound++;
            }
        }

        res.json({
            total_products: (products || []).length,
            updated,
            skipped_already_correct: skipped,
            no_category_mapping: notFound,
            errors
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/store/:slug/products
 * Get product catalog for authenticated company
 */
router.get('/:slug/products', requireCompanyAuth, async (req, res) => {
    try {
        const companyId = req.company.id;
        const { brand, category, search, page = 1, limit = 100 } = req.query;

        let query = supabaseAdmin
            .from('products')
            .select('*', { count: 'exact' })
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('brand')
            .order('sort_order')
            .order('name');

        if (brand) query = query.eq('brand', brand);
        if (category) query = query.eq('category', category);
        if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%,brand.ilike.%${search}%`);

        // Pagination
        const offset = (parseInt(page) - 1) * parseInt(limit);
        query = query.range(offset, offset + parseInt(limit) - 1);

        const { data: products, error, count } = await query;

        if (error) {
            console.error('Products fetch error:', error);
            return res.status(500).json({ error: 'Failed to load products.' });
        }

        // Get available brands and categories for filters
        const { data: brands } = await supabaseAdmin
            .from('products')
            .select('brand')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('brand');

        const uniqueBrands = [...new Set((brands?.map(b => b.brand) || []).filter(Boolean))];

        const { data: categories } = await supabaseAdmin
            .from('products')
            .select('category')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .not('category', 'is', null)
            .neq('category', '')
            .order('category');

        const uniqueCategories = [...new Set((categories?.map(c => c.category) || []).filter(Boolean))];

        res.json({
            products,
            total: count,
            page: parseInt(page),
            limit: parseInt(limit),
            filters: {
                brands: uniqueBrands,
                categories: uniqueCategories
            }
        });

    } catch (err) {
        console.error('Products error:', err);
        res.status(500).json({ error: 'Failed to load products.' });
    }
});

/**
 * GET /api/store/:slug/promotions
 * Get active promotions (global + company-specific)
 */
router.get('/:slug/promotions', requireCompanyAuth, async (req, res) => {
    try {
        const companyId = req.company.id;
        if (!isValidUUID(companyId)) {
            return res.status(400).json({ error: 'Invalid company identifier.' });
        }
        const now = new Date().toISOString();

        // Fetch company-specific promotions
        const { data: companyPromos } = await supabaseAdmin
            .from('promotions')
            .select(`
                id, promo_price, promo_label, description, starts_at, ends_at, company_id,
                products (id, brand, name, sku, description, price, previous_price, case_qty, unit, image_url, category)
            `)
            .eq('company_id', companyId)
            .eq('is_active', true)
            .lte('starts_at', now)
            .gte('ends_at', now);

        // Fetch global promotions separately (avoids .or() interpolation)
        const { data: globalPromos } = await supabaseAdmin
            .from('promotions')
            .select(`
                id, promo_price, promo_label, description, starts_at, ends_at, company_id,
                products (id, brand, name, sku, description, price, previous_price, case_qty, unit, image_url, category)
            `)
            .is('company_id', null)
            .eq('is_active', true)
            .lte('starts_at', now)
            .gte('ends_at', now);

        const promotions = [...(companyPromos || []), ...(globalPromos || [])];
        const error = null;

        if (error) {
            console.error('Promotions fetch error:', error);
            return res.status(500).json({ error: 'Failed to load promotions.' });
        }

        // Tag each promotion as global or company-specific
        const tagged = (promotions || []).map(p => ({
            ...p,
            is_global: p.company_id === null,
            savings: p.products ? (p.products.price - p.promo_price).toFixed(2) : '0.00',
            savings_pct: p.products ? Math.round((1 - p.promo_price / p.products.price) * 100) : 0
        }));

        res.json({ promotions: tagged });

    } catch (err) {
        console.error('Promotions error:', err);
        res.status(500).json({ error: 'Failed to load promotions.' });
    }
});

/**
 * GET /api/store/:slug/locations
 * Get company locations for order form dropdown
 */
router.get('/:slug/locations', requireCompanyAuth, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('company_locations')
            .select('id, name, city, address')
            .eq('company_id', req.company.id)
            .eq('is_active', true)
            .order('sort_order')
            .order('city')
            .order('name');

        if (error) throw error;
        res.json({ locations: data || [] });
    } catch (err) {
        console.error('[Locations API] Error:', err);
        res.status(500).json({ error: 'Failed to load locations.' });
    }
});

/**
 * POST /api/store/:slug/orders
 * Submit a new order
 */
router.post('/:slug/orders', requireCompanyAuth, async (req, res) => {
    try {
        const companyId = req.company.id;
        const {
            contact_name, contact_email, contact_phone,
            po_number, location, items, notes
        } = sanitizeObject(req.body);

        // Validate required fields
        if (!contact_name || !contact_email || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Contact name, email, and at least one item are required.' });
        }

        if (!po_number || !po_number.trim()) {
            return res.status(400).json({ error: 'PO Number is required.' });
        }

        if (!isValidUUID(companyId)) {
            return res.status(400).json({ error: 'Invalid company identifier.' });
        }

        // Validate item quantities
        for (const item of items) {
            const qty = parseInt(item.quantity);
            if (!item.product_id || !isValidUUID(item.product_id) || !qty || qty < 1 || qty > 9999) {
                return res.status(400).json({ error: 'Invalid product or quantity. Quantities must be between 1 and 9999.' });
            }
        }

        // Validate and calculate totals from server-side prices
        const productIds = items.map(i => i.product_id);
        const { data: products } = await supabaseAdmin
            .from('products')
            .select('id, name, sku, price, case_qty')
            .eq('company_id', companyId)
            .in('id', productIds);

        if (!products || products.length !== productIds.length) {
            return res.status(400).json({ error: 'One or more products not found.' });
        }

        // Check for active promotions on these products (separate queries to avoid .or() injection)
        const now = new Date().toISOString();
        const { data: companyOrderPromos } = await supabaseAdmin
            .from('promotions')
            .select('product_id, promo_price')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .lte('starts_at', now)
            .gte('ends_at', now)
            .in('product_id', productIds);

        const { data: globalOrderPromos } = await supabaseAdmin
            .from('promotions')
            .select('product_id, promo_price')
            .is('company_id', null)
            .eq('is_active', true)
            .lte('starts_at', now)
            .gte('ends_at', now)
            .in('product_id', productIds);

        const promoMap = {};
        // Global promos first, then company-specific (company overrides global)
        (globalOrderPromos || []).forEach(p => { promoMap[p.product_id] = p.promo_price; });
        (companyOrderPromos || []).forEach(p => { promoMap[p.product_id] = p.promo_price; });

        const productMap = {};
        products.forEach(p => { productMap[p.id] = p; });

        // Build verified line items with server-side pricing
        let subtotal = 0;
        const verifiedItems = items.map(item => {
            const product = productMap[item.product_id];
            const effectivePrice = promoMap[item.product_id] || product.price;
            const qty = parseInt(item.quantity) || 1;
            const lineTotal = effectivePrice * qty;
            subtotal += lineTotal;

            return {
                product_id: product.id,
                name: product.name,
                sku: product.sku,
                quantity: qty,
                unit_price: effectivePrice,
                was_promo: !!promoMap[item.product_id],
                subtotal: lineTotal
            };
        });

        const total = subtotal; // Tax can be added here if needed

        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .insert({
                company_id: companyId,
                contact_name: stripHtml(contact_name),
                contact_email: stripHtml(contact_email),
                contact_phone: stripHtml(contact_phone || ''),
                company_name: req.company.name,
                po_number: stripHtml(po_number),
                location: stripHtml(location || ''),
                items: verifiedItems,
                subtotal,
                total,
                notes: stripHtml(notes || ''),
                status: 'pending',
                status_history: [{ status: 'pending', timestamp: now, note: 'Order placed' }]
            })
            .select()
            .single();

        if (error) {
            console.error('Order insert error:', error);
            return res.status(500).json({ error: 'Failed to submit order.' });
        }

        // Send email notification (non-blocking — don't fail the order if email fails)
        try {
            // Get company's email_config for notification routing
            const { data: companyData } = await supabaseAdmin
                .from('companies')
                .select('email_config, contact_email')
                .eq('id', companyId)
                .single();

            const notificationEmail = companyData?.email_config?.notification_email || companyData?.contact_email;

            if (notificationEmail) {
                sendOrderNotification({
                    to: notificationEmail,
                    order: { ...order, items: verifiedItems },
                    companyName: req.company.name,
                    contactName: stripHtml(contact_name),
                    contactEmail: stripHtml(contact_email),
                    contactPhone: stripHtml(contact_phone || ''),
                    poNumber: stripHtml(po_number),
                    location: stripHtml(location || ''),
                    notes: stripHtml(notes || '')
                }).catch(err => console.error('Order email failed (non-blocking):', err.message));
            }
        } catch (emailErr) {
            console.error('Email lookup error (non-blocking):', emailErr.message);
        }

        res.status(201).json({
            message: 'Order submitted successfully!',
            order: {
                id: order.id,
                order_number: order.order_number,
                total: order.total,
                status: order.status,
                created_at: order.created_at
            }
        });

    } catch (err) {
        console.error('Order submission error:', err);
        res.status(500).json({ error: 'Failed to submit order.' });
    }
});

/**
 * GET /api/store/:slug/orders
 * Get order history for the authenticated company session
 */
router.get('/:slug/orders', requireCompanyAuth, async (req, res) => {
    try {
        const { data: orders, error } = await supabaseAdmin
            .from('orders')
            .select('id, order_number, contact_name, contact_email, total, status, location, created_at, items')
            .eq('company_id', req.company.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            console.error('Orders fetch error:', error);
            return res.status(500).json({ error: 'Failed to load orders.' });
        }

        res.json({ orders: orders || [] });

    } catch (err) {
        console.error('Orders error:', err);
        res.status(500).json({ error: 'Failed to load orders.' });
    }
});

module.exports = router;
