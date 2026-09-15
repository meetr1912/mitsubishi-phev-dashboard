/* sw.js — app-shell cache for instant reopen.
 *
 * Deliberately narrow: only the static shell (HTML/CSS/JS/icons/manifest),
 * never live vehicle data (./data/*.json) or any Cloudflare Worker call.
 * Those must always hit the network fresh -- stale vehicle/command state
 * could be actively misleading (e.g. showing "locked" when it's actually
 * unlocked), so this cache only ever touches things that don't represent
 * live state.
 *
 * Bump CACHE_NAME whenever the shell asset list changes so activate() cleans
 * out the old version.
 */
var CACHE_NAME = "phev-shell-v16";
var SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./data-contract.js",
  "./app.js",
  "./activity.js",
  "./trip-intelligence.js",
  "./vehicle-intelligence.js",
  "./charts.js",
  "./crypto.js",
  "./nav.js",
  "./pull-refresh.js",
  "./shortcuts-setup.js",
  "./manifest.webmanifest",
  "./apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(SHELL_ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(
          names.filter(function (n) { return n !== CACHE_NAME; })
               .map(function (n) { return caches.delete(n); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Only the shell, same-origin, GET. Everything else (the CDN scripts,
// docs/data/*.json, every Cloudflare Worker call) passes through completely
// untouched -- no respondWith() means the browser handles it exactly as if
// this service worker didn't exist.
function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.indexOf("/data/") !== -1) return false;
  return true;
}

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var url = new URL(event.request.url);
  if (!isShellRequest(url)) return;

  // Network-first prevents a deployed layout from being masked by an older
  // app shell. The cache is only an offline fallback; this matters on iOS
  // where an installed web app can otherwise keep an old tab layout alive.
  event.respondWith(
    fetch(event.request)
      .then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return res;
      })
      .catch(function () { return caches.match(event.request); })
  );
});
