/**
 * public/refinishai-inventory-sw.js
 *
 * Service worker for refinishAI Inventory. Its only job is to make the console
 * installable on a phone home screen and to keep the shell usable when the
 * shop-floor Wi-Fi drops. It is registered only by the inventory module, so a
 * company using the ordering portal alone never installs it.
 *
 * Deliberately network-first for everything. A cache-first worker on a live
 * ordering portal is a stale-asset bug waiting to happen: a technician would
 * keep seeing yesterday's prices after a deploy. Here the network always wins,
 * and the cache is only ever a fallback for a request that failed outright.
 *
 * API calls are never cached — stock levels that are minutes old are worse than
 * no answer, because they look authoritative.
 */

const CACHE = 'refinishai-inventory-v1';
const SHELL = ['/assets/chc-logo.png', '/assets/refinishai-mark.png', '/assets/refinishai-icon.png'];

self.addEventListener('install', (event) => {
    // addAll rejects the whole batch if any single asset 404s, so warm the
    // cache item by item and tolerate misses.
    event.waitUntil(
        caches.open(CACHE)
            .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => null))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;   // CDNs handle their own caching
    if (url.pathname.startsWith('/api/')) return;      // never serve stale stock data

    event.respondWith(
        fetch(req)
            .then(resp => {
                if (resp && resp.ok && resp.type === 'basic') {
                    const copy = resp.clone();
                    caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
                }
                return resp;
            })
            .catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
});
