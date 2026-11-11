/**
 * public/insights.js -- the Insights button and panel on the Reports screen.
 *
 * Shown only where CHC has switched the Insights module on (the server checks
 * again on every request). Uses the store's own globals: state, apiFetch.
 *
 * Nothing is sent anywhere until the person presses "Get insights", and the
 * panel says exactly what is sent, to whom, and that this is the only part of
 * the console that uses AI.
 */
(function () {
    'use strict';
    const INS = {};
    let busy = false;

    const esc = v => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const on = company => !!(company && company.settings && company.settings.insights && company.settings.insights.enabled === true);
    const panel = () => document.getElementById('insights-panel');
    const shop = () => {
        const sel = document.getElementById('rep-shop');
        return sel && /^[0-9a-f-]{36}$/i.test(sel.value) ? sel.value : '';
    };

    INS.init = function (company) {
        const btn = document.getElementById('insights-btn');
        if (btn) btn.classList.toggle('hidden', !on(company));
        if (!on(company) && panel()) { panel().classList.add('hidden'); panel().innerHTML = ''; }
    };

    INS.toggle = async function () {
        const p = panel();
        if (!p) return;
        if (!p.classList.contains('hidden')) { p.classList.add('hidden'); return; }
        p.classList.remove('hidden');
        p.innerHTML = '<div class="bg-white rounded-xl border p-5 text-gray-500">Loading Insights…</div>';
        await INS.load();
    };

    INS.load = async function () {
        const p = panel();
        try {
            const q = shop() ? `?location_id=${encodeURIComponent(shop())}` : '';
            const resp = await apiFetch(`/store/${state.slug}/insights${q}`);
            const data = await resp.json();
            if (!resp.ok) { p.innerHTML = box(`<p class="text-gray-700">${esc(data.error || 'Insights is not available.')}</p>`); return; }
            render(data, data.last);
        } catch (_) {
            p.innerHTML = box('<p class="text-gray-700">Could not load Insights. Try again in a minute.</p>');
        }
    };

    INS.run = async function () {
        if (busy) return;
        busy = true;
        const btn = document.getElementById('insights-run');
        if (btn) { btn.disabled = true; btn.textContent = 'Reading your numbers… (about 20 seconds)'; }
        try {
            const resp = await apiFetch(`/store/${state.slug}/insights`, { method: 'POST', body: JSON.stringify({ location_id: shop() || null }) });
            const data = await resp.json();
            if (!resp.ok) {
                const err = document.getElementById('insights-error');
                if (err) { err.textContent = data.error || 'Insights could not run.'; err.classList.remove('hidden'); }
                if (btn) { btn.disabled = false; btn.textContent = 'Get insights'; }
                return;
            }
            await INS.load();
        } catch (_) {
            const err = document.getElementById('insights-error');
            if (err) { err.textContent = 'Insights could not run. Check your connection and try again.'; err.classList.remove('hidden'); }
            if (btn) { btn.disabled = false; btn.textContent = 'Get insights'; }
        } finally { busy = false; }
    };

    function aiWhere(list) {
        const f = Array.isArray(list) ? list : [];
        if (!f.length) return 'Insights, on this screen.';
        const n = ['', 'one place', 'two places', 'three places', 'four places'][f.length] || `${f.length} places`;
        return `The software uses AI in ${n}: ` + f.map(x => esc(x.plain || x.name)).join('; and ') + '.';
    }

    function box(inner) { return `<div class="bg-white rounded-xl border p-5">${inner}</div>`; }

    function points(list, tone) {
        if (!list || !list.length) return '<p class="text-sm text-gray-500">Nothing to add here this time.</p>';
        return list.map(p => `
            <div class="border-t first:border-t-0 pt-3 first:pt-0">
                <p class="font-semibold text-gray-800">${esc(p.title)}</p>
                <p class="text-sm text-gray-700 mt-1">${esc(p.detail)}</p>
                ${p.based_on ? `<p class="text-xs text-gray-500 mt-1">Based on: ${esc(p.based_on)}</p>` : ''}
            </div>`).join('');
    }

    function render(status, last) {
        const p = panel();
        const d = status.disclosure || {};
        const canRun = status.configured && status.remaining_today > 0;
        const scope = status.scope && status.scope.name ? status.scope.name : 'All shops';
        const result = last && last.insights ? `
            <div class="bg-white rounded-xl border p-5 mb-4">
                <p class="text-xs text-gray-500">${esc(scope)} · ${esc(new Date(last.generated_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }))}</p>
                <h3 class="text-xl font-bold text-gray-800 mt-1">${esc(last.insights.headline)}</h3>
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
                    <section class="rounded-lg border p-4" aria-label="Going well">
                        <h4 class="font-semibold text-green-800 mb-3"><i class="fas fa-circle-check mr-1"></i>Going well</h4>
                        <div class="space-y-3">${points(last.insights.going_well)}</div>
                    </section>
                    <section class="rounded-lg border p-4" aria-label="Worth acting on">
                        <h4 class="font-semibold text-blue-800 mb-3"><i class="fas fa-arrow-right mr-1"></i>Worth acting on</h4>
                        <div class="space-y-3">${points(last.insights.worth_acting_on)}</div>
                    </section>
                    <section class="rounded-lg border p-4" aria-label="Worth a closer look">
                        <h4 class="font-semibold text-amber-800 mb-3"><i class="fas fa-magnifying-glass mr-1"></i>Worth a closer look</h4>
                        <div class="space-y-3">${points(last.insights.worth_a_closer_look)}</div>
                    </section>
                </div>
                ${last.insights.data_caveats ? `<p class="text-sm text-gray-500 mt-4">${esc(last.insights.data_caveats)}</p>` : ''}
                <p class="text-xs text-gray-500 mt-4">Suggestions from Claude (${esc(last.model || 'Anthropic')}), read from your numbers. You know your shop best; nothing in the console changed because of this.</p>
                ${last.snapshot ? `<details class="mt-3"><summary class="text-sm text-blue-700 cursor-pointer">See exactly what was sent</summary>
                    <pre class="mt-2 text-xs bg-gray-50 border rounded-lg p-3 overflow-x-auto max-h-80">${esc(JSON.stringify(last.snapshot, null, 2))}</pre></details>` : ''}
            </div>` : '';

        p.innerHTML = `
            ${result}
            <div class="bg-white rounded-xl border p-5">
                <div class="flex flex-wrap items-start justify-between gap-4">
                    <div class="max-w-2xl">
                        <h3 class="text-lg font-bold text-gray-800">${last ? 'Run Insights again' : 'Insights'}</h3>
                        <p class="text-sm text-gray-700 mt-1">A second opinion on your numbers, the way a trusted friend in the trade would give it: what is going well, what may be worth acting on, and what may be worth a closer look. Suggestions, not instructions.</p>
                    </div>
                    <div class="text-right">
                        <button id="insights-run" type="button" onclick="INS.run()" ${canRun ? '' : 'disabled'}
                            class="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-5 py-3 rounded-lg">Get insights</button>
                        <p class="text-xs text-gray-500 mt-2">${status.configured ? `${esc(status.remaining_today)} left today · for ${esc(scope)}` : 'Not set up on the server yet. Ask CHC.'}</p>
                    </div>
                </div>
                <p id="insights-error" role="alert" class="hidden mt-3 text-sm text-red-700"></p>
                <div class="mt-4 rounded-lg bg-gray-50 border p-4 text-sm text-gray-700 space-y-2">
                    <p><strong>How it works.</strong> Pressing the button makes one request to Claude, an AI model by Anthropic. It reads a summary of your account and answers once. It cannot see or change anything else in the console.</p>
                    <p><strong>What is sent.</strong> ${esc(d.sends || '')}</p>
                    <p><strong>Logged.</strong> Each use is recorded (when, which account, the summary sent and the answer) so CHC can show exactly how AI was used.</p>
                    <p><strong>Where AI is used.</strong> ${aiWhere(status.ai_features)} Nothing else in the software calls an AI model.</p>
                </div>
            </div>`;
    }

    window.INS = INS;
})();
