/* api-shim.js — Chess Coach AI, fully static build.
   Intercepts every fetch() to "/api/..." made by app.js / board.js and
   fulfils it in the browser:
     - chess rules        -> vendored chess.js   (window.Chess)
     - engine analysis    -> vendored Stockfish 19 Lite WASM (window.CCEngine, js/engine.js)
     - user data          -> localStorage, keys namespaced "chesscoach:*"
     - optional network   -> lichess tablebase / cloud-eval / game import / rating history,
                             chess.com game import, a user-configured local LLM URL.
   Response shapes follow API_CONTRACTS.md (derived from how app.js reads them).
   Any unknown /api path still answers 200 with an empty-but-well-shaped body.
   Must load AFTER vendor/chess.js + js/engine.js and BEFORE app.js. */
(function () {
  "use strict";
  if (window.__CC_SHIM__) return;
  window.__CC_SHIM__ = true;

  var NATIVE_FETCH = window.fetch ? window.fetch.bind(window) : null;
  var START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  var NS = "chesscoach:";
  var SHIM_VERSION = "static-1.0";

  /* ------------------------------------------------------------------ */
  /* storage                                                             */
  /* ------------------------------------------------------------------ */
  var memStore = {};
  var S = {
    get: function (k, def) {
      try {
        var v = localStorage.getItem(NS + k);
        if (v == null) return def === undefined ? null : clone(def);
        return JSON.parse(v);
      } catch (_) { return memStore[k] !== undefined ? memStore[k] : (def === undefined ? null : clone(def)); }
    },
    set: function (k, v) {
      try { localStorage.setItem(NS + k, JSON.stringify(v)); }
      catch (e) { memStore[k] = v; console.warn("[chesscoach] storage write failed for", k, e && e.name); }
      return v;
    },
    del: function (k) { try { localStorage.removeItem(NS + k); } catch (_) {} delete memStore[k]; },
  };
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function nowIso() { return new Date().toISOString(); }
  function utcDay(d) { return (d ? new Date(d) : new Date()).toISOString().slice(0, 10); }
  function uid(prefix) { return (prefix || "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function hashStr(s) { // FNV-1a 32-bit, hex
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ------------------------------------------------------------------ */
  /* HTTP plumbing                                                       */
  /* ------------------------------------------------------------------ */
  function HttpError(status, detail) { this.status = status; this.detail = detail; }
  function fail(status, detail) { throw new HttpError(status, detail); }
  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body == null ? {} : body), {
      status: status, headers: { "Content-Type": "application/json" },
    });
  }

  var ROUTES = [];
  function route(method, pattern, handler) {
    var keys = [];
    var re = new RegExp("^" + pattern.replace(/:([a-zA-Z_]+)/g, function (_, k) { keys.push(k); return "([^/]+)"; }) + "$");
    ROUTES.push({ method: method, re: re, keys: keys, handler: handler });
  }

  function emptyFor(path) {
    // well-shaped empty answers for anything not implemented
    return { ok: true, available: false, items: [], entries: [], games: [], lines: [], moves: [], note: "not available in the static build", path: path };
  }

  var MINE_READY = null; // v39: bundled "my data" import; every API call waits for it once
  async function dispatch(method, url, body) {
    var u = new URL(url, location.href);
    var path = u.pathname.replace(/^.*?(\/api\/)/, "/api/");
    if (MINE_READY && path.indexOf("/api/mine/") !== 0) { try { await MINE_READY; } catch (_) {} }
    var query = {};
    u.searchParams.forEach(function (v, k) { query[k] = v; });
    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i];
      if (r.method !== method && r.method !== "*") continue;
      var m = path.match(r.re);
      if (!m) continue;
      var params = {};
      r.keys.forEach(function (k, j) { params[k] = decodeURIComponent(m[j + 1]); });
      return r.handler(body || {}, query, params, method);
    }
    console.info("[chesscoach] unimplemented endpoint (empty response):", method, path);
    return emptyFor(path);
  }

  function isApiUrl(url) {
    if (typeof url !== "string") return false;
    if (url.indexOf("/api/") === 0 || url.indexOf("api/") === 0) return true;
    try { var u = new URL(url, location.href); return u.origin === location.origin && /\/api\//.test(u.pathname) && u.pathname.indexOf("/api/") === u.pathname.search(/\/api\//); }
    catch (_) { return false; }
  }

  window.fetch = async function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    if (!isApiUrl(url) || (url.indexOf("http") === 0 && url.indexOf(location.origin) !== 0)) {
      return NATIVE_FETCH(input, init);
    }
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    var body = null;
    try {
      var raw = init && init.body;
      if (raw && typeof raw === "string") body = JSON.parse(raw);
    } catch (_) { body = {}; }
    try {
      var out = await dispatch(method, url, body);
      if (out instanceof Response) return out;
      return jsonResponse(200, out);
    } catch (e) {
      if (e instanceof HttpError) return jsonResponse(e.status, { detail: e.detail });
      if (e && e.message === "engine_unavailable") return jsonResponse(503, { detail: "engine_unavailable" });
      console.error("[chesscoach] handler error", method, url, e);
      return jsonResponse(500, { detail: (e && e.message) || "internal_error" });
    }
  };

  /* app.js only uses fetch, but shim XHR too so nothing can leak to a server */
  (function patchXhr() {
    var X = window.XMLHttpRequest;
    if (!X) return;
    var open = X.prototype.open, sendOrig = X.prototype.send;
    X.prototype.open = function (method, url) {
      this.__ccApi = isApiUrl(String(url)) ? { method: String(method).toUpperCase(), url: String(url) } : null;
      return open.apply(this, arguments);
    };
    X.prototype.send = function (body) {
      if (!this.__ccApi) return sendOrig.apply(this, arguments);
      var xhr = this, req = this.__ccApi;
      window.fetch(req.url, { method: req.method, body: body }).then(function (r) {
        return r.text().then(function (t) {
          Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
          Object.defineProperty(xhr, "status", { value: r.status, configurable: true });
          Object.defineProperty(xhr, "responseText", { value: t, configurable: true });
          Object.defineProperty(xhr, "response", { value: t, configurable: true });
          if (xhr.onreadystatechange) xhr.onreadystatechange();
          if (xhr.onload) xhr.onload();
          xhr.dispatchEvent && xhr.dispatchEvent(new Event("load"));
        });
      });
    };
  })();

  /* ------------------------------------------------------------------ */
  /* bundled data                                                        */
  /* ------------------------------------------------------------------ */
  var dataCache = {};
  function loadData(name) {
    if (!dataCache[name]) {
      dataCache[name] = NATIVE_FETCH("data/" + name).then(function (r) {
        if (!r.ok) throw new Error("missing data file " + name);
        return r.json();
      }).catch(function (e) { delete dataCache[name]; throw e; });
    }
    return dataCache[name];
  }

  /* ------------------------------------------------------------------ */
  /* chess helpers (chess.js)                                            */
  /* ------------------------------------------------------------------ */
  var PIECE_NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  var PIECE_VAL = { p: 100, n: 300, b: 320, r: 500, q: 900, k: 0 };

  function normFen(fen) {
    var p = String(fen || "").trim().split(/\s+/);
    if (p.length < 1 || !p[0]) return "";
    var d = ["", "w", "-", "-", "0", "1"];
    for (var i = p.length; i < 6; i++) p.push(d[i]);
    return p.slice(0, 6).join(" ");
  }
  function mkChess(fen) {
    try { return new Chess(normFen(fen || START_FEN)); }
    catch (e) { fail(400, "invalid_fen"); }
  }
  function tryChess(fen) { try { return new Chess(normFen(fen)); } catch (_) { return null; } }
  function tryMove(ch, uci) {
    if (!uci || uci.length < 4) return null;
    try { return ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined }); }
    catch (_) {
      // pawn reaching the last rank without a promotion letter → queen
      if (!uci[4]) { try { return ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: "q" }); } catch (__) {} }
      return null;
    }
  }
  function trySan(ch, san) {
    try { return ch.move(san); } catch (_) {}
    try { return ch.move(String(san).replace(/[!?]+$/, ""), { strict: false }); } catch (_) { return null; }
  }
  function sideName(c) { return c === "w" ? "white" : "black"; }
  function gameStatus(ch) {
    var turn = ch.turn();
    if (ch.isCheckmate()) return { terminal: true, result: turn === "w" ? "0-1" : "1-0", reason: "checkmate" };
    if (ch.isStalemate()) return { terminal: true, result: "1/2-1/2", reason: "stalemate" };
    if (ch.isInsufficientMaterial()) return { terminal: true, result: "1/2-1/2", reason: "insufficient material" };
    if (ch.isDrawByFiftyMoves && ch.isDrawByFiftyMoves()) return { terminal: true, result: "1/2-1/2", reason: "fifty-move rule" };
    if (ch.isThreefoldRepetition && ch.isThreefoldRepetition()) return { terminal: true, result: "1/2-1/2", reason: "threefold repetition" };
    return { terminal: false, result: null, reason: null };
  }
  function uciToSanLine(fen, ucis, max) {
    var ch = tryChess(fen), out = [];
    if (!ch) return out;
    for (var i = 0; i < ucis.length && (max == null || i < max); i++) {
      var m = tryMove(ch, ucis[i]);
      if (!m) break;
      out.push(m.san);
    }
    return out;
  }
  function sanOf(fen, uci) { var s = uciToSanLine(fen, [uci], 1); return s[0] || uci; }
  function fenAfter(fen, uci) { var ch = tryChess(fen); if (!ch) return null; var m = tryMove(ch, uci); return m ? ch.fen() : null; }
  function pieceCount(fen) { return (String(fen).split(" ")[0].match(/[a-zA-Z]/g) || []).length; }
  function materialOf(ch, color) {
    var tot = 0;
    ch.board().forEach(function (row) { row.forEach(function (sq) { if (sq && sq.color === color) tot += PIECE_VAL[sq.type]; }); });
    return tot;
  }
  function moveFacts(fen, uci) {
    var ch = tryChess(fen); if (!ch) return null;
    var m = tryMove(ch, uci); if (!m) return null;
    return { san: m.san, piece: m.piece, from: m.from, to: m.to, captured: m.captured || null,
      check: ch.inCheck(), mate: ch.isCheckmate(), promotion: m.promotion || null,
      castle: /O-O/.test(m.san), fen_after: ch.fen() };
  }

  /* robust PGN loader: chess.js first, then a cleaned retry, then token replay */
  function cleanPgnMoves(text) {
    var body = String(text).replace(/\[[^\]]*\]/g, " ").replace(/\{[^}]*\}/g, " ").replace(/;[^\n]*/g, " ").replace(/\$\d+/g, " ");
    var depth = 0, out = "";
    for (var i = 0; i < body.length; i++) {
      var c = body[i];
      if (c === "(") depth++; else if (c === ")") depth = Math.max(0, depth - 1); else if (depth === 0) out += c;
    }
    return out.split(/\s+/).map(function (t) { return t.replace(/^\d+\.(\.\.)?/, "").replace(/[!?]+$/, ""); })
      .filter(function (t) { return t && !/^\d+\.+$/.test(t) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t); });
  }
  function parseHeaders(text) {
    var h = {}, re = /\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g, m;
    while ((m = re.exec(text)) !== null) h[m[1]] = m[2];
    return h;
  }
  function loadGame(pgn) {
    var text = String(pgn || "").trim();
    if (!text) fail(400, "invalid_pgn");
    var headers = parseHeaders(text);
    var startFen = headers.FEN ? normFen(headers.FEN) : START_FEN;
    var ch = new Chess();
    var ok = false;
    try { ch.loadPgn(text, { strict: false }); ok = true; } catch (_) {}
    if (!ok || (ch.history().length === 0 && cleanPgnMoves(text).length)) {
      ch = tryChess(startFen);
      if (!ch) fail(400, "invalid_pgn");
      var toks = cleanPgnMoves(text), n = 0;
      for (var i = 0; i < toks.length; i++) {
        if (!trySan(ch, toks[i])) {
          // an illegal SAN-looking move means a broken game, not just a stray token
          if (/^([KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](x[a-h])?[1-8](=?[QRBN])?|O-O(-O)?)[+#]?$/.test(toks[i])) fail(400, "invalid_pgn");
          break;
        }
        n++;
      }
      if (n === 0 && toks.length) fail(400, "invalid_pgn");
    }
    var hist = ch.history({ verbose: true });
    var moves = hist.map(function (m, i) {
      return { ply: i + 1, san: m.san, uci: m.lan || (m.from + m.to + (m.promotion || "")), fen_before: m.before, fen: m.after, fen_after: m.after };
    });
    if (moves.length) startFen = moves[0].fen_before;
    return { headers: headers, start_fen: startFen, moves: moves, final_fen: moves.length ? moves[moves.length - 1].fen : startFen };
  }
  function splitPgns(text) {
    var t = String(text || "").replace(/\r\n?/g, "\n").trim();
    if (!t) return [];
    var parts = t.split(/\n\s*\n(?=\[Event |\[White |\[Site )/);
    if (parts.length === 1 && /\[Event /.test(t)) parts = t.split(/(?=\[Event )/);
    return parts.map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function pgnHash(pgn) {
    var h = parseHeaders(pgn);
    return hashStr([h.White || "", h.Black || "", h.Date || h.UTCDate || "", cleanPgnMoves(pgn).join(" ")].join("|"));
  }

  /* ------------------------------------------------------------------ */
  /* engine helpers                                                      */
  /* ------------------------------------------------------------------ */
  var Engine = window.CCEngine;
  var MATE_CP = 10000;

  function evCp(ev) { // eval object (side-to-move POV) -> centipawns
    if (!ev) return 0;
    if (typeof ev === "string") return ev === "mate" ? -MATE_CP : 0;
    if (ev.type === "mate") return ev.value > 0 ? MATE_CP - ev.value * 10 : ev.value < 0 ? -MATE_CP - ev.value * 10 : -MATE_CP;
    return ev.value;
  }
  function capCp(cp) { return clamp(cp, -1500, 1500); }
  function negEval(ev) { return ev && typeof ev === "object" ? { type: ev.type, value: -ev.value } : ev; }
  function winPct(cp) { return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -1500, 1500))) - 1); }
  function moveAccuracy(cpBefore, cpAfter) {
    var d = winPct(cpBefore) - winPct(cpAfter);
    return clamp(103.1668 * Math.exp(-0.04354 * Math.max(0, d)) - 3.1669, 0, 100);
  }
  function classifyCpl(cpl) {
    if (cpl <= 10) return "best";
    if (cpl <= 40) return "good";
    if (cpl <= 100) return "inaccuracy";
    if (cpl <= 250) return "mistake";
    return "blunder";
  }

  async function engineAvailable() {
    try { await Engine.ready(); return Engine.status().ok; } catch (_) { return false; }
  }

  /* lichess cloud-eval fallback (only when the local engine cannot start) */
  async function cloudEval(fen, multipv) {
    var r = await NATIVE_FETCH("https://lichess.org/api/cloud-eval?multiPv=" + (multipv || 1) + "&fen=" + encodeURIComponent(fen));
    if (!r.ok) throw new Error("engine_unavailable");
    var j = await r.json();
    var side = fen.split(" ")[1];
    var lines = (j.pvs || []).map(function (pv, i) {
      // cloud evals are White POV — convert to side-to-move POV like UCI
      var sc = pv.mate != null ? { type: "mate", value: pv.mate } : { type: "cp", value: pv.cp };
      if (side === "b") sc = { type: sc.type, value: -sc.value };
      return { multipv: i + 1, depth: j.depth, score: sc, pv: pv.moves.split(" ") };
    });
    return { bestmove: lines[0] && lines[0].pv[0], depth: j.depth, lines: lines, provider: "cloud" };
  }

  /* analyse a position; returns { fen, terminal, result, reason, eval, lines[], best, best_san, depth, provider } */
  async function analysePos(fen, o) {
    o = o || {};
    var ch = mkChess(fen);
    fen = ch.fen();
    var st = gameStatus(ch);
    if (st.terminal) {
      return { fen: fen, terminal: true, result: st.result, reason: st.reason,
        eval: st.reason === "checkmate" ? "mate" : "draw", lines: [], best: null, best_san: null, depth: 0, provider: "local" };
    }
    var depth = clamp(o.depth || 12, 1, 22);
    var movetime = o.movetime || (depth <= 12 ? 2500 : depth <= 16 ? 5000 : 9000);
    var res, provider = "local";
    try {
      res = await Engine.analyse(fen, { depth: depth, movetime: movetime, multipv: o.multipv || 1, priority: o.priority || "normal", skill: o.skill });
    } catch (e) {
      try { res = await cloudEval(fen, o.multipv || 1); provider = "cloud"; }
      catch (_) { throw new Error("engine_unavailable"); }
    }
    var lines = (res.lines || []).map(function (l) {
      var pv = l.pv.slice(0, o.pvLen || 12);
      return { eval: l.score, moves_uci: pv, moves_san: uciToSanLine(fen, pv), depth: l.depth };
    });
    var best = res.bestmove || (lines[0] && lines[0].moves_uci[0]) || null;
    return { fen: fen, terminal: false, result: null, reason: null,
      eval: lines[0] ? lines[0].eval : { type: "cp", value: 0 }, lines: lines,
      best: best, best_san: best ? sanOf(fen, best) : null, depth: res.depth, provider: provider };
  }

  /* ------------------------------------------------------------------ */
  /* human-readable, board-verified explanations (no LLM)                */
  /* ------------------------------------------------------------------ */
  var MOTIF_LABELS = {
    missed_mate: "Missed a forced mate", allowed_mate: "Allowed a forced mate",
    hanging_piece: "Left material hanging", missed_capture: "Missed a winning capture",
    missed_check: "Missed a forcing check", positional: "Positional / strategic error",
    ignored_threat: "Ignored the opponent's threat", allowed_tactic: "Allowed a tactic",
    opening_slip: "Opening slip", endgame_technique: "Endgame technique",
  };
  function mistakeFacts(fenBefore, uci, bestUci, evBefore, afterLines) {
    var played = moveFacts(fenBefore, uci) || { san: uci };
    var best = moveFacts(fenBefore, bestUci) || { san: bestUci };
    var reply = afterLines && afterLines[0] && afterLines[0].moves_uci[0];
    var replyFacts = reply && played.fen_after ? moveFacts(played.fen_after, reply) : null;
    var afterEv = afterLines && afterLines[0] ? afterLines[0].eval : null; // opponent POV
    var motif = "positional";
    if (evBefore && evBefore.type === "mate" && evBefore.value > 0) motif = "missed_mate";
    else if (afterEv && afterEv.type === "mate" && afterEv.value > 0) motif = "allowed_mate";
    else if (replyFacts && replyFacts.captured && PIECE_VAL[replyFacts.captured] >= 300) motif = "hanging_piece";
    else if (best.captured && PIECE_VAL[best.captured] >= 100) motif = "missed_capture";
    else if (best.check) motif = "missed_check";
    return { played: played, best: best, reply: replyFacts, motif: motif };
  }
  function explainMistake(f, cpl, pvSan) {
    var s = [];
    if (f.motif === "missed_mate") s.push(f.best.san + " started a forced mate; " + f.played.san + " let it slip.");
    else if (f.motif === "allowed_mate") s.push(f.played.san + " allows a forced mate" + (f.reply ? ", starting with " + f.reply.san : "") + ".");
    else if (f.motif === "hanging_piece") s.push("After " + f.played.san + ", " + f.reply.san + " wins your " + PIECE_NAME[f.reply.captured] + ".");
    else if (f.motif === "missed_capture") s.push(f.best.san + " would have captured a " + PIECE_NAME[f.best.captured] + ".");
    else if (f.motif === "missed_check") s.push(f.best.san + " was a forcing check that kept the initiative.");
    else s.push("The engine prefers " + f.best.san + " here; " + f.played.san + " gives the opponent an easier game.");
    if (pvSan && pvSan.length > 1) s.push("Best line: " + pvSan.slice(0, 6).join(" ") + ".");
    if (cpl > 0 && cpl < 3000) s.push("This cost about " + (Math.min(cpl, 1500) / 100).toFixed(1) + " pawns.");
    return s.join(" ");
  }
  function hintForMove(fen, uci) {
    var f = moveFacts(fen, uci);
    if (!f) return { text: "Look for the most forcing move: checks, captures, threats." };
    var bits = ["The key move is a " + PIECE_NAME[f.piece] + " move"];
    if (f.mate) bits.push("and it ends the game");
    else if (f.check) bits.push("and it gives check");
    else if (f.captured) bits.push("and it captures something");
    return { text: bits.join(" ") + "." , piece: PIECE_NAME[f.piece] };
  }

  /* ------------------------------------------------------------------ */
  /* TIER 1: health / config / move / board / analysis                   */
  /* ------------------------------------------------------------------ */
  var CONFIG_DEFAULTS = {
    lichess_username: "", chesscom_username: "", lichess_token: "",
    llm_enabled: false, llm_url: "", llm_model: "",
    voice_enabled: false, persona_enabled: false, voice_provider: "auto",
    my_names: "",
  };
  // v39: every name the player uses in imported games (config usernames + bundled "my data" names)
  function myNames() {
    var c = getConfig();
    return [c.lichess_username, c.chesscom_username].concat(String(c.my_names || "").split(","))
      .map(function (x) { return String(x || "").trim().toLowerCase(); }).filter(Boolean);
  }
  function getConfig() { return Object.assign({}, CONFIG_DEFAULTS, S.get("config", {})); }
  function publicConfig() {
    var c = getConfig();
    var out = Object.assign({}, c);
    delete out.lichess_token;
    out.lichess_token_set = !!c.lichess_token;
    out.static_build = true;
    return out;
  }

  route("GET", "/api/health", async function () {
    var ok = await engineAvailable();
    var st = Engine.status();
    var cloud = false;
    if (!ok && navigator.onLine !== false) {
      try { await cloudEval(START_FEN, 1); cloud = true; } catch (_) {}
    }
    return {
      status: "ok", version: SHIM_VERSION, mode: "static",
      engine: ok || cloud, engine_provider: ok ? "local" : cloud ? "cloud" : null,
      engine_name: st.name || "Stockfish 19 Lite (WASM, in-browser)",
      engine_error: ok ? null : (st.error || "WebAssembly engine failed to start"),
      llm: !!getConfig().llm_enabled, maia: false, storage: "localStorage",
    };
  });

  route("GET", "/api/config", function () { return publicConfig(); });
  route("POST", "/api/config", function (b) {
    var c = getConfig();
    Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
      if (b[k] === undefined) return;
      c[k] = typeof CONFIG_DEFAULTS[k] === "boolean" ? !!b[k] : String(b[k] == null ? "" : b[k]).trim();
    });
    S.set("config", c);
    return publicConfig();
  });
  route("POST", "/api/config/test-llm", async function (b) {
    var base = String(b.llm_url || getConfig().llm_url || "").trim().replace(/\/+$/, "");
    if (!base) return { ok: false, detail: "connection_refused" };
    var t0 = performance.now();
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 6000);
    try {
      var r = await NATIVE_FETCH(base.replace(/\/v1$/, "") + "/v1/models", { signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) return { ok: false, detail: "http_" + r.status };
      var j = await r.json().catch(function () { return null; });
      if (!j || !Array.isArray(j.data)) return { ok: false, detail: "bad_response" };
      return { ok: true, latency_ms: Math.round(performance.now() - t0),
        reply_sample: j.data.map(function (m) { return m.id; }).slice(0, 3).join(", ") || "(no models listed)" };
    } catch (e) {
      clearTimeout(to);
      return { ok: false, detail: e && e.name === "AbortError" ? "timeout" : "connection_refused" };
    }
  });

  route("POST", "/api/move", function (b) {
    var ch = mkChess(b.fen);
    var before = ch.fen();
    var m = b.move_uci ? tryMove(ch, String(b.move_uci).trim()) : (b.move_san ? trySan(ch, b.move_san) : null);
    if (!m) return { legal: false, fen: before, fen_before: before, reason: "illegal_move" };
    var st = gameStatus(ch);
    return {
      legal: true, uci: m.lan || (m.from + m.to + (m.promotion || "")), san: m.san,
      fen_before: before, fen_after: ch.fen(), check: ch.inCheck(), capture: m.captured || null,
      terminal: st.terminal, result: st.result, reason: st.reason,
      side_to_move: sideName(ch.turn()),
    };
  });

  route("POST", "/api/board/status", function (b) {
    var ch = mkChess(b.fen);
    var st = gameStatus(ch);
    return { fen: ch.fen(), terminal: st.terminal, result: st.result, reason: st.reason,
      side_to_move: sideName(ch.turn()), in_check: ch.inCheck(), legal_moves: ch.moves().length };
  });

  route("POST", "/api/board/from-pgn", function (b) {
    var g = loadGame(b.pgn);
    var h = g.headers;
    return {
      ok: true, start_fen: g.start_fen, final_fen: g.final_fen,
      moves: g.moves.map(function (m) { return { ply: m.ply, san: m.san, uci: m.uci, fen: m.fen }; }),
      headers: { white: h.White || "?", black: h.Black || "?", result: h.Result || "*", date: h.Date || "", event: h.Event || "", fen: h.FEN || null },
    };
  });

  route("POST", "/api/analyze/position", async function (b) {
    var a = await analysePos(b.fen, { depth: b.depth || 12, multipv: b.multipv || 3, priority: "high" });
    return {
      fen: a.fen, terminal: a.terminal, result: a.result, reason: a.reason,
      eval: a.eval, depth: a.depth, provider: a.provider,
      best_move_uci: a.best, best_move_san: a.best_san,
      lines: a.lines.map(function (l) { return { eval: l.eval, moves_uci: l.moves_uci, moves_san: l.moves_san }; }),
    };
  });

  route("POST", "/api/move/feedback", async function (b) {
    var fen = mkChess(b.fen).fen();
    var depth = clamp(b.depth || 12, 6, 18);
    var pre = await analysePos(fen, { depth: depth, multipv: 2, priority: "high" });
    if (pre.terminal) fail(400, "terminal_position");
    var uci = String(b.move_uci || "");
    var facts = moveFacts(fen, uci);
    if (!facts) fail(400, "illegal_move");
    var post = await analysePos(facts.fen_after, { depth: depth, multipv: 1, priority: "high" });
    var bestCp = capCp(evCp(pre.eval));
    var afterCp = post.terminal ? (post.reason === "checkmate" ? 1500 : 0) : capCp(-evCp(post.eval));
    var cpl = uci === pre.best ? 0 : Math.max(0, Math.round(bestCp - afterCp));
    var cls = classifyCpl(cpl);
    if (uci === pre.best && pre.lines[1]) {
      var gap = bestCp - capCp(evCp(pre.lines[1].eval));
      var ch = mkChess(fen), me = ch.turn();
      var matBefore = materialOf(ch, me) - materialOf(ch, me === "w" ? "b" : "w");
      var after = mkChess(facts.fen_after);
      var matAfter = materialOf(after, me) - materialOf(after, me === "w" ? "b" : "w");
      var sac = matAfter < matBefore - 150 && !facts.captured;
      if (gap >= 150 && sac && bestCp > -100) cls = "brilliant";
      else if (gap >= 120) cls = "great";
    }
    return { classification: cls, cpl: cpl, san: facts.san, best_uci: pre.best, best_san: pre.best_san,
      eval_before: pre.eval, eval_after: post.terminal ? post.eval : negEval(post.eval), depth: depth };
  });

  /* ---- full-game analysis (also feeds mistakes/scan, post-mortem, puzzles) ---- */
  var analysisMem = {};
  function analysisIndex() { return S.get("analyses", []); }
  async function analyseGame(pgn, depth, opts) {
    opts = opts || {};
    var g = loadGame(pgn);
    var key = pgnHash(pgn) + ":" + (depth || 12);
    if (analysisMem[key]) return analysisMem[key];
    var stored = S.get("analysis:" + key);
    if (stored) { analysisMem[key] = stored; return stored; }
    var mineA = await mineAnalysis(pgnHash(pgn));
    if (mineA) { analysisMem[key] = mineA; return mineA; }
    depth = clamp(depth || 12, 6, 16);
    var fens = [g.start_fen].concat(g.moves.map(function (m) { return m.fen; }));
    var evals = [];
    for (var i = 0; i < fens.length; i++) {
      evals.push(await analysePos(fens[i], { depth: depth, movetime: opts.movetime || 1500, multipv: 1, priority: opts.priority || "normal", pvLen: 8 }));
      if (opts.onProgress) opts.onProgress(i + 1, fens.length);
    }
    var accs = { w: [], b: [] }, moves = [];
    g.moves.forEach(function (m, i) {
      var pre = evals[i], post = evals[i + 1];
      var mover = pre.fen.split(" ")[1];
      var bestCp = capCp(evCp(pre.eval));
      var afterCp = post.terminal ? (post.reason === "checkmate" ? 1500 : 0) : capCp(-evCp(post.eval));
      var cpl = m.uci === pre.best ? 0 : Math.max(0, Math.round(bestCp - afterCp));
      var evAfter = post.terminal ? (post.reason === "checkmate" ? { type: "mate", value: 0 } : { type: "cp", value: 0 }) : negEval(post.eval);
      accs[mover].push(moveAccuracy(bestCp, afterCp));
      var cls = classifyCpl(cpl);
      var pvSan = pre.lines[0] ? pre.lines[0].moves_san : [];
      var rec = {
        ply: m.ply, san: m.san, uci: m.uci, fen_before: pre.fen, fen_after: m.fen,
        eval_before: pre.eval === "mate" || pre.eval === "draw" ? { type: "cp", value: 0 } : pre.eval,
        eval_after: evAfter, cpl: cpl, classification: cls,
        best_uci: pre.best, best_san: pre.best_san, pv_san: pvSan, brilliant: false,
      };
      if (cpl >= 100 && pre.best && pre.best !== m.uci) {
        var f = mistakeFacts(pre.fen, m.uci, pre.best, pre.eval, post.lines);
        rec.motif = f.motif;
        rec.explanation = explainMistake(f, cpl, pvSan);
        var num = Math.ceil(m.ply / 2) + (mover === "w" ? ". " : "... ");
        var suffix = { blunder: "??", mistake: "?", inaccuracy: "?!" }[cls] || "";
        rec.title = "Move " + num + m.san + suffix + " — " + pre.best_san + " was better";
      }
      moves.push(rec);
    });
    var avg = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; };
    var h = g.headers;
    var count = function (side, c) { return moves.filter(function (mv) { return (mv.fen_before.split(" ")[1] === side) && mv.classification === c; }).length; };
    var res = {
      white: h.White || "White", black: h.Black || "Black", result: h.Result || "*",
      date: h.Date || "", start_fen: g.start_fen, depth: depth, provider: evals.some(function (e) { return e.provider === "cloud"; }) ? "cloud" : "local",
      accuracy: { white: Math.round(avg(accs.w) * 10) / 10, black: Math.round(avg(accs.b) * 10) / 10 },
      moves: moves, pgn_hash: pgnHash(pgn),
    };
    res.coach_summary = (res.white) + " played with " + res.accuracy.white.toFixed(1) + "% accuracy (" +
      count("w", "blunder") + " blunders, " + count("w", "mistake") + " mistakes); " + (res.black) + " " +
      res.accuracy.black.toFixed(1) + "% (" + count("b", "blunder") + " blunders, " + count("b", "mistake") + " mistakes)." +
      (moves.length ? "" : " No moves to analyze.");
    analysisMem[key] = res;
    // persist the full analysis (bounded) + a summary record for progress/profile
    var idx = analysisIndex().filter(function (r) { return r.key !== key; });
    idx.unshift({ key: key, pgn_hash: res.pgn_hash, white: res.white, black: res.black, result: res.result, date: res.date,
      accuracy_white: res.accuracy.white, accuracy_black: res.accuracy.black, at: nowIso(),
      blunders_white: count("w", "blunder"), blunders_black: count("b", "blunder"),
      motifs: moves.filter(function (m) { return m.motif; }).map(function (m) { return { motif: m.motif, side: m.fen_before.split(" ")[1] }; }) });
    idx.slice(15).forEach(function (r) { S.del("analysis:" + r.key); });
    S.set("analyses", idx.slice(0, 200));
    S.set("analysis:" + key, res);
    return res;
  }

  function mistakesFrom(a, side) {
    var list = a.moves.filter(function (mv) {
      return mv.cpl >= 150 && mv.best_uci && mv.best_uci !== mv.uci && (!side || side === "both" || sideName(mv.fen_before.split(" ")[1]) === side);
    }).sort(function (x, y) { return y.cpl - x.cpl; }).slice(0, 5);
    return list.map(function (mv) {
      var white = mv.fen_before.split(" ")[1] === "w";
      var toWhite = function (ev) { return white ? ev : negEval(ev); };
      return {
        ply: mv.ply, move_number: Math.ceil(mv.ply / 2), color: white ? "white" : "black",
        san: mv.san, uci: mv.uci, classification: mv.classification, fen_before: mv.fen_before,
        best_san: mv.best_san, best_uci: mv.best_uci, eval_before: toWhite(mv.eval_before), eval_after: toWhite(mv.eval_after),
        cp_loss: mv.cpl, pv_san: mv.pv_san || [], explanation: mv.explanation || "", title: mv.title || ("Move " + Math.ceil(mv.ply / 2) + " " + mv.san),
        motif: mv.motif || "positional",
      };
    });
  }

  route("POST", "/api/analyze/game", async function (b) {
    var a = await analyseGame(b.pgn, b.depth || 12);
    logActivity("review", "analysis");
    return a;
  });
  route("POST", "/api/mistakes/scan", async function (b) {
    var a = await analyseGame(b.pgn, b.depth || 12);
    return { mistakes: mistakesFrom(a), result: a.result, provider: a.provider, white: a.white, black: a.black };
  });

  route("GET", "/api/tablebase", async function (b, q) {
    var fen = normFen(q.fen || "");
    if (!fen || pieceCount(fen) > 7) return { available: false, reason: "more than 7 pieces" };
    try {
      var r = await NATIVE_FETCH("https://tablebase.lichess.ovh/standard?fen=" + encodeURIComponent(fen));
      if (!r.ok) return { available: false, reason: "tablebase http " + r.status };
      var j = await r.json();
      var flip = { win: "loss", loss: "win", "cursed-win": "blessed-loss", "blessed-loss": "cursed-win", "maybe-win": "maybe-loss", "maybe-loss": "maybe-win" };
      return {
        available: true, category: j.category, dtz: j.dtz, dtm: j.dtm,
        // lichess reports move categories from the opponent's view — flip to the mover's
        moves: (j.moves || []).map(function (m) { return { uci: m.uci, san: m.san, category: flip[m.category] || m.category, dtz: m.dtz != null ? -m.dtz : null }; }),
      };
    } catch (e) { return { available: false, reason: "offline" }; }
  });
  async function tablebaseCategory(fen) {
    if (pieceCount(fen) > 7) return null;
    try {
      var r = await NATIVE_FETCH("https://tablebase.lichess.ovh/standard?fen=" + encodeURIComponent(normFen(fen)));
      if (!r.ok) return null;
      var j = await r.json();
      return j.category || null;
    } catch (_) { return null; }
  }

  /* ------------------------------------------------------------------ */
  /* activity log (feeds streak / heatmap / training plan)               */
  /* ------------------------------------------------------------------ */
  // pillar: review | tactics | sparring | endgame | masters ; kind: free text
  function logActivity(pillar, kind) {
    var log = S.get("activity", []);
    log.push({ date: utcDay(), at: nowIso(), pillar: pillar, kind: kind });
    if (log.length > 5000) log = log.slice(-5000);
    S.set("activity", log);
    try { window.dispatchEvent(new CustomEvent("cc-activity", { detail: { pillar: pillar, kind: kind } })); } catch (_) {}
  }
  function weekStart(d) { // Monday (UTC) of the week containing d
    var x = d ? new Date(d + "T00:00:00Z") : new Date(utcDay() + "T00:00:00Z");
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x.toISOString().slice(0, 10);
  }
  function addDays(day, n) { var x = new Date(day + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }

  /* ------------------------------------------------------------------ */
  /* puzzles                                                             */
  /* ------------------------------------------------------------------ */
  var THEME_WHY = {
    fork: "one piece attacks two targets at once", pin: "a piece is pinned and cannot move without losing more",
    skewer: "a valuable piece is attacked and must move, exposing the piece behind it",
    discoveredAttack: "moving one piece unmasks an attack from another", discoveredCheck: "a discovered check wins time",
    doubleCheck: "a double check forces the king to move", hangingPiece: "an undefended piece can simply be taken",
    deflection: "a defender is lured away from its duty", attraction: "a piece is lured onto a fatal square",
    capturingDefender: "removing the defender wins what it protected", trappedPiece: "a piece has no safe squares left",
    xRayAttack: "an attack works through another piece", intermezzo: "an in-between move changes the outcome",
    clearance: "a square or line is cleared for another piece", interference: "a line between enemy pieces is cut",
    quietMove: "a quiet move sets up an unstoppable threat", sacrifice: "material is given up for a decisive gain",
    exposedKing: "the exposed king cannot be defended", advancedPawn: "an advanced pawn decides the game",
    promotion: "a pawn promotes", defensiveMove: "the only move holds the position", zugzwang: "the opponent must weaken their position",
    attackingF2F7: "the weak f2/f7 square collapses", castling: "castling is the strongest move", enPassant: "en passant is the key capture",
    collinearMove: "pieces on the same line work together", rookEndgame: "precise rook-endgame technique wins",
    pawnEndgame: "king-and-pawn technique decides", bishopEndgame: "bishop-endgame technique decides",
    knightEndgame: "knight-endgame technique decides", queenEndgame: "queen-endgame technique decides",
    queenRookEndgame: "heavy pieces coordinate", backRankMate: "the back rank is weak", smotheredMate: "the king is smothered by its own pieces",
    mateIn1: "it is checkmate", mateIn2: "it forces mate in two", mateIn3: "it forces mate in three", mateIn4: "it forces mate in four", mateIn5: "it forces a long mate",
    advantage: "it wins decisive material or position", mate: "it forces checkmate", material: "it wins material", tactic: "it is the only move that keeps the advantage",
  };
  var THEME_LABEL = function (t) { return String(t || "tactic").replace(/([A-Z])/g, " $1").replace(/^./, function (c) { return c.toUpperCase(); }).replace(/In (\d)/, " in $1"); };

  async function puzzlePool() {
    var data = await loadData("puzzles.json");
    var user = S.get("userPuzzles", []);
    return data.puzzles.concat(user);
  }
  async function findPuzzle(id) {
    var pool = await puzzlePool();
    var p = pool.find(function (x) { return x.id === id; });
    if (!p) fail(404, "puzzle_not_found");
    return p;
  }
  /* v42: no assembled "works because" sentence — a question to answer first,
     the line, and the matching principle from knowledge.json */
  var THEME_KNOW = { fork: "k-tc-02", pin: "k-tc-02", skewer: "k-tc-02", discoveredAttack: "k-tc-02", discoveredCheck: "k-tc-02",
    hangingPiece: "k-tc-02", doubleCheck: "k-tc-02", trappedPiece: "k-tc-02", xRayAttack: "k-tc-02", capturingDefender: "k-tc-02",
    deflection: "k-tc-02", interference: "k-tc-02", clearance: "k-tc-02",
    mateIn1: "k-ks-02", mateIn2: "k-ks-02", mateIn3: "k-ks-02", mateIn4: "k-ks-02", mate: "k-ks-02", exposedKing: "k-ks-02",
    attackingF2F7: "k-ks-02", sacrifice: "k-ks-02", backRankMate: "k-ks-02", smotheredMate: "k-ks-02", attraction: "k-ks-02",
    rookEndgame: "k-eg-03", pawnEndgame: "k-eg-04", zugzwang: "k-eg-04", bishopEndgame: "k-eg-04", knightEndgame: "k-eg-04",
    queenEndgame: "k-eg-05", queenRookEndgame: "k-eg-05", advancedPawn: "k-eg-01", promotion: "k-eg-01",
    quietMove: "k-me-01", defensiveMove: "k-me-01", intermezzo: "k-me-01" };
  var KNOW = null;
  loadData("knowledge.json").then(function (d) { KNOW = {}; (d.entries || []).forEach(function (e) { KNOW[e.id] = e; }); }).catch(function () {});
  function knowledgeFor(themes) {
    if (!KNOW) return null;
    for (var i = 0; i < themes.length; i++) { var e = KNOW[THEME_KNOW[themes[i]]]; if (e) return { id: e.id, title: e.title, text: e.text }; }
    return null;
  }
  function puzzleQuestion(p, themes) {
    var s = p.solution_san, side = p.side_to_move === "black" ? "Black" : "White", has = function (t) { return themes.indexOf(t) !== -1; };
    var first = s[0], after = s.length > 2 ? s[0] + " " + s[1] : first;
    if (themes.some(function (t) { return /^mate/.test(t) || /Mate$/.test(t); })) return "Before you read on: after " + first + ", which squares can the king still use, and what covers each one?";
    if (has("fork") || has("doubleCheck") || has("discoveredAttack") || has("discoveredCheck")) return "Name the two things " + first + " hits at once. Which one can the opponent not save?";
    if (has("pin") || has("skewer") || has("xRayAttack")) return "After " + first + ", which piece is stuck on its line, and what stands behind it?";
    if (has("deflection") || has("attraction") || has("capturingDefender") || has("interference") || has("clearance")) return "Which defender does " + first + " pull away or cut off, and what was it guarding?";
    if (has("quietMove") || has("zugzwang") || has("defensiveMove")) return first + " is not a check or a capture. What does it stop, or what does it threaten next?";
    if (themes.some(function (t) { return /Endgame$/.test(t); })) return "Why is " + first + " the right square in this ending? What goes wrong with the natural alternative?";
    if (has("sacrifice") || has("exposedKing")) return "What does " + side + " get back for the material after " + after + "?";
    return s.length > 2 ? "After " + after + ", what is the follow-up, and why can the reply not avoid it?" : "What did " + first + " attack that was not defended enough?";
  }
  function puzzleWhy(p) {
    var themes = (p.themes && p.themes.length ? p.themes : [p.theme]);
    if (p.origin === "olympiad") {
      var oq = "In the game " + (p.played_san || "another move") + " was played here (" + (p.fam_name || "a blunder") + "). What did it allow, and what does " + p.solution_san[0] + " take away from the opponent?";
      return { text: oq, question: oq, line: p.solution_san.join(" ") + (p.best_line ? "  (engine: " + p.best_line + ")" : ""),
        principle: p.habit ? { id: "olympiad", title: "Habit: " + (p.fam_name || "blunder check"), text: p.habit } : knowledgeFor(themes) };
    }
    var q = puzzleQuestion(p, themes);
    return { text: q, question: q, line: p.solution_san.join(" "), principle: knowledgeFor(themes) };
  }
  function pubPuzzle(p) {
    return { id: p.id, fen: p.fen, side_to_move: p.side_to_move, theme: THEME_LABEL(p.theme), rating: p.rating,
      themes: (p.themes || []).map(THEME_LABEL), source: p.source || "lichess",
      url: p.url || null, note: p.note || null, set: p.set || null, label: p.label || null };
  }

  route("GET", "/api/puzzles/library-stats", async function () {
    var data = await loadData("puzzles.json");
    var user = S.get("userPuzzles", []);
    var hist = S.get("puzzleHistory", {});
    var ownMissed = data.puzzles.filter(function (p) { return p.set === "my-missed" || p.source === "own-missed"; }).length;
    var defend = data.puzzles.filter(function (p) { return p.set === "defend-it" || p.source === "own-allowed"; }).length;
    return { total_puzzles: data.puzzles.length + user.length, static_puzzles: data.puzzles.length, user_puzzles: user.length,
      solved: Object.keys(hist).filter(function (k) { return hist[k].solved; }).length,
      my_missed: ownMissed, defend_it: defend };
  });

  route("POST", "/api/puzzle/next", async function (b) {
    var pool = await puzzlePool();
    var set = b.set || "all";
    if (set && set !== "all") {
      pool = pool.filter(function (p) { return p.set === set || (set === "my-missed" && p.source === "own-missed") || (set === "defend-it" && p.source === "own-allowed"); });
    }
    var seen = new Set(b.seen_ids || []);
    var hist = S.get("puzzleHistory", {});
    var lo = b.min_rating || 0, hi = b.max_rating || 99999;
    var inRange = pool.filter(function (p) { return (p.rating || 1000) >= lo && (p.rating || 1000) <= hi; });
    if (!inRange.length) inRange = pool;
    // prefer: user-built puzzles not yet solved, then unseen + unsolved, then unseen, then anything
    var tiers = [
      inRange.filter(function (p) { return p.source === "user" && !seen.has(p.id) && !(hist[p.id] && hist[p.id].solved); }),
      inRange.filter(function (p) { return !seen.has(p.id) && !hist[p.id]; }),
      inRange.filter(function (p) { return !seen.has(p.id) && !(hist[p.id] && hist[p.id].solved); }),
      inRange.filter(function (p) { return !seen.has(p.id); }),
      inRange,
    ];
    // v43: a fresh "Train these blunders" batch from the Olympiad comes first, in the order it was sent
    if (S.get("puzzlePrefer", null) === "olympiad") {
      var oly = pool.filter(function (p) { return p.origin === "olympiad" && !seen.has(p.id) && !(hist[p.id] && (hist[p.id].solved || hist[p.id].revealed)); })
        .sort(function (x, y) { return (x.batch_ix || 0) - (y.batch_ix || 0); });
      if (oly.length) return pubPuzzle(oly[0]);
      S.del("puzzlePrefer");
    }
    var choice = null;
    for (var i = 0; i < tiers.length && !choice; i++) if (tiers[i].length) choice = pick(tiers[i]);
    if (!choice) fail(404, "no_puzzles");
    return pubPuzzle(choice);
  });

  route("POST", "/api/puzzle/hint", async function (b) {
    var p = await findPuzzle(b.id);
    var f = moveFacts(p.fen, p.moves_uci[0]);
    var level = b.level >= 2 ? 2 : 1;
    var text = level === 1
      ? "Look for a " + PIECE_NAME[f.piece] + " move" + (f.check ? " that gives check." : f.captured ? " that captures." : ".")
      : "The " + PIECE_NAME[f.piece] + " on " + f.from + " is the key piece.";
    var hist = S.get("puzzleHistory", {});
    hist[p.id] = Object.assign(hist[p.id] || {}, { hinted: level });
    S.set("puzzleHistory", hist);
    return { id: p.id, level: level, text: text };
  });

  route("POST", "/api/puzzle/attempt", async function (b) {
    var p = await findPuzzle(b.id);
    var moves = b.moves_uci || [];
    var sol = p.moves_uci;
    var progress = 0, wrong = false, altOk = false;
    var ch = tryChess(p.fen);
    for (var i = 0; i < moves.length; i++) {
      var expect = sol[2 * i];
      if (moves[i] === expect) {
        progress++;
        tryMove(ch, moves[i]);
        if (sol[2 * i + 1]) tryMove(ch, sol[2 * i + 1]);
        continue;
      }
      // any mating move is accepted as the final solving move
      var test = tryChess(ch.fen()), m = test && tryMove(test, moves[i]);
      if (m && test.isCheckmate() && 2 * i + 1 >= sol.length - 1) { progress++; continue; }
      if (p.origin === "olympiad" && sol.length === 1 && i === 0 && m) {
        try {
          var root = await analysePos(p.fen, { depth: 12, movetime: 1200, multipv: 1, priority: "high" });
          var aft = await analysePos(test.fen(), { depth: 12, movetime: 1200, multipv: 1, priority: "high" });
          var bestCp = root.lines[0] ? capCp(evCp(root.lines[0].eval)) : null;
          var mineCp = aft.terminal ? (test.isCheckmate() ? 1500 : 0) : (aft.lines[0] ? -capCp(evCp(aft.lines[0].eval)) : null);
          if (bestCp !== null && mineCp !== null && bestCp - mineCp <= 40) { progress++; altOk = true; continue; }
        } catch (_) { /* fall through: treat as wrong */ }
      }
      wrong = true; break;
    }
    var solverMoves = Math.ceil(sol.length / 2);
    var solved = !wrong && progress >= solverMoves;
    var hist = S.get("puzzleHistory", {});
    var h = hist[p.id] || {};
    h.attempts = (h.attempts || 0) + 1; h.last = nowIso();
    if (solved) { h.solved = true; h.solved_at = nowIso(); }
    if (wrong) h.failed = (h.failed || 0) + 1;
    if (wrong && !h.miss_sent) {
      h.miss_sent = true;
      try { var mc = tryChess(p.fen); for (var mi = 0; mi < progress; mi++) { tryMove(mc, sol[2 * mi]); if (sol[2 * mi + 1]) tryMove(mc, sol[2 * mi + 1]); }
        addMisses([{ fen_before: mc.fen(), best_uci: sol[2 * progress], uci: moves[progress], title: "Puzzle " + THEME_LABEL(p.theme) + " (" + p.rating + ")",
          explanation: puzzleWhy(p).question, motif: /mate/i.test(p.theme) ? "missed_mate" : "missed_capture" }], "puzzle"); } catch (_) {}
    }
    hist[p.id] = h; S.set("puzzleHistory", hist);
    if (solved) logActivity("tactics", "puzzle");
    return {
      id: p.id, solved: solved, progress: wrong ? progress : progress,
      correct_line_san: p.solution_san, total_moves: solverMoves,
      message: solved ? (altOk ? "Good — that holds the position too (within 0.4). The engine's first choice was " + p.solution_san[0] + "." : "Solved! Well done.") : wrong ? "Not the best move — try again." : "Correct — keep going.",
      why: solved ? puzzleWhy(p) : null,
    };
  });

  route("POST", "/api/puzzle/reveal", async function (b) {
    var p = await findPuzzle(b.id);
    var hist = S.get("puzzleHistory", {});
    if (!(hist[p.id] && hist[p.id].miss_sent)) {
      try { addMisses([{ fen_before: p.fen, best_uci: p.moves_uci[0], title: "Puzzle " + THEME_LABEL(p.theme) + " (" + p.rating + ")", explanation: puzzleWhy(p).question,
        motif: /mate/i.test(p.theme) ? "missed_mate" : "missed_capture" }], "puzzle"); } catch (_) {}
    }
    hist[p.id] = Object.assign(hist[p.id] || {}, { revealed: true, last: nowIso(), miss_sent: true });
    S.set("puzzleHistory", hist);
    return { id: p.id, solution_san: p.solution_san, solution_uci: p.moves_uci, why: puzzleWhy(p), context: p.context || null };
  });

  /* verify "a unique, settled best move" and save into the user puzzle store */
  async function puzzleFromPosition(fen, context, priority) {
    var a = await analysePos(fen, { depth: 14, movetime: 3000, multipv: 2, priority: priority || "high" });
    if (a.terminal || !a.lines.length) return null;
    var best = capCp(evCp(a.lines[0].eval));
    var second = a.lines[1] ? capCp(evCp(a.lines[1].eval)) : -1500;
    var isMate = a.lines[0].eval.type === "mate" && a.lines[0].eval.value > 0;
    if (!(isMate || (best >= 150 && best - second >= 150))) return null;
    var pv = a.lines[0].moves_uci;
    // keep a forcing continuation only while the solver's moves stay unique-ish: 1 move, or 3 plies for mates
    var len = isMate ? Math.min(pv.length, Math.max(1, a.lines[0].eval.value * 2 - 1)) : 1;
    var ucis = pv.slice(0, len);
    var sans = uciToSanLine(fen, ucis);
    var f = moveFacts(fen, ucis[0]);
    var theme = isMate ? ("mateIn" + Math.min(5, a.lines[0].eval.value)) : f.captured ? "material" : f.check ? "tactic" : "quietMove";
    return {
      id: "u:" + hashStr(fen.split(" ").slice(0, 4).join(" ") + ucis[0]),
      fen: fen, side_to_move: sideName(fen.split(" ")[1]), moves_uci: ucis, solution_san: sans,
      rating: clamp(Math.round(1000 + (best - second) / 4 + (len > 1 ? 200 : 0)), 800, 2200),
      theme: theme, themes: [theme], source: "user", context: context || null, created_at: nowIso(),
    };
  }
  function saveUserPuzzles(list) {
    var store = S.get("userPuzzles", []);
    var ids = new Set(store.map(function (p) { return p.id; }));
    var added = 0;
    list.forEach(function (p) { if (!ids.has(p.id)) { store.push(p); ids.add(p.id); added++; } });
    S.set("userPuzzles", store.slice(-1500));
    return added;
  }

  route("POST", "/api/puzzles/from-fen", async function (b) {
    var ch = tryChess(b.fen);
    if (!ch) fail(400, "invalid_fen");
    if (gameStatus(ch).terminal) fail(422, "no_clear_puzzle");
    var p = await puzzleFromPosition(ch.fen(), "Made from a position you were studying.");
    if (!p) fail(422, "no_clear_puzzle");
    var added = saveUserPuzzles([p]);
    return { created: added > 0, puzzle: pubPuzzle(p) };
  });

  async function puzzlesFromGame(pgn, priority) {
    var a = await analyseGame(pgn, 12, { priority: priority || "normal", movetime: priority === "low" ? 600 : 1500 });
    var cands = a.moves.filter(function (mv) { return mv.cpl >= 200 && mv.best_uci && mv.best_uci !== mv.uci; })
      .sort(function (x, y) { return y.cpl - x.cpl; }).slice(0, 6);
    var out = [];
    for (var i = 0; i < cands.length; i++) {
      var mv = cands[i];
      var p = await puzzleFromPosition(mv.fen_before, a.white + " vs " + a.black + ", move " + Math.ceil(mv.ply / 2) +
        ": the game continued " + mv.san + " instead.", priority);
      if (p) { p.game = a.white + " vs " + a.black; out.push(p); }
    }
    return { puzzles: out, analysis: a };
  }
  route("POST", "/api/puzzles/from-game", async function (b) {
    var r = await puzzlesFromGame(b.pgn, "normal");
    var added = b.persist === false ? 0 : saveUserPuzzles(r.puzzles);
    return { puzzles: r.puzzles.map(pubPuzzle), count: r.puzzles.length, persisted: added };
  });

  var buildJobs = {};
  route("POST", "/api/puzzles/build-from-library", function (b) {
    if (Object.keys(buildJobs).some(function (k) { return buildJobs[k].status === "running"; })) fail(409, "build_running");
    var lib = S.get("games", []);
    var max = clamp(b.max_games || 50, 1, 500);
    var games = lib.slice(0, max);
    if (!games.length) return { total_games: 0, job_id: null };
    var id = uid("job");
    var job = buildJobs[id] = { status: "running", processed: 0, total: games.length, candidates: 0, added: 0, games_with_puzzles: 0, by_theme: {}, error: null };
    (async function () {
      try {
        for (var i = 0; i < games.length; i++) {
          try {
            var r = await puzzlesFromGame(games[i].pgn, "low");
            if (r.puzzles.length) job.games_with_puzzles++;
            job.candidates += r.puzzles.length;
            r.puzzles.forEach(function (p) { job.by_theme[THEME_LABEL(p.theme)] = (job.by_theme[THEME_LABEL(p.theme)] || 0) + 1; });
            job.added += saveUserPuzzles(r.puzzles);
          } catch (e) { /* skip unreadable game */ }
          job.processed = i + 1;
        }
        job.focus_themes = Object.keys(job.by_theme).sort(function (x, y) { return job.by_theme[y] - job.by_theme[x]; }).slice(0, 3);
        job.status = "done";
      } catch (e) { job.status = "error"; job.error = e.message; }
    })();
    return { total_games: games.length, job_id: id };
  });
  route("GET", "/api/puzzles/build-status/:id", function (b, q, p) {
    var job = buildJobs[p.id];
    if (!job) fail(404, "unknown_job");
    return job;
  });

  /* ------------------------------------------------------------------ */
  /* flashcards (SM-2)                                                   */
  /* ------------------------------------------------------------------ */
  function cards() { return S.get("flashcards", []); }
  function saveCards(c) { S.set("flashcards", c); }
  function endOfTodayIso() { var d = new Date(); d.setHours(23, 59, 59, 999); return d.toISOString(); }
  function cardFromMistake(m, source) {
    var ch = tryChess(m.fen_before);
    if (!ch || !m.best_uci) return null;
    var best = moveFacts(m.fen_before, m.best_uci);
    if (!best) return null;
    var played = m.uci ? moveFacts(m.fen_before, m.uci) : null;
    var motif = m.motif && MOTIF_LABELS[m.motif] ? m.motif : "positional";
    return {
      id: "c" + hashStr(m.fen_before + m.best_uci), fen_before: ch.fen(), best_uci: m.best_uci, best_san: best.san,
      played_uci: m.uci || null, played_san: played ? played.san : (m.san || null),
      title: m.title || "", explanation: m.explanation || "", motif: motif, source: source || "",
      hint: hintForMove(m.fen_before, m.best_uci), classification: m.classification || null,
      ease: 2.5, interval: 0, reps: 0, lapses: 0, due_at: nowIso(), created_at: nowIso(),
    };
  }
  function addCards(list, source) {
    var deck = cards(), ids = new Set(deck.map(function (c) { return c.id; }));
    var added = 0, present = 0, invalid = 0, relapsed = 0, newIds = [];
    list.forEach(function (m) {
      var c = cardFromMistake(m, source);
      if (!c) { invalid++; return; }
      if (ids.has(c.id)) {
        present++;
        if (m.force_due) { deck.forEach(function (d) { if (d.id === c.id) { d.due_at = nowIso(); relapsed++; } }); }
        return;
      }
      deck.push(c); ids.add(c.id); added++; newIds.push(c.id);
    });
    saveCards(deck);
    return { added: added, already_present: present, skipped_invalid: invalid, relapsed: relapsed, ids: newIds };
  }
  function reviews() { return S.get("fcReviews", []); }
  function fcStats() {
    var deck = cards(), rv = reviews();
    var eod = endOfTodayIso();
    var weekAgo = Date.now() - 7 * 86400000;
    var recent = rv.filter(function (r) { return Date.parse(r.at) >= weekAgo; });
    var days = new Set(rv.map(function (r) { return utcDay(r.at); }));
    var streak = 0, d = utcDay();
    if (!days.has(d)) d = addDays(d, -1);
    while (days.has(d)) { streak++; d = addDays(d, -1); }
    return {
      total: deck.length, due_today: deck.filter(function (c) { return c.due_at <= eod; }).length,
      retention_7d: recent.length ? recent.filter(function (r) { return r.grade !== "again"; }).length / recent.length : null,
      current_streak: streak, reviewed_today: rv.filter(function (r) { return utcDay(r.at) === utcDay(); }).length,
      quarantined_total: 0,
    };
  }
  function pubCard(c) { var o = clone(c); return o; }

  route("GET", "/api/flashcards/stats", function () { return fcStats(); });
  /* v42: a miss anywhere (attacks, puzzles, calculation, lessons) becomes a
     flashcard and joins the rolling "Training misses" Woodpecker set */
  var MISS_SET_ID = "set-misses";
  function addMisses(items, source) {
    var r = addCards(items.map(function (m) { return Object.assign({ force_due: true }, m); }), source || "miss");
    var byId = {}; cards().forEach(function (c) { byId[c.id] = c; });
    var ids = items.map(function (m) { return "c" + hashStr((tryChess(m.fen_before) ? tryChess(m.fen_before).fen() : m.fen_before) + m.best_uci); });
    var all = sets(), s = all.find(function (x) { return x.id === MISS_SET_ID; });
    if (!s) { s = { id: MISS_SET_ID, name: "Training misses", kind: "source", value: "miss", cards: [], cycles: [], prs: {}, created_at: nowIso() }; all.push(s); }
    var have = new Set(s.cards.map(function (c) { return c.id; }));
    ids.forEach(function (id) { var c = byId[id]; if (c && !have.has(id)) { have.add(id); s.cards.push({ id: c.id, fen_before: c.fen_before, best_uci: c.best_uci, best_san: c.best_san,
      played_san: c.played_san, played_uci: c.played_uci, title: c.title, hint: c.hint, motif: c.motif, explanation: c.explanation }); } });
    s.cards = s.cards.slice(-60);
    saveSets(all);
    return { added: r.added, already_present: r.already_present, set_size: s.cards.length };
  }
  route("POST", "/api/misses/add", function (b) { return addMisses(b.items || [], String(b.source || "miss").slice(0, 24)); });
  route("POST", "/api/flashcards/add", function (b) {
    var r = addCards(b.mistakes || [], b.source || "");
    return { added: r.added, already_present: r.already_present, skipped_invalid: r.skipped_invalid };
  });
  function dueCards(limit) {
    var eod = endOfTodayIso();
    return cards().filter(function (c) { return c.due_at <= eod; })
      .sort(function (a, b) { return a.due_at < b.due_at ? -1 : 1; }).slice(0, limit || 20);
  }
  route("GET", "/api/flashcards/due", function (b, q) { return { cards: dueCards(parseInt(q.limit, 10) || 20).map(pubCard) }; });
  route("GET", "/api/flashcards/queue", function (b, q) {
    var due = dueCards(parseInt(q.cap, 10) || 20);
    // interleave across sources/motifs: round-robin by source
    var groups = {};
    due.forEach(function (c) { (groups[c.source || c.motif] = groups[c.source || c.motif] || []).push(c); });
    var keys = Object.keys(groups), mixed = [];
    while (mixed.length < due.length) keys.forEach(function (k) { var c = groups[k].shift(); if (c) mixed.push(c); });
    var motifKeys = Object.keys(MOTIF_LABELS);
    return { entries: mixed.map(function (c, i) {
      var e = { card: pubCard(c) };
      if (q.interleave !== "false" && i % 3 === 2) {
        var others = motifKeys.filter(function (m) { return m !== c.motif; }).sort(function () { return Math.random() - 0.5; }).slice(0, 2);
        var options = others.concat([c.motif]).sort(function () { return Math.random() - 0.5; });
        var labels = {}; options.forEach(function (m) { labels[m] = MOTIF_LABELS[m]; });
        e.motif_quiz = { options: options, correct: c.motif, labels: labels };
      }
      return e;
    }) };
  });
  function sm2(c, grade) {
    var q = { again: 1, hard: 3, good: 4, easy: 5 }[grade] || 4;
    if (q < 3) { c.reps = 0; c.interval = 0; c.lapses = (c.lapses || 0) + 1; c.due_at = new Date(Date.now() + 10 * 60000).toISOString(); }
    else {
      c.reps = (c.reps || 0) + 1;
      c.interval = c.reps === 1 ? 1 : c.reps === 2 ? (q === 5 ? 4 : 3) : Math.round((c.interval || 1) * c.ease * (q === 3 ? 0.8 : q === 5 ? 1.3 : 1));
      c.due_at = new Date(Date.now() + c.interval * 86400000).toISOString();
    }
    c.ease = Math.max(1.3, (c.ease || 2.5) + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    c.last_review = nowIso();
    return c;
  }
  route("POST", "/api/flashcards/review", function (b) {
    var deck = cards();
    var c = deck.find(function (x) { return x.id === b.id; });
    if (!c) fail(404, "card_not_found");
    sm2(c, b.grade);
    saveCards(deck);
    var rv = reviews(); rv.push({ id: c.id, grade: b.grade, at: nowIso(), solve_ms: b.solve_ms || null });
    S.set("fcReviews", rv.slice(-3000));
    logActivity("tactics", "flashcards");
    return { card: pubCard(c) };
  });
  route("POST", "/api/flashcards/motif-answer", function (b) {
    var deck = cards();
    var c = deck.find(function (x) { return x.id === b.id; });
    if (!c) fail(404, "card_not_found");
    if (b.chosen === c.motif) return { ok: true, correct: c.motif, correct_label: MOTIF_LABELS[c.motif] };
    sm2(c, "again"); saveCards(deck);
    var rv = reviews(); rv.push({ id: c.id, grade: "again", at: nowIso(), motif_miss: true }); S.set("fcReviews", rv.slice(-3000));
    return { ok: false, correct: c.motif, correct_label: MOTIF_LABELS[c.motif],
      note: "The motif was: " + MOTIF_LABELS[c.motif] + ". The card is due again shortly." };
  });

  /* ------------------------------------------------------------------ */
  /* Woodpecker cycles                                                   */
  /* ------------------------------------------------------------------ */
  function sets() { return S.get("cycleSets", []); }
  function saveSets(s) { S.set("cycleSets", s); }
  function setSummary(s) {
    var last = s.cycles[s.cycles.length - 1] || null;
    return { id: s.id, name: s.name, kind: s.kind, value: s.value, size: s.cards.length, created_at: s.created_at,
      cycles_completed: s.cycles.length, last_cycle: last, prs: s.prs || {} };
  }
  route("GET", "/api/cycles/sets", function () {
    var motifs = {};
    cards().forEach(function (c) { motifs[c.motif] = (motifs[c.motif] || 0) + 1; });
    return { sets: sets().map(setSummary), motifs: motifs, motif_labels: MOTIF_LABELS };
  });
  route("POST", "/api/cycles/sets", function (b) {
    var deck = cards().slice().sort(function (a, c) { return a.created_at < c.created_at ? 1 : -1; });
    var v = b.value == null ? "" : String(b.value).trim();
    var chosen;
    if (b.kind === "last_n") chosen = deck.slice(0, parseInt(v, 10) || 20);
    else if (b.kind === "source") chosen = deck.filter(function (c) { return !v || (c.source || "").toLowerCase().indexOf(v.toLowerCase()) !== -1; });
    else if (b.kind === "motif") chosen = deck.filter(function (c) { return !v || c.motif === v || (MOTIF_LABELS[c.motif] || "").toLowerCase().indexOf(v.toLowerCase()) !== -1; });
    else chosen = dueCards(500);
    if (!chosen.length) fail(400, "No cards match — add mistake flashcards first (Puzzles tab).");
    var s = { id: uid("set"), name: String(b.name || "Set").slice(0, 120), kind: b.kind, value: v || null,
      cards: chosen.map(function (c) { return { id: c.id, fen_before: c.fen_before, best_uci: c.best_uci, best_san: c.best_san,
        played_san: c.played_san, played_uci: c.played_uci, title: c.title, hint: c.hint, motif: c.motif, explanation: c.explanation }; }),
      cycles: [], prs: {}, created_at: nowIso() };
    var all = sets(); all.push(s); saveSets(all);
    return setSummary(s);
  });
  function findSet(id) { var all = sets(); var s = all.find(function (x) { return x.id === id; }); if (!s) fail(404, "set_not_found"); return { all: all, s: s }; }
  route("GET", "/api/cycles/sets/:id", function (b, q, p) { var r = findSet(p.id); return Object.assign(setSummary(r.s), { cycles: r.s.cycles, cards: r.s.cards }); });
  route("POST", "/api/cycles/sets/:id/rename", function (b, q, p) { var r = findSet(p.id); r.s.name = String(b.name || r.s.name).slice(0, 120); saveSets(r.all); return setSummary(r.s); });
  route("POST", "/api/cycles/sets/:id/delete", function (b, q, p) { var all = sets().filter(function (x) { return x.id !== p.id; }); saveSets(all); return { ok: true }; });
  route("POST", "/api/cycles/sets/:id/cycles/start", function (b, q, p) {
    var r = findSet(p.id), s = r.s;
    var last = s.cycles[s.cycles.length - 1];
    var tooSoon = !!(last && Date.now() - Date.parse(last.finished_at) < 24 * 3600000);
    return { cycle_no: s.cycles.length + 1, cards: s.cards, too_soon: tooSoon,
      warning: tooSoon ? "Your last cycle on this set finished less than 24 hours ago — repeating this soon trains short-term memory more than pattern recognition. Click Start again to go anyway." : null };
  });
  route("POST", "/api/cycles/sets/:id/cycles/finish", function (b, q, p) {
    var r = findSet(p.id), s = r.s;
    var recs = b.records || [];
    var solved = recs.filter(function (x) { return x.solved; }).length;
    var totalMs = recs.reduce(function (a, x) { return a + (x.think_ms || 0) + (x.incremental_ms || 0); }, 0);
    var scoreOf = function (x) { if (!x.solved) return 0; var eff = (x.think_ms || 0) + 2 * (x.incremental_ms || 0); return clamp(Math.round(100 * (1 - (eff - 5000) / 55000)), 0, 100); };
    var cycle = { cycle_no: s.cycles.length + 1, finished_at: nowIso(), cards: recs.length,
      accuracy: recs.length ? solved / recs.length : 0, avg_ms: recs.length ? Math.round(totalMs / recs.length) : null,
      total_ms: totalMs, avg_score: recs.length ? recs.reduce(function (a, x) { return a + scoreOf(x); }, 0) / recs.length : null };
    var prev = s.cycles[s.cycles.length - 1];
    if (prev) cycle.deltas = { accuracy: cycle.accuracy - (prev.accuracy || 0), avg_ms: (cycle.avg_ms || 0) - (prev.avg_ms || 0) };
    var prs = s.prs || {}, newPrs = [], out = {};
    var solvedAvg = solved ? Math.round(recs.filter(function (x) { return x.solved; }).reduce(function (a, x) { return a + x.think_ms + x.incremental_ms; }, 0) / solved) : null;
    function pr(key, field, val, better) {
      if (val == null) return;
      var old = prs[field];
      if (old == null) { prs[field] = val; out["pr_" + field] = { value: val, previous: null }; return; } // baseline
      if (better(val, old)) { newPrs.push(key); out["pr_" + field] = { value: val, previous: old }; prs[field] = val; }
      else out["pr_" + field] = { value: old, previous: null };
    }
    if (cycle.accuracy === 1) pr("fastest", "fastest_ms", totalMs, function (a, b2) { return a < b2; });
    pr("accuracy", "best_accuracy", cycle.accuracy, function (a, b2) { return a > b2; });
    pr("avg_solve", "fastest_avg_solve_ms", solvedAvg, function (a, b2) { return a < b2; });
    s.prs = prs;
    s.cycles.push(cycle);
    saveSets(r.all);
    logActivity("tactics", "cycle");
    var guard = s.cycles.length === 1 && cycle.accuracy < 0.6
      ? { message: "First pass under 60% accuracy — consider a smaller set so each cycle stays about pattern recognition, not guessing." } : null;
    return { cycle: cycle, guardrail: guard, new_prs: newPrs, prs: out };
  });
  route("GET", "/api/cycles/summary", function () {
    var latest = null;
    sets().forEach(function (s) {
      var c = s.cycles[s.cycles.length - 1];
      if (c && (!latest || c.finished_at > latest.finished_at)) latest = Object.assign({ set_name: s.name, set_id: s.id }, c);
    });
    return { latest: latest, sets: sets().length };
  });

  /* ------------------------------------------------------------------ */
  /* shared: opponent engine at a level, tablebase best move, claims     */
  /* ------------------------------------------------------------------ */
  var LEVEL_SKILL = { casual: 3, club: 8, advanced: 13, expert: 17, masters: 20 };
  var LEVEL_DEPTH = { casual: 6, club: 9, advanced: 12, expert: 14, masters: 16 };
  function levelOf(l) { return LEVEL_SKILL[l] != null ? l : "club"; }

  async function tbProbe(fen) {
    if (pieceCount(fen) > 7) return null;
    try {
      var r = await NATIVE_FETCH("https://tablebase.lichess.ovh/standard?fen=" + encodeURIComponent(normFen(fen)));
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }
  async function opponentMove(fen, level) {
    level = levelOf(level);
    var ch = mkChess(fen);
    var st = gameStatus(ch);
    if (st.terminal) return { terminal: true, result: st.result, reason: st.reason, fen: ch.fen() };
    var uci = null, source = "stockfish";
    // strong levels defend/convert with tablebase-perfect moves when the position is small
    if ((level === "expert" || level === "masters") && pieceCount(fen) <= 7) {
      var tb = await tbProbe(fen);
      if (tb && tb.moves && tb.moves.length) { uci = tb.moves[0].uci; source = "tablebase"; }
    }
    if (!uci) {
      var a = await analysePos(ch.fen(), { depth: LEVEL_DEPTH[level], movetime: 1200, multipv: 1, skill: LEVEL_SKILL[level], priority: "high" });
      uci = a.best;
    }
    var m = tryMove(ch, uci);
    if (!m) fail(503, "engine_unavailable");
    var st2 = gameStatus(ch);
    return { terminal: false, uci: m.lan || uci, san: m.san, fen: fen, fen_after: ch.fen(), source: source,
      after_terminal: st2.terminal, result: st2.result, reason: st2.reason };
  }

  /* verify a result claim for `side` ("white"/"black") on final_fen */
  async function verifyClaim(finalFen, side, result) {
    var ch = mkChess(finalFen), st = gameStatus(ch);
    var me = side === "white" ? "w" : "b";
    if (result === "loss") return { ok: true, result: "loss", detail: "resigned" };
    if (st.terminal) {
      var actual = st.result === "1/2-1/2" ? "draw" : ((st.result === "1-0") === (me === "w") ? "win" : "loss");
      if (actual !== result && !(result === "draw" && actual === "win")) return { ok: false, detail: "the board shows a " + actual + " (" + st.reason + ")" };
      return { ok: true, result: actual, detail: st.reason };
    }
    var tb = await tbProbe(ch.fen());
    if (tb && tb.category) {
      var cat = tb.category; // side-to-move POV
      if (ch.turn() !== me) cat = { win: "loss", loss: "win", "cursed-win": "blessed-loss", "blessed-loss": "cursed-win" }[cat] || cat;
      var isWin = cat === "win", isDraw = cat === "draw" || cat === "cursed-win" || cat === "blessed-loss";
      if (result === "win" && isWin) return { ok: true, result: "win", detail: "tablebase win" };
      if (result === "draw" && (isDraw || isWin)) return { ok: true, result: "draw", detail: "tablebase draw" };
      return { ok: false, detail: "the tablebase says this position is a " + cat + " for you" };
    }
    var a;
    try { a = await analysePos(ch.fen(), { depth: 16, movetime: 3000, multipv: 1, priority: "high" }); }
    catch (e) { fail(503, "engine_unavailable"); }
    var cp = capCp(evCp(a.eval)); if (ch.turn() !== me) cp = -cp;
    if (result === "win" && cp >= 500) return { ok: true, result: "win", detail: "engine +" + (cp / 100).toFixed(1) };
    if (result === "draw" && Math.abs(cp) <= 60) return { ok: true, result: "draw", detail: "engine eval " + (cp / 100).toFixed(2) };
    return { ok: false, detail: "the engine evaluates this position at " + (cp >= 0 ? "+" : "") + (cp / 100).toFixed(1) + " for you — " + (result === "win" ? "not yet a clear win" : "not a draw") };
  }
  function goalPassed(goal, result) { return goal === "win" ? result === "win" : result === "win" || result === "draw"; }

  /* colour-flip a position (mirror scenario) */
  function flipFen(fen) {
    var p = normFen(fen).split(" ");
    var rows = p[0].split("/").reverse().map(function (r) { return r.replace(/[a-zA-Z]/g, function (c) { return c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(); }); });
    var cast = p[2] === "-" ? "-" : p[2].split("").map(function (c) { return c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(); }).sort(function (a, b) { return "KQkq".indexOf(a) - "KQkq".indexOf(b); }).join("");
    var ep = p[3] === "-" ? "-" : p[3][0] + (p[3][1] === "3" ? "6" : "3");
    return [rows.join("/"), p[1] === "w" ? "b" : "w", cast, ep, p[4], p[5]].join(" ");
  }
  var attemptTokens = {};
  function mintToken(data) { var t = uid("att"); attemptTokens[t] = data; return t; }
  function takeToken(t) { var d = attemptTokens[t]; if (!d) fail(422, { detail: "unknown or expired attempt — restart the scenario" }); delete attemptTokens[t]; return d; }
  function claimFail(data, detail) {
    var retry = mintToken(data);
    throw new HttpError(422, { detail: detail, retry_token: retry });
  }
  async function hintFor(fen) {
    var ch = mkChess(fen), best = null, why = null;
    var tb = await tbProbe(ch.fen());
    if (tb && tb.moves && tb.moves.length) {
      best = tb.moves[0].uci;
      var c = tb.moves[0].category;
      var keeps = { loss: "win", win: "loss", draw: "draw", "blessed-loss": "win", "cursed-win": "draw" }[c] || "result";
      var dtm = tb.moves[0].dtm;
      why = { text: "The tablebase confirms the best move keeps the " + keeps + (keeps === "win" && dtm ? " (mate in " + Math.ceil(Math.abs(dtm) / 2) + ")" : "") + "." +
        (keeps === "draw" ? " Stay in the defensive zone and don't let the stronger king in." : " Keep your king active and watch out for stalemate.") };
    } else {
      var a = await analysePos(ch.fen(), { depth: 14, movetime: 2500, multipv: 1, priority: "high" });
      best = a.best;
      why = { text: "The engine line runs " + (a.lines[0] ? a.lines[0].moves_san.slice(0, 3).length + " moves deep" : "") + " — look for the move that improves your worst-placed piece." };
    }
    return { hint: hintForMove(ch.fen(), best), why: why };
  }

  /* ------------------------------------------------------------------ */
  /* sparring                                                            */
  /* ------------------------------------------------------------------ */
  function spState() { return S.get("sparring", { packs: [], results: {} }); }
  function spSave(s) { S.set("sparring", s); }
  // results[scenarioId][side] = {passed, due, passes, fails, last}
  function spSide(s, scId, side) {
    var r = (s.results[scId] = s.results[scId] || {});
    return r[side] || { passed: false, due: false, passes: 0, fails: 0 };
  }
  async function spScenarios() {
    var d = await loadData("endgames.json");
    var own = S.get("sparringOwn", []);
    return d.sparring.concat(own);
  }
  route("POST", "/api/sparring/packs/generate", async function (b) {
    var all = await spScenarios();
    var s = spState();
    // own scenarios: small endgame positions from mistake cards, goal from the tablebase
    var own = S.get("sparringOwn", []), ownIds = new Set(own.map(function (o) { return o.id; }));
    // v39: endgames reached in his own games (him to move) come first, then small positions from mistake cards
    var cand = S.get("mineEndgames", []).map(function (e) { return { id: "eg" + hashStr(e.fen), fen_before: e.fen, theme: "From your game " + e.label }; })
      .concat(cards().filter(function (c) { return pieceCount(c.fen_before) <= 7; }))
      .filter(function (c) { return !ownIds.has("own-" + c.id); }).slice(0, 4);
    for (var i = 0; i < cand.length; i++) {
      var tb = await tbProbe(cand[i].fen_before);
      if (!tb || !tb.category) continue;
      var turn = cand[i].fen_before.split(" ")[1];
      var goal = tb.category === "win" ? "win" : tb.category === "draw" ? "hold" : null;
      if (!goal) continue;
      var sc = { id: "own-" + cand[i].id, theme: cand[i].theme || "From your games", fen: cand[i].fen_before, goal: goal, user_side: sideName(turn), own: true };
      own.push(sc); all.push(sc);
    }
    S.set("sparringOwn", own);
    var fresh = all.filter(function (sc) { return !spSide(s, sc.id, sc.user_side).passed; });
    if (b && (b.side === "white" || b.side === "black")) {
      var mineSide = fresh.filter(function (sc) { return sc.user_side === b.side; });
      if (mineSide.length >= 4) fresh = mineSide.concat(fresh.filter(function (sc) { return sc.user_side !== b.side; }).slice(0, 2));
    }
    var pool = (fresh.length >= 4 ? fresh : all).slice().sort(function () { return Math.random() - 0.5; });
    var ownFirst = pool.filter(function (x) { return x.own; }).concat(pool.filter(function (x) { return !x.own; }));
    var chosen = ownFirst.slice(0, 6);
    var pack = { id: uid("pack"), name: "Pack " + (s.packs.length + 1) + " — " + utcDay(), scenario_ids: chosen.map(function (x) { return x.id; }), created_at: nowIso() };
    s.packs.unshift(pack); s.packs = s.packs.slice(0, 20); spSave(s);
    return { id: pack.id, name: pack.name, size: chosen.length };
  });
  async function packView(s, pack, full) {
    var all = await spScenarios();
    var scs = pack.scenario_ids.map(function (id) { return all.find(function (x) { return x.id === id; }); }).filter(Boolean);
    var v = { id: pack.id, name: pack.name, size: scs.length, created_at: pack.created_at,
      passed_primary: scs.filter(function (sc) { return spSide(s, sc.id, sc.user_side).passed; }).length,
      own_scenarios: scs.filter(function (sc) { return sc.own; }).length,
      due_count: scs.filter(function (sc) { return spSide(s, sc.id, "white").due || spSide(s, sc.id, "black").due; }).length,
      themes: Array.from(new Set(scs.map(function (sc) { return sc.theme; }))) };
    if (full) v.scenarios = scs.map(function (sc) { return { id: sc.id, theme: sc.theme, goal: sc.goal, user_side: sc.user_side,
      sides: { white: spSide(s, sc.id, "white"), black: spSide(s, sc.id, "black") } }; });
    return v;
  }
  route("GET", "/api/sparring/packs", async function () {
    var s = spState(), out = [];
    for (var i = 0; i < s.packs.length; i++) out.push(await packView(s, s.packs[i], false));
    return { packs: out };
  });
  route("GET", "/api/sparring/packs/:id", async function (b, q, p) {
    var s = spState(), pack = s.packs.find(function (x) { return x.id === p.id; });
    if (!pack) fail(404, "pack_not_found");
    return packView(s, pack, true);
  });
  route("GET", "/api/sparring/progress", async function () {
    var s = spState(), all = await spScenarios(), due = [], themes = {};
    all.forEach(function (sc) {
      ["white", "black"].forEach(function (side) {
        var r = s.results[sc.id] && s.results[sc.id][side];
        if (!r) return;
        if (r.due) due.push({ scenario_id: sc.id, side: side, theme: sc.theme });
        var t = themes[sc.theme] = themes[sc.theme] || { passes: 0, fails: 0, pass_rate: null };
        t.passes += r.passes || 0; t.fails += r.fails || 0;
      });
    });
    Object.keys(themes).forEach(function (k) { var t = themes[k]; t.pass_rate = t.passes + t.fails ? t.passes / (t.passes + t.fails) : null; });
    return { due: due, themes: themes };
  });
  route("POST", "/api/sparring/attempt/start", async function (b) {
    var sc = (await spScenarios()).find(function (x) { return x.id === b.scenario_id; });
    if (!sc) fail(404, "scenario_not_found");
    var side = b.user_side === "black" || b.user_side === "white" ? b.user_side : sc.user_side;
    var fen = side === sc.user_side ? normFen(sc.fen) : flipFen(sc.fen);
    var level = levelOf(b.level);
    var tok = mintToken({ kind: "sparring", scenario_id: sc.id, user_side: side, start_fen: fen, goal: sc.goal });
    return { scenario_id: sc.id, goal: sc.goal, theme: sc.theme, attempt_token: tok, fen: fen, side_to_move: fen.split(" ")[1], user_side: side,
      opponent: { type: "stockfish", skill: LEVEL_SKILL[level], level: level } };
  });
  route("POST", "/api/sparring/opponent-move", async function (b) { return opponentMove(b.fen, b.level); });
  route("POST", "/api/sparring/attempt/finish", async function (b) {
    var att = takeToken(b.attempt_token);
    var fen = normFen(b.final_fen);
    if (fen.split(" ").slice(0, 4).join(" ") === att.start_fen.split(" ").slice(0, 4).join(" ") && b.result !== "loss") claimFail(att, "no_moves_played");
    var v = await verifyClaim(fen, att.user_side, b.result);
    if (!v.ok) claimFail(att, "Claim rejected — " + v.detail);
    var passed = goalPassed(att.goal, v.result);
    var s = spState(), r = spSide(s, att.scenario_id, att.user_side);
    if (passed) { r.passes++; r.passed = true; r.due = false; } else { r.fails++; r.due = true; }
    r.last = nowIso();
    s.results[att.scenario_id][att.user_side] = r; spSave(s);
    logActivity("sparring", "scenario");
    return { passed: passed, goal: att.goal, result: v.result, verification: { detail: v.detail }, side: r };
  });
  route("POST", "/api/sparring/hint", async function (b) { return hintFor(b.fen); });

  /* ------------------------------------------------------------------ */
  /* endgame curriculum                                                  */
  /* ------------------------------------------------------------------ */
  function egState() { return S.get("endgame", { lessons: {}, placement: null, history: [] }); }
  function egSave(s) { S.set("endgame", s); }
  async function egCanon() {
    var d = await loadData("endgames.json"), s = egState();
    var tiers = {};
    d.canon.forEach(function (l) { (tiers[l.tier] = tiers[l.tier] || []).push(l); });
    var unlocked = Math.max(1, s.placement && s.placement.completed ? s.placement.recommended_tier : 1);
    var tierNums = Object.keys(tiers).map(Number).sort();
    tierNums.forEach(function (t) {
      if (t > 1 && tiers[t - 1] && tiers[t - 1].every(function (l) { return (s.lessons[l.id] || {}).passes > 0; })) unlocked = Math.max(unlocked, t);
    });
    var passed = 0;
    var out = tierNums.map(function (t) {
      return { tier: t, lessons: tiers[t].map(function (l) {
        var r = s.lessons[l.id] || { attempts: 0, passes: 0 };
        if (r.passes > 0) passed++;
        return { id: l.id, title: l.title, theme: l.theme, goal: l.goal, user_side: l.user_side, attempts: r.attempts, passes: r.passes,
          status: r.passes > 0 ? "passed" : t <= unlocked ? "available" : "locked" };
      }) };
    });
    return { passed: passed, total: d.canon.length, unlocked_tier: unlocked,
      placement: s.placement ? { completed: !!s.placement.completed, recommended_tier: s.placement.recommended_tier } : { completed: false, recommended_tier: null },
      tiers: out, data: d };
  }
  route("GET", "/api/endgame/canon", async function () { var c = await egCanon(); delete c.data; return c; });
  async function egLesson(id) {
    var d = await loadData("endgames.json");
    var l = d.canon.find(function (x) { return x.id === id; });
    if (!l) fail(404, "lesson_not_found");
    return l;
  }
  function egStartPayload(l, level, extra) {
    level = levelOf(level);
    var fen = normFen(l.fen);
    var tok = mintToken(Object.assign({ kind: "endgame", lesson_id: l.id, user_side: l.user_side, start_fen: fen, goal: l.goal }, extra || {}));
    return { lesson_id: l.id, title: l.title, explanation: l.explanation, theme: l.theme, goal: l.goal, user_side: l.user_side,
      attempt_token: tok, fen: fen, side_to_move: fen.split(" ")[1], opponent: { type: "stockfish", skill: LEVEL_SKILL[level], level: level } };
  }
  route("POST", "/api/endgame/lesson/:id/start", async function (b, q, p) {
    var c = await egCanon();
    var st = null; c.tiers.forEach(function (t) { t.lessons.forEach(function (l) { if (l.id === p.id) st = l.status; }); });
    if (st === "locked") fail(403, "lesson_locked — pass the previous tier first (or take the placement test)");
    return egStartPayload(await egLesson(p.id), b.level);
  });
  route("POST", "/api/endgame/lesson/:id/complete", async function (b, q, p) {
    var att = takeToken(b.attempt_token);
    if (att.lesson_id !== p.id) claimFail(att, "token does not match this lesson");
    var fen = normFen(b.final_fen);
    if (fen.split(" ").slice(0, 4).join(" ") === att.start_fen.split(" ").slice(0, 4).join(" ") && b.result !== "loss") claimFail(att, "no_moves_played");
    var v = await verifyClaim(fen, att.user_side, b.result);
    if (!v.ok) claimFail(att, "Claim rejected — " + v.detail);
    var passed = goalPassed(att.goal, v.result);
    var s = egState(), r = s.lessons[p.id] || { attempts: 0, passes: 0 };
    r.attempts++; if (passed) { r.passes++; r.passed_at = r.passed_at || nowIso(); }
    s.lessons[p.id] = r;
    s.history.push({ at: nowIso(), lesson_id: p.id, passed: passed });
    s.history = s.history.slice(-500);
    egSave(s);
    logActivity("endgame", "lesson");
    if (!passed) {
      // put the lesson's start position into the flashcard deck (best move from the tablebase)
      try {
        var tb = await tbProbe(att.start_fen);
        if (tb && tb.moves && tb.moves.length) {
          var l0 = await egLesson(p.id);
          addCards([{ fen_before: att.start_fen, best_uci: tb.moves[0].uci, title: "Endgame: " + l0.title, explanation: l0.explanation, motif: "positional" }], "endgame");
        }
      } catch (_) {}
    }
    var c = await egCanon(), lesson = await egLesson(p.id);
    var tier = c.tiers.find(function (t) { return t.tier === lesson.tier; });
    var tierComplete = passed && tier.lessons.every(function (l) { return l.status === "passed"; });
    var next = null;
    c.tiers.some(function (t) { return t.lessons.some(function (l) { if (l.status === "available") { next = { id: l.id, title: l.title }; return true; } return false; }); });
    return { passed: passed, goal: att.goal, result: v.result, verification: { detail: v.detail }, tier_complete: tierComplete, next_lesson: next };
  });
  route("POST", "/api/endgame/hint", async function (b) { return hintFor(b.fen); });

  var placementSessions = {};
  route("POST", "/api/endgame/placement/start", async function (b) {
    var d = await loadData("endgames.json");
    var sid = uid("plc");
    var ids = d.placement.slice();
    placementSessions[sid] = { ids: ids, index: 0, answers: [], level: levelOf(b.level) };
    var l = d.canon.find(function (x) { return x.id === ids[0]; });
    return Object.assign(egStartPayload(l, b.level, { session_id: sid, index: 0 }), { session_id: sid, index: 0, total: ids.length, title: "Placement — " + l.title });
  });
  route("POST", "/api/endgame/placement/answer", async function (b) {
    var sess = placementSessions[b.session_id];
    if (!sess) fail(404, "placement_session_not_found");
    var att = takeToken(b.attempt_token);
    var fen = normFen(b.final_fen);
    if (fen.split(" ").slice(0, 4).join(" ") === att.start_fen.split(" ").slice(0, 4).join(" ") && b.result !== "loss") claimFail(att, "no_moves_played");
    var v = await verifyClaim(fen, att.user_side, b.result);
    if (!v.ok) claimFail(att, "Claim rejected — " + v.detail);
    var passed = goalPassed(att.goal, v.result);
    var d = await loadData("endgames.json");
    var lesson = d.canon.find(function (x) { return x.id === att.lesson_id; });
    sess.answers.push({ id: att.lesson_id, tier: lesson.tier, passed: passed });
    sess.index++;
    logActivity("endgame", "placement");
    var out = { passed: passed, goal: att.goal, result: v.result, verification: { detail: v.detail }, done: false, index: sess.index, total: sess.ids.length };
    if (sess.index >= sess.ids.length) {
      var byTier = function (t) { var a = sess.answers.filter(function (x) { return x.tier === t; }); return a.length ? a.filter(function (x) { return x.passed; }).length / a.length : 0; };
      var rec = byTier(1) < 1 ? 1 : byTier(2) < 0.66 ? 2 : 3;
      var s = egState();
      s.placement = { completed: true, recommended_tier: rec, at: nowIso(), answers: sess.answers };
      // positions passed in placement count as passed lessons
      sess.answers.forEach(function (a) { if (a.passed) { var r = s.lessons[a.id] || { attempts: 0, passes: 0 }; r.attempts++; r.passes++; s.lessons[a.id] = r; } });
      egSave(s);
      delete placementSessions[b.session_id];
      out.done = true; out.recommended_tier = rec;
    } else {
      var nl = d.canon.find(function (x) { return x.id === sess.ids[sess.index]; });
      out.next = Object.assign(egStartPayload(nl, sess.level, { session_id: b.session_id }), { session_id: b.session_id, index: sess.index, total: sess.ids.length, title: "Placement — " + nl.title });
    }
    return out;
  });
  route("GET", "/api/endgame/progress", async function () {
    var c = await egCanon(), tiers = {};
    c.tiers.forEach(function (t) { tiers[t.tier] = { passed: t.lessons.filter(function (l) { return l.status === "passed"; }).length, total: t.lessons.length }; });
    var hist = egState().history;
    return { lessons_passed: c.passed, lessons_total: c.total, placement: c.placement, tiers: tiers,
      history: hist.slice(-50) };
  });

  function pieceClass(fen) {
    var b = fen.split(" ")[0].toLowerCase().replace(/[^pnbrq]/g, "");
    if (/q/.test(b)) return "queen";
    if (/r/.test(b)) return "rook";
    if (/[nb]/.test(b)) return "minor";
    return "pawn";
  }
  var LEAK_LESSONS = { pawn: ["eg1-kp-opposition", "eg1-kp-defend"], rook: ["eg2-lucena", "eg2-philidor", "eg3-r-vs-b"],
    queen: ["eg2-q-vs-pawn", "eg1-queen-mate"], minor: ["eg3-wrong-bishop", "eg3-bn-mate"] };
  route("POST", "/api/endgame/leaks/scan", async function (b) {
    var games = S.get("games", []);
    var cache = b.rescan ? {} : S.get("egLeakCache", {});
    var cfg = getConfig();
    var names = myNames();
    var out = { games_total: games.length, games_scanned: 0, games_cached: 0, games_degraded: 0, leaks: [], by_class: {} };
    for (var i = 0; i < games.length; i++) {
      var g = games[i], key = g.pgn_hash || hashStr(g.pgn);
      var entry = cache[key];
      if (entry) out.games_cached++;
      else {
        entry = { leak: null };
        try {
          var lg = loadGame(g.pgn);
          var first = lg.moves.find(function (m) { return pieceCount(m.fen) <= 7; });
          if (first) {
            var tb = await tbProbe(first.fen);
            if (!tb || !tb.category) { out.games_degraded++; continue; }
            var turn = first.fen.split(" ")[1];
            var w = (g.white || "").toLowerCase(), bl = (g.black || "").toLowerCase();
            var userSide = names.indexOf(w) !== -1 ? "white" : names.indexOf(bl) !== -1 ? "black" : null;
            var uncertain = !userSide;
            if (!userSide) userSide = "white";
            var cat = tb.category;
            if (turn !== userSide[0]) cat = { win: "loss", loss: "win" }[cat] || cat;
            var res = g.result === "1/2-1/2" ? "draw" : g.result === "1-0" ? (userSide === "white" ? "win" : "loss") : g.result === "0-1" ? (userSide === "black" ? "win" : "loss") : null;
            var type = cat === "win" && res && res !== "win" ? "win_not_converted" : cat === "draw" && res === "loss" ? "draw_lost" : null;
            if (type) entry.leak = { date: g.date, white: g.white, black: g.black, type: type, piece_class: pieceClass(first.fen), user_side: userSide, result: res, side_uncertain: uncertain, fen: first.fen };
            await sleep(150); // be polite to the public tablebase
          }
          out.games_scanned++;
        } catch (_) { out.games_scanned++; }
        cache[key] = entry;
      }
      if (entry.leak) { out.leaks.push(entry.leak); out.by_class[entry.leak.piece_class] = (out.by_class[entry.leak.piece_class] || 0) + 1; }
    }
    S.set("egLeakCache", cache);
    var c = await egCanon(), seen = {};
    out.recommended_lessons = [];
    Object.keys(out.by_class).sort(function (x, y) { return out.by_class[y] - out.by_class[x]; }).forEach(function (k) {
      (LEAK_LESSONS[k] || []).forEach(function (id) {
        if (seen[id]) return; seen[id] = 1;
        c.tiers.forEach(function (t) { t.lessons.forEach(function (l) { if (l.id === id) out.recommended_lessons.push({ id: id, tier: t.tier, title: l.title, passed: l.status === "passed" }); }); });
      });
    });
    return out;
  });

  /* ------------------------------------------------------------------ */
  /* opening rehearsal: script prefix, then human stats or engine        */
  /* ------------------------------------------------------------------ */
  var LEVEL_RATINGS = { casual: "1000,1200,1400", club: "1600,1800", advanced: "2000,2200", expert: "2200,2500", masters: null };
  async function humanMoves(fen, level) {
    var cfg = getConfig();
    if (!cfg.lichess_token) return null;
    var url = level === "masters"
      ? "https://explorer.lichess.ovh/masters?moves=12&fen=" + encodeURIComponent(fen)
      : "https://explorer.lichess.ovh/lichess?variant=standard&speeds=blitz,rapid,classical&moves=12&ratings=" + LEVEL_RATINGS[levelOf(level)] + "&fen=" + encodeURIComponent(fen);
    try {
      var r = await NATIVE_FETCH(url, { headers: { Authorization: "Bearer " + cfg.lichess_token } });
      if (!r.ok) return null;
      var j = await r.json();
      var tot = (j.moves || []).reduce(function (a, m) { return a + m.white + m.draws + m.black; }, 0);
      if (!tot) return [];
      return j.moves.map(function (m) { var n = m.white + m.draws + m.black; return { uci: m.uci, san: m.san, games: n, pct: 100 * n / tot }; });
    } catch (_) { return null; }
  }
  route("POST", "/api/rehearsal/opponent-move", async function (b) {
    var ch = mkChess(b.fen), fen = ch.fen();
    var st = gameStatus(ch);
    if (st.terminal) return { terminal: true, result: st.result, reason: st.reason, fen: fen };
    var key = function (f) { return f.split(" ").slice(0, 4).join(" "); };
    if (Array.isArray(b.script) && b.script.length) {
      var rc = new Chess();
      for (var i = 0; i < b.script.length; i++) {
        if (key(rc.fen()) === key(fen)) {
          var mm = tryMove(ch, b.script[i]);
          if (mm) { var st1 = gameStatus(ch); return { terminal: false, uci: mm.lan, san: mm.san, fen: fen, fen_after: ch.fen(), source: "script", rank: null, pct: null, games: null, branch_source: "script", maia_elo: null, after_terminal: st1.terminal }; }
          break;
        }
        if (!tryMove(rc, b.script[i])) break;
      }
    }
    var topN = clamp(b.top_n || 3, 1, 8);
    var hm = await humanMoves(fen, b.opponent_level);
    var choice = null, source = "stockfish", branchSource = "stockfish";
    if (hm && hm.length) {
      var top = hm.slice(0, topN), sum = top.reduce(function (a, m) { return a + m.games; }, 0), x = Math.random() * sum;
      for (var k = 0; k < top.length; k++) { x -= top[k].games; if (x <= 0) { choice = Object.assign({ rank: k + 1 }, top[k]); break; } }
      if (!choice) choice = Object.assign({ rank: 1 }, top[0]);
      source = "lichess"; branchSource = b.opponent_level === "masters" ? "masters" : "lichess";
    } else {
      var a = await analysePos(fen, { depth: 12, movetime: 1500, multipv: topN, priority: "high" });
      var best = capCp(evCp(a.lines[0].eval));
      var tol = { casual: 220, club: 140, advanced: 90, expert: 60, masters: 40 }[levelOf(b.opponent_level)] || 80; // v41: play at the chosen level
      var ok = a.lines.filter(function (l) { return best - capCp(evCp(l.eval)) <= tol; });
      var w = ok.map(function (l, i2) { return 1 / (i2 + 1); }), ws = w.reduce(function (p, q) { return p + q; }, 0), r2 = Math.random() * ws, idx = 0;
      for (; idx < w.length - 1; idx++) { r2 -= w[idx]; if (r2 <= 0) break; }
      choice = { uci: ok[idx].moves_uci[0], rank: idx + 1, pct: null, games: null };
    }
    var m = tryMove(ch, choice.uci);
    if (!m) fail(503, "engine_unavailable");
    var st2 = gameStatus(ch);
    return { terminal: false, uci: m.lan, san: m.san, fen: fen, fen_after: ch.fen(), source: source, rank: choice.rank,
      pct: choice.pct, games: choice.games, branch_source: branchSource, maia_elo: null, after_terminal: st2.terminal };
  });

  /* ------------------------------------------------------------------ */
  /* strategy: plan / null-move threat / candidate lines                 */
  /* ------------------------------------------------------------------ */
  function stepReason(fen, uci) {
    var f = moveFacts(fen, uci);
    if (!f) return "";
    if (f.mate) return "Checkmate.";
    if (f.castle) return "Castles — king to safety and the rook joins the game.";
    if (f.promotion) return "Promotes the pawn.";
    if (f.captured) return "Wins the " + PIECE_NAME[f.captured] + " on " + f.to + (f.check ? " with check" : "") + ".";
    if (f.check) return "Check — forces the reply.";
    if (f.piece === "p") return /[de]/.test(f.to[0]) ? "Claims central space." : "Gains space on the " + (f.to[0] < "d" ? "queenside" : "kingside") + ".";
    var dev = { w: "1", b: "8" }[fen.split(" ")[1]];
    if ((f.piece === "n" || f.piece === "b") && f.from[1] === dev) return "Develops the " + PIECE_NAME[f.piece] + " toward the centre.";
    return "Improves the " + PIECE_NAME[f.piece] + " (" + f.from + "–" + f.to + ").";
  }
  route("POST", "/api/strategy/plan", async function (b) {
    var ch = mkChess(b.fen), fen = ch.fen(), st = gameStatus(ch);
    var level = levelOf(b.opponent_level);
    var cfg = getConfig();
    if (st.terminal) return { fen: fen, terminal: true, result: st.result, reason: st.reason, opponent_level: level, main_line: [], branches: [], explanation: { goal: "The game is over.", steps: [] }, branch_source: "stockfish", lichess_token_set: !!cfg.lichess_token };
    var side = fen.split(" ")[1];
    if (b.bottom_side && b.bottom_side !== sideName(side)) fail(400, "bottom_side_mismatch");
    var nPlayer = clamp(b.player_moves || 3, 1, 6);
    var a = await analysePos(fen, { depth: clamp(b.depth || 12, 8, 16), multipv: 1, priority: "high", pvLen: 2 * nPlayer });
    var pv = (a.lines[0] ? a.lines[0].moves_uci : []).slice(0, 2 * nPlayer - 1);
    var main = [], f = fen, steps = [];
    pv.forEach(function (u, i) {
      var san = sanOf(f, u);
      var sd = i % 2 === 0 ? "player" : "opponent";
      main.push({ uci: u, san: san, side: sd, ply: i + 1 });
      if (sd === "player") steps.push({ side: sd, san: san, reason: stepReason(f, u), ply: i + 1 });
      f = fenAfter(f, u) || f;
    });
    var cp = capCp(evCp(a.eval));
    var goal = cp >= 300 ? "You are clearly better — simplify and convert." : cp >= 80 ? "You have the edge — keep the initiative and improve your pieces."
      : cp > -80 ? "The position is balanced — complete development and fight for the centre." : cp > -300 ? "You are under some pressure — consolidate and neutralise threats first." : "You are worse — set problems and look for counterplay.";
    var branches = [], branchSource = "stockfish";
    if (main.length >= 1) {
      var f1 = fenAfter(fen, main[0].uci);
      var nB = clamp(b.opp_branches || 2, 1, 4);
      var hm = await humanMoves(f1, level);
      var opp;
      if (hm && hm.length) { branchSource = level === "masters" ? "masters" : "lichess"; opp = hm.slice(0, nB).map(function (m) { return { uci: m.uci, san: m.san, pct: m.pct, games: m.games }; }); }
      else {
        var ob = await analysePos(f1, { depth: 10, movetime: 1200, multipv: nB, priority: "high" });
        opp = ob.lines.map(function (l) { return { uci: l.moves_uci[0], san: l.moves_san[0], pct: null, games: null }; });
      }
      for (var i = 0; i < opp.length; i++) {
        var f2 = fenAfter(f1, opp[i].uci);
        if (!f2) continue;
        var rep = await analysePos(f2, { depth: 10, movetime: 1200, multipv: 1, priority: "high" });
        var ev = rep.terminal ? (rep.reason === "checkmate" ? { type: "mate", value: 0 } : { type: "cp", value: 0 }) : rep.eval;
        branches.push({ move_uci: opp[i].uci, move_san: opp[i].san, pct: opp[i].pct, games: opp[i].games,
          reply_uci: rep.best, reply_san: rep.best_san, eval: ev, in_main_line: main[1] ? main[1].uci === opp[i].uci : false,
          comment: stepReason(f1, opp[i].uci).replace("Wins", "Takes") });
      }
    }
    return { fen: fen, terminal: false, result: null, reason: null, opponent_level: level, main_line: main,
      explanation: { goal: goal, steps: steps }, branch_source: branchSource, lichess_token_set: !!cfg.lichess_token, branches: branches };
  });
  route("POST", "/api/strategy/nullmove", async function (b) {
    var ch = mkChess(b.fen), fen = ch.fen();
    if (ch.inCheck()) return { legal: false, note: "You are in check — there is no 'pass' here; deal with the check first.", threat: null };
    var p = fen.split(" ");
    p[1] = p[1] === "w" ? "b" : "w"; p[3] = "-";
    var nf = p.join(" ");
    var test = tryChess(nf);
    if (!test) return { legal: false, note: "A null move is not possible in this position.", threat: null };
    var a = await analysePos(nf, { depth: 12, multipv: 1, priority: "high" });
    if (a.terminal) return { legal: true, note: "If you passed, the opponent would have no moves.", threat: null };
    var ev = negEval(a.eval);
    var cpY = capCp(evCp(ev));
    var note = cpY <= -200 ? "Big threat: if you pass, " + a.best_san + " is coming." : cpY <= -50 ? "There is a real threat: " + a.best_san + "." : "No serious threat — your opponent's best idea is " + a.best_san + ".";
    return { legal: true, note: note, threat: { best_move_san: a.best_san, best_move_uci: a.best, line_san: a.lines[0] ? a.lines[0].moves_san.slice(0, 6) : [], eval: ev } };
  });
  route("POST", "/api/strategy/lines", async function (b) {
    var n = clamp(b.max_moves || 3, 1, 5);
    var a = await analysePos(b.fen, { depth: 14, multipv: n, priority: "high", pvLen: 8 });
    return { fen: a.fen, terminal: a.terminal, result: a.result, reason: a.reason,
      lines: a.lines.map(function (l, i) { return { rank: i + 1, eval: l.eval, moves_san: l.moves_san, moves_uci: l.moves_uci }; }) };
  });

  /* ------------------------------------------------------------------ */
  /* game library + import (lichess / chess.com / PGN)                   */
  /* ------------------------------------------------------------------ */
  var LIB_CAP = 600;
  function slimPgn(pgn) { // drop clock/eval comments to save localStorage space
    return String(pgn).replace(/\{[^}]*\}/g, "").replace(/\$\d+/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  function gameRecord(pgn, extra) {
    var h = parseHeaders(pgn);
    var p = slimPgn(pgn);
    return Object.assign({
      id: "g" + pgnHash(p), white: h.White || "?", black: h.Black || "?", result: h.Result || "*",
      date: (h.UTCDate || h.Date || "").replace(/\./g, "-"), time_class: h.TimeControl ? timeClassOf(h.TimeControl) : (h.Event && /blitz|rapid|bullet|classical/i.test(h.Event) ? h.Event.match(/blitz|rapid|bullet|classical/i)[0].toLowerCase() : ""),
      opening: h.Opening || h.ECOUrl && decodeURIComponent(h.ECOUrl.split("/").pop()).replace(/-/g, " ") || "", eco: h.ECO || "",
      pgn: p, pgn_hash: pgnHash(p), source: "pgn",
    }, extra || {});
  }
  function timeClassOf(tc) {
    var m = String(tc).match(/^(\d+)(?:\+(\d+))?/);
    if (!m) return tc === "-" ? "correspondence" : "";
    var t = +m[1] + 40 * (+(m[2] || 0));
    return t < 180 ? "bullet" : t < 480 ? "blitz" : t < 1500 ? "rapid" : "classical";
  }
  function addToLibrary(recs) {
    var lib = S.get("games", []);
    var have = new Set(lib.map(function (g) { return g.pgn_hash; }));
    var stored = 0, dup = 0, fresh = [];
    recs.forEach(function (r) {
      if (have.has(r.pgn_hash)) { dup++; return; }
      have.add(r.pgn_hash); fresh.push(r); stored++;
    });
    lib = fresh.concat(lib).sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
    var truncated = lib.length > LIB_CAP;
    lib = lib.slice(0, LIB_CAP);
    while (true) { // shrink until it fits in the storage quota
      try { localStorage.setItem(NS + "games", JSON.stringify(lib)); break; }
      catch (e) { if (lib.length < 20) { S.set("games", lib); break; } lib = lib.slice(0, Math.floor(lib.length * 0.8)); truncated = true; }
    }
    return { stored: stored, duplicates_skipped: dup, truncated: truncated };
  }
  route("GET", "/api/games", function () { return { games: S.get("games", []) }; });

  route("POST", "/api/import", async function (b) {
    var user = String(b.username || "").trim();
    if (!user) fail(400, "no_username");
    if (b.source === "chesscom") return importChesscom(user, 1);
    var r;
    try {
      var headers = { Accept: "application/x-ndjson" };
      var tok = getConfig().lichess_token; if (tok) headers.Authorization = "Bearer " + tok;
      r = await NATIVE_FETCH("https://lichess.org/api/games/user/" + encodeURIComponent(user) + "?max=50&pgnInJson=true&opening=true&clocks=false&evals=false", { headers: headers });
    } catch (e) { fail(502, "lichess unreachable — check your connection"); }
    if (r.status === 404) fail(404, "lichess user not found");
    if (!r.ok) fail(502, "lichess http " + r.status);
    var text = await r.text();
    var recs = text.split("\n").filter(Boolean).map(function (line) {
      try {
        var j = JSON.parse(line);
        return gameRecord(j.pgn, { source: "lichess", time_class: j.speed || "", url: "https://lichess.org/" + j.id,
          opening: j.opening ? j.opening.name : "", eco: j.opening ? j.opening.eco : "" });
      } catch (_) { return null; }
    }).filter(Boolean);
    addToLibrary(recs);
    return { games: recs };
  });

  async function importChesscom(user, monthsBack) {
    var base = "https://api.chess.com/pub/player/" + encodeURIComponent(user.toLowerCase());
    var r;
    try { r = await NATIVE_FETCH(base + "/games/archives"); } catch (e) { fail(502, "chess.com unreachable"); }
    if (r.status === 404) fail(404, "chess.com user not found");
    if (!r.ok) fail(502, "chess.com http " + r.status);
    var arch = (await r.json()).archives || [];
    if (monthsBack > 0) arch = arch.slice(-monthsBack);
    var recs = [];
    for (var i = arch.length - 1; i >= 0; i--) {
      try {
        var m = await NATIVE_FETCH(arch[i]);
        if (!m.ok) continue;
        var j = await m.json();
        (j.games || []).forEach(function (g) {
          if (!g.pgn || (g.rules && g.rules !== "chess")) return;
          recs.push(gameRecord(g.pgn, { source: "chesscom", time_class: g.time_class || "", url: g.url || "" }));
        });
      } catch (_) {}
      if (recs.length >= LIB_CAP) break;
    }
    var res = addToLibrary(recs);
    recs.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
    return { games_imported: res.stored, duplicates_skipped: res.duplicates_skipped, games_truncated: recs.length > 200 || res.truncated, games: recs.slice(0, 200) };
  }
  route("POST", "/api/import/chesscom", function (b) {
    var user = String(b.username || "").trim();
    if (!user) fail(400, "no_username");
    var mb = b.months_back == null ? 3 : parseInt(b.months_back, 10);
    return importChesscom(user, isNaN(mb) ? 3 : mb);
  });
  route("POST", "/api/import/pgn", function (b) {
    var parts = splitPgns(b.pgn_text || "");
    var recs = [];
    parts.forEach(function (p) { try { var g = loadGame(p); if (g.moves.length) recs.push(gameRecord(p)); } catch (_) {} });
    var res = addToLibrary(recs);
    return { games: recs, stored: res.stored, duplicates_skipped: res.duplicates_skipped };
  });

  function userSideOf(white, black) {
    var names = myNames();
    if (names.indexOf(String(white || "").toLowerCase()) !== -1) return "white";
    if (names.indexOf(String(black || "").toLowerCase()) !== -1) return "black";
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* post-mortem (self-annotation before the engine reveal)              */
  /* ------------------------------------------------------------------ */
  var pmJobs = {};
  function pmSessions() { return S.get("pmSessions", []); }
  route("GET", "/api/postmortem/pending", function (b, q) {
    var s = pmSessions().find(function (x) { return x.pgn_hash === q.pgn_hash && !x.revealed; });
    return { pending: !!s, session_id: s ? s.id : null };
  });
  route("POST", "/api/postmortem/start", function (b) {
    var g = loadGame(b.pgn);
    var h = g.headers;
    var side = b.side === "white" || b.side === "black" ? b.side : "both";
    var id = uid("pm");
    var depth = clamp(b.depth || 12, 8, 14);
    var sess = { id: id, pgn: b.pgn, pgn_hash: pgnHash(b.pgn), depth: depth, side: side, white: h.White || "White", black: h.Black || "Black",
      result: h.Result || "*", start_fen: g.start_fen, created_at: nowIso(), revealed: false };
    var all = pmSessions().filter(function (x) { return x.revealed || x.pgn_hash !== sess.pgn_hash; });
    all.push(sess); S.set("pmSessions", all.slice(-30));
    pmJobs[id] = analyseGame(b.pgn, depth, { priority: "low", movetime: 1200 }); // runs while the user annotates
    pmJobs[id].catch(function () {});
    return { id: id, white: sess.white, black: sess.black, result: sess.result, side: side, start_fen: g.start_fen,
      moves: g.moves.map(function (m) { return { ply: m.ply, abs_ply: m.ply, san: m.san, fen_after: m.fen }; }) };
  });
  route("POST", "/api/postmortem/:id/submit", async function (b, q, p) {
    var all = pmSessions(), sess = all.find(function (x) { return x.id === p.id; });
    if (!sess) fail(404, "postmortem_not_found");
    var a = await (pmJobs[p.id] || analyseGame(sess.pgn, sess.depth, { priority: "high" }));
    var marks = (b.marks || []).slice(0, 7);
    var sideOk = function (mv) { var s = sideName(mv.fen_before.split(" ")[1]); return sess.side === "both" || s === sess.side; };
    var critical = a.moves.filter(function (mv) { return sideOk(mv) && mv.cpl >= 150 && mv.best_uci && mv.best_uci !== mv.uci; })
      .sort(function (x, y) { return y.cpl - x.cpl; }).slice(0, 5);
    var critPly = critical.map(function (c) { return c.ply; });
    var label = function (mv) { var n = Math.ceil(mv.ply / 2); return (mv.ply % 2 === 1 ? n + ". " : n + "... ") + mv.san; };
    var found = [], near = [], extra = [], feedback = [], usedCrit = {};
    var flagged = [], contraCards = [];
    marks.forEach(function (mk) {
      var mv = a.moves[mk.ply - 1];
      if (!mv) return;
      var exact = critPly.indexOf(mk.ply);
      var nearIdx = exact === -1 ? critPly.findIndex(function (c) { return Math.abs(c - mk.ply) <= 2 && !usedCrit[c]; }) : -1;
      var verdict, text;
      if (exact !== -1 && !usedCrit[mk.ply]) {
        usedCrit[mk.ply] = 1; verdict = "found"; found.push(mk.ply);
        text = "Yes — " + mv.san + " was a " + mv.classification + ". " + (mv.explanation || "");
      } else if (nearIdx !== -1) {
        var c = critPly[nearIdx]; usedCrit[c] = 1; verdict = "near"; near.push(mk.ply);
        var cm = a.moves[c - 1];
        text = "Close — the critical moment was " + label(cm) + " (" + cm.classification + "). " + (cm.explanation || "");
      } else {
        verdict = "extra"; extra.push(mk.ply);
        text = mv.san + " was " + (mv.classification === "best" || mv.classification === "good" ? "fine" : "a small " + mv.classification) + " — not a critical moment (" + mv.cpl + " cp).";
      }
      // hypercorrection: the user praised/defended a move that was actually bad (or vice versa) with high confidence
      var ann = (mk.annotation || "").toLowerCase();
      var saysGood = /\b(good|best|great|strong|fine|correct|right|winning)\b/.test(ann) && !/\bnot (good|best|great)\b/.test(ann);
      var contradiction = saysGood && mv.cpl >= 150;
      if (contradiction && (mk.confidence || 0) >= 4) { flagged.push(mk.ply); contraCards.push(mv); }
      feedback.push({ ply: mk.ply, label: label(mv), verdict: verdict, contradiction: contradiction, confidence: mk.confidence || 3, text: text });
    });
    var hc = { flagged_plies: flagged, enqueued: 0, relapsed: 0 };
    if (contraCards.length) {
      var add = addCards(contraCards.map(function (mv) { return Object.assign({}, mv, { force_due: true }); }), "postmortem");
      hc.enqueued = add.added; hc.relapsed = add.relapsed;
    }
    var nCrit = critical.length;
    var score = nCrit === 0 ? (extra.length ? Math.max(0, 100 - 15 * extra.length) : 100)
      : Math.round(clamp(100 * (found.length + 0.5 * near.length) / nCrit - 10 * extra.length, 0, 100));
    var missed = critical.filter(function (c) { return !usedCrit[c.ply]; }).map(function (mv) {
      return { ply: mv.ply, label: label(mv), classification: mv.classification, explanation: mv.explanation || "",
        plan: { goal: mv.best_san ? "Better was " + mv.best_san + (mv.pv_san && mv.pv_san.length > 1 ? " (" + mv.pv_san.slice(0, 4).join(" ") + ")." : ".") : "" },
        cpl: mv.cpl, fen_before: mv.fen_before, best_san: mv.best_san, best_uci: mv.best_uci };
    });
    var note = nCrit === 0 ? "No big swings in this game — a clean one." :
      score >= 80 ? "Excellent self-assessment — you see your critical moments." :
      score >= 50 ? "Decent calibration; " + missed.length + " critical moment(s) slipped past you." :
      "Your sense of the critical moments needs work — study the missed ones below.";
    sess.revealed = true; sess.score = score; sess.revealed_at = nowIso();
    S.set("pmSessions", all);
    var hist = S.get("pmHistory", []);
    hist.push({ score: score, at: nowIso(), white: sess.white, black: sess.black, found: found.length + near.length, critical_count: nCrit });
    S.set("pmHistory", hist.slice(-200));
    logActivity("review", "postmortem");
    delete pmJobs[p.id];
    return { calibration: { score: score, found: found, near_misses: near, critical_count: nCrit, extra: extra }, coach_note: note,
      feedback: feedback, hypercorrection: hc, missed_moments: missed,
      reveal: { white: a.white, black: a.black, result: a.result, moves: a.moves, accuracy: a.accuracy, start_fen: a.start_fen } };
  });
  route("GET", "/api/postmortem/calibration/history", function () { return { history: S.get("pmHistory", []) }; });

  /* ------------------------------------------------------------------ */
  /* guess-the-move (master games)                                       */
  /* ------------------------------------------------------------------ */
  function gtmState() { return S.get("gtm", { sessions: {}, history: [] }); }
  function gtmSave(s) {
    var ids = Object.keys(s.sessions);
    if (ids.length > 20) ids.sort(function (a, b) { return s.sessions[a].started_at < s.sessions[b].started_at ? -1 : 1; }).slice(0, ids.length - 20).forEach(function (k) { delete s.sessions[k]; });
    S.set("gtm", s);
  }
  async function gtmGame(id) {
    var d = await loadData("masters.json");
    var g = d.games.find(function (x) { return x.id === id; });
    if (!g) fail(404, "game_not_found");
    if (!g._moves) g._moves = loadGame(g.pgn).moves;
    return g;
  }
  function gtmUserPlies(g) { var me = g.user_side[0]; return g._moves.filter(function (m, i) { return i >= g.start_ply && m.fen_before.split(" ")[1] === me; }); }
  function gtmView(g, s) {
    var mv = g._moves.slice(0, s.ply).map(function (m) { return m.san; });
    var fen = s.ply === 0 ? g._moves[0].fen_before : g._moves[s.ply - 1].fen;
    return { session_id: s.id, game_id: g.id, title: g.title, white: g.white, black: g.black, event: g.event, year: g.year,
      user_side: g.user_side, fen: fen, moves_san: mv, finished: s.finished, summary: s.finished ? s.summary : null, guesses: s.guesses };
  }
  route("GET", "/api/gtm/games", async function () {
    var d = await loadData("masters.json"), st = gtmState();
    var out = [];
    for (var i = 0; i < d.games.length; i++) {
      var g = await gtmGame(d.games[i].id);
      var best = null, active = null;
      st.history.forEach(function (h) { if (h.game_id === g.id && (best == null || h.score > best)) best = h.score; });
      Object.keys(st.sessions).forEach(function (k) { if (st.sessions[k].game_id === g.id && !st.sessions[k].finished) active = k; });
      out.push({ id: g.id, title: g.title, white: g.white, black: g.black, year: g.year, event: g.event, user_side: g.user_side, principle: g.principle,
        guesses_to_make: gtmUserPlies(g).length, best_score: best, themes: g.themes || [], active_session_id: active });
    }
    return { games: out };
  });
  route("GET", "/api/gtm/history", function () { return { entries: gtmState().history.slice().reverse() }; });
  route("POST", "/api/gtm/session/start", async function (b) {
    var g = await gtmGame(b.game_id), st = gtmState();
    // resume an unfinished session for the same game
    var existing = Object.keys(st.sessions).map(function (k) { return st.sessions[k]; }).find(function (x) { return x.game_id === g.id && !x.finished; });
    var s = existing || { id: uid("gtm"), game_id: g.id, ply: g.start_ply, guesses: [], hints: 0, finished: false, started_at: nowIso() };
    // advance to the first user move
    while (s.ply < g._moves.length && g._moves[s.ply].fen_before.split(" ")[1] !== g.user_side[0]) s.ply++;
    st.sessions[s.id] = s; gtmSave(st);
    return gtmView(g, s);
  });
  function gtmSess(id) { var st = gtmState(), s = st.sessions[id]; if (!s) fail(404, "session_not_found"); return { st: st, s: s }; }
  route("GET", "/api/gtm/session/:id/state", async function (b, q, p) { var r = gtmSess(p.id); return gtmView(await gtmGame(r.s.game_id), r.s); });
  route("POST", "/api/gtm/session/:id/hint", async function (b, q, p) {
    var r = gtmSess(p.id), g = await gtmGame(r.s.game_id);
    if (r.s.finished) fail(400, "session_finished");
    var m = g._moves[r.s.ply];
    r.s.hints = (r.s.hints || 0) + 1; r.s.pendingHint = true; gtmSave(r.st);
    var h = hintForMove(m.fen_before, m.uci);
    return { hint: { text: h.text.replace("The key move", "The master's move") }, hint_penalty: 0.25 };
  });
  function gtmSummary(g, s) {
    var n = s.guesses.length || 1;
    var mean = s.guesses.reduce(function (a, x) { return a + x.credit; }, 0) / n;
    return { score: Math.round(100 * mean), guesses: s.guesses.length, master_matches: s.guesses.filter(function (x) { return x.master_match; }).length,
      mean_credit: mean, themes: g.themes || [], summary: g.summary };
  }
  route("POST", "/api/gtm/session/:id/guess", async function (b, q, p) {
    var r = gtmSess(p.id), s = r.s, g = await gtmGame(s.game_id);
    if (s.finished) fail(400, "session_finished");
    var m = g._moves[s.ply];
    var yours = moveFacts(m.fen_before, String(b.uci || ""));
    if (!yours) fail(400, "illegal_move");
    var match = yours.fen_after.split(" ").slice(0, 4).join(" ") === m.fen.split(" ").slice(0, 4).join(" ");
    var pre = await analysePos(m.fen_before, { depth: 12, movetime: 1500, multipv: 1, priority: "high" });
    var bestCp = capCp(evCp(pre.eval));
    var evalAfter = async function (fen) { var x = await analysePos(fen, { depth: 12, movetime: 1500, multipv: 1, priority: "high" }); return x.terminal ? (x.reason === "checkmate" ? 1500 : 0) : capCp(-evCp(x.eval)); };
    var yourCp = await evalAfter(yours.fen_after);
    var masterCp = match ? yourCp : await evalAfter(m.fen);
    var cpl = Math.max(0, Math.round(bestCp - yourCp));
    var grade = classifyCpl(cpl);
    var credit = match ? 1 : clamp(1 - Math.max(0, masterCp - yourCp) / 200, 0, 1);
    if (!match && yourCp >= masterCp + 30) grade = cpl <= 10 ? "great" : grade;
    if (s.pendingHint) { credit = Math.max(0, credit - 0.25); s.pendingHint = false; }
    s.ply++;
    var reply = null;
    if (s.ply < g._moves.length) { var om = g._moves[s.ply]; reply = { san: om.san, uci: om.uci }; s.ply++; }
    while (s.ply < g._moves.length && g._moves[s.ply].fen_before.split(" ")[1] !== g.user_side[0]) s.ply++;
    var guess = { ply: m.ply, grade: grade, master_match: match, credit: Math.round(credit * 100) / 100, cpl: cpl, your_san: yours.san,
      master: { san: m.san, uci: m.uci }, opponent_reply: reply, engine: { san: pre.best_san, eval: pre.eval }, maia: null, fen_before: m.fen_before };
    s.guesses.push(guess);
    if (s.ply >= g._moves.length) {
      s.finished = true; s.summary = gtmSummary(g, s);
      r.st.history.push({ game_id: g.id, title: g.title, score: s.summary.score, at: nowIso() });
      logActivity("masters", "gtm");
    }
    gtmSave(r.st);
    var v = gtmView(g, s);
    return { moves_san: v.moves_san, fen: v.fen, finished: s.finished, summary: s.finished ? s.summary : null, guess: guess };
  });
  route("POST", "/api/gtm/session/:id/finish", async function (b, q, p) {
    var r = gtmSess(p.id), s = r.s, g = await gtmGame(s.game_id);
    if (!s.finished) {
      s.finished = true; s.summary = gtmSummary(g, s);
      if (s.guesses.length) { r.st.history.push({ game_id: g.id, title: g.title, score: s.summary.score, at: nowIso() }); logActivity("masters", "gtm"); }
      gtmSave(r.st);
    }
    return { summary: s.summary };
  });
  route("POST", "/api/gtm/session/:id/debrief", async function (b, q, p) {
    var r = gtmSess(p.id), s = r.s, g = await gtmGame(s.game_id);
    var gs = s.guesses.find(function (x) { return x.ply === b.ply; }) || s.guesses[s.guesses.length - 1];
    if (!gs) return { chat: { reply: "Make a guess first, then ask about it.", session_id: null } };
    var reply = gs.master_match ? "You found " + gs.master.san + ", the move " + (g.user_side === "white" ? g.white : g.black) + " played. "
      : "The master played " + gs.master.san + " where you chose " + gs.your_san + ". ";
    reply += "The engine's top choice was " + (gs.engine.san || "?") + ". " + stepReason(gs.fen_before, gs.master.uci) + " ";
    if (g.principle) reply += "Theme of this game: " + g.principle + ".";
    var llm = await llmChat([{ role: "system", content: "You are a concise chess coach. Facts: " + reply }, { role: "user", content: String(b.question || "Why was the master's move strong?") }]);
    return { chat: { reply: llm || reply, session_id: "gtm-" + s.id, source: llm ? "llm" : "template" } };
  });

  /* ------------------------------------------------------------------ */
  /* lessons / model games / profile / openings / progress               */
  /* ------------------------------------------------------------------ */
  // v42: the coach's lessons (Pawn Breaks, Prophylaxis, …) come first, ordered by his weak spots
  var LESSON_ORDER = ["L06", "L07", "L05", "L04", "L03", "L08", "L02", "L01"];
  async function allLessons() {
    var base = (await loadData("lessons.json")).lessons, coach = [];
    try { coach = clone(await loadData("coach_lessons.json")); } catch (_) {}
    coach.sort(function (a, b) { return LESSON_ORDER.indexOf(a.id) - LESSON_ORDER.indexOf(b.id); });
    coach.forEach(function (l) { l.principle = String(l.principle || "").replace(/-/g, " ").replace(/^./, function (c) { return c.toUpperCase(); }); l.coach = true; });
    return coach.concat(base);
  }
  /* a step without a task gets one when the next step is one legal move away */
  function lessonWithTasks(l) {
    l = clone(l);
    for (var i = 0; i < l.steps.length; i++) {
      var st = l.steps[i];
      if (st.task || !l.steps[i + 1]) continue;
      var ch = tryChess(st.fen), next = l.steps[i + 1].fen.split(" ").slice(0, 3).join(" ");
      if (!ch) continue;
      var hit = ch.moves({ verbose: true }).find(function (m) { var t = tryChess(st.fen); t.move(m.san); return t.fen().split(" ").slice(0, 3).join(" ") === next; });
      if (hit) { st.task = "Find the move that comes next — " + (st.fen.split(" ")[1] === "w" ? "White" : "Black") + " to play."; st.solution_uci = hit.from + hit.to + (hit.promotion || ""); st.derived = true; }
    }
    return l;
  }
  route("GET", "/api/lessons", async function () {
    var all = await allLessons();
    return { lessons: all.map(function (l) { return { id: l.id, title: l.title, principle: l.principle, difficulty: l.difficulty, steps_count: l.steps.length, summary: l.summary,
      tasks: lessonWithTasks(l).steps.filter(function (s) { return s.task; }).length, coach: !!l.coach }; }) };
  });
  route("GET", "/api/lessons/:id", async function (b, q, p) {
    var l = (await allLessons()).find(function (x) { return x.id === p.id; });
    if (!l) fail(404, "lesson_not_found");
    return lessonWithTasks(l);
  });
  /* opening repertoires (Modern / Grünfeld) and kingside attacks          */
  /* /api/repertoire/:slug        -> overview: everything except the heavy  */
  /*                                 per-look plies/tactics/fen            */
  /* /api/repertoire/:slug/:id    -> one look in full                      */
  /* /api/attacks                 -> name, summary, patterns w/o puzzles   */
  /*                                 (puzzle_count instead)                */
  /* /api/attacks/:id             -> one pattern with its puzzles          */
  var REPERTOIRES = { modern: "modern.json", grunfeld: "grunfeld.json", scotch: "scotch.json" };
  function repFile(slug) {
    if (!Object.prototype.hasOwnProperty.call(REPERTOIRES, slug)) fail(404, "repertoire_not_found");
    return loadData(REPERTOIRES[slug]);
  }
  route("GET", "/api/repertoire/:slug", async function (b, q, p) {
    var d = clone(await repFile(p.slug));
    d.slug = p.slug;
    d.looks = (d.looks || []).map(function (l) {
      return { id: l.id, name: l.name, eco: l.eco, frequency: l.frequency, tell: l.tell,
        line_san: l.line_san || (l.moves || []).join(" "), moves_count: l.moves_count || (l.plies || l.moves || []).length,
        structure: l.structure };
    });
    return d;
  });
  route("GET", "/api/repertoire/:slug/:id", async function (b, q, p) {
    var d = await repFile(p.slug);
    var l = (d.looks || []).find(function (x) { return x.id === p.id; });
    if (!l) fail(404, "look_not_found");
    return clone(l);
  });
  /* v41: first-try memory per opening line, spaced repetition */
  var REP_STEPS = [1, 3, 7, 14, 30, 60];
  function repProg() { return S.get("repProgress", {}); }
  route("POST", "/api/repertoire/:slug/:id/result", function (b, q, p) {
    var all = repProg(), key = p.slug + "/" + p.id;
    var r = all[key] || { slug: p.slug, id: p.id, name: b.name || p.id, attempts: 0, step: -1, history: [] };
    var total = Math.max(1, parseInt(b.total, 10) || 1), right = clamp(parseInt(b.right, 10) || 0, 0, total);
    r.attempts++; r.name = b.name || r.name;
    r.last_right = right; r.last_total = total; r.last_at = nowIso(); r.missed = (b.missed || []).slice(0, 10);
    r.best = Math.max(r.best || 0, Math.round(100 * right / total));
    // missed -> tomorrow; known first try -> 3, 7, 14, 30, 60 days
    if (right === total) r.step = Math.min(REP_STEPS.length - 1, Math.max(1, (r.step == null ? 0 : r.step) + 1)); else r.step = 0;
    r.interval = REP_STEPS[Math.max(0, r.step)];
    var due = new Date(); due.setHours(4, 0, 0, 0); due.setDate(due.getDate() + r.interval);
    r.due = due.toISOString();
    r.history = (r.history || []).concat([{ at: r.last_at, right: right, total: total }]).slice(-30);
    all[key] = r; S.set("repProgress", all);
    return r;
  });
  async function repProgressSummary(slug) {
    var all = repProg(), lines = Object.keys(all).map(function (k) { return all[k]; }).filter(function (l) { return !slug || l.slug === slug; });
    var totalLines = 0;
    for (var s2 of ["modern", "grunfeld", "scotch"]) { if (slug && slug !== s2) continue; try { totalLines += ((await repFile(s2)).looks || []).length; } catch (_) {} }
    var now = Date.now();
    return { lines: lines, total_lines: totalLines, tried: lines.length,
      known: lines.filter(function (l) { return l.last_right === l.last_total; }).length,
      due_count: lines.filter(function (l) { return Date.parse(l.due) <= now; }).length + Math.max(0, totalLines - lines.length) };
  }
  route("GET", "/api/repertoire-progress", async function (b, q) { return await repProgressSummary(q.slug || null); });
  route("GET", "/api/attacks", async function () {
    var d = clone(await loadData("attacks.json"));
    d.patterns = (d.patterns || []).map(function (pt) {
      var o = {};
      Object.keys(pt).forEach(function (k) { if (k !== "puzzles") o[k] = pt[k]; });
      o.puzzle_count = (pt.puzzles || []).length;
      return o;
    });
    return d;
  });
  route("GET", "/api/attacks/:id", async function (b, q, p) {
    var d = await loadData("attacks.json");
    var pt = (d.patterns || []).find(function (x) { return x.id === p.id; });
    if (!pt) fail(404, "pattern_not_found");
    var o = clone(pt);
    o.puzzle_count = (o.puzzles || []).length;
    return o;
  });
  route("GET", "/api/model-games/principles", async function () {
    var d = await loadData("masters.json");
    return { principles: Array.from(new Set(d.games.map(function (g) { return g.principle; }))) };
  });
  route("GET", "/api/model-games", async function (b, q) {
    var d = await loadData("masters.json");
    return { games: d.games.filter(function (g) { return !q.principle || g.principle === q.principle; })
      .map(function (g) { return { id: g.id, title: g.title, white: g.white, black: g.black, year: g.year, event: g.event, result: g.result, principle: g.principle, summary: g.summary, pgn: g.pgn }; }) };
  });

  var MOTIF_LESSON = { missed_mate: "back-rank", allowed_mate: "back-rank", hanging_piece: "knight-fork", missed_capture: "knight-fork", missed_check: "the-pin", positional: "center-control",
    ignored_threat: "knight-fork", allowed_tactic: "the-pin", opening_slip: "center-control", endgame_technique: "center-control" };
  route("GET", "/api/profile/summary", function () {
    var idx = analysisIndex();
    var accs = [], blunders = 0, motifs = {};
    idx.forEach(function (r) {
      var side = userSideOf(r.white, r.black);
      if (side === "white" || !side) { accs.push(r.accuracy_white); blunders += r.blunders_white || 0; }
      if (side === "black" || !side) { accs.push(r.accuracy_black); blunders += r.blunders_black || 0; }
      (r.motifs || []).forEach(function (m) { if (!side || m.side === side[0]) motifs[m.motif] = (motifs[m.motif] || 0) + 1; });
    });
    var weaknesses = Object.keys(motifs).sort(function (a, b) { return motifs[b] - motifs[a]; }).map(function (k) { return { theme: MOTIF_LABELS[k] || k, motif: k, count: motifs[k] }; });
    var recs = Array.from(new Set(weaknesses.slice(0, 3).map(function (w) { return MOTIF_LESSON[w.motif]; }).filter(Boolean)));
    return { games_analyzed: idx.length, accuracy_avg: accs.length ? Math.round(10 * accs.reduce(function (a, x) { return a + x; }, 0) / accs.length) / 10 : null,
      blunders_per_game: idx.length ? Math.round(100 * blunders / idx.length) / 100 : null, brilliants: 0,
      weaknesses: weaknesses, recommended_lessons: recs.length ? recs : ["center-control"] };
  });

  function openingName(g) {
    if (g.opening) return g.opening;
    try { var mv = loadGame(g.pgn).moves.slice(0, 4).map(function (m) { return m.san; }); return mv.length ? mv.join(" ") : "Unknown"; } catch (_) { return "Unknown"; }
  }
  route("GET", "/api/openings/report", function () {
    var lib = S.get("games", []), by = {};
    lib.forEach(function (g) {
      var side = userSideOf(g.white, g.black);
      if (!side) return;
      var name = openingName(g).split(":")[0].trim();
      var o = by[name] = by[name] || { name: name, eco: g.eco || "", games: 0, wins: 0, draws: 0, losses: 0 };
      o.games++;
      if (g.result === "1/2-1/2") o.draws++;
      else if ((g.result === "1-0") === (side === "white") && g.result !== "*") o.wins++;
      else if (g.result !== "*") o.losses++;
    });
    var list = Object.keys(by).map(function (k) { var o = by[k]; o.score_pct = Math.round(100 * (o.wins + 0.5 * o.draws) / o.games); return o; })
      .sort(function (a, b) { return b.games - a.games; });
    var counted = list.reduce(function (a, o) { return a + o.games; }, 0);
    return { total_games: counted, by_opening: list.slice(0, 25),
      leaks: list.filter(function (o) { return o.games >= 3 && o.score_pct < 45; }).sort(function (a, b) { return a.score_pct - b.score_pct; }).slice(0, 5),
      note: counted ? null : "Set your lichess/chess.com username in Settings and import games to see your opening report." };
  });

  route("GET", "/api/progress/summary", function () {
    var idx = analysisIndex();
    return { games_imported: S.get("games", []).length, games_analyzed: idx.length,
      analyses: idx.map(function (r) { return { white: r.white, black: r.black, result: r.result, date: r.date, accuracy_white: r.accuracy_white, accuracy_black: r.accuracy_black, at: r.at }; }),
      accuracy_trend: idx.slice().reverse().map(function (r) {
        var side = userSideOf(r.white, r.black);
        return { at: r.at, accuracy: side === "black" ? r.accuracy_black : side === "white" ? r.accuracy_white : Math.round((r.accuracy_white + r.accuracy_black) * 5) / 10 };
      }) };
  });
  route("GET", "/api/progress/rating-history", async function () {
    var user = getConfig().lichess_username;
    if (!user) fail(400, "no_username");
    try {
      var r = await NATIVE_FETCH("https://lichess.org/api/user/" + encodeURIComponent(user) + "/rating-history");
      if (!r.ok) return { available: false, username: user, categories: [], reason: "lichess http " + r.status };
      var j = await r.json();
      return { available: true, username: user, categories: j.filter(function (c) { return c.points && c.points.length; }).map(function (c) { return { name: c.name, points: c.points }; }) };
    } catch (_) { return { available: false, username: user, categories: [], reason: "offline" }; }
  });

  /* ------------------------------------------------------------------ */
  /* training plan / streak / heatmap                                    */
  /* ------------------------------------------------------------------ */
  var PILLAR_TARGET = { review: 2, tactics: 5, sparring: 2, endgame: 2, masters: 1 };
  function activityIn(from, to) { return S.get("activity", []).filter(function (a) { return a.date >= from && a.date <= to; }); }
  function planFor(week) {
    var end = addDays(week, 6), today = utcDay();
    var acts = activityIn(week, end);
    var doneBy = function (pillar, kinds) { return acts.filter(function (a) { return a.pillar === pillar && (!kinds || kinds.indexOf(a.kind) !== -1); }); };
    var daysOf = function (list) { return new Set(list.map(function (a) { return a.date; })); };
    var reasons = [];
    var st = fcStats();
    var pillars = {};
    // review
    var rv = doneBy("review");
    var revItems = [{ label: "Post-mortem one of your games", kind: "postmortem", done: doneBy("review", ["postmortem"]).length > 0, due: null, ref: { tab: "games" } },
      { label: "Run a full game review", kind: "analysis", done: doneBy("review", ["analysis"]).length > 0, due: null, ref: { tab: "games" } }];
    if (!S.get("games", []).length) { revItems.unshift({ label: "Import your games (Games tab)", kind: "onboarding", done: false, due: null, ref: { tab: "games" } }); reasons.push("no games imported yet"); }
    pillars.review = { target_sessions: PILLAR_TARGET.review, done_sessions: Math.min(PILLAR_TARGET.review, daysOf(rv).size), items: revItems };
    // tactics: one flashcard item per day of the week (up to today)
    var fc = [], fcDays = daysOf(doneBy("tactics", ["flashcards"]));
    for (var i = 0; i < 7; i++) {
      var d = addDays(week, i);
      if (d > today) break;
      fc.push({ label: "Flashcard queue" + (d === today ? " (" + st.due_today + " due)" : " — " + d), kind: "flashcards", done: fcDays.has(d) || (d === today && st.due_today === 0 && st.total > 0), due: d === today ? null : d, ref: { tab: "puzzles" } });
    }
    var tac = fc.concat([{ label: "Complete a Woodpecker cycle", kind: "cycle", done: doneBy("tactics", ["cycle"]).length > 0, due: null, ref: { tab: "cycles" } },
      { label: "Solve 10 puzzles", kind: "motif_focus", done: doneBy("tactics", ["puzzle"]).length >= 10, due: null, ref: { tab: "puzzles" } }]);
    if (st.due_today > 10) reasons.push(st.due_today + " flashcards due");
    var focus = cardFocus();
    if (focus.length) {
      var gm = gameMissFocus();
      reasons.unshift("your " + focus.reduce(function (a, f) { return a + f.n; }, 0) + " mistake cards: " + focus.slice(0, 4).map(function (f) { return f.n + "× " + f.label.toLowerCase(); }).join(", ") +
        (gm.length ? "; your analysed games add " + gm.slice(0, 2).map(function (f) { return f.n + "× " + f.label.toLowerCase(); }).join(" and ") : "") +
        " — so this week leads with flashcards and the “My mistakes” Woodpecker cycle");
      tac.unshift({ label: "Focus: " + focus[0].label + " (" + focus[0].n + " of your cards)", kind: "motif_focus_mine", done: doneBy("tactics", ["cycle", "flashcards"]).length > 0, due: null, ref: { tab: "cycles" } });
    }
    pillars.tactics = { target_sessions: PILLAR_TARGET.tactics, done_sessions: Math.min(PILLAR_TARGET.tactics, daysOf(doneBy("tactics")).size), items: tac };
    // sparring
    var sp = spState(), due = 0;
    Object.keys(sp.results).forEach(function (k) { ["white", "black"].forEach(function (s2) { if (sp.results[k][s2] && sp.results[k][s2].due) due++; }); });
    var spItems = [];
    if (due) { spItems.push({ label: due + " sparring re-test(s) due", kind: "retest", done: false, due: null, ref: { tab: "sparring" } }); reasons.push("sparring re-tests due"); }
    spItems.push({ label: "Play a sparring pack session", kind: "pack_session", done: doneBy("sparring").length >= 3, due: null, ref: { tab: "sparring" } });
    pillars.sparring = { target_sessions: PILLAR_TARGET.sparring, done_sessions: Math.min(PILLAR_TARGET.sparring, daysOf(doneBy("sparring")).size), items: spItems };
    // endgame
    var eg = egState();
    var egItems = [];
    if (!eg.placement) egItems.push({ label: "Take the endgame placement test", kind: "placement", done: false, due: null, ref: { tab: "endgames" } });
    egItems.push({ label: "Pass an endgame lesson", kind: "lesson", done: doneBy("endgame", ["lesson"]).length > 0, due: null, ref: { tab: "endgames" } });
    pillars.endgame = { target_sessions: PILLAR_TARGET.endgame, done_sessions: Math.min(PILLAR_TARGET.endgame, daysOf(doneBy("endgame")).size), items: egItems };
    // masters
    pillars.masters = { target_sessions: PILLAR_TARGET.masters, done_sessions: Math.min(PILLAR_TARGET.masters, daysOf(doneBy("masters")).size),
      items: [{ label: "Guess-the-move: one master game", kind: "gtm", done: doneBy("masters", ["gtm"]).length > 0, due: null, ref: { tab: "masters" } }] };
    // v41: openings — due lines from the first-try memory
    var rp = repProg(), rpLines = Object.keys(rp).map(function (k) { return rp[k]; });
    var nowMs = Date.now();
    var dueBy = { modern: 0, grunfeld: 0 };
    rpLines.forEach(function (l) { if (Date.parse(l.due) <= nowMs) dueBy[l.slug] = (dueBy[l.slug] || 0) + 1; });
    var newBy = { modern: Math.max(0, 7 - rpLines.filter(function (l) { return l.slug === "modern"; }).length),
      grunfeld: Math.max(0, 7 - rpLines.filter(function (l) { return l.slug === "grunfeld"; }).length) };
    var opDone = doneBy("openings");
    var opItems = ["modern", "grunfeld"].map(function (sl) {
      var n = dueBy[sl] + newBy[sl], nm = sl === "modern" ? "Modern" : "Grünfeld";
      return { label: "Openings: " + nm + " — " + (n ? n + " line" + (n === 1 ? "" : "s") + " to drill (" + dueBy[sl] + " due, " + newBy[sl] + " new)" : "all lines fresh"),
        kind: "opening_drill", done: n === 0 || acts.some(function (a) { return a.pillar === "openings" && a.date === today && a.kind === "repertoire"; }) && dueBy[sl] === 0,
        due: null, ref: { tab: sl, drill: sl } };
    });
    if (dueBy.modern + dueBy.grunfeld) reasons.push((dueBy.modern + dueBy.grunfeld) + " opening line(s) due for review");
    pillars.openings = { target_sessions: 3, done_sessions: Math.min(3, daysOf(opDone).size), items: opItems };
    var planned = 0, completed = 0;
    Object.keys(pillars).forEach(function (k) { planned += pillars[k].target_sessions; completed += pillars[k].done_sessions; });
    return { week_of: week, reasons: reasons, pillars: pillars, adherence: { completed: completed, planned: planned, pct: planned ? Math.round(100 * completed / planned) : 0 } };
  }
  route("GET", "/api/training-plan", function () { return planFor(weekStart()); });
  // v39: category counts of the player's own mistake cards (bundled cards + misses from his games)
  function focusBy(src) {
    var by = {};
    cards().forEach(function (c) { if (c.source === src) by[c.motif] = (by[c.motif] || 0) + 1; });
    return Object.keys(by).map(function (k) { return { motif: k, label: MOTIF_LABELS[k] || k, n: by[k] }; })
      .sort(function (a, b) { return (b.n - a.n) || ((a.motif === "positional") - (b.motif === "positional")); });
  }
  function cardFocus() { return focusBy("my-cards"); }
  function gameMissFocus() { return focusBy("my-games").filter(function (f) { return f.motif !== "positional"; }); }
  route("GET", "/api/training-plan/adherence", function () {
    var acts = S.get("activity", []);
    var first = acts.length ? weekStart(acts[0].date) : weekStart();
    var weeks = [], w = weekStart();
    for (var i = 0; i < 8 && w >= first; i++) { weeks.unshift({ week_of: w, pct: planFor(w).adherence.pct }); w = addDays(w, -7); }
    return { weeks: weeks };
  });
  route("GET", "/api/training-plan/pillars", function () {
    var pm = S.get("pmHistory", []);
    var sets2 = sets(), cyc = [];
    sets2.forEach(function (s) { s.cycles.forEach(function (c) { cyc.push(c); }); });
    cyc.sort(function (a, b) { return a.finished_at < b.finished_at ? -1 : 1; });
    var sp = spState(), passes = 0, fails = 0;
    Object.keys(sp.results).forEach(function (k) { ["white", "black"].forEach(function (s2) { var r = sp.results[k][s2]; if (r) { passes += r.passes || 0; fails += r.fails || 0; } }); });
    var eg = egState(), egPassed = 0, trend = [], seen = {};
    Object.keys(eg.lessons).forEach(function (k) { if (eg.lessons[k].passes > 0) egPassed++; });
    eg.history.forEach(function (h) { if (h.passed && !seen[h.lesson_id]) { seen[h.lesson_id] = 1; trend.push(Object.keys(seen).length); } });
    var gh = gtmState().history;
    var spAttempts = S.get("activity", []).filter(function (a) { return a.pillar === "sparring"; });
    return {
      review: { latest_calibration: pm.length ? pm[pm.length - 1].score : null, calibration: pm.slice(-12).map(function (x) { return x.score; }) },
      tactics: { retention_7d: fcStats().retention_7d, cycle_accuracy: cyc.slice(-12).map(function (c) { return c.accuracy; }) },
      sparring: { pass_rate: passes + fails ? passes / (passes + fails) : null, pass_trend: [], attempts: spAttempts.length },
      endgame: { lessons_passed: egPassed, lessons_total: 10, passed_trend: trend.slice(-12) },
      openings: (function () { var rp = repProg(), ls = Object.keys(rp).map(function (k) { return rp[k]; });
        return { known_pct: ls.length ? Math.round(100 * ls.filter(function (l) { return l.last_right === l.last_total; }).length / 14) : null,
          trend: ls.reduce(function (a, l) { return a.concat(l.history || []); }, []).sort(function (x, y) { return x.at < y.at ? -1 : 1; }).slice(-12).map(function (h) { return Math.round(100 * h.right / h.total); }) }; })(),
      masters: { best_score: gh.length ? Math.max.apply(null, gh.map(function (h) { return h.score; })) : null, scores: gh.slice(-12).map(function (h) { return h.score; }) },
    };
  });
  // v40: a streak day needs a real answer (viewing a game review or opening a tab does not count)
  var STREAK_SKIP = { analysis: 1 };
  route("POST", "/api/activity/answer", function (b) {
    var pillar = { openings: "openings", tactics: "tactics", masters: "masters" }[b.pillar] || "tactics";
    logActivity(pillar, String(b.kind || "answer").slice(0, 32));
    return { ok: true };
  });
  route("GET", "/api/training-plan/streak", function () {
    var days = new Set(S.get("activity", []).filter(function (a) { return !STREAK_SKIP[a.kind]; }).map(function (a) { return a.date; }));
    var today = utcDay(), cur = 0, d = days.has(today) ? today : addDays(today, -1);
    while (days.has(d)) { cur++; d = addDays(d, -1); }
    var best = 0, run = 0, sorted = Array.from(days).sort(), prev = null;
    sorted.forEach(function (x) { run = prev && addDays(prev, 1) === x ? run + 1 : 1; best = Math.max(best, run); prev = x; });
    return { current: cur, best: best, today_done: days.has(today), in_progress: !days.has(today) && cur > 0, repair_available: false, freeze_available: false, freezes_used_this_week: 0 };
  });
  route("GET", "/api/training-plan/heatmap", function (b, q) {
    var year = parseInt(q.year, 10) || new Date().getUTCFullYear();
    var counts = {};
    S.get("activity", []).forEach(function (a) { if (a.date.slice(0, 4) === String(year)) counts[a.date] = (counts[a.date] || 0) + 1; });
    return { year: year, days: Object.keys(counts).sort().map(function (k) { return { date: k, sessions: counts[k] }; }) };
  });

  /* ------------------------------------------------------------------ */
  /* TIER 3: coach (template, optional LLM pass-through), voice, maia    */
  /* ------------------------------------------------------------------ */
  async function llmChat(messages) {
    var cfg = getConfig();
    if (!cfg.llm_enabled || !cfg.llm_url) return null;
    var base = cfg.llm_url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, 30000);
    try {
      var r = await NATIVE_FETCH(base + "/v1/chat/completions", { method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.llm_model || "local", messages: messages, temperature: 0.4, max_tokens: 400 }) });
      clearTimeout(to);
      if (!r.ok) return null;
      var j = await r.json();
      var t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return t ? String(t).trim() : null;
    } catch (_) { clearTimeout(to); return null; }
  }
  function evalWords(ev, side) {
    if (ev === "mate") return "checkmate"; if (ev === "draw") return "a draw";
    var cp = capCp(evCp(ev));
    var who = cp > 0 ? side : (side === "White" ? "Black" : "White");
    if (ev.type === "mate") return who + " has a forced mate";
    var a = Math.abs(cp);
    return a < 30 ? "equal" : a < 100 ? "slightly better for " + who : a < 250 ? "clearly better for " + who : "winning for " + who;
  }
  function cctOf(fen) {
    var ch = mkChess(fen), moves = ch.moves({ verbose: true });
    var checks = [], captures = [];
    moves.forEach(function (m) {
      if (/[+#]/.test(m.san)) checks.push(m.san);
      if (m.captured) {
        var gain = PIECE_VAL[m.captured] - (PIECE_VAL[m.piece] || 0);
        var t = tryChess(fen); t.move(m.san);
        var defended = t.moves({ verbose: true }).some(function (r) { return r.to === m.to; });
        var cls = !defended || gain > 50 ? "winning" : gain >= -50 ? "even" : "losing";
        captures.push({ san: m.san, cls: cls, label: cls === "winning" ? "wins material" : cls === "even" ? "a trade" : "loses material" });
      }
    });
    // threats: what the opponent could capture/check if it were their move
    var p = ch.fen().split(" "); p[1] = p[1] === "w" ? "b" : "w"; p[3] = "-";
    var threats = [];
    var t2 = tryChess(p.join(" "));
    if (t2 && !ch.inCheck()) t2.moves({ verbose: true }).forEach(function (m) {
      if (/#/.test(m.san)) threats.push({ san: m.san, why: "checkmate threat" });
      else if (m.captured && PIECE_VAL[m.captured] >= 300) threats.push({ san: m.san, why: "attacks your " + PIECE_NAME[m.captured] });
    });
    return { checks: checks.slice(0, 8), captures: captures.slice(0, 8), threats: threats.slice(0, 6) };
  }
  async function coachFacts(fen, depth) {
    var a = await analysePos(fen, { depth: clamp(depth || 12, 6, 18), multipv: 3, priority: "high" });
    var side = fen.split(" ")[1] === "w" ? "White" : "Black";
    return { a: a, side: side };
  }

  route("POST", "/api/coach/comment", async function (b) {
    var f = await coachFacts(mkChess(b.fen).fen(), 12), a = f.a;
    if (a.terminal) return { commentary: "The game is over (" + a.result + ", " + a.reason + ").", source: "template", persona: false };
    var txt = "The position is " + evalWords(a.eval, f.side) + ". " + f.side + "'s best is " + a.best_san +
      (a.lines[0] && a.lines[0].moves_san.length > 1 ? " (" + a.lines[0].moves_san.slice(0, 4).join(" ") + ")" : "") + ". " + stepReason(a.fen, a.best);
    if (a.lines[1]) txt += " " + a.lines[1].moves_san[0] + " is the main alternative.";
    var llm = await llmChat([{ role: "system", content: "You are a concise chess coach. Use ONLY these verified facts, 2-3 sentences: " + txt }, { role: "user", content: "Comment on this position. FEN " + a.fen }]);
    return { commentary: llm || txt, source: llm ? "llm" : "template", persona: false };
  });
  route("POST", "/api/coach/discuss", async function (b) {
    var fen = mkChess(b.fen).fen();
    var f = await coachFacts(fen, b.depth), a = f.a;
    if (a.terminal) return { terminal: true, result: a.result, reason: a.reason };
    var cct = cctOf(fen);
    var cands = [];
    for (var i = 0; i < a.lines.length; i++) {
      var l = a.lines[i], u = l.moves_uci[0], mf = moveFacts(fen, u);
      var pros = [stepReason(fen, u)], cons = [];
      if (i > 0) { var loss = capCp(evCp(a.lines[0].eval)) - capCp(evCp(l.eval)); if (loss > 30) cons.push("about " + (loss / 100).toFixed(1) + " pawns worse than " + a.best_san); }
      if (mf && mf.piece === "k" && !mf.castle) cons.push("moves the king");
      cands.push({ san: l.moves_san[0], uci: u, eval: l.eval, pros: pros, cons: cons,
        reply: l.moves_san[1] ? { san: l.moves_san[1], reason: stepReason(mf.fen_after, l.moves_uci[1]) } : null });
    }
    var disc = "The position is " + evalWords(a.eval, f.side) + ". The engine's top choices are " + cands.map(function (c) { return c.san; }).join(", ") + ".";
    var llm = await llmChat([{ role: "system", content: "You are a Socratic chess coach. Verified facts: " + disc + " Checks: " + cct.checks.join(",") + "." }, { role: "user", content: "Discuss the candidate moves briefly." }]);
    return { terminal: false, result: null, reason: null, persona: false, source: llm ? "llm" : "template",
      socratic: ["What checks, captures and threats do both sides have?", "Which of your pieces is doing the least, and how could it improve?", "What is your opponent's best idea if you pass?"],
      discussion: llm || disc, cct: cct, candidates: cands };
  });
  route("POST", "/api/coach/suggest", async function (b) {
    var fen = mkChess(b.fen).fen();
    var f = await coachFacts(fen, 12), a = f.a;
    if (a.terminal) return { suggestions: [], master_note: "The game is over." };
    return { suggestions: a.lines.map(function (l) { return { move_san: l.moves_san[0], move_uci: l.moves_uci[0], plan: stepReason(fen, l.moves_uci[0]), eval: l.eval, line_san: l.moves_san.slice(0, 6) }; }),
      master_note: "Engine suggestions (in-browser Stockfish). Compare the plans, not just the numbers." };
  });
  var chatSessions = {};
  route("POST", "/api/coach/chat", async function (b) {
    var fen = mkChess(b.fen).fen();
    var sid = b.session_id || uid("chat");
    var hist = chatSessions[sid] = chatSessions[sid] || [];
    var f = await coachFacts(fen, 12), a = f.a;
    var moveMap = {};
    a.lines.forEach(function (l) { l.moves_san.forEach(function (s, i) { if (i === 0) moveMap[s] = l.moves_uci[0]; }); });
    var facts = a.terminal ? "The game is over (" + a.result + ")." :
      "Position: " + evalWords(a.eval, f.side) + ". Best: " + a.best_san + " (" + (a.lines[0] ? a.lines[0].moves_san.slice(0, 4).join(" ") : "") + "). Alternatives: " + a.lines.slice(1).map(function (l) { return l.moves_san[0]; }).join(", ") + ".";
    var msg = String(b.message || "").trim();
    var reply = null;
    if (msg) {
      hist.push({ role: "user", content: msg });
      reply = await llmChat([{ role: "system", content: "You are a friendly, concise chess coach. Use only these verified engine facts; never invent moves. " + facts + " FEN " + fen }].concat(hist.slice(-8)));
    }
    var source = reply ? "llm" : "template";
    if (!reply) {
      var cct = a.terminal ? { checks: [], captures: [], threats: [] } : cctOf(fen);
      reply = (!msg ? "Hi! Before choosing a move: what checks, captures and threats are there? " : "") +
        facts + (cct.threats.length ? " Watch out: " + cct.threats.map(function (t) { return t.san + " (" + t.why + ")"; }).slice(0, 2).join("; ") + "." : "") +
        "";
    }
    hist.push({ role: "assistant", content: reply });
    if (hist.length > 20) hist.splice(0, hist.length - 20);
    return { session_id: sid, reply: reply, move_map: moveMap, source: source, persona: false,
      suggestions: ["What's the plan here?", "What is my opponent threatening?", "Why is " + (a.best_san || "that") + " best?"] };
  });

  route("GET", "/api/coach/voice-status", function () { return { enabled: false, available: false, providers: { edge: false, xtts: false, sapi: false } }; });
  route("POST", "/api/coach/speak", function () { fail(503, "voice_unavailable"); });
  route("GET", "/api/maia/status", function () { return { available: false, reason: "Maia human-move models are not available in the static web build." }; });
  route("POST", "/api/maia/human-moves", function () { fail(503, "maia_unavailable"); });
  route("GET", "/api/human/stats", function () { return { available: false, moves: [] }; });

  /* ------------------------------------------------------------------ */
  /* v39: the player's own training data, bundled under data/mine/        */
  /* First visit imports it into browser storage; /api/mine/reload resets */
  /* ------------------------------------------------------------------ */
  var MINE_SET_ID = "set-mine";
  async function mineAnalysis(hash) {
    var idx = S.get("mineIdx", null);
    if (!idx || !idx[hash]) return null;
    try {
      var a = clone(await loadData("mine/analyses/" + idx[hash] + ".json"));
      a.pgn_hash = hash;
      return a;
    } catch (_) { return null; }
  }
  async function mergeStyleCards(cj) {
    /* v44: merge new mistake cards by id without a full reload */
    if (!cj || !cj.cards) return { added: 0 };
    var rev = cj.cards_revision || null;
    if (rev && S.get("mineCardsRevision") === rev) return { added: 0 };
    var before = cards().length;
    var mapped = cj.cards.map(function (c) {
      return { fen_before: c.fen_before, best_uci: c.best_uci, uci: c.uci, san: c.san,
        title: c.title, explanation: c.explanation, motif: c.motif || "missed_capture",
        classification: c.classification || "mistake" };
    });
    /* Prefer stable ids from the file when present */
    var deck = cards(), byKey = {};
    deck.forEach(function (c) { byKey[c.id] = c; });
    var added = 0;
    cj.cards.forEach(function (c) {
      if (!c.id || !c.fen_before || !c.best_uci) return;
      if (byKey[c.id]) return;
      var built = cardFromMistake({ fen_before: c.fen_before, best_uci: c.best_uci, uci: c.uci, san: c.san,
        title: c.title, explanation: c.explanation, motif: c.motif || "missed_capture",
        classification: c.classification || "mistake" }, c.source || "my-cards");
      if (!built) return;
      /* Prefer the stable style-review id so merges stay idempotent */
      if (c.id) { built.id = c.id; }

      if (c.url) built.url = c.url;
      deck.push(built);
      byKey[c.id] = built;
      added++;
    });
    if (added) saveCards(deck);
    if (rev) S.set("mineCardsRevision", rev);
    return { added: added };
  }
  async function importMine(force) {
    var gj = await loadData("mine/games.json"), cj = await loadData("mine/cards.json");
    if (!force && S.get("mineVersion") === gj.version) {
      try { await mergeStyleCards(cj); } catch (_) {}
      return mineStatus();
    }
    var first = !S.get("mineVersion");
    // 1. names + level (only the non-secret prefs from his config)
    var cfg = S.get("config", {});
    var names = String(cfg.my_names || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    (gj.me || []).forEach(function (n) { if (names.map(function (x) { return x.toLowerCase(); }).indexOf(n.toLowerCase()) === -1) names.push(n); });
    cfg.my_names = names.join(",");
    if (gj.level && !cfg.level) cfg.level = gj.level;
    S.set("config", cfg);
    // 2. games -> library (+ hash -> bundled analysis file)
    var mineIdx = {}, recs = [];
    gj.games.forEach(function (g, i) {
      var meAcc = g.accuracy[g.my_side];
      var r = gameRecord(g.pgn, { source: "mine", date: "", time_class: "", my_side: g.my_side, my_accuracy: meAcc,
        my_blunders: g.blunders[g.my_side], mine_no: gj.games.length - i, opening: "" });
      r.id = "g" + r.pgn_hash;
      mineIdx[r.pgn_hash] = g.id;
      recs.push(r);
    });
    S.set("mineIdx", mineIdx);
    var lib = S.get("games", []).filter(function (g) { return g.source !== "mine"; });
    S.set("games", lib);
    addToLibrary(recs);
    // 3. analyses index (feeds Progress accuracy trend, profile, openings)
    var t0 = Date.now() - gj.games.length * 3600000;
    var idx = analysisIndex().filter(function (r) { return !r.mine; });
    var mineRows = gj.games.map(function (g, i) {
      var h = recs[i].pgn_hash;
      return { key: h + ":12", pgn_hash: h, white: g.white, black: g.black, result: g.result, date: "", mine: true,
        accuracy_white: g.accuracy.white, accuracy_black: g.accuracy.black, at: new Date(t0 + i * 3600000).toISOString(),
        blunders_white: g.blunders.white, blunders_black: g.blunders.black, motifs: g.motifs };
    }).reverse();
    S.set("analyses", idx.concat(mineRows).slice(0, 200));
    // 4. flashcards: his 24 cards due now, missed positions from his games spread over the next two weeks
    var deck = cards().filter(function (c) { return !/^my-/.test(c.source || ""); });
    saveCards(deck);
    var rc = addCards(cj.cards.map(function (c) { return { fen_before: c.fen_before, best_uci: c.best_uci, uci: c.uci, san: c.san,
      title: c.title, explanation: c.explanation, motif: c.motif, classification: c.classification }; }), "my-cards");
    try { await mergeStyleCards(cj); } catch (_) {}
    var misses = [];
    gj.games.forEach(function (g) { g.misses.forEach(function (m) { misses.push(m); }); });
    misses.sort(function (a, b) { return b.cpl - a.cpl; });
    var rg = addCards(misses, "my-games");
    var due = {}, n = 0;
    rg.ids.forEach(function (id) { due[id] = new Date(Date.now() + Math.floor(n++ / 8) * 86400000).toISOString(); });
    saveCards(cards().map(function (c) { if (due[c.id]) c.due_at = due[c.id]; return c; }));
    // 5. Cycles: a default Woodpecker set = his cards + the worst missed positions
    var allSets = sets().filter(function (x) { return x.id !== MINE_SET_ID; });
    var pickIds = rc.ids.concat(rg.ids.slice(0, 26)), byId = {};
    cards().forEach(function (c) { byId[c.id] = c; });
    var chosen = pickIds.map(function (id) { return byId[id]; }).filter(Boolean);
    if (chosen.length) {
      allSets.unshift({ id: MINE_SET_ID, name: "My mistakes — " + rc.ids.length + " cards + " + Math.min(26, rg.ids.length) + " missed positions", kind: "source", value: "my-",
        cards: chosen.map(function (c) { return { id: c.id, fen_before: c.fen_before, best_uci: c.best_uci, best_san: c.best_san,
          played_san: c.played_san, played_uci: c.played_uci, title: c.title, hint: c.hint, motif: c.motif, explanation: c.explanation }; }),
        cycles: [], prs: {}, created_at: nowIso() });
    }
    saveSets(allSets);
    // 6. stale caches that depend on the library
    S.del("egLeakCache"); S.del("sparringOwn");
    S.set("mineEndgames", gj.games.filter(function (g) { return g.endgame_fen; }).map(function (g) {
      return { fen: g.endgame_fen, label: "#" + (gj.games.length - gj.games.indexOf(g)) + " (" + g.white + " – " + g.black + ")" }; }));
    S.set("mineVersion", gj.version); S.set("mineImportedAt", nowIso());
    if (cj.cards_revision) S.set("mineCardsRevision", cj.cards_revision);
    var st = mineStatus();
    st.first_import = first; st.cards_added = rc.added; st.misses_added = rg.added;
    return st;
  }
  function mineStatus() {
    var deck = cards();
    return { version: S.get("mineVersion") || null, imported_at: S.get("mineImportedAt") || null,
      games: S.get("games", []).filter(function (g) { return g.source === "mine"; }).length,
      cards: deck.filter(function (c) { return c.source === "my-cards"; }).length,
      missed_positions: deck.filter(function (c) { return c.source === "my-games"; }).length,
      names: String(getConfig().my_names || ""), level: getConfig().level || null };
  }
  route("GET", "/api/mine/status", async function () { if (MINE_READY) { try { await MINE_READY; } catch (_) {} } return mineStatus(); });
  route("POST", "/api/mine/reload", async function () { MINE_READY = importMine(true); return await MINE_READY; });
  MINE_READY = importMine(false).then(function (st) {
    if (st && st.first_import) window.dispatchEvent(new CustomEvent("cc-mine-imported", { detail: st }));
    return st;
  }).catch(function (e) { console.info("[chesscoach] my data not loaded:", e && e.message); });

  /* ------------------------------------------------------------------ */
  /* v42: Calculation trainer (ported from the newer frontend, client-side) */
  /* ------------------------------------------------------------------ */
  function nullMoveFen(fen) { var p = mkChess(fen).fen().split(" "); p[1] = p[1] === "w" ? "b" : "w"; p[3] = "-"; return p.join(" "); }
  route("POST", "/api/calc/position", async function (b) {
    var src = b.source || "mixed", seen = new Set(b.seen_ids || []), pool = [];
    if (src === "puzzle" || src === "mixed") {
      var pz = (await loadData("puzzles.json")).puzzles.filter(function (p) { return p.moves_uci.length >= 3; });
      pz.forEach(function (p) { pool.push({ id: "p:" + p.id, fen: p.fen, label: "Curated tactic (" + THEME_LABEL(p.theme) + ", " + p.rating + ")", src: "puzzle" }); });
    }
    if (src === "mygame" || src === "mixed") {
      cards().filter(function (c) { return /^my-|miss|puzzle|attacks/.test(c.source || ""); }).forEach(function (c) {
        pool.push({ id: "c:" + c.id, fen: c.fen_before, label: c.source === "my-cards" || c.source === "my-games" ? "From your games" : "From your misses", src: "mygame" }); });
    }
    if (src === "mixed") {
      var at = await loadData("attacks.json");
      (at.patterns || []).forEach(function (pt) { (pt.puzzles || []).forEach(function (q, i) { pool.push({ id: "a:" + pt.id + i, fen: q.fen, label: "Kingside attack — " + pt.name, src: "attacks" }); }); });
    }
    if (!pool.length) fail(404, "no_positions");
    var fresh = pool.filter(function (x) { return !seen.has(x.id); });
    var choice = pick(fresh.length ? fresh : pool);
    var c = cctOf(choice.fen);
    return { id: choice.id, fen: mkChess(choice.fen).fen(), label: choice.label, source: choice.src,
      forcing_counts: { total: new Set(c.checks.concat(c.captures.map(function (x) { return x.san; }))).size } };
  });
  function moveKind(fen, uci) { var f = moveFacts(fen, uci); return !f ? "quiet" : f.mate ? "mate" : f.check ? "check" : f.captured ? "capture" : "quiet"; }
  route("POST", "/api/calc/solution", async function (b) {
    var fen = mkChess(b.fen).fen(), plies = clamp(b.plies || 5, 1, 9);
    var a = await analysePos(fen, { depth: 14, movetime: 2500, multipv: 1, priority: "high", pvLen: plies });
    var line = [], cur = fen, pv = (a.lines[0] && a.lines[0].moves_uci) || [];
    for (var i = 0; i < Math.min(plies, pv.length); i++) { var f = moveFacts(cur, pv[i]); if (!f) break; line.push({ uci: pv[i], san: f.san, kind: moveKind(cur, pv[i]) }); cur = f.fen_after; }
    return { line: line, eval: a.eval };
  });
  route("POST", "/api/calc/check", async function (b) {
    var fen = mkChess(b.fen).fen(), moves = (b.moves_uci || []).slice(0, 9);
    var steps = [], cur = fen, clean = 0, cleanBroken = false, correct = 0;
    for (var i = 0; i < moves.length; i++) {
      var f = moveFacts(cur, moves[i]);
      if (!f) { steps.push({ ply: i + 1, side: i % 2 ? "them" : "you", played_uci: moves[i], verdict: "illegal" }); cleanBroken = true; break; }
      var pre = await analysePos(cur, { depth: 12, movetime: 1500, multipv: 1, priority: "high" });
      var bestCp = capCp(evCp(pre.eval));
      var post = await analysePos(f.fen_after, { depth: 12, movetime: 1500, multipv: 1, priority: "high" });
      var afterCp = post.terminal ? (post.reason === "checkmate" ? 1500 : 0) : capCp(-evCp(post.eval));
      var loss = moves[i] === pre.best ? 0 : Math.max(0, Math.round(bestCp - afterCp));
      var verdict = loss === 0 ? "best" : loss <= 40 ? "good" : loss < 100 ? "inaccuracy" : loss < 250 ? "mistake" : "blunder";
      var ok = loss <= 40;
      if (ok) correct++;
      if (!ok) cleanBroken = true;
      if (!cleanBroken && i % 2 === 0) clean++;
      steps.push({ ply: i + 1, side: i % 2 ? "them" : "you", played_uci: moves[i], played_san: f.san, verdict: verdict, best_san: pre.best_san, best_uci: pre.best, loss_cp: loss, fen_before: cur });
      cur = f.fen_after;
      if (post.terminal) break;
    }
    var sol = await dispatch("POST", "/api/calc/solution", { fen: fen, plies: Math.max(moves.length, 3) });
    var firstBad = steps.find(function (s) { return s.verdict !== "best" && s.verdict !== "good"; });
    if (firstBad && firstBad.best_uci && firstBad.verdict !== "illegal") {
      addMisses([{ fen_before: firstBad.fen_before, best_uci: firstBad.best_uci, uci: firstBad.played_uci, title: "Calculation — ply " + firstBad.ply + " (" + (firstBad.side === "you" ? "your move" : "their reply") + ")",
        explanation: "In your calculated line, " + firstBad.played_san + " was a " + firstBad.verdict + "; " + firstBad.best_san + " was the move.", motif: "positional" }], "calc");
    }
    var coach = !steps.length ? null : firstBad
      ? "Your line held for " + clean + " move" + (clean === 1 ? "" : "s") + ". It broke at ply " + firstBad.ply + ": " + (firstBad.side === "them"
        ? "you expected " + firstBad.played_san + ", but the opponent has " + firstBad.best_san + ". Check their forcing replies before you go deeper."
        : firstBad.played_san + " gives away " + (firstBad.loss_cp / 100).toFixed(1) + "; " + firstBad.best_san + " was stronger.")
      : "Clean all the way — every ply holds up against the engine.";
    logActivity("tactics", "calc");
    return { steps: steps, correct_plies: correct, clean_depth_moves: clean, solution: sol, coach: coach ? { coach: "Coach", commentary: coach } : null };
  });
  route("POST", "/api/calc/census", async function (b) {
    var fen = mkChess(b.fen).fen();
    function side(f) {
      var ch = tryChess(f); if (!ch) return { counts: { total: 0 }, moves: [] };
      var list = [];
      ch.moves({ verbose: true }).forEach(function (m) {
        var t = tryChess(f); t.move(m.san);
        var kind = t.isCheckmate() ? "mate" : t.inCheck() ? "check" : m.captured ? "capture" : m.promotion ? "promotion" : null;
        if (!kind) {
          // a threat: after the move, it attacks an undefended or bigger piece
          var t2 = tryChess(nullMoveFen(t.fen()));
          if (t2 && !t.inCheck()) {
            var hits = t2.moves({ verbose: true }).filter(function (r) { return r.from === m.to && r.captured && (PIECE_VAL[r.captured] > (PIECE_VAL[m.piece] || 0) || !t.moves({ verbose: true }).some(function (d) { return d.to === r.to; })); });
            if (hits.length) kind = "threat";
          }
        }
        if (kind) list.push({ san: m.san, kind: kind, uci: m.from + m.to + (m.promotion || "") });
      });
      var counts = { total: list.length };
      list.forEach(function (x) { counts[x.kind === "mate" ? "check" : x.kind] = (counts[x.kind === "mate" ? "check" : x.kind] || 0) + 1; });
      return { counts: counts, moves: list.slice(0, 14), hidden: Math.max(0, list.length - 14) };
    }
    var you = side(fen), opp = mkChess(fen).inCheck() ? { counts: { total: 0 }, moves: [], note: "You are in check — they have no free move." } : side(nullMoveFen(fen));
    var coach = opp.counts.total > you.counts.total ? "They have more forcing moves than you. Before you calculate your own attack, list their checks and captures."
      : "Start with your checks, then captures, then threats — and give each one their best reply.";
    return { you: you, opponent: opp, coach: { coach: "Coach", commentary: coach } };
  });


  /* ---------- v43: Olympiad "Train these blunders" ---------- */
  var OLY_THEME = { "mate-allowed": "defensiveMove", "mate-missed": "mate", hung: "hangingPiece", fork: "defensiveMove", pin: "defensiveMove",
    discovery: "defensiveMove", "promo-allowed": "defensiveMove", "promo-missed": "promotion", "tactic-missed": "tactic", combination: "defensiveMove",
    king: "defensiveMove", endgame: "endgame", positional: "quietMove" };
  var OLY_MOTIF = { "mate-allowed": "allowed_mate", "mate-missed": "missed_mate", hung: "hanging_piece", fork: "allowed_tactic", pin: "allowed_tactic",
    discovery: "allowed_tactic", "promo-allowed": "ignored_threat", "promo-missed": "missed_capture", "tactic-missed": "missed_capture",
    combination: "allowed_tactic", king: "ignored_threat", endgame: "endgame_technique", positional: "positional" };
  var OLY_SET_ID = "set-olympiad";
  route("POST", "/api/olympiad/train", function (b) {
    var items = (b.items || []).slice(0, 40), puzzles = [], cardsIn = [], batch = Date.now();
    items.forEach(function (it, ix) {
      var ch = tryChess(it.fen);
      if (!ch || !it.best_uci) return;
      var best = moveFacts(it.fen, it.best_uci);
      if (!best) return;
      var played = it.played_uci ? moveFacts(it.fen, it.played_uci) : null;
      var fen = ch.fen(), theme = OLY_THEME[it.fam] || "quietMove";
      var swing = Math.abs(parseFloat(String(it.e0 || "0").replace("\u2212", "-")) - parseFloat(String(it.e1 || "0").replace("\u2212", "-"))) || 0;
      puzzles.push({
        id: "o:" + hashStr(fen.split(" ").slice(0, 4).join(" ") + it.best_uci), fen: fen, side_to_move: sideName(fen.split(" ")[1]),
        moves_uci: [it.best_uci], solution_san: [best.san], rating: clamp(Math.round(1350 + Math.min(swing, 6) * 60), 1200, 1900),
        theme: theme, themes: [theme], source: "user", origin: "olympiad", batch: batch, batch_ix: ix,
        played_san: played ? played.san : null, fam_name: String(it.fam_name || "").slice(0, 60), habit: String(it.habit || "").slice(0, 400),
        best_line: String(it.best_line || "").slice(0, 120),
        context: ("Olympiad 2026 \u00b7 " + String(it.game || "").slice(0, 80) + (it.rd ? ", round " + it.rd : "") + ": " + (it.label || "") +
          " was played here (" + (it.fam_name || "blunder") + ", " + (it.e0 || "") + " \u2192 " + (it.e1 || "") + "). Find the better move."),
        created_at: nowIso(),
      });
      cardsIn.push({ fen_before: fen, best_uci: it.best_uci, uci: it.played_uci || null, motif: OLY_MOTIF[it.fam] || "positional",
        title: "Olympiad: " + (it.label || "") + " (" + (it.fam_name || "blunder") + ")", explanation: String(it.habit || "").slice(0, 400) });
    });
    // re-sent positions go back to the front of the queue
    var store = S.get("userPuzzles", []), byId = {};
    puzzles.forEach(function (p) { byId[p.id] = p; });
    var hadIds = new Set(store.map(function (p) { return p.id; }));
    store = store.filter(function (p) { return !byId[p.id]; }).concat(puzzles);
    S.set("userPuzzles", store.slice(-1500));
    var hist = S.get("puzzleHistory", {});
    puzzles.forEach(function (p) { if (hist[p.id]) { delete hist[p.id].solved; delete hist[p.id].revealed; } });
    S.set("puzzleHistory", hist);
    S.set("puzzlePrefer", "olympiad");
    var r = addCards(cardsIn, "olympiad");
    var byCard = {}; cards().forEach(function (c) { byCard[c.id] = c; });
    var all = sets(), set = all.find(function (x) { return x.id === OLY_SET_ID; });
    if (!set) { set = { id: OLY_SET_ID, name: "Olympiad blunders", kind: "source", value: "olympiad", cards: [], cycles: [], prs: {}, created_at: nowIso() }; all.push(set); }
    var have = new Set(set.cards.map(function (c) { return c.id; }));
    cardsIn.forEach(function (m) {
      var c = byCard["c" + hashStr(tryChess(m.fen_before).fen() + m.best_uci)];
      if (c && !have.has(c.id)) { have.add(c.id); set.cards.push({ id: c.id, fen_before: c.fen_before, best_uci: c.best_uci, best_san: c.best_san,
        played_san: c.played_san, played_uci: c.played_uci, title: c.title, hint: c.hint, motif: c.motif, explanation: c.explanation }); }
    });
    set.cards = set.cards.slice(-60);
    saveSets(all);
    return { received: items.length, puzzles_added: puzzles.filter(function (p) { return !hadIds.has(p.id); }).length, puzzles_queued: puzzles.length,
      cards_added: r.added, cards_present: r.already_present, set_size: set.cards.length };
  });

  window.__CC_SHIM_ROUTES__ = ROUTES.length;
  window.ChessCoachShim = { dispatch: dispatch, storage: S, version: SHIM_VERSION,
    reset: function () { Object.keys(localStorage).filter(function (k) { return k.indexOf(NS) === 0; }).forEach(function (k) { localStorage.removeItem(k); }); } };
})();
