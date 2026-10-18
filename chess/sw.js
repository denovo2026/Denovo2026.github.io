/* Chess Coach AI service worker: network-first for the app shell (so updates
   land immediately), cache fallback for offline use. Cross-origin requests
   (lichess / chess.com / LLM) are never cached. */
var CACHE = "chesscoach-v33";
var SHELL = ["./", "index.html", "style.css?v=33", "app.js?v=33", "board.js?v=33", "pieces.js?v=33",
  "api-shim.js?v=33", "js/engine.js?v=33", "vendor/chess.js?v=33",
  "vendor/stockfish/stockfish-19-lite-single.js", "vendor/stockfish/stockfish-19-lite-single.wasm",
  "data/puzzles.json", "data/masters.json", "data/lessons.json", "data/endgames.json",
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
  e.respondWith(fetch(e.request).then(function (r) {
    if (r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
    return r;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: false }).then(function (m) { return m || caches.match("index.html"); }); }));
});
