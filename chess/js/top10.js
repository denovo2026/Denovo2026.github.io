/* top10.js — Top 10 Openings.
   One tab, ten plan cards, a short drill on each line, and spaced
   repetition in localStorage. The board, the nav and "play it out"
   are the same pieces the other opening tabs use. */

const TOP10_SR_KEY = "chesscoach:top10-sr";
const TOP10_STEPS = [1, 3, 7, 14, 30, 60];
const TOP10_TABS = { modern: 1, scotch: 1, alapin: 1, "alapin-drill": 1, grunfeld: 1 };
const TOP10_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const Top10 = {
  data: null,
  opening: null,
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

let top10Board = null;
let top10Nav = null;
let top10Wired = false;

function top10Today() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function top10AddDays(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const p = (x) => (x < 10 ? "0" : "") + x;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function top10DaysUntil(iso) {
  if (!iso) return 0;
  const t = top10Today().split("-").map(Number);
  const b = iso.split("-").map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(t[0], t[1] - 1, t[2])) / 86400000);
}

function top10When(iso) {
  const days = top10DaysUntil(iso);
  if (days <= 0) return "due today";
  if (days === 1) return "due tomorrow";
  return "in " + days + " days";
}

function top10LoadSR() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOP10_SR_KEY) || "");
    if (raw && raw.lines && typeof raw.lines === "object") return raw;
  } catch (_) { /* fresh */ }
  return { lines: {} };
}

function top10SaveSR(sr) {
  try { localStorage.setItem(TOP10_SR_KEY, JSON.stringify(sr)); } catch (_) { /* private mode */ }
}

function top10PlaySan(ch, san) {
  const tries = [san, String(san).replace(/[!?]/g, ""), String(san).replace(/[!?+#]/g, "")];
  for (let i = 0; i < tries.length; i++) {
    try {
      const m = ch.move(tries[i]);
      if (m) return m;
    } catch (_) { /* chess.js throws on illegal */ }
  }
  return null;
}

function top10Expand(moves) {
  if (typeof Chess !== "function") throw new Error("chess.js missing");
  const ch = new Chess();
  const plies = [];
  for (let i = 0; i < moves.length; i++) {
    const m = top10PlaySan(ch, moves[i]);
    if (!m) throw new Error("Illegal move " + moves[i]);
    plies.push({
      san: m.san,
      uci: m.from + m.to + (m.promotion || ""),
      side: m.color === "w" ? "white" : "black",
      fen: ch.fen(),
    });
  }
  return plies;
}

function top10ExpandAll(data) {
  (data.openings || []).forEach((op) => {
    (op.lines || []).forEach((line) => { line.plies = top10Expand(line.moves || []); });
    (op.traps || []).forEach((t) => { if (t.moves && t.moves.length) t.plies = top10Expand(t.moves); });
  });
  return data;
}

const top10Ready = fetch("data/top10.json?v=48").then((r) => {
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}).then(top10ExpandAll);

top10Ready.then((d) => { Top10.data = d; top10PaintDue(); }).catch(() => {});

function top10Me() { return (Top10.opening && Top10.opening.side) || "white"; }

function top10Plies() {
  if (Top10.branch && Top10.branch.plies) return Top10.branch.plies;
  return (Top10.line && Top10.line.plies) || [];
}

function top10FenAt(ply) {
  const plies = top10Plies();
  if (ply <= 0) return TOP10_START;
  return plies[ply - 1].fen;
}

function top10SetStatus(msg, kind) {
  const el = $("top10-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "info-line" + (kind ? " " + kind : "");
}

function top10LineId(op, line) { return op.id + "/" + line.id; }

function top10CountDue() {
  const sr = top10LoadSR();
  const today = top10Today();
  let n = 0;
  let total = 0;
  (Top10.data.openings || []).forEach((op) => {
    (op.lines || []).forEach((line) => {
      total++;
      const rec = sr.lines[top10LineId(op, line)];
      if (!rec || rec.due <= today) n++;
    });
  });
  return { n: n, total: total };
}

function top10PaintDue() {
  if (!Top10.data) return;
  const c = top10CountDue();
  const badge = $("top10-tab-due");
  if (badge) {
    badge.textContent = c.n ? String(c.n) : "";
    badge.classList.toggle("hidden", !c.n);
    badge.title = c.n ? c.n + " line" + (c.n === 1 ? "" : "s") + " due today" : "";
  }
  const chip = $("top10-due");
  if (chip) {
    chip.textContent = "Due today: " + c.n;
    chip.className = "rep-mem " + (c.n ? "miss" : "ok");
    chip.title = "New lines count as due until you drill them. A clean line comes back in 3 days, then 7, 14, 30 and 60. A miss comes back tomorrow.";
  }
  const dueBtn = $("btn-top10-due");
  if (dueBtn) dueBtn.textContent = "Drill due (" + c.n + ")";
}

function top10Mem(op, line) {
  const rec = top10LoadSR().lines[top10LineId(op, line)];
  if (!rec) return { cls: "new", text: "New" };
  const when = top10When(rec.due);
  const mark = rec.lastRight + "/" + rec.lastTotal;
  const ok = rec.lastRight === rec.lastTotal && top10DaysUntil(rec.due) > 0;
  return { cls: ok ? "ok" : "miss", text: mark + " · " + when };
}

function top10OpeningMem(op) {
  const sr = top10LoadSR();
  const today = top10Today();
  let due = 0;
  let next = null;
  op.lines.forEach((line) => {
    const rec = sr.lines[top10LineId(op, line)];
    if (!rec || rec.due <= today) due++;
    else if (!next || rec.due < next) next = rec.due;
  });
  if (due) return { cls: "miss", text: due + " due" };
  return { cls: "ok", text: top10When(next) };
}

function top10Go(n) {
  const plies = top10Plies();
  Top10.ply = Math.max(0, Math.min(plies.length, n));
  if (!top10Board) return;
  top10Board.setFen(top10FenAt(Top10.ply));
  const last = Top10.ply > 0 ? plies[Top10.ply - 1] : null;
  top10Board.setLastMove(last ? last.uci.slice(0, 2) : null, last ? last.uci.slice(2, 4) : null);
  if (!Top10.drill) {
    top10Board.setGuided([]);
    top10Board.clearArrows();
  }
  top10RenderMoves();
  top10RenderLabel();
  if (top10Nav) {
    const on = !Top10.drill;
    top10Nav.update({
      start: on && Top10.ply > 0,
      prev: on && Top10.ply > 0,
      next: on && Top10.ply < plies.length,
      end: on && Top10.ply < plies.length,
    });
  }
}

function top10RenderLabel() {
  const el = $("top10-label");
  if (!el) return;
  if (!Top10.opening) { el.textContent = "Pick an opening."; return; }
  if (Top10.branch) {
    el.textContent = Top10.opening.name + " — " + Top10.branch.name;
    return;
  }
  const who = Top10.opening.side === "white" ? "you play White" : "you play Black";
  el.textContent = Top10.opening.name + " — " + (Top10.line ? Top10.line.name : "") + " · " + who;
}

function top10RenderMoves() {
  const host = $("top10-movebar");
  if (!host) return;
  const plies = top10Plies();
  host.innerHTML = "";
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i];
    const span = document.createElement("span");
    const hidden = Top10.drill && i >= Top10.ply;
    span.className = "rep-move " + p.side + (i < Top10.ply ? " played" : "");
    span.textContent = (i % 2 === 0 ? (i / 2 + 1) + ". " : "") + (hidden ? "…" : p.san);
    if (!Top10.drill) {
      span.addEventListener("click", () => top10Go(i + 1));
    }
    host.appendChild(span);
  }
}

function top10RenderScore() {
  const el = $("top10-score");
  if (!el) return;
  if (!Top10.drill && !Top10.score.asked) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const s = Top10.score;
  const pct = s.asked ? Math.round((100 * s.right) / s.asked) : 0;
  el.innerHTML = '<span class="calc-score-big">' + s.right + "</span>"
    + '<span class="calc-score-unit">of ' + s.asked + " first tries</span>"
    + '<span class="calc-score-sub">' + pct + "%</span>";
}

function top10List(items) {
  if (!items || !items.length) return "";
  return '<ul class="struct-plans">' + items.map((x) => "<li>" + escapeHtml(x) + "</li>").join("") + "</ul>";
}

function top10RenderOpenings() {
  const host = $("top10-openings");
  if (!host || !Top10.data) return;
  host.innerHTML = "";
  Top10.data.openings.forEach((op) => {
    const mem = top10OpeningMem(op);
    const btn = document.createElement("button");
    btn.type = "button";
    const on = Top10.opening && Top10.opening.id === op.id;
    btn.className = "rep-look t10-" + op.side + (on ? " active" : "");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.innerHTML = '<span class="t10-kicker">' + escapeHtml(op.side === "white" ? "White" : "Black")
      + " · " + escapeHtml(op.family) + "</span>"
      + '<span class="ml-head"><strong>' + escapeHtml(op.name) + "</strong></span>"
      + '<span class="ml-tell">' + escapeHtml(op.blurb) + "</span>"
      + '<span class="rep-mem ' + mem.cls + '">' + escapeHtml(mem.text) + "</span>";
    btn.addEventListener("click", () => top10Select(op.id));
    host.appendChild(btn);
  });
}

function top10RenderLines() {
  const host = $("top10-lines");
  if (!host) return;
  host.innerHTML = "";
  if (!Top10.opening) return;
  Top10.opening.lines.forEach((line) => {
    const mem = top10Mem(Top10.opening, line);
    const btn = document.createElement("button");
    btn.type = "button";
    const on = Top10.line && Top10.line.id === line.id && !Top10.branch;
    btn.className = "t10-line" + (on ? " active" : "");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.innerHTML = escapeHtml(line.name) + '<span class="rep-mem ' + mem.cls + '">' + escapeHtml(mem.text) + "</span>";
    btn.title = line.note || "";
    btn.addEventListener("click", () => top10Select(Top10.opening.id, line.id));
    host.appendChild(btn);
  });
}

function top10RenderDetail() {
  const op = Top10.opening;
  const title = $("top10-card-title");
  const host = $("top10-detail");
  if (!op || !host) return;
  if (title) title.textContent = op.name;
  const you = op.side === "white" ? "white" : "black";
  const them = you === "white" ? "black" : "white";
  const youName = you === "white" ? "White" : "Black";
  const themName = them === "white" ? "White" : "Black";
  let html = '<div class="struct-head">'
    + '<span class="chip verified">' + escapeHtml(youName) + " · you</span>"
    + '<span class="chip">' + escapeHtml(op.family) + "</span>"
    + '<span class="chip">' + escapeHtml(op.eco || "") + "</span></div>";
  html += "<h4 class='sub-head'>The tell</h4><div class='coach-box'>" + escapeHtml(op.tell) + "</div>";
  html += "<h4 class='sub-head'>Pawn structure</h4><p class='info-line'>" + escapeHtml(op.structure) + "</p>";
  html += "<h4 class='sub-head'>Where the pieces go</h4>" + top10List(op.pieces);
  html += "<h4 class='sub-head'>Your plan</h4>" + top10List(op.plans && op.plans[you]);
  html += "<h4 class='sub-head'>What " + themName + " wants</h4>" + top10List(op.plans && op.plans[them]);
  html += "<h4 class='sub-head'>Pawn breaks</h4>" + top10List(op.breaks);
  if (op.traps && op.traps.length) {
    html += "<h4 class='sub-head'>Traps and tactics</h4>";
    op.traps.forEach((t, i) => {
      html += '<div class="rep-tactic"><div class="mt-head"><strong>' + escapeHtml(t.name) + "</strong>";
      if (t.plies && t.plies.length) {
        html += '<button type="button" class="btn mt-show t10-show" data-i="' + i + '">Show it</button>';
      }
      html += "</div><div>" + escapeHtml(t.point) + "</div></div>";
    });
  }
  if (op.links && op.links.length) {
    html += "<h4 class='sub-head'>In your repertoire</h4>";
    op.links.forEach((L) => {
      const note = escapeHtml(L.note || "");
      let btn = "";
      if (L.tab && TOP10_TABS[L.tab]) {
        btn = ' <button type="button" class="btn mini t10-jump" data-tab="' + escapeHtml(L.tab) + '">'
          + escapeHtml(L.label) + "</button>";
      } else if (L.opening && Top10.data.openings.some((o) => o.id === L.opening)) {
        btn = ' <button type="button" class="btn mini t10-jump" data-opening="' + escapeHtml(L.opening) + '">'
          + escapeHtml(L.label) + "</button>";
      }
      html += '<p class="info-line">' + note + btn + "</p>";
    });
  }
  if (op.games && op.games.length) {
    html += "<h4 class='sub-head'>Model games</h4><ul class='struct-plans'>";
    op.games.forEach((g) => {
      const note = g.note ? " — " + escapeHtml(g.note) : "";
      const link = (g.url && /^https:\/\//.test(g.url))
        ? ' <a href="' + escapeHtml(g.url) + '" target="_blank" rel="noopener">game &#x2197;</a>' : "";
      html += "<li>" + escapeHtml(g.title) + note + link + "</li>";
    });
    html += "</ul>";
  }
  if (Top10.line && Top10.line.note) {
    html += "<h4 class='sub-head'>This line</h4><p class='info-line'>" + escapeHtml(Top10.line.note) + "</p>";
  }
  host.innerHTML = html;
}

function top10Select(id, lineId) {
  const op = (Top10.data.openings || []).find((o) => o.id === id);
  if (!op) return;
  Top10.drill = false;
  Top10.branch = null;
  Top10.first = {};
  Top10.hinted = {};
  Top10.misses = {};
  Top10.score = { asked: 0, right: 0 };
  const drillBtn = $("btn-top10-drill");
  if (drillBtn) drillBtn.textContent = "Drill this line";
  const hint = $("btn-top10-hint");
  if (hint) hint.disabled = true;
  Top10.opening = op;
  Top10.line = op.lines.find((l) => l.id === lineId) || op.lines[0];
  if (top10Board) top10Board.setOrientation(op.side);
  $("top10-sides").classList.add("hidden");
  $("top10-score").classList.add("hidden");
  top10RenderOpenings();
  top10RenderLines();
  top10RenderDetail();
  top10Go(0);
  top10SetStatus("Step through the line, drill your moves, or play the final position out.");
  const card = $("top10-openings") && $("top10-openings").querySelector(".rep-look.active");
  if (card && card.scrollIntoView) {
    try { card.scrollIntoView({ inline: "nearest", block: "nearest" }); } catch (_) { /* */ }
  }
}

function top10ShowTrap(i) {
  const t = Top10.opening && Top10.opening.traps[i];
  if (!t || !t.plies) return;
  Top10.drill = false;
  const drillBtn = $("btn-top10-drill");
  if (drillBtn) drillBtn.textContent = "Drill this line";
  const hint = $("btn-top10-hint");
  if (hint) hint.disabled = true;
  Top10.branch = t;
  top10RenderLines();
  top10Go(t.plies.length);
  top10SetStatus(t.name + ". Step back through it with the arrows. Pick a line again for the drill.");
}

function top10StopDrill(msg) {
  Top10.drill = false;
  const drillBtn = $("btn-top10-drill");
  if (drillBtn) drillBtn.textContent = "Drill this line";
  const hint = $("btn-top10-hint");
  if (hint) hint.disabled = true;
  if (top10Board) { top10Board.setGuided([]); top10Board.clearArrows(); }
  if (msg) top10SetStatus(msg);
  top10Go(Top10.ply);
}

function top10Advance(justSan) {
  const plies = top10Plies();
  const me = top10Me();
  while (Top10.ply < plies.length && plies[Top10.ply].side !== me) Top10.ply++;
  top10Go(Top10.ply);
  if (!Top10.drill) return;
  if (Top10.ply >= plies.length) { top10Finish(); return; }
  const n = Math.floor(Top10.ply / 2) + 1;
  const who = me === "white" ? "White" : "Black";
  const prefix = justSan ? justSan + " — that's the move. " : "";
  top10SetStatus(prefix + who + " to play, move " + n + ". Find the book move.", justSan ? "good" : "");
}

function top10StartDrill() {
  if (!Top10.line || !Top10.line.plies) return;
  Top10.branch = null;
  Top10.drill = true;
  Top10.first = {};
  Top10.hinted = {};
  Top10.misses = {};
  Top10.score = { asked: 0, right: 0 };
  Top10.ply = 0;
  const drillBtn = $("btn-top10-drill");
  if (drillBtn) drillBtn.textContent = "Stop drill";
  const hint = $("btn-top10-hint");
  if (hint) hint.disabled = false;
  top10RenderLines();
  top10RenderScore();
  top10Go(0);
  top10Advance();
}

function top10Schedule(right, total) {
  const id = top10LineId(Top10.opening, Top10.line);
  const sr = top10LoadSR();
  const r = sr.lines[id] || { step: -1, attempts: 0 };
  r.attempts = (r.attempts || 0) + 1;
  r.name = Top10.opening.name + " — " + Top10.line.name;
  r.lastRight = right;
  r.lastTotal = total;
  r.lastAt = new Date().toISOString();
  if (total > 0 && right === total) {
    const prev = (r.step == null || r.step < 0) ? 0 : r.step;
    r.step = Math.min(TOP10_STEPS.length - 1, Math.max(1, prev + 1));
  } else {
    r.step = 0;
  }
  r.interval = TOP10_STEPS[Math.max(0, r.step)];
  r.due = top10AddDays(r.interval);
  sr.lines[id] = r;
  top10SaveSR(sr);
  return r;
}

function top10Finish() {
  const plies = Top10.line.plies;
  const me = top10Me();
  const mine = [];
  for (let i = 0; i < plies.length; i++) if (plies[i].side === me) mine.push(i);
  const total = mine.length;
  const right = mine.filter((i) => Top10.first[i]).length;
  const rec = top10Schedule(right, total);
  Top10.drill = false;
  const drillBtn = $("btn-top10-drill");
  if (drillBtn) drillBtn.textContent = "Drill this line";
  const hint = $("btn-top10-hint");
  if (hint) hint.disabled = true;
  if (top10Board) { top10Board.setGuided([]); top10Board.clearArrows(); }
  const clean = right === total;
  top10SetStatus(right + " of " + total + " on the first try. "
    + (clean ? "Next review in " + rec.interval + " days." : "Missed — back tomorrow."),
    clean ? "good" : "warn");
  top10RenderScore();
  top10PaintDue();
  top10RenderOpenings();
  top10RenderLines();
  top10Go(plies.length);
}

function top10Hint() {
  if (!Top10.drill) return;
  const want = top10Plies()[Top10.ply];
  if (!want || want.side !== top10Me()) return;
  Top10.hinted[Top10.ply] = true;
  const from = want.uci.slice(0, 2);
  const to = want.uci.slice(2, 4);
  top10Board.setGuided([from, to]);
  top10Board.setArrows([{ from: from, to: to, color: "green" }]);
  top10SetStatus("Hint: " + want.san + ". It will not count as a first try.", "warn");
}

function top10OnMove(from, to) {
  if (!Top10.drill || Top10.busy) return;
  const plies = top10Plies();
  const want = plies[Top10.ply];
  if (!want || want.side !== top10Me()) return;
  const guess = uciCandidate(top10Board, from, to);
  Top10.busy = true;
  try {
    if (guess === want.uci) {
      const unseen = !(Top10.ply in Top10.first);
      if (unseen) {
        const clean = !Top10.hinted[Top10.ply];
        Top10.first[Top10.ply] = clean;
        Top10.score.asked++;
        if (clean) Top10.score.right++;
      }
      Top10.ply++;
      top10Board.setGuided([]);
      top10Board.clearArrows();
      top10RenderScore();
      top10Advance(want.san);
    } else {
      Top10.misses[Top10.ply] = (Top10.misses[Top10.ply] || 0) + 1;
      if (!(Top10.ply in Top10.first)) {
        Top10.first[Top10.ply] = false;
        Top10.score.asked++;
      }
      top10RenderScore();
      if (Top10.misses[Top10.ply] >= 2) {
        top10Board.setGuided([want.uci.slice(0, 2), want.uci.slice(2, 4)]);
        top10SetStatus("Not that. The move is " + want.san + ".", "warn");
      } else {
        top10SetStatus("Not the book move. Look at the plan, then try again.", "warn");
      }
    }
  } finally {
    Top10.busy = false;
  }
}

function top10DrillDue() {
  if (!Top10.data) return;
  const sr = top10LoadSR();
  const today = top10Today();
  const items = [];
  let index = 0;
  Top10.data.openings.forEach((op) => {
    op.lines.forEach((line) => {
      const rec = sr.lines[top10LineId(op, line)];
      let rank = 3;
      if (!rec) rank = 1;
      else if (rec.due <= today && rec.lastRight < rec.lastTotal) rank = 0;
      else if (rec.due <= today) rank = 2;
      items.push({ op: op, line: line, rec: rec, rank: rank, due: rec ? rec.due : "", index: index++ });
    });
  });
  items.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 1) return a.index - b.index;
    if (a.due !== b.due) return a.due < b.due ? -1 : 1;
    return a.index - b.index;
  });
  const pick = items[0];
  if (!pick) return;
  top10Select(pick.op.id, pick.line.id);
  top10StartDrill();
  const why = pick.rank === 0 ? "You missed this one. "
    : pick.rank === 1 ? "A new line. "
    : pick.rank === 2 ? "Due for review. "
    : "Nothing is due — drilling the next line anyway. ";
  const cur = $("top10-status").textContent;
  top10SetStatus(why + pick.op.name + ", " + pick.line.name + ". " + cur);
}

function top10EndFen() {
  const plies = Top10.line && Top10.line.plies;
  if (!plies || !plies.length) return TOP10_START;
  return plies[plies.length - 1].fen;
}

function top10PlayOut(side) {
  if (!Top10.opening || !Top10.line) return;
  const fen = top10EndFen();
  const plan = (Top10.opening.plans && Top10.opening.plans[side] && Top10.opening.plans[side][0]) || "";
  const who = side === "white" ? "White" : "Black";
  const text = Top10.opening.name + " · " + Top10.line.name
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

function top10Analyze() {
  if (!top10Board || typeof sendFenToPlay !== "function") return;
  const side = top10Me();
  const name = Top10.opening ? Top10.opening.name : "Top 10";
  sendFenToPlay(top10Board.getFen(), side, "Loaded from Top 10 — " + name + ".");
}

function top10Wire() {
  if (top10Wired) return;
  top10Wired = true;
  top10Board = new Board($("top10-board"), { onMove: top10OnMove });
  top10Board.setOrientation("white");
  top10Nav = createNavControls("top10-nav", {
    isActive: () => $("tab-top10").classList.contains("active"),
    onNav: (dir) => {
      if (Top10.drill) return;
      const n = top10Plies().length;
      if (dir === "start") top10Go(0);
      else if (dir === "prev") top10Go(Top10.ply - 1);
      else if (dir === "next") top10Go(Top10.ply + 1);
      else top10Go(n);
    },
  });
  $("btn-top10-drill").addEventListener("click", () => {
    if (Top10.drill) top10StopDrill("Drill stopped. Finish a line to schedule the next review.");
    else top10StartDrill();
  });
  $("btn-top10-due").addEventListener("click", top10DrillDue);
  $("btn-top10-hint").addEventListener("click", top10Hint);
  $("btn-top10-playout").addEventListener("click", () => {
    const box = $("top10-sides");
    box.classList.toggle("hidden");
    if (!box.classList.contains("hidden") && Top10.opening) {
      box.querySelectorAll("[data-side]").forEach((b) => {
        b.classList.toggle("primary", b.dataset.side === Top10.opening.side);
      });
    }
  });
  $("top10-sides").addEventListener("click", (e) => {
    const b = e.target.closest("[data-side]");
    if (!b) return;
    $("top10-sides").classList.add("hidden");
    top10PlayOut(b.dataset.side);
  });
  $("btn-top10-analyze").addEventListener("click", top10Analyze);
  $("top10-detail").addEventListener("click", (e) => {
    const jump = e.target.closest(".t10-jump");
    if (jump) {
      if (jump.dataset.tab && typeof switchTab === "function") switchTab(jump.dataset.tab);
      else if (jump.dataset.opening) top10Select(jump.dataset.opening);
      return;
    }
    const show = e.target.closest(".t10-show");
    if (show) top10ShowTrap(Number(show.dataset.i));
  });
}

async function initTop10() {
  try {
    Top10.data = await top10Ready;
  } catch (e) {
    const host = $("top10-openings");
    if (host) host.textContent = "Could not load the openings. " + (e && e.message ? e.message : "");
    return;
  }
  const sum = $("top10-summary");
  if (sum && Top10.data.summary) sum.textContent = Top10.data.summary;
  top10Wire();
  top10PaintDue();
  if (!Top10.opening && Top10.data.openings.length) top10Select(Top10.data.openings[0].id);
  else {
    top10RenderOpenings();
    top10RenderLines();
  }
}
