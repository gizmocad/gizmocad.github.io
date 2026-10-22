// Sketch constraints: dimensions and geometric rules (horizontal, parallel,
// tangent, …) that a drawing keeps to. After every change the solver nudges
// the constrained shapes, as little as possible, until every rule holds; the
// numbers the user just changed are held (almost) still so their edit wins.

import type { Point2, SketchConstraint, SketchEntity, SketchRef } from "./model";
import { ngonPoints, rectCorners } from "./sketchGeometry";

type P = Point2;
const DEG = Math.PI / 180;

// ---- Geometry an entity offers to constraints ---------------------------------

/** Points: rect corners 0–3 and centre 4; circle/ellipse centre 0; n-gon centre 0 then corners; slot ends; polygon/curve points; line ends. */
export function refPoints(e: SketchEntity): P[] {
  switch (e.type) {
    case "rect": {
      const c = rectCorners(e);
      return [...c, [e.x, e.y]];
    }
    case "circle":
    case "ellipse":
      return [[e.x, e.y]];
    case "ngon":
      return [[e.x, e.y], ...ngonPoints(e)];
    case "slot":
      return [[e.x1, e.y1], [e.x2, e.y2]];
    case "polygon":
    case "spline":
    case "stroke":
      return e.points.map((p) => [p[0], p[1]] as P);
    case "point":
      return [[e.x, e.y]];
    case "line":
      return [[e.x1, e.y1], [e.x2, e.y2]];
  }
}

/** Straight edges: rect and n-gon sides, polygon sides (as their chord), a line. */
export function refEdges(e: SketchEntity): [P, P][] {
  const loop = (pts: P[]) => pts.map((p, i) => [p, pts[(i + 1) % pts.length]] as [P, P]);
  switch (e.type) {
    case "rect":
      return loop(rectCorners(e));
    case "ngon":
      return loop(ngonPoints(e));
    case "polygon":
      return loop(e.points);
    case "line":
      return [[[e.x1, e.y1], [e.x2, e.y2]]];
    default:
      return [];
  }
}

/** Circles: a circle; a slot's two round ends. */
export function refCircles(e: SketchEntity): { c: P; r: number }[] {
  if (e.type === "circle") return [{ c: [e.x, e.y], r: e.radius }];
  if (e.type === "slot") return [{ c: [e.x1, e.y1], r: e.radius }, { c: [e.x2, e.y2], r: e.radius }];
  return [];
}

type Resolved = { kind: "point"; p: P } | { kind: "edge"; a: P; b: P } | { kind: "circle"; c: P; r: number };

function resolve(entities: Map<string, SketchEntity>, ref: SketchRef): Resolved | null {
  const e = entities.get(ref.entity);
  if (!e) return null;
  if (ref.kind === "point") {
    const p = refPoints(e)[ref.index];
    return p ? { kind: "point", p } : null;
  }
  if (ref.kind === "edge") {
    const ed = refEdges(e)[ref.index];
    return ed ? { kind: "edge", a: ed[0], b: ed[1] } : null;
  }
  const c = refCircles(e)[ref.index];
  return c ? { kind: "circle", c: c.c, r: c.r } : null;
}

// ---- What each constraint asks for -----------------------------------------------

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const len = (v: P) => Math.hypot(v[0], v[1]);
const cross = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
/** Angles count as much as this many mm, so both kinds of error weigh about the same. */
const ANGLE_SCALE = 20;

/** Signed distance from p to the infinite line through a, b. */
function lineDistance(p: P, a: P, b: P): number {
  const d = sub(b, a);
  const l = len(d) || 1e-12;
  return cross(d, sub(p, a)) / l;
}

/** The errors (0 when satisfied) of one constraint; null if its geometry is gone or doesn't fit. */
function residuals(c: SketchConstraint, g: Resolved[]): number[] | null {
  const [a, b] = g;
  const edgeDir = (r: Resolved): P | null => (r.kind === "edge" ? sub(r.b, r.a) : null);
  switch (c.type) {
    case "horizontal":
    case "vertical": {
      const i = c.type === "horizontal" ? 1 : 0;
      if (g.length === 1 && a.kind === "edge") return [a.b[i] - a.a[i]];
      if (g.length === 2 && a.kind === "point" && b.kind === "point") return [b.p[i] - a.p[i]];
      return null;
    }
    case "parallel":
    case "perpendicular": {
      const [d1, d2] = [edgeDir(a), b && edgeDir(b)];
      if (!d1 || !d2) return null;
      const l = len(d1) * len(d2) || 1e-12;
      return [((c.type === "parallel" ? cross(d1, d2) : dot(d1, d2)) / l) * ANGLE_SCALE];
    }
    case "equal": {
      if (a?.kind === "edge" && b?.kind === "edge") return [len(sub(a.b, a.a)) - len(sub(b.b, b.a))];
      if (a?.kind === "circle" && b?.kind === "circle") return [a.r - b.r];
      return null;
    }
    case "tangent": {
      const edge = g.find((x) => x.kind === "edge") as Extract<Resolved, { kind: "edge" }> | undefined;
      const circles = g.filter((x) => x.kind === "circle") as Extract<Resolved, { kind: "circle" }>[];
      if (edge && circles.length === 1) return [Math.abs(lineDistance(circles[0].c, edge.a, edge.b)) - circles[0].r];
      if (circles.length === 2) {
        const d = len(sub(circles[0].c, circles[1].c));
        // value −1: one inside the other (internal), else side by side.
        return [c.value === -1 ? d - Math.abs(circles[0].r - circles[1].r) : d - (circles[0].r + circles[1].r)];
      }
      return null;
    }
    case "coincident": {
      const pt = g.find((x) => x.kind === "point") as Extract<Resolved, { kind: "point" }> | undefined;
      const other = g.find((x) => x !== pt);
      if (!pt || !other) return null;
      if (other.kind === "point") return [other.p[0] - pt.p[0], other.p[1] - pt.p[1]];
      if (other.kind === "edge") return [lineDistance(pt.p, other.a, other.b)];
      return [len(sub(pt.p, other.c)) - other.r];
    }
    case "distance": {
      const v = c.value ?? 0;
      if (a?.kind === "point" && b?.kind === "point") return [len(sub(b.p, a.p)) - v];
      const pt = g.find((x) => x.kind === "point") as Extract<Resolved, { kind: "point" }> | undefined;
      const edge = g.find((x) => x.kind === "edge") as Extract<Resolved, { kind: "edge" }> | undefined;
      if (pt && edge) return [Math.abs(lineDistance(pt.p, edge.a, edge.b)) - v];
      return null;
    }
    case "length":
      return a?.kind === "edge" ? [len(sub(a.b, a.a)) - (c.value ?? 0)] : null;
    case "diameter":
      return a?.kind === "circle" ? [2 * a.r - (c.value ?? 0)] : null;
    case "angle": {
      const [d1, d2] = [edgeDir(a), b && edgeDir(b)];
      if (!d1 || !d2) return null;
      const angle = Math.atan2(Math.abs(cross(d1, d2)), dot(d1, d2));
      return [(angle - (c.value ?? 0) * DEG) * ANGLE_SCALE];
    }
    case "fix":
      return a?.kind === "point" && c.at ? [a.p[0] - c.at[0], a.p[1] - c.at[1]] : null;
  }
}

/** Is this constraint about this geometry (the right kinds of thing, in a sensible number)? */
export function constraintFits(type: SketchConstraint["type"], refs: SketchRef[]): boolean {
  const kinds = refs.map((r) => r.kind).sort().join(",");
  switch (type) {
    case "horizontal":
    case "vertical":
      return kinds === "edge" || kinds === "point,point";
    case "parallel":
    case "perpendicular":
    case "angle":
      return kinds === "edge,edge";
    case "equal":
      return kinds === "edge,edge" || kinds === "circle,circle";
    case "tangent":
      return kinds === "circle,edge" || kinds === "circle,circle";
    case "coincident":
      return kinds === "point,point" || kinds === "edge,point" || kinds === "circle,point";
    case "distance":
      return kinds === "point,point" || kinds === "edge,point";
    case "length":
      return kinds === "edge";
    case "diameter":
      return kinds === "circle";
    case "fix":
      return kinds === "point";
  }
}

/** The current value a new dimension starts at (what it measures now). */
export function measure(type: SketchConstraint["type"], refs: SketchRef[], entities: SketchEntity[]): number | undefined {
  const map = new Map(entities.map((e) => [e.id, e]));
  const g = refs.map((r) => resolve(map, r));
  if (g.some((x) => !x)) return undefined;
  const probe = { id: "", type, refs, value: 0 } as SketchConstraint;
  if (type === "tangent") {
    // Inside or outside: whichever the circles are closer to now.
    const [a, b] = g as Resolved[];
    if (a.kind === "circle" && b.kind === "circle") {
      const d = len(sub(a.c, b.c));
      return Math.abs(d - Math.abs(a.r - b.r)) < Math.abs(d - (a.r + b.r)) ? -1 : 1;
    }
    return undefined;
  }
  if (!["distance", "length", "diameter", "angle"].includes(type)) return undefined;
  const r = residuals(probe, g as Resolved[]);
  if (!r) return undefined;
  const v = type === "angle" ? r[0] / ANGLE_SCALE / DEG : r[0];
  return Math.round(v * 1e4) / 1e4 + 0;
}

// ---- Solving ----------------------------------------------------------------------

/** Sizes (radii, widths…), as opposed to positions and angles: the solver would rather move a shape than resize it. */
const SIZES = new Set(["width", "height", "radius", "rx", "ry"]);

/** The numbers of an entity the solver may change, as get/set pairs (`size`: one of its sizes). */
function slots(e: SketchEntity): { get(): number; set(v: number): void; size?: boolean }[] {
  const field = (k: string) => ({ get: () => (e as unknown as Record<string, number>)[k], set: (v: number) => ((e as unknown as Record<string, number>)[k] = v), size: SIZES.has(k) });
  const pts = (list: P[]) => list.flatMap((p) => [0, 1].map((i) => ({ get: () => p[i], set: (v: number) => (p[i] = v) })));
  switch (e.type) {
    case "rect":
      return ["x", "y", "width", "height", "angle"].map(field);
    case "circle":
      return ["x", "y", "radius"].map(field);
    case "ellipse":
      return ["x", "y", "rx", "ry", "angle"].map(field);
    case "ngon":
      return ["x", "y", "radius", "angle"].map(field);
    case "slot":
      return ["x1", "y1", "x2", "y2", "radius"].map(field);
    case "polygon":
    case "spline":
    case "stroke":
      return pts(e.points);
    case "point":
      return ["x", "y"].map(field);
    case "line":
      return ["x1", "y1", "x2", "y2"].map(field);
  }
}

export interface SolveResult {
  /** Constraints whose geometry no longer exists (deleted shapes or points): drop them. */
  dead: string[];
  /** Largest remaining error: well above 0 means the rules can't all be met. */
  error: number;
}

/**
 * Move the constrained entities (in place) so every constraint holds, changing
 * them as little as possible, and moving shapes rather than resizing them.
 * `before` is the drawing before the user's edit: numbers that changed since
 * are held nearly still, so the edit itself sticks. Shapes in `hold` are held
 * still too (the shape a new rule was added against).
 */
export function solveSketch(entities: SketchEntity[], constraints: SketchConstraint[], before?: SketchEntity[], hold: Set<string> = new Set()): SolveResult {
  const map = new Map(entities.map((e) => [e.id, e]));
  const dead = constraints.filter((c) => c.refs.some((r) => !resolve(map, r)) || !constraintFits(c.type, c.refs)).map((c) => c.id);
  const live = constraints.filter((c) => !dead.includes(c.id));
  if (!live.length) return { dead, error: 0 };

  // Variables: every number of every entity a live constraint touches.
  const ids = [...new Set(live.flatMap((c) => c.refs.map((r) => r.entity)))];
  const vars: { get(): number; set(v: number): void; weight: number }[] = [];
  const old = new Map((before ?? []).map((e) => [e.id, e]));
  for (const id of ids) {
    const e = map.get(id)!;
    const prev = old.get(id);
    const prevSlots = prev && prev.type === e.type ? slots(structuredClone(prev)) : null;
    slots(e).forEach((s, i) => {
      const changed = prevSlots && prevSlots[i] && Math.abs(prevSlots[i].get() - s.get()) > 1e-9;
      vars.push({ ...s, weight: hold.has(id) ? 1e9 : changed ? 1e6 : s.size ? 100 : 1 });
    });
  }

  const evaluate = (): number[] => live.flatMap((c) => residuals(c, c.refs.map((r) => resolve(map, r)!)) ?? []);
  let r = evaluate();
  const norm = (v: number[]) => Math.max(0, ...v.map(Math.abs));
  for (let iter = 0; iter < 60 && norm(r) > 1e-9; iter++) {
    // Jacobian by central differences.
    const m = r.length;
    const n = vars.length;
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const x = vars[j].get();
      const h = 1e-6 * Math.max(1, Math.abs(x));
      vars[j].set(x + h);
      const up = evaluate();
      vars[j].set(x - h);
      const down = evaluate();
      vars[j].set(x);
      for (let i = 0; i < m; i++) J[i][j] = (up[i] - down[i]) / (2 * h);
    }
    // Smallest weighted step that zeroes the (linearised) errors: Δ = −W⁻¹Jᵀ(JW⁻¹Jᵀ + μI)⁻¹ r.
    const A: number[][] = Array.from({ length: m }, (_, i) =>
      Array.from({ length: m }, (_, k) => {
        let s = i === k ? 1e-10 : 0;
        for (let j = 0; j < n; j++) s += (J[i][j] * J[k][j]) / vars[j].weight;
        return s;
      }),
    );
    const y = solveLinear(A, r);
    if (!y) break;
    // Damped if a full step makes things worse.
    let step = 1;
    const start = vars.map((v) => v.get());
    const was = norm(r);
    for (let tries = 0; tries < 8; tries++) {
      vars.forEach((v, j) => {
        let d = 0;
        for (let i = 0; i < m; i++) d += J[i][j] * y[i];
        v.set(start[j] - (step * d) / v.weight);
      });
      const next = evaluate();
      if (norm(next) < was || tries === 7) {
        r = next;
        break;
      }
      step /= 2;
    }
  }
  // Tidy the numbers so the panel shows clean values.
  for (const v of vars) v.set(Math.round(v.get() * 1e6) / 1e6 + 0);
  // Radii and sizes can't go negative.
  for (const id of ids) {
    const e = map.get(id)!;
    if (e.type === "circle" || e.type === "ngon" || e.type === "slot") e.radius = Math.abs(e.radius);
    if (e.type === "rect") [e.width, e.height] = [Math.abs(e.width), Math.abs(e.height)];
  }
  return { dead, error: norm(evaluate()) };
}

/** Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = c + 1; i < n; i++) {
      const f = M[i][c] / M[c][c];
      for (let k = c; k <= n; k++) M[i][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k];
    x[i] = s / M[i][i];
  }
  return x;
}

// ---- Labels -------------------------------------------------------------------------

export const CONSTRAINT_LABEL: Record<SketchConstraint["type"], string> = {
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  tangent: "Tangent",
  coincident: "Coincident",
  distance: "Distance",
  length: "Length",
  diameter: "Diameter",
  angle: "Angle",
  fix: "Fixed",
};

export const CONSTRAINT_GLYPH: Record<SketchConstraint["type"], string> = {
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  tangent: "T",
  coincident: "●",
  distance: "↔",
  length: "↔",
  diameter: "Ø",
  angle: "∠",
  fix: "⚓",
};

/** Where a constraint's label goes: the middle of what it refers to. */
export function constraintAnchor(c: SketchConstraint, entities: SketchEntity[]): P | null {
  const map = new Map(entities.map((e) => [e.id, e]));
  const pts: P[] = [];
  for (const r of c.refs) {
    const g = resolve(map, r);
    if (!g) return null;
    if (g.kind === "point") pts.push(g.p);
    else if (g.kind === "edge") pts.push([(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2]);
    else pts.push([g.c[0] + g.r * Math.SQRT1_2, g.c[1] + g.r * Math.SQRT1_2]);
  }
  if (!pts.length) return null;
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

/** The pieces a constraint is drawn between (for a dimension line), in sketch coordinates. */
export function refGeometry(ref: SketchRef, entities: SketchEntity[]): Resolved | null {
  return resolve(new Map(entities.map((e) => [e.id, e])), ref);
}

/** The ref under the pointer: points first, then edges, then circles. */
export function refAt(entities: SketchEntity[], p: P, tolerance: number): SketchRef | null {
  let best: { ref: SketchRef; d: number } | null = null;
  const consider = (ref: SketchRef, d: number, bias: number) => {
    if (d <= tolerance && (!best || d - bias < best.d)) best = { ref, d: d - bias };
  };
  for (const e of entities) {
    refPoints(e).forEach((q, i) => consider({ entity: e.id, kind: "point", index: i }, len(sub(q, p)), tolerance * 0.6));
    refEdges(e).forEach(([a, b], i) => {
      const ab = sub(b, a);
      const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1e-12)));
      consider({ entity: e.id, kind: "edge", index: i }, len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t])), 0);
    });
    refCircles(e).forEach(({ c, r }, i) => consider({ entity: e.id, kind: "circle", index: i }, Math.abs(len(sub(p, c)) - r), 0));
  }
  return (best as { ref: SketchRef } | null)?.ref ?? null;
}
