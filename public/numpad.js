/**
 * public/numpad.js -- an on-screen number pad for quantity boxes on phones
 * and tablets.
 *
 * Why: a USB or Bluetooth barcode scanner plugged into a phone is, to the
 * phone, a keyboard. While one is connected iOS (and most Android builds)
 * stop showing the on-screen keyboard, so tapping a quantity box does
 * nothing visible and there is no way to type a number. This pad does not
 * depend on the phone's keyboard at all, so it works with or without a
 * scanner attached.
 *
 * Where: every number box inside the Inventory tab (#tab-inventory) and
 * inside anything marked data-numpad-root. Only for a touch tap; a mouse or a real keyboard on a computer types as before.
 * A box can opt out with data-native-keyboard.
 *
 * When the pad is done it sets the box's value and fires the same `input`
 * and `change` events typing would, so every screen's own handlers run
 * unchanged.
 */
(function () {
    'use strict';
    if (window.RAINumpad) return;

    var ROOTS = '#tab-inventory, [data-numpad-root]';
    var state = { input: null, text: '', fresh: true, decimals: true };
    var sheet = null;

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

    function build() {
        if (sheet) return sheet;
        var css = document.createElement('style');
        css.textContent =
            '.rnp-back{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9998;display:none}' +
            '.rnp-back.open{display:block}' +
            '.rnp{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fff;border-radius:18px 18px 0 0;' +
            'box-shadow:0 -10px 30px rgba(15,23,42,.2);padding:14px 16px calc(14px + env(safe-area-inset-bottom));' +
            'max-width:480px;margin:0 auto;transform:translateY(105%);transition:transform .18s ease;font-family:inherit}' +
            '.rnp.open{transform:none}' +
            '@media (prefers-reduced-motion:reduce){.rnp{transition:none}}' +
            '.rnp-label{font-size:14px;color:#475569;margin:0 0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.rnp-display{font-size:34px;font-weight:700;text-align:right;color:#0f172a;border:2px solid #2563eb;border-radius:12px;' +
            'padding:6px 14px;min-height:56px;margin-bottom:10px;font-variant-numeric:tabular-nums;overflow:hidden}' +
            '.rnp-display.empty{color:#94a3b8}' +
            '.rnp-keys{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}' +
            '.rnp-keys button{height:56px;border-radius:12px;border:1px solid #e2e8f0;background:#f8fafc;font-size:24px;font-weight:600;color:#0f172a;' +
            'touch-action:manipulation;-webkit-tap-highlight-color:transparent}' +
            '.rnp-keys button:active{background:#e2e8f0}' +
            '.rnp-keys button:focus-visible,.rnp-act button:focus-visible{outline:3px solid #93c5fd;outline-offset:1px}' +
            '.rnp-keys button[disabled]{visibility:hidden}' +
            '.rnp-act{display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-top:8px}' +
            '.rnp-act button{height:52px;border-radius:12px;font-size:18px;font-weight:600;touch-action:manipulation}' +
            '.rnp-cancel{background:#fff;border:1px solid #cbd5e1;color:#334155}' +
            '.rnp-done{background:#2563eb;border:1px solid #2563eb;color:#fff}';
        document.head.appendChild(css);

        var back = document.createElement('div');
        back.className = 'rnp-back';
        back.addEventListener('click', cancel);

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
        sheet._back = back;
        document.body.appendChild(back);
        document.body.appendChild(sheet);

        // A computer keyboard (or the phone's own, if it does show) works too.
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
        if (k === 'cancel') return cancel();
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
        sheet._back.classList.remove('open');
        var el = state.input;
        state.input = null;
        if (el) { el.readOnly = !!el._rnpWasReadOnly; delete el._rnpWasReadOnly; }
    }

    function cancel() { close(); }

    function done() {
        var el = state.input;
        var text = state.text.replace(/\.$/, '');
        close();
        if (!el || state.fresh || text === '') return;      // nothing typed: leave it as it was
        if (String(el.value) === text) return;
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function open(el) {
        build();
        state.input = el;
        state.text = '';
        state.fresh = true;
        state.decimals = allowsDecimals(el);
        document.getElementById('rnp-label').textContent = labelFor(el);
        paint();
        sheet._back.classList.add('open');
        sheet.classList.add('open');
    }

    // Before the tap focuses the box, make it read-only so the phone does not
    // try to open its own keyboard; then open the pad instead.
    function armTouch(e) {
        var el = e.target;
        if (!eligible(el)) return;
        if (e.type === 'pointerdown' && e.pointerType === 'mouse') return;
        if (!('_rnpWasReadOnly' in el)) el._rnpWasReadOnly = el.readOnly;
        el.readOnly = true;
        el._rnpArmed = Date.now();
        // A touch that turns into a scroll never clicks: give the box back.
        clearTimeout(el._rnpTimer);
        el._rnpTimer = setTimeout(function () {
            if (state.input !== el && '_rnpWasReadOnly' in el) { el.readOnly = el._rnpWasReadOnly; delete el._rnpWasReadOnly; }
        }, 1600);
    }
    document.addEventListener('pointerdown', armTouch, true);
    document.addEventListener('touchstart', armTouch, { capture: true, passive: true });

    document.addEventListener('click', function (e) {
        var el = e.target;
        if (!eligible(el) || !el._rnpArmed || Date.now() - el._rnpArmed > 1500) return;
        el._rnpArmed = 0;
        if (el._rnpWasReadOnly) { el.readOnly = true; delete el._rnpWasReadOnly; return; }
        e.preventDefault();
        if (typeof el.blur === 'function') el.blur();
        open(el);
    }, true);

    window.RAINumpad = { open: open, close: close, isOpen: function () { return !!state.input; } };
})();
