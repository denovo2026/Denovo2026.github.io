/* Shared by the Modern / Grünfeld / Attacks tabs: hand a position to the
   Play & Analyze board the same way "Load FEN" does — end any game review or
   rehearsal run first so the board is free for analysis. */
function sendFenToPlay(fen, orientation, message) {
  if (typeof Review !== "undefined" && Review.active) exitReview();
  if (typeof Rehearsal !== "undefined" && Rehearsal.active) rehearsalExit();
  switchTab("play");
  playResetTo(fen);
  playBoard.setOrientation(orientation);
  $("play-fen-input").value = fen;
  $("play-fen-status").textContent = message;
  try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (_) { /* */ }
}

/* =======================================================================
   OPENING REPERTOIRE TABS (V13)

   One implementation, one tab per opening. A repertoire is organised by
   what the OPPONENT does, because that is how it arrives: you never
   choose which line you are in, you recognise it from the move just
   played and pick the plan that goes with it. So the unit is a "look" —
   the tell, their idea, your plan, the strategy, and the tactics that
   actually decide it.

   Three modes on the same board. STEP walks the line with the nav
   buttons. QUIZ plays their moves and makes you find yours. BLIND does
   the same without saying which set-up you are in, so you have to read
   the tell off the board — and that is the skill the page exists for.

   createRepertoireTab({slug, prefix}) wires one tab. Every element id is
   `${prefix}-...`, so the markup for a new opening is a copy of the
   section with the prefix changed and nothing else.
   ======================================================================= */

function createRepertoireTab(cfg) {
  const P = cfg.prefix;
  const API = "/api/repertoire/" + cfg.slug;

  const S = {
    data: null,        // the overview payload
    look: null,        // the selected look, in full
    ply: 0,            // plies shown on the board
    quiz: false,
    score: { asked: 0, right: 0 },
    busy: false,
    branch: null,      // a tactic being shown instead of the main line

    // the blind drill: White plays one of the set-ups without saying which
    blind: false,
    revealed: true,    // true whenever the identity is on show
    toldYou: false,    // did a wrong move force the answer out?
    lastBlindId: null, // so two runs in a row are not the same line

    // v41: memory
    first: {},         // ply index -> first try right? (this run)
    transposed: 0,
    progress: {},      // look id -> saved result (first tries, due date)
    posIndex: null,    // position key -> look name, for transpositions
  };

  const repBoard = new Board($(P + "-board"), { onMove: onRepMove });
  // The whole tab is Black's view of the opening, so the board never flips.
  repBoard.setOrientation("black");

  function repPlies() {
    return (S.branch || S.look || {}).plies || [];
  }

  function repFenAt(ply) {
    const plies = repPlies();
    return ply === 0 ? PLAY_START_FEN : plies[ply - 1].fen;
  }

  function repSetStatus(msg, kind) {
    const el = $(P + "-status");
    el.textContent = msg || "";
    el.className = "info-line" + (kind ? " " + kind : "");
  }

  /* ---- stepping the line ---------------------------------------------- */

  function repGoToPly(n) {
    const plies = repPlies();
    S.ply = Math.max(0, Math.min(plies.length, n));
    repBoard.setFen(repFenAt(S.ply));
    const last = S.ply > 0 ? plies[S.ply - 1] : null;
    repBoard.setLastMove(last ? last.uci.slice(0, 2) : null,
                            last ? last.uci.slice(2, 4) : null);
    renderRepMoves();
    repNav.update({
      start: S.ply > 0, prev: S.ply > 0,
      next: S.ply < plies.length, end: S.ply < plies.length,
    });
  }

  const repNav = createNavControls(P + "-nav", {
    isActive: () => $("tab-" + P).classList.contains("active"),
    onNav: (dir) => {
      if (S.quiz) return;          // stepping would give the answer away
      const n = repPlies().length;
      if (dir === "start") repGoToPly(0);
      else if (dir === "prev") repGoToPly(S.ply - 1);
      else if (dir === "next") repGoToPly(S.ply + 1);
      else repGoToPly(n);
    },
  });

  function renderRepMoves() {
    const host = $(P + "-movebar");
    const plies = repPlies();
    host.innerHTML = "";
    for (let i = 0; i < plies.length; i++) {
      const p = plies[i];
      const span = document.createElement("span");
      const hidden = S.quiz && i >= S.ply;
      span.className = "rep-move " + p.side
        + (i < S.ply ? " played" : "");
      span.textContent = (i % 2 === 0 ? (i / 2 + 1) + "." : "")
        + (hidden ? "…" : p.san);
      if (!S.quiz) {
        span.addEventListener("click", () => repGoToPly(i + 1));
      }
      host.appendChild(span);
    }
  }

  /* ---- the quiz -------------------------------------------------------
     White's moves play themselves; every Black move is asked. A wrong
     answer is taken back rather than accepted, because the point is to
     leave knowing the line, not to collect a score. */

  function repStartQuiz() {
    if (!S.look) { repSetStatus("Pick a set-up first.", "warn"); return; }
    S.branch = null;
    S.quiz = true;
    S.score = { asked: 0, right: 0 };
    S.first = {}; S.transposed = 0;
    S.ply = 0;
    $(P + "-score").classList.remove("hidden");
    $("btn-" + P + "-quiz").textContent = "Stop the quiz";
    repGoToPly(0);
    renderRepScore();
    repAdvanceWhite();
  }

  /* ---- the blind drill -------------------------------------------------
     The same quiz with the label taken off. White plays one of the set-ups
     at random and never says which; you have to read the tell off the board
     and answer it with the right move. Nobody is asked to name anything —
     playing the right move IS recognising it.

     Get one wrong and the answer comes out: the set-up is named, its tell
     is quoted, and the plans appear, because at that point you have found
     the edge of what you know and guessing again teaches nothing.

     It is a fair question because no two lines part company on a Black
     move; whenever Black's answers differ, White has already shown you
     something different. There is a test that keeps it that way. */

  function repPickBlind() {
    const ids = S.data.looks.map(l => l.id)
      .filter(id => id !== S.lastBlindId || S.data.looks.length < 2);
    return ids[Math.floor(Math.random() * ids.length)];
  }

  async function repStartBlindQuiz() {
    const id = repPickBlind();
    repSetStatus("Dealing a set-up…");
    let look;
    try {
      look = await apiGet(API + "/" + id);
    } catch (e) {
      repSetStatus("Could not start it: " + e.message, "warn");
      return;
    }
    S.look = look;
    S.lastBlindId = id;
    S.blind = true;
    S.revealed = false;
    S.toldYou = false;
    $(P + "-label").textContent =
      "Unknown set-up — read what White plays and answer it.";
    $(P + "-look-name").textContent = "Which set-up is this?";
    $(P + "-detail").innerHTML =
      '<p class="info-line">Hidden. White is playing one of the ' + S.data.looks.length + ' set-ups and '
      + "will not say which — the fourth move usually gives the plan away. "
      + "Answer it with the right move and it stays hidden; get one wrong "
      + "and you will be told which it was.</p>";
    renderRepLooks();
    repStartQuiz();
  }

  function repReveal() {
    S.revealed = true;
    $(P + "-label").textContent =
      S.look.name + " — " + S.look.line_san;
    renderRepDetail(S.look);
    renderRepLooks();
  }

  function repStopQuiz(message) {
    S.quiz = false;
    $("btn-" + P + "-quiz").textContent = "Quiz me on Black's moves";
    repSetStatus(message || "");
    renderRepMoves();
    repGoToPly(S.ply);
  }

  function repAdvanceWhite() {
    const plies = repPlies();
    while (S.ply < plies.length && plies[S.ply].side === "white") {
      S.ply++;
    }
    repGoToPly(S.ply);
    if (S.ply >= plies.length) {
      const s = S.score;
      const rec = S.branch ? null : repRecordResult();
      let msg = "Line complete — " + s.right + " of " + s.asked + " found."
        + (rec ? " First tries " + rec.right + "/" + rec.total + (rec.next ? " · next drill " + rec.next : "") + "." : "");
      if (S.blind) {
        if (!S.revealed) repReveal();
        msg += S.toldYou
          ? " It was " + S.look.name + " — run another and see if the "
            + "tell lands sooner."
          : " Straight through without being told, against " + S.look.name
            + ". That is the drill.";
      } else {
        msg += " Step back through it and read the plans again.";
      }
      repStopQuiz(msg);
      return;
    }
    const n = Math.floor(S.ply / 2) + 1;
    repSetStatus("Black to play, move " + n
      + ". Make the move on the board.");
  }

  async function onRepMove(from, to) {
    if (!S.quiz || S.busy) return;
    const plies = repPlies();
    const want = plies[S.ply];
    if (!want || want.side !== "black") return;
    S.busy = true;
    try {
      const guess = uciCandidate(repBoard, from, to);
      S.score.asked++;
      ccLogAnswer("openings", "repertoire");
      const tr = guess === want.uci ? null : await repTransposition(guess, plies);
      if (!(S.ply in S.first)) S.first[S.ply] = guess === want.uci || !!tr;
      if (tr) {
        S.score.right++; S.transposed++;
        renderRepScore();
        S.ply++;
        repGoToPly(S.ply);
        const msg = "Fine — that transposes" + (tr.to ? " to " + tr.to : "") + ". The book order here is "
          + want.san + "; carrying on with the book move.";
        repAdvanceWhite();
        if (S.quiz) repSetStatus(msg + " " + $(P + "-status").textContent, "good");
      } else if (guess === want.uci) {
        S.score.right++;
        renderRepScore();
        S.ply++;
        repGoToPly(S.ply);
        repSetStatus(want.san + " — that's the move.", "good");
        repAdvanceWhite();
      } else {
        renderRepScore();
        // put the position back: a wrong move left on the board teaches
        // the wrong picture, and the next prompt would make no sense
        repGoToPly(S.ply);
        if (S.blind && !S.revealed) {
          // You have hit the edge of what you can read. Guessing again with
          // nothing new to go on is not practice, so the answer comes out.
          S.toldYou = true;
          repReveal();
          repSetStatus("Not the move. White is playing " + S.look.name
            + " — the tell was: " + S.look.tell
            + " The plans are on the right now; find Black's answer.", "warn");
        } else {
          repSetStatus("Not the book move here. Read the plan on the right "
                          + "and try again — or stop the quiz to see it.", "warn");
        }
      }
    } finally {
      S.busy = false;
    }
  }

  /* ---- v41: memory, transpositions, spaced repetition ----------------- */
  const posKey = (fen) => fen.split(" ").slice(0, 3).join(" ");
  async function repPositionIndex() {
    if (S.posIndex) return S.posIndex;
    const idx = {};
    for (const l of (S.data ? S.data.looks : [])) {
      try {
        const full = l.id === (S.look && S.look.id) ? S.look : await apiGet(API + "/" + l.id);
        (full.plies || []).forEach(p => { if (p.side === "black" && !idx[posKey(p.fen)]) idx[posKey(p.fen)] = full.name; });
      } catch (_) { /* skip */ }
    }
    S.posIndex = idx;
    return idx;
  }
  function playUci(ch, uci) {
    try { return ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); } catch (_) { return null; }
  }
  /* a different move is still fine when it reaches a book position: either a
     known position of this repertoire, or the same position as the book after
     Black's next two moves are swapped (…d6 before …Bg7 and so on) */
  async function repTransposition(guess, plies) {
    if (!guess || typeof Chess === "undefined") return null;
    const here = repFenAt(S.ply);
    const ch = new Chess(here);
    if (!playUci(ch, guess)) return null;
    const after = posKey(ch.fen());
    const nextBlack = plies[S.ply + 2];
    if (nextBlack && nextBlack.side === "black" && guess === nextBlack.uci) {
      const sw = new Chess(here);
      if (playUci(sw, guess) && playUci(sw, plies[S.ply + 1].uci) && playUci(sw, plies[S.ply].uci)
          && posKey(sw.fen()) === posKey(nextBlack.fen)) return { to: null };
    }
    const idx = await repPositionIndex();
    if (idx[after]) return { to: idx[after] === S.look.name ? null : idx[after] };
    return null;
  }
  function repRecordResult() {
    const keys = Object.keys(S.first);
    if (!keys.length || !S.look) return null;
    const right = keys.filter(k => S.first[k]).length, total = keys.length;
    const missed = keys.filter(k => !S.first[k]).map(k => repPlies()[k] && repPlies()[k].san).filter(Boolean);
    const out = { right, total, next: right === total ? "later" : "tomorrow" };
    fetch(API.replace(/^\//, "") + "/" + S.look.id + "/result", { method: "POST",
      body: JSON.stringify({ right, total, missed, transposed: S.transposed, blind: S.blind, name: S.look.name }) })
      .then(r => r.json()).then(p => { if (p && p.id) { S.progress[p.id] = p; renderRepLooks(); } })
      .catch(() => {});
    return out;
  }
  async function repLoadProgress() {
    try {
      const r = await apiGet("/api/repertoire-progress?slug=" + cfg.slug);
      S.progress = {};
      (r.lines || []).forEach(l => { S.progress[l.id] = l; });
    } catch (_) { /* no memory yet */ }
  }
  function repDueText(p) {
    if (!p) return "New";
    const days = repDaysUntil(p.due);
    const when = days <= 0 ? "due now" : days === 1 ? "due tomorrow" : "in " + days + " days";
    return (p.last_right === p.last_total ? "✓ " : "") + p.last_right + "/" + p.last_total + " · " + when;
  }
  /* missed lines first, then lines never tried, then the most overdue */
  async function repDrillDue() {
    // the tab may still be loading its first set-up — let that land first
    for (let i = 0; i < 60 && !(S.data && S.look); i++) await new Promise(r => setTimeout(r, 100));
    if (!S.data) return;
    await repLoadProgress();
    const now = Date.now();
    const looks = S.data.looks.map(l => ({ l, p: S.progress[l.id] }));
    const rank = (x) => !x.p ? 1 : (Date.parse(x.p.due) <= now ? (x.p.last_right < x.p.last_total ? 0 : 2) : 3);
    looks.sort((a, b) => rank(a) - rank(b) || (a.p && b.p ? Date.parse(a.p.due) - Date.parse(b.p.due) : 0));
    const pick = looks[0];
    await loadRepLook(pick.l.id);
    repStartQuiz();
    repSetStatus((rank(pick) === 0 ? "You missed this one last time — " : rank(pick) === 1 ? "A line you have not drilled yet — "
      : rank(pick) === 2 ? "Due for review — " : "Nothing is due; drilling your weakest line — ")
      + pick.l.name + ". Black to play.");
  }
  function repPlayThePlan() {
    if (!S.look) return;
    if (S.quiz) repStopQuiz("");
    const plies = S.look.plies || [];
    const fen = plies.length ? plies[plies.length - 1].fen : PLAY_START_FEN;
    if (typeof startPracticeFrom === "function") {
      startPracticeFrom(fen, S.data.side || "black");
      const plan = (S.look.plans || [])[0];
      if (plan) $("rehearsal-banner").textContent = S.look.name + " — play the plan against the engine at your level. " + plan;
    } else {
      sendFenToPlay(fen, S.data.side || "black", "Final position of " + S.look.name + ".");
    }
  }

  function renderRepScore() {
    const s = S.score;
    const pct = s.asked ? Math.round((100 * s.right) / s.asked) : 0;
    $(P + "-score").innerHTML =
      '<span class="calc-score-big">' + s.right + "</span>"
      + '<span class="calc-score-unit">of ' + s.asked + " first tries</span>"
      + '<span class="calc-score-sub">' + pct + "% straight away</span>";
  }

  /* ---- the panels ------------------------------------------------------ */

  function renderRepLooks() {
    const host = $(P + "-looks");
    // The strip stays a plain selector for deliberate study. Naming a hidden
    // set-up happens down by the board, where the drill is.
    const guessing = S.blind && !S.revealed;
    host.innerHTML = "";
    for (const look of S.data.looks) {
      // nothing is "selected" while the identity is still hidden
      const chosen = !guessing
        && Boolean(S.look && S.look.id === look.id);
      const card = document.createElement("button");
      card.className = "rep-look" + (chosen ? " active" : "");
      // they behave as one exclusive choice, so say so rather than leaving
      // seven buttons that look pressed for no announced reason
      card.setAttribute("aria-pressed", chosen ? "true" : "false");
      // The move list is not repeated on the card — it is long, it makes the
      // row unreadable, and the board's own label carries it.
      card.innerHTML =
        '<span class="ml-head"><strong>' + escapeHtml(look.name) + "</strong>"
        + '<span class="chip">' + escapeHtml(look.frequency) + "</span></span>"
        + '<span class="ml-tell">' + escapeHtml(look.tell) + "</span>"
        + (guessing ? "" : '<span class="rep-mem ' + (!S.progress[look.id] ? "new" : S.progress[look.id].last_right === S.progress[look.id].last_total ? "ok" : "miss") + '">'
          + escapeHtml(repDueText(S.progress[look.id])) + "</span>");
      card.title = look.line_san;
      card.addEventListener("click", () => loadRepLook(look.id));
      host.appendChild(card);
    }
  }

  function repList(items, cls) {
    if (!items || !items.length) return "";
    return '<ul class="' + (cls || "struct-plans") + '">'
      + items.map(x => "<li>" + escapeHtml(x) + "</li>").join("") + "</ul>";
  }

  function renderRepDetail(look) {
    $(P + "-look-name").textContent = look.name;
    let html = '<div class="struct-head">'
      + '<span class="chip verified">' + escapeHtml(look.frequency) + "</span>"
      + '<span class="chip">' + escapeHtml(look.eco || (S.data && S.data.eco) || "") + "</span>"
      + "</div>";

    html += "<h4 class='sub-head'>The tell</h4>"
      + '<div class="coach-box">' + escapeHtml(look.tell) + "</div>";
    html += "<h4 class='sub-head'>What White wants</h4>"
      + '<div class="info-line">' + escapeHtml(look.white_idea) + "</div>";
    html += "<h4 class='sub-head'>Your plan</h4>" + repList(look.plans);
    html += "<h4 class='sub-head'>Playing it strategically</h4>"
      + repList(look.strategic);

    if (look.tactics && look.tactics.length) {
      html += "<h4 class='sub-head'>The tactics that decide it</h4>";
      for (let i = 0; i < look.tactics.length; i++) {
        const t = look.tactics[i];
        html += '<div class="rep-tactic">'
          + '<div class="mt-head"><strong>' + escapeHtml(t.name) + "</strong>"
          + '<button class="btn mt-show" data-tactic="' + i + '">Show it</button>'
          + "</div>"
          + '<div class="mt-line">' + escapeHtml(t.line_san) + "</div>"
          + "<div>" + escapeHtml(t.point) + "</div></div>";
      }
    }
    const oly = repOlympiadLink(cfg.slug, look.id);
    if (oly) {
      html += '<div class="rep-oly"><a class="btn mini" href="' + oly.href + '" target="_blank" rel="noopener">'
        + escapeHtml(oly.label) + " &#x2197;</a></div>";
    }
    if (look.watch) {
      html += "<h4 class='sub-head'>What goes wrong</h4>"
        + '<div class="coach-box warn-box">' + escapeHtml(look.watch) + "</div>";
    }
    $(P + "-detail").innerHTML = html;

    $(P + "-detail").querySelectorAll(".mt-show").forEach(btn => {
      btn.addEventListener("click", () =>
        showRepTactic(Number(btn.dataset.tactic)));
    });
  }

  function showRepTactic(i) {
    const t = (S.look.tactics || [])[i];
    if (!t) return;
    if (S.quiz) repStopQuiz("");
    S.branch = t;
    $(P + "-label").textContent = S.look.name + " — " + t.name;
    repGoToPly(t.plies.length);
    repSetStatus("Showing the tactic. Press Back to step through it, or "
                    + "pick the set-up again for the main line.");
  }

  async function loadRepLook(id) {
    repSetStatus("Loading…");
    try {
      const look = await apiGet(API + "/" + id);
      S.look = look;
      S.branch = null;
      S.quiz = false;
      S.blind = false;
      S.revealed = true;
      $("btn-" + P + "-quiz").textContent = "Quiz me on Black's moves";
      $(P + "-score").classList.add("hidden");
      $(P + "-label").textContent = look.name + " — " + look.line_san;
      renderRepLooks();
      renderRepDetail(look);
      repGoToPly(0);
      repSetStatus("Step through it, or take the quiz.");
    } catch (e) {
      repSetStatus("Could not load that set-up: " + e.message, "warn");
    }
  }

  /* ---- wiring ---------------------------------------------------------- */

  $("btn-" + P + "-quiz").addEventListener("click", () => {
    if (S.quiz) {
      // stopping gives up on naming it, so show what it was
      if (S.blind && !S.revealed) repReveal();
      const was = S.blind ? " It was " + S.look.name + "." : "";
      repStopQuiz("Quiz stopped." + was);
      S.blind = false;
    } else {
      S.blind = false;
      S.revealed = true;
      renderRepLooks();
      repStartQuiz();
    }
  });

  $("btn-" + P + "-blind").addEventListener("click", repStartBlindQuiz);
  $("btn-" + P + "-due").addEventListener("click", repDrillDue);
  $("btn-" + P + "-plan").addEventListener("click", repPlayThePlan);


  $("btn-" + P + "-play").addEventListener("click", () => {
    if (!S.data) return;
    if (S.quiz) repStopQuiz("");
    const fen = repFenAt(S.ply);
    sendFenToPlay(fen, S.data.side || "black",
      "Loaded from the " + S.data.name + " tab — you are "
      + (S.data.side === "white" ? "White" : "Black") + ".");
  });

  let repInitDone = false;
  async function initRep() {
    if (repInitDone) return;
    repInitDone = true;
    try {
      S.data = await apiGet(API);
    } catch (e) {
      $(P + "-looks").innerHTML =
        '<div class="info-line">Repertoire unavailable: '
        + escapeHtml(e.message) + "</div>";
      return;
    }
    $(P + "-title").textContent = S.data.name;
    $(P + "-summary").textContent = S.data.summary;
    $(P + "-scheme").innerHTML = repList(S.data.scheme);
    $(P + "-reading").innerHTML = repList(S.data.reading);
    if (S.data.coach_note) {
      const box = $(P + "-coach");
      box.textContent = S.data.coach_note;
      box.classList.remove("hidden");
    }
    await repLoadProgress();
    renderRepLooks();
    if (S.data.looks.length) loadRepLook(S.data.looks[0].id);
  }


  return { init: initRep, state: S, drillDue: repDrillDue, loadProgress: repLoadProgress };
}

/* The Modern Defense and Grünfeld Defense tabs — one implementation, two data sets. */
const ModernTab = createRepertoireTab({ slug: "modern", prefix: "modern" });
const initModern = () => ModernTab.init();
const GrunfeldTab = createRepertoireTab({ slug: "grunfeld", prefix: "grunfeld" });
const initGrunfeld = () => GrunfeldTab.init();

/* v40: count a training day only after a real answer on this trainer */
function ccLogAnswer(pillar, kind) {
  try { fetch("api/activity/answer", { method: "POST", body: JSON.stringify({ pillar: pillar, kind: kind }) }); } catch (_) {}
}

/* v41: each set-up -> the Olympiad games that reached it (URL filter) */
const REP_OLYMPIAD = {
  modern: { fam: "Modern", q: { "150-attack": "150 attack", austrian: "austrian", "classical-quiet": "classical" } },
  grunfeld: { fam: "Grünfeld", q: { "exchange-classical": "exchange", "exchange-modern": "exchange", fianchetto: "fianchetto",
    russian: "vs. system", bf4: "vs. system", bg5: "vs. system" } },
};
function repOlympiadLink(slug, id) {
  const m = REP_OLYMPIAD[slug];
  if (!m) return null;
  const q = m.q[id];
  const href = "./olympiad/?fam=" + encodeURIComponent(m.fam) + (q ? "&q=" + encodeURIComponent(q) : "") + "#games";
  return { href, label: q ? "Olympiad games with this set-up" : "All Olympiad " + m.fam + " games" };
}

/* whole calendar days from today to an ISO date (0 = today or overdue) */
function repDaysUntil(iso) {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(iso); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}
