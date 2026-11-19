/**
 * public/numpad.js -- an on-screen number pad and a tap-to-choose list, for
 * phones and tablets with a barcode scanner plugged in.
 *
 * Why: a USB or Bluetooth barcode scanner connected to a phone is, to the
 * phone, a keyboard. While one is connected iOS (and most Android builds)
 * stop showing the on-screen keyboard for EVERY text box, so a quantity
 * box or a "why" question cannot be typed into at all. Nothing here needs
 * the phone's keyboard.
 *
 * Number boxes: on a touch screen, every number box inside the Inventory tab
 * (#tab-inventory, or anything marked data-numpad-root) is made untappable
 * by CSS (pointer-events: none), so the phone never focuses it and never
 * tries to show a keyboard. A tap where the box is drawn opens this pad
 * instead. Done sets the value and fires the same `input` and `change`
 * events typing would, so each screen's own handlers run unchanged. A
 * mouse or keyboard on a computer types as before. A box can opt out with
 * data-native-keyboard.
 *
 * Choices: RAINumpad.choose({ title, options, other }) shows a list of big
 * buttons and resolves with the one tapped (or null). Used where the console
 * used to ask for a typed reason.
 */
(function () {
    'use strict';
    if (window.RAINumpad) return;

    var ROOTS = '#tab-inventory, [data-numpad-root]';
    var BOXES = '#tab-inventory input[type="number"], [data-numpad-root] input[type="number"]';
    var state = { input: null, text: '', fresh: true, decimals: true };
    var sheet = null, back = null, chooser = null;

    function touchScreen() {
        try {
            if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
            if (window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches && !window.matchMedia('(pointer: fine)').matches) return true;
        } catch (e) { /* old browser */ }
        return ('ontouchstart' in window) && (navigator.maxTouchPoints || 0) > 0 && !(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
    }

    function eligible(el) {
        return el && el.tagName === 'INPUT' && el.type === 'number' && !el.disabled &&
            !el.hasAttribute('data-native-keyboard') && el.closest && el.closest(ROOTS);
    }

    function labelFor(el) {
        var l = el.getAttribute('aria-label') || el.getAttribute('placeholder') || 'Quantity';
        return l.length > 70 ? l.slice(0, 67) + '…' : l;
    }

    function allowsDecimals(el) {
        var step = el.getAttribute('step');
        if (el.getAttribute('inputmode') === 'numeric') return false;
        return !(step && /^\d+$/.test(step));
    }

    function css() {
        if (document.getElementById('rnp-css')) return;
        var s = document.createElement('style');
        s.id = 'rnp-css';
        s.textContent =
            // The heart of it: on a touch screen the box itself never takes a tap.
            'html.rnp-touch #tab-inventory input[type="number"]:not([data-native-keyboard]),' +
            'html.rnp-touch [data-numpad-root] input[type="number"]:not([data-native-keyboard]){pointer-events:none}' +
            '.rnp-back{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9998;display:none}' +
            '.rnp-back.open{display:block}' +
            '.rnp,.rnp-choose{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fff;border-radius:18px 18px 0 0;' +
            'box-shadow:0 -10px 30px rgba(15,23,42,.2);padding:14px 16px calc(14px + env(safe-area-inset-bottom));' +
            'max-width:480px;margin:0 auto;transform:translateY(105%);transition:transform .18s ease;font-family:inherit;max-height:88vh;overflow-y:auto}' +
            '.rnp.open,.rnp-choose.open{transform:none}' +
            '@media (prefers-reduced-motion:reduce){.rnp,.rnp-choose{transition:none}}' +
            '.rnp-label{font-size:14px;color:#475569;margin:0 0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.rnp-display{font-size:34px;font-weight:700;text-align:right;color:#0f172a;border:2px solid #2563eb;border-radius:12px;' +
            'padding:6px 14px;min-height:56px;margin-bottom:10px;font-variant-numeric:tabular-nums;overflow:hidden}' +
            '.rnp-display.empty{color:#94a3b8}' +
            '.rnp-keys{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}' +
            '.rnp-keys button{height:56px;border-radius:12px;border:1px solid #e2e8f0;background:#f8fafc;font-size:24px;font-weight:600;color:#0f172a;' +
            'touch-action:manipulation;-webkit-tap-highlight-color:transparent}' +
            '.rnp-keys button:active,.rnp-opt:active{background:#e2e8f0}' +
            '.rnp button:focus-visible,.rnp-choose button:focus-visible{outline:3px solid #93c5fd;outline-offset:1px}' +
            '.rnp-keys button[disabled]{visibility:hidden}' +
            '.rnp-act{display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:8px}' +
            '.rnp-act button{height:52px;border-radius:12px;font-size:18px;font-weight:600;touch-action:manipulation}' +
            '.rnp-cancel{background:#fff;border:1px solid #cbd5e1;color:#334155}' +
            '.rnp-done{background:#2563eb;border:1px solid #2563eb;color:#fff}' +
            '.rnp-choose h2{font-size:17px;font-weight:700;color:#0f172a;margin:0 0 4px}' +
            '.rnp-choose p{font-size:14px;color:#475569;margin:0 0 10px}' +
            '.rnp-opts{display:grid;gap:8px}' +
            '.rnp-opt{min-height:52px;border-radius:12px;border:1px solid #cbd5e1;background:#f8fafc;font-size:17px;font-weight:600;color:#0f172a;' +
            'text-align:left;padding:10px 14px;touch-action:manipulation}' +
            '.rnp-other{display:flex;gap:8px;margin-top:10px}' +
            '.rnp-other input{flex:1;min-width:0;border:1px solid #cbd5e1;border-radius:12px;padding:12px;font-size:16px}' +
            '.rnp-other button{border-radius:12px;background:#2563eb;color:#fff;font-weight:600;padding:0 16px;border:0}' +
            '.rnp-choose .rnp-cancel{width:100%;height:52px;border-radius:12px;font-size:17px;font-weight:600;margin-top:10px}';
        document.head.appendChild(s);
    }

    function backdrop() {
        if (back) return back;
        back = document.createElement('div');
        back.className = 'rnp-back';
        back.addEventListener('click', function () { if (state.input) close(); if (chooser && chooser._resolve) closeChooser(null); });
        document.body.appendChild(back);
        return back;
    }

    // ---------------------------------------------------------------
    // Number pad
    // ---------------------------------------------------------------
    function build() {
        if (sheet) return sheet;
        css(); backdrop();
        sheet = document.createElement('div');
        sheet.className = 'rnp';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-labelledby', 'rnp-label');
        var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];
        sheet.innerHTML =
            '<p class="rnp-label" id="rnp-label"></p>' +
            '<div class="rnp-display" id="rnp-display" aria-live="polite"></div>' +
            '<div class="rnp-keys">' + keys.map(function (k) {
                return k === 'back'
                    ? '<button type="button" data-k="back" aria-label="Delete">&#9003;</button>'
                    : '<button type="button" data-k="' + k + '">' + k + '</button>';
            }).join('') + '</div>' +
            '<div class="rnp-act"><button type="button" class="rnp-cancel" data-k="cancel">Cancel</button>' +
            '<button type="button" class="rnp-done" data-k="done">Done</button></div>';
        sheet.addEventListener('click', function (e) {
            var b = e.target.closest('button[data-k]');
            if (!b) return;
            e.preventDefault();
            press(b.getAttribute('data-k'));
        });
        document.body.appendChild(sheet);

        // Number keys on a real keyboard work too while the pad is open.
        document.addEventListener('keydown', function (e) {
            if (!state.input) return;
            if (/^[0-9]$/.test(e.key)) press(e.key);
            else if (e.key === '.' || e.key === ',') press('.');
            else if (e.key === 'Backspace') press('back');
            else if (e.key === 'Enter') press('done');
            else if (e.key === 'Escape') press('cancel');
            else return;
            e.preventDefault();
            e.stopPropagation();
        }, true);
        return sheet;
    }

    function paint() {
        var d = document.getElementById('rnp-display');
        var empty = state.text === '';
        d.textContent = empty ? (state.input ? (state.input.value || '0') : '0') : state.text;
        d.classList.toggle('empty', empty);
        var dot = sheet.querySelector('button[data-k="."]');
        if (dot) dot.disabled = !state.decimals;
    }

    function press(k) {
        if (!state.input) return;
        if (k === 'cancel') return close();
        if (k === 'done') return done();
        if (state.fresh) { state.text = ''; state.fresh = false; }
        if (k === 'back') state.text = state.text.slice(0, -1);
        else if (k === '.') {
            if (state.decimals && state.text.indexOf('.') === -1) state.text = (state.text || '0') + '.';
        } else if (state.text.length < 9) {
            state.text = state.text === '0' ? k : state.text + k;
        }
        paint();
    }

    function close() {
        if (!sheet) return;
        sheet.classList.remove('open');
        back.classList.remove('open');
        state.input = null;
        var cb = state.onClose; state.onClose = null;
        if (cb) cb();
    }

    function done() {
        var el = state.input;
        var text = state.text.replace(/\.$/, '');
        var typed = !state.fresh;
        close();
        if (!el || !typed || String(el.value) === text) return;
        if (text === '' && !el._rnpAllowBlank) return;
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function open(el, onClose) {
        build();
        state.onClose = onClose || null;
        if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) {
            document.activeElement.blur();
        }
        state.input = el;
        state.text = '';
        state.fresh = true;
        state.decimals = allowsDecimals(el);
        document.getElementById('rnp-label').textContent = labelFor(el);
        paint();
        back.classList.add('open');
        sheet.classList.add('open');
    }

    /** The number box drawn under this point, if any (the box itself takes no taps). */
    function boxAt(x, y) {
        var list = document.querySelectorAll(BOXES);
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (!eligible(el)) continue;
            var r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) return el;
        }
        return null;
    }

    function onTap(e) {
        if (!document.documentElement.classList.contains('rnp-touch')) return;
        if (state.input || (chooser && chooser.classList.contains('open'))) return;
        var x = e.clientX, y = e.clientY;
        if (x === undefined || (x === 0 && y === 0 && e.detail === 0)) return;   // keyboard "click"
        var el = boxAt(x, y);
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        open(el);
    }

    // ---------------------------------------------------------------
    // Tap-to-choose list
    // ---------------------------------------------------------------
    function closeChooser(value) {
        if (!chooser) return;
        chooser.classList.remove('open');
        if (back && !state.input) back.classList.remove('open');
        var r = chooser._resolve;
        chooser._resolve = null;
        if (r) r(value);
    }

    /**
     * Ask a question with big buttons instead of a typed answer.
     *   opts.title    the question
     *   opts.help     one line under it (optional)
     *   opts.options  [ 'Started by mistake', ... ]
     *   opts.other    label for a typed answer, shown only when a keyboard can be used (optional)
     * Resolves with the chosen text, or null if cancelled.
     */
    function choose(opts) {
        css(); backdrop();
        if (!chooser) {
            chooser = document.createElement('div');
            chooser.className = 'rnp-choose';
            chooser.setAttribute('role', 'dialog');
            chooser.setAttribute('aria-modal', 'true');
            chooser.setAttribute('aria-labelledby', 'rnp-choose-title');
            chooser.addEventListener('click', function (e) {
                var b = e.target.closest('button[data-v]');
                if (b) { e.preventDefault(); closeChooser(b.getAttribute('data-v')); return; }
                if (e.target.closest('button[data-cancel]')) { e.preventDefault(); closeChooser(null); return; }
                if (e.target.closest('button[data-other]')) {
                    e.preventDefault();
                    var t = (chooser.querySelector('input') || {}).value || '';
                    if (t.trim()) closeChooser(t.trim());
                }
            });
            document.body.appendChild(chooser);
        }
        var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
        chooser.innerHTML =
            '<h2 id="rnp-choose-title">' + esc(opts.title || 'Choose one') + '</h2>' +
            (opts.help ? '<p>' + esc(opts.help) + '</p>' : '') +
            '<div class="rnp-opts">' + (opts.options || []).map(function (o) {
                return '<button type="button" class="rnp-opt" data-v="' + esc(o) + '">' + esc(o) + '</button>';
            }).join('') + '</div>' +
            (opts.other ? '<div class="rnp-other"><input type="text" maxlength="200" placeholder="' + esc(opts.other) + '" aria-label="' + esc(opts.other) + '">' +
                '<button type="button" data-other="1">Use</button></div>' : '') +
            '<button type="button" class="rnp-cancel" data-cancel="1">Cancel</button>';
        return new Promise(function (resolve) {
            if (chooser._resolve) chooser._resolve(null);
            chooser._resolve = resolve;
            back.classList.add('open');
            chooser.classList.add('open');
        });
    }

    /**
     * Ask for a number with the pad (no phone keyboard needed).
     * Resolves with the number typed, '' if cleared to nothing, or null if cancelled.
     */
    function askNumber(label, current, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var el = document.createElement('input');
            el.type = 'number';
            el.setAttribute('aria-label', label);
            if (opts.integer) el.setAttribute('step', '1');
            el._rnpAllowBlank = true;
            el.value = current === null || current === undefined ? '' : String(current);
            var answered = false;
            el.addEventListener('change', function () { answered = true; resolve(el.value); });
            open(el, function () { if (!answered) setTimeout(function () { if (!answered) resolve(null); }, 0); });
        });
    }

    function init() {
        if (touchScreen()) document.documentElement.classList.add('rnp-touch');
        css();
        document.addEventListener('click', onTap, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    window.RAINumpad = {
        open: open, close: close, choose: choose, askNumber: askNumber,
        isOpen: function () { return !!state.input; },
        isTouch: function () { return document.documentElement.classList.contains('rnp-touch'); }
    };
})();
