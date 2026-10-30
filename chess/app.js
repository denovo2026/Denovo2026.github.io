/* app.js — Chess Coach AI frontend: tabs, API calls, state.
   All move legality is validated by the backend (/api/move); the client
   never generates moves. */

"use strict";

/* ================= API helpers ================= */

function apiError(r, data) {
  const detail = typeof data.detail === "string" ? data.detail : null;
  const err = new Error(detail || ("HTTP " + r.status));
  err.status = r.status;
  err.detail = data.detail;
  return err;
}

async function apiGet(path) {
  const r = await fetch(path);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw apiError(r, data);
  return data;
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw apiError(r, data);
  return data;
}

function showError(msg) {
  const b = document.getElementById("error-banner");
  if (!msg) { b.classList.add("hidden"); return; }
  b.textContent = msg;
  b.classList.remove("hidden");
  clearTimeout(showError._t);
  showError._t = setTimeout(() => b.classList.add("hidden"), 6000);
}

const $ = (id) => document.getElementById(id);

/* ================= engine health / error surfacing ================= */

function setEngineBanner(msg, tone) {
  const b = $("engine-banner");
  if (!msg) { b.classList.add("hidden"); return; }
  b.textContent = msg;
  b.classList.remove("amber", "red");
  b.classList.add(tone === "red" ? "red" : "amber");
  b.classList.remove("hidden");
}

/* red: nothing can serve analysis at all */
function engineUnavailableText(engineError) {
  return "Engine unavailable — " + (engineError || "no engine found") +
    ". The in-browser engine failed to load — try refreshing the page.";
}

/* amber/info: local engine broken but cloud analysis still works */
function cloudFallbackText(engineError) {
  return "Local engine unusable (" + (engineError || "unknown") +
    ") — using online analysis. Refresh the page to retry the in-browser engine.";
}

/* health dot + "(online)" badge in the header */
function updateHealthDot(provider, engineError) {
  const dot = $("health-dot");
  const badge = $("health-badge");
  dot.classList.remove("ok", "cloud", "down");
  if (provider === "local") {
    dot.classList.add("ok");
    dot.title = "Engine: local Stockfish";
    badge.classList.add("hidden");
  } else if (provider === "cloud") {
    dot.classList.add("cloud");
    dot.title = "Engine: online fallback (lichess cloud)";
    badge.classList.remove("hidden");
  } else {
    dot.classList.add("down");
    dot.title = "Engine: unavailable — " + (engineError || "no engine found");
    badge.classList.add("hidden");
  }
}

/* apply a /api/health response to banner + dot + state */
function updateHealthUI(h) {
  State.engineOk = !!h.engine;
  const provider = h.engine_provider || (h.engine ? "local" : null);
  updateHealthDot(provider, h.engine_error);
  if (provider === "cloud") {
    /* local engine unusable but analysis still works via the cloud —
       informational amber banner, not an error */
    setEngineBanner(cloudFallbackText(h.engine_error), "amber");
  } else if (!provider) {
    setEngineBanner(engineUnavailableText(h.engine_error), "red");
  } else {
    setEngineBanner(null);
  }
}

function isEngineUnavailableError(e) {
  if (!e || e.status !== 503) return false;
  const d = typeof e.detail === "string" ? e.detail : e.message;
  return String(d).indexOf("engine_unavailable") !== -1;
}

/* call in the catch of any engine endpoint; returns true when it was a
   503 engine_unavailable (banner + health dot are refreshed via /api/health) */
async function surfaceEngineError(e) {
  if (!isEngineUnavailableError(e)) return false;
  State.engineOk = false;
  try {
    const h = await apiGet("/api/health");
    updateHealthUI(h);
  } catch (_) {
    updateHealthDot(null, null);
    setEngineBanner(engineUnavailableText(null), "red");
  }
  return true;
}

/* ================= eval / formatting helpers ================= */

function evalText(ev) {
  if (!ev) return "–";
  if (typeof ev === "string") return ev;  // terminal payload: "mate" | "draw"
  if (ev.type === "mate" && ev.value === 0) return "#"; // game already over
  if (ev.type === "mate") return (ev.value > 0 ? "M" : "-M") + Math.abs(ev.value);
  const v = ev.value / 100;
  return (v > 0 ? "+" : "") + v.toFixed(2);
}

/* v40: side-to-move eval → White's view (matches the eval bar) */
function whitePovEval(ev, side) {
  return (ev && typeof ev === "object" && side === "b" && typeof ev.value === "number")
    ? Object.assign({}, ev, { value: -ev.value }) : ev;
}

/* eval is from side-to-move POV → white-win percentage for the bar */
function evalToWhitePct(ev, sideToMove) {
  if (!ev) return 50;
  if (typeof ev === "string") return 50;  // terminal payload: bar set by result
  let cp;
  if (ev.type === "mate") cp = (ev.value > 0 ? 1 : -1) * 10000;
  else cp = ev.value;
  const whiteCp = sideToMove === "w" ? cp : -cp;
  return 100 / (1 + Math.exp(-0.004 * whiteCp));
}

function classifyCpl(cpl) {
  if (cpl <= 10) return "best";
  if (cpl <= 40) return "good";
  if (cpl <= 100) return "inaccuracy";
  if (cpl <= 250) return "mistake";
  return "blunder";
}

/* ================= FEN utilities (no move generation) ================= */

function fenToPosition(fen) {
  const pos = {};
  const rows = fen.split(" ")[0].split("/");
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) f += parseInt(ch, 10);
      else {
        pos[FILES[f] + (8 - r)] = (ch === ch.toUpperCase() ? "w" : "b") + ch.toUpperCase();
        f++;
      }
    }
  }
  return pos;
}

function fenSide(fen) { return (fen.split(" ")[1] || "w"); }

/* toggle side to move (null move), clear en-passant */
function fenFlippedSide(fen) {
  const p = fen.split(" ");
  while (p.length < 6) p.push(p.length === 3 ? "-" : "0");
  p[1] = p[1] === "w" ? "b" : "w";
  p[3] = "-";
  return p.join(" ");
}

function fenLooksValid(fen) {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) return false;
  const rows = parts[0].split("/");
  if (rows.length !== 8) return false;
  return rows.every(r => {
    let n = 0;
    for (const ch of r) n += /\d/.test(ch) ? parseInt(ch, 10) : 1;
    return n === 8;
  });
}

/* ================= SAN → UCI resolver =================
   Parses a SAN string into piece/destination/disambiguation, enumerates the
   handful of candidate origin squares, and asks /api/move which is legal.
   This is candidate validation (sanctioned), not move generation. */

async function resolveSan(fen, san) {
  let s = san.trim().replace(/[!?+#]+$/, "").replace(/^\d+\.(\.\.)?/, "");
  const pos = fenToPosition(fen);
  const side = fenSide(fen);

  if (s === "O-O" || s === "O-O-O") {
    const rank = side === "w" ? "1" : "8";
    const uci = "e" + rank + (s === "O-O" ? "g" : "c") + rank;
    try {
      const r = await apiPost("/api/move", { fen, move_uci: uci });
      if (r.legal) return { uci, result: r };
    } catch (e) { /* fall through */ }
    return null;
  }

  let promotion = "";
  const pm = s.match(/=([QRBN])$/);
  if (pm) { promotion = pm[1].toLowerCase(); s = s.slice(0, pm.index); }

  let piece = "P";
  if (/^[KQRBN]/.test(s)) { piece = s[0]; s = s.slice(1); }
  s = s.replace("x", "");

  const dm = s.match(/([a-h]?)([1-8]?)([a-h][1-8])$/);
  if (!dm) return null;
  const disFile = dm[1], disRank = dm[2], dest = dm[3];

  const candidates = [];
  for (const sq in pos) {
    if (pos[sq] === side + piece) {
      if (disFile && sq[0] !== disFile) continue;
      if (disRank && sq[1] !== disRank) continue;
      candidates.push(sq);
    }
  }
  for (const from of candidates) {
    const uci = from + dest + promotion;
    try {
      const r = await apiPost("/api/move", { fen, move_uci: uci });
      if (r.legal && (!r.san || r.san.replace(/[!?]+$/, "") === san.trim().replace(/[!?]+$/, "") || candidates.length === 1)) {
        return { uci, result: r };
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

/* ================= PGN parsing (text only) ================= */

function parsePgn(pgn) {
  const headers = {};
  const headerRe = /\[([A-Za-z0-9_]+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = headerRe.exec(pgn)) !== null) headers[m[1]] = m[2];
  let body = pgn.replace(headerRe, " ");
  body = body.replace(/\{[^}]*\}/g, " ");           // comments
  body = body.replace(/\$\d+/g, " ");                // NAGs
  let depth = 0, cleaned = "";                        // strip variations
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) cleaned += ch;
  }
  const tokens = cleaned.split(/\s+/).filter(t =>
    t && !/^\d+\.(\.\.)?$/.test(t) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
  return {
    headers,
    sans: tokens,
    startFen: headers.FEN || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  };
}

/* ================= tab switching ================= */

/* v43: five sections (Today / Play / Train / Openings / Study), each with its own sub-tabs */
const TAB_GROUPS = {
  today: ["plan", "progress"],
  play: ["play", "lab", "games"],
  train: ["deck", "puzzles", "cycles", "sparring", "endgames", "attacks", "calc"],
  openings: ["top10", "modern", "scotch", "alapin", "alapin-drill", "grunfeld"],
  study: ["masters", "learn"],
};
function tabGroupOf(name) {
  for (const g in TAB_GROUPS) if (TAB_GROUPS[g].includes(name)) return g;
  return "play";
}
function showTabGroup(g) {
  document.querySelectorAll(".grp-btn").forEach(b => {
    const on = b.dataset.group === g;
    b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("#tab-subs [data-group]").forEach(b => b.classList.toggle("in-group", b.dataset.group === g));
}
function switchTab(name) {
  const grp = tabGroupOf(name);
  showTabGroup(grp);
  try { localStorage.setItem("cc-last-tab-" + grp, name); localStorage.setItem("cc-last-tab", name); } catch (_) { /* */ }
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "plan") initPlan();
  if (name === "learn") initLearn();
  if (name === "lab") initLab();
  if (name === "puzzles") { refreshFlashcards(); refreshPuzzleLibraryInfo(); }
  if (name === "cycles") initCycles();
  if (name === "sparring") initSparring();
  if (name === "endgames") initEndgames();
  if (name === "masters") initMasters();
  if (name === "progress") { initProgress(); if (typeof renderProgressOpenings === "function") renderProgressOpenings(); }
  if (name === "games" && typeof loadLibrary === "function" && !Games.list.length) loadLibrary();
  if (name === "calc" && typeof initCalc === "function") initCalc();
  if (name === "deck" && typeof initDeck === "function") initDeck();
  if (name === "top10" && typeof initTop10 === "function") initTop10();
  if (name === "modern" && typeof initModern === "function") initModern();
  if (name === "scotch" && typeof initScotch === "function") initScotch();
  if (name === "alapin" && typeof initAlapin === "function") initAlapin();
  if (name === "alapin-drill" && typeof initAlapinDrill === "function") initAlapinDrill();
  if (name === "grunfeld" && typeof initGrunfeld === "function") initGrunfeld();
  if (name === "attacks" && typeof initAttacks === "function") initAttacks();
}

document.querySelectorAll(".tab-btn").forEach(b =>
  b.addEventListener("click", () => switchTab(b.dataset.tab)));
document.querySelectorAll(".grp-btn").forEach(b => b.addEventListener("click", () => {
  const g = b.dataset.group, list = TAB_GROUPS[g] || [];
  let last = null;
  try { last = localStorage.getItem("cc-last-tab-" + g); } catch (_) { /* */ }
  const cur = (document.querySelector(".tab-btn.active") || {}).dataset;
  if (cur && tabGroupOf(cur.tab) === g) return; // already in this section
  switchTab(list.includes(last) ? last : list[0]);
  if (window.innerWidth <= 700) window.scrollTo({ top: 0 });
  const act = document.querySelector(".tab-btn.active");
  if (act && act.scrollIntoView) try { act.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) { /* */ }
}));

/* ================= reusable move-navigation controls =================
   createNavControls(slotId, { onNav(dir), isActive() }) builds
   ⏮ ◀ ▶ ⏭ buttons into the slot element. Left/right arrow keys drive the
   first registered control whose isActive() says its view is visible.
   update({start,prev,next,end}) enables/disables buttons (bounds). */

const NavRegistry = [];

function createNavControls(slotId, opts) {
  const host = $(slotId);
  const wrap = document.createElement("div");
  wrap.className = "nav-controls";
  const btns = {};
  const titles = { start: "Start", prev: "Back (←)", next: "Forward (→)", end: "End" };
  const labels = { start: "⏮", prev: "◀", next: "▶", end: "⏭" };
  for (const dir of ["start", "prev", "next", "end"]) {
    const b = document.createElement("button");
    b.className = "btn nav-btn";
    b.textContent = labels[dir];
    b.title = titles[dir];
    b.disabled = true;
    b.addEventListener("click", () => opts.onNav(dir));
    wrap.appendChild(b);
    btns[dir] = b;
  }
  host.appendChild(wrap);
  const ctl = {
    btns,
    isActive: opts.isActive,
    onNav: opts.onNav,
    update(state) {
      for (const dir in btns) btns[dir].disabled = !state[dir];
    },
  };
  NavRegistry.push(ctl);
  return ctl;
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const t = e.target;
  if (t && ((t.closest && t.closest("input, textarea, select")) || t.isContentEditable)) return;
  // mistake review mode owns the arrows on the Play tab
  if (typeof Review !== "undefined" && Review.active &&
      $("tab-play").classList.contains("active")) {
    e.preventDefault();
    reviewStep(e.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  for (const ctl of NavRegistry) {
    if (ctl.isActive && ctl.isActive()) {
      const dir = e.key === "ArrowLeft" ? "prev" : "next";
      if (!ctl.btns[dir].disabled) {
        e.preventDefault();
        ctl.onNav(dir);
      }
      return;
    }
  }
});

/* ================= global state ================= */

/* V25 (DUP-3): the session-only puzzle queue in State was removed —
   single-game builds persist into the user puzzle store and come back via
   /api/puzzle/next like library-built puzzles. */

const State = {
  lastAnalyzedPgn: null,
  engineOk: true,
  labGameCache: {},     // pgn -> {sans, fens, ucis} resolved plies for Strategy Lab
  lichessTokenSet: false, // server has a lichess API token (GET /api/config)
  lastScanMistakes: null, // mistakes[] of the last /api/mistakes/scan (flashcard adds)
  usernames: { lichess: "", chesscom: "" }, // GET /api/config (progress/review "you" color)
  puzzleLibrary: null,  // cached /api/puzzles/library-stats (Puzzles tab)
};

/* ================= My plan (/api/strategy/plan) =================
   V30: "Show my plan" is back on the Play & Analyze tab (V25 DUP-6 had
   moved it to the Strategy Lab only; the user wants BOTH doors). Two plan
   contexts share the machinery below: playPlanCtx (#btn-show-plan +
   #opponent-level + #plan-panel, player_moves 4 — "the next best 4 moves")
   and labPlanCtx (#btn-lab-plan + #lab-opponent-level + #lab-plan-result,
   player_moves 3). A plan context bundles:
   { board, panel(), btn(), getFen(), getBottomSide(), state, playerMoves }
   where state.plan holds the last shown plan response (null = none shown).
   "Bottom side" == the side at the bottom of the screen (board.orientation).
   Opponent moves come from the lichess player database at the selected
   opponent level; without human data the backend falls back to engine
   alternatives (branch_source "stockfish"). */

/* opponent level selector values → short labels for the plan header */
const OPP_LEVEL_LABEL = {
  casual: "Casual",
  club: "Club",
  advanced: "Advanced",
  expert: "Expert",
  masters: "Masters (OTB)",
};

function getOpponentLevel() {
  try {
    const v = localStorage.getItem("opponent_level");
    if (v && OPP_LEVEL_LABEL[v]) return v;
  } catch (_) { /* storage unavailable — fall through */ }
  return "club";
}

/* keep every opponent-level <select> in sync with the persisted choice */
function syncOppLevelSelects() {
  const v = getOpponentLevel();
  document.querySelectorAll("select.opp-level").forEach(el => { el.value = v; });
}

/* compact game counts: 127920 → "128k", 56784 → "56.8k", 1500000 → "1.5M" */
function fmtGames(n) {
  if (n == null) return "";
  if (n >= 1e6) return (Math.round(n / 1e5) / 10) + "M";
  if (n >= 1e5) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (Math.round(n / 100) / 10) + "k";
  return String(n);
}

/* 41 → "41", 33.5 → "33.5" */
function fmtPct(p) {
  const v = Math.round(p * 10) / 10;
  return v % 1 === 0 ? String(Math.round(v)) : v.toFixed(1);
}

async function fetchStrategyPlan(fen, bottomSide, playerMoves) {
  return apiPost("/api/strategy/plan", {
    fen, bottom_side: bottomSide, opponent_level: getOpponentLevel(),
    player_moves: playerMoves || 3, opp_branches: 2, depth: 12,
  });
}

/* "1." / "1…" move-number prefix for a main_line entry, from the plan
   FEN's side to move + fullmove counter. Shared by the plan header text
   and the step buttons so both always number the same move identically. */
function planMovePrefix(plan, m, i) {
  const parts = (plan.fen || "").split(" ");
  const startMove = parseInt(parts[5], 10) || 1;
  const whiteToMove = parts[1] !== "b";
  // plies before this one, counting from the FEN's side to move
  const pliesFromStart = (m.ply != null ? m.ply : i + 1) - 1;
  const moverWhite = whiteToMove ? pliesFromStart % 2 === 0
                                 : pliesFromStart % 2 === 1;
  const moveNo = startMove + Math.floor((pliesFromStart + (whiteToMove ? 0 : 1)) / 2);
  return moverWhite ? moveNo + "." : moveNo + "…";
}

/* "1.d4 2.c4 3.Nf3"-style text for the bottom side's numbered moves.
   main_line sides are "player" (bottom side) / "opponent". */
function planMovesText(plan) {
  const out = [];
  (plan.main_line || []).forEach((m, i) => {
    if (m.side !== "player") return;
    out.push(planMovePrefix(plan, m, i) + m.san);
  });
  return out.join(" ");
}

function renderPlanPanel(ctx, plan) {
  if (plan && plan.for_side_note) setTimeout(() => {
    const p = ctx.panel();
    if (p && !p.querySelector(".plan-side-note")) {
      const d = document.createElement("div");
      d.className = "info-line plan-side-note";
      d.textContent = "Plan for " + (plan.bottom_side === "black" ? "Black" : "White") + " (the side to move).";
      p.prepend(d);
    }
  }, 0);
  const host = ctx.panel();
  host.innerHTML = "";
  host.classList.remove("hidden");
  if (plan.terminal) {
    const d = document.createElement("div");
    d.className = "info-line";
    d.textContent = "Game over — " + (plan.result || "") +
      (plan.reason ? " (" + plan.reason + ")" : "") + ". No plan to show.";
    host.appendChild(d);
    return;
  }
  // header: product framing — Stockfish plan vs. what players at this
  // level actually play (opponent moves = #1 most popular human replies)
  const level = OPP_LEVEL_LABEL[plan.opponent_level] || OPP_LEVEL_LABEL[getOpponentLevel()];
  const h = document.createElement("div");
  h.className = "plan-head";
  h.textContent = "Your plan vs. the most likely replies at " + level + " level";
  host.appendChild(h);

  const head = document.createElement("div");
  head.className = "plan-line";
  head.title = "Click to redraw the full plan";
  head.textContent = "Your plan: " + planMovesText(plan);
  head.addEventListener("click", () => {
    ctx.board.drawPlan(plan.main_line, { bottomSide: "player" });
    host.querySelectorAll(".plan-branch").forEach(el => el.classList.remove("active"));
    host.querySelectorAll(".plan-step-row").forEach(el => el.classList.remove("active"));
  });
  host.appendChild(head);

  // V11: what the plan is trying to accomplish — goal + per-move reasons
  // (board-verified backend heuristics, optional LLM goal polish). Older
  // backends may not send plan.explanation — skip silently then.
  const expl = plan.explanation;
  if (expl && expl.goal) {
    const g = document.createElement("div");
    g.className = "plan-goal";
    g.append("🎯 ");
    const goalText = document.createElement("span");
    // V34: persona goal (Latvian broken English) outranks the plain LLM
    // goal; the pristine template goal stays the final fallback
    goalText.textContent = expl.persona_goal || expl.llm_goal || expl.goal; // textContent only
    g.appendChild(goalText);
    if (expl.persona_goal) {
      const lv = document.createElement("span");
      lv.className = "plan-goal-ai";
      lv.textContent = " (Latvian coach)";
      g.appendChild(lv);
    } else if (expl.llm_goal) {
      const ai = document.createElement("span");
      ai.className = "plan-goal-ai";
      ai.textContent = " (AI coach)";
      g.appendChild(ai);
    }
    host.appendChild(g);
  }
  if (expl && Array.isArray(expl.steps) && expl.steps.length) {
    const steps = document.createElement("div");
    steps.className = "plan-steps";
    for (const step of expl.steps) {
      // V32: opponent plies render as muted, NON-clickable rows (no arrows,
      // no button) interleaved in ply order between the player steps
      if (step.side === "opponent") {
        const orow = document.createElement("div");
        orow.className = "plan-step-row opp";
        const omv = document.createElement("span");
        omv.className = "plan-step-opp-mv";
        omv.textContent = "…" + step.san; // textContent only
        const owhy = document.createElement("span");
        owhy.className = "plan-step-why";
        owhy.textContent = step.reason; // textContent only
        orow.append(omv, owhy);
        steps.appendChild(orow);
        continue;
      }
      const row = document.createElement("div");
      row.className = "plan-step-row";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "plan-step";
      btn.title = "Draw the plan up to this move";
      // same move-number math as the plan header (black plans read "1… Nf6",
      // never raw ply numbers that would clash with planMovesText)
      const ml = (plan.main_line || []).find(m => m.ply === step.ply) || {};
      btn.textContent = planMovePrefix(plan, ml, (step.ply || 1) - 1) + " " + step.san;
      const why = document.createElement("span");
      why.className = "plan-step-why";
      why.textContent = step.reason; // plain text — the button already separates
      btn.addEventListener("click", () => {
        // prefix up to and including this ply (ply is 1-based)
        ctx.board.drawPlan(plan.main_line.slice(0, step.ply), { bottomSide: "player" });
        host.querySelectorAll(".plan-branch").forEach(el => el.classList.remove("active"));
        steps.querySelectorAll(".plan-step-row").forEach(el => el.classList.remove("active"));
        row.classList.add("active");
      });
      row.append(btn, why);
      steps.appendChild(row);
    }
    host.appendChild(steps);
  }

  // human-game stats may be unavailable: either no lichess token (actionable)
  // or simply no games reached this position (plain note)
  const engineOnly = plan.branch_source === "stockfish";
  if (engineOnly) {
    const tokenSet = plan.lichess_token_set != null ? plan.lichess_token_set : State.lichessTokenSet;
    const note = document.createElement("div");
    note.className = "plan-note";
    if (tokenSet) {
      note.textContent = "No human game data for this position — showing engine alternatives";
    } else {
      note.classList.add("action");
      note.textContent = "No human game stats — add your free lichess token to see what players actually play";
      note.title = "Open the lichess token settings";
      note.addEventListener("click", openLichessSettings);
    }
    host.appendChild(note);
  }

  // branches: "d5 — 41% of games (128k) → reply c4 (+0.28)", most popular
  // first. Branch fields per the API: move_uci/move_san (opponent move),
  // reply_uci/reply_san (player best reply — null when the branch ends the
  // game or the engine budget ran out), eval (player POV at the reply node).
  const branches = (plan.branches || []).slice();
  if (!engineOnly) branches.sort((a, b) => (b.pct || 0) - (a.pct || 0));
  for (const b of branches) {
    const d = document.createElement("div");
    d.className = "plan-branch";
    d.title = "Draw this branch on the board";
    let txt = b.move_san;
    if (b.pct != null) {
      txt += " — " + fmtPct(b.pct) + "% of games";
      if (b.games != null) txt += " (" + fmtGames(b.games) + ")";
    }
    if (b.reply_san) {
      txt += " → reply " + b.reply_san + " ";
    } else if (b.eval && b.eval.type === "mate") {
      txt += " — checkmate, no reply";
    }
    d.textContent = txt;
    if (b.reply_san || b.eval) {
      const ev = document.createElement("span");
      ev.className = "b-eval";
      ev.textContent = "(" + evalText(b.eval) + ")"; // eval is player (bottom side) POV
      d.appendChild(ev);
    }
    if (b.in_main_line) {
      const tag = document.createElement("span");
      tag.className = "plan-tag";
      tag.textContent = "most likely";
      d.appendChild(tag);
    }
    // V32: what the opponent's popular move aims at (board-verified
    // backend comment) — muted line under the branch row, textContent only
    if (b.comment) {
      const why = document.createElement("span");
      why.className = "plan-branch-why";
      why.textContent = b.comment;
      d.appendChild(why);
    }
    d.addEventListener("click", () => {
      const line = [{ uci: b.move_uci, side: "opponent" }];
      if (b.reply_uci) line.push({ uci: b.reply_uci, side: "player" });
      ctx.board.drawPlan(line, { bottomSide: "player" });
      host.querySelectorAll(".plan-branch").forEach(el => el.classList.remove("active"));
      // drawing a branch supersedes any highlighted plan step, exactly
      // like the head/step clicks already clear branch actives
      host.querySelectorAll(".plan-step-row").forEach(el => el.classList.remove("active"));
      d.classList.add("active");
    });
    host.appendChild(d);
  }
}

function clearPlanUi(ctx) {
  ctx.state.plan = null;
  const p = ctx.panel();
  p.classList.add("hidden");
  p.innerHTML = "";
  const b = ctx.btn();
  if (b) b.classList.remove("active");
}

/* the plan only makes sense from the mover's seat: the backend rejects a
   bottom_side that isn't the side to move (400 bottom_side_mismatch), so
   check first and tell the user to flip instead of firing a doomed request */
function bottomSideMsg(fen) {
  const turn = fen.split(" ")[1] === "b" ? "Black" : "White";
  return "It's " + turn + " to move — flip the board so " + turn +
    " is at the bottom, then ask for the plan.";
}

async function requestPlan(ctx) {
  const fen = ctx.getFen();
  const bottomSide = ctx.getBottomSide();
  const sideToMove = fen.split(" ")[1] === "b" ? "black" : "white";
  const panel = ctx.panel();
  panel.classList.remove("hidden");
  // v40: plan for the side to move, whichever way the board faces
  panel.innerHTML = '<div class="info-line">Calculating the plan for ' + (sideToMove === "black" ? "Black" : "White") + '…</div>';
  try {
    const plan = await fetchStrategyPlan(fen, sideToMove, ctx.playerMoves);
    // board moved on while the engine thought — drop the stale response
    if (ctx.getFen() !== fen) return;
    plan.bottom_side = sideToMove; // not echoed by the API — keep for the panel
    plan.for_side_note = bottomSide !== sideToMove;
    ctx.state.plan = plan;
    if (plan.terminal) ctx.board.clearArrows();
    else ctx.board.drawPlan(plan.main_line, { bottomSide: "player" });
    renderPlanPanel(ctx, plan);
    const b = ctx.btn();
    if (b) b.classList.add("active");
  } catch (e) {
    const eng = await surfaceEngineError(e);
    ctx.state.plan = null;
    const msg = eng ? "Engine unavailable — see the banner above."
      : e.detail === "bottom_side_mismatch" ? bottomSideMsg(fen)
      : "Plan failed: " + escapeHtml(e.message);
    panel.innerHTML = '<div class="info-line">' + msg + "</div>";
  }
}

/* changing the opponent level persists the choice and re-requests any
   plan currently shown (both contexts stay on the same level) */
function onOppLevelChange(value) {
  if (!OPP_LEVEL_LABEL[value]) return;
  try { localStorage.setItem("opponent_level", value); } catch (_) {}
  syncOppLevelSelects();
  if (Play.plan) requestPlan(playPlanCtx);
  if (Lab.plan) requestPlan(labPlanCtx);
  // Maia predictions are level-specific too — re-fetch at the new level
  if (Maia.available) refreshMaiaPanel(playBoard.getFen());
  if (Review.active && Review.mistakes[Review.idx]) {
    annotateMistakeWithMaia(Review.mistakes[Review.idx]);
  }
}

/* ================= lichess API token (enables human-move stats) ================= */

function updateLichessCheck() {
  $("lichess-check").classList.toggle("hidden", !State.lichessTokenSet);
  $("btn-lichess-settings").classList.toggle("token-set", State.lichessTokenSet);
}

/* reveal the inline token field (also reachable from a plan-panel note,
   including notes shown in the Strategy Lab) */
function openLichessSettings() {
  switchTab("play");
  const box = $("lichess-settings");
  box.classList.remove("hidden");
  box.scrollIntoView({ block: "nearest" });
  $("lichess-token-input").focus();
}

async function loadLichessConfig() {
  try {
    const c = await apiGet("/api/config");
    State.lichessTokenSet = !!c.lichess_token_set;
    State.usernames.lichess = (c.lichess_username || "").trim();
    State.usernames.chesscom = (c.chesscom_username || "").trim();
    updateLichessCheck();
    $("cfg-lichess-username").value = State.usernames.lichess;
    $("cfg-chesscom-username").value = State.usernames.chesscom;
    $("llm-enabled").checked = !!c.llm_enabled;
    $("llm-url-input").value = c.llm_url || "";
    $("llm-model-input").value = c.llm_model || "";
    // if the coach is already enabled, show the no-restart hint on load too
    $("llm-no-restart-hint").classList.toggle("hidden", !c.llm_enabled);
    // V26: voice toggle reflects the saved config (availability is probed
    // separately via /api/coach/voice-status in loadVoiceStatus)
    $("voice-enabled").checked = !!c.voice_enabled;
    Voice.enabled = !!c.voice_enabled;
    // V34: persona wording toggle + provider picker mirror the saved config
    $("persona-enabled").checked = !!c.persona_enabled;
    $("voice-provider").value = c.voice_provider || "auto";
    syncImportUI(); // prefill the import username from the loaded config
  } catch (_) { /* config unreadable — leave the checkmark off */ }
}

function wireLichessSettings() {
  $("btn-lichess-settings").addEventListener("click", () => {
    $("lichess-settings").classList.toggle("hidden");
  });
  $("btn-lichess-save").addEventListener("click", async () => {
    const status = $("lichess-save-status");
    const token = $("lichess-token-input").value.trim();
    status.textContent = "Saving…";
    try {
      const c = await apiPost("/api/config", { lichess_token: token });
      State.lichessTokenSet = c.lichess_token_set != null ? !!c.lichess_token_set : !!token;
      if (State.lichessTokenSet) $("lichess-token-input").value = "";
      updateLichessCheck();
      status.textContent = State.lichessTokenSet ? "Saved — token is set. ✓" : "Saved — token cleared.";
      // a shown plan may now be able to use human stats → refresh it
      if (Play.plan) requestPlan(playPlanCtx);
      if (Lab.plan) requestPlan(labPlanCtx);
    } catch (e) {
      status.textContent = "Save failed: " + e.message;
    }
  });
  // usernames: all-optional config keys — send ONLY these two so the token
  // and every other setting are left untouched server-side
  $("btn-cfg-usernames-save").addEventListener("click", async () => {
    const status = $("cfg-usernames-status");
    const body = {
      lichess_username: $("cfg-lichess-username").value.trim(),
      chesscom_username: $("cfg-chesscom-username").value.trim(),
    };
    status.textContent = "Saving…";
    try {
      const c = await apiPost("/api/config", body);
      State.usernames.lichess = (c.lichess_username || "").trim();
      State.usernames.chesscom = (c.chesscom_username || "").trim();
      status.textContent = "Saved. ✓";
    } catch (e) {
      status.textContent = "Save failed: " + e.message;
    }
  });
}

/* AI coach (local LLM) section of the same settings panel */
const LLM_TEST_MESSAGES = {
  connection_refused: "Can't reach a server at that URL — is it running?",
  timeout: "Server didn't answer in time.",
  bad_response: "That doesn't look like an LLM server.",
  unreachable: "That doesn't look like an LLM server.",
};

function llmTestFailText(detail) {
  if (typeof detail === "string" && detail.startsWith("http_")) {
    return "Server answered with an error (HTTP " + detail.slice(5) + ").";
  }
  return LLM_TEST_MESSAGES[detail] || "Connection test failed.";
}

function setLlmStatus(text, kind) {
  const el = $("llm-status");
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.textContent = text;
}

function wireLlmSettings() {
  $("btn-llm-save").addEventListener("click", async () => {
    const enabled = $("llm-enabled").checked;
    setLlmStatus("Saving…", null);
    try {
      await apiPost("/api/config", {
        llm_enabled: enabled,
        llm_url: $("llm-url-input").value.trim(),
        llm_model: $("llm-model-input").value.trim(),
      });
      setLlmStatus("Saved.", "ok");
      $("llm-no-restart-hint").classList.toggle("hidden", !enabled);
    } catch (e) {
      setLlmStatus("Save failed: " + e.message, "err");
    }
  });
  $("btn-llm-test").addEventListener("click", async () => {
    const btn = $("btn-llm-test");
    btn.disabled = true;
    setLlmStatus("Testing…", null);
    try {
      const r = await apiPost("/api/config/test-llm", {
        llm_url: $("llm-url-input").value.trim(),
      });
      if (r.ok) {
        setLlmStatus("Connected in " + r.latency_ms + "ms — reply: " +
                     (r.reply_sample || ""), "ok");
      } else {
        setLlmStatus(llmTestFailText(r.detail), "err");
      }
    } catch (e) {
      setLlmStatus("Connection test failed: " + e.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
}

/* ================= V26 coach voice (Latvian accent, optional) =================
   Zero-hallucination: the voice ONLY reads strings the app already shows —
   it never adds a chess claim. Backend: edge-tts (lv-LV-NilsNeural,
   online) with a pyttsx3/SAPI offline fallback; both are OPTIONAL
   (not available in the web version). When the voice is off or unavailable every
   speaker button stays hidden — no dead UI. */

const Voice = {
  enabled: false,   // voice_enabled in the server config
  available: false, // a provider (edge or sapi) is importable server-side
  playing: false,   // one clip at a time — overlapping requests are dropped
  hintShown: false, // the "voice unavailable" hint appears once
  // analysis keys whose brilliant flash already fired (confetti + speak
  // happen ONCE per analysis, not on every renderGameAnalysis re-render)
  celebratedFlashes: new Set(),
};

/* text elements a speaker button reads; the button id is "btn-speak-" + id */
const SPEAK_TARGETS = [
  "puzzle-hint", "puzzle-why", "review-explain", "fc-hint", "fc-explain",
  "cycle-hint", "sparring-hint", "endgame-hint", "gtm-hint", "gtm-debrief",
];

function voiceOn() { return Voice.enabled && Voice.available; }

/* a speaker button is visible exactly when the voice works AND its target
   text is on screen — call after any show/hide of a SPEAK_TARGETS element */
function syncSpeakButtons() {
  SPEAK_TARGETS.forEach(id => {
    const btn = $("btn-speak-" + id);
    const target = $(id);
    if (!btn || !target) return;
    const show = voiceOn() && !target.classList.contains("hidden") &&
      !!target.textContent.trim();
    btn.classList.toggle("hidden", !show);
  });
  // chat bubbles carry their own per-message buttons
  document.querySelectorAll("#chat-messages .speak-btn").forEach(btn => {
    btn.classList.toggle("hidden", !voiceOn());
  });
}

async function speakText(text, btn) {
  text = (text || "").trim();
  if (!text || !voiceOn() || Voice.playing) return; // drop overlaps
  Voice.playing = true;
  if (btn) btn.disabled = true;
  const done = () => { Voice.playing = false; if (btn) btn.disabled = false; };
  let started = false; // playback actually began — cleared on ended/error
  try {
    const r = await fetch("/api/coach/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.status === 403 || r.status === 503) {
      // voice switched off server-side, or no provider installed — hide the
      // dead buttons and (once) explain the voice is unavailable
      Voice.enabled = false;
      Voice.available = false;
      syncSpeakButtons();
      voiceInstallHintOnce();
      return;
    }
    if (!r.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    // play() resolving only means playback STARTED — keep Voice.playing set
    // until the clip ends (or errors) so a second click mid-clip is dropped,
    // and revoke the blob URL on every path so it never leaks.
    audio.onended = () => { URL.revokeObjectURL(url); done(); };
    audio.onerror = () => { URL.revokeObjectURL(url); done(); };
    try {
      await audio.play();
      started = true;
    } catch (_) {
      URL.revokeObjectURL(url); // play() rejected — the clip never started
    }
  } catch (_) {
    /* playback/network failure — the text is still on screen */
  } finally {
    if (!started) done();
  }
}

function speakElementText(id, btn) {
  const target = $(id);
  if (target) speakText(target.textContent, btn);
}

/* celebration banners (week closed / new PR / streak milestone / verified
   brilliant): read the banner text ONCE when it appears */
function speakCelebration(text) { speakText(text, null); }

function voiceInstallHintOnce() {
  if (Voice.hintShown) return;
  Voice.hintShown = true;
  const el = $("voice-hint");
  el.textContent = "Coach voice is unavailable in the web version — " +
    "the coach's advice is shown as text instead.";
  el.classList.remove("hidden");
}

function wireVoice() {
  SPEAK_TARGETS.forEach(id => {
    const btn = $("btn-speak-" + id);
    if (btn) btn.addEventListener("click", () => speakElementText(id, btn));
  });
  $("voice-enabled").addEventListener("change", async () => {
    const enabled = $("voice-enabled").checked;
    try {
      await apiPost("/api/config", { voice_enabled: enabled });
      Voice.enabled = enabled;
      // re-probe availability BEFORE syncing the buttons: the user may have
      // gained a voice provider while the app was up, or a 403/503
      // hid the buttons — toggling must reflect the CURRENT truth, not the
      // startup probe. loadVoiceStatus also syncs the buttons.
      await loadVoiceStatus();
      if (Voice.available) {
        $("voice-status").textContent = enabled
          ? "Voice on — speaker buttons appear next to coach texts. ✓"
          : "Voice off.";
      } // else: loadVoiceStatus already showed the "unavailable" hint
    } catch (e) {
      $("voice-status").textContent = "Save failed: " + e.message;
    }
  });
  // V34: persona wording toggle — the coach's TEXT (and therefore what the
  // voice reads) switches between standard and Latvian broken English
  $("persona-enabled").addEventListener("change", async () => {
    try {
      await apiPost("/api/config", { persona_enabled: $("persona-enabled").checked });
      $("voice-status").textContent = "Latvian coach wording saved. ✓";
    } catch (e) {
      $("voice-status").textContent = "Save failed: " + e.message;
    }
  });
  // V34: provider picker (Auto / Nils online / Offline clone / system voice)
  $("voice-provider").addEventListener("change", async () => {
    try {
      await apiPost("/api/config", { voice_provider: $("voice-provider").value });
      await loadVoiceStatus(); // reflect what the new provider can do NOW
    } catch (e) {
      $("voice-status").textContent = "Save failed: " + e.message;
    }
  });
}

/* startup probe: hide every speaker button when the voice is off or no
   provider is installed (no dead UI) */
async function loadVoiceStatus() {
  try {
    const s = await apiGet("/api/coach/voice-status");
    Voice.enabled = !!s.enabled;
    Voice.available = !!s.available;
    $("voice-enabled").checked = Voice.enabled;
    // list whichever providers the server can use right now (V34 adds the
    // offline clone, so the user sees whether their pick can speak)
    const p = s.providers || {};
    const avail = [];
    if (p.edge) avail.push("Nils (online)");
    if (p.xtts) avail.push("Offline clone");
    if (p.sapi) avail.push("System voice (offline)");
    $("voice-status").textContent = !s.available
      ? "Coach voice is unavailable in the web version — " +
        "coach texts are shown on screen only."
      : "Available: " + avail.join(" + ") + ".";
  } catch (_) { /* status unreadable — buttons stay hidden */ }
  syncSpeakButtons();
}

/* ================= Play & Analyze tab ================= */

const PLAY_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const Play = {
  moves: [],       // {san, uci, fen_after, classification}
  lastEval: null,  // {ev, sideToMove} for fen BEFORE last played move
  busy: false,
  viewPly: 0,      // ply currently shown (== moves.length → live position)
  startFen: PLAY_START_FEN, // ply-0 position (set by New game / Load FEN)
  lastAnalysis: null,
  plan: null,      // shown /api/strategy/plan response (null = none)
};

const playBoard = new Board($("play-board"), { onMove: onPlayMove });

/* V30: the Play-tab plan context (restored pre-V25 wiring) — 4 player
   moves: the user remembers "the next best 4 moves" */
const playPlanCtx = {
  board: playBoard,
  panel: () => $("plan-panel"),
  btn: () => $("btn-show-plan"),
  getFen: () => playBoard.getFen(),
  getBottomSide: () => playBoard.orientation,
  state: Play,
  playerMoves: 4,
};

function playFenAt(ply) { return ply === 0 ? Play.startFen : Play.moves[ply - 1].fen_after; }

const playNav = createNavControls("play-nav", {
  onNav: (dir) => {
    const last = Play.moves.length;
    playGoToPly(dir === "start" ? 0 : dir === "end" ? last : Play.viewPly + (dir === "next" ? 1 : -1));
  },
  isActive: () => $("tab-play").classList.contains("active"),
});

function updatePlayNav() {
  if (typeof Review !== "undefined" && Review.active) {
    playNav.update({ start: false, prev: false, next: false, end: false });
    return;
  }
  const last = Play.moves.length;
  const p = Math.min(Play.viewPly, last);
  playNav.update({ start: p > 0, prev: p > 0, next: p < last, end: p < last });
}

/* view-only history stepping; the live position is ply == moves.length */
function playGoToPly(n) {
  n = Math.max(0, Math.min(Play.moves.length, n));
  Play.viewPly = n;
  playBoard.setFen(playFenAt(n));
  const m = n > 0 ? Play.moves[n - 1] : null;
  playBoard.setLastMove(m ? m.uci.slice(0, 2) : null, m ? m.uci.slice(2, 4) : null);
  playBoard.setGuided([]); // history navigation drops the guided glow…
  playBoard.clearArrows();
  clearPlanUi(playPlanCtx);
  clearDiscussUi(); // position changed — any shown discussion is stale
  const viewing = n < Play.moves.length;
  const note = $("play-history-note");
  note.classList.toggle("hidden", !viewing);
  if (viewing) {
    note.textContent = "Viewing history (ply " + n + "/" + Play.moves.length +
      ") — moves are disabled here; ⏭ returns to the live position.";
  }
  highlightPlayMove(n);
  refreshEvalBar(playFenAt(n));
  refreshPositionExtras(playFenAt(n));
  updatePlayNav();
  // …and returning to the live position restores it on a guided user turn
  if (typeof Rehearsal !== "undefined" && Rehearsal.active) refreshGuidedUi();
}

function highlightPlayMove(n) {
  const host = $("play-moves");
  host.querySelectorAll(".mv").forEach((el, i) => el.classList.toggle("current", i === n - 1));
}

async function onPlayMove(from, to) {
  if (Review.active) { playBoard.shake(); return; } // mistake review is view-only
  if (Play.busy || Rehearsal.busy) return; // busy = app is "thinking" — ignore board clicks
  // moves are only allowed at the latest ply — jump forward on attempt
  if (Play.viewPly < Play.moves.length) {
    playGoToPly(Play.moves.length);
    const note = $("play-history-note");
    note.classList.remove("hidden");
    note.textContent = "Jumped to the live position — make your move now.";
    return;
  }
  if (Rehearsal.active && Rehearsal.gameOver) {
    playBoard.shake();
    rehearsalGameOver(null, null); // re-show the game-over hint
    return;
  }
  Play.busy = true;
  const fenBefore = playBoard.getFen();
  // V31: on a guided user turn, note whether the played move leaves the line
  const wasOnScript = Rehearsal.active && guidedOnScript() &&
    fenSide(fenBefore) !== rehearsalAppSide();
  try {
    const r = await apiPost("/api/move", { fen: fenBefore, move_uci: uciCandidate(playBoard, from, to) });
    if (!r.legal) { playBoard.shake(); return; }
    Play.moves.push({ san: r.san, uci: uciCandidate(playBoard, from, to), fen_after: r.fen_after, classification: null });
    playBoard.setFen(r.fen_after);
    playBoard.setLastMove(from, to);
    clearGuidedHighlight(); // also clears the guided arrow/squares (and any plan arrows)
    clearPlanUi(playPlanCtx);
    clearDiscussUi(); // position changed — any shown discussion is stale
    Play.viewPly = Play.moves.length;
    $("play-history-note").classList.add("hidden");
    renderPlayMoves();
    updatePlayNav();
    autoClassifyLast(fenBefore, r.fen_after);
    // live verdict on the USER's move (free play + rehearsal); fire-and-forget
    requestMoveFeedback(fenBefore, Play.moves[Play.moves.length - 1].uci);
    refreshPositionExtras(r.fen_after);
    if (Rehearsal.active && !Rehearsal.gameOver) {
      // a guided move that does NOT complete the line and no longer matches
      // the prefix is a deviation — say so along with the app's reply
      const deviated = wasOnScript && !guidedOnScript() && !guidedLineComplete();
      // rehearsal: app answers with a common human reply (await keeps the
      // board locked via Play.busy while the app is "thinking")
      await rehearsalRequestOpponentMove(deviated
        ? "Off the script — the app continues with the most popular replies."
        : undefined);
    } else {
      refreshEvalBar(r.fen_after);
    }
  } catch (e) {
    showError(e.message);
  } finally {
    Play.busy = false;
  }
}

function renderPlayMoves() {
  const host = $("play-moves");
  host.innerHTML = "";
  for (let i = 0; i < Play.moves.length; i += 2) {
    const row = document.createElement("div");
    row.className = "move-pair";
    const num = document.createElement("span");
    num.className = "move-num";
    num.textContent = (i / 2 + 1) + ".";
    row.appendChild(num);
    for (let j = i; j < Math.min(i + 2, Play.moves.length); j++) {
      const mv = document.createElement("span");
      mv.className = "mv";
      mv.textContent = Play.moves[j].san;
      const dot = document.createElement("span");
      dot.className = "dot " + (Play.moves[j].classification || "none");
      mv.appendChild(dot);
      mv.addEventListener("click", () => playGoToPly(j + 1));
      row.appendChild(mv);
    }
    host.appendChild(row);
  }
  host.scrollTop = host.scrollHeight;
  highlightPlayMove(Play.viewPly);
}

/* per-move auto-classification: compare eval before/after via backend.
   plyIdx is captured at call time — in rehearsal mode the app's reply may
   already be appended by the time the analysis returns. */
async function autoClassifyLast(fenBefore, fenAfter) {
  if (!State.engineOk) return;
  const plyIdx = Play.moves.length - 1;
  try {
    const a = await apiPost("/api/analyze/position", { fen: fenBefore, depth: 12 });
    const b = await apiPost("/api/analyze/position", { fen: fenAfter, depth: 12 });
    // string eval = terminal payload: "mate" = side to move is checkmated
    const toCp = (ev) => typeof ev === "string" ? (ev === "mate" ? -100000 : 0)
      : ev.type === "mate" ? (ev.value > 0 ? 100000 : -100000) : ev.value;
    // evals are side-to-move POV; mover POV of "after" = -b
    const cpl = Math.max(0, toCp(a.eval) - (-toCp(b.eval)));
    if (Play.moves[plyIdx]) {
      Play.moves[plyIdx].classification = classifyCpl(cpl);
      renderPlayMoves();
    }
  } catch (e) { surfaceEngineError(e); /* leave badge neutral */ }
}

/* ================= live move feedback (7-grade chip) =================
   After the USER's move lands, /api/move/feedback grades it: green for
   brilliant/great/best, yellow for good/inaccuracy, red for
   mistake/blunder. The request is fire-and-forget — board input is never
   blocked, and a seq guard drops verdicts superseded by a newer move. */

const Feedback = { seq: 0, last: null };

const FEEDBACK_TONE = {
  brilliant: "green", great: "green", best: "green",
  good: "yellow", inaccuracy: "yellow",
  mistake: "red", blunder: "red",
};

const FEEDBACK_LABEL = {
  brilliant: "Brilliant!", great: "Great move", best: "Best move",
  good: "Good move", inaccuracy: "Inaccuracy",
  mistake: "Mistake", blunder: "Blunder",
};

function hideFeedbackChip() {
  $("feedback-chip").classList.add("hidden");
}

/* redesign: annotation glyph + one-line plain-English "why" for the chip,
   built only from fields /api/move/feedback already returns
   (classification, cpl, best_san, eval_after — mover's POV). */
const FEEDBACK_ICON = {
  brilliant: "!!", great: "!", best: "★", good: "✓",
  inaccuracy: "?!", mistake: "?", blunder: "??",
};

function feedbackEvalPhrase(ev) {
  if (!ev || typeof ev !== "object") return "";
  if (ev.type === "mate") {
    const n = Math.abs(ev.value);
    return ev.value > 0 ? "You now have mate in " + n + "." : "Your opponent now has mate in " + n + ".";
  }
  if (typeof ev.value !== "number") return "";
  const p = ev.value / 100;
  if (Math.abs(p) < 0.3) return "The position is roughly level.";
  const who = p > 0 ? "you" : "your opponent";
  const size = Math.abs(p) >= 3 ? "winning" : Math.abs(p) >= 1.2 ? "clearly better" : "slightly better";
  return "Now " + (p > 0 ? "+" : "−") + Math.abs(p).toFixed(1) + " — " + who + " " +
    (who === "you" ? "are " : "is ") + size + ".";
}

function feedbackWhy(r) {
  const pawns = (r.cpl || 0) / 100;
  const pw = pawns.toFixed(1) + " pawn" + (pawns >= 0.95 && pawns < 1.05 ? "" : "s");
  const best = r.best_san ? r.best_san : "the engine's choice";
  let why;
  switch (r.classification) {
    case "brilliant": why = "A sound sacrifice the engine confirms — the strongest move on the board."; break;
    case "great": why = "The only move that keeps your edge — the alternatives were clearly worse."; break;
    case "best": why = "This matches the engine's top choice."; break;
    case "good": why = r.cpl > 0 ? "Solid. " + best + " was a touch more precise." : "A solid, sensible move."; break;
    case "inaccuracy": why = "Gives away about " + pw + " of value — " + best + " kept more."; break;
    case "mistake": why = "Costs about " + pw + ". There was a clearly stronger move — tap Hint to see it."; break;
    case "blunder": why = "A serious error (about " + pw + " lost). Ask what your opponent threatens now, or tap Hint for the better move."; break;
    default: why = "";
  }
  let ev = feedbackEvalPhrase(r.eval_after);
  if (ev && r.cpl >= 50 && /— you are/.test(ev)) ev = ev.replace("— you are", "— you are still");
  return ev ? why + " " + ev : why;
}

function showFeedbackChip(r) {
  const chip = $("feedback-chip");
  chip.className = "feedback-chip " + (FEEDBACK_TONE[r.classification] || "yellow") +
    " q-" + String(r.classification || "good").replace(/[^a-z]/g, "");
  $("feedback-label").textContent =
    FEEDBACK_LABEL[r.classification] || r.classification;
  $("feedback-cpl").textContent = r.cpl > 0 ? "−" + r.cpl + " cp" : "";
  const icon = $("feedback-icon");
  if (icon) icon.textContent = FEEDBACK_ICON[r.classification] || "•";
  const why = $("feedback-why");
  if (why) why.textContent = feedbackWhy(r);
  // Hint only on poor moves — it flashes the best-move arrow, no take-back
  $("btn-feedback-hint").classList.toggle("hidden",
    !(r.classification === "mistake" || r.classification === "blunder"));
  chip.classList.remove("hidden");
}

async function requestMoveFeedback(fen, uci) {
  const seq = ++Feedback.seq;
  try {
    const r = await apiPost("/api/move/feedback",
      { fen, move_uci: uci, depth: 12 });
    if (seq !== Feedback.seq) return; // superseded by a newer move
    Feedback.last = r;
    showFeedbackChip(r);
  } catch (e) {
    if (seq !== Feedback.seq) return;
    Feedback.last = null;
    hideFeedbackChip();
    surfaceEngineError(e);
  }
}

$("btn-feedback-hint").addEventListener("click", () => {
  const r = Feedback.last;
  if (!r || !r.best_uci || r.best_uci.length < 4) return;
  const seq = Feedback.seq;
  playBoard.setArrows([{ from: r.best_uci.slice(0, 2), to: r.best_uci.slice(2, 4), color: "green" }]);
  setTimeout(() => {
    if (seq === Feedback.seq) playBoard.clearArrows();
  }, 2000);
});

async function refreshEvalBar(fen) {
  if (!State.engineOk) return;
  try {
    const a = await apiPost("/api/analyze/position", { fen, depth: 12 });
    setEvalBar(a.eval, fenSide(fen), a.result);
  } catch (e) { surfaceEngineError(e); /* keep old bar */ }
}

function setEvalBar(ev, side, result) {
  // Terminal positions send a string eval ("mate"/"draw") plus the game
  // result: show the string as-is and pin the bar by the result.
  const pct = typeof ev === "string"
    ? (result === "1-0" ? 100 : result === "0-1" ? 0 : 50)
    : evalToWhitePct(ev, side);
  $("eval-fill").style.height = pct + "%";
  // redesign: the bar is drawn from White's side, so label it from White's
  // side too (the engine eval is side-to-move POV)
  const whiteEv = (ev && typeof ev === "object" && side === "b" && typeof ev.value === "number")
    ? Object.assign({}, ev, { value: -ev.value }) : ev;
  $("eval-label").textContent = evalText(whiteEv);
  const bar = $("eval-fill").parentElement;
  if (bar) { bar.classList.toggle("white-ahead", pct >= 50); bar.title = "Evaluation (White's view): " + evalText(whiteEv); }
}

async function analyzePlayPosition() {
  if (Review.active) return; // blocked during mistake review
  const fen = playBoard.getFen();
  const depth = parseInt($("depth-input").value, 10) || 14;
  try {
    const a = await apiPost("/api/analyze/position", { fen, depth });
    setEvalBar(a.eval, fenSide(fen), a.result);
    const list = $("lines-list");
    list.innerHTML = "";
    for (const line of a.lines) {
      const li = document.createElement("li");
      li.textContent = evalText(whitePovEval(line.eval, fenSide(fen))) + "  " + line.moves_san.join(" ");
      list.appendChild(li);
    }
    playBoard.clearArrows();
    clearPlanUi(playPlanCtx); // a fresh analysis replaces any shown plan
    clearDiscussUi(); // a fresh analysis replaces any shown discussion
    if (a.best_move_uci && a.best_move_uci.length >= 4) {
      playBoard.setArrows([{ from: a.best_move_uci.slice(0, 2), to: a.best_move_uci.slice(2, 4), color: "green" }]);
    }
    // the analysis arrows replaced the guided arrow — re-assert it when a
    // guided highlight is showing on the user's guided turn
    reassertGuidedUi();
    Play.lastAnalysis = a;
    Play.lastAnalysis._fen = fen;
    refreshTablebase(fen);
  } catch (e) {
    const eng = await surfaceEngineError(e);
    showError("Analysis failed: " + (eng ? "engine unavailable — see the banner above." : e.message));
  }
}

/* ================= V25 (DUP-2): unified coach panel =================
   ONE coach surface in the Play side panel. The mode chips pick:
     Quick take  — /api/coach/comment on the current position
     Socratic    — the /api/coach/discuss think-first flow
     Free chat   — the /api/coach/chat conversation (default)
   Exactly one mode's output is visible at a time; the input row always
   belongs to Free chat (sending from another mode switches to it). */

const Coach = { mode: "chat" };

function setCoachMode(mode) {
  Coach.mode = mode;
  const chips = {
    quick: $("coach-mode-quick"),
    socratic: $("coach-mode-socratic"),
    chat: $("coach-mode-chat"),
  };
  for (const m in chips) chips[m].classList.toggle("active", m === mode);
  $("coach-comment").classList.toggle("hidden", mode !== "quick");
  $("discuss-panel").classList.toggle("hidden", mode !== "socratic");
  $("chat-messages").classList.toggle("hidden", mode !== "chat");
  $("chat-chips").classList.toggle("hidden", mode !== "chat");
}

$("coach-mode-quick").addEventListener("click", () => {
  if (Review.active) return; // blocked during mistake review
  setCoachMode("quick");
  coachCommentPlay();
});
$("coach-mode-socratic").addEventListener("click", () => {
  if (Review.active) return; // blocked during mistake review
  setCoachMode("socratic");
  if (!Discuss.data) requestDiscuss(); // keep a shown discussion; else ask
});
$("coach-mode-chat").addEventListener("click", () => {
  setCoachMode("chat");
  $("chat-input").focus();
});

/* Quick take: one verified coach comment on the current position. */
async function coachCommentPlay() {
  if (Review.active) return; // blocked during mistake review
  const fen = playBoard.getFen();
  const box = $("coach-comment");
  box.classList.remove("hidden");
  box.textContent = "Thinking…";
  try {
    const body = { fen };
    if (Play.lastAnalysis && Play.lastAnalysis.fen === fen) body.analysis = Play.lastAnalysis;
    const r = await apiPost("/api/coach/comment", body);
    box.textContent = r.commentary +
      (r.persona ? "  (Latvian coach)"
                 : r.source === "template" ? "" : "  (LLM)");
  } catch (e) {
    box.textContent = "Coach unavailable: " + e.message;
  }
}

/* ================= V13: discuss with the coach (Socratic) =================
   Two phases, both fully usable without an LLM:
   1) the coach's Socratic questions (think first), with a reveal button;
   2) the coach's take — the verified checks/captures/threats inventory and
      the candidate moves with their pros and cons, discussion on top
      (LLM voice when enabled, template otherwise). */

const Discuss = { data: null, revealed: false };

function clearDiscussUi() {
  Discuss.data = null;
  Discuss.revealed = false;
  const p = $("discuss-panel");
  p.classList.add("hidden");
  p.innerHTML = "";
}

function renderDiscussQuestions() {
  const panel = $("discuss-panel");
  const data = Discuss.data;
  panel.innerHTML = "";
  panel.classList.remove("hidden");
  const head = document.createElement("div");
  head.className = "plan-head";
  head.textContent = "Discuss with the coach — think first, then reveal";
  panel.appendChild(head);
  const ol = document.createElement("ol");
  ol.className = "discuss-questions";
  (data.socratic || []).forEach(q => {
    const li = document.createElement("li");
    li.className = "discuss-q";
    li.textContent = "Coach: " + q; // textContent only
    ol.appendChild(li);
  });
  panel.appendChild(ol);
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.id = "btn-discuss-reveal";
  reveal.className = "btn primary";
  reveal.textContent = "Show me the coach's take";
  reveal.addEventListener("click", () => {
    Discuss.revealed = true;
    renderDiscussTake();
  });
  panel.appendChild(reveal);
}

function renderDiscussTake() {
  const panel = $("discuss-panel");
  const data = Discuss.data;
  panel.innerHTML = "";
  panel.classList.remove("hidden");
  // keep the questions visible above the answer — the discussion refers to them
  renderDiscussQuestionSummary(panel, data);

  // the coach's monologue (LLM voice over the verified facts, or template)
  if (data.discussion) {
    const box = document.createElement("div");
    box.className = "discuss-discussion";
    const txt = document.createElement("span");
    txt.textContent = data.discussion; // textContent only, never innerHTML
    box.appendChild(txt);
    if (data.persona) {
      const lv = document.createElement("span");
      lv.className = "plan-goal-ai";
      lv.textContent = " (Latvian coach)";
      box.appendChild(lv);
    } else if (data.source === "llm") {
      const ai = document.createElement("span");
      ai.className = "plan-goal-ai";
      ai.textContent = " (AI coach)";
      box.appendChild(ai);
    }
    panel.appendChild(box);
  }

  // checks / captures / threats — the verified inventory
  const cct = data.cct || {};
  const chips = document.createElement("div");
  chips.className = "discuss-cct";
  const addChip = (label, items, cls) => {
    const chip = document.createElement("div");
    chip.className = "discuss-chip " + cls;
    const strong = document.createElement("span");
    strong.className = "discuss-chip-label";
    strong.textContent = label + ": ";
    chip.appendChild(strong);
    const body = document.createElement("span");
    body.textContent = items; // pre-joined plain text
    chip.appendChild(body);
    chips.appendChild(chip);
  };
  const checks = cct.checks || [];
  addChip("Checks", checks.length ? checks.join(" · ") : "none", "checks");
  const caps = cct.captures || [];
  const wins = caps.filter(c => c.cls === "winning")
    .map(c => c.san + " (" + c.label + ")");
  const evens = caps.filter(c => c.cls === "even").map(c => c.san);
  const losers = caps.filter(c => c.cls === "losing").map(c => c.san);
  const capText = (wins.length ? "Winning captures: " + wins.join(" · ") : "")
    + (evens.length ? (wins.length ? " · " : "") + "Even: " + evens.join(" · ") : "")
    + (losers.length ? ((wins.length || evens.length) ? " · " : "") + "Losing: " + losers.join(" · ") : "");
  addChip("Captures", capText || "none", wins.length ? "win" : "quiet");
  const threats = cct.threats || [];
  addChip("Threat", threats.length
    ? threats.map(t => t.san + " — " + t.why).join(" · ")
    : "none concrete", threats.length ? "threat" : "quiet");
  panel.appendChild(chips);

  // candidate cards: rank, SAN + eval, pros / cons
  const cards = document.createElement("div");
  cards.className = "discuss-cands";
  (data.candidates || []).forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "discuss-cand";
    const head2 = document.createElement("span");
    head2.className = "discuss-cand-head";
    head2.textContent = (i + 1) + ". " + c.san + " (" + evalText(c.eval) + ")";
    card.appendChild(head2);
    if (Array.isArray(c.pros) && c.pros.length) {
      const pros = document.createElement("div");
      pros.className = "discuss-pros";
      pros.textContent = "+ " + c.pros.join("; ");
      card.appendChild(pros);
    }
    if (Array.isArray(c.cons) && c.cons.length) {
      const cons = document.createElement("div");
      cons.className = "discuss-cons";
      cons.textContent = "− " + c.cons.join("; ");
      card.appendChild(cons);
    }
    // a non-punishing reply is neutral info — a muted line, never a con
    if (c.reply && c.reply.san) {
      const rep = document.createElement("div");
      rep.className = "discuss-reply";
      rep.textContent = "their likely reply: " + c.reply.san +
        (c.reply.reason ? " — " + c.reply.reason : ""); // textContent only
      card.appendChild(rep);
    }
    cards.appendChild(card);
  });
  panel.appendChild(cards);
}

/* the questions stay on screen in phase 2, collapsed to plain numbered
   lines so the coach's answer can be read against them */
function renderDiscussQuestionSummary(panel, data) {
  const ol = document.createElement("ol");
  ol.className = "discuss-questions compact";
  (data.socratic || []).forEach(q => {
    const li = document.createElement("li");
    li.className = "discuss-q";
    li.textContent = q; // textContent only
    ol.appendChild(li);
  });
  panel.appendChild(ol);
}

async function requestDiscuss() {
  if (Review.active) return; // blocked during mistake review
  const btn = $("coach-mode-socratic"); // one discuss request in flight
  const fen = playBoard.getFen();
  const panel = $("discuss-panel");
  panel.classList.remove("hidden");
  panel.innerHTML = '<div class="info-line">Asking the coach…</div>';
  // honor the Play-tab Depth input (clamped), falling back to 12
  let depth = parseInt($("depth-input").value, 10);
  if (!Number.isFinite(depth)) depth = 12;
  depth = Math.max(6, Math.min(22, depth));
  if (btn) btn.disabled = true; // one discuss request in flight at a time
  try {
    const r = await apiPost("/api/coach/discuss", { fen, depth });
    // board moved on while the engine thought — drop the stale response
    if (playBoard.getFen() !== fen) return;
    if (r.terminal) {
      Discuss.data = null;
      panel.innerHTML = '<div class="info-line">Game over — ' +
        escapeHtml((r.result || "") + (r.reason ? " (" + r.reason + ")" : "")) +
        ". Nothing to discuss here.</div>";
      return;
    }
    Discuss.data = r;
    Discuss.revealed = false;
    renderDiscussQuestions();
  } catch (e) {
    const eng = await surfaceEngineError(e);
    Discuss.data = null;
    panel.innerHTML = '<div class="info-line">' +
      (eng ? "Engine unavailable — see the banner above."
           : "Coach discussion failed: " + escapeHtml(e.message)) + "</div>";
  } finally {
    // re-enable — unless mistake review started while we were in flight
    // (setReviewGuards owns the chip then)
    if (btn) btn.disabled = Review.active;
  }
}

/* ================= V14: coach chat (fully conversational) =================
   Tool-first dialogue: the server parses the student's message, pulls the
   verified facts from the engine-backed tools (candidates, CCT, threats)
   and answers — the optional LLM only rewords. The client keeps ONE
   session (localStorage) across position changes; the next message simply
   carries the current fen and the server invalidates its facts. */

const CHAT_SESSION_KEY = "coach_chat_session";

const Chat = { sessionId: null, inFlight: false, _arrowT: null };

function chatSessionId() {
  if (Chat.sessionId === null) {
    try { Chat.sessionId = localStorage.getItem(CHAT_SESSION_KEY) || ""; }
    catch (_) { Chat.sessionId = ""; }
  }
  return Chat.sessionId || null;
}

function chatStoreSession(id) {
  Chat.sessionId = id || "";
  try {
    if (id) localStorage.setItem(CHAT_SESSION_KEY, id);
    else localStorage.removeItem(CHAT_SESSION_KEY);
  } catch (_) {}
}

/* SAN-shaped token in a coach reply (matched against the reply's
   server-provided move_map — no client-side move generation). */
const CHAT_MOVE_TOKEN =
  /^([KQRBN][a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?|[a-h]x?[a-h][1-8](=[QRBN])?[+#]?|O-O(-O)?[+#]?)$/;

/* flash one move's arrow on the board, then clear it — same single-move
   drawPlan trick as the plan branch clicks */
function chatFlashMove(uci) {
  if (Review.active) return; // review mode owns the board — link is inert
  if (!uci || uci.length < 4) return;
  playBoard.drawPlan([{ uci, side: "player" }], { bottomSide: "player" });
  clearTimeout(Chat._arrowT);
  Chat._arrowT = setTimeout(() => {
    if (Review.active) return; // review entered mid-flash: don't redraw
    if (Play.plan && Play.plan.main_line) {
      playBoard.drawPlan(Play.plan.main_line, { bottomSide: "player" });
    } else {
      playBoard.clearArrows();
    }
  }, 1600);
}

function chatAddBubble(role, text, moveMap, isPersona) {
  const box = $("chat-messages");
  const div = document.createElement("div");
  div.className = "chat-bubble " + role;
  if (role === "coach" && moveMap) {
    // coach text: SAN-like tokens that are legal here become clickable
    // spans; everything else is plain text (textContent, never innerHTML)
    String(text).split(/(\s+)/).forEach(part => {
      const idx = part.search(/[A-Za-z0-9]/);
      if (idx === -1) { div.appendChild(document.createTextNode(part)); return; }
      let end = part.length;
      while (end > idx && /[).,;:!?"']/.test(part[end - 1])) end--;
      const core = part.slice(idx, end);
      if (core && CHAT_MOVE_TOKEN.test(core) && moveMap[core]) {
        if (idx > 0) div.appendChild(document.createTextNode(part.slice(0, idx)));
        const span = document.createElement("span");
        span.className = "chat-move";
        span.textContent = core;
        span.title = "Show this move on the board";
        const uci = moveMap[core];
        span.addEventListener("click", () => chatFlashMove(uci));
        div.appendChild(span);
        if (end < part.length)
          div.appendChild(document.createTextNode(part.slice(end)));
      } else {
        div.appendChild(document.createTextNode(part));
      }
    });
  } else {
    div.textContent = text; // textContent only, never innerHTML
  }
  if (role === "coach") {
    // V34: muted persona marker on persona-worded replies (like the plan's
    // "(AI coach)" span — textContent only)
    if (isPersona) {
      const lv = document.createElement("span");
      lv.className = "plan-goal-ai";
      lv.textContent = " (Latvian coach)";
      div.appendChild(lv);
    }
    // V26: every coach message gets its own speaker button (reads exactly
    // the bubble's text — the voice adds nothing of its own)
    const speak = document.createElement("button");
    speak.type = "button";
    speak.className = "btn mini speak-btn" + (voiceOn() ? "" : " hidden");
    speak.textContent = "🔊";
    speak.title = "Read aloud (coach voice)";
    speak.addEventListener("click", () => speakText(text, speak));
    div.appendChild(speak);
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function chatRenderChips(list) {
  const box = $("chat-chips");
  box.innerHTML = "";
  (list || []).forEach(s => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-chip";
    b.textContent = s; // server-composed suggestion, plain text
    b.addEventListener("click", () => {
      $("chat-input").value = s;
      chatSend(false);
    });
    box.appendChild(b);
  });
}

/* one send in flight at a time; during mistake review setReviewGuards owns
   the controls, so the busy-flag never re-enables them there */
function chatSetBusy(busy) {
  $("btn-chat-send").disabled = busy || Review.active;
  $("chat-input").disabled = busy || Review.active;
}

async function chatSend(implicit) {
  if (Chat.inFlight || Review.active) return;
  const input = $("chat-input");
  const msg = implicit ? "hello" : input.value.trim();
  if (!msg) return;
  setCoachMode("chat"); // the input row always belongs to Free chat
  input.value = "";
  if (!implicit) chatAddBubble("student", msg);
  const thinking = chatAddBubble("coach", "Thinking…");
  thinking.classList.add("thinking");
  Chat.inFlight = true;
  chatSetBusy(true);
  try {
    const body = { fen: playBoard.getFen(), message: msg };
    const sid = chatSessionId();
    if (sid) body.session_id = sid;
    const r = await apiPost("/api/coach/chat", body);
    thinking.remove();
    if (r.session_id) chatStoreSession(r.session_id);
    chatAddBubble("coach", r.reply || "…", r.move_map || {}, !!r.persona);
    chatRenderChips(r.suggestions || []);
  } catch (e) {
    const eng = await surfaceEngineError(e);
    thinking.classList.remove("thinking");
    thinking.textContent = eng
      ? "Engine unavailable — see the banner above."
      : "Coach unavailable: " + e.message; // textContent only
  } finally {
    Chat.inFlight = false;
    chatSetBusy(false);
  }
}

/* first ever open: an implicit "hello" so the coach greets with the
   Socratic checks/captures/threats question (and creates the session) */
function chatInit() {
  if (chatSessionId()) return; // returning conversation — no fresh greeting
  chatSend(true);
}

$("btn-chat-send").addEventListener("click", () => chatSend(false));
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") chatSend(false);
});
$("btn-chat-new").addEventListener("click", () => {
  chatStoreSession(null); // fresh session — the server forgets the old one
  $("chat-messages").innerHTML = "";
  chatRenderChips([]);
  chatSend(true); // implicit hello greets the new conversation
});

$("btn-analyze-pos").addEventListener("click", analyzePlayPosition);
$("btn-show-plan").addEventListener("click", () => {
  // toggle: a second click hides the plan and its board overlay
  if (Play.plan) {
    clearPlanUi(playPlanCtx); playBoard.clearArrows();
    reassertGuidedUi(); // the close also wiped the guided arrow — re-draw it
    return;
  }
  requestPlan(playPlanCtx);
});
$("btn-flip").addEventListener("click", () => {
  playBoard.flip();
  // flip semantics: "bottom side" changed → re-plan for the new bottom side
  if (Play.plan) requestPlan(playPlanCtx);
});

/* ================= Maia "Human moves" panel =================
   Optional Maia engine: when installed, the panel under Top lines shows
   what a player at the selected opponent level would most likely play.
   When absent, a muted install note replaces the panel. */

const Maia = {
  available: null,   // null = status not checked yet
  status: null,      // last /api/maia/status payload (reason, diagnostics)
  seq: 0,            // stale-response guard
  cache: {},         // fen|elo|top_k -> response (panel + review annotation)
};

/* opponent-level selector value → Maia elo (mirrors MAIA_ELO_LEVELS) */
const MAIA_LEVEL_ELO = {
  casual: 1200, club: 1600, advanced: 2000, expert: 2200, masters: 2500,
};

function maiaEloForLevel(level) { return MAIA_LEVEL_ELO[level] || 1600; }

async function initMaia() {
  try {
    const s = await apiGet("/api/maia/status");
    Maia.status = s;
    Maia.available = !!s.available;
  } catch (e) {
    Maia.available = false;
  }
  renderMaiaAvailability();
  if (Maia.available) refreshMaiaPanel(playBoard.getFen());
}

function renderMaiaAvailability() {
  const off = Maia.available === false;
  const note = $("maia-note");
  // v40: the web build never has Maia — don't show a permanent "off" notice
  note.classList.toggle("hidden", !off || !!(State.config && State.config.static_build) || location.protocol !== "file:");
  if (off) {
    if (Maia.status && Maia.status.reason) {
      // surface the backend's real reason (textContent only — contains a path)
      note.textContent = "Human-move predictions off — " + Maia.status.reason;
    } else {
      note.textContent = "Human-move predictions off — Maia models are not available in the web version.";
    }
  }
  $("maia-panel").classList.toggle("hidden", Maia.available !== true);
}

async function fetchMaiaMoves(fen, level, topK) {
  const elo = maiaEloForLevel(level);
  const key = fen + "|" + elo + "|" + topK;
  if (Maia.cache[key]) return Maia.cache[key];
  const r = await apiPost("/api/maia/human-moves", {
    fen, elo_self: elo, elo_oppo: elo, top_k: topK,
  });
  Maia.cache[key] = r;
  return r;
}

async function refreshMaiaPanel(fen) {
  if (Maia.available !== true) return;
  const seq = ++Maia.seq;
  const level = getOpponentLevel();
  try {
    const r = await fetchMaiaMoves(fen, level, 3);
    if (seq !== Maia.seq) return; // position changed while Maia thought
    $("maia-title").textContent =
      "Human moves @ " + (OPP_LEVEL_LABEL[level] || level);
    const host = $("maia-moves");
    host.innerHTML = "";
    const moves = r.moves || [];
    for (const m of moves) {
      const d = document.createElement("div");
      d.className = "info-line";
      d.textContent = m.san + " — " + Math.round(m.prob * 100) + "%";
      host.appendChild(d);
    }
    if (moves.length === 0) {
      host.innerHTML = '<div class="info-line">No prediction for this position.</div>';
    }
  } catch (e) {
    if (seq !== Maia.seq) return;
    if (e.status === 503) { // Maia vanished mid-session → swap to the note
      Maia.available = false;
      renderMaiaAvailability();
      return;
    }
    $("maia-moves").innerHTML = "";
  }
}

/* mistake-review annotation: how often players at this level find the
   moves involved — "Players @ Club: your move 12% · best 43%" */
async function annotateMistakeWithMaia(m) {
  const el = $("review-maia");
  el.textContent = "";
  if (Maia.available !== true) return; // silent skip when unavailable
  const level = getOpponentLevel();
  const seq = ++Review.maiaSeq;
  try {
    const r = await fetchMaiaMoves(m.fen_before, level, 8);
    if (seq !== Review.maiaSeq || !Review.active) return;
    const probOf = (uci) => {
      const hits = (r.moves || []).filter(x => x.uci === uci);
      return hits.length ? Math.round(hits[0].prob * 100) + "%" : "<1%";
    };
    el.textContent = "Players @ " + (OPP_LEVEL_LABEL[level] || level) +
      ": your move " + probOf(m.uci) + " · best " + probOf(m.best_uci);
  } catch (e) { /* annotation is optional — stay silent */ }
}

/* ================= tablebase chip (<=7 pieces) =================
   After each position/analysis refresh on the Play tab: exact endgame
   verdict from the Syzygy tablebase. Any failure hides the chip silently. */

const Tablebase = { seq: 0 };

function fenPieceCount(fen) {
  let n = 0;
  for (const ch of fen.split(" ")[0]) {
    if (ch !== "/" && !/\d/.test(ch)) n++;
  }
  return n;
}

function hideTablebaseChip() { $("tb-chip").classList.add("hidden"); }

async function refreshTablebase(fen) {
  const seq = ++Tablebase.seq;
  if (fenPieceCount(fen) > 7) { hideTablebaseChip(); return; }
  try {
    const r = await apiGet("/api/tablebase?fen=" + encodeURIComponent(fen));
    if (seq !== Tablebase.seq) return;
    if (!r.available) { hideTablebaseChip(); return; }
    $("tb-chip-label").textContent = "Tablebase: " + (r.category || "?") +
      (r.dtz != null ? " (DTZ " + r.dtz + ")" : "");
    const host = $("tb-moves");
    host.innerHTML = "";
    (r.moves || []).slice(0, 3).forEach((m, i) => {
      const d = document.createElement("div");
      d.textContent = (i + 1) + ". " + (m.san || m.uci) +
        (m.category ? " — " + m.category : "") +
        (m.dtz != null ? " (DTZ " + m.dtz + ")" : "");
      host.appendChild(d);
    });
    $("tb-chip").classList.remove("hidden");
  } catch (e) {
    if (seq === Tablebase.seq) hideTablebaseChip(); // offline etc. — silent
  }
}

/* panels that follow the board position (Maia + tablebase) */
function refreshPositionExtras(fen) {
  refreshMaiaPanel(fen);
  refreshTablebase(fen);
}

/* reset the whole Play-tab game to an arbitrary FEN (New game / Load FEN) */
function playResetTo(fen) {
  Play.moves = [];
  Play.lastAnalysis = null;
  Play.viewPly = 0;
  Play.startFen = fen;
  playBoard.setFen(fen);
  playBoard.setLastMove(null, null);
  playBoard.clearArrows();
  clearPlanUi(playPlanCtx);
  clearDiscussUi(); // new game / FEN load — hide any shown discussion
  renderPlayMoves();
  updatePlayNav();
  $("play-history-note").classList.add("hidden");
  $("lines-list").innerHTML = "";
  $("coach-comment").classList.add("hidden");
  setEvalBar(null, fenSide(fen));
  Feedback.seq++; // drop any in-flight verdict for the old position
  hideFeedbackChip();
  refreshEvalBar(fen);
  refreshPositionExtras(fen);
}

$("btn-new-game").addEventListener("click", () => {
  if (Review.active) exitReview(); // a fresh game implicitly ends the review
  // a fresh startpos game ends ad-hoc practice (it has no line to rehearse);
  // the named opening modes keep surviving "New game" as before
  if (Rehearsal.active === "custom") rehearsalExit();
  playResetTo(PLAY_START_FEN);
  if (!Rehearsal.active && typeof mySide === "function") playBoard.setOrientation(mySide());
  $("play-fen-input").value = "";
  $("play-fen-status").textContent = "";
  // "New game" re-starts the run from move 1 — re-show the guided highlight
  // (it otherwise stayed hidden for the rest of the run after "Hide guide")
  Rehearsal.hideGuide = false;
  // an active rehearsal mode survives "New game" and re-starts from move 1
  rehearsalReanchor(Rehearsal.active ? REHEARSAL_MODES[Rehearsal.active].hint : "");
});

/* paste-any-FEN analysis: validate client-side (same pattern as the
   Strategy Lab loader), then reset the Play tab to that position */
$("btn-load-fen").addEventListener("click", () => {
  const fen = $("play-fen-input").value.trim();
  const status = $("play-fen-status");
  if (!fenLooksValid(fen)) { status.textContent = "That FEN does not look valid."; return; }
  if (Review.active) exitReview(); // loading a position ends the review
  playResetTo(fen);
  status.textContent = "Position loaded.";
  $("rehearsal-pgn-status").textContent = ""; // drop stale "Loaded N move(s)."
  // inside a rehearsal mode the app answers from the loaded position
  rehearsalReanchor("Position loaded — your move.");
});

/* ================= Opening Rehearsal mode =================
   Fixed training setups on the Play board (plus ad-hoc practice). Each named
   mode first walks its guided opening line with the user — the app plays the
   scripted book replies and the user's prescribed moves are highlighted —
   then the app plays one side with the most common human replies
   (/api/rehearsal/opponent-move — popularity-weighted among the top N at the
   selected opponent level). Take-back, PGN/FEN setup and all analyze/plan
   tools keep working from rehearsal positions. Client-side history:
   Play.moves / Play.startFen, with Rehearsal.basePly as the take-back floor. */

/* V31 guided lead-in: each named mode carries its opening ``line`` (uci
   from the standard start) with a curated parallel ``lineSan`` (no client
   chess lib — pinned by tests against python-chess). While the played plies
   still match the line prefix the app plays the scripted replies (server:
   source "script") and the user's prescribed move is highlighted; after the
   line (or a deviation) the most popular replies take over as before. Each
   skipFen is exactly the position after the full line, so "Skip to opening"
   lands where the guided phase ends. */
const REHEARSAL_MODES = {
  modern: {
    userSide: "black",
    startFen: PLAY_START_FEN, // app (White) moves first
    line: ["e2e4", "g7g6", "d2d4", "f8g7"],
    lineSan: ["e4", "g6", "d4", "Bg7"],
    skipFen: "rnbqk1nr/ppppppbp/6p1/8/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 1 3", // after 1.e4 g6 2.d4 Bg7
    banner: "Modern Defense — you are Black. The app walks through 1.e4 g6 2.d4 Bg7 with you — your moves are highlighted; then it plays the most common replies.",
    hint: "White opens — then it's your move.",
  },
  grunfeld: {
    userSide: "black",
    startFen: PLAY_START_FEN, // app (White) moves first
    line: ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "d7d5"],
    lineSan: ["d4", "Nf6", "c4", "g6", "Nc3", "d5"],
    skipFen: "rnbqkb1r/ppp1pp1p/5np1/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq d6 0 4", // after 1.d4 Nf6 2.c4 g6 3.Nc3 d5
    banner: "Grünfeld Defense — you are Black. The app walks through 1.d4 Nf6 2.c4 g6 3.Nc3 d5 with you — your moves are highlighted; then it plays the most common replies.",
    hint: "White opens — aim for 1.d4 Nf6 2.c4 g6 3.Nc3 d5, or skip straight there.",
  },
  scotch: {
    userSide: "white",
    startFen: PLAY_START_FEN, // user moves first
    line: ["e2e4", "e7e5", "g1f3", "b8c6", "d2d4"],
    lineSan: ["e4", "e5", "Nf3", "Nc6", "d4"],
    skipFen: "r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 3", // after 1.e4 e5 2.Nf3 Nc6 3.d4
    banner: "Scotch Gambit — you are White. The app walks through 1.e4 e5 2.Nf3 Nc6 3.d4 with you — your moves are highlighted; then the most common replies take over.",
    hint: "Your move — aim for 1.e4 e5 2.Nf3 Nc6 3.d4, or skip straight there.",
  },
  qga: {
    userSide: "black",
    startFen: PLAY_START_FEN, // app (White) moves first
    line: ["d2d4", "d7d5", "c2c4", "d5c4"],
    lineSan: ["d4", "d5", "c4", "dxc4"],
    skipFen: "rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3", // after 1.d4 d5 2.c4 dxc4
    banner: "Queen's Gambit Accepted — you are Black. The app walks through 1.d4 d5 2.c4 dxc4 with you — your moves are highlighted; then the most common replies take over.",
    hint: "White opens — aim for 1.d4 d5 2.c4 dxc4, or skip straight there.",
  },
  qgaw: {
    userSide: "white",
    startFen: PLAY_START_FEN, // user moves first
    line: ["d2d4", "d7d5", "c2c4", "d5c4"],
    lineSan: ["d4", "d5", "c4", "dxc4"],
    skipFen: "rnbqkbnr/ppp1pppp/8/8/2pP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3", // after 1.d4 d5 2.c4 dxc4
    banner: "Queen's Gambit Accepted — you are White. The app walks through 1.d4 d5 2.c4 dxc4 with you — your moves are highlighted; then the most common replies take over.",
    hint: "Your move — aim for 1.d4 d5 2.c4 dxc4, or skip straight there.",
  },
  /* ad-hoc "Practice from here" mode — every field is overwritten by
     startPracticeFrom() at each launch; no line, no skipFen, no mode button */
  custom: {
    userSide: "white",
    startFen: PLAY_START_FEN,
    banner: "",
    hint: "",
  },
};

const Rehearsal = {
  active: null,       // null | "modern" | "scotch" | "qga" | "qgaw" | "custom"
  busy: false,        // /api/rehearsal/opponent-move in flight
  gameOver: false,    // terminal position reached in a mode
  gameOverText: "",   // last game-over line (re-shown on further clicks)
  basePly: 0,         // take-back floor (plies below are a loaded game's)
  seq: 0,             // bumped on reset/take-back/exit — drops stale replies
  hideGuide: false,   // V31: user hid the guided highlight for this run
};

/* ================= V31 guided lead-in =================
   Guided progress is a PURE function of the played plies since the mode
   start (Play.moves above Rehearsal.basePly) vs the mode's line prefix —
   no extra state, so take-back re-enters the guided phase automatically.
   on-script  ⇔  every played ply matches the line prefix AND the line is
   not exhausted. Only meaningful for a FRESH standard-start run: a
   headerless PGN re-anchor also leaves Play.startFen string-equal to
   PLAY_START_FEN, but its loaded history moves the floor above 0 — the
   basePly === 0 requirement keeps the guide off that mid-game board.
   ("New game" re-anchors at true startpos with basePly 0 → guide on.) */
function rehearsalModeLine() {
  const mode = Rehearsal.active && REHEARSAL_MODES[Rehearsal.active];
  return (mode && mode.line && Play.startFen === PLAY_START_FEN &&
    Rehearsal.basePly === 0) ? mode : null;
}

function guidedPly() { // count of leading played plies matching the line
  const mode = rehearsalModeLine();
  if (!mode) return 0;
  let n = 0;
  while (Rehearsal.basePly + n < Play.moves.length &&
         n < mode.line.length &&
         Play.moves[Rehearsal.basePly + n].uci === mode.line[n]) n++;
  return n;
}

function guidedOnScript() {
  const mode = rehearsalModeLine();
  if (!mode) return false;
  const n = guidedPly();
  return n === Play.moves.length - Rehearsal.basePly && n < mode.line.length;
}

/* line played through exactly to its end (skip lands here too) */
function guidedLineComplete() {
  const mode = rehearsalModeLine();
  return !!mode && guidedPly() === mode.line.length &&
    Play.moves.length - Rehearsal.basePly === mode.line.length;
}

/* the prescribed user move at the current guided ply, or null */
function guidedUserMove() {
  const mode = rehearsalModeLine();
  if (!mode || !guidedOnScript() || Rehearsal.gameOver) return null;
  if (Play.viewPly !== Play.moves.length) return null; // history view
  if (fenSide(playBoard.getFen()) === rehearsalAppSide()) return null; // app's turn
  const k = guidedPly();
  const userIsWhite = mode.userSide === "white";
  let n = 0, total = 0;
  for (let i = 0; i < mode.line.length; i++) {
    if ((i % 2 === 0) === userIsWhite) { total++; if (i <= k) n++; }
  }
  return { uci: mode.line[k], san: mode.lineSan[k], n, total };
}

function clearGuidedHighlight() {
  playBoard.setGuided([]);
  playBoard.clearArrows();
  $("btn-rehearsal-hide-guide").classList.add("hidden");
}

/* highlight the prescribed move (blue arrow + pulsing squares) and own the
   status line on the user's guided turn; returns false when the guided UI
   is inactive (off-script, line over, game over, or hidden by the user) so
   the caller falls back to its default status */
function refreshGuidedUi() {
  clearGuidedHighlight();
  if (Rehearsal.hideGuide) return false;
  const g = guidedUserMove();
  if (!g) return false;
  playBoard.setArrows([{ from: g.uci.slice(0, 2), to: g.uci.slice(2, 4), color: "blue" }]);
  playBoard.setGuided([g.uci.slice(0, 2), g.uci.slice(2, 4)]);
  $("btn-rehearsal-hide-guide").classList.remove("hidden");
  setRehearsalStatus(null, "Guided line — play " + g.san +
    " (" + g.n + " of " + g.total + ")");
  return true;
}

/* arrows drawn over the board by other tools (plan-toggle close, analysis
   best move) wipe the guided arrow while the guided squares/status stay —
   re-assert the guided UI, but only when a guided highlight was actually
   showing (refreshGuidedUi re-derives everything from state, so it is a
   no-op off the user's guided turn and respects Rehearsal.hideGuide) */
function reassertGuidedUi() {
  if (Rehearsal.active && !Rehearsal.hideGuide && guidedUserMove()) {
    refreshGuidedUi();
  }
}

function rehearsalAppSide() { // "w" | "b" — the side the app plays
  return REHEARSAL_MODES[Rehearsal.active].userSide === "white" ? "b" : "w";
}

function rehearsalAppName() { return rehearsalAppSide() === "w" ? "White" : "Black"; }

function getRehearsalTopN() {
  try {
    const v = parseInt(localStorage.getItem("rehearsal_top_n"), 10);
    if (v >= 1 && v <= 3) return v;
  } catch (_) { /* storage unavailable — fall through */ }
  return 3;
}

function setRehearsalStatus(kind, msg) {
  const el = $("rehearsal-status");
  el.classList.remove("error", "over");
  if (kind) el.classList.add(kind);
  el.innerHTML = "";
  if (kind === "thinking") {
    const sp = document.createElement("span");
    sp.className = "rehearsal-spinner";
    el.appendChild(sp);
  }
  el.appendChild(document.createTextNode(msg || ""));
}

/* game-over hint: offer take-back only when there are plies above the
   reanchor floor — e.g. a FINISHED game just loaded into the mode sits AT
   the floor, where take-back is a no-op, so only Restart makes sense */
function rehearsalGameOverHint() {
  return Play.moves.length > Rehearsal.basePly
    ? " Take back (b) or restart the mode."
    : " Restart the mode to play again.";
}

function rehearsalGameOver(result, reason) {
  Rehearsal.gameOver = true;
  clearGuidedHighlight(); // the mode run is over — no prescribed move to show
  if (result != null || reason != null) {
    Rehearsal.gameOverText = "Game over — " + (result || "?") +
      (reason ? " (" + reason + ")" : "") + "." + rehearsalGameOverHint();
  }
  setRehearsalStatus("over", Rehearsal.gameOverText ||
    ("Game over." + rehearsalGameOverHint()));
}

function renderRehearsalPanel() {
  const active = Rehearsal.active;
  $("rehearsal-active").classList.toggle("hidden", !active);
  $("rehearsal-mode-tag").classList.toggle("hidden", !active);
  // "Skip to opening" is meaningless in the ad-hoc practice mode (no skipFen)
  $("btn-rehearsal-skip").classList.toggle("hidden", active === "custom");
  document.querySelectorAll(".rehearsal-mode-btn").forEach(b => b.classList.remove("active"));
  if (active) {
    const mode = REHEARSAL_MODES[active];
    $("rehearsal-banner").textContent = mode.banner;
    $("rehearsal-mode-tag").textContent = {
      modern: "Modern Defense",
      grunfeld: "Grünfeld Defense",
      scotch: "Scotch Gambit",
      qga: "Queen's Gambit Accepted",
      qgaw: "Queen's Gambit Accepted (White)",
      custom: "Practice position",
    }[active];
    // custom practice has no mode button — guard the lookup
    const modeBtn = $("btn-mode-" + active);
    if (modeBtn) modeBtn.classList.add("active");
  }
}

/* activate (or restart) a mode, optionally from a custom start FEN */
function rehearsalStart(modeKey, fen, hint) {
  if (Review.active) exitReview(); // a rehearsal ends any active mistake review
  const mode = REHEARSAL_MODES[modeKey];
  // a (re)start / mode switch drops any stale guided highlight from the old
  // run — refreshGuidedUi re-draws it below when the new run starts guided
  clearGuidedHighlight();
  Rehearsal.active = modeKey;
  Rehearsal.busy = false;
  Rehearsal.gameOver = false;
  Rehearsal.gameOverText = "";
  Rehearsal.seq++;
  Rehearsal.hideGuide = false; // a (re)start re-shows the guided highlight
  playResetTo(fen || mode.startFen);
  Rehearsal.basePly = Play.moves.length; // 0 right after playResetTo
  $("rehearsal-pgn-status").textContent = ""; // drop stale "Loaded N move(s)."
  playBoard.setOrientation(mode.userSide);
  $("rehearsal-body").classList.remove("hidden");
  $("rehearsal-caret").textContent = "▾";
  $("rehearsal-toggle").setAttribute("aria-expanded", "true");
  renderRehearsalPanel();
  rehearsalMaybeReply(hint || mode.hint);
}

/* after a (re)anchor inside a mode: show whose move it is and let the app
   move immediately when the position is on the app's turn */
function rehearsalMaybeReply(hint) {
  if (!Rehearsal.active) return;
  if (fenSide(playBoard.getFen()) === rehearsalAppSide()) {
    rehearsalRequestOpponentMove();
  } else {
    // on the user's guided turn the prescribed move is highlighted and the
    // status names it; otherwise the mode's hint line
    if (!refreshGuidedUi()) setRehearsalStatus(null, hint || "Your move.");
    rehearsalCheckTerminal(); // the user's position may already be over
  }
}

/* user-to-move branch of rehearsalMaybeReply: a practice-from position or
   a loaded FINISHED game can already be game over. The terminal answer of
   /api/rehearsal/opponent-move is only asked on the APP's turn, so check
   explicitly here (same Rehearsal.seq staleness guard as the app reply).
   Errors are ignored (offline tolerance) — the board itself still rejects
   illegal moves, so the user can never make a move in a finished game. */
async function rehearsalCheckTerminal() {
  if (!Rehearsal.active || Rehearsal.gameOver) return;
  const fen = playBoard.getFen();
  const seq = Rehearsal.seq;
  try {
    const r = await apiPost("/api/board/status", { fen });
    // stale (take-back / reset / exit) or the board moved on — drop
    if (seq !== Rehearsal.seq || !Rehearsal.active ||
        playBoard.getFen() !== fen) return;
    if (r.terminal) rehearsalGameOver(r.result, r.reason);
  } catch (_) { /* offline tolerance — the user can still try to play */ }
}

/* New game / Load FEN / Load PGN while a mode is active: the mode stays on,
   history so far becomes the take-back floor, app answers from here */
function rehearsalReanchor(hint) {
  if (!Rehearsal.active) return;
  Rehearsal.seq++;
  Rehearsal.busy = false;
  Rehearsal.gameOver = false;
  Rehearsal.gameOverText = "";
  Rehearsal.basePly = Play.moves.length;
  rehearsalMaybeReply(hint);
}

async function rehearsalRequestOpponentMove(note) {
  if (!Rehearsal.active || Rehearsal.busy || Rehearsal.gameOver) return;
  const appName = rehearsalAppName();
  const fen = playBoard.getFen();
  const seq = Rehearsal.seq;
  Rehearsal.busy = true;
  setRehearsalStatus("thinking", appName + " is thinking…");
  try {
    const body = {
      fen, opponent_level: getOpponentLevel(), top_n: getRehearsalTopN(),
    };
    // V31: always send the mode's line while it has one — the server answers
    // from the script while the position is on a prefix and falls through to
    // the popular-reply flow after a deviation or when the line is exhausted,
    // so there is no client-side on/off switching to keep in sync.
    const mode = REHEARSAL_MODES[Rehearsal.active];
    if (mode && mode.line) body.script = mode.line;
    const r = await apiPost("/api/rehearsal/opponent-move", body);
    // board moved on while the app was "thinking" (take-back / reset / exit)
    if (seq !== Rehearsal.seq || !Rehearsal.active || playBoard.getFen() !== fen) return;
    if (r.terminal) { rehearsalGameOver(r.result, r.reason); return; }
    // fen_after is the position AFTER the app's reply — the "fen" echo is
    // the PRE-move request position (using it reset the board and orphaned
    // the move list). Older backends without fen_after: apply the uci
    // through the same validated /api/move path the user's moves use.
    let fenAfter = r.fen_after;
    let san = r.san;
    if (!fenAfter) {
      const mv = await apiPost("/api/move", { fen, move_uci: r.uci });
      if (!mv.legal) throw new Error("the app's reply " + r.uci + " was rejected");
      fenAfter = mv.fen_after;
      san = mv.san;
    }
    Play.moves.push({ san: san, uci: r.uci, fen_after: fenAfter, classification: null });
    playBoard.setFen(fenAfter);
    playBoard.setLastMove(r.uci.slice(0, 2), r.uci.slice(2, 4));
    playBoard.clearArrows(); // also clears any plan arrows
    clearPlanUi(playPlanCtx);
    clearDiscussUi(); // position changed — any shown discussion is stale
    Play.viewPly = Play.moves.length;
    renderPlayMoves();
    updatePlayNav();
    // V30 provenance line: where the app's reply came from (textContent
    // only — setRehearsalStatus never injects HTML)
    let msg;
    if (r.source === "script") {
      // V31 guided lead-in: the app walked the prescribed book move
      msg = "Guided line — " + appName + " plays " + san + " (book)";
    } else {
      msg = appName + " played " + san;
      if (r.source === "stockfish") {
        msg += " — engine line" + (r.rank != null ? " #" + r.rank : "");
      } else if (r.branch_source === "maia") {
        msg += " — Maia #" + r.rank + " choice";
        if (r.maia_elo && r.maia_elo.elo_self != null) msg += " @ " + r.maia_elo.elo_self;
      } else if (r.rank != null) {
        msg += " — #" + r.rank + " most common";
        if (r.pct != null) {
          msg += " (" + fmtPct(r.pct) + "% of " +
            (OPP_LEVEL_LABEL[getOpponentLevel()] || "level") + " games";
          msg += r.games != null ? ", " + fmtGames(r.games) + " games)" : ")";
        }
      }
    }
    if (note) msg = note + " " + msg; // e.g. the off-the-script notice
    setRehearsalStatus(null, msg);
    // V31 guided transitions after the app's reply: the line is played
    // through exactly (the user made the final line move, or the scripted
    // reply was the last one) → announce the opening; mid-line → highlight
    // the next prescribed user move.
    if (guidedLineComplete()) {
      setRehearsalStatus(null, msg +
        " Opening reached — from here the app plays the most popular replies.");
    } else if (r.source === "script") {
      refreshGuidedUi(); // keeps msg when the guide is hidden
    }
    refreshPositionExtras(fenAfter);
    // the app's move may have ended the game — this one analysis call doubles
    // as the eval-bar refresh and the terminal check
    rehearsalRefreshEval(fenAfter);
  } catch (e) {
    if (seq !== Rehearsal.seq || !Rehearsal.active) return; // stale — dropped
    clearGuidedHighlight(); // no reply coming — don't leave the guide pulsing
    const eng = await surfaceEngineError(e);
    setRehearsalStatus("error", "Couldn't get " + appName + "'s move: " +
      (eng ? "engine unavailable — see the banner above." : e.message) + " ");
    const retry = document.createElement("span");
    retry.className = "rehearsal-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => rehearsalRequestOpponentMove());
    $("rehearsal-status").appendChild(retry);
  } finally {
    if (seq === Rehearsal.seq) Rehearsal.busy = false;
  }
}

async function rehearsalRefreshEval(fen) {
  if (!State.engineOk) return;
  try {
    const a = await apiPost("/api/analyze/position", { fen, depth: 12 });
    setEvalBar(a.eval, fenSide(fen), a.result);
    if (a.terminal && Rehearsal.active) rehearsalGameOver(a.result, a.reason);
  } catch (e) { surfaceEngineError(e); /* keep old bar */ }
}

/* undo the last move PAIR (user move + app reply), or the last single move
   when only one side has moved since the floor (mode start / failed reply).
   Works repeatedly back to Rehearsal.basePly; if the app ends up to move
   (e.g. Modern mode start), it answers again — possibly a different line. */
function rehearsalTakeBack() {
  if (!Rehearsal.active) return;
  const appSide = rehearsalAppSide();
  const floor = Rehearsal.basePly;
  if (Play.moves.length <= floor) {
    setRehearsalStatus(null, "Nothing to take back — this is the start of the rehearsal.");
    return;
  }
  Rehearsal.seq++; // drop any in-flight app reply
  Rehearsal.busy = false;
  Rehearsal.gameOver = false;
  Rehearsal.gameOverText = "";
  const lastIdx = Play.moves.length - 1;
  const lastMover = fenSide(playFenAt(lastIdx)); // side that made the last move
  let remove = 1;
  if (lastMover === appSide && lastIdx - 1 >= floor &&
      fenSide(playFenAt(lastIdx - 1)) !== appSide) {
    remove = 2; // the app's reply plus the user's move before it
  }
  Play.moves.length = lastIdx + 1 - remove;
  renderPlayMoves();
  playGoToPly(Play.moves.length); // redraws board, nav, last move, eval bar
  $("play-history-note").classList.add("hidden");
  if (fenSide(playBoard.getFen()) === appSide) {
    rehearsalRequestOpponentMove();
  } else if (!refreshGuidedUi()) {
    // take-back re-enters the guided phase automatically when the plies
    // again match the line prefix (refreshGuidedUi then owns the status)
    setRehearsalStatus(null, "Taken back — your move; try a different approach.");
  }
}

function rehearsalExit() {
  Rehearsal.active = null;
  Rehearsal.busy = false;
  Rehearsal.gameOver = false;
  Rehearsal.gameOverText = "";
  Rehearsal.seq++;
  clearGuidedHighlight();
  renderRehearsalPanel();
  setRehearsalStatus(null, "");
  $("rehearsal-pgn-status").textContent = ""; // drop stale "Loaded N move(s)."
}

/* Load PGN onto the Play board (works with or without an active mode):
   board jumps to the final position, full move list navigable via the
   existing ⏮ ◀ ▶ ⏭ controls. */
async function rehearsalLoadPgn() {
  if (Review.active) exitReview(); // loading a game ends any active mistake review
  const pgn = $("rehearsal-pgn-input").value.trim();
  const status = $("rehearsal-pgn-status");
  if (!pgn) { status.textContent = "Paste a PGN first."; return; }
  status.textContent = "Loading…";
  try {
    const r = await apiPost("/api/board/from-pgn", { pgn });
    if (r.ok === false) { status.textContent = "Could not read that PGN."; return; }
    const moves = r.moves || [];
    // ply-0 position: the PGN's FEN header if present, else the standard start
    Play.startFen = parsePgn(pgn).startFen;
    Play.moves = moves.map(m => ({ san: m.san, uci: m.uci, fen_after: m.fen, classification: null }));
    Play.lastAnalysis = null;
    playBoard.setLastMove(null, null);
    playBoard.clearArrows();
    clearPlanUi(playPlanCtx);
    clearDiscussUi(); // new game loaded — hide any shown discussion
    $("lines-list").innerHTML = "";
    $("coach-comment").classList.add("hidden");
    renderPlayMoves();
    playGoToPly(Play.moves.length); // jump straight to the final position
    const h = r.headers || {};
    const named = (h.white && h.white !== "?") || (h.black && h.black !== "?");
    status.textContent = "Loaded " + moves.length + " move(s)" +
      (named ? " — " + (h.white || "?") + " vs " + (h.black || "?") : "") + ".";
    $("rehearsal-pgn-box").classList.add("hidden");
    rehearsalReanchor("Game loaded — your move from here.");
  } catch (e) {
    status.textContent = e.detail === "invalid_pgn"
      ? "That PGN could not be parsed."
      : "PGN load failed: " + e.message;
  }
}

$("rehearsal-toggle").addEventListener("click", () => {
  const closed = $("rehearsal-body").classList.toggle("hidden");
  $("rehearsal-caret").textContent = closed ? "▸" : "▾";
  $("rehearsal-toggle").setAttribute("aria-expanded", String(!closed));
});
$("btn-mode-modern").addEventListener("click", () => rehearsalStart("modern"));
$("btn-mode-grunfeld").addEventListener("click", () => rehearsalStart("grunfeld"));
$("btn-mode-scotch").addEventListener("click", () => rehearsalStart("scotch"));
$("btn-mode-qga").addEventListener("click", () => rehearsalStart("qga"));
$("btn-mode-qgaw").addEventListener("click", () => rehearsalStart("qgaw"));
$("btn-rehearsal-hide-guide").addEventListener("click", () => {
  // suppress the guided highlight for the rest of this run (self-testing);
  // Restart mode re-enables it (Rehearsal.hideGuide reset in rehearsalStart)
  Rehearsal.hideGuide = true;
  clearGuidedHighlight();
  setRehearsalStatus(null, "Guide hidden — your move.");
});
$("btn-rehearsal-skip").addEventListener("click", () => {
  if (!Rehearsal.active) return;
  rehearsalStart(Rehearsal.active, REHEARSAL_MODES[Rehearsal.active].skipFen, "Opening position loaded.");
});
$("btn-rehearsal-takeback").addEventListener("click", rehearsalTakeBack);
$("btn-rehearsal-restart").addEventListener("click", () => {
  if (Rehearsal.active) rehearsalStart(Rehearsal.active);
});
$("btn-rehearsal-exit").addEventListener("click", rehearsalExit);
$("rehearsal-topn").addEventListener("change", (e) => {
  const v = parseInt(e.target.value, 10);
  if (v >= 1 && v <= 3) {
    try { localStorage.setItem("rehearsal_top_n", String(v)); } catch (_) {}
  }
});
$("btn-rehearsal-pgn").addEventListener("click", () => {
  $("rehearsal-pgn-box").classList.toggle("hidden");
  $("rehearsal-pgn-status").textContent = "";
});
$("btn-rehearsal-pgn-cancel").addEventListener("click", () => {
  $("rehearsal-pgn-box").classList.add("hidden");
});
$("btn-rehearsal-pgn-load").addEventListener("click", rehearsalLoadPgn);

/* 'b' = take back (only on the Play tab, only inside a mode) */
document.addEventListener("keydown", (e) => {
  if (e.key !== "b" && e.key !== "B") return;
  const t = e.target;
  if (t && ((t.closest && t.closest("input, textarea, select")) || t.isContentEditable)) return;
  if (!Rehearsal.active || !$("tab-play").classList.contains("active")) return;
  e.preventDefault();
  rehearsalTakeBack();
});

$("rehearsal-topn").value = String(getRehearsalTopN());

/* ================= Mistake Review mode =================
   Entered from My Games ("Review mistakes"): the Play board shows each
   poor move's position oriented to the mover, with the move actually
   played (red arrow) vs the engine's best (green arrow). ◀ ▶ steps
   through the mistakes; Exit restores the previous Play position. Like
   rehearsal mode, the plan/analysis tools are blocked while active. */

const Review = {
  active: false,
  mistakes: [],   // mistakes[] from /api/mistakes/scan
  idx: 0,
  gameLabel: "",
  saved: null,    // Play-tab snapshot restored on exit
  maiaSeq: 0,     // stale-response guard for the Maia annotation
};

/* enter mistake review on the Play tab for a My Games row.
   V25 (DUP-4): a cached Game-review analysis for the SAME game is reused
   (no second engine pass); /api/mistakes/scan runs ONLY when the game was
   never analyzed. */
async function reviewGameMistakes(game, btn) {
  // never bypass (or clobber) a coach-locked post-mortem with engine truth
  if (typeof PM !== "undefined" && PM.active) return;
  // DUP-4 spoiler guard: an unfinished post-mortem on file for this game?
  if (!(await pmSpoilerConfirm(game))) return;
  pmExit(); // the Play-tab mistake review supersedes any post-mortem
  const status = $("game-analysis-status");
  const cached = (Games.review && Games.review.game &&
                  Games.review.game.pgn === game.pgn)
    ? Games.review.analysis : null;
  if (cached) {
    const mistakes = mistakesFromAnalysis(cached);
    if (mistakes.length === 0) {
      status.textContent = "No mistakes found in this game — nicely played!";
      return;
    }
    status.textContent = "";
    State.lastScanMistakes = mistakes;
    updateFcAddButton();
    let label = (cached.white || "White") + " vs " + (cached.black || "Black") +
      (cached.result && cached.result !== "*" ? " · " + cached.result : "");
    // review-fix (MED-1): same caveat the scan path shows — a cloud-served
    // analysis only covers the first 40 moves
    if (cached.provider === "cloud") {
      label = "Cloud analysis — first 40 moves only. " + label;
    }
    enterReview(mistakes, label);
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
  status.textContent = "Scanning game for mistakes (this can take a minute)…";
  try {
    const r = await apiPost("/api/mistakes/scan", { pgn: game.pgn, depth: 12 });
    if (!r.mistakes || r.mistakes.length === 0) {
      status.textContent = "No mistakes found in this game — nicely played!";
      return;
    }
    status.textContent = "";
    // cache the scan for the Puzzles tab's "Add from last mistake scan"
    State.lastScanMistakes = r.mistakes;
    updateFcAddButton();
    let label = (game.white || "White") + " vs " + (game.black || "Black") +
      (r.result && r.result !== "*" ? " · " + r.result : "");
    if (r.provider === "cloud") {
      label = "Cloud analysis — first 40 moves only. " + label;
    }
    enterReview(r.mistakes, label);
  } catch (e) {
    const eng = await surfaceEngineError(e);
    status.textContent = eng
      ? "Scan failed: engine unavailable — see the banner above."
      : "Scan failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Review mistakes"; }
  }
}

function setReviewGuards(on) {
  playBoard.setInteractive(!on);
  $("btn-analyze-pos").disabled = on;
  $("btn-show-plan").disabled = on;
  $("coach-mode-quick").disabled = on;    // all three coach modes are
  $("coach-mode-socratic").disabled = on; // engine-verdict tools — review
  $("coach-mode-chat").disabled = on;     // mode locks them down
  $("chat-input").disabled = on;   // chat is a coach tool — review mode
  $("btn-chat-send").disabled = on; // blocks it like the mode chips
  $("btn-chat-new").disabled = on;  // no fresh session mid-review either
  if (on) clearTimeout(Chat._arrowT); // a pending chat-flash restore must
                                      // not redraw over the review board
}

function enterReview(mistakes, label) {
  if (Rehearsal.active) rehearsalExit();
  Feedback.seq++;      // drop any in-flight verdict so the feedback chip
  hideFeedbackChip();  // can't pop over the review board
  if (!Review.active) {
    // snapshot the Play tab only on entry — re-entering mid-review must not
    // clobber the original snapshot with review-position state
    Review.saved = {
      moves: Play.moves,
      startFen: Play.startFen,
      viewPly: Play.viewPly,
      orientation: playBoard.orientation,
    };
  }
  Review.active = true;
  Review.mistakes = mistakes;
  Review.idx = 0;
  Review.gameLabel = label;
  switchTab("play");
  $("review-game").textContent = label;
  $("review-panel").classList.remove("hidden");
  setReviewGuards(true);
  showMistake(0);
}

function showMistake(i) {
  const n = Review.mistakes.length;
  if (n === 0) return;
  Review.idx = Math.max(0, Math.min(n - 1, i));
  const m = Review.mistakes[Review.idx];
  playResetTo(m.fen_before);
  playBoard.setOrientation(m.color);
  playBoard.setInteractive(false); // reaffirm — review is view-only
  playBoard.setArrows([
    { from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), color: "red" },
    { from: m.best_uci.slice(0, 2), to: m.best_uci.slice(2, 4), color: "green" },
  ]);
  $("review-counter").textContent = "Mistake " + (Review.idx + 1) + " of " + n;
  $("review-title").textContent = m.title || ("Move " + m.move_number + " " + m.san);
  const chip = $("review-class");
  chip.className = "chip " + m.classification;
  chip.textContent = m.classification;
  $("review-moves").textContent = "played " + m.san + " · best was " + m.best_san;
  $("review-eval").textContent = "Eval (White's view): " + evalText(m.eval_before) +
    " → " + evalText(m.eval_after) +
    " — lost about " + (m.cp_loss / 100).toFixed(1) + " pawns";
  $("review-explain").textContent = m.explanation || "";
  $("review-pv").textContent = (m.pv_san && m.pv_san.length)
    ? "Best line: " + m.pv_san.join(" ") : "";
  $("btn-review-prev").disabled = Review.idx === 0;
  $("btn-review-next").disabled = Review.idx === n - 1;
  annotateMistakeWithMaia(m); // silent no-op when Maia is unavailable
  syncSpeakButtons(); // review-explain speaks the mistake explanation
}

function reviewStep(d) { if (Review.active) showMistake(Review.idx + d); }

function exitReview() {
  if (!Review.active) return;
  Review.active = false;
  Review.mistakes = [];
  $("review-panel").classList.add("hidden");
  setReviewGuards(false);
  const s = Review.saved;
  Review.saved = null;
  if (s) {
    Play.moves = s.moves;
    Play.startFen = s.startFen;
    renderPlayMoves();
    playBoard.setOrientation(s.orientation);
    playGoToPly(Math.min(s.viewPly, s.moves.length));
  } else {
    playResetTo(PLAY_START_FEN);
  }
}

$("btn-review-prev").addEventListener("click", () => reviewStep(-1));
$("btn-review-next").addEventListener("click", () => reviewStep(1));
$("btn-review-exit").addEventListener("click", exitReview);

/* ================= Daily training streak =================
   Tracked locally in localStorage: every solved puzzle and every graded
   flashcard marks today as "trained". The header chip shows
   max(local streak, server flashcards current_streak) — the server streak
   only counts flashcard reviews while the local one covers puzzles too,
   so the maximum is the user's true "trained N days in a row" number. */

const STREAK_KEY = "daily_streak_v1"; // {last: "YYYY-MM-DD", count: n}

function streakToday(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - (offsetDays || 0));
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + m + "-" + day;
}

/* live local streak: 0 once the last trained day is older than yesterday */
function localStreak() {
  try {
    const s = JSON.parse(localStorage.getItem(STREAK_KEY) || "null");
    if (!s || !s.last) return 0;
    if (s.last === streakToday(0) || s.last === streakToday(1)) return s.count || 0;
  } catch (_) { /* storage unavailable */ }
  return 0;
}

function markTrainedToday() {
  try {
    const s = JSON.parse(localStorage.getItem(STREAK_KEY) || "null") || {};
    const today = streakToday(0);
    if (s.last === today) {
      // already counted today — nothing to bump
    } else {
      s.count = s.last === streakToday(1) ? (s.count || 0) + 1 : 1;
      s.last = today;
      localStorage.setItem(STREAK_KEY, JSON.stringify(s));
    }
  } catch (_) { /* storage unavailable */ }
  renderStreak();
  if (typeof loadStreak === "function") loadStreak();
}

function renderStreak() {
  const el = $("puzzle-streak");
  const server = (FC.stats && FC.stats.current_streak) || 0;
  // v40: one streak everywhere — the unified training streak when it is known
  let unified = null;
  try { unified = Plan24.streak; } catch (_) { unified = null; } // Plan24 is declared further down
  const n = unified ? unified.current : Math.max(localStreak(), server);
  el.textContent = "🔥 Streak: " + n + (n === 1 ? " day" : " days");
  el.classList.toggle("hidden", n === 0);
}

/* ================= Puzzles tab ================= */

const Puzzles = {
  current: null,      // {id, fen, side_to_move, theme, rating} — merged pool (static + persisted user puzzles)
  set: "all",         // v44: all | my-missed | defend-it  (v46: + knight-h5)
  userMoves: [],      // solver UCIs played so far
  fen: null,          // current board position in puzzle
  done: false,
  busy: false,
  seenIds: [],
  hintLevel: 0,       // 0 = no hint shown, 1/2 = levels already revealed
};

const puzzleBoard = new Board($("puzzle-board"), { onMove: onPuzzleMove });
puzzleBoard.setInteractive(false);

function puzzleInfo() {
  const p = Puzzles.current;
  if (!p) { $("puzzle-info").textContent = "Load a puzzle to begin."; return; }
  let line = "Theme: " + (p.theme || "?") + " · Rating: " + (p.rating || "?") +
    " · You play " + p.side_to_move;
  if (p.explanation) line += " · " + p.explanation;
  if (p.set === "my-missed" || p.set === "defend-it" || (p.id && String(p.id).indexOf("own-") === 0))
    line += " · from your games";
  $("puzzle-info").textContent = line;
  let link = $("puzzle-source-link");
  if (!link) {
    link = document.createElement("a");
    link.id = "puzzle-source-link";
    link.className = "info-line";
    link.target = "_blank";
    link.rel = "noopener";
    $("puzzle-info").after(link);
  }
  if (p.url) {
    link.href = p.url;
    link.textContent = "Open the source game ↗";
    link.classList.remove("hidden");
  } else {
    link.textContent = "";
    link.removeAttribute("href");
    link.classList.add("hidden");
  }
  updatePuzzleHintButton();
  updateQueueInfo();
}

/* merged library counts (static + persisted user puzzles) — refreshed
   after every build, single-game or library (DUP-3: one store) */
function updateQueueInfo() {
  const lib = State.puzzleLibrary;
  $("puzzle-lib-info").textContent = lib
    ? "Library: " + lib.total_puzzles + " puzzles (" + lib.user_puzzles + " from your games)"
    : "";
}

/* merged puzzle-pool size (static + built from your library) — Puzzles tab
   init and after every library build */
async function refreshPuzzleLibraryInfo() {
  try {
    State.puzzleLibrary = await apiGet("/api/puzzles/library-stats");
  } catch (_) {
    State.puzzleLibrary = null;
  }
  updateQueueInfo();
}

function setPuzzleStatus(kind, msg) {
  const b = $("puzzle-status");
  if (!kind) { b.classList.add("hidden"); return; }
  b.className = "banner " + kind;
  b.textContent = msg;
}

async function newPuzzle() {
  if (FC.active) return; // finish (or exit) the flashcard review first
  setPuzzleStatus(null, null);
  Puzzles.userMoves = [];
  Puzzles.done = false;
  Puzzles.hintLevel = 0;
  puzzleBoard.clearArrows();
  puzzleBoard.setLastMove(null, null);
  resetPuzzleHintUI();

  const sel = $("puzzle-rating").value;
  const body = { seen_ids: Puzzles.seenIds, set: Puzzles.set || ($("puzzle-set") && $("puzzle-set").value) || "all" };
  if (sel !== "any") {
    const [lo, hi] = sel.split("-").map(Number);
    body.min_rating = lo; body.max_rating = hi;
  }
  try {
    const p = await apiPost("/api/puzzle/next", body);
    Puzzles.current = { id: p.id, fen: p.fen, side_to_move: p.side_to_move, theme: p.theme, rating: p.rating, url: p.url || null, note: p.note || null, set: p.set || null, explanation: p.explanation || null };
    Puzzles.fen = p.fen;
    Puzzles.seenIds.push(p.id);
    puzzleBoard.setFen(p.fen);
    puzzleBoard.setOrientation(p.side_to_move);
    puzzleBoard.setInteractive(true);
    $("puzzle-progress").textContent = "Find the winning move.";
    puzzleInfo();
  } catch (e) {
    showError("Could not load puzzle: " + e.message);
  }
}

/* ---- V22: graduated hint + reveal/why (server puzzles) ---- */

function resetPuzzleHintUI() {
  $("puzzle-hint").classList.add("hidden");
  $("puzzle-why").classList.add("hidden");
  updatePuzzleHintButton();
  syncSpeakButtons();
}

function updatePuzzleHintButton() {
  // the hint endpoint serves every puzzle in the merged pool (static +
  // persisted user-built u: ids)
  const can = !!(Puzzles.current && !Puzzles.done && Puzzles.hintLevel < 2);
  $("btn-puzzle-hint").disabled = !can;
}

/* after solving / revealing: the computed "why" (zero-hallucination —
   the server composes it from board facts only) */
function showPuzzleWhy(why, context) {
  if (!why || !why.text) return;
  const box = $("puzzle-why");
  // v42: answer the question yourself first; the line and the principle come after
  box.innerHTML = '<div class="why-q"><b>Think first:</b> ' + escapeHtml(why.question || why.text) + "</div>"
    + '<button type="button" class="btn mini why-show">Show the idea</button>'
    + '<div class="why-a hidden">' + (why.line ? '<div class="mt-line">Line: ' + escapeHtml(why.line) + "</div>" : "")
    + (why.principle ? '<div class="why-principle"><b>' + escapeHtml(why.principle.title) + ".</b> " + escapeHtml(why.principle.text) + "</div>" : "")
    + (context ? '<div class="info-line">' + escapeHtml(context) + "</div>" : "") + "</div>";
  box.querySelector(".why-show").addEventListener("click", (e) => { box.querySelector(".why-a").classList.remove("hidden"); e.target.remove(); });
  box.classList.remove("hidden");
  syncSpeakButtons();
}

async function puzzleHint() {
  const P = Puzzles;
  if (FC.active || !P.current || P.done) return;
  const level = Math.min(P.hintLevel + 1, 2);
  try {
    const h = await apiPost("/api/puzzle/hint", { id: P.current.id, level });
    P.hintLevel = level;
    const line = $("puzzle-hint");
    line.textContent = "Hint: " + (h.text || "");
    line.classList.remove("hidden");
    syncSpeakButtons();
  } catch (e) {
    showError("Hint failed: " + e.message);
  } finally {
    updatePuzzleHintButton();
  }
}

async function onPuzzleMove(from, to) {
  if (FC.active) { onFlashcardMove(from, to); return; } // flashcard practice owns the board
  const P = Puzzles;
  if (!P.current || P.done || P.busy) return;
  P.busy = true;
  const uci = uciCandidate(puzzleBoard, from, to);
  const fenBefore = P.fen;
  try {
    const r = await apiPost("/api/move", { fen: fenBefore, move_uci: uci });
    if (!r.legal) { puzzleBoard.shake(); return; }
    await handleServerPuzzleMove(uci, r);
  } catch (e) {
    showError(e.message);
  } finally {
    P.busy = false;
  }
}

async function handleServerPuzzleMove(uci, moveResult) {
  const P = Puzzles;
  P.userMoves.push(uci);
  const att = await apiPost("/api/puzzle/attempt", { id: P.current.id, moves_uci: P.userMoves.slice() });
  if (att.solved) {
    applyPuzzleMove(moveResult, uci);
    P.done = true;
    puzzleBoard.setInteractive(false);
    setPuzzleStatus("green", att.message || "Solved! Well done.");
    $("puzzle-progress").textContent = "Puzzle complete.";
    showPuzzleWhy(att.why, null);
    updatePuzzleHintButton();
    markTrainedToday();
    return;
  }
  if (att.progress >= P.userMoves.length) {
    // correct so far — apply user move, then the opponent's stored reply
    applyPuzzleMove(moveResult, uci);
    $("puzzle-progress").textContent = "Correct — keep going (" + att.progress + " found).";
    await playOpponentReplyFromSan(att);
  } else {
    // wrong move: revert
    P.userMoves.pop();
    P.fen = fenBeforePuzzle();
    puzzleBoard.setFen(P.fen);
    puzzleBoard.shake();
    setPuzzleStatus("red", att.message || "Not the best move — try again.");
  }
}

function fenBeforePuzzle() { return Puzzles.fen; }

function applyPuzzleMove(moveResult, uci) {
  Puzzles.fen = moveResult.fen_after;
  puzzleBoard.setFen(moveResult.fen_after);
  puzzleBoard.setLastMove(uci.slice(0, 2), uci.slice(2, 4));
}

/* opponent reply for server puzzles: take it from the returned correct line */
async function playOpponentReplyFromSan(att) {
  const P = Puzzles;
  const line = att.correct_line_san || [];
  const n = P.userMoves.length;
  const san = line.length > 2 * n - 1 ? line[2 * n - 1] : line[line.length - 1];
  if (!san) return;
  const solved = await resolveSan(P.fen, san);
  if (!solved) return;
  applyPuzzleMove(solved.result, solved.uci);
}

async function showPuzzleSolution() {
  if (FC.active) return; // flashcard practice owns the board — no hijack
  const P = Puzzles;
  if (!P.current) return;
  // explicit give-up: the reveal endpoint answers with the full solution
  // line + the computed "why" (+ stored context on library-built puzzles)
  try {
    const r = await apiPost("/api/puzzle/reveal", { id: P.current.id });
    $("puzzle-progress").textContent =
      "Solution line: " + (r.solution_san || []).join(" ");
    showPuzzleWhy(r.why, r.context || null);
    P.done = true;
    puzzleBoard.setInteractive(false);
    updatePuzzleHintButton();
  } catch (e) {
    showError(e.message);
  }
}

/* ---- Build drills (V25 DUP-3: one panel, one persistent store) ----
   Single-game builds persist into the user puzzle store (same merge/dedup
   as the bulk library build) — no session-only queue that vanishes on
   reload; the queue info simply re-reads /api/puzzles/library-stats. */

/* review-fix (LOW-5): puzzle building leaks engine best moves — run the
   SAME post-mortem spoiler guard as the review paths. The library record
   is resolved from the PGN (selected game, the active post-mortem's game
   or the loaded games list) so a pasted PGN matching a guarded game is
   covered too; an unmatched paste carries no hash and passes through. */
function buildGuardGame(pgn) {
  if (Games.selected && Games.selected.pgn === pgn) return Games.selected;
  if (typeof PM !== "undefined" && PM.game && PM.game.pgn === pgn) return PM.game;
  return (Games.list || []).find(g => g && g.pgn === pgn) || null;
}

async function buildPuzzlesFromPgn(pgn, gameId) {
  if (!pgn || !pgn.trim()) { $("build-status").textContent = "Paste a PGN first."; return; }
  if (!(await pmSpoilerConfirm(buildGuardGame(pgn)))) return;
  $("build-status").textContent = "Analyzing your game and building puzzles…";
  try {
    // review-fix (LOW-4a): pass the library record id so the persisted
    // build dedupes against the SAME gid the bulk library build records
    const body = { pgn, persist: true };
    if (gameId) body.game_id = gameId;
    const r = await apiPost("/api/puzzles/from-game", body);
    if (!r.puzzles || r.puzzles.length === 0) {
      $("build-status").textContent = "No missed tactics found in this game — nicely played!";
      return;
    }
    const added = r.persisted != null ? r.persisted : r.count;
    $("build-status").textContent = "Built " + r.count + " puzzle(s) from your game — " +
      (added > 0 ? added + " new saved to your puzzle library."
                 : "all of them were already in your puzzle library.");
    await refreshPuzzleLibraryInfo();
    if (!Puzzles.current || Puzzles.done) newPuzzle();
  } catch (e) {
    const eng = await surfaceEngineError(e);
    $("build-status").textContent = eng
      ? "Could not build puzzles: engine unavailable — see the banner above."
      : "Could not build puzzles: " + e.message;
  }
}

/* the scope selector swaps between the PGN textarea and the library
   options inside the SAME Build-drills panel */
function syncBuildScope() {
  const lib = $("build-scope").value === "library";
  $("build-pgn-block").classList.toggle("hidden", lib);
  $("build-library-block").classList.toggle("hidden", !lib);
}

$("build-scope").addEventListener("change", syncBuildScope);

/* v44: puzzle sets from your own games */
if ($("puzzle-set")) {
  $("puzzle-set").addEventListener("change", () => {
    Puzzles.set = $("puzzle-set").value || "all";
    try { localStorage.setItem("cc-puzzle-set", Puzzles.set); } catch (_) {}
    newPuzzle();
  });
  try { const s = localStorage.getItem("cc-puzzle-set"); if (s) { Puzzles.set = s; $("puzzle-set").value = s; } } catch (_) {}
}
$("btn-new-puzzle").addEventListener("click", newPuzzle);
$("btn-puzzle-hint").addEventListener("click", puzzleHint);
$("btn-show-solution").addEventListener("click", showPuzzleSolution);
$("btn-build-puzzles").addEventListener("click", () => {
  if (FC.active) return; // flashcard practice owns the board — no hijack
  buildPuzzlesFromPgn($("pgn-build-input").value);
});
$("btn-build-from-last").addEventListener("click", () => {
  if (FC.active) return; // flashcard practice owns the board — no hijack
  if (!State.lastAnalyzedPgn) { $("build-status").textContent = "No game analyzed yet — analyze one in My Games first."; return; }
  $("pgn-build-input").value = State.lastAnalyzedPgn;
  buildPuzzlesFromPgn(State.lastAnalyzedPgn);
});

/* ---- Build from my game library (persistent bulk build, V21) ---- */

async function buildLibraryPuzzles() {
  const btn = $("btn-build-library");
  const maxGames = parseInt($("build-lib-max").value, 10) || 50;
  btn.disabled = true;
  $("build-lib-status").textContent = "Starting library build…";
  try {
    const r = await apiPost("/api/puzzles/build-from-library", { max_games: maxGames });
    if (!r.total_games) {
      $("build-lib-status").textContent = "Your game library is empty — import games in My Games first.";
      btn.disabled = false;
      return;
    }
    pollLibraryBuild(r.job_id);
  } catch (e) {
    btn.disabled = false;
    $("build-lib-status").textContent = e.status === 409
      ? "A library build is already running — wait for it to finish."
      : "Could not start build: " + e.message;
  }
}

function pollLibraryBuild(jobId) {
  setTimeout(async () => {
    let s;
    try {
      s = await apiGet("/api/puzzles/build-status/" + jobId);
    } catch (e) {
      $("btn-build-library").disabled = false;
      $("build-lib-status").textContent = "Lost track of the build: " + e.message;
      return;
    }
    if (s.status === "running") {
      $("build-lib-status").textContent = "Processing game " + s.processed + "/" +
        s.total + " — " + s.candidates + " puzzles found so far";
      pollLibraryBuild(jobId);
      return;
    }
    $("btn-build-library").disabled = false;
    if (s.status === "error") {
      $("build-lib-status").textContent = "Build failed: " + (s.error || "unknown error");
      return;
    }
    const byTheme = s.by_theme || {};
    const focus = (s.focus_themes || []).map(t => t + " (" + (byTheme[t] || 0) + ")");
    $("build-lib-status").textContent = "Added " + s.added + " puzzles from " +
      s.games_with_puzzles + " games." +
      (focus.length ? " Focus areas: " + focus.join(", ") + "." : "");
    refreshPuzzleLibraryInfo();
  }, 2000);
}

$("btn-build-library").addEventListener("click", () => {
  if (FC.active) return; // flashcard practice owns the board — no hijack
  buildLibraryPuzzles();
});

/* ================= Mistake Flashcards (SM-2 deck) =================
   Cards come from /api/mistakes/scan results ("Add from last mistake
   scan"). Practice runs on the puzzle board: while FC.active,
   onPuzzleMove routes board moves to onFlashcardMove instead of the
   puzzle logic; Exit restores the previous puzzle-board state. */

const FC = {
  active: false,
  cards: [],        // due cards of this review session
  idx: 0,
  awaitingGrade: false, // a card was answered; grade buttons are live
  busy: false,
  stats: null,
  lastDueAt: null,  // due_at of the last graded card ("next card due …")
  quiz: {},         // card_id -> {options, correct, labels} motif-first step
  awaitingMotif: false, // board stays locked until the motif is named
  shownAt: 0,       // Date.now() when the current card was shown
  answeredAt: 0,    // Date.now() of the first move attempt (solve time)
};

const FC_GRADES = ["again", "hard", "good", "easy"];

/* "Add from last mistake scan" is armed by review mode after a scan */
function updateFcAddButton() {
  $("btn-fc-add").disabled =
    !(State.lastScanMistakes && State.lastScanMistakes.length);
}

async function refreshFlashcards() {
  try {
    const s = await apiGet("/api/flashcards/stats");
    FC.stats = s;
    const ret = s.retention_7d == null ? "–" : Math.round(s.retention_7d * 100) + "%";
    $("fc-stats").textContent = s.due_today + " due today · " + s.total +
      " total · retention 7d " + ret + " · 🔥 streak " + s.current_streak;
    // V28: corrupt legacy cards are quarantined server-side; tell the
    // user once, unobtrusively (textContent only — server-derived count)
    const quarantined = s.quarantined_total || 0;
    $("fc-quarantined").classList.toggle("hidden", quarantined <= 0);
    if (quarantined > 0) {
      $("fc-quarantined").textContent = "Removed " + quarantined +
        " broken drill cards (outdated or inconsistent data).";
    }
    $("fc-empty").classList.toggle("hidden", s.total > 0 || FC.active);
    const btn = $("btn-fc-start");
    btn.textContent = "Start review (" + s.due_today + " due)";
    btn.disabled = s.due_today === 0 || FC.active;
    renderStreak(); // refresh the header chip with the fresh server streak
  } catch (e) {
    $("fc-stats").textContent = "Flashcards unavailable: " + e.message;
    renderStreak(); // local streak still shows without the server stats
  }
}

$("btn-fc-add").addEventListener("click", async () => {
  const mistakes = State.lastScanMistakes || [];
  if (!mistakes.length) return;
  const status = $("fc-add-status");
  status.textContent = "Adding…";
  try {
    const r = await apiPost("/api/flashcards/add", {
      mistakes, source: Review.gameLabel || "",
    });
    // V28: add-time fact checks may skip corrupt candidates — say so
    // (textContent only; the count is server-derived)
    const skipped = r.skipped_invalid || 0;
    status.textContent = "Added " + r.added +
      " (" + r.already_present + " already in deck)" +
      (skipped > 0
        ? " — " + skipped + " skipped (failed consistency checks)"
        : "");
    refreshFlashcards();
  } catch (e) {
    status.textContent = "Could not add cards: " + e.message;
  }
});

/* the card title carries the scan's "??"/"?"/"?!" suffix — map to a face */
function fcClassEmoji(card) {
  const t = card.title || "";
  if (t.indexOf("??") !== -1) return "😱";
  if (t.indexOf("?!") !== -1) return "😕";
  if (t.indexOf("?") !== -1) return "😬";
  return "❌";
}

async function fcStart() {
  $("fc-add-status").textContent = "";
  $("fc-done").classList.add("hidden");
  try {
    // interleave mode (default ON): per-session queue (cap is per fetch,
    // not per day) mixed across games/motifs
    // with a "name the motif first" step on every 3rd card
    const interleaved = $("fc-interleave").checked;
    let cards = [], quiz = {};
    if (interleaved) {
      const r = await apiGet("/api/flashcards/queue?interleave=true&cap=20");
      for (const e of (r.entries || [])) {
        cards.push(e.card);
        if (e.motif_quiz && e.card) quiz[e.card.id] = e.motif_quiz;
      }
    } else {
      const r = await apiGet("/api/flashcards/due?limit=20");
      cards = r.cards || [];
    }
    if (!cards.length) { refreshFlashcards(); return; }
    FC.active = true;
    FC.cards = cards;
    FC.quiz = quiz;
    FC.idx = 0;
    FC.awaitingGrade = false;
    FC.awaitingMotif = false;
    FC.busy = false;
    FC.lastDueAt = null;
    $("fc-practice").classList.remove("hidden");
    $("fc-empty").classList.add("hidden");
    $("btn-fc-start").disabled = true;
    fcShowCard();
  } catch (e) {
    $("fc-add-status").textContent = "Could not load due cards: " + e.message;
  }
}

function fcShowCard() {
  const c = FC.cards[FC.idx];
  FC.awaitingGrade = false;
  FC.shownAt = Date.now();
  FC.answeredAt = 0;
  puzzleBoard.setFen(c.fen_before);
  // orient the board to the side that made the mistake
  puzzleBoard.setOrientation(fenSide(c.fen_before) === "w" ? "white" : "black");
  puzzleBoard.setLastMove(null, null);
  puzzleBoard.clearArrows();
  $("fc-prompt").textContent = "Find the best move — you played " +
    (c.played_san || "?") + " " + fcClassEmoji(c) +
    "   (card " + (FC.idx + 1) + "/" + FC.cards.length + ")";
  $("fc-result").classList.add("hidden");
  $("fc-explain").classList.add("hidden");
  $("fc-grades").classList.add("hidden");
  // V22 pre-answer hint (server-computed level-1 facts on the card)
  $("fc-hint").classList.add("hidden");
  $("btn-fc-hint").disabled = !(c.hint && c.hint.text);
  syncSpeakButtons();
  // two-step "name the motif first" prompt on a subset of the queue: the
  // board stays locked until the motif is picked
  const quiz = FC.quiz[c.id];
  if (quiz) {
    FC.awaitingMotif = true;
    puzzleBoard.setInteractive(false);
    fcShowMotifQuiz(c, quiz);
  } else {
    FC.awaitingMotif = false;
    $("fc-motif-quiz").classList.add("hidden");
    puzzleBoard.setInteractive(true);
  }
}

/* render the 3-option motif chooser (labels come from verified card data) */
function fcShowMotifQuiz(c, quiz) {
  const box = $("fc-motif-options");
  box.innerHTML = "";
  $("fc-motif-note").classList.add("hidden");
  for (const m of quiz.options) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = (quiz.labels && quiz.labels[m]) || m;
    b.addEventListener("click", () => fcMotifAnswer(c, m));
    box.appendChild(b);
  }
  $("fc-motif-quiz").classList.remove("hidden");
}

async function fcMotifAnswer(c, chosen) {
  if (!FC.active || !FC.awaitingMotif || FC.busy) return;
  FC.busy = true;
  try {
    const r = await apiPost("/api/flashcards/motif-answer",
                            { id: c.id, chosen });
    FC.awaitingMotif = false;
    if (r.ok) {
      $("fc-motif-quiz").classList.add("hidden");
      puzzleBoard.setInteractive(true); // motif named — now find the move
    } else {
      // wrong motif: the server already marked the card "again"; show the
      // explanatory note, then move on to the next card
      const note = $("fc-motif-note");
      note.className = "banner red";
      note.textContent = r.note || ("The motif was: " + r.correct_label);
      note.classList.remove("hidden");
      markTrainedToday();
      setTimeout(() => {
        if (!FC.active) return;
        FC.idx++;
        if (FC.idx < FC.cards.length) fcShowCard();
        else fcFinish();
      }, 3000);
    }
  } catch (e) {
    showError("Motif check failed: " + e.message);
  } finally {
    FC.busy = false;
  }
}

function fcShowExplanation(c) {
  const box = $("fc-explain");
  if (!c.explanation) return;
  box.textContent = c.explanation;
  box.classList.remove("hidden");
  syncSpeakButtons();
}

/* V22: pre-answer hint — the level-1 hint text shipped on the due card
   (server-computed board facts; never the move itself) */
function fcHint() {
  if (!FC.active || FC.awaitingGrade || FC.busy) return;
  const c = FC.cards[FC.idx];
  if (!c || !c.hint || !c.hint.text) return;
  const line = $("fc-hint");
  line.textContent = "Hint: " + c.hint.text;
  line.classList.remove("hidden");
  $("btn-fc-hint").disabled = true;
  syncSpeakButtons();
}

/* grade buttons; on a wrong answer "Again" is pre-selected emphasis */
function fcShowGrades(emphasisAgain) {
  const row = $("fc-grades");
  row.classList.remove("hidden");
  row.querySelectorAll(".fc-grade").forEach(b =>
    b.classList.toggle("primary", emphasisAgain && b.dataset.grade === "again"));
}

async function onFlashcardMove(from, to) {
  if (!FC.active || FC.awaitingGrade || FC.awaitingMotif || FC.busy) return;
  const c = FC.cards[FC.idx];
  if (!c) return;
  FC.busy = true;
  const uci = uciCandidate(puzzleBoard, from, to);
  try {
    const r = await apiPost("/api/move", { fen: c.fen_before, move_uci: uci });
    if (!r.legal) { puzzleBoard.shake(); return; }
    if (!FC.answeredAt) FC.answeredAt = Date.now();
    const res = $("fc-result");
    if (uci === c.best_uci) {
      puzzleBoard.setFen(r.fen_after);
      puzzleBoard.setLastMove(from, to);
      puzzleBoard.setInteractive(false);
      res.className = "banner green";
      res.textContent = "Correct!";
    } else {
      puzzleBoard.setFen(c.fen_before); // stay on the card position
      puzzleBoard.shake();
      // played (the recorded mistake) vs best, like the mistake review
      const arrows = [];
      if (c.played_uci && c.played_uci.length >= 4) {
        arrows.push({ from: c.played_uci.slice(0, 2), to: c.played_uci.slice(2, 4), color: "red" });
      }
      if (c.best_uci && c.best_uci.length >= 4) {
        arrows.push({ from: c.best_uci.slice(0, 2), to: c.best_uci.slice(2, 4), color: "green" });
      }
      puzzleBoard.setArrows(arrows);
      res.className = "banner red";
      res.textContent = "Not the best move (" + r.san + ") — the best was " +
        (c.best_san || "?") + ".";
    }
    res.classList.remove("hidden");
    fcShowExplanation(c);
    FC.awaitingGrade = true;
    $("btn-fc-hint").disabled = true; // answer is out — hint is moot
    fcShowGrades(uci !== c.best_uci);
  } catch (e) {
    showError(e.message);
  } finally {
    FC.busy = false;
  }
}

async function fcGrade(grade) {
  if (!FC.active || !FC.awaitingGrade || FC.busy) return;
  const c = FC.cards[FC.idx];
  if (!c) return;
  FC.busy = true;
  try {
    const body = { id: c.id, grade };
    // V16: time-to-answer goes on the review log (solve-time tracking)
    if (FC.answeredAt && FC.shownAt) {
      body.solve_ms = Math.max(0, Math.round(FC.answeredAt - FC.shownAt));
    }
    const r = await apiPost("/api/flashcards/review", body);
    markTrainedToday(); // a graded card counts as trained today
    if (r.card && r.card.due_at) FC.lastDueAt = r.card.due_at;
    FC.idx++;
    FC.awaitingGrade = false;
    if (FC.idx < FC.cards.length) fcShowCard();
    else fcFinish();
  } catch (e) {
    showError("Review failed: " + e.message);
  } finally {
    FC.busy = false;
  }
}

/* "in 10 min" / "in 3 h" / "in 2 d" for an ISO-8601 UTC timestamp */
function fcRelTime(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return "later";
  const mins = Math.max(0, Math.round((t - Date.now()) / 60000));
  if (mins < 1) return "shortly";
  if (mins < 60) return "in " + mins + " min";
  const hours = Math.round(mins / 60);
  if (hours < 48) return "in " + hours + " h";
  return "in " + Math.round(hours / 24) + " d";
}

/* put the puzzle board back the way the Puzzles tab left it */
function fcRestoreBoard() {
  puzzleBoard.clearArrows();
  puzzleBoard.setLastMove(null, null);
  if (Puzzles.current) {
    puzzleBoard.setFen(Puzzles.fen);
    puzzleBoard.setOrientation(Puzzles.current.side_to_move);
    puzzleBoard.setInteractive(!Puzzles.done);
  } else {
    puzzleBoard.setFen(PLAY_START_FEN);
    puzzleBoard.setOrientation("white");
    puzzleBoard.setInteractive(false);
  }
}

function fcFinish() {
  FC.active = false;
  $("fc-practice").classList.add("hidden");
  const done = $("fc-done");
  done.classList.remove("hidden");
  done.textContent = "All caught up!" +
    (FC.lastDueAt ? " Next card due " + fcRelTime(FC.lastDueAt) + "." : "");
  fcRestoreBoard();
  refreshFlashcards();
}

function fcExit() {
  if (!FC.active) return;
  FC.active = false;
  FC.awaitingGrade = false;
  $("fc-practice").classList.add("hidden");
  fcRestoreBoard();
  refreshFlashcards();
}

$("btn-fc-start").addEventListener("click", fcStart);
$("btn-fc-exit").addEventListener("click", fcExit);
$("btn-fc-hint").addEventListener("click", fcHint);
document.querySelectorAll(".fc-grade").forEach(b =>
  b.addEventListener("click", () => fcGrade(b.dataset.grade)));

/* grade keyboard shortcuts 1-4 (Again/Hard/Good/Easy) while a card awaits grading */
document.addEventListener("keydown", (e) => {
  if (!FC.active || !FC.awaitingGrade) return;
  if (!$("tab-puzzles").classList.contains("active")) return;
  const t = e.target;
  if (t && ((t.closest && t.closest("input, textarea, select")) || t.isContentEditable)) return;
  const i = ["1", "2", "3", "4"].indexOf(e.key);
  if (i === -1) return;
  e.preventDefault();
  fcGrade(FC_GRADES[i]);
});

/* ================= Woodpecker cycle mode =================
   Fixed sets of mistake cards solved in repeated full passes. The runner
   owns the Cycles-tab board; per-card timing is think_ms (until the first
   move attempt) + incremental_ms (after it — incremental guessing), and
   the server blends them into the speed score. */

const CY = {
  sets: [],
  motifs: {},
  running: false,
  busy: false,
  waitingNext: false,
  setId: null,
  setName: "",
  cycleNo: 0,
  cards: [],
  idx: 0,
  records: [],
  attempts: 0,
  shownAt: 0,
  firstAttemptAt: 0,
  startedAt: 0,
  timerInt: null,
  warned: {},   // set_id -> true once the <24h warning was acknowledged
};

const cycleBoard = new Board($("cycle-board"), { onMove: onCycleMove });
cycleBoard.setInteractive(false);

function initCycles() {
  loadCycleSets();
}

async function loadCycleSets() {
  try {
    const r = await apiGet("/api/cycles/sets");
    CY.sets = r.sets || [];
    CY.motifs = r.motifs || {};
    renderCycleSets();
  } catch (e) {
    $("cycle-set-list").innerHTML = "";
    const d = document.createElement("div");
    d.className = "info-line";
    d.textContent = "Cycle sets unavailable: " + e.message;
    $("cycle-set-list").appendChild(d);
  }
}

function cycleFmtMs(ms) {
  if (ms == null) return "–";
  return (ms / 1000).toFixed(1) + "s";
}

function renderCycleSets() {
  const host = $("cycle-set-list");
  host.innerHTML = "";
  if (!CY.sets.length) {
    host.appendChild(emptyStateCard({
      icon: "🔁", title: "No cycle sets yet",
      text: "A cycle set is a frozen snapshot of your mistake deck that you solve again and again, faster each pass. " +
        "Name a set above, choose which cards to include, then click Create set. " +
        "Need cards first? Review a game in My Games and add its mistakes from the Puzzles tab.",
      actions: [
        { label: "Name my first set", primary: true, onClick: () => { const i = $("cycle-set-name"); if (i) { i.focus(); i.scrollIntoView({ block: "center", behavior: "smooth" }); } } },
        { label: "Go to My Games", tab: "games" },
      ],
    }));
    return;
  }
  for (const s of CY.sets) {
    const row = document.createElement("div");
    row.className = "cycle-set-row";
    const head = document.createElement("div");
    head.className = "panel-row";
    const name = document.createElement("b");
    name.textContent = s.name;
    head.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = " " + s.size + " cards · " + s.cycles_completed +
      " cycles";
    head.appendChild(meta);
    row.appendChild(head);

    if (s.last_cycle) {
      const last = document.createElement("div");
      last.className = "info-line";
      last.textContent = "Last: cycle " + s.last_cycle.cycle_no + " — " +
        Math.round((s.last_cycle.accuracy || 0) * 100) + "% · avg " +
        cycleFmtMs(s.last_cycle.avg_ms) +
        (s.last_cycle.avg_score != null
          ? " · score " + Math.round(s.last_cycle.avg_score) : "");
      row.appendChild(last);
    }

    const btns = document.createElement("div");
    btns.className = "panel-row";
    const start = document.createElement("button");
    start.className = "btn primary";
    start.textContent = "Start cycle " + (s.cycles_completed + 1);
    start.disabled = CY.running;
    start.addEventListener("click", () => cycleRequestStart(s));
    btns.appendChild(start);
    const ren = document.createElement("button");
    ren.className = "btn";
    ren.textContent = "Rename";
    ren.disabled = CY.running;
    ren.addEventListener("click", () => cycleRename(s, name));
    btns.appendChild(ren);
    const del = document.createElement("button");
    del.className = "btn";
    del.textContent = "Delete";
    del.disabled = CY.running;
    del.addEventListener("click", () => cycleDelete(s));
    btns.appendChild(del);
    row.appendChild(btns);
    host.appendChild(row);
  }
}

async function cycleCreate() {
  const status = $("cycle-create-status");
  const name = $("cycle-set-name").value.trim();
  const kind = $("cycle-set-kind").value;
  const value = $("cycle-set-value").value.trim();
  if (!name) { status.textContent = "Name the set first."; return; }
  status.textContent = "Creating…";
  try {
    await apiPost("/api/cycles/sets", { name, kind, value: value || null });
    status.textContent = "";
    $("cycle-set-name").value = "";
    $("cycle-set-value").value = "";
    loadCycleSets();
  } catch (e) {
    status.textContent = "Could not create set: " + e.message;
  }
}

/* inline rename: swap the name label for an input + save */
function cycleRename(s, nameEl) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = s.name;
  input.maxLength = 120;
  const save = document.createElement("button");
  save.className = "btn mini";
  save.textContent = "Save";
  nameEl.replaceWith(input);
  input.after(save);
  const doSave = async () => {
    const v = input.value.trim();
    if (!v || v === s.name) { loadCycleSets(); return; }
    try {
      await apiPost("/api/cycles/sets/" + s.id + "/rename", { name: v });
    } catch (e) {
      showError("Rename failed: " + e.message);
    }
    loadCycleSets();
  };
  save.addEventListener("click", doSave);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
  input.focus();
}

async function cycleDelete(s) {
  try {
    await apiPost("/api/cycles/sets/" + s.id + "/delete", {});
    loadCycleSets();
  } catch (e) {
    showError("Delete failed: " + e.message);
  }
}

/* start asks the server first: a cycle <24h after the last one shows the
   short-term-memorization warning; clicking again starts anyway (soft
   guardrail, never blocks) */
async function cycleRequestStart(s) {
  try {
    const r = await apiPost("/api/cycles/sets/" + s.id + "/cycles/start", {});
    if (r.too_soon && !CY.warned[s.id]) {
      CY.warned[s.id] = true;
      const warn = $("cycle-warn");
      warn.textContent = r.warning;
      warn.classList.remove("hidden");
      renderCycleSets();
      return;
    }
    $("cycle-warn").classList.add("hidden");
    cycleBegin(s, r);
  } catch (e) {
    showError("Could not start cycle: " + e.message);
  }
}

function cycleBegin(s, r) {
  CY.running = true;
  CY.setId = s.id;
  CY.setName = s.name;
  CY.cycleNo = r.cycle_no;
  CY.cards = r.cards || [];
  CY.idx = 0;
  CY.records = [];
  CY.startedAt = Date.now();
  $("cycle-set-list").classList.add("hidden");
  $("cycle-summary").classList.add("hidden");
  $("cycle-run").classList.remove("hidden");
  $("cycle-run-title").textContent = s.name + " — cycle " + r.cycle_no +
    " of " + CY.cards.length + " cards";
  CY.timerInt = setInterval(cycleTick, 250);
  cycleShowCard();
}

function cycleTick() {
  if (!CY.running) return;
  const el = $("cycle-timer");
  const cur = (Date.now() - CY.shownAt) / 1000;
  const tot = (Date.now() - CY.startedAt) / 1000;
  el.textContent = "card " + cur.toFixed(1) + "s · cycle " + tot.toFixed(0) + "s";
}

function cycleShowCard() {
  const c = CY.cards[CY.idx];
  CY.attempts = 0;
  CY.shownAt = Date.now();
  CY.firstAttemptAt = 0;
  CY.waitingNext = false;
  cycleBoard.setFen(c.fen_before);
  cycleBoard.setOrientation(fenSide(c.fen_before) === "w" ? "white" : "black");
  cycleBoard.setLastMove(null, null);
  cycleBoard.clearArrows();
  cycleBoard.setInteractive(true);
  $("cycle-progress").textContent = "Card " + (CY.idx + 1) + "/" +
    CY.cards.length;
  $("cycle-prompt").textContent = "Find the best move — you played " +
    (c.played_san || "?") + " " + fcClassEmoji(c);
  $("cycle-result").classList.add("hidden");
  $("btn-cycle-next").classList.add("hidden");
  $("btn-cycle-giveup").classList.add("hidden");
  // V22 pre-answer hint (server-computed level-1 facts on the card)
  $("cycle-hint").classList.add("hidden");
  $("btn-cycle-hint").disabled = !(c.hint && c.hint.text);
  syncSpeakButtons();
}

function cyHint() {
  if (!CY.running || CY.waitingNext || CY.busy) return;
  const c = CY.cards[CY.idx];
  if (!c || !c.hint || !c.hint.text) return;
  const line = $("cycle-hint");
  line.textContent = "Hint: " + c.hint.text;
  line.classList.remove("hidden");
  $("btn-cycle-hint").disabled = true;
  syncSpeakButtons();
}

/* build one per-card record: think = time to first attempt, incremental =
   time after it (the server counts it double against the speed score).
   Unsolved cards record their REAL incremental too — the score stays 0
   either way, but avg_ms reflects the time actually spent. */
function cyRecord(solved) {
  const end = Date.now();
  const firstAt = CY.firstAttemptAt || end;
  return {
    card_id: CY.cards[CY.idx].id,
    solved: solved,
    attempts: Math.max(1, CY.attempts),
    think_ms: Math.max(0, Math.round(firstAt - CY.shownAt)),
    incremental_ms: Math.max(0, Math.round(end - firstAt)),
  };
}

async function onCycleMove(from, to) {
  if (!CY.running || CY.waitingNext || CY.busy) return;
  const c = CY.cards[CY.idx];
  if (!c) return;
  CY.busy = true;
  const uci = uciCandidate(cycleBoard, from, to);
  try {
    const r = await apiPost("/api/move", { fen: c.fen_before, move_uci: uci });
    if (!r.legal) { cycleBoard.shake(); return; }
    CY.attempts++;
    if (!CY.firstAttemptAt) CY.firstAttemptAt = Date.now();
    const res = $("cycle-result");
    if (uci === c.best_uci) {
      cycleBoard.setFen(r.fen_after);
      cycleBoard.setLastMove(from, to);
      cycleBoard.setInteractive(false);
      CY.records.push(cyRecord(true));
      res.className = "banner green";
      res.textContent = CY.attempts === 1
        ? "Correct — first try!"
        : "Correct (after " + CY.attempts + " attempts).";
      res.classList.remove("hidden");
      cyOfferNext();
    } else {
      cycleBoard.setFen(c.fen_before); // stay on the card, keep trying
      cycleBoard.shake();
      res.className = "banner red";
      res.textContent = "Not the best move (" + r.san + ") — try again.";
      res.classList.remove("hidden");
      $("btn-cycle-giveup").classList.remove("hidden");
    }
  } catch (e) {
    showError(e.message);
  } finally {
    CY.busy = false;
  }
}

function cyOfferNext() {
  CY.waitingNext = true;
  cycleBoard.setInteractive(false);
  $("btn-cycle-next").classList.remove("hidden");
  $("btn-cycle-giveup").classList.add("hidden");
  $("btn-cycle-hint").disabled = true; // card is answered — hint is moot
}

function cycleGiveUp() {
  if (!CY.running || CY.waitingNext) return;
  const c = CY.cards[CY.idx];
  CY.records.push(cyRecord(false));
  const arrows = [];
  if (c.best_uci && c.best_uci.length >= 4) {
    arrows.push({ from: c.best_uci.slice(0, 2), to: c.best_uci.slice(2, 4),
                  color: "green" });
  }
  cycleBoard.setArrows(arrows);
  const res = $("cycle-result");
  res.className = "banner red";
  res.textContent = "The best move was " + (c.best_san || "?") + ".";
  res.classList.remove("hidden");
  cyOfferNext();
}

function cycleNext() {
  if (!CY.running || !CY.waitingNext) return;
  CY.idx++;
  if (CY.idx < CY.cards.length) cycleShowCard();
  else cycleFinish();
}

async function cycleFinish() {
  clearInterval(CY.timerInt);
  CY.running = false;
  cycleBoard.setInteractive(false);
  $("cycle-timer").textContent = "";
  try {
    const r = await apiPost(
      "/api/cycles/sets/" + CY.setId + "/cycles/finish",
      { records: CY.records });
    renderCycleSummary(r.cycle, r.guardrail || null,
      r.new_prs || [], r.prs || {});
  } catch (e) {
    showError("Could not save the cycle: " + e.message);
    $("cycle-run").classList.add("hidden");
    $("cycle-set-list").classList.remove("hidden");
  }
  markTrainedToday();
  loadCycleSets();
}

function cycleAbort() {
  if (!CY.running) return;
  clearInterval(CY.timerInt);
  CY.running = false;
  cycleBoard.setInteractive(false);
  $("cycle-timer").textContent = "";
  $("cycle-run").classList.add("hidden");
  $("cycle-set-list").classList.remove("hidden");
  loadCycleSets();
}

/* V24 personal-record celebration lines ("🏆 New PR: fastest clear 4:12
   (−38s)"); deltas come from the finish response's pre-update values. */
/* mm:ss for cycle-length durations ("4:12"), plain seconds under a minute */
function prFmtMs(ms) {
  if (ms == null) return "–";
  const total = Math.round(ms / 1000);
  if (total >= 60) {
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }
  return (ms / 1000).toFixed(1) + "s";
}

function renderCyclePrs(newPrs, prs) {
  const host = $("cycle-prs");
  host.innerHTML = "";
  const defs = {
    fastest: { field: "pr_fastest_ms",
      fmt: (v) => "fastest clear " + prFmtMs(v),
      delta: (v, p) => "−" + ((p - v) / 1000).toFixed(0) + "s" },
    accuracy: { field: "pr_best_accuracy",
      fmt: (v) => "accuracy " + Math.round(v * 100) + "%",
      delta: (v, p) => "+" + Math.round((v - p) * 100) + "%" },
    avg_solve: { field: "pr_fastest_avg_solve_ms",
      fmt: (v) => "avg solve " + prFmtMs(v),
      delta: (v, p) => "−" + ((p - v) / 1000).toFixed(1) + "s" },
  };
  newPrs.forEach(key => {
    const def = defs[key];
    const rec = def && (prs || {})[def.field];
    if (!rec || rec.value == null) return;
    const line = document.createElement("div");
    line.className = "pr-line";
    line.textContent = "🏆 New PR: " + def.fmt(rec.value) +
      (rec.previous != null ? " (" + def.delta(rec.value, rec.previous) + ")" : "");
    host.appendChild(line);
  });
  if (newPrs.length && host.childNodes.length) {
    confettiBurst(30);
    // V26: read the celebration ONCE (the lines the app just printed)
    speakCelebration(
      Array.from(host.childNodes).map(n => n.textContent).join(" "));
  }
}

/* cycle-complete summary: stats, deltas vs last cycle ("beat your last
   cycle" target), first-pass guardrail, accuracy + avg-time sparklines */
async function renderCycleSummary(cycle, guardrail, newPrs, prs) {
  $("cycle-run").classList.add("hidden");
  const host = $("cycle-summary");
  host.classList.remove("hidden");
  renderCyclePrs(newPrs || [], prs || {});
  const stats = $("cycle-summary-stats");
  stats.innerHTML = "";
  stats.appendChild(glanceStat(
    Math.round((cycle.accuracy || 0) * 100) + "%", "accuracy"));
  stats.appendChild(glanceStat(cycleFmtMs(cycle.avg_ms), "avg solve"));
  stats.appendChild(glanceStat(cycleFmtMs(cycle.total_ms), "total time"));
  stats.appendChild(glanceStat(
    cycle.avg_score != null ? Math.round(cycle.avg_score) : null,
    "avg score /100"));

  const target = $("cycle-target");
  if (cycle.deltas) {
    const dAcc = Math.round((cycle.deltas.accuracy || 0) * 100);
    const dMs = cycle.deltas.avg_ms || 0;
    const prevAcc = Math.round(((cycle.accuracy || 0) -
      (cycle.deltas.accuracy || 0)) * 100);
    const prevMs = (cycle.avg_ms || 0) - dMs;
    const beaten = dAcc >= 0 && dMs <= 0;
    target.textContent = "Beat-your-last-cycle target: " + prevAcc + "% & " +
      cycleFmtMs(prevMs) + " avg → " + (dAcc >= 0 ? "+" : "") + dAcc + "% · " +
      (dMs <= 0 ? "" : "+") + (dMs / 1000).toFixed(1) + "s " +
      (beaten ? "— target beaten!" : "— not yet.");
  } else {
    target.textContent = "First cycle done — this is the baseline your " +
      "next cycle tries to beat.";
  }

  const g = $("cycle-guardrail");
  if (guardrail) {
    g.textContent = guardrail.message;
    g.classList.remove("hidden");
  } else {
    g.classList.add("hidden");
  }

  const charts = $("cycle-charts");
  charts.innerHTML = "";
  try {
    const detail = await apiGet("/api/cycles/sets/" + CY.setId);
    const hist = detail.cycles || [];
    const accVals = hist.map(h => (h.accuracy || 0) * 100);
    const msVals = hist.map(h => (h.avg_ms || 0) / 1000);
    if (accVals.length >= 2) {
      const a = document.createElement("div");
      a.className = "info-line";
      a.textContent = "Accuracy across cycles (%)";
      charts.appendChild(a);
      charts.appendChild(sparkBlock(accVals, v => v.toFixed(0) + "%"));
      const t = document.createElement("div");
      t.className = "info-line";
      t.textContent = "Avg solve time across cycles (s)";
      charts.appendChild(t);
      charts.appendChild(sparkBlock(msVals, v => v.toFixed(1) + "s"));
    }
  } catch (_) { /* charts are optional */ }
  $("cycle-set-list").classList.remove("hidden");
}

$("btn-cycle-create").addEventListener("click", cycleCreate);
$("btn-cycle-next").addEventListener("click", cycleNext);
$("btn-cycle-giveup").addEventListener("click", cycleGiveUp);
$("btn-cycle-abort").addEventListener("click", cycleAbort);
$("btn-cycle-hint").addEventListener("click", cyHint);

/* ================= V17: Play-it-out Sparring Packs =================
   Goal-based position training. The server owns the pack store, goal
   verification (tablebase/Stockfish) and result-claim verification; this
   client only renders and relays moves (validated by /api/move like every
   other board — no client-side move generation). Opponent replies come
   from /api/sparring/opponent-move (Maia at the chosen level when
   installed, else skill-limited Stockfish). */

const SP = {
  packs: [],
  progress: null,
  pack: null,        // currently open pack detail
  scenarios: [],     // run order (due re-tests first)
  idx: 0,
  attempt: null,     // {scenario_id, user_side, goal, theme, level}
  busy: false,       // an API call is in flight
  over: false,       // the current attempt has finished
  seq: 0,            // bumped on scenario switch/exit — drops stale replies
};

const SP_GOAL_TEXT = { win: "WIN", hold: "HOLD the draw" };

const sparringBoard = new Board($("sparring-board"), { onMove: onSparringMove });
sparringBoard.setInteractive(false);

function initSparring() {
  loadSparringAll();
}

async function loadSparringAll() {
  try {
    const r = await apiGet("/api/sparring/packs");
    SP.packs = r.packs || [];
  } catch (e) {
    SP.packs = [];
    showError("Sparring packs unavailable: " + e.message);
  }
  try {
    SP.progress = await apiGet("/api/sparring/progress");
  } catch (_) {
    SP.progress = null; // progress is optional — the list still renders
  }
  renderSparringProgress();
  renderSparringPacks();
}

function sparringLevel() {
  const el = $("sparring-level");
  return el && el.value ? el.value : getOpponentLevel();
}

function sparringSideName(side) { return side === "white" ? "White" : "Black"; }

/* brief line, e.g. "Lucena rook ending — WIN as White" */
function sparringBriefText(theme, goal, side) {
  return theme + " — " + (SP_GOAL_TEXT[goal] || goal) + " as " +
    sparringSideName(side);
}

function renderSparringProgress() {
  const host = $("sparring-progress");
  host.innerHTML = "";
  const p = SP.progress;
  if (!p) return;
  if (p.due && p.due.length) {
    const d = document.createElement("div");
    d.className = "banner amber";
    d.textContent = p.due.length + " re-test" + (p.due.length > 1 ? "s" : "") +
      " due — failed scenarios are back for another try.";
    host.appendChild(d);
  }
  const themes = p.themes || {};
  const keys = Object.keys(themes);
  if (!keys.length) return;
  const box = document.createElement("div");
  box.className = "info-line";
  const parts = keys.map(k => {
    const t = themes[k];
    const rate = t.pass_rate == null ? "–" : Math.round(t.pass_rate * 100) + "%";
    return k + " " + rate + " (" + t.passes + "/" + (t.passes + t.fails) + ")";
  });
  box.textContent = "Pass rates — " + parts.join(" · ");
  host.appendChild(box);
}

function renderSparringPacks() {
  const host = $("sparring-pack-list");
  host.innerHTML = "";
  if (!SP.packs.length) {
    host.appendChild(emptyStateCard({
      icon: "🥊", title: "No sparring packs yet",
      text: "A pack is a set of positions with a clear goal — win it or hold the draw — that you play out against an opponent at your level. " +
        "With mistake cards in your deck the pack uses positions from your own games; otherwise it starts from curated model positions.",
      actions: [
        { label: "Generate my first pack", primary: true, onClick: () => { const b = $("btn-sparring-generate"); if (b && !b.disabled) b.click(); } },
      ],
    }));
    return;
  }
  for (const pack of SP.packs) {
    const row = document.createElement("div");
    row.className = "cycle-set-row sp-pack-row";
    const head = document.createElement("div");
    head.className = "panel-row";
    const name = document.createElement("b");
    name.textContent = pack.name;
    head.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = " " + pack.size + " scenarios · " +
      pack.passed_primary + " passed" +
      (pack.own_scenarios ? " · " + pack.own_scenarios + " from your games" : "");
    head.appendChild(meta);
    row.appendChild(head);

    if (pack.due_count) {
      const due = document.createElement("div");
      due.className = "info-line sp-due";
      due.textContent = pack.due_count + " re-test" +
        (pack.due_count > 1 ? "s" : "") + " due";
      row.appendChild(due);
    }

    const chips = document.createElement("div");
    chips.className = "chip-row";
    for (const theme of (pack.themes || [])) {
      const chip = document.createElement("span");
      chip.className = "chip plan";
      chip.textContent = theme;
      chips.appendChild(chip);
    }
    row.appendChild(chips);

    const btns = document.createElement("div");
    btns.className = "panel-row";
    const open = document.createElement("button");
    open.className = "btn primary";
    open.textContent = "Open pack";
    open.addEventListener("click", () => sparringOpenPack(pack.id));
    btns.appendChild(open);
    row.appendChild(btns);
    host.appendChild(row);
  }
}

async function sparringGenerate() {
  const status = $("sparring-gen-status");
  status.textContent = "Generating — verifying goals (tablebase/engine)…";
  try {
    await apiPost("/api/sparring/packs/generate", { side: typeof mySide === "function" ? mySide() : null });
    status.textContent = "";
    await loadSparringAll();
  } catch (e) {
    status.textContent = "Could not generate a pack: " + e.message;
  }
}

async function sparringOpenPack(packId) {
  try {
    const pack = await apiGet("/api/sparring/packs/" + packId);
    SP.pack = pack;
    // due re-tests surface first (a scenario is due when EITHER side is);
    // the rest keep pack order. Stable sort via index mapping.
    SP.scenarios = (pack.scenarios || []).map((sc, i) => ({ sc, i }))
      .sort((a, b) => {
        const da = (a.sc.sides.white.due || a.sc.sides.black.due) ? 0 : 1;
        const db = (b.sc.sides.white.due || b.sc.sides.black.due) ? 0 : 1;
        return da - db || a.i - b.i;
      })
      .map(x => x.sc);
    SP.idx = 0;
    $("sparring-pack-list").classList.add("hidden");
    $("sparring-run").classList.remove("hidden");
    sparringPickSide();
  } catch (e) {
    showError("Could not open the pack: " + e.message);
  }
}

/* side picker for the current scenario: play the primary side by default;
   when it is already passed (or due on the mirror side), offer the other */
function sparringPickSide() {
  const sc = SP.scenarios[SP.idx];
  const primary = sc.user_side;
  const mirror = primary === "white" ? "black" : "white";
  const ps = sc.sides[primary];
  const ms = sc.sides[mirror];
  let side = primary;
  if (ms.due) side = mirror;
  else if (ps.due || !ps.passed) side = primary;
  else if (!ms.passed) side = mirror;
  sparringStartAttempt(side);
}

async function sparringStartAttempt(side) {
  const sc = SP.scenarios[SP.idx];
  SP.seq++;
  SP.busy = true;
  SP.over = false;
  sparringBoard.setInteractive(false);
  $("sparring-feedback").classList.add("hidden");
  $("btn-sparring-next").classList.add("hidden");
  $("sparring-status").textContent = "Preparing the scenario…";
  try {
    const r = await apiPost("/api/sparring/attempt/start", {
      scenario_id: sc.id, user_side: side, level: sparringLevel(),
    });
    SP.attempt = {
      scenario_id: sc.id, user_side: side, goal: r.goal, theme: r.theme,
      token: r.attempt_token, moves: 0,
    };
    sparringUpdateClaimButtons();
    $("sparring-hint").classList.add("hidden");
    syncSpeakButtons();
    $("btn-sparring-hint").disabled = false;
    $("sparring-run-title").textContent =
      "Scenario " + (SP.idx + 1) + "/" + SP.scenarios.length;
    $("sparring-brief").textContent =
      sparringBriefText(r.theme, r.goal, side);
    const opp = r.opponent || {};
    $("sparring-board-note").textContent = opp.type === "maia"
      ? "Opponent: Maia human-like engine @ ~" + opp.elo_self
      : "Opponent: Stockfish, skill " + opp.skill + " (level " +
        (opp.level || "club") + ")";
    sparringBoard.setFen(r.fen);
    sparringBoard.setOrientation(side);
    sparringBoard.setLastMove(null, null);
    sparringBoard.clearArrows();
    if (r.side_to_move !== (side === "white" ? "w" : "b")) {
      $("sparring-status").textContent = "Opponent to move…";
      sparringOpponentReply();
    } else {
      $("sparring-status").textContent = "Your move — " +
        (r.goal === "win" ? "convert the win." : "hold the draw.");
      sparringBoard.setInteractive(true);
      sparringCheckTerminal(); // the start position may already be terminal
    }
  } catch (e) {
    $("sparring-status").textContent = "Could not start: " + e.message;
  } finally {
    SP.busy = false;
  }
}

function sparringUserLetter() {
  return SP.attempt && SP.attempt.user_side === "white" ? "w" : "b";
}

/* the server rejects win/draw claims on the untouched start position
   (422 no_moves_played) — keep the claim buttons off until the user has
   actually played a move */
function sparringUpdateClaimButtons() {
  const can = !!(SP.attempt && !SP.over && (SP.attempt.moves || 0) > 0);
  $("btn-sparring-claim-win").disabled = !can;
  $("btn-sparring-claim-draw").disabled = !can;
}

async function onSparringMove(from, to) {
  if (!SP.attempt || SP.busy || SP.over) return;
  const fen = sparringBoard.getFen();
  if (fenSide(fen) !== sparringUserLetter()) { sparringBoard.shake(); return; }
  SP.busy = true;
  const uci = uciCandidate(sparringBoard, from, to);
  try {
    const r = await apiPost("/api/move", { fen, move_uci: uci });
    if (!r.legal) { sparringBoard.shake(); return; }
    SP.attempt.moves = (SP.attempt.moves || 0) + 1;
    sparringUpdateClaimButtons();
    sparringBoard.setFen(r.fen_after);
    sparringBoard.setLastMove(from, to);
    sparringBoard.clearArrows();
    $("sparring-status").textContent = "You played " + r.san +
      " — opponent to move…";
    if (await sparringCheckTerminal()) return;
    sparringOpponentReply();
  } catch (e) {
    showError(e.message);
  } finally {
    SP.busy = false;
  }
}

async function sparringOpponentReply() {
  if (!SP.attempt || SP.over) return;
  const fen = sparringBoard.getFen();
  const seq = SP.seq;
  SP.busy = true;
  try {
    const r = await apiPost("/api/sparring/opponent-move", {
      fen, level: sparringLevel(),
    });
    if (seq !== SP.seq || !SP.attempt || sparringBoard.getFen() !== fen) return;
    if (r.terminal) { await sparringCheckTerminal(); return; }
    sparringBoard.setFen(r.fen_after);
    sparringBoard.setLastMove(r.uci.slice(0, 2), r.uci.slice(2, 4));
    $("sparring-status").textContent = "Opponent played " + r.san +
      " — your move.";
    if (await sparringCheckTerminal()) return;
    sparringBoard.setInteractive(true);
  } catch (e) {
    if (seq !== SP.seq) return;
    $("sparring-status").textContent =
      "Couldn't get the opponent's move: " + e.message;
  } finally {
    if (seq === SP.seq) SP.busy = false;
  }
}

/* terminal check after every move; auto-finishes the attempt.
   Returns true when the position was terminal. */
async function sparringCheckTerminal() {
  if (!SP.attempt || SP.over) return false;
  const fen = sparringBoard.getFen();
  const seq = SP.seq;
  try {
    const r = await apiPost("/api/board/status", { fen });
    if (seq !== SP.seq || !SP.attempt || sparringBoard.getFen() !== fen) {
      return false;
    }
    if (!r.terminal) return false;
    let result = "draw";
    if (r.result === "1-0") result = SP.attempt.user_side === "white" ? "win" : "loss";
    else if (r.result === "0-1") result = SP.attempt.user_side === "black" ? "win" : "loss";
    await sparringFinish(result, fen);
    return true;
  } catch (_) {
    return false; // offline tolerance — the board still rejects illegal moves
  }
}

/* finish the attempt: the server VERIFIES the claim against final_fen and
   answers pass/fail for the scenario goal */
async function sparringFinish(result, finalFen) {
  if (!SP.attempt || SP.over) return;
  SP.busy = true;
  SP.over = true; // no further moves regardless of the verdict
  sparringUpdateClaimButtons();
  sparringBoard.setInteractive(false);
  try {
    const r = await apiPost("/api/sparring/attempt/finish", {
      scenario_id: SP.attempt.scenario_id,
      user_side: SP.attempt.user_side,
      result: result,
      final_fen: finalFen || sparringBoard.getFen(),
      attempt_token: SP.attempt.token,
    });
    const fb = $("sparring-feedback");
    fb.className = "banner " + (r.passed ? "green" : "red");
    const goalText = SP_GOAL_TEXT[r.goal] || r.goal;
    fb.textContent = (r.passed ? "Passed — " : "Failed — ") +
      "goal was " + goalText + ", you scored a " + r.result + " (" +
      (r.verification && r.verification.detail ? r.verification.detail : "verified") +
      ")." + (r.passed ? "" : " Re-test scheduled.");
    fb.classList.remove("hidden");
    $("sparring-status").textContent = "";
    // keep the local copy of the scenario in sync
    const sc = SP.scenarios[SP.idx];
    if (sc && r.side) sc.sides[SP.attempt.user_side] = r.side;
    sparringOfferNext();
  } catch (e) {
    SP.over = false; // the claim was refused — the attempt is still live
    sparringUpdateClaimButtons();
    const fb = $("sparring-feedback");
    fb.className = "banner amber";
    fb.textContent = e.status === 422
      ? "Claim rejected: " + (e.detail && e.detail.detail ? e.detail.detail : e.message)
      : e.status === 503
        ? "Engine busy or unavailable — try again in a moment."
        : "Could not finish: " + e.message;
    fb.classList.remove("hidden");
    sparringBoard.setInteractive(true);
    // the finish consumed the one-shot attempt token — quietly mint a
    // fresh one so the still-live attempt can claim again later
    const att = SP.attempt;
    if (att && e.status !== 503) {
      apiPost("/api/sparring/attempt/start", {
        scenario_id: att.scenario_id, user_side: att.user_side,
        level: sparringLevel(),
      }).then(r => {
        if (SP.attempt === att) SP.attempt.token = r.attempt_token;
      }).catch(() => {});
    }
  } finally {
    SP.busy = false;
  }
}

function sparringOfferNext() {
  $("btn-sparring-next").classList.remove("hidden");
  $("btn-sparring-hint").disabled = true; // attempt over — hint is moot
}

/* V22: hint for the CURRENT board of the live play-out (the server
   computes the tablebase/Stockfish best move but only returns level-1
   hint facts + the "why" — never the move itself) */
async function sparringHint() {
  if (!SP.attempt || SP.busy || SP.over) return;
  const sc = SP.scenarios[SP.idx];
  const packId = SP.pack && SP.pack.id;
  if (!sc || !packId) return;
  SP.busy = true;
  const box = $("sparring-hint");
  try {
    const r = await apiPost("/api/sparring/hint", {
      pack_id: packId, position_id: sc.id, fen: sparringBoard.getFen(),
    });
    box.textContent = "Hint: " + ((r.hint && r.hint.text) || "") +
      (r.why && r.why.text ? " Why the best move works: " + r.why.text : "");
    box.classList.remove("hidden");
    syncSpeakButtons();
  } catch (e) {
    box.className = "coach-box";
    box.textContent = "Hint unavailable: " + e.message;
    box.classList.remove("hidden");
    syncSpeakButtons();
  } finally {
    SP.busy = false;
  }
}

function sparringNext() {
  SP.idx++;
  if (SP.idx < SP.scenarios.length) {
    sparringPickSide();
  } else {
    sparringExit();
    loadSparringAll();
  }
}

function sparringExit() {
  SP.seq++;
  SP.attempt = null;
  SP.over = false;
  SP.pack = null;
  sparringUpdateClaimButtons();
  $("btn-sparring-hint").disabled = true;
  $("sparring-hint").classList.add("hidden");
  syncSpeakButtons();
  sparringBoard.setInteractive(false);
  $("sparring-board-note").textContent = "";
  $("sparring-run").classList.add("hidden");
  $("sparring-pack-list").classList.remove("hidden");
}

$("btn-sparring-generate").addEventListener("click", sparringGenerate);
$("btn-sparring-claim-win").addEventListener("click", () => {
  if (SP.attempt && !SP.busy && !SP.over &&
      (SP.attempt.moves || 0) > 0) sparringFinish("win");
});
$("btn-sparring-claim-draw").addEventListener("click", () => {
  if (SP.attempt && !SP.busy && !SP.over &&
      (SP.attempt.moves || 0) > 0) sparringFinish("draw");
});
$("btn-sparring-resign").addEventListener("click", () => {
  if (SP.attempt && !SP.busy && !SP.over) sparringFinish("loss");
});
$("btn-sparring-restart").addEventListener("click", () => {
  if (SP.attempt) sparringStartAttempt(SP.attempt.user_side);
});
$("btn-sparring-hint").addEventListener("click", sparringHint);
$("btn-sparring-mirror").addEventListener("click", () => {
  if (SP.attempt && !SP.busy) {
    const mirror = SP.attempt.user_side === "white" ? "black" : "white";
    sparringStartAttempt(mirror);
  }
});
$("btn-sparring-next").addEventListener("click", sparringNext);
$("btn-sparring-exit").addEventListener("click", () => {
  sparringExit();
  loadSparringAll();
});

/* ================= V19: Endgame Canon Curriculum + Leak Detector =================
   Tiered endgame curriculum: every lesson goal is tablebase-verified on
   the server; this client renders the tier map, runs the guided play-out
   (same mechanics as sparring: /api/move for legality,
   /api/sparring/opponent-move for the opponent, verified result claims)
   and the leak scan. Placement = six play-outs that recommend a starting
   tier. */

const EG = {
  canon: null,       // /api/endgame/canon payload
  attempt: null,     // {mode: "lesson"|"placement", lesson_id, user_side,
                     //  goal, token, session_id, index, total, title}
  busy: false,
  over: false,
  seq: 0,
};

const EG_GOAL_TEXT = { win: "WIN", hold: "HOLD the draw" };

const endgameBoard = new Board($("endgame-board"), { onMove: onEndgameMove });
endgameBoard.setInteractive(false);

function initEndgames() {
  loadEndgameCanon();
}

async function loadEndgameCanon() {
  try {
    EG.canon = await apiGet("/api/endgame/canon");
  } catch (e) {
    EG.canon = null;
    showError("Endgame curriculum unavailable: " + e.message);
  }
  renderEndgameSummary();
  renderEndgameTiers();
}

function egSideName(side) { return side === "white" ? "White" : "Black"; }

function renderEndgameSummary() {
  const host = $("endgame-summary");
  host.innerHTML = "";
  const c = EG.canon;
  if (!c) return;
  const d = document.createElement("div");
  d.className = "info-line";
  let text = "Curriculum: " + c.passed + " / " + c.total + " lessons passed.";
  const p = c.placement;
  if (p && p.completed) {
    text += " Placement recommends starting at tier " + p.recommended_tier + ".";
  }
  d.textContent = text;
  host.appendChild(d);
}

const EG_STATUS_LABEL = { passed: "✓", available: "▶", locked: "🔒" };

function renderEndgameTiers() {
  const host = $("endgame-tiers");
  host.innerHTML = "";
  const c = EG.canon;
  if (!c || !c.tiers || !c.tiers.length) {
    const d = document.createElement("div");
    d.className = "info-line muted";
    d.textContent = "No endgame canon available.";
    host.appendChild(d);
    return;
  }
  for (const tier of c.tiers) {
    const box = document.createElement("div");
    box.className = "cycle-set-row sp-pack-row";
    const head = document.createElement("div");
    head.className = "panel-row";
    const title = document.createElement("b");
    const passed = tier.lessons.filter(l => l.status === "passed").length;
    title.textContent = "Tier " + tier.tier + " — " + passed + "/" +
      tier.lessons.length + " passed";
    head.appendChild(title);
    box.appendChild(head);
    for (const lesson of tier.lessons) {
      const row = document.createElement("div");
      row.className = "panel-row eg-lesson-row";
      const mark = document.createElement("span");
      mark.className = "eg-status eg-" + lesson.status;
      mark.textContent = EG_STATUS_LABEL[lesson.status] || "?";
      row.appendChild(mark);
      const name = document.createElement("span");
      name.className = "eg-lesson-name";
      name.textContent = lesson.title;
      row.appendChild(name);
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = (EG_GOAL_TEXT[lesson.goal] || lesson.goal) + " as " +
        egSideName(lesson.user_side) +
        (lesson.attempts ? " · " + lesson.passes + "/" + lesson.attempts + " passed" : "");
      row.appendChild(meta);
      if (lesson.status !== "locked") {
        const btn = document.createElement("button");
        btn.className = "btn mini";
        btn.textContent = lesson.status === "passed" ? "Review" : "Start";
        btn.addEventListener("click", () => endgameStartLesson(lesson.id));
        row.appendChild(btn);
      }
      box.appendChild(row);
    }
    host.appendChild(box);
  }
}

/* ---- lesson / placement play-out runner (sparring mechanics) ---- */

async function endgameStartLesson(lessonId) {
  EG.seq++;
  EG.busy = true;
  EG.over = false;
  endgameBoard.setInteractive(false);
  $("endgame-feedback").classList.add("hidden");
  $("btn-endgame-next").classList.add("hidden");
  $("endgame-tiers").classList.add("hidden");
  $("endgame-run").classList.remove("hidden");
  $("endgame-status").textContent = "Preparing the lesson…";
  try {
    const r = await apiPost("/api/endgame/lesson/" + lessonId + "/start", {
      level: sparringLevel(),
    });
    $("endgame-run-title").textContent = r.title;
    $("endgame-explain").textContent = r.explanation || "";
    endgameBegin({
      mode: "lesson", lesson_id: lessonId, user_side: r.user_side,
      goal: r.goal, token: r.attempt_token, title: r.title,
    }, r);
  } catch (e) {
    $("endgame-status").textContent = "Could not start: " + e.message;
    endgameExit();
  } finally {
    EG.busy = false;
  }
}

function endgameBegin(attempt, r) {
  EG.attempt = attempt;
  EG.attempt.moves = 0;
  endgameUpdateClaimButtons();
  // V22 hint: lessons only (placement positions have no hint endpoint)
  $("endgame-hint").classList.add("hidden");
  syncSpeakButtons();
  $("btn-endgame-hint").disabled = attempt.mode !== "lesson";
  $("endgame-brief").textContent =
    (r.theme || "") + " — " + (EG_GOAL_TEXT[r.goal] || r.goal) + " as " +
    egSideName(r.user_side);
  const opp = r.opponent || {};
  $("endgame-board-note").textContent = opp.type === "maia"
    ? "Opponent: Maia human-like engine @ ~" + opp.elo_self
    : "Opponent: Stockfish, skill " + opp.skill + " (level " +
      (opp.level || "club") + ")";
  endgameBoard.setFen(r.fen);
  endgameBoard.setOrientation(r.user_side);
  endgameBoard.setLastMove(null, null);
  endgameBoard.clearArrows();
  if (r.side_to_move !== (r.user_side === "white" ? "w" : "b")) {
    $("endgame-status").textContent = "Opponent to move…";
    endgameOpponentReply();
  } else {
    $("endgame-status").textContent = "Your move — " +
      (r.goal === "win" ? "convert the win." : "hold the draw.");
    endgameBoard.setInteractive(true);
    endgameCheckTerminal();
  }
}

function egUserLetter() {
  return EG.attempt && EG.attempt.user_side === "white" ? "w" : "b";
}

/* the server rejects win/draw claims on the untouched start position
   (422 no_moves_played) — keep the claim buttons off until the user has
   actually played a move */
function endgameUpdateClaimButtons() {
  const can = !!(EG.attempt && !EG.over && (EG.attempt.moves || 0) > 0);
  $("btn-endgame-claim-win").disabled = !can;
  $("btn-endgame-claim-draw").disabled = !can;
}

async function onEndgameMove(from, to) {
  if (!EG.attempt || EG.busy || EG.over) return;
  const fen = endgameBoard.getFen();
  if (fenSide(fen) !== egUserLetter()) { endgameBoard.shake(); return; }
  EG.busy = true;
  const uci = uciCandidate(endgameBoard, from, to);
  try {
    const r = await apiPost("/api/move", { fen, move_uci: uci });
    if (!r.legal) { endgameBoard.shake(); return; }
    EG.attempt.moves = (EG.attempt.moves || 0) + 1;
    endgameUpdateClaimButtons();
    endgameBoard.setFen(r.fen_after);
    endgameBoard.setLastMove(from, to);
    endgameBoard.clearArrows();
    $("endgame-status").textContent = "You played " + r.san +
      " — opponent to move…";
    if (await endgameCheckTerminal()) return;
    endgameOpponentReply();
  } catch (e) {
    showError(e.message);
  } finally {
    EG.busy = false;
  }
}

async function endgameOpponentReply() {
  if (!EG.attempt || EG.over) return;
  const fen = endgameBoard.getFen();
  const seq = EG.seq;
  EG.busy = true;
  try {
    const r = await apiPost("/api/sparring/opponent-move", {
      fen, level: sparringLevel(),
    });
    if (seq !== EG.seq || !EG.attempt || endgameBoard.getFen() !== fen) return;
    if (r.terminal) { await endgameCheckTerminal(); return; }
    endgameBoard.setFen(r.fen_after);
    endgameBoard.setLastMove(r.uci.slice(0, 2), r.uci.slice(2, 4));
    $("endgame-status").textContent = "Opponent played " + r.san +
      " — your move.";
    if (await endgameCheckTerminal()) return;
    endgameBoard.setInteractive(true);
  } catch (e) {
    if (seq !== EG.seq) return;
    $("endgame-status").textContent =
      "Couldn't get the opponent's move: " + e.message;
  } finally {
    if (seq === EG.seq) EG.busy = false;
  }
}

async function endgameCheckTerminal() {
  if (!EG.attempt || EG.over) return false;
  const fen = endgameBoard.getFen();
  const seq = EG.seq;
  try {
    const r = await apiPost("/api/board/status", { fen });
    if (seq !== EG.seq || !EG.attempt || endgameBoard.getFen() !== fen) {
      return false;
    }
    if (!r.terminal) return false;
    let result = "draw";
    if (r.result === "1-0") result = EG.attempt.user_side === "white" ? "win" : "loss";
    else if (r.result === "0-1") result = EG.attempt.user_side === "black" ? "win" : "loss";
    await endgameFinish(result, fen);
    return true;
  } catch (_) {
    return false; // offline tolerance — the board still rejects illegal moves
  }
}

/* finish: lesson complete or placement answer — the server VERIFIES the
   claim against final_fen and answers pass/fail */
async function endgameFinish(result, finalFen) {
  if (!EG.attempt || EG.over) return;
  const att = EG.attempt;
  EG.busy = true;
  EG.over = true;
  endgameUpdateClaimButtons();
  $("btn-endgame-hint").disabled = true;
  endgameBoard.setInteractive(false);
  const url = att.mode === "placement"
    ? "/api/endgame/placement/answer"
    : "/api/endgame/lesson/" + att.lesson_id + "/complete";
  const payload = {
    result: result,
    final_fen: finalFen || endgameBoard.getFen(),
    attempt_token: att.token,
  };
  if (att.mode === "placement") payload.session_id = att.session_id;
  try {
    const r = await apiPost(url, payload);
    const fb = $("endgame-feedback");
    fb.className = "banner " + (r.passed ? "green" : "red");
    const goalText = EG_GOAL_TEXT[r.goal] || r.goal;
    let text = (r.passed ? "Passed — " : "Failed — ") +
      "goal was " + goalText + ", you scored a " + r.result + " (" +
      (r.verification && r.verification.detail ? r.verification.detail : "verified") +
      ").";
    if (!r.passed && att.mode === "lesson") {
      text += " The position was added to your flashcards.";
    }
    if (att.mode === "lesson" && r.passed && r.tier_complete) {
      text += " Tier complete!";
    }
    fb.textContent = text;
    fb.classList.remove("hidden");
    $("endgame-status").textContent = "";
    if (att.mode === "placement") {
      if (r.done) {
        fb.textContent = text + " Placement complete — recommended " +
          "starting tier: " + r.recommended_tier + ".";
        $("endgame-placement-status").textContent =
          "Recommended starting tier: " + r.recommended_tier;
        $("btn-endgame-next").classList.add("hidden");
      } else {
        // continue the placement with the next position
        $("btn-endgame-next").classList.remove("hidden");
        EG.attempt = null;
        $("btn-endgame-next").onclick = () => endgamePlacementNext(r);
        loadEndgameCanon();
        return;
      }
    } else if (r.passed && r.next_lesson) {
      $("btn-endgame-next").classList.remove("hidden");
      $("btn-endgame-next").onclick = () => endgameStartLesson(r.next_lesson.id);
    }
    loadEndgameCanon();
  } catch (e) {
    EG.over = false; // the claim was refused — the attempt is still live
    endgameUpdateClaimButtons();
    $("btn-endgame-hint").disabled = att.mode !== "lesson";
    const fb = $("endgame-feedback");
    fb.className = "banner amber";
    fb.textContent = e.status === 422
      ? "Claim rejected: " + (e.detail && e.detail.detail ? e.detail.detail : e.message)
      : e.status === 503
        ? "Engine busy or unavailable — try again in a moment."
        : "Could not finish: " + e.message;
    fb.classList.remove("hidden");
    endgameBoard.setInteractive(true);
    // the finish consumed the one-shot token — the server attaches a fresh
    // one to its 422 (or the lesson start endpoint can re-mint)
    if (att && e.detail && e.detail.retry_token) {
      att.token = e.detail.retry_token;
    }
  } finally {
    EG.busy = false;
  }
}

function endgameExit() {
  EG.seq++;
  EG.attempt = null;
  EG.over = false;
  endgameUpdateClaimButtons();
  $("btn-endgame-hint").disabled = true;
  $("endgame-hint").classList.add("hidden");
  syncSpeakButtons();
  endgameBoard.setInteractive(false);
  $("endgame-board-note").textContent = "";
  $("endgame-run").classList.add("hidden");
  $("endgame-tiers").classList.remove("hidden");
  loadEndgameCanon();
}

/* V22: hint for the CURRENT lesson board (tablebase-verified best move;
   the server returns only level-1 hint facts + the "why", never the move) */
async function endgameHint() {
  if (!EG.attempt || EG.attempt.mode !== "lesson" || EG.busy || EG.over) return;
  EG.busy = true;
  const box = $("endgame-hint");
  try {
    const r = await apiPost("/api/endgame/hint", {
      lesson_id: EG.attempt.lesson_id, fen: endgameBoard.getFen(),
    });
    box.textContent = "Hint: " + ((r.hint && r.hint.text) || "") +
      (r.why && r.why.text ? " Why the best move works: " + r.why.text : "");
    box.classList.remove("hidden");
    syncSpeakButtons();
  } catch (e) {
    box.className = "coach-box";
    box.textContent = "Hint unavailable: " + e.message;
    box.classList.remove("hidden");
    syncSpeakButtons();
  } finally {
    EG.busy = false;
  }
}

/* ---- placement flow ---- */

async function endgamePlacementStart() {
  const status = $("endgame-placement-status");
  status.textContent = "Preparing the placement test…";
  try {
    const r = await apiPost("/api/endgame/placement/start", {
      level: sparringLevel(),
    });
    status.textContent = "";
    EG.placementSession = r.session_id;
    $("endgame-tiers").classList.add("hidden");
    $("endgame-run").classList.remove("hidden");
    $("endgame-feedback").classList.add("hidden");
    $("btn-endgame-next").classList.add("hidden");
    $("endgame-run-title").textContent = "Placement test — position " +
      (r.index + 1) + "/" + r.total;
    $("endgame-explain").textContent =
      "Play this position out against the engine. Your pass/fail pattern " +
      "across six positions recommends your starting tier.";
    EG.over = false;
    endgameBegin({
      mode: "placement", session_id: r.session_id,
      user_side: r.user_side, goal: r.goal, token: r.attempt_token,
      title: r.title, index: r.index, total: r.total,
    }, r);
  } catch (e) {
    status.textContent = "Could not start the placement: " + e.message;
  }
}

/* continue a placement after a graded position (payload from the answer) */
function endgamePlacementNext(answer) {
  const r = answer.next;
  if (!r) { endgameExit(); return; }
  EG.seq++;
  EG.over = false;
  endgameBoard.setInteractive(false);
  $("endgame-feedback").classList.add("hidden");
  $("btn-endgame-next").classList.add("hidden");
  $("endgame-run-title").textContent = "Placement test — position " +
    (r.index + 1) + "/" + r.total;
  endgameBegin({
    mode: "placement", session_id: EG.placementSession,
    user_side: r.user_side, goal: r.goal, token: r.attempt_token,
    title: r.title, index: r.index, total: r.total,
  }, r);
}

/* ---- leak detector ---- */

async function endgameLeaksScan(rescan) {
  const status = $("endgame-leaks-status");
  const host = $("endgame-leaks");
  host.innerHTML = "";
  status.textContent = rescan
    ? "Re-verifying every game against the tablebase (cache ignored)…"
    : "Scanning your games against the tablebase…";
  try {
    const r = await apiPost("/api/endgame/leaks/scan", {
      rescan: !!rescan,
    });
    status.textContent = "Scanned " + r.games_total + " games (" +
      r.games_scanned + " verified, " + r.games_cached + " from cache)." +
      (r.games_degraded
        ? " " + r.games_degraded + " could not be verified — the " +
          "tablebase and engine were unreachable; they were NOT cached, " +
          "so scan again later (or use Rescan)."
        : "");
    renderEndgameLeaks(r);
  } catch (e) {
    status.textContent = "Leak scan failed: " + e.message;
  }
}

const EG_LEAK_LABEL = {
  win_not_converted: "win not converted",
  draw_lost: "draw slipped to a loss",
};

function renderEndgameLeaks(r) {
  const host = $("endgame-leaks");
  host.innerHTML = "";
  if (!r.leaks || !r.leaks.length) {
    const d = document.createElement("div");
    d.className = "info-line muted";
    d.textContent = "No tablebase leaks found — every endgame that reached " +
      "a won or drawn theoretical position ended as it should.";
    host.appendChild(d);
    return;
  }
  const counts = document.createElement("div");
  counts.className = "info-line";
  const parts = Object.keys(r.by_class || {}).sort().map(k =>
    k + ": " + r.by_class[k]);
  counts.textContent = r.leaks.length + " leak" +
    (r.leaks.length > 1 ? "s" : "") + " — " + parts.join(" · ");
  host.appendChild(counts);

  for (const leak of r.leaks.slice(0, 10)) {
    const row = document.createElement("div");
    row.className = "info-line";
    row.textContent = (leak.date || "?") + " — " + (leak.white || "?") +
      " vs " + (leak.black || "?") + ": " +
      (EG_LEAK_LABEL[leak.type] || leak.type) + " (" + leak.piece_class +
      " ending, you were " + leak.user_side + ", " + leak.result + ")" +
      (leak.side_uncertain
        ? " — side uncertain: set your username in settings"
        : "");
    host.appendChild(row);
  }

  const recs = (r.recommended_lessons || []).filter(l => !l.passed);
  if (recs.length) {
    const head = document.createElement("div");
    head.className = "info-line";
    head.textContent = "Recommended lessons:";
    host.appendChild(head);
    for (const rec of recs) {
      const row = document.createElement("div");
      row.className = "panel-row";
      const name = document.createElement("span");
      name.className = "eg-lesson-name";
      name.textContent = "Tier " + rec.tier + " — " + rec.title;
      row.appendChild(name);
      const btn = document.createElement("button");
      btn.className = "btn mini primary";
      btn.textContent = "Start lesson";
      btn.addEventListener("click", () => endgameStartLesson(rec.id));
      row.appendChild(btn);
      host.appendChild(row);
    }
  }
}

$("btn-endgame-placement").addEventListener("click", endgamePlacementStart);
$("btn-endgame-claim-win").addEventListener("click", () => {
  if (EG.attempt && !EG.busy && !EG.over &&
      (EG.attempt.moves || 0) > 0) endgameFinish("win");
});
$("btn-endgame-claim-draw").addEventListener("click", () => {
  if (EG.attempt && !EG.busy && !EG.over &&
      (EG.attempt.moves || 0) > 0) endgameFinish("draw");
});
$("btn-endgame-resign").addEventListener("click", () => {
  if (EG.attempt && !EG.busy && !EG.over) endgameFinish("loss");
});
$("btn-endgame-restart").addEventListener("click", () => {
  if (EG.attempt && EG.attempt.mode === "lesson") {
    endgameStartLesson(EG.attempt.lesson_id);
  }
});
$("btn-endgame-exit").addEventListener("click", endgameExit);
$("btn-endgame-hint").addEventListener("click", endgameHint);
$("btn-endgame-leaks").addEventListener("click", () => endgameLeaksScan(false));
$("btn-endgame-leaks-rescan").addEventListener("click",
  () => endgameLeaksScan(true));

/* ================= V18: Play Like the Master (Guess-the-Move) =================
   Solitaire chess on classic games: the user plays the winner's moves
   from the early middlegame. The server owns the game score (the played
   prefix only ever reaches the client) and grades every guess with the
   shared 7-grade engine bands — ChessBase-style partial credit, so an
   equivalent-but-different move is not punished, and the master's own
   move always earns full credit. Each reveal contrasts three moves: the
   master's actual move, the engine's best, and Maia's human move at the
   user's rating (when the optional engine is installed). */

const GTM = {
  games: [],
  session: null,   // locked session payload (prefix moves only)
  reveal: null,    // the last guess reveal
  busy: false,
};

const gtmBoard = new Board($("gtm-board"), { onMove: onGtmMove });
gtmBoard.setInteractive(false);

const GTM_GRADE_LABEL = {
  brilliant: "Brilliant", great: "Great move", best: "Best move",
  good: "Good move", inaccuracy: "Inaccuracy", mistake: "Mistake",
  blunder: "Blunder",
};

function initMasters() {
  loadGtmLibrary();
}

async function loadGtmLibrary() {
  try {
    const r = await apiGet("/api/gtm/games");
    GTM.games = r.games || [];
  } catch (e) {
    GTM.games = [];
    showError("Master-game library unavailable: " + e.message);
  }
  try {
    const h = await apiGet("/api/gtm/history");
    renderGtmHistory(h.entries || []);
  } catch (_) {
    renderGtmHistory([]); // history is optional — the library still renders
  }
  renderGtmLibrary();
}

function renderGtmHistory(entries) {
  const host = $("gtm-history");
  host.innerHTML = "";
  if (!entries.length) return;
  const d = document.createElement("div");
  d.className = "info-line";
  const parts = entries.slice(0, 5).map(e =>
    (e.title || "Session") + ": " +
    (e.score == null ? "–" : Math.round(e.score) + "/100"));
  d.textContent = "Recent master-match scores — " + parts.join(" · ");
  host.appendChild(d);
}

function renderGtmLibrary() {
  const host = $("gtm-library");
  host.innerHTML = "";
  if (!GTM.games.length) {
    const d = document.createElement("div");
    d.className = "info-line muted";
    d.textContent = "The master-game library is empty.";
    host.appendChild(d);
    return;
  }
  // v40: games where you sit on your usual side come first
  const side = typeof mySide === "function" ? mySide() : "white";
  const ordered = GTM.games.slice().sort((a, b) => (b.user_side === side) - (a.user_side === side));
  for (const g of ordered) {
    const row = document.createElement("div");
    row.className = "cycle-set-row gtm-game-row" + (g.user_side === side ? " my-side" : "");
    const head = document.createElement("div");
    head.className = "panel-row";
    const name = document.createElement("b");
    name.textContent = g.title;
    head.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = " " + g.white + " – " + g.black + ", " + g.year;
    head.appendChild(meta);
    row.appendChild(head);

    const sub = document.createElement("div");
    sub.className = "info-line";
    sub.textContent = "You play " +
      (g.user_side === "white" ? g.white : g.black) +
      " (" + (g.user_side === "white" ? "White" : "Black") + ") · " +
      g.guesses_to_make + " moves to guess" +
      (g.best_score != null ? " · best score " + Math.round(g.best_score) + "/100" : "");
    row.appendChild(sub);

    const chips = document.createElement("div");
    chips.className = "chip-row";
    for (const theme of (g.themes || [])) {
      const chip = document.createElement("span");
      chip.className = "chip plan";
      chip.textContent = theme;
      chips.appendChild(chip);
    }
    row.appendChild(chips);

    const btns = document.createElement("div");
    btns.className = "panel-row";
    if (g.active_session_id) {
      const resume = document.createElement("button");
      resume.className = "btn primary";
      resume.textContent = "Resume session";
      resume.addEventListener("click", () => gtmResume(g.active_session_id));
      btns.appendChild(resume);
    }
    const start = document.createElement("button");
    start.className = g.active_session_id ? "btn" : "btn primary";
    start.textContent = g.active_session_id ? "New session" : "Play";
    start.addEventListener("click", () => gtmStart(g.id));
    btns.appendChild(start);
    row.appendChild(btns);
    host.appendChild(row);
  }
}

function gtmElo() {
  const el = $("gtm-elo");
  const n = parseInt(el && el.value, 10);
  return Number.isFinite(n) ? n : 1500;
}

async function gtmStart(gameId) {
  try {
    const r = await apiPost("/api/gtm/session/start", {
      game_id: gameId, elo: gtmElo(),
    });
    gtmEnter(r);
  } catch (e) {
    showError("Could not start the session: " + e.message);
  }
}

async function gtmResume(sessionId) {
  try {
    const r = await apiGet("/api/gtm/session/" + sessionId + "/state");
    gtmEnter(r);
  } catch (e) {
    showError("Could not resume the session: " + e.message);
  }
}

/* enter/resume a session: render the locked payload on the board */
function gtmEnter(sess) {
  GTM.session = sess;
  GTM.reveal = null;
  $("gtm-library").classList.add("hidden");
  $("gtm-history").classList.add("hidden");
  $("gtm-run").classList.remove("hidden");
  $("gtm-reveal").classList.add("hidden");
  $("gtm-debrief").classList.add("hidden");
  $("gtm-summary").classList.add("hidden");
  $("gtm-run-title").textContent = sess.title;
  $("gtm-run-meta").textContent = sess.white + " – " + sess.black + ", " +
    sess.event + " " + sess.year + " · you play " +
    (sess.user_side === "white" ? sess.white : sess.black);
  gtmBoard.setFen(sess.fen);
  gtmBoard.setOrientation(sess.user_side);
  gtmBoard.setLastMove(null, null);
  gtmBoard.clearArrows();
  gtmRenderMoves();
  if (sess.finished) {
    $("gtm-hint").classList.add("hidden");
    syncSpeakButtons();
    $("btn-gtm-hint").disabled = true;
    gtmShowSummary(sess.summary);
  } else {
    $("gtm-prompt").textContent = "Your move — what did the master play?";
    $("gtm-board-note").textContent = "Guess the move on the board.";
    $("gtm-hint").classList.add("hidden");
    syncSpeakButtons();
    $("btn-gtm-hint").disabled = false;
    gtmBoard.setInteractive(true);
  }
}

/* move list up to the current point (the played prefix only) */
function gtmRenderMoves() {
  const host = $("gtm-moves");
  host.innerHTML = "";
  const sans = (GTM.session && GTM.session.moves_san) || [];
  let line = "";
  sans.forEach((san, i) => {
    if (i % 2 === 0) line += (i / 2 + 1) + ". " + san + " ";
    else line += san + "  ";
  });
  host.textContent = line;
}

/* V22: pre-guess hint about the MASTER's move (level-1 board facts from
   the server — never the move itself; no scoring penalty) */
async function gtmHint() {
  if (!GTM.session || GTM.busy || GTM.session.finished || GTM.reveal) return;
  GTM.busy = true;
  const line = $("gtm-hint");
  try {
    const r = await apiPost("/api/gtm/session/" + GTM.session.session_id +
      "/hint", {});
    line.textContent = "Hint: " + ((r.hint && r.hint.text) || "") +
      (r.hint_penalty ? "" : " (no scoring penalty)");
    line.classList.remove("hidden");
    syncSpeakButtons();
    $("btn-gtm-hint").disabled = true; // one hint per position is enough
  } catch (e) {
    showError("Hint failed: " + e.message);
  } finally {
    GTM.busy = false;
  }
}

function gtmUserLetter() {
  return GTM.session && GTM.session.user_side === "white" ? "w" : "b";
}

async function onGtmMove(from, to) {
  if (!GTM.session || GTM.busy || GTM.session.finished) return;
  if (GTM.reveal) return; // reveal open — press Continue first
  const fen = gtmBoard.getFen();
  if (fenSide(fen) !== gtmUserLetter()) { gtmBoard.shake(); return; }
  GTM.busy = true;
  gtmBoard.setInteractive(false);
  try {
    const r = await apiPost("/api/gtm/session/" + GTM.session.session_id +
      "/guess", { uci: uciCandidate(gtmBoard, from, to) });
    GTM.session.moves_san = r.moves_san;
    GTM.session.fen = r.fen;
    GTM.session.finished = r.finished;
    GTM.session.summary = r.summary;
    GTM.session.guesses = (GTM.session.guesses || []).concat([r.guess]);
    GTM.reveal = r.guess;
    gtmBoard.setFen(r.fen);
    const last = r.guess.opponent_reply || r.guess.master;
    if (last && last.uci) {
      gtmBoard.setLastMove(last.uci.slice(0, 2), last.uci.slice(2, 4));
    }
    gtmRenderMoves();
    gtmShowReveal(r.guess);
    $("btn-gtm-hint").disabled = true; // reveal is out — hint is moot
  } catch (e) {
    gtmBoard.setFen(fen); // rejected guess (or server error) — revert
    if (e.status === 400) gtmBoard.shake();
    else showError("Guess failed: " + e.message);
    gtmBoard.setInteractive(true);
  } finally {
    GTM.busy = false;
  }
}

/* the three-way contrast reveal: master / engine / Maia-at-your-level */
function gtmShowReveal(g) {
  $("gtm-reveal").classList.remove("hidden");
  $("gtm-debrief").classList.add("hidden");
  const grade = $("gtm-grade");
  grade.textContent = (GTM_GRADE_LABEL[g.grade] || g.grade) +
    (g.master_match ? " — the master's move!" : "");
  grade.className = "chip gtm-grade-" + (g.grade || "best");
  $("gtm-credit").textContent = "partial credit: " +
    Math.round((g.credit || 0) * 100) + "%" +
    (typeof g.cpl === "number" ? " (" + g.cpl + "cp lost)" : "");
  $("gtm-your").textContent = "You guessed: " + g.your_san;
  $("gtm-master").textContent = "Master played: " + g.master.san +
    (g.opponent_reply ? " — the game went " + g.opponent_reply.san : " — game over");
  const ev = g.engine && g.engine.eval;
  $("gtm-engine").textContent = "Engine best: " + g.engine.san +
    (ev ? " (" + evalText(ev) + ")" : "");
  $("gtm-maia").textContent = g.maia
    ? "A ~" + g.maia.elo + " player would play: " + g.maia.san
    : "Human-move lens unavailable (Maia not installed)";
  $("btn-gtm-continue").textContent =
    GTM.session && GTM.session.finished ? "See summary" : "Continue";
  $("gtm-prompt").textContent = g.master_match
    ? "Exactly the master's choice."
    : "Compare the three moves, then continue.";
}

function gtmContinue() {
  $("gtm-reveal").classList.add("hidden");
  GTM.reveal = null;
  gtmBoard.clearArrows();
  if (GTM.session && GTM.session.finished) {
    $("gtm-hint").classList.add("hidden");
    syncSpeakButtons();
    $("btn-gtm-hint").disabled = true;
    gtmShowSummary(GTM.session.summary);
    return;
  }
  // new position, fresh hint allowance
  $("gtm-hint").classList.add("hidden");
  syncSpeakButtons();
  $("btn-gtm-hint").disabled = false;
  $("gtm-prompt").textContent = "Your move — what did the master play?";
  gtmBoard.setInteractive(true);
}

function gtmShowSummary(summary) {
  gtmBoard.setInteractive(false);
  $("gtm-reveal").classList.add("hidden");
  const box = $("gtm-summary");
  box.classList.remove("hidden");
  const s = summary || {};
  $("gtm-score").textContent = s.score == null
    ? "No guesses scored"
    : "Master-match score: " + Math.round(s.score) + " / 100";
  $("gtm-summary-line").textContent = s.guesses
    ? s.master_matches + " of " + s.guesses + " moves matched the master" +
      " · mean partial credit " +
      (s.mean_credit == null ? "–" : Math.round(s.mean_credit * 100) + "%") +
      " · themes: " + (s.themes || []).join(", ")
    : "Finish after at least one guess to earn a score.";
  const strip = $("gtm-grade-strip");
  strip.innerHTML = "";
  for (const g of (GTM.session.guesses || [])) {
    const chip = document.createElement("span");
    chip.className = "chip gtm-grade-" + (g.grade || "best");
    chip.textContent = g.your_san + (g.master_match ? " ★" : "");
    chip.title = (GTM_GRADE_LABEL[g.grade] || g.grade) + " — credit " +
      Math.round((g.credit || 0) * 100) + "%";
    strip.appendChild(chip);
  }
  $("gtm-prompt").textContent = "Session complete.";
}

/* "Ask coach why": the server routes a contextual question about the
   revealed position through the coach chat engine. */
async function gtmDebrief() {
  if (!GTM.session || !GTM.reveal || GTM.busy) return;
  GTM.busy = true;
  const box = $("gtm-debrief");
  box.classList.remove("hidden");
  box.textContent = "Thinking…";
  try {
    const r = await apiPost("/api/gtm/session/" + GTM.session.session_id +
      "/debrief", { ply: GTM.reveal.ply, question: "" });
    const chat = r.chat || {};
    box.textContent = chat.reply || "…";
    syncSpeakButtons(); // the debrief reply is speakable
    if (chat.session_id) chatStoreSession(chat.session_id);
  } catch (e) {
    const eng = await surfaceEngineError(e);
    box.textContent = eng
      ? "Engine unavailable — see the banner above."
      : "Coach unavailable: " + e.message;
  } finally {
    GTM.busy = false;
  }
}

async function gtmFinish() {
  if (!GTM.session || GTM.busy) return;
  GTM.busy = true;
  try {
    const r = await apiPost("/api/gtm/session/" + GTM.session.session_id +
      "/finish", {});
    GTM.session.finished = true;
    GTM.session.summary = r.summary;
    GTM.reveal = null;
    gtmShowSummary(r.summary);
  } catch (e) {
    showError("Could not finish the session: " + e.message);
  } finally {
    GTM.busy = false;
  }
}

function gtmExit() {
  GTM.session = null;
  GTM.reveal = null;
  gtmBoard.setInteractive(false);
  $("gtm-board-note").textContent = "";
  $("gtm-run").classList.add("hidden");
  $("gtm-library").classList.remove("hidden");
  $("gtm-history").classList.remove("hidden");
  loadGtmLibrary();
}

$("btn-gtm-continue").addEventListener("click", gtmContinue);
$("btn-gtm-debrief").addEventListener("click", gtmDebrief);
$("btn-gtm-finish").addEventListener("click", gtmFinish);
$("btn-gtm-hint").addEventListener("click", gtmHint);
$("btn-gtm-exit").addEventListener("click", gtmExit);

/* ================= My Games tab ================= */

const Games = {
  list: [],
  selected: null,       // game object from /api/import
  analysis: null,       // /api/analyze/game response
  review: null,         // {game, analysis} shown in the Game review panel
  recommendedLessons: [],
  viewPly: 0,           // ply currently shown on the analysis board
  startFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
};

const gameBoard = new Board($("game-board"), { interactive: false });

const gameNav = createNavControls("game-nav", {
  onNav: (dir) => {
    // post-mortem locked mode owns the board/nav on the Games tab
    if (typeof PM !== "undefined" && PM.active) { pmNavStep(dir); return; }
    if (!Games.analysis) return;
    const last = Games.analysis.moves.length;
    gameGoToPly(dir === "start" ? 0 : dir === "end" ? last : Games.viewPly + (dir === "next" ? 1 : -1));
  },
  isActive: () => $("tab-games").classList.contains("active") &&
    (!!Games.analysis || (typeof PM !== "undefined" && PM.active)),
});

function updateGameNav() {
  const a = Games.analysis;
  const last = a ? a.moves.length : 0;
  const p = a ? Games.viewPly : 0;
  gameNav.update({ start: p > 0, prev: p > 0, next: p < last, end: p < last });
}

function gameFenAt(ply) {
  return ply === 0 ? Games.startFen : Games.analysis.moves[ply - 1].fen_after;
}

function gameGoToPly(n) {
  const a = Games.analysis;
  if (!a) return;
  n = Math.max(0, Math.min(a.moves.length, n));
  Games.viewPly = n;
  gameBoard.setFen(gameFenAt(n));
  gameBoard.setLastMove(null, null);
  const host = $("game-moves");
  host.querySelectorAll(".mv").forEach((el, i) => el.classList.toggle("current", i === n - 1));
  const cur = host.querySelectorAll(".mv")[n - 1];
  if (cur) cur.scrollIntoView({ block: "nearest" });
  updateGameNav();
}

function isPgnSource() { return $("import-source").value === "pgn"; }
function isChesscomSource() { return $("import-source").value === "chesscom"; }

async function fetchGames() {
  if (isPgnSource()) return importPgnGames();
  if (isChesscomSource()) return importChesscomGames();
  const username = $("import-username").value.trim();
  if (!username) { $("import-status").textContent = "Enter a username."; return; }
  $("import-status").textContent = "Fetching…";
  try {
    const r = await apiPost("/api/import", { source: $("import-source").value, username });
    Games.list = r.games || [];
    $("import-status").textContent = Games.list.length + " game(s) loaded.";
    renderGamesList();
  } catch (e) {
    $("import-status").textContent = "Import failed: " + e.message;
  }
}

/* chess.com archive import: persists the last N months into the local
   library (/api/import/chesscom). V25 (DUP-5): the response carries the
   stored records for the fetched months, so the list repaints from this
   ONE call — the old second /api/import hop re-fetched chess.com. */
async function importChesscomGames() {
  const username = $("import-username").value.trim();
  if (!username) { $("import-status").textContent = "Enter a username."; return; }
  const parsed = parseInt($("import-months").value, 10);
  const months = Number.isNaN(parsed) ? 3 : parsed; // 0 = All history (valid!)
  $("import-status").textContent = months === 0
    ? "Importing your FULL chess.com history — this may take several minutes…"
    : "Importing from chess.com…";
  try {
    const r = await apiPost("/api/import/chesscom", { username, months_back: months });
    // review-fix (LOW-6): the games echo is capped server-side — say so
    $("import-status").textContent = "Imported " + r.games_imported +
      " games (" + r.duplicates_skipped + " already had)" +
      (r.games_truncated ? " (showing latest 200)" : "");
    Games.list = r.games || []; // repaint straight from the import response
    renderGamesList();
  } catch (e) {
    if (e.status === 404) $("import-status").textContent = "chess.com user not found";
    else if (e.status === 502) $("import-status").textContent = "chess.com unreachable — check connection";
    else $("import-status").textContent = "Import failed: " + e.message;
  }
}

/* warn early when "All history" is selected — full archives can take minutes */
$("import-months").addEventListener("change", () => {
  if ($("import-months").value === "0") {
    $("import-status").textContent = "All history selected — the import may take several minutes.";
  }
});

/* Noctie.ai / universal PGN import — multi-game PGN straight from the textarea */
async function importPgnGames() {
  const pgnText = $("import-pgn-text").value.trim();
  if (!pgnText) { $("import-status").textContent = "Paste a PGN or pick a .pgn file first."; return; }
  $("import-status").textContent = "Importing PGN…";
  try {
    const r = await apiPost("/api/import/pgn", { pgn_text: pgnText });
    Games.list = r.games || [];
    $("import-status").textContent = Games.list.length === 0
      ? "No games found in that PGN."
      : (r.stored != null ? r.stored : Games.list.length) +
        " game(s) imported (" + (r.duplicates_skipped || 0) + " already in library).";
    renderGamesList();
  } catch (e) {
    $("import-status").textContent = "Import failed: " + e.message;
  }
}

/* reflect the selected import source in the UI (also called at startup) */
function syncImportUI() {
  const pgn = isPgnSource();
  const chesscom = isChesscomSource();
  $("import-username").classList.toggle("hidden", pgn);
  $("import-months").classList.toggle("hidden", !chesscom);
  $("pgn-import-block").classList.toggle("hidden", !pgn);
  $("btn-fetch-games").textContent = pgn ? "Import PGN" : chesscom ? "Import" : "Fetch games";
  // prefill the configured handle for the chosen source (never overwrite typing)
  const prefill = chesscom ? State.usernames.chesscom : State.usernames.lichess;
  if (!pgn && prefill && !$("import-username").value.trim()) {
    $("import-username").value = prefill;
  }
  $("import-status").textContent = "";
}

$("import-source").addEventListener("change", syncImportUI);

/* .pgn file picker → read the file text into the textarea */
$("import-pgn-file").addEventListener("change", (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("import-pgn-text").value = String(reader.result || "");
    $("import-status").textContent = 'Loaded "' + f.name + '" — review the PGN, then click Import PGN.';
  };
  reader.onerror = () => { $("import-status").textContent = "Could not read that file."; };
  reader.readAsText(f);
  ev.target.value = ""; // allow picking the same file again
});

function renderGamesList() {
  const host = $("games-list");
  host.innerHTML = "";
  // while a coach-locked post-mortem owns the tab, every engine-verdict
  // entry point stays inert so the lock cannot be bypassed (or lost)
  const pmLocked = typeof PM !== "undefined" && PM.active;
  if (!Games.list.length) {
    host.appendChild(emptyStateCard({
      icon: "♟", title: "Import your games",
      text: "Pull your recent games from chess.com or lichess (enter your username above), or paste a PGN. " +
        "Then run a game review to find your key mistakes, start a post-mortem, or turn them into puzzles and flashcards.",
      actions: [
        { label: "Enter my username", primary: true, onClick: () => { const i = $("import-username"); if (i) { const src = $("import-source"); if (src && src.value === "pgn") { src.value = "chesscom"; src.dispatchEvent(new Event("change")); } i.focus(); } } },
        { label: "Paste a PGN", onClick: () => { const src = $("import-source"); if (src) { src.value = "pgn"; src.dispatchEvent(new Event("change")); const t = $("import-pgn-text"); if (t) t.focus(); } } },
      ],
    }));
  }
  Games.list.forEach((g, i) => {
    const d = document.createElement("div");
    d.className = "game-item";
    d.innerHTML = "<div><b>" + escapeHtml(g.white) + "</b> vs <b>" + escapeHtml(g.black) + "</b> " +
      '<span class="gi-result">' + escapeHtml(g.result) + "</span></div>" +
      '<div class="info-line">' + (g.source === "mine"
        ? "Your game" + (g.mine_no ? " #" + g.mine_no : "") + " · as " + escapeHtml(g.my_side || "") +
          (g.my_accuracy != null ? " · " + Number(g.my_accuracy).toFixed(0) + "% accuracy" : "") +
          (g.my_blunders != null ? " · " + g.my_blunders + " blunder" + (g.my_blunders === 1 ? "" : "s") : "")
        : escapeHtml(g.date || "") + " · " + escapeHtml(g.time_class || "")) + "</div>";
    const openBtn = document.createElement("button");
    openBtn.className = "btn mini gi-open";
    openBtn.textContent = "Open in Lab";
    openBtn.title = "Load this game into the Strategy Lab";
    openBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      Games.selected = g;
      openGameInLab(g, 0);
    });
    d.appendChild(openBtn);
    // PRIMARY post-mortem entry point: the locked session starts straight
    // from the games list, BEFORE any engine review can leak the answer key
    const pmBtn = document.createElement("button");
    pmBtn.className = "btn mini gi-postmortem";
    pmBtn.textContent = "Post-mortem";
    pmBtn.title = pmLocked
      ? "Finish (or exit) the current post-mortem first"
      : "Commit to your own read of the critical moments BEFORE the engine reveals them";
    pmBtn.disabled = pmLocked;
    pmBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      startPostmortem(g);
    });
    d.appendChild(pmBtn);
    const reviewBtn = document.createElement("button");
    reviewBtn.className = "btn mini gi-review";
    reviewBtn.textContent = "Review mistakes";
    reviewBtn.title = pmLocked
      ? "Finish (or exit) the current post-mortem first"
      : "Scan this game for poor moves and review them on the Play board";
    reviewBtn.disabled = pmLocked;
    reviewBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      reviewGameMistakes(g, reviewBtn);
    });
    d.appendChild(reviewBtn);
    const grBtn = document.createElement("button");
    grBtn.className = "btn mini gi-gamereview";
    grBtn.textContent = "Game review";
    grBtn.title = pmLocked
      ? "Finish (or exit) the current post-mortem first"
      : "Full-game review: accuracy, move classifications and key moments";
    grBtn.disabled = pmLocked;
    grBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      runGameReview(g, grBtn);
    });
    d.appendChild(grBtn);
    d.addEventListener("click", () => {
      Games.selected = g;
      document.querySelectorAll(".game-item").forEach(el => el.classList.remove("selected"));
      d.classList.add("selected");
      $("btn-game-to-puzzles").disabled = false;
      $("game-analysis-status").textContent = "";
    });
    host.appendChild(d);
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* V25 (DUP-4): spoiler guard — an UNREVEALED post-mortem session for this
   game means Game review / Review mistakes would leak the engine verdicts
   the lock exists to withhold. Cheap GET by pgn_hash; best-effort (a
   failed lookup never blocks a review). */
async function pmSpoilerConfirm(game) {
  const h = game && game.pgn_hash;
  if (!h) return true; // games imported before V25 carry no hash
  try {
    const r = await apiGet("/api/postmortem/pending?pgn_hash=" + encodeURIComponent(h));
    if (r && r.pending) {
      return window.confirm("This game has an unfinished post-mortem — " +
        "reviewing now reveals engine verdicts. Continue?");
    }
  } catch (_) { /* guard is best-effort */ }
  return true;
}

/* V25 (DUP-4): rebuild the mistake list from an /api/analyze/game result
   (per-move evals/cpl/best moves are already in the response) instead of
   a second /api/mistakes/scan engine pass. Same contract as the scan:
   cpl >= 150, a DIFFERENT best move to recommend, worst 5 by cpl. */
function mistakesFromAnalysis(a) {
  const swings = (a.moves || []).filter(mv =>
    mv.cpl >= 150 && mv.best_uci && mv.uci && mv.best_uci !== mv.uci &&
    mv.fen_before && mv.eval_before);
  swings.sort((x, y) => y.cpl - x.cpl);
  return swings.slice(0, 5).map(mv => {
    // review-fix (MED-3): the mover comes from the pre-move FEN's active
    // color — ply parity assumes a standard start and inverts the POV for
    // FEN-start games where Black moves first. Ply parity is the fallback
    // for records without fen_before.
    const fenTurn = mv.fen_before ? mv.fen_before.split(" ")[1] : "";
    const white = fenTurn ? fenTurn === "w" : mv.ply % 2 === 1;
    // analysis evals are mover POV — the review panel shows White's view
    const toWhite = (ev) => white ? ev : { type: ev.type, value: -ev.value };
    const num = Math.floor((mv.ply + 1) / 2);
    const label = "Move " + num + (white ? ". " : "... ");
    const suffix = REVIEW_SUFFIX[mv.classification] || "";
    return {
      ply: mv.ply,
      move_number: num,
      color: white ? "white" : "black",
      san: mv.san,
      uci: mv.uci,
      classification: mv.classification,
      fen_before: mv.fen_before,
      best_san: mv.best_san,
      best_uci: mv.best_uci,
      eval_before: toWhite(mv.eval_before),
      eval_after: toWhite(mv.eval_after),
      cp_loss: mv.cpl,
      pv_san: mv.pv_san || [],
      // review-fix (MED-1): the server attaches the SAME title/explanation
      // mistakes._explain produces for the scan path (motif titles + 2-4
      // verified sentences) — use them when present; the template below is
      // only a fallback for analyses persisted before this field existed.
      explanation: mv.explanation || "",
      title: mv.title ||
        (label + mv.san + suffix + " — " + mv.best_san + " was better"),
    };
  });
}

function renderGameAnalysis() {
  const a = Games.analysis;
  $("game-summary").classList.remove("hidden");
  $("acc-white").textContent = (a.white || "White") + " " + Math.round(a.accuracy.white) + "%";
  $("acc-black").textContent = (a.black || "Black") + " " + Math.round(a.accuracy.black) + "%";
  $("acc-white").title = "White accuracy";
  $("acc-black").title = "Black accuracy";
  $("game-coach-summary").textContent = a.coach_summary || "";

  const host = $("game-moves");
  host.innerHTML = "";
  let brilliants = 0;
  for (let i = 0; i < a.moves.length; i += 2) {
    const row = document.createElement("div");
    row.className = "move-pair";
    const num = document.createElement("span");
    num.className = "move-num";
    num.textContent = (i / 2 + 1) + ".";
    row.appendChild(num);
    for (let j = i; j < Math.min(i + 2, a.moves.length); j++) {
      const mv = document.createElement("span");
      mv.className = "mv";
      mv.textContent = a.moves[j].san;
      mv.title = a.moves[j].classification + " (best: " + a.moves[j].best_san + ")";
      if (a.moves[j].brilliant) {
        // V24: ✦ Verified Brilliant — tooltip discloses the gate values
        brilliants++;
        const info = a.moves[j].brilliant_info || {};
        mv.title = "✦ Verified Brilliant — the only winning move, and a " +
          "sacrifice (cpl " + (info.cpl != null ? info.cpl : "?") +
          ", second-best gap " +
          (info.second_gap_cp != null ? info.second_gap_cp + "cp" : "n/a") +
          ", material given " +
          (info.material_drop_cp != null ? info.material_drop_cp + "cp" : "?") +
          ")";
        const badge = document.createElement("span");
        badge.className = "mv-brilliant";
        badge.textContent = "✦";
        mv.appendChild(badge);
      }
      const dot = document.createElement("span");
      dot.className = "dot " + a.moves[j].classification;
      mv.appendChild(dot);
      mv.addEventListener("click", () => gameGoToPly(j + 1));
      row.appendChild(mv);
    }
    host.appendChild(row);
  }
  const flash = $("game-brilliant-flash");
  if (brilliants > 0) {
    flash.textContent = "✦ Verified Brilliant — the only winning move, " +
      "and a sacrifice." + (brilliants > 1 ? " ×" + brilliants : "");
    flash.classList.remove("hidden");
    // fire ONCE per analysis: renderGameAnalysis re-runs on post-mortem
    // reveal/close and must not re-confetti / re-speak the same flash
    const flashKey = (a.white || "") + " vs " + (a.black || "") + " " +
      (a.result || "") + " " + a.moves.map(m => m.san).join(" ");
    if (!Voice.celebratedFlashes.has(flashKey)) {
      Voice.celebratedFlashes.add(flashKey);
      confettiBurst(30);
      speakCelebration(flash.textContent); // V26: read the flash ONCE
    }
  } else {
    flash.classList.add("hidden");
  }
  gameGoToPly(a.moves.length > 0 ? 1 : 0);
}

/* ---- Game review (per-row "Game review" button) ----
   Runs /api/analyze/game and shows a highlights panel above the games
   layout: accuracy badges, per-side classification counts, and the top-5
   CPL swings as clickable rows that jump into the existing mistake review
   mode anchored at that ply. */

const REVIEW_CLASSES = ["best", "good", "inaccuracy", "mistake", "blunder"];
const REVIEW_SUFFIX = { blunder: "??", mistake: "?", inaccuracy: "?!" };

/* which side the configured user played, or null (case-insensitive) */
function userColorIn(white, black) {
  const names = [State.usernames.lichess, State.usernames.chesscom]
    .filter(Boolean).map(s => s.toLowerCase());
  if (names.indexOf(String(white || "").toLowerCase()) !== -1) return "white";
  if (names.indexOf(String(black || "").toLowerCase()) !== -1) return "black";
  return null;
}

async function runGameReview(game, btn) {
  // never bypass (or clobber) a coach-locked post-mortem with engine truth
  if (typeof PM !== "undefined" && PM.active) return;
  // DUP-4 spoiler guard: an unfinished post-mortem on file for this game?
  if (!(await pmSpoilerConfirm(game))) return;
  pmExit(); // re-running the review supersedes any post-mortem session
  $("game-review-panel").classList.remove("hidden");
  if (btn) { btn.disabled = true; btn.textContent = "Reviewing…"; }
  $("gr-status").textContent = "Analyzing game at depth 12 (this can take a minute)…";
  try {
    const a = await apiPost("/api/analyze/game", { pgn: game.pgn, depth: 12 });
    Games.review = { game, analysis: a };
    State.lastAnalyzedPgn = game.pgn;
    // the per-row Game review is THE analysis action now (DUP-4): fill the
    // summary/accuracy/moves board too — key moments + Review mistakes
    // then reuse this result instead of a second engine pass
    Games.analysis = a;
    Games.startFen = parsePgn(game.pgn).startFen;
    renderGameAnalysis();
    renderGameReview(game, a);
    $("gr-status").textContent = "";
    loadProfileStrip();
  } catch (e) {
    const eng = await surfaceEngineError(e);
    $("gr-status").textContent = eng
      ? "Review failed: engine unavailable — see the banner above."
      : "Review failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Game review"; }
  }
}

function renderGameReview(game, a) {
  const userColor = userColorIn(a.white, a.black);
  $("gr-game").textContent = (a.white || "White") + " vs " + (a.black || "Black") +
    (a.result && a.result !== "*" ? " · " + a.result : "");
  const fmt = (v) => (v == null ? "–" : Number(v).toFixed(1) + "%");
  $("gr-accuracy").textContent = userColor
    ? "You: " + fmt((a.accuracy || {})[userColor]) +
      " · Opponent: " + fmt((a.accuracy || {})[userColor === "white" ? "black" : "white"])
    : (a.white || "White") + ": " + fmt((a.accuracy || {}).white) +
      " · " + (a.black || "Black") + ": " + fmt((a.accuracy || {}).black);
  $("gr-summary").textContent = a.coach_summary || "";

  // classification counts per side (analyze_game emits the 5 base classes)
  const counts = { white: {}, black: {} };
  for (const c of REVIEW_CLASSES) { counts.white[c] = 0; counts.black[c] = 0; }
  for (const mv of a.moves || []) {
    const side = mv.ply % 2 === 1 ? "white" : "black";
    if (counts[side][mv.classification] != null) counts[side][mv.classification]++;
  }
  const bar = $("gr-classbar");
  bar.innerHTML = "";
  [["white", a.white], ["black", a.black]].forEach((pair) => {
    const side = pair[0], name = pair[1];
    const row = document.createElement("div");
    row.className = "gr-side";
    const who = document.createElement("b");
    who.textContent = userColor
      ? (side === userColor ? "You" : "Opponent")
      : (name || side);
    row.appendChild(who);
    for (const c of REVIEW_CLASSES) {
      const s = document.createElement("span");
      s.className = "gr-count";
      s.title = c + " moves";
      const dot = document.createElement("span");
      dot.className = "dot " + c;
      s.appendChild(dot);
      s.appendChild(document.createTextNode(c + " " + counts[side][c]));
      row.appendChild(s);
    }
    bar.appendChild(row);
  });

  // key moments: top-5 CPL swings, either side
  const host = $("gr-moments");
  host.innerHTML = "";
  const swings = (a.moves || []).filter(mv => mv.cpl > 0)
    .sort((x, y) => y.cpl - x.cpl).slice(0, 5);
  if (swings.length === 0) {
    host.innerHTML = '<div class="info-line">No significant swings — a clean game!</div>';
  }
  for (const mv of swings) {
    const row = document.createElement("div");
    row.className = "gr-moment";
    const num = Math.ceil(mv.ply / 2);
    const label = (mv.ply % 2 === 1 ? num + ". " : num + "... ") +
      mv.san + (REVIEW_SUFFIX[mv.classification] || "");
    const dot = document.createElement("span");
    dot.className = "dot " + mv.classification;
    row.appendChild(dot);
    const b = document.createElement("b");
    b.textContent = label;
    row.appendChild(b);
    const chip = document.createElement("span");
    chip.className = "chip " + mv.classification;
    chip.textContent = mv.classification;
    row.appendChild(chip);
    const loss = document.createElement("span");
    loss.className = "muted";
    loss.textContent = "(−" + (mv.cpl / 100).toFixed(1) + ")";
    row.appendChild(loss);
    row.title = "Review this moment in Mistake Review mode";
    row.addEventListener("click", () => reviewGameAtPly(game, mv.ply));
    host.appendChild(row);
  }
  $("game-review-panel").scrollIntoView({ block: "nearest" });
}

/* V25 (DUP-4): key-moment clicks REUSE the Game-review analysis already
   in hand — the response carries per-move evals/cpl/best moves, so the
   old /api/mistakes/scan re-run (a full second engine pass) is gone.
   Enters mistake review anchored at the clicked ply (first mistake when
   the click was a small swing below the review threshold). */
function reviewGameAtPly(game, ply) {
  const status = $("gr-status");
  const a = Games.review && Games.review.analysis;
  if (!a) return;
  const mistakes = mistakesFromAnalysis(a);
  if (mistakes.length === 0) {
    status.textContent = "No mistakes found in this game — nicely played!";
    return;
  }
  status.textContent = "";
  // same reuse as a scan: the Puzzles tab's "Add from last mistake scan"
  State.lastScanMistakes = mistakes;
  updateFcAddButton();
  const label = (a.white || "White") + " vs " + (a.black || "Black") +
    (a.result && a.result !== "*" ? " · " + a.result : "");
  enterReview(mistakes, label);
  const idx = mistakes.findIndex(m => m.ply === ply);
  if (idx > 0) showMistake(idx); // enterReview already showed mistake #1
}

$("btn-gr-close").addEventListener("click", () =>
  $("game-review-panel").classList.add("hidden"));
$("btn-gr-retry").addEventListener("click", () => {
  if (Games.review) reviewGameMistakes(Games.review.game, null);
});

/* ================= V15: Commit-First Post-Mortem =================
   Locked phase: the user steps through the game with EVERY engine verdict
   hidden (no dots, no evals, no key-moments panel) and marks the 1-7 plies
   they believe were critical, with a why and a 1-5 confidence. Only after
   committing does the server reveal the truth (calibration score, per-mark
   feedback, full analysis). Confident-but-wrong reads (confidence >= 4
   contradictions) become instant SM-2 retest flashcards server-side. */

const PM = {
  active: false,   // locked phase in progress (marks being collected)
  session: null,   // locked state payload — engine-free by contract
  game: null,
  viewPly: 0,
  marks: [],       // [{ply, annotation, confidence}]
  result: null,    // submit response (the reveal)
};

function pmFenAt(ply) {
  return ply === 0 ? PM.session.start_fen : PM.session.moves[ply - 1].fen_after;
}

/* "62. Qxd5" / "62... Qh4" from a locked-move entry — labels use the
   ABSOLUTE game ply (mv.abs_ply), never the 1-based session ply: games
   longer than the analyzed window start mid-game, so a session ply would
   render the wrong move number and the wrong color for the whole window */
function pmMoveLabel(mv) {
  const ply = (mv && typeof mv.abs_ply === "number") ? mv.abs_ply
    : (mv && typeof mv.ply === "number" ? mv.ply : 1);
  const n = Math.ceil(ply / 2);
  return (ply % 2 === 1 ? n + ". " : n + "... ") + (mv ? mv.san : "");
}

function pmMarkAt(ply) {
  return PM.marks.find(m => m.ply === ply) || null;
}

function pmUpdateNav() {
  const last = PM.session ? PM.session.moves.length : 0;
  const p = PM.viewPly;
  gameNav.update({ start: p > 0, prev: p > 0, next: p < last, end: p < last });
}

function pmNavStep(dir) {
  if (!PM.session) return;
  const last = PM.session.moves.length;
  pmGoToPly(dir === "start" ? 0 : dir === "end" ? last :
    PM.viewPly + (dir === "next" ? 1 : -1));
}

function pmGoToPly(n) {
  if (!PM.session) return;
  n = Math.max(0, Math.min(PM.session.moves.length, n));
  PM.viewPly = n;
  gameBoard.setFen(pmFenAt(n));
  gameBoard.setLastMove(null, null);
  const host = $("game-moves");
  host.querySelectorAll(".mv").forEach((el, i) =>
    el.classList.toggle("current", i === n - 1));
  const cur = host.querySelectorAll(".mv")[n - 1];
  if (cur) cur.scrollIntoView({ block: "nearest" });
  $("pm-ply-label").textContent = n === 0
    ? "Start position — move forward to the moment you want to mark."
    : "Ply " + n + ": " + pmMoveLabel(PM.session.moves[n - 1]) +
      (pmMarkAt(n) ? " — marked" : "");
  pmUpdateNav();
}

/* move list WITHOUT classification dots — the whole point of the lock.
   Pairing/numbering use the ABSOLUTE game ply (mv.abs_ply): a windowed
   (>120-ply) game can start mid-move-number or even on a Black move, so
   session-ply math would misnumber every row and invert the colors */
function pmRenderMoves() {
  const host = $("game-moves");
  host.innerHTML = "";
  const moves = PM.session.moves;
  let row = null;
  let rowNum = -1;
  moves.forEach((m, i) => {
    const absPly = typeof m.abs_ply === "number" ? m.abs_ply : m.ply;
    const num = Math.ceil(absPly / 2);
    if (num !== rowNum) {
      rowNum = num;
      row = document.createElement("div");
      row.className = "move-pair";
      const numEl = document.createElement("span");
      numEl.className = "move-num";
      numEl.textContent = num + ".";
      row.appendChild(numEl);
      if (absPly % 2 === 0) {
        // the window starts on Black's move — keep Black in the second
        // column with a placeholder for White's (unanalyzed) half-move
        const gap = document.createElement("span");
        gap.className = "mv-gap";
        gap.textContent = "…";
        row.appendChild(gap);
      }
      host.appendChild(row);
    }
    const mv = document.createElement("span");
    mv.className = "mv";
    mv.textContent = m.san; // no dots, no titles — locked
    mv.addEventListener("click", () => pmGoToPly(i + 1));
    row.appendChild(mv);
  });
}

function pmRenderMarks() {
  const host = $("pm-marks");
  host.innerHTML = "";
  $("pm-marks-count").textContent =
    PM.marks.length ? "(" + PM.marks.length + " of 7)" : "";
  PM.marks.forEach((m) => {
    const row = document.createElement("div");
    row.className = "pm-mark";
    const head = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = pmMoveLabel(PM.session.moves[m.ply - 1]);
    head.appendChild(b);
    const conf = document.createElement("span");
    conf.className = "chip";
    conf.textContent = "confidence " + m.confidence + "/5";
    head.appendChild(conf);
    const jump = document.createElement("button");
    jump.className = "btn mini";
    jump.textContent = "Show";
    jump.title = "Jump to this ply";
    jump.addEventListener("click", () => pmGoToPly(m.ply));
    head.appendChild(jump);
    const del = document.createElement("button");
    del.className = "btn mini";
    del.textContent = "✕";
    del.title = "Remove this mark";
    del.addEventListener("click", () => {
      PM.marks = PM.marks.filter(x => x.ply !== m.ply);
      pmRenderMarks();
      pmGoToPly(PM.viewPly);
    });
    head.appendChild(del);
    row.appendChild(head);
    if (m.annotation) {
      const note = document.createElement("div");
      note.className = "info-line";
      note.textContent = m.annotation;
      row.appendChild(note);
    }
    host.appendChild(row);
  });
  $("btn-pm-submit").disabled = PM.marks.length < 1 || PM.marks.length > 7;
}

async function startPostmortem(game) {
  $("pm-panel").classList.remove("hidden");
  $("pm-locked").classList.remove("hidden");
  $("pm-reveal").classList.add("hidden");
  $("pm-status").textContent =
    "Preparing post-mortem (engine pass — this can take a minute)…";
  try {
    const side = userColorIn(game.white, game.black);
    const body = { pgn: game.pgn, depth: 12 };
    if (side) body.side = side;
    const st = await apiPost("/api/postmortem/start", body);
    PM.active = true;
    PM.session = st;
    PM.game = game;
    PM.marks = [];
    PM.result = null;
    PM.viewPly = 0;
    // hide every engine-derived view for the locked phase
    Games.analysis = null;
    $("game-summary").classList.add("hidden");
    $("game-review-panel").classList.add("hidden");
    renderGamesList(); // disable the per-row review buttons under the lock
    $("pm-game").textContent = (st.white || "White") + " vs " +
      (st.black || "Black") +
      (st.result && st.result !== "*" ? " · " + st.result : "") +
      " — reviewing " +
      (st.side === "both" ? "both sides" : "your " + st.side + " moves");
    $("pm-annotation").value = "";
    $("pm-confidence").value = "3";
    $("pm-status").textContent = "";
    pmRenderMoves();
    pmRenderMarks();
    pmGoToPly(0);
    $("pm-panel").scrollIntoView({ block: "nearest" });
  } catch (e) {
    const eng = await surfaceEngineError(e);
    $("pm-status").textContent = eng
      ? "Post-mortem failed: engine unavailable — see the banner above."
      : "Post-mortem failed: " + e.message;
  }
}

function pmRenderReveal(r) {
  $("pm-locked").classList.add("hidden");
  $("pm-reveal").classList.remove("hidden");
  const c = r.calibration || {};
  $("pm-score").textContent = "Calibration score: " + c.score + "/100 — found " +
    ((c.found || []).length + (c.near_misses || []).length) + " of " +
    c.critical_count + " critical moment(s)" +
    ((c.extra || []).length ? ", " + c.extra.length + " false alarm(s)" : "");
  $("pm-coach-note").textContent = r.coach_note || "";

  const fb = $("pm-feedback");
  fb.innerHTML = "";
  (r.feedback || []).forEach((f) => {
    const row = document.createElement("div");
    row.className = "pm-mark";
    const head = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = f.label;
    head.appendChild(b);
    const chip = document.createElement("span");
    chip.className = "chip " + (f.verdict === "found" ? "plan" :
      f.verdict === "near" ? "inaccuracy" : "mistake");
    chip.textContent = f.verdict === "found" ? "correct" :
      f.verdict === "near" ? "near miss" : "not critical";
    head.appendChild(chip);
    // honest retest chip: driven by the server's actual enqueue outcome
    // (new card vs. already-present card lapsed back to due), not just by
    // the local contradiction flag
    const hc = r.hypercorrection || {};
    if (f.contradiction && f.confidence >= 4 &&
        (hc.flagged_plies || []).indexOf(f.ply) !== -1 &&
        ((hc.enqueued || 0) + (hc.relapsed || 0)) > 0) {
      const chip = document.createElement("span");
      chip.className = "chip blunder";
      chip.textContent = (hc.enqueued || 0) > 0
        ? "retest card added"
        : "retest card bumped to due-now";
      head.appendChild(chip);
    }
    row.appendChild(head);
    const txt = document.createElement("div");
    txt.className = "info-line";
    txt.textContent = f.text;
    row.appendChild(txt);
    fb.appendChild(row);
  });

  const ms = $("pm-missed");
  ms.innerHTML = "";
  if (!(r.missed_moments || []).length) {
    ms.innerHTML =
      '<div class="info-line muted">None — you found every critical moment.</div>';
  }
  (r.missed_moments || []).forEach((d) => {
    const row = document.createElement("div");
    row.className = "pm-mark";
    const head = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = d.label;
    head.appendChild(b);
    const chip = document.createElement("span");
    chip.className = "chip " + d.classification;
    chip.textContent = d.classification;
    head.appendChild(chip);
    row.appendChild(head);
    const txt = document.createElement("div");
    txt.className = "info-line";
    txt.textContent = d.explanation +
      (d.plan && d.plan.goal ? " " + d.plan.goal : "");
    row.appendChild(txt);
    ms.appendChild(row);
  });
  $("btn-pm-debrief").classList.toggle("hidden",
    !(r.missed_moments || []).length);
}

/* the reveal IS the normal analysis payload — unlock the standard view */
function pmUnlockAnalysis(r) {
  const rv = r.reveal || {};
  Games.analysis = {
    white: rv.white, black: rv.black, result: rv.result,
    moves: rv.moves || [],
    accuracy: rv.accuracy || { white: 0, black: 0 },
    coach_summary: "Post-mortem revealed. " + (r.coach_note || ""),
  };
  Games.startFen = rv.start_fen || Games.startFen;
  renderGameAnalysis(); // dots, titles, accuracy and nav restored
}

function pmExit() {
  const wasLocked = PM.active;
  PM.active = false;
  PM.session = null;
  PM.marks = [];
  PM.result = null;
  $("pm-panel").classList.add("hidden");
  // exiting mid-lock must not strand the user: restore the game-review
  // panel the lock hid (if a review exists) and re-arm the row buttons
  if (wasLocked && Games.review) {
    $("game-review-panel").classList.remove("hidden");
  }
  // Re-render ONLY when the lock was actually on (its whole point is to
  // re-arm the lock-disabled row buttons). An unconditional re-render here
  // would detach the very row button reviewGameMistakes/runGameReview are
  // about to mark "Scanning…"/"Reviewing…" — the busy feedback would be
  // written to a detached node and never seen.
  if (wasLocked) renderGamesList();
}

/* No in-review "Start post-mortem" button (V15 fix): the game-review panel
   is only reachable AFTER the engine's accuracy/classifications/key-moments
   rendered — starting the lock there would leak the answer key. The locked
   session starts from the per-row "Post-mortem" button in the games list,
   BEFORE any engine review is shown. */

$("btn-pm-mark").addEventListener("click", () => {
  if (!PM.active || !PM.session) return;
  if (PM.viewPly === 0) {
    $("pm-status").textContent = "Move to the ply you want to mark first.";
    return;
  }
  if (!pmMarkAt(PM.viewPly) && PM.marks.length >= 7) {
    $("pm-status").textContent = "7 marks maximum — remove one first.";
    return;
  }
  $("pm-status").textContent = "";
  PM.marks = PM.marks.filter(x => x.ply !== PM.viewPly); // one mark per ply
  PM.marks.push({
    ply: PM.viewPly,
    annotation: $("pm-annotation").value.trim().slice(0, 280),
    confidence: parseInt($("pm-confidence").value, 10) || 3,
  });
  PM.marks.sort((a, b) => a.ply - b.ply);
  $("pm-annotation").value = "";
  pmRenderMarks();
  pmGoToPly(PM.viewPly); // refresh the "— marked" label
});

$("btn-pm-submit").addEventListener("click", async () => {
  if (!PM.active || !PM.session) return;
  const btn = $("btn-pm-submit");
  btn.disabled = true;
  $("pm-status").textContent = "Revealing…";
  try {
    const r = await apiPost("/api/postmortem/" + PM.session.id + "/submit",
      { marks: PM.marks });
    PM.result = r;
    PM.active = false; // nav returns to the normal analysis handlers
    $("pm-status").textContent = "";
    pmRenderReveal(r);
    pmUnlockAnalysis(r);
    // the lock is over: re-arm the per-row buttons NOW (they were disabled
    // by the lock's render) instead of leaving stale "finish the
    // post-mortem first" rows until the panel is closed
    renderGamesList();
  } catch (e) {
    $("pm-status").textContent = "Submit failed: " + e.message;
    btn.disabled = false;
  }
});

$("btn-pm-close").addEventListener("click", () => {
  const revealed = !!PM.result;
  pmExit();
  if (revealed && Games.analysis) renderGameAnalysis();
});

/* Socratic debrief of the biggest missed moment, in the coach chat */
$("btn-pm-debrief").addEventListener("click", () => {
  const r = PM.result;
  if (!r || !(r.missed_moments || []).length) return;
  const biggest = r.missed_moments.slice().sort((a, b) => b.cpl - a.cpl)[0];
  pmExit();
  switchTab("play");
  if (typeof Review !== "undefined" && Review.active) exitReview();
  playResetTo(biggest.fen_before);
  $("chat-input").value =
    "I just finished a post-mortem and missed the critical moment here (" +
    biggest.label + "). Coach me Socratically: ask me questions that help " +
    "me find what I missed — don't just tell me the answer.";
  chatSend(false);
});

/* ---- coaching profile strip ---- */

async function loadProfileStrip() {
  try {
    const p = await apiGet("/api/profile/summary");
    Games.recommendedLessons = p.recommended_lessons || [];
    const strip = $("profile-strip");
    strip.classList.remove("hidden");
    strip.innerHTML = "";
    const title = document.createElement("span");
    title.className = "ps-title";
    title.textContent = "Your coaching profile";
    strip.appendChild(title);

    const stat = (val, label) => {
      const d = document.createElement("div");
      d.className = "ps-stat";
      const b = document.createElement("b");
      b.textContent = val == null ? "–" : val;
      const s = document.createElement("span");
      s.textContent = label;
      d.appendChild(b); d.appendChild(s);
      return d;
    };
    strip.appendChild(stat(p.games_analyzed, "games analyzed"));
    strip.appendChild(stat(p.accuracy_avg == null ? null : p.accuracy_avg.toFixed(1) + "%", "avg accuracy"));
    strip.appendChild(stat(p.blunders_per_game == null ? null : p.blunders_per_game.toFixed(1), "blunders / game"));
    if (p.brilliants) {
      strip.appendChild(stat("✦ " + p.brilliants, "verified brilliants"));
    }

    const chips = document.createElement("div");
    chips.className = "chip-row";
    chips.style.margin = "0";
    (p.weaknesses || []).slice(0, 5).forEach(w => {
      const c = document.createElement("button");
      c.className = "chip weakness";
      c.textContent = w.theme + " (" + w.count + ")";
      c.title = "Jump to a recommended lesson";
      c.addEventListener("click", () => {
        switchTab("learn");
        highlightRecommendedLessons();
      });
      chips.appendChild(c);
    });
    if ((p.weaknesses || []).length === 0) {
      const ok = document.createElement("span");
      ok.className = "info-line";
      ok.textContent = "No recurring weaknesses detected yet.";
      chips.appendChild(ok);
    }
    strip.appendChild(chips);
  } catch (e) {
    // profile is optional — stay quiet
  }
}

function highlightRecommendedLessons() {
  // applied once lessons are loaded; also re-applied by renderLessons
  document.querySelectorAll("#lessons-list .card").forEach(card => {
    card.classList.toggle("highlighted", Games.recommendedLessons.includes(card.dataset.lessonId));
  });
  const first = document.querySelector("#lessons-list .card.highlighted");
  if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
}

$("btn-fetch-games").addEventListener("click", fetchGames);
$("btn-game-to-puzzles").addEventListener("click", async () => {
  if (!Games.selected) return;
  const pgn = Games.selected.pgn;
  State.lastAnalyzedPgn = pgn;
  switchTab("puzzles");
  // land in the Build-drills panel on the PGN scope, then build (persisted)
  $("build-scope").value = "pgn";
  syncBuildScope();
  $("pgn-build-input").value = pgn;
  await buildPuzzlesFromPgn(pgn, Games.selected.id || null);
});
$("btn-game-to-lab").addEventListener("click", () => {
  if (!Games.selected) return;
  openGameInLab(Games.selected, Games.analysis ? Games.viewPly : 0);
});

/* ================= Learn tab ================= */

const Learn = {
  loaded: false,
  lessons: [],
  current: null,      // full lesson object
  stepIdx: 0,
  taskSolved: false,
  busy: false,
};

const lessonBoard = new Board($("lesson-board"), { onMove: onLessonMove });
lessonBoard.setInteractive(false);

let learnInitStarted = false;
async function initLearn() {
  if (learnInitStarted) return;
  learnInitStarted = true;
  try {
    const r = await apiGet("/api/lessons");
    Learn.lessons = r.lessons || [];
    renderLessons();
  } catch (e) {
    $("lessons-list").innerHTML = '<div class="info-line">Lessons unavailable: ' + escapeHtml(e.message) + "</div>";
  }
  loadPrincipleChips();
  loadModelGames(null);
}

function renderLessons() {
  const host = $("lessons-list");
  host.innerHTML = "";
  for (const l of Learn.lessons) {
    const c = document.createElement("div");
    c.className = "card";
    c.dataset.lessonId = l.id;
    c.innerHTML = "<h4>" + escapeHtml(l.title) + "</h4>" +
      '<div class="card-meta">' + escapeHtml(l.principle) + " · " + escapeHtml(l.difficulty || "") +
      " · " + (l.steps_count || "?") + " steps" + (l.tasks ? " · " + l.tasks + " moves to find" : "") + "</div>" +
      '<div class="card-summary">' + escapeHtml(l.summary || "") + "</div>";
    c.addEventListener("click", () => openLesson(l.id));
    host.appendChild(c);
  }
  highlightRecommendedLessons();
}

async function openLesson(id) {
  try {
    const l = await apiGet("/api/lessons/" + encodeURIComponent(id));
    Learn.current = l;
    Learn.stepIdx = 0;
    $("learn-home").classList.add("hidden");
    $("mg-viewer").classList.add("hidden");
    $("lesson-player").classList.remove("hidden");
    $("lesson-title").textContent = l.title + "  ·  " + l.principle;
    showLessonStep();
  } catch (e) {
    showError("Could not load lesson: " + e.message);
  }
}

function showLessonStep() {
  const l = Learn.current;
  const step = l.steps[Learn.stepIdx];
  Learn.taskSolved = !step.task;
  lessonBoard.setFen(step.fen);
  lessonBoard.setLastMove(null, null);
  lessonBoard.clearArrows();
  lessonBoard.setMarked([]);
  lessonBoard.setInteractive(!!step.task);
  // v42: with a move to find, the explanation waits until you have found it
  Learn.misses = 0;
  $("lesson-step-text").textContent = step.task ? "Find the move first — the explanation appears when you do." : step.text;
  $("lesson-step-text").classList.toggle("muted", !!step.task);
  $("lesson-progress").textContent = "Step " + (Learn.stepIdx + 1) + " / " + l.steps.length;
  $("btn-lesson-prev").disabled = Learn.stepIdx === 0;
  $("btn-lesson-next").textContent = Learn.stepIdx === l.steps.length - 1 ? "Finish" : "Next →";
  const hint = $("lesson-task-hint");
  if (step.task) {
    hint.classList.remove("hidden");
    hint.className = "banner amber";
    hint.textContent = "Your move: " + step.task;
  } else {
    hint.classList.add("hidden");
  }
}

async function onLessonMove(from, to) {
  const l = Learn.current;
  if (!l || Learn.busy) return;
  const step = l.steps[Learn.stepIdx];
  if (!step.task || Learn.taskSolved) return;
  Learn.busy = true;
  try {
    const uci = uciCandidate(lessonBoard, from, to);
    const r = await apiPost("/api/move", { fen: step.fen, move_uci: uci });
    if (!r.legal) { lessonBoard.shake(); return; }
    if (step.solution_uci && uci !== step.solution_uci) {
      lessonBoard.shake();
      Learn.misses = (Learn.misses || 0) + 1;
      if (Learn.misses === 1) {
        try { apiPost("/api/misses/add", { source: "lesson", items: [{ fen_before: step.fen, best_uci: step.solution_uci, uci, title: "Lesson — " + l.title, explanation: step.text, motif: "positional" }] }); } catch (_) {}
      }
      const hint = $("lesson-task-hint");
      hint.className = "banner red";
      hint.textContent = "Not quite — try again. " + (Learn.misses >= 2 ? "Hint: " + step.task + " Look at the " + step.solution_uci.slice(0, 2) + " piece." : "Hint: " + step.task);
      return;
    }
    Learn.taskSolved = true;
    $("lesson-step-text").textContent = step.text;
    $("lesson-step-text").classList.remove("muted");
    try { apiPost("/api/activity/answer", { pillar: "masters", kind: "lesson_task" }); } catch (_) {}
    lessonBoard.setFen(r.fen_after);
    lessonBoard.setLastMove(from, to);
    lessonBoard.setInteractive(false);
    const hint = $("lesson-task-hint");
    hint.className = "banner green";
    hint.textContent = "Correct! " + (r.san || "") + " is the move.";
  } catch (e) {
    showError(e.message);
  } finally {
    Learn.busy = false;
  }
}

$("btn-lesson-prev").addEventListener("click", () => {
  if (Learn.stepIdx > 0) { Learn.stepIdx--; showLessonStep(); }
});
$("btn-lesson-next").addEventListener("click", () => {
  const l = Learn.current;
  if (!l) return;
  const step = l.steps[Learn.stepIdx];
  if (step.task && !Learn.taskSolved) {
    lessonBoard.shake();
    return;
  }
  if (Learn.stepIdx < l.steps.length - 1) { Learn.stepIdx++; showLessonStep(); }
  else closeLesson();
});
function closeLesson() {
  $("lesson-player").classList.add("hidden");
  $("learn-home").classList.remove("hidden");
  Learn.current = null;
}
$("btn-lesson-close").addEventListener("click", closeLesson);

/* ---- Model games ---- */

const MG = {
  games: [],
  current: null,
  sans: [],
  fens: [],           // fens[i] = position after i plies (fens[0] = start)
  ply: 0,
  resolving: false,
};

const mgBoard = new Board($("mg-board"), { interactive: false });

async function loadPrincipleChips() {
  const host = $("principle-chips");
  try {
    const r = await apiGet("/api/model-games/principles");
    host.innerHTML = "";
    const mk = (label, value) => {
      const c = document.createElement("button");
      c.className = "chip" + (value === null ? " active" : "");
      c.textContent = label;
      c.addEventListener("click", () => {
        host.querySelectorAll(".chip").forEach(el => el.classList.remove("active"));
        c.classList.add("active");
        loadModelGames(value);
      });
      host.appendChild(c);
    };
    mk("All", null);
    (r.principles || []).forEach(p => mk(p, p));
  } catch (e) {
    host.innerHTML = "";
  }
}

async function loadModelGames(principle) {
  const host = $("model-games-list");
  host.innerHTML = '<div class="info-line">Loading…</div>';
  try {
    const r = await apiGet("/api/model-games" + (principle ? "?principle=" + encodeURIComponent(principle) : ""));
    MG.games = r.games || [];
    host.innerHTML = "";
    for (const g of MG.games) {
      const c = document.createElement("div");
      c.className = "card";
      c.innerHTML = "<h4>" + escapeHtml(g.title) + "</h4>" +
        '<div class="card-meta">' + escapeHtml(g.white) + " vs " + escapeHtml(g.black) +
        " · " + escapeHtml(g.year || "") + " · " + escapeHtml(g.principle) + "</div>" +
        '<div class="card-summary">' + escapeHtml(g.summary || "") + "</div>";
      c.addEventListener("click", () => openModelGame(g));
      host.appendChild(c);
    }
    if (MG.games.length === 0) host.innerHTML = '<div class="info-line">No games for this principle yet.</div>';
  } catch (e) {
    host.innerHTML = '<div class="info-line">Model games unavailable: ' + escapeHtml(e.message) + "</div>";
  }
}

function openModelGame(g) {
  const parsed = parsePgn(g.pgn);
  MG.current = g;
  MG.sans = parsed.sans;
  MG.fens = [parsed.startFen];
  MG.ply = 0;
  $("learn-home").classList.add("hidden");
  $("lesson-player").classList.add("hidden");
  $("mg-viewer").classList.remove("hidden");
  $("mg-title").textContent = g.title + " — " + g.white + " vs " + g.black + " (" + (g.year || "?") + ")";
  $("mg-summary").textContent = (g.principle || "") + " · " + (g.summary || "");
  mgBoard.setFen(MG.fens[0]);
  mgBoard.setLastMove(null, null);
  renderMgMoves();
  updateMgView();
}

function renderMgMoves() {
  const host = $("mg-moves");
  host.innerHTML = "";
  for (let i = 0; i < MG.sans.length; i += 2) {
    const row = document.createElement("div");
    row.className = "move-pair";
    const num = document.createElement("span");
    num.className = "move-num";
    num.textContent = (i / 2 + 1) + ".";
    row.appendChild(num);
    for (let j = i; j < Math.min(i + 2, MG.sans.length); j++) {
      const mv = document.createElement("span");
      mv.className = "mv";
      mv.dataset.ply = j + 1;
      mv.textContent = MG.sans[j];
      mv.addEventListener("click", () => mgGoToPly(j + 1));
      row.appendChild(mv);
    }
    host.appendChild(row);
  }
}

/* ensure fens resolved up to ply n (each via /api/move SAN resolution) */
async function mgEnsureFens(n) {
  while (MG.fens.length <= n && MG.fens.length <= MG.sans.length) {
    const i = MG.fens.length - 1;
    const resolved = await resolveSan(MG.fens[i], MG.sans[i]);
    if (!resolved) { showError("Could not parse move " + MG.sans[i]); break; }
    MG.fens.push(resolved.result.fen_after);
  }
}

async function mgGoToPly(n) {
  if (MG.resolving) return;
  MG.resolving = true;
  try {
    await mgEnsureFens(n);
    MG.ply = Math.min(n, MG.fens.length - 1);
    updateMgView();
  } finally {
    MG.resolving = false;
  }
}

async function updateMgView() {
  mgBoard.setFen(MG.fens[MG.ply]);
  document.querySelectorAll("#mg-moves .mv").forEach(el =>
    el.classList.toggle("current", parseInt(el.dataset.ply, 10) === MG.ply));
  const label = MG.ply === 0 ? "Starting position" :
    Math.ceil(MG.ply / 2) + (MG.ply % 2 === 1 ? ". " : "… ") + MG.sans[MG.ply - 1];
  $("mg-move-label").textContent = label + "   (" + MG.ply + "/" + MG.sans.length + ")";
  updateMgNav();
}

/* V25 (DUP-2): no third coach surface in the model-game viewer — the
   button seeds the Play tab's unified coach panel: load the viewed
   position onto the Play board, switch tabs, prefill the chat input. */
$("btn-mg-ask-coach").addEventListener("click", () => {
  if (!MG.current || !MG.fens[MG.ply]) return;
  playResetTo(MG.fens[MG.ply]);
  switchTab("play");
  setCoachMode("chat");
  $("chat-input").value = "I'm studying \"" + MG.current.title +
    "\" — what should I take away from this position?";
  $("chat-input").focus();
});

const mgNav = createNavControls("mg-nav", {
  onNav: (dir) => {
    if (!MG.current) return;
    mgGoToPly(dir === "start" ? 0 : dir === "end" ? MG.sans.length : MG.ply + (dir === "next" ? 1 : -1));
  },
  isActive: () => $("tab-learn").classList.contains("active") && !$("mg-viewer").classList.contains("hidden"),
});

function updateMgNav() {
  const last = MG.sans.length;
  mgNav.update({ start: MG.ply > 0, prev: MG.ply > 0, next: MG.ply < last, end: MG.ply < last });
}

$("btn-mg-close").addEventListener("click", () => {
  $("mg-viewer").classList.add("hidden");
  $("learn-home").classList.remove("hidden");
});

/* ================= Strategy Lab tab ================= */

const Lab = {
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  lines: [],
  playback: null,   // {fens:[], idx, timer, lineIdx, uci}
  game: null,       // {label, sans, fens, ucis} — game loaded via "Open in Lab"
  ply: 0,           // currently shown ply of Lab.game
  plan: null,       // shown /api/strategy/plan response (null = none)
};

const labBoard = new Board($("lab-board"), { interactive: false });
let labInitDone = false;

const labPlanCtx = {
  board: labBoard,
  panel: () => $("lab-plan-result"),
  btn: () => $("btn-lab-plan"),
  getFen: () => labCurrentFen(),
  getBottomSide: () => labBoard.orientation,
  state: Lab,
  playerMoves: 3,
};

$("btn-lab-flip").addEventListener("click", () => {
  labBoard.flip();
  // flip semantics: "bottom side" changed → re-plan for the new bottom side
  if (Lab.plan) requestPlan(labPlanCtx);
});

$("btn-lab-plan").addEventListener("click", () => {
  if (Lab.plan) { clearPlanUi(labPlanCtx); labBoard.clearArrows(); return; }
  requestPlan(labPlanCtx);
});

function initLab() {
  if (labInitDone) return;
  labInitDone = true;
  // default to current Play-tab position
  Lab.fen = playBoard.getFen();
  labBoard.setFen(Lab.fen);
  $("lab-fen-input").value = Lab.fen;
  updateLabNav();
}

/* the position currently shown on the Lab board — all panels operate on it */
function labCurrentFen() {
  if (Lab.playback) return Lab.playback.fens[Lab.playback.idx];
  if (Lab.game) return Lab.game.fens[Lab.ply];
  return Lab.fen;
}

const labNav = createNavControls("lab-nav", {
  onNav: (dir) => {
    if (Lab.playback) { lineNavStep(dir); return; }
    if (Lab.game) {
      const last = Lab.game.sans.length;
      labGoToPly(dir === "start" ? 0 : dir === "end" ? last : Lab.ply + (dir === "next" ? 1 : -1));
    }
  },
  isActive: () => $("tab-lab").classList.contains("active") && !!(Lab.playback || Lab.game),
});

function updateLabNav() {
  let s;
  if (Lab.playback) {
    const pb = Lab.playback;
    s = { start: pb.idx > 0, prev: pb.idx > 0, next: pb.idx < pb.fens.length - 1, end: pb.idx < pb.fens.length - 1 };
  } else if (Lab.game) {
    const last = Lab.game.sans.length;
    s = { start: Lab.ply > 0, prev: Lab.ply > 0, next: Lab.ply < last, end: Lab.ply < last };
  } else {
    s = { start: false, prev: false, next: false, end: false };
  }
  labNav.update(s);
}

/* show ply n of the loaded game; panels then work on that position */
function labGoToPly(n) {
  const g = Lab.game;
  if (!g) return;
  n = Math.max(0, Math.min(g.sans.length, n));
  Lab.ply = n;
  Lab.fen = g.fens[n];
  labBoard.setFen(Lab.fen);
  labBoard.clearArrows();
  const uci = n > 0 ? g.ucis[n - 1] : null;
  labBoard.setLastMove(uci ? uci.slice(0, 2) : null, uci ? uci.slice(2, 4) : null);
  $("lab-fen-input").value = Lab.fen;
  updateLabNav();
}

/* resolve every ply of a PGN via /api/move (cached per PGN text) */
async function resolveGamePlies(pgn) {
  if (State.labGameCache[pgn]) return State.labGameCache[pgn];
  const parsed = parsePgn(pgn);
  const fens = [parsed.startFen];
  const ucis = [];
  let fen = parsed.startFen;
  for (let i = 0; i < parsed.sans.length; i++) {
    const r = await resolveSan(fen, parsed.sans[i]);
    if (!r) break;
    fens.push(r.result.fen_after);
    ucis.push(r.uci);
    fen = r.result.fen_after;
    if (i % 10 === 9) $("lab-status").textContent = "Loading game into Lab… " + (i + 1) + "/" + parsed.sans.length;
  }
  const out = { sans: parsed.sans.slice(0, fens.length - 1), fens, ucis };
  State.labGameCache[pgn] = out;
  return out;
}

/* Feature: open an imported game in the Strategy Lab at a given ply */
async function openGameInLab(game, ply) {
  if (!game || !game.pgn) return;
  switchTab("lab");
  initLab();
  const label = (game.white || "White") + " vs " + (game.black || "Black") +
    (game.date ? " · " + game.date : "");
  $("lab-status").textContent = "Loading game into Lab…";
  try {
    const resolved = await resolveGamePlies(game.pgn);
    if (!resolved || resolved.fens.length < 1) {
      $("lab-status").textContent = "Could not load that game.";
      return;
    }
    stopLinePlayback();
    Lab.game = { label, sans: resolved.sans, fens: resolved.fens, ucis: resolved.ucis };
    $("lab-game-label").textContent = label;
    $("lab-game-bar").classList.remove("hidden");
    labGoToPly(Math.max(0, Math.min(ply || 0, resolved.sans.length)));
    $("lab-status").textContent = "Game loaded — step through it; the panels analyze the shown position.";
  } catch (e) {
    $("lab-status").textContent = "Could not load game: " + e.message;
  }
}

function labUnloadGame() {
  Lab.game = null;
  Lab.ply = 0;
  $("lab-game-bar").classList.add("hidden");
  updateLabNav();
}

$("btn-lab-unload").addEventListener("click", () => {
  stopLinePlayback();
  labUnloadGame();
  labSetFen(Lab.fen, "Game unloaded — free-position mode.");
});

function labSetFen(fen, msg) {
  if (!fenLooksValid(fen)) { $("lab-status").textContent = "That FEN does not look valid."; return false; }
  stopLinePlayback();
  Lab.fen = fen;
  labBoard.setFen(fen);
  labBoard.clearArrows();
  clearPlanUi(labPlanCtx); // a new position invalidates any shown plan
  labBoard.setLastMove(null, null);
  $("lab-fen-input").value = fen;
  $("lab-status").textContent = msg || "Position loaded.";
  return true;
}

/* manual position loads leave game mode */
$("btn-lab-load-fen").addEventListener("click", () => {
  labUnloadGame();
  labSetFen($("lab-fen-input").value.trim());
});
$("btn-lab-load-current").addEventListener("click", () => {
  labUnloadGame();
  labSetFen(playBoard.getFen(), "Loaded current Play-tab position.");
});

/* ---- (a) What if I pass? (Zero move) ---- */

$("btn-nullmove").addEventListener("click", async () => {
  const res = $("nullmove-result");
  res.classList.remove("hidden", "threat");
  $("nm-note").textContent = "Analyzing…";
  $("nm-line").textContent = "";
  labBoard.clearArrows();
  const fen = labCurrentFen();
  try {
    const r = await apiPost("/api/strategy/nullmove", { fen });
    $("nm-note").textContent = r.note || "";
    if (!r.legal) {
      $("nm-line").textContent = "";
      return;
    }
    if (r.threat) {
      const t = r.threat;
      const losing = t.eval && (t.eval.type === "mate" ? t.eval.value < 0 : t.eval.value <= -200);
      res.classList.toggle("threat", !!losing);
      $("nm-line").textContent =
        "Threat: " + (t.best_move_san || "?") +
        " — " + (t.line_san || []).join(" ") +
        "   (" + evalText(t.eval) + " for you)";
      // arrow for the opponent's best move: resolve SAN in the flipped position
      if (t.best_move_san) {
        const flipped = fenFlippedSide(fen);
        const solved = await resolveSan(flipped, t.best_move_san);
        if (solved) {
          labBoard.setArrows([{ from: solved.uci.slice(0, 2), to: solved.uci.slice(2, 4), color: "red" }]);
        }
      }
    } else {
      $("nm-line").textContent = "No concrete threat found — your position is solid.";
    }
  } catch (e) {
    const eng = await surfaceEngineError(e);
    $("nm-note").textContent = eng
      ? "Engine unavailable — see the banner above."
      : "Null-move analysis failed: " + e.message;
  }
});

/* ---- (b) Play it out ---- */

$("lines-slider").addEventListener("input", () => {
  $("lines-slider-val").textContent = $("lines-slider").value;
});

$("btn-playout").addEventListener("click", async () => {
  const shown = labCurrentFen(); // capture before playback is stopped
  stopLinePlayback();
  Lab.fen = shown; // lines start from the position currently shown
  labBoard.setFen(Lab.fen);
  labBoard.clearArrows();
  const host = $("lines-results");
  host.innerHTML = '<div class="info-line">Calculating lines…</div>';
  try {
    const r = await apiPost("/api/strategy/lines", {
      fen: Lab.fen,
      max_moves: parseInt($("lines-slider").value, 10),
    });
    Lab.lines = r.lines || [];
    host.innerHTML = "";
    Lab.lines.forEach((line, i) => {
      const d = document.createElement("div");
      d.className = "lab-line";
      d.innerHTML = '<span class="rank-badge">#' + line.rank + "</span>" +
        "<b>" + evalText(line.eval) + "</b>  " + escapeHtml(line.moves_san.join(" "));
      d.addEventListener("click", () => selectLabLine(i, d));
      host.appendChild(d);
    });
    if (Lab.lines.length === 0) host.innerHTML = '<div class="info-line">No lines returned.</div>';
  } catch (e) {
    const eng = await surfaceEngineError(e);
    host.innerHTML = '<div class="info-line">' + (eng
      ? "Engine unavailable — see the banner above."
      : "Lines failed: " + escapeHtml(e.message)) + "</div>";
  }
});

async function selectLabLine(i, el) {
  document.querySelectorAll(".lab-line").forEach(x => x.classList.remove("active"));
  el.classList.add("active");
  stopLinePlayback();
  const line = Lab.lines[i];
  // precompute the FEN after each ply (moves come from the engine, validate step by step)
  const fens = [Lab.fen];
  let fen = Lab.fen;
  try {
    for (const uci of line.moves_uci) {
      const r = await apiPost("/api/move", { fen, move_uci: uci });
      if (!r.legal) break;
      fen = r.fen_after;
      fens.push(fen);
    }
  } catch (e) {
    showError("Playback unavailable: " + e.message);
    return;
  }
  Lab.playback = { fens, idx: 0, timer: null, lineIdx: i, uci: line.moves_uci };
  labBoard.setFen(Lab.fen);
  drawLabLineArrows(); // numbered arrows for the whole line (paused state)
  $("btn-line-play").disabled = false;
  $("btn-line-pause").disabled = true;
  $("btn-line-reset").disabled = false;
  updateLabNav();
}

/* numbered arrows for the selected line's first N moves (N = slider, max 5) */
function drawLabLineArrows() {
  const pb = Lab.playback;
  if (!pb) return;
  const n = Math.min(5, parseInt($("lines-slider").value, 10) || 4);
  labBoard.clearArrows();
  labBoard.drawNumberedMoves(pb.uci, n);
}

function labShowPlaybackPly() {
  const pb = Lab.playback;
  labBoard.setFen(pb.fens[pb.idx]);
  const uci = pb.idx > 0 ? pb.uci[pb.idx - 1] : null;
  labBoard.setLastMove(uci ? uci.slice(0, 2) : null, uci ? uci.slice(2, 4) : null);
}

/* manual ◀ ▶ / ⏮ ⏭ stepping while a line is loaded (pauses auto-play) */
function lineNavStep(dir) {
  const pb = Lab.playback;
  if (!pb) return;
  pauseLinePlayback();
  const last = pb.fens.length - 1;
  if (dir === "start") pb.idx = 0;
  else if (dir === "end") pb.idx = last;
  else pb.idx = Math.max(0, Math.min(last, pb.idx + (dir === "next" ? 1 : -1)));
  labShowPlaybackPly();
  drawLabLineArrows(); // paused → show the full line's numbered arrows
  updateLabNav();
}

function lineStepForward() {
  const pb = Lab.playback;
  if (!pb) return;
  if (pb.idx >= pb.fens.length - 1) { pauseLinePlayback(); drawLabLineArrows(); updateLabNav(); return; }
  pb.idx++;
  labShowPlaybackPly();
  updateLabNav();
}

function startLinePlayback() {
  const pb = Lab.playback;
  if (!pb || pb.timer) return;
  if (pb.idx >= pb.fens.length - 1) { pb.idx = 0; labBoard.setFen(pb.fens[0]); labBoard.setLastMove(null, null); }
  labBoard.clearArrows(); // numbered arrows hide during playback
  pb.timer = setInterval(lineStepForward, 600); // 600ms per ply
  $("btn-line-play").disabled = true;
  $("btn-line-pause").disabled = false;
  updateLabNav();
}

function pauseLinePlayback() {
  const pb = Lab.playback;
  if (pb && pb.timer) { clearInterval(pb.timer); pb.timer = null; }
  $("btn-line-play").disabled = !Lab.playback;
  $("btn-line-pause").disabled = true;
}

function stopLinePlayback() {
  if (Lab.playback && Lab.playback.timer) clearInterval(Lab.playback.timer);
  Lab.playback = null;
  $("btn-line-play").disabled = true;
  $("btn-line-pause").disabled = true;
  $("btn-line-reset").disabled = true;
  updateLabNav();
}

$("btn-line-play").addEventListener("click", startLinePlayback);
$("btn-line-pause").addEventListener("click", () => {
  pauseLinePlayback();
  drawLabLineArrows(); // paused → show the full line's numbered arrows
});
$("btn-line-reset").addEventListener("click", () => {
  pauseLinePlayback();
  if (Lab.playback) {
    Lab.playback.idx = 0;
    labBoard.setFen(Lab.fen);
    labBoard.setLastMove(null, null);
    drawLabLineArrows();
    updateLabNav();
  }
});

/* ---- (c) Master suggestions ---- */

$("btn-suggest").addEventListener("click", async () => {
  const host = $("suggest-cards");
  host.innerHTML = '<div class="info-line">Asking the master…</div>';
  $("master-note").classList.add("hidden");
  const fen = labCurrentFen();
  try {
    const r = await apiPost("/api/coach/suggest", { fen });
    host.innerHTML = "";
    (r.suggestions || []).forEach(s => {
      const c = document.createElement("div");
      c.className = "card";
      c.innerHTML = '<div class="big-move">' + escapeHtml(s.move_san) + "</div>" +
        '<span class="chip plan">' + escapeHtml(s.plan || "Plan") + "</span>" +
        '<div class="card-meta">eval ' + evalText(s.eval) + "</div>" +
        '<div class="line-preview">' + escapeHtml((s.line_san || []).join(" ")) + "</div>";
      c.addEventListener("click", () => {
        labBoard.setFen(fen);
        labBoard.setArrows([{ from: s.move_uci.slice(0, 2), to: s.move_uci.slice(2, 4), color: "amber" }]);
      });
      host.appendChild(c);
    });
    if (r.master_note) {
      const mn = $("master-note");
      mn.classList.remove("hidden");
      mn.textContent = r.master_note;
    }
  } catch (e) {
    const eng = await surfaceEngineError(e);
    host.innerHTML = '<div class="info-line">' + (eng
      ? "Engine unavailable — see the banner above."
      : "Suggestions failed: " + escapeHtml(e.message)) + "</div>";
  }
});

/* ================= Progress dashboard =================
   Rating history (lichess proxy), week-at-a-glance stats, accuracy trend
   and the openings report. All charts are dependency-free inline SVG
   sparklines built from plain point arrays. */

/* inline-SVG sparkline for an array of numbers (vanilla, no chart lib) */
function sparklineSvg(values, width, height) {
  const w = width || 260, h = height || 64, pad = 6;
  if (!values.length) return "";
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const span = (max - min) || 1;
  const stepX = values.length > 1 ? (w - 2 * pad) / (values.length - 1) : 0;
  const pts = values.map((v, i) =>
    (pad + i * stepX).toFixed(1) + "," +
    (h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(1)).join(" ");
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w +
    '" height="' + h + '" role="img" aria-label="trend chart">' +
    '<polyline fill="none" stroke="#c98f2e" stroke-width="2" ' +
    'stroke-linejoin="round" stroke-linecap="round" points="' + pts + '"/>' +
    "</svg>";
}

/* sparkline block with min/max value labels under it */
function sparkBlock(values, fmtVal) {
  const wrap = document.createElement("div");
  const fmt = fmtVal || (v => String(v));
  wrap.innerHTML = sparklineSvg(values);
  const labels = document.createElement("div");
  labels.className = "spark-labels";
  labels.innerHTML = "<span>min " + fmt(Math.min.apply(null, values)) + "</span>" +
    "<span>max " + fmt(Math.max.apply(null, values)) + "</span>";
  wrap.appendChild(labels);
  return wrap;
}

function initProgress() {
  loadRatingHistory();
  loadProgressSummary();
  loadOpeningsReport();
  loadPostmortemCalibration();
  loadCycleSummaryCard();
  loadEndgameProgressCard();
}

/* ---- endgame canon curriculum (dashboard card, V19) ---- */

async function loadEndgameProgressCard() {
  const host = $("progress-endgame");
  host.innerHTML = "";
  try {
    const r = await apiGet("/api/endgame/progress");
    const grid = document.createElement("div");
    grid.className = "glance-grid";
    grid.appendChild(glanceStat(
      r.lessons_passed + " / " + r.lessons_total, "canon lessons passed"));
    const p = r.placement;
    grid.appendChild(glanceStat(
      p && p.completed ? "tier " + p.recommended_tier : null,
      "placement recommendation"));
    host.appendChild(grid);
    const tiers = r.tiers || {};
    const keys = Object.keys(tiers).sort();
    if (keys.length) {
      const d = document.createElement("div");
      d.className = "info-line";
      d.textContent = keys.map(t =>
        "Tier " + t + ": " + tiers[t].passed + "/" + tiers[t].total
      ).join(" · ");
      host.appendChild(d);
    }
  } catch (_) {
    host.innerHTML =
      '<div class="info-line muted">Endgame curriculum unavailable.</div>';
  }
}

/* ---- latest Woodpecker cycle (dashboard card) ---- */

async function loadCycleSummaryCard() {
  const host = $("progress-cycles");
  host.innerHTML = "";
  try {
    const r = await apiGet("/api/cycles/summary");
    if (!r.latest) {
      host.appendChild(emptyStateCard({
        compact: true, icon: "🔁", title: "No cycles yet",
        text: "Build a set in the Cycles tab and run your first pass — your speed and accuracy per pass will show here.",
        actions: [{ label: "Open Cycles", tab: "cycles" }],
      }));
      return;
    }
    const l = r.latest;
    const grid = document.createElement("div");
    grid.className = "glance-grid";
    grid.appendChild(glanceStat(l.set_name || "?", "set"));
    grid.appendChild(glanceStat("cycle " + l.cycle_no, "completed"));
    grid.appendChild(glanceStat(
      Math.round((l.accuracy || 0) * 100) + "%", "accuracy"));
    grid.appendChild(glanceStat(
      l.avg_ms != null ? (l.avg_ms / 1000).toFixed(1) + "s" : null,
      "avg solve"));
    host.appendChild(grid);
    if (l.deltas) {
      const d = document.createElement("div");
      d.className = "info-line";
      const dAcc = Math.round((l.deltas.accuracy || 0) * 100);
      const dMs = (l.deltas.avg_ms || 0) / 1000;
      d.textContent = "vs previous cycle: " + (dAcc >= 0 ? "+" : "") + dAcc +
        "% accuracy · " + (dMs <= 0 ? "" : "+") + dMs.toFixed(1) + "s";
      host.appendChild(d);
    }
  } catch (_) {
    host.innerHTML =
      '<div class="info-line muted">Cycle stats unavailable.</div>';
  }
  // V24: current personal records per set (from the same set summaries)
  try {
    const sets = await apiGet("/api/cycles/sets");
    const prHost = document.createElement("div");
    (sets.sets || []).forEach(s => {
      const prs = s.prs || {};
      if (prs.fastest_ms == null && prs.best_accuracy == null &&
          prs.fastest_avg_solve_ms == null) return;
      const d = document.createElement("div");
      d.className = "info-line pr-line";
      const bits = [];
      if (prs.fastest_ms != null) {
        bits.push("fastest " + prFmtMs(prs.fastest_ms));
      }
      if (prs.best_accuracy != null) {
        bits.push("accuracy " + Math.round(prs.best_accuracy * 100) + "%");
      }
      if (prs.fastest_avg_solve_ms != null) {
        bits.push("avg " + prFmtMs(prs.fastest_avg_solve_ms));
      }
      d.textContent = "🏆 " + (s.name || "set") + ": " + bits.join(" · ");
      prHost.appendChild(d);
    });
    if (prHost.childNodes.length) host.appendChild(prHost);
  } catch (_) { /* PR list optional */ }
}

/* ---- post-mortem calibration trend (commit-first review scores) ---- */

async function loadPostmortemCalibration() {
  const host = $("pm-calibration-trend");
  try {
    const r = await apiGet("/api/postmortem/calibration/history");
    const rows = (r.history || []).filter(h => typeof h.score === "number");
    host.innerHTML = "";
    if (!rows.length) {
      host.innerHTML = "";
      host.appendChild(emptyStateCard({
        compact: true, icon: "🕵", title: "No post-mortems yet",
        text: "Pick a game in My Games and start a post-mortem: mark the moments you think were critical before the engine reveals the truth. Your calibration score is tracked here.",
        actions: [{ label: "Go to My Games", tab: "games" }],
      }));
      return;
    }
    const values = rows.map(h => h.score).slice(-30);
    if (values.length >= 2) {
      host.appendChild(sparkBlock(values, v => Math.round(v) + "/100"));
    }
    const list = document.createElement("div");
    rows.slice(-5).reverse().forEach((h) => {
      const d = document.createElement("div");
      d.className = "info-line";
      d.textContent = String(h.at || "").slice(0, 10) + " — " +
        Math.round(h.score) + "/100 · " + (h.white || "?") + " vs " +
        (h.black || "?") + " (found " + h.found + "/" + h.critical_count + ")";
      list.appendChild(d);
    });
    host.appendChild(list);
  } catch (_) {
    host.innerHTML =
      '<div class="info-line muted">Calibration history unavailable.</div>';
  }
}

/* ---- rating history (lichess proxy; degrades to a muted note) ---- */

function showRatingNote(msg) {
  const note = $("progress-rating-note");
  note.textContent = msg;
  note.classList.remove("hidden");
  $("progress-rating-settings-row").classList.remove("hidden");
  $("progress-rating-charts").innerHTML = "";
}

async function loadRatingHistory() {
  const charts = $("progress-rating-charts");
  try {
    const r = await apiGet("/api/progress/rating-history");
    if (!r.available) {
      showRatingNote("Set your lichess username in Settings to see rating history");
      return;
    }
    charts.innerHTML = "";
    $("progress-rating-note").classList.add("hidden");
    $("progress-rating-settings-row").classList.add("hidden");
    let shown = 0;
    for (const cat of r.categories || []) {
      const values = (cat.points || []).map(p => p[3]);
      if (values.length < 2) continue;
      shown++;
      const div = document.createElement("div");
      div.className = "rating-cat";
      const name = document.createElement("div");
      name.className = "rc-name";
      name.textContent = (cat.name || "?") + " — " + values[values.length - 1];
      div.appendChild(name);
      div.appendChild(sparkBlock(values));
      charts.appendChild(div);
    }
    if (!shown) {
      charts.innerHTML = '<div class="info-line muted">No rating data for ' +
        escapeHtml(r.username || "this user") + " yet.</div>";
    }
  } catch (e) {
    // 400 no_username or any failure: the card degrades to the muted note
    showRatingNote("Set your lichess username in Settings to see rating history");
  }
}

$("btn-progress-settings").addEventListener("click", openLichessSettings);
$("btn-openings-import").addEventListener("click", () => switchTab("games"));

/* ---- week at a glance + accuracy trend (progress summary + flashcards) ---- */

function glanceStat(val, label) {
  const d = document.createElement("div");
  d.className = "ps-stat";
  const b = document.createElement("b");
  b.textContent = val == null ? "–" : val;
  const s = document.createElement("span");
  s.textContent = label;
  d.appendChild(b); d.appendChild(s);
  return d;
}

async function loadProgressSummary() {
  let summary = null, fc = null;
  try { summary = await apiGet("/api/progress/summary"); } catch (_) { /* below */ }
  try {
    fc = await apiGet("/api/flashcards/stats");
    if (fc) { FC.stats = fc; renderStreak(); }
  } catch (_) { /* flashcards optional */ }
  // V24: the unified training streak (all session types) for the glance
  try {
    Plan24.streak = await apiGet("/api/training-plan/streak");
  } catch (_) { /* streak optional */ }
  renderGlance(summary, fc);
  renderAccuracyTrend(summary);
}

function renderGlance(summary, fc) {
  const host = $("progress-glance");
  host.innerHTML = "";
  if (!summary && !fc) {
    host.appendChild(emptyStateCard({
      compact: true, icon: "📈", title: "No progress data yet",
      text: "Import and review a game, or solve a few puzzles — your weekly numbers appear here.",
      actions: [{ label: "Import games", tab: "games" }, { label: "Solve a puzzle", tab: "puzzles" }],
    }));
    return;
  }
  host.appendChild(glanceStat(summary ? summary.games_imported : null, "games imported"));
  host.appendChild(glanceStat(summary ? summary.games_analyzed : null, "games analyzed"));
  // avg accuracy of the last 10 analyses (user side when the handle is known)
  let avg = null;
  if (summary) {
    const vals = [];
    for (const rec of (summary.analyses || []).slice(0, 10)) {
      const color = userColorIn(rec.white, rec.black);
      const v = color
        ? rec["accuracy_" + color]
        : [rec.accuracy_white, rec.accuracy_black]
            .filter(x => typeof x === "number")
            .reduce((a, x, _, arr) => a + x / arr.length, 0);
      if (typeof v === "number" && isFinite(v)) vals.push(v);
    }
    if (vals.length) {
      avg = (vals.reduce((a, x) => a + x, 0) / vals.length).toFixed(1) + "%";
    }
  }
  host.appendChild(glanceStat(avg, "avg accuracy (last 10)"));
  host.appendChild(glanceStat(fc ? fc.reviewed_today : null, "flashcards today"));
  // V24: prefer the unified training streak (all real session types, with
  // freeze state) over the flashcards-only one
  const ts = Plan24.streak;
  const streakVal = ts
    ? "🔥 " + ts.current + (ts.freeze_available ? " ❄" : "")
    : "🔥 " + Math.max(localStreak(), (fc && fc.current_streak) || 0);
  host.appendChild(glanceStat(streakVal, "day streak"));
  host.appendChild(glanceStat(
    fc && fc.retention_7d != null ? Math.round(fc.retention_7d * 100) + "%" : null,
    "retention 7d"));
}

function renderAccuracyTrend(summary) {
  const host = $("progress-trend");
  host.innerHTML = "";
  const values = ((summary && summary.accuracy_trend) || [])
    .map(p => p.accuracy).filter(v => typeof v === "number").slice(-30);
  if (values.length < 2) {
    host.innerHTML = "";
    host.appendChild(emptyStateCard({
      compact: true, icon: "🎯", title: "No accuracy trend yet",
      text: "Review at least two games in My Games — each review adds an accuracy point to this chart.",
      actions: [{ label: "Go to My Games", tab: "games" }],
    }));
    return;
  }
  host.appendChild(sparkBlock(values, v => v.toFixed(1) + "%"));
}

/* ---- openings report + leak warnings ---- */

async function loadOpeningsReport() {
  const wrap = $("openings-table-wrap");
  const leaksHost = $("openings-leaks");
  try {
    const r = await apiGet("/api/openings/report");
    if (!r.total_games) {
      $("openings-empty").classList.remove("hidden");
      wrap.innerHTML = "";
      leaksHost.innerHTML = "";
      return;
    }
    $("openings-empty").classList.add("hidden");
    const rows = (r.by_opening || []).slice(0, 10);
    let html = '<table class="openings-table"><thead><tr>' +
      "<th>Opening</th><th>ECO</th><th>Games</th><th>W-D-L</th><th>Score%</th>" +
      "</tr></thead><tbody>";
    for (const o of rows) {
      html += "<tr><td>" + escapeHtml(o.name || "?") + "</td><td>" +
        escapeHtml(o.eco || "–") + "</td><td>" + o.games + "</td><td>" +
        o.wins + "-" + o.draws + "-" + o.losses + "</td><td>" +
        o.score_pct.toFixed(1) + "%</td></tr>";
    }
    wrap.innerHTML = html + "</tbody></table>";
    // leaks: server pre-filters score<45% over >=3 games
    leaksHost.innerHTML = "";
    if ((r.leaks || []).length) {
      const h = document.createElement("h3");
      h.textContent = "Leaks";
      leaksHost.appendChild(h);
    }
    for (const leak of r.leaks || []) {
      const card = document.createElement("div");
      card.className = "leak-card";
      const txt = document.createElement("span");
      txt.textContent = (leak.name || "?") + " — " + leak.score_pct.toFixed(0) +
        "% over " + leak.games + " games — review your lines in Strategy Lab";
      card.appendChild(txt);
      const btn = document.createElement("button");
      btn.className = "btn mini";
      btn.textContent = "Strategy Lab";
      btn.addEventListener("click", () => switchTab("lab"));
      card.appendChild(btn);
      leaksHost.appendChild(card);
    }
  } catch (e) {
    wrap.innerHTML = '<div class="info-line">Openings report unavailable: ' +
      escapeHtml(e.message) + "</div>";
  }
}

/* ================= Play from here + Copy FEN (all boards) =================
   Every board gets "▶ Practice from here" (a shared side-picker popover that
   launches the ad-hoc `custom` rehearsal mode from the displayed position)
   and "⧉ Copy FEN" (async clipboard API with a textarea/execCommand
   fallback). FEN sources always match what the board currently displays —
   for the stepped viewers (Games / model games / Lab) that is the position
   at the current nav ply, the same source the board itself was set from. */

/* launch the ad-hoc practice mode from any displayed position */
function startPracticeFrom(fen, userSide) {
  if (!fenLooksValid(fen)) { // boards always hold valid FENs — belt & braces
    console.warn("startPracticeFrom: refusing invalid FEN", fen);
    return;
  }
  const mode = REHEARSAL_MODES.custom;
  mode.userSide = userSide;
  mode.startFen = fen;
  mode.banner = "Practice position — you are " +
    (userSide === "white" ? "White" : "Black") + ". The app plays the other side.";
  mode.hint = fenSide(fen) === (userSide === "white" ? "w" : "b")
    ? "Your move." : "App moves first…";
  switchTab("play");
  rehearsalStart("custom", fen, mode.hint); // exits review; app replies if it's its turn
}

/* FEN at the Games board's current nav ply — the same gameFenAt() source
   gameGoToPly() displays; falls back to the board when nothing is loaded */
function gameCurrentFen() {
  return Games.analysis ? gameFenAt(Games.viewPly) : gameBoard.getFen();
}

/* FEN at the model-game viewer's current ply (updateMgView()'s source) */
function mgCurrentFen() {
  return MG.current ? MG.fens[MG.ply] : mgBoard.getFen();
}

/* ---- shared side-picker popover (one instance for every board) ---- */

const Pfh = {
  anchor: null,   // button the menu is currently attached to
  getFen: null,   // FEN provider captured when the menu was opened
};

function openPfhMenu(anchorBtn, getFen) {
  const menu = $("pfh-menu");
  if (!menu) return;
  if (Pfh.anchor === anchorBtn && !menu.hidden) { closePfhMenu(); return; } // toggle
  closePfhMenu(); // only one open at a time (also resets any previous anchor)
  Pfh.anchor = anchorBtn;
  Pfh.getFen = getFen;
  menu.hidden = false; // unhide before measuring
  const r = anchorBtn.getBoundingClientRect();
  let left = r.left + window.scrollX;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 4;
  left = Math.max(window.scrollX + 4, Math.min(left, maxLeft)); // keep inside viewport
  menu.style.left = left + "px";
  // below the anchor by default; flip ABOVE when it would overflow the
  // bottom viewport edge (measured while unhidden)
  let top = r.bottom + window.scrollY + 4;
  if (r.bottom + 4 + menu.offsetHeight > window.innerHeight) {
    top = r.top + window.scrollY - menu.offsetHeight - 4;
  }
  menu.style.top = top + "px";
  anchorBtn.setAttribute("aria-expanded", "true");
  // a resize can move the anchor out from under the menu — just close it
  window.addEventListener("resize", closePfhMenu);
}

function closePfhMenu() {
  const menu = $("pfh-menu");
  if (menu) menu.hidden = true;
  if (Pfh.anchor) Pfh.anchor.setAttribute("aria-expanded", "false");
  Pfh.anchor = null;
  Pfh.getFen = null;
  window.removeEventListener("resize", closePfhMenu); // no-op when not added
}

document.querySelectorAll("#pfh-menu button[data-side]").forEach(btn =>
  btn.addEventListener("click", () => {
    const getFen = Pfh.getFen;
    const side = btn.dataset.side;
    closePfhMenu();
    if (getFen) startPracticeFrom(getFen(), side);
  }));

/* outside mousedown or Escape closes the menu (clicks on the anchor itself
   fall through to the anchor's own click handler, which toggles) */
document.addEventListener("mousedown", (e) => {
  const menu = $("pfh-menu");
  if (!menu || menu.hidden) return;
  if (menu.contains(e.target)) return;
  if (Pfh.anchor && Pfh.anchor.contains(e.target)) return;
  closePfhMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePfhMenu();
});

/* ---- shared FEN copier ---- */

/* generation counter for the 3s "FEN copied." clear: a LATER copy (any
   board — the status element may be shared per board) must not have its
   fresh message wiped by an EARLIER copy's pending timeout */
let copyStatusSeq = 0;

async function copyFenToClipboard(fen, statusEl) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(fen);
    ok = true;
  } catch (_) {
    // clipboard API unavailable (non-secure context / denied) — legacy fallback
    try {
      const ta = document.createElement("textarea");
      ta.value = fen;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (_) { ok = false; }
  }
  if (!statusEl) return;
  if (ok) {
    statusEl.textContent = "FEN copied.";
    const seq = ++copyStatusSeq;
    setTimeout(() => {
      if (seq === copyStatusSeq && statusEl.textContent === "FEN copied.") {
        statusEl.textContent = "";
      }
    }, 3000);
  } else {
    // show the FEN (textContent only) so the user can select it manually
    statusEl.textContent = "Copy failed — select it here: " + fen;
  }
}

/* ---- "Make puzzle from here" (Play + Lab boards) ----
   POSTs the displayed FEN to /api/puzzles/from-fen; the server verifies a
   unique, settled best move and saves it into the user puzzle library.
   Result is reported in the board's copy-status line (textContent only). */
let makePuzzleSeq = 0;

async function makePuzzleFrom(getFen, statusEl) {
  if (!statusEl) return;
  statusEl.textContent = "Checking for a puzzle…";
  const seq = ++makePuzzleSeq;
  try {
    const data = await apiPost("/api/puzzles/from-fen", { fen: getFen() });
    if (seq !== makePuzzleSeq) return; // a newer request superseded this one
    const p = data.puzzle || {};
    statusEl.textContent = data.created
      ? "Puzzle saved to your library (" + (p.theme || "?") +
        ", rating " + (p.rating || "?") + ")."
      : "That position is already a puzzle in your library.";
  } catch (err) {
    if (seq !== makePuzzleSeq) return;
    const detail = (err && typeof err.detail === "string") ? err.detail : "";
    statusEl.textContent =
      detail === "no_clear_puzzle" ? "No clear puzzle in this position." :
      detail === "engine_unavailable" ? "Engine unavailable — cannot verify a puzzle." :
      detail === "invalid_fen" ? "The board position is not a valid FEN." :
      "Could not build a puzzle here.";
  }
}

/* null-safe wiring for one board's make-puzzle button */
function wireMakePuzzle(btnId, statusId, getFen) {
  const btn = $(btnId);
  if (btn) {
    btn.addEventListener("click", () => makePuzzleFrom(getFen, $(statusId)));
  }
}

/* null-safe wiring for one board's practice + copy buttons */
function wirePracticeCopy(practiceId, copyId, statusId, getFen) {
  const practiceBtn = $(practiceId);
  if (practiceBtn) {
    practiceBtn.setAttribute("aria-haspopup", "menu");
    practiceBtn.setAttribute("aria-expanded", "false");
    practiceBtn.addEventListener("click", () => openPfhMenu(practiceBtn, getFen));
  }
  const copyBtn = $(copyId);
  if (copyBtn) {
    copyBtn.addEventListener("click", () => copyFenToClipboard(getFen(), $(statusId)));
  }
}

// Play board (works during mistake review too — rehearsalStart exits review)
wirePracticeCopy("btn-play-practice", "btn-play-copy-fen", "play-copy-status",
  () => playBoard.getFen());
wirePracticeCopy("btn-puzzle-practice", "btn-puzzle-copy-fen", "puzzle-copy-status",
  () => puzzleBoard.getFen());
wirePracticeCopy("btn-game-practice", "btn-game-copy-fen", "game-copy-status",
  () => gameCurrentFen());
wirePracticeCopy("btn-mg-practice", "btn-mg-copy-fen", "mg-copy-status",
  () => mgCurrentFen());
wirePracticeCopy("btn-lesson-practice", "btn-lesson-copy-fen", "lesson-copy-status",
  () => lessonBoard.getFen());
wirePracticeCopy("btn-lab-practice", "btn-lab-copy-fen", "lab-copy-status",
  () => labCurrentFen());

// "Make puzzle from here" — Play + Lab boards (verified server-side)
wireMakePuzzle("btn-play-makepuzzle", "play-copy-status",
  () => playBoard.getFen());
wireMakePuzzle("btn-lab-makepuzzle", "lab-copy-status",
  () => labCurrentFen());

/* ================= startup: health check + plan controls ================= */

// opponent-level selects: restore the persisted choice, re-plan on change
syncOppLevelSelects();
document.querySelectorAll("select.opp-level").forEach(el =>
  el.addEventListener("change", () => onOppLevelChange(el.value)));
wireLichessSettings();
wireLlmSettings();
wireVoice();

(async function startup() {
  loadLichessConfig(); // sets the token checkmark when one is stored server-side
  loadVoiceStatus();   // hides the speaker buttons when the voice can't work
  initMaia();          // Maia panel, or the muted install note when absent
  refreshFlashcards(); // flashcard deck stats on the Puzzles tab
  updateFcAddButton();
  syncImportUI();      // import source defaults to chess.com (months dropdown)
  renderStreak();      // streak chip from localStorage before server stats land
  try {
    const h = await apiGet("/api/health");
    updateHealthUI(h);
  } catch (e) {
    State.engineOk = false;
    updateHealthDot(null, "backend server unreachable");
    setEngineBanner("Cannot reach the backend server.", "red");
  }
  chatInit(); // first ever open: the coach greets (implicit "hello")
})();

/* ================= Visual Training Plan (V20) =================
   The weekly plan board: five pillar columns with live checklist items,
   hand-rolled SVG progress rings, per-pillar sparkline trends, an
   adherence bar (this week + 8-week trend) and a plain-language
   "why this plan" line. Everything comes from /api/training-plan — the
   server derives the plan from the real stores, so nothing here is
   invented. Item labels are applied with textContent only; the SVG
   strings below contain numbers exclusively. */

const PLAN_PILLARS = [
  { key: "review", label: "Review" },
  { key: "tactics", label: "Tactics" },
  { key: "sparring", label: "Sparring" },
  { key: "endgame", label: "Endgame" },
  { key: "masters", label: "Masters" },
  { key: "openings", label: "Openings" },
];

/* Today-card priority: due re-tests first, then today's flashcards. */
const PLAN_KIND_PRIORITY = {
  retest: 0, flashcards: 1, postmortem: 2, cycle: 3, placement: 4,
  lesson: 5, pack_session: 6, gtm: 7, motif_focus: 8, opening_repair: 9, opening_drill: 2,
  analysis: 10, onboarding: 11,
};

/* donut ring: % of the pillar's weekly target done, headline metric in
   the middle. `metric` is always formatted from numbers below (never
   user data), so the SVG string stays injection-free. */
function planRingSvg(frac, metric) {
  const r = 30, c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac || 0));
  const dash = (f * c).toFixed(1) + " " + c.toFixed(1);
  const top = String(metric == null ? "–" : metric);
  const sub = Math.round(f * 100) + "%";
  return '<svg class="plan-ring" viewBox="0 0 76 76" width="76" height="76" ' +
    'role="img" aria-label="pillar progress ring">' +
    '<circle cx="38" cy="38" r="' + r + '" fill="none" stroke="#e7dcc4" stroke-width="8"/>' +
    '<circle cx="38" cy="38" r="' + r + '" fill="none" stroke="#c98f2e" stroke-width="8" ' +
    'stroke-linecap="round" stroke-dasharray="' + dash + '" transform="rotate(-90 38 38)"/>' +
    '<text x="38" y="36" text-anchor="middle" font-size="13" font-weight="700" fill="#33302b">' +
    top + "</text>" +
    '<text x="38" y="50" text-anchor="middle" font-size="10" fill="#55504a">' +
    sub + "</text></svg>";
}

/* per-pillar headline metric + sparkline series from the metrics payload */
function planPillarVisual(key, pillar, metrics) {
  const m = metrics || {};
  const target = pillar.target_sessions || 0;
  const frac = target ? (pillar.done_sessions || 0) / target : 0;
  let metric = null, trend = [];
  if (key === "review" && m.review) {
    metric = m.review.latest_calibration != null
      ? Math.round(m.review.latest_calibration) + "%" : null;
    trend = m.review.calibration || [];
  } else if (key === "tactics" && m.tactics) {
    metric = m.tactics.retention_7d != null
      ? Math.round(m.tactics.retention_7d * 100) + "%" : null;
    trend = (m.tactics.cycle_accuracy || []).map(v => Math.round(v * 100));
  } else if (key === "sparring" && m.sparring) {
    metric = m.sparring.pass_rate != null
      ? Math.round(m.sparring.pass_rate * 100) + "%" : null;
    trend = (m.sparring.pass_trend || []).map(v => Math.round(v * 100));
  } else if (key === "endgame" && m.endgame) {
    metric = m.endgame.lessons_passed + "/" + m.endgame.lessons_total;
    trend = m.endgame.passed_trend || [];
  } else if (key === "openings" && m.openings) {
    metric = m.openings.known_pct != null ? m.openings.known_pct + "%" : null;
    trend = m.openings.trend || [];
  } else if (key === "masters" && m.masters) {
    metric = m.masters.best_score != null ? String(m.masters.best_score) : null;
    trend = m.masters.scores || [];
  }
  return { metric: metric, trend: trend, frac: frac };
}

/* actionable right now: not done and not scheduled for a future date.
   Missed flashcard days collapse into ONE entry (today's queue, or the
   most recent missed day) so a skipped week can't crowd the card. */
function planActionable(plan) {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  const flash = [];
  PLAN_PILLARS.forEach(p => {
    const pillar = plan && plan.pillars ? plan.pillars[p.key] : null;
    ((pillar && pillar.items) || []).forEach(it => {
      if (it.done) return;
      if (it.due && String(it.due) > today) return;
      const entry = { pillar: p.label, item: it };
      if (it.kind === "flashcards") flash.push(entry);
      else out.push(entry);
    });
  });
  if (flash.length) {
    // today's item has due=null — prefer it, else the latest missed day
    flash.sort((a, b) => String(b.item.due || "9999")
      .localeCompare(String(a.item.due || "9999")));
    out.push(flash[0]);
  }
  out.sort((a, b) => {
    const pa = PLAN_KIND_PRIORITY[a.item.kind] != null ? PLAN_KIND_PRIORITY[a.item.kind] : 50;
    const pb = PLAN_KIND_PRIORITY[b.item.kind] != null ? PLAN_KIND_PRIORITY[b.item.kind] : 50;
    return pa - pb;
  });
  return out;
}

/* V24 (DUP-1): the Today card exists ONCE, on the Plan tab — the Progress
   dashboard now links here instead of rendering a duplicate. */
function renderPlanToday(host, plan) {
  if (!host) return;
  host.innerHTML = "";
  if (!plan) {
    const d = document.createElement("div");
    d.className = "info-line muted";
    d.textContent = "Training plan unavailable.";
    host.appendChild(d);
    return;
  }
  const actions = planActionable(plan).slice(0, 5);
  if (!actions.length) {
    const d = document.createElement("div");
    d.className = "info-line";
    d.textContent = "All caught up — nothing due right now. Nice work.";
    host.appendChild(d);
  }
  actions.forEach(a => {
    const row = document.createElement("div");
    row.className = "plan-today-row";
    const tag = document.createElement("span");
    tag.className = "plan-pillar-tag";
    tag.textContent = a.pillar;
    const lbl = document.createElement("span");
    lbl.className = "plan-today-label";
    lbl.textContent = a.item.label;
    const btn = document.createElement("button");
    btn.className = "btn mini";
    btn.textContent = "Open";
    const tab = a.item.ref && a.item.ref.tab;
    if (a.item.ref && a.item.ref.drill) btn.setAttribute("data-opening-drill", a.item.ref.drill);
    else btn.addEventListener("click", () => { if (tab) switchTab(tab); });
    row.appendChild(tag);
    row.appendChild(lbl);
    row.appendChild(btn);
    host.appendChild(row);
  });
}

function renderPlanAdherence(plan, adherence) {
  const host = $("plan-adherence");
  if (!host) return;
  host.innerHTML = "";
  const a = plan && plan.adherence;
  if (!a) {
    host.innerHTML = "";
    const d = document.createElement("div");
    d.className = "info-line muted";
    d.textContent = "Adherence unavailable.";
    host.appendChild(d);
    return;
  }
  const line = document.createElement("div");
  line.className = "info-line";
  line.textContent = "This week: " + a.completed + " of " + a.planned +
    " planned items done (" + a.pct + "%)";
  const bar = document.createElement("div");
  bar.className = "adherence-bar";
  const fill = document.createElement("div");
  fill.className = "adherence-fill";
  fill.style.width = Math.max(0, Math.min(100, a.pct || 0)) + "%";
  bar.appendChild(fill);
  host.appendChild(line);
  host.appendChild(bar);

  const trendHost = $("plan-adherence-trend");
  if (!trendHost) return;
  trendHost.innerHTML = "";
  const weeks = (adherence && adherence.weeks) || [];
  if (weeks.length >= 2) {
    trendHost.appendChild(sparkBlock(weeks.map(w => w.pct || 0), v => v + "%"));
    const cap = document.createElement("div");
    cap.className = "info-line muted";
    cap.textContent = "Weekly adherence — " + weeks[0].week_of + " → " +
      weeks[weeks.length - 1].week_of;
    trendHost.appendChild(cap);
  } else {
    const d = document.createElement("div");
    d.className = "info-line muted";
    d.textContent = "The 8-week adherence trend builds up week by week.";
    trendHost.appendChild(d);
  }
}

function renderPlanReasons(plan) {
  const host = $("plan-reasons");
  if (!host) return;
  const reasons = (plan && plan.reasons) || [];
  let text = reasons.length
    ? "Why this plan: " + reasons.join(" · ")
    : "Why this plan: the standard weekly mix — review your games, drill " +
      "tactics, spar, study endgames and the masters.";
  if (plan && plan.week_of) text = "Week of " + plan.week_of + ". " + text;
  host.textContent = text;
}

function planItemCard(it) {
  const card = document.createElement("div");
  card.className = "plan-item" + (it.done ? " done" : "");
  const check = document.createElement("span");
  check.className = "plan-check";
  check.textContent = it.done ? "✓" : "";
  const body = document.createElement("div");
  body.className = "plan-item-body";
  const lbl = document.createElement("div");
  lbl.className = "plan-item-label";
  lbl.textContent = it.label;
  body.appendChild(lbl);
  if (it.due) {
    const due = document.createElement("div");
    due.className = "plan-item-due muted";
    due.textContent = "due " + it.due;
    body.appendChild(due);
  }
  card.appendChild(check);
  card.appendChild(body);
  if (!it.done && it.ref && it.ref.tab) {
    card.classList.add("clickable");
    card.title = "Open the " + it.ref.tab + " tab";
    if (it.ref.drill) card.setAttribute("data-opening-drill", it.ref.drill);
    else card.addEventListener("click", () => switchTab(it.ref.tab));
  }
  return card;
}

function renderPlanBoard(plan, metrics) {
  const host = $("plan-board");
  if (!host) return;
  host.innerHTML = "";
  PLAN_PILLARS.forEach(p => {
    const pillar = (plan && plan.pillars && plan.pillars[p.key]) ||
      { target_sessions: 0, done_sessions: 0, items: [] };
    const col = document.createElement("div");
    col.className = "plan-col";
    col.id = "plan-col-" + p.key;
    const head = document.createElement("div");
    head.className = "plan-col-head";
    const title = document.createElement("h3");
    title.textContent = p.label;
    const count = document.createElement("span");
    count.className = "plan-col-count muted";
    count.textContent = (pillar.done_sessions || 0) + "/" +
      (pillar.target_sessions || 0);
    head.appendChild(title);
    head.appendChild(count);
    col.appendChild(head);
    const vis = planPillarVisual(p.key, pillar, metrics);
    const ringWrap = document.createElement("div");
    ringWrap.className = "plan-ring-wrap";
    ringWrap.innerHTML = planRingSvg(vis.frac, vis.metric);
    col.appendChild(ringWrap);
    if (vis.trend.length >= 2) {
      const ts = document.createElement("div");
      ts.className = "plan-trend";
      ts.innerHTML = sparklineSvg(vis.trend, 150, 36);
      col.appendChild(ts);
    }
    const list = document.createElement("div");
    list.className = "plan-items";
    (pillar.items || []).forEach(it => list.appendChild(planItemCard(it)));
    col.appendChild(list);
    host.appendChild(col);
  });
}

function initPlan() {
  loadTrainingPlan();
  loadStreak();
  loadHeatmap();
}

async function loadTrainingPlan() {
  let plan = null, adherence = null, metrics = null;
  try { plan = await apiGet("/api/training-plan"); } catch (_) { /* below */ }
  try { adherence = await apiGet("/api/training-plan/adherence"); } catch (_) { /* below */ }
  try { metrics = await apiGet("/api/training-plan/pillars"); } catch (_) { /* below */ }
  renderPlanToday($("plan-today"), plan);
  renderPlanAdherence(plan, adherence);
  renderPlanReasons(plan);
  renderPlanBoard(plan, metrics);
  checkWeekClosed(plan);
}

/* V24 (DUP-1): the Progress tab links to the single Plan-tab Today card. */
$("btn-progress-today-plan").addEventListener("click", () => switchTab("plan"));

/* ================= V24: the delight layer =================
   Training streak (freeze + repair), training-year heatmap, ring-closure
   confetti and milestone banners. All derived from /api/training-plan/*
   endpoints — flavor text only, no chess claims. */

/* muted palette for the confetti burst (pure decoration, no text) */
const CONFETTI_COLORS = ["#10b981", "#34d399", "#3b82f6", "#f59e0b",
  "#a855f7", "#e2e8f0"];

function confettiBurst(count) {
  const host = $("confetti-host");
  if (!host) return;
  const n = count || 30;
  for (let i = 0; i < n; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = (35 + Math.random() * 30) + "vw";
    piece.style.background =
      CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.animationDelay = (Math.random() * 0.25).toFixed(2) + "s";
    piece.style.setProperty("--drift", (Math.random() * 40 - 20) + "vw");
    piece.style.transform = "rotate(" + Math.floor(Math.random() * 360) + "deg)";
    host.appendChild(piece);
    setTimeout(() => { piece.remove(); }, 2600);
  }
}

/* ---- training streak: flame chip + milestone banner ---- */

const STREAK_MILESTONES_KEY = "chesscoach.streakMilestones";
const STREAK_MILESTONES = [7, 30, 100];

const Plan24 = { streak: null };

async function loadStreak() {
  try {
    const s = await apiGet("/api/training-plan/streak");
    Plan24.streak = s;
    renderStreakChip(s);
    checkStreakMilestone(s);
  } catch (_) { /* streak chip stays hidden */ }
}

function renderStreakChip(s) {
  const chip = $("streak-chip");
  const note = $("streak-note");
  if (!chip || !s) return;
  chip.classList.remove("hidden");
  chip.textContent = "🔥 " + s.current +
    (s.current === 1 ? " day" : " days");
  const bits = [];
  if (s.today_done) bits.push("today done");
  else if (s.in_progress) bits.push("today in progress");
  if (s.repair_available) {
    bits.push("finish any session today to repair your streak");
  } else if (s.freeze_available) {
    bits.push("❄ freeze ready");
  } else if (s.freezes_used_this_week > 0) {
    bits.push("❄ freeze used");
  }
  if (s.best > 1) bits.push("best " + s.best);
  note.textContent = bits.join(" · ");
  chip.title = "Training streak — consecutive training days (UTC). " +
    "One missed day per 7 is auto-frozen; two in a row break the streak.";
}

/* milestone banner: fires once per milestone (localStorage-tracked) */
function checkStreakMilestone(s) {
  if (!s || !s.current) return;
  const hit = STREAK_MILESTONES.filter(m => s.current >= m).pop();
  if (!hit) return;
  let shown = [];
  try { shown = JSON.parse(localStorage.getItem(STREAK_MILESTONES_KEY) || "[]"); }
  catch (_) { shown = []; }
  if (shown.indexOf(hit) !== -1) return;
  shown.push(hit);
  try { localStorage.setItem(STREAK_MILESTONES_KEY, JSON.stringify(shown)); }
  catch (_) { /* storage unavailable — banner still shows this once */ }
  const banner = $("streak-milestone");
  $("streak-milestone-text").textContent =
    "🔥 " + hit + "-day training streak — keep it burning!";
  banner.classList.remove("hidden");
  confettiBurst(30);
  speakCelebration($("streak-milestone-text").textContent); // V26: once
}

$("btn-streak-milestone-dismiss").addEventListener("click", () =>
  $("streak-milestone").classList.add("hidden"));

/* ---- training-year heatmap (GitHub-style contribution grid) ---- */

const HEATMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul",
  "Aug", "Sep", "Oct", "Nov", "Dec"];

async function loadHeatmap() {
  const year = new Date().getFullYear();
  try {
    const r = await apiGet("/api/training-plan/heatmap?year=" + year);
    renderHeatmap(r);
  } catch (_) {
    $("plan-heatmap-caption").textContent = "Heatmap unavailable.";
  }
}

function renderHeatmap(data) {
  const host = $("plan-heatmap");
  const monthsHost = $("plan-heatmap-months");
  const capHost = $("plan-heatmap-caption");
  host.innerHTML = "";
  monthsHost.innerHTML = "";
  const year = data.year;
  const counts = {};
  let trainedDays = 0;
  (data.days || []).forEach(d => {
    counts[d.date] = d.sessions;
    if (d.sessions >= 1) trainedDays++;
  });

  // grid: week-columns x 7 day-rows (Mon first), covering Jan 1 – Dec 31.
  // The column count is derived from the year's days + the Jan-1 weekday
  // offset: a 366-day year starting on a Sunday needs 54 columns — a
  // hardcoded 53 would drop Dec 31 (and Dec 30) off the grid.
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dec31 = new Date(Date.UTC(year, 11, 31));
  const start = new Date(jan1);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const cols = Math.floor((dec31 - start) / (7 * 86400000)) + 1;
  const todayStr = new Date().toISOString().slice(0, 10);
  const monthRow = new Array(cols).fill("");
  monthsHost.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
  let lastMonth = -1;
  for (let col = 0; col < cols; col++) {
    const weekStart = new Date(start);
    weekStart.setUTCDate(weekStart.getUTCDate() + col * 7);
    const m = weekStart.getUTCMonth();
    if (weekStart.getUTCFullYear() === year && m !== lastMonth) {
      monthRow[col] = HEATMAP_MONTHS[m];
      lastMonth = m;
    }
    for (let row = 0; row < 7; row++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + col * 7 + row);
      const cell = document.createElement("div");
      cell.className = "heatmap-cell";
      if (d.getUTCFullYear() !== year) {
        cell.classList.add("outside");
      } else {
        const iso = d.toISOString().slice(0, 10);
        const n = counts[iso] || 0;
        const level = n <= 0 ? 0 : Math.min(4, n);
        cell.classList.add("l" + level);
        cell.title = iso + " — " + n +
          (n === 1 ? " session" : " sessions") +
          (iso > todayStr ? " (future)" : "");
      }
      host.appendChild(cell);
    }
  }
  monthRow.forEach(label => {
    const m = document.createElement("span");
    m.textContent = label;
    monthsHost.appendChild(m);
  });
  capHost.textContent = trainedDays +
    (trainedDays === 1 ? " training day" : " training days") +
    " this year";
}

/* ---- ring-closure celebration: all five pillars met their weekly target ---- */

const WEEK_CLOSED_KEY = "chesscoach.weekClosed";

function checkWeekClosed(plan) {
  if (!plan || !plan.pillars || !plan.week_of) return;
  const closed = PLAN_PILLARS.every(p => {
    const pillar = plan.pillars[p.key];
    return pillar && pillar.target_sessions > 0 &&
      (pillar.done_sessions || 0) >= pillar.target_sessions;
  });
  if (!closed) return;
  let celebrated = null;
  try { celebrated = localStorage.getItem(WEEK_CLOSED_KEY); } catch (_) { /* */ }
  if (celebrated === plan.week_of) return; // once per week
  try { localStorage.setItem(WEEK_CLOSED_KEY, plan.week_of); } catch (_) { /* */ }
  const banner = $("week-closed-banner");
  banner.textContent = "Week closed — every pillar complete.";
  banner.classList.remove("hidden");
  confettiBurst(30);
  speakCelebration(banner.textContent); // V26: read the banner ONCE
}

/* ================= redesign UX layer (theme, sound, empty states) =================
   Additive and defensive: every piece is wrapped so a failure here can never
   break the engine, shim or tab logic above. */

/* friendly empty-state card: { icon, title, text, compact, actions:[{label, primary, tab, onClick}] } */
function emptyStateCard(o) {
  const card = document.createElement("div");
  card.className = "empty-state" + (o.compact ? " compact" : "");
  const icon = document.createElement("div");
  icon.className = "es-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = o.icon || "♟";
  const body = document.createElement("div");
  body.className = "es-body";
  const t = document.createElement("div");
  t.className = "es-title";
  t.textContent = o.title || "";
  const p = document.createElement("div");
  p.className = "es-text";
  p.textContent = o.text || "";
  body.appendChild(t);
  body.appendChild(p);
  if (o.actions && o.actions.length) {
    const row = document.createElement("div");
    row.className = "es-actions";
    for (const a of o.actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn" + (a.primary ? " primary" : "");
      b.textContent = a.label;
      if (a.tab) b.dataset.gotoTab = a.tab;
      if (a.onClick) b.addEventListener("click", a.onClick);
      row.appendChild(b);
    }
    body.appendChild(row);
  }
  card.appendChild(icon);
  card.appendChild(body);
  return card;
}

(function redesignUx() {
  /* ---- theme toggle (localStorage "chesscoach:theme") ---- */
  try {
    const btn = $("btn-theme-toggle");
    const apply = (t) => {
      document.documentElement.setAttribute("data-theme", t);
      const m = document.getElementById("meta-theme-color");
      if (m) m.setAttribute("content", t === "light" ? "#f5f7fa" : "#0d1117");
      if (btn) {
        btn.querySelector(".icon-btn-glyph").textContent = t === "light" ? "☾" : "☀";
        btn.title = t === "light" ? "Switch to dark theme" : "Switch to light theme";
      }
    };
    apply(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    if (btn) btn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      try { localStorage.setItem("chesscoach:theme", next); } catch (_) { /* */ }
      apply(next);
    });
  } catch (_) { /* theme is cosmetic */ }

  /* ---- move-sound mute toggle (localStorage "chesscoach:sound") ---- */
  try {
    const btn = $("btn-sound-toggle");
    const sync = () => {
      const muted = typeof BoardSound !== "undefined" && BoardSound.muted;
      btn.querySelector(".icon-btn-glyph").textContent = muted ? "🔇" : "🔊";
      btn.setAttribute("aria-pressed", muted ? "false" : "true");
      btn.title = muted ? "Move sounds: muted (click to unmute)" : "Move sounds: on (click to mute)";
      btn.classList.toggle("off", muted);
    };
    if (btn && typeof BoardSound !== "undefined") {
      sync();
      btn.addEventListener("click", () => {
        BoardSound.setMuted(!BoardSound.muted);
        sync();
        if (!BoardSound.muted) BoardSound.play("move");
      });
    } else if (btn) {
      btn.classList.add("hidden");
    }
  } catch (_) { /* */ }

  /* ---- "go to tab" CTA buttons inside empty states (event delegation) ---- */
  document.addEventListener("click", (e) => {
    const b = e.target && e.target.closest ? e.target.closest("[data-goto-tab]") : null;
    if (!b) return;
    e.preventDefault();
    try {
      switchTab(b.dataset.gotoTab);
      const tb = document.querySelector('.tab-btn[data-tab="' + b.dataset.gotoTab + '"]');
      if (tb && tb.scrollIntoView) tb.scrollIntoView({ block: "nearest", inline: "center" });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (_) { /* */ }
  });

  /* keep the active tab visible in the horizontally-scrolling tab bar */
  document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => {
    try { b.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) { /* */ }
  }));

  /* ---- Puzzles: intro card until the first puzzle is requested ---- */
  try {
    const empty = $("puzzle-empty");
    const hide = () => empty && empty.classList.add("hidden");
    // any path that loads a puzzle (Plan items, deep links…) rewrites the info line
    const info = $("puzzle-info");
    if (info && typeof MutationObserver !== "undefined") {
      const initial = info.textContent;
      new MutationObserver(() => { if (info.textContent !== initial) hide(); })
        .observe(info, { childList: true, characterData: true, subtree: true });
    }
    const start = $("btn-puzzle-empty-start");
    if (start) start.addEventListener("click", () => { hide(); $("btn-new-puzzle").click(); });
    $("btn-new-puzzle").addEventListener("click", hide);
  } catch (_) { /* */ }

  /* ---- Home / End jump to the first / last move on the active board ---- */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Home" && e.key !== "End") return;
    const t = e.target;
    if (t && ((t.closest && t.closest("input, textarea, select")) || t.isContentEditable)) return;
    if (typeof Review !== "undefined" && Review.active) return;
    for (const ctl of NavRegistry) {
      if (ctl.isActive && ctl.isActive()) {
        const dir = e.key === "Home" ? "start" : "end";
        if (ctl.btns[dir] && !ctl.btns[dir].disabled) { e.preventDefault(); ctl.onNav(dir); }
        return;
      }
    }
  });

  /* ---- My Games: show the import guide on first paint if the list is empty ---- */
  try {
    const host = $("games-list");
    if (host && !host.children.length && typeof Games !== "undefined" && !Games.list.length) renderGamesList();
  } catch (_) { /* */ }
})();


/* ------------------------------------------------------------------ */
/* v39: "my training data" — bundled cards + analysed games            */
/* ------------------------------------------------------------------ */
async function loadLibrary() {
  try {
    const r = await apiGet("/api/games");
    Games.list = r.games || [];
    renderGamesList();
  } catch (_) { /* library stays empty */ }
}
function setMineText(el, st, prefix) {
  if (el.dataset.short && st && st.version) {
    el.textContent = prefix + "My data: " + st.games + " games · " + st.cards + " cards · " + st.missed_positions + " missed";
    el.title = mineSummary(st);
  } else el.textContent = prefix + mineSummary(st);
}
function mineSummary(st) {
  if (!st || !st.version) return "Your training data is not loaded.";
  return "Your data: " + st.games + " analysed games, " + st.cards + " mistake cards, " +
    st.missed_positions + " missed positions" + (st.names ? " (as " + st.names + ")" : "") + ".";
}
async function refreshMineBar() {
  try {
    const st = await apiGet("/api/mine/status");
    document.querySelectorAll(".mine-status").forEach((el) => { setMineText(el, st, ""); });
  } catch (_) {}
}
async function reloadMine(btn) {
  if (!confirm("Reload your bundled training data? This resets the progress on your own mistake cards and the \u201cMy mistakes\u201d cycle. Other progress is kept.")) return;
  document.querySelectorAll(".btn-mine-reload").forEach((b) => { b.disabled = true; });
  document.querySelectorAll(".mine-status").forEach((el) => { el.textContent = "Reloading\u2026"; });
  try {
    const st = await apiPost("/api/mine/reload", {});
    document.querySelectorAll(".mine-status").forEach((el) => { setMineText(el, st, "Reloaded. "); });
    await loadLibrary();
  } catch (e) {
    document.querySelectorAll(".mine-status").forEach((el) => { el.textContent = "Reload failed: " + e.message; });
  } finally {
    document.querySelectorAll(".btn-mine-reload").forEach((b) => { b.disabled = false; });
  }
}
document.querySelectorAll(".btn-mine-reload").forEach((b) => b.addEventListener("click", () => reloadMine(b)));
window.addEventListener("cc-mine-imported", (ev) => {
  const st = ev.detail || {};
  const n = document.createElement("div");
  n.className = "mine-toast";
  n.setAttribute("role", "status");
  n.textContent = "Loaded your training data: " + st.games + " analysed games and " + st.cards + " mistake cards. Find them in My Games, Puzzles and Cycles.";
  document.body.appendChild(n);
  setTimeout(() => n.classList.add("out"), 6000);
  setTimeout(() => n.remove(), 6800);
});
refreshMineBar();
loadLibrary();


/* ------------------------------------------------------------------ */
/* v40: one shared "I play Black/White" + "My level" setting           */
/* ------------------------------------------------------------------ */
const MY_SIDE_KEY = "my_side";
const LEVEL_ELO = { casual: 1200, club: 1500, advanced: 2000, expert: 2200, masters: 2500 };
function mySide() {
  try { const v = localStorage.getItem(MY_SIDE_KEY); if (v === "white" || v === "black") return v; } catch (_) {}
  return "black";
}
function renderMe() {
  const side = mySide(), lvl = getOpponentLevel();
  const short = { casual: "Casual", club: "Club", advanced: "Advanced", expert: "Expert", masters: "Masters" }[lvl] || "Club";
  $("me-label").textContent = (side === "black" ? "Black" : "White") + " · " + short;
  document.querySelectorAll("#me-pop .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.side === side));
  const g = $("gtm-elo");
  if (g) {
    const elo = String(LEVEL_ELO[lvl] || 1500);
    if (![...g.options].some(o => o.value === elo)) { const o = document.createElement("option"); o.value = elo; o.textContent = "~" + elo; g.appendChild(o); }
    g.value = elo;
  }
}
function setMySide(side) {
  try { localStorage.setItem(MY_SIDE_KEY, side); } catch (_) {}
  renderMe();
  // a fresh board follows the setting straight away
  if (!Rehearsal.active && Play.moves.length === 0) playBoard.setOrientation(side);
  if (typeof labBoard !== "undefined" && Lab && !Lab.plan) labBoard.setOrientation(side);
  if (GTM && GTM.games && GTM.games.length) renderGtmLibrary();
}
$("btn-me").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("me-pop"), open = pop.classList.toggle("hidden") === false;
  $("btn-me").setAttribute("aria-expanded", open ? "true" : "false");
});
document.addEventListener("click", (e) => {
  const pop = $("me-pop");
  if (!pop.classList.contains("hidden") && !pop.contains(e.target) && e.target !== $("btn-me")) {
    pop.classList.add("hidden"); $("btn-me").setAttribute("aria-expanded", "false");
  }
});
document.querySelectorAll("#me-pop .seg-btn").forEach(b => b.addEventListener("click", () => setMySide(b.dataset.side)));
$("me-level").addEventListener("change", () => { onOppLevelChange($("me-level").value); renderMe(); });
document.querySelectorAll("select.opp-level").forEach(el => el.addEventListener("change", renderMe));
$("gtm-elo").addEventListener("change", () => {
  const n = parseInt($("gtm-elo").value, 10);
  const lvl = n < 1400 ? "casual" : n < 1950 ? "club" : n < 2150 ? "advanced" : n < 2400 ? "expert" : "masters";
  onOppLevelChange(lvl); renderMe();
});
syncOppLevelSelects();
renderMe();
if (!Rehearsal.active && Play.moves.length === 0 && Play.startFen === PLAY_START_FEN) playBoard.setOrientation(mySide());
if (typeof labBoard !== "undefined") labBoard.setOrientation(mySide());
// v40: the Plan / Progress streak chips refresh whenever a real answer is logged
let __ccStreakT = null;
window.addEventListener("cc-activity", () => {
  clearTimeout(__ccStreakT);
  __ccStreakT = setTimeout(() => { if (typeof loadStreak === "function") loadStreak().then(() => renderStreak()); }, 250);
});


/* ------------------------------------------------------------------ */
/* v41: opening-line memory on Progress; Plan items open the drill     */
/* ------------------------------------------------------------------ */
async function renderProgressOpenings() {
  const host = $("progress-openings");
  if (!host) return;
  let r;
  try { r = await apiGet("/api/repertoire-progress"); } catch (_) { return; }
  if (!r.lines || !r.lines.length) return;
  const now = Date.now();
  const row = (l) => {
    const days = repDaysUntil(l.due);
    const cls = l.last_right === l.last_total ? "ok" : "miss";
    const slugLbl = l.slug === "grunfeld" ? "Grünfeld" : l.slug === "scotch" ? "Scotch" : l.slug === "alapin" ? "Alapin" : "Modern";
    return '<div class="po-row"><span class="po-name">' + escapeHtml(l.name || l.id) + ' <span class="muted">' + escapeHtml(slugLbl) + "</span></span>"
      + '<span class="rep-mem ' + cls + '">' + l.last_right + "/" + l.last_total + "</span>"
      + '<span class="muted">' + (days <= 0 ? "due now" : days === 1 ? "tomorrow" : "in " + days + " d") + "</span></div>";
  };
  host.innerHTML = '<div class="info-line">' + r.known + " of " + r.total_lines + " lines known first try · " + r.due_count + " due · "
    + r.tried + " drilled</div>" + r.lines.slice().sort((a, b) => Date.parse(a.due) - Date.parse(b.due)).map(row).join("");
}
document.addEventListener("click", (e) => {
  // Plan "Openings" item: open the trainer straight into the due drill
  const b = e.target.closest && e.target.closest("[data-opening-drill]");
  if (!b) return;
  const slug = b.getAttribute("data-opening-drill");
  switchTab(slug);
  setTimeout(() => { const T = slug === "grunfeld" ? GrunfeldTab : slug === "scotch" ? ScotchTab : slug === "alapin" ? AlapinTab : ModernTab; T.init().then(() => T.drillDue()); }, 50);
});


/* ------------------------------------------------------------------ */
/* v43: "Train these blunders" hand-off from the Olympiad explorer     */
/* ------------------------------------------------------------------ */
(async function olympiadHandoff() {
  let u;
  try { u = new URLSearchParams(location.search); } catch (_) { return; }
  if (u.get("train") !== "olympiad") return;
  let pack = null;
  try { pack = JSON.parse(localStorage.getItem("cc-olympiad-train") || "null"); } catch (_) { pack = null; }
  try { localStorage.removeItem("cc-olympiad-train"); } catch (_) { /* */ }
  try { history.replaceState(null, "", location.pathname + location.hash); } catch (_) { /* */ }
  if (!pack || !Array.isArray(pack.items) || !pack.items.length) return;
  try {
    const r = await apiPost("/api/olympiad/train", { items: pack.items, label: pack.label || "" });
    switchTab("puzzles");
    const n = document.createElement("div");
    n.className = "mine-toast oly-toast"; n.setAttribute("role", "status");
    if (document.querySelector(".mine-toast")) n.style.bottom = (window.innerWidth <= 700 ? 140 : 86) + "px";
    n.textContent = "Added " + r.puzzles_added + " Olympiad blunder positions to Puzzles and " + r.cards_added +
      " flashcards (Cycles: \u201cOlympiad blunders\u201d, " + r.set_size + " positions). Find the better move.";
    document.body.appendChild(n);
    setTimeout(() => n.classList.add("out"), 7000);
    setTimeout(() => n.remove(), 7800);
    const empty = $("puzzle-empty");
    if (empty) empty.classList.add("hidden");
    const nb = $("btn-new-puzzle");
    if (nb) nb.click();
  } catch (e) {
    console.warn("olympiad hand-off failed", e);
  }
})();

/* ------------------------------------------------------------------ */
/* v46: deep links — ?tab=alapin, ?tab=puzzles&set=knight-h5,         */
/* ?tab=deck&card=<id>. The query is dropped after it is used.         */
/* ------------------------------------------------------------------ */
(function deepLink() {
  let u;
  try { u = new URLSearchParams(location.search); } catch (_) { return; }
  const tab = u.get("tab"), set = u.get("set"), card = u.get("card");
  if (!tab && !set && !card) return;
  try { history.replaceState(null, "", location.pathname + location.hash); } catch (_) { /* */ }
  const target = card ? "deck" : set ? "puzzles" : tab;
  if (!document.getElementById("tab-" + target)) return;
  const run = () => {
    if (set && $("puzzle-set") && [...$("puzzle-set").options].some(o => o.value === set)) {
      $("puzzle-set").value = set;
      $("puzzle-set").dispatchEvent(new Event("change"));
    }
    switchTab(target);
    if (card && window.CCDeck && window.CCDeck.show) window.CCDeck.show(card);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else setTimeout(run, 0);
})();
