/* alapin-drill.js — short Alapin trainer.
   Same shape as the Top 10 drill: a plan card, one main line and two
   sidelines through move 8, wrong moves refused, spaced repetition in
   localStorage, and "play it out" against the engine. The longer
   repertoire stays on the Alapin tab. */

const ALN_SR_KEY = "chesscoach:alapin-drill-sr";
const ALN_STEPS = [1, 3, 7, 14, 30, 60];
const ALN_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const Aln = {
  data: null,
  line: null,
  branch: null,
  ply: 0,
  drill: false,
  first: {},
  hinted: {},
  misses: {},
  score: { asked: 0, right: 0 },
  busy: false,
};

let alnBoard = null;
let alnNav = null;
let alnWired = false;
let alnInitDone = false;

function alnToday() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function alnAddDays(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const p = (x) => (x < 10 ? "0" : "") + x;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function alnDaysUntil(iso) {
  if (!iso) return 0;
  const t = alnToday().split("-").map(Number);
  const b = iso.split("-").map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(t[0], t[1] - 1, t[2])) / 86400000);
}

function alnWhen(iso) {
  const days = alnDaysUntil(iso);
  if (days <= 0) return "due today";
  if (days === 1) return "due tomorrow";
  return "in " + days + " days";
}

function alnLoadSR() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALN_SR_KEY) || "");
    if (raw && raw.lines && typeof raw.lines === "object") return raw;
  } catch (_) { /* fresh */ }
  return { lines: {} };
}

function alnSaveSR(sr) {
  try { localStorage.setItem(ALN_SR_KEY, JSON.stringify(sr)); } catch (_) { /* private mode */ }
}

function alnPlaySan(ch, san) {
  const tries = [san, String(san).replace(/[!?]/g, ""), String(san).replace(/[!?+#]/g, "")];
  for (let i = 0; i < tries.length; i++) {
    try {
      const m = ch.move(tries[i]);
      if (m) return m;
    } catch (_) { /* chess.js throws on an illegal move */ }
  }
  return null;
}

function alnExpand(moves) {
  if (typeof Chess !== "function") throw new Error("chess.js missing");
  const ch = new Chess();
  const plies = [];
  for (let i = 0; i < moves.length; i++) {
    const m = alnPlaySan(ch, moves[i]);
    if (!m) throw new Error("Illegal move " + moves[i] + " at ply " + (i + 1));
    plies.push({
      san: m.san,
      uci: m.from + m.to + (m.promotion || ""),
      side: m.color === "w" ? "white" : "black",
      fen: ch.fen(),
    });
  }
  return plies;
}

function alnExpandAll(data) {
  (data.lines || []).forEach((line) => { line.plies = alnExpand(line.moves || []); });
  (data.traps || []).forEach((t) => { if (t.moves && t.moves.length) t.plies = alnExpand(t.moves); });
  return data;
}

const alnReady = fetch("data/alapin-drill.json?v=48").then((r) => {
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}).then(alnExpandAll);

function alnMe() { return (Aln.data && Aln.data.side) || "white"; }

function alnPlies() {
  if (Aln.branch && Aln.branch.plies) return Aln.branch.plies;
  return (Aln.line && Aln.line.plies) || [];
}

function alnFenAt(ply) {
  const plies = alnPlies();
  if (ply <= 0) return ALN_START;
  return plies[ply - 1].fen;
}

function alnSetStatus(msg, kind) {
  const el = $("aln-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "info-line" + (kind ? " " + kind : "");
}

function alnCountDue() {
  const sr = alnLoadSR();
  const today = alnToday();
  let n = 0;
  const lines = (Aln.data && Aln.data.lines) || [];
  lines.forEach((line) => {
    const rec = sr.lines[line.id];
    if (!rec || rec.due <= today) n++;
  });
  return { n: n, total: lines.length };
}

function alnPaintDue() {
  if (!Aln.data) return;
  const c = alnCountDue();
  const badge = $("aln-tab-due");
  if (badge) {
    badge.textContent = c.n ? String(c.n) : "";
    badge.classList.toggle("hidden", !c.n);
    badge.title = c.n ? c.n + " line" + (c.n === 1 ? "" : "s") + " due today" : "";
  }
  const chip = $("aln-due");
  if (chip) {
    chip.textContent = "Due today: " + c.n;
    chip.className = "rep-mem " + (c.n ? "miss" : "ok");
    chip.title = "New lines count as due until you drill them. A clean line comes back in 3 days, then 7, 14, 30 and 60. A miss comes back tomorrow.";
  }
  const dueBtn = $("btn-aln-due");
  if (dueBtn) dueBtn.textContent = "Drill due (" + c.n + ")";
}

function alnMem(line) {
  const rec = alnLoadSR().lines[line.id];
  if (!rec) return { cls: "new", text: "New" };
  const when = alnWhen(rec.due);
  const mark = rec.lastRight + "/" + rec.lastTotal;
  const ok = rec.lastRight === rec.lastTotal && alnDaysUntil(rec.due) > 0;
  return { cls: ok ? "ok" : "miss", text: mark + " · " + when };
}

function alnGo(n) {
  const plies = alnPlies();
  Aln.ply = Math.max(0, Math.min(plies.length, n));
  if (!alnBoard) return;
  alnBoard.setFen(alnFenAt(Aln.ply));
  const last = Aln.ply > 0 ? plies[Aln.ply - 1] : null;
  alnBoard.setLastMove(last ? last.uci.slice(0, 2) : null, last ? last.uci.slice(2, 4) : null);
  if (!Aln.drill) {
    alnBoard.setGuided([]);
    alnBoard.clearArrows();
  }
  alnRenderMoves();
  alnRenderLabel();
  if (alnNav) {
    const on = !Aln.drill;
    alnNav.update({
      start: on && Aln.ply > 0,
      prev: on && Aln.ply > 0,
      next: on && Aln.ply < plies.length,
      end: on && Aln.ply < plies.length,
    });
  }
}

function alnRenderLabel() {
  const el = $("aln-label");
  if (!el) return;
  if (!Aln.data) { el.textContent = "Loading the Alapin…"; return; }
  if (Aln.branch) {
    el.textContent = Aln.data.name + " — " + Aln.branch.name;
    return;
  }
  el.textContent = Aln.data.name + " — " + (Aln.line ? Aln.line.name : "") + " · you play White";
}

function alnRenderMoves() {
  const host = $("aln-movebar");
  if (!host) return;
  const plies = alnPlies();
  host.innerHTML = "";
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i];
    const span = document.createElement("span");
    const hidden = Aln.drill && i >= Aln.ply;
    span.className = "rep-move " + p.side + (i < Aln.ply ? " played" : "");
    span.textContent = (i % 2 === 0 ? (i / 2 + 1) + ". " : "") + (hidden ? "…" : p.san);
    if (!Aln.drill) span.addEventListener("click", () => alnGo(i + 1));
    host.appendChild(span);
  }
}

function alnRenderScore() {
  const el = $("aln-score");
  if (!el) return;
  if (!Aln.drill && !Aln.score.asked) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const s = Aln.score;
  const pct = s.asked ? Math.round((100 * s.right) / s.asked) : 0;
  el.innerHTML = '<span class="calc-score-big">' + s.right + "</span>"
    + '<span class="calc-score-unit">of ' + s.asked + " first tries</span>"
    + '<span class="calc-score-sub">' + pct + "%</span>";
}

function alnList(items) {
  if (!items || !items.length) return "";
  return '<ul class="struct-plans">' + items.map((x) => "<li>" + escapeHtml(x) + "</li>").join("") + "</ul>";
}

function alnRenderLines() {
  const host = $("aln-lines");
  if (!host || !Aln.data) return;
  host.innerHTML = "";
  Aln.data.lines.forEach((line) => {
    const mem = alnMem(line);
    const btn = document.createElement("button");
    btn.type = "button";
    const on = Aln.line && Aln.line.id === line.id && !Aln.branch;
    btn.className = "t10-line" + (on ? " active" : "");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.innerHTML = escapeHtml(line.name) + '<span class="rep-mem ' + mem.cls + '">' + escapeHtml(mem.text) + "</span>";
    btn.title = line.note || "";
    btn.addEventListener("click", () => alnSelect(line.id));
    host.appendChild(btn);
  });
}

function alnRenderDetail() {
  const op = Aln.data;
  const host = $("aln-detail");
  const title = $("aln-card-title");
  if (!op || !host) return;
  if (title) title.textContent = op.name;
  let html = '<div class="struct-head">'
    + '<span class="chip verified">White · you</span>'
    + '<span class="chip">' + escapeHtml(op.family || "") + "</span>"
    + '<span class="chip">' + escapeHtml(op.eco || "") + "</span></div>";
  html += "<h4 class='sub-head'>The tell</h4><div class='coach-box'>" + escapeHtml(op.tell) + "</div>";
  html += "<h4 class='sub-head'>Pawn structure</h4><p class='info-line'>" + escapeHtml(op.structure) + "</p>";
  html += "<h4 class='sub-head'>Where the pieces go</h4>" + alnList(op.pieces);
  html += "<h4 class='sub-head'>Your plan</h4>" + alnList(op.plans && op.plans.white);
  html += "<h4 class='sub-head'>What Black wants</h4>" + alnList(op.plans && op.plans.black);
  html += "<h4 class='sub-head'>Pawn breaks</h4>" + alnList(op.breaks);
  if (op.traps && op.traps.length) {
    html += "<h4 class='sub-head'>Traps</h4>";
    op.traps.forEach((t, i) => {
      html += '<div class="rep-tactic"><div class="mt-head"><strong>' + escapeHtml(t.name) + "</strong>";
      if (t.plies && t.plies.length) {
        html += '<button type="button" class="btn mt-show aln-show" data-i="' + i + '">Show it</button>';
      }
      html += "</div><div>" + escapeHtml(t.point) + "</div></div>";
    });
  }
  if (op.links && op.links.length) {
    html += "<h4 class='sub-head'>Also in the app</h4>";
    op.links.forEach((L) => {
      let btn = "";
      if (L.tab) {
        btn = ' <button type="button" class="btn mini aln-jump" data-tab="' + escapeHtml(L.tab) + '">'
          + escapeHtml(L.label) + "</button>";
      } else if (L.opening) {
        btn = ' <button type="button" class="btn mini aln-jump" data-opening="' + escapeHtml(L.opening) + '">'
          + escapeHtml(L.label) + "</button>";
      }
      html += '<p class="info-line">' + escapeHtml(L.note || "") + btn + "</p>";
    });
  }
  if (Aln.line && Aln.line.note) {
    html += "<h4 class='sub-head'>This line</h4><p class='info-line'>" + escapeHtml(Aln.line.note) + "</p>";
  }
  host.innerHTML = html;
}

function alnSelect(lineId) {
  if (!Aln.data) return;
  Aln.drill = false;
  Aln.branch = null;
  Aln.first = {};
  Aln.hinted = {};
  Aln.misses = {};
  Aln.score = { asked: 0, right: 0 };
  const drillBtn = $("btn-aln-drill");
  if (drillBtn) drillBtn.textContent = "Drill this line";
  const hint = $("btn-aln-hint");
  if (hint) hint.disabled = true;
  const sides = $("aln-sides");
  if (sides) sides.classList.add("hidden");
  const score = $("aln-score");
  if (score) score.classList.add("hidden");
  Aln.line = Aln.data.lines.find((l) => l.id === lineId) || Aln.data.lines[0];
  if (alnBoard) alnBoard.setOrientation("white");
  alnRenderLines();
  alnRenderDetail();
  alnGo(0);
  alnSetStatus("Step through the line, drill your moves, or play the final position out.");
}

function alnShowTrap(i) {
  const t = Aln.data && Aln.data.traps[i];
  if (!t || !t.plies) return;
  Aln.drill = false;
  const drillBtn = $("btn-aln-drill");
  if (drillBtn) drillBtn.textContent = "Drill this line";
  const hint = $("btn-aln-hint");
  if (hint) hint.disabled = true;
  Aln.branch = t;
  alnRenderLines();
  alnGo(t.plies.length);
  alnSetStatus(t.name + ". Step back through it with the arrows. Pick a line again for the drill.");
}

function alnStopDrill(msg) {
  Aln.drill = false;
  const drillBtn = $("btn-aln-drill");
  if (drillBtn) drillBtn.textContent = "Drill this line";
  const hint = $("btn-aln-hint");
  if (hint) hint.disabled = true;
  if (alnBoard) { alnBoard.setGuided([]); alnBoard.clearArrows(); }
  if (msg) alnSetStatus(msg);
  alnGo(Aln.ply);
}

function alnAdvance(justSan) {
  const plies = alnPlies();
  const me = alnMe();
  while (Aln.ply < plies.length && plies[Aln.ply].side !== me) Aln.ply++;
  alnGo(Aln.ply);
  if (!Aln.drill) return;
  if (Aln.ply >= plies.length) { alnFinish(); return; }
  const n = Math.floor(Aln.ply / 2) + 1;
  const prefix = justSan ? justSan + " — that's the move. " : "";
  alnSetStatus(prefix + "White to play, move " + n + ". Find the book move.", justSan ? "good" : "");
}

function alnStartDrill() {
  if (!Aln.line || !Aln.line.plies) return;
  Aln.branch = null;
  Aln.drill = true;
  Aln.first = {};
  Aln.hinted = {};
  Aln.misses = {};
  Aln.score = { asked: 0, right: 0 };
  Aln.ply = 0;
  const drillBtn = $("btn-aln-drill");
  if (drillBtn) drillBtn.textContent = "Stop drill";
  const hint = $("btn-aln-hint");
  if (hint) hint.disabled = false;
  const sides = $("aln-sides");
  if (sides) sides.classList.add("hidden");
  alnRenderLines();
  alnRenderScore();
  alnGo(0);
  alnAdvance();
}

function alnSchedule(right, total) {
  const id = Aln.line.id;
  const sr = alnLoadSR();
  const r = sr.lines[id] || { step: -1, attempts: 0 };
  r.attempts = (r.attempts || 0) + 1;
  r.name = Aln.data.name + " — " + Aln.line.name;
  r.lastRight = right;
  r.lastTotal = total;
  r.lastAt = new Date().toISOString();
  if (total > 0 && right === total) {
    const prev = (r.step == null || r.step < 0) ? 0 : r.step;
    r.step = Math.min(ALN_STEPS.length - 1, Math.max(1, prev + 1));
  } else {
    r.step = 0;
  }
  r.interval = ALN_STEPS[Math.max(0, r.step)];
  r.due = alnAddDays(r.interval);
  sr.lines[id] = r;
  alnSaveSR(sr);
  return r;
}

function alnFinish() {
  const plies = Aln.line.plies;
  const me = alnMe();
  const mine = [];
  for (let i = 0; i < plies.length; i++) if (plies[i].side === me) mine.push(i);
  const total = mine.length;
  const right = mine.filter((i) => Aln.first[i]).length;
  const rec = alnSchedule(right, total);
  Aln.drill = false;
  const drillBtn = $("btn-aln-drill");
  if (drillBtn) drillBtn.textContent = "Drill this line";
  const hint = $("btn-aln-hint");
  if (hint) hint.disabled = true;
  if (alnBoard) { alnBoard.setGuided([]); alnBoard.clearArrows(); }
  const clean = right === total;
  alnSetStatus(right + " of " + total + " on the first try. "
    + (clean ? "Next review in " + rec.interval + " days." : "Missed — back tomorrow."),
    clean ? "good" : "warn");
  alnRenderScore();
  alnPaintDue();
  alnRenderLines();
  alnGo(plies.length);
}

function alnHint() {
  if (!Aln.drill) return;
  const want = alnPlies()[Aln.ply];
  if (!want || want.side !== alnMe()) return;
  Aln.hinted[Aln.ply] = true;
  const from = want.uci.slice(0, 2);
  const to = want.uci.slice(2, 4);
  alnBoard.setGuided([from, to]);
  alnBoard.setArrows([{ from: from, to: to, color: "green" }]);
  alnSetStatus("Hint: " + want.san + ". It will not count as a first try.", "warn");
}

function alnOnMove(from, to) {
  if (!Aln.drill || Aln.busy) return;
  const plies = alnPlies();
  const want = plies[Aln.ply];
  if (!want || want.side !== alnMe()) return;
  const guess = uciCandidate(alnBoard, from, to);
  Aln.busy = true;
  try {
    if (guess === want.uci) {
      const unseen = !(Aln.ply in Aln.first);
      if (unseen) {
        const clean = !Aln.hinted[Aln.ply];
        Aln.first[Aln.ply] = clean;
        Aln.score.asked++;
        if (clean) Aln.score.right++;
      }
      Aln.ply++;
      alnBoard.setGuided([]);
      alnBoard.clearArrows();
      alnRenderScore();
      alnAdvance(want.san);
    } else {
      Aln.misses[Aln.ply] = (Aln.misses[Aln.ply] || 0) + 1;
      if (!(Aln.ply in Aln.first)) {
        Aln.first[Aln.ply] = false;
        Aln.score.asked++;
      }
      alnRenderScore();
      if (Aln.misses[Aln.ply] >= 2) {
        alnBoard.setGuided([want.uci.slice(0, 2), want.uci.slice(2, 4)]);
        alnSetStatus("Refused. The book move is " + want.san + ".", "warn");
      } else {
        alnSetStatus("Not the book move. It is refused — look at the plan, then try again.", "warn");
      }
    }
  } finally {
    Aln.busy = false;
  }
}

function alnDrillDue() {
  if (!Aln.data) return;
  const sr = alnLoadSR();
  const today = alnToday();
  const items = Aln.data.lines.map((line, index) => {
    const rec = sr.lines[line.id];
    let rank = 3;
    if (!rec) rank = 1;
    else if (rec.due <= today && rec.lastRight < rec.lastTotal) rank = 0;
    else if (rec.due <= today) rank = 2;
    return { line: line, rank: rank, due: rec ? rec.due : "", index: index };
  });
  items.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 1) return a.index - b.index;
    if (a.due !== b.due) return a.due < b.due ? -1 : 1;
    return a.index - b.index;
  });
  const pick = items[0];
  if (!pick) return;
  alnSelect(pick.line.id);
  alnStartDrill();
  const why = pick.rank === 0 ? "You missed this one. "
    : pick.rank === 1 ? "A new line. "
    : pick.rank === 2 ? "Due for review. "
    : "Nothing is due — drilling the next line anyway. ";
  const cur = $("aln-status").textContent;
  alnSetStatus(why + pick.line.name + ". " + cur);
}

function alnEndFen() {
  const plies = Aln.line && Aln.line.plies;
  if (!plies || !plies.length) return ALN_START;
  return plies[plies.length - 1].fen;
}

function alnPlayOut(side) {
  if (!Aln.data || !Aln.line) return;
  const fen = alnEndFen();
  const plan = (Aln.data.plans && Aln.data.plans[side] && Aln.data.plans[side][0]) || "";
  const who = side === "white" ? "White" : "Black";
  const text = Aln.data.name + " · " + Aln.line.name
    + " — you are " + who + ". The app plays the other side."
    + (plan ? " " + plan : "");
  if (typeof startPracticeFrom === "function") {
    startPracticeFrom(fen, side);
    try { REHEARSAL_MODES.custom.banner = text; } catch (_) { /* */ }
    const b = $("rehearsal-banner");
    if (b) b.textContent = text;
  } else if (typeof sendFenToPlay === "function") {
    sendFenToPlay(fen, side, text);
  }
}

function alnAnalyze() {
  if (!alnBoard || typeof sendFenToPlay !== "function") return;
  sendFenToPlay(alnBoard.getFen(), "white", "Loaded from the Alapin drill — " + (Aln.data ? Aln.data.name : "Alapin") + ".");
}

function alnWire() {
  if (alnWired) return;
  alnWired = true;
  alnBoard = new Board($("aln-board"), { onMove: alnOnMove });
  alnBoard.setOrientation("white");
  alnNav = createNavControls("aln-nav", {
    isActive: () => $("tab-alapin-drill").classList.contains("active"),
    onNav: (dir) => {
      if (Aln.drill) return;
      const n = alnPlies().length;
      if (dir === "start") alnGo(0);
      else if (dir === "prev") alnGo(Aln.ply - 1);
      else if (dir === "next") alnGo(Aln.ply + 1);
      else alnGo(n);
    },
  });
  $("btn-aln-drill").addEventListener("click", () => {
    if (Aln.drill) alnStopDrill("Drill stopped. Finish a line to schedule the next review.");
    else alnStartDrill();
  });
  $("btn-aln-due").addEventListener("click", alnDrillDue);
  $("btn-aln-hint").addEventListener("click", alnHint);
  $("btn-aln-playout").addEventListener("click", () => {
    const box = $("aln-sides");
    box.classList.toggle("hidden");
  });
  $("aln-sides").addEventListener("click", (e) => {
    const b = e.target.closest("[data-side]");
    if (!b) return;
    $("aln-sides").classList.add("hidden");
    alnPlayOut(b.dataset.side);
  });
  $("btn-aln-analyze").addEventListener("click", alnAnalyze);
  $("aln-detail").addEventListener("click", (e) => {
    const jump = e.target.closest(".aln-jump");
    if (jump) {
      if (jump.dataset.opening) {
        const id = jump.dataset.opening;
        switchTab("top10");
        const go = () => { if (typeof top10Select === "function") top10Select(id); };
        if (typeof top10Ready !== "undefined" && top10Ready && top10Ready.then) top10Ready.then(go);
        else go();
      } else if (jump.dataset.tab && typeof switchTab === "function") {
        switchTab(jump.dataset.tab);
      }
      return;
    }
    const show = e.target.closest(".aln-show");
    if (show) alnShowTrap(Number(show.dataset.i));
  });
}

async function initAlapinDrill() {
  if (alnInitDone) return;
  alnInitDone = true;
  try {
    Aln.data = await alnReady;
  } catch (e) {
    alnInitDone = false;
    const host = $("aln-lines");
    if (host) host.textContent = "Could not load the Alapin drill. " + (e && e.message ? e.message : "");
    return;
  }
  const sum = $("aln-summary");
  if (sum && Aln.data.summary) sum.textContent = Aln.data.summary;
  alnWire();
  alnPaintDue();
  if (!Aln.line && Aln.data.lines.length) alnSelect(Aln.data.lines[0].id);
  else {
    alnRenderLines();
    alnRenderDetail();
  }
}
