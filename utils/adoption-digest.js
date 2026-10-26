/**
 * utils/adoption-digest.js
 *
 * The weekly adoption email: every Monday morning (Toronto time), a summary of
 * the week that just finished -- which shops entered the ordering console,
 * what they ordered and who ordered it -- sent to CHC's leadership list.
 *
 * It reports on a COMPLETE Monday-to-Sunday week, never the one just starting.
 * The numbers come from the same loader as the Reports screen
 * (utils/adoption-data.js), so the email and the screen cannot disagree.
 *
 * Who receives it: ADOPTION_REPORT_RECIPIENTS (comma separated) if set,
 * otherwise the list below. Everyone gets their own copy; nobody sees the others.
 */

const { loadAdoptionReport } = require('./adoption-data');
const { weekStart } = require('./adoption');

const DEFAULT_RECIPIENTS = [
    'adam@chcpaint.com',
    'gabe@chcpaint.com',
    'manny@chcpaint.com',
    'frankc@chcpaint.com',
    'pino@chcpaint.com',
    'daniel@chcpaint.com'
];

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function recipients(env = process.env) {
    const raw = String(env.ADOPTION_REPORT_RECIPIENTS || '').trim();
    const list = (raw ? raw.split(/[,;\s]+/) : DEFAULT_RECIPIENTS)
        .map(e => e.trim().toLowerCase())
        .filter(e => EMAIL_RE.test(e));
    return [...new Set(list)];
}

function digestInfo() {
    return { recipients: recipients(), when: 'Mondays at about 7 a.m. Toronto time, covering the week that just ended' };
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = n => '$' + Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const publicBase = () => (process.env.PUBLIC_BASE_URL || 'https://chcsale.com').replace(/\/+$/, '');

/** The moment just before this Monday began: "as of" the end of last week. */
function endOfLastWeek(now = new Date()) {
    return new Date(weekStart(now).getTime() - 1000);
}

/**
 * Build the email from a report whose last week is the finished week.
 * Pure: report in, {subject, html, text} out.
 */
function renderDigest(report) {
    const W = report.weeks.length;
    const wk = report.weeks[W - 1];
    const live = report.locations.filter(l => l.is_active);
    const active = live.filter(l => l.active_weeks[W - 1]);
    const idle = live.filter(l => !l.active_weeks[W - 1]);
    const prevActive = W > 1 ? live.filter(l => l.active_weeks[W - 2]) : [];
    const prevIds = new Set(prevActive.map(l => l.location_id));
    const nowIds = new Set(active.map(l => l.location_id));
    const newlyActive = active.filter(l => !prevIds.has(l.location_id));
    const droppedOff = prevActive.filter(l => !nowIds.has(l.location_id));
    const neverSeen = idle.filter(l => !l.weeks_active);
    const pct = live.length ? Math.round(active.length / live.length * 100) : 0;
    const orders = live.reduce((a, l) => a + l.orders[W - 1], 0);
    const dollars = live.reduce((a, l) => a + l.dollars[W - 1], 0);

    const subject = `CHC console adoption, ${wk.label}: ${active.length} of ${live.length} shops active`;
    const link = `${publicBase()}/admin`;

    const name = l => `${l.location}${l.company_name && !l.location.toLowerCase().includes(l.company_name.toLowerCase()) ? ' (' + l.company_name + ')' : ''}`;
    const list = arr => arr.length ? arr.map(name).join(', ') : 'none';

    const th = 'text-align:left;padding:6px 10px;background:#f3f4f6;font-size:12px;color:#4b5563;border-bottom:1px solid #e5e7eb';
    const td = 'padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:14px';
    const tdr = td + ';text-align:right';

    const companyRows = report.companies.map(c => `<tr>
        <td style="${td}">${esc(c.company_name)}</td>
        <td style="${tdr}">${c.active_this_week} of ${c.locations_total}</td>
        <td style="${tdr}">${c.adoption_pct}%</td>
        <td style="${tdr}">${c.sign_ins_this_week}</td></tr>`).join('');

    const shopRows = active.slice().sort((a, b) => b.dollars[W - 1] - a.dollars[W - 1] || a.location.localeCompare(b.location)).map(l => `<tr>
        <td style="${td}">${esc(l.location)}<div style="font-size:12px;color:#6b7280">${esc(l.company_name)}</div></td>
        <td style="${tdr}">${l.entries[W - 1]}</td>
        <td style="${tdr}">${l.orders[W - 1]}</td>
        <td style="${tdr}">${money(l.dollars[W - 1])}</td>
        <td style="${td}">${esc(l.people.slice(0, 3).map(p => p.name).join(', '))}</td></tr>`).join('');

    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1f2937">
      <h2 style="margin:0 0 4px;color:#111827">Weekly console adoption</h2>
      <p style="margin:0 0 16px;color:#6b7280">${esc(wk.label)} &middot; Monday to Sunday</p>
      <p style="font-size:16px;margin:0 0 6px"><strong>${active.length} of ${live.length} shops</strong> used the console last week (${pct}%), compared with <strong>${prevActive.length}</strong> the week before.</p>
      <p style="margin:0 0 20px">They placed <strong>${orders}</strong> order${orders === 1 ? '' : 's'} worth <strong>${money(dollars)}</strong>.</p>

      <h3 style="margin:20px 0 6px;font-size:15px">By company</h3>
      <table style="border-collapse:collapse;width:100%"><tr><th style="${th}">Company</th><th style="${th};text-align:right">Shops active</th><th style="${th};text-align:right">Adoption</th><th style="${th};text-align:right">Sign-ins</th></tr>${companyRows}</table>

      <h3 style="margin:20px 0 6px;font-size:15px">Shops that were active</h3>
      ${active.length ? `<table style="border-collapse:collapse;width:100%"><tr><th style="${th}">Shop</th><th style="${th};text-align:right">Store entries</th><th style="${th};text-align:right">Orders</th><th style="${th};text-align:right">Order dollars</th><th style="${th}">Who ordered</th></tr>${shopRows}</table>` : '<p style="color:#6b7280">No shop used the console last week.</p>'}

      <h3 style="margin:20px 0 6px;font-size:15px">Worth a call</h3>
      <p style="margin:0 0 6px;font-size:14px"><strong>Dropped off (active the week before, not last week):</strong> ${esc(list(droppedOff))}</p>
      <p style="margin:0 0 6px;font-size:14px"><strong>Newly active (not active the week before):</strong> ${esc(list(newlyActive))}</p>
      <p style="margin:0 0 6px;font-size:14px"><strong>No activity in the last ${W} weeks:</strong> ${esc(list(neverSeen))}</p>

      <p style="margin:24px 0 6px"><a href="${esc(link)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Open Reports &rsaquo; Weekly adoption</a></p>
      <p style="color:#9ca3af;font-size:12px">A shop counts as active when someone signed in and entered its store, or it placed an order. Customers on a shared access code show by shop, not by person; &ldquo;who ordered&rdquo; comes from the order contact name.</p>
    </div>`;

    const text = [
        `Weekly console adoption, ${wk.label}`,
        `${active.length} of ${live.length} shops active last week (${pct}%); ${prevActive.length} the week before.`,
        `${orders} order(s), ${money(dollars)}.`,
        '',
        'Dropped off (active the week before, not last week): ' + list(droppedOff),
        'Newly active (not active the week before): ' + list(newlyActive),
        `No activity in the last ${W} weeks: ` + list(neverSeen),
        '',
        `Details: ${link} > Reports > Weekly adoption`
    ].join('\n');

    return { subject, html, text };
}

/**
 * Build last week's report and email it. `to` defaults to the standing list.
 * `sendFn` is injectable for tests; it receives {to, subject, html, text}.
 */
async function sendDigestNow({ to, now = new Date(), sendFn } = {}) {
    const list = (to && to.length ? to : recipients());
    if (!list.length) return { sent: false, reason: 'no_recipients' };
    const report = await loadAdoptionReport({ weeks: 8, asOf: endOfLastWeek(now) });
    const mail = renderDigest(report);
    const send = sendFn || require('./email').sendAdoptionReport;
    const result = await send({ to: list, ...mail });
    return { ...result, to: list, week: report.weeks[report.weeks.length - 1].label };
}

module.exports = { DEFAULT_RECIPIENTS, recipients, digestInfo, renderDigest, endOfLastWeek, sendDigestNow };
