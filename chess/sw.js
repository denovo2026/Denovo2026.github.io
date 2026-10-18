/* Chess Coach AI service worker: network-first for the app shell (so updates
   land immediately), cache fallback for offline use. Cross-origin requests
   (lichess / chess.com / LLM) are never cached. */
var CACHE = "chesscoach-v43";
var SHELL = ["./", "index.html", "style.css?v=43", "app.js?v=43", "board.js?v=35", "pieces.js?v=33",
  "api-shim.js?v=43", "js/engine.js?v=33", "js/repertoire.js?v=43", "js/attacks.js?v=43", "js/calc.js?v=43", "vendor/chess.js?v=33",
  "vendor/stockfish/stockfish-19-lite-single.js", "vendor/stockfish/stockfish-19-lite-single.wasm",
  "data/puzzles.json", "data/masters.json", "data/lessons.json", "data/endgames.json",
  "data/modern.json", "data/grunfeld.json", "data/attacks.json",
  "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  /* The Olympiad sub-app (./olympiad/) is a separate page with ~13MB of JSON:
     let the browser fetch it directly, never cache it here or fall back to the
     Chess Coach shell. */
  if (u.pathname.indexOf("/olympiad/") !== -1) return;
  e.respondWith(fetch(e.request).then(function (r) {
    if (r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return r;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: false }).then(function (m) { return m || caches.match("index.html"); }); }));
});
