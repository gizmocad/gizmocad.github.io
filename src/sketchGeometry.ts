// Geometry of sketch entities, shared by the kernel (exact curves) and the
// editor (drawing, hit-testing, handles, snapping) so both always agree.

import * as clippingModule from "polygon-clipping";
import type { MultiPolygon } from "polygon-clipping";
import type { Point2, SketchEntity } from "./model";

// The package's types name its functions, but its ES build only has a default export holding them.
const clipping = ((clippingModule as unknown as { default?: typeof clippingModule }).default ?? clippingModule) as typeof clippingModule;

type P = Point2;

/** A closed outline made of exact segments, starting at `start`. */
export type Segment = { kind: "line"; to: P } | { kind: "arc"; via: P; to: P } | { kind: "bezier"; c1: P; c2: P; to: P };
export interface Path {
  start: P;
  segments: Segment[];
}

const DEG = Math.PI / 180;
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const scale = (a: P, s: number): P => [a[0] * s, a[1] * s];
const len = (a: P) => Math.hypot(a[0], a[1]);
const dist = (a: P, b: P) => len(sub(a, b));
const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const rot = (a: P, deg: number): P => {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
};
/** Unit normal to the left of a → b. */
const leftNormal = (a: P, b: P): P => {
  const d = sub(b, a);
  const l = len(d) || 1;
  return [-d[1] / l, d[0] / l];
};
export const round = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

/** Entities that bound an area (as opposed to points and lines). */
export function isClosed(e: SketchEntity): boolean {
  return e.type !== "point" && e.type !== "line";
}

/** Does this entity contribute to the solid? */
export function isProfile(e: SketchEntity): boolean {
  return isClosed(e) && e.mode !== "construction";
}

// ---- Exact paths ---------------------------------------------------------

/** Point on the arc of edge a→b bowed by `bend` (signed sagitta, positive = left). */
export function bendPoint(a: P, b: P, bend: number): P {
  return add(mid(a, b), scale(leftNormal(a, b), bend));
}

/** Catmull-Rom tangents turned into cubic Bézier control points, closed loop. */
/**
 * Smooth closed curve through the points, as Béziers. Each handle is scaled by its own segment's share of the
 * neighbouring spacing, so closely spaced points make tight bends without overshooting (evenly spaced points
 * give the usual Catmull-Rom curve).
 */
function splineSegments(points: P[]): Segment[] {
  const n = points.length;
  const d = (a: P, b: P) => Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
  return points.map((p1, i) => {
    const p0 = points[(i - 1 + n) % n];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const [d1, d2, d3] = [d(p0, p1), d(p1, p2), d(p2, p3)];
    const c1 = add(p1, scale(sub(p2, p0), d2 / (d1 + d2) / 3));
    const c2 = sub(p2, scale(sub(p3, p1), d2 / (d2 + d3) / 3));
    return { kind: "bezier", c1, c2, to: p2 } as Segment;
  });
}

function polygonPath(points: P[], bends: number[] = []): Path {
  return {
    start: points[0],
    segments: points.map((a, i) => {
      const b = points[(i + 1) % points.length];
      const bend = bends[i] ?? 0;
      return Math.abs(bend) > 1e-9 ? { kind: "arc", via: bendPoint(a, b, bend), to: b } : { kind: "line", to: b };
    }),
  };
}

function transformPath(path: Path, f: (p: P) => P): Path {
  return {
    start: f(path.start),
    segments: path.segments.map((s) =>
      s.kind === "line" ? { kind: "line", to: f(s.to) } : s.kind === "arc" ? { kind: "arc", via: f(s.via), to: f(s.to) } : { kind: "bezier", c1: f(s.c1), c2: f(s.c2), to: f(s.to) },
    ),
  };
}

export function ngonPoints(e: { x: number; y: number; radius: number; sides: number; angle: number }): P[] {
  const n = Math.max(3, Math.round(e.sides));
  return Array.from({ length: n }, (_, i) => add([e.x, e.y], rot([e.radius, 0], e.angle + (360 * i) / n)));
}

/** Corners of a prism shape's polygon (centred, `radius` to the corners), with a flat side facing -Y. */
export function prismPoints(radius: number, sides: number): P[] {
  const n = Math.max(3, Math.round(sides));
  return ngonPoints({ x: 0, y: 0, radius, sides: n, angle: -90 + 180 / n });
}

export function rectCorners(e: { x: number; y: number; width: number; height: number; angle: number }): P[] {
  const w = e.width / 2;
  const h = e.height / 2;
  return ([[-w, -h], [w, -h], [w, h], [-w, h]] as P[]).map((c) => add([e.x, e.y], rot(c, e.angle)));
}

/**
 * The exact closed outline of an entity, or null for open entities and for
 * ellipses (which the kernel builds natively; see `outline` for drawing them).
 */
export function entityPath(e: SketchEntity): Path | null {
  switch (e.type) {
    case "rect": {
      const w = e.width / 2;
      const h = e.height / 2;
      const r = Math.min(Math.max(e.radius, 0), Math.min(w, h) - 1e-6);
      let path: Path;
      if (r <= 1e-9) {
        path = polygonPath([[-w, -h], [w, -h], [w, h], [-w, h]]);
      } else {
        const k = Math.SQRT1_2 * r;
        const corner = (cx: number, cy: number, sx: number, sy: number): P => [cx + sx * k, cy + sy * k];
        path = {
          start: [-w + r, -h],
          segments: [
            { kind: "line", to: [w - r, -h] },
            { kind: "arc", via: corner(w - r, -h + r, 1, -1), to: [w, -h + r] },
            { kind: "line", to: [w, h - r] },
            { kind: "arc", via: corner(w - r, h - r, 1, 1), to: [w - r, h] },
            { kind: "line", to: [-w + r, h] },
            { kind: "arc", via: corner(-w + r, h - r, -1, 1), to: [-w, h - r] },
            { kind: "line", to: [-w, -h + r] },
            { kind: "arc", via: corner(-w + r, -h + r, -1, -1), to: [-w + r, -h] },
          ],
        };
      }
      return transformPath(path, (p) => add([e.x, e.y], rot(p, e.angle)));
    }
    case "circle": {
      const { x, y, radius: r } = e;
      return {
        start: [x + r, y],
        segments: [
          { kind: "arc", via: [x, y + r], to: [x - r, y] },
          { kind: "arc", via: [x, y - r], to: [x + r, y] },
        ],
      };
    }
    case "ngon":
      return polygonPath(ngonPoints(e));
    case "slot": {
      const a: P = [e.x1, e.y1];
      const b: P = [e.x2, e.y2];
      const r = e.radius;
      if (dist(a, b) < 1e-9) return entityPath({ id: e.id, mode: e.mode, type: "circle", x: e.x1, y: e.y1, radius: r });
      const n = scale(leftNormal(a, b), r);
      const d = scale(sub(b, a), r / dist(a, b));
      return {
        start: add(a, n),
        segments: [
          { kind: "line", to: add(b, n) },
          { kind: "arc", via: add(b, d), to: sub(b, n) },
          { kind: "line", to: sub(a, n) },
          { kind: "arc", via: sub(a, d), to: add(a, n) },
        ],
      };
    }
    case "polygon":
      return e.points.length >= 3 ? polygonPath(e.points, e.bends) : null;
    case "spline":
      return e.points.length >= 3 ? { start: e.points[0], segments: splineSegments(e.points) } : null;
    default:
      return null;
  }
}

// ---- Brush strokes ---------------------------------------------------------

/** Ramer–Douglas–Peucker: drop points that stay within `tolerance` of the simplified path. */
export function simplify(points: P[], tolerance: number): P[] {
  if (points.length <= 2) return points.slice();
  let index = 0;
  let maxD = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSegment(points[i], points[0], points[points.length - 1]);
    if (d > maxD) [index, maxD] = [i, d];
  }
  if (maxD <= tolerance) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)];
}

/** Turn raw pointer samples into a stroke path of at most `maxSegments` segments. */
export function strokePath(raw: P[], width: number, maxSegments = 40): P[] {
  const pts = raw.filter((p, i) => i === 0 || dist(p, raw[i - 1]) > 1e-6);
  if (pts.length <= 1) return pts.map((p) => [round(p[0]), round(p[1])] as P);
  let tolerance = Math.max(width * 0.08, 0.05);
  let out = simplify(pts, tolerance);
  while (out.length - 1 > maxSegments) {
    tolerance *= 1.5;
    out = simplify(pts, tolerance);
  }
  return out.map((p) => [round(p[0]), round(p[1])] as P);
}

/** The pieces a stroke is built from: a capsule per segment (or a dot for a single point). */
export function strokePieces(e: { points: P[]; width: number }): Path[] {
  const r = e.width / 2;
  const pts = e.points.filter((p, i) => i === 0 || dist(p, e.points[i - 1]) > 1e-6);
  if (r <= 0 || !pts.length) return [];
  if (pts.length === 1) return [entityPath({ id: "", mode: "add", type: "circle", x: pts[0][0], y: pts[0][1], radius: r })!];
  return pts.slice(1).map((b, i) => entityPath({ id: "", mode: "add", type: "slot", x1: pts[i][0], y1: pts[i][1], x2: b[0], y2: b[1], radius: r })!);
}

/** An approximate outline for drawing a stroke: along one side, round the end, back along the other. */
function strokeOutline(e: { points: P[]; width: number }): P[] {
  const r = e.width / 2;
  const pts = e.points;
  if (pts.length < 2) return pts.length ? outline({ id: "", mode: "add", type: "circle", x: pts[0][0], y: pts[0][1], radius: r }) : [];
  const side = (sign: number) =>
    pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      return add(p, scale(leftNormal(a, b), sign * r));
    });
  const cap = (center: P, from: P, steps = 8): P[] => {
    const start = Math.atan2(from[1] - center[1], from[0] - center[0]);
    return Array.from({ length: steps - 1 }, (_, k) => {
      const t = start - (Math.PI * (k + 1)) / steps;
      return [center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)] as P;
    });
  };
  const left = side(1);
  const right = side(-1).reverse();
  return [...left, ...cap(pts[pts.length - 1], left[left.length - 1]), ...right, ...cap(pts[0], right[right.length - 1])];
}

// ---- Sampled outlines (for drawing and hit-testing) ----------------------

function arcSamples(a: P, via: P, b: P, n = 32): P[] {
  // Circle through three points.
  const d = 2 * (a[0] * (via[1] - b[1]) + via[0] * (b[1] - a[1]) + b[0] * (a[1] - via[1]));
  if (Math.abs(d) < 1e-12) return [b];
  const sq = (p: P) => p[0] * p[0] + p[1] * p[1];
  const c: P = [
    (sq(a) * (via[1] - b[1]) + sq(via) * (b[1] - a[1]) + sq(b) * (a[1] - via[1])) / d,
    (sq(a) * (b[0] - via[0]) + sq(via) * (a[0] - b[0]) + sq(b) * (via[0] - a[0])) / d,
  ];
  const r = dist(a, c);
  const ang = (p: P) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(a);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Go the way that passes through `via`.
  let sweep = norm(ang(b) - a0);
  if (norm(ang(via) - a0) > sweep) sweep -= 2 * Math.PI;
  return Array.from({ length: n }, (_, i) => {
    const t = a0 + (sweep * (i + 1)) / n;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as P;
  });
}

function bezierSamples(a: P, c1: P, c2: P, b: P, n = 20): P[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n;
    const u = 1 - t;
    return [
      u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
      u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1],
    ] as P;
  });
}

export function samplePath(path: Path): P[] {
  const out: P[] = [path.start];
  let cur = path.start;
  for (const s of path.segments) {
    if (s.kind === "line") out.push(s.to);
    else if (s.kind === "arc") out.push(...arcSamples(cur, s.via, s.to));
    else out.push(...bezierSamples(cur, s.c1, s.c2, s.to));
    cur = s.to;
  }
  out.pop(); // The last point repeats the start.
  return out;
}

/** Points to draw. Closed entities form a loop; lines are two points; points are one. */
export function outline(e: SketchEntity): P[] {
  if (e.type === "point") return [[e.x, e.y]];
  if (e.type === "line") return [[e.x1, e.y1], [e.x2, e.y2]];
  if (e.type === "ellipse") {
    return Array.from({ length: 96 }, (_, i) => add([e.x, e.y], rot([e.rx * Math.cos((i / 96) * 2 * Math.PI), e.ry * Math.sin((i / 96) * 2 * Math.PI)], e.angle)));
  }
  if (e.type === "stroke") return strokeOutline(e);
  if ((e.type === "polygon" || e.type === "spline") && e.points.length < 3) return e.points;
  const path = entityPath(e);
  return path ? samplePath(path) : [];
}

// ---- Hit-testing ---------------------------------------------------------

function pointInPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(p: P, a: P, b: P): number {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
  return dist(p, add(a, scale(ab, t)));
}

function distToPolyline(p: P, pts: P[]): number {
  if (pts.length === 1) return dist(p, pts[0]);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]));
  return best;
}

export function distToOutline(e: SketchEntity, p: P): number {
  if (e.type === "stroke") return Math.abs(distToPolyline(p, e.points) - e.width / 2);
  const pts = outline(e);
  if (pts.length === 1) return dist(p, pts[0]);
  let best = Infinity;
  const closed = isClosed(e);
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) best = Math.min(best, distToSegment(p, pts[i], pts[(i + 1) % pts.length]));
  return best;
}

function polygonArea(poly: P[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a / 2);
}

/**
 * The entity under `p`. Anything whose outline is within `tolerance` wins;
 * otherwise the smallest filled shape containing the point, so small shapes
 * inside big ones stay clickable.
 */
export function hitTest(entities: SketchEntity[], p: P, tolerance: number): string | null {
  let best: { id: string; score: number } | null = null;
  for (const e of entities) {
    const d = distToOutline(e, p);
    let score: number | null = null;
    if (d <= tolerance) score = d - 1e9; // Near an edge beats being inside.
    else if (e.type === "stroke" && e.mode !== "construction" && distToPolyline(p, e.points) <= e.width / 2) score = e.width * e.points.length;
    else if (isClosed(e) && e.type !== "stroke" && e.mode !== "construction" && pointInPolygon(p, outline(e))) score = polygonArea(outline(e));
    if (score !== null && (!best || score < best.score)) best = { id: e.id, score };
  }
  return best?.id ?? null;
}

export function bounds(e: SketchEntity): [P, P] {
  const pts = outline(e);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [
    [Math.min(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.max(...ys)],
  ];
}

// ---- Handles (the draggable dots) ----------------------------------------

export type HandleKind = "center" | "vertex" | "edge" | "size";
export interface Handle {
  key: string;
  kind: HandleKind;
  p: P;
}

export function handles(e: SketchEntity): Handle[] {
  switch (e.type) {
    case "rect":
      return [{ key: "c", kind: "center", p: [e.x, e.y] }, ...rectCorners(e).map((p, i) => ({ key: `k${i}`, kind: "size" as const, p }))];
    case "circle":
      return [
        { key: "c", kind: "center", p: [e.x, e.y] },
        { key: "r", kind: "size", p: [e.x + e.radius, e.y] },
      ];
    case "ellipse":
      return [
        { key: "c", kind: "center", p: [e.x, e.y] },
        { key: "rx", kind: "size", p: add([e.x, e.y], rot([e.rx, 0], e.angle)) },
        { key: "ry", kind: "size", p: add([e.x, e.y], rot([0, e.ry], e.angle)) },
      ];
    case "ngon":
      return [
        { key: "c", kind: "center", p: [e.x, e.y] },
        { key: "v", kind: "size", p: ngonPoints(e)[0] },
      ];
    case "slot": {
      const a: P = [e.x1, e.y1];
      const b: P = [e.x2, e.y2];
      return [
        { key: "a", kind: "vertex", p: a },
        { key: "b", kind: "vertex", p: b },
        { key: "r", kind: "size", p: add(mid(a, b), scale(leftNormal(a, b), e.radius)) },
      ];
    }
    case "polygon":
      return [
        ...e.points.map((p, i) => ({ key: `v${i}`, kind: "vertex" as const, p })),
        ...e.points.map((a, i) => ({ key: `m${i}`, kind: "edge" as const, p: bendPoint(a, e.points[(i + 1) % e.points.length], e.bends[i] ?? 0) })),
      ];
    case "spline":
    case "stroke":
      return e.points.map((p, i) => ({ key: `v${i}`, kind: "vertex" as const, p }));
    case "point":
      return [{ key: "c", kind: "center", p: [e.x, e.y] }];
    case "line":
      return [
        { key: "a", kind: "vertex", p: [e.x1, e.y1] },
        { key: "b", kind: "vertex", p: [e.x2, e.y2] },
      ];
  }
}

/** Drag handle `key` of `e` to `p`, updating the entity in place. */
export function moveHandle(e: SketchEntity, key: string, p: P) {
  const [u, v] = [round(p[0]), round(p[1])];
  if (key === "c" && "x" in e && "y" in e) {
    e.x = u;
    e.y = v;
    return;
  }
  switch (e.type) {
    case "rect": {
      const i = Number(key.slice(1));
      const opposite = rectCorners(e)[(i + 2) % 4];
      const d = rot(sub(p, opposite), -e.angle);
      const center = add(opposite, rot(scale(d, 0.5), e.angle));
      e.width = round(Math.abs(d[0]));
      e.height = round(Math.abs(d[1]));
      e.x = round(center[0]);
      e.y = round(center[1]);
      break;
    }
    case "circle":
      e.radius = round(dist(p, [e.x, e.y]));
      break;
    case "ellipse": {
      const d = sub(p, [e.x, e.y]);
      if (key === "rx") {
        e.rx = round(len(d));
        e.angle = round(Math.atan2(d[1], d[0]) / DEG);
      } else {
        e.ry = round(Math.abs(rot(d, -e.angle)[1]));
      }
      break;
    }
    case "ngon": {
      const d = sub(p, [e.x, e.y]);
      e.radius = round(len(d));
      e.angle = round(Math.atan2(d[1], d[0]) / DEG);
      break;
    }
    case "slot":
    case "line":
      if (key === "a") [e.x1, e.y1] = [u, v];
      else if (key === "b") [e.x2, e.y2] = [u, v];
      else if (e.type === "slot") {
        const a: P = [e.x1, e.y1];
        const b: P = [e.x2, e.y2];
        e.radius = round(Math.max(0.01, Math.abs(dotP(sub(p, mid(a, b)), leftNormal(a, b)))));
      }
      break;
    case "polygon":
    case "spline":
    case "stroke": {
      const i = Number(key.slice(1));
      if (key[0] === "v") e.points[i] = [u, v];
      else if (e.type === "polygon") {
        const a = e.points[i];
        const b = e.points[(i + 1) % e.points.length];
        e.bends[i] = round(dotP(sub(p, mid(a, b)), leftNormal(a, b)));
      }
      break;
    }
  }
}

const dotP = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];

export function translateEntity(e: SketchEntity, [du, dv]: P) {
  const t = (p: P): P => [round(p[0] + du), round(p[1] + dv)];
  if ("x" in e && "y" in e) [e.x, e.y] = t([e.x, e.y]);
  if (e.type === "slot" || e.type === "line") {
    [e.x1, e.y1] = t([e.x1, e.y1]);
    [e.x2, e.y2] = t([e.x2, e.y2]);
  }
  if (e.type === "polygon" || e.type === "spline" || e.type === "stroke") e.points = e.points.map(t);
}

/** Points the cursor snaps to: corners, centres, ends, midpoints. */
export function snapPoints(e: SketchEntity): P[] {
  if (e.type === "stroke") return e.points.length ? [e.points[0], e.points[e.points.length - 1]] : [];
  const pts = handles(e).map((h) => h.p);
  if (e.type === "line") pts.push(mid([e.x1, e.y1], [e.x2, e.y2]));
  if (e.type === "rect") {
    const c = rectCorners(e);
    pts.push(...c.map((a, i) => mid(a, c[(i + 1) % 4])));
  }
  if (e.type === "circle") pts.push([e.x - e.radius, e.y], [e.x, e.y + e.radius], [e.x, e.y - e.radius]);
  if (e.type === "ngon") pts.push(...ngonPoints(e));
  return pts;
}

/** Insert a point in the middle of edge i (polygon or spline). */
export function insertPoint(e: SketchEntity, edge: number) {
  if (e.type !== "polygon" && e.type !== "spline") return;
  const a = e.points[edge];
  const b = e.points[(edge + 1) % e.points.length];
  const m: P = e.type === "polygon" ? bendPoint(a, b, e.bends[edge] ?? 0) : mid(a, b);
  e.points.splice(edge + 1, 0, [round(m[0]), round(m[1])]);
  if (e.type === "polygon") {
    // Splitting an arc into two halves: each half has about a quarter of the sagitta.
    const half = round((e.bends[edge] ?? 0) / 4);
    e.bends.splice(edge, 1, half, half);
  }
}

export function removePoint(e: SketchEntity, index: number) {
  if ((e.type !== "polygon" && e.type !== "spline") || e.points.length <= 3) return;
  e.points.splice(index, 1);
  if (e.type === "polygon") e.bends.splice(index, 1);
}

/** The edge of a polygon/spline nearest `p`. */
export function nearestEdge(e: SketchEntity, p: P): number {
  if (e.type !== "polygon" && e.type !== "spline") return -1;
  let best = 0;
  let bestD = Infinity;
  e.points.forEach((a, i) => {
    const b = e.points[(i + 1) % e.points.length];
    const d = distToSegment(p, a, b);
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

// ---- Splitting -----------------------------------------------------------

/** The point on segment a→b nearest p, and how far along it is (0..1). */
function project(p: P, a: P, b: P): { at: P; t: number } {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
  return { at: [round(a[0] + ab[0] * t), round(a[1] + ab[1] * t)], t };
}

/** Can `splitAt` do anything with this entity? */
export function canSplit(e: SketchEntity): boolean {
  return e.type === "line" || e.type === "stroke" || e.type === "polygon" || e.type === "spline" || e.type === "ngon" || (e.type === "rect" && !e.radius);
}

/**
 * Split an entity at the point nearest `p`. Lines and brush strokes become two
 * pieces (the second gets `newId`); closed outlines get a new corner there,
 * which can then be dragged (rectangles and N-gons turn into polygons for that).
 * Returns the replacement entities, or null if there's nothing to split there.
 */
export function splitAt(e: SketchEntity, p: P, newId: string): SketchEntity[] | null {
  if (e.type === "line") {
    const { at, t } = project(p, [e.x1, e.y1], [e.x2, e.y2]);
    if (t < 0.01 || t > 0.99) return null;
    return [
      { ...e, x2: at[0], y2: at[1] },
      { ...e, id: newId, x1: at[0], y1: at[1] },
    ];
  }
  if (e.type === "stroke") {
    let best = { i: -1, d: Infinity, at: [0, 0] as P };
    for (let i = 0; i < e.points.length - 1; i++) {
      const { at } = project(p, e.points[i], e.points[i + 1]);
      const d = dist(p, at);
      if (d < best.d) best = { i, d, at };
    }
    if (best.i < 0) return null;
    const first = [...e.points.slice(0, best.i + 1), best.at];
    const second = [best.at, ...e.points.slice(best.i + 1)];
    if (dist(first[0], best.at) < 1e-6 || dist(second.at(-1)!, best.at) < 1e-6) return null; // At an end: nothing to split.
    return [
      { ...e, points: first },
      { ...e, id: newId, points: second },
    ];
  }
  // Closed outlines: add a corner where the click was.
  let poly: Extract<SketchEntity, { type: "polygon" | "spline" }>;
  if (e.type === "rect" && !e.radius) poly = { id: e.id, mode: e.mode, type: "polygon", points: rectCorners(e).map(([x, y]) => [round(x), round(y)]), bends: [0, 0, 0, 0] };
  else if (e.type === "ngon") {
    const pts = ngonPoints(e).map(([x, y]) => [round(x), round(y)] as P);
    poly = { id: e.id, mode: e.mode, type: "polygon", points: pts, bends: pts.map(() => 0) };
  } else if (e.type === "polygon" || e.type === "spline") poly = structuredClone(e);
  else return null;
  const edge = nearestEdge(poly, p);
  const a = poly.points[edge];
  const b = poly.points[(edge + 1) % poly.points.length];
  if (poly.type === "polygon" && poly.bends[edge]) {
    insertPoint(poly, edge); // A curved edge splits at its middle, keeping the curve.
    return [poly];
  }
  const { at, t } = project(p, a, b);
  if (t < 0.01 || t > 0.99) return null;
  poly.points.splice(edge + 1, 0, at);
  if (poly.type === "polygon") poly.bends.splice(edge, 1, 0, 0);
  return [poly];
}

// ---- Trimming overlaps ----------------------------------------------------

/** A closed entity's outline as a polygon ring (curves sampled finely). */
function ring(e: SketchEntity): P[] {
  return outline(e);
}

/** Does `e` take part in trimming as an area (a closed, non-guide shape)? */
function isArea(e: SketchEntity): boolean {
  return isClosed(e) && e.mode !== "construction" && outline(e).length >= 3;
}

/** Drop repeated and in-line points, so merged outlines stay light and editable. */
function tidyRing(points: P[]): P[] {
  let pts = points.map(([x, y]) => [round(x), round(y)] as P);
  if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (dist(a, b) < 1e-6 || Math.abs(cross) < 1e-6 * Math.max(1, dist(a, c))) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts;
}

/** Turn a boolean result back into polygon entities (holes become cut-outs). */
function toEntities(mp: MultiPolygon, mode: SketchEntity["mode"], ids: () => string): SketchEntity[] {
  const out: SketchEntity[] = [];
  for (const [outer, ...holes] of mp) {
    const pts = tidyRing(outer as P[]);
    if (pts.length >= 3) out.push({ id: ids(), mode, type: "polygon", points: pts, bends: pts.map(() => 0) });
    if (mode !== "add") continue;
    for (const h of holes) {
      const hp = tidyRing(h as P[]);
      if (hp.length >= 3) out.push({ id: ids(), mode: "subtract", type: "polygon", points: hp, bends: hp.map(() => 0) });
    }
  }
  return out;
}

function intersects(a: SketchEntity, b: SketchEntity): boolean {
  try {
    return clipping.intersection([ring(a)], [ring(b)]).length > 0;
  } catch {
    return false;
  }
}

/** Where segments a→b and c→d cross, as the fraction along a→b (or null). */
function crossAt(a: P, b: P, c: P, d: P): number | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const q = sub(c, a);
  const t = (q[0] * s[1] - q[1] * s[0]) / den;
  const u = (q[0] * r[1] - q[1] * r[0]) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
}

export interface TrimResult {
  remove: string[];
  add: SketchEntity[];
  message: string;
}

/**
 * Trim at point `p` (on an outline, within `tolerance`):
 * - on a guide line: cut away the piece between the nearest crossings;
 * - on a shape's edge inside another shape: merge them into one outline (or,
 *   if one adds and the other cuts, trim the clicked one back to the other's edge).
 * Returns null when there's nothing to trim there.
 */
export function trimAt(entities: SketchEntity[], p: P, tolerance: number, ids: () => string): TrimResult | null {
  let hit: SketchEntity | null = null;
  let best = tolerance;
  for (const e of entities) {
    if (e.type === "point") continue;
    const d = distToOutline(e, p);
    if (d <= best) [hit, best] = [e, d];
  }
  if (!hit) return null;
  const others = entities.filter((x) => x.id !== hit!.id && x.type !== "point");

  if (hit.type === "line") {
    const a: P = [hit.x1, hit.y1];
    const b: P = [hit.x2, hit.y2];
    const ts: number[] = [];
    for (const o of others) {
      const pts = outline(o);
      const closed = isClosed(o);
      for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
        const t = crossAt(a, b, pts[i], pts[(i + 1) % pts.length]);
        if (t !== null) ts.push(t);
      }
    }
    const { t } = project(p, a, b);
    const cuts = [0, ...ts.sort((x, y) => x - y), 1];
    const k = cuts.findIndex((c, i) => i > 0 && t <= c);
    const [t0, t1] = [cuts[k - 1], cuts[k]];
    const at = (u: number): P => [round(a[0] + (b[0] - a[0]) * u), round(a[1] + (b[1] - a[1]) * u)];
    const add: SketchEntity[] = [];
    if (t0 > 1e-9) add.push({ ...hit, id: ids(), x2: at(t0)[0], y2: at(t0)[1] });
    if (t1 < 1 - 1e-9) add.push({ ...hit, id: ids(), x1: at(t1)[0], y1: at(t1)[1] });
    return { remove: [hit.id], add, message: add.length ? "Trimmed the line back to where it crosses." : "Removed the line (nothing crosses it)." };
  }

  if (!isArea(hit)) return null;
  // The shapes this edge runs inside.
  const around = others.filter((o) => isArea(o) && pointInPolygon(p, ring(o)) && distToOutline(o, p) > tolerance / 2);
  if (!around.length) return trimOutside(hit, others, p, ids);
  const same = around.filter((o) => o.mode === hit!.mode);
  try {
    if (same.length) {
      const group = [hit, ...same];
      const merged = clipping.union([ring(hit)], ...same.map((o) => [ring(o)]));
      return { remove: group.map((g) => g.id), add: toEntities(merged, hit.mode, ids), message: `Merged ${group.length} overlapping shapes into one outline.` };
    }
    const left = clipping.difference([ring(hit)], ...around.map((o) => [ring(o)]));
    return { remove: [hit.id], add: toEntities(left, hit.mode, ids), message: "Trimmed the shape back to the edge it overlapped." };
  } catch {
    return null;
  }
}

/**
 * The clicked edge of `hit` lies outside every other shape: cut away the part of `hit` it bounds.
 * If `hit` overlaps other shapes, keep only the overlap (trimming off the overhang); otherwise, if guide lines
 * cross it, cut it along the nearest one and drop the side that was clicked.
 */
function trimOutside(hit: SketchEntity, others: SketchEntity[], p: P, ids: () => string): TrimResult | null {
  try {
    const overlapping = others.filter((o) => isArea(o) && intersects(hit, o));
    if (overlapping.length) {
      const inside = clipping.union([ring(overlapping[0])], ...overlapping.slice(1).map((o) => [ring(o)]));
      const left = clipping.intersection([ring(hit)], inside);
      if (!left.length) return null;
      return { remove: [hit.id], add: toEntities(left, hit.mode, ids), message: "Trimmed off the part sticking out of the other shape." };
    }
    const pts = ring(hit);
    let best: { a: P; b: P; d: number } | null = null;
    for (const o of others) {
      if (o.type !== "line") continue;
      const a: P = [o.x1, o.y1];
      const b: P = [o.x2, o.y2];
      const crossings = pts.filter((_, i) => crossAt(a, b, pts[i], pts[(i + 1) % pts.length]) !== null).length;
      const d = distToSegment(p, a, b);
      if (crossings >= 2 && (!best || d < best.d)) best = { a, b, d };
    }
    if (!best) return null;
    // A huge box on the clicked side of the (extended) line.
    const { a, b } = best;
    const dir = sub(b, a);
    const len = Math.hypot(dir[0], dir[1]);
    const u: P = [dir[0] / len, dir[1] / len];
    let n: P = [-u[1], u[0]];
    if ((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]];
    const big = 1e5;
    const at = (s: number, t: number): P => [a[0] + u[0] * s + n[0] * t, a[1] + u[1] * s + n[1] * t];
    const side = [at(-big, 0), at(big, 0), at(big, big), at(-big, big)];
    const left = clipping.difference([pts], [side]);
    if (!left.length) return null;
    return { remove: [hit.id], add: toEntities(left, hit.mode, ids), message: "Cut the shape along the guide line, removing the side you clicked." };
  } catch {
    return null;
  }
}

/** Merge every group of overlapping shapes (same add/cut kind) among `selected` into one outline each. */
export function mergeOverlaps(selected: SketchEntity[], ids: () => string): TrimResult | null {
  const areas = selected.filter(isArea);
  const parent = areas.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      if (areas[i].mode === areas[j].mode && intersects(areas[i], areas[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, SketchEntity[]>();
  areas.forEach((e, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), e]));
  const result: TrimResult = { remove: [], add: [], message: "" };
  let merged = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    try {
      const mp = clipping.union([ring(g[0])], ...g.slice(1).map((e) => [ring(e)]));
      result.remove.push(...g.map((e) => e.id));
      result.add.push(...toEntities(mp, g[0].mode, ids));
      merged += g.length;
    } catch {
      // Leave a group that can't be merged as it is.
    }
  }
  if (!merged) return null;
  result.message = `Merged ${merged} overlapping shapes.`;
  return result;
}

// ---- Gear and star outlines -------------------------------------------------

/** Outside radius of a spur gear: module × (teeth + 2) / 2. */
export function gearOuterRadius(teeth: number, module: number): number {
  return (module * (Math.max(6, Math.round(teeth)) + 2)) / 2;
}

/** A star's outline: tips on `radius`, dips on `inner`, a tip pointing +Y. */
export function starPoints(points: number, radius: number, inner: number): P[] {
  const n = Math.max(3, Math.round(points));
  return Array.from({ length: 2 * n }, (_, i) => {
    const r = i % 2 ? inner : radius;
    const a = Math.PI / 2 + (Math.PI * i) / n;
    return [round(r * Math.cos(a)), round(r * Math.sin(a))] as P;
  });
}

/**
 * The gear outline as exact segments: each tooth side is one arc through
 * three points of its involute (very close to the true curve), the tip and
 * the root between teeth are circle arcs. Fewer, smoother faces than `gearPoints`.
 */
export function gearPath(teeth: number, module: number): Path {
  const z = Math.max(6, Math.round(teeth));
  const m = module;
  const pressure = (20 * Math.PI) / 180;
  const rp = (m * z) / 2;
  const ra = rp + m;
  const rf = Math.max(rp - 1.25 * m, rp * 0.5);
  const rb = rp * Math.cos(pressure);
  const inv = (a: number) => Math.tan(a) - a;
  const half = (r: number) => Math.max(0, Math.PI / (2 * z) + inv(pressure) - inv(Math.acos(Math.min(1, rb / r))));
  const at = (r: number, a: number): P => [round(r * Math.cos(a)), round(r * Math.sin(a))];
  const r0 = Math.max(rb, rf);
  const rm = (r0 + ra) / 2;
  const pointy = half(ra) < 1e-4; // Small gears: the flanks meet at the tip.
  const step = (2 * Math.PI) / z;
  const segments: Segment[] = [];
  const start = at(rf, -step / 2);
  for (let k = 0; k < z; k++) {
    const c = k * step;
    // Root arc from the middle of the previous gap to the foot of this tooth.
    segments.push({ kind: "arc", via: at(rf, c - (step / 2 + half(r0)) / 2), to: at(rf, c - half(r0)) });
    if (rf < rb) segments.push({ kind: "line", to: at(r0, c - half(r0)) });
    segments.push({ kind: "arc", via: at(rm, c - half(rm)), to: at(ra, c - half(ra)) });
    if (!pointy) segments.push({ kind: "arc", via: at(ra, c), to: at(ra, c + half(ra)) });
    segments.push({ kind: "arc", via: at(rm, c + half(rm)), to: at(r0, c + half(r0)) });
    if (rf < rb) segments.push({ kind: "line", to: at(rf, c + half(r0)) });
    segments.push({ kind: "arc", via: at(rf, c + (step / 2 + half(r0)) / 2), to: at(rf, c + step / 2) });
  }
  return { start, segments };
}

/**
 * A closed curve through `points`, sampled one piece per span (piece i runs
 * from point i to point i+1; the last piece closes back to the start). Exactly
 * the curve a finished spline entity gets, so previews match the result.
 */
export function splinePieces(points: P[]): P[][] {
  if (points.length < 3) return [];
  let cur = points[0];
  return splineSegments(points).map((s) => {
    const seg = s as Extract<Segment, { kind: "bezier" }>;
    const piece = [cur, ...bezierSamples(cur, seg.c1, seg.c2, seg.to)];
    cur = seg.to;
    return piece;
  });
}
