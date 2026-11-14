/* Progress dashboard. One screen: rapid rating, conversion from +3,
   Finish it (no clock and clocked), puzzle accuracy, opening-drill due
   counts, and plan-trainer accuracy. Week-over-week where the stored
   dates allow it. Charts are inline SVG. */
(function () {
  "use strict";

  var state = { rating: null, user: "", perf: "Rapid" };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return typeof escapeHtml === "function" ? escapeHtml(s) : String(s == null ? "" : s); }
  function utcDay(d) { return (d ? new Date(d) : new Date()).toISOString().slice(0, 10); }
  function addDays(day, n) {
    var x = new Date(day + "T00:00:00Z");
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  }
  function weekStart(day) {
    var x = new Date(day + "T00:00:00Z");
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x.toISOString().slice(0, 10);
  }
  function weeks() {
    var start = weekStart(utcDay());
    return { thisStart: start, thisEnd: addDays(start, 7), prevStart: addDays(start, -7), prevEnd: start };
  }
  function inWeek(iso, start, end) {
    if (!iso) return false;
    var day = String(iso).slice(0, 10);
    return day >= start && day < end;
  }
  function readJSON(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || "");
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }
  function userName() {
    var el = $("dash-user");
    var v = (el && el.value || "").trim();
    if (v) return v;
    try { v = localStorage.getItem("cc-lichess-user-v1") || ""; } catch (_) { v = ""; }
    return v || "Jetblack007";
  }
  function deltaSpan(cur, prev, digits, suffix, words) {
    if (cur == null || prev == null || !isFinite(cur) || !isFinite(prev)) return "";
    var d = cur - prev;
    if (Math.abs(d) < 0.05) return '<span class="dash-delta">no change ' + (words || "vs last week") + "</span>";
    var cls = d > 0 ? "up" : "down";
    var n = Math.abs(d);
    var text = digits ? n.toFixed(digits) : String(Math.round(n));
    return '<span class="dash-delta ' + cls + '">' + (d > 0 ? "+" : "−") + text + (suffix || "") + " " + (words || "vs last week") + "</span>";
  }
  function spark(values, w, h) {
    if (!values || values.length < 2) return "";
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var span = (max - min) || 1;
    var pts = values.map(function (v, i) {
      var x = 2 + (i / (values.length - 1)) * (w - 4);
      var y = (h - 4) - ((v - min) / span) * (h - 10);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var area = "2," + (h - 2) + " " + pts.join(" ") + " " + (w - 2) + "," + (h - 2);
    return '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" role="img">'
      + '<polygon class="spark-area" points="' + area + '"></polygon>'
      + '<polyline points="' + pts.join(" ") + '"></polyline></svg>';
  }
  function big(text) { return '<div class="dash-big">' + text + "</div>"; }

  function pointDay(p) {
    var month = p[1];
    if (month > 11) month -= 1;
    var m = String(month + 1).padStart(2, "0");
    var d = String(p[2]).padStart(2, "0");
    return p[0] + "-" + m + "-" + d;
  }
  function paintRating() {
    var host = $("dash-rating-body");
    if (!host) return;
    var pack = state.rating;
    if (!pack || !pack.categories) {
      host.innerHTML = '<div class="info-line">No rating history yet.</div>';
      return;
    }
    var names = pack.categories.map(function (c) { return c.name; });
    var perf = state.perf;
    if (names.indexOf(perf) < 0) perf = names.indexOf("Rapid") >= 0 ? "Rapid" : (names[0] || "");
    state.perf = perf;
    var cat = null;
    pack.categories.forEach(function (c) { if (c.name === perf) cat = c; });
    var sel = names.map(function (n) {
      return '<option' + (n === perf ? " selected" : "") + ">" + esc(n) + "</option>";
    }).join("");
    if (!cat || !cat.points || cat.points.length < 2) {
      var live = liveRating(pack.profile, perf);
      host.innerHTML = '<select id="dash-perf" aria-label="Rating type">' + sel + "</select>"
        + (live == null ? "" : big(String(live)))
        + '<div class="info-line">Not enough ' + esc(perf) + " points for a line yet.</div>";
      bindPerf();
      return;
    }
    var pts = cat.points.slice(-48);
    var values = pts.map(function (p) { return p[3]; });
    var last = cat.points[cat.points.length - 1];
    var lastDay = pointDay(last);
    var weekAgo = addDays(lastDay, -7);
    var prior = null;
    for (var i = cat.points.length - 1; i >= 0; i--) {
      if (pointDay(cat.points[i]) <= weekAgo) { prior = cat.points[i][3]; break; }
    }
    host.innerHTML = '<div class="dash-head"><select id="dash-perf" aria-label="Rating type">' + sel + "</select>"
      + deltaSpan(last[3], prior, 0, "", cat.synthetic ? "vs a week earlier" : "in 7 days") + "</div>"
      + big(String(last[3]))
      + spark(values, 320, 72)
      + '<div class="info-line">' + esc(pack.username) + " · " + esc(perf) + " · "
      + (cat.synthetic ? "from your games (Lichess rating history is empty)" : "last " + values.length + " points")
      + "</div>";
    bindPerf();
  }
  function bindPerf() {
    var sel = $("dash-perf");
    if (!sel || sel.dataset.bound) return;
    sel.dataset.bound = "1";
    sel.addEventListener("change", function () {
      state.perf = sel.value;
      finishRating(state.dashGames || []);
    });
  }
  var PERF_SPEED = { Rapid: "rapid", Blitz: "blitz", Classical: "classical", Bullet: "bullet", UltraBullet: "ultraBullet", Correspondence: "correspondence" };
  function liveRating(profile, perf) {
    var key = PERF_SPEED[perf] || String(perf || "").toLowerCase();
    var block = profile && profile.perfs && profile.perfs[key];
    return block && typeof block.rating === "number" && !block.prov ? block.rating : null;
  }
  function datePoint(ms, rating) {
    var d = new Date(ms);
    return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), rating];
  }
  function pointsFromGames(games, user, perf) {
    var speed = PERF_SPEED[perf] || "rapid";
    var rows = [];
    (games || []).forEach(function (g) {
      if (!g || !g.createdAt || (g.speed && g.speed !== speed)) return;
      if (g.rated === false) return;
      var side = sideOf(g, user);
      if (!side) return;
      var rating = side === "white" ? g.whiteRating : g.blackRating;
      var diff = side === "white" ? g.whiteDiff : g.blackDiff;
      if (typeof rating !== "number") return;
      rows.push({ at: g.createdAt, rating: rating, after: typeof diff === "number" ? rating + diff : rating });
    });
    rows.sort(function (a, b) { return a.at - b.at; });
    var points = rows.map(function (r) { return datePoint(r.at, r.rating); });
    if (rows.length) points.push(datePoint(rows[rows.length - 1].at + 60000, rows[rows.length - 1].after));
    var live = liveRating(state.profile, perf);
    if (live != null) {
      var now = Date.now();
      var lastAt = rows.length ? rows[rows.length - 1].at : 0;
      if (!rows.length || now - lastAt > 86400000 || points[points.length - 1][3] !== live) {
        points.push(datePoint(now, live));
      }
    }
    return points;
  }
  async function loadRating(user) {
    var host = $("dash-rating-body");
    if (host) host.innerHTML = '<div class="info-line">Loading rating history…</div>';
    state.ratingRaw = [];
    state.profile = null;
    try {
      var r = await fetch("https://lichess.org/api/user/" + encodeURIComponent(user) + "/rating-history", { headers: { Accept: "application/json" } });
      if (r.status === 404) {
        if (host) host.innerHTML = '<div class="info-line">No Lichess user named ' + esc(user) + ".</div>";
        state.missingUser = true;
        return;
      }
      state.missingUser = false;
      if (r.ok) state.ratingRaw = await r.json();
    } catch (_) { /* profile and games can still draw a line */ }
    try {
      var p = await fetch("https://lichess.org/api/user/" + encodeURIComponent(user), { headers: { Accept: "application/json" } });
      if (p.ok) state.profile = await p.json();
    } catch (_) {}
  }
  function finishRating(games) {
    if (state.missingUser) return;
    var user = state.user;
    var cats = (state.ratingRaw || []).filter(function (c) { return c && c.points && c.points.length; }).map(function (c) {
      return { name: c.name, points: c.points };
    });
    var want = state.perf || "Rapid";
    var has = cats.some(function (c) { return c.name === want && c.points.length > 1; });
    if (!has) {
      var built = pointsFromGames(games, user, want);
      if (built.length > 1) {
        cats = cats.filter(function (c) { return c.name !== want; });
        cats.push({ name: want, points: built, synthetic: true });
      }
    }
    state.rating = { username: user, categories: cats, profile: state.profile };
    paintRating();
  }

  function sideOf(g, user) {
    var n = user.toLowerCase();
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
  function conversions(games, user) {
    var rows = [];
    (games || []).forEach(function (g) {
      if (!g.evals) return;
      var side = sideOf(g, user);
      if (!side) return;
      var hit = -1;
      for (var i = 0; i < g.evals.length; i++) {
        var w = g.evals[i];
        if (w == null) continue;
        var u = side === "white" ? w : -w;
        if (u >= 300) { hit = i; break; }
      }
      if (hit < 0) return;
      var o = outcome(g, side);
      if (!o) return;
      var day = g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : "";
      rows.push({ o: o, day: day });
    });
    return rows;
  }
  function tally(rows) {
    var w = 0, d = 0, l = 0;
    rows.forEach(function (r) { if (r.o === "w") w++; else if (r.o === "d") d++; else l++; });
    var n = w + d + l;
    return { n: n, w: w, d: d, l: l, pct: n ? Math.round(100 * w / n) : null };
  }
  function paintConversion(games, user) {
    var host = $("dash-conv-body");
    if (!host) return;
    var rows = conversions(games, user);
    var all = tally(rows);
    if (!all.n) {
      host.innerHTML = big("—") + '<div class="info-line">No game has a saved eval yet. Load games on Opening leaks — Lichess evals are kept with them — and this becomes wins from +3.</div>';
      return;
    }
    var W = weeks();
    var tw = tally(rows.filter(function (r) { return inWeek(r.day, W.thisStart, W.thisEnd); }));
    var pw = tally(rows.filter(function (r) { return inWeek(r.day, W.prevStart, W.prevEnd); }));
    var delta = tw.n && pw.n ? deltaSpan(tw.pct, pw.pct, 0, " pts") : "";
    host.innerHTML = '<div class="dash-head">' + delta + "</div>"
      + big(all.pct + "%")
      + '<div class="info-line">Won from +3 · ' + all.w + "-" + all.d + "-" + all.l + " in " + all.n + " games</div>"
      + '<div class="wdl" title="Wins, draws, losses from +3">'
      + (all.w ? '<span class="wdl-w" style="flex:' + all.w + '"></span>' : "")
      + (all.d ? '<span class="wdl-d" style="flex:' + all.d + '"></span>' : "")
      + (all.l ? '<span class="wdl-l" style="flex:' + all.l + '"></span>' : "")
      + "</div>"
      + '<div class="info-line">This week ' + (tw.n ? tw.w + "/" + tw.n : "—") + " · last week " + (pw.n ? pw.w + "/" + pw.n : "—") + "</div>";
  }

  function paintFinish() {
    var host = $("dash-finish-body");
    if (!host) return;
    var bests = readJSON("cc-finish-best-v1", {});
    var log = readJSON("cc-finish-log-v1", []);
    if (!bests || typeof bests !== "object") bests = {};
    if (!Array.isArray(log)) log = [];
    function fromBests(clocked) {
      var keys = Object.keys(bests).filter(function (k) { return clocked ? /#clk$/.test(k) : !/#clk$/.test(k); });
      var wins = 0;
      keys.forEach(function (k) { if (bests[k] && bests[k].win) wins++; });
      return { n: keys.length, wins: wins };
    }
    var plain = fromBests(false), clock = fromBests(true);
    var W = weeks();
    function attempts(clocked, start, end) {
      return log.filter(function (e) { return !!e.clocked === !!clocked && inWeek(e.at, start, end); });
    }
    function line(label, pack, clocked) {
      var tw = attempts(clocked, W.thisStart, W.thisEnd);
      var pw = attempts(clocked, W.prevStart, W.prevEnd);
      var rate = pack.n ? Math.round(100 * pack.wins / pack.n) + "%" : "—";
      var week = "";
      if (tw.length || pw.length) {
        var twW = tw.filter(function (e) { return e.win; }).length;
        var pwW = pw.filter(function (e) { return e.win; }).length;
        week = '<div class="info-line">This week ' + twW + "/" + tw.length + " · last week " + pwW + "/" + pw.length + "</div>";
      }
      return '<div class="dash-split"><b>' + label + '</b><span class="dash-num">' + rate + "</span></div>"
        + '<div class="info-line">' + pack.wins + " wins in " + pack.n + " positions tried</div>" + week;
    }
    if (!plain.n && !clock.n && !log.length) {
      host.innerHTML = big("—") + '<div class="info-line">No Finish it results yet. They show up here after you play one, with or without the clock.</div>';
      return;
    }
    host.innerHTML = line("No clock", plain, false) + line("Clocked", clock, true);
  }

  function paintPuzzles() {
    var host = $("dash-puzzle-body");
    if (!host) return;
    var hist = readJSON("chesscoach:puzzleHistory", {});
    var ids = hist && typeof hist === "object" ? Object.keys(hist) : [];
    var solved = 0, missed = 0, tried = 0;
    var W = weeks();
    var thisS = 0, prevS = 0;
    ids.forEach(function (id) {
      var h = hist[id] || {};
      if ((h.attempts || 0) > 0 || h.solved || h.failed) tried++;
      if (h.solved) solved++;
      missed += h.failed || 0;
      if (h.solved && inWeek(h.solved_at, W.thisStart, W.thisEnd)) thisS++;
      if (h.solved && inWeek(h.solved_at, W.prevStart, W.prevEnd)) prevS++;
    });
    if (!tried) {
      host.innerHTML = big("—") + '<div class="info-line">No puzzles attempted yet. Tactics records land here.</div>';
      return;
    }
    var pct = Math.round(100 * solved / tried);
    host.innerHTML = '<div class="dash-head">' + deltaSpan(thisS, prevS, 0, "", "solved vs last week") + "</div>"
      + big(pct + "%")
      + '<div class="info-line">' + solved + " solved of " + tried + " tried"
      + (missed ? " · " + missed + " misses" : "") + "</div>"
      + spark(ids.slice(-24).map(function (id) { return hist[id] && hist[id].solved ? 1 : 0; }), 320, 48);
  }

  function dueSR(raw, total) {
    var lines = (raw && raw.lines) || {};
    var ids = Object.keys(lines);
    var today = utcDay();
    var due = 0;
    ids.forEach(function (id) {
      var rec = lines[id];
      if (!rec || !rec.due || rec.due <= today) due++;
    });
    return due + Math.max(0, (total || 0) - ids.length);
  }
  function collectDays(set, iso) {
    if (!iso) return;
    set[String(iso).slice(0, 10)] = 1;
  }
  function streakOf(daySet) {
    var cursor = utcDay();
    if (!daySet[cursor]) cursor = addDays(cursor, -1);
    if (!daySet[cursor]) return 0;
    var n = 0;
    while (daySet[cursor]) { n++; cursor = addDays(cursor, -1); }
    return n;
  }
  async function paintOpenings() {
    var host = $("dash-open-body");
    if (!host) return;
    host.innerHTML = '<div class="info-line">Counting due lines…</div>';
    var rep = { due_count: 0, tried: 0, total_lines: 0, lines: [] };
    try { rep = await apiGet("/api/repertoire-progress"); } catch (_) {}
    var topRaw = readJSON("chesscoach:top10-sr", { lines: {} });
    var alnRaw = readJSON("chesscoach:alapin-drill-sr", { lines: {} });
    var topTotal = 0, alnTotal = 3;
    try {
      var top = await fetch("data/top10.json", { cache: "force-cache" }).then(function (r) { return r.json(); });
      (top.openings || []).forEach(function (op) { topTotal += (op.lines || []).length; });
    } catch (_) { topTotal = 0; }
    try {
      var aln = await fetch("data/alapin-drill.json", { cache: "force-cache" }).then(function (r) { return r.json(); });
      if (aln && aln.lines) alnTotal = aln.lines.length;
    } catch (_) {}
    var topDue = dueSR(topRaw, topTotal);
    var alnDue = dueSR(alnRaw, alnTotal);
    var days = {};
    (rep.lines || []).forEach(function (l) {
      collectDays(days, l.last_at);
      (l.history || []).forEach(function (h) { collectDays(days, h.at); });
    });
    Object.keys((topRaw && topRaw.lines) || {}).forEach(function (id) { collectDays(days, topRaw.lines[id].lastAt); });
    Object.keys((alnRaw && alnRaw.lines) || {}).forEach(function (id) { collectDays(days, alnRaw.lines[id].lastAt); });
    var streak = streakOf(days);
    var W = weeks();
    var drills = [];
    (rep.lines || []).forEach(function (l) {
      var hist = l.history || [];
      if (hist.length) hist.forEach(function (h) { drills.push(h.at); });
      else if (l.last_at) drills.push(l.last_at);
    });
    Object.keys((topRaw && topRaw.lines) || {}).forEach(function (id) { drills.push(topRaw.lines[id].lastAt); });
    Object.keys((alnRaw && alnRaw.lines) || {}).forEach(function (id) { drills.push(alnRaw.lines[id].lastAt); });
    var tw = drills.filter(function (at) { return inWeek(at, W.thisStart, W.thisEnd); }).length;
    var pw = drills.filter(function (at) { return inWeek(at, W.prevStart, W.prevEnd); }).length;
    var due = (rep.due_count || 0) + topDue + alnDue;
    host.innerHTML = '<div class="dash-head">' + deltaSpan(tw, pw, 0, "", "drills vs last week") + "</div>"
      + big(String(due) + " due")
      + '<div class="info-line">Streak ' + streak + (streak === 1 ? " day" : " days")
      + " · repertoire " + (rep.tried || 0) + "/" + (rep.total_lines || 0) + " tried</div>"
      + '<div class="info-line">Book due ' + (rep.due_count || 0)
      + " · wider set " + topDue + " · Alapin drill " + alnDue + "</div>";
  }

  function paintPlans() {
    var host = $("dash-plan-body");
    if (!host) return;
    var log = [];
    if (window.Plans && Plans.log) log = Plans.log();
    else log = readJSON("cc-plan-log-v1", []);
    if (!Array.isArray(log) || !log.length) {
      host.innerHTML = big("—") + '<div class="info-line">No plan-trainer answers yet. They record when you pick a plan.</div>';
      return;
    }
    var ok = log.filter(function (x) { return x.correct; }).length;
    var pct = Math.round(100 * ok / log.length);
    var W = weeks();
    function slice(start, end) { return log.filter(function (x) { return inWeek(x.at, start, end); }); }
    var tw = slice(W.thisStart, W.thisEnd), pw = slice(W.prevStart, W.prevEnd);
    var twP = tw.length ? Math.round(100 * tw.filter(function (x) { return x.correct; }).length / tw.length) : null;
    var pwP = pw.length ? Math.round(100 * pw.filter(function (x) { return x.correct; }).length / pw.length) : null;
    host.innerHTML = '<div class="dash-head">' + (twP != null && pwP != null ? deltaSpan(twP, pwP, 0, " pts") : "") + "</div>"
      + big(pct + "%")
      + '<div class="info-line">' + ok + " of " + log.length + " plans"
      + " · this week " + (tw.length ? tw.filter(function (x) { return x.correct; }).length + "/" + tw.length : "—")
      + " · last week " + (pw.length ? pw.filter(function (x) { return x.correct; }).length + "/" + pw.length : "—") + "</div>"
      + spark(log.slice(-30).map(function (x) { return x.correct ? 1 : 0; }), 320, 48);
  }

  async function boot(forceGames) {
    var user = userName();
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(user)) {
      var note = $("dash-status");
      if (note) note.textContent = "Type a Lichess username.";
      return;
    }
    try { localStorage.setItem("cc-lichess-user-v1", user); } catch (_) {}
    var input = $("dash-user");
    if (input) input.value = user;
    state.user = user;
    paintFinish();
    paintPuzzles();
    paintPlans();
    paintOpenings();
    if (forceGames) { state.ratingRaw = null; state.profile = null; }
    var ratingP = (!state.profile || forceGames) ? loadRating(user) : Promise.resolve();
    var games = [];
    if (window.LichessImport) {
      try {
        games = forceGames ? await LichessImport.ensure(user, 60, true) : await LichessImport.ensure(user, 60, false);
      } catch (_) {
        try { games = await LichessImport.pool(user); } catch (e2) { games = []; }
      }
    }
    try { await ratingP; } catch (_) {}
    state.dashGames = games;
    finishRating(games);
    paintConversion(games, user);
    var st = $("dash-status");
    if (st) st.textContent = games.length ? games.length + " games on this browser." : "No stored games yet.";
  }
  function bind() {
    var go = $("btn-dash-load");
    if (go && !go.dataset.bound) {
      go.dataset.bound = "1";
      go.addEventListener("click", function () { state.rating = null; boot(true); });
    }
    var input = $("dash-user");
    if (input && !input.value) {
      var saved = "";
      try { saved = localStorage.getItem("cc-lichess-user-v1") || ""; } catch (_) {}
      input.value = saved || "Jetblack007";
    }
  }
  window.Dash = { open: function () { bind(); boot(false); } };
  if ($("tab-dash") && $("tab-dash").classList.contains("active")) window.Dash.open();
})();
