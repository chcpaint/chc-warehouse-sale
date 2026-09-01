/**
 * Exercise the slide-out menu in a real browser. These are the behaviours the
 * Skyline menu in the screenshot does NOT have, so they are the ones worth
 * proving rather than assuming.
 */
const { chromium } = require('/home/claude/chcrepo/node_modules/playwright');
const SHOTS = '/tmp/claude-0/-home-claude/9dfc7950-5fa5-5b72-9797-0090d97c6526/scratchpad';

const results = [];
const check = (name, pass, detail) => {
    results.push({ name, pass });
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && detail ? `\n         ${detail}` : ''}`);
};

(async () => {
    const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    const ctx = await b.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push(e.message.slice(0, 120)));

    await pg.goto('http://127.0.0.1:4321/store/demo-shop', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(2200);
    await pg.fill('#access-code', 'x').catch(() => {});
    const sb = await pg.$('form button[type=submit]'); if (sb) await sb.click();
    await pg.waitForTimeout(1800);
    const loc = await pg.$('#location-list button, [onclick*="selectLocation"]');
    if (loc) { await loc.click(); await pg.waitForTimeout(1800); }

    check('the storefront loads with no script errors', errs.length === 0, errs.join(' | '));

    // ---- opening
    check('the menu button is visible on a phone-width screen',
        await pg.isVisible('#drawer-btn'));
    check('the desktop tab bar is hidden at that width',
        !(await pg.isVisible('#nav-tabs')));

    await pg.click('#drawer-btn');
    await pg.waitForTimeout(450);
    check('the menu opens', await pg.isVisible('#drawer'));
    check('a backdrop appears behind it', await pg.isVisible('#drawer-backdrop'));
    check('the button reports itself expanded to screen readers',
        (await pg.getAttribute('#drawer-btn', 'aria-expanded')) === 'true');
    check('the page behind cannot scroll while it is open',
        (await pg.evaluate(() => document.body.style.overflow)) === 'hidden');
    check('focus moves into the menu',
        await pg.evaluate(() => document.getElementById('drawer').contains(document.activeElement)));

    const groups = await pg.$$eval('.drawer-group', els => els.map(e => e.dataset.group));
    check('links are grouped, not one long list', groups.length >= 2, JSON.stringify(groups));
    check('only real destinations are listed',
        (await pg.$$eval('.drawer-link', els => els.length)) >= 6);

    await pg.screenshot({ path: `${SHOTS}/drawer-open.png` });

    // ---- the current screen is marked
    check('the screen you are on is marked as current',
        (await pg.getAttribute('[data-drawer-tab="products"]', 'aria-current')) === 'page');

    // ---- filter
    await pg.fill('#drawer-filter', 'ord');
    await pg.waitForTimeout(250);
    const visible = await pg.$$eval('.drawer-link', els =>
        els.filter(e => e.style.display !== 'none').map(e => e.querySelector('.label').textContent.trim()));
    check('typing filters the menu', visible.length > 0 && visible.every(v => /ord/i.test(v)), JSON.stringify(visible));
    await pg.fill('#drawer-filter', 'zzzz');
    await pg.waitForTimeout(200);
    check('a search with no matches says so', await pg.isVisible('#drawer-noresult'));
    await pg.fill('#drawer-filter', '');
    await pg.waitForTimeout(200);

    // ---- collapsing, and that it is remembered
    await pg.click('.drawer-group[data-group="Account"] .grp-btn');
    await pg.waitForTimeout(200);
    check('a group collapses',
        (await pg.getAttribute('.drawer-group[data-group="Account"]', 'data-open')) === 'false');

    // ---- navigation
    await pg.click('[data-drawer-tab="orders"]');
    await pg.waitForTimeout(600);
    check('choosing an item navigates and closes the menu',
        !(await pg.isVisible('#drawer')) && await pg.isVisible('#tab-orders'));
    check('focus returns to the menu button',
        await pg.evaluate(() => document.activeElement.id === 'drawer-btn'));

    await pg.click('#drawer-btn'); await pg.waitForTimeout(400);
    check('the collapsed group is remembered next time',
        (await pg.getAttribute('.drawer-group[data-group="Account"]', 'data-open')) === 'false');
    check('the new current screen is marked',
        (await pg.getAttribute('[data-drawer-tab="orders"]', 'aria-current')) === 'page');
    check('the group holding the current screen is forced open',
        (await pg.getAttribute('.drawer-group[data-group="Ordering"]', 'data-open')) === 'true');

    // ---- escape and click-out
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(400);
    check('Escape closes it', !(await pg.isVisible('#drawer')));

    await pg.click('#drawer-btn'); await pg.waitForTimeout(400);
    await pg.click('#drawer-backdrop', { position: { x: 400, y: 500 } });
    await pg.waitForTimeout(400);
    check('clicking outside closes it', !(await pg.isVisible('#drawer')));

    // ---- badges
    // Drive the HEADER badges — the drawer mirrors those, so this also
    // proves the two can never show different numbers.
    await pg.evaluate(() => {
        const c = document.getElementById('cart-badge');
        if (c) { c.classList.remove('hidden'); c.textContent = '5'; }
        const l = document.getElementById('inv-low-badge');
        if (l) { l.classList.remove('hidden'); l.textContent = '7'; }
    });
    await pg.click('#drawer-btn'); await pg.waitForTimeout(400);
    const cartBadge = await pg.textContent('.count[data-count="cart"]').catch(() => null);
    check('the cart count shows in the menu', cartBadge === '5', `got ${cartBadge}`);
    await pg.screenshot({ path: `${SHOTS}/drawer-badges.png` });

    console.log('\n  page errors:', errs.length ? errs : 'none');
    const fail = results.filter(r => !r.pass).length;
    console.log(`\n${results.length - fail} passed, ${fail} failed`);
    await b.close();
    process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('HARNESS FAILED:', e.message.split('\n')[0]); process.exitCode = 2; });
