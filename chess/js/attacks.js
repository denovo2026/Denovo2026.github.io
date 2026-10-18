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
};

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
  // drawn from the attacker's side: the side to move is the one attacking
  attacksBoard.setOrientation(fenSide(p.fen) === "w" ? "white" : "black");
  attacksBoard.setLastMove(null, null);
  const mover = fenSide(p.fen) === "w" ? "White" : "Black";
  $("attacks-puzzle-label").textContent =
    p.white + " vs " + p.black + " — " + p.section + ", round " + p.round
    + ". " + mover + " to play and attack.";
  attacksSetStatus("Position " + (Attacks.at + 1) + " of "
    + Attacks.queue.length + ". Find the move.");
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
    Attacks.score.asked++;
    if (typeof ccLogAnswer === "function") ccLogAnswer("tactics", "attacks");
    if (guess === p.solution_uci) {
      Attacks.score.right++;
      renderAttacksScore();
      attacksSetStatus("That is the move.", "good");
      revealAnswer(true);
    } else {
      renderAttacksScore();
      attacksBoard.setFen(p.fen);   // a wrong move left up teaches the wrong picture
      attacksSetStatus("Not that one. Read the preconditions on the right — "
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
    Attacks.score.asked++;
    renderAttacksScore();
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
