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
        scheduler_runs: [], inventory_status: [],
        ...clone(seed)
    };

    db.__insert = (table, payload) => {
        counter++;
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
                    suggested_order_qty: Math.max((l.max_point ?? l.min_point ?? 0) - onHand, 0)
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
            return { data: null, error: { message: `unknown rpc ${name}` } };
        }
    };

    return client;
}

module.exports = { createFakeSupabase };
