/* =======================================================================
   KINGSIDE ATTACKS (V13)

   Theory on the right, a position to solve on the left. The patterns are
   written; the positions are not — every one is a real game from the 46th
   Olympiad where the engine has already confirmed both the mistake and
   the punishment, so a move that "looks right" either is the answer or is
   not, and the page does not have to take anyone's word for it.

   The board is drawn from the attacker's side, because the whole skill is
   seeing the king's cover the way the attacker sees it.
   ======================================================================= */

const Attacks = {
  data: null,        // overview: patterns + theory, no positions
  pattern: null,     // the selected pattern, in full
  queue: [],         // its positions, shuffled
  at: 0,
  solved: false,
  busy: false,
  score: { asked: 0, right: 0 },
  // v42: the whole line, not just the first move
  seq: [],           // uci moves of the line (attacker, defender, attacker…)
  step: 0,           // index into seq of the move being asked
  fenNow: null,      // position on the board while solving
  clean: true,       // every attacker move found first try so far
  missed: false,     // a miss was already sent to the flashcards
};

/* the stored line ("39.Rxh7 Rxh7 40.Qxe6+ Kh8 …") -> uci moves, at most 3 of the attacker's */
function attacksLine(p) {
  const out = [];
  try {
    const ch = new Chess(p.fen);
    const toks = String(p.line_san || "").split(/\s+/).map(t => t.replace(/^\d+\.+/, "")).filter(Boolean);
    for (const t of toks) {
      const m = ch.move(t);
      if (!m) break;
      out.push(m.from + m.to + (m.promotion || ""));
      if (out.length >= 5) break;
    }
  } catch (_) { /* fall back to the first move */ }
  if (!out.length || out[0] !== p.solution_uci) return [p.solution_uci];
  // the line must end on an attacker move
  return out.length % 2 === 0 ? out.slice(0, -1) : out;
}
function attacksFenAfter(fen, uci) {
  try { const ch = new Chess(fen); ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" }); return ch.fen(); }
  catch (_) { return null; }
}
function attacksSendMiss(p, fen, best, played) {
  if (Attacks.missed) return;
  Attacks.missed = true;
  try {
    fetch("api/misses/add", { method: "POST", body: JSON.stringify({ source: "attacks", items: [{
      fen_before: fen, best_uci: best, uci: played || null,
      title: (Attacks.pattern ? Attacks.pattern.name : "Attack") + " — " + p.white + " vs " + p.black,
      explanation: p.note || "", motif: "missed_check" }] }) });
  } catch (_) { /* best effort */ }
}

const attacksBoard = new Board($("attacks-board"), { onMove: onAttacksMove });

function attacksSetStatus(msg, kind) {
  const el = $("attacks-status");
  el.textContent = msg || "";
  el.className = "info-line" + (kind ? " " + kind : "");
}

function currentPuzzle() {
  return Attacks.queue[Attacks.at] || null;
}

/* ---- the theory ------------------------------------------------------ */

function attacksList(items) {
  if (!items || !items.length) return "";
  return "<ul class='struct-plans'>"
    + items.map(x => "<li>" + escapeHtml(x) + "</li>").join("") + "</ul>";
}

const SIDE_LABEL = {
  attacking: "you are usually the one attacking",
  defending: "you are usually the one defending",
  both: "it cuts both ways",
};

function renderAttacksPatterns() {
  const host = $("attacks-patterns");
  host.innerHTML = "";
  for (const p of Attacks.data.patterns) {
    const chosen = Boolean(Attacks.pattern && Attacks.pattern.id === p.id);
    const card = document.createElement("button");
    card.className = "rep-look" + (chosen ? " active" : "");
    card.setAttribute("aria-pressed", chosen ? "true" : "false");
    card.innerHTML =
      '<span class="ml-head"><strong>' + escapeHtml(p.name) + "</strong>"
      + '<span class="chip">' + p.puzzle_count + " positions</span></span>"
      + '<span class="ml-tell">' + escapeHtml(p.mechanism) + "</span>";
    card.addEventListener("click", () => loadPattern(p.id));
    host.appendChild(card);
  }
}

function renderAttacksTheory(p) {
  $("attacks-pattern-name").textContent = p.name;
  let html = '<div class="struct-head">'
    + '<span class="chip verified">' + escapeHtml(SIDE_LABEL[p.you_are] || "")
    + "</span>"
    + '<span class="chip">' + escapeHtml(p.detect) + "</span></div>";
  html += "<h4 class='sub-head'>Where you meet it</h4>"
    + attacksList(p.openings);
  html += "<h4 class='sub-head'>What has to be true first</h4>"
    + attacksList(p.preconditions);
  html += "<h4 class='sub-head'>How it goes</h4>"
    + '<div class="coach-box">' + escapeHtml(p.mechanism) + "</div>";
  html += "<h4 class='sub-head'>How it is stopped</h4>"
    + '<div class="coach-box warn-box">' + escapeHtml(p.defence) + "</div>";
  $("attacks-theory").innerHTML = html;
}

/* ---- the positions --------------------------------------------------- */

function shuffle(xs) {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function loadPattern(id) {
  attacksSetStatus("Loading…");
  try {
    Attacks.pattern = await apiGet("/api/attacks/" + id);
  } catch (e) {
    attacksSetStatus("Could not load that pattern: " + e.message, "warn");
    return;
  }
  Attacks.queue = shuffle(Attacks.pattern.puzzles || []);
  Attacks.at = 0;
  Attacks.score = { asked: 0, right: 0 };
  $("attacks-score").classList.add("hidden");
  renderAttacksPatterns();
  renderAttacksTheory(Attacks.pattern);
  showPuzzle();
}

function showPuzzle() {
  const p = currentPuzzle();
  $("attacks-answer").classList.add("hidden");
  Attacks.solved = false;
  if (!p) {
    $("attacks-puzzle-label").textContent =
      "That is every position for this pattern — pick another above.";
    attacksSetStatus("");
    return;
  }
  attacksBoard.setFen(p.fen);
  attacksBoard.clearArrows();
  Attacks.seq = attacksLine(p); Attacks.step = 0; Attacks.fenNow = p.fen; Attacks.clean = true; Attacks.missed = false;
  // drawn from the attacker's side: the side to move is the one attacking
  attacksBoard.setOrientation(fenSide(p.fen) === "w" ? "white" : "black");
  attacksBoard.setLastMove(null, null);
  const mover = fenSide(p.fen) === "w" ? "White" : "Black";
  const verb = (Attacks.pattern && Attacks.pattern.id === "own-traps") ? "find the right move" : "to play and attack";
  const where = [p.section, p.round ? ("round " + p.round) : ""].filter(Boolean).join(", ");
  $("attacks-puzzle-label").textContent =
    p.white + " vs " + p.black + (where ? " — " + where : "")
    + ". " + mover + " " + verb + ".";
  const own = Math.ceil(Attacks.seq.length / 2);
  attacksSetStatus("Position " + (Attacks.at + 1) + " of "
    + Attacks.queue.length + ". " + (own > 1 ? "Work out the line: " + own + " moves of yours, nothing is shown until you have them all." : "Find the move."));
}

function renderAttacksScore() {
  const s = Attacks.score;
  $("attacks-score").classList.remove("hidden");
  $("attacks-score").innerHTML =
    '<span class="calc-score-big">' + s.right + "</span>"
    + '<span class="calc-score-unit">of ' + s.asked + " found</span>"
    + '<span class="calc-score-sub">first try, no hints</span>';
}

function revealAnswer(found) {
  const p = currentPuzzle();
  if (!p) return;
  Attacks.solved = true;
  const box = $("attacks-answer");
  box.classList.remove("hidden");
  box.innerHTML =
    '<div class="their-verdict ' + (found ? "v-exact" : "v-miss") + '">'
    + escapeHtml(p.solution_san) + '  <span class="chip">'
    + escapeHtml(p.eval) + "</span></div>"
    + '<div class="coach-box">' + escapeHtml(p.note) + "</div>"
    + (p.line_san
        ? '<div class="mt-line">' + escapeHtml(p.line_san) + "</div>" : "");
  const uci = p.solution_uci;
  attacksBoard.setArrows([{ from: uci.slice(0, 2), to: uci.slice(2, 4),
                            color: "amber" }]);
}

async function onAttacksMove(from, to) {
  const p = currentPuzzle();
  if (!p || Attacks.busy || Attacks.solved) return;
  Attacks.busy = true;
  try {
    const guess = uciCandidate(attacksBoard, from, to);
    const want = Attacks.seq[Attacks.step];
    const own = Math.ceil(Attacks.seq.length / 2), n = Attacks.step / 2 + 1;
    if (Attacks.step === 0) Attacks.score.asked++;
    if (typeof ccLogAnswer === "function") ccLogAnswer("tactics", "attacks");
    // any mate is as good as the stored move
    const after = attacksFenAfter(Attacks.fenNow, guess);
    const mates = after && (() => { try { return new Chess(after).isCheckmate(); } catch (_) { return false; } })();
    if (guess === want || mates) {
      Attacks.fenNow = after;
      attacksBoard.setFen(after);
      attacksBoard.setLastMove(guess.slice(0, 2), guess.slice(2, 4));
      Attacks.step += 2;
      if (Attacks.step >= Attacks.seq.length || mates) {
        if (Attacks.clean) Attacks.score.right++;
        renderAttacksScore();
        attacksSetStatus((own > 1 ? "That is the whole line — " + own + " of " + own + "." : "That is the move.")
          + (Attacks.clean ? "" : " (Not all first try, so it goes to your flashcards.)"), "good");
        revealAnswer(Attacks.clean);
        return;
      }
      renderAttacksScore();
      const reply = Attacks.seq[Attacks.step - 1];
      await new Promise(r => setTimeout(r, 350));
      const fenReply = attacksFenAfter(Attacks.fenNow, reply);
      let replySan = reply;
      try { const c = new Chess(Attacks.fenNow); replySan = c.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] || "q" }).san; } catch (_) {}
      Attacks.fenNow = fenReply;
      attacksBoard.setFen(fenReply);
      attacksBoard.setLastMove(reply.slice(0, 2), reply.slice(2, 4));
      attacksSetStatus("Right (" + n + " of " + own + "). The reply is " + replySan + " — now your next move.", "good");
    } else {
      Attacks.clean = false;
      attacksSendMiss(p, Attacks.fenNow, want, guess);
      renderAttacksScore();
      attacksBoard.setFen(Attacks.fenNow);   // a wrong move left up teaches the wrong picture
      attacksSetStatus("Not that one" + (Attacks.step ? " (move " + n + " of " + own + ")" : "") + ". Read the preconditions on the right — "
        + "the move is there because one of them is met.", "warn");
    }
  } finally {
    Attacks.busy = false;
  }
}

/* ---- wiring ---------------------------------------------------------- */

$("btn-attacks-next").addEventListener("click", () => {
  if (!Attacks.queue.length) {
    attacksSetStatus("Pick a pattern first.", "warn");
    return;
  }
  Attacks.at = (Attacks.at + 1) % Attacks.queue.length;
  showPuzzle();
});

$("btn-attacks-show").addEventListener("click", () => {
  if (!currentPuzzle()) return;
  if (!Attacks.solved) {
    if (Attacks.step === 0) Attacks.score.asked++;
    renderAttacksScore();
    attacksSendMiss(currentPuzzle(), Attacks.fenNow || currentPuzzle().fen, Attacks.seq[Attacks.step] || currentPuzzle().solution_uci, null);
  }
  attacksSetStatus("Here it is — now find why it works.");
  revealAnswer(false);
});

$("btn-attacks-play").addEventListener("click", () => {
  const p = currentPuzzle();
  if (!p) return;
  sendFenToPlay(p.fen, fenSide(p.fen) === "w" ? "white" : "black",
    "Loaded from the Attacks tab — " + (fenSide(p.fen) === "w" ? "White" : "Black") + " to play and attack.");
});

let attacksInitDone = false;
async function initAttacks() {
  if (attacksInitDone) return;
  attacksInitDone = true;
  try {
    Attacks.data = await apiGet("/api/attacks");
  } catch (e) {
    $("attacks-patterns").innerHTML =
      '<div class="info-line">Patterns unavailable: '
      + escapeHtml(e.message) + "</div>";
    return;
  }
  $("attacks-title").textContent = Attacks.data.name;
  $("attacks-summary").textContent = Attacks.data.summary;
  renderAttacksPatterns();
  if (Attacks.data.patterns.length) loadPattern(Attacks.data.patterns[0].id);
}
