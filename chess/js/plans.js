/* Middlegame plan trainer.
   Positions come from your games (moves 12–30, not already +3) and from a
   small built-in set so the tab works before any import. Stockfish scores
   five candidate moves. One has to be clearly best; the other two stay
   plausible. You pick the plan in words, then the evals come out. */
(function () {
  "use strict";

  var LOG_KEY = "cc-plan-log-v1";
  var SEEDS = [
    { id: "seed-modern", title: "Modern, the centre is still closed", side: "white",
      fen: "r1b1r1k1/2qn1pbp/pppp1np1/4p3/P2PP3/2N1BN1P/1PPQBPP1/3RR1K1 w - - 0 13" },
    { id: "seed-grun", title: "Grünfeld, the centre is the target", side: "white",
      fen: "r2q1rk1/pp2ppbp/4b1p1/n7/3PP3/3BBP2/P3N1PP/R2Q1RK1 w - - 1 14" },
    { id: "seed-qg", title: "Queen's Gambit, tension in the centre", side: "white",
      fen: "r2q1rk1/1b1nbppp/p3pn2/1pp3B1/3P4/P1NBPN2/1P3PPP/2RQ1RK1 w - - 0 13" },
    { id: "seed-scotch", title: "Scotch, pieces still on the board", side: "white",
      fen: "r2qr1k1/p1p2pp1/2p1bn1p/3p4/1b2P2B/2NB4/PPP2PPP/R2QR1K1 w - - 4 12" },
    { id: "seed-attack", title: "Space against a kingside fianchetto", side: "white",
      fen: "r2q1rk1/pp2npbp/2p2np1/3Pp3/4P3/2NBBQ1P/PPP3P1/R4RK1 w - - 0 13" },
    { id: "seed-iqp", title: "Isolated queen pawn", side: "white",
      fen: "2r2rk1/p2nqp2/1p2b1pp/2pp4/3P4/3QPN2/PP3PPP/1BR2RK1 w - - 0 16" },
    { id: "seed-modern-b", title: "Modern, your move as Black", side: "black",
      fen: "r1bqr1k1/1p1n1pbp/p1pp1np1/4p3/P2PP3/2N1BN1P/1PPQBPP1/R3R1K1 b - - 3 11" },
    { id: "seed-qg-b", title: "Queen's Gambit, your move as Black", side: "black",
      fen: "r2q1rk1/1b1nbppp/p1p1pn2/1p4B1/3P4/P1NBPN2/1P3PPP/2RQ1RK1 b - - 0 12" },
    { id: "seed-grun-b", title: "Grünfeld, your move as Black", side: "black",
      fen: "r2q1rk1/pp2ppbp/6p1/n7/3PP1b1/3BBP2/P3N1PP/R2Q1RK1 b - - 0 13" }
  ];
  var WHY = {
    attack: "This starts play against the king before the other side can reorganise.",
    trade: "The trade leaves the better structure and fewer pieces to go wrong.",
    weak: "That pawn cannot be defended by another pawn, so pressure on it is the plan.",
    break: "Opening the centre uses the pieces that are already better placed.",
    expand: "Gaining space on that wing makes the later break easier to play.",
    improve: "The piece that was doing the least now takes a useful square."
  };
  var state = {
    booted: false, board: null, token: 0, queue: [], cursor: -1, current: null,
    locked: false, games: [], making: false
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return typeof escapeHtml === "function" ? escapeHtml(s) : String(s == null ? "" : s); }
  function setStatus(t) { var el = $("plans-status"); if (el) el.textContent = t || ""; }
  function fmtPawns(cp) {
    if (cp == null || !isFinite(cp)) return "—";
    var v = cp / 100, body = Math.abs(v).toFixed(1);
    if (Math.abs(cp) >= 9000) return cp > 0 ? "+mate" : "−mate";
    if (v > 0.049) return "+" + body;
    if (v < -0.049) return "−" + body;
    return "0.0";
  }
  function logLoad() {
    try {
      var v = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }
  function logSave(v) {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(v.slice(-300))); } catch (_) {}
  }
  function accuracyText() {
    var log = logLoad();
    if (!log.length) return "No answers yet.";
    var ok = log.filter(function (x) { return x.correct; }).length;
    return ok + "/" + log.length + " (" + Math.round(100 * ok / log.length) + "%)";
  }
  function paintAcc() {
    var el = $("plans-acc");
    if (el) el.textContent = "Accuracy " + accuracyText();
  }
  function userOf() {
    try { return localStorage.getItem("cc-lichess-user-v1") || "Jetblack007"; }
    catch (_) { return "Jetblack007"; }
  }
  function sideOf(g, user) {
    var n = String(user || "").toLowerCase();
    if ((g.white || "").toLowerCase() === n) return "white";
    if ((g.black || "").toLowerCase() === n) return "black";
    return null;
  }
  function playTok(ch, token) {
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token)) {
      try { return ch.move({ from: token.slice(0, 2), to: token.slice(2, 4), promotion: token[4] || "q" }); }
      catch (_) { return null; }
    }
    try { return ch.move(String(token).replace(/[+#?!]/g, "")); } catch (_) { return null; }
  }
  function lineCp(line) {
    if (!line || !line.score) return null;
    var s = line.score;
    if (s.type === "mate") {
      if (!s.value) return 0;
      var mag = 10000 - Math.min(80, Math.abs(s.value)) * 10;
      return s.value > 0 ? mag : -mag;
    }
    return s.value;
  }
  function sanLine(fen, pv, n) {
    var ch;
    try { ch = new Chess(fen); } catch (_) { return ""; }
    var out = [];
    for (var i = 0; i < (pv || []).length && i < n; i++) {
      var u = pv[i];
      if (!u || u.length < 4) break;
      var turn = ch.turn(), num = ch.moveNumber();
      var m = null;
      try { m = ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); }
      catch (_) { m = null; }
      if (!m) break;
      if (turn === "w") out.push(num + "." + m.san);
      else if (!out.length) out.push(num + "…" + m.san);
      else out.push(m.san);
    }
    return out.join(" ");
  }
  function kingSq(ch, color) {
    var b = ch.board();
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var p = b[r][f];
        if (p && p.type === "k" && p.color === color) return "abcdefgh"[f] + (8 - r);
      }
    }
    return null;
  }
  function dist(a, b) {
    if (!a || !b) return 8;
    return Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(+a[1] - +b[1]));
  }
  function isolated(ch, square, color) {
    var file = square.charCodeAt(0) - 97;
    var b = ch.board();
    for (var df = -1; df <= 1; df += 2) {
      var f = file + df;
      if (f < 0 || f > 7) continue;
      for (var r = 0; r < 8; r++) {
        var p = b[r][f];
        if (p && p.type === "p" && p.color === color) return false;
      }
    }
    return true;
  }
  function hitsWeak(ch, enemy, me) {
    var files = "abcdefgh";
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var sq = files[f] + (8 - r);
        var piece = ch.board()[r][f];
        if (!piece || piece.type !== "p" || piece.color !== enemy) continue;
        if (!isolated(ch, sq, enemy)) continue;
        try { if (ch.isAttacked(sq, me)) return true; } catch (_) {}
      }
    }
    return false;
  }
  function classify(fen, uci) {
    var ch = new Chess(fen);
    var m;
    try { m = ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); }
    catch (_) { m = null; }
    if (!m) return { kind: "improve", title: "Improve a piece" };
    var enemy = m.color === "w" ? "b" : "w";
    var king = kingSq(ch, enemy);
    var near = dist(m.to, king) <= 2;
    var storm = m.piece === "p" && king && Math.abs(m.to.charCodeAt(0) - king.charCodeAt(0)) <= 1 && !m.captured && dist(m.to, king) <= 3;
    if ((m.san.indexOf("+") >= 0 && dist(m.to, king) <= 3) || storm || (near && m.piece !== "p" && m.piece !== "k")) {
      return { kind: "attack", title: "Attack the king" };
    }
    if (m.captured && m.captured !== "p") return { kind: "trade", title: "Trade into a better endgame" };
    if (hitsWeak(ch, enemy, m.color)) return { kind: "weak", title: "Target a weak pawn" };
    if (m.piece === "p" && "cdef".indexOf(m.to[0]) >= 0 && ("45".indexOf(m.to[1]) >= 0 || m.captured)) {
      return { kind: "break", title: "Break in the centre" };
    }
    if (m.piece === "p" && "abgh".indexOf(m.from[0]) >= 0) {
      return { kind: "expand", title: "Expand on the wing" };
    }
    var names = { n: "knight", b: "bishop", r: "rook", q: "queen", k: "king", p: "pawn" };
    return { kind: "improve", title: "Improve the " + (names[m.piece] || "piece") };
  }
  function uniqueTitles(choices) {
    var seen = {};
    choices.forEach(function (c) {
      var t = c.plan.title;
      if (seen[t]) c.plan.title = t + " — " + c.san;
      seen[c.plan.title] = 1;
    });
  }
  function pickTrio(lines) {
    var scored = [];
    (lines || []).forEach(function (l) {
      if (!l || !l.pv || !l.pv[0] || !l.score) return;
      var cp = lineCp(l);
      if (cp == null) return;
      if (scored.some(function (s) { return s.uci === l.pv[0]; })) return;
      scored.push({ uci: l.pv[0], pv: l.pv.slice(0, 8), cp: cp, mate: l.score.type === "mate" });
    });
    scored.sort(function (a, b) { return b.cp - a.cp; });
    if (scored.length < 3) return null;
    var best = scored[0];
    if (best.mate || best.cp >= 300 || best.cp < -450) return null;
    var rest = scored.slice(1).filter(function (x) {
      var gap = best.cp - x.cp;
      return gap >= 25 && gap <= 160;
    });
    if (rest.length < 2) return null;
    if (best.cp - rest[0].cp < 35) return null;
    return [best, rest[0], rest[1]];
  }
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  async function scoreItem(item, token) {
    if (!window.CCEngine) return null;
    await CCEngine.ready();
    if (token !== state.token) return null;
    var r = await CCEngine.analyse(item.fen, { depth: 10, movetime: 480, multipv: 5, priority: "high", skill: 20 });
    if (token !== state.token) return null;
    var trio = pickTrio(r && r.lines);
    if (!trio) return null;
    var choices = trio.map(function (t) {
      var plan = classify(item.fen, t.uci);
      return {
        uci: t.uci, pv: t.pv, cp: t.cp, san: sanOf(item.fen, t.uci),
        line: sanLine(item.fen, t.pv, 4), plan: plan, best: false
      };
    });
    uniqueTitles(choices);
    var bestCp = Math.max.apply(null, choices.map(function (c) { return c.cp; }));
    choices.forEach(function (c) { c.best = c.cp === bestCp; });
    shuffle(choices);
    return { item: item, choices: choices };
  }
  function sanOf(fen, uci) {
    try {
      var ch = new Chess(fen);
      var m = ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
      return m ? m.san : uci;
    } catch (_) { return uci; }
  }
  function gameItems(games, user) {
    var out = [], seen = {};
    games.forEach(function (g) {
      var side = sideOf(g, user);
      if (!side || !g.moves) return;
      var ch = new Chess();
      var tokens = String(g.moves).trim().split(/\s+/).filter(Boolean);
      var taken = 0;
      for (var i = 0; i < tokens.length && taken < 2; i++) {
        var fen = ch.fen();
        var m = playTok(ch, tokens[i]);
        if (!m) break;
        var moveNo = parseInt(fen.split(" ")[5], 10) || 1;
        var stm = fen.split(" ")[1];
        if (moveNo < 12 || moveNo > 30) continue;
        if ((stm === "w") !== (side === "white")) continue;
        if (moveNo !== 14 && moveNo !== 18 && moveNo !== 22 && moveNo !== 26) continue;
        if (g.evals) {
          var w = i === 0 ? 0 : g.evals[i - 1];
          if (w != null) {
            var u = side === "white" ? w : -w;
            if (u >= 280 || u < -450) continue;
          }
        }
        var id = g.id + "#" + i;
        if (seen[id]) continue;
        seen[id] = 1;
        taken++;
        var opp = side === "white" ? g.black : g.white;
        out.push({
          id: id, fen: fen, side: side, source: "game",
          title: "Your game" + (opp ? " vs " + opp : "") + (g.opening ? " · " + g.opening : ""),
          moveNo: moveNo
        });
      }
    });
    return out;
  }
  function showPosition(made) {
    state.current = made;
    state.locked = false;
    var item = made.item;
    if (state.board) {
      state.board.setFen(item.fen);
      state.board.setOrientation(item.side === "black" ? "black" : "white");
      state.board.clearArrows();
    }
    var label = $("plans-label");
    if (label) {
      var who = item.side === "white" ? "White" : "Black";
      label.textContent = item.title + " · move " + (item.moveNo || fenMove(item.fen)) + " · you are " + who;
    }
    var host = $("plans-choices");
    host.innerHTML = "";
    made.choices.forEach(function (c, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "plan-choice";
      b.innerHTML = '<span class="pc-title">' + esc(c.plan.title) + '</span>'
        + '<span class="pc-line">' + esc(c.san) + (c.line ? " · " + esc(c.line) : "") + "</span>";
      b.addEventListener("click", function () { pick(i); });
      host.appendChild(b);
    });
    var rev = $("plans-reveal");
    if (rev) { rev.classList.add("hidden"); rev.textContent = ""; }
    setStatus("Three plans. One is clearly best. Pick before the evals come out.");
    paintAcc();
  }
  function fenMove(fen) { return parseInt(String(fen).split(" ")[5], 10) || "?"; }
  function pick(i) {
    var made = state.current;
    if (!made || state.locked) return;
    state.locked = true;
    var choice = made.choices[i];
    var best = made.choices.filter(function (c) { return c.best; })[0];
    var buttons = $("plans-choices").querySelectorAll(".plan-choice");
    buttons.forEach(function (b, k) {
      b.disabled = true;
      if (made.choices[k].best) b.classList.add("best");
      else if (k === i) b.classList.add("wrong");
      var ev = document.createElement("span");
      ev.className = "pc-ev";
      ev.textContent = fmtPawns(made.choices[k].cp);
      b.appendChild(ev);
    });
    if (state.board && best) {
      state.board.setArrows([{ from: best.uci.slice(0, 2), to: best.uci.slice(2, 4), color: "green" }]);
      state.board.setLastMove(best.uci.slice(0, 2), best.uci.slice(2, 4));
    }
    var correct = !!choice.best;
    var log = logLoad();
    log.push({ at: new Date().toISOString(), correct: correct, fen: made.item.fen, picked: choice.san, best: best.san });
    logSave(log);
    var rev = $("plans-reveal");
    if (rev) {
      var evals = made.choices.map(function (c) {
        return c.plan.title + " " + fmtPawns(c.cp);
      }).join(" · ");
      var why = WHY[best.plan.kind] || WHY.improve;
      rev.innerHTML = "<b>" + (correct ? "That's the one." : "Not this time.") + "</b> "
        + esc(best.plan.title) + " (" + esc(best.san) + ", " + esc(fmtPawns(best.cp)) + ") is best. "
        + esc(why)
        + '<div class="info-line">Evals: ' + esc(evals) + "</div>"
        + (best.line ? '<div class="info-line">Best line: ' + esc(best.line) + "</div>" : "");
      rev.classList.remove("hidden");
    }
    setStatus(correct ? "Recorded. Accuracy " + accuracyText() + "." : "Recorded as a miss. Accuracy " + accuracyText() + ".");
    paintAcc();
    if (typeof ccLogAnswer === "function") ccLogAnswer("tactics", "plan");
  }
  function showScoring(item) {
    if (state.board && item) {
      state.board.setFen(item.fen);
      state.board.setOrientation(item.side === "black" ? "black" : "white");
      state.board.clearArrows();
    }
    var label = $("plans-label");
    if (label && item) label.textContent = item.title + " · scoring the plans…";
    var host = $("plans-choices");
    if (host) host.innerHTML = '<div class="info-line">Stockfish is comparing three plans…</div>';
    var rev = $("plans-reveal");
    if (rev) rev.classList.add("hidden");
  }
  async function ensureNext(token) {
    if (state.making || token !== state.token) return;
    if (state.cursor + 1 < state.queue.length) return;
    state.making = true;
    var seedsLeft = SEEDS.filter(function (s) {
      return !state.queue.some(function (q) { return q.item.id === s.id; }) && !state.tried[s.id];
    });
    var gamesLeft = (state.gameItems || []).filter(function (s) {
      return !state.queue.some(function (q) { return q.item.id === s.id; }) && !state.tried[s.id];
    });
    var pool = seedsLeft.concat(gamesLeft);
    for (var i = 0; i < pool.length && state.cursor + 1 >= state.queue.length; i++) {
      if (token !== state.token) break;
      var item = pool[i];
      state.tried[item.id] = 1;
      setStatus("Scoring " + (item.title || "a position") + "…");
      if (!state.current) showScoring(item);
      var made = null;
      try { made = await scoreItem(item, token); } catch (_) { made = null; }
      if (token !== state.token) break;
      if (made) state.queue.push(made);
    }
    state.making = false;
  }
  async function go(delta) {
    var token = state.token;
    if (delta > 0 && state.cursor + 1 >= state.queue.length) {
      setStatus("Looking for a position with one clearly best plan…");
      await ensureNext(token);
    }
    if (token !== state.token) return;
    var next = state.cursor + delta;
    if (next < 0) next = 0;
    if (next >= state.queue.length) {
      setStatus("No further position with a clear plan yet. Import more games, or try Next again in a moment.");
      return;
    }
    state.cursor = next;
    showPosition(state.queue[state.cursor]);
    ensureNext(token);
  }
  async function boot() {
    paintAcc();
    if (state.booted) {
      if (state.queue.length && state.cursor >= 0 && state.cursor < state.queue.length && !state.locked) {
        showPosition(state.queue[state.cursor]);
      }
      return;
    }
    if (!state.board && $("plans-board")) state.board = new Board($("plans-board"), { interactive: false });
    if (!state.booted) {
      state.booted = true;
      state.tried = {};
      var next = $("btn-plans-next");
      if (next) next.addEventListener("click", function () { go(1); });
      var user = userOf();
      if (window.LichessImport && LichessImport.pool) {
        try { state.games = await LichessImport.pool(user); }
        catch (_) { state.games = []; }
      }
      state.gameItems = gameItems(state.games || [], user);
      setStatus(state.gameItems.length
        ? "Sample positions are ready. Your games are queued behind them."
        : "Sample positions. Import games on Mistakes or Opening leaks to train on your own middlegames.");
    }
    var token = ++state.token;
    await ensureNext(token);
    if (token !== state.token) return;
    if (state.queue.length) go(1);
    else setStatus("The engine could not separate a best plan in the sample set. Try Next again.");
  }
  window.Plans = {
    open: function () { boot(); },
    log: logLoad
  };
  if ($("tab-plans") && $("tab-plans").classList.contains("active")) boot();
})();
