/* =======================================================================
   MISTAKE DECK (v45)

   One card per meaningful mistake from all of your games (Lichess,
   Chess.com, Noctie), built offline with Stockfish and bundled as
   data/mine/deck.json. Spaced repetition: find the better move on the
   board, the answer is checked (engine best or a near-equal move), the
   explanation is revealed, then you grade Again / Hard / Good / Easy.
   Progress lives in localStorage (cc-deck-srs-v1). New games can be
   fetched from the public Lichess / Chess.com APIs (or pasted as PGN)
   and analysed in the browser with WASM Stockfish; those cards are kept
   in cc-deck-local-v1 and merged by id with the bundled deck.
   ======================================================================= */
const DECK_KEYS = { srs: "cc-deck-srs-v1", local: "cc-deck-local-v1", prefs: "cc-deck-prefs-v1", sync: "cc-deck-sync-v1" };
const Deck = { all: [], byId: {}, meta: null, srs: {}, queue: [], cur: null, state: "idle", tries: 0, hinted: 0,
  prefs: { costly: false, theme: "", opening: "", colour: "", phase: "", source: "", sort: "due" }, loaded: false, anim: null, busy: false };
const deckBoard = new Board($("deck-board"), { onMove: onDeckMove });
const DECK_ME = ["jetblack007"];

function deckLS(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }
function deckSave(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* quota */ } }
function deckWp(cp) { cp = Math.max(-1500, Math.min(1500, cp)); return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1); }
function deckFmt(cp) {
  if (Math.abs(cp) >= 9000) { const n = Math.round((10000 - Math.abs(cp)) / 10); return (cp > 0 ? "#" : "#-") + n; }
  return (cp > 0 ? "+" : cp < 0 ? "−" : "") + (Math.abs(cp) / 100).toFixed(1);
}
function deckEsc(s) { return typeof escapeHtml === "function" ? escapeHtml(s) : String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
const DECK_SITE = { lichess: "Lichess", chesscom: "Chess.com", noctie: "Noctie", legacy: "Earlier set", local: "Added here" };

/* ---------------- loading + merge by id ---------------- */
async function deckLoad() {
  let bundled = { cards: [], summary: null };
  try {
    const r = await fetch("data/mine/deck.json?v=48", { cache: "no-cache" });
    if (r.ok) bundled = await r.json();
  } catch (e) { console.info("[deck] bundled deck not loaded:", e && e.message); }
  const local = deckLS(DECK_KEYS.local, []);
  const byId = {};
  (bundled.cards || []).forEach(c => { byId[c.id] = c; });
  local.forEach(c => { if (c && c.id && !byId[c.id]) { c.local = true; byId[c.id] = c; } });
  // alias ids: an older card id (e.g. from v39–v44 cards.json) keeps its progress
  const srs = deckLS(DECK_KEYS.srs, {});
  Object.values(byId).forEach(c => (c.alias_ids || []).forEach(a => { if (srs[a] && !srs[c.id]) srs[c.id] = srs[a]; }));
  Deck.known = new Set(Object.values(byId).map(c => c.game_id).concat(local.map(c => c.game_id)));
  Deck.all = Object.values(byId).filter(c => !c.marker);
  Deck.byId = byId;
  Deck.meta = bundled;
  Deck.srs = srs;
  Deck.prefs = Object.assign(Deck.prefs, deckLS(DECK_KEYS.prefs, {}));
  Deck.loaded = true;
  deckFillFilters();
  deckRenderSummary();
  deckRenderTop();
}
function deckFillFilters() {
  const fill = (id, key, label) => {
    const sel = $(id), counts = {};
    Deck.all.forEach(c => { const v = c[key]; if (v) counts[v] = (counts[v] || 0) + 1; });
    const first = sel.options[0].outerHTML;
    sel.innerHTML = first + Object.keys(counts).sort((a, b) => counts[b] - counts[a])
      .map(v => '<option value="' + deckEsc(v) + '">' + deckEsc(label ? label(v) : v) + " (" + counts[v] + ")</option>").join("");
  };
  fill("deck-f-theme", "theme");
  fill("deck-f-opening", "opening");
  const p = Deck.prefs;
  $("deck-f-theme").value = p.theme || ""; $("deck-f-opening").value = p.opening || "";
  $("deck-f-colour").value = p.colour || ""; $("deck-f-phase").value = p.phase || "";
  $("deck-f-source").value = p.source || ""; $("deck-sort").value = p.sort || "due";
  if ($("deck-f-theme").value !== (p.theme || "")) p.theme = "";
  if ($("deck-f-opening").value !== (p.opening || "")) p.opening = "";
  $("deck-f-costly").classList.toggle("active", !!p.costly);
  $("deck-f-costly").setAttribute("aria-pressed", p.costly ? "true" : "false");
}
function deckSiteOf(c) { return c.local && !c.source ? "local" : c.source; }
function deckFiltered() {
  const p = Deck.prefs;
  return Deck.all.filter(c => (!p.costly || c.most_costly) && (!p.theme || c.theme === p.theme) && (!p.opening || c.opening === p.opening)
    && (!p.colour || c.side === p.colour) && (!p.phase || c.phase === p.phase)
    && (!p.source || (p.source === "local" ? c.local : c.source === p.source)));
}
function deckDue(c) { const s = Deck.srs[c.id]; return !s || !s.due || Date.parse(s.due) <= Date.now(); }
function deckBuildQueue() {
  const list = deckFiltered(), sort = Deck.prefs.sort;
  if (sort === "cost") list.sort((a, b) => b.cost - a.cost);
  else if (sort === "date") list.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.cost - a.cost);
  else if (sort === "random") { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } }
  else {
    list.sort((a, b) => {
      const da = deckDue(a), db = deckDue(b);
      if (da !== db) return da ? -1 : 1;
      if (!da) return Date.parse(Deck.srs[a.id].due) - Date.parse(Deck.srs[b.id].due);
      const na = !Deck.srs[a.id], nb = !Deck.srs[b.id];   // reviews due before brand-new cards? no: costly first
      return b.cost - a.cost || (na === nb ? 0 : na ? 1 : -1);
    });
  }
  Deck.queue = list;
  return list;
}

/* ---------------- summary header ---------------- */
function deckCounts(list, key) {
  const m = {}; list.forEach(c => { const v = (typeof key === "function" ? key(c) : c[key]) || "—"; m[v] = (m[v] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
function deckRenderSummary() {
  const all = Deck.all, shown = deckFiltered();
  const due = shown.filter(deckDue).length, newN = shown.filter(c => !Deck.srs[c.id]).length;
  const learned = all.filter(c => { const s = Deck.srs[c.id]; return s && s.interval >= 7; }).length;
  const games = Deck.meta && Deck.meta.summary ? Deck.meta.summary.games : null;
  $("deck-sum").innerHTML = "<b>" + all.length + "</b> cards" + (games ? " from " + games.total + " games" : "")
    + " · <b>" + all.filter(c => c.most_costly).length + "</b> most costly · showing <b>" + shown.length + "</b> · <b>" + due + "</b> due"
    + " (" + newN + " new) · " + learned + " learned";
  const block = (title, rows) => '<div class="deck-bd"><h4>' + title + "</h4>" + rows.slice(0, 8).map(([k, n]) =>
    '<div class="deck-bd-row"><span>' + deckEsc(k) + "</span><b>" + n + "</b></div>").join("") + "</div>";
  const sum = Deck.meta && Deck.meta.summary;
  $("deck-breakdown-body").innerHTML =
    block("Theme", deckCounts(all, "theme")) + block("Phase", deckCounts(all, "phase")) + block("Opening", deckCounts(all, "opening"))
    + block("Colour", deckCounts(all, c => c.side === "white" ? "White" : "Black")) + block("Site", deckCounts(all, c => DECK_SITE[deckSiteOf(c)] || c.source))
    + block("Kind", deckCounts(all, c => ({ allowed: "Allowed a tactic", missed: "Missed a tactic", positional: "Positional / technique" }[c.kind] || c.kind)))
    + (sum ? '<div class="deck-bd deck-bd-note"><h4>Built</h4><div class="info-line">' + deckEsc(sum.note || "") + "</div></div>" : "");
}
function deckRenderTop() {
  if (typeof deckRenderLessons === "function") deckRenderLessons();
  const top = Deck.all.filter(c => c.most_costly).sort((a, b) => a.rank - b.rank);
  $("deck-top-list").innerHTML = top.map(c => {
    const s = Deck.srs[c.id];
    return '<li><button type="button" class="deck-top-item' + (Deck.cur && Deck.cur.id === c.id ? " current" : "") + '" data-id="' + deckEsc(c.id) + '">'
      + '<span class="dt-swing">' + deckEsc(c.swing) + "</span>"
      + '<span class="dt-move">' + c.move_no + (c.side === "white" ? ". " : "… ") + deckEsc(c.played_san) + "</span>"
      + '<span class="dt-theme">' + deckEsc(c.theme) + "</span>"
      + '<span class="dt-game">' + deckEsc(c.opening) + " · " + deckEsc(c.date || "") + "</span>"
      + (s ? '<span class="dt-done" title="Reviewed">' + (s.last === "again" ? "↺" : "✓") + "</span>" : "") + "</button></li>";
  }).join("");
}

/* ---------------- SRS (SM-2 style) ---------------- */
function deckSched(id, grade, dry) {
  const s = Object.assign({ ease: 2.5, interval: 0, reps: 0, lapses: 0 }, Deck.srs[id] || {});
  let mins;
  if (grade === "again") { s.reps = 0; s.lapses++; s.ease = Math.max(1.3, s.ease - 0.2); s.interval = 0; mins = 10; }
  else if (grade === "hard") { s.ease = Math.max(1.3, s.ease - 0.15); s.interval = s.interval ? Math.max(1, Math.round(s.interval * 1.2)) : 1; s.reps++; }
  else if (grade === "good") { s.interval = s.reps === 0 ? 1 : s.reps === 1 ? 3 : Math.round(s.interval * s.ease); s.reps++; }
  else { s.ease += 0.15; s.interval = s.reps === 0 ? 4 : Math.round(Math.max(s.interval, 1) * s.ease * 1.3); s.reps++; }
  if (dry) return mins ? "10m" : s.interval + "d";
  s.due = new Date(Date.now() + (mins ? mins * 60000 : s.interval * 86400000)).toISOString();
  s.last = grade; s.at = new Date().toISOString();
  s.hist = (s.hist || []).concat([[s.at.slice(0, 10), grade[0]]]).slice(-12);
  Deck.srs[id] = s;
  deckSave(DECK_KEYS.srs, Deck.srs);
  return s;
}

/* ---------------- one card ---------------- */
function deckSetFeedback(html, kind) {
  const el = $("deck-feedback");
  el.innerHTML = html; el.className = "deck-feedback" + (kind ? " " + kind : "");
  el.classList.toggle("hidden", !html);
}
function deckShow(c) {
  deckStopAnim();
  Deck.cur = c; Deck.state = "ask"; Deck.tries = 0; Deck.hinted = 0;
  if (!c) {
    $("deck-label").textContent = "No cards match these filters.";
    $("deck-rank").textContent = ""; $("deck-meta").textContent = "";
    $("deck-prompt").textContent = Deck.all.length ? "Nothing here — loosen a filter or press Reset." : "The deck is empty.";
    deckSetFeedback(""); $("deck-grades").classList.add("hidden"); $("deck-explain").classList.add("hidden");
    return;
  }
  deckBoard.setFen(c.fen);
  deckBoard.setOrientation(c.side);
  deckBoard.setLastMove(null, null);
  deckBoard.clearArrows();
  deckBoard.setInteractive(true);
  const s = Deck.srs[c.id];
  $("deck-label").textContent = (c.game_label || DECK_SITE[c.source] || "Game") + " — move " + c.move_no + ", you are " + (c.side === "white" ? "White" : "Black");
  $("deck-rank").innerHTML = (c.most_costly ? '<span class="deck-star" title="One of the 20 most costly">★ #' + c.rank + "</span>" : (c.rank ? "#" + c.rank : "new"))
    + ' <span class="chip deck-theme-chip">' + deckEsc(c.theme) + "</span>";
  $("deck-meta").textContent = [c.opening, c.phase, DECK_SITE[c.source] || c.source, c.date].filter(Boolean).join(" · ")
    + (s ? " · seen " + (s.reps + s.lapses) + "×" : "");
  $("deck-prompt").innerHTML = "In the game you played <b>" + deckEsc(c.played_san) + "</b> here and it cost <b>"
    + Math.round(c.wp_loss) + "%</b> win chance. <span class=\"deck-ask\">Find the better move.</span>";
  deckSetFeedback("");
  $("deck-grades").classList.add("hidden");
  $("deck-explain").classList.add("hidden");
  $("btn-deck-hint").disabled = false; $("btn-deck-reveal").disabled = false;
  deckRenderTop();
  deckRenderSummary();
}
function deckNext() {
  const q = deckBuildQueue();
  if (!q.length) return deckShow(null);
  // don't repeat the card we just did when there is another one
  const nxt = q.find(c => !Deck.cur || c.id !== Deck.cur.id) || q[0];
  deckShow(nxt);
}
function deckSan(fen, uci) {
  try { const ch = new Chess(fen); const m = ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); return m ? m.san : uci; } catch (_) { return uci; }
}
async function deckEngineAccept(c, uci) {
  /* a move that is not in the stored list: ask WASM Stockfish how much it gives up */
  if (!window.CCEngine) return null;
  try {
    const ch = new Chess(c.fen); ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
    if (ch.isCheckmate()) return { ok: true, cp: 10000 };
    const r = await Promise.race([CCEngine.analyse(ch.fen(), { depth: 14, priority: "high" }), new Promise(res => setTimeout(() => res(null), 9000))]);
    if (!r || !r.lines || !r.lines[0]) return null;
    const sc = r.lines[0].score, cp = -(sc.type === "mate" ? (sc.value > 0 ? 10000 - sc.value * 10 : -10000 - sc.value * 10) : sc.value);
    const lossVsBest = deckWp(c.eval_before) - deckWp(cp), gainVsPlayed = deckWp(cp) - deckWp(c.eval_after);
    return { ok: lossVsBest <= Math.min(6, Math.max(3, 0.12 * c.wp_loss)) && gainVsPlayed >= 7, cp };
  } catch (_) { return null; }
}
async function onDeckMove(from, to) {
  const c = Deck.cur;
  if (!c || Deck.state !== "ask" || Deck.busy) { if (c) deckBoard.setFen(c.fen); return; }
  const uci = uciCandidate(deckBoard, from, to);
  let san = null, after = null;
  try { const ch = new Chess(c.fen); const m = ch.move({ from, to, promotion: uci[4] || "q" }); if (m) { san = m.san; after = ch.fen(); } } catch (_) { san = null; }
  if (!san) { deckBoard.setFen(c.fen); deckBoard.shake && deckBoard.shake(); return; }
  deckBoard.setFen(after); deckBoard.setLastMove(from, to);
  const acc = c.accept || [c.best_uci];
  let verdict = null;
  if (uci === c.best_uci || uci.slice(0, 4) === c.best_uci.slice(0, 4)) verdict = "best";
  else if (acc.indexOf(uci) !== -1) verdict = "near";
  else if (uci === c.played_uci) verdict = "same";
  else {
    Deck.busy = true;
    deckSetFeedback("Checking " + deckEsc(san) + " with Stockfish…", "info");
    const r = await deckEngineAccept(c, uci);
    Deck.busy = false;
    if (Deck.cur !== c) return;
    verdict = r && r.ok ? "near" : "wrong";
  }
  Deck.tries++;
  if (verdict === "best" || verdict === "near") {
    Deck.state = "solved";
    deckSetFeedback((verdict === "best" ? "✓ <b>" + deckEsc(san) + "</b> — that is the engine's move." : "✓ <b>" + deckEsc(san) + "</b> is good enough — near-equal to the engine's <b>" + deckEsc(c.best_san) + "</b>.")
      + (Deck.tries > 1 ? " (try " + Deck.tries + ")" : ""), "good");
    deckReveal(true);
  } else {
    deckSetFeedback(verdict === "same" ? "✗ <b>" + deckEsc(san) + "</b> is the move you played in the game. Look again." : "✗ <b>" + deckEsc(san) + "</b> is not it. Try again, take a hint, or show the answer.", "bad");
    setTimeout(() => { if (Deck.cur === c && Deck.state === "ask") { deckBoard.setFen(c.fen); deckBoard.setLastMove(null, null); } }, 700);
    if (Deck.tries >= 3) deckReveal(false);
  }
}
function deckReveal(solved) {
  const c = Deck.cur; if (!c) return;
  if (!solved) { Deck.state = "revealed"; if (!$("deck-feedback").classList.contains("bad")) deckSetFeedback("The answer was <b>" + deckEsc(c.best_san) + "</b>.", "bad"); }
  deckBoard.setFen(c.fen); deckBoard.setLastMove(null, null);
  deckBoard.setArrows([{ from: c.best_uci.slice(0, 2), to: c.best_uci.slice(2, 4), color: "green" }, { from: c.played_uci.slice(0, 2), to: c.played_uci.slice(2, 4), color: "red" }]);
  const ex = $("deck-explain");
  const other = (c.accept_san || []).filter(s => s !== c.best_san);
  ex.innerHTML = '<div class="deck-ex-head"><span class="deck-swing">' + deckEsc(c.swing) + "</span> "
    + "<span>you played <b class=\"bad-t\">" + deckEsc(c.played_san) + "</b>, best was <b class=\"good-t\">" + deckEsc(c.best_san) + "</b>"
    + (other.length ? " (also fine: " + other.map(deckEsc).join(", ") + ")" : "") + "</span>"
    + ' <span class="muted">' + Math.round(c.wp_before) + "% → " + Math.round(c.wp_after) + "% win chance" + (c.result_changed ? " · <b>changed the result</b>" : "") + "</span></div>"
    + '<div class="deck-ex-title">' + deckEsc(c.title) + "</div>"
    + (c.rule ? '<div class="coach-box deck-rule"><b>The rule:</b> ' + deckEsc(c.rule) + "</div>" : "")
    + '<div class="coach-box">' + deckEsc(c.explanation) + "</div>"
    + (c.engine_note ? '<div class="info-line muted">' + deckEsc(c.engine_note) + "</div>" : "")
    + '<div class="panel-row deck-lines">'
    + (c.best_pv && c.best_pv.length ? '<button class="btn mini" type="button" id="btn-deck-play-best">▶ Best line</button>' : "")
    + (c.refute_pv && c.refute_pv.length ? '<button class="btn mini" type="button" id="btn-deck-play-ref">▶ What ' + deckEsc(c.played_san) + " allowed</button>" : "")
    + (c.url ? '<a class="btn mini" target="_blank" rel="noopener" href="' + deckEsc(c.url) + '">Open game ↗</a>' : '<span class="info-line muted">' + deckEsc(c.game_label || "") + "</span>")
    + "</div>"
    + (c.best_line ? '<div class="info-line"><b>Best:</b> ' + deckEsc(c.best_line) + "</div>" : "")
    + (c.refute_line ? '<div class="info-line"><b>After ' + deckEsc(c.played_san) + ":</b> " + deckEsc(c.refute_line) + "</div>" : "")
    + (c.seen > 1 ? '<div class="info-line muted">Same mistake ' + c.seen + "× in your games.</div>" : "");
  ex.classList.remove("hidden");
  const pb = $("btn-deck-play-best"), pr = $("btn-deck-play-ref");
  if (pb) pb.addEventListener("click", () => deckAnimate(c.fen, c.best_pv));
  if (pr) pr.addEventListener("click", () => deckAnimate(c.fen, [c.played_uci].concat(c.refute_pv)));
  ["again", "hard", "good", "easy"].forEach(g => { $("deck-iv-" + g).textContent = " " + deckSched(c.id, g, true); });
  $("deck-grades").classList.remove("hidden");
  const sug = !solved ? "again" : Deck.tries > 1 || Deck.hinted ? "hard" : "good";
  document.querySelectorAll(".deck-grade").forEach(b => b.classList.toggle("primary", b.dataset.grade === sug));
  $("btn-deck-hint").disabled = true; $("btn-deck-reveal").disabled = true;
  deckBoard.setInteractive(false);
  try { const sc = document.querySelector("#tab-deck .deck-card"); if (window.innerWidth <= 960 && sc && sc.scrollIntoView) sc.scrollIntoView({ block: "nearest" }); } catch (_) { /* */ }
}
function deckStopAnim() { if (Deck.anim) { clearInterval(Deck.anim); Deck.anim = null; } }
function deckAnimate(fen, pv) {
  deckStopAnim();
  let ch; try { ch = new Chess(fen); } catch (_) { return; }
  deckBoard.setFen(fen); deckBoard.clearArrows(); let i = 0;
  Deck.anim = setInterval(() => {
    if (i >= Math.min(pv.length, 10)) { deckStopAnim(); return; }
    const u = pv[i++]; let m = null;
    try { m = ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); } catch (_) { m = null; }
    if (!m) { deckStopAnim(); return; }
    deckBoard.setFen(ch.fen()); deckBoard.setLastMove(m.from, m.to);
  }, 750);
}
function deckGrade(g) {
  const c = Deck.cur; if (!c || Deck.state === "ask") return;
  deckSched(c.id, g);
  deckNext();
}
function deckHint() {
  const c = Deck.cur; if (!c || Deck.state !== "ask") return;
  Deck.hinted++;
  const sq = c.best_uci.slice(0, 2), p = deckBoard.pieceAt(sq);
  const names = { P: "pawn", N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king" };
  if (Deck.hinted === 1) deckSetFeedback("Hint: it's about <b>" + deckEsc(c.theme.toLowerCase()) + "</b> — move your <b>" + (p ? names[p[1]] : "piece") + "</b>.", "info");
  else { deckSetFeedback("Hint: the piece on <b>" + sq + "</b>.", "info"); deckBoard.setMarked([sq]); }
}

/* ---------------- filters ---------------- */
function deckPrefsChanged() {
  deckSave(DECK_KEYS.prefs, Deck.prefs);
  $("deck-f-costly").classList.toggle("active", !!Deck.prefs.costly);
  $("deck-f-costly").setAttribute("aria-pressed", Deck.prefs.costly ? "true" : "false");
  deckRenderSummary();
  const q = deckBuildQueue();
  if (!Deck.cur || q.indexOf(Deck.cur) === -1 || Deck.state !== "ask") deckShow(q[0] || null);
}
[["deck-f-theme", "theme"], ["deck-f-opening", "opening"], ["deck-f-colour", "colour"], ["deck-f-phase", "phase"], ["deck-f-source", "source"], ["deck-sort", "sort"]]
  .forEach(([id, k]) => $(id).addEventListener("change", () => { Deck.prefs[k] = $(id).value; if (k === "sort") Deck.cur = null; deckPrefsChanged(); }));
$("deck-f-costly").addEventListener("click", () => { Deck.prefs.costly = !Deck.prefs.costly; if (Deck.prefs.costly) Deck.prefs.sort = "cost", $("deck-sort").value = "cost"; Deck.cur = null; deckPrefsChanged(); });
$("deck-f-reset").addEventListener("click", () => {
  Deck.prefs = { costly: false, theme: "", opening: "", colour: "", phase: "", source: "", sort: "due" };
  deckFillFilters(); Deck.cur = null; deckPrefsChanged();
});
$("btn-deck-hint").addEventListener("click", deckHint);
$("btn-deck-reveal").addEventListener("click", () => { if (Deck.state === "ask") deckReveal(false); });
$("btn-deck-skip").addEventListener("click", deckNext);
document.querySelectorAll(".deck-grade").forEach(b => b.addEventListener("click", () => deckGrade(b.dataset.grade)));
$("deck-top-list").addEventListener("click", (e) => {
  const b = e.target.closest(".deck-top-item"); if (!b) return;
  const c = Deck.byId[b.dataset.id]; if (c) deckShow(c);
});
document.addEventListener("keydown", (e) => {
  if (!$("tab-deck").classList.contains("active") || /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || "")) return;
  if (Deck.state !== "ask" && "1234".indexOf(e.key) !== -1 && e.key.length === 1) { deckGrade(["again", "hard", "good", "easy"][+e.key - 1]); e.preventDefault(); }
  else if (e.key === "h" || e.key === "H") deckHint();
  else if ((e.key === "r" || e.key === "R") && Deck.state === "ask") deckReveal(false);
  else if (e.key === "n" || e.key === "N") deckNext();
});

/* ---------------- refresh from new games (client side) ---------------- */
function deckSyncStatus(msg, kind) { const el = $("deck-sync-status"); el.textContent = msg || ""; el.className = "info-line" + (kind ? " " + kind : ""); }
function deckCp(line) { const s = line.score; return s.type === "mate" ? (s.value > 0 ? 10000 - s.value * 10 : -10000 - s.value * 10) : s.value; }
const DECK_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
function deckMat(ch, color) { let n = 0; ch.board().forEach(row => row.forEach(p => { if (p && p.color === color) n += DECK_VAL[p.type]; })); return n; }
function deckNet(fen, pv, n) {
  const ch = new Chess(fen), me = ch.turn(), op = me === "w" ? "b" : "w", d0 = deckMat(ch, me) - deckMat(ch, op);
  for (const u of pv.slice(0, n)) { try { if (!ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" })) break; } catch (_) { break; } }
  return deckMat(ch, me) - deckMat(ch, op) - d0;
}
function deckLine(fen, pv, n) {
  const ch = new Chess(fen), out = [];
  for (const u of pv.slice(0, n)) {
    let m = null; const mv = ch.moveNumber(), w = ch.turn() === "w";
    try { m = ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); } catch (_) { m = null; }
    if (!m) break; out.push(w ? mv + ". " + m.san : (out.length ? m.san : mv + "... " + m.san));
  }
  return out.join(" ");
}
function deckTheme(fen, playedUci, bestLine, refLine, refCp) {
  /* light browser version of the offline classifier */
  const after = new Chess(fen); after.move({ from: playedUci.slice(0, 2), to: playedUci.slice(2, 4), promotion: playedUci[4] || "q" });
  if (bestLine.score.type === "mate" && bestLine.score.value > 0) return ["missed", "Missed mate"];
  if (refLine && refLine.score.type === "mate" && refLine.score.value > 0) return ["allowed", "Mating attack"];
  const np = refLine ? -deckNet(after.fen(), refLine.pv, 7) + deckNet(fen, [playedUci], 1) : 0, nb = deckNet(fen, bestLine.pv, 7);
  if (refLine && np - nb <= -2) {
    const u = refLine.pv[0], m = new Chess(after.fen()).move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" });
    if (m && m.captured) return ["allowed", "Loose piece"];
    if (m && (m.piece === "n" || m.piece === "q") && m.san.indexOf("+") !== -1) return ["allowed", "Fork"];
    return ["allowed", "Tactic"];
  }
  if (nb >= 2) return ["missed", "Tactic"];
  const n = new Chess(fen).board().flat().filter(p => p && p.type !== "p" && p.type !== "k").length;
  return ["positional", n <= 6 ? "Endgame technique" : (new Chess(fen).moveNumber() <= 12 ? "Opening" : "Positional")];
}
async function deckAnalyseGame(g, onStep) {
  /* g: { site, id, url, date, side, opp, opening, sans:[...], startFen } -> new cards */
  const ch = new Chess(g.startFen || undefined), pos = [];
  for (const s of g.sans) { const fen = ch.fen(); let m; try { m = ch.move(s); } catch (_) { m = null; } if (!m) break; pos.push({ fen, uci: m.from + m.to + (m.promotion || ""), san: m.san, mine: (m.color === "w") === (g.side === "white"), move_no: parseInt(fen.split(" ")[5], 10) }); }
  const evals = [];
  const fens = pos.map(p => p.fen).concat([ch.fen()]);
  for (let i = 0; i < fens.length; i++) {
    const t = new Chess(fens[i]);
    if (t.isGameOver()) { evals.push(t.isCheckmate() ? -10000 : 0); continue; }
    const r = await CCEngine.analyse(fens[i], { depth: 11, priority: "low" });
    evals.push(r && r.lines && r.lines[0] ? deckCp(r.lines[0]) : 0);
    if (onStep) onStep(i + 1, fens.length);
  }
  const out = [];
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i]; if (!p.mine) continue;
    const before = evals[i], afterCp = -evals[i + 1];
    if (deckWp(before) - deckWp(afterCp) < 12) continue;
    const r = await CCEngine.analyse(p.fen, { depth: 15, multipv: 3, priority: "low" });
    if (!r || !r.lines || !r.lines.length || r.lines[0].pv[0] === p.uci) continue;
    const t = new Chess(p.fen); t.move({ from: p.uci.slice(0, 2), to: p.uci.slice(2, 4), promotion: p.uci[4] || "q" });
    const ra = t.isGameOver() ? null : await CCEngine.analyse(t.fen(), { depth: 15, priority: "low" });
    const best = r.lines[0], bcp = deckCp(best), acp = ra && ra.lines[0] ? -deckCp(ra.lines[0]) : afterCp;
    const loss = deckWp(bcp) - deckWp(acp);
    if (loss < 10) continue;
    const acc = r.lines.filter(l => deckWp(bcp) - deckWp(deckCp(l)) <= Math.min(6, Math.max(3, 0.12 * loss)) && deckWp(deckCp(l)) - deckWp(acp) >= 7).map(l => l.pv[0]);
    const [kind, theme] = deckTheme(p.fen, p.uci, best, ra && ra.lines[0], acp);
    const bestSan = deckSan(p.fen, best.pv[0]);
    const bl = deckLine(p.fen, best.pv, 8), rl = ra && ra.lines[0] ? deckLine(t.fen(), ra.lines[0].pv, 6) : "";
    const pieces = new Chess(p.fen).board().flat().filter(x => x && x.type !== "p" && x.type !== "k").length;
    out.push({ id: "md-" + g.site + "-" + g.id + "-" + i, fen: p.fen, side: g.side, played_uci: p.uci, played_san: p.san,
      best_uci: best.pv[0], best_san: bestSan, accept: acc, accept_san: acc.map(u => deckSan(p.fen, u)),
      best_line: bl, refute_line: rl, best_pv: best.pv.slice(0, 10), refute_pv: ra && ra.lines[0] ? ra.lines[0].pv.slice(0, 10) : [],
      eval_before: bcp, eval_after: acp, swing: deckFmt(bcp) + " → " + deckFmt(acp), wp_before: +deckWp(bcp).toFixed(1), wp_after: +deckWp(acp).toFixed(1),
      wp_loss: +loss.toFixed(1), cost: +loss.toFixed(1), theme, kind,
      title: (kind === "allowed" ? "Allowed: " : kind === "missed" ? "Missed: " : "") + theme + " — you played " + p.san,
      explanation: kind === "allowed" ? p.san + " allows " + (rl || "a tactic") + ". " + bestSan + " was safer. Blunder-check: their checks, captures and threats after your move."
        : kind === "missed" ? "You had " + bestSan + " (" + bl + "). Checks and captures first — every move." : p.san + " lets the position slide (" + deckFmt(bcp) + " → " + deckFmt(acp) + "). The engine's plan: " + bl + ".",
      phase: pieces <= 6 ? "endgame" : (p.move_no <= 12 && pieces > 10 ? "opening" : "middlegame"), move_no: p.move_no, ply: i,
      opening: g.opening || "Other", source: g.site, game_id: g.id, url: g.url ? g.url + (g.site === "lichess" ? "#" + i : "") : "",
      game_label: (DECK_SITE[g.site] || g.site) + (g.opp ? " vs " + g.opp : "") + ", " + (g.date || ""), date: g.date || "", opp: g.opp || "", seen: 1, local: true, added_at: new Date().toISOString() });
  }
  return out;
}
function deckOpeningName(side, sans, header) {
  const my = sans.filter((_, i) => (i % 2 === 1) === (side === "black"));
  if (side === "black" && my.slice(0, 2).indexOf("g6") !== -1) return "Modern Defense";
  if (side === "white" && sans.slice(0, 5).join(" ") === "e4 e5 Nf3 Nc6 d4") return "Scotch Game";
  return (header || "").split(/[:,]/)[0].trim() || "Other";
}
async function deckAddGames(games) {
  const known = Deck.known || new Set();
  const todo = games.filter(g => !known.has(g.id) && g.sans.length >= 8);
  if (!todo.length) { deckSyncStatus("No new games to analyse.", "good"); return 0; }
  await CCEngine.ready();
  const local = deckLS(DECK_KEYS.local, []), have = new Set(local.map(c => c.id).concat(Object.keys(Deck.byId)));
  let added = 0;
  for (let k = 0; k < todo.length; k++) {
    const g = todo[k];
    const cards = await deckAnalyseGame(g, (i, n) => deckSyncStatus("Game " + (k + 1) + "/" + todo.length + " (" + g.date + ", " + (g.opp || "") + "): position " + i + "/" + n + "…"));
    cards.forEach(c => { if (!have.has(c.id)) { local.push(c); have.add(c.id); added++; } });
    // remember analysed games even when clean, so the next check skips them
    local.push({ id: "game-" + g.site + "-" + g.id, marker: true, game_id: g.id });
    deckSave(DECK_KEYS.local, local);
  }
  await deckLoad();
  deckPrefsChanged();
  return added;
}
async function deckSync() {
  if (Deck.busy) return; Deck.busy = true; $("btn-deck-sync").disabled = true;
  const max = parseInt($("deck-sync-max").value, 10) || 5, sync = deckLS(DECK_KEYS.sync, {}), games = [];
  try {
    deckSyncStatus("Fetching Lichess…");
    const since = sync.lichess || Date.parse((Deck.meta && Deck.meta.summary && Deck.meta.summary.newest) || "2026-10-22") + 86400000;
    try {
      const r = await fetch("https://lichess.org/api/games/user/Jetblack007?max=" + max + "&since=" + since + "&opening=true&pgnInJson=false", { headers: { Accept: "application/x-ndjson" } });
      if (r.ok) {
        const txt = await r.text();
        txt.split("\n").filter(Boolean).forEach(l => {
          const j = JSON.parse(l); if (j.variant !== "standard" && j.variant !== "fromPosition") return;
          const side = ((j.players.white.user || {}).name || "").toLowerCase() === "jetblack007" ? "white" : "black";
          const opp = side === "white" ? j.players.black : j.players.white, sans = (j.moves || "").split(" ").filter(Boolean);
          games.push({ site: "lichess", id: j.id, url: "https://lichess.org/" + j.id, date: new Date(j.createdAt).toISOString().slice(0, 10), side,
            opp: (opp.user && opp.user.name) || (opp.aiLevel ? "lichess AI " + opp.aiLevel : "?"), sans, startFen: j.initialFen,
            opening: deckOpeningName(side, sans, j.opening && j.opening.name), ts: j.createdAt });
        });
      }
    } catch (e) { console.info("[deck] lichess fetch failed", e && e.message); }
    deckSyncStatus("Fetching Chess.com…");
    try {
      const a = await (await fetch("https://api.chess.com/pub/player/jetblack007/games/archives")).json();
      const urls = (a.archives || []).slice(-2);
      for (const u of urls) {
        const j = await (await fetch(u)).json();
        (j.games || []).forEach(x => {
          if (x.rules !== "chess" || !x.pgn || (sync.chesscom && x.end_time * 1000 <= sync.chesscom)) return;
          const p = parsePgn(x.pgn), side = x.white.username.toLowerCase() === "jetblack007" ? "white" : "black";
          games.push({ site: "chesscom", id: x.url.split("/").pop(), url: x.url, date: (p.headers.Date || "").replace(/\./g, "-"), side,
            opp: side === "white" ? x.black.username : x.white.username, sans: p.sans, startFen: p.headers.FEN,
            opening: deckOpeningName(side, p.sans, (x.eco || "").split("/").pop().replace(/-/g, " ")), ts: x.end_time * 1000 });
        });
      }
    } catch (e) { console.info("[deck] chess.com fetch failed", e && e.message); }
    games.sort((a, b) => b.ts - a.ts);
    const pick = games.slice(0, max);
    const added = await deckAddGames(pick);
    games.forEach(g => { if (g.site === "lichess") sync.lichess = Math.max(sync.lichess || 0, g.ts + 1); if (g.site === "chesscom") sync.chesscom = Math.max(sync.chesscom || 0, g.ts); });
    sync.at = new Date().toISOString(); deckSave(DECK_KEYS.sync, sync);
    deckSyncStatus(games.length ? "Done: " + pick.length + " new game(s) analysed, " + added + " new card(s)." : "No new games since the last check.", "good");
  } catch (e) {
    deckSyncStatus("Could not update: " + (e && e.message), "warn");
  } finally { Deck.busy = false; $("btn-deck-sync").disabled = false; }
}
async function deckImportPgn() {
  const txt = $("deck-pgn").value.trim(); if (!txt || Deck.busy) return;
  Deck.busy = true; $("btn-deck-pgn").disabled = true;
  try {
    const games = [];
    txt.split(/\n\s*\n(?=\s*\[Event)/).forEach((chunk, i) => {
      const p = parsePgn(chunk); if (!p || !p.sans.length) return;
      const h = p.headers, w = (h.White || "").toLowerCase(), side = DECK_ME.some(n => w.indexOf(n) !== -1) ? "white" : "black";
      const site = /noctie/i.test((h.Site || "") + (h.White || "") + (h.Black || "")) ? "noctie" : /lichess/i.test(h.Site || "") ? "lichess" : /chess\.com/i.test(h.Site || "") ? "chesscom" : "local";
      const date = (h.Date || "").replace(/\./g, "-");
      const id = (h.GameId || (site + "-" + date + "-" + p.sans.length + "-" + p.sans.slice(0, 12).join("")).replace(/[^\w-]/g, "")).slice(0, 60);
      games.push({ site, id, url: /^https?:\/\/(lichess\.org|www\.chess\.com)\//.test(h.Site || "") ? h.Site : "", date, side,
        opp: side === "white" ? h.Black : h.White, sans: p.sans, startFen: h.FEN, opening: deckOpeningName(side, p.sans, h.Opening) });
    });
    if (!games.length) { deckSyncStatus("No games found in that PGN.", "warn"); return; }
    deckSyncStatus("Analysing " + games.length + " game(s)…");
    const added = await deckAddGames(games);
    deckSyncStatus("Done: " + added + " new card(s) from " + games.length + " game(s).", "good");
  } catch (e) { deckSyncStatus("PGN import failed: " + (e && e.message), "warn"); }
  finally { Deck.busy = false; $("btn-deck-pgn").disabled = false; }
}
$("btn-deck-sync").addEventListener("click", deckSync);
$("btn-deck-pgn").addEventListener("click", deckImportPgn);

let deckInitDone = false;
let deckInitP = null;
async function initDeck() {
  if (deckInitDone) return deckInitP; deckInitDone = true;
  deckInitP = (async () => {
    await deckLoad();
    deckBuildQueue();
    deckShow(Deck.queue[0] || null);
  })();
  return deckInitP;
}
/* v46: open one card by id (deep link ?card=…, lesson list) */
async function deckShowById(id) {
  await initDeck();
  const c = Deck.byId[id];
  if (c) deckShow(c);
  return !!c;
}
function deckRenderLessons() {
  const host = $("deck-lessons-list"); if (!host) return;
  const ls = Deck.all.filter(c => c.lesson);
  $("deck-lessons").classList.toggle("hidden", !ls.length);
  host.innerHTML = ls.map(c => '<li><button type="button" class="deck-top-item' + (Deck.cur && Deck.cur.id === c.id ? " current" : "") + '" data-id="' + deckEsc(c.id) + '">'
    + '<span class="dt-swing">' + deckEsc(c.swing) + "</span>"
    + '<span class="dt-move">' + c.move_no + (c.side === "white" ? ". " : "… ") + deckEsc(c.played_san) + "</span>"
    + '<span class="dt-theme">' + deckEsc(c.theme) + "</span>"
    + '<span class="dt-game">' + deckEsc(c.opening) + " · " + deckEsc(c.date || "") + "</span></button></li>").join("");
}
if ($("deck-lessons-list")) $("deck-lessons-list").addEventListener("click", (e) => {
  const b = e.target.closest(".deck-top-item"); if (!b) return;
  const c = Deck.byId[b.dataset.id]; if (c) deckShow(c);
});
window.CCDeck = { state: Deck, init: initDeck, next: deckNext, grade: deckGrade, show: deckShowById };
