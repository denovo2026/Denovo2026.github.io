/* engine.js — async wrapper around the vendored single-threaded Stockfish 19
   Lite WASM build, running in a Web Worker (no SharedArrayBuffer / COOP-COEP
   needed, so it works on GitHub Pages).

   API (window.CCEngine):
     CCEngine.ready()                       -> Promise<{name}>   boots the worker once
     CCEngine.analyse(fen, opts)            -> Promise<result>
        opts: { depth, movetime, multipv=1, skill=20, priority="normal"|"high"|"low", nocache }
        result: { bestmove, ponder, depth, lines:[{multipv, depth, score:{type:"cp"|"mate", value}, pv:[uci...]}] }
        Scores are UCI-relative (side to move), exactly what Stockfish prints.
     CCEngine.status()                      -> { booted, ok, error, name }
   Jobs are serialized through one worker; "high" jobs jump ahead of queued
   "normal"/"low" ones (interactive eval-bar requests are not starved by a
   background game analysis). Results are cached per fen|multipv|skill and
   reused when the cached depth >= the requested depth. */
(function (global) {
  "use strict";
  var SF_PATH = "vendor/stockfish/stockfish-19-lite-single.js";
  var PRI = { high: 0, normal: 1, low: 2 };
  var worker = null, bootPromise = null, current = null, queue = [];
  var state = { booted: false, ok: false, error: null, name: null };
  var opts = { multipv: 1, skill: 20 };
  var cache = new Map(), CACHE_MAX = 400;
  var bootWaiters = null;

  function send(cmd) { worker.postMessage(cmd); }

  function onLine(line) {
    if (typeof line !== "string") line = (line && line.data) ? String(line.data) : String(line || "");
    if (bootWaiters) {
      if (line.indexOf("id name") === 0) state.name = line.slice(8).trim();
      if (line === "uciok") send("isready");
      if (line === "readyok") { var w = bootWaiters; bootWaiters = null; w.resolve(); }
      return;
    }
    if (line === "readyok" && current && current.waitReady) { current.waitReady(); return; }
    if (!current) return;
    if (line.indexOf("info ") === 0 && line.indexOf(" pv ") !== -1 && line.indexOf("bound") === -1) {
      var m = line.match(/ depth (\d+)/), mp = line.match(/ multipv (\d+)/),
          sc = line.match(/ score (cp|mate) (-?\d+)/), pv = line.match(/ pv (.+)$/);
      if (!m || !sc || !pv) return;
      var k = mp ? parseInt(mp[1], 10) : 1;
      current.lines[k] = { multipv: k, depth: parseInt(m[1], 10), score: { type: sc[1], value: parseInt(sc[2], 10) }, pv: pv[1].trim().split(/\s+/) };
      current.maxDepth = Math.max(current.maxDepth || 0, parseInt(m[1], 10));
      return;
    }
    if (line.indexOf("bestmove") === 0) {
      var parts = line.split(/\s+/);
      var job = current; current = null;
      clearTimeout(job.timer);
      var lines = Object.keys(job.lines).map(function (k) { return job.lines[k]; })
        .sort(function (a, b) { return a.multipv - b.multipv; }).slice(0, job.multipv);
      var best = parts[1] && parts[1] !== "(none)" ? parts[1] : null;
      var res = { bestmove: best, ponder: parts[3] || null, depth: job.maxDepth || 0, lines: lines };
      if (!job.nocache && best) putCache(job, res);
      job.resolve(res);
      pump();
    }
  }

  function ready() {
    if (bootPromise) return bootPromise;
    bootPromise = new Promise(function (resolve, reject) {
      var t = setTimeout(function () { fail("engine did not start (timeout)"); }, 25000);
      function fail(msg) {
        clearTimeout(t); state.booted = true; state.ok = false; state.error = msg;
        if (bootWaiters) bootWaiters = null;
        reject(new Error(msg));
        queue.splice(0).forEach(function (j) { j.reject(new Error("engine_unavailable")); });
      }
      try {
        if (typeof WebAssembly !== "object") throw new Error("WebAssembly not supported by this browser");
        worker = new Worker(SF_PATH);
      } catch (e) { fail(e.message || String(e)); return; }
      bootWaiters = { resolve: function () {
        clearTimeout(t); state.booted = true; state.ok = true; state.error = null;
        send("setoption name Hash value 32");
        resolve({ name: state.name });
        pump();
      } };
      worker.onmessage = function (e) { onLine(e.data); };
      worker.onerror = function (e) {
        var msg = "engine worker error" + (e && e.message ? ": " + e.message : "");
        if (!state.ok) { fail(msg); return; }
        state.ok = false; state.error = msg;
        if (current) { clearTimeout(current.timer); current.reject(new Error("engine_unavailable")); current = null; }
        queue.splice(0).forEach(function (j) { j.reject(new Error("engine_unavailable")); });
      };
      send("uci");
    });
    return bootPromise;
  }

  function cacheKey(fen, multipv, skill) { return fen + "|" + multipv + "|" + skill; }
  function putCache(job, res) {
    var key = cacheKey(job.fen, job.multipv, job.skill);
    var prev = cache.get(key);
    if (prev && prev.depth > res.depth) return;
    cache.delete(key); cache.set(key, res);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  function getCache(fen, multipv, skill, depth) {
    // any cached entry with >= multipv and >= depth serves the request
    for (var mp = multipv; mp <= 5; mp++) {
      var r = cache.get(cacheKey(fen, mp, skill));
      if (r && r.depth >= depth && r.lines.length >= Math.min(multipv, r.lines.length)) {
        return { bestmove: r.bestmove, ponder: r.ponder, depth: r.depth, lines: r.lines.slice(0, multipv), cached: true };
      }
    }
    return null;
  }

  function pump() {
    if (current || !queue.length || !state.ok) return;
    var job = queue.shift();
    current = job;
    job.lines = {};
    if (job.multipv !== opts.multipv) { send("setoption name MultiPV value " + job.multipv); opts.multipv = job.multipv; }
    if (job.skill !== opts.skill) { send("setoption name Skill Level value " + job.skill); opts.skill = job.skill; }
    send("position fen " + job.fen);
    var go = "go";
    if (job.depth) go += " depth " + job.depth;
    if (job.movetime) go += " movetime " + job.movetime;
    if (!job.depth && !job.movetime) go += " depth 12";
    send(go);
    job.timer = setTimeout(function () { if (current === job) send("stop"); }, (job.movetime || 8000) + 15000);
  }

  function analyse(fen, o) {
    o = o || {};
    var job = {
      fen: fen, depth: o.depth ? Math.max(1, Math.min(30, o.depth | 0)) : 0,
      movetime: o.movetime ? Math.max(20, o.movetime | 0) : 0,
      multipv: Math.max(1, Math.min(5, (o.multipv | 0) || 1)),
      skill: o.skill == null ? 20 : Math.max(0, Math.min(20, o.skill | 0)),
      pri: PRI[o.priority] != null ? PRI[o.priority] : 1, nocache: !!o.nocache,
    };
    if (!job.nocache && job.depth && job.skill === 20) {
      var c = getCache(fen, job.multipv, job.skill, job.depth);
      if (c) return Promise.resolve(c);
    }
    return ready().then(function () {
      return new Promise(function (resolve, reject) {
        if (!state.ok) { reject(new Error("engine_unavailable")); return; }
        job.resolve = resolve; job.reject = reject;
        var i = queue.length;
        while (i > 0 && queue[i - 1].pri > job.pri) i--;
        queue.splice(i, 0, job);
        pump();
      });
    });
  }

  global.CCEngine = {
    ready: ready, analyse: analyse,
    status: function () { return { booted: state.booted, ok: state.ok, error: state.error, name: state.name }; },
    queueLength: function () { return queue.length + (current ? 1 : 0); },
  };
})(typeof self !== "undefined" ? self : this);
