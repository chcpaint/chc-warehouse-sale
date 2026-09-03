/**
 * public/refinishai-inventory.js
 *
 * refinishAI Inventory — the optional inventory half of the CHC sales console.
 *
 * This file is fetched only for companies that have the module switched on, so
 * a customer using the ordering portal alone never downloads a byte of it. It
 * owns its own markup and state; the console hands it a context object and
 * calls three methods. Nothing else in the console depends on anything here,
 * and deleting this file degrades the console to the ordering portal it was.
 *
 * Contract with store.html:
 *   RAI.init(ctx) -> boolean   ctx = { apiBase, slug, settings, mount,
 *                                      getToken(), getLocation(), getCompany(),
 *                                      onOrderPlaced() }
 *   RAI.show()                 the console switched to the Inventory tab
 *   RAI.teardown()             the console left the tab, or logged out
 */
(function () {
    'use strict';

    const RAI = window.RAI = window.RAI || {};
    RAI.ready = false;
    RAI.ctx = null;

    /** Authenticated fetch, using whatever token the console currently holds. */
    RAI.api = function (path, options) {
        options = options || {};
        return fetch(`${RAI.ctx.apiBase}${path}`, Object.assign({}, options, {
            headers: Object.assign({
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${RAI.ctx.getToken()}`
            }, options.headers || {})
        }));
    };

    /** Escape before interpolating into innerHTML. */
    RAI.esc = function (text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };

    // The Inventory tab's markup. It lives here, not in store.html, so the
    // console ships nothing for a company that has the module switched off.
    RAI.markup = [
        "            <!-- ============ INVENTORY TAB ============ -->",
        "            <section id=\"tab-inventory\" class=\"hidden fade-in\">",
        "",
        "                <!-- Who is scanning. Storefront sessions carry no user identity,",
        "                     so this name is what attributes every movement in the ledger. -->",
        "                <div class=\"bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap items-center gap-3\">",
        "                    <!-- RefinishAI is CHC's digital brand; the mark is drawn for a light",
        "                         ground, which is what this strip is. -->",
        "                    <div class=\"flex items-center gap-2 pr-3 border-r\">",
        "                        <img src=\"/assets/refinishai-mark.png\" alt=\"RefinishAI\"",
        "                            class=\"h-8 w-8 object-contain\" onerror=\"this.style.display='none'\">",
        "                        <div class=\"leading-tight\">",
        "                            <div class=\"font-semibold text-gray-800 text-sm\">",
        "                                refinish<span class=\"text-blue-500\">AI</span> Inventory",
        "                            </div>",
        "                            <div class=\"text-[11px] text-gray-400\">by CHC Paint &amp; Auto Body Supplies</div>",
        "                        </div>",
        "                    </div>",
        "                    <div class=\"flex items-center gap-2\">",
        "                        <i class=\"fas fa-user-tag text-gray-400\"></i>",
        "                        <label for=\"inv-actor\" class=\"text-sm text-gray-600\">Working as</label>",
        "                        <input id=\"inv-actor\" type=\"text\" maxlength=\"80\" placeholder=\"Your name\"",
        "                            class=\"border rounded-lg px-3 py-1.5 text-sm w-44 focus:ring-2 focus:ring-blue-500 focus:outline-none\"",
        "                            oninput=\"RAI.saveActor()\">",
        "                    </div>",
        "                    <div class=\"text-sm text-gray-500 border-l pl-3\">",
        "                        <i class=\"fas fa-location-dot mr-1\"></i><span id=\"inv-location-name\">\u2014</span>",
        "                    </div>",
        "                    <div class=\"ml-auto flex gap-1 text-sm\">",
        "                        <button onclick=\"RAI.showInvView('scan')\" data-invview=\"scan\"",
        "                            class=\"px-3 py-1.5 rounded-lg hover:bg-gray-100 inv-view-btn\">",
        "                            <i class=\"fas fa-barcode mr-1\"></i> Scan",
        "                        </button>",
        "                        <button onclick=\"RAI.showInvView('stock')\" data-invview=\"stock\"",
        "                            class=\"px-3 py-1.5 rounded-lg hover:bg-gray-100 inv-view-btn\">",
        "                            <i class=\"fas fa-warehouse mr-1\"></i> Stock",
        "                        </button>",
        "                        <button onclick=\"RAI.showInvView('replen')\" data-invview=\"replen\"",
        "                            class=\"px-3 py-1.5 rounded-lg hover:bg-gray-100 inv-view-btn relative\">",
        "                            <i class=\"fas fa-cart-arrow-down mr-1\"></i> Reorder",
        "                            <span id=\"inv-replen-badge\"",
        "                                class=\"hidden absolute -top-1 -right-1 bg-amber-500 text-white text-xs rounded-full w-5 h-5 items-center justify-center\">0</span>",
        "                        </button>",
        "                        <button onclick=\"RAI.showInvView('kits')\" data-invview=\"kits\"",
        "                            class=\"px-3 py-1.5 rounded-lg hover:bg-gray-100 inv-view-btn\">",
        "                            <i class=\"fas fa-boxes-packing mr-1\"></i> Kits",
        "                        </button>",
        "                        <button onclick=\"RAI.showInvView('count')\" data-invview=\"count\"",
        "                            class=\"px-3 py-1.5 rounded-lg hover:bg-gray-100 inv-view-btn\">",
        "                            <i class=\"fas fa-clipboard-check mr-1\"></i> Count",
        "                        </button>",
        "                        <button onclick=\"RAI.showInvView('transfer')\" data-invview=\"transfer\"",
        "                            class=\"px-3 py-1.5 rounded-lg hover:bg-gray-100 inv-view-btn\">",
        "                            <i class=\"fas fa-right-left mr-1\"></i> Transfer",
        "                        </button>",
        "                        <button onclick=\"RAI.showInvView('analytics')\" data-invview=\"analytics\"",
        "                            class=\"px-3 py-1.5 rounded-lg hover:bg-gray-100 inv-view-btn\">",
        "                            <i class=\"fas fa-chart-simple mr-1\"></i> Usage",
        "                        </button>",
        "                        <button onclick=\"RAI.showInvView('history')\" data-invview=\"history\"",
        "                            class=\"px-3 py-1.5 rounded-lg hover:bg-gray-100 inv-view-btn\">",
        "                            <i class=\"fas fa-clock-rotate-left mr-1\"></i> History",
        "                        </button>",
        "                    </div>",
        "                </div>",
        "",
        "                <!-- Summary strip -->",
        "                <div class=\"grid grid-cols-2 md:grid-cols-4 gap-3 mb-4\">",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-4\">",
        "                        <div class=\"text-xs uppercase tracking-wide text-gray-400\">Tracked items</div>",
        "                        <div id=\"inv-stat-tracked\" class=\"text-2xl font-bold text-gray-800\">\u2014</div>",
        "                    </div>",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-4\">",
        "                        <div class=\"text-xs uppercase tracking-wide text-gray-400\">Low stock</div>",
        "                        <div id=\"inv-stat-low\" class=\"text-2xl font-bold text-amber-600\">\u2014</div>",
        "                    </div>",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-4\">",
        "                        <div class=\"text-xs uppercase tracking-wide text-gray-400\">Out of stock</div>",
        "                        <div id=\"inv-stat-out\" class=\"text-2xl font-bold text-red-600\">\u2014</div>",
        "                    </div>",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-4\">",
        "                        <div class=\"text-xs uppercase tracking-wide text-gray-400\">Stock value</div>",
        "                        <div id=\"inv-stat-value\" class=\"text-2xl font-bold text-gray-800\">\u2014</div>",
        "                    </div>",
        "                </div>",
        "",
        "                <!-- ---------- SCAN VIEW ---------- -->",
        "                <div id=\"inv-view-scan\">",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-5 mb-4\">",
        "                        <div class=\"flex flex-wrap items-center gap-3 mb-4\">",
        "                            <div class=\"flex bg-gray-100 rounded-lg p-1\">",
        "                                <button onclick=\"RAI.setScanMode('consume')\" data-scanmode=\"consume\"",
        "                                    class=\"px-4 py-2 rounded-md text-sm font-medium scan-mode-btn\">",
        "                                    <i class=\"fas fa-minus-circle mr-1\"></i> Use",
        "                                </button>",
        "                                <button onclick=\"RAI.setScanMode('receive')\" data-scanmode=\"receive\"",
        "                                    class=\"px-4 py-2 rounded-md text-sm font-medium scan-mode-btn\">",
        "                                    <i class=\"fas fa-truck-ramp-box mr-1\"></i> Receive",
        "                                </button>",
        "                                <button onclick=\"RAI.setScanMode('count')\" data-scanmode=\"count\"",
        "                                    class=\"px-4 py-2 rounded-md text-sm font-medium scan-mode-btn\">",
        "                                    <i class=\"fas fa-clipboard-check mr-1\"></i> Count",
        "                                </button>",
        "                            </div>",
        "                            <span id=\"inv-scan-hint\" class=\"text-sm text-gray-500\">",
        "                                Each scan adds one. Scan it again to add another, or type the quantity on the line.",
        "                            </span>",
        "                            <input id=\"inv-job-ref\" type=\"text\" maxlength=\"60\" placeholder=\"Job / RO number (optional)\"",
        "                                class=\"border rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[12rem] focus:ring-2 focus:ring-blue-500 focus:outline-none\">",
        "                        </div>",
        "",
        "                        <div class=\"flex flex-wrap gap-2\">",
        "                            <div class=\"relative flex-1 min-w-[16rem]\">",
        "                                <i class=\"fas fa-barcode absolute left-3 top-1/2 -translate-y-1/2 text-gray-400\"></i>",
        "                                <input id=\"inv-scan-input\" type=\"text\" autocomplete=\"off\"",
        "                                    placeholder=\"Scan a barcode or type a part number, then press Enter\"",
        "                                    class=\"w-full border-2 border-blue-200 rounded-lg pl-10 pr-3 py-3 text-lg focus:border-blue-500 focus:outline-none\"",
        "                                    onkeydown=\"if(event.key==='Enter'){event.preventDefault();RAI.submitScan(this.value);}\">",
        "                            </div>",
        "                            <button onclick=\"RAI.toggleCamera()\" id=\"inv-camera-btn\" type=\"button\"",
        "                                class=\"px-4 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white\">",
        "                                <i class=\"fas fa-camera mr-1\"></i> <span id=\"inv-camera-label\">Camera</span>",
        "                            </button>",
        "                        </div>",
        "                        <p class=\"text-xs text-gray-400 mt-2\">",
        "                            A USB or Bluetooth scanner works anywhere on this page \u2014 no need to click the box first.",
        "                        </p>",
        "",
        "                        <!-- Camera viewport -->",
        "                        <div id=\"inv-camera-wrap\" class=\"hidden mt-4\">",
        "                            <div class=\"relative bg-black rounded-lg overflow-hidden max-w-md mx-auto\">",
        "                                <video id=\"inv-video\" playsinline muted class=\"w-full\"></video>",
        "                                <div class=\"absolute inset-x-8 top-1/2 -translate-y-1/2 h-24 border-2 border-green-400/80 rounded-lg pointer-events-none\"></div>",
        "                            </div>",
        "                            <p id=\"inv-camera-hint\" class=\"text-center text-xs text-gray-500 mt-2\">",
        "                                Hold the barcode inside the green box.",
        "                            </p>",
        "                        </div>",
        "                    </div>",
        "",
        "                    <!-- Scan result / disambiguation -->",
        "                    <div id=\"inv-scan-result\" class=\"mb-4\"></div>",
        "",
        "                    <!-- Staged. Scanned but not yet in the ledger, so a mis-scan is",
        "                         corrected here instead of needing a correcting entry. -->",
        "                    <div class=\"bg-white rounded-xl shadow-sm overflow-hidden mb-4\">",
        "                        <div class=\"px-5 py-3 border-b flex flex-wrap items-center justify-between gap-2\">",
        "                            <div>",
        "                                <h3 class=\"font-semibold text-gray-700\">Ready to post <span id=\"inv-basket-count\" class=\"text-gray-400 font-normal\"></span></h3>",
        "                                <p class=\"text-xs text-gray-400\">Nothing is written until you post it.</p>",
        "                            </div>",
        "                            <div class=\"flex items-center gap-2\">",
        "                                <button onclick=\"RAI.clearBasket()\" class=\"text-sm text-gray-400 hover:text-gray-600 px-3 py-2\">Clear</button>",
        "                                <button onclick=\"RAI.commitBasket()\" id=\"inv-basket-post\" disabled",
        "                                    class=\"bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-40\">",
        "                                    <i class=\"fas fa-check mr-1\"></i> Post",
        "                                </button>",
        "                            </div>",
        "                        </div>",
        "                        <div id=\"inv-basket-list\" class=\"divide-y max-h-96 overflow-y-auto\">",
        "                            <div class=\"px-5 py-8 text-center text-gray-400 text-sm\">Nothing scanned yet.</div>",
        "                        </div>",
        "                    </div>",
        "",
        "                    <!-- Already in the ledger. -->",
        "                    <div class=\"bg-white rounded-xl shadow-sm overflow-hidden\">",
        "                        <div class=\"px-5 py-3 border-b flex items-center justify-between\">",
        "                            <h3 class=\"font-semibold text-gray-700\">Posted</h3>",
        "                            <button onclick=\"RAI.clearScanSession()\" class=\"text-sm text-gray-400 hover:text-gray-600\">Clear</button>",
        "                        </div>",
        "                        <div id=\"inv-session-list\" class=\"divide-y max-h-64 overflow-y-auto\">",
        "                            <div class=\"px-5 py-8 text-center text-gray-400 text-sm\">Nothing posted yet.</div>",
        "                        </div>",
        "                    </div>",
        "                </div>",
        "",
        "                <!-- ---------- STOCK VIEW ---------- -->",
        "                <div id=\"inv-view-stock\" class=\"hidden\">",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap gap-3\">",
        "                        <div class=\"relative flex-1 min-w-[14rem]\">",
        "                            <i class=\"fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400\"></i>",
        "                            <input id=\"inv-stock-search\" type=\"text\" placeholder=\"Search item or part number\"",
        "                                class=\"w-full border rounded-lg pl-10 pr-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none\"",
        "                                oninput=\"RAI.invStockDebounce()\">",
        "                        </div>",
        "                        <select id=\"inv-stock-status\" onchange=\"RAI.loadInvStock()\"",
        "                            class=\"border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none\">",
        "                            <option value=\"\">All items</option>",
        "                            <option value=\"low\">Low stock</option>",
        "                            <option value=\"out\">Out of stock</option>",
        "                            <option value=\"ok\">In stock</option>",
        "                        </select>",
        "                        <button onclick=\"RAI.loadInvStock()\" class=\"px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700\">",
        "                            <i class=\"fas fa-rotate mr-1\"></i> Refresh",
        "                        </button>",
        "                    </div>",
        "                    <div class=\"bg-white rounded-xl shadow-sm overflow-hidden\">",
        "                        <div class=\"overflow-x-auto\">",
        "                            <table class=\"w-full text-sm\">",
        "                                <thead class=\"bg-gray-50 text-gray-500 text-xs uppercase tracking-wide\">",
        "                                    <tr>",
        "                                        <th class=\"text-left px-4 py-3\">Item</th>",
        "                                        <th class=\"text-left px-4 py-3\">Part #</th>",
        "                                        <th class=\"text-right px-4 py-3\">On hand</th>",
        "                                        <th class=\"text-right px-4 py-3\">Min</th>",
        "                                        <th class=\"text-right px-4 py-3\">Max</th>",
        "                                        <th class=\"text-left px-4 py-3\">Bin</th>",
        "                                        <th class=\"text-left px-4 py-3\">Status</th>",
        "                                        <th class=\"px-4 py-3\"></th>",
        "                                    </tr>",
        "                                </thead>",
        "                                <tbody id=\"inv-stock-body\" class=\"divide-y\"></tbody>",
        "                            </table>",
        "                        </div>",
        "                    </div>",
        "                </div>",
        "",
        "                <!-- ---------- REORDER QUEUE VIEW ---------- -->",
        "                <div id=\"inv-view-replen\" class=\"hidden\">",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap items-center gap-3\">",
        "                        <p class=\"text-sm text-gray-600 flex-1\">",
        "                            Items that have reached their shelf minimum are queued here. Review the quantities,",
        "                            then approve to send the order to CHC.",
        "                        </p>",
        "                        <button onclick=\"RAI.refreshReplenishment()\" class=\"px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700\">",
        "                            <i class=\"fas fa-rotate mr-1\"></i> Rebuild from stock levels",
        "                        </button>",
        "                    </div>",
        "                    <div id=\"inv-replen-list\"></div>",
        "                </div>",
        "",
        "                <!-- ---------- KITS VIEW ---------- -->",
        "                <div id=\"inv-view-kits\" class=\"hidden\">",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-4 mb-4\">",
        "                        <p class=\"text-sm text-gray-600\">",
        "                            Pick the job you are doing and the materials it uses come off the shelf together,",
        "                            booked against the repair order. Nothing moves until you review the list.",
        "                        </p>",
        "                    </div>",
        "                    <div id=\"inv-kit-list\" class=\"grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3\"></div>",
        "",
        "                    <!-- The preview panel: what a kit would take, before it takes it -->",
        "                    <div id=\"inv-kit-panel\" class=\"hidden mt-4 bg-white rounded-xl shadow-sm p-4\">",
        "                        <div class=\"flex flex-wrap items-start justify-between gap-3 mb-4\">",
        "                            <div>",
        "                                <h3 id=\"inv-kit-title\" class=\"text-lg font-semibold text-gray-800\"></h3>",
        "                                <p id=\"inv-kit-sub\" class=\"text-sm text-gray-500\"></p>",
        "                            </div>",
        "                            <button onclick=\"RAI.closeKit()\" class=\"text-gray-400 hover:text-gray-600\">",
        "                                <i class=\"fas fa-xmark text-xl\"></i>",
        "                            </button>",
        "                        </div>",
        "",
        "                        <div class=\"flex flex-wrap gap-3 mb-4\">",
        "                            <div>",
        "                                <label class=\"block text-xs font-medium text-gray-500 mb-1\">Repair order</label>",
        "                                <input id=\"inv-kit-job\" type=\"text\" placeholder=\"RO-1234\"",
        "                                    class=\"border rounded-lg px-3 py-2 w-40 focus:ring-2 focus:ring-blue-500 focus:outline-none\"",
        "                                    oninput=\"RAI.updateKitButton()\">",
        "                            </div>",
        "                            <div>",
        "                                <label class=\"block text-xs font-medium text-gray-500 mb-1\">How many</label>",
        "                                <div class=\"flex items-center gap-1\">",
        "                                    <button onclick=\"RAI.bumpKitMultiplier(-1)\" type=\"button\"",
        "                                        class=\"w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700\">&minus;</button>",
        "                                    <input id=\"inv-kit-mult\" type=\"number\" min=\"0.25\" max=\"100\" step=\"0.25\" value=\"1\"",
        "                                        class=\"border rounded-lg px-3 py-2 w-20 text-center focus:ring-2 focus:ring-blue-500 focus:outline-none\"",
        "                                        onchange=\"RAI.loadKitPreview()\">",
        "                                    <button onclick=\"RAI.bumpKitMultiplier(1)\" type=\"button\"",
        "                                        class=\"w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700\">+</button>",
        "                                </div>",
        "                            </div>",
        "                            <div class=\"flex-1 min-w-[180px]\">",
        "                                <label class=\"block text-xs font-medium text-gray-500 mb-1\">Note (optional)</label>",
        "                                <input id=\"inv-kit-note\" type=\"text\" placeholder=\"Anything unusual about this job\"",
        "                                    class=\"border rounded-lg px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:outline-none\">",
        "                            </div>",
        "                        </div>",
        "",
        "                        <div id=\"inv-kit-warning\" class=\"hidden mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800\"></div>",
        "                        <div id=\"inv-kit-result\" class=\"hidden mb-4 p-3 rounded-lg text-sm\" role=\"status\" aria-live=\"polite\"></div>",
        "",
        "                        <div class=\"overflow-x-auto\">",
        "                            <table class=\"w-full text-sm\">",
        "                                <thead class=\"text-left text-gray-500 border-b\">",
        "                                    <tr>",
        "                                        <th class=\"py-2 pr-3\">Item</th>",
        "                                        <th class=\"py-2 pr-3 text-right\">Qty</th>",
        "                                        <th class=\"py-2 pr-3 text-right\">On hand</th>",
        "                                        <th class=\"py-2 pr-3 text-right\">Cost</th>",
        "                                        <th class=\"py-2 pr-3 text-center\">Use</th>",
        "                                    </tr>",
        "                                </thead>",
        "                                <tbody id=\"inv-kit-lines\"></tbody>",
        "                            </table>",
        "                        </div>",
        "",
        "                        <div class=\"flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t\">",
        "                            <p class=\"text-sm text-gray-600\">",
        "                                Total <span id=\"inv-kit-total\" class=\"font-semibold text-gray-900\">$0.00</span>",
        "                            </p>",
        "                            <button id=\"inv-kit-commit\" onclick=\"RAI.consumeKit()\" disabled",
        "                                class=\"px-5 py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed\">",
        "                                <i class=\"fas fa-check mr-1\"></i> Expense to job",
        "                            </button>",
        "                        </div>",
        "                    </div>",
        "",
        "                    <div id=\"inv-kit-recent\" class=\"mt-4\"></div>",
        "                </div>",
        "",
        "                <!-- ---------- HISTORY VIEW ---------- -->",
        "                <div id=\"inv-view-history\" class=\"hidden\">",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap gap-3\">",
        "                        <select id=\"inv-hist-type\" onchange=\"RAI.loadInvHistory()\"",
        "                            class=\"border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none\">",
        "                            <option value=\"\">All movements</option>",
        "                            <option value=\"consume\">Used</option>",
        "                            <option value=\"receive\">Received</option>",
        "                            <option value=\"count\">Counted</option>",
        "                            <option value=\"adjust\">Adjusted</option>",
        "                        </select>",
        "                        <button onclick=\"RAI.loadInvHistory()\" class=\"px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700\">",
        "                            <i class=\"fas fa-rotate mr-1\"></i> Refresh",
        "                        </button>",
        "                        <button onclick=\"RAI.exportInvHistory()\" class=\"px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700\">",
        "                            <i class=\"fas fa-file-csv mr-1\"></i> Export CSV",
        "                        </button>",
        "                    </div>",
        "                    <div class=\"bg-white rounded-xl shadow-sm overflow-hidden\">",
        "                        <div class=\"overflow-x-auto\">",
        "                            <table class=\"w-full text-sm\">",
        "                                <thead class=\"bg-gray-50 text-gray-500 text-xs uppercase tracking-wide\">",
        "                                    <tr>",
        "                                        <th class=\"text-left px-4 py-3\">When</th>",
        "                                        <th class=\"text-left px-4 py-3\">Item</th>",
        "                                        <th class=\"text-left px-4 py-3\">Movement</th>",
        "                                        <th class=\"text-right px-4 py-3\">Change</th>",
        "                                        <th class=\"text-right px-4 py-3\">On hand after</th>",
        "                                        <th class=\"text-left px-4 py-3\">By</th>",
        "                                        <th class=\"text-left px-4 py-3\">Job / reason</th>",
        "                                    </tr>",
        "                                </thead>",
        "                                <tbody id=\"inv-hist-body\" class=\"divide-y\"></tbody>",
        "                            </table>",
        "                        </div>",
        "                    </div>",
        "                </div>",
        "                <!-- ---------- COUNT VIEW (phase 4) ---------- -->",
        "                <div id=\"inv-view-count\" class=\"hidden\">",
        "                    <div id=\"inv-count-empty\" class=\"bg-white rounded-xl shadow-sm p-8 text-center\">",
        "                        <i class=\"fas fa-clipboard-check text-4xl text-gray-300 mb-3\"></i>",
        "                        <div class=\"text-gray-700 font-medium mb-1\">No count in progress</div>",
        "                        <p class=\"text-sm text-gray-500 max-w-md mx-auto mb-5\">",
        "                            Counting is a session: scan the shelf at your own pace, then review the",
        "                            differences before anything changes. Nothing moves until you commit.",
        "                        </p>",
        "                        <div class=\"flex flex-wrap gap-2 justify-center items-center\">",
        "                            <select id=\"inv-count-scope\" onchange=\"RAI.onCountScopeChange()\"",
        "                                class=\"border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none\">",
        "                                <option value=\"all\">Everything at this location</option>",
        "                                <option value=\"category\">One category</option>",
        "                                <option value=\"bin\">One bin / shelf</option>",
        "                            </select>",
        "                            <input id=\"inv-count-scope-value\" type=\"text\" maxlength=\"80\" placeholder=\"Category or bin\"",
        "                                class=\"hidden border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none\">",
        "                            <button onclick=\"RAI.startCount()\"",
        "                                class=\"px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium\">",
        "                                <i class=\"fas fa-play mr-1\"></i> Start count",
        "                            </button>",
        "                        </div>",
        "                    </div>",
        "",
        "                    <div id=\"inv-count-active\" class=\"hidden\">",
        "                        <div class=\"bg-white rounded-xl shadow-sm p-4 mb-4\">",
        "                            <div class=\"flex flex-wrap items-center gap-3 mb-3\">",
        "                                <div>",
        "                                    <div class=\"font-semibold text-gray-800\" id=\"inv-count-name\">Count</div>",
        "                                    <div class=\"text-xs text-gray-500\" id=\"inv-count-meta\"></div>",
        "                                </div>",
        "                                <div class=\"ml-auto flex gap-4 text-sm\">",
        "                                    <div class=\"text-center\">",
        "                                        <div class=\"text-xs uppercase tracking-wide text-gray-400\">Counted</div>",
        "                                        <div class=\"text-xl font-bold text-gray-800\" id=\"inv-count-lines\">0</div>",
        "                                    </div>",
        "                                    <div class=\"text-center\">",
        "                                        <div class=\"text-xs uppercase tracking-wide text-gray-400\">Differences</div>",
        "                                        <div class=\"text-xl font-bold text-amber-600\" id=\"inv-count-variances\">0</div>",
        "                                    </div>",
        "                                </div>",
        "                            </div>",
        "                            <div class=\"flex flex-wrap gap-2\">",
        "                                <div class=\"relative flex-1 min-w-[14rem]\">",
        "                                    <i class=\"fas fa-barcode absolute left-3 top-1/2 -translate-y-1/2 text-gray-400\"></i>",
        "                                    <input id=\"inv-count-scan\" type=\"text\" autocomplete=\"off\"",
        "                                        placeholder=\"Scan the item you are counting\"",
        "                                        class=\"w-full border-2 border-blue-200 rounded-lg pl-10 pr-3 py-2.5 focus:border-blue-500 focus:outline-none\"",
        "                                        onkeydown=\"if(event.key==='Enter'){event.preventDefault();RAI.countScan(this.value);}\">",
        "                                </div>",
        "                                <input id=\"inv-count-qty\" type=\"number\" step=\"0.5\" min=\"0\" placeholder=\"Counted\"",
        "                                    class=\"w-28 border rounded-lg px-3 py-2.5 text-center focus:ring-2 focus:ring-blue-500 focus:outline-none\">",
        "                                <button onclick=\"RAI.toggleCamera('count')\" type=\"button\"",
        "                                    class=\"px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white\">",
        "                                    <i class=\"fas fa-camera\"></i>",
        "                                </button>",
        "                            </div>",
        "                            <div id=\"inv-count-feedback\" class=\"mt-3\"></div>",
        "                        </div>",
        "",
        "                        <div class=\"bg-white rounded-xl shadow-sm overflow-hidden mb-4\">",
        "                            <div class=\"overflow-x-auto\">",
        "                                <table class=\"w-full text-sm\">",
        "                                    <thead class=\"bg-gray-50 text-gray-500 text-xs uppercase tracking-wide\">",
        "                                        <tr>",
        "                                            <th class=\"text-left px-4 py-3\">Item</th>",
        "                                            <th class=\"text-right px-4 py-3\">System</th>",
        "                                            <th class=\"text-right px-4 py-3\">Counted</th>",
        "                                            <th class=\"text-right px-4 py-3\">Difference</th>",
        "                                            <th class=\"text-left px-4 py-3\">By</th>",
        "                                            <th class=\"px-4 py-3\"></th>",
        "                                        </tr>",
        "                                    </thead>",
        "                                    <tbody id=\"inv-count-body\" class=\"divide-y\"></tbody>",
        "                                </table>",
        "                            </div>",
        "                        </div>",
        "",
        "                        <div class=\"bg-white rounded-xl shadow-sm p-4 flex flex-wrap gap-2 justify-end\">",
        "                            <button onclick=\"RAI.cancelCount()\"",
        "                                class=\"px-4 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100\">",
        "                                Cancel count",
        "                            </button>",
        "                            <button onclick=\"RAI.commitCount()\"",
        "                                class=\"px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium\">",
        "                                <i class=\"fas fa-check mr-1\"></i> Commit and adjust stock",
        "                            </button>",
        "                        </div>",
        "                    </div>",
        "                </div>",
        "",
        "                <!-- ---------- TRANSFER VIEW (phase 4) ---------- -->",
        "                <div id=\"inv-view-transfer\" class=\"hidden\">",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-5 mb-4\">",
        "                        <h3 class=\"font-semibold text-gray-800 mb-1\">Move stock between shops</h3>",
        "                        <p class=\"text-sm text-gray-500 mb-4\">",
        "                            Both sides are recorded as one event, so a shortfall at one shop and a",
        "                            surplus at another are never left looking unexplained.",
        "                        </p>",
        "                        <div class=\"grid md:grid-cols-2 gap-3 mb-4\">",
        "                            <div>",
        "                                <label class=\"block text-xs uppercase tracking-wide text-gray-400 mb-1\">From</label>",
        "                                <select id=\"inv-tr-from\" onchange=\"RAI.onTransferLocationChange()\"",
        "                                    class=\"w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none\"></select>",
        "                            </div>",
        "                            <div>",
        "                                <label class=\"block text-xs uppercase tracking-wide text-gray-400 mb-1\">To</label>",
        "                                <select id=\"inv-tr-to\" onchange=\"RAI.onTransferLocationChange()\"",
        "                                    class=\"w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none\"></select>",
        "                            </div>",
        "                        </div>",
        "                        <div class=\"flex flex-wrap items-center gap-3 mb-3\">",
        "                            <span id=\"inv-tr-hint\" class=\"text-sm text-gray-500\">",
        "                                Each scan adds one. Scan it again to add another, or type the quantity on the line.",
        "                            </span>",
        "                            <input id=\"inv-tr-reason\" type=\"text\" maxlength=\"200\" placeholder=\"Reason (optional)\"",
        "                                class=\"border rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[12rem] focus:ring-2 focus:ring-blue-500 focus:outline-none\">",
        "                        </div>",
        "                        <div class=\"relative\">",
        "                            <i class=\"fas fa-barcode absolute left-3 top-1/2 -translate-y-1/2 text-gray-400\"></i>",
        "                            <input id=\"inv-tr-scan\" type=\"text\" autocomplete=\"off\"",
        "                                placeholder=\"Scan a barcode or type a part number, then press Enter\"",
        "                                class=\"w-full border-2 border-blue-200 rounded-lg pl-10 pr-3 py-3 text-lg focus:border-blue-500 focus:outline-none\"",
        "                                onkeydown=\"if(event.key==='Enter'){event.preventDefault();RAI.transferScan(this.value);}\">",
        "                        </div>",
        "                        <p class=\"text-xs text-gray-400 mt-2\">",
        "                            A USB or Bluetooth scanner works anywhere on this page — no need to click the box first.",
        "                        </p>",
        "                        <div id=\"inv-tr-result\" class=\"mt-3\"></div>",
        "                    </div>",
        "",
        "                    <!-- Staged. Nothing moves until Post. -->",
        "                    <div class=\"bg-white rounded-xl shadow-sm overflow-hidden mb-4\">",
        "                        <div class=\"px-5 py-3 border-b flex flex-wrap items-center justify-between gap-2\">",
        "                            <div>",
        "                                <h3 class=\"font-semibold text-gray-700\">Ready to move <span id=\"inv-tr-basket-count\" class=\"text-gray-400 font-normal\"></span></h3>",
        "                                <p class=\"text-xs text-gray-400\">Nothing is written until you post it.</p>",
        "                            </div>",
        "                            <div class=\"flex items-center gap-2\">",
        "                                <button onclick=\"RAI.clearTransferBasket()\" class=\"text-sm text-gray-400 hover:text-gray-600 px-3 py-2\">Clear</button>",
        "                                <button onclick=\"RAI.commitTransferBasket()\" id=\"inv-tr-basket-post\" disabled",
        "                                    class=\"bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-40\">",
        "                                    <i class=\"fas fa-check mr-1\"></i> Post",
        "                                </button>",
        "                            </div>",
        "                        </div>",
        "                        <div id=\"inv-tr-basket-list\" class=\"divide-y max-h-96 overflow-y-auto\">",
        "                            <div class=\"px-5 py-8 text-center text-gray-400 text-sm\">Nothing scanned yet.</div>",
        "                        </div>",
        "                    </div>",
        "",
        "                    <div class=\"bg-white rounded-xl shadow-sm overflow-hidden\">",
        "                        <div class=\"px-5 py-3 border-b font-semibold text-gray-700\">Recent transfers</div>",
        "                        <div class=\"overflow-x-auto\">",
        "                            <table class=\"w-full text-sm\">",
        "                                <thead class=\"bg-gray-50 text-gray-500 text-xs uppercase tracking-wide\">",
        "                                    <tr>",
        "                                        <th class=\"text-left px-4 py-3\">When</th>",
        "                                        <th class=\"text-left px-4 py-3\">Item</th>",
        "                                        <th class=\"text-right px-4 py-3\">Qty</th>",
        "                                        <th class=\"text-left px-4 py-3\">From</th>",
        "                                        <th class=\"text-left px-4 py-3\">To</th>",
        "                                        <th class=\"text-left px-4 py-3\">By</th>",
        "                                    </tr>",
        "                                </thead>",
        "                                <tbody id=\"inv-tr-body\" class=\"divide-y\"></tbody>",
        "                            </table>",
        "                        </div>",
        "                    </div>",
        "                </div>",
        "",
        "                <!-- ---------- ANALYTICS VIEW (phase 5) ---------- -->",
        "                <div id=\"inv-view-analytics\" class=\"hidden\">",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-center\">",
        "                        <select id=\"inv-an-period\" onchange=\"RAI.loadAnalytics()\"",
        "                            class=\"border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none\">",
        "                            <option value=\"last_30\">Last 30 days</option>",
        "                            <option value=\"this_month\">This month</option>",
        "                            <option value=\"last_month\">Last month</option>",
        "                            <option value=\"this_quarter\">This quarter</option>",
        "                            <option value=\"this_year\">This year</option>",
        "                            <option value=\"last_year\">Last year</option>",
        "                            <option value=\"all\">All time</option>",
        "                        </select>",
        "                        <label class=\"flex items-center gap-2 text-sm text-gray-600\">",
        "                            <input id=\"inv-an-allshops\" type=\"checkbox\" onchange=\"RAI.loadAnalytics()\"",
        "                                class=\"rounded border-gray-300\">",
        "                            All shops",
        "                        </label>",
        "                        <span id=\"inv-an-label\" class=\"text-sm text-gray-400\"></span>",
        "                        <div class=\"ml-auto flex gap-2\">",
        "                            <button onclick=\"RAI.exportAnalytics('product')\"",
        "                                class=\"px-3 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm\">",
        "                                <i class=\"fas fa-file-csv mr-1\"></i> By item",
        "                            </button>",
        "                            <button onclick=\"RAI.exportAnalytics('job')\"",
        "                                class=\"px-3 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm\">",
        "                                <i class=\"fas fa-file-csv mr-1\"></i> By job",
        "                            </button>",
        "                        </div>",
        "                    </div>",
        "",
        "                    <div class=\"grid grid-cols-2 md:grid-cols-4 gap-3 mb-4\">",
        "                        <div class=\"bg-white rounded-xl shadow-sm p-4\">",
        "                            <div class=\"text-xs uppercase tracking-wide text-gray-400\">Materials used</div>",
        "                            <div id=\"inv-an-value\" class=\"text-2xl font-bold text-gray-800\">\u2014</div>",
        "                        </div>",
        "                        <div class=\"bg-white rounded-xl shadow-sm p-4\">",
        "                            <div class=\"text-xs uppercase tracking-wide text-gray-400\">Units</div>",
        "                            <div id=\"inv-an-units\" class=\"text-2xl font-bold text-gray-800\">\u2014</div>",
        "                        </div>",
        "                        <div class=\"bg-white rounded-xl shadow-sm p-4\">",
        "                            <div class=\"text-xs uppercase tracking-wide text-gray-400\">Jobs</div>",
        "                            <div id=\"inv-an-jobs\" class=\"text-2xl font-bold text-gray-800\">\u2014</div>",
        "                        </div>",
        "                        <div class=\"bg-white rounded-xl shadow-sm p-4\">",
        "                            <div class=\"text-xs uppercase tracking-wide text-gray-400\">Avg per job</div>",
        "                            <div id=\"inv-an-perjob\" class=\"text-2xl font-bold text-gray-800\">\u2014</div>",
        "                        </div>",
        "                    </div>",
        "",
        "                    <div class=\"bg-white rounded-xl shadow-sm p-5 mb-4\">",
        "                        <h3 class=\"font-semibold text-gray-700 mb-3\">Daily consumption</h3>",
        "                        <div id=\"inv-an-chart\" class=\"w-full overflow-x-auto\"></div>",
        "                    </div>",
        "",
        "                    <div class=\"grid lg:grid-cols-2 gap-4\">",
        "                        <div class=\"bg-white rounded-xl shadow-sm overflow-hidden\">",
        "                            <div class=\"px-5 py-3 border-b font-semibold text-gray-700\">Top items by value used</div>",
        "                            <div class=\"overflow-x-auto\">",
        "                                <table class=\"w-full text-sm\">",
        "                                    <thead class=\"bg-gray-50 text-gray-500 text-xs uppercase tracking-wide\">",
        "                                        <tr>",
        "                                            <th class=\"text-left px-4 py-2\">Item</th>",
        "                                            <th class=\"text-right px-4 py-2\">Units</th>",
        "                                            <th class=\"text-right px-4 py-2\">Value</th>",
        "                                        </tr>",
        "                                    </thead>",
        "                                    <tbody id=\"inv-an-products\" class=\"divide-y\"></tbody>",
        "                                </table>",
        "                            </div>",
        "                        </div>",
        "                        <div class=\"bg-white rounded-xl shadow-sm overflow-hidden\">",
        "                            <div class=\"px-5 py-3 border-b font-semibold text-gray-700\">Materials by job / RO</div>",
        "                            <div class=\"overflow-x-auto\">",
        "                                <table class=\"w-full text-sm\">",
        "                                    <thead class=\"bg-gray-50 text-gray-500 text-xs uppercase tracking-wide\">",
        "                                        <tr>",
        "                                            <th class=\"text-left px-4 py-2\">Job</th>",
        "                                            <th class=\"text-right px-4 py-2\">Items</th>",
        "                                            <th class=\"text-right px-4 py-2\">Value</th>",
        "                                            <th class=\"text-left px-4 py-2\">Last used</th>",
        "                                        </tr>",
        "                                    </thead>",
        "                                    <tbody id=\"inv-an-jobs-body\" class=\"divide-y\"></tbody>",
        "                                </table>",
        "                            </div>",
        "                        </div>",
        "                    </div>",
        "                </div>",
        "            </section>"
    ].join('\n');('\n');

    // ============================================================
    // INVENTORY MODULE
    //
    // Optional per company. Everything below is inert until
    // RAI.initInventory() finds settings.inventory.enabled on the company.
    //
    // Two scan inputs sit behind one RAI.submitScan():
    //   1. keyboard-wedge scanners (USB / Bluetooth) — detected by typing speed
    //   2. the phone camera — native BarcodeDetector, with html5-qrcode as the
    //      fallback iOS requires
    // ============================================================

    const inv = RAI.state = {
        enabled: false,
        settings: null,
        view: 'scan',
        mode: 'consume',
        session: [],
        basket: [],
        trBasket: [],
        trActiveProductId: null,
        stock: [],
        replenishment: [],
        camera: { on: false, target: 'scan', stream: null, detector: null, raf: null, html5: null, lastCode: '', lastAt: 0 },
        busy: false
    };

    /**
     * Called by store.html once it has confirmed the company has the module
     * switched on. Injects the tab markup, wires the scanners, reports back.
     */
    RAI.init = function (ctx) {
        if (RAI.ready) return true;
        RAI.ctx = ctx;
        inv.settings = ctx.settings || {};
        inv.enabled = true;

        const host = ctx.mount || document.querySelector('main');
        if (!host) return false;
        const holder = document.createElement('div');
        holder.innerHTML = RAI.markup;
        while (holder.firstChild) host.appendChild(holder.firstChild);

        const actorEl = document.getElementById('inv-actor');
        if (actorEl) {
            try { actorEl.value = localStorage.getItem('chc_inv_actor') || ''; } catch (e) { /* private mode */ }
        }
        const locEl = document.getElementById('inv-location-name');
        const loc = ctx.getLocation();
        if (locEl && loc) locEl.textContent = loc.name;

        RAI.setScanMode('consume');
        RAI.showInvView('scan');
        RAI.installWedgeListener();
        RAI.installPwa();
        RAI.loadInvSummary();

        RAI.ready = true;
        return true;
    };

    /** The console switched to the Inventory tab. */
    RAI.show = function () {
        RAI.loadInvSummary();
        RAI.showInvView(inv.view || 'scan');
    };

    /** The console left the tab, or logged out. */
    RAI.teardown = function () {
        if (inv.camera.on) RAI.stopCamera();
    };

    RAI.saveActor = function () {
        const el = document.getElementById('inv-actor');
        if (!el) return;
        try { localStorage.setItem('chc_inv_actor', el.value.trim()); } catch (e) { /* private mode */ }
    }

    RAI.invActor = function () {
        const el = document.getElementById('inv-actor');
        return el ? el.value.trim() : '';
    }

    RAI.invLocationId = function () {
        return RAI.ctx.getLocation() ? RAI.ctx.getLocation().id : '';
    }

    // ------------------------------------------------------------
    // VIEW SWITCHING
    // ------------------------------------------------------------
    RAI.VIEWS = ['scan', 'stock', 'replen', 'kits', 'count', 'transfer', 'analytics', 'history'];

    RAI.showInvView = function (view) {
        inv.view = view;
        RAI.VIEWS.forEach(v => {
            const el = document.getElementById(`inv-view-${v}`);
            if (el) el.classList.toggle('hidden', v !== view);
        });
        document.querySelectorAll('.inv-view-btn').forEach(b => {
            const on = b.dataset.invview === view;
            b.classList.toggle('bg-blue-50', on);
            b.classList.toggle('text-blue-700', on);
            b.classList.toggle('font-semibold', on);
        });

        if (view !== 'scan' && view !== 'count' && inv.camera.on) RAI.stopCamera();
        if (view === 'stock') RAI.loadInvStock();
        if (view === 'replen') RAI.loadReplenishment();
        if (view === 'history') RAI.loadInvHistory();
        if (view === 'kits') RAI.loadKits();
        if (view === 'count') RAI.loadCount();
        if (view === 'transfer') { RAI.loadTransfers(); RAI.renderTransferBasket(); }
        if (view === 'analytics') RAI.loadAnalytics();
        if (view === 'scan') RAI.focusScanInput();
    }

    RAI.focusScanInput = function () {
        const el = document.getElementById('inv-scan-input');
        // Focusing on a phone pops the on-screen keyboard, which is unwelcome
        // when the operator is about to use the camera instead.
        if (el && !RAI.isTouchDevice()) el.focus();
    }

    RAI.isTouchDevice = function () {
        return window.matchMedia('(pointer: coarse)').matches;
    }

    RAI.setScanMode = function (mode) {
        // Switching mode with lines staged would silently change what they
        // mean — five scanned to use becoming five received is a stock error
        // nobody would spot. Post or clear first.
        if (inv.basket.length && mode !== inv.mode) {
            RAI.renderScanResult(`<div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4">
                Post or clear the ${inv.basket.length} item(s) on the list before switching.
                They were scanned to <b>${RAI.esc({ consume: 'use', receive: 'receive', count: 'count' }[inv.mode] || inv.mode)}</b>,
                and changing that now would record the wrong movement.</div>`);
            return;
        }
        inv.mode = mode;
        document.querySelectorAll('.scan-mode-btn').forEach(b => {
            const on = b.dataset.scanmode === mode;
            b.classList.toggle('bg-white', on);
            b.classList.toggle('shadow', on);
            b.classList.toggle('text-blue-700', on);
            b.classList.toggle('text-gray-500', !on);
        });
        const hint = document.getElementById('inv-scan-hint');
        if (hint) hint.textContent = mode === 'count'
            ? 'Each scan counts one. Scan again to count another, or type the number you counted on the line.'
            : 'Each scan adds one. Scan it again to add another, or type the quantity on the line.';
        RAI.renderBasket();
        const jobRef = document.getElementById('inv-job-ref');
        if (jobRef) jobRef.classList.toggle('hidden', mode !== 'consume');
    }

    // ------------------------------------------------------------
    // KEYBOARD-WEDGE SCANNERS
    //
    // Commodity USB / Bluetooth scanners present as a keyboard: they type the
    // digits fast and press Enter. Human typing is far slower, so the gap
    // between keystrokes tells the two apart without any driver or SDK.
    // ------------------------------------------------------------
    const WEDGE_MAX_GAP_MS = 45;      // scanners fire well under this
    const WEDGE_MIN_LENGTH = 4;
    let wedgeBuffer = '';
    let wedgeLastKeyAt = 0;
    let wedgeInstalled = false;

    RAI.installWedgeListener = function () {
        if (wedgeInstalled) return;
        wedgeInstalled = true;

        document.addEventListener('keydown', (e) => {
            if (!inv.enabled) return;
            // Only while the Inventory tab is the visible one.
            const section = document.getElementById('tab-inventory');
            if (!section || section.classList.contains('hidden')) return;

            // A wedge scanner just types into whatever has focus. On the Transfer
            // screen that target is inv-tr-scan, not inv-scan-input, and the
            // result belongs in the transfer basket, not the use/receive/count
            // one — same buffering, different destination.
            const inTransfer = inv.view === 'transfer';
            const scanInputId = inTransfer ? 'inv-tr-scan' : 'inv-scan-input';

            const target = e.target;
            const typingElsewhere = target && (target.tagName === 'TEXTAREA' ||
                (target.tagName === 'INPUT' && target.id !== scanInputId));
            if (typingElsewhere) return;

            const now = Date.now();
            const gap = now - wedgeLastKeyAt;
            wedgeLastKeyAt = now;

            if (e.key === 'Enter' || e.key === 'Tab') {
                if (wedgeBuffer.length >= WEDGE_MIN_LENGTH) {
                    e.preventDefault();
                    const code = wedgeBuffer;
                    wedgeBuffer = '';
                    if (inTransfer) RAI.transferScan(code); else RAI.submitScan(code);
                } else {
                    wedgeBuffer = '';
                }
                return;
            }

            if (e.key.length !== 1) return;          // modifiers, arrows, F-keys
            if (gap > WEDGE_MAX_GAP_MS) wedgeBuffer = '';
            wedgeBuffer += e.key;
        });
    }

    // ------------------------------------------------------------
    // CAMERA SCANNING
    // ------------------------------------------------------------
    const CAMERA_FORMATS = ['upc_a', 'upc_e', 'ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'itf'];

    RAI.toggleCamera = async function () {
        if (inv.camera.on) { RAI.stopCamera(); return; }
        await RAI.startCamera();
    }

    RAI.startCamera = async function () {
        const wrap = document.getElementById('inv-camera-wrap');
        const hint = document.getElementById('inv-camera-hint');
        const video = document.getElementById('inv-video');
        if (!wrap || !video) return;

        if (!window.isSecureContext) {
            hint.textContent = 'Camera scanning needs a secure (https) connection.';
            wrap.classList.remove('hidden');
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            hint.textContent = 'This browser cannot use the camera. Use a USB scanner or type the part number.';
            wrap.classList.remove('hidden');
            return;
        }

        wrap.classList.remove('hidden');
        hint.textContent = 'Starting camera…';
        RAI.setCameraLabel('Stop');

        try {
            inv.camera.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
            video.srcObject = inv.camera.stream;
            await video.play();
            inv.camera.on = true;

            if ('BarcodeDetector' in window) {
                const supported = await window.BarcodeDetector.getSupportedFormats();
                const formats = CAMERA_FORMATS.filter(f => supported.includes(f));
                if (formats.length) {
                    inv.camera.detector = new window.BarcodeDetector({ formats });
                    hint.textContent = 'Hold the barcode inside the green box.';
                    RAI.detectLoop();
                    return;
                }
            }

            // Safari on iOS and iPadOS has no BarcodeDetector, so fall back to
            // the WASM decoder. This path is mandatory for iPhones and iPads.
            hint.textContent = 'Loading scanner…';
            await RAI.startHtml5Fallback(hint);
        } catch (err) {
            console.error('[Inventory] camera error:', err);
            hint.textContent = err && err.name === 'NotAllowedError'
                ? 'Camera permission was declined. Allow camera access, or use a USB scanner.'
                : 'Could not start the camera. Use a USB scanner or type the part number.';
            RAI.stopCamera();
        }
    }

    RAI.detectLoop = async function () {
        const video = document.getElementById('inv-video');
        if (!inv.camera.on || !inv.camera.detector || !video) return;
        try {
            const found = await inv.camera.detector.detect(video);
            if (found && found.length) RAI.onCameraCode(found[0].rawValue);
        } catch (e) { /* a dropped frame is not an error worth surfacing */ }
        inv.camera.raf = requestAnimationFrame(detectLoop);
    }

    RAI.startHtml5Fallback = async function (hint) {
        try {
            await RAI.loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js');
        } catch (e) {
            hint.textContent = 'Scanner could not load. Use a USB scanner or type the part number.';
            RAI.stopCamera();
            return;
        }
        // The library manages its own video element, so hand the stream back.
        RAI.stopStreamOnly();

        let host = document.getElementById('inv-html5-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'inv-html5-host';
            host.className = 'max-w-md mx-auto';
            document.getElementById('inv-camera-wrap').prepend(host);
        }
        host.classList.remove('hidden');
        document.getElementById('inv-video').classList.add('hidden');

        inv.camera.html5 = new window.Html5Qrcode('inv-html5-host', { verbose: false });
        await inv.camera.html5.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 280, height: 140 } },
            (decoded) => RAI.onCameraCode(decoded),
            () => { /* per-frame miss; ignore */ }
        );
        inv.camera.on = true;
        hint.textContent = 'Hold the barcode inside the frame.';
    }

    RAI.loadScriptOnce = function (src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) return resolve();
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error('script failed'));
            document.head.appendChild(s);
        });
    }

    /** Debounce repeated frames of the same barcode into one scan. */
    RAI.onCameraCode = function (code) {
        const now = Date.now();
        if (code === inv.camera.lastCode && now - inv.camera.lastAt < 2500) return;
        inv.camera.lastCode = code;
        inv.camera.lastAt = now;
        RAI.beep();
        if (navigator.vibrate) navigator.vibrate(40);
        RAI.submitScan(code);
    }

    RAI.stopStreamOnly = function () {
        if (inv.camera.raf) { cancelAnimationFrame(inv.camera.raf); inv.camera.raf = null; }
        if (inv.camera.stream) {
            inv.camera.stream.getTracks().forEach(t => t.stop());
            inv.camera.stream = null;
        }
        const video = document.getElementById('inv-video');
        if (video) video.srcObject = null;
    }

    RAI.stopCamera = function () {
        RAI.stopStreamOnly();
        inv.camera.detector = null;
        if (inv.camera.html5) {
            inv.camera.html5.stop().catch(() => {}).then(() => {
                try { inv.camera.html5.clear(); } catch (e) {}
                inv.camera.html5 = null;
            });
        }
        const host = document.getElementById('inv-html5-host');
        if (host) host.classList.add('hidden');
        const video = document.getElementById('inv-video');
        if (video) video.classList.remove('hidden');
        const wrap = document.getElementById('inv-camera-wrap');
        if (wrap) wrap.classList.add('hidden');
        inv.camera.on = false;
        RAI.setCameraLabel('Camera');
    }

    RAI.setCameraLabel = function (text) {
        const el = document.getElementById('inv-camera-label');
        if (el) el.textContent = text;
    }

    let audioCtx = null;
    RAI.beep = function (bad) {
        if (inv.settings && inv.settings.scan_sound === false) return;
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.frequency.value = bad ? 220 : 880;
            gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.16);
            osc.start(); osc.stop(audioCtx.currentTime + 0.16);
        } catch (e) { /* audio is a nicety, never a blocker */ }
    }

    // ------------------------------------------------------------
    // SCAN -> LOOKUP -> MOVEMENT
    // ------------------------------------------------------------
    RAI.submitScan = async function (rawCode) {
        const code = String(rawCode || '').trim();
        const input = document.getElementById('inv-scan-input');
        if (input) input.value = '';
        if (!code) return;

        if (!RAI.invActor()) {
            RAI.renderScanResult(`<div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4">
                Enter your name at the top before scanning — it is what records who moved the stock.</div>`);
            const actorEl = document.getElementById('inv-actor');
            if (actorEl) actorEl.focus();
            return;
        }
        if (inv.busy) return;
        inv.busy = true;

        try {
            const resp = await RAI.api(
                `/store/${RAI.ctx.slug}/inventory/lookup?code=${encodeURIComponent(code)}&location_id=${RAI.invLocationId()}`
            );
            const data = await resp.json();

            if (resp.status === 300 && data.ambiguous) {
                RAI.renderAmbiguous(data);
                return;
            }
            if (!resp.ok) {
                RAI.beep(true);
                RAI.renderScanResult(`<div class="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
                    <div class="font-semibold">${RAI.esc(data.error || 'Not found')}</div>
                    <div class="text-sm mt-1">Scanned: <code>${RAI.esc(code)}</code></div>
                    <div class="text-sm mt-2">Ask CHC to add this barcode to the item, or search for it under Stock.</div>
                </div>`);
                return;
            }
            RAI.addToBasket(data.product, code);
        } catch (err) {
            console.error('[Inventory] scan failed:', err);
            RAI.renderScanResult(`<div class="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
                Could not reach the server. Check the connection and scan again.</div>`);
        } finally {
            inv.busy = false;
            RAI.focusScanInput();
        }
    }

    RAI.renderAmbiguous = function (data) {
        RAI.beep(true);
        const rows = data.candidates.map(c => `
            <button onclick="RAI.pickCandidate('${c.id}', '${RAI.esc(data.code).replace(/'/g, "\\'")}')"
                class="w-full text-left px-4 py-3 hover:bg-blue-50 border-b last:border-b-0">
                <div class="font-medium text-gray-800">${RAI.esc(c.name)}</div>
                <div class="text-sm text-gray-500">${RAI.esc(c.sku || '')} · ${RAI.esc(c.brand || '')}
                    · on hand ${c.level ? c.level.on_hand : 0}</div>
            </button>`).join('');
        RAI.renderScanResult(`
            <div class="bg-white border-2 border-amber-300 rounded-xl overflow-hidden">
                <div class="px-4 py-3 bg-amber-50 text-amber-800 text-sm font-medium">
                    <i class="fas fa-triangle-exclamation mr-1"></i> ${RAI.esc(data.message)}
                </div>
                ${rows}
            </div>`);
    }

    RAI.pickCandidate = async function (productId, code) {
        const resp = await RAI.api(
            `/store/${RAI.ctx.slug}/inventory/lookup?code=${encodeURIComponent(code)}&location_id=${RAI.invLocationId()}`
        );
        const data = await resp.json();
        const list = data.candidates || (data.product ? [data.product] : []);
        const product = list.find(p => p.id === productId);
        if (product) RAI.addToBasket(product, code);
    }

    // ------------------------------------------------------------
    // THE BASKET
    //
    // A scan stages a line; it does not write to the ledger. One scan is one
    // unit, scanning the same thing again makes it two, and the quantity can
    // be typed straight onto the line for the times somebody is putting away
    // fifty of something.
    //
    // Staging rather than posting per scan is what makes a mis-scan a
    // correction on screen instead of a correcting entry in an append-only
    // ledger that everybody can see forever.
    // ------------------------------------------------------------

    RAI.addToBasket = function (product, code) {
        const existing = inv.basket.find(l => l.product_id === product.id);
        if (existing) {
            existing.quantity = round4(existing.quantity + 1);
            existing.error = null;
        } else {
            inv.basket.unshift({
                product_id: product.id,
                name: product.name,
                sku: product.sku,
                code: code,
                on_hand: product.level ? Number(product.level.on_hand) : null,
                quantity: 1,
                error: null
            });
        }
        // The line just scanned goes to the top and is highlighted, so on a
        // long list the thing in your hand is the thing you are looking at.
        inv.basket.sort((a, b) => (a.product_id === product.id ? -1 : b.product_id === product.id ? 1 : 0));
        inv.activeProductId = product.id;
        RAI.beep();
        RAI.renderScanResult('');
        RAI.renderBasket();
    }

    function round4(n) { return Math.round(Number(n) * 10000) / 10000; }

    RAI.setLineQty = function (productId, value) {
        const line = inv.basket.find(l => l.product_id === productId);
        if (!line) return;
        const n = parseFloat(value);
        // Zero is a legitimate count ("this shelf is empty"), so it is only
        // rejected outside count mode, where it would mean nothing at all.
        if (!Number.isFinite(n) || n < 0) return;
        if (n === 0 && inv.mode !== 'count') { RAI.removeLine(productId); return; }
        line.quantity = round4(n);
        line.error = null;
        RAI.renderBasket();
    }

    RAI.bumpLine = function (productId, delta) {
        const line = inv.basket.find(l => l.product_id === productId);
        if (!line) return;
        const next = round4(line.quantity + delta);
        if (next <= 0 && inv.mode !== 'count') { RAI.removeLine(productId); return; }
        line.quantity = Math.max(0, next);
        line.error = null;
        RAI.renderBasket();
    }

    RAI.removeLine = function (productId) {
        inv.basket = inv.basket.filter(l => l.product_id !== productId);
        if (inv.activeProductId === productId) inv.activeProductId = null;
        RAI.renderBasket();
    }

    RAI.clearBasket = function () {
        if (inv.basket.length > 1 && !confirm('Clear everything scanned but not yet posted?')) return;
        inv.basket = [];
        inv.activeProductId = null;
        RAI.renderBasket();
        RAI.focusScanInput();
    }

    RAI.renderBasket = function () {
        const el = document.getElementById('inv-basket-list');
        const count = document.getElementById('inv-basket-count');
        const post = document.getElementById('inv-basket-post');
        if (!el) return;

        const units = inv.basket.reduce((s, l) => s + Number(l.quantity || 0), 0);
        if (count) count.textContent = inv.basket.length
            ? `— ${inv.basket.length} item(s), ${RAI.formatQty(units)} unit(s)` : '';
        if (post) post.disabled = inv.basket.length === 0;

        if (!inv.basket.length) {
            el.innerHTML = '<div class="px-5 py-8 text-center text-gray-400 text-sm">Nothing scanned yet.</div>';
            return;
        }

        const verb = { consume: 'Use', receive: 'Receive', count: 'Count' }[inv.mode] || inv.mode;
        el.innerHTML = inv.basket.map(l => `
            <div class="px-4 py-3 flex items-center gap-3 ${l.product_id === inv.activeProductId ? 'bg-blue-50' : ''}">
                <div class="flex-1 min-w-0">
                    <div class="font-medium text-gray-800 truncate">${RAI.esc(l.name)}</div>
                    <div class="text-xs text-gray-500">
                        ${RAI.esc(l.sku || '')}
                        ${l.on_hand !== null && l.on_hand !== undefined ? ` · on hand ${RAI.formatQty(l.on_hand)}` : ''}
                    </div>
                    ${l.error ? `<div class="text-xs text-red-600 mt-1">${RAI.esc(l.error)}</div>` : ''}
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button onclick="RAI.bumpLine('${l.product_id}', -1)" type="button"
                        class="w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700">&minus;</button>
                    <input type="number" step="0.5" min="0" value="${l.quantity}"
                        onchange="RAI.setLineQty('${l.product_id}', this.value)"
                        onfocus="this.select()"
                        aria-label="${RAI.esc(verb)} how many of ${RAI.esc(l.name)}"
                        class="w-20 border rounded-lg px-2 py-1.5 text-center text-lg focus:ring-2 focus:ring-blue-500 focus:outline-none">
                    <button onclick="RAI.bumpLine('${l.product_id}', 1)" type="button"
                        class="w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700">+</button>
                    <button onclick="RAI.removeLine('${l.product_id}')" type="button" title="Take this off the list"
                        class="w-9 h-9 rounded-lg text-gray-300 hover:text-red-600">&times;</button>
                </div>
            </div>`).join('');
    }

    /**
     * Write the whole basket to the ledger in one call.
     *
     * Lines that fail STAY in the basket carrying their reason. Clearing them
     * would lose work somebody physically did, and the usual failure — not
     * enough on hand — is one they can fix and post again.
     */
    RAI.commitBasket = async function () {
        if (!inv.basket.length || inv.busy) return;
        if (!RAI.invActor()) {
            RAI.renderScanResult(`<div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4">
                Enter your name at the top before posting — it is what records who moved the stock.</div>`);
            return;
        }
        inv.busy = true;
        const post = document.getElementById('inv-basket-post');
        if (post) { post.disabled = true; post.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Posting'; }

        const jobRefEl = document.getElementById('inv-job-ref');
        const jobRef = inv.mode === 'consume' && jobRefEl ? jobRefEl.value.trim() : '';
        const sending = inv.basket.slice();

        try {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/movements/bulk`, {
                method: 'POST',
                body: JSON.stringify({
                    location_id: RAI.invLocationId(),
                    actor_label: RAI.invActor(),
                    movements: sending.map(l => ({
                        product_id: l.product_id,
                        movement_type: inv.mode,
                        quantity: l.quantity,
                        scanned_barcode: l.code,
                        job_ref: jobRef
                    }))
                })
            });
            const data = await resp.json();
            const results = data.results || [];

            const failed = [];
            results.forEach((r, i) => {
                const line = sending[i];
                if (!line) return;
                if (r.ok) {
                    inv.session.unshift({ name: line.name, sku: line.sku, mode: inv.mode,
                                          quantity: line.quantity, on_hand: r.on_hand, at: new Date() });
                } else {
                    line.error = r.error || 'Could not be posted.';
                    failed.push(line);
                }
            });
            // A response that carried no per-line results at all is a failure of
            // the whole batch, not a silent success.
            if (!results.length && !resp.ok) {
                sending.forEach(l => { l.error = data.error || 'Could not be posted.'; });
                inv.basket = sending;
            } else {
                inv.basket = failed;
            }

            const posted = results.filter(r => r.ok).length;
            RAI.beep(failed.length > 0);
            RAI.renderScanResult(failed.length
                ? `<div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4">
                     <div class="font-semibold">${posted} posted, ${failed.length} still to sort out.</div>
                     <div class="text-sm mt-1">The ones that failed are still on the list with the reason. Fix the quantity and post again.</div>
                   </div>`
                : `<div class="bg-green-50 border border-green-200 rounded-xl p-4">
                     <div class="font-semibold text-green-900">${posted} item(s) posted.</div>
                   </div>`);

            RAI.renderBasket();
            RAI.renderScanSession();
            RAI.loadInvSummary();
        } catch (err) {
            console.error('[Inventory] post failed:', err);
            RAI.renderScanResult(`<div class="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4">
                Could not reach the server. Nothing was posted — everything is still on the list.</div>`);
        } finally {
            inv.busy = false;
            if (post) { post.disabled = inv.basket.length === 0; post.innerHTML = '<i class="fas fa-check mr-1"></i> Post'; }
            RAI.focusScanInput();
        }
    }

    RAI.renderScanResult = function (html) {
        const el = document.getElementById('inv-scan-result');
        if (el) el.innerHTML = html;
    }

    RAI.renderScanSession = function () {
        const el = document.getElementById('inv-session-list');
        if (!el) return;
        if (!inv.session.length) {
            el.innerHTML = '<div class="px-5 py-8 text-center text-gray-400 text-sm">Nothing posted yet.</div>';
            return;
        }
        const labels = { consume: 'Used', receive: 'Received', count: 'Counted', adjust: 'Adjusted' };
        el.innerHTML = inv.session.map(s => `
            <div class="px-5 py-3 flex items-center justify-between">
                <div>
                    <div class="font-medium text-gray-800">${RAI.esc(s.name)}</div>
                    <div class="text-xs text-gray-500">${RAI.esc(s.sku || '')} ·
                        ${labels[s.mode] || s.mode} ${RAI.formatQty(s.quantity)} ·
                        ${s.at.toLocaleTimeString()}</div>
                </div>
                <div class="text-sm text-gray-600">on hand <span class="font-semibold">${RAI.formatQty(s.on_hand)}</span></div>
            </div>`).join('');
    }

    RAI.clearScanSession = function () {
        inv.session = [];
        RAI.renderScanSession();
        RAI.renderScanResult('');
    }

    // ------------------------------------------------------------
    // SUMMARY + STOCK
    // ------------------------------------------------------------
    RAI.loadInvSummary = async function () {
        if (!inv.enabled || !RAI.invLocationId()) return;
        try {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/summary?location_id=${RAI.invLocationId()}`);
            if (!resp.ok) return;
            const { summary, pending_replenishment } = await resp.json();

            RAI.setText('inv-stat-tracked', summary.tracked);
            RAI.setText('inv-stat-low', summary.low);
            RAI.setText('inv-stat-out', summary.out);
            RAI.setText('inv-stat-value', '$' + Number(summary.stock_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

            // Some items are priced by the branch at purchase and cannot be
            // valued. Saying so turns a number that would quietly be too low
            // into one the reader can trust.
            const valueEl = document.getElementById('inv-stat-value');
            if (valueEl && valueEl.parentElement) {
                let hint = document.getElementById('inv-stat-value-note');
                if (!hint) {
                    hint = document.createElement('div');
                    hint.id = 'inv-stat-value-note';
                    hint.className = 'text-xs text-blue-700 mt-0.5';
                    valueEl.parentElement.appendChild(hint);
                }
                const n = Number(summary.unvalued_lines || 0);
                hint.textContent = n ? `+ ${n} item${n === 1 ? '' : 's'} priced by your branch` : '';
                hint.classList.toggle('hidden', !n);
            }

            const badge = document.getElementById('inv-replen-badge');
            if (badge) {
                badge.textContent = pending_replenishment;
                badge.classList.toggle('hidden', !pending_replenishment);
                badge.classList.toggle('flex', !!pending_replenishment);
            }
            const navBadge = document.getElementById('inv-low-badge');
            if (navBadge) {
                const alerts = (summary.low || 0) + (summary.out || 0);
                navBadge.textContent = alerts;
                navBadge.classList.toggle('hidden', !alerts);
                navBadge.classList.toggle('flex', !!alerts);
            }
        } catch (err) {
            console.error('[Inventory] summary failed:', err);
        }
    }

    let invStockTimer;
    RAI.invStockDebounce = function () {
        clearTimeout(invStockTimer);
        invStockTimer = setTimeout(loadInvStock, 300);
    }

    RAI.loadInvStock = async function () {
        const body = document.getElementById('inv-stock-body');
        if (!body) return;
        body.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-gray-400">Loading…</td></tr>';

        const search = (document.getElementById('inv-stock-search') || {}).value || '';
        const status = (document.getElementById('inv-stock-status') || {}).value || '';

        try {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/levels?location_id=${RAI.invLocationId()}`
                + `&search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}&limit=200`);
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error);

            inv.stock = data.levels || [];
            if (!inv.stock.length) {
                body.innerHTML = `<tr><td colspan="8" class="px-4 py-8 text-center text-gray-400">
                    No items yet. CHC seeds your stock list from the master product file.</td></tr>`;
                return;
            }

            body.innerHTML = inv.stock.map(l => `
                <tr class="hover:bg-gray-50">
                    <td class="px-4 py-3">
                        <div class="font-medium text-gray-800">${RAI.esc(l.product_name)}</div>
                        <div class="text-xs text-gray-400">${RAI.esc(l.brand || '')}</div>
                    </td>
                    <td class="px-4 py-3 text-gray-500 font-mono text-xs">${RAI.esc(l.sku || '')}</td>
                    <td class="px-4 py-3 text-right font-semibold">${RAI.formatQty(l.on_hand)}</td>
                    <td class="px-4 py-3 text-right text-gray-500">${l.min_point ?? '—'}</td>
                    <td class="px-4 py-3 text-right text-gray-500">${l.max_point ?? '—'}</td>
                    <td class="px-4 py-3 text-gray-500">${RAI.esc(l.bin_location || '')}</td>
                    <td class="px-4 py-3">${RAI.statusPill(l.stock_status)}</td>
                    <td class="px-4 py-3 text-right">
                        <button onclick="RAI.editLevel('${l.product_id}')" class="text-blue-600 hover:text-blue-800 text-sm">
                            <i class="fas fa-sliders"></i> Points
                        </button>
                    </td>
                </tr>`).join('');
        } catch (err) {
            body.innerHTML = `<tr><td colspan="8" class="px-4 py-8 text-center text-red-500">
                ${RAI.esc(err.message || 'Failed to load stock levels.')}</td></tr>`;
        }
    }

    RAI.statusPill = function (status) {
        const map = {
            ok:        ['bg-green-100 text-green-700', 'In stock'],
            low:       ['bg-amber-100 text-amber-700', 'Low'],
            out:       ['bg-red-100 text-red-700', 'Out'],
            untracked: ['bg-gray-100 text-gray-500', 'Not tracked']
        };
        const [cls, label] = map[status] || map.untracked;
        return `<span class="px-2 py-1 rounded-full text-xs font-medium ${cls}">${label}</span>`;
    }

    RAI.editLevel = async function (productId) {
        const level = inv.stock.find(l => l.product_id === productId);
        if (!level) return;

        const min = prompt(`Minimum for ${level.product_name}\n\nReorder when on-hand falls to this number. Leave blank for no automatic reorder.`,
            level.min_point ?? '');
        if (min === null) return;
        const max = prompt(`Maximum for ${level.product_name}\n\nWhen it reorders, it orders back up to this number.`,
            level.max_point ?? '');
        if (max === null) return;
        const bin = prompt(`Shelf / bin for ${level.product_name}`, level.bin_location ?? '');
        if (bin === null) return;

        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/levels/${productId}`, {
            method: 'PUT',
            body: JSON.stringify({
                location_id: RAI.invLocationId(),
                min_point: min === '' ? null : Number(min),
                max_point: max === '' ? null : Number(max),
                bin_location: bin
            })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || 'Could not save those reorder points.'); return; }
        RAI.loadInvStock();
        RAI.loadInvSummary();
    }

    // ------------------------------------------------------------
    // REPLENISHMENT QUEUE
    // ------------------------------------------------------------
    RAI.loadReplenishment = async function () {
        const el = document.getElementById('inv-replen-list');
        if (!el) return;
        el.innerHTML = '<div class="bg-white rounded-xl shadow-sm p-8 text-center text-gray-400">Loading…</div>';

        try {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/replenishment?location_id=${RAI.invLocationId()}`);
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error);

            inv.replenishment = data.orders || [];
            if (!inv.replenishment.length) {
                el.innerHTML = `<div class="bg-white rounded-xl shadow-sm p-10 text-center">
                    <i class="fas fa-check-circle text-4xl text-green-400 mb-3"></i>
                    <div class="text-gray-600">Nothing needs reordering right now.</div>
                    <div class="text-sm text-gray-400 mt-1">Items appear here as soon as they hit their shelf minimum.</div>
                </div>`;
                return;
            }

            el.innerHTML = inv.replenishment.map(o => RAI.renderReplenOrder(o)).join('');
        } catch (err) {
            el.innerHTML = `<div class="bg-white rounded-xl shadow-sm p-8 text-center text-red-500">
                ${RAI.esc(err.message || 'Failed to load the reorder queue.')}</div>`;
        }
    }

    RAI.renderReplenOrder = function (o) {
        const lines = (o.replenishment_order_lines || []).map(l => `
            <tr class="hover:bg-gray-50">
                <td class="px-4 py-3">
                    <div class="font-medium text-gray-800">${RAI.esc(l.name || '')}</div>
                    <div class="text-xs text-gray-400 font-mono">${RAI.esc(l.sku || '')}</div>
                </td>
                <td class="px-4 py-3 text-right text-gray-500">${RAI.formatQty(l.on_hand_at_draft)}</td>
                <td class="px-4 py-3 text-right text-gray-500">${l.min_point ?? '—'} / ${l.max_point ?? '—'}</td>
                <td class="px-4 py-3 text-right">
                    <input type="number" min="0" step="1" value="${l.quantity}"
                        onchange="RAI.updateReplenLine('${o.id}', '${l.id}', this.value)"
                        class="w-20 border rounded-lg px-2 py-1 text-right focus:ring-2 focus:ring-blue-500 focus:outline-none">
                </td>
                <td class="px-4 py-3 text-right text-gray-600">$${Number((l.unit_price || 0) * l.quantity).toFixed(2)}</td>
            </tr>`).join('');

        return `
        <div class="bg-white rounded-xl shadow-sm overflow-hidden mb-4">
            <div class="px-5 py-4 border-b flex flex-wrap items-center justify-between gap-3">
                <div>
                    <div class="font-semibold text-gray-800">${o.line_count} item${o.line_count === 1 ? '' : 's'} to reorder</div>
                    <div class="text-sm text-gray-500">
                        Queued ${new Date(o.created_at).toLocaleDateString()} · ${RAI.esc(o.notes || '')}
                    </div>
                </div>
                <div class="text-right">
                    <div class="text-xs uppercase tracking-wide text-gray-400">Estimated</div>
                    <div class="text-xl font-bold text-gray-800">$${Number(o.estimated_total || 0).toFixed(2)}</div>
                </div>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                        <tr>
                            <th class="text-left px-4 py-2">Item</th>
                            <th class="text-right px-4 py-2">On hand</th>
                            <th class="text-right px-4 py-2">Min / Max</th>
                            <th class="text-right px-4 py-2">Order</th>
                            <th class="text-right px-4 py-2">Line total</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y">${lines}</tbody>
                </table>
            </div>
            <div class="px-5 py-4 bg-gray-50 border-t">
                <div class="grid md:grid-cols-3 gap-3 mb-3">
                    <input id="replen-po-${o.id}" type="text" maxlength="60" placeholder="PO number (required)"
                        class="border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none">
                    <input id="replen-name-${o.id}" type="text" maxlength="100" placeholder="Your name (required)"
                        value="${RAI.esc(RAI.invActor())}"
                        class="border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none">
                    <input id="replen-email-${o.id}" type="email" maxlength="160" placeholder="Your email (required)"
                        class="border rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none">
                </div>
                <div class="flex flex-wrap gap-2 justify-end">
                    <button onclick="RAI.rejectReplenishment('${o.id}')"
                        class="px-4 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100">
                        Reject
                    </button>
                    <button onclick="RAI.approveReplenishment('${o.id}')"
                        class="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium">
                        <i class="fas fa-paper-plane mr-1"></i> Approve &amp; send to CHC
                    </button>
                </div>
            </div>
        </div>`;
    }

    RAI.updateReplenLine = async function (orderId, lineId, value) {
        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/replenishment/${orderId}/lines/${lineId}`, {
            method: 'PUT',
            body: JSON.stringify({ quantity: Number(value) })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || 'Could not update that line.'); }
        RAI.loadReplenishment();
    }

    RAI.approveReplenishment = async function (orderId) {
        const po = (document.getElementById(`replen-po-${orderId}`) || {}).value || '';
        const name = (document.getElementById(`replen-name-${orderId}`) || {}).value || '';
        const email = (document.getElementById(`replen-email-${orderId}`) || {}).value || '';

        if (!po.trim()) { alert('A PO number is required.'); return; }
        if (!name.trim()) { alert('Enter your name.'); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { alert('Enter a valid email address.'); return; }
        if (!confirm('Approve this reorder and send it to CHC?')) return;

        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/replenishment/${orderId}/approve`, {
            method: 'POST',
            body: JSON.stringify({
                po_number: po, contact_name: name, contact_email: email, actor_label: RAI.invActor() || name
            })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || 'Could not approve that reorder.'); return; }

        alert(`Order ${data.order.order_number || ''} sent to CHC.`);
        RAI.loadReplenishment();
        RAI.loadInvSummary();
        RAI.ctx.onOrderPlaced();
    }

    RAI.rejectReplenishment = async function (orderId) {
        const reason = prompt('Why is this reorder being rejected?');
        if (reason === null) return;
        if (!reason.trim()) { alert('A reason is required.'); return; }

        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/replenishment/${orderId}/reject`, {
            method: 'POST',
            body: JSON.stringify({ reason, actor_label: RAI.invActor() })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || 'Could not reject that reorder.'); return; }
        RAI.loadReplenishment();
        RAI.loadInvSummary();
    }

    RAI.refreshReplenishment = async function () {
        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/replenishment/refresh`, {
            method: 'POST',
            body: JSON.stringify({ location_id: RAI.invLocationId(), actor_label: RAI.invActor() })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || 'Could not rebuild the queue.'); return; }
        RAI.loadReplenishment();
        RAI.loadInvSummary();
    }

    // ------------------------------------------------------------
    // HISTORY
    // ------------------------------------------------------------
    let invHistory = [];

    RAI.loadInvHistory = async function () {
        const body = document.getElementById('inv-hist-body');
        if (!body) return;
        body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-400">Loading…</td></tr>';

        const type = (document.getElementById('inv-hist-type') || {}).value || '';
        try {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/movements?location_id=${RAI.invLocationId()}`
                + `&movement_type=${encodeURIComponent(type)}&limit=200`);
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error);

            invHistory = data.movements || [];
            if (!invHistory.length) {
                body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-400">No movements recorded yet.</td></tr>';
                return;
            }

            const labels = { consume: 'Used', receive: 'Received', count: 'Counted', adjust: 'Adjusted', seed: 'Opening balance', transfer_in: 'Transferred in', transfer_out: 'Transferred out' };
            body.innerHTML = invHistory.map(m => `
                <tr class="hover:bg-gray-50">
                    <td class="px-4 py-3 text-gray-500 whitespace-nowrap">${new Date(m.created_at).toLocaleString()}</td>
                    <td class="px-4 py-3">
                        <div class="font-medium text-gray-800">${RAI.esc((m.products && m.products.name) || '')}</div>
                        <div class="text-xs text-gray-400 font-mono">${RAI.esc((m.products && m.products.sku) || '')}</div>
                    </td>
                    <td class="px-4 py-3 text-gray-600">${labels[m.movement_type] || m.movement_type}</td>
                    <td class="px-4 py-3 text-right font-semibold ${Number(m.qty_change) < 0 ? 'text-red-600' : 'text-green-600'}">
                        ${Number(m.qty_change) > 0 ? '+' : ''}${RAI.formatQty(m.qty_change)}
                    </td>
                    <td class="px-4 py-3 text-right text-gray-600">${RAI.formatQty(m.on_hand_after)}</td>
                    <td class="px-4 py-3 text-gray-600">${RAI.esc(m.actor_label || '')}</td>
                    <td class="px-4 py-3 text-gray-500">${RAI.esc(m.job_ref ? m.job_ref + ' — ' : '')}${RAI.esc(m.reason || '')}</td>
                </tr>`).join('');
        } catch (err) {
            body.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-red-500">
                ${RAI.esc(err.message || 'Failed to load history.')}</td></tr>`;
        }
    }

    RAI.exportInvHistory = function () {
        if (!invHistory.length) { alert('Nothing to export yet.'); return; }
        const header = ['When', 'Item', 'Part #', 'Movement', 'Change', 'On hand after', 'By', 'Job', 'Reason'];
        const rows = invHistory.map(m => [
            new Date(m.created_at).toLocaleString(),
            (m.products && m.products.name) || '',
            (m.products && m.products.sku) || '',
            m.movement_type,
            m.qty_change,
            m.on_hand_after,
            m.actor_label || '',
            m.job_ref || '',
            m.reason || ''
        ]);
        const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `inventory-history-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    RAI.csvCell = function (v) {
        const s = String(v === null || v === undefined ? '' : v);
        // Neutralise spreadsheet formula injection on export.
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    }

    // ------------------------------------------------------------
    // HOME-SCREEN INSTALL
    //
    // The manifest is generated at runtime because start_url has to point at
    // this company's store (/store/<slug>), which is not known at build time.
    // Everything here fails soft: if the browser will not install, or the
    // service worker is not being served, the console carries on unchanged.
    // ------------------------------------------------------------
    RAI.installPwa = function () {
        try {
            // The manifest is served per company at /store/<slug>/manifest.webmanifest.
            // It used to be built here as a data: URL, which the site's CSP
            // (manifest-src 'self') refuses outright — the page looked fine and
            // the install prompt simply never appeared.
            let link = document.getElementById('inv-manifest');
            if (!link) {
                link = document.createElement('link');
                link.id = 'inv-manifest';
                link.rel = 'manifest';
                document.head.appendChild(link);
            }
            link.href = `/store/${encodeURIComponent(RAI.ctx.slug)}/manifest.webmanifest`;
        } catch (e) { /* installability is a nicety, never a blocker */ }

        if ('serviceWorker' in navigator && window.isSecureContext) {
            navigator.serviceWorker.register('/refinishai-inventory-sw.js')
                .catch(() => { /* not served as a static file; the console still works */ });
        }
    };

    // ------------------------------------------------------------
    // SMALL HELPERS
    // ------------------------------------------------------------
    RAI.formatQty = function (n) {
        const v = Number(n || 0);
        return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
    }

    RAI.setText = function (id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    // ============================================================
    // PHASE 4 — CYCLE COUNTS
    //
    // Counting is a session. Nothing touches stock until the supervisor
    // commits, and the commit measures against on-hand at that moment, so
    // material that legitimately moved mid-count is not silently reversed.
    // ============================================================

    RAI.count = { session: null, lines: [], pendingProduct: null };

    RAI.onCountScopeChange = function () {
        const scope = document.getElementById('inv-count-scope').value;
        const el = document.getElementById('inv-count-scope-value');
        el.classList.toggle('hidden', scope === 'all');
        el.placeholder = scope === 'bin' ? 'Bin / shelf' : 'Category';
    };

    RAI.startCount = async function () {
        if (!RAI.requireActor()) return;
        const scope = document.getElementById('inv-count-scope').value;
        const scopeValue = (document.getElementById('inv-count-scope-value') || {}).value || '';

        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/counts`, {
            method: 'POST',
            body: JSON.stringify({
                location_id: RAI.invLocationId(),
                scope_type: scope,
                scope_value: scopeValue,
                actor_label: RAI.invActor()
            })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || 'Could not start that count.'); return; }

        RAI.count.session = data.session;
        RAI.renderCountShell();
        RAI.loadCount();
    };

    RAI.loadCount = async function () {
        // Resume whatever is open at this location, so a count survives a
        // refresh, a dropped connection, or a shift change.
        if (!RAI.count.session) {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/counts?location_id=${RAI.invLocationId()}&status=open`);
            const data = await resp.json();
            if (!resp.ok) return;
            RAI.count.session = (data.sessions || [])[0] || null;
        }

        if (!RAI.count.session) {
            document.getElementById('inv-count-empty').classList.remove('hidden');
            document.getElementById('inv-count-active').classList.add('hidden');
            return;
        }

        RAI.renderCountShell();

        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/counts/${RAI.count.session.id}`);
        const data = await resp.json();
        if (!resp.ok) return;

        RAI.count.session = data.session;
        RAI.count.lines = data.lines || [];
        RAI.setText('inv-count-lines', data.summary.counted);
        RAI.setText('inv-count-variances', data.summary.variances);
        RAI.renderCountLines();
    };

    RAI.renderCountShell = function () {
        document.getElementById('inv-count-empty').classList.add('hidden');
        document.getElementById('inv-count-active').classList.remove('hidden');
        const s = RAI.count.session;
        RAI.setText('inv-count-name', s.name || 'Count');
        RAI.setText('inv-count-meta',
            `Started by ${s.opened_by || '—'} · ${new Date(s.created_at).toLocaleString()}`);
    };

    RAI.renderCountLines = function () {
        const body = document.getElementById('inv-count-body');
        if (!body) return;
        if (!RAI.count.lines.length) {
            body.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-gray-400">Scan an item to start counting.</td></tr>';
            return;
        }
        body.innerHTML = RAI.count.lines.map(l => {
            const v = Number(l.live_variance);
            const cls = v === 0 ? 'text-gray-400' : (v < 0 ? 'text-red-600' : 'text-green-600');
            return `
            <tr class="hover:bg-gray-50">
                <td class="px-4 py-3">
                    <div class="font-medium text-gray-800">${RAI.esc(l.name || '')}</div>
                    <div class="text-xs text-gray-400 font-mono">${RAI.esc(l.sku || '')}</div>
                </td>
                <td class="px-4 py-3 text-right text-gray-500">${RAI.formatQty(l.current_on_hand)}</td>
                <td class="px-4 py-3 text-right font-semibold">${RAI.formatQty(l.counted_qty)}</td>
                <td class="px-4 py-3 text-right font-semibold ${cls}">${v > 0 ? '+' : ''}${RAI.formatQty(v)}</td>
                <td class="px-4 py-3 text-gray-500">${RAI.esc(l.counted_by || '')}</td>
                <td class="px-4 py-3 text-right">
                    <button onclick="RAI.removeCountLine('${l.id}')" class="text-gray-400 hover:text-red-600" title="Remove">
                        <i class="fas fa-xmark"></i>
                    </button>
                </td>
            </tr>`;
        }).join('');
    };

    RAI.countScan = async function (rawCode) {
        const code = String(rawCode || '').trim();
        const input = document.getElementById('inv-count-scan');
        if (input) input.value = '';
        if (!code || !RAI.count.session) return;
        if (!RAI.requireActor()) return;

        const qtyEl = document.getElementById('inv-count-qty');
        const counted = parseFloat(qtyEl ? qtyEl.value : '');
        if (!Number.isFinite(counted) || counted < 0) {
            RAI.countFeedback('Enter the counted quantity first, then scan.', 'amber');
            if (qtyEl) qtyEl.focus();
            return;
        }

        const lookup = await RAI.api(
            `/store/${RAI.ctx.slug}/inventory/lookup?code=${encodeURIComponent(code)}&location_id=${RAI.invLocationId()}`);
        const found = await lookup.json();

        if (lookup.status === 300 && found.ambiguous) {
            RAI.countFeedback('That barcode is on more than one item — use the Scan tab to pick one.', 'amber');
            return;
        }
        if (!lookup.ok) {
            RAI.beep(true);
            RAI.countFeedback(found.error || 'No product matches that code.', 'red');
            return;
        }

        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/counts/${RAI.count.session.id}/lines`, {
            method: 'POST',
            body: JSON.stringify({
                product_id: found.product.id,
                counted_qty: counted,
                scanned_barcode: code,
                actor_label: RAI.invActor()
            })
        });
        const data = await resp.json();
        if (!resp.ok) { RAI.beep(true); RAI.countFeedback(data.error || 'Could not record that count.', 'red'); return; }

        RAI.beep();
        const v = Number(data.variance);
        RAI.countFeedback(
            v === 0
                ? `${found.product.name} — matches the system (${RAI.formatQty(counted)}).`
                : `${found.product.name} — counted ${RAI.formatQty(counted)}, system had ${RAI.formatQty(data.expected_qty)} (${v > 0 ? '+' : ''}${RAI.formatQty(v)}).`,
            v === 0 ? 'green' : 'amber');

        if (qtyEl) qtyEl.value = '';
        RAI.loadCount();
    };

    RAI.countFeedback = function (message, tone) {
        const el = document.getElementById('inv-count-feedback');
        if (!el) return;
        const map = {
            green: 'bg-green-50 border-green-200 text-green-800',
            amber: 'bg-amber-50 border-amber-200 text-amber-800',
            red:   'bg-red-50 border-red-200 text-red-700'
        };
        el.innerHTML = `<div class="border rounded-lg px-4 py-3 text-sm ${map[tone] || map.amber}">${RAI.esc(message)}</div>`;
    };

    RAI.removeCountLine = async function (lineId) {
        if (!RAI.count.session) return;
        const resp = await RAI.api(
            `/store/${RAI.ctx.slug}/inventory/counts/${RAI.count.session.id}/lines/${lineId}`, { method: 'DELETE' });
        if (!resp.ok) { const d = await resp.json(); alert(d.error || 'Could not remove that line.'); return; }
        RAI.loadCount();
    };

    RAI.commitCount = async function () {
        if (!RAI.count.session || !RAI.requireActor()) return;
        const variances = RAI.count.lines.filter(l => Number(l.live_variance) !== 0).length;
        const msg = variances
            ? `Commit this count? ${variances} item${variances === 1 ? '' : 's'} will be adjusted.`
            : 'Commit this count? Everything matches, so no stock will change.';
        if (!confirm(msg)) return;

        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/counts/${RAI.count.session.id}/commit`, {
            method: 'POST',
            body: JSON.stringify({ actor_label: RAI.invActor() })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || 'Could not commit that count.'); return; }

        alert(data.message);
        RAI.count.session = null;
        RAI.count.lines = [];
        RAI.loadCount();
        RAI.loadInvSummary();
    };

    RAI.cancelCount = async function () {
        if (!RAI.count.session || !RAI.requireActor()) return;
        const reason = prompt('Why is this count being cancelled?');
        if (reason === null) return;
        if (!reason.trim()) { alert('A reason is required.'); return; }

        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/counts/${RAI.count.session.id}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ actor_label: RAI.invActor(), reason })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error || 'Could not cancel that count.'); return; }

        RAI.count.session = null;
        RAI.count.lines = [];
        RAI.loadCount();
    };

    // ============================================================
    // PHASE 4 — TRANSFERS
    // ============================================================

    RAI.transfer = { locations: [], product: null };

    RAI.loadTransfers = async function () {
        if (!RAI.transfer.locations.length) {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/locations`);
            if (resp.ok) {
                const data = await resp.json();
                RAI.transfer.locations = data.locations || [];
            }
            const here = RAI.invLocationId();
            for (const id of ['inv-tr-from', 'inv-tr-to']) {
                const sel = document.getElementById(id);
                if (!sel) continue;
                sel.innerHTML = RAI.transfer.locations.map(l =>
                    `<option value="${l.id}"${id === 'inv-tr-from' && l.id === here ? ' selected' : ''}>${RAI.esc(l.name)}</option>`
                ).join('');
            }
        }

        const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/transfers?location_id=${RAI.invLocationId()}&limit=50`);
        const body = document.getElementById('inv-tr-body');
        if (!body) return;
        if (!resp.ok) { body.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-red-500">Failed to load transfers.</td></tr>'; return; }

        const { transfers } = await resp.json();
        if (!transfers.length) {
            body.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-gray-400">No transfers yet.</td></tr>';
            return;
        }
        body.innerHTML = transfers.map(t => `
            <tr class="hover:bg-gray-50">
                <td class="px-4 py-3 text-gray-500 whitespace-nowrap">${new Date(t.created_at).toLocaleString()}</td>
                <td class="px-4 py-3">
                    <div class="font-medium text-gray-800">${RAI.esc((t.products && t.products.name) || '')}</div>
                    <div class="text-xs text-gray-400 font-mono">${RAI.esc((t.products && t.products.sku) || '')}</div>
                </td>
                <td class="px-4 py-3 text-right font-semibold">${RAI.formatQty(t.quantity)}</td>
                <td class="px-4 py-3 text-gray-600">${RAI.esc(t.from_location_name || '')}</td>
                <td class="px-4 py-3 text-gray-600">${RAI.esc(t.to_location_name || '')}</td>
                <td class="px-4 py-3 text-gray-500">${RAI.esc(t.actor_label || '')}</td>
            </tr>`).join('');
    };

    // ------------------------------------------------------------
    // THE TRANSFER BASKET
    //
    // Same shape as the scan basket above: a scan stages a line, the same
    // barcode again adds to it, the quantity can be typed directly, and one
    // Post writes the whole list. Kept as its own basket rather than folded
    // into inv.basket because a transfer carries two locations, not one, and
    // switching either one mid-basket invalidates every on-hand number
    // already staged — a distinction the single-location modes don't have.
    // ------------------------------------------------------------

    RAI.transferLocations = function () {
        return {
            from: (document.getElementById('inv-tr-from') || {}).value || '',
            to: (document.getElementById('inv-tr-to') || {}).value || ''
        };
    };

    /** From or To changed. Staged on-hand figures were read at the old From, so they cannot follow. */
    RAI.onTransferLocationChange = function () {
        if (inv.trBasket.length && !confirm('Changing the location clears the list you have scanned so far. Continue?')) {
            RAI.loadTransfers();
            return;
        }
        inv.trBasket = [];
        inv.trActiveProductId = null;
        RAI.renderTransferBasket();
        RAI.transferResult('');
        RAI.loadTransfers();
    };

    RAI.transferScan = async function (rawCode) {
        const code = String(rawCode || '').trim();
        const input = document.getElementById('inv-tr-scan');
        if (input) input.value = '';
        if (!code) return;
        if (!RAI.requireActor('inv-tr-result')) return;

        const { from, to } = RAI.transferLocations();
        if (!from || !to) { RAI.transferResult('Choose both a source and a destination first.', 'amber'); return; }
        if (from === to) { RAI.transferResult('Source and destination must be different.', 'amber'); return; }

        if (inv.busy) return;
        inv.busy = true;
        try {
            const lookup = await RAI.api(
                `/store/${RAI.ctx.slug}/inventory/lookup?code=${encodeURIComponent(code)}&location_id=${from}`);
            const found = await lookup.json();
            if (lookup.status === 300) { RAI.beep(true); RAI.transferResult('That barcode is on more than one item — use the Scan tab to identify it, then search here by part number.', 'amber'); return; }
            if (!lookup.ok) { RAI.beep(true); RAI.transferResult(found.error || 'No product matches that code.', 'red'); return; }

            RAI.addToTransferBasket(found.product, code);
        } catch (err) {
            console.error('[Inventory] transfer scan failed:', err);
            RAI.transferResult('Could not reach the server. Scan again.', 'red');
        } finally {
            inv.busy = false;
            if (input) input.focus();
        }
    };

    RAI.addToTransferBasket = function (product, code) {
        const existing = inv.trBasket.find(l => l.product_id === product.id);
        if (existing) {
            existing.quantity = round4(existing.quantity + 1);
            existing.error = null;
        } else {
            inv.trBasket.unshift({
                product_id: product.id,
                name: product.name,
                sku: product.sku,
                code: code,
                on_hand: product.level ? Number(product.level.on_hand) : null,
                quantity: 1,
                error: null
            });
        }
        inv.trBasket.sort((a, b) => (a.product_id === product.id ? -1 : b.product_id === product.id ? 1 : 0));
        inv.trActiveProductId = product.id;
        RAI.beep();
        RAI.transferResult('');
        RAI.renderTransferBasket();
    };

    RAI.setTransferLineQty = function (productId, value) {
        const line = inv.trBasket.find(l => l.product_id === productId);
        if (!line) return;
        const n = parseFloat(value);
        if (!Number.isFinite(n) || n < 0) return;
        if (n === 0) { RAI.removeTransferLine(productId); return; }
        line.quantity = round4(n);
        line.error = null;
        RAI.renderTransferBasket();
    };

    RAI.bumpTransferLine = function (productId, delta) {
        const line = inv.trBasket.find(l => l.product_id === productId);
        if (!line) return;
        const next = round4(line.quantity + delta);
        if (next <= 0) { RAI.removeTransferLine(productId); return; }
        line.quantity = next;
        line.error = null;
        RAI.renderTransferBasket();
    };

    RAI.removeTransferLine = function (productId) {
        inv.trBasket = inv.trBasket.filter(l => l.product_id !== productId);
        if (inv.trActiveProductId === productId) inv.trActiveProductId = null;
        RAI.renderTransferBasket();
    };

    RAI.clearTransferBasket = function () {
        if (inv.trBasket.length > 1 && !confirm('Clear everything scanned but not yet posted?')) return;
        inv.trBasket = [];
        inv.trActiveProductId = null;
        RAI.renderTransferBasket();
        const input = document.getElementById('inv-tr-scan');
        if (input) input.focus();
    };

    RAI.renderTransferBasket = function () {
        const el = document.getElementById('inv-tr-basket-list');
        const count = document.getElementById('inv-tr-basket-count');
        const post = document.getElementById('inv-tr-basket-post');
        if (!el) return;

        const units = inv.trBasket.reduce((s, l) => s + Number(l.quantity || 0), 0);
        if (count) count.textContent = inv.trBasket.length
            ? `— ${inv.trBasket.length} item(s), ${RAI.formatQty(units)} unit(s)` : '';
        if (post) post.disabled = inv.trBasket.length === 0;

        if (!inv.trBasket.length) {
            el.innerHTML = '<div class="px-5 py-8 text-center text-gray-400 text-sm">Nothing scanned yet.</div>';
            return;
        }

        el.innerHTML = inv.trBasket.map(l => `
            <div class="px-4 py-3 flex items-center gap-3 ${l.product_id === inv.trActiveProductId ? 'bg-blue-50' : ''}">
                <div class="flex-1 min-w-0">
                    <div class="font-medium text-gray-800 truncate">${RAI.esc(l.name)}</div>
                    <div class="text-xs text-gray-500">
                        ${RAI.esc(l.sku || '')}
                        ${l.on_hand !== null && l.on_hand !== undefined ? ` · on hand ${RAI.formatQty(l.on_hand)} at source` : ''}
                    </div>
                    ${l.error ? `<div class="text-xs text-red-600 mt-1">${RAI.esc(l.error)}</div>` : ''}
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button onclick="RAI.bumpTransferLine('${l.product_id}', -1)" type="button"
                        class="w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700">&minus;</button>
                    <input type="number" step="0.5" min="0" value="${l.quantity}"
                        onchange="RAI.setTransferLineQty('${l.product_id}', this.value)"
                        onfocus="this.select()"
                        aria-label="Move how many of ${RAI.esc(l.name)}"
                        class="w-20 border rounded-lg px-2 py-1.5 text-center text-lg focus:ring-2 focus:ring-blue-500 focus:outline-none">
                    <button onclick="RAI.bumpTransferLine('${l.product_id}', 1)" type="button"
                        class="w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700">+</button>
                    <button onclick="RAI.removeTransferLine('${l.product_id}')" type="button" title="Take this off the list"
                        class="w-9 h-9 rounded-lg text-gray-300 hover:text-red-600">&times;</button>
                </div>
            </div>`).join('');
    };

    /**
     * Write the whole staged list as one batch. Lines that fail (almost
     * always a shortfall at the source) stay on the list carrying their
     * reason, same discipline as commitBasket.
     */
    RAI.commitTransferBasket = async function () {
        if (!inv.trBasket.length || inv.busy) return;
        if (!RAI.requireActor('inv-tr-result')) return;

        const { from, to } = RAI.transferLocations();
        if (!from || !to) { RAI.transferResult('Choose both a source and a destination first.', 'amber'); return; }
        if (from === to) { RAI.transferResult('Source and destination must be different.', 'amber'); return; }

        inv.busy = true;
        const post = document.getElementById('inv-tr-basket-post');
        if (post) { post.disabled = true; post.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Posting'; }

        const reason = (document.getElementById('inv-tr-reason') || {}).value || '';
        const sending = inv.trBasket.slice();

        try {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/transfers/bulk`, {
                method: 'POST',
                body: JSON.stringify({
                    from_location_id: from,
                    to_location_id: to,
                    actor_label: RAI.invActor(),
                    reason,
                    transfers: sending.map(l => ({
                        product_id: l.product_id,
                        quantity: l.quantity,
                        scanned_barcode: l.code
                    }))
                })
            });
            const data = await resp.json();
            const results = data.results || [];

            const failed = [];
            results.forEach((r, i) => {
                const line = sending[i];
                if (!line) return;
                if (!r.ok) { line.error = r.error || 'Could not be posted.'; failed.push(line); }
            });
            if (!results.length && !resp.ok) {
                sending.forEach(l => { l.error = data.error || 'Could not be posted.'; });
                inv.trBasket = sending;
            } else {
                inv.trBasket = failed;
            }

            const posted = results.filter(r => r.ok).length;
            RAI.beep(failed.length > 0);
            RAI.transferResult(
                failed.length
                    ? `${posted} moved, ${failed.length} still to sort out — fix the quantity and post again.`
                    : `${posted} item(s) moved.`,
                failed.length ? 'amber' : 'green');

            RAI.renderTransferBasket();
            RAI.loadTransfers();
            RAI.loadInvSummary();
        } catch (err) {
            console.error('[Inventory] transfer post failed:', err);
            RAI.transferResult('Could not reach the server. Nothing was moved — everything is still on the list.', 'red');
        } finally {
            inv.busy = false;
            if (post) { post.disabled = inv.trBasket.length === 0; post.innerHTML = '<i class="fas fa-check mr-1"></i> Post'; }
            const input = document.getElementById('inv-tr-scan');
            if (input) input.focus();
        }
    };

    RAI.transferResult = function (message, tone) {
        const el = document.getElementById('inv-tr-result');
        if (!el) return;
        if (!message) { el.innerHTML = ''; return; }
        const map = {
            green: 'bg-green-50 border-green-200 text-green-800',
            amber: 'bg-amber-50 border-amber-200 text-amber-800',
            red:   'bg-red-50 border-red-200 text-red-700'
        };
        el.innerHTML = `<div class="border rounded-lg px-4 py-3 text-sm ${map[tone] || map.amber}">${RAI.esc(message)}</div>`;
    };

    // ============================================================
    // PHASE 5 — CONSUMPTION ANALYTICS
    // ============================================================

    RAI.analyticsQuery = function () {
        const period = (document.getElementById('inv-an-period') || {}).value || 'last_30';
        const allShops = (document.getElementById('inv-an-allshops') || {}).checked;
        const loc = allShops ? '' : `&location_id=${RAI.invLocationId()}`;
        return `period=${encodeURIComponent(period)}${loc}`;
    };

    RAI.loadAnalytics = async function () {
        const q = RAI.analyticsQuery();
        try {
            const [summaryResp, productResp, jobResp] = await Promise.all([
                RAI.api(`/store/${RAI.ctx.slug}/inventory/analytics/summary?${q}`),
                RAI.api(`/store/${RAI.ctx.slug}/inventory/analytics/by-product?${q}&limit=15`),
                RAI.api(`/store/${RAI.ctx.slug}/inventory/analytics/by-job?${q}&limit=15`)
            ]);

            if (summaryResp.ok) {
                const s = await summaryResp.json();
                RAI.setText('inv-an-label', s.period.label);
                RAI.setText('inv-an-value', RAI.money(s.totals.value_used));
                RAI.setText('inv-an-units', RAI.formatQty(s.totals.units_used));
                RAI.renderSparkChart(s.series);
            }

            if (productResp.ok) {
                const p = await productResp.json();
                const body = document.getElementById('inv-an-products');
                body.innerHTML = p.items.length
                    ? p.items.map(i => `
                        <tr class="hover:bg-gray-50">
                            <td class="px-4 py-2">
                                <div class="font-medium text-gray-800">${RAI.esc(i.product_name)}</div>
                                <div class="text-xs text-gray-400 font-mono">${RAI.esc(i.sku || '')}</div>
                            </td>
                            <td class="px-4 py-2 text-right text-gray-600">${RAI.formatQty(i.units_used)}</td>
                            <td class="px-4 py-2 text-right font-semibold">${RAI.money(i.value_used)}</td>
                        </tr>`).join('')
                    : '<tr><td colspan="3" class="px-4 py-8 text-center text-gray-400">Nothing consumed in this period.</td></tr>';
            }

            if (jobResp.ok) {
                const j = await jobResp.json();
                RAI.setText('inv-an-jobs', j.totals.jobs);
                RAI.setText('inv-an-perjob', RAI.money(j.totals.avg_value_per_job));

                const perJobEl = document.getElementById('inv-an-perjob');
                if (perJobEl && perJobEl.parentElement) {
                    let hint = document.getElementById('inv-an-perjob-note');
                    if (!hint) {
                        hint = document.createElement('div');
                        hint.id = 'inv-an-perjob-note';
                        hint.className = 'text-xs text-blue-700 mt-0.5';
                        perJobEl.parentElement.appendChild(hint);
                    }
                    const n = Number(j.totals.jobs_with_unpriced_items || 0);
                    hint.textContent = n ? `${n} job${n === 1 ? '' : 's'} include items your branch prices` : '';
                    hint.classList.toggle('hidden', !n);
                }
                const body = document.getElementById('inv-an-jobs-body');
                body.innerHTML = j.jobs.length
                    ? j.jobs.map(job => `
                        <tr class="hover:bg-gray-50">
                            <td class="px-4 py-2 font-medium text-gray-800">${RAI.esc(job.job_ref)}</td>
                            <td class="px-4 py-2 text-right text-gray-600">${job.distinct_items}</td>
                            <td class="px-4 py-2 text-right font-semibold">${RAI.money(job.value_used)}</td>
                            <td class="px-4 py-2 text-gray-500">${new Date(job.last_used_at).toLocaleDateString()}</td>
                        </tr>`).join('')
                    : `<tr><td colspan="4" class="px-4 py-8 text-center text-gray-400">
                         No job references recorded yet — enter a job or RO number when using stock and it will appear here.
                       </td></tr>`;
            }
        } catch (err) {
            console.error('[refinishAI Inventory] analytics failed:', err);
        }
    };

    /**
     * A small inline bar chart, drawn as SVG. No charting library: this is one
     * series of one number, and a dependency would cost more than it earns.
     */
    RAI.renderSparkChart = function (series) {
        const host = document.getElementById('inv-an-chart');
        if (!host) return;
        if (!series || !series.length) {
            host.innerHTML = '<div class="text-center text-gray-400 py-10 text-sm">No consumption recorded in this period.</div>';
            return;
        }

        const w = Math.max(600, series.length * 18);
        const h = 160, pad = { t: 10, r: 8, b: 26, l: 52 };
        const max = Math.max(...series.map(d => d.value_used), 1);
        const innerW = w - pad.l - pad.r;
        const innerH = h - pad.t - pad.b;
        const barW = Math.max(3, Math.min(28, innerW / series.length - 3));

        const bars = series.map((d, i) => {
            const x = pad.l + (i + 0.5) * (innerW / series.length) - barW / 2;
            const barH = Math.max(1, (d.value_used / max) * innerH);
            const y = pad.t + innerH - barH;
            return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"
                        rx="2" fill="#1e40af" opacity="0.85">
                        <title>${d.day}: ${RAI.money(d.value_used)} (${RAI.formatQty(d.units_used)} units)</title>
                    </rect>`;
        }).join('');

        const ticks = [0, 0.5, 1].map(f => {
            const y = pad.t + innerH - f * innerH;
            return `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>
                    <text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#9ca3af">${RAI.money(max * f)}</text>`;
        }).join('');

        const first = series[0].day, last = series[series.length - 1].day;
        const labels = `<text x="${pad.l}" y="${h - 8}" font-size="10" fill="#9ca3af">${first}</text>
                        <text x="${w - pad.r}" y="${h - 8}" text-anchor="end" font-size="10" fill="#9ca3af">${last}</text>`;

        host.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
                               aria-label="Daily materials consumption">${ticks}${bars}${labels}</svg>`;
    };

    RAI.exportAnalytics = function (group) {
        const url = `${RAI.ctx.apiBase}/store/${RAI.ctx.slug}/inventory/analytics/export?${RAI.analyticsQuery()}&group=${group}`;
        // The endpoint is behind the bearer token, so fetch it and hand the
        // browser a blob rather than navigating to a URL it cannot authorise.
        RAI.api(url.replace(RAI.ctx.apiBase, ''))
            .then(r => r.ok ? r.blob() : Promise.reject(new Error('export failed')))
            .then(blob => {
                const href = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = href;
                a.download = `refinishai-consumption-${group}-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(href);
            })
            .catch(() => alert('Could not export that data.'));
    };

    // ============================================================
    // KITS — a job's materials, expensed together
    //
    // The shape of this view is deliberate: a kit is never applied from the
    // picker. Choosing one opens a priced list of exactly what would leave the
    // shelf, and the commit button stays disabled until there is a repair order
    // to book it against and nothing is blocking. The technician sees the whole
    // consequence before any of it happens.
    // ============================================================

    RAI.kits = { list: [], current: null, preview: null, skipped: new Set(), overrides: {} };

    RAI.loadKits = async function () {
        const host = document.getElementById('inv-kit-list');
        if (!host) return;
        host.innerHTML = '<p class="text-sm text-gray-400 col-span-full">Loading kits…</p>';

        try {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/kits`);
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Failed to load kits.');

            RAI.kits.list = data.kits || [];

            if (RAI.kits.list.length === 0) {
                host.innerHTML =
                    '<div class="col-span-full bg-white rounded-xl shadow-sm p-6 text-center">' +
                    '<p class="text-gray-600">No kits are set up for your shop yet.</p>' +
                    '<p class="text-sm text-gray-400 mt-1">CHC can build these from the jobs you do most.</p>' +
                    '</div>';
                RAI.loadKitHistory();
                return;
            }

            host.innerHTML = RAI.kits.list.map(kit => {
                // A kit that is not ready is shown, not hidden. Hiding it would
                // make the shop think CHC never set it up; saying so plainly
                // tells them what to ask for.
                const ready = kit.ready;
                return `
                <button onclick="RAI.openKit('${kit.id}')" ${ready ? '' : 'disabled'}
                    class="text-left bg-white rounded-xl shadow-sm p-4 border-2 transition
                           ${ready ? 'border-transparent hover:border-blue-400 cursor-pointer'
                                   : 'border-transparent opacity-60 cursor-not-allowed'}">
                    <div class="flex items-start justify-between gap-2">
                        <h4 class="font-semibold text-gray-800">${RAI.esc(kit.name)}</h4>
                        ${ready
                            ? `<span class="text-xs text-gray-400 whitespace-nowrap">${kit.line_count} item${kit.line_count === 1 ? '' : 's'}</span>`
                            : '<span class="text-xs bg-amber-100 text-amber-800 rounded-full px-2 py-0.5 whitespace-nowrap">Not set up</span>'}
                    </div>
                    ${kit.description ? `<p class="text-sm text-gray-500 mt-1">${RAI.esc(kit.description)}</p>` : ''}
                    <p class="text-sm mt-2 ${ready ? 'text-gray-600' : 'text-amber-700'}">
                        ${ready
                            ? `About ${RAI.money(kit.estimated_cost)} of materials`
                            : `${kit.unresolved_count} item${kit.unresolved_count === 1 ? '' : 's'} not matched to your catalogue — ask CHC to finish this one`}
                    </p>
                </button>`;
            }).join('');

            RAI.loadKitHistory();
        } catch (err) {
            host.innerHTML = `<p class="text-sm text-red-600 col-span-full">${RAI.esc(err.message)}</p>`;
        }
    };

    RAI.openKit = function (kitId) {
        const kit = RAI.kits.list.find(k => k.id === kitId);
        if (!kit || !kit.ready) return;

        RAI.kits.current = kit;
        RAI.kits.skipped = new Set();
        RAI.kits.overrides = {};

        RAI.setText('inv-kit-title', kit.name);
        RAI.setText('inv-kit-sub', kit.description || '');
        const panel = document.getElementById('inv-kit-panel');
        if (panel) panel.classList.remove('hidden');

        const mult = document.getElementById('inv-kit-mult');
        if (mult) mult.value = '1';
        RAI.clearKitResult();

        RAI.loadKitPreview();
        panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    RAI.closeKit = function () {
        RAI.kits.current = null;
        RAI.kits.preview = null;
        document.getElementById('inv-kit-panel')?.classList.add('hidden');
    };

    RAI.bumpKitMultiplier = function (step) {
        const el = document.getElementById('inv-kit-mult');
        if (!el) return;
        const next = Math.round(Math.min(100, Math.max(0.25, (Number(el.value) || 1) + step * 0.25)) * 100) / 100;
        el.value = String(next);
        RAI.loadKitPreview();
    };

    RAI.loadKitPreview = async function () {
        const kit = RAI.kits.current;
        if (!kit) return;

        const body = document.getElementById('inv-kit-lines');
        if (body) body.innerHTML = '<tr><td colspan="5" class="py-3 text-sm text-gray-400">Checking the shelf…</td></tr>';

        const multiplier = Number(document.getElementById('inv-kit-mult')?.value) || 1;

        try {
            const resp = await RAI.api(
                `/store/${RAI.ctx.slug}/inventory/kits/${kit.id}/preview` +
                `?location_id=${RAI.invLocationId()}&multiplier=${encodeURIComponent(multiplier)}`
            );
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Failed to preview that kit.');

            RAI.kits.preview = data;
            RAI.renderKitPreview();
        } catch (err) {
            if (body) body.innerHTML = `<tr><td colspan="5" class="py-3 text-sm text-red-600">${RAI.esc(err.message)}</td></tr>`;
            RAI.updateKitButton();
        }
    };

    RAI.renderKitPreview = function () {
        const data = RAI.kits.preview;
        const body = document.getElementById('inv-kit-lines');
        if (!data || !body) return;

        body.innerHTML = (data.lines || []).map(line => {
            const skipped = RAI.kits.skipped.has(line.kit_item_id);
            const override = RAI.kits.overrides[line.kit_item_id];
            const qty = override !== undefined ? override : line.quantity;

            // Short and skipped are different colours because they are different
            // problems: one blocks, the other is a choice the operator made.
            const rowClass = skipped ? 'opacity-40'
                : line.blocking ? 'bg-red-50'
                : '';

            return `
            <tr class="border-b last:border-0 ${rowClass}">
                <td class="py-2 pr-3">
                    <span class="font-medium text-gray-800">${RAI.esc(line.name)}</span>
                    <span class="block text-xs text-gray-400">${RAI.esc(line.sku || '')}</span>
                    ${line.category_blocked
                        ? '<span class="block text-xs text-red-600">This location does not stock that category</span>' : ''}
                </td>
                <td class="py-2 pr-3 text-right">
                    <input type="number" min="0" step="0.01" value="${qty}"
                        ${skipped ? 'disabled' : ''}
                        onchange="RAI.setKitQty('${line.kit_item_id}', this.value)"
                        class="border rounded px-2 py-1 w-24 text-right focus:ring-2 focus:ring-blue-500 focus:outline-none">
                    <span class="block text-xs text-gray-400">${RAI.esc(line.unit || 'each')}</span>
                </td>
                <td class="py-2 pr-3 text-right ${line.would_go_negative && !skipped ? 'text-red-600 font-semibold' : 'text-gray-600'}">
                    ${RAI.formatQty(line.on_hand)}
                </td>
                <td class="py-2 pr-3 text-right text-gray-700">${RAI.money(qty * line.unit_price)}</td>
                <td class="py-2 pr-3 text-center">
                    <input type="checkbox" data-line="${line.kit_item_id}" ${skipped ? '' : 'checked'}
                        onchange="RAI.toggleKitLine('${line.kit_item_id}')"
                        class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500">
                </td>
            </tr>`;
        }).join('');

        // Excluded lines are shown, quietly. A technician who knows the job
        // should be able to see that a step was deliberately left out rather
        // than wonder whether the kit is wrong.
        if ((data.excluded || []).length) {
            body.innerHTML += `
            <tr>
                <td colspan="5" class="py-2 text-xs text-gray-400">
                    Not used by your shop: ${data.excluded.map(e => RAI.esc(e.sku)).join(', ')}
                </td>
            </tr>`;
        }

        const warning = document.getElementById('inv-kit-warning');
        if (warning) {
            if (data.blocked_reason) {
                warning.textContent = data.blocked_reason;
                warning.classList.remove('hidden');
            } else {
                warning.classList.add('hidden');
            }
        }

        RAI.updateKitTotal();
        RAI.updateKitButton();
    };

    RAI.setKitQty = function (kitItemId, value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return;
        RAI.kits.overrides[kitItemId] = n;
        RAI.updateKitTotal();
        RAI.updateKitButton();
    };

    /**
     * Ticking a line in or out updates that row in place rather than rebuilding
     * the table. Rebuilding would destroy the checkbox the operator just
     * touched — taking the focus with it, which on a phone closes the keyboard
     * mid-edit and on a desktop loses the tab position.
     */
    RAI.toggleKitLine = function (kitItemId) {
        const skipped = RAI.kits.skipped.has(kitItemId);
        if (skipped) RAI.kits.skipped.delete(kitItemId);
        else RAI.kits.skipped.add(kitItemId);

        const nowSkipped = !skipped;
        const line = (RAI.kits.preview?.lines || []).find(l => l.kit_item_id === kitItemId);
        const box = document.querySelector(`#inv-kit-lines input[type="checkbox"][data-line="${kitItemId}"]`);
        const row = box ? box.closest('tr') : null;

        if (row) {
            row.classList.toggle('opacity-40', nowSkipped);
            row.classList.toggle('bg-red-50', !nowSkipped && !!line?.blocking);
            const qtyInput = row.querySelector('input[type="number"]');
            if (qtyInput) qtyInput.disabled = nowSkipped;
        }

        RAI.updateKitTotal();
        RAI.updateKitButton();
    };

    /** Lines as they will actually be posted, after skips and edits. */
    RAI.kitPlannedLines = function () {
        const data = RAI.kits.preview;
        if (!data) return [];
        return (data.lines || [])
            .filter(l => !RAI.kits.skipped.has(l.kit_item_id))
            .map(l => ({
                ...l,
                quantity: RAI.kits.overrides[l.kit_item_id] !== undefined
                    ? RAI.kits.overrides[l.kit_item_id]
                    : l.quantity
            }));
    };

    RAI.updateKitTotal = function () {
        const total = RAI.kitPlannedLines().reduce((s, l) => s + l.quantity * l.unit_price, 0);
        RAI.setText('inv-kit-total', RAI.money(total));
    };

    RAI.updateKitButton = function () {
        const btn = document.getElementById('inv-kit-commit');
        if (!btn) return;

        const job = (document.getElementById('inv-kit-job')?.value || '').trim();
        const planned = RAI.kitPlannedLines();

        // A line the operator skipped cannot block: they have already decided
        // not to take it. Only the lines actually being posted matter.
        const blocked = planned.some(l => l.blocking) || planned.some(l => !(l.quantity > 0));

        btn.disabled = !RAI.kits.preview || !job || planned.length === 0 || blocked;
    };

    RAI.consumeKit = async function () {
        const kit = RAI.kits.current;
        if (!kit || inv.busy) return;
        if (!RAI.requireActor()) return;

        const job = (document.getElementById('inv-kit-job')?.value || '').trim();
        if (!job) return;

        const planned = RAI.kitPlannedLines();
        if (planned.length === 0) return;

        const btn = document.getElementById('inv-kit-commit');
        inv.busy = true;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Expensing…'; }

        try {
            const resp = await RAI.api(`/store/${RAI.ctx.slug}/inventory/kits/${kit.id}/consume`, {
                method: 'POST',
                body: JSON.stringify({
                    location_id: RAI.invLocationId(),
                    job_ref: job,
                    actor_label: RAI.invActor(),
                    multiplier: Number(document.getElementById('inv-kit-mult')?.value) || 1,
                    note: (document.getElementById('inv-kit-note')?.value || '').trim() || undefined,
                    // Send every line explicitly, so a skip or an edit made on
                    // screen is exactly what the server posts. Relying on the
                    // multiplier alone would silently discard both.
                    lines: (RAI.kits.preview.lines || []).map(l => ({
                        kit_item_id: l.kit_item_id,
                        skip: RAI.kits.skipped.has(l.kit_item_id),
                        quantity: RAI.kits.overrides[l.kit_item_id] !== undefined
                            ? RAI.kits.overrides[l.kit_item_id]
                            : l.quantity
                    }))
                })
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Failed to expense that kit.');

            RAI.showKitResult('ok', data.message +
                (data.replenishments_drafted ? ` ${data.replenishments_drafted} item(s) added to the reorder list.` : ''));

            const jobEl = document.getElementById('inv-kit-job');
            const noteEl = document.getElementById('inv-kit-note');
            if (jobEl) jobEl.value = '';
            if (noteEl) noteEl.value = '';

            RAI.kits.skipped = new Set();
            RAI.kits.overrides = {};

            await RAI.loadKitPreview();          // on-hand has moved
            await RAI.loadKitHistory();
            RAI.loadInvSummary();
        } catch (err) {
            RAI.showKitResult('error', err.message);
        } finally {
            inv.busy = false;
            if (btn) btn.innerHTML = '<i class="fas fa-check mr-1"></i> Expense to job';
            RAI.updateKitButton();
        }
    };

    /**
     * The outcome of a commit, in its own banner.
     *
     * It cannot share the warning banner: the commit reloads the preview to
     * pick up the new on-hand, and the renderer clears that banner every time.
     * A confirmation the operator never sees is worse than none, because they
     * cannot tell whether the job was booked.
     */
    RAI.showKitResult = function (kind, message) {
        const el = document.getElementById('inv-kit-result');
        if (!el) return;
        el.className = kind === 'ok'
            ? 'mb-4 p-3 rounded-lg text-sm bg-green-50 border border-green-200 text-green-800'
            : 'mb-4 p-3 rounded-lg text-sm bg-red-50 border border-red-200 text-red-800';
        el.textContent = message;
    };

    RAI.clearKitResult = function () {
        const el = document.getElementById('inv-kit-result');
        if (el) { el.textContent = ''; el.className = 'hidden mb-4 p-3 rounded-lg text-sm'; }
    };

    RAI.loadKitHistory = async function () {
        const host = document.getElementById('inv-kit-recent');
        if (!host) return;

        try {
            const resp = await RAI.api(
                `/store/${RAI.ctx.slug}/inventory/kits/consumptions?location_id=${RAI.invLocationId()}&limit=10`
            );
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || '');

            const rows = data.consumptions || [];
            if (rows.length === 0) { host.innerHTML = ''; return; }

            host.innerHTML = `
            <div class="bg-white rounded-xl shadow-sm p-4">
                <h4 class="font-semibold text-gray-800 mb-3">Recently expensed</h4>
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead class="text-left text-gray-500 border-b">
                            <tr>
                                <th class="py-2 pr-3">Job</th>
                                <th class="py-2 pr-3">Kit</th>
                                <th class="py-2 pr-3 text-right">Items</th>
                                <th class="py-2 pr-3 text-right">Cost</th>
                                <th class="py-2 pr-3">By</th>
                                <th class="py-2 pr-3">When</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(r => `
                            <tr class="border-b last:border-0">
                                <td class="py-2 pr-3 font-medium text-gray-800">${RAI.esc(r.job_ref)}</td>
                                <td class="py-2 pr-3 text-gray-600">${RAI.esc(r.kit_name)}${Number(r.multiplier) !== 1 ? ` &times;${r.multiplier}` : ''}</td>
                                <td class="py-2 pr-3 text-right text-gray-600">${r.line_count}</td>
                                <td class="py-2 pr-3 text-right text-gray-700">${RAI.money(r.total_cost)}</td>
                                <td class="py-2 pr-3 text-gray-500">${RAI.esc(r.actor_label || '')}</td>
                                <td class="py-2 pr-3 text-gray-400">${new Date(r.created_at).toLocaleString()}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>`;
        } catch (err) {
            host.innerHTML = '';
        }
    };

    // ============================================================
    // SHARED
    // ============================================================

    /** Every write is attributed; refuse politely rather than posting anonymously. */
    RAI.requireActor = function (targetId) {
        if (RAI.invActor()) return true;
        const message = 'Enter your name at the top first — it is what records who did this.';
        if (targetId && document.getElementById(targetId)) {
            document.getElementById(targetId).innerHTML =
                `<div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm">${message}</div>`;
        } else {
            alert(message);
        }
        const el = document.getElementById('inv-actor');
        if (el) el.focus();
        return false;
    };

    RAI.money = function (n) {
        return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

})();
