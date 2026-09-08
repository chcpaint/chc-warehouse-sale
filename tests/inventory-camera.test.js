/**
 * tests/inventory-camera.test.js
 *
 * public/refinishai-inventory.js has no Node test coverage generally (it is
 * pure frontend DOM/camera code, exercised only by hand on a device) -- but
 * the camera-routing logic this file fixes is plain data-in/data-out and
 * worth pinning down for real: which element ids a camera session targets,
 * and which scan handler a decode is handed to, both keyed only off
 * inv.camera.target ('scan' or 'count'). This loads the actual file in a
 * minimal vm sandbox (no jsdom needed -- nothing here touches layout) and
 * drives those two functions directly.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'refinishai-inventory.js'), 'utf8');

function loadRAI() {
    const calls = { getElementById: [] };
    const window = {};
    const document = {
        getElementById: (id) => { calls.getElementById.push(id); return null; },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        activeElement: null
    };
    const navigator = { mediaDevices: undefined, vibrate: undefined };
    const context = {
        window, document, navigator,
        localStorage: { getItem: () => null, setItem: () => {} },
        console,
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {}
    };
    context.window.document = document;
    vm.createContext(context);
    vm.runInContext(SRC, context, { filename: 'refinishai-inventory.js' });
    return { RAI: context.window.RAI, calls };
}

// ==================================================================
// cameraIds() -- the one place a target turns into element ids
// ==================================================================

test('cameraIds resolves the Scan tab camera by default', () => {
    const { RAI } = loadRAI();
    const ids = RAI.cameraIds();
    assert.equal(ids.wrap, 'inv-camera-wrap');
    assert.equal(ids.video, 'inv-video');
    assert.equal(ids.hint, 'inv-camera-hint');
    assert.equal(ids.flash, 'inv-camera-flash');
    assert.equal(ids.host, 'inv-html5-host');
});

test('cameraIds resolves the Scan tab camera for any target other than "count"', () => {
    const { RAI } = loadRAI();
    assert.equal(RAI.cameraIds('scan').wrap, 'inv-camera-wrap');
    assert.equal(RAI.cameraIds('bogus').wrap, 'inv-camera-wrap');
});

test('cameraIds resolves a completely separate set of ids for the Count tab', () => {
    const { RAI } = loadRAI();
    const ids = RAI.cameraIds('count');
    assert.equal(ids.wrap, 'inv-count-camera-wrap');
    assert.equal(ids.video, 'inv-count-video');
    assert.equal(ids.hint, 'inv-count-camera-hint');
    assert.equal(ids.flash, 'inv-count-camera-flash');
    assert.equal(ids.host, 'inv-count-html5-host');
    // Guards the regression this fix exists for: before it, every one of
    // these resolved to the Scan tab's ids no matter which button was
    // pressed, so the Count tab's camera ran invisibly behind a hidden
    // section and posted through the wrong handler.
    const scanIds = RAI.cameraIds('scan');
    for (const key of Object.keys(ids)) {
        assert.notEqual(ids[key], scanIds[key], `expected "${key}" to differ between scan and count`);
    }
});

// ==================================================================
// onCameraCode() -- routes a decode to the tab that actually opened the
// camera, not always to the Scan tab's basket
// ==================================================================

test('a decode while the Scan camera is open goes to submitScan', () => {
    const { RAI } = loadRAI();
    RAI.state.camera.target = 'scan';
    RAI.beep = () => {};
    RAI.flashCameraBox = () => {};
    let submitted = null, counted = null;
    RAI.submitScan = (code) => { submitted = code; };
    RAI.countScan = (code) => { counted = code; };

    RAI.onCameraCode('012345678905');

    assert.equal(submitted, '012345678905');
    assert.equal(counted, null);
});

test('a decode while the Count camera is open goes to countScan, not submitScan', () => {
    const { RAI } = loadRAI();
    RAI.state.camera.target = 'count';
    RAI.beep = () => {};
    RAI.flashCameraBox = () => {};
    let submitted = null, counted = null;
    RAI.submitScan = (code) => { submitted = code; };
    RAI.countScan = (code) => { counted = code; };

    RAI.onCameraCode('012345678905');

    // This is the regression the fix closes: a Count-tab scan used to be
    // silently posted as a use/receive movement (submitScan) instead of a
    // count line, because onCameraCode never looked at which tab was open.
    assert.equal(counted, '012345678905');
    assert.equal(submitted, null);
});

test('the 2.5s debounce still applies regardless of which tab is scanning', () => {
    const { RAI } = loadRAI();
    RAI.state.camera.target = 'count';
    RAI.beep = () => {};
    RAI.flashCameraBox = () => {};
    let calls = 0;
    RAI.countScan = () => { calls++; };

    RAI.onCameraCode('111');
    RAI.onCameraCode('111'); // same code, immediately -- should be swallowed

    assert.equal(calls, 1);
});

// ==================================================================
// The view-switch guard: stopping the camera has to key off which tab
// actually opened it, not a fixed "scan or count" allow-list
// ==================================================================

test('showInvView stops the camera when leaving the tab that opened it, even switching straight to the other camera-capable tab', () => {
    const { RAI } = loadRAI();
    RAI.state.camera.on = true;
    RAI.state.camera.target = 'scan';
    let stopped = false;
    RAI.stopCamera = () => { stopped = true; };
    // Stub out the per-view loaders so this test only exercises the guard.
    for (const fn of ['loadInvStock', 'loadReplenishment', 'loadInvHistory', 'loadKits',
        'loadCount', 'loadTransfers', 'renderTransferBasket', 'loadAnalytics', 'focusScanInput']) {
        RAI[fn] = () => {};
    }

    RAI.showInvView('count'); // the Scan camera was open; switching to Count must stop it

    assert.equal(stopped, true);
});

test('showInvView leaves the camera running when the view is the one that opened it', () => {
    const { RAI } = loadRAI();
    RAI.state.camera.on = true;
    RAI.state.camera.target = 'count';
    let stopped = false;
    RAI.stopCamera = () => { stopped = true; };
    for (const fn of ['loadInvStock', 'loadReplenishment', 'loadInvHistory', 'loadKits',
        'loadCount', 'loadTransfers', 'renderTransferBasket', 'loadAnalytics', 'focusScanInput']) {
        RAI[fn] = () => {};
    }

    RAI.showInvView('count');

    assert.equal(stopped, false);
});
