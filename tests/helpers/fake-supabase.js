/**
 * tests/helpers/fake-supabase.js
 *
 * A small in-memory stand-in for the supabase-js query builder, covering the
 * operations the inventory routes actually use. It exists so the HTTP layer —
 * routing, auth guards, validation, status codes — can be tested without a
 * database or network.
 *
 * It deliberately reproduces two behaviours the real client has that the routes
 * depend on:
 *   - the inventory_levels / stock_movements relationship (a movement updates
 *     on_hand and stamps on_hand_after, exactly as the DB trigger does)
 *   - the unique constraints that make upserts idempotent
 */

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/**
 * Columns the real tables actually have, for the tables whose inserts are built
 * by hand in route code.
 *
 * This exists because of a bug that reached a commit: an insert added
 * `orders.needs_pricing`, a column that does not exist. Every test passed —
 * the fake happily stored the unknown key — and it would have 500'd every
 * order in production. A stub that accepts more than the database does is worse
 * than no stub, because it converts a certain failure into a confident pass.
 *
 * Only tables worth guarding are listed; an unlisted table is not checked.
 * Kept in sync by hand with migrations/.
 */
const KNOWN_COLUMNS = {
    // Kept in step with the live orders table. This list is what caught
    // `needs_pricing` before it shipped, and it is what caught
    // `placed_by_user_id` arriving without the fake being updated — so when a
    // migration adds a column, add it here in the same change.
    orders: new Set([
        'id', 'company_id', 'order_number', 'contact_name', 'contact_email', 'contact_phone',
        'company_name', 'location', 'items', 'subtotal', 'tax', 'total',
        'notes', 'status', 'status_history', 'created_at', 'updated_at',
        'po_number', 'location_id',
        'payment_status', 'payment_provider', 'payment_intent_id', 'amount_paid', 'paid_at',
        'invoice_path', 'invoice_filename', 'invoice_uploaded_at', 'invoice_uploaded_by',
        'closed_at', 'closed_by',
        'po_source', 'po_normalized', 'placed_by_user_id'
    ]),
    company_po_sequences: new Set([
        'company_id', 'prefix', 'next_number', 'pad_width', 'use_check_digit',
        'created_at', 'updated_at', 'updated_by'
    ]),
    stock_movements: new Set([
        'id', 'company_id', 'location_id', 'product_id', 'qty_change', 'movement_type',
        'reason', 'source_doc_type', 'source_doc_id', 'scanned_barcode', 'created_by',
        'created_at', 'actor_type', 'actor_label', 'job_ref', 'on_hand_after'
    ]),
    kit_consumptions: new Set([
        'id', 'company_id', 'location_id', 'kit_id', 'kit_name', 'job_ref', 'multiplier',
        'line_count', 'total_cost', 'actor_label', 'actor_type', 'created_by', 'created_at'
    ]),
    scheduler_runs: new Set(['id', 'job', 'run_key', 'detail', 'result', 'started_at', 'finished_at']),
    products: new Set([
        'id', 'company_id', 'brand', 'name', 'sku', 'description', 'category', 'price',
        'previous_price', 'case_qty', 'unit', 'image_url', 'metadata', 'sort_order',
        'is_active', 'created_at', 'updated_at', 'price_on_request'
    ]),
    product_barcodes: new Set([
        'id', 'product_id', 'barcode', 'symbology', 'is_primary', 'created_at',
        'label_printed_at', 'source', 'is_internal'
    ]),
    item_library: new Set([
        'id', 'sku', 'sku_key', 'name', 'brand', 'vendor_code', 'barcode', 'unit',
        'case_qty', 'list_price', 'source', 'source_ref', 'imported_at', 'notes'
    ]),
    item_library_conflicts: new Set([
        'id', 'company_id', 'product_id', 'sku', 'barcode', 'reason',
        'resolved_at', 'resolved_by', 'created_at'
    ])
};

function assertKnownColumns(table, payload) {
    const known = KNOWN_COLUMNS[table];
    if (!known) return;
    for (const key of Object.keys(payload || {})) {
        if (!known.has(key)) {
            const e = new Error(
                `column "${key}" of relation "${table}" does not exist ` +
                `(fake-supabase: add it to KNOWN_COLUMNS if a migration added it)`);
            e.code = '42703';
            throw e;
        }
    }
}

/**
 * Deterministic UUID-shaped ids. The routes guard on isValidUUID(), so ids that
 * merely look unique are not enough — they have to be shaped like real ones.
 */
let uuidSeq = 0;
function fakeUuid() {
    const n = (++uuidSeq).toString(16).padStart(12, '0');
    return `aaaaaaaa-bbbb-4ccc-8ddd-${n}`;
}

function matches(row, filters) {
    return filters.every(f => {
        const val = row[f.col];
        switch (f.op) {
            case 'eq':   return String(val) === String(f.val);
            case 'neq':  return String(val) !== String(f.val);
            case 'in':   return f.val.map(String).includes(String(val));
            case 'is':   return f.val === null ? (val === null || val === undefined) : val === f.val;
            case 'gte':  return val >= f.val;
            case 'lte':  return val <= f.val;
            case 'ilike': {
                const rx = new RegExp('^' + String(f.val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
                return rx.test(String(val ?? ''));
            }
            case 'or': return true;   // the routes only use .or() for search narrowing
            default: return true;
        }
    });
}

class Query {
    constructor(db, table, mode, payload, opts = {}) {
        this.db = db; this.table = table; this.mode = mode;
        this.payload = payload; this.opts = opts;
        this.filters = []; this._limit = null; this._range = null; this._count = false;
        this._embeds = [];
    }

    select(cols = '*', options = {}) {
        this._count = !!options.count;
        this._head = !!options.head;
        // Record any embedded relation names so the result can carry them.
        for (const m of String(cols).matchAll(/([a-z_]+)!?(?:inner)?\s*\(/g)) this._embeds.push(m[1]);
        return this;
    }
    eq(col, val)   { this.filters.push({ col, op: 'eq', val }); return this; }
    neq(col, val)  { this.filters.push({ col, op: 'neq', val }); return this; }
    in(col, val)   { this.filters.push({ col, op: 'in', val }); return this; }
    is(col, val)   { this.filters.push({ col, op: 'is', val }); return this; }
    gte(col, val)  { this.filters.push({ col, op: 'gte', val }); return this; }
    lte(col, val)  { this.filters.push({ col, op: 'lte', val }); return this; }
    ilike(col, val){ this.filters.push({ col, op: 'ilike', val }); return this; }
    or()           { return this; }
    not()          { return this; }
    order()        { return this; }
    limit(n)       { this._limit = n; return this; }
    range(a, b)    { this._range = [a, b]; return this; }

    /**
     * Resolve a filter column, following one level of embed:
     * .eq('products.company_id', x) reads through product_id into products.
     */
    _value(row, col) {
        if (!col.includes('.')) return row[col];
        const [rel, field] = col.split('.');
        const map = { products: ['product_id', 'products'], company_locations: ['location_id', 'company_locations'] };
        const spec = map[rel];
        if (!spec) return undefined;
        const target = (this.db[spec[1]] || []).find(x => x.id === row[spec[0]]);
        return target ? target[field] : undefined;
    }

    rows() {
        const list = this.db[this.table] || [];
        return list.filter(r => this.filters.every(f => matches({ [f.col]: this._value(r, f.col) }, [f])));
    }

    _withEmbeds(rows) {
        return rows.map(r => {
            const out = clone(r);
            for (const rel of this._embeds) {
                if (rel === 'products' && r.product_id) {
                    out.products = clone((this.db.products || []).find(p => p.id === r.product_id)) || null;
                } else if (rel === 'company_locations' && r.location_id) {
                    out.company_locations = clone((this.db.company_locations || []).find(l => l.id === r.location_id)) || null;
                } else if (rel === 'replenishment_order_lines') {
                    out.replenishment_order_lines = clone((this.db.replenishment_order_lines || []).filter(l => l.order_id === r.id));
                } else if (rel === 'repair_kits' && (r.kit_id || r.id)) {
                    // company_kit_access embeds by kit_id; kit_items by kit_id too.
                    out.repair_kits = clone((this.db.repair_kits || []).find(k => k.id === (r.kit_id || r.id))) || null;
                }
            }
            return out;
        });
    }

    async _run() {
        const { db, table } = this;
        db[table] = db[table] || [];

        if (this.mode === 'insert') {
            try {
                const list = Array.isArray(this.payload) ? this.payload : [this.payload];
                const created = list.map(p => db.__insert(table, p));
                return { data: created.length === 1 ? clone(created[0]) : clone(created), error: null };
            } catch (e) {
                return { data: null, error: { message: e.message, code: e.code } };
            }
        }

        if (this.mode === 'upsert') {
            try {
                const list = Array.isArray(this.payload) ? this.payload : [this.payload];
                const keys = String(this.opts.onConflict || 'id').split(',').map(s => s.trim());
                const out = list.map(p => {
                    const found = db[table].find(r => keys.every(k => String(r[k]) === String(p[k])));
                    if (found) { Object.assign(found, p); return found; }
                    return db.__insert(table, p);
                });
                return { data: out.length === 1 ? clone(out[0]) : clone(out), error: null };
            } catch (e) {
                return { data: null, error: { message: e.message, code: e.code } };
            }
        }

        if (this.mode === 'update') {
            try {
                assertKnownColumns(table, this.payload);
            } catch (e) {
                return { data: null, error: { message: e.message, code: e.code } };
            }
            const hit = this.rows();
            hit.forEach(r => Object.assign(r, this.payload));
            if (this._single && hit.length === 0) {
                return { data: null, error: { message: 'no rows updated' } };
            }
            return { data: this._single ? clone(hit[0]) : clone(hit), error: null };
        }

        if (this.mode === 'delete') {
            const hit = this.rows();
            db[table] = db[table].filter(r => !hit.includes(r));
            return { data: clone(hit), error: null };
        }

        // select
        let rows = this.rows();
        const count = rows.length;
        if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
        if (this._limit !== null) rows = rows.slice(0, this._limit);
        rows = this._withEmbeds(rows);

        if (this._single) {
            if (rows.length !== 1) return { data: null, error: { message: 'expected exactly one row' }, count };
            return { data: rows[0], error: null, count };
        }
        if (this._maybe) return { data: rows[0] || null, error: null, count };
        return { data: this._head ? null : rows, error: null, count: this._count ? count : undefined };
    }

    single()      { this._single = true; return this; }
    maybeSingle() { this._maybe = true; return this; }
    then(res, rej) { return this._run().then(res, rej); }
}

function createFakeSupabase(seed = {}) {
    let counter = 0;
    const db = {
        products: [], companies: [], company_locations: [], supplier_branches: [],
        product_barcodes: [], inventory_levels: [], stock_movements: [],
        replenishment_orders: [], replenishment_order_lines: [], inventory_uploads: [],
        inventory_count_sessions: [], inventory_count_lines: [], inventory_transfers: [],
        inventory_alert_log: [], orders: [], promotions: [], audit_log: [],
        repair_kits: [], kit_items: [], company_kit_access: [],
        kit_product_map: [], kit_consumptions: [],
        scheduler_runs: [], inventory_status: [], company_po_sequences: [],
        ...clone(seed)
    };

    db.__insert = (table, payload) => {
        counter++;
        assertKnownColumns(table, payload);
        const row = { id: payload.id || fakeUuid(), created_at: new Date().toISOString(), ...payload };

        // Column defaults the routes rely on reading back. Without these a
        // suppression check that filters on the timestamp finds nothing and
        // every alert looks like the first one.
        if (table === 'inventory_alert_log' && row.sent_at === undefined) {
            row.sent_at = new Date().toISOString();
        }
        if (table === 'scheduler_runs' && row.started_at === undefined) {
            row.started_at = new Date().toISOString();
        }

        // Reproduce the apply_stock_movement trigger: on-hand is the running sum
        // of the ledger, and the resulting balance is stamped on the movement.
        if (table === 'stock_movements') {
            if (Number(row.qty_change) === 0) throw new Error('stock_movements_qty_nonzero_chk');
            let level = db.inventory_levels.find(l =>
                l.location_id === row.location_id && l.product_id === row.product_id);
            if (!level) {
                level = {
                    id: fakeUuid(), company_id: row.company_id, location_id: row.location_id,
                    product_id: row.product_id, on_hand: 0, min_point: null, max_point: null,
                    reorder_qty: null, bin_location: null, is_tracked: true
                };
                db.inventory_levels.push(level);
            }
            level.on_hand = Math.round((Number(level.on_hand) + Number(row.qty_change)) * 10000) / 10000;
            row.on_hand_after = level.on_hand;
        }

        // Reproduce uq_replenishment_open_per_location.
        if (table === 'replenishment_orders' && ['draft', 'pending_approval'].includes(row.status)) {
            const clash = db.replenishment_orders.find(o =>
                o.location_id === row.location_id && ['draft', 'pending_approval'].includes(o.status));
            if (clash) { const e = new Error('duplicate key value violates unique constraint'); e.code = '23505'; throw e; }
        }

        // Reproduce uq_open_count_per_location: two people counting the same
        // shelf into different sessions would each commit against a moving target.
        if (table === 'inventory_count_sessions' && row.status === 'open') {
            const clash = db.inventory_count_sessions.find(c =>
                c.location_id === row.location_id && c.status === 'open');
            if (clash) { const e = new Error('duplicate key value violates unique constraint'); e.code = '23505'; throw e; }
        }

        // Reproduce scheduler_runs_unique. This one is load-bearing rather than
        // defensive: the scheduler's whole multi-instance safety IS this
        // constraint, so a fake that let both inserts through would test the
        // opposite of the real behaviour.
        if (table === 'scheduler_runs') {
            const clash = (db.scheduler_runs || []).find(r =>
                r.job === row.job && r.run_key === row.run_key);
            if (clash) { const e = new Error('duplicate key value violates unique constraint'); e.code = '23505'; throw e; }
        }

        // Reproduce kit_product_map_unique (company_id, kit_item_id).
        if (table === 'kit_product_map') {
            const clash = (db.kit_product_map || []).find(m =>
                m.company_id === row.company_id && m.kit_item_id === row.kit_item_id);
            if (clash) { const e = new Error('duplicate key value violates unique constraint'); e.code = '23505'; throw e; }
        }

        db[table] = db[table] || [];
        db[table].push(row);
        return row;
    };

    // The inventory_status view, computed the same way as the SQL CASE.
    Object.defineProperty(db, 'inventory_status', {
        enumerable: true,
        // A no-op setter: the query builder defensively assigns db[table] = [],
        // which would throw on a getter-only property.
        set() { /* the view is computed, never stored */ },
        get() {
            return db.inventory_levels.map(l => {
                const p = db.products.find(x => x.id === l.product_id) || {};
                const loc = db.company_locations.find(x => x.id === l.location_id) || {};
                const onHand = Number(l.on_hand || 0);
                let status = 'ok';
                if (l.is_tracked === false) status = 'untracked';
                else if (onHand <= 0) status = 'out';
                else if (l.min_point !== null && l.min_point !== undefined && onHand <= Number(l.min_point)) status = 'low';
                return {
                    ...l,
                    location_name: loc.name, sku: p.sku, product_name: p.name, brand: p.brand,
                    category: p.category, price: p.price, case_qty: p.case_qty, unit: p.unit,
                    stock_status: status,
                    suggested_order_qty: Math.max((l.max_point ?? l.min_point ?? 0) - onHand, 0),
                    // Mirrors migration 018: a price-on-request line has no
                    // value, which is NULL rather than 0 so a sum skips it.
                    price_on_request: p.price_on_request === true,
                    line_value: p.price_on_request === true ? null : onHand * Number(p.price || 0)
                };
            });
        }
    });

    const client = {
        db,
        from(table) {
            return {
                select: (...a) => new Query(db, table, 'select').select(...a),
                insert: (payload) => new Query(db, table, 'insert', payload),
                update: (payload) => new Query(db, table, 'update', payload),
                upsert: (payload, opts) => new Query(db, table, 'upsert', payload, opts),
                delete: () => new Query(db, table, 'delete')
            };
        },
        async rpc(name, args) {
            if (name === 'recompute_inventory_on_hand') {
                let fixed = 0;
                for (const level of db.inventory_levels) {
                    if (level.company_id !== args.p_company_id) continue;
                    if (args.p_location_id && level.location_id !== args.p_location_id) continue;
                    const total = db.stock_movements
                        .filter(m => m.location_id === level.location_id && m.product_id === level.product_id)
                        .reduce((s, m) => s + Number(m.qty_change), 0);
                    if (Number(level.on_hand) !== total) { level.on_hand = total; fixed++; }
                }
                return { data: fixed, error: null };
            }
            if (name === 'allocate_po_number') {
                // Mirrors allocate_po_number(): consume the current number and
                // advance the counter. The REAL guarantee is the row lock that
                // makes this atomic under concurrency, and no stub can
                // reproduce that — a single-threaded fake would "prove" safety
                // it has not got. That property is tested for real in
                // qa/e2e-po.js against the live database. What this covers is
                // the shape of the call and the arithmetic.
                const seq = (db.company_po_sequences || [])
                    .find(r => r.company_id === args.p_company_id);
                if (!seq) return { data: [], error: null };

                const issued = Number(seq.next_number);
                seq.next_number = issued + 1;
                return {
                    data: [{
                        prefix: seq.prefix,
                        seq: issued,
                        pad_width: seq.pad_width,
                        use_check_digit: seq.use_check_digit
                    }],
                    error: null
                };
            }
            if (name === 'search_item_library') {
                // Mirrors search_item_library(): match on SKU, barcode or every
                // typed word, and say whether the asking company already sells
                // it. The ranking in the real function is Postgres trigram
                // similarity and is not reproduced here — what this covers is
                // the contract the route depends on: which rows come back, and
                // the already_in_catalogue flag, which is the flag that stops
                // the console offering a duplicate SKU.
                const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
                const raw = String(args.p_query || '').trim();
                const key = norm(raw);
                const words = raw.toLowerCase().split(/\s+/).filter(Boolean);

                const mine = new Map();
                for (const p of db.products || []) {
                    if (p.company_id !== args.p_company_id) continue;
                    const k = norm(p.sku);
                    if (k) mine.set(k, p.id);
                }

                let rows = (db.item_library || []).filter(l => {
                    if (args.p_vendors && !args.p_vendors.includes(l.vendor_code)) return false;
                    if (raw === '') return true;
                    if (key && norm(l.sku).includes(key)) return true;
                    if (l.barcode === raw) return true;
                    return words.length > 0 && words.every(w =>
                        String(l.name || '').toLowerCase().includes(w) ||
                        String(l.sku || '').toLowerCase().includes(w));
                });

                rows = rows.map(l => ({
                    ...l,
                    existing_product_id: mine.get(norm(l.sku)) || null,
                    already_in_catalogue: mine.has(norm(l.sku))
                }));

                if (args.p_only_new) rows = rows.filter(r => !r.already_in_catalogue);

                const total = rows.length;
                const offset = Number(args.p_offset) || 0;
                const limit = Number(args.p_limit) || 50;
                return {
                    data: rows.slice(offset, offset + limit)
                        .map(r => ({ ...r, rank: 1, total_count: total })),
                    error: null
                };
            }
            return { data: null, error: { message: `unknown rpc ${name}` } };
        }
    };

    return client;
}

module.exports = { createFakeSupabase };
