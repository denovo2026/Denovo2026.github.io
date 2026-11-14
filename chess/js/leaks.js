/* Opening leak finder.
   Replay stored Lichess games (and the bundled set) against the repertoire
   lines. A game is "in" a line while its position is still on that line,
   so a different move order that reaches the same position still counts.
   The first move that steps off every matching line is the leak: his own
   deviation, or an opponent sideline the book does not cover.
   Ranked by how much the eval swung against him. */
(function () {
  "use strict";

  var BOOKS = [
    { slug: "modern", file: "data/modern.json" },
    { slug: "grunfeld", file: "data/grunfeld.json" },
    { slug: "scotch", file: "data/scotch.json" },
    { slug: "qg", file: "data/qg.json" },
    { slug: "alapin", file: "data/alapin.json" }
  ];
  /* Two plies in the book is enough to say the opening started
     (1.e4 e5 is already the Scotch path; 1.e4 c5 is already the Alapin). */
  var MIN_PLIES = 2;
  var CP_KEY = "cc-leak-cp-v1";
  var state = { lines: null, rows: [], games: [], user: "", filter: "all", token: 0, board: null, selected: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return typeof escapeHtml === "function" ? escapeHtml(s) : String(s == null ? "" : s); }
  function posKey(fen) { return String(fen || "").split(" ").slice(0, 4).join(" "); }
  function userName() {
    var el = $("leak-user");
    var v = (el && el.value || "").trim();
    if (v) return v;
    try { v = localStorage.getItem("cc-lichess-user-v1") || ""; } catch (_) { v = ""; }
    return v || "Jetblack007";
  }
  function remember(name) {
    try { localStorage.setItem("cc-lichess-user-v1", name); } catch (_) {}
    var el = $("leak-user");
    if (el) el.value = name;
  }
  function setStatus(t) {
    var el = $("leak-status");
    if (el) el.textContent = t || "";
  }
  function fmtPawns(cp) {
    if (cp == null || !isFinite(cp)) return "—";
    var v = cp / 100;
    var body = Math.abs(v).toFixed(1);
    if (v > 0.049) return "+" + body;
    if (v < -0.049) return "−" + body;
    return "0.0";
  }
  function plyLabel(ply, san) {
    var n = Math.floor(ply / 2) + 1;
    return (ply % 2 === 0 ? n + "." : n + "…") + san;
  }
  function userSide(g, user) {
    var n = String(user || "").toLowerCase();
    if ((g.white || "").toLowerCase() === n) return "white";
    if ((g.black || "").toLowerCase() === n) return "black";
    return null;
  }
  function outcome(g, side) {
    if (g.result === "1/2-1/2" || g.status === "draw" || g.status === "stalemate") return "d";
    if (g.winner === "white" || g.winner === "black") return g.winner === side ? "w" : "l";
    if (g.result === "1-0") return side === "white" ? "w" : "l";
    if (g.result === "0-1") return side === "black" ? "w" : "l";
    return null;
  }
  function playToken(ch, token) {
    if (!token) return null;
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token)) {
      try {
        return ch.move({ from: token.slice(0, 2), to: token.slice(2, 4), promotion: token[4] || "q" });
      } catch (_) { return null; }
    }
    var clean = String(token).replace(/[+#?!]/g, "");
    try { return ch.move(clean) || ch.move(token); } catch (_) {
      try { return ch.move(token); } catch (e2) { return null; }
    }
  }
  function replay(moves) {
    var ch = new Chess();
    var tokens = String(moves || "").trim().split(/\s+/).filter(Boolean);
    var steps = [];
    for (var i = 0; i < tokens.length; i++) {
      var fenBefore = ch.fen();
      var m = playToken(ch, tokens[i]);
      if (!m) break;
      steps.push({
        san: m.san, uci: m.from + m.to + (m.promotion || ""),
        fenBefore: fenBefore, fenAfter: ch.fen(),
        ply: i, stm: fenBefore.split(" ")[1]
      });
    }
    return steps;
  }
  function loadLines() {
    if (state.lines) return Promise.resolve(state.lines);
    return Promise.all(BOOKS.map(function (b) {
      return fetch(b.file, { cache: "force-cache" }).then(function (r) { return r.json(); }).then(function (data) {
        var lines = [];
        (data.looks || []).forEach(function (look) {
          var sans = look.moves || [];
          if (!sans.length) return;
          var ch = new Chess();
          var keys = [posKey(ch.fen())];
          var ucis = [];
          for (var i = 0; i < sans.length; i++) {
            var m = playToken(ch, sans[i]);
            if (!m) return;
            ucis.push(m.from + m.to + (m.promotion || ""));
            keys.push(posKey(ch.fen()));
          }
          lines.push({
            slug: b.slug, id: look.id, name: look.name, opening: data.name || b.slug,
            side: data.side || "both", tab: b.slug, sans: sans, ucis: ucis, keys: keys
          });
        });
        return lines;
      });
    })).then(function (groups) {
      state.lines = groups.reduce(function (a, g) { return a.concat(g); }, []);
      return state.lines;
    });
  }
  function maxAt(list) {
    var m = 0;
    for (var i = 0; i < list.length; i++) if (list[i].at > m) m = list[i].at;
    return m;
  }
  function focus(active) {
    var bestAt = maxAt(active);
    return active.filter(function (a) { return a.at === bestAt; });
  }
  function assign(active) {
    var tie = focus(active);
    var by = {};
    tie.forEach(function (a) { (by[a.line.slug] = by[a.line.slug] || []).push(a); });
    var slug = Object.keys(by).sort(function (a, b) { return by[b].length - by[a].length; })[0];
    var group = by[slug];
    return { line: group[0].line, ply: group[0].at, trunk: group.length > 1, group: group };
  }
  function serverSwing(game, ply, side) {
    if (!game.evals) return null;
    var before = ply === 0 ? 0 : game.evals[ply - 1];
    var after = game.evals[ply];
    if (before == null || after == null) return null;
    var d = after - before;
    var s = side === "white" ? d : -d;
    if (s > 2000) s = 2000;
    if (s < -2000) s = -2000;
    return s;
  }
  function walk(game, lines, user) {
    var side = userSide(game, user);
    if (!side) return null;
    if (game.variant && game.variant !== "standard") return null;
    var steps = replay(game.moves);
    if (steps.length < 8) return null;
    var relevant = lines.filter(function (l) { return l.side === "both" || l.side === side; });
    var active = relevant.map(function (l) { return { line: l, at: 0 }; });
    var departed = null;
    var lastGood = null;
    for (var i = 0; i < steps.length; i++) {
      var after = posKey(steps[i].fenAfter);
      var next = [];
      for (var k = 0; k < active.length; k++) {
        var a = active[k];
        if (a.line.keys[a.at + 1] === after) next.push({ line: a.line, at: a.at + 1 });
      }
      if (!next.length) {
        var cont = active.filter(function (a) { return a.at < a.line.sans.length; });
        if (cont.length && maxAt(cont) >= MIN_PLIES) {
          var books = [];
          cont.forEach(function (a) {
            var s = a.line.sans[a.at];
            if (s && books.indexOf(normSan(s)) < 0) books.push(normSan(s));
          });
          departed = {
            gamePly: i, san: steps[i].san, uci: steps[i].uci,
            fen: steps[i].fenBefore, fenAfter: steps[i].fenAfter,
            who: steps[i].stm === (side === "white" ? "w" : "b") ? "you" : "opponent",
            books: books.slice(0, 3), active: cont, at: maxAt(cont)
          };
        }
        break;
      }
      active = next;
      if (maxAt(active) >= MIN_PLIES) lastGood = active;
    }
    var group = departed ? departed.active : lastGood;
    if (!group) return { outside: true, side: side };
    return {
      outside: false, side: side, asg: assign(group), departed: departed,
      swing: departed ? serverSwing(game, departed.gamePly, side) : null,
      result: outcome(game, side), game: game
    };
  }
  function normSan(s) { return String(s || "").replace(/[+#?!]/g, ""); }
  function rowKey(hit) {
    var a = hit.asg;
    var id = a.trunk ? "trunk" : a.line.id;
    return a.line.slug + "/" + id + "/" + hit.side;
  }
  function buildRows(games, lines, user) {
    var map = {};
    var outside = 0, used = 0;
    games.forEach(function (g) {
      var hit = walk(g, lines, user);
      if (!hit || hit.outside) { if (hit && hit.outside) outside++; return; }
      used++;
      var key = rowKey(hit);
      var row = map[key];
      if (!row) {
        var a = hit.asg;
        row = map[key] = {
          key: key, slug: a.line.slug, lookId: a.line.id, tab: a.line.tab,
          opening: a.line.opening, name: a.trunk ? a.line.opening + " — shared start" : a.line.name,
          trunk: a.trunk, side: hit.side, n: 0, w: 0, d: 0, l: 0, deps: [], stayed: 0
        };
      }
      row.n++;
      if (hit.result === "w") row.w++;
      else if (hit.result === "d") row.d++;
      else if (hit.result === "l") row.l++;
      if (!hit.departed) { row.stayed++; return; }
      var d = hit.departed;
      row.deps.push({
        who: d.who, san: d.san, uci: d.uci, books: d.books, ply: d.at,
        gamePly: d.gamePly, fen: d.fen, fenAfter: d.fenAfter, swing: hit.swing,
        label: plyLabel(d.gamePly, d.san)
      });
    });
    var rows = Object.keys(map).map(function (k) { return map[k]; });
    rows.forEach(attachPrimary);
    rows.sort(byLeak);
    return { rows: rows, outside: outside, used: used };
  }
  function attachPrimary(row) {
    var buckets = {};
    row.deps.forEach(function (d) {
      var k = d.who + "|" + normSan(d.san) + "|" + (d.books || []).join("/");
      if (!buckets[k]) buckets[k] = { n: 0, swings: [], sample: d, who: d.who, san: d.san, books: d.books, label: d.label };
      buckets[k].n++;
      if (d.swing != null) buckets[k].swings.push(d.swing);
    });
    var list = Object.keys(buckets).map(function (k) {
      var b = buckets[k];
      b.avg = b.swings.length ? b.swings.reduce(function (a, c) { return a + c; }, 0) / b.swings.length : null;
      b.harm = b.avg == null ? 0 : Math.max(0, -b.avg);
      b.source = b.swings.length ? "Lichess" : "";
      return b;
    });
    list.sort(function (a, b) { return (b.harm * b.n) - (a.harm * a.n) || b.n - a.n; });
    row.primary = list[0] || null;
    row.also = list.length > 1 ? list[1] : null;
  }
  function leakScore(row) {
    var p = row.primary;
    if (!p) return -1;
    var harm = p.avg == null ? (row.l * 40 + p.n * 8) : p.harm * p.n;
    return harm + row.l * 15 + p.n;
  }
  function byLeak(a, b) { return leakScore(b) - leakScore(a) || b.n - a.n; }
  function scorePct(row) {
    var known = row.w + row.d + row.l;
    if (!known) return null;
    return Math.round(100 * (row.w + 0.5 * row.d) / known);
  }
  function visibleRows() {
    return state.rows.filter(function (r) {
      if (state.filter === "all") return true;
      return r.side === state.filter;
    });
  }
  function bookUci(fen, san) {
    try {
      var ch = new Chess(fen);
      var m = playToken(ch, san);
      return m ? m.from + m.to + (m.promotion || "") : "";
    } catch (_) { return ""; }
  }
  function showRow(row) {
    state.selected = row && row.key;
    if (!state.board) return;
    var p = row && row.primary;
    if (!p) {
      state.board.setFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
      state.board.clearArrows();
      var idle = $("leak-pos");
      if (idle) idle.textContent = row ? "Stayed in the book. Drill the line to keep it." : "Select a line.";
      return;
    }
    state.board.setFen(p.sample.fen);
    state.board.setOrientation(row.side === "black" ? "black" : "white");
    state.board.setLastMove(p.sample.uci.slice(0, 2), p.sample.uci.slice(2, 4));
    var arrows = [{ from: p.sample.uci.slice(0, 2), to: p.sample.uci.slice(2, 4), color: "red" }];
    var bu = p.books && p.books[0] ? bookUci(p.sample.fen, p.books[0]) : "";
    if (bu && bu.slice(0, 4) !== p.sample.uci.slice(0, 4)) {
      arrows.push({ from: bu.slice(0, 2), to: bu.slice(2, 4), color: "green" });
    }
    state.board.setArrows(arrows);
    var note = $("leak-pos");
    if (!note) return;
    var who = p.who === "you" ? "You played" : "Opponent played";
    var book = (p.books || []).slice(0, 2).join(" or ");
    note.textContent = who + " " + p.label + (book ? ". The book has " + book + "." : ".")
      + " Red is the move played, green is the book move.";
  }
  function render() {
    var host = $("leak-list");
    if (!host) return;
    var rows = visibleRows();
    host.innerHTML = "";
    if (!rows.length) {
      host.innerHTML = '<div class="info-line leak-empty">No repertoire games in this set yet. Load games, or these games never reached the Modern, Grünfeld, Scotch, Queen\'s Gambit or Alapin.</div>';
      return;
    }
    rows.forEach(function (row, i) {
      var el = document.createElement("div");
      el.className = "leak-row" + (row.key === state.selected ? " on" : "");
      el.dataset.key = row.key;
      var p = row.primary;
      var pct = scorePct(row);
      var swing = p && p.avg != null ? fmtPawns(p.avg) : (p ? "…" : "");
      var swingCls = p && p.avg != null ? (p.avg < -15 ? "bad" : "ok") : "";
      var dep = "Stayed in prep";
      if (p) {
        var who = p.who === "you" ? "You left with " : "Opponent left theory with ";
        var book = (p.books || []).slice(0, 2).join(" or ");
        dep = who + p.label + (book ? " · book " + book : "");
        if (p.n && row.n) dep += " · " + p.n + " of " + row.n;
      } else if (row.stayed) {
        dep = "Stayed through the book · " + row.stayed + (row.stayed === 1 ? " game" : " games");
      }
      var side = row.side === "white" ? "White" : "Black";
      el.innerHTML = '<span class="leak-n">' + (i + 1) + '</span><div class="leak-main">'
        + '<div class="lr-name">' + esc(row.opening) + " — " + esc(row.name.replace(row.opening + " — ", "")) + "</div>"
        + '<div class="lr-meta">' + row.n + " " + (row.n === 1 ? "game" : "games")
        + " · " + row.w + "-" + row.d + "-" + row.l
        + (pct == null ? "" : " · " + pct + "%")
        + " · you " + side + "</div>"
        + '<div class="lr-dep">' + esc(dep) + "</div></div>"
        + '<div class="leak-side"><span class="leak-swing ' + swingCls + '">' + esc(swing) + "</span>"
        + (p && p.source ? '<span class="leak-src">' + esc(p.source) + "</span>" : "")
        + '<button type="button" class="btn mini leak-drill">Drill this line</button></div>';
      el.addEventListener("click", function () { showRow(row); markOn(); });
      el.querySelector(".leak-drill").addEventListener("click", function (e) {
        e.stopPropagation();
        drill(row);
      });
      host.appendChild(el);
    });
    function markOn() {
      host.querySelectorAll(".leak-row").forEach(function (n) {
        n.classList.toggle("on", n.dataset.key === state.selected);
      });
    }
    if (!state.selected || !rows.some(function (r) { return r.key === state.selected; })) showRow(rows[0]);
    else showRow(rows.filter(function (r) { return r.key === state.selected; })[0]);
    markOn();
  }
  async function drill(row) {
    var p = row.primary;
    var ply = p ? p.sample.ply : 0;
    var ok = false;
    if (typeof openRepertoireLine === "function") {
      try { ok = await openRepertoireLine(row.tab, row.lookId, ply, row.side); }
      catch (_) { ok = false; }
    }
    if (!ok && p && typeof sendFenToPlay === "function") {
      sendFenToPlay(p.sample.fen, row.side, "Left the book here — " + (p.who === "you" ? "you played " : "opponent played ") + p.label + ".");
    }
  }
  function cpCache() {
    try {
      var v = JSON.parse(localStorage.getItem(CP_KEY) || "{}");
      return v && typeof v === "object" ? v : {};
    } catch (_) { return {}; }
  }
  function cpSave(cache) {
    var keys = Object.keys(cache);
    if (keys.length > 240) keys.slice(0, keys.length - 240).forEach(function (k) { delete cache[k]; });
    try { localStorage.setItem(CP_KEY, JSON.stringify(cache)); } catch (_) {}
  }
  async function whiteCp(fen, cache) {
    var key = posKey(fen);
    if (cache[key] != null) return cache[key];
    var ch = new Chess(fen);
    if (ch.isGameOver()) {
      var stm = ch.isCheckmate() ? -10000 : 0;
      var white = ch.turn() === "w" ? stm : -stm;
      cache[key] = white;
      return white;
    }
    if (!window.CCEngine) return null;
    await CCEngine.ready();
    var r = await CCEngine.analyse(fen, { depth: 8, movetime: 220, multipv: 1, priority: "low", skill: 20 });
    var line = r && r.lines && r.lines[0];
    if (!line || !line.score) return null;
    var sc = line.score, stmCp;
    if (sc.type === "mate") {
      var mag = 10000 - Math.min(80, Math.abs(sc.value)) * 10;
      stmCp = sc.value > 0 ? mag : -mag;
    } else stmCp = sc.value;
    var w = fen.split(" ")[1] === "w" ? stmCp : -stmCp;
    cache[key] = w;
    return w;
  }
  function leaksOn() {
    var p = $("tab-leaks");
    return p && p.classList.contains("active");
  }
  async function fillSwings(token) {
    var cache = cpCache();
    var need = state.rows.filter(function (r) { return r.primary && r.primary.avg == null; });
    need.sort(byLeak);
    var n = 0;
    for (var i = 0; i < need.length && n < 12; i++) {
      if (token !== state.token || !leaksOn()) return;
      var row = need[i];
      var sample = row.primary.sample;
      setStatus("Scoring leak " + (n + 1) + " with Stockfish…");
      try {
        var before = await whiteCp(sample.fen, cache);
        if (token !== state.token || !leaksOn()) return;
        var after = await whiteCp(sample.fenAfter, cache);
        if (before == null || after == null) continue;
        var d = after - before;
        var swing = row.side === "white" ? d : -d;
        row.primary.avg = swing;
        row.primary.harm = Math.max(0, -swing);
        row.primary.source = "Stockfish";
        row.primary.swings = [swing];
        n++;
        cpSave(cache);
        state.rows.sort(byLeak);
        var keep = state.selected;
        render();
        state.selected = keep;
      } catch (_) { /* engine busy or down; the list still stands */ }
    }
    cpSave(cache);
    if (token === state.token) {
      state.rows.sort(byLeak);
      render();
      setStatus(statusLine());
    }
  }
  function statusLine() {
    var evals = state.games.filter(function (g) { return g.evals; }).length;
    return state.games.length + " games · " + state.used + " entered your repertoire · "
      + state.outside + " other openings"
      + (evals ? " · " + evals + " with Lichess evals" : "");
  }
  async function run(force) {
    var user = userName();
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(user)) {
      setStatus("Type a Lichess username (letters, numbers, _ or -).");
      return;
    }
    remember(user);
    var max = parseInt(($("leak-max") && $("leak-max").value) || "30", 10);
    if (!(max > 0)) max = 30;
    var token = ++state.token;
    var btn = $("btn-leak-load");
    if (btn) btn.disabled = true;
    setStatus(force ? "Fetching recent games for " + user + "…" : "Loading games…");
    try {
      state.lines = state.lines || await loadLines();
      var games;
      try {
        games = await LichessImport.ensure(user, max, !!force);
      } catch (e) {
        setStatus((e && e.message) || "Could not reach Lichess. Using games already stored.");
        games = await LichessImport.pool(user);
      }
      if (token !== state.token) return;
      state.games = games || [];
      state.user = user;
      var built = buildRows(state.games, state.lines, user);
      state.rows = built.rows;
      state.outside = built.outside;
      state.used = built.used;
      state.selected = null;
      render();
      setStatus(statusLine());
      fillSwings(token);
    } catch (e) {
      setStatus((e && e.message) || "Could not build the leak list.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  var opened = false;
  function boot() {
    if (opened) {
      if (state.rows.length) render();
      return;
    }
    opened = true;
    var el = $("leak-user");
    if (el && !el.value) {
      var saved = "";
      try { saved = localStorage.getItem("cc-lichess-user-v1") || ""; } catch (_) {}
      el.value = saved || "Jetblack007";
    }
    if (!state.board && $("leak-board")) {
      state.board = new Board($("leak-board"), { interactive: false });
    }
    var go = $("btn-leak-load");
    if (go && !go.dataset.bound) {
      go.dataset.bound = "1";
      go.addEventListener("click", function () { run(true); });
      var filters = $("leak-filters");
      if (filters) filters.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest("[data-leak-side]");
        if (!b) return;
        state.filter = b.dataset.leakSide;
        filters.querySelectorAll("[data-leak-side]").forEach(function (n) {
          n.classList.toggle("primary", n === b);
          n.setAttribute("aria-pressed", n === b ? "true" : "false");
        });
        render();
      });
    }
    if (!state.rows.length) run(false);
    else render();
  }
  window.Leaks = { open: boot, refresh: function () { run(true); } };
  if ($("tab-leaks") && $("tab-leaks").classList.contains("active")) boot();
})();
