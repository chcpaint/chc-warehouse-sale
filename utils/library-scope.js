/**
 * utils/library-scope.js -- every distributor has its own Item Library.
 *
 * The library (and its import history and change log) holds a distributor's
 * own supplier catalogue, including its list prices, so one distributor must
 * never read or write another's. Every query on those tables goes through
 * libraryTable(), which:
 *   - select / update / delete: adds  distributor_id = <this distributor>
 *   - insert / upsert:          stamps distributor_id on every row (and
 *                               ignores any distributor_id the caller passed)
 *
 * The distributor is the one the request arrived on (req.distributor, set by
 * utils/tenant.js and enforced against the signed-in account by
 * middleware/auth.js), or an id passed directly.
 *
 * Without a distributor (unit tests that mount a router without the tenant
 * middleware) queries are not narrowed; in the running app every request has
 * one, so that branch is never taken there.
 */
const { supabaseAdmin } = require('./supabase');

const TABLES = new Set(['item_library', 'item_library_changes', 'item_library_imports']);

function distributorIdOf(reqOrId) {
    if (!reqOrId) return null;
    if (typeof reqOrId === 'string') return reqOrId;
    return (reqOrId.distributor && reqOrId.distributor.id) || null;
}

function libraryTable(reqOrId, table = 'item_library') {
    if (!TABLES.has(table)) throw new Error(`libraryTable: ${table} is not a library table`);
    const id = distributorIdOf(reqOrId);
    const base = () => supabaseAdmin.from(table);
    if (!id) return base();
    const stamp = rows => Array.isArray(rows) ? rows.map(r => ({ ...r, distributor_id: id })) : { ...rows, distributor_id: id };
    const strip = v => { if (v && typeof v === 'object' && 'distributor_id' in v) { const { distributor_id, ...rest } = v; return rest; } return v; };
    return {
        select: (...a) => base().select(...a).eq('distributor_id', id),
        insert: (rows, ...o) => base().insert(stamp(rows), ...o),
        upsert: (rows, ...o) => base().upsert(stamp(rows), ...o),
        update: (v, ...o) => base().update(strip(v), ...o).eq('distributor_id', id),
        delete: (...o) => base().delete(...o).eq('distributor_id', id)
    };
}

/** The library of the distributor a company belongs to. */
async function libraryTableForCompany(companyId, table = 'item_library') {
    const { data } = await supabaseAdmin.from('companies').select('distributor_id').eq('id', companyId).maybeSingle();
    return libraryTable((data && data.distributor_id) || null, table);
}

module.exports = { libraryTable, libraryTableForCompany, distributorIdOf, TABLES };
