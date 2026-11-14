/* =====================================================================
   Import recent rated Lichess games in the browser (no token).

   The bulk download works from a page when Accept is application/x-ndjson
   (without that header Lichess returns 404). CORS is open. evals=true
   includes server analysis when Lichess has it, in centipawns from White
   after each move. If that download 404s, game ids are taken from
   /api/user/{user}/activity and the games are loaded with
   POST /api/games/export/_ids, then per-game /game/export/{id}.

   Stockfish runs only where a server eval or a best move is missing.
   New mistake cards and Finish it starts go in cc-deck-local-v1.
   ===================================================================== */
(function () {
  "use strict";

  var USER_KEY = "cc-lichess-user-v1";
  var SEEN_KEY = "cc-lichess-seen-v1";
  var DECK_KEY = "cc-deck-local-v1";
  /* Deck stored +3.1 here; a deeper read was +2.85, so it is not a Finish it start. */
  var SKIP_FINISH = { "XtnIByaY#40": 1 };
  var state = { busy: false, stop: false, ctrl: null };

  function $(id) { return document.getElementById(id); }
  function liStatus(msg) {
    var el = $("li-status");
    if (el) el.textContent = msg || "";
  }
  function liBusy(on) {
    state.busy = on;
    var go = $("btn-li-import"), stop = $("btn-li-cancel"), user = $("li-user"), max = $("li-max");
    if (go) go.disabled = on;
    if (stop) stop.classList.toggle("hidden", !on);
    if (user) user.disabled = on;
    if (max) max.disabled = on;
  }
  function liUser() {
    var el = $("li-user");
    var v = (el && el.value || "").trim();
    return v || "Jetblack007";
  }
  function liSaveUser(name) {
    try { localStorage.setItem(USER_KEY, name); } catch (_) {}
  }
  function liLoadUser() {
    var el = $("li-user");
    if (!el) return;
    var v = "";
    try { v = localStorage.getItem(USER_KEY) || ""; } catch (_) {}
    el.value = v || "Jetblack007";
  }
  function liSeen() {
    try {
      var v = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }
  function liMarkSeen(id) {
    var v = liSeen();
    if (v.indexOf(id) === -1) v.push(id);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(v.slice(-400))); } catch (_) {}
  }
  function liWp(cp) {
    if (typeof deckWp === "function") return deckWp(cp);
    cp = Math.max(-1500, Math.min(1500, cp));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }
  function liFmt(cp) {
    if (typeof deckFmt === "function") return deckFmt(cp);
    if (Math.abs(cp) >= 9000) return cp > 0 ? "mate" : "−mate";
    return (cp > 0 ? "+" : cp < 0 ? "−" : "") + (Math.abs(cp) / 100).toFixed(1);
  }
  function liCancel() {
    var e = new Error("cancelled");
    e.cancel = true;
    return e;
  }
  function liRateError(r) {
    var wait = r && r.headers && r.headers.get && r.headers.get("Retry-After");
    var e = new Error("Lichess rate limit (429). " + (wait ? "Wait " + wait + " seconds and try again." : "Wait a minute and try again."));
    e.rate = true;
    return e;
  }
  function liMateMag(m) {
    if (!m) return 0;
    var mag = 10000 - Math.min(80, Math.abs(m)) * 10;
    return m > 0 ? mag : -mag;
  }
  function liWhiteFromServer(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.mate === "number") return liMateMag(entry.mate);
    if (typeof entry.eval === "number") return entry.eval;
    return null;
  }
  function liScoreCp(score) {
    if (!score) return null;
    if (score.type === "mate") return liMateMag(score.value);
    if (score.type === "cp") return score.value;
    return null;
  }
  async function liKeys() {
    var ids = {}, gp = {}, fen = {};
    function add(c) {
      if (!c || c.marker) return;
      if (c.id) ids[c.id] = 1;
      var gid = c.game_id || c.gameId;
      if (gid != null && c.ply != null && c.ply !== "") gp[String(gid) + "#" + c.ply] = 1;
      if (c.fen) fen[String(c.fen).split(" ").slice(0, 4).join(" ")] = 1;
    }
    try {
      var bundled = await fetch("data/mine/deck.json?v=59", { cache: "no-cache" });
      if (bundled.ok) {
        var data = await bundled.json();
        ((data && data.cards) || []).forEach(add);
      }
    } catch (_) {}
    try {
      var local = JSON.parse(localStorage.getItem(DECK_KEY) || "[]");
      if (Array.isArray(local)) local.forEach(add);
    } catch (_) {}
    if (window.Deck && Deck.byId) Object.keys(Deck.byId).forEach(function (k) { add(Deck.byId[k]); });
    if (window.FinishIt && FinishIt.positions) {
      try { FinishIt.positions().forEach(add); } catch (_) {}
    }
    return { ids: ids, gp: gp, fen: fen };
  }
  function liTaken(keys, id, gameId, ply, fen) {
    var fk = String(fen || "").split(" ").slice(0, 4).join(" ");
    return !!(keys.ids[id] || keys.gp[String(gameId) + "#" + ply] || (fk && keys.fen[fk]));
  }
  function liSave(cards) {
    var local = [];
    try { local = JSON.parse(localStorage.getItem(DECK_KEY) || "[]"); } catch (_) { local = []; }
    if (!Array.isArray(local)) local = [];
    var have = {};
    local.forEach(function (c) { if (c && c.id) have[c.id] = 1; });
    var n = 0;
    cards.forEach(function (c) {
      if (!c || !c.id || have[c.id]) return;
      local.push(c);
      have[c.id] = 1;
      n++;
    });
    try { localStorage.setItem(DECK_KEY, JSON.stringify(local)); }
    catch (_) { throw new Error("This browser could not store the new cards (storage is full)."); }
    return n;
  }
  function liPlaySans(fen, sans) {
    var ch;
    try { ch = new Chess(fen); } catch (_) { return { line: "", pv: [] }; }
    var out = [], pv = [];
    for (var i = 0; i < sans.length && i < 8; i++) {
      var turn = ch.turn(), num = ch.moveNumber(), m = null;
      try { m = ch.move(sans[i]); } catch (_) { m = null; }
      if (!m) break;
      pv.push(m.from + m.to + (m.promotion || ""));
      if (turn === "w") out.push(num + ". " + m.san);
      else if (!out.length) out.push(num + "… " + m.san);
      else out.push(m.san);
    }
    return { line: out.join(" "), pv: pv };
  }
  function liPvLine(fen, pv) {
    var ch;
    try { ch = new Chess(fen); } catch (_) { return { line: "", pv: [] }; }
    var out = [], kept = [];
    for (var i = 0; i < (pv || []).length && i < 8; i++) {
      var u = pv[i];
      if (!u || u.length < 4) break;
      var turn = ch.turn(), num = ch.moveNumber(), m = null;
      try { m = ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); } catch (_) { m = null; }
      if (!m) break;
      kept.push(u);
      if (turn === "w") out.push(num + ". " + m.san);
      else if (!out.length) out.push(num + "… " + m.san);
      else out.push(m.san);
    }
    return { line: out.join(" "), pv: kept };
  }
  function liSan(fen, uci) {
    if (typeof deckSan === "function") return deckSan(fen, uci);
    try {
      var ch = new Chess(fen);
      var m = ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
      return m ? m.san : uci;
    } catch (_) { return uci || ""; }
  }
  function liPhase(fen, moveNo) {
    var pieces = 0;
    try {
      pieces = new Chess(fen).board().flat().filter(function (x) { return x && x.type !== "p" && x.type !== "k"; }).length;
    } catch (_) { pieces = 8; }
    if (pieces <= 6) return "endgame";
    if (moveNo <= 12 && pieces > 10) return "opening";
    return "middlegame";
  }
  /* Lichess JSON "moves" is SAN ("e4 d6 Nf3"). "best" on an analysis entry is UCI. */
  function liApplyToken(ch, token) {
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token)) {
      var spec = { from: token.slice(0, 2), to: token.slice(2, 4) };
      if (token.length > 4) spec.promotion = token[4];
      return ch.move(spec);
    }
    return ch.move(token);
  }
  function liPositions(j) {
    var ch = j.initialFen ? new Chess(j.initialFen) : new Chess();
    var tokens = String(j.moves || "").trim().split(/\s+/).filter(Boolean);
    var pos = [];
    for (var i = 0; i < tokens.length; i++) {
      var fen = ch.fen();
      var m = null;
      try { m = liApplyToken(ch, tokens[i]); } catch (_) { m = null; }
      if (!m) break;
      pos.push({
        fen: fen, uci: m.from + m.to + (m.promotion || ""), san: m.san, ply: i,
        moveNo: parseInt(fen.split(" ")[5], 10) || 1
      });
    }
    return { pos: pos, finalFen: ch.fen() };
  }
  function liSide(j, user) {
    var u = String(user || "").toLowerCase();
    var w = j.players && j.players.white && j.players.white.user;
    var b = j.players && j.players.black && j.players.black.user;
    var wid = ((w && (w.id || w.name)) || "").toLowerCase();
    var bid = ((b && (b.id || b.name)) || "").toLowerCase();
    if (wid === u) return "white";
    if (bid === u) return "black";
    return null;
  }
  function liOpp(j, side) {
    var p = (j.players && j.players[side === "white" ? "black" : "white"]) || {};
    if (p.aiLevel) return "";
    if (p.user && p.user.name) return p.user.name;
    return "";
  }
  function liHasServer(analysis, n) {
    if (!analysis || !analysis.length) return false;
    var known = 0;
    for (var i = 0; i < analysis.length; i++) if (liWhiteFromServer(analysis[i]) != null) known++;
    return known >= Math.max(4, Math.floor(n * 0.6));
  }
  function liPick(pos, beforeWhite, afterWhite, hints, side) {
    var mistakes = [], firstPlus = null;
    for (var i = 0; i < pos.length; i++) {
      var mine = (pos[i].fen.split(" ")[1] === "w") === (side === "white");
      if (!mine) continue;
      var beforeW = beforeWhite[i];
      if (beforeW == null) continue;
      var playerBefore = side === "white" ? beforeW : -beforeW;
      if (playerBefore >= 300 && !firstPlus) firstPlus = { i: i, cp: playerBefore };
      var afterW = afterWhite[i];
      if (afterW == null) continue;
      var playerAfter = side === "white" ? afterW : -afterW;
      var h = hints[i] || {};
      var jud = h.judgment || "";
      var lossCp = playerBefore - playerAfter;
      var lossWp = liWp(playerBefore) - liWp(playerAfter);
      var best = h.best || "";
      if (best && best.slice(0, 4) === pos[i].uci.slice(0, 4)) continue;
      var big = (jud === "Mistake" || jud === "Blunder") && lossWp >= 8;
      if (!big && lossWp >= 10 && lossCp >= 80) big = true;
      if (!big) continue;
      mistakes.push({
        i: i, lossWp: lossWp, lossCp: lossCp, jud: jud, best: best,
        variation: h.variation || "", pv: h.pv || [],
        before: Math.round(playerBefore), after: Math.round(playerAfter)
      });
    }
    mistakes.sort(function (a, b) { return b.lossWp - a.lossWp || b.lossCp - a.lossCp; });
    return { mistakes: mistakes.slice(0, 3), firstPlus: firstPlus };
  }
  async function liEngineAt(fen) {
    var ch = new Chess(fen);
    if (ch.isGameOver()) {
      var stm = ch.isCheckmate() ? -10000 : 0;
      var white = ch.turn() === "w" ? stm : -stm;
      return { white: white, best: "", pv: [] };
    }
    var r = await CCEngine.analyse(fen, { depth: 8, movetime: 200, multipv: 1, priority: "low", skill: 20 });
    var stmCp = liScoreCp(r && r.lines && r.lines[0] && r.lines[0].score);
    if (stmCp == null) stmCp = 0;
    var whiteCp = (fen.split(" ")[1] === "w") ? stmCp : -stmCp;
    return {
      white: whiteCp,
      best: (r && r.bestmove) || "",
      pv: (r && r.lines && r.lines[0] && r.lines[0].pv) || []
    };
  }
  async function liScan(pos, finalFen, onPos) {
    var fens = pos.map(function (p) { return p.fen; }).concat([finalFen]);
    var white = [];
    var info = [];
    for (var i = 0; i < fens.length; i++) {
      if (state.stop) throw liCancel();
      if (onPos) onPos(i + 1, fens.length);
      var got = await liEngineAt(fens[i]);
      white[i] = got.white;
      if (i < pos.length) info[i] = { best: got.best, pv: got.pv, judgment: "", variation: "" };
    }
    var beforeWhite = [], afterWhite = [], hints = [];
    for (var k = 0; k < pos.length; k++) {
      beforeWhite[k] = white[k];
      afterWhite[k] = white[k + 1];
      hints[k] = info[k] || { best: "", pv: [], judgment: "", variation: "" };
    }
    return { beforeWhite: beforeWhite, afterWhite: afterWhite, hints: hints };
  }
  function liFromServer(pos, analysis) {
    var beforeWhite = [], afterWhite = [], hints = [];
    for (var i = 0; i < pos.length; i++) {
      beforeWhite[i] = i === 0 ? 0 : liWhiteFromServer(analysis[i - 1]);
      afterWhite[i] = liWhiteFromServer(analysis[i]);
      var e = analysis[i] || {};
      hints[i] = {
        best: e.best || "",
        variation: e.variation || "",
        pv: [],
        judgment: e.judgment && e.judgment.name || ""
      };
    }
    return { beforeWhite: beforeWhite, afterWhite: afterWhite, hints: hints };
  }
  async function liLine(fen, hint) {
    if (hint && hint.variation) {
      var played = liPlaySans(fen, String(hint.variation).trim().split(/\s+/).filter(Boolean));
      if (played.pv.length) return played;
    }
    if (hint && hint.pv && hint.pv.length) {
      var fromPv = liPvLine(fen, hint.pv);
      if (fromPv.pv.length) return fromPv;
    }
    if (hint && hint.best) return { line: "", pv: [hint.best] };
    if (!window.CCEngine) return { line: "", pv: [] };
    if (state.stop) throw liCancel();
    await CCEngine.ready();
    var r = await CCEngine.analyse(fen, { depth: 10, movetime: 400, multipv: 1, priority: "low", skill: 20 });
    var pv = (r && r.lines && r.lines[0] && r.lines[0].pv) || [];
    if ((!pv || !pv.length) && r && r.bestmove) pv = [r.bestmove];
    return liPvLine(fen, pv);
  }
  function liMistakeCard(g, p, hit, line) {
    var bestUci = (line.pv && line.pv[0]) || hit.best || "";
    if (!bestUci) return null;
    var bestSan = liSan(p.fen, bestUci);
    var phase = liPhase(p.fen, p.moveNo);
    var theme = hit.jud === "Blunder" ? "Blunder" : "Mistake";
    var swing = liFmt(hit.before) + " → " + liFmt(hit.after);
    var drop = Math.max(0, Math.round(hit.lossWp));
    return {
      id: "md-lichess-" + g.id + "-" + p.ply,
      fen: p.fen, side: g.side, played_uci: p.uci, played_san: p.san,
      best_uci: bestUci, best_san: bestSan,
      accept: [bestUci], accept_san: [bestSan],
      best_line: line.line || "", refute_line: "", best_pv: (line.pv || []).slice(0, 8), refute_pv: [],
      eval_before: hit.before, eval_after: hit.after, swing: swing,
      wp_before: +liWp(hit.before).toFixed(1), wp_after: +liWp(hit.after).toFixed(1),
      wp_loss: drop, cost: drop, theme: theme, kind: hit.jud === "Blunder" ? "allowed" : "missed",
      title: theme + " — you played " + p.san,
      explanation: "You played " + p.san + " and your win chance fell by " + drop + "% (" + swing + "). "
        + bestSan + " was the move" + (line.line ? ": " + line.line + "." : ".")
        + " Checks, captures and threats before a quiet move.",
      phase: phase, move_no: p.moveNo, ply: p.ply,
      opening: g.opening || "Game", source: "lichess", game_id: g.id,
      url: "https://lichess.org/" + g.id + "#" + p.ply,
      game_label: "Lichess vs " + (g.opp || "opponent") + (g.date ? ", " + g.date : ""),
      date: g.date || "", opp: g.opp || "", result: g.result || "",
      seen: 1, local: true, imported: true, training: false,
      engine_note: hit.fromEngine ? "Stockfish in the browser, short search." : "Lichess server eval.",
      added_at: new Date().toISOString()
    };
  }
  function liFinishCard(g, p, cp, line) {
    var bestUci = (line && line.pv && line.pv[0]) || "";
    var bestSan = bestUci ? liSan(p.fen, bestUci) : "";
    return {
      id: "fi-lichess-" + g.id + "-" + p.ply,
      fen: p.fen, side: g.side, move_no: p.moveNo, ply: p.ply,
      opening: g.opening || "Game", opp: g.opp || "", date: g.date || "",
      url: "https://lichess.org/" + g.id + "#" + p.ply, game_id: g.id,
      eval_before: Math.round(cp),
      best_san: bestSan, best_uci: bestUci, best_line: (line && line.line) || "",
      best_pv: (line && line.pv) || [], played_san: "", played_uci: "",
      accept: bestUci ? [bestUci] : [], accept_san: bestSan ? [bestSan] : [],
      swing: liFmt(Math.round(cp)), wp_before: +liWp(cp).toFixed(1), wp_after: +liWp(cp).toFixed(1),
      wp_loss: 0, cost: 0, theme: "Conversion", kind: "finish",
      title: "Finish it — you were " + liFmt(Math.round(cp)),
      explanation: "A winning position from your game. Convert it in Finish it.",
      blurb: "Imported from your rated game" + (g.opp ? " vs " + g.opp : "") + ". You are "
        + (g.side === "white" ? "White" : "Black") + " and " + liFmt(Math.round(cp)) + ". Play it out.",
      phase: liPhase(p.fen, p.moveNo), source: "lichess",
      game_label: "Lichess vs " + (g.opp || "opponent") + (g.date ? ", " + g.date : ""),
      finish_start: true, imported: true, training: false, local: true, seen: 1,
      variant: "Standard", added_at: new Date().toISOString()
    };
  }
  async function liAnalyse(j, user, keys, onPos) {
    var side = liSide(j, user);
    if (!side) return { cards: [], scanned: false, skip: "not your game" };
    var other = (j.players && j.players[side === "white" ? "black" : "white"]) || {};
    if (other.aiLevel) return { cards: [], scanned: false, skip: "bot" };
    var opp = liOpp(j, side) || "opponent";
    if (j.variant && j.variant !== "standard") return { cards: [], scanned: false, skip: "variant" };
    if (j.rated === false) return { cards: [], scanned: false, skip: "unrated" };
    var built = liPositions(j);
    var pos = built.pos;
    if (pos.length < 8 && j.status === "started") return { cards: [], scanned: false, skip: "unfinished" };
    if (pos.length < 4) return { cards: [], scanned: false, skip: "too short" };
    var pack, scanned = false;
    if (liHasServer(j.analysis, pos.length)) pack = liFromServer(pos, j.analysis);
    else {
      if (!window.CCEngine) throw new Error("The in-browser engine is not loaded, and this game has no Lichess evals.");
      await CCEngine.ready();
      scanned = true;
      pack = await liScan(pos, built.finalFen, onPos);
    }
    var picked = liPick(pos, pack.beforeWhite, pack.afterWhite, pack.hints, side);
    var g = {
      id: j.id, side: side, opp: opp, opening: (j.opening && j.opening.name) || "Game",
      date: "", result: j.winner === "white" ? "1-0" : j.winner === "black" ? "0-1" : (j.status === "draw" ? "1/2-1/2" : "")
    };
    try { if (j.createdAt) g.date = new Date(j.createdAt).toISOString().slice(0, 10); } catch (_) { g.date = ""; }
    var cards = [], skipped = 0, sf = 0;
    var mistakePly = {};
    for (var m = 0; m < picked.mistakes.length; m++) {
      if (state.stop) throw liCancel();
      var hit = picked.mistakes[m];
      var p = pos[hit.i];
      var id = "md-lichess-" + j.id + "-" + p.ply;
      if (liTaken(keys, id, j.id, p.ply, p.fen)) { skipped++; continue; }
      var hint = pack.hints[p.ply] || {};
      var need = !(hint.variation || (hint.pv && hint.pv.length) || hint.best);
      if (need) sf++;
      var line = await liLine(p.fen, hint);
      if (need) hit.fromEngine = true;
      var card = liMistakeCard(g, p, hit, line);
      if (!card) { skipped++; continue; }
      cards.push(card);
      mistakePly[p.ply] = card;
      keys.ids[card.id] = 1;
      keys.gp[j.id + "#" + p.ply] = 1;
      keys.fen[p.fen.split(" ").slice(0, 4).join(" ")] = 1;
    }
    var plus = picked.firstPlus;
    if (plus && !SKIP_FINISH[j.id + "#" + plus.i]) {
      var fp = pos[plus.i];
      var sameMistake = mistakePly[fp.ply] && (mistakePly[fp.ply].eval_before | 0) >= 300;
      var fid = "fi-lichess-" + j.id + "-" + fp.ply;
      var mid = "md-lichess-" + j.id + "-" + fp.ply;
      if (sameMistake || liTaken(keys, fid, j.id, fp.ply, fp.fen) || liTaken(keys, mid, j.id, fp.ply, fp.fen)) {
        skipped++;
      } else {
        var fhint = pack.hints[fp.ply] || {};
        var fline;
        if (fhint.variation || (fhint.pv && fhint.pv.length)) fline = await liLine(fp.fen, fhint);
        else { sf++; fline = await liLine(fp.fen, {}); }
        var fcard = liFinishCard(g, fp, plus.cp, fline);
        cards.push(fcard);
        keys.ids[fcard.id] = 1;
        keys.gp[j.id + "#" + fp.ply] = 1;
        keys.fen[fp.fen.split(" ").slice(0, 4).join(" ")] = 1;
      }
    }
    return { cards: cards, scanned: scanned, skipped: skipped, sf: sf };
  }
  function liCollectIds(node, out) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(function (x) { liCollectIds(x, out); }); return; }
    if (typeof node.id === "string" && /^[A-Za-z0-9]{8}$/.test(node.id) && typeof node.url === "string" && node.url.indexOf("lichess.org") !== -1) out.push(node.id);
    Object.keys(node).forEach(function (k) { if (k !== "id") liCollectIds(node[k], out); });
  }
  function liEvalComment(cmt) {
    if (!cmt) return {};
    var m = String(cmt).match(/\[%eval\s+(#(-?\d+)|(-?\d+(?:\.\d+)?))/);
    if (!m) return {};
    if (m[1] && m[1].charAt(0) === "#") return { mate: parseInt(m[2], 10) || 0 };
    if (m[3] != null) return { eval: Math.round(parseFloat(m[3]) * 100) };
    return {};
  }
  function liGameFromPgn(pgn) {
    var headers = {}, re = /\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g, m;
    while ((m = re.exec(pgn))) headers[m[1]] = m[2];
    var body = pgn.replace(/\[[^\]]*\]/g, " ");
    var depth = 0, main = "";
    for (var i = 0; i < body.length; i++) {
      var c = body[i];
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (!depth) main += c;
    }
    var comments = [];
    main = main.replace(/\{[^}]*\}/g, function (cmt) { comments.push(cmt); return " __C" + (comments.length - 1) + "__ "; });
    var tokens = main.split(/\s+/).filter(Boolean);
    var sans = [], evals = [], pending = null;
    tokens.forEach(function (t) {
      var cm = t.match(/^__C(\d+)__$/);
      if (cm) { pending = comments[+cm[1]]; return; }
      if (/^\d+\.(\.\.)?$/.test(t) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) return;
      sans.push(t);
      evals.push(pending);
      pending = null;
    });
    var ch = headers.FEN ? new Chess(headers.FEN) : new Chess();
    var ucis = [], analysis = [];
    for (var k = 0; k < sans.length; k++) {
      var mv = null;
      try { mv = ch.move(sans[k]); } catch (_) { mv = null; }
      if (!mv) break;
      ucis.push(mv.from + mv.to + (mv.promotion || ""));
      analysis.push(liEvalComment(evals[k]));
    }
    var id = headers.GameId || "";
    if (!id && headers.Site) {
      var im = String(headers.Site).match(/([A-Za-z0-9]{8})\/?$/);
      if (im) id = im[1];
    }
    var event = headers.Event || "";
    var created = Date.parse((headers.UTCDate || headers.Date || "").replace(/\./g, "-") + "T" + (headers.UTCTime || "00:00:00") + "Z");
    var variant = headers.Variant && headers.Variant !== "Standard" ? "fromPosition" : "standard";
    return {
      id: id, rated: /rated/i.test(event), variant: variant,
      createdAt: isNaN(created) ? Date.now() : created,
      status: headers.Result === "1/2-1/2" ? "draw" : "resign",
      winner: headers.Result === "1-0" ? "white" : headers.Result === "0-1" ? "black" : null,
      moves: ucis.join(" "), opening: { name: headers.Opening || "" },
      players: {
        white: { user: { name: headers.White || "", id: (headers.White || "").toLowerCase() } },
        black: { user: { name: headers.Black || "", id: (headers.Black || "").toLowerCase() } }
      },
      analysis: analysis, initialFen: headers.FEN || null
    };
  }
  async function liFetchEach(ids, signal) {
    var games = [];
    for (var i = 0; i < ids.length; i++) {
      if (state.stop) throw liCancel();
      var r = await fetch("https://lichess.org/game/export/" + ids[i] + "?evals=true&opening=true&clocks=false&moves=true", {
        headers: { Accept: "application/x-chess-pgn" }, signal: signal
      });
      if (r.status === 429) throw liRateError(r);
      if (!r.ok) continue;
      var g = liGameFromPgn(await r.text());
      if (g && g.id) games.push(g);
    }
    return games;
  }
  async function liFetchFallback(user, max, signal) {
    var act = await fetch("https://lichess.org/api/user/" + encodeURIComponent(user) + "/activity", {
      headers: { Accept: "application/json" }, signal: signal
    });
    if (act.status === 429) throw liRateError(act);
    var ids = [];
    if (act.ok) liCollectIds(await act.json(), ids);
    var seen = {}, uniq = [];
    ids.forEach(function (id) { if (!seen[id]) { seen[id] = 1; uniq.push(id); } });
    uniq = uniq.slice(0, max);
    if (!uniq.length) {
      throw new Error("Lichess did not list recent games. The bulk download returned 404, and the activity feed has no game ids. Try again in a minute.");
    }
    var exp = await fetch("https://lichess.org/api/games/export/_ids?evals=true&opening=true&moves=true&clocks=false&pgnInJson=false", {
      method: "POST",
      headers: { Accept: "application/x-ndjson", "Content-Type": "text/plain" },
      body: uniq.join(","),
      signal: signal
    });
    if (exp.status === 429) throw liRateError(exp);
    if (!exp.ok) return liFetchEach(uniq, signal);
    var text = await exp.text();
    return text.split("\n").filter(Boolean).map(function (line) { return JSON.parse(line); }).filter(function (g) { return g && g.id; });
  }
  async function liFetchGames(user, max, signal) {
    var url = "https://lichess.org/api/games/user/" + encodeURIComponent(user)
      + "?max=" + max + "&rated=true&opening=true&moves=true&evals=true&clocks=false&pgnInJson=false";
    var r;
    try {
      r = await fetch(url, { headers: { Accept: "application/x-ndjson" }, signal: signal });
    } catch (e) {
      if (e && e.name === "AbortError") throw liCancel();
      throw new Error("Could not reach Lichess. Check your connection and try again.");
    }
    if (r.status === 429) throw liRateError(r);
    if (r.status === 404) {
      var who;
      try {
        who = await fetch("https://lichess.org/api/user/" + encodeURIComponent(user), { headers: { Accept: "application/json" }, signal: signal });
      } catch (e2) {
        if (e2 && e2.name === "AbortError") throw liCancel();
        throw new Error("Could not reach Lichess. Check your connection and try again.");
      }
      if (who.status === 404) throw new Error("No Lichess user named " + user + ".");
      if (who.status === 429) throw liRateError(who);
      return liFetchFallback(user, max, signal);
    }
    if (!r.ok) throw new Error("Lichess returned " + r.status + ".");
    var text = await r.text();
    return text.split("\n").filter(Boolean).map(function (line) { return JSON.parse(line); }).filter(function (g) { return g && g.id; });
  }
  function liPlural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  async function liRun() {
    if (state.busy) return;
    var user = liUser();
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(user)) {
      liStatus("Type a Lichess username (letters, numbers, _ or -).");
      return;
    }
    var el = $("li-user");
    if (el) el.value = user;
    liSaveUser(user);
    var max = parseInt(($("li-max") && $("li-max").value) || "10", 10);
    if (!(max > 0)) max = 10;
    max = Math.max(1, Math.min(15, max));
    state.stop = false;
    state.ctrl = typeof AbortController === "function" ? new AbortController() : null;
    liBusy(true);
    var mistakes = 0, finishes = 0, skippedPos = 0, skippedGames = 0, serverN = 0, engineN = 0, sf = 0;
    var failed = "";
    try {
      if (window.CCDeck && CCDeck.init) {
        try { await CCDeck.init(); } catch (_) {}
      }
      liStatus("Fetching recent games for " + user + "…");
      var games = await liFetchGames(user, max, state.ctrl && state.ctrl.signal);
      var seen = {};
      liSeen().forEach(function (id) { seen[id] = 1; });
      var todo = [];
      games.forEach(function (g) {
        if (!g || !g.id) return;
        if (g.rated === false || (g.variant && g.variant !== "standard")) return;
        if (seen[g.id]) { skippedGames++; return; }
        todo.push(g);
      });
      if (!todo.length) {
        liStatus(games.length
          ? (skippedGames
            ? "No new games. " + liPlural(skippedGames, "game") + " already imported."
            : "Lichess did not return any new rated standard games.")
          : "Lichess returned no rated games for " + user + ".");
        return;
      }
      var keys = await liKeys();
      for (var i = 0; i < todo.length; i++) {
        if (state.stop) throw liCancel();
        var g = todo[i];
        var label = "Analyzing game " + (i + 1) + " of " + todo.length + "…";
        liStatus(label);
        try {
          var res = await liAnalyse(g, user, keys, function (a, b) {
            liStatus(label + " position " + a + " of " + b);
          });
          if (res.scanned) engineN++; else serverN++;
          skippedPos += res.skipped || 0;
          sf += res.sf || 0;
          var batch = res.cards || [];
          batch.forEach(function (c) { if (c.finish_start) finishes++; else mistakes++; });
          if (batch.length) liSave(batch);
          liMarkSeen(g.id);
        } catch (e) {
          if (e && (e.cancel || e.name === "AbortError")) throw liCancel();
          failed = (e && e.message) || "One game could not be analysed.";
          liStatus(label + " " + failed);
        }
      }
      if (typeof deckLoad === "function") {
        try { await deckLoad(); } catch (_) {}
      }
      if (window.FinishIt && FinishIt.reload) {
        try { await FinishIt.reload(); } catch (_) {}
      }
      var lines = ["Added " + liPlural(mistakes, "mistake card") + " and " + liPlural(finishes, "Finish it start") + "."];
      if (skippedPos) lines.push("Skipped " + liPlural(skippedPos, "position") + " already in the deck.");
      if (skippedGames) lines.push("Skipped " + liPlural(skippedGames, "game") + " already imported.");
      if (serverN) lines.push(serverN + (serverN === 1 ? " game used Lichess evals." : " games used Lichess evals."));
      if (engineN) lines.push("Stockfish scanned " + liPlural(engineN, "game") + " with no server evals.");
      if (sf) lines.push("Stockfish filled " + liPlural(sf, "missing line") + ".");
      if (failed) lines.push(failed);
      liStatus(lines.join(" "));
    } catch (e) {
      if (e && (e.cancel || e.name === "AbortError")) {
        if (mistakes || finishes) {
          try { if (typeof deckLoad === "function") await deckLoad(); } catch (_) {}
          try { if (window.FinishIt && FinishIt.reload) await FinishIt.reload(); } catch (_) {}
        }
        liStatus("Stopped. Added " + liPlural(mistakes, "mistake card") + " and " + liPlural(finishes, "Finish it start") + ".");
      } else {
        liStatus((e && e.message) || "Could not import games.");
      }
    } finally {
      state.ctrl = null;
      state.stop = false;
      liBusy(false);
    }
  }

  function liBind() {
    liLoadUser();
    var go = $("btn-li-import"), stop = $("btn-li-cancel"), user = $("li-user");
    if (go) go.addEventListener("click", function () { liRun(); });
    if (stop) stop.addEventListener("click", function () {
      state.stop = true;
      if (state.ctrl) { try { state.ctrl.abort(); } catch (_) {} }
      liStatus("Stopping…");
    });
    if (user) user.addEventListener("change", function () { liSaveUser(liUser()); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", liBind);
  else liBind();
  window.LichessImport = { run: liRun };
})();
