/**
 * public/admin-look.js -- the refinishAI new look for the CHC admin console.
 *
 * On by default. Each person can go back to the classic look for their own
 * browser with the link at the foot of the menu (remembered in this browser
 * only). It changes presentation only: no request, no permission, no screen
 * and no button changes.
 */
(function () {
    'use strict';
    const KEY = 'rai_admin_look';
    const LOCKUP = '/assets/refinishai-lockup.png';

    function preferClassic() {
        try { return localStorage.getItem(KEY) === 'classic'; } catch (_) { return false; }
    }
    function remember(classic) {
        try { classic ? localStorage.setItem(KEY, 'classic') : localStorage.removeItem(KEY); } catch (_) { /* private window */ }
    }

    function decorate() {
        const on = !preferClassic();
        document.body.classList.toggle('nla', on);

        // Sign-in card: the refinishAI logo above the form.
        const card = document.querySelector('#admin-login > div');
        if (card && !card.querySelector('.nla-login-logo')) {
            const d = document.createElement('div');
            d.className = 'nla-login-logo';
            d.innerHTML = '<img src="' + LOCKUP + '" alt="refinishAI" width="240" height="68">';
            const head = card.querySelector('.text-center');
            card.insertBefore(d, head || card.firstChild);
            d.hidden = !on;
        } else if (card) {
            card.querySelector('.nla-login-logo').hidden = !on;
        }

        // Menu: the refinishAI logo top left, "CHC console" under it.
        const top = document.querySelector('#admin-sidebar > div');
        if (top && !top.querySelector('.nla-brand')) {
            const b = document.createElement('div');
            b.className = 'nla-brand';
            b.innerHTML = '<img src="' + LOCKUP + '" alt="refinishAI" width="186" height="52">';
            const s = document.createElement('span');
            s.className = 'nla-sub';
            s.textContent = 'CHC console';
            top.insertBefore(s, top.firstChild);
            top.insertBefore(b, top.firstChild);
        }
        document.querySelectorAll('.nla-brand, .nla-sub').forEach(el => { el.hidden = !on; });

        // The switch, at the foot of the menu.
        const foot = document.querySelector('#admin-sidebar > div:last-child');
        if (foot) {
            let t = foot.querySelector('.nla-look-toggle');
            if (!t) {
                t = document.createElement('button');
                t.type = 'button';
                t.className = 'nla-look-toggle w-full text-left text-sm text-gray-500 hover:text-blue-600';
                t.addEventListener('click', () => { remember(document.body.classList.contains('nla')); decorate(); });
                foot.appendChild(t);
            }
            t.innerHTML = on ? '<i class="fas fa-rotate-left mr-2"></i> Use classic look' : '<i class="fas fa-wand-magic-sparkles mr-2"></i> Use new look';
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorate);
    else decorate();
})();
