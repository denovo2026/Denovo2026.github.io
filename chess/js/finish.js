/* =====================================================================
   v49: Finish it (Sparring)

   Conversion drill. No clock. Each position is one of Trey's own real
   games where the mistake deck already has him at +3.00 or better
   (player-side centipawns) and it is his move. Bot games, coach games
   and From-Position training are not included. New deck cards that pass
   the same filter show up on their own, including cards saved locally
   after an in-browser analysis.

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

   Fail: his eval drops under +1.5, he is checkmated, he gives up, or the
   game is drawn (stalemate, threefold repetition, 50-move, insufficient
   material).

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
  /* Deck id whose stored eval is +3.1 but Stockfish 17.1 depth 22 is +2.85. */
  var FI_REJECT = { "md-lichess-XtnIByaY-40": 285 };

  var FI_STARTER = {
    "md-chesscom-856440792-32": {
      verifiedCp: 419,
      verifiedDepth: 22,
      blurb: "Scotch endgame, Chess.com daily 856440792. The link's move 32 is ply 32 — move 17, you to move as White."
    }
  };

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
    worst: null,
    loaded: false,
    bound: false
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

  function fiBests() {
    try { return JSON.parse(localStorage.getItem(FI_LS) || "{}"); } catch (_) { return {}; }
  }
  function fiSaveBest(id, pct, win) {
    var all = fiBests();
    var prev = all[id];
    if (!prev || pct > prev.pct || (pct === prev.pct && win && !prev.win)) {
      all[id] = { pct: pct, win: !!win, at: new Date().toISOString() };
      try { localStorage.setItem(FI_LS, JSON.stringify(all)); } catch (_) {}
    }
    return all[id];
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
      verifiedCp: extra ? extra.verifiedCp : null,
      verifiedDepth: extra ? extra.verifiedDepth : null,
      blurb: extra ? extra.blurb : ""
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
      var h = FI.hint || {};
      FI.worst = {
        drop: drop,
        before: beforeCp,
        after: afterCp,
        san: FI._lastSan || "",
        playedUci: FI._lastUci || "",
        fen: FI._lastFen || "",
        bestUci: h.uci || "",
        bestSan: h.san || ""
      };
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
    el.innerHTML = "Your own games, from a position the deck has at <b>+3</b> or better, with you to move. "
      + "<b>No clock.</b> Stockfish defends at full strength (skill 20). "
      + "A win is checkmate, a forced mate, or <b>+10</b> — about a queen, where the conversion is no longer in doubt. "
      + "A fail is an edge under <b>+1.5</b>, or any draw. "
      + "The score is the lowest edge divided by the start, both capped at +10. "
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
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fi-row" + (p.id === FI.posId ? " current" : "");
      btn.setAttribute("role", "listitem");
      btn.dataset.id = p.id;
      var sub = (p.starter ? "Starter · " : "") + (p.opp ? "vs " + p.opp : "") + (p.date ? " · " + p.date : "");
      btn.innerHTML = '<span class="fi-ev">' + fiEsc(fiFmt(p.evalBefore)) + "</span>"
        + '<span class="fi-text"><span class="fi-main">' + fiEsc(p.opening) + " · " + fiEsc(String(p.moveNo)) + (p.side === "white" ? "." : "…")
        + "</span>"
        + '<span class="fi-sub">' + fiEsc(sub) + "</span></span>"
        + '<span class="fi-best">' + (b && (b.pct > 0 || b.win) ? fiEsc(String(b.pct) + "%") : "") + "</span>";
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
    if (note) note.textContent = "Preview · No clock · " + fiSideName(p.side) + " to move";
    fiSyncStart();
  }

  function fiSyncStart() {
    var btn = $("btn-fi-start");
    if (!btn) return;
    var ready = !!(FI.posId && FI.byId[FI.posId]) || !!(fiVisible()[0]);
    btn.disabled = !ready;
  }

  function fiShowHome() {
    FI.seq++;
    FI.busy = false;
    var home = $("fi-home"), run = $("fi-run");
    if (home) home.classList.remove("hidden");
    if (run) run.classList.add("hidden");
    sparringBoard.setInteractive(false);
    FI.phase = "idle";
    if (FI.pos && FI.mode === "finish") {
      var note = $("sparring-board-note");
      if (note) note.textContent = "Preview · No clock · " + fiSideName(FI.pos.side) + " to move";
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
    FI.worst = null;
    FI._lastSan = "";
    FI._lastUci = "";
    FI._lastFen = "";
    fiShowRun();
    $("fi-summary").classList.add("hidden");
    $("fi-summary").innerHTML = "";
    $("btn-fi-giveup").disabled = true;
    $("fi-kicker").textContent = [p.date, p.opp ? "vs " + p.opp : "", "you are " + fiSideName(p.side)].filter(Boolean).join(" · ");
    $("fi-brief").textContent = p.blurb || (p.opening + ", move " + p.moveNo + ". You are " + fiSideName(p.side) + ", to move. The game's best move stays hidden until the end.");
    fiSetStatus("Reading the position…");
    $("sparring-board-note").textContent = "No clock · " + fiSideName(p.side) + " · Stockfish skill 20";
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
        return;
      }
      if (cp < FI_FAIL_CP) {
        fiSetStatus("The engine reads this " + fiFmt(cp) + " now, under the +1.5 fail line, so it is not started. Deck had " + fiFmt(p.evalBefore) + ".");
        FI.busy = false;
        FI.phase = "idle";
        return;
      }
      FI.startCp = cp;
      FI.minCp = cp;
      FI.finalCp = cp;
      FI.hint = { uci: a.best || p.bestUci, san: a.best ? fiSan(p.fen, a.best) : p.bestSan };
      FI.phase = "user";
      FI.busy = false;
      $("btn-fi-giveup").disabled = false;
      var deckNote = Math.abs(cp - p.evalBefore) >= 40 ? " Deck had " + fiFmt(p.evalBefore) + "." : "";
      fiSetStatus("Your move. Edge " + fiFmt(cp) + ". It fails under +1.5." + deckNote);
      if (FI.mode === "finish") sparringBoard.setInteractive(true);
    }).catch(function (e) {
      if (seq !== FI.seq) return;
      FI.busy = false;
      FI.phase = "idle";
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
    var uci = uciCandidate(sparringBoard, from, to);
    var mv = fiApply(ch, uci);
    if (!mv) { sparringBoard.shake(); sparringBoard.setFen(fenBefore); return; }
    var seq = FI.seq;
    var beforeCp = FI.finalCp;
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
        var ended2 = fiEvalEnd(now);
        if (ended2) { fiFinish(ended2); return; }
        FI.phase = "user";
        FI.busy = false;
        fiSetStatus("Stockfish played " + reply.san + ". Edge " + fiFmt(now) + ". Your move.");
        if (FI.mode === "finish") sparringBoard.setInteractive(true);
      });
    }).catch(function (e) {
      if (seq !== FI.seq) return;
      FI.busy = false;
      FI.phase = "user";
      fiSetStatus("Engine unavailable: " + (e && e.message ? e.message : "no reply"));
      if (FI.mode === "finish") sparringBoard.setInteractive(true);
    });
  }

  function fiFinish(result) {
    if (!FI.pos || FI.phase === "over") return;
    var p = FI.pos;
    FI.phase = "over";
    FI.busy = false;
    FI.seq++;
    sparringBoard.setInteractive(false);
    $("btn-fi-giveup").disabled = true;
    var win = result.outcome === "win";
    var kept = fiKept(FI.startCp, FI.minCp);
    if (typeof ccLogAnswer === "function") ccLogAnswer("sparring", "finish");
    fiSaveBest(p.id, kept, win);
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
    var clean = "<div class=\"coach-box\"><b>" + (p.starter ? "Clean finish" : "Known better move") + ": "
      + fiEsc(p.bestSan || "—") + ".</b>"
      + (line ? "<div class=\"info-line\">" + fiEsc(line) + "</div>" : "")
      + (p.playedSan ? "<div class=\"info-line\">In the game you played " + fiEsc(p.playedSan) + ".</div>" : "")
      + (p.url ? '<div class="info-line"><a href="' + fiEsc(p.url) + '" target="_blank" rel="noopener">Open the game</a></div>' : "")
      + "</div>";
    sum.innerHTML = '<div class="banner ' + (win ? "green" : "red") + '">'
      + (win ? "Win" : "Fail") + " — " + fiEsc(result.detail) + "</div>"
      + '<div class="fi-score">' + kept + "% kept</div>"
      + '<div class="info-line">Start ' + fiEsc(fiFmt(FI.startCp))
      + " · lowest " + fiEsc(fiFmt(FI.minCp))
      + " · final " + fiEsc(fiFmt(FI.finalCp))
      + ". Lowest ÷ start, both capped at +10. Mate counts as +10.</div>"
      + worstHtml + clean;
    sum.classList.remove("hidden");
    fiSetStatus("");
    var show = $("btn-fi-show-drop");
    if (show) show.addEventListener("click", fiShowWorst);
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
      } else if (FI.pos && FI.phase !== "idle") fiRestoreBoard();
      else sparringBoard.setInteractive(false);
    } else {
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
    var startBtn = $("btn-fi-start");
    if (startBtn) startBtn.addEventListener("click", function () {
      var id = (FI.posId && FI.byId[FI.posId]) ? FI.posId : (fiVisible()[0] && fiVisible()[0].id);
      if (id) fiStart(id);
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
      var list = fiDedupe(Object.keys(byId).map(function (k) { return byId[k]; }).filter(fiReal).map(fiFromCard));
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
    positions: function () { return FI.positions.slice(); }
  };
})();
