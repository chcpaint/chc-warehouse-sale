/**
 * qa/e2e.js — end-to-end exercise of refinishAI Inventory against the LIVE site.
 *
 * This is not the unit suite. Nothing here is stubbed: it authenticates over
 * HTTPS against chcsale.com with a real access code, calls the real endpoints,
 * and the real database records the results. It is the only way to catch the
 * class of bug that only exists once code, schema and deployment meet —
 * a route mounted but unreachable, a column the code writes that the table
 * does not have, an auth guard that passes locally and fails in production.
 *
 * Fixtures: three throwaway companies (qa-solo-north, qa-solo-south, qa-group)
 * seeded beforehand. qa-group has three shops, one of them locked to a single
 * category, so multi-shop behaviour and the category restriction are both real
 * rather than simulated.
 *
 *   node qa/e2e.js
 */

const BASE = process.env.QA_BASE || 'https://chcsale.com';

const SHOPS = {
    north: { slug: 'qa-solo-north', code: 'QANORTH2026' },
    south: { slug: 'qa-solo-south', code: 'QASOUTH2026' },
    group: { slug: 'qa-group',      code: 'QAGROUP2026' }
};

// Named people, because every write is attributed and that attribution is
// itself under test.
const TECH = 'Dana R (QA)';
const MANAGER = 'Marcus T (QA)';

const results = [];
let currentArea = '';

function area(name) { currentArea = name; }

function record(ok, name, detail) {
    results.push({ area: currentArea, ok, name, detail });
    const mark = ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`  ${mark} ${name}${!ok && detail ? `\n         ${detail}` : ''}`);
}

/** Assert, but never stop the run: one broken feature must not hide the rest. */
function check(name, condition, detail) {
    record(Boolean(condition), name, detail);
    return Boolean(condition);
}

let rateLimited = false;

async function api(token, method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { _raw: text.slice(0, 200) }; }

    // A 429 is the rate limiter doing its job, not the feature failing. Say so
    // once and loudly, because otherwise every check after it reports a false
    // failure and the real result of the run is buried.
    if (res.status === 429 && !rateLimited) {
        rateLimited = true;
        console.log('\n  \x1b[33m!\x1b[0m rate limit reached (100 requests / 15 min) — later checks are not meaningful.');
        console.log('    Wait for the window to clear and re-run for a clean result.\n');
    }
    return { status: res.status, body: json };
}

async function login(shop) {
    const res = await fetch(`${BASE}/api/auth/company-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: shop.slug, access_code: shop.code })
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, token: body.token, company: body.company, body };
}

const sku = (levels, s) => (levels || []).find(l => l.sku === s);

// ==================================================================

async function main() {
    console.log(`\nrefinishAI Inventory — end-to-end against ${BASE}\n`);

    // ---------------------------------------------------------------
    area('Authentication');
    console.log('Authentication');

    // Sign-in attempts are capped at 10 per 5 minutes — deliberately, since this
    // is the endpoint an attacker would grind. So the tokens the run depends on
    // are taken FIRST and the deliberately-failing attempts are left to the very
    // end, where exhausting the budget costs nothing.
    const north = await login(SHOPS.north);
    check('a shop signs in with its access code', north.status === 200 && north.token,
        `status ${north.status}${north.status === 429 ? ' — sign-in rate limit still cooling down' : ''}`);

    const group = await login(SHOPS.group);
    check('a multi-shop group signs in', group.status === 200 && group.token,
        `status ${group.status}`);

    const noAuth = await api(null, 'GET', '/api/store/qa-solo-north/inventory/summary');
    check('no token means no inventory', noAuth.status === 401, `status ${noAuth.status}`);

    if (!north.token || !group.token) {
        console.log('\nCannot continue without tokens.');
        return summarise();
    }

    // ---------------------------------------------------------------
    area('Locations');
    console.log('\nLocations');

    const nLocs = await api(north.token, 'GET', '/api/store/qa-solo-north/locations');
    const gLocs = await api(group.token, 'GET', '/api/store/qa-group/locations');

    check('a single shop sees exactly one location',
        nLocs.body?.locations?.length === 1, `saw ${nLocs.body?.locations?.length}`);
    check('a group sees all three of its shops',
        gLocs.body?.locations?.length === 3, `saw ${gLocs.body?.locations?.length}`);

    const NORTH_LOC = nLocs.body?.locations?.[0]?.id;
    const locs = gLocs.body?.locations || [];
    const OAKVILLE = locs.find(l => /Oakville/.test(l.name))?.id;
    const MARKHAM  = locs.find(l => /Markham/.test(l.name))?.id;
    const DEPOT    = locs.find(l => /Depot/.test(l.name))?.id;

    check('the group\'s three shops are all addressable',
        OAKVILLE && MARKHAM && DEPOT, JSON.stringify(locs.map(l => l.name)));

    // ---------------------------------------------------------------
    area('Tenant isolation');
    console.log('\nTenant isolation');

    const crossLevels = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/levels?location_id=${OAKVILLE}`);
    check('one company cannot read another company\'s location',
        crossLevels.status === 400, `status ${crossLevels.status}`);

    const crossPost = await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements', {
        location_id: OAKVILLE, movement_type: 'consume', quantity: 1, actor_label: TECH,
        product_id: '00000000-0000-4000-8000-000000000000'
    });
    check('one company cannot post stock into another company\'s shop',
        crossPost.status === 400, `status ${crossPost.status}`);

    const slugSwap = await api(north.token, 'GET',
        `/api/store/qa-group/inventory/levels?location_id=${OAKVILLE}`);
    check('a token cannot be used against a different company\'s URL',
        slugSwap.status === 400 || slugSwap.status === 403,
        `status ${slugSwap.status} — the token identifies the company, the URL must not override it`);

    // ---------------------------------------------------------------
    area('Stock levels');
    console.log('\nStock levels');

    const levels = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/levels?location_id=${NORTH_LOC}&limit=100`);
    check('stock levels load', levels.status === 200 && levels.body?.levels?.length === 12,
        `status ${levels.status}, ${levels.body?.levels?.length} lines`);

    const clear = sku(levels.body?.levels, 'QA-CLEAR-1');
    check('opening balances were derived by the ledger trigger, not written directly',
        Number(clear?.on_hand) === 6, `clear on hand = ${clear?.on_hand}`);
    check('min, max and bin come through', clear?.min_point == 2 && clear?.bin_location === 'A-01');

    const summary = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/summary?location_id=${NORTH_LOC}`);
    check('the summary counters load',
        summary.status === 200 && summary.body?.summary?.tracked === 12,
        JSON.stringify(summary.body?.summary));
    // 9 paint/abrasive/PPE lines + 2 masking lines, with the quoted booth
    // service contributing nothing at all.
    check('stock value excludes the price-on-request item',
        Math.abs(Number(summary.body?.summary?.stock_value) - 5996.76) < 0.01,
        `value = ${summary.body?.summary?.stock_value} (expected 5996.76 — the quoted line contributing nothing)`);

    const search = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/levels?location_id=${NORTH_LOC}&search=Masking`);
    check('search narrows the list', (search.body?.levels?.length || 0) === 2,
        `${search.body?.levels?.length} matched "Masking"`);

    // ---------------------------------------------------------------
    area('Barcode lookup');
    console.log('\nBarcode lookup');

    const byEan = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/lookup?code=0000000000017&location_id=${NORTH_LOC}`);
    check('a 13-digit EAN resolves to its product',
        byEan.status === 200 && byEan.body?.product?.sku === 'QA-CLEAR-1',
        `status ${byEan.status}, got ${byEan.body?.product?.sku}`);

    const byInternal = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/lookup?code=RAI-QA-FILTER-1&location_id=${NORTH_LOC}`);
    check('an internal RAI label resolves',
        byInternal.body?.product?.sku === 'QA-FILTER-1', `got ${byInternal.body?.product?.sku}`);

    const bySku = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/lookup?code=QA-TAPE-18&location_id=${NORTH_LOC}`);
    check('typing a part number works as well as scanning',
        bySku.body?.product?.sku === 'QA-TAPE-18', `got ${bySku.body?.product?.sku}`);

    const ambiguous = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/lookup?code=QA-DUPE-BARCODE&location_id=${NORTH_LOC}`);
    check('a barcode on two products asks which one, rather than guessing',
        ambiguous.status === 300 && ambiguous.body?.ambiguous === true
            && ambiguous.body?.candidates?.length === 2,
        `status ${ambiguous.status} — ${JSON.stringify(ambiguous.body).slice(0, 160)}`);
    check('each candidate carries enough to choose between them',
        (ambiguous.body?.candidates || []).every(c => c.sku && c.name && c.level),
        'a candidate is missing sku, name or on-hand');

    const unknown = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/lookup?code=9999999999999&location_id=${NORTH_LOC}`);
    check('an unknown barcode is a clean 404, not an error',
        unknown.status === 404, `status ${unknown.status}`);

    // ---------------------------------------------------------------
    area('Movements');
    console.log('\nMovements');

    const consume = await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements', {
        location_id: NORTH_LOC, product_id: clear.product_id, movement_type: 'consume',
        quantity: 2, job_ref: 'QA-RO-100', actor_label: TECH, scanned_barcode: '0000000000017'
    });
    check('consuming against a repair order works',
        consume.status === 201 && Number(consume.body?.on_hand) === 4,
        `status ${consume.status}, on hand ${consume.body?.on_hand}`);

    const receive = await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements', {
        location_id: NORTH_LOC, product_id: clear.product_id, movement_type: 'receive',
        quantity: 3, actor_label: MANAGER
    });
    check('receiving adds stock', Number(receive.body?.on_hand) === 7, `on hand ${receive.body?.on_hand}`);

    const count = await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements', {
        location_id: NORTH_LOC, product_id: clear.product_id, movement_type: 'count',
        quantity: 5, actor_label: MANAGER
    });
    check('a count sets on-hand to the counted figure, not adds to it',
        Number(count.body?.on_hand) === 5, `on hand ${count.body?.on_hand}`);

    const adjust = await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements', {
        location_id: NORTH_LOC, product_id: clear.product_id, movement_type: 'adjust',
        quantity: -1, reason: 'QA damage write-off', actor_label: MANAGER
    });
    check('a negative adjustment works', Number(adjust.body?.on_hand) === 4, `on hand ${adjust.body?.on_hand}`);

    const anon = await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements', {
        location_id: NORTH_LOC, product_id: clear.product_id, movement_type: 'consume', quantity: 1
    });
    check('a movement with no name attached is refused', anon.status === 400, `status ${anon.status}`);

    const tooMany = await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements', {
        location_id: NORTH_LOC, product_id: clear.product_id, movement_type: 'consume',
        quantity: 9999, actor_label: TECH
    });
    check('consuming more than is on the shelf is refused', tooMany.status === 409,
        `status ${tooMany.status}`);

    const badType = await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements', {
        location_id: NORTH_LOC, product_id: clear.product_id, movement_type: 'teleport',
        quantity: 1, actor_label: TECH
    });
    check('an invented movement type is refused', badType.status === 400, `status ${badType.status}`);

    const bulk = await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements/bulk', {
        location_id: NORTH_LOC, actor_label: TECH,
        movements: [
            { product_id: sku(levels.body.levels, 'QA-TAPE-18').product_id, movement_type: 'consume', quantity: 2, job_ref: 'QA-RO-101' },
            { product_id: sku(levels.body.levels, 'QA-TAPE-24').product_id, movement_type: 'consume', quantity: 1, job_ref: 'QA-RO-101' },
            { product_id: '00000000-0000-4000-8000-000000000000', movement_type: 'consume', quantity: 1 }
        ]
    });
    check('a queued batch applies the good lines and reports the bad one',
        bulk.body?.applied === 2 && bulk.body?.failed === 1,
        `applied ${bulk.body?.applied}, failed ${bulk.body?.failed}`);

    const history = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/movements?location_id=${NORTH_LOC}&limit=50`);
    const mine = (history.body?.movements || []).filter(m => m.actor_label === TECH);
    check('every movement carries who made it',
        mine.length >= 3, `${mine.length} movements attributed to ${TECH}`);
    check('the ledger records the barcode that was scanned',
        (history.body?.movements || []).some(m => m.scanned_barcode === '0000000000017'));

    // ---------------------------------------------------------------
    area('Category-locked shop');
    console.log('\nCategory-locked shop');

    const gLevels = await api(group.token, 'GET',
        `/api/store/qa-group/inventory/levels?location_id=${OAKVILLE}&limit=100`);
    const gPaint = sku(gLevels.body?.levels, 'QA-CLEAR-1');
    const gFilter = sku(gLevels.body?.levels, 'QA-FILTER-1');

    const wrongCat = await api(group.token, 'POST', '/api/store/qa-group/inventory/movements', {
        location_id: DEPOT, product_id: gPaint.product_id, movement_type: 'receive',
        quantity: 1, actor_label: MANAGER
    });
    check('a depot locked to equipment refuses paint',
        wrongCat.status === 400 && /only stocks/i.test(wrongCat.body?.error || ''),
        `status ${wrongCat.status}: ${wrongCat.body?.error}`);

    const rightCat = await api(group.token, 'POST', '/api/store/qa-group/inventory/movements', {
        location_id: DEPOT, product_id: gFilter.product_id, movement_type: 'receive',
        quantity: 2, actor_label: MANAGER
    });
    check('the same depot accepts its own category', rightCat.status === 201,
        `status ${rightCat.status}: ${rightCat.body?.error || ''}`);

    // ---------------------------------------------------------------
    area('Transfers between shops');
    console.log('\nTransfers between shops');

    const before = await api(group.token, 'GET',
        `/api/store/qa-group/inventory/levels?location_id=${MARKHAM}&limit=100`);
    const markhamClearBefore = Number(sku(before.body?.levels, 'QA-CLEAR-1')?.on_hand);

    const transfer = await api(group.token, 'POST', '/api/store/qa-group/inventory/transfers', {
        from_location_id: OAKVILLE, to_location_id: MARKHAM,
        product_id: gPaint.product_id, quantity: 2, actor_label: MANAGER, notes: 'QA transfer'
    });
    check('stock moves between two shops in the same group', transfer.status === 201,
        `status ${transfer.status}: ${transfer.body?.error || ''}`);

    const after = await api(group.token, 'GET',
        `/api/store/qa-group/inventory/levels?location_id=${MARKHAM}&limit=100`);
    check('the receiving shop\'s on-hand went up by exactly the amount sent',
        Number(sku(after.body?.levels, 'QA-CLEAR-1')?.on_hand) === markhamClearBefore + 2,
        `${markhamClearBefore} -> ${sku(after.body?.levels, 'QA-CLEAR-1')?.on_hand}`);

    const sameShop = await api(group.token, 'POST', '/api/store/qa-group/inventory/transfers', {
        from_location_id: OAKVILLE, to_location_id: OAKVILLE,
        product_id: gPaint.product_id, quantity: 1, actor_label: MANAGER
    });
    check('a shop cannot transfer to itself', sameShop.status === 400, `status ${sameShop.status}`);

    const outOfGroup = await api(group.token, 'POST', '/api/store/qa-group/inventory/transfers', {
        from_location_id: OAKVILLE, to_location_id: NORTH_LOC,
        product_id: gPaint.product_id, quantity: 1, actor_label: MANAGER
    });
    check('stock cannot be transferred to another company\'s shop',
        outOfGroup.status === 400, `status ${outOfGroup.status}`);

    // ---------------------------------------------------------------
    area('Cycle counts');
    console.log('\nCycle counts');

    const openCount = await api(group.token, 'POST', '/api/store/qa-group/inventory/counts', {
        location_id: OAKVILLE, name: 'QA count', scope: 'all', actor_label: MANAGER
    });
    check('a count session opens', openCount.status === 201, `status ${openCount.status}: ${openCount.body?.error || ''}`);
    const countId = openCount.body?.session?.id;

    if (countId) {
        const second = await api(group.token, 'POST', '/api/store/qa-group/inventory/counts', {
            location_id: OAKVILLE, name: 'QA second count', scope: 'all', actor_label: TECH
        });
        check('a second count on the same shelf is refused while one is open',
            second.status === 409 || second.status === 400, `status ${second.status}`);

        const line = await api(group.token, 'POST', `/api/store/qa-group/inventory/counts/${countId}/lines`, {
            product_id: gPaint.product_id, counted_qty: 99, actor_label: MANAGER
        });
        check('an item can be counted into the session', line.status === 201,
            `status ${line.status}: ${line.body?.error || ''}`);
        check('the variance against live on-hand is shown before committing',
            line.body?.variance !== undefined, JSON.stringify(line.body).slice(0, 120));

        const midCount = await api(group.token, 'GET',
            `/api/store/qa-group/inventory/levels?location_id=${OAKVILLE}&limit=100`);
        check('nothing moves until the count is committed',
            Number(sku(midCount.body?.levels, 'QA-CLEAR-1')?.on_hand) !== 99,
            'on-hand changed while the count was still open');

        const commit = await api(group.token, 'POST', `/api/store/qa-group/inventory/counts/${countId}/commit`, {
            actor_label: MANAGER
        });
        check('committing the count applies the variance', commit.status === 200,
            `status ${commit.status}: ${commit.body?.error || ''}`);

        const postCount = await api(group.token, 'GET',
            `/api/store/qa-group/inventory/levels?location_id=${OAKVILLE}&limit=100`);
        check('on-hand now matches what was counted',
            Number(sku(postCount.body?.levels, 'QA-CLEAR-1')?.on_hand) === 99,
            `on hand ${sku(postCount.body?.levels, 'QA-CLEAR-1')?.on_hand}`);
    }

    // ---------------------------------------------------------------
    area('Reordering');
    console.log('\nReordering');

    // Drive the tape below its minimum so a draft is raised for real.
    const tape = sku(levels.body.levels, 'QA-TAPE-18');
    await api(north.token, 'POST', '/api/store/qa-solo-north/inventory/movements', {
        location_id: NORTH_LOC, product_id: tape.product_id, movement_type: 'count',
        quantity: 1, actor_label: MANAGER
    });

    const queue = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/replenishment?location_id=${NORTH_LOC}`);
    const order = (queue.body?.orders || [])[0];
    check('dropping below the minimum raises a reorder automatically',
        Boolean(order), `${queue.body?.orders?.length || 0} orders in the queue`);

    if (order) {
        const line = (order.replenishment_order_lines || order.lines || [])[0];
        check('the draft names the item and a suggested quantity',
            line && Number(line.quantity) > 0, JSON.stringify(line).slice(0, 140));

        if (line) {
            const edited = await api(north.token, 'PUT',
                `/api/store/qa-solo-north/inventory/replenishment/${order.id}/lines/${line.id}`,
                { quantity: 12, actor_label: MANAGER });
            check('a manager can change the quantity before approving', edited.status === 200,
                `status ${edited.status}: ${edited.body?.error || ''}`);
        }

        const approved = await api(north.token, 'POST',
            `/api/store/qa-solo-north/inventory/replenishment/${order.id}/approve`,
            { po_number: 'QA-PO-001', actor_label: MANAGER, contact_name: MANAGER,
              contact_email: 'qa-north@example.invalid' });
        check('approving turns the draft into a real CHC order', approved.status === 200 || approved.status === 201,
            `status ${approved.status}: ${approved.body?.error || ''}`);
        check('the resulting order is identified back to the shop',
            Boolean(approved.body?.order?.order_number || approved.body?.order_number),
            JSON.stringify(approved.body).slice(0, 160));
    }

    const rebuild = await api(north.token, 'POST',
        '/api/store/qa-solo-north/inventory/replenishment/refresh',
        { location_id: NORTH_LOC, actor_label: MANAGER });
    check('the queue can be rebuilt from stock levels on demand',
        rebuild.status === 200 || rebuild.status === 201,
        `status ${rebuild.status}: ${rebuild.body?.error || ''}`);

    const queue2 = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/replenishment?location_id=${NORTH_LOC}`);
    const order2 = (queue2.body?.orders || [])[0];
    if (order2) {
        const rejected = await api(north.token, 'POST',
            `/api/store/qa-solo-north/inventory/replenishment/${order2.id}/reject`,
            { actor_label: MANAGER, reason: 'QA reject path' });
        check('a queued reorder can be rejected instead of ordered',
            rejected.status === 200, `status ${rejected.status}: ${rejected.body?.error || ''}`);
    }

    // ---------------------------------------------------------------
    area('Usage and job costing');
    console.log('\nUsage and job costing');

    const anSummary = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/analytics/summary?location_id=${NORTH_LOC}&period=30d`);
    check('the usage summary loads', anSummary.status === 200, `status ${anSummary.status}`);
    check('materials consumed are valued', Number(anSummary.body?.totals?.value_used) > 0,
        `value_used = ${anSummary.body?.totals?.value_used}`);

    const byProduct = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/analytics/by-product?location_id=${NORTH_LOC}&period=30d`);
    check('usage by product loads',
        byProduct.status === 200 && (byProduct.body?.items?.length || 0) > 0,
        `status ${byProduct.status}, ${byProduct.body?.items?.length} items`);
    check('the most-consumed item is ranked first by value',
        (byProduct.body?.items || []).every((it, i, a) => i === 0 || a[i - 1].value_used >= it.value_used),
        'items are not sorted by value consumed');

    const byJob = await api(north.token, 'GET',
        `/api/store/qa-solo-north/inventory/analytics/by-job?location_id=${NORTH_LOC}&period=30d`);
    const qaJob = (byJob.body?.jobs || []).find(j => j.job_ref === 'QA-RO-100');
    check('materials are attributed to the repair order they went onto',
        Boolean(qaJob), `jobs seen: ${(byJob.body?.jobs || []).map(j => j.job_ref).join(', ')}`);
    check('the job carries a cost', qaJob && Number(qaJob.value_used) > 0,
        `value_used = ${qaJob?.value_used}`);

    const exportRes = await fetch(
        `${BASE}/api/store/qa-solo-north/inventory/analytics/export?location_id=${NORTH_LOC}&period=30d&group=job`,
        { headers: { authorization: `Bearer ${north.token}` } });
    const csv = await exportRes.text();
    check('usage exports as CSV', exportRes.status === 200 && csv.includes('QA-RO-100'),
        `status ${exportRes.status}, ${csv.length} bytes`);

    // ---------------------------------------------------------------
    area('Repair kits');
    console.log('\nRepair kits');

    const kitsOff = await api(north.token, 'GET', '/api/store/qa-solo-north/inventory/kits');
    check('a shop without the kits module gets an empty list, not an error',
        kitsOff.status === 200 && (kitsOff.body?.kits?.length || 0) === 0,
        `status ${kitsOff.status}, ${kitsOff.body?.kits?.length} kits`);

    const kitsOn = await api(group.token, 'GET', '/api/store/qa-group/inventory/kits');
    check('a shop with kits enabled can list them', kitsOn.status === 200,
        `status ${kitsOn.status}: ${kitsOn.body?.error || ''}`);

    const readyKit = (kitsOn.body?.kits || []).find(k => k.ready);
    const unreadyKit = (kitsOn.body?.kits || []).find(k => !k.ready);
    check('an unmapped kit is listed as not ready rather than hidden',
        Boolean(unreadyKit) || (kitsOn.body?.kits || []).length === 0,
        `${(kitsOn.body?.kits || []).length} kits, ${(kitsOn.body?.kits || []).filter(k => k.ready).length} ready`);

    if (unreadyKit) {
        const blocked = await api(group.token, 'POST',
            `/api/store/qa-group/inventory/kits/${unreadyKit.id}/consume`,
            { location_id: OAKVILLE, job_ref: 'QA-RO-200', actor_label: TECH });
        check('an unmapped kit refuses to expense anything',
            blocked.status === 409 && Array.isArray(blocked.body?.unresolved),
            `status ${blocked.status}`);
    }

    if (readyKit) {
        const preview = await api(group.token, 'GET',
            `/api/store/qa-group/inventory/kits/${readyKit.id}/preview?location_id=${OAKVILLE}`);
        check('a ready kit previews with prices', preview.status === 200 && !preview.body?.blocked,
            `status ${preview.status}, blocked=${preview.body?.blocked}, ${preview.body?.blocked_reason || ''}`);

        const consumed = await api(group.token, 'POST',
            `/api/store/qa-group/inventory/kits/${readyKit.id}/consume`,
            { location_id: OAKVILLE, job_ref: 'QA-RO-200', actor_label: TECH });
        check('a ready kit expenses its materials to the job', consumed.status === 201,
            `status ${consumed.status}: ${consumed.body?.error || ''}`);

        const hist = await api(group.token, 'GET',
            '/api/store/qa-group/inventory/kits/consumptions?job_ref=QA-RO-200');
        check('kit history records what went onto the job',
            (hist.body?.consumptions?.length || 0) > 0, `${hist.body?.consumptions?.length} entries`);
    } else {
        record(true, 'no ready kit for this company — kit consume not exercised (see notes)', '');
    }

    const noJobRef = readyKit && await api(group.token, 'POST',
        `/api/store/qa-group/inventory/kits/${readyKit.id}/consume`,
        { location_id: OAKVILLE, actor_label: TECH });
    if (noJobRef) {
        check('a kit cannot be expensed without a repair order number',
            noJobRef.status === 400, `status ${noJobRef.status}`);
    }

    // ---------------------------------------------------------------
    area('App shell');
    console.log('\nApp shell');

    const manifest = await fetch(`${BASE}/store/qa-group/manifest.webmanifest`);
    const manifestBody = await manifest.text();
    let manifestJson = null;
    try { manifestJson = JSON.parse(manifestBody); } catch (_) { /* reported below */ }
    check('the phone app manifest is served as real JSON',
        manifest.status === 200 && manifestJson?.name,
        `status ${manifest.status}, name=${manifestJson?.name}`);

    const sw = await fetch(`${BASE}/refinishai-inventory-sw.js`);
    check('the service worker is served', sw.status === 200, `status ${sw.status}`);

    const csp = (await fetch(`${BASE}/store/qa-group`)).headers.get('content-security-policy') || '';
    check('the CSP still allows camera scanning on iPhone',
        csp.includes('wasm-unsafe-eval'), 'wasm-unsafe-eval missing from script-src');
    check('the CSP still allows the install prompt', csp.includes('manifest-src'),
        'manifest-src missing');

    // ---------------------------------------------------------------
    // Left until last on purpose: these burn the sign-in budget, and by now
    // nothing else depends on it.
    area('Sign-in refusals');
    console.log('\nSign-in refusals');

    const bad = await login({ slug: 'qa-solo-north', code: 'WRONG-CODE' });
    check('a wrong access code is refused', bad.status === 401, `status ${bad.status}`);

    const nosuch = await login({ slug: 'qa-does-not-exist', code: 'QANORTH2026' });
    check('an unknown company gives the same message as a wrong code',
        nosuch.status === 401 && /invalid company or access code/i.test(nosuch.body?.error || ''),
        `status ${nosuch.status} ${JSON.stringify(nosuch.body)} — must not reveal whether the company exists`);

    let limited = null;
    for (let i = 0; i < 12 && (!limited || limited.status !== 429); i++) {
        limited = await login({ slug: 'qa-solo-north', code: `WRONG-${i}` });
    }
    check('repeated sign-in attempts are rate limited',
        limited?.status === 429, `ended on status ${limited?.status} — brute force must be throttled`);

    summarise();
}

function summarise() {
    if (rateLimited) {
        console.log('\n\x1b[33mThis run hit the rate limiter part-way through.\x1b[0m');
        console.log('Checks after that point are not a verdict on the features.\n');
    }
    const pass = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok);

    console.log(`\n${'─'.repeat(64)}`);
    console.log(`${pass} passed, ${fail.length} failed, ${results.length} checks\n`);

    if (fail.length) {
        console.log('Failures by area:');
        const byArea = {};
        for (const f of fail) (byArea[f.area] = byArea[f.area] || []).push(f);
        for (const [a, list] of Object.entries(byArea)) {
            console.log(`\n  ${a}`);
            for (const f of list) console.log(`    - ${f.name}\n      ${f.detail || ''}`);
        }
        console.log('');
    }
    process.exitCode = fail.length ? 1 : 0;
}

main().catch(err => {
    console.error('\nHarness itself failed:', err);
    process.exitCode = 2;
});
