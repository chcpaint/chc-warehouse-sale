/**
 * public/help-bot.js -- the help assistant: a round button, bottom right, that
 * answers "how do I...?" questions about any part of the suite.
 *
 * It does NOT use AI. It searches the written answers in /help-content.js on
 * the person's own device, instantly, and sends nothing anywhere. That keeps
 * the software's AI statement true (two features, both listed in
 * utils/ai-usage.js). When it cannot find an answer it offers an email to
 * info@chcpaint.com.
 *
 * Also exposes window.RAI_HELP_SEARCH(query, audience) for the Help page.
 */
(function () {
    'use strict';
    const FALLBACK_EMAIL = 'info@chcpaint.com';
    const SEEN_KEY = 'rai_help_seen';

    const SYN = {
        buy: 'order', purchase: 'order', checkout: 'order', submit: 'order',
        stock: 'inventory', stocktake: 'count', counting: 'count',
        reorder: 'reorder', restock: 'reorder', replenish: 'reorder',
        delivery: 'receive', deliveries: 'receive', shipment: 'receive', arrived: 'receive', truck: 'receive',
        took: 'use', take: 'use', used: 'use', consume: 'use', scanout: 'kiosk', tablet: 'kiosk',
        pw: 'password', login: 'sign', logon: 'sign', signin: 'sign',
        label: 'labels', sticker: 'labels', barcode: 'scan', scanner: 'scan',
        invoice: 'invoices', bill: 'invoices', po: 'po', customer: 'company', shop: 'location',
        ai: 'insights', claude: 'insights', advice: 'insights', insight: 'insights',
        backorder: 'partial', missing: 'partial', short: 'partial',
        user: 'team', staff: 'team', employee: 'team', invite: 'team',
        price: 'pricing', prices: 'pricing', discount: 'pricing',
        turn: 'switch', enable: 'switch', disable: 'switch', activate: 'switch', toggle: 'switch'
    };
    const STOP = new Set('a an the to do i we my our how can what where when is are it in on of for and or with does should me you your this that be at from get'.split(' '));

    function words(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/)
            .filter(w => w && !STOP.has(w))
            .map(w => SYN[w] || w)
            .map(w => w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);
    }

    function allItems(audience) {
        const data = window.RAI_HELP || { areas: [] };
        const out = [];
        for (const area of data.areas) {
            if (audience === 'shop' && area.audience === 'chc') continue;
            for (const it of area.items) out.push({ ...it, area: area.title, areaId: area.id });
        }
        return out;
    }

    /** Best matches for a question, highest score first. */
    const GOOD = r => r.score >= 2 && r.cover >= 0.5;
    window.RAI_HELP_GOOD = GOOD;
    function search(query, audience) {
        const qw = [...new Set(words(query))];
        if (!qw.length) return [];
        return allItems(audience).map(it => {
            const q = new Set(words(it.q)), k = new Set(words(it.k)), a = new Set(words(it.a));
            let score = 0, matched = 0;
            for (const w of qw) {
                const s = (q.has(w) ? 3 : 0) + (k.has(w) ? 3 : 0) + (a.has(w) ? 1 : 0);
                score += s;
                if (s) matched += 1;
            }
            // cover: how much of the question this answer speaks to. An answer
            // that shares one word out of three is a guess, not an answer.
            return { it, score: score / Math.sqrt(qw.length), cover: matched / qw.length };
        }).filter(r => r.score > 0).sort((x, y) => y.score - x.score || y.cover - x.cover);
    }
    window.RAI_HELP_SEARCH = search;

    const esc = v => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function audience() {
        return document.getElementById('admin-app') || document.body.dataset.helpAudience === 'all' ? 'all' : 'shop';
    }

    const CSS = `
    .rai-help-btn{position:fixed;right:20px;bottom:20px;z-index:55;width:56px;height:56px;border-radius:999px;border:0;
      background:#1747D6;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;
      box-shadow:0 6px 20px rgba(14,26,43,.28);font:600 15px 'IBM Plex Sans',system-ui,sans-serif}
    .rai-help-btn:focus-visible{outline:3px solid #0E1A2B;outline-offset:3px}
    .rai-help-btn.pulse::before{content:'';position:absolute;inset:0;border-radius:999px;background:#1747D6;opacity:.55;animation:raiPulse 2s ease-out infinite;z-index:-1}
    @keyframes raiPulse{0%{transform:scale(1);opacity:.55}100%{transform:scale(1.8);opacity:0}}
    @media (prefers-reduced-motion: reduce){.rai-help-btn.pulse::before{animation:none}}
    .rai-help-panel{position:fixed;right:20px;bottom:88px;z-index:56;width:360px;max-width:calc(100vw - 32px);height:500px;max-height:calc(100vh - 120px);
      background:#fff;color:#0E1A2B;border:1px solid #DFE4EC;border-radius:16px;box-shadow:0 16px 48px rgba(14,26,43,.25);
      display:flex;flex-direction:column;overflow:hidden;font:14px/1.45 'IBM Plex Sans',system-ui,sans-serif}
    .rai-help-panel[hidden]{display:none}
    .rai-help-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#0E1A2B;color:#fff}
    .rai-help-head strong{font-family:'Archivo','IBM Plex Sans',sans-serif;font-size:16px}
    .rai-help-head small{display:block;color:#C9D3E1;font-size:12px}
    .rai-help-x{background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;width:36px;height:36px;border-radius:8px}
    .rai-help-x:hover{background:#1D2D45}
    .rai-help-log{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:#F4F6F9}
    .rai-msg{max-width:92%;padding:9px 12px;border-radius:12px;white-space:pre-line}
    .rai-msg.me{align-self:flex-end;background:#1747D6;color:#fff;border-bottom-right-radius:4px}
    .rai-msg.bot{align-self:flex-start;background:#fff;border:1px solid #DFE4EC;border-bottom-left-radius:4px}
    .rai-msg.bot .t{font-weight:600;display:block;margin-bottom:4px}
    .rai-msg a{color:#1747D6;font-weight:600}
    .rai-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    .rai-chip{border:1px solid #C9D2DE;background:#fff;color:#0E1A2B;border-radius:999px;padding:5px 10px;font:inherit;font-size:12.5px;cursor:pointer;text-align:left}
    .rai-chip:hover{border-color:#1747D6;color:#1747D6}
    .rai-help-form{display:flex;gap:8px;padding:10px;border-top:1px solid #DFE4EC;background:#fff}
    .rai-help-form input{flex:1;min-width:0;border:1px solid #C9D2DE;border-radius:10px;padding:10px 12px;font:inherit}
    .rai-help-form button{border:0;border-radius:10px;background:#1747D6;color:#fff;font:inherit;font-weight:600;padding:0 14px;cursor:pointer}
    .rai-help-foot{padding:6px 12px 10px;font-size:11.5px;color:#4A5A70;background:#fff;text-align:center}
    .rai-help-foot a{color:#4A5A70}
    .rai-support-footer[data-mode="flow"]{padding-bottom:88px!important}
    .rai-support-footer[data-mode="overlay"]{padding-left:84px!important;padding-right:84px!important}
    @media print{.rai-help-btn,.rai-help-panel{display:none!important}}`;

    function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

    function build() {
        if (document.querySelector('.rai-help-btn') || document.body.dataset.helpBot === 'off') return;
        const style = el('style'); style.textContent = CSS; document.head.appendChild(style);

        const btn = el('button', 'rai-help-btn');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Help: ask how to do something');
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = '<svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"></path><path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1v.5"></path><path d="M12 16.5h.01"></path></svg>';
        let seen = false; try { seen = sessionStorage.getItem(SEEN_KEY) === '1'; } catch (_) {}
        if (!seen) btn.classList.add('pulse');

        const panel = el('section', 'rai-help-panel');
        panel.hidden = true;
        panel.setAttribute('aria-label', 'Help');
        panel.innerHTML = `
            <div class="rai-help-head"><div><strong>Help</strong><small>Ask how to do anything in the app</small></div>
              <button type="button" class="rai-help-x" aria-label="Close help">&times;</button></div>
            <div class="rai-help-log" role="log" aria-live="polite"></div>
            <form class="rai-help-form"><label for="rai-help-q" style="position:absolute;left:-9999px">Your question</label>
              <input id="rai-help-q" autocomplete="off" placeholder="e.g. how do I receive a delivery?"><button type="submit">Ask</button></form>
            <div class="rai-help-foot">Answers come from our help guide, not AI. <a href="/help" target="_blank" rel="noopener">Open the full guide</a></div>`;
        document.body.appendChild(btn);
        document.body.appendChild(panel);

        const log = panel.querySelector('.rai-help-log');
        const input = panel.querySelector('input');
        const say = (html, who) => { const m = el('div', 'rai-msg ' + who, html); log.appendChild(m); log.scrollTop = log.scrollHeight; return m; };
        const chips = (items) => '<div class="rai-chips">' + items.map(it => `<button type="button" class="rai-chip" data-q="${esc(it.q)}">${esc(it.q)}</button>`).join('') + '</div>';

        function greet() {
            const aud = audience();
            const starters = ['How do I place an order?', 'How do I receive a delivery?', 'How do I record that we used something?', 'How do I count stock?']
                .concat(aud === 'all' ? ['How do I switch features on or off for a customer?'] : []);
            const items = allItems(aud).filter(it => starters.includes(it.q));
            say('Hi! Ask me how to do something, or pick one:' + chips(items), 'bot');
        }

        function answer(q) {
            say(esc(q), 'me');
            const hits = search(q, audience());
            const best = hits.find(GOOD);
            if (!best) {
                const mail = `mailto:${FALLBACK_EMAIL}?subject=${encodeURIComponent('refinishAI help')}&body=${encodeURIComponent('My question: ' + q)}`;
                say(`I couldn't find that one in the guide. Email <a href="${mail}">${FALLBACK_EMAIL}</a> and the team will help.` +
                    (hits.length ? '<br><br>These might be close:' + chips(hits.slice(0, 3).map(h => h.it)) : ''), 'bot');
                return;
            }
            const more = hits.filter(h => h !== best && GOOD(h)).slice(0, 3).map(h => h.it);
            say(`<span class="t">${esc(best.it.q)}</span>${esc(best.it.a)}` + (more.length ? '<br><br>Related:' + chips(more) : ''), 'bot');
        }

        function open() {
            panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); btn.classList.remove('pulse');
            try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (_) {}
            if (!log.childElementCount) greet();
            setTimeout(() => input.focus(), 30);
        }
        function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); }

        btn.addEventListener('click', () => (panel.hidden ? open() : close()));
        panel.querySelector('.rai-help-x').addEventListener('click', close);
        panel.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
        panel.querySelector('form').addEventListener('submit', e => {
            e.preventDefault();
            const q = input.value.trim();
            if (!q) return;
            input.value = '';
            answer(q);
        });
        log.addEventListener('click', e => {
            const c = e.target.closest('.rai-chip');
            if (c) answer(c.getAttribute('data-q'));
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
    else build();
})();
