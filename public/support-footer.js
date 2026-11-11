/**
 * public/support-footer.js -- a faint footer on every page saying who to reach
 * for support. Clicking it opens an email.
 *
 * Placed where each page has room for it, so it never covers a button:
 *   - inside the signed-in app (store, admin), after the content;
 *   - at the foot of the sign-in screens;
 *   - at the foot of the window on the short stand-alone pages.
 * Not on the scan-out kiosk: that tablet is locked to scanning, and an email
 * link would take it out of the kiosk screen.
 */
(function () {
    'use strict';
    const EMAIL = 'adam@chcpaint.com';
    const SUBJECT = 'refinishAI support';

    // [selector, how it sits, light or dark background]
    const MOUNTS = [
        ['#app', 'flow', 'light'],
        ['#login-screen', 'overlay', 'dark'],
        ['#admin-main', 'flow', 'light'],
        ['#admin-login', 'overlay', 'dark'],
        ['#help-page', 'flow', 'light']
    ];

    function make(tone, mode) {
        const f = document.createElement('footer');
        f.className = 'rai-support-footer';
        f.dataset.mode = mode;
        f.setAttribute('role', 'contentinfo');
        const a = document.createElement('a');
        a.href = `mailto:${EMAIL}?subject=${encodeURIComponent(SUBJECT)}`;
        a.textContent = `RefinishAI 2026 · Support: Adam Berube · ${EMAIL}`;
        a.title = 'Email support';
        const ink = tone === 'dark' ? 'rgba(255,255,255,0.72)' : '#6B7789';
        f.style.cssText = 'text-align:center;font-size:12px;line-height:1.4;padding:14px 16px;';
        a.style.cssText = `color:${ink};text-decoration:none;`;
        a.addEventListener('mouseenter', () => { a.style.textDecoration = 'underline'; });
        a.addEventListener('mouseleave', () => { a.style.textDecoration = 'none'; });
        f.appendChild(a);
        return f;
    }

    function place() {
        if (document.querySelector('.rai-support-footer')) return;
        let placed = false;
        for (const [sel, mode, tone] of MOUNTS) {
            const host = document.querySelector(sel);
            if (!host) continue;
            const f = make(tone, mode);
            if (mode === 'overlay') {
                if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
                f.style.position = 'absolute';
                f.style.left = '0'; f.style.right = '0'; f.style.bottom = '0';
            }
            host.appendChild(f);
            placed = true;
        }
        if (!placed) {
            const dark = document.body.className.includes('from-blue-900');
            const f = make(dark ? 'dark' : 'light', 'fixed');
            f.style.position = 'fixed';
            f.style.left = '0'; f.style.right = '0'; f.style.bottom = '0';
            document.body.appendChild(f);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', place);
    else place();
})();
