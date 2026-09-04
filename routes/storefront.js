const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { stripHtml, sanitizeObject, isValidUUID } = require('../utils/sanitize');
const { sendOrderNotification } = require('../utils/email');
const { resolveOrderPo, poSettings, formatPo } = require('../utils/po');
const { taxSettings, computeTax } = require('../utils/tax');
const { paymentsEnabled, publicPaymentConfig, getStripe } = require('../utils/payments');
const { barcodeVariants, canonicalBarcode } = require('../utils/inventory');

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
 * GET /api/store/:slug/products
 * Get product catalog for authenticated company
 */
router.get('/:slug/products', requireCompanyAuth, async (req, res) => {
    try {
        const companyId = req.company.id;
        const { brand, category, search, location_id, page = 1, limit = 100 } = req.query;

        // Location-based category lockdown (e.g., Nova Scotia shops -> Equipment/Booth only)
        let effectiveCategory = category;
        let lockedCategory = null;
        if (location_id && isValidUUID(location_id)) {
            const { data: loc } = await supabaseAdmin
                .from('company_locations')
                .select('restrict_to_category')
                .eq('id', location_id).eq('company_id', companyId).single();
            if (loc && loc.restrict_to_category) { lockedCategory = loc.restrict_to_category; effectiveCategory = loc.restrict_to_category; }
        }

        let query = supabaseAdmin
            .from('products')
            .select('*', { count: 'exact' })
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('brand')
            .order('sort_order')
            .order('name');

        if (brand) query = query.eq('brand', brand);
        if (effectiveCategory) query = query.eq('category', effectiveCategory);
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
            locked_category: lockedCategory,
            filters: {
                brands: uniqueBrands,
                categories: lockedCategory ? [lockedCategory] : uniqueCategories
            }
        });

    } catch (err) {
        console.error('Products error:', err);
        res.status(500).json({ error: 'Failed to load products.' });
    }
});

/**
 * GET /api/store/:slug/products/lookup?code=&location_id=
 *
 * Scan a barcode (or type a part number) straight into the cart, the same way
 * refinishAI Inventory looks a code up against a shelf — but this is ordering,
 * not stock, so it exists whether or not that module is on. A UPC/EAN checks
 * against product_barcodes first; failing that, the code is tried as a SKU, so
 * a keyboard-wedge scan of a shelf label works the same as scanning the item
 * itself. The same location category-lock that narrows browsing narrows a scan
 * too — a Nova Scotia branch cannot order paint by scanning it any more than it
 * can order it by clicking it.
 */
router.get('/:slug/products/lookup', requireCompanyAuth, async (req, res) => {
    try {
        const companyId = req.company.id;

        let restrictCategory = null;
        if (req.query.location_id && isValidUUID(req.query.location_id)) {
            const { data: loc } = await supabaseAdmin
                .from('company_locations')
                .select('restrict_to_category')
                .eq('id', req.query.location_id).eq('company_id', companyId).maybeSingle();
            if (loc && loc.restrict_to_category) restrictCategory = loc.restrict_to_category;
        }

        const raw = String(req.query.code || '').trim().slice(0, 128);
        if (!raw) return res.status(400).json({ error: 'No code supplied.' });

        const variants = barcodeVariants(raw);
        let products = [];
        let matchedBy = 'barcode';

        if (variants.length) {
            const { data, error } = await supabaseAdmin
                .from('product_barcodes')
                .select('barcode, symbology, products!inner(*)')
                .in('barcode', variants)
                .eq('products.company_id', companyId)
                .eq('products.is_active', true)
                .limit(20);
            if (error) throw error;
            products = dedupeStoreProducts((data || []).map(r => r.products));
        }

        if (products.length === 0) {
            matchedBy = 'sku';
            const { data } = await supabaseAdmin
                .from('products')
                .select('*')
                .eq('company_id', companyId)
                .eq('is_active', true)
                .ilike('sku', raw)
                .limit(20);
            products = dedupeStoreProducts(data || []);
        }

        if (restrictCategory) {
            products = products.filter(p => (p.category || '') === restrictCategory);
        }

        if (products.length === 0) {
            return res.status(404).json({
                error: restrictCategory
                    ? `No product matches that code in ${restrictCategory}.`
                    : 'No product matches that code.',
                code: raw,
                canonical: canonicalBarcode(raw)
            });
        }

        if (products.length > 1) {
            return res.status(300).json({
                ambiguous: true,
                message: 'More than one item shares this code — choose the one you are holding.',
                code: raw,
                matched_by: matchedBy,
                candidates: products
            });
        }

        res.json({ code: raw, matched_by: matchedBy, product: products[0] });
    } catch (err) {
        console.error('Storefront lookup error:', err);
        res.status(500).json({ error: 'Failed to look up that code.' });
    }
});

function dedupeStoreProducts(list) {
    const seen = new Map();
    for (const p of list) {
        if (p && p.id && !seen.has(p.id)) seen.set(p.id, p);
    }
    return [...seen.values()];
}

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
            .select('id, name, city, address, province, restrict_to_category')
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
/**
 * POST /api/store/:slug/track
 * Lightweight, anonymous usage logging (visit / login / enter-store). Never blocks the store.
 */
router.post('/:slug/track', async (req, res) => {
    try {
        const { event, location_id, session_id } = req.body || {};
        const ev = ['visit', 'login', 'enter'].includes(event) ? event : 'visit';
        const { data: company } = await supabaseAdmin
            .from('companies').select('id').eq('slug', req.params.slug).single();
        if (!company) return res.json({ ok: true });
        await supabaseAdmin.from('console_visits').insert({
            company_id: company.id,
            slug: req.params.slug,
            event: ev,
            location_id: (location_id && isValidUUID(location_id)) ? location_id : null,
            session_id: (session_id || '').toString().slice(0, 64),
            ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64),
            user_agent: (req.headers['user-agent'] || '').toString().slice(0, 300)
        });
        res.json({ ok: true });
    } catch (e) { res.json({ ok: true }); }
});

router.post('/:slug/orders', requireCompanyAuth, async (req, res) => {
    try {
        const companyId = req.company.id;
        const {
            contact_name, contact_email, contact_phone,
            po_number, location, location_id, items, notes
        } = sanitizeObject(req.body);

        // Validate required fields
        if (!contact_name || !contact_email || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Contact name, email, and at least one item are required.' });
        }

        // How the PO is handled is a per-company choice. Until this existed the
        // field was mandatory for everybody, which is why a shop with no
        // purchase-order system ended up typing the same number every time.
        const { data: poCompany } = await supabaseAdmin
            .from('companies').select('settings').eq('id', companyId).maybeSingle();

        const poDecision = resolveOrderPo(poCompany?.settings, po_number);
        if (!poDecision.ok) {
            return res.status(400).json({ error: poDecision.error });
        }

        if (!isValidUUID(companyId)) {
            return res.status(400).json({ error: 'Invalid company identifier.' });
        }

        // Location is required and must be a real, active location belonging to this company.
        // We resolve the authoritative name from the DB and never trust client-supplied text.
        if (!location_id || !isValidUUID(location_id)) {
            return res.status(400).json({ error: 'Please select your location before submitting your order.' });
        }
        const { data: locationRow, error: locationLookupError } = await supabaseAdmin
            .from('company_locations')
            .select('id, name, supplier_branch_id, restrict_to_category, notify_emails')
            .eq('id', location_id)
            .eq('company_id', companyId)
            .eq('is_active', true)
            .single();
        if (locationLookupError || !locationRow) {
            return res.status(400).json({ error: 'Selected location is not valid for this account.' });
        }
        const resolvedLocationName = locationRow.name;

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
            .select('id, name, sku, price, case_qty, category, price_on_request')
            .eq('company_id', companyId)
            .in('id', productIds);

        if (!products || products.length !== productIds.length) {
            return res.status(400).json({ error: 'One or more products not found.' });
        }

        // Enforce location category lockdown at order time (defense in depth)
        if (locationRow.restrict_to_category) {
            const offItem = products.find(p => (p.category || '') !== locationRow.restrict_to_category);
            if (offItem) {
                return res.status(400).json({ error: `This location can only order ${locationRow.restrict_to_category} items. Please remove other items from your cart.` });
            }
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
            const qty = parseInt(item.quantity) || 1;

            // A price-on-request item is quoted by the branch when the order is
            // picked. It must not be totalled at zero: that would tell the
            // customer the order costs less than it does, and give the branch
            // nothing to notice. It is carried at null with an explicit flag,
            // and the order records that it is not fully priced.
            //
            // A promotion on a quoted item still applies — a real promo price
            // is a real price, and overrides the quote.
            const promoPrice = promoMap[item.product_id];
            const quoted = product.price_on_request === true && promoPrice === undefined;

            const effectivePrice = quoted ? null : (promoPrice || product.price);
            const lineTotal = quoted ? null : effectivePrice * qty;
            if (!quoted) subtotal += lineTotal;

            return {
                product_id: product.id,
                name: product.name,
                sku: product.sku,
                quantity: qty,
                unit_price: effectivePrice,
                was_promo: !!promoPrice,
                price_on_request: quoted,
                subtotal: lineTotal
            };
        });

        // Not stored as its own column: every line already carries the flag, so
        // a separate count would be a second source of truth able to disagree
        // with the lines beneath it. Derived where it is needed instead.
        const quotedItems = verifiedItems.filter(i => i.price_on_request);

        // Tax is computed on the priced subtotal only — a price-on-request line
        // has no price yet, so it cannot be taxed yet either. poCompany.settings
        // was already fetched above for the PO decision; reusing it here avoids
        // a second read of the same row for the same request.
        const resolvedTax = taxSettings(poCompany?.settings);
        const tax = computeTax(subtotal, resolvedTax.rate);
        const total = subtotal + tax;

        // ------------------------------------------------------------------
        // Allocate the PO number LAST, immediately before the insert.
        //
        // Deliberately not earlier: every validation above can still reject the
        // order, and a number consumed by an order that was then refused is a
        // gap in the shop's sequence with nothing to explain it. Allocating
        // here means the only way to burn a number is to actually place an
        // order — which is the behaviour a shop expects and can reconcile.
        // ------------------------------------------------------------------
        let finalPo = null;
        let poSource = 'none';

        if (poDecision.action === 'manual') {
            finalPo = poDecision.po_number;
            poSource = 'manual';
        } else if (poDecision.action === 'allocate') {
            const { data: allocated, error: allocError } = await supabaseAdmin
                .rpc('allocate_po_number', { p_company_id: companyId });

            const row = Array.isArray(allocated) ? allocated[0] : allocated;
            if (allocError || !row) {
                // No sequence configured. Refusing is right: silently falling
                // back to a typed PO, or to none, would produce an order whose
                // numbering nobody can account for later.
                console.error('PO allocation failed:', allocError?.message || 'no sequence for company');
                return res.status(409).json({
                    error: 'Purchase order numbering is not set up for this account yet. Please contact CHC.'
                });
            }

            finalPo = formatPo(row.prefix, row.seq, {
                padWidth: row.pad_width,
                checkDigit: row.use_check_digit
            });
            poSource = 'generated';
        }

        const { data: order, error } = await supabaseAdmin
            .from('orders')
            .insert({
                company_id: companyId,
                contact_name: stripHtml(contact_name),
                contact_email: stripHtml(contact_email),
                contact_phone: stripHtml(contact_phone || ''),
                company_name: req.company.name,
                po_number: finalPo,
                po_source: poSource,
                location: resolvedLocationName,
                location_id: locationRow.id,
                // When the customer signed in as an individual, attribute the
                // order to them so the owner can see who placed it.
                placed_by_user_id: req.companyUser ? req.companyUser.id : null,
                items: verifiedItems,
                subtotal,
                tax,
                tax_rate: resolvedTax.rate,
                total,
                notes: stripHtml(notes || ''),
                status: 'pending',
                status_history: [{
                    status: 'pending', timestamp: now,
                    note: quotedItems.length
                        ? `Order placed — ${quotedItems.length} item(s) to be priced by the branch`
                        : 'Order placed'
                }]
            })
            .select()
            .single();

        if (error) {
            // 23505 on the PO index means this number has been used before by
            // this company. That is the constraint doing its job — the whole
            // point of the feature — so it deserves a message the shop can act
            // on rather than a generic failure.
            if (error.code === '23505' && /po/i.test(error.message || '')) {
                return res.status(409).json({
                    error: poSource === 'generated'
                        ? 'That purchase order number has already been used. Please try again.'
                        : `Purchase order ${finalPo} has already been used on another order. Please use a different number.`,
                    po_number: finalPo,
                    field: 'po_number'
                });
            }
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

            // Notify the company notification/contact email plus every configured manager.
            const cfg = companyData?.email_config || {};
            const managerEmails = Array.isArray(cfg.manager_emails) ? cfg.manager_emails : [];
            // Company contact email (if the company has one set). Managers below are the optional per-company group.
            const companyContact = companyData?.contact_email;

            // Route to the servicing CHC branch assigned to this order's location.
            let branchEmails = [];
            if (locationRow.supplier_branch_id) {
                const { data: branch } = await supabaseAdmin
                    .from('supplier_branches')
                    .select('emails, is_active')
                    .eq('id', locationRow.supplier_branch_id)
                    .single();
                if (branch && branch.is_active !== false && Array.isArray(branch.emails)) branchEmails = branch.emails;
            }

            // Always email the person who placed the order + the company contact (if set)
            // + the optional manager/general group + the servicing CHC branch.
            const ordererEmail = String(contact_email || '').trim().toLowerCase();
            const recipients = [...new Set(
                [ordererEmail, ...(companyContact ? [companyContact] : []), ...managerEmails, ...(Array.isArray(locationRow.notify_emails) ? locationRow.notify_emails : []), ...branchEmails]
                    .map(e => String(e || '').trim().toLowerCase())
                    .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
            )];
            // Replies (from the branch/CHC) go back to the person who ordered, then the company contact.
            const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ordererEmail) ? ordererEmail : (companyContact || undefined);

            if (recipients.length) {
                sendOrderNotification({
                    to: recipients,
                    replyTo,
                    order: { ...order, items: verifiedItems },
                    companyName: req.company.name,
                    contactName: stripHtml(contact_name),
                    contactEmail: stripHtml(contact_email),
                    contactPhone: stripHtml(contact_phone || ''),
                    poNumber: finalPo,
                    location: resolvedLocationName,
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
                // Returned so the confirmation can show it. When CHC issued the
                // number this is the only moment the shop sees it, and their
                // accounts department will be asked for it later.
                po_number: order.po_number,
                po_source: order.po_source,
                subtotal: order.subtotal,
                tax: order.tax,
                tax_rate: order.tax_rate,
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
            .select('id, order_number, contact_name, contact_email, subtotal, tax, tax_rate, total, status, location, location_id, created_at, items, invoice_filename, invoice_uploaded_at')
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

/**
 * GET /api/store/:slug/reports/orders
 * Filtered orders for reporting: by location, date range. Returns line items too.
 * Branches may view all and filter; scoping/aggregation happens client-side.
 */
router.get('/:slug/reports/orders', requireCompanyAuth, async (req, res) => {
    try {
        const { location_id, from, to } = req.query;
        let q = supabaseAdmin
            .from('orders')
            .select('id, order_number, contact_name, po_number, status, subtotal, tax, tax_rate, total, location, location_id, created_at, items')
            .eq('company_id', req.company.id)
            .order('created_at', { ascending: false })
            .limit(5000);
        if (location_id) q = q.eq('location_id', location_id);
        if (from) q = q.gte('created_at', from);
        if (to) q = q.lte('created_at', to);
        const { data, error } = await q;
        if (error) { console.error('Reports fetch error:', error); return res.status(500).json({ error: 'Failed to load report data.' }); }
        res.json({ orders: data || [] });
    } catch (err) {
        console.error('Reports error:', err);
        res.status(500).json({ error: 'Failed to load report data.' });
    }
});

/**
 * GET /api/store/:slug/payments/config
 * Tells the storefront whether online card payment is available for this tenant.
 * Returns { enabled:false } unless Stripe keys are configured AND the company opted in.
 */
router.get('/:slug/payments/config', requireCompanyAuth, async (req, res) => {
    try {
        const { data: company } = await supabaseAdmin
            .from('companies')
            .select('settings')
            .eq('id', req.company.id)
            .single();
        res.json(publicPaymentConfig(company));
    } catch (err) {
        console.error('Payment config error:', err);
        res.json({ enabled: false, provider: 'stripe', publishable_key: null });
    }
});

/**
 * POST /api/store/:slug/payments/create-intent
 * Pre-wired Stripe PaymentIntent creation for an existing order.
 * INERT until Stripe keys + the company payments flag are enabled — returns 503 otherwise.
 * Body: { order_id }
 */
router.post('/:slug/payments/create-intent', requireCompanyAuth, async (req, res) => {
    try {
        const companyId = req.company.id;
        const { order_id } = req.body || {};

        const { data: company } = await supabaseAdmin
            .from('companies')
            .select('settings')
            .eq('id', companyId)
            .single();

        if (!paymentsEnabled(company)) {
            return res.status(503).json({ error: 'Online payments are not enabled for this account.' });
        }
        if (!order_id || !isValidUUID(order_id)) {
            return res.status(400).json({ error: 'A valid order_id is required.' });
        }

        // Always price from the server-side order, never the client.
        const { data: order, error: orderErr } = await supabaseAdmin
            .from('orders')
            .select('id, total, order_number, payment_status')
            .eq('id', order_id)
            .eq('company_id', companyId)
            .single();
        if (orderErr || !order) {
            return res.status(404).json({ error: 'Order not found.' });
        }
        if (order.payment_status === 'paid') {
            return res.status(409).json({ error: 'This order has already been paid.' });
        }

        const stripe = getStripe();
        const intent = await stripe.paymentIntents.create({
            amount: Math.round(parseFloat(order.total) * 100), // cents
            currency: 'cad',
            metadata: { order_id: order.id, order_number: order.order_number, company_id: companyId },
            automatic_payment_methods: { enabled: true }
        });

        await supabaseAdmin
            .from('orders')
            .update({ payment_provider: 'stripe', payment_intent_id: intent.id, payment_status: 'pending' })
            .eq('id', order.id);

        // TODO (activation): confirm payment client-side with Stripe.js using this client_secret,
        // then rely on the /api/webhooks/stripe handler to mark the order 'paid'.
        res.json({ client_secret: intent.client_secret });
    } catch (err) {
        console.error('Create payment intent error:', err);
        res.status(500).json({ error: 'Failed to start payment.' });
    }
});

/**
 * GET /api/store/:slug/orders/:orderId/invoice
 * Returns a short-lived signed download URL for the order's invoice (company-scoped).
 */
router.get('/:slug/orders/:orderId/invoice', requireCompanyAuth, async (req, res) => {
    try {
        const { data: order } = await supabaseAdmin
            .from('orders').select('id, invoice_path, invoice_filename')
            .eq('id', req.params.orderId).eq('company_id', req.company.id).single();
        if (!order || !order.invoice_path) {
            return res.status(404).json({ error: 'No invoice available for this order.' });
        }
        const { data: signed, error } = await supabaseAdmin.storage
            .from('invoices')
            .createSignedUrl(order.invoice_path, 300);  // inline: opens the PDF in the browser instead of forcing a desktop download
        if (error || !signed) {
            console.error('Invoice signed URL error:', error);
            return res.status(500).json({ error: 'Failed to prepare invoice download.' });
        }
        res.json({ url: signed.signedUrl, filename: order.invoice_filename });
    } catch (err) {
        console.error('Invoice download error:', err);
        res.status(500).json({ error: 'Failed to get invoice.' });
    }
});

// ============================================================
// refinishAI INVENTORY (optional module, per company)
//
// Mounted here rather than in server.js so the whole module can be added or
// removed without touching application bootstrap. The sub-router applies its
// own requireCompanyAuth and refuses companies that have not enabled it, so a
// customer on the ordering portal alone is unaffected by its presence.
// ============================================================
/**
 * GET /api/store/:slug/po/config
 *
 * What the checkout should do about purchase orders. Returned rather than
 * inferred client-side, so the form and the server can never disagree about
 * whether a PO is required.
 */
router.get('/:slug/po/config', requireCompanyAuth, async (req, res) => {
    try {
        const { data: company } = await supabaseAdmin
            .from('companies').select('settings').eq('id', req.company.id).maybeSingle();

        const settings = poSettings(company?.settings);

        let example = null;
        if (settings.issued_by_chc) {
            const { data: seq } = await supabaseAdmin
                .from('company_po_sequences')
                .select('prefix, next_number, pad_width, use_check_digit')
                .eq('company_id', req.company.id)
                .maybeSingle();
            // The NEXT number, shown so the shop knows what to expect — not
            // allocated, because looking at a checkout page must never consume
            // a number from the sequence.
            if (seq) {
                example = formatPo(seq.prefix, seq.next_number, {
                    padWidth: seq.pad_width, checkDigit: seq.use_check_digit
                });
            }
        }

        res.json({
            mode: settings.mode,
            required: settings.required,
            issued_by_chc: settings.issued_by_chc,
            configured: settings.issued_by_chc ? Boolean(example) : true,
            next_example: example
        });
    } catch (err) {
        console.error('PO config error:', err);
        res.status(500).json({ error: 'Failed to load purchase order settings.' });
    }
});

/**
 * GET /api/store/:slug/tax/config
 *
 * The rate the cart should preview before checkout. The order route always
 * recomputes this itself at submit time from the same company settings — this
 * endpoint exists only so the cart total on screen doesn't disagree with what
 * the order will actually be charged.
 */
router.get('/:slug/tax/config', requireCompanyAuth, async (req, res) => {
    try {
        const { data: company } = await supabaseAdmin
            .from('companies').select('settings').eq('id', req.company.id).maybeSingle();

        const settings = taxSettings(company?.settings);
        res.json(settings);
    } catch (err) {
        console.error('Tax config error:', err);
        res.status(500).json({ error: 'Failed to load tax settings.' });
    }
});

router.use('/:slug/inventory', require('./inventory-store'));

// Company-owner management of their own customer users (Customer-users module).
router.use('/:slug/users', require('./company-users-store'));

module.exports = router;
