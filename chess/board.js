/* board.js — Board class: render from FEN, click-click AND drag moves,
   last-move highlight, arrows (SVG overlay), coordinates on edges.
   No client-side move generation: candidates are reported via onMove and
   validated by the backend /api/move endpoint. */

const FILES = "abcdefgh";

/* muted categorical palette for numbered next-move arrows */
const NUMBERED_COLORS = ["#c98f2e", "#7a9a6d", "#c07a5a", "#6d7f8f", "#96708a"];

/* neutral warm gray for opponent moves inside a plan overlay */
const OPP_ARROW_COLOR = "#8a8378";

function algToXY(sq, orientation) {
  const f = FILES.indexOf(sq[0]);
  const r = parseInt(sq[1], 10);
  const col = orientation === "white" ? f : 7 - f;
  const row = orientation === "white" ? 8 - r : r - 1;
  return { col, row };
}

function xyToAlg(col, row, orientation) {
  const f = orientation === "white" ? col : 7 - col;
  const r = orientation === "white" ? 8 - row : row + 1;
  return FILES[f] + r;
}

class Board {
  constructor(container, opts) {
    opts = opts || {};
    this.container = container;
    this.onMove = opts.onMove || null;      // (from, to) => void  (UCI, promotion auto-appended by caller path)
    this.onSelect = opts.onSelect || null;  // (sq|null) => void
    this.orientation = opts.orientation || "white";
    this.interactive = opts.interactive !== false;
    this.fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    this.position = {}; // sq -> piece code e.g. "wK"
    this.selected = null;
    this.lastMove = null; // {from,to}
    this.arrows = [];     // [{from,to,color}]
    this.numberedArrows = []; // [{from,to,idx,color}] — numbered next-moves overlay
    this.planArrows = []; // [{from,to,seq,dim,num?,color?}] — strategy-plan overlay
    this.marked = [];     // squares with extra mark (e.g. targets)
    this.guided = [];     // squares with the guided-line glow (rehearsal)
    this._drag = null;

    this.container.classList.add("board-wrap");
    this.el = document.createElement("div");
    this.el.className = "board";
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("class", "board-arrows");
    this.svg.setAttribute("viewBox", "0 0 8 8");
    this.container.innerHTML = "";
    this.container.appendChild(this.el);
    this.container.appendChild(this.svg);

    this.squares = {}; // sq -> div
    this._build();
    this.setFen(this.fen);
    this._bind();
  }

  _build() {
    this.el.innerHTML = "";
    this.squares = {};
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = xyToAlg(col, row, this.orientation);
        const d = document.createElement("div");
        d.className = "sq " + (((col + row) % 2 === 0) ? "light" : "dark");
        d.dataset.sq = sq;
        // coordinates on edges
        if (col === 0) {
          const s = document.createElement("span");
          s.className = "coord rank";
          s.textContent = sq[1];
          d.appendChild(s);
        }
        if (row === 7) {
          const s = document.createElement("span");
          s.className = "coord file";
          s.textContent = sq[0];
          d.appendChild(s);
        }
        const piece = document.createElement("div");
        piece.className = "piece";
        d.appendChild(piece);
        this.el.appendChild(d);
        this.squares[sq] = d;
      }
    }
    this._renderPieces();
    this._renderArrows();
  }

  setFen(fen) {
    this.fen = fen;
    this.position = {};
    const placement = fen.split(" ")[0];
    const rows = placement.split("/");
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of rows[r]) {
        if (/\d/.test(ch)) { f += parseInt(ch, 10); }
        else {
          const color = ch === ch.toUpperCase() ? "w" : "b";
          this.position[FILES[f] + (8 - r)] = color + ch.toUpperCase();
          f++;
        }
      }
    }
    this._renderPieces();
  }

  getFen() { return this.fen; }

  pieceAt(sq) { return this.position[sq] || null; }

  sideToMove() { return (this.fen.split(" ")[1] || "w"); }

  _renderPieces() {
    for (const sq in this.squares) {
      const holder = this.squares[sq].querySelector(".piece");
      const code = this.position[sq];
      holder.innerHTML = code && PIECES[code] ? PIECES[code] : "";
      holder.dataset.piece = code || "";
    }
    // re-apply highlights
    for (const sq in this.squares) {
      this.squares[sq].classList.remove("last-from", "last-to", "selected", "marked", "guided");
    }
    if (this.lastMove) {
      if (this.squares[this.lastMove.from]) this.squares[this.lastMove.from].classList.add("last-from");
      if (this.squares[this.lastMove.to]) this.squares[this.lastMove.to].classList.add("last-to");
    }
    if (this.selected && this.squares[this.selected]) this.squares[this.selected].classList.add("selected");
    for (const sq of this.marked) if (this.squares[sq]) this.squares[sq].classList.add("marked");
    for (const sq of this.guided) if (this.squares[sq]) this.squares[sq].classList.add("guided");
  }

  setInteractive(v) {
    this.interactive = v;
    this.el.classList.toggle("non-interactive", !v);
    if (!v) this._clearSelection();
  }

  setOrientation(o) {
    if (o !== "white" && o !== "black") return;
    if (o === this.orientation) return;
    this.orientation = o;
    this._build();
  }

  flip() { this.setOrientation(this.orientation === "white" ? "black" : "white"); }

  setLastMove(from, to) {
    this.lastMove = from && to ? { from, to } : null;
    this._renderPieces();
  }

  setMarked(sqs) {
    this.marked = sqs || [];
    this._renderPieces();
  }

  /* guided-rehearsal glow: pulsing highlight on the prescribed move's
     from/to squares (same re-render path as setMarked) */
  setGuided(sqs) {
    this.guided = sqs || [];
    this._renderPieces();
  }

  setArrows(arrows) {
    this.arrows = arrows || [];
    this.numberedArrows = [];
    this.planArrows = [];
    this._renderArrows();
  }

  clearArrows() { this.setArrows([]); }

  /* Draw up to `count` moves (UCI strings) as simultaneously visible arrows,
     each tagged with a small numbered disc (1..count) at the arrow midpoint.
     Arrows get slight alternating arc offsets so overlapping lines stay readable. */
  drawNumberedMoves(movesUci, count) {
    const n = Math.min(count || 5, (movesUci || []).length, NUMBERED_COLORS.length);
    this.numberedArrows = [];
    this.planArrows = [];
    for (let i = 0; i < n; i++) {
      const u = movesUci[i];
      if (!u || u.length < 4) continue;
      this.numberedArrows.push({ from: u.slice(0, 2), to: u.slice(2, 4), idx: i, color: NUMBERED_COLORS[i] });
    }
    this._renderArrows();
  }

  /* Draw a strategic plan (/api/strategy/plan): EVERY move of mainLine as an
     arrow. Bottom-side moves get numbered discs (1..N, palette) at full
     opacity; opponent moves are drawn dimmer (thinner, ~35% opacity, neutral
     gray). mainLine: [{uci, san, side}] with side "white"|"black".
     opts: { bottomSide } — defaults to the first move's side.
     Renders correctly in both orientations (geometry goes through algToXY). */
  drawPlan(mainLine, opts) {
    opts = opts || {};
    const line = mainLine || [];
    const bottomSide = opts.bottomSide || (line[0] && line[0].side) || "white";
    this.numberedArrows = [];
    this.planArrows = [];
    let n = 0;
    for (let i = 0; i < line.length; i++) {
      const m = line[i];
      const u = m && m.uci;
      if (!u || u.length < 4) continue;
      const mine = m.side === bottomSide;
      const a = { from: u.slice(0, 2), to: u.slice(2, 4), seq: i, dim: !mine };
      if (mine) {
        const ci = n % NUMBERED_COLORS.length;
        a.num = n + 1;
        a.color = NUMBERED_COLORS[ci];
        a.marker = "ahn-" + ci;
        n++;
      }
      this.planArrows.push(a);
    }
    this._renderArrows();
  }

  shake() {
    this.el.classList.remove("shake");
    void this.el.offsetWidth; // restart animation
    this.el.classList.add("shake");
  }

  _renderArrows() {
    const NS = "http://www.w3.org/2000/svg";
    this.svg.innerHTML =
      '<defs>' +
      ["green", "red", "amber", "blue", "opp"].map(c =>
        `<marker id="ah-${c}" markerWidth="4" markerHeight="4" refX="2.05" refY="1.25" orient="auto">` +
        `<path d="M0,0 L2.5,1.25 L0,2.5 Z" class="arrowhead ${c}"></path></marker>`).join("") +
      NUMBERED_COLORS.map((c, i) =>
        `<marker id="ahn-${i}" markerWidth="4" markerHeight="4" refX="2.05" refY="1.25" orient="auto">` +
        `<path d="M0,0 L2.5,1.25 L0,2.5 Z" fill="${c}"></path></marker>`).join("") +
      "</defs>";
    for (const a of this.arrows) {
      const p1 = algToXY(a.from, this.orientation);
      const p2 = algToXY(a.to, this.orientation);
      let x1 = p1.col + 0.5, y1 = p1.row + 0.5, x2 = p2.col + 0.5, y2 = p2.row + 0.5;
      // shorten the line so the head lands inside the target square
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      x2 -= (dx / len) * 0.18; y2 -= (dy / len) * 0.18;
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", x1); line.setAttribute("y1", y1);
      line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      line.setAttribute("class", "arrow " + (a.color || "green"));
      line.setAttribute("marker-end", `url(#ah-${a.color || "green"})`);
      this.svg.appendChild(line);
    }
    /* arced arrow geometry: slight alternating bend (by index k) so overlapping
       arrows fan out. Returns the path "d" and the curve midpoint (bx,by). */
    const arcGeom = (from, to, k) => {
      const p1 = algToXY(from, this.orientation);
      const p2 = algToXY(to, this.orientation);
      const x1 = p1.col + 0.5, y1 = p1.row + 0.5;
      let x2 = p2.col + 0.5, y2 = p2.row + 0.5;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      x2 -= (dx / len) * 0.2; y2 -= (dy / len) * 0.2;
      const bend = (k % 2 === 0 ? 1 : -1) * (0.05 + 0.06 * Math.floor(k / 2)) * Math.min(len, 3);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const cx = mx - (dy / len) * bend, cy = my + (dx / len) * bend;
      return {
        d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`,
        bx: 0.25 * x1 + 0.5 * cx + 0.25 * x2,
        by: 0.25 * y1 + 0.5 * cy + 0.25 * y2,
      };
    };
    const addDisc = (bx, by, color, label) => {
      const disc = document.createElementNS(NS, "circle");
      disc.setAttribute("cx", bx); disc.setAttribute("cy", by);
      disc.setAttribute("r", "0.21");
      disc.setAttribute("fill", color);
      disc.setAttribute("class", "arrow-disc");
      this.svg.appendChild(disc);
      const txt = document.createElementNS(NS, "text");
      txt.setAttribute("x", bx); txt.setAttribute("y", by);
      txt.setAttribute("class", "arrow-num");
      txt.textContent = label;
      this.svg.appendChild(txt);
    };
    // numbered next-move arrows: slightly arced paths + numbered disc at midpoint
    for (const a of this.numberedArrows) {
      const g = arcGeom(a.from, a.to, a.idx);
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", g.d);
      path.setAttribute("class", "arrow numbered");
      path.setAttribute("stroke", a.color);
      path.setAttribute("fill", "none");
      path.setAttribute("marker-end", `url(#ahn-${a.idx})`);
      this.svg.appendChild(path);
      addDisc(g.bx, g.by, a.color, String(a.idx + 1));
    }
    // strategy-plan arrows: full line — bottom-side moves numbered, opponent dim
    for (const a of this.planArrows) {
      const g = arcGeom(a.from, a.to, a.seq);
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", g.d);
      path.setAttribute("fill", "none");
      if (a.dim) {
        path.setAttribute("class", "arrow opp");
        path.setAttribute("marker-end", "url(#ah-opp)");
      } else {
        path.setAttribute("class", "arrow plan");
        path.setAttribute("stroke", a.color);
        path.setAttribute("marker-end", `url(#${a.marker})`);
      }
      this.svg.appendChild(path);
      if (!a.dim) addDisc(g.bx, g.by, a.color, String(a.num));
    }
  }

  _clearSelection() {
    this.selected = null;
    this._renderPieces();
    if (this.onSelect) this.onSelect(null);
  }

  _squareFromEvent(e) {
    const t = e.target.closest ? e.target.closest(".sq") : null;
    return t ? t.dataset.sq : null;
  }

  _bind() {
    // click-click
    this.el.addEventListener("click", (e) => {
      if (!this.interactive || this._dragged) { this._dragged = false; return; }
      const sq = this._squareFromEvent(e);
      if (!sq) return;
      if (this.selected && sq !== this.selected) {
        const from = this.selected;
        this._clearSelection();
        if (this.onMove) this.onMove(from, sq);
        return;
      }
      if (this.selected === sq) { this._clearSelection(); return; }
      if (this.position[sq]) {
        this.selected = sq;
        this._renderPieces();
        if (this.onSelect) this.onSelect(sq);
      }
    });

    // drag & drop
    this.el.addEventListener("mousedown", (e) => {
      if (!this.interactive || e.button !== 0) return;
      const sq = this._squareFromEvent(e);
      if (!sq || !this.position[sq]) return;
      const rect = this.el.getBoundingClientRect();
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.innerHTML = PIECES[this.position[sq]];
      ghost.style.width = rect.width / 8 + "px";
      ghost.style.height = rect.height / 8 + "px";
      document.body.appendChild(ghost);
      this._drag = { from: sq, ghost, rect };
      moveGhost(e);
      e.preventDefault();
    });

    const moveGhost = (e) => {
      if (!this._drag) return;
      const size = this._drag.rect.width / 8;
      this._drag.ghost.style.left = (e.clientX - size / 2) + "px";
      this._drag.ghost.style.top = (e.clientY - size / 2) + "px";
    };

    document.addEventListener("mousemove", moveGhost);
    document.addEventListener("mouseup", (e) => {
      if (!this._drag) return;
      const drag = this._drag;
      drag.ghost.remove();
      this._drag = null;
      const rect = this.el.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;
      const col = Math.floor(x / (rect.width / 8));
      const row = Math.floor(y / (rect.height / 8));
      const to = xyToAlg(col, row, this.orientation);
      if (to === drag.from) { this._dragged = false; return; }
      this._dragged = true; // suppress the click that follows mouseup
      this._clearSelection();
      if (this.onMove) this.onMove(drag.from, to);
    });
  }
}

/* Helper: build a UCI candidate, auto-promoting to queen when a pawn
   reaches the last rank (backend validates legality regardless). */
function uciCandidate(board, from, to) {
  const piece = board.pieceAt(from);
  let uci = from + to;
  if (piece && piece[1] === "P" && (to[1] === "8" || to[1] === "1")) uci += "q";
  return uci;
}
