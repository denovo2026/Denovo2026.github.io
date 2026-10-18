/* =======================================================================
   CALCULATION TRAINER (v42, ported from the newer frontend to run in the browser)

   Drill 1: enter the whole line — your move, their best answer, your move —
   before anything moves. The board stays still in blindfold mode on purpose;
   that is the skill. Drill 2: count the forcing moves for both sides, then
   reveal the census. A broken line goes to the flashcards and the
   "Training misses" cycle.
   ======================================================================= */
const Calc = { fen: null, label: "", moves: [], shadowFen: null, seen: [], busy: false };
const calcBoard = new Board($("calc-board"), { onMove: onCalcMove });

function calcSetStatus(msg, kind) {
  const el = $("calc-status");
  el.textContent = msg || "";
  el.className = "info-line" + (kind ? " " + kind : "");
}
function calcBlind() { return $("calc-blind").checked; }
function calcPlies() { return 2 * parseInt($("calc-depth").value, 10) - 1; }
function calcSideName(i) {
  const me = fenSide(Calc.fen) === "w" ? "White" : "Black", them = me === "White" ? "Black" : "White";
  return i % 2 === 0 ? me : them;
}
function calcRenderSlots() {
  const host = $("calc-slots");
  const n = calcPlies();
  let html = "";
  for (let i = 0; i < n; i++) {
    const m = Calc.moves[i];
    html += '<span class="calc-slot' + (m ? " filled" : "") + (i === Calc.moves.length ? " next" : "") + '">'
      + '<span class="calc-slot-who">' + (i % 2 === 0 ? "you" : "them") + "</span>"
      + escapeHtml(m ? (m.san || "✓") : "…") + "</span>";
  }
  host.innerHTML = html;
  $("btn-calc-check").disabled = Calc.moves.length === 0;
}
function calcLoadFen(fen, label) {
  Calc.fen = fen; Calc.label = label || "Position"; Calc.moves = []; Calc.shadowFen = fen;
  calcBoard.setFen(fen);
  calcBoard.setOrientation(fenSide(fen) === "w" ? "white" : "black");
  calcBoard.setLastMove(null, null);
  calcBoard.clearArrows();
  $("calc-label").textContent = Calc.label + " — " + (fenSide(fen) === "w" ? "White" : "Black") + " to move.";
  $("calc-verdict").classList.add("hidden");
  $("calc-coach").classList.add("hidden");
  $("calc-census").innerHTML = ""; $("calc-census-guess").textContent = ""; $("calc-census-coach").classList.add("hidden");
  calcRenderSlots();
}
async function calcNew() {
  calcSetStatus("Finding a position…");
  try {
    const pos = await apiPost("/api/calc/position", { source: $("calc-source").value, seen_ids: Calc.seen.slice(-60) });
    Calc.seen.push(pos.id);
    calcLoadFen(pos.fen, pos.label);
    calcSetStatus("Enter " + Math.ceil(calcPlies() / 2) + " moves of yours and the replies between them — on the board, one at a time.");
  } catch (e) {
    calcSetStatus("No positions for that source yet: " + e.message, "warn");
  }
}
async function onCalcMove(from, to) {
  if (!Calc.fen || Calc.busy) return;
  if (Calc.moves.length >= calcPlies()) { calcBoard.setFen(calcBlind() ? Calc.fen : Calc.shadowFen); calcSetStatus("That is the full line — check it, or undo a move.", "warn"); return; }
  const uci = uciCandidate(calcBoard, from, to);
  let san = null, next = null;
  try { const ch = new Chess(Calc.shadowFen); const m = ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); san = m.san; next = ch.fen(); } catch (_) { san = null; }
  if (!san) { calcBoard.setFen(calcBlind() ? Calc.fen : Calc.shadowFen); calcBoard.shake && calcBoard.shake(); calcSetStatus("Not legal in the position you are imagining.", "warn"); return; }
  Calc.moves.push({ uci, san });
  Calc.shadowFen = next;
  if (calcBlind()) { calcBoard.setFen(Calc.fen); calcBoard.setLastMove(null, null); }
  else { calcBoard.setFen(next); calcBoard.setLastMove(from, to); }
  // in blindfold the board turns to the side whose move you are entering next
  calcSetStatus(Calc.moves.length >= calcPlies() ? "Line complete — press Check my line." : "Now " + calcSideName(Calc.moves.length) + "'s move" + (Calc.moves.length % 2 ? " (their best reply)." : "."));
  calcRenderSlots();
}
function calcUndo() {
  if (!Calc.moves.length) return;
  Calc.moves.pop();
  let f = Calc.fen;
  try { const ch = new Chess(Calc.fen); Calc.moves.forEach(m => ch.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] || "q" })); f = ch.fen(); } catch (_) {}
  Calc.shadowFen = f;
  calcBoard.setFen(calcBlind() ? Calc.fen : f);
  calcRenderSlots();
}
function calcClear() { if (Calc.fen) calcLoadFen(Calc.fen, Calc.label); }
function calcVerdict(r) {
  const host = $("calc-verdict");
  host.classList.remove("hidden");
  const n = r.clean_depth_moves || 0;
  let html = '<div class="rep-score"><span class="calc-score-big">' + n + '</span><span class="calc-score-unit">clean move' + (n === 1 ? "" : "s") + ' deep</span>'
    + '<span class="calc-score-sub">' + r.correct_plies + " of " + (r.steps || []).length + " plies hold up</span></div>";
  html += '<table class="calc-steps"><thead><tr><th>#</th><th>Who</th><th>You said</th><th>Verdict</th><th>Best</th></tr></thead><tbody>';
  for (const s of r.steps || []) {
    html += '<tr class="v-' + s.verdict + '"><td>' + s.ply + "</td><td>" + s.side + "</td><td>" + escapeHtml(s.played_san || s.played_uci || "") + "</td><td>" + escapeHtml(s.verdict) + "</td><td>" + escapeHtml(s.best_san || "") + "</td></tr>";
  }
  html += "</tbody></table>";
  const sol = (r.solution && r.solution.line) || [];
  if (sol.length) html += '<div class="mt-line"><strong>Engine line:</strong> ' + escapeHtml(sol.map(x => x.san).join(" ")) + "</div>";
  host.innerHTML = html;
  if (sol.length) calcBoard.setArrows(sol.filter((_, i) => i % 2 === 0).slice(0, 3).map(x => ({ from: x.uci.slice(0, 2), to: x.uci.slice(2, 4), color: "green" })));
}
async function calcCheck() {
  if (!Calc.fen || !Calc.moves.length) return;
  const btn = $("btn-calc-check"); btn.disabled = true;
  calcSetStatus("Grading every ply against the engine…");
  try {
    const r = await apiPost("/api/calc/check", { fen: Calc.fen, moves_uci: Calc.moves.map(m => m.uci), plies: calcPlies() });
    calcVerdict(r);
    if (r.coach) { const c = $("calc-coach"); c.textContent = r.coach.commentary; c.classList.remove("hidden"); }
    calcSetStatus(r.steps.every(s => s.verdict === "best" || s.verdict === "good") ? "Clean line." : "Where it broke is now on your flashcards and in the Training misses cycle.");
  } catch (e) {
    calcSetStatus("Grading failed: " + e.message, "warn");
  } finally { btn.disabled = false; }
}
async function calcReveal() {
  if (!Calc.fen) return;
  calcSetStatus("Asking the engine…");
  try {
    const r = await apiPost("/api/calc/solution", { fen: Calc.fen, plies: calcPlies() });
    const host = $("calc-verdict"); host.classList.remove("hidden");
    host.innerHTML = '<div class="mt-line"><strong>Engine line:</strong> ' + escapeHtml((r.line || []).map(s => s.san + (s.kind !== "quiet" ? " (" + s.kind + ")" : "")).join(" ")) + "</div>";
    calcSetStatus("Solution shown — the drill only counts when you check your own line first.");
  } catch (e) { calcSetStatus("Could not get the solution: " + e.message, "warn"); }
}
function censusCol(title, side) {
  const c = side.counts || {};
  const chip = (n, w) => '<span class="chip">' + (n || 0) + " " + w + ((n || 0) === 1 ? "" : "s") + "</span>";
  return '<div class="census-col"><h4>' + title + "</h4><div class=\"chip-row\">" + chip(c.check, "check") + chip(c.capture, "capture") + chip(c.threat, "threat") + "</div>"
    + (side.note ? '<div class="info-line">' + escapeHtml(side.note) + "</div>" : "")
    + '<div class="census-list">' + (side.moves || []).map(m => '<span class="census-item kind-' + m.kind + '">' + escapeHtml(m.san) + "</span>").join(" ") + "</div>"
    + (side.hidden ? '<div class="info-line muted">+' + side.hidden + " more</div>" : "") + "</div>";
}
async function calcCensus() {
  if (!Calc.fen) { calcSetStatus("Load a position first.", "warn"); return; }
  try {
    const r = await apiPost("/api/calc/census", { fen: Calc.fen });
    const gy = parseInt($("calc-guess-you").value, 10) || 0, gt = parseInt($("calc-guess-them").value, 10) || 0;
    const ry = r.you.counts.total || 0, rt = r.opponent.counts.total || 0;
    $("calc-census-guess").textContent = "You guessed " + gy + " / " + gt + " — actual " + ry + " / " + rt + "."
      + (gt < rt ? " You are under-counting THEIR forcing moves. That is where games are lost." : "");
    $("calc-census").innerHTML = censusCol("Your forcing moves", r.you) + censusCol("Theirs, if you pass", r.opponent);
    const c = $("calc-census-coach"); c.textContent = r.coach.commentary; c.classList.remove("hidden");
  } catch (e) { calcSetStatus("Census failed: " + e.message, "warn"); }
}
$("btn-calc-new").addEventListener("click", calcNew);
$("btn-calc-check").addEventListener("click", calcCheck);
$("btn-calc-undo").addEventListener("click", calcUndo);
$("btn-calc-clear").addEventListener("click", calcClear);
$("btn-calc-reveal").addEventListener("click", calcReveal);
$("btn-calc-census").addEventListener("click", calcCensus);
$("btn-calc-current").addEventListener("click", () => calcLoadFen(playBoard.getFen(), "Position from Play & Analyze"));
$("calc-depth").addEventListener("input", () => { $("calc-depth-val").textContent = $("calc-depth").value; Calc.moves = Calc.moves.slice(0, calcPlies()); calcRenderSlots(); });
$("calc-blind").addEventListener("change", () => { if (Calc.fen) calcBoard.setFen(calcBlind() ? Calc.fen : Calc.shadowFen); });
let calcInitDone = false;
function initCalc() { if (calcInitDone) return; calcInitDone = true; calcRenderSlots(); calcNew(); }
