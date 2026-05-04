const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { stripHtml, sanitizeObject, isValidUUID } = require('../utils/sanitize');
const { sendOrderNotification } = require('../utils/email');

const router = express.Router();

/**
 * POST /api/store/seed-locations
 * TEMPORARY - seed Assured locations into the correct Supabase
 * REMOVE AFTER USE
 */
router.post('/seed-locations', async (req, res) => {
    try {
        const secret = req.body.setup_secret;
        if (secret !== 'CHC-TEMP-SETUP-2026') {
            return res.status(403).json({ error: 'Invalid secret.' });
        }

        // Look up Assured company in THIS database
        const { data: company } = await supabaseAdmin
            .from('companies')
            .select('id, name, slug')
            .eq('slug', 'assured')
            .single();

        if (!company) {
            return res.status(404).json({ error: 'Assured company not found.' });
        }

        const companyId = company.id;

        // Clear existing locations for this company first
        await supabaseAdmin.from('company_locations').delete().eq('company_id', companyId);

        // All 80 Assured locations
        const locations = [
            { name: "Assured - Ajax", city: "Ajax" },
            { name: "Assured - Aurora", city: "Aurora" },
            { name: "Assured - Barrie (Bayfield)", city: "Barrie" },
            { name: "Assured - Barrie (Dunlop)", city: "Barrie" },
            { name: "Assured - Bolton", city: "Bolton" },
            { name: "Assured - Bowmanville", city: "Bowmanville" },
            { name: "Assured - Brampton (Chrysler)", city: "Brampton" },
            { name: "Assured - Brampton (Coventry)", city: "Brampton" },
            { name: "Assured - Brampton (Glidden)", city: "Brampton" },
            { name: "Assured - Brantford", city: "Brantford" },
            { name: "Assured - Burlington (Brant)", city: "Burlington" },
            { name: "Assured - Burlington (Mainway)", city: "Burlington" },
            { name: "Assured - Cambridge (Hespeler)", city: "Cambridge" },
            { name: "Assured - Cambridge (Sheldon)", city: "Cambridge" },
            { name: "Assured - Concord", city: "Concord" },
            { name: "Assured - East York", city: "East York" },
            { name: "Assured - Etobicoke (Belfield)", city: "Etobicoke" },
            { name: "Assured - Etobicoke (Westmore)", city: "Etobicoke" },
            { name: "Assured - Georgetown", city: "Georgetown" },
            { name: "Assured - Grimsby", city: "Grimsby" },
            { name: "Assured - Guelph", city: "Guelph" },
            { name: "Assured - Hamilton (Barton)", city: "Hamilton" },
            { name: "Assured - Hamilton (Centennial)", city: "Hamilton" },
            { name: "Assured - Hamilton (Kenora)", city: "Hamilton" },
            { name: "Assured - Hamilton (Upper James)", city: "Hamilton" },
            { name: "Assured - Hamilton (Upper Wellington)", city: "Hamilton" },
            { name: "Assured - Innisfil", city: "Innisfil" },
            { name: "Assured - Kanata", city: "Kanata" },
            { name: "Assured - Kingston (Dalton)", city: "Kingston" },
            { name: "Assured - Kingston (Fortune)", city: "Kingston" },
            { name: "Assured - Kitchener (Bingemans)", city: "Kitchener" },
            { name: "Assured - Kitchener (Victoria)", city: "Kitchener" },
            { name: "Assured - Lindsay", city: "Lindsay" },
            { name: "Assured - London (Clarke)", city: "London" },
            { name: "Assured - London (Pond Mills)", city: "London" },
            { name: "Assured - London (Wharncliffe)", city: "London" },
            { name: "Assured - Markham", city: "Markham" },
            { name: "Assured - Milton", city: "Milton" },
            { name: "Assured - Mississauga (Argentia)", city: "Mississauga" },
            { name: "Assured - Mississauga (Dundas)", city: "Mississauga" },
            { name: "Assured - Mississauga (Lakeshore)", city: "Mississauga" },
            { name: "Assured - Mississauga (Mavis)", city: "Mississauga" },
            { name: "Assured - Newmarket", city: "Newmarket" },
            { name: "Assured - Niagara Falls", city: "Niagara Falls" },
            { name: "Assured - North York (Dufferin)", city: "North York" },
            { name: "Assured - North York (Magnetic)", city: "North York" },
            { name: "Assured - Oakville (Speers)", city: "Oakville" },
            { name: "Assured - Oakville (Wyecroft)", city: "Oakville" },
            { name: "Assured - Orangeville", city: "Orangeville" },
            { name: "Assured - Orillia", city: "Orillia" },
            { name: "Assured - Oshawa (Bond)", city: "Oshawa" },
            { name: "Assured - Oshawa (Wentworth)", city: "Oshawa" },
            { name: "Assured - Ottawa (Bantree)", city: "Ottawa" },
            { name: "Assured - Ottawa (Citigate)", city: "Ottawa" },
            { name: "Assured - Ottawa (Merivale)", city: "Ottawa" },
            { name: "Assured - Peterborough", city: "Peterborough" },
            { name: "Assured - Pickering", city: "Pickering" },
            { name: "Assured - Richmond Hill", city: "Richmond Hill" },
            { name: "Assured - Sarnia", city: "Sarnia" },
            { name: "Assured - Scarborough (Birchmount)", city: "Scarborough" },
            { name: "Assured - Scarborough (Milner)", city: "Scarborough" },
            { name: "Assured - St. Catharines (Bunting)", city: "St. Catharines" },
            { name: "Assured - St. Catharines (Eastchester)", city: "St. Catharines" },
            { name: "Assured - Stoney Creek", city: "Stoney Creek" },
            { name: "Assured - Sudbury", city: "Sudbury" },
            { name: "Assured - Thunder Bay", city: "Thunder Bay" },
            { name: "Assured - Toronto (Danforth)", city: "Toronto" },
            { name: "Assured - Toronto (Dufferin)", city: "Toronto" },
            { name: "Assured - Toronto (Dupont)", city: "Toronto" },
            { name: "Assured - Toronto (Kennedy)", city: "Toronto" },
            { name: "Assured - Toronto (Lake Shore)", city: "Toronto" },
            { name: "Assured - Vaughan", city: "Vaughan" },
            { name: "Assured - Waterloo", city: "Waterloo" },
            { name: "Assured - Welland", city: "Welland" },
            { name: "Assured - Whitby", city: "Whitby" },
            { name: "Assured - Windsor (Division)", city: "Windsor" },
            { name: "Assured - Windsor (Walker)", city: "Windsor" },
            { name: "Assured - Woodbridge", city: "Woodbridge" },
            { name: "Assured - Woodstock", city: "Woodstock" },
            { name: "Assured - York", city: "York" }
        ];

        const rows = locations.map((loc, i) => ({
            company_id: companyId,
            name: loc.name,
            city: loc.city,
            address: '',
            sort_order: i,
            is_active: true
        }));

        const { data: inserted, error } = await supabaseAdmin
            .from('company_locations')
            .insert(rows)
            .select('id');

        if (error) {
            return res.status(500).json({ error: 'Insert failed', detail: error.message });
        }

        res.json({
            message: 'Locations seeded',
            company_id: companyId,
            company_name: company.name,
            count: inserted.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

        const uniqueBrands = [...new Set(brands?.map(b => b.brand) || [])];

        const { data: categories } = await supabaseAdmin
            .from('products')
            .select('category')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .not('category', 'is', null)
            .order('category');

        const uniqueCategories = [...new Set(categories?.map(c => c.category) || [])];

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
        console.log(`[Locations API] Fetching for company_id: ${req.company.id}, slug: ${req.params.slug}`);
        const { data, error } = await supabaseAdmin
            .from('company_locations')
            .select('id, name, city, address')
            .eq('company_id', req.company.id)
            .eq('is_active', true)
            .order('sort_order')
            .order('city')
            .order('name');

        if (error) {
            console.error('[Locations API] Supabase error:', error);
            throw error;
        }
        console.log(`[Locations API] Returning ${(data || []).length} locations`);
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
            location, items, notes
        } = sanitizeObject(req.body);

        // Validate required fields
        if (!contact_name || !contact_email || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Contact name, email, and at least one item are required.' });
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
