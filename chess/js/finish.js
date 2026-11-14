/* =====================================================================
   v59: Finish it (Sparring)

   Conversion drill. Clock is optional (off by default): a budget for the
   user's moves across the whole run, ticking only on their turn. Each
   position is one of Trey's own real
   games where the mistake deck already has him at +3.00 or better
   (player-side centipawns) and it is his move. Bot games, coach games
   and From-Position training are not included. New deck cards that pass
   the same filter show up on their own, including cards saved locally
   after an in-browser analysis.

   FI_ADDED is three extra starts, not deck cards. EpaT0ls0 and 7HUeCT5v
   are Lichess From-Position games against the AI and are marked training.
   AnaYlr4G is a rated rapid game with him as Black: White is to move, so
   the board stays on Black and Stockfish plays White's first move.
   Stored evals are Stockfish 19 Lite, depth 22, from his side.

   One named position was rechecked under +3 with Stockfish 17.1 depth 22
   and is excluded even though the deck stored +3.1: XtnIByaY ply 40
   (move 21, Qxd6), +2.85. The other three named starters are absent
   because the deck itself has them under +3; the "left out" note records
   the depth-22 numbers.

   Opponent: this app's Stockfish at skill 20 (the maximum) and depth 16,
   or 1.8s, whichever comes first. That is full strength for this build,
   the same skill as the Masters sparring level and a slightly longer think.

   Win, after at least one of his moves: checkmate by him, a forced mate,
   or +10.00. +10 is the decisive line — about a queen — past the point
   where a conversion is still in doubt. The start position is allowed to
   already be past +10; he still has to play a move.

   Fail: his eval drops under +1.5, he is checkmated, he gives up, the
   clock runs out, or the game is drawn (stalemate, threefold repetition,
   50-move, insufficient material).

   Score: edge kept = lowest player-eval during the session ÷ starting
   eval, both capped at +10 (a mate counts as +10). 100% means the edge
   never fell below the start, or never fell below the decisive line.
   ===================================================================== */
(function () {
  "use strict";

  var FI_MIN_CP = 300;
  var FI_FAIL_CP = 150;
  var FI_WIN_CP = 1000;
  var FI_LS = "cc-finish-best-v1";
  var FI_CLOCK_LS = "cc-finish-clock-v1";
  /* Deck id whose stored eval is +3.1 but Stockfish 17.1 depth 22 is +2.85. */
  var FI_REJECT = { "md-lichess-XtnIByaY-40": 285 };

  var FI_STARTER = {
    "md-chesscom-856440792-32": {
      verifiedCp: 419,
      verifiedDepth: 22,
      blurb: "Scotch endgame, Chess.com daily 856440792. The link's move 32 is ply 32 — move 17, you to move as White."
    }
  };

  /* Player-side centipawns from Stockfish 19 Lite depth 22.
     Stated reads were about +5.8, −5.3 and +4.4; the depth-22 numbers
     below are what this build actually returns, and all stay past +3. */
  var FI_ADDED = [
    {
      id: "fi-lichess-EpaT0ls0-27",
      fen: "2r3k1/1b4pp/p4b2/1p2pB2/1P1p4/P3QP2/4N1PP/7K w - - 0 27",
      side: "white",
      moveNo: 27,
      opening: "Conversion practice",
      opp: "AI level 7",
      date: "2026-11-06",
      url: "https://lichess.org/EpaT0ls0",
      gameId: "EpaT0ls0",
      evalBefore: 696,
      bestSan: "Qb3+",
      bestUci: "e3b3",
      bestLine: "27. Qb3+ Kf8 28. Bxc8 Bxc8 29. Qd5 Ke7 30. Qc5+ Kd7",
      playedSan: "",
      starter: true,
      training: true,
      added: true,
      verifiedCp: 696,
      verifiedDepth: 22,
      blurb: "Lichess EpaT0ls0, conversion practice against AI level 7. You are White, to move. Best start: 27.Qb3+."
    },
    {
      id: "fi-lichess-AnaYlr4G-34",
      fen: "1n1q1rk1/4ppb1/b4np1/3p3p/2PP2PP/1p1BBP2/1P1Q1N2/rNKR3R w - - 0 18",
      side: "black",
      moveNo: 18,
      opening: "Modern, 150 Attack",
      opp: "alansutton",
      date: "2026-11-03",
      url: "https://lichess.org/AnaYlr4G#34",
      gameId: "AnaYlr4G",
      evalBefore: 451,
      bestSan: "",
      bestUci: "",
      bestLine: "18. c5 Bxd3 19. Qxd3 Nc6, then you attacked the king.",
      playedSan: "",
      starter: true,
      training: false,
      added: true,
      verifiedCp: 451,
      verifiedDepth: 22,
      blurb: "Your rated rapid win as Black, Modern Defense against the 150 Attack. White moves first. The game went 18.c5 Bxd3 19.Qxd3 Nc6."
    },
    {
      id: "fi-lichess-7HUeCT5v-24",
      fen: "2r3k1/1b4pp/p3p3/1p1p1p2/1P1b4/P2B1P2/4N1PP/2Q4K w - - 1 24",
      side: "white",
      moveNo: 24,
      opening: "Conversion practice",
      opp: "AI level 6",
      date: "2026-11-06",
      url: "https://lichess.org/7HUeCT5v",
      gameId: "7HUeCT5v",
      evalBefore: 514,
      bestSan: "Qf4",
      bestUci: "c1f4",
      bestLine: "24. Qf4 Bf6 25. Qd6 Re8 26. h4 Kf7 27. h5 g6",
      playedSan: "",
      starter: true,
      training: true,
      added: true,
      verifiedCp: 514,
      verifiedDepth: 22,
      blurb: "Lichess 7HUeCT5v, conversion practice against AI level 6, after the AI played 23…Rc8. You are White, to move."
    }
  ];

  var FI_LEFT_OUT = [
    {
      label: "Lichess sLtyi2H6, move 24 (link #46)",
      cp: 150, depth: 22, best: "Qxe8",
      why: "Qxe8 is best. Stockfish 17.1 depth 22: +1.50."
    },
    {
      label: "Lichess CHOi8WJi, move 18 (link #34)",
      cp: 221, depth: 22, best: "Bxf6",
      why: "Bxf6 is best. Stockfish 17.1 depth 22: +2.21."
    },
    {
      label: "Lichess XtnIByaY, move 21 (link #40 is ply 40)",
      cp: 285, depth: 22, best: "Qxd6",
      why: "Qxd6 is best. The deck stored +3.1; depth 22 reads +2.85."
    },
    {
      label: "Lichess Y38f4Nlq, the move before 9.f3",
      cp: 95, depth: 22, best: "Bh4",
      why: "The position with White to move, just before f3. Depth 22: +0.95."
    }
  ];

  var FI = {
    mode: "packs",
    filter: "all",
    positions: [],
    byId: {},
    pos: null,
    posId: null,
    seq: 0,
    phase: "idle", /* idle | user | engine | over */
    busy: false,
    chess: null,
    startCp: null,
    minCp: null,
    finalCp: null,
    moves: 0,
    hint: null, /* {uci, san} best move in the current user-to-move position */
    hintFen: "",
    hints: 0,
    hinted: false,
    resumed: false,
    plies: [],
    lineSeq: 0,
    worst: null,
    loaded: false,
    bound: false,
    clockPref: null,
    clock: null,
    clockTimer: null
  };

  function $(id) { return document.getElementById(id); }
  function fiEsc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(s) : String(s == null ? "" : s)
      .replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; });
  }

  function fiFmt(cp) {
    if (cp == null || isNaN(cp)) return "—";
    if (cp >= 9000) return "mate";
    if (cp <= -9000) return "−mate";
    var v = cp / 100;
    var n = Math.abs(v).toFixed(1);
    return (v > 0 ? "+" : v < 0 ? "−" : "") + n;
  }

  /* Side-to-move UCI score → centipawns from `side`'s point of view.
     A mate for the side to move is large and positive; a mate against is large and negative. */
  function fiCp(score, fen, side) {
    if (!score || (score.type !== "cp" && score.type !== "mate")) return null;
    var cp;
    if (score.type === "mate") {
      var m = score.value;
      if (!m) cp = 0;
      else {
        var mag = 10000 - Math.min(80, Math.abs(m)) * 10;
        cp = m > 0 ? mag : -mag;
      }
    } else cp = score.value;
    var stm = (fen.split(" ")[1] || "w");
    var me = side === "white" ? "w" : "b";
    return stm === me ? cp : -cp;
  }

  /* Conversion-relevant edge. Anything past +10 counts the same as +10, and a minus counts as nothing. */
  function fiEdge(cp) {
    if (cp == null) return 0;
    if (cp >= 9000) return FI_WIN_CP;
    return Math.max(0, Math.min(FI_WIN_CP, cp));
  }

  function fiKept(startCp, minCp) {
    var s = fiEdge(startCp);
    if (s <= 0) return 0;
    return Math.min(100, Math.round(100 * fiEdge(minCp) / s));
  }

  var FI_LOG = "cc-finish-log-v1";
  function fiLogRun(entry) {
    var log = [];
    try { log = JSON.parse(localStorage.getItem(FI_LOG) || "[]"); } catch (_) { log = []; }
    if (!Array.isArray(log)) log = [];
    log.push(entry);
    if (log.length > 400) log = log.slice(-400);
    try { localStorage.setItem(FI_LOG, JSON.stringify(log)); } catch (_) {}
  }
  function fiBests() {
    try { return JSON.parse(localStorage.getItem(FI_LS) || "{}"); } catch (_) { return {}; }
  }
  function fiSaveBest(id, pct, win, hinted, clocked, meta) {
    var all = fiBests();
    /* Clocked runs are stored apart from unclocked ones, so a 3-minute
       win cannot overwrite a no-clock personal best (or the reverse). */
    var key = clocked ? id + "#clk" : id;
    var prev = all[key];
    var next = { pct: pct, win: !!win, hinted: !!hinted, at: new Date().toISOString() };
    if (clocked && meta) {
      next.budget = meta.budget;
      next.inc = meta.inc;
    }
    /* Clean win beats a hinted win, and any win beats a loss. A flag that
       "keeps" 100% must not block a later clocked win. */
    var rank = function (w, h) { return w ? (h ? 1 : 2) : 0; };
    var replace = !prev || rank(!!win, !!hinted) > rank(!!prev.win, !!prev.hinted)
      || (rank(!!win, !!hinted) === rank(!!prev.win, !!prev.hinted) && pct > prev.pct);
    if (replace) {
      all[key] = next;
      try { localStorage.setItem(FI_LS, JSON.stringify(all)); } catch (_) {}
      return next;
    }
    return prev;
  }

  function fiClockPref() {
    var d = { preset: "off", inc: 0 };
    try {
      var v = JSON.parse(localStorage.getItem(FI_CLOCK_LS) || "null");
      if (v && (v.preset === "off" || v.preset === "3" || v.preset === "5" || v.preset === "10")) d.preset = v.preset;
      if (v && (v.inc === 0 || v.inc === 2 || v.inc === 5)) d.inc = v.inc | 0;
    } catch (_) {}
    return d;
  }
  function fiClockSavePref(p) {
    FI.clockPref = { preset: p.preset, inc: p.inc | 0 };
    try { localStorage.setItem(FI_CLOCK_LS, JSON.stringify(FI.clockPref)); } catch (_) {}
  }
  function fiClockPhrase(pref) {
    pref = pref || FI.clockPref || fiClockPref();
    if (!pref || pref.preset === "off") return "No clock";
    return pref.preset + ":00" + (pref.inc ? " +" + pref.inc + "s" : "");
  }
  function fiDur(ms) {
    ms = Math.max(0, Math.round(ms || 0));
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }
  function fiClockText(ms) {
    ms = Math.max(0, ms || 0);
    if (ms < 20000) {
      var t = ms / 1000;
      var sec = Math.floor(t);
      var tenths = Math.min(9, Math.floor((t - sec) * 10));
      return "0:" + String(sec).padStart(2, "0") + "." + tenths;
    }
    return fiDur(ms);
  }
  function fiClockStopTicker() {
    if (FI.clockTimer) { clearInterval(FI.clockTimer); FI.clockTimer = null; }
  }
  function fiClockPaint(leftLive, thinkMs) {
    var el = $("fi-clock");
    var on = !!(FI.clock && FI.clock.on && FI.mode === "finish" && FI.phase !== "idle");
    if (el) {
      el.classList.toggle("hidden", !on);
      if (on) {
        var left = leftLive != null ? leftLive : FI.clock.leftMs;
        var text = fiClockText(left);
        el.textContent = text;
        el.classList.toggle("paused", FI.phase !== "user");
        el.classList.toggle("low", left < 30000);
        el.classList.toggle("urgent", left < 10000);
        el.setAttribute("aria-label", (FI.phase === "user" ? "Your clock " : "Clock paused ") + text);
      }
    }
    var pace = $("fi-pace");
    if (!pace) return;
    var show = on && FI.phase === "user" && thinkMs >= 30000 && (FI.finalCp == null || FI.finalCp >= FI_MIN_CP);
    pace.classList.toggle("hidden", !show);
    if (show) pace.textContent = "You're " + fiFmt(FI.finalCp) + ". Under 30 seconds on this move.";
  }
  function fiClockTick() {
    if (!FI.clock || FI.mode !== "finish" || FI.phase !== "user" || FI.clock.turnStart == null) return;
    var elapsed = Date.now() - FI.clock.turnStart;
    var left = FI.clock.on ? FI.clock.leftMs - elapsed : null;
    fiClockPaint(left, elapsed);
    if (FI.clock.on && left <= 0) {
      fiClockFreeze();
      fiClockStopTicker();
      fiClockFlag();
    }
  }
  function fiClockEnsureTicker() {
    if (FI.clockTimer) return;
    FI.clockTimer = setInterval(fiClockTick, 100);
  }
  function fiClockFreeze() {
    if (!FI.clock || FI.clock.turnStart == null) return;
    var spent = Date.now() - FI.clock.turnStart;
    if (spent < 0) spent = 0;
    FI.clock.usedMs += spent;
    if (FI.clock.on) FI.clock.leftMs -= spent;
    FI.clock.turnStart = null;
    FI.clock.openThink = true;
    fiClockPaint();
  }
  function fiClockArm() {
    if (!FI.clock || FI.mode !== "finish" || FI.phase !== "user") return;
    var pace = $("fi-pace");
    if (pace) { pace.textContent = ""; pace.classList.add("hidden"); }
    if (FI.clock.on && FI.clock.leftMs <= 0) { fiClockFlag(); return; }
    FI.clock.leftAtTurn = FI.clock.leftMs;
    FI.clock.usedAtTurn = FI.clock.usedMs;
    FI.clock.completedAtTurn = FI.clock.completed;
    FI.clock.openThink = false;
    FI.clock.turnStart = Date.now();
    if (FI.clock.on) fiClockEnsureTicker();
    else fiClockStopTicker();
    fiClockPaint(FI.clock.on ? FI.clock.leftMs : null, 0);
  }
  function fiClockFlag() {
    if (!FI.clock || !FI.clock.on || FI.phase === "over" || FI.phase === "idle" || !FI.pos) return;
    FI.clock.leftMs = Math.min(0, FI.clock.leftMs);
    fiFinish({ outcome: "fail", reason: "time", detail: "Out of time." });
  }
  /* Charge the move that just landed. A flag undoes it: the move does not count. */
  function fiClockOnPlayedMove(ch) {
    fiClockFreeze();
    fiClockStopTicker();
    if (FI.clock && FI.clock.on && FI.clock.leftMs <= 0) {
      try { ch.undo(); } catch (_) {}
      sparringBoard.setFen(ch.fen());
      sparringBoard.setLastMove(null, null);
      sparringBoard.clearArrows();
      fiClockFlag();
      return false;
    }
    if (FI.clock && FI.clock.on) FI.clock.leftMs += FI.clock.incMs;
    if (FI.clock) {
      FI.clock.completed = (FI.clock.completed || 0) + 1;
      FI.clock.openThink = false;
    }
    return true;
  }
  function fiClockBeginRun() {
    var pref = FI.clockPref || fiClockPref();
    FI.clockPref = pref;
    var mins = pref.preset === "off" ? 0 : parseInt(pref.preset, 10);
    FI.clock = {
      on: mins > 0,
      budgetMin: mins,
      incMs: mins > 0 ? (pref.inc | 0) * 1000 : 0,
      leftMs: mins * 60 * 1000,
      usedMs: 0,
      turnStart: null,
      completed: 0,
      leftAtTurn: mins * 60 * 1000,
      usedAtTurn: 0,
      completedAtTurn: 0
    };
    fiClockStopTicker();
    fiClockPaint();
  }
  function fiRenderClockControls() {
    var pref = FI.clockPref || fiClockPref();
    FI.clockPref = pref;
    document.querySelectorAll("#fi-clock-presets .seg-btn").forEach(function (b) {
      var on = b.dataset.clock === pref.preset;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.querySelectorAll("#fi-inc-presets .seg-btn").forEach(function (b) {
      var on = String(pref.inc) === b.dataset.inc;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var inc = $("fi-inc-presets");
    if (inc) inc.classList.toggle("hidden", pref.preset === "off");
    fiRenderLead();
  }
  function fiTimeReport(result) {
    if (!FI.clock) return { html: "", avg: null, winning: false };
    var thinks = FI.clock.completed || 0;
    if (FI.clock.openThink) thinks += 1;
    if (thinks < 1 && (FI.clock.usedMs || 0) < 400) return { html: "", avg: null, winning: false };
    var n = Math.max(1, thinks);
    var avg = (FI.clock.usedMs || 0) / 1000 / n;
    var winning = (FI.startCp != null && FI.startCp >= FI_MIN_CP) || (FI.pos && (FI.pos.evalBefore | 0) >= FI_MIN_CP);
    var clockBit = "";
    if (FI.clock.on) {
      clockBit = "Clock " + FI.clock.budgetMin + ":00"
        + (FI.clock.incMs ? " +" + Math.round(FI.clock.incMs / 1000) + "s" : "") + ". ";
    }
    var html = '<div class="info-line">' + fiEsc(clockBit)
      + "Time used " + fiEsc(fiDur(FI.clock.usedMs))
      + " · " + fiEsc(String(Math.round(avg))) + "s per move.</div>";
    var nudge = "";
    if (winning && result && result.reason === "time") {
      nudge = "Out of time from a winning position. Once you are +3, the goal is under 30 seconds a move.";
    } else if (winning && avg > 30) {
      nudge = "You were clearly better (+3 or more). Aim for under 30 seconds a move so the clock does not become the problem.";
    } else if (winning && FI.clock.on && result && result.outcome === "win" && avg <= 30) {
      nudge = "Under 30 seconds a move while winning. That is the pace.";
    }
    if (nudge) html += '<div class="coach-box">' + fiEsc(nudge) + "</div>";
    return { html: html, avg: avg, winning: winning };
  }

  function fiReal(c) {
    if (!c || c.marker || !c.fen || (c.side !== "white" && c.side !== "black")) return false;
    if (c.training) return false;
    if (c.game_type === "bot" || c.game_type === "coach") return false;
    if (c.variant === "From Position") return false;
    if (c.opening === "From position (training)") return false;
    if ((c.eval_before | 0) < FI_MIN_CP) return false;
    if (FI_REJECT[c.id]) return false;
    var stm = (c.fen.split(" ")[1] || "");
    var me = c.side === "white" ? "w" : "b";
    return stm === me;
  }

  function fiFromCard(c) {
    var extra = FI_STARTER[c.id] || null;
    return {
      id: c.id,
      fen: c.fen,
      side: c.side,
      moveNo: c.move_no,
      ply: c.ply,
      opening: c.opening || "Game",
      opp: c.opp || "",
      date: c.date || "",
      url: c.url || "",
      gameId: c.game_id || "",
      evalBefore: c.eval_before | 0,
      bestSan: c.best_san || "",
      bestUci: c.best_uci || "",
      bestLine: c.best_line || "",
      playedSan: c.played_san || "",
      starter: !!extra,
      imported: !!c.imported,
      verifiedCp: extra ? extra.verifiedCp : null,
      verifiedDepth: extra ? extra.verifiedDepth : null,
      blurb: extra ? extra.blurb : (c.blurb || "")
    };
  }

  function fiDedupe(list) {
    var by = {};
    list.forEach(function (p) {
      var k = p.fen.split(" ").slice(0, 4).join(" ");
      var prev = by[k];
      if (!prev || p.starter || (!prev.starter && p.evalBefore > prev.evalBefore)) by[k] = p;
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }

  function fiVisible() {
    return FI.positions.filter(function (p) { return FI.filter === "all" || p.starter; });
  }

  function fiAnalyse(fen, depth, movetime) {
    return CCEngine.analyse(fen, {
      depth: depth, movetime: movetime, skill: 20, multipv: 1, priority: "high"
    }).then(function (r) {
      var line = r && r.lines && r.lines[0];
      return {
        best: r && r.bestmove,
        score: line ? line.score : null,
        depth: r ? r.depth : 0,
        pv: line && line.pv ? line.pv : []
      };
    });
  }

  function fiApply(ch, uci) {
    if (!uci || uci.length < 4) return null;
    try {
      return ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
    } catch (_) { return null; }
  }

  function fiSan(fen, uci) {
    try {
      var ch = new Chess(fen);
      var m = fiApply(ch, uci);
      return m ? m.san : uci;
    } catch (_) { return uci || ""; }
  }

  function fiTerminal(ch, side) {
    if (ch.isCheckmate()) {
      var me = side === "white" ? "w" : "b";
      if (ch.turn() !== me) return { outcome: "win", reason: "checkmate", detail: "You checkmated." };
      return { outcome: "fail", reason: "checkmate", detail: "You were checkmated." };
    }
    if (ch.isDraw()) {
      var why = "Draw";
      if (ch.isStalemate()) why = "Stalemate";
      else if (ch.isThreefoldRepetition()) why = "Threefold repetition";
      else if (ch.isDrawByFiftyMoves()) why = "The 50-move rule";
      else if (ch.isInsufficientMaterial()) why = "Insufficient material";
      return { outcome: "fail", reason: "draw", detail: why + ". Drawn games count as a fail." };
    }
    return null;
  }

  /* Decisive / collapse checks apply only once he has moved. The start
     position is often already a large plus; the drill is to keep it. */
  function fiEvalEnd(cp) {
    if (FI.moves < 1 || cp == null) return null;
    if (cp >= FI_WIN_CP) {
      return {
        outcome: "win", reason: "decisive",
        detail: cp >= 9000
          ? "Mate is forced. That is a win."
          : "The edge reached " + fiFmt(cp) + ". +10 is the decisive line, so that is a win."
      };
    }
    if (cp < FI_FAIL_CP) {
      return { outcome: "fail", reason: "edge", detail: "The edge fell to " + fiFmt(cp) + ", under +1.5." };
    }
    return null;
  }

  function fiNoteDrop(beforeCp, afterCp) {
    if (beforeCp == null || afterCp == null) return;
    var drop = beforeCp - afterCp;
    if (drop <= 0) return;
    if (!FI.worst || drop > FI.worst.drop) {
      var pre = FI._pre || {};
      var h = (FI.hintFen && FI.hintFen === pre.fen) ? (FI.hint || {}) : (FI.hint || {});
      FI.worst = {
        drop: drop,
        before: beforeCp,
        after: afterCp,
        san: FI._lastSan || "",
        playedUci: FI._lastUci || "",
        fen: pre.fen || FI._lastFen || "",
        history: pre.history || [],
        userMoves: pre.userMoves || 0,
        minCp: pre.minCp,
        bestUci: h.uci || "",
        bestSan: h.san || "",
        clockLeft: pre.clockLeft,
        clockUsed: pre.clockUsed,
        clockCompleted: pre.clockCompleted
      };
      fiSyncRunButtons();
    }
  }

  function fiTrack(cp) {
    if (cp == null) return;
    FI.finalCp = cp;
    if (FI.minCp == null || cp < FI.minCp) FI.minCp = cp;
  }

  function fiSetStatus(text) {
    var el = $("fi-status");
    if (el) el.textContent = text || "";
  }

  function fiRenderLead() {
    var n = FI.positions.length;
    var starters = FI.positions.filter(function (p) { return p.starter; }).length;
    var el = $("fi-lead");
    if (!el) return;
    var pref = FI.clockPref || fiClockPref();
    var clockBit = pref.preset === "off"
      ? "<b>No clock</b> unless you turn one on. "
      : "<b>Clock " + fiEsc(fiClockPhrase(pref)) + "</b> for your moves, running only on your turn. ";
    el.innerHTML = "Positions at <b>+3</b> or better for you, mostly from your own games. "
      + clockBit
      + "Stockfish defends at full strength (skill 20) and moves first when it is to move. "
      + "A win is checkmate, a forced mate, or <b>+10</b>. "
      + "A fail is under <b>+1.5</b>, a draw, or <b>out of time</b>. "
      + "<b>" + n + "</b> position" + (n === 1 ? "" : "s")
      + (starters ? ", including " + starters + " checked starter" + (starters === 1 ? "" : "s") : "") + ".";
  }

  function fiRenderLeftOut() {
    var box = $("fi-leftout");
    if (!box) return;
    box.innerHTML = "<summary>" + FI_LEFT_OUT.length + " named positions are under +3, so they are not in this list</summary><ul>"
      + FI_LEFT_OUT.map(function (x) {
        return "<li><b>" + fiEsc(x.label) + "</b> — " + fiEsc(x.why) + " Best move " + fiEsc(x.best) + ".</li>";
      }).join("") + "</ul>";
  }

  function fiRenderFilters() {
    var all = $("btn-fi-filter-all"), st = $("btn-fi-filter-starter");
    if (all) all.setAttribute("aria-pressed", FI.filter === "all" ? "true" : "false");
    if (st) st.setAttribute("aria-pressed", FI.filter === "starter" ? "true" : "false");
  }

  function fiRenderList() {
    var host = $("fi-list");
    if (!host) return;
    var list = fiVisible();
    var bests = fiBests();
    host.innerHTML = "";
    if (!FI.loaded) {
      host.innerHTML = '<div class="info-line">Loading positions from your mistake deck…</div>';
      return;
    }
    if (!list.length) {
      host.innerHTML = '<div class="info-line">No positions in this view.</div>';
      fiSyncStart();
      return;
    }
    list.forEach(function (p) {
      var b = bests[p.id];
      var bc = bests[p.id + "#clk"];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fi-row" + (p.id === FI.posId ? " current" : "");
      btn.setAttribute("role", "listitem");
      btn.dataset.id = p.id;
      var sub = (p.starter ? "Starter · " : "")
        + (p.imported ? "Imported · " : "")
        + (p.training ? "Training · " : "")
        + (fiEngineFirst(p) ? fiSideName(p.side === "white" ? "black" : "white") + " moves first · " : "")
        + (p.opp ? "vs " + p.opp : "")
        + (p.date ? " · " + p.date : "");
      var bestTxt = "";
      if (b && (b.pct > 0 || b.win)) bestTxt = b.pct + "%";
      if (bc && bc.win) {
        var tag = (bc.budget ? bc.budget + "m " : "") + bc.pct + "%";
        bestTxt = bestTxt ? bestTxt + " · " + tag : tag;
      }
      btn.innerHTML = '<span class="fi-ev">' + fiEsc(fiFmt(p.evalBefore)) + "</span>"
        + '<span class="fi-text"><span class="fi-main">' + fiEsc(p.opening) + " · " + fiEsc(String(p.moveNo)) + (p.side === "white" ? "." : "…")
        + "</span>"
        + '<span class="fi-sub">' + fiEsc(sub) + "</span></span>"
        + '<span class="fi-best">' + fiEsc(bestTxt) + "</span>";
      btn.addEventListener("click", function () { fiStart(p.id); });
      host.appendChild(btn);
    });
    fiSyncStart();
  }

  /* List view: put the first position on the board so the picker is not the
     initial array. Does not start the engine. */
  function fiPreview(p) {
    if (!p || FI.mode !== "finish") return;
    if (FI.phase === "user" || FI.phase === "engine" || FI.phase === "over") return;
    FI.pos = p;
    FI.posId = p.id;
    sparringBoard.setInteractive(false);
    sparringBoard.setOrientation(p.side);
    sparringBoard.setFen(p.fen);
    sparringBoard.setLastMove(null, null);
    sparringBoard.clearArrows();
    var note = $("sparring-board-note");
    if (note) note.textContent = fiPreviewNote(p);
    fiSyncStart();
  }

  function fiSyncStart() {
    var btn = $("btn-fi-start");
    if (!btn) return;
    var ready = !!(FI.posId && FI.byId[FI.posId]) || !!(fiVisible()[0]);
    btn.disabled = !ready;
  }

  function fiShowHome() {
    fiClockFreeze();
    fiClockStopTicker();
    FI.seq++;
    FI.busy = false;
    var home = $("fi-home"), run = $("fi-run");
    if (home) home.classList.remove("hidden");
    if (run) run.classList.add("hidden");
    sparringBoard.setInteractive(false);
    FI.phase = "idle";
    fiClockPaint();
    var pace = $("fi-pace");
    if (pace) { pace.textContent = ""; pace.classList.add("hidden"); }
    if (FI.pos && FI.mode === "finish") {
      var note = $("sparring-board-note");
      if (note) note.textContent = fiPreviewNote(FI.pos);
    }
    fiSyncStart();
    fiRenderList();
  }

  function fiShowRun() {
    var home = $("fi-home"), run = $("fi-run");
    if (home) home.classList.add("hidden");
    if (run) run.classList.remove("hidden");
  }

  function fiSideName(side) { return side === "white" ? "White" : "Black"; }

  /* True when the side to move is Stockfish, so the run must open with its move. */
  function fiEngineFirst(p) {
    if (!p || !p.fen) return false;
    var stm = p.fen.split(" ")[1] || "w";
    var me = p.side === "black" ? "b" : "w";
    return stm !== me;
  }

  function fiPreviewNote(p) {
    var clock = fiClockPhrase();
    if (fiEngineFirst(p)) {
      return "Preview · " + clock + " · You play " + fiSideName(p.side) + " · "
        + fiSideName(p.side === "white" ? "black" : "white") + " moves first";
    }
    return "Preview · " + clock + " · " + fiSideName(p.side) + " to move";
  }

  function fiSyncRunButtons() {
    var hint = $("btn-fi-hint");
    var slip = $("btn-fi-slip");
    if (hint) hint.disabled = !(FI.phase === "user" && !FI.busy && FI.chess);
    if (slip) slip.disabled = !(FI.worst && FI.worst.fen && !FI.busy && (FI.phase === "user" || FI.phase === "over"));
  }

  function fiPvToSan(fen, pv) {
    var ch;
    try { ch = new Chess(fen); } catch (_) { return ""; }
    var out = [];
    for (var i = 0; i < pv.length && i < 6; i++) {
      var turn = ch.turn();
      var num = ch.moveNumber();
      var m = fiApply(ch, pv[i]);
      if (!m) break;
      if (turn === "w") out.push(num + ". " + m.san);
      else if (!out.length) out.push(num + "… " + m.san);
      else out.push(m.san);
    }
    return out.join(" ");
  }

  function fiWalkLine(fen, n) {
    var ch;
    try { ch = new Chess(fen); } catch (_) { return Promise.resolve(""); }
    var ucis = [];
    function step(i) {
      if (i >= n) return Promise.resolve(fiPvToSan(fen, ucis));
      return fiAnalyse(ch.fen(), 8, 220).then(function (a) {
        if (!a || !a.best) return fiPvToSan(fen, ucis);
        if (!fiApply(ch, a.best)) return fiPvToSan(fen, ucis);
        ucis.push(a.best);
        return step(i + 1);
      });
    }
    return step(0);
  }

  function fiSlipLine(fen) {
    var token = ++FI.lineSeq;
    var el = $("fi-slip-line");
    if (!el) return;
    if (!fen) { el.textContent = ""; return; }
    el.textContent = "From the slip…";
    fiAnalyse(fen, 12, 700).then(function (a) {
      var pv = (a && a.pv ? a.pv : []).filter(Boolean).slice(0, 6);
      if (pv.length >= 2) return fiPvToSan(fen, pv);
      return fiWalkLine(fen, 6);
    }).then(function (text) {
      if (token !== FI.lineSeq) return;
      var node = $("fi-slip-line");
      if (node) node.textContent = text ? "From the slip: " + text : "";
    }).catch(function () {
      if (token !== FI.lineSeq) return;
      var node = $("fi-slip-line");
      if (node) node.textContent = "";
    });
  }

  function fiGiveHint() {
    if (FI.phase !== "user" || FI.busy || !FI.chess || !FI.pos) return;
    var fen = FI.chess.fen();
    var seq = FI.seq;
    function show(uci, san) {
      if (seq !== FI.seq || FI.phase !== "user") return;
      FI.hints = (FI.hints || 0) + 1;
      FI.hinted = true;
      if (uci && uci.length >= 4) {
        sparringBoard.setArrows([{ from: uci.slice(0, 2), to: uci.slice(2, 4), color: "green" }]);
      }
      fiSetStatus("Hint: " + (san || uci || "none") + ".");
      fiSyncRunButtons();
    }
    if (FI.hint && FI.hint.uci && FI.hintFen === fen) {
      show(FI.hint.uci, FI.hint.san);
      return;
    }
    var btn = $("btn-fi-hint");
    if (btn) btn.disabled = true;
    fiSetStatus("Looking for a hint…");
    fiAnalyse(fen, 12, 800).then(function (a) {
      if (seq !== FI.seq || FI.phase !== "user") return;
      var san = a && a.best ? fiSan(fen, a.best) : "";
      FI.hint = { uci: (a && a.best) || "", san: san };
      FI.hintFen = fen;
      show(FI.hint.uci, san);
    }).catch(function () {
      if (seq !== FI.seq) return;
      fiSetStatus("No hint — the engine did not answer.");
      fiSyncRunButtons();
    });
  }

  function fiRetrySlip() {
    var w = FI.worst;
    if (!w || !w.fen || !FI.pos || FI.mode !== "finish" || FI.startCp == null) return;
    var ch;
    try { ch = new Chess(w.fen); } catch (_) {
      fiSetStatus("Could not restore that position.");
      return;
    }
    FI.seq++;
    FI.resumed = true;
    FI.busy = false;
    FI.phase = "user";
    FI.chess = ch;
    FI.moves = w.userMoves || 0;
    FI.finalCp = w.before != null ? w.before : FI.finalCp;
    FI.minCp = w.minCp != null ? w.minCp : FI.finalCp;
    FI.hint = { uci: w.bestUci || "", san: w.bestSan || "" };
    FI.hintFen = w.fen;
    fiShowRun();
    var sum = $("fi-summary");
    if (sum) { sum.classList.add("hidden"); sum.innerHTML = ""; }
    var give = $("btn-fi-giveup");
    if (give) give.disabled = false;
    sparringBoard.setOrientation(FI.pos.side);
    sparringBoard.setFen(w.fen);
    sparringBoard.setLastMove(null, null);
    sparringBoard.clearArrows();
    sparringBoard.setInteractive(true);
    var note = $("sparring-board-note");
    if (FI.clock && w.clockLeft != null) {
      FI.clock.leftMs = w.clockLeft;
      FI.clock.usedMs = w.clockUsed || 0;
      FI.clock.completed = w.clockCompleted || 0;
      FI.clock.turnStart = null;
    }
    if (note) note.textContent = "Resumed · " + (FI.clock && FI.clock.on ? fiClockText(FI.clock.leftMs) : fiClockPhrase())
      + " · " + fiSideName(FI.pos.side) + " to move";
    fiSetStatus("Back before " + (w.san || "the slip") + ". Edge " + fiFmt(FI.finalCp) + ". Your move.");
    fiClockArm();
    fiSyncRunButtons();
  }

  function fiStart(id) {
    var p = FI.byId[id];
    if (!p) return;
    var seq = ++FI.seq;
    FI.pos = p;
    FI.posId = p.id;
    FI.phase = "engine";
    FI.busy = true;
    FI.chess = null;
    FI.startCp = null;
    FI.minCp = null;
    FI.finalCp = null;
    FI.moves = 0;
    FI.hint = null;
    FI.hintFen = "";
    FI.hints = 0;
    FI.hinted = false;
    FI.resumed = false;
    FI.plies = [];
    FI.worst = null;
    FI._pre = null;
    FI._lastSan = "";
    FI._lastUci = "";
    FI._lastFen = "";
    fiClockBeginRun();
    fiShowRun();
    $("fi-summary").classList.add("hidden");
    $("fi-summary").innerHTML = "";
    $("btn-fi-giveup").disabled = true;
    $("fi-kicker").textContent = [p.training ? "Training" : "", p.date, p.opp ? "vs " + p.opp : "", "you are " + fiSideName(p.side)].filter(Boolean).join(" · ");
    var turnLine = fiEngineFirst(p)
      ? "You are " + fiSideName(p.side) + ". " + fiSideName(p.side === "white" ? "black" : "white") + " moves first."
      : "You are " + fiSideName(p.side) + ", to move.";
    $("fi-brief").textContent = p.blurb || (p.opening + ", move " + p.moveNo + ". " + turnLine + " The game's best move stays hidden until the end.");
    fiSetStatus("Reading the position…" + (FI.clock && FI.clock.on ? " Clock " + fiClockText(FI.clock.leftMs) + ", only on your turn." : ""));
    $("sparring-board-note").textContent = fiClockPhrase() + " · " + fiSideName(p.side) + " · Stockfish skill 20";
    sparringBoard.setInteractive(false);
    sparringBoard.setOrientation(p.side);
    sparringBoard.setFen(p.fen);
    sparringBoard.setLastMove(null, null);
    sparringBoard.clearArrows();
    var ch;
      try { ch = new Chess(p.fen); } catch (e) {
      fiSetStatus("This FEN did not load.");
      FI.busy = false;
      FI.phase = "idle";
      fiClockStopTicker();
      fiClockPaint();
      return;
    }
    FI.chess = ch;
    fiAnalyse(p.fen, 14, 1600).then(function (a) {
      if (seq !== FI.seq || FI.mode !== "finish") return;
      var cp = fiCp(a.score, p.fen, p.side);
      if (cp == null) {
        fiSetStatus("The engine did not return an eval. Try the position again.");
        FI.busy = false;
        FI.phase = "idle";
        $("btn-fi-giveup").disabled = true;
        fiClockStopTicker();
        fiClockPaint();
        return;
      }
      if (cp < FI_FAIL_CP) {
        fiSetStatus("The engine reads this " + fiFmt(cp) + " now, under the +1.5 fail line, so it is not started. Deck had " + fiFmt(p.evalBefore) + ".");
        FI.busy = false;
        FI.phase = "idle";
        fiClockStopTicker();
        fiClockPaint();
        return;
      }
      FI.startCp = cp;
      FI.minCp = cp;
      FI.finalCp = cp;
      var gapNote = Math.abs(cp - p.evalBefore) >= 40
        ? " " + (p.added ? "Listed at " : "Deck had ") + fiFmt(p.evalBefore) + "."
        : "";
      if (!fiEngineFirst(p)) {
        FI.hint = { uci: a.best || p.bestUci, san: a.best ? fiSan(p.fen, a.best) : p.bestSan };
        FI.hintFen = p.fen;
        FI.phase = "user";
        FI.busy = false;
        $("btn-fi-giveup").disabled = false;
        fiSyncRunButtons();
        fiSetStatus("Your move. Edge " + fiFmt(cp) + ". It fails under +1.5." + gapNote);
        fiClockArm();
        if (FI.mode === "finish") sparringBoard.setInteractive(true);
        return;
      }
      var reply = fiApply(ch, a.best);
      if (!reply) {
        fiSetStatus("Stockfish returned no opening move.");
        FI.busy = false;
        FI.phase = "idle";
        fiClockStopTicker();
        fiClockPaint();
        return;
      }
      sparringBoard.setFen(ch.fen());
      sparringBoard.setLastMove(reply.from, reply.to);
      var opened = fiTerminal(ch, p.side);
      if (opened) { fiFinish(opened); return; }
      fiSetStatus("Stockfish played " + reply.san + ".");
      return fiAnalyse(ch.fen(), 14, 1600).then(function (b) {
        if (seq !== FI.seq || FI.mode !== "finish") return;
        var now = fiCp(b.score, ch.fen(), p.side);
        if (now != null) fiTrack(now);
        FI.hint = { uci: (b && b.best) || "", san: b && b.best ? fiSan(ch.fen(), b.best) : "" };
        FI.hintFen = ch.fen();
        FI.phase = "user";
        FI.busy = false;
        $("btn-fi-giveup").disabled = false;
        fiSyncRunButtons();
        fiSetStatus("Stockfish played " + reply.san + ". Edge " + fiFmt(now != null ? now : cp) + ". Your move. It fails under +1.5.");
        fiClockArm();
        if (FI.mode === "finish") sparringBoard.setInteractive(true);
      });
    }).catch(function (e) {
      if (seq !== FI.seq) return;
      var me = p.side === "black" ? "b" : "w";
      if (FI.chess && fiEngineFirst(p) && FI.chess.turn() === me && FI.startCp != null) {
        FI.phase = "user";
        FI.busy = false;
        $("btn-fi-giveup").disabled = false;
        fiSyncRunButtons();
        fiSetStatus("Your move. Edge " + fiFmt(FI.finalCp) + ". It fails under +1.5.");
        fiClockArm();
        if (FI.mode === "finish") sparringBoard.setInteractive(true);
        return;
      }
      FI.busy = false;
      FI.phase = "idle";
      fiClockStopTicker();
      fiClockPaint();
      fiSetStatus("Engine unavailable: " + (e && e.message ? e.message : "could not analyse"));
    });
  }

  function fiOnMove(from, to) {
    if (FI.mode !== "finish" || !FI.pos || FI.phase !== "user" || FI.busy) {
      if (FI.mode === "finish") sparringBoard.shake();
      return;
    }
    var p = FI.pos;
    var ch = FI.chess;
    var fenBefore = ch.fen();
    var verbose = [];
    try { verbose = ch.history({ verbose: true }); } catch (_) { verbose = []; }
    var me = p.side === "white" ? "w" : "b";
    var uci = uciCandidate(sparringBoard, from, to);
    var mv = fiApply(ch, uci);
    if (!mv) { sparringBoard.shake(); sparringBoard.setFen(fenBefore); return; }
    if (!fiClockOnPlayedMove(ch)) return;
    var seq = FI.seq;
    var beforeCp = FI.finalCp;
    FI._pre = {
      fen: fenBefore,
      eval: beforeCp,
      history: verbose.map(function (m) { return m.san; }),
      userMoves: verbose.filter(function (m) { return m.color === me; }).length,
      minCp: FI.minCp,
      clockLeft: FI.clock ? FI.clock.leftAtTurn : null,
      clockUsed: FI.clock ? FI.clock.usedAtTurn : null,
      clockCompleted: FI.clock ? FI.clock.completedAtTurn : null
    };
    FI.plies.push(FI._pre);
    FI._lastSan = mv.san;
    FI._lastUci = uci;
    FI._lastFen = fenBefore;
    FI.moves += 1;
    FI.busy = true;
    FI.phase = "engine";
    sparringBoard.setInteractive(false);
    sparringBoard.setFen(ch.fen());
    sparringBoard.setLastMove(from, to);
    sparringBoard.clearArrows();
    var term = fiTerminal(ch, p.side);
    if (term) { fiNoteDrop(beforeCp, term.outcome === "win" ? FI_WIN_CP : FI.finalCp); fiFinish(term); return; }
    fiSetStatus("You played " + mv.san + ". Stockfish is defending…");
    fiAnalyse(ch.fen(), 16, 1800).then(function (a) {
      if (seq !== FI.seq || FI.mode !== "finish" || !FI.pos || FI.pos.id !== p.id) return;
      var afterCp = fiCp(a.score, ch.fen(), p.side);
      fiTrack(afterCp);
      fiNoteDrop(beforeCp, afterCp);
      var ended = fiEvalEnd(afterCp) || fiTerminal(ch, p.side);
      if (ended) { fiFinish(ended); return; }
      var reply = fiApply(ch, a.best);
      if (!reply) {
        fiSetStatus("Stockfish returned no move.");
        FI.phase = "user";
        FI.busy = false;
        fiSyncRunButtons();
        fiClockArm();
        sparringBoard.setInteractive(true);
        return;
      }
      sparringBoard.setFen(ch.fen());
      sparringBoard.setLastMove(reply.from, reply.to);
      var term2 = fiTerminal(ch, p.side);
      if (term2) { fiFinish(term2); return; }
      return fiAnalyse(ch.fen(), 12, 900).then(function (b) {
        if (seq !== FI.seq || FI.mode !== "finish" || !FI.pos || FI.pos.id !== p.id) return;
        var now = fiCp(b.score, ch.fen(), p.side);
        fiTrack(now);
        fiNoteDrop(beforeCp, now);
        FI.hint = { uci: b.best || "", san: b.best ? fiSan(ch.fen(), b.best) : "" };
        FI.hintFen = ch.fen();
        var ended2 = fiEvalEnd(now);
        if (ended2) { fiFinish(ended2); return; }
        FI.phase = "user";
        FI.busy = false;
        fiSetStatus("Stockfish played " + reply.san + ". Edge " + fiFmt(now) + ". Your move.");
        fiSyncRunButtons();
        fiClockArm();
        if (FI.mode === "finish") sparringBoard.setInteractive(true);
      });
    }).catch(function (e) {
      if (seq !== FI.seq) return;
      FI.busy = false;
      FI.phase = "user";
      fiSetStatus("Engine unavailable: " + (e && e.message ? e.message : "no reply"));
      fiSyncRunButtons();
      fiClockArm();
      if (FI.mode === "finish") sparringBoard.setInteractive(true);
    });
  }

  function fiFinish(result) {
    if (!FI.pos || FI.phase === "over") return;
    fiClockFreeze();
    fiClockStopTicker();
    var p = FI.pos;
    FI.phase = "over";
    FI.busy = false;
    FI.seq++;
    sparringBoard.setInteractive(false);
    $("btn-fi-giveup").disabled = true;
    fiClockPaint();
    var win = result.outcome === "win";
    var kept = fiKept(FI.startCp, FI.minCp);
    if (typeof ccLogAnswer === "function") ccLogAnswer("sparring", "finish");
    var clocked = !!(FI.clock && FI.clock.on);
    var skipBest = result.reason === "time" && (FI.moves || 0) < 1;
    if (!skipBest) {
      fiSaveBest(p.id, kept, win, FI.hinted, clocked, clocked ? { budget: FI.clock.budgetMin, inc: Math.round((FI.clock.incMs || 0) / 1000) } : null);
      fiLogRun({ id: p.id, at: new Date().toISOString(), win: win, hinted: !!FI.hinted, clocked: clocked, pct: kept });
    }
    var sum = $("fi-summary");
    var worst = FI.worst;
    var worstHtml = worst
      ? "<div class=\"info-line\">Biggest give-back: <b>" + fiEsc(worst.san || "that move") + "</b> ("
        + fiEsc(fiFmt(worst.before)) + " → " + fiEsc(fiFmt(worst.after)) + ")."
        + (worst.bestSan ? " The engine wanted <b>" + fiEsc(worst.bestSan) + "</b> there." : "")
        + (worst.fen ? ' <button type="button" class="btn mini" id="btn-fi-show-drop">Show that move</button>' : "")
        + "</div>"
      : "<div class=\"info-line\">No move of yours gave the edge back.</div>";
    var line = p.bestLine ? String(p.bestLine) : "";
    if (line.length > 180) line = line.slice(0, 177) + "…";
    var cleanTitle = fiEngineFirst(p)
      ? "How the game went"
      : ((p.starter ? "Clean finish" : "Known better move") + ": " + (p.bestSan || "—"));
    var clean = "<div class=\"coach-box\"><b>" + fiEsc(cleanTitle) + ".</b>"
      + (line ? "<div class=\"info-line\">" + fiEsc(line) + "</div>" : "")
      + (!fiEngineFirst(p) && p.playedSan ? "<div class=\"info-line\">In the game you played " + fiEsc(p.playedSan) + ".</div>" : "")
      + (p.url ? '<div class="info-line"><a href="' + fiEsc(p.url) + '" target="_blank" rel="noopener">Open the game</a></div>' : "")
      + "</div>";
    sum.innerHTML = '<div class="banner ' + (win ? "green" : "red") + '">'
      + (win ? "Win" : "Fail") + " — " + fiEsc(result.detail) + "</div>"
      + '<div class="fi-score">' + kept + "% kept</div>"
      + '<div class="info-line">Start ' + fiEsc(fiFmt(FI.startCp))
      + " · lowest " + fiEsc(fiFmt(FI.minCp))
      + " · final " + fiEsc(fiFmt(FI.finalCp))
      + ". Lowest ÷ start, both capped at +10. Mate counts as +10. "
      + "(" + (FI.hints || 0) + " hint" + ((FI.hints || 0) === 1 ? "" : "s") + (FI.resumed ? ", resumed" : "")
      + (clocked ? ", clocked" : "") + ")</div>"
      + fiTimeReport(result).html
      + '<div id="fi-slip-line" class="info-line"></div>'
      + worstHtml + clean;
    sum.classList.remove("hidden");
    fiSetStatus("");
    var show = $("btn-fi-show-drop");
    if (show) show.addEventListener("click", fiShowWorst);
    fiSyncRunButtons();
    if (worst && worst.fen) fiSlipLine(worst.fen);
    fiRenderList();
  }

  function fiShowWorst() {
    var w = FI.worst;
    if (!w || !w.fen || !FI.pos) return;
    sparringBoard.setOrientation(FI.pos.side);
    sparringBoard.setFen(w.fen);
    sparringBoard.setLastMove(null, null);
    var arrows = [];
    if (w.bestUci && w.bestUci.length >= 4) arrows.push({ from: w.bestUci.slice(0, 2), to: w.bestUci.slice(2, 4), color: "green" });
    if (w.playedUci && w.playedUci.length >= 4) arrows.push({ from: w.playedUci.slice(0, 2), to: w.playedUci.slice(2, 4), color: "red" });
    sparringBoard.setArrows(arrows);
    sparringBoard.setInteractive(false);
    fiSetStatus("Green is the engine move. Red is the move you played.");
  }

  function fiNext() {
    var list = fiVisible();
    if (!list.length) return;
    var i = 0;
    for (var k = 0; k < list.length; k++) if (list[k].id === FI.posId) i = k;
    fiStart(list[(i + 1) % list.length].id);
  }

  function fiRestoreBoard() {
    if (FI.mode !== "finish" || !FI.pos) return;
    sparringBoard.setOrientation(FI.pos.side);
    if (FI.chess) sparringBoard.setFen(FI.chess.fen());
    else sparringBoard.setFen(FI.pos.fen);
    var live = FI.phase === "user" && !FI.busy;
    sparringBoard.setInteractive(live);
  }

  function finishSetMode(mode) {
    FI.mode = mode === "finish" ? "finish" : "packs";
    var fin = FI.mode === "finish";
    $("sparring-finish").classList.toggle("hidden", !fin);
    $("sparring-packs").classList.toggle("hidden", fin);
    $("btn-sp-finish").classList.toggle("active", fin);
    $("btn-sp-finish").setAttribute("aria-selected", fin ? "true" : "false");
    $("btn-sp-packs").classList.toggle("active", !fin);
    $("btn-sp-packs").setAttribute("aria-selected", fin ? "false" : "true");
    if (fin) {
      if (FI.phase === "idle" && FI.loaded) {
        fiPreview(FI.pos && FI.byId[FI.pos.id] ? FI.pos : fiVisible()[0]);
        fiRenderList();
      } else if (FI.pos && FI.phase !== "idle") {
        fiRestoreBoard();
        if (FI.phase === "user" && !FI.busy) fiClockArm();
      } else sparringBoard.setInteractive(false);
    } else {
      fiClockFreeze();
      fiClockStopTicker();
      fiClockPaint();
      FI.seq++;
      FI.busy = false;
      if (FI.phase === "engine") FI.phase = "user";
      if (!(typeof SP !== "undefined" && SP.attempt && !SP.over)) {
        sparringBoard.setInteractive(false);
        var note = $("sparring-board-note");
        if (note) note.textContent = "";
      }
    }
  }

  function fiBind() {
    if (FI.bound) return;
    FI.bound = true;
    var prev = sparringBoard.onMove;
    sparringBoard.onMove = function (from, to) {
      if (FI.mode === "finish") fiOnMove(from, to);
      else if (prev) prev(from, to);
    };
    $("btn-sp-packs").addEventListener("click", function () { finishSetMode("packs"); });
    $("btn-sp-finish").addEventListener("click", function () { finishSetMode("finish"); });
    $("btn-fi-filter-all").addEventListener("click", function () {
      FI.filter = "all"; fiRenderFilters(); if (FI.phase === "idle") fiPreview(fiVisible()[0]); fiRenderList();
    });
    $("btn-fi-filter-starter").addEventListener("click", function () {
      FI.filter = "starter"; fiRenderFilters(); if (FI.phase === "idle") fiPreview(fiVisible()[0]); fiRenderList();
    });
    $("btn-fi-retry").addEventListener("click", function () { if (FI.posId) fiStart(FI.posId); });
    $("btn-fi-next").addEventListener("click", fiNext);
    $("btn-fi-giveup").addEventListener("click", function () {
      if (!FI.pos || FI.phase === "over" || FI.phase === "idle") return;
      fiFinish({ outcome: "fail", reason: "resign", detail: "You gave up." });
    });
    $("btn-fi-positions").addEventListener("click", fiShowHome);
    var hintBtn = $("btn-fi-hint");
    if (hintBtn) hintBtn.addEventListener("click", fiGiveHint);
    var slipBtn = $("btn-fi-slip");
    if (slipBtn) slipBtn.addEventListener("click", fiRetrySlip);
    var startBtn = $("btn-fi-start");
    if (startBtn) startBtn.addEventListener("click", function () {
      var id = (FI.posId && FI.byId[FI.posId]) ? FI.posId : (fiVisible()[0] && fiVisible()[0].id);
      if (id) fiStart(id);
    });
    var presets = $("fi-clock-presets");
    if (presets) presets.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-clock]");
      if (!b) return;
      var pref = FI.clockPref || fiClockPref();
      pref.preset = b.dataset.clock;
      fiClockSavePref(pref);
      fiRenderClockControls();
      if (FI.mode === "finish" && FI.phase === "idle" && FI.pos) {
        var note = $("sparring-board-note");
        if (note) note.textContent = fiPreviewNote(FI.pos);
      }
    });
    var incs = $("fi-inc-presets");
    if (incs) incs.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-inc]");
      if (!b) return;
      var pref = FI.clockPref || fiClockPref();
      pref.inc = parseInt(b.dataset.inc, 10) || 0;
      fiClockSavePref(pref);
      fiRenderClockControls();
      if (FI.mode === "finish" && FI.phase === "idle" && FI.pos) {
        var note = $("sparring-board-note");
        if (note) note.textContent = fiPreviewNote(FI.pos);
      }
    });
    fiRenderLeftOut();
  }

  var fiLoadP = null;
  function fiLoad() {
    fiLoadP = fetch("data/mine/deck.json?v=49", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("deck " + r.status);
      return r.json();
    }).then(function (data) {
      var byId = {};
      ((data && data.cards) || []).forEach(function (c) { if (c && c.id) byId[c.id] = c; });
      var local = [];
      try { local = JSON.parse(localStorage.getItem("cc-deck-local-v1") || "[]"); } catch (_) { local = []; }
      (local || []).forEach(function (c) { if (c && c.id && !byId[c.id]) byId[c.id] = c; });
      if (typeof Deck !== "undefined" && Deck.loaded && Deck.all) {
        Deck.all.forEach(function (c) { if (c && c.id) byId[c.id] = c; });
      }
      var fromDeck = Object.keys(byId).map(function (k) { return byId[k]; }).filter(fiReal).map(fiFromCard);
      var list = fiDedupe(fromDeck.concat(FI_ADDED));
      list.sort(function (a, b) {
        if (a.starter !== b.starter) return a.starter ? -1 : 1;
        return b.evalBefore - a.evalBefore || String(b.date).localeCompare(String(a.date));
      });
      FI.positions = list;
      FI.byId = {};
      list.forEach(function (p) { FI.byId[p.id] = p; });
      FI.loaded = true;
      fiRenderLead();
      fiRenderList();
      if (FI.mode === "finish" && FI.phase === "idle") {
        fiPreview(fiVisible()[0]);
        fiRenderList();
      }
    }).catch(function (e) {
      FI.loaded = true;
      var host = $("fi-list");
      if (host) host.innerHTML = '<div class="info-line">Could not load the mistake deck (' + fiEsc(e && e.message) + ").</div>";
    });
    return fiLoadP;
  }

  function finishInit() {
    fiBind();
    FI.clockPref = fiClockPref();
    fiRenderClockControls();
    fiRenderFilters();
    if (!fiLoadP) fiLoad();
    else { fiRenderLead(); fiRenderList(); }
  }

  window.finishInit = finishInit;
  window.finishSetMode = finishSetMode;
  window.FinishIt = {
    kept: fiKept,
    edge: fiEdge,
    fmt: fiFmt,
    state: function () { return FI; },
    positions: function () { return FI.positions.slice(); },
    reload: function () { return fiLoad(); }
  };
})();
