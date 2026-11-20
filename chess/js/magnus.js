/* Magnus Modern (v61).
   Carlsen as Black, for a Modern player around 1760. Game library, a
   "which plan did he choose?" quiz, play-on from the middlegame positions,
   and eight theme cards. Every game, move and note comes from
   data/magnus-modern.json. The quiz asks Stockfish in the browser; those
   evals are not stored as facts. */
(function () {
  "use strict";

  var DATA_URL = "data/magnus-modern.json?v=61";
  var LS_KEY = "cc-magnus-modern-v1";
  var LEVEL_NAME = { casual: "Casual", club: "Club", advanced: "Advanced", expert: "Expert", masters: "Masters" };

  var state = {
    data: null,
    parsed: {},
    view: "games",
    lane: "all",
    gameId: null,
    ply: 0,
    shell: "",
    quizIx: 0,
    quizToken: 0,
    playId: null,
    playSeq: 0,
    playPhase: "idle",
    playChess: null,
    playMoves: 0,
    board: null,
    nav: null,
    booted: false,
    loading: false,
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(s) : String(s == null ? "" : s)
      .replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; });
  }
  function fenKey(fen) { return String(fen || "").split(" ").slice(0, 4).join(" "); }
  function readStore() {
    try {
      var v = JSON.parse(localStorage.getItem(LS_KEY) || "");
      if (!v || typeof v !== "object") throw new Error("empty");
      v.games = v.games || {};
      v.quiz = v.quiz || {};
      v.themes = v.themes || {};
      v.play = v.play || {};
      return v;
    } catch (_) {
      return { games: {}, quiz: {}, themes: {}, play: {} };
    }
  }
  function writeStore(v) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch (_) {}
  }
  function summary() {
    var s = readStore();
    var data = state.data;
    var quizIds = Object.keys(s.quiz);
    var correct = 0;
    quizIds.forEach(function (id) { if (s.quiz[id] && s.quiz[id].correct) correct++; });
    var stepped = 0, finished = 0;
    Object.keys(s.games).forEach(function (id) {
      if (s.games[id] && s.games[id].stepped) stepped++;
      if (s.games[id] && s.games[id].finished) finished++;
    });
    return {
      gamesStepped: stepped,
      gamesFinished: finished,
      gamesTotal: data && data.games ? data.games.length : 15,
      quizAnswered: quizIds.length,
      quizCorrect: correct,
      quizTotal: data && data.plan_positions ? data.plan_positions.length : 10,
      themesRead: Object.keys(s.themes).length,
      themesTotal: data && data.study ? data.study.themes.length : 8,
      playStarted: Object.keys(s.play).length,
    };
  }
  function paintProgress() {
    var el = $("mm-progress");
    if (!el) return;
    var s = summary();
    el.textContent = s.gamesStepped + "/" + s.gamesTotal + " games · "
      + s.quizAnswered + "/" + s.quizTotal + " plans · "
      + s.themesRead + "/" + s.themesTotal + " themes";
  }

  function gameById(id) {
    var games = (state.data && state.data.games) || [];
    for (var i = 0; i < games.length; i++) if (games[i].id === id) return games[i];
    return null;
  }
  function posById(id) {
    var list = (state.data && state.data.plan_positions) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function orderedGames() {
    var study = state.data.study;
    var lane = state.lane;
    return study.order.map(gameById).filter(function (g) {
      return g && (lane === "all" || study.lanes[g.id] === lane);
    });
  }
  function notesFor(id) {
    return state.data.study.annotations.filter(function (a) { return a.game_id === id; });
  }
  function moveLabel(parsed, ply) {
    if (!ply) return "Start";
    var m = parsed.moves[ply - 1];
    var n = Math.ceil(ply / 2);
    return m.color === "b" ? n + "…" + m.san : n + "." + m.san;
  }
  function outcome(g) {
    if (g.result === "0-1") return "Carlsen won";
    if (g.result === "1-0") return "Carlsen lost";
    if (g.result === "1/2-1/2") return "Drawn";
    return g.result;
  }
  function confNote(g) {
    if (g.pgn_confidence === "secondary") {
      return "Secondary score only. The event and the result are confirmed; the moves come from a blog that attributes ChessBase.";
    }
    if (g.pgn_confidence === "medium-high") {
      return "Lower-confidence score. The move list was not cross-checked against a TWIC file.";
    }
    return "";
  }
  function shortWhite(name) {
    if (name === "Wei Yi") return "Wei Yi";
    if (name === "Pranesh M") return "Pranesh";
    var parts = String(name || "").split(" ");
    return parts[parts.length - 1] || name;
  }
  function hostOf(url) {
    try { return new URL(url).host.replace(/^www\./, ""); } catch (_) { return url; }
  }
  function parseGame(pgn) {
    var ch = new Chess();
    ch.loadPgn(pgn, { strict: false });
    var hist = ch.history({ verbose: true });
    if (!hist.length) return null;
    return {
      start: hist[0].before,
      moves: hist.map(function (m) {
        return {
          san: m.san,
          uci: m.lan || (m.from + m.to + (m.promotion || "")),
          fen: m.after,
          color: m.color,
        };
      }),
    };
  }
  function levelName() {
    var id = typeof getOpponentLevel === "function" ? getOpponentLevel() : "club";
    return LEVEL_NAME[id] || "Club";
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
  function pawns(cp) {
    if (cp == null || !isFinite(cp)) return "—";
    if (cp >= 9000) return "mate";
    if (cp <= -9000) return "−mate";
    var v = cp / 100;
    var n = Math.abs(v).toFixed(1);
    if (Math.abs(v) < 0.05) return "0.0";
    return (v > 0 ? "+" : "−") + n;
  }
  function forBlack(cp, fen) {
    if (cp == null) return null;
    return (String(fen).split(" ")[1] === "b") ? cp : -cp;
  }
  function sanOf(fen, uci) {
    if (!uci) return "";
    try {
      var ch = new Chess(fen);
      var m = ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
      return m ? m.san : uci;
    } catch (_) { return uci; }
  }
  function pvSan(fen, pv) {
    try {
      var ch = new Chess(fen);
      var out = [];
      for (var i = 0; i < (pv || []).length && i < 6; i++) {
        var u = pv[i];
        var turn = ch.turn();
        var num = ch.moveNumber();
        var m = ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" });
        if (!m) break;
        if (turn === "w") out.push(num + "." + m.san);
        else if (!out.length) out.push(num + "…" + m.san);
        else out.push(m.san);
      }
      return out.join(" ");
    } catch (_) { return ""; }
  }

  function setLabel(text, title) {
    var el = $("mm-label");
    if (!el) return;
    el.textContent = text;
    el.title = title || text;
  }
  function setViewButtons() {
    document.querySelectorAll("#mm-views [data-mm]").forEach(function (b) {
      var on = b.dataset.mm === state.view;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    var tab = $("tab-magnus");
    if (tab) tab.dataset.view = state.view;
  }

  function load() {
    if (state.loading) return;
    state.loading = true;
    var side = $("mm-side");
    if (side) side.innerHTML = '<p class="info-line">Loading the games…</p>';
    fetch(DATA_URL).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      state.data = data;
      state.parsed = {};
      data.games.forEach(function (g) {
        var parsed = parseGame(g.pgn);
        if (!parsed) throw new Error("Could not read " + g.id);
        state.parsed[g.id] = parsed;
      });
      data.plan_positions.forEach(function (p) {
        var parsed = state.parsed[p.game_id];
        var idx = -1;
        for (var i = 0; i < parsed.moves.length; i++) {
          if (parsed.moves[i].fen === p.fen) idx = i;
        }
        if (idx < 0 || !parsed.moves[idx + 1]) throw new Error("Quiz position missing from " + p.game_id);
        var mv = parsed.moves[idx + 1];
        if (mv.uci !== p.played_uci || mv.san !== p.played_san) {
          throw new Error("Played move mismatch " + p.id);
        }
      });
      state.loading = false;
      if (!state.gameId) state.gameId = data.study.order[0];
      if (!state.playId) state.playId = data.study.play_ids[0];
      showCurrent();
    }).catch(function (e) {
      state.loading = false;
      if (side) side.innerHTML = '<p class="info-line">The Magnus Modern file did not load. ' + esc(e.message) + "</p>";
    });
  }

  function showCurrent() {
    setViewButtons();
    paintProgress();
    if (!state.data) return;
    if (state.view === "games") renderGames();
    else if (state.view === "quiz") renderQuiz();
    else if (state.view === "play") renderPlay();
    else renderThemes();
  }

  function setView(view) {
    if (view !== "play") state.playSeq++;
    if (view !== "quiz") state.quizToken++;
    state.view = view;
    state.shell = "";
    if (state.board) {
      state.board.setInteractive(false);
      state.board.clearArrows();
    }
    showCurrent();
  }

  function touchGame(id, ply, len) {
    var s = readStore();
    var rec = s.games[id] || {};
    rec.stepped = true;
    rec.ply = ply;
    rec.at = new Date().toISOString();
    if (ply >= len) rec.finished = true;
    s.games[id] = rec;
    writeStore(s);
    paintProgress();
  }
  function touchTheme(id) {
    var s = readStore();
    if (!s.themes[id]) {
      s.themes[id] = { at: new Date().toISOString() };
      writeStore(s);
      paintProgress();
    }
  }
  function touchPlay(id, moves) {
    var s = readStore();
    var rec = s.play[id] || { moves: 0 };
    rec.moves = Math.max(rec.moves || 0, moves || 0);
    rec.at = new Date().toISOString();
    s.play[id] = rec;
    writeStore(s);
    paintProgress();
  }

  /* ---------- games ---------- */

  function renderGames() {
    var games = orderedGames();
    if (!games.length) return;
    if (!gameById(state.gameId) || (state.lane !== "all" && state.data.study.lanes[state.gameId] !== state.lane)) {
      state.gameId = games[0].id;
      state.ply = 0;
    }
    var shellKey = "games:" + state.lane;
    if (state.shell !== shellKey) {
      state.shell = shellKey;
      var lanes = [
        ["all", "All"], ["tiger", "Tiger"], ["gurgenidze", "Gurgenidze"],
        ["pirc", "Pirc"], ["hippo", "Hippo"], ["norwegian", "Norwegian"],
      ];
      var laneHtml = lanes.map(function (pair) {
        var on = pair[0] === state.lane;
        return '<button type="button" class="btn mini' + (on ? " primary" : "") + '" data-act="lane" data-id="' + pair[0] + '" aria-pressed="' + (on ? "true" : "false") + '">' + pair[1] + "</button>";
      }).join("");
      var rows = games.map(function (g) {
        var soft = g.pgn_confidence !== "high";
        return '<button type="button" class="mm-row' + (g.id === state.gameId ? " on" : "") + '" data-act="game" data-id="' + esc(g.id) + '">'
          + '<span class="t">' + esc(g.white) + "</span>"
          + '<span class="s">' + esc(g.year) + " · " + esc(g.time_control) + " · " + esc(outcome(g))
          + (g.time_control === "blindfold" ? " · blindfold" : "")
          + (soft ? " · lower-confidence score" : "")
          + "</span></button>";
      }).join("");
      $("mm-side").innerHTML = '<p class="mm-soft">Curated set: 8 wins, 4 draws, 3 losses. Classical, rapid, blitz, online, and one blindfold game. Time control stays on the row.</p>'
        + '<div class="mm-lane" role="group" aria-label="Study lanes">' + laneHtml + "</div>"
        + '<div class="mm-list" role="list">' + rows + "</div>"
        + '<div id="mm-note"></div>';
    } else {
      document.querySelectorAll("#mm-side .mm-row").forEach(function (row) {
        row.classList.toggle("on", row.dataset.id === state.gameId);
      });
    }
    goPly(state.ply, false);
  }

  function goPly(n, fromUser) {
    var g = gameById(state.gameId);
    var parsed = g && state.parsed[g.id];
    if (!parsed || !state.board) return;
    var ply = Math.max(0, Math.min(parsed.moves.length, n | 0));
    state.ply = ply;
    var fen = ply ? parsed.moves[ply - 1].fen : parsed.start;
    state.board.setOrientation("black");
    state.board.setInteractive(false);
    state.board.setFen(fen);
    var mv = ply ? parsed.moves[ply - 1] : null;
    state.board.setLastMove(mv ? mv.uci.slice(0, 2) : null, mv ? mv.uci.slice(2, 4) : null);
    if (state.nav && state.view === "games") {
      state.nav.update({
        start: ply > 0, prev: ply > 0,
        next: ply < parsed.moves.length, end: ply < parsed.moves.length,
      });
    }
    setLabel(moveLabel(parsed, ply) + " · " + g.white + " " + g.year + " · " + g.time_control,
      g.white + " – Carlsen, " + g.year + " · " + moveLabel(parsed, ply) + " · " + g.time_control + " · " + outcome(g));
    renderNote();
    if (fromUser) touchGame(g.id, ply, parsed.moves.length);
  }

  function renderNote() {
    var host = $("mm-note");
    var g = gameById(state.gameId);
    var parsed = g && state.parsed[g.id];
    if (!host || !g || !parsed) return;
    var notes = notesFor(g.id);
    var here = null;
    var prev = null;
    var next = null;
    notes.forEach(function (a) {
      if (a.ply === state.ply) here = a;
      else if (a.ply < state.ply) prev = a;
      else if (!next) next = a;
    });
    var chips = notes.map(function (a) {
      return '<button type="button" class="btn mini' + (a.ply === state.ply ? " primary" : "") + '" data-act="ply" data-ply="' + a.ply + '">'
        + esc(moveLabel(parsed, a.ply)) + "</button>";
    }).join("");
    var body = here
      ? "<p>" + esc(here.text) + "</p>"
      : "<p class=\"muted\">No note on this move."
        + (next ? " Next note: " + esc(moveLabel(parsed, next.ply)) + "." : "")
        + "</p>";
    var soft = confNote(g);
    var links = (g.source_urls || []).map(function (u) {
      return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(hostOf(u)) + "</a>";
    }).join(" · ");
    host.innerHTML = '<div class="mm-meta">'
      + esc(g.event) + " · rd " + esc(g.round) + " · " + esc(g.eco) + " · " + esc(g.result)
      + (g.time_control === "blindfold" ? " · blindfold" : "")
      + "</div>"
      + '<div class="mm-meta muted">' + esc(g.opening) + "</div>"
      + (soft ? '<p class="mm-soft">' + esc(soft) + "</p>" : "")
      + '<div class="mm-jumps"><span class="muted">Notes</span> ' + chips + "</div>"
      + '<div class="mm-jumpbtns">'
      + '<button type="button" class="btn mini" data-act="note-prev"' + (prev ? "" : " disabled") + ">Previous note</button>"
      + '<button type="button" class="btn mini" data-act="note-next"' + (next ? "" : " disabled") + ">Next note</button>"
      + "</div>"
      + '<div class="mm-annot">' + body + "</div>"
      + '<p class="mm-src">' + esc(g.pgn_source) + (links ? " · " + links : "") + "</p>"
      + '<p class="mm-count muted">' + state.ply + " / " + parsed.moves.length + " plies · you have Black at the bottom</p>";
  }

  function jumpNote(dir) {
    var notes = notesFor(state.gameId);
    var target = null;
    if (dir > 0) {
      for (var i = 0; i < notes.length; i++) if (notes[i].ply > state.ply) { target = notes[i]; break; }
    } else {
      for (var j = notes.length - 1; j >= 0; j--) if (notes[j].ply < state.ply) { target = notes[j]; break; }
    }
    if (target) goPly(target.ply, true);
  }

  /* ---------- quiz ---------- */

  function renderQuiz() {
    state.shell = "quiz";
    var list = state.data.plan_positions;
    var pos = list[state.quizIx] || list[0];
    state.quizIx = list.indexOf(pos);
    var g = gameById(pos.game_id);
    var choices = state.data.study.quiz_choices[pos.id] || [];
    var saved = readStore().quiz[pos.id];
    state.board.setOrientation("black");
    state.board.setInteractive(false);
    state.board.setFen(pos.fen);
    state.board.setLastMove(null, null);
    state.board.clearArrows();
    if (state.nav) state.nav.update({ start: false, prev: false, next: false, end: false });
    setLabel("Find the plan · " + (state.quizIx + 1) + " of " + list.length + " · " + g.white + " " + g.year + " · " + g.time_control);
    var buttons = choices.map(function (c) {
      var cls = "plan-choice";
      if (saved) {
        if (c.magnus) cls += pos.cautionary ? " matched warn" : " matched";
        else if (saved.picked === c.id) cls += " off";
      }
      return '<button type="button" class="' + cls + '" data-act="choice" data-id="' + esc(c.id) + '"' + (saved ? " disabled" : "") + ">"
        + '<span class="pc-title">' + esc(c.text) + "</span></button>";
    }).join("");
    var warn = pos.cautionary
      ? '<div class="mm-warn">Warning. The question is what he chose. 10…Bxg4 did not hold, and he lost. It is not a model to copy.</div>'
      : "";
    var soft = confNote(g);
    $("mm-side").innerHTML = '<div class="mm-qhead"><strong>' + esc(g.white) + " – Carlsen, " + esc(String(g.year)) + "</strong>"
      + '<span class="mm-meta">' + esc(g.time_control) + " · after " + esc(pos.after) + " · Black to move"
      + (g.time_control === "blindfold" ? " · blindfold" : "") + "</span></div>"
      + warn
      + (soft ? '<p class="mm-soft">' + esc(soft) + "</p>" : "")
      + '<p class="mm-ask">' + (pos.cautionary ? "What did he choose here?" : "Which plan did he choose?") + "</p>"
      + '<div class="plan-choices" id="mm-choices">' + buttons + "</div>"
      + '<div id="mm-reveal" class="mm-annot" role="status"></div>'
      + '<div id="mm-engine" class="mm-engine"></div>'
      + '<div class="mm-jumpbtns">'
      + '<button type="button" class="btn mini" data-act="quiz" data-dir="-1"' + (state.quizIx ? "" : " disabled") + ">Previous</button>"
      + '<button type="button" class="btn mini primary" data-act="quiz" data-dir="1"' + (state.quizIx < list.length - 1 ? "" : " disabled") + ">Next</button>"
      + "</div>";
    if (saved) revealAnswer(pos, saved.picked, false);
  }

  function pickChoice(choiceId) {
    var pos = state.data.plan_positions[state.quizIx];
    if (!pos) return;
    var s = readStore();
    if (s.quiz[pos.id]) return;
    var choices = state.data.study.quiz_choices[pos.id] || [];
    var picked = null;
    choices.forEach(function (c) { if (c.id === choiceId) picked = c; });
    if (!picked) return;
    s.quiz[pos.id] = { correct: !!picked.magnus, picked: picked.id, at: new Date().toISOString() };
    writeStore(s);
    paintProgress();
    document.querySelectorAll("#mm-choices .plan-choice").forEach(function (btn) {
      btn.disabled = true;
      var id = btn.dataset.id;
      var mine = false;
      choices.forEach(function (c) { if (c.id === id && c.magnus) mine = true; });
      if (mine) btn.classList.add("matched", pos.cautionary ? "warn" : "ok");
      else if (id === choiceId) btn.classList.add("off");
    });
    revealAnswer(pos, choiceId, true);
  }

  function revealAnswer(pos, pickedId, fresh) {
    var box = $("mm-reveal");
    var eng = $("mm-engine");
    if (!box) return;
    var choices = state.data.study.quiz_choices[pos.id] || [];
    var picked = null;
    choices.forEach(function (c) { if (c.id === pickedId) picked = c; });
    var matched = picked && picked.magnus;
    var head;
    if (pos.cautionary && matched) head = "That is what he chose. The sacrifice did not hold.";
    else if (matched) head = "That is his plan.";
    else if (pos.cautionary) head = "He chose the sacrifice, and it failed. A calmer plan is a different question.";
    else head = "He chose a different plan.";
    var detail = pos.cautionary
      ? "He played 10…Bxg4, aiming for two pawns and an attack after 7.g4. It was not enough, and Naiditsch won."
      : "He played " + pos.magnus_move + ". " + pos.plan;
    box.innerHTML = "<p><strong>" + esc(head) + "</strong> " + esc(detail) + "</p>";
    if (eng) eng.textContent = "Asking Stockfish…";
    if (pos.played_uci && pos.played_uci.length >= 4) {
      state.board.setArrows([{ from: pos.played_uci.slice(0, 2), to: pos.played_uci.slice(2, 4), color: pos.cautionary ? "amber" : "green" }]);
    }
    askEngine(pos);
    if (fresh) paintProgress();
  }

  function askEngine(pos) {
    var token = ++state.quizToken;
    var eng = $("mm-engine");
    if (!window.CCEngine) {
      if (eng) eng.textContent = "Stockfish is not loaded in this page.";
      return;
    }
    CCEngine.analyse(pos.fen, { depth: 12, movetime: 900, multipv: 3, skill: 20, priority: "high" }).then(function (r) {
      if (token !== state.quizToken || state.view !== "quiz") return;
      var bestUci = r && r.bestmove;
      var bestLine = r && r.lines && r.lines[0];
      var bestCp = forBlack(lineCp(bestLine), pos.fen);
      var depth = r && r.depth ? r.depth : 0;
      var bestSan = sanOf(pos.fen, bestUci);
      var same = bestUci && pos.played_uci && bestUci === pos.played_uci;
      if (same) {
        paintEngine(pos, "Stockfish 19 Lite, depth " + depth + ": the first line is " + pos.played_san
          + " (" + pawns(bestCp) + " for Black). " + pvSan(pos.fen, bestLine && bestLine.pv));
        return;
      }
      var ch = new Chess(pos.fen);
      var played = null;
      try {
        played = ch.move({ from: pos.played_uci.slice(0, 2), to: pos.played_uci.slice(2, 4), promotion: pos.played_uci[4] || "q" });
      } catch (_) { played = null; }
      if (!played) {
        paintEngine(pos, "Stockfish 19 Lite, depth " + depth + ": first line " + bestSan + " (" + pawns(bestCp) + " for Black).");
        return;
      }
      return CCEngine.analyse(ch.fen(), { depth: 12, movetime: 700, multipv: 1, skill: 20, priority: "high" }).then(function (after) {
        if (token !== state.quizToken || state.view !== "quiz") return;
        var afterLine = after && after.lines && after.lines[0];
        var hisCp = forBlack(lineCp(afterLine), ch.fen());
        var gap = (bestCp != null && hisCp != null) ? bestCp - hisCp : null;
        var taste = "";
        if (gap != null && gap > 80) taste = " The engine prefers a different move at this depth.";
        else if (gap != null && gap > 30) taste = " The engine is a bit ahead of his move at this depth.";
        else if (gap != null) taste = " At this depth the two moves are close.";
        paintEngine(pos, "Stockfish 19 Lite, depth " + depth + ": first line " + bestSan
          + " (" + pawns(bestCp) + " for Black). After " + pos.played_san + ": " + pawns(hisCp) + " for Black." + taste);
      });
    }).catch(function () {
      if (token !== state.quizToken) return;
      paintEngine(pos, "Stockfish did not answer. The recorded move is " + pos.played_san + ".");
    });
  }

  function paintEngine(pos, text) {
    var eng = $("mm-engine");
    if (!eng || state.view !== "quiz") return;
    var extra = "";
    if (pos.cautionary) {
      extra = " The game result stands either way: the attack was not enough, and Naiditsch won.";
    }
    eng.textContent = text + extra;
  }

  /* ---------- play ---------- */

  function playPositions() {
    var ids = state.data.study.play_ids || [];
    return ids.map(posById).filter(Boolean);
  }

  function renderPlay() {
    state.shell = "play";
    var list = playPositions();
    if (!state.playId || !posById(state.playId)) state.playId = list[0] ? list[0].id : null;
    var rows = list.map(function (p) {
      var g = gameById(p.game_id);
      return '<button type="button" class="mm-row' + (p.id === state.playId ? " on" : "") + '" data-act="play" data-id="' + esc(p.id) + '">'
        + '<span class="t">' + esc(g.white) + " " + esc(String(g.year)) + (p.cautionary ? " · warning" : "") + "</span>"
        + '<span class="s">' + esc(g.time_control) + " · after " + esc(p.after) + "</span></button>";
    }).join("");
    var running = state.playPhase === "user" || state.playPhase === "engine";
    $("mm-side").innerHTML = '<p class="mm-ask">Play on from a middlegame he reached. You are Black. White is Stockfish at your Sparring level (' + esc(levelName()) + ').</p>'
      + '<p class="mm-soft">The breaks against Tari (move 4) and Mamedov (move 5) stay in the quiz. They are the opening move, not a middlegame.</p>'
      + '<div class="mm-list">' + rows + "</div>"
      + '<div id="mm-play-goal" class="mm-annot"></div>'
      + '<div id="mm-status" class="info-line" role="status"></div>'
      + '<div class="mm-jumpbtns">'
      + '<button type="button" class="btn mini primary" data-act="start"' + (running ? " disabled" : "") + ">Start</button>"
      + '<button type="button" class="btn mini" data-act="resign"' + (running ? "" : " disabled") + ">Resign</button>"
      + "</div>";
    if (!running) previewPlay(state.playId);
    else paintPlayGoal();
  }

  function previewPlay(id) {
    var pos = posById(id);
    if (!pos || !state.board) return;
    state.playId = id;
    state.playPhase = "preview";
    state.playChess = null;
    state.board.setOrientation("black");
    state.board.setInteractive(false);
    state.board.setFen(pos.fen);
    state.board.setLastMove(null, null);
    state.board.clearArrows();
    var g = gameById(pos.game_id);
    setLabel("Play like Magnus · " + g.white + " " + g.year + " · you are Black");
    paintPlayGoal();
    var st = $("mm-status");
    if (st) st.textContent = "Preview. Start when you want Stockfish to answer.";
  }

  function paintPlayGoal() {
    var host = $("mm-play-goal");
    var pos = posById(state.playId);
    if (!host || !pos) return;
    if (pos.cautionary) {
      host.innerHTML = '<div class="mm-warn">In the game he played 10…Bxg4 and lost. Play the position. The sacrifice is a warning, not the assignment.</div>';
    } else {
      host.innerHTML = "<p>" + esc(pos.plan) + "</p>";
    }
  }

  function startPlay() {
    var pos = posById(state.playId);
    if (!pos) return;
    var ch;
    try { ch = new Chess(pos.fen); } catch (_) {
      var st = $("mm-status");
      if (st) st.textContent = "This position did not load.";
      return;
    }
    state.playSeq++;
    state.playChess = ch;
    state.playMoves = 0;
    state.playPhase = "user";
    touchPlay(pos.id, 0);
    state.board.setInteractive(true);
    state.board.setFen(ch.fen());
    state.board.setLastMove(null, null);
    var startBtn = document.querySelector('#mm-side [data-act="start"]');
    var resignBtn = document.querySelector('#mm-side [data-act="resign"]');
    if (startBtn) startBtn.disabled = true;
    if (resignBtn) resignBtn.disabled = false;
    var st = $("mm-status");
    if (st) st.textContent = "Your move. White is Stockfish (" + levelName() + ").";
  }

  function endPlay(text) {
    state.playSeq++;
    state.playPhase = "over";
    if (state.board) state.board.setInteractive(false);
    var st = $("mm-status");
    if (st) st.textContent = text || "Game over.";
    var startBtn = document.querySelector('#mm-side [data-act="start"]');
    var resignBtn = document.querySelector('#mm-side [data-act="resign"]');
    if (startBtn) startBtn.disabled = false;
    if (resignBtn) resignBtn.disabled = true;
  }

  function onUserMove(from, to) {
    if (state.view !== "play" || state.playPhase !== "user" || !state.playChess) {
      if (state.board) state.board.shake();
      return;
    }
    var uci = typeof uciCandidate === "function" ? uciCandidate(state.board, from, to) : (from + to);
    var m = null;
    try {
      m = state.playChess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
    } catch (_) { m = null; }
    if (!m) { state.board.shake(); return; }
    state.playMoves++;
    touchPlay(state.playId, state.playMoves);
    state.board.setFen(state.playChess.fen());
    state.board.setLastMove(m.from, m.to);
    if (state.playChess.isGameOver()) {
      endPlay(terminalText(state.playChess));
      return;
    }
    engineReply();
  }

  function terminalText(ch) {
    if (ch.isCheckmate()) return ch.turn() === "w" ? "Checkmate. You won." : "Checkmate. White won.";
    if (ch.isStalemate()) return "Stalemate.";
    if (ch.isDraw()) return "Drawn.";
    return "Game over.";
  }

  function engineReply() {
    var seq = state.playSeq;
    var fen = state.playChess.fen();
    state.playPhase = "engine";
    state.board.setInteractive(false);
    var st = $("mm-status");
    if (st) st.textContent = "White to move…";
    var level = typeof getOpponentLevel === "function" ? getOpponentLevel() : "club";
    var job = (typeof apiPost === "function")
      ? apiPost("/api/sparring/opponent-move", { fen: fen, level: level })
      : Promise.reject(new Error("no engine"));
    job.then(function (r) {
      if (seq !== state.playSeq || state.view !== "play") return;
      if (!r || r.terminal || !r.uci) {
        endPlay((r && (r.reason || r.result)) || "Game over.");
        return;
      }
      try { state.playChess = new Chess(r.fen_after); }
      catch (_) { endPlay("The reply did not load."); return; }
      state.board.setFen(r.fen_after);
      state.board.setLastMove(r.uci.slice(0, 2), r.uci.slice(2, 4));
      if (r.after_terminal || state.playChess.isGameOver()) {
        endPlay(r.reason || terminalText(state.playChess));
        return;
      }
      state.playPhase = "user";
      state.board.setInteractive(true);
      if (st) st.textContent = "White played " + r.san + ". Your move.";
    }).catch(function (e) {
      if (seq !== state.playSeq || state.view !== "play") return;
      state.playPhase = "user";
      state.board.setInteractive(true);
      if (st) st.textContent = "No reply from Stockfish. " + (e && e.message ? e.message : "Try the move again.");
    });
  }

  /* ---------- themes ---------- */

  function renderThemes() {
    state.shell = "themes";
    if (state.board) state.board.setInteractive(false);
    if (state.nav) state.nav.update({ start: false, prev: false, next: false, end: false });
    setLabel("Eight ideas from the games");
    var html = state.data.study.themes.map(function (t) {
      var games = t.games.map(function (pair) {
        var g = gameById(pair[0]);
        var parsed = state.parsed[pair[0]];
        var label = g ? shortWhite(g.white) + " " + g.year : pair[0];
        if (parsed) label += " · " + moveLabel(parsed, pair[1]);
        return '<button type="button" class="btn mini" data-act="theme-game" data-id="' + esc(pair[0]) + '" data-ply="' + pair[1] + '" data-theme="' + esc(t.id) + '">' + esc(label) + "</button>";
      }).join("");
      var quizzes = (t.quizzes || []).map(function (id) {
        var p = posById(id);
        var g = p && gameById(p.game_id);
        var label = g ? shortWhite(g.white) + " · " + p.magnus_move : id;
        return '<button type="button" class="btn mini" data-act="theme-quiz" data-id="' + esc(id) + '" data-theme="' + esc(t.id) + '">' + esc(label) + "</button>";
      }).join("");
      return '<article class="mm-card"><h3>' + esc(t.title) + "</h3><p>" + esc(t.body) + "</p>"
        + '<div class="mm-links">' + games + quizzes + "</div></article>";
    }).join("");
    $("mm-themes").innerHTML = html + '<p class="mm-foot">' + esc(state.data.study.footer) + "</p>";
  }

  function openGame(id, ply, themeId) {
    if (themeId) touchTheme(themeId);
    state.lane = "all";
    state.gameId = id;
    state.ply = ply;
    state.shell = "";
    state.view = "games";
    showCurrent();
    goPly(ply, true);
  }
  function openQuiz(id, themeId) {
    if (themeId) touchTheme(themeId);
    var list = state.data.plan_positions;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) state.quizIx = i;
    state.view = "quiz";
    state.shell = "";
    showCurrent();
  }

  function onSideClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    var act = btn.dataset.act;
    if (act === "lane") {
      state.lane = btn.dataset.id;
      state.shell = "";
      renderGames();
      return;
    }
    if (act === "game") {
      state.gameId = btn.dataset.id;
      state.ply = 0;
      state.shell = "";
      renderGames();
      return;
    }
    if (act === "ply") { goPly(parseInt(btn.dataset.ply, 10), true); return; }
    if (act === "note-next") { jumpNote(1); return; }
    if (act === "note-prev") { jumpNote(-1); return; }
    if (act === "choice") { pickChoice(btn.dataset.id); return; }
    if (act === "quiz") {
      var dir = parseInt(btn.dataset.dir, 10) || 0;
      var n = state.quizIx + dir;
      var len = state.data.plan_positions.length;
      if (n < 0 || n >= len) return;
      state.quizToken++;
      state.quizIx = n;
      renderQuiz();
      return;
    }
    if (act === "play") {
      if (state.playPhase === "user" || state.playPhase === "engine") return;
      state.playId = btn.dataset.id;
      state.shell = "";
      renderPlay();
      return;
    }
    if (act === "start") { startPlay(); return; }
    if (act === "resign") { endPlay("You resigned."); }
  }

  function onThemeClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "theme-game") openGame(btn.dataset.id, parseInt(btn.dataset.ply, 10), btn.dataset.theme);
    if (btn.dataset.act === "theme-quiz") openQuiz(btn.dataset.id, btn.dataset.theme);
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;
    state.board = new Board($("mm-board"), { onMove: onUserMove });
    state.board.setOrientation("black");
    state.board.setInteractive(false);
    state.nav = createNavControls("mm-nav", {
      isActive: function () {
        var tab = $("tab-magnus");
        return !!(tab && tab.classList.contains("active") && state.view === "games");
      },
      onNav: function (dir) {
        var parsed = state.parsed[state.gameId];
        if (!parsed) return;
        var n = state.ply;
        if (dir === "start") n = 0;
        else if (dir === "end") n = parsed.moves.length;
        else if (dir === "prev") n = state.ply - 1;
        else n = state.ply + 1;
        goPly(n, true);
      },
    });
    $("mm-views").addEventListener("click", function (e) {
      var b = e.target.closest("[data-mm]");
      if (!b || b.dataset.mm === state.view) return;
      setView(b.dataset.mm);
    });
    $("mm-side").addEventListener("click", onSideClick);
    $("mm-themes").addEventListener("click", onThemeClick);
  }

  function open() {
    boot();
    if (!state.data) load();
    else showCurrent();
  }

  window.MagnusModern = { open: open, summary: summary, storageKey: LS_KEY };
})();
