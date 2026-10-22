// Runs OpenCascade (via replicad) off the main thread so the UI never freezes.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { measureVolume, Blueprint, BlueprintSketcher, Blueprints, CompoundBlueprint, Drawing, type Curve2D, Plane, EdgeFinder, FaceFinder, type Face, type Edge, type Wire, type Sketch, type CompoundSketch, type Sketches, type GenericSweepConfig, makeBSplineApproximation, assembleWire, cast, deserializeShape, draw, drawCircle, drawEllipse, drawText, genericSweep, getOC, importSTEP, loadFont, makeBaseBox, makeBox, makeCircle, makeCompound, makeCylinder, makeHelix, makeLine, makeEllipsoid, makePolygon, makeSolid, makeSphere, setOC, type Shape3D } from "replicad";
import {
  PLANE_ROTATIONS,
  SCREW_SIZES,
  LEAN_KINDS,
  childrenOf,
  subtreeIds,
  ignoresHole,
  anyIgnoredHoles,
  clearanceOf,
  isGroove,
  isSweepSketch,
  INSERT_SIZES,
  NUT_PLAY,
  NUT_SIZES,
  sweepOf,
  type Sweep,
  worldMatrix,
  insideMergedGroup,
  isMergedGroup,
  type Clip,
  clipNormal,
  type ScrewParams,
  type SnapParams,
  snapHeadroom,
  withHolesCuttingAround,
  snapLayout,
  type Shell,
  type SpringParams,
  type TextParams,
  jointMatrix,
  localMatrix,
  type EdgeOp,
  type Feature,
  type ImportedParams,
  type SketchEntity,
  type SketchParams,
} from "./model";
import { entityPath, gearPath, isProfile, outline, prismPoints, starPoints, strokeLine, strokePieces, wrapPath, type Path } from "./sketchGeometry";
import type { BuildStep, Clash, ImportedSolid, ImportSource, KernelRequest, KernelResponse, MeshData, ModelStats, SketchLoop } from "./kernel";
import { hedron } from "./hedron";
import { CUSTOM_FONT, builtInFontUrl, fontFamily, isCustomFont } from "./fonts";
import { Box3, Matrix3, Matrix4, Vector3 } from "three";
import { applyTexture } from "./texture";
import { BufferAttribute, BufferGeometry, EdgesGeometry, Triangle } from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import ManifoldModule from "manifold-3d/manifold.js";
import manifoldWasm from "manifold-3d/manifold.wasm?url";
import { decodeFloats, decodeIndices } from "./sculpt";

type Font = Awaited<ReturnType<typeof loadFont>>;
/** Loaded fonts by family (see fontFamily): built-in ones as texts first need them, imported ones when the app sends them. */
const fonts: Record<string, Font> = {};

const ready = (async () => {
  const oc = await opencascade({ locateFile: () => wasmUrl });
  setOC(oc as Parameters<typeof setOC>[0]);
})();

/** Load the built-in fonts these texts use (each once). */
async function ensureFonts(features: Feature[]) {
  const families = new Set(features.flatMap((f) => (f.kind === "text" ? [fontFamily(f.params.font, f.params.bold)] : [])));
  await Promise.all(
    [...families].map(async (family) => {
      if (fonts[family] || isCustomFont(family)) return;
      const url = builtInFontUrl(family);
      if (url) fonts[family] = await loadFont(url, family);
    }),
  );
}

function pathDrawing(path: Path): Drawing {
  const pen = draw(path.start);
  for (const s of path.segments) {
    if (s.kind === "line") pen.lineTo(s.to);
    else if (s.kind === "arc") pen.threePointsArcTo(s.to, s.via);
    else pen.cubicBezierCurveTo(s.to, s.c1, s.c2);
  }
  return pen.close();
}

function entityDrawing(e: SketchEntity): Drawing | null {
  if (e.trims?.length) return trimmedDrawing(e);
  if (e.type === "stroke") {
    // Open offsets crash OpenCascade's 2D offset, so a stroke is the union of a capsule per segment.
    let result: Drawing | null = null;
    for (const piece of strokePieces(e)) {
      const d = pathDrawing(piece);
      result = result ? result.fuse(d) : d;
    }
    return result;
  }
  if (e.type === "ellipse") {
    if (e.rx <= 0 || e.ry <= 0) return null;
    // replicad wants the major radius first; swap and turn 90° if needed.
    const d = e.rx >= e.ry ? drawEllipse(e.rx, e.ry).rotate(e.angle) : drawEllipse(e.ry, e.rx).rotate(e.angle + 90);
    return d.translate(e.x, e.y);
  }
  if (e.type === "rect" && (e.width <= 0 || e.height <= 0)) return null;
  // (A rectangle's `radius` is its corner rounding, so 0 is fine there.)
  if ((e.type === "circle" || e.type === "ngon" || e.type === "slot") && e.radius <= 0) return null;
  const path = entityPath(e);
  return path ? pathDrawing(path) : null;
}

/**
 * A trimmed shape: its own exact outline combined with what it was trimmed
 * against. If OpenCascade's 2D booleans fail, the sampled outline (the same one
 * the sketch editor shows) stands in.
 */
function trimmedDrawing(e: SketchEntity): Drawing | null {
  try {
    let d = entityDrawing({ ...e, trims: undefined } as SketchEntity);
    for (const [k, t] of (e.trims ?? []).entries()) {
      if (!d) return null;
      if (t.op === "hull") {
        // Wrapped round it and the other shapes: built from the exact wrapped outline.
        const path = wrapPath([{ ...e, trims: e.trims!.slice(0, k) } as SketchEntity, ...t.shapes]);
        if (path) d = pathDrawing(path);
        continue;
      }
      let others: Drawing | null = null;
      for (const s of t.shapes) {
        const sd = entityDrawing(s);
        if (sd) others = others ? others.fuse(sd) : sd;
      }
      if (!others) continue;
      d = t.op === "keep" ? d.intersect(others) : t.op === "cut" ? d.cut(others) : d.fuse(others);
    }
    if (d) return d;
  } catch {
    // Fall through to the outline.
  }
  const pts = outline(e);
  return pts.length >= 3 ? polygonDrawing(pts) : null;
}

type Solidifiable = {
  extrude(distance: number, config?: { extrusionDirection?: [number, number, number]; extrusionProfile?: { profile: "linear"; endFactor: number } }): Shape3D;
  revolve(axis?: [number, number, number], config?: { origin?: [number, number, number]; angle?: number }): Shape3D;
};

/** How far the top moves per mm of height, in X and Y: the tangents of the lean angles. Null: upright. */
type Lean = [number, number] | null;

function leanOf(f: Feature): Lean {
  const t = f.tilt;
  if (!t || (!t.leanX && !t.leanY)) return null;
  const tan = (deg: number) => Math.tan((Math.max(-60, Math.min(60, deg)) * Math.PI) / 180);
  return [tan(t.leanX), tan(t.leanY)];
}

/**
 * Extrude a drawing up by `h`: slanted so the top shifts by the lean, and/or
 * narrowing towards the top so its outermost points lean in by `taper` degrees
 * (exact for circles; used where OpenCascade's draft can't handle the sides).
 */
function extrudeUp(d: Drawing, h: number, lean: Lean, taper = 0): Shape3D {
  const sketch = d.sketchOnPlane("XY") as unknown as Solidifiable;
  let extrusionProfile: { profile: "linear"; endFactor: number } | undefined;
  if (taper) {
    const [[x0, y0], [x1, y1]] = d.boundingBox.bounds;
    const reach = Math.max(-x0, x1, -y0, y1);
    const endFactor = 1 - (h * Math.tan((taper * Math.PI) / 180)) / reach;
    if (endFactor <= 0.01) throw new Error("The taper is too steep for this height: the sides would meet before the top.");
    extrusionProfile = { profile: "linear", endFactor };
  }
  if (!lean && !extrusionProfile) return sketch.extrude(h);
  const [tx, ty] = lean ?? [0, 0];
  return sketch.extrude(h * Math.hypot(tx, ty, 1), { extrusionDirection: [tx, ty, 1], extrusionProfile });
}

/** A solid from flat faces (corner lists), each corner sheared by the lean. */
function facesSolid(faces: [number, number, number][][], lean: Lean): Shape3D {
  const [tx, ty] = lean ?? [0, 0];
  return makeSolid(faces.map((face) => makePolygon(face.map(([x, y, z]) => [x + z * tx, y + z * ty, z] as [number, number, number]))));
}

/** Corners of a box from (x0, y0, 0) to (x1, y1, h) as six faces. */
function boxFaces(x0: number, y0: number, x1: number, y1: number, h: number): [number, number, number][][] {
  const c = (i: number): [number, number, number] => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? h : 0];
  return [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]].map((f) => f.map(c));
}

/**
 * Taper: every side face leans in by `deg` from straight up, pivoting about the
 * base (z = 0), so the bottom keeps its size. Negative leans out.
 */
function draftSides(shape: Shape3D, deg: number): Shape3D | null {
  try {
    const result = shape.draft(deg, (f) => f.not((g) => g.parallelTo("XY")));
    return isValidShape(result) ? result : null;
  } catch {
    return null; // OpenCascade's draft only handles some faces (not round ones).
  }
}

/** Kinds that can be rebuilt narrowing towards the top when a draft won't work on them. */
const SCALE_TAPER = new Set(["cylinder", "tube", "cone", "prism", "gear", "star", "text", "sketch"]);

/** Extrude or revolve one 2D drawing, in the sketch's XY frame (direction/offset applied later). */
function solidify(d: Drawing, p: SketchParams, lean: Lean = null, taper = 0): Shape3D {
  const sketch = d.sketchOnPlane("XY") as unknown as Solidifiable;
  if (p.operation === "revolve") {
    const [[minU], [maxU]] = d.boundingBox.bounds;
    if (minU < -1e-9 && maxU > 1e-9) throw new Error("A revolved profile must stay on one side of the V axis (the green line).");
    if (p.pitch && p.pitch > 0) return coilShape(d, p);
    return sketch.revolve([0, 1, 0], { origin: [0, 0, 0], angle: p.angle });
  }
  const depth = Math.abs(p.depth);
  return extrudeUp(d, p.direction === "both" ? depth * 2 : depth, lean, taper);
}

/**
 * One sketch entity as a solid. A brush stroke is first merged in 2D (fast);
 * if that gives bad geometry, its capsules are merged as solids instead (slow but robust).
 */
function entitySolid(e: SketchEntity, p: SketchParams, lean: Lean, taper: number): Shape3D | null {
  const d = entityDrawing(e);
  if (!d) return null;
  const solid = solidify(d, p, lean, taper);
  if (e.type !== "stroke" || isValidShape(solid)) return solid;
  let merged: Shape3D | null = null;
  for (const piece of strokePieces(e)) {
    const s = solidify(pathDrawing(piece), p, lean, taper);
    merged = merged ? merged.fuse(s) : s;
  }
  return merged;
}

/**
 * Each shape becomes its own solid and they're combined with 3D booleans,
 * which OpenCascade handles far more reliably than 2D booleans on complex,
 * overlapping outlines (e.g. crossing brush strokes).
 */
function buildSketch(p: SketchParams, featureLean: Lean, taper = 0, self?: Feature): Shape3D | null {
  if (p.operation === "flat") return null; // Just a drawing until it's extruded or revolved.
  if (p.operation === "sweep") {
    if (p.sweepProfile !== "sketch") throw new Error("A sweep needs a brush stroke to follow: draw one with the Brush tool (B).");
    let shape = profileSweep(p, self);
    if (p.offset) shape = shape.translate(0, 0, p.offset);
    for (const r of PLANE_ROTATIONS[p.plane]) shape = shape.rotate(r.degrees, [0, 0, 0], r.axis);
    return shape;
  }
  if (p.operation === "loft") {
    let shape = loftShape(p, self);
    for (const r of PLANE_ROTATIONS[p.plane]) shape = shape.rotate(r.degrees, [0, 0, 0], r.axis);
    return p.offset ? shape.translate(...(new Vector3(0, 0, p.offset).applyMatrix4(planeTurn(p)).toArray() as [number, number, number])) : shape;
  }
  // Only an extrusion straight up from the XY plane leans (other planes would lean sideways).
  const lean = p.operation === "extrude" && p.plane === "XY" ? featureLean : null;
  const profileEntities = p.entities.filter(isProfile);
  let shape: Shape3D | null = null;
  for (const e of profileEntities.filter((e) => e.mode === "add")) {
    const s = entitySolid(e, p, lean, taper);
    if (s) shape = shape ? shape.fuse(s) : s;
  }
  if (!shape) return null;
  for (const e of profileEntities.filter((e) => e.mode === "subtract")) {
    const s = entitySolid(e, p, lean, taper);
    if (s) shape = shape.cut(s);
  }
  if (self?.edgeOps.length) shape = tidyForFinishes(shape, p, lean, taper);

  if (p.operation === "extrude") {
    const depth = Math.abs(p.depth);
    // A negative depth extrudes the other way, same as "reversed".
    const reversed = (p.direction === "reversed") !== p.depth < 0;
    // Moved down along its slant, so a leaning sketch still leans about its plane.
    if (p.direction === "both" || reversed) shape = shape.translate(-depth * (lean?.[0] ?? 0), -depth * (lean?.[1] ?? 0), -depth);
  }
  if (p.offset) shape = shape.translate(0, 0, p.offset);
  for (const r of PLANE_ROTATIONS[p.plane]) shape = shape.rotate(r.degrees, [0, 0, 0], r.axis);
  return shape;
}

/** Edges shorter than this, where a sketch's shapes nearly meet, are closed up (see closeTinyEdges). */
const TINY_EDGE = 0.15;
/** Edges meeting at less than this many degrees off smooth get a tiny rounding (see roundNearSmooth). */
const NEAR_SMOOTH = 25;

/**
 * A sketch's profile tidied for fillets and chamfers, which OpenCascade can't fit beside an edge
 * a few hundredths of a millimetre long (where the sketch's shapes nearly meet), nor across a join
 * where two edges meet almost but not quite smoothly (as curved polygon edges often do). The
 * profile is redrawn in 2D with those taken out, as long as that gives the same solid otherwise.
 */
function tidyForFinishes(shape: Shape3D, p: SketchParams, lean: Lean, taper: number): Shape3D {
  if (p.operation !== "extrude" && p.operation !== "revolve") return shape;
  try {
    const d = tidyDrawing(profileDrawing(p, "This sketch"));
    if (!d) return shape;
    const solid = solidify(d, p, lean, taper);
    const [was, now] = [measureVolume(shape), measureVolume(solid)];
    return isValidShape(solid) && Math.abs(now - was) <= 0.005 * was + 0.5 ? solid : shape;
  } catch {
    return shape;
  }
}

/** The drawing with each loop tidied (see tidyForFinishes), or null if there was nothing to tidy. */
function tidyDrawing(d: Drawing): Drawing | null {
  let changed = false;
  const loop = (bp: Blueprint) => {
    const out = tidyLoop(bp);
    if (out !== bp) changed = true;
    return out;
  };
  const compound = (c: Blueprint | CompoundBlueprint) => (c instanceof CompoundBlueprint ? new CompoundBlueprint(c.blueprints.map(loop)) : loop(c));
  const inner = (d as unknown as { innerShape: Blueprint | CompoundBlueprint | Blueprints | null }).innerShape;
  if (!inner) return null;
  const shape = inner instanceof Blueprints ? new Blueprints(inner.blueprints.map(compound)) : compound(inner);
  return changed ? new Drawing(shape) : null;
}

/** A loop's edge being tidied: a line, an arc (through `via`) or another curve (left as it is). */
type Piece = { kind: "line" | "arc" | "other"; a: P2; b: P2; via: P2; curve: Curve2D | null };

/** About how long an edge is. */
const pieceLength = (x: Piece) => (x.kind === "line" ? dist2(x.a, x.b) : dist2(x.a, x.via) + dist2(x.via, x.b));

/** An arc's circle, and whether it runs anticlockwise. */
function pieceCircle(x: Piece): { o: P2; r: number; ccw: boolean } | null {
  const [a, m, b] = [x.a, x.via, x.b];
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const sq = (p: P2) => p[0] * p[0] + p[1] * p[1];
  const o: P2 = [(sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d, (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d];
  return { o, r: dist2(a, o), ccw: (m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]) > 0 };
}

/** The point midway along an arc of `circle` from `a` to `b`. */
function arcMiddle(c: { o: P2; r: number; ccw: boolean }, a: P2, b: P2): P2 {
  const ang = (p: P2) => Math.atan2(p[1] - c.o[1], p[0] - c.o[0]);
  const turn = (((c.ccw ? ang(b) - ang(a) : ang(a) - ang(b)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const t = ang(a) + ((c.ccw ? 1 : -1) * turn) / 2;
  return [c.o[0] + c.r * Math.cos(t), c.o[1] + c.r * Math.sin(t)];
}

/** Which way an edge runs at its start or end (a unit vector). */
function pieceTangent(x: Piece, end: "a" | "b"): P2 {
  const c = x.kind === "arc" ? pieceCircle(x) : null;
  if (!c) {
    const l = dist2(x.a, x.b) || 1;
    return [(x.b[0] - x.a[0]) / l, (x.b[1] - x.a[1]) / l];
  }
  const p = x[end];
  const s = c.ccw ? 1 : -1;
  return [(-(p[1] - c.o[1]) / c.r) * s, ((p[0] - c.o[0]) / c.r) * s];
}

/**
 * A closed loop tidied for fillets and chamfers: arcs that hardly bulge (by under 0.01 mm, a
 * nudged polygon edge) made straight, edges shorter than TINY_EDGE taken out (the edges either
 * side meet at the tiny one's middle instead), then each join where two lines or arcs meet a
 * little off smooth (under NEAR_SMOOTH degrees) rounded with an arc just big enough to make it
 * smooth, at most 0.3 mm along each edge: the outline moves by thousandths of a millimetre.
 */
function tidyLoop(bp: Blueprint): Blueprint {
  const pieces: Piece[] = bp.curves.map((c) => ({ kind: c.geomType === "LINE" ? "line" : c.geomType === "CIRCLE" ? "arc" : "other", a: c.firstPoint, b: c.lastPoint, via: c.value((c.firstParameter + c.lastParameter) / 2), curve: c }));
  let straightened = 0;
  for (const x of pieces) {
    const chord = dist2(x.a, x.b);
    const bulge = chord > 1e-9 ? Math.abs((x.b[0] - x.a[0]) * (x.via[1] - x.a[1]) - (x.b[1] - x.a[1]) * (x.via[0] - x.a[0])) / chord : Infinity;
    if (x.kind === "arc" && bulge < 0.01) {
      Object.assign(x, { kind: "line", curve: null });
      straightened++;
    }
  }
  const changed = straightened + closeTinyEdges(pieces) + roundNearSmooth(pieces) > 0;
  if (!changed) return bp;
  return new Blueprint(
    pieces.map((x) => {
      if (x.curve) return x.curve;
      const pen = new BlueprintSketcher(x.a);
      return (x.kind === "line" ? pen.lineTo(x.b) : pen.threePointsArcTo(x.b, x.via)).done().curves[0];
    }),
  );
}

/** Take out a loop's tiny edges (see tidyLoop); how many. A changed edge loses its `curve`, to be redrawn. */
function closeTinyEdges(pieces: Piece[]): number {
  let closed = 0;
  for (let i = 0; pieces.length > 3 && i < pieces.length; ) {
    const n = pieces.length;
    const [prev, tiny, next] = [pieces[(i - 1 + n) % n], pieces[i], pieces[(i + 1) % n]];
    if (pieceLength(tiny) >= TINY_EDGE || (prev.kind === "other" && next.kind === "other")) {
      i++;
      continue;
    }
    // Other curves can't be redrawn: the edges meet at their end.
    const at: P2 = prev.kind === "other" ? tiny.a : next.kind === "other" ? tiny.b : [(tiny.a[0] + tiny.b[0]) / 2, (tiny.a[1] + tiny.b[1]) / 2];
    if (prev.kind !== "other") Object.assign(prev, { b: at, curve: null });
    if (next.kind !== "other") Object.assign(next, { a: at, curve: null });
    pieces.splice(i, 1);
    closed++;
    i = Math.max(0, i - 1); // The edge before may be tiny now.
  }
  return closed;
}

/** Round a loop's joins that are a little off smooth (see tidyLoop); how many. */
function roundNearSmooth(pieces: Piece[]): number {
  let rounded = 0;
  for (let i = 0; i < pieces.length; i++) {
    const [p, q] = [pieces[i], pieces[(i + 1) % pieces.length]];
    if (p.kind === "other" || q.kind === "other" || p === q) continue;
    const blend = joinBlend(p, q);
    if (!blend) continue;
    pieces.splice(i + 1, 0, blend);
    rounded++;
    i++;
  }
  return rounded;
}

/**
 * The arc rounding the join from `p` into `q` (a line or arc each) if they meet a little off
 * smooth, with `p` and `q` cut back to meet it; null (and nothing changed) otherwise.
 */
function joinBlend(p: Piece, q: Piece): Piece | null {
  const [u, v] = [pieceTangent(p, "b"), pieceTangent(q, "a")];
  const turn = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
  if (Math.abs(turn) < 1e-3 || Math.abs(turn) > (NEAR_SMOOTH * Math.PI) / 180) return null;
  const side = Math.sign(turn); // The rounding's centre is on the side the outline turns to.
  const along = Math.min(0.3, pieceLength(p) / 4, pieceLength(q) / 4);
  let r = Math.min(along / Math.tan(Math.abs(turn) / 2), 200);
  const [cp, cq] = [p.kind === "arc" ? pieceCircle(p) : null, q.kind === "arc" ? pieceCircle(q) : null];
  // Each edge moved `r` towards that side: a line shifts; an arc's circle grows or shrinks.
  const inward = (c: { ccw: boolean }) => c.ccw === side > 0;
  for (const c of [cp, cq]) if (c && inward(c)) r = Math.min(r, c.r * 0.5);
  type Offset = { line: [P2, P2] } | { o: P2; r: number };
  const offset = (x: Piece, c: { o: P2; r: number; ccw: boolean } | null): Offset => {
    if (!c) {
      const t = pieceTangent(x, "a");
      const n: P2 = [-t[1] * side * r, t[0] * side * r];
      return { line: [[x.a[0] + n[0], x.a[1] + n[1]], t] };
    }
    return { o: c.o, r: inward(c) ? c.r - r : c.r + r };
  };
  const centres = crossings(offset(p, cp), offset(q, cq));
  const join = p.b;
  const centre = centres.sort((m, n) => dist2(m, join) - dist2(n, join))[0];
  if (!centre) return null;
  // Where the rounding touches each edge, which must be near the join, on the edge.
  const touch = (x: Piece, c: { o: P2; r: number } | null): P2 => {
    if (!c) {
      const t = pieceTangent(x, "a");
      const k = (centre[0] - x.a[0]) * t[0] + (centre[1] - x.a[1]) * t[1];
      return [x.a[0] + t[0] * k, x.a[1] + t[1] * k];
    }
    const l = dist2(centre, c.o) || 1;
    return [c.o[0] + ((centre[0] - c.o[0]) / l) * c.r, c.o[1] + ((centre[1] - c.o[1]) / l) * c.r];
  };
  const [tp, tq] = [touch(p, cp), touch(q, cq)];
  if (dist2(tp, join) > pieceLength(p) / 2 || dist2(tq, join) > pieceLength(q) / 2 || dist2(tp, tq) < 1e-6) return null;
  const mid: P2 = [(tp[0] + tq[0]) / 2 - centre[0], (tp[1] + tq[1]) / 2 - centre[1]];
  const ml = Math.hypot(mid[0], mid[1]) || 1;
  const blend: Piece = { kind: "arc", a: tp, b: tq, via: [centre[0] + (mid[0] / ml) * r, centre[1] + (mid[1] / ml) * r], curve: null };
  Object.assign(p, { b: tp, via: cp ? arcMiddle(cp, p.a, tp) : p.via, curve: null });
  Object.assign(q, { a: tq, via: cq ? arcMiddle(cq, tq, q.b) : q.via, curve: null });
  return blend;
}

/** Where two lines (a point and direction) or circles cross. */
function crossings(m: { line: [P2, P2] } | { o: P2; r: number }, n: { line: [P2, P2] } | { o: P2; r: number }): P2[] {
  if ("line" in m && "line" in n) {
    const [[a, d], [b, e]] = [m.line, n.line];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) return [];
    const t = ((b[0] - a[0]) * e[1] - (b[1] - a[1]) * e[0]) / den;
    return [[a[0] + d[0] * t, a[1] + d[1] * t]];
  }
  if ("line" in m || "line" in n) {
    const [l, c] = "line" in m ? [m, n as { o: P2; r: number }] : [n as { line: [P2, P2] }, m];
    const [a, d] = l.line;
    const f: P2 = [a[0] - c.o[0], a[1] - c.o[1]];
    const bq = f[0] * d[0] + f[1] * d[1];
    const disc = bq * bq - (f[0] * f[0] + f[1] * f[1] - c.r * c.r);
    if (disc < 0) return [];
    return [-bq - Math.sqrt(disc), -bq + Math.sqrt(disc)].map((t) => [a[0] + d[0] * t, a[1] + d[1] * t] as P2);
  }
  const [c1, c2] = [m, n] as { o: P2; r: number }[];
  const d = dist2(c1.o, c2.o);
  if (d < 1e-12 || d > c1.r + c2.r || d < Math.abs(c1.r - c2.r)) return [];
  const a = (c1.r * c1.r - c2.r * c2.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, c1.r * c1.r - a * a));
  const [ux, uy] = [(c2.o[0] - c1.o[0]) / d, (c2.o[1] - c1.o[1]) / d];
  const [px, py] = [c1.o[0] + ux * a, c1.o[1] + uy * a];
  return [
    [px - uy * h, py + ux * h],
    [px + uy * h, py - ux * h],
  ];
}

type EdgeFilter = Parameters<Shape3D["fillet"]>[1];

/**
 * Set while building a solid made from a mesh: its curves are many small flat
 * facets, and only the edges at real corners (not the seams between facets)
 * count for "all", "top", "bottom" and "vertical" edges.
 */
let facetedBuild = false;

/** Facets meeting at less than this angle are one smooth surface. */
const FACET_ANGLE = 30;

/** Upper bound for OpenCascade shape hashes (as replicad uses). */
const HASH_MAX = 2147483647;

type OcShape = { delete(): void };

/** A faceted solid's corner edges (with the faces either side), worked out once per shape. */
const cornerCache = new WeakMap<Shape3D, { edge: OcShape; faces: OcShape[]; normals: (Vector3 | null)[] }[]>();

/**
 * The edges where a faceted solid's faces meet at more than FACET_ANGLE (or
 * where a face is curved), with their faces. Found with OpenCascade's own
 * shape map: listing a shape's edges through replicad compares each with
 * every other, which takes minutes on thousands of facets.
 */
function cornerEdges(shape: Shape3D) {
  let corners = cornerCache.get(shape);
  if (corners) return corners;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  // Each edge comes up once per face it bounds: the same edge is found by its hash, then IsSame.
  const byHash = new Map<number, { edge: { IsSame(o: unknown): boolean }; faces: OcShape[]; normals: (Vector3 | null)[] }[]>();
  const all: { edge: { IsSame(o: unknown): boolean }; faces: OcShape[]; normals: (Vector3 | null)[] }[] = [];
  const faces = new oc.TopExp_Explorer((shape as unknown as { wrapped: unknown }).wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; faces.More(); faces.Next()) {
    const face = oc.TopoDS.Face(faces.Current());
    const wrapped = cast(face) as unknown as { geomType: string; normalAt(): { toTuple(): [number, number, number] } };
    const normal = wrapped.geomType === "PLANE" ? new Vector3(...wrapped.normalAt().toTuple()) : null;
    const edges = new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; edges.More(); edges.Next()) {
      const edge = oc.TopoDS.Edge(edges.Current());
      const hash = oc.ReplicadShapeHasher.HashCode(edge, HASH_MAX) as number;
      const bucket = byHash.get(hash) ?? [];
      let entry = bucket.find((x) => x.edge.IsSame(edge));
      if (!entry) {
        entry = { edge, faces: [], normals: [] };
        bucket.push(entry);
        all.push(entry);
        byHash.set(hash, bucket);
      }
      entry.faces.push(face);
      entry.normals.push(normal);
    }
    edges.delete();
  }
  faces.delete();
  const limit = Math.cos((FACET_ANGLE * Math.PI) / 180);
  corners = [];
  for (const { edge, faces, normals } of all) {
    if (faces.length !== 2) continue; // A seam (or an open edge): nothing to round between.
    // Faces may face either way round here, so it's the line's angle that counts.
    if (normals[0] && normals[1] && Math.abs(normals[0].dot(normals[1])) >= limit) continue;
    corners.push({ edge: edge as unknown as OcShape, faces, normals });
  }
  cornerCache.set(shape, corners);
  return corners;
}

/** A faceted solid's corner edges that an op's target picks. */
function facetedTargets(shape: Shape3D, op: EdgeOp) {
  const filter = edgeFilter(shape, op);
  const finder = filter ? (filter(new EdgeFinder(), shape) as unknown as { shouldKeep(e: Edge): boolean }) : null;
  return cornerEdges(shape).filter((c) => !finder || finder.shouldKeep(cast(c.edge as never) as unknown as Edge));
}

/** A fillet, chamfer or bevel on a faceted solid's corners (see cornerEdges). */
function facetedEdgeOp(shape: Shape3D, op: EdgeOp, size: number): Shape3D {
  const targets = facetedTargets(shape, op);
  if (!targets.length) throw new Error("No edge matches.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const wrapped = (shape as unknown as { wrapped: unknown }).wrapped;
  const builder = op.type === "fillet" ? new oc.BRepFilletAPI_MakeFillet(wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational) : new oc.BRepFilletAPI_MakeChamfer(wrapped);
  try {
    for (const { edge, faces, normals } of targets) {
      if (op.type !== "bevel") builder.Add(size, edge);
      else {
        // As bevel(): the distance runs along the flatter face (or the other, flipped).
        const flatness = (k: number) => Math.abs(normals[k]?.z ?? 0);
        let k = flatness(1) > flatness(0) + 1e-6 ? 1 : 0;
        if (op.flip) k = 1 - k;
        builder.AddDA(size, (Math.min(89, Math.max(1, op.angle ?? 45)) * Math.PI) / 180, edge, faces[k]);
      }
    }
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
  }
}

function edgeFilter(shape: Shape3D, op: EdgeOp): EdgeFilter | undefined {
  const [[, , zMin], [, , zMax]] = shape.boundingBox.bounds;
  switch (op.target) {
    case "all":
      return undefined;
    case "top":
      return (f) => f.inPlane("XY", zMax);
    case "bottom":
      return (f) => f.inPlane("XY", zMin);
    case "vertical":
      return (f) => f.inDirection("Z");
    case "picked":
      return (f) => f.either(op.points.map((p) => (g: typeof f) => g.atDistance(0, p, 1e-3)));
  }
}

/** OpenCascade can return broken geometry instead of failing (e.g. a fillet bigger than the part), so check. */
function isValidShape(shape: Shape3D): boolean {
  const oc = getOC() as unknown as Record<string, new (...args: unknown[]) => { IsValid?: () => boolean; IsValid_2?: () => boolean; delete(): void }>;
  const analyzer = new oc.BRepCheck_Analyzer((shape as unknown as { wrapped: unknown }).wrapped, true, false);
  try {
    return (analyzer.IsValid_2 ?? analyzer.IsValid)!.call(analyzer);
  } finally {
    analyzer.delete();
  }
}

/**
 * Sizes actually used by edge operations whose requested size was too big
 * (op id → size; 0 means it couldn't be applied at any size). Filled during a build.
 */
let adjusted: Record<string, number> = {};

/** The op at `size`, or null if OpenCascade fails or returns invalid geometry. */
function tryEdgeOp(shape: Shape3D, op: EdgeOp, size: number): Shape3D | null {
  try {
    if (facetedBuild) {
      const result = facetedEdgeOp(shape, op, size);
      return isValidShape(result) ? result : null;
    }
    const filter = edgeFilter(shape, op);
    const result = op.type === "fillet" ? shape.fillet(size, filter) : op.type === "bevel" ? bevel(shape, op, size, filter) : shape.chamfer(size, filter);
    return isValidShape(result) ? result : null;
  } catch (err) {
    if (err instanceof Error && /no edge/i.test(err.message)) throw err;
    return null;
  }
}

/**
 * An uneven chamfer: `size` along one face at each edge and the cut at `angle`
 * from it. That face is the flatter of the edge's two (the top or bottom, on
 * most parts), or the other one when the op is flipped.
 */
function bevel(shape: Shape3D, op: EdgeOp, size: number, filter: EdgeFilter | undefined): Shape3D {
  const edges = filter ? filter(new EdgeFinder(), shape).find(shape) : shape.edges;
  if (!edges.length) throw new Error("No edge matches.");
  const angle = Math.min(89, Math.max(1, op.angle ?? 45));
  const faces = shape.faces;
  const oc = getOC() as unknown as {
    BRepFilletAPI_MakeChamfer: new (s: unknown) => { AddDA(d: number, a: number, e: unknown, f: unknown): void; Shape(): unknown; IsDone(): boolean; delete(): void };
  };
  const builder = new oc.BRepFilletAPI_MakeChamfer((shape as unknown as { wrapped: unknown }).wrapped);
  try {
    for (const edge of edges) {
      const mid = edge.pointAt(0.5);
      const touching = faces.filter((face) => face.edges.some((e) => e.isSame(edge)));
      if (touching.length < 2) continue; // A seam or open edge: nothing to bevel between.
      const flatness = (face: (typeof faces)[number]) => Math.abs(face.normalAt(mid).z);
      const [a, b] = touching;
      let face = flatness(b) > flatness(a) + 1e-6 ? b : a;
      if (op.flip) face = face === a ? b : a;
      builder.AddDA(size, (angle * Math.PI) / 180, (edge as unknown as { wrapped: unknown }).wrapped, (face as unknown as { wrapped: unknown }).wrapped);
    }
    return cast(builder.Shape() as never) as Shape3D;
  } finally {
    builder.delete();
  }
}

/**
 * Apply one op at its size, or, if that's too big for the shape, at the
 * largest size that still gives valid geometry (found by bisection, with a
 * small margin so the result isn't razor-thin).
 */
function safeEdgeOp(shape: Shape3D, op: EdgeOp): Shape3D {
  const exact = tryEdgeOp(shape, op, op.size);
  if (exact) return exact;
  if (op.type === "bevel") {
    // Keep the distance and make the cut flatter (it reaches less far down the side), if any angle fits.
    const flatter = flattestFit(shape, op);
    if (flatter) {
      adjusted[`${op.id}@angle`] = flatter.angle;
      return flatter.shape;
    }
  }
  // Too big for some edges only (a thin part's sharp tip, a tiny step): the full size where it fits, smaller just there.
  const partial = !facetedBuild && op.type !== "bevel" ? partialEdgeOp(shape, op) : null;
  if (partial) {
    adjusted[op.id] = partial.size;
    adjusted[`${op.id}@edges`] = partial.reduced;
    if (partial.rest !== undefined) adjusted[`${op.id}@rest`] = partial.rest;
    return partial.shape;
  }
  let lo = 0;
  let hi = op.size;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (tryEdgeOp(shape, op, mid)) lo = mid;
    else hi = mid;
  }
  const safe = Math.floor(lo * 0.98 * 100) / 100;
  const result = safe > 0 ? tryEdgeOp(shape, op, safe) : null;
  if (!result && !facetedBuild && op.type !== "bevel") {
    // Each edge takes it, but not all together, at any size: the full size on as many as go together.
    const filter = edgeFilter(shape, op);
    const edges = filter ? filter(new EdgeFinder(), shape).find(shape) : shape.edges;
    const most = edges.length > 1 && edges.length <= 80 ? mostEdges(shape, op, edges, []) : null;
    if (most) {
      adjusted[op.id] = 0;
      adjusted[`${op.id}@edges`] = edges.length - most.kept;
      return most.shape;
    }
  }
  adjusted[op.id] = result ? safe : 0;
  return result ?? shape;
}

/** A fillet or chamfer with its own size for each edge (null skips one), or null if it fails. */
function tryEdgeSizes(shape: Shape3D, op: EdgeOp, size: (e: Edge) => number | null): Shape3D | null {
  try {
    const result = op.type === "fillet" ? shape.fillet(size) : shape.chamfer(size);
    return isValidShape(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * When an edge finish doesn't fit all its edges at its size: each edge tried
 * on its own, the size kept on those it fits, and the largest that fits used
 * on the rest. Null if it fits none, or the two sizes don't go together.
 */
function partialEdgeOp(shape: Shape3D, op: EdgeOp): { shape: Shape3D; size: number; reduced: number; rest?: number } | null {
  const filter = edgeFilter(shape, op);
  const edges = filter ? filter(new EdgeFinder(), shape).find(shape) : shape.edges;
  // Each edge is a try of its own: not for a part with very many.
  if (edges.length < 2 || edges.length > 80) return null;
  const only = (set: Edge[], size: number) => (e: Edge) => (set.some((x) => x.isSame(e)) ? size : null);
  const bad = edges.filter((e) => !tryEdgeSizes(shape, op, only([e], op.size)));
  if (!bad.length || bad.length === edges.length) return null;
  const good = edges.filter((e) => !bad.includes(e));
  let lo = 0;
  let hi = op.size;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (tryEdgeSizes(shape, op, only(bad, mid))) lo = mid;
    else hi = mid;
  }
  const small = Math.floor(lo * 0.98 * 100) / 100;
  const both = (big: number) => tryEdgeSizes(shape, op, (e) => (good.some((x) => x.isSame(e)) ? big : small > 0 && bad.some((x) => x.isSame(e)) ? small : null));
  const result = both(op.size);
  if (result) return { shape: result, size: small, reduced: bad.length };
  // The edges beside one too small for it (a tiny edge where two shapes nearly meet) often can't take it
  // either, and some only fail together: the full size on as many as go together, the rest left sharp.
  const most = mostEdges(shape, op, good, bad);
  if (most && most.kept * 2 >= good.length) return { shape: most.shape, size: 0, reduced: edges.length - most.kept };
  // Too few of them: the biggest size the rest can take alongside the small one, if that's better than one size for all.
  let [a, b] = [small, op.size];
  for (let i = 0; i < 7; i++) {
    const mid = (a + b) / 2;
    if (both(mid)) a = mid;
    else b = mid;
  }
  const big = Math.floor(a * 0.98 * 100) / 100;
  const smaller = big > small * 1.2 ? both(big) : null;
  if (smaller) return { shape: smaller, size: small, reduced: bad.length, rest: big };
  return most ? { shape: most.shape, size: 0, reduced: edges.length - most.kept } : null;
}

/**
 * The finish at full size on as many of `good` as go together: first all those not touching a
 * `bad` edge at once, then one at a time (those away from trouble, then the longest, first).
 */
function mostEdges(shape: Shape3D, op: EdgeOp, good: Edge[], bad: Edge[]): { shape: Shape3D; kept: number } | null {
  const only = (set: Edge[]) => (e: Edge) => (set.some((x) => x.isSame(e)) ? op.size : null);
  const ends = (e: Edge) => [e.startPoint, e.endPoint];
  const touches = (e: Edge) => bad.some((x) => ends(x).some((p) => ends(e).some((q) => p.sub(q).Length < 1e-4)));
  const order = good.map((e) => ({ e, near: touches(e), length: e.length })).sort((x, y) => Number(x.near) - Number(y.near) || y.length - x.length);
  const kept: Edge[] = [];
  let best: Shape3D | null = null;
  const away = order.filter((x) => !x.near).map((x) => x.e);
  const together = away.length ? tryEdgeSizes(shape, op, only(away)) : null;
  if (together) {
    kept.push(...away);
    best = together;
  }
  // One at a time is a try each: not for very many.
  if (order.length <= 40) {
    for (const { e } of order) {
      if (kept.includes(e)) continue;
      const tried = tryEdgeSizes(shape, op, only([...kept, e]));
      if (tried) {
        kept.push(e);
        best = tried;
      }
    }
  }
  return best ? { shape: best, kept: kept.length } : null;
}

/** A bevel at its full distance with the steepest angle (below the one asked for) that still fits, if any. */
function flattestFit(shape: Shape3D, op: EdgeOp): { shape: Shape3D; angle: number } | null {
  const at = (angle: number) => tryEdgeOp(shape, { ...op, angle }, op.size);
  if (!at(1)) return null;
  let lo = 1;
  let hi = Math.min(89, Math.max(1, op.angle ?? 45));
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid)) lo = mid;
    else hi = mid;
  }
  // A whole tenth of a degree, a little under the limit so the result isn't razor-thin.
  for (let angle = Math.floor(lo * 0.98 * 10) / 10; angle >= 1; angle = Math.round((angle - 0.5) * 10) / 10) {
    const result = at(angle);
    if (result) return { shape: result, angle };
  }
  return null;
}

/** Apply fillets/chamfers in order, shrinking any that are too big for the shape. */
function applyEdgeOps(shape: Shape3D, ops: EdgeOp[], which: (op: EdgeOp) => boolean = () => true): Shape3D {
  for (const [i, op] of ops.entries()) {
    if (!which(op) || op.size <= 0 || (op.target === "picked" && op.points.length === 0)) continue;
    const label = `${op.type === "fillet" ? "Fillet" : op.type === "bevel" ? "Bevel" : "Chamfer"} ${i + 1}`;
    if (facetedBuild && op.target !== "picked" && !facetedTargets(shape, op).length)
      throw new Error(`${label}: there are no sharp corners there to ${op.type === "fillet" ? "round" : "cut"} (this solid was made from a mesh and its curves are smooth; import the part as a STEP file for real edges).`);
    try {
      shape = logged(`${label} (${op.size} mm, ${op.target} edges)`, () => safeEdgeOp(shape, op));
    } catch {
      throw new Error(`${label}: its edges no longer exist; pick them again.`);
    }
  }
  return shape;
}

/** The feature's own geometry with its fillets/chamfers, in its local frame. */
function buildOwn(f: Feature, swept = true): Shape3D | null {
  let shape = buildBase(f);
  const taper = f.kind !== "group" ? (f.tilt?.taper ?? 0) : 0;
  if (shape && taper) {
    // Draft the sides if OpenCascade can (exact angle on flat sides), else rebuild it narrowing.
    const drafted = draftSides(shape, taper);
    if (drafted) shape = drafted;
    else if (SCALE_TAPER.has(f.kind)) shape = buildBase(f, taper);
    else throw new Error("This shape's sides can't be tapered.");
  }
  // Text takes neither: OpenCascade can't round or hollow font outlines reliably (see the Text panel).
  const finished = f.kind !== "group" && f.kind !== "text";
  if (shape && finished && f.edgeOps.length) {
    facetedBuild = isFaceted(f);
    try {
      shape = applyEdgeOps(shape, f.edgeOps, (o) => !o.afterHoles);
    } finally {
      facetedBuild = false;
    }
  }
  if (shape && finished && f.shell) shape = applyShell(shape, f.shell);
  if (shape && finished && hasAfterHoles(f)) {
    // Cut by the holes that reach it first, so the edges they make can be rounded.
    shape = cutByReachingHoles(f, shape);
    facetedBuild = isFaceted(f);
    try {
      shape = applyEdgeOps(shape, f.edgeOps, (o) => !!o.afterHoles);
    } finally {
      facetedBuild = false;
    }
  }
  if (shape && clearanceOf(f)) shape = logged(`grow the hole by ${clearanceOf(f)} mm (clearance)`, () => growSolid(shape!, clearanceOf(f)));
  if (shape && swept && sweepOf(f)) {
    // Only exact results (a STEP export) need it as a solid; the view and meshes use its triangles.
    const w = sweptTriangles(f, shape);
    shape = logged("make the swept hole a solid", () => solidFromTriangles(w.vertices, w.triangles, [1, 1, 1], "bodies"));
    knownTriangles.set(shape, w);
  }
  return shape && f.clips?.length ? applyClips(shape, f.clips) : shape;
}

/** Edge finishes set to go after the holes (a merged group's go on its merged result, after the holes from outside it). */
const hasAfterHoles = (f: Feature) => (f.kind !== "group" || isMergedGroup(f)) && f.mode === "solid" && f.edgeOps.some((o) => o.afterHoles);

/** The model being worked on (for an object's after-holes finishes, which need the holes that reach it). */
let modelFeatures: Feature[] = [];

/**
 * The holes cut into an object before its after-holes finishes. When those finishes are all on picked
 * edges, just the holes near one: a hole elsewhere can't make those edges, and cutting it exactly first
 * can take many seconds on a big part (it's cut afterwards with the rest, as triangles, far quicker).
 */
function holesCutFirst(features: Feature[], f: Feature): Feature[] {
  const ops = f.edgeOps.filter((o) => o.afterHoles && o.size > 0);
  const near = ops.length && ops.every((o) => o.target === "picked") ? ops.flatMap((o) => o.points.map((p) => ({ p, r: o.size + 1 }))) : null;
  const back = worldMatrix(features, f.id).invert();
  return cuttingHoles(features, f).filter((h) => {
    // A hole made of triangles (a swept cut, a groove, a mesh) would take many seconds to cut exactly, and
    // its faceted edges don't round well: it's left to cut afterwards, as holes usually do.
    const sub = subtreeIds(features, h.id);
    if (hasFaceted(features.filter((x) => sub.has(x.id)))) return false;
    if (!near) return true;
    const hs = branch(features, h);
    if (!hs) return false;
    // Its box, in the object's frame.
    const [a, b] = hs.boundingBox.bounds;
    hs.delete();
    const to = back.clone().multiply(worldMatrix(features, h.id));
    const box = new Box3();
    for (const c of [0, 1, 2, 3, 4, 5, 6, 7]) box.expandByPoint(new Vector3(c & 1 ? b[0] : a[0], c & 2 ? b[1] : a[1], c & 4 ? b[2] : a[2]).applyMatrix4(to));
    return near.some(({ p, r }) => box.clone().expandByScalar(r).containsPoint(new Vector3(...p)));
  });
}

/** A shape in an object's frame with the holes that reach it (near its after-holes finishes) cut away. */
function cutByReachingHoles(f: Feature, shape: Shape3D): Shape3D {
  const features = modelFeatures;
  if (!features.some((x) => x.id === f.id)) return shape;
  const [lo, hi] = shape.boundingBox.bounds;
  for (const h of holesCutFirst(features, f)) {
    const hs = branch(features, h);
    if (!hs) continue;
    const local = fromWorld(features, f, placeInWorld(features, h, hs));
    const [a, b] = local.boundingBox.bounds;
    if ([0, 1, 2].some((k) => a[k] > hi[k] || b[k] < lo[k])) continue;
    shape = logged(`${f.name}: cut by ${h.name} before its edge finishes`, () => booleanSafe(shape, local, "cut"));
  }
  return shape;
}

/** A shape in the world, moved into an object's own frame (back through its parents). */
function fromWorld(features: Feature[], f: Feature, shape: Shape3D): Shape3D {
  const chain: Feature[] = [];
  for (let n: Feature | undefined = f; n; n = features.find((x) => x.id === n!.parentId)) chain.push(n);
  for (let i = chain.length - 1; i >= 0; i--) shape = unplace(chain[i], shape);
  return shape;
}

/** What an object's after-holes finishes depend on: the holes that reach it, and where they are from it. */
function afterHolesKey(f: Feature) {
  if (!hasAfterHoles(f)) return null;
  const features = modelFeatures;
  const back = worldMatrix(features, f.id).invert();
  return holesCutFirst(features, f).map((h) => [geometryKey(features, h.id), back.clone().multiply(worldMatrix(features, h.id)).elements.map(r6)]);
}

/**
 * Hollow a solid: walls `thickness` thick. Open at the top or bottom, the face
 * there is removed (a cup or box); closed, the inside is an empty pocket.
 */
function applyShell(shape: Shape3D, s: Shell): Shape3D {
  if (s.thickness <= 0) return shape;
  const [[, , zMin], [, , zMax]] = shape.boundingBox.bounds;
  try {
    const picked = s.open === "picked" ? pickedFaces(shape, s.faces ?? []) : [];
    if (s.open === "top" || s.open === "bottom" || picked.length) {
      const z = s.open === "top" ? zMax : zMin;
      // Positive: walls go inward, outside size kept.
      const result = picked.length ? shape.shell(s.thickness, (f) => f.inList(picked)) : shape.shell(s.thickness, (f) => f.inPlane("XY", z));
      if (isValidShape(result)) return result;
      throw new Error("invalid");
    }
    const oc = getOC() as unknown as { BRepOffsetAPI_MakeOffsetShape: new () => { PerformByJoin(s: unknown, offset: number, tol: number): void; Shape(): unknown; IsDone(): boolean; delete(): void } };
    const maker = new oc.BRepOffsetAPI_MakeOffsetShape();
    try {
      maker.PerformByJoin((shape as unknown as { wrapped: unknown }).wrapped, -s.thickness, 1e-3);
      if (!maker.IsDone()) throw new Error("offset failed");
      const inner = cast(maker.Shape() as Parameters<typeof cast>[0]) as Shape3D;
      const result = shape.cut(inner);
      if (isValidShape(result)) return result;
      throw new Error("invalid");
    } finally {
      maker.delete();
    }
  } catch {
    throw new Error(`Couldn't hollow this shape with ${s.thickness} mm walls: try thinner walls${s.open === "none" ? ", or open it at the top" : ""}.`);
  }
}

/**
 * The faces under clicked points (in the shape's frame). A point from the
 * view's mesh can sit a little off a curved face, so a looser match is tried
 * when no face passes through it.
 */
function pickedFaces(shape: Shape3D, points: [number, number, number][]): Face[] {
  const out: Face[] = [];
  for (const p of points) {
    let hits = new FaceFinder().atDistance(0, p, 1e-3).find(shape);
    if (!hits.length) hits = new FaceFinder().atDistance(0, p, 0.06).find(shape);
    out.push(...hits.filter((h) => !out.some((o) => o.isSame(h))));
  }
  return out;
}

/**
 * A solid grown by `by` mm on every side (its edges and corners rounded over),
 * for a hole with clearance. A solid made from triangles is grown as triangles.
 */
function growSolid(shape: Shape3D, by: number): Shape3D {
  const viaMesh = (w: WorldMesh) => {
    const grown = growMesh(w, by);
    const solid = solidFromTriangles(grown.vertices, grown.triangles, [1, 1, 1], "bodies");
    knownTriangles.set(solid, grown);
    return solid;
  };
  const known = knownTriangles.get(shape);
  if (known) return viaMesh(known);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const maker = new oc.BRepOffsetAPI_MakeOffsetShape();
  const temps: { delete(): void }[] = [maker];
  try {
    maker.PerformByJoin((shape as unknown as { wrapped: unknown }).wrapped, by, 1e-3);
    if (!maker.IsDone()) throw new Error("offset failed");
    let out = maker.Shape();
    if (out.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
      // Sometimes it comes back as the closed skin only: make that a solid.
      const make = new oc.BRepBuilderAPI_MakeSolid();
      temps.push(make);
      make.Add(oc.TopoDS.Shell(out));
      out = make.Solid();
      oc.BRepLib.OrientClosedSolid(out);
    }
    const result = cast(out) as Shape3D;
    if (isValidShape(result)) return result;
    throw new Error("invalid");
  } catch {
    // OpenCascade couldn't offset it exactly: grow its triangles instead.
    return viaMesh(shapeTriangles(shape));
  } finally {
    for (const t of temps) t.delete();
  }
}

/**
 * Triangles grown by `by` mm: each corner moves out so every face it touches
 * ends up `by` further out (flat faces stay flat; a closed mesh stays closed).
 */
function growMesh(w: WorldMesh, by: number): WorldMesh {
  const { vertices, triangles } = w;
  // Corners at the same place (the triangles of different faces) move together.
  const weld = new Map<string, number>();
  const group = new Int32Array(vertices.length / 3);
  for (let i = 0; i < group.length; i++) {
    const key = `${Math.round(vertices[i * 3] * 1e4)},${Math.round(vertices[i * 3 + 1] * 1e4)},${Math.round(vertices[i * 3 + 2] * 1e4)}`;
    let g = weld.get(key);
    if (g === undefined) weld.set(key, (g = weld.size));
    group[i] = g;
  }
  const normals: number[][][] = Array.from({ length: weld.size }, () => []);
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let t = 0; t < triangles.length; t += 3) {
    a.fromArray(vertices, triangles[t] * 3);
    b.fromArray(vertices, triangles[t + 1] * 3);
    c.fromArray(vertices, triangles[t + 2] * 3);
    const n = c.sub(b).cross(a.sub(b));
    const len = n.length();
    if (len < 1e-12) continue;
    n.divideScalar(len);
    for (let k = 0; k < 3; k++) {
      const list = normals[group[triangles[t + k]]];
      if (!list.some((m) => m[0] * n.x + m[1] * n.y + m[2] * n.z > 0.999)) list.push([n.x, n.y, n.z]);
    }
  }
  // Each corner's move: the point `by` out from every face around it (found by repeated projection).
  const moves = new Float32Array(weld.size * 3);
  for (let g = 0; g < weld.size; g++) {
    const list = normals[g];
    let [x, y, z] = [0, 0, 0];
    for (let it = 0; it < 24; it++)
      for (const [nx, ny, nz] of list) {
        const d = by - (x * nx + y * ny + z * nz);
        x += d * nx;
        y += d * ny;
        z += d * nz;
      }
    // A needle-sharp tip would shoot far out: keep it near.
    const len = Math.hypot(x, y, z);
    const s = len > by * 4 ? (by * 4) / len : 1;
    moves.set([x * s, y * s, z * s], g * 3);
  }
  const out = new Float32Array(vertices.length);
  for (let i = 0; i < group.length; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = vertices[i * 3 + k] + moves[group[i] * 3 + k];
  return { vertices: out, triangles };
}

/** A faceted solid's own triangles, grown if it's a hole with clearance. */
function facetOwn(f: Extract<Feature, { kind: "imported" }>): WorldMesh {
  if (sweepOf(f)) return sweptTriangles(f);
  return facetGrown(f);
}

/** A faceted solid's triangles, grown if it's a hole with clearance. */
function facetGrown(f: Extract<Feature, { kind: "imported" }>): WorldMesh {
  const w = facetTriangles(f.params);
  const by = clearanceOf(f);
  if (!by) return w;
  const key = `${f.params.ref}|${f.params.scale.join(",")}|${by}`;
  let grown = grownCache.get(key);
  if (!grown) {
    grown = logged(`grow the hole by ${by} mm (clearance)`, () => growMesh(w, by));
    grownCache.set(key, grown);
    if (grownCache.size > 16) grownCache.delete(grownCache.keys().next().value!);
  }
  return grown;
}
const grownCache = new Map<string, WorldMesh>();

/** An object's own shape as triangles (straight from them for faceted solids and swept holes), or null if it can't be made. */
function ownTriangles(f: Feature): WorldMesh | null {
  if (f.kind === "imported" && plainFaceted(f)) return facetOwn(f);
  if (plainGroove(f)) return meshSketchTriangles(f);
  if (!sweepOf(f)) {
    const s = buildOwnSafe(f);
    return s && shapeTriangles(s);
  }
  try {
    return logged(`${f.name}: its swept shape`, () => sweptTriangles(f));
  } catch (err) {
    failures[f.id] = message(err);
    return null;
  }
}

/** A swept hole's triangles in its own frame: its shape (grown by any clearance) at every step of the swing, joined. */
function sweptTriangles(f: Feature, unswept?: Shape3D): WorldMesh {
  const s = sweepOf(f)!;
  const key = JSON.stringify([f.kind, keyParams(f), f.edgeOps, f.clips ?? [], f.shell ?? null, f.tilt ?? null]);
  let w = sweptCache.get(key) ?? keptResult<WorldMesh>("sweeps", key);
  if (!w) {
    const base = f.kind === "imported" && plainFaceted(f) ? facetGrown(f) : shapeTriangles(unswept ?? buildOwn(f, false)!);
    w = logged(`sweep the hole through ${fmtRange(s)}`, () => sweepMesh(base, s, clearanceOf(f)));
    keepResult("sweeps", key, w);
  }
  if (!sweptCache.has(key)) {
    sweptCache.set(key, w);
    if (sweptCache.size > 16) sweptCache.delete(sweptCache.keys().next().value!);
  }
  return w;
}
const sweptCache = new Map<string, WorldMesh>();

// ---- Results kept between visits --------------------------------------------------------
//
// A sweep, or cutting the holes into a big imported part, can take seconds, and
// reloading the page would redo them. Finished ones are kept in this browser
// (IndexedDB), by everything that shapes them, and read back when the worker
// starts. Bump KEPT_VERSION when how they're made changes.

const KEPT_VERSION = 4;
const KEPT_LIMIT = { sweeps: 12, cuts: 16 } as const;
type KeptStore = keyof typeof KEPT_LIMIT;
const kept: Record<KeptStore, Map<string, unknown>> = { sweeps: new Map(), cuts: new Map() };
/** Each store's full keys, oldest first (to know what to drop without reading the entries back). */
const keptOrder: Record<KeptStore, string[]> = { sweeps: [], cuts: [] };
let keptDb: IDBDatabase | null = null;

/** A short name for a long key (53-bit string hash; the full key is kept with each entry). */
function hashKey(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

type KeptEntry = { key: string; value: unknown; at: number };

const idb = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));

/** Read what's kept (nothing, quietly, where the browser won't keep it: a private window). */
const keptLoaded = (async () => {
  try {
    const open = indexedDB.open("gizmocad-kept", 1);
    open.onupgradeneeded = () => {
      for (const name of Object.keys(KEPT_LIMIT)) open.result.createObjectStore(name);
    };
    keptDb = await idb(open);
    for (const name of Object.keys(KEPT_LIMIT) as KeptStore[]) {
      const all = (await idb(keptDb.transaction(name).objectStore(name).getAll())) as KeptEntry[];
      for (const e of all.sort((a, b) => a.at - b.at)) {
        kept[name].set(e.key, e.value);
        keptOrder[name].push(e.key);
      }
    }
  } catch {
    keptDb = null;
  }
})();

/** A result kept from an earlier visit. */
const keptResult = <T>(store: KeptStore, key: string) => kept[store].get(`${KEPT_VERSION}|${key}`) as T | undefined;

/** Keep a finished result for later visits (past the store's limit, the oldest go). */
function keepResult(store: KeptStore, key: string, value: unknown) {
  const full = `${KEPT_VERSION}|${key}`;
  const order = keptOrder[store];
  const at = order.indexOf(full);
  if (at >= 0) order.splice(at, 1);
  order.push(full);
  kept[store].set(full, value);
  const gone = order.splice(0, Math.max(0, order.length - KEPT_LIMIT[store]));
  for (const old of gone) kept[store].delete(old);
  if (!keptDb) return;
  try {
    const os = keptDb.transaction(store, "readwrite").objectStore(store);
    os.put({ key: full, value, at: Date.now() } satisfies KeptEntry, hashKey(full));
    for (const old of gone) os.delete(hashKey(old));
  } catch {
    // Not kept: it's only a speed-up.
  }
}

const fmtRange = (s: Sweep) => `${s.from} to ${s.to}${s.joint.type === "slider" ? " mm" : "°"}`;

/**
 * Triangles moved through a joint's range (copies close enough together that
 * the gaps between them are tiny), joined into one shape. With clearance the
 * gaps can be half of it (up to 0.15 mm): far fewer copies, and quicker.
 */
function sweepMesh(w: WorldMesh, s: Sweep, clearance = 0): WorldMesh {
  const tol = Math.max(0.03, Math.min(0.15, clearance / 2));
  const M = manifoldReady;
  if (!M) throw new Error("The mesh library isn't loaded.");
  const [lo, hi] = [Math.min(s.from, s.to), Math.max(s.from, s.to)];
  const frame = new Matrix4().fromArray(s.frame);
  // Copies close enough that the shape strays under `tol` between them: for a hinge, by how far it reaches from the axis.
  let step = 0.1;
  if (s.joint.type !== "slider") {
    const o = new Vector3(s.joint.origin.x, s.joint.origin.y, s.joint.origin.z);
    const axis = new Vector3(s.joint.axis.x, s.joint.axis.y, s.joint.axis.z).normalize();
    const v = new Vector3();
    let reach = 1;
    for (let i = 0; i < w.vertices.length; i += 3) {
      v.fromArray(w.vertices, i).applyMatrix4(frame).sub(o);
      reach = Math.max(reach, v.sub(axis.clone().multiplyScalar(v.dot(axis))).length());
    }
    step = Math.max(0.25, (2 * Math.acos(Math.max(-1, 1 - tol / reach)) * 180) / Math.PI);
  }
  const count = Math.min(240, Math.max(1, Math.ceil((hi - lo) / step)));
  const back = frame.clone().invert();
  const from = jointMatrix(s.joint, s.joint.value, s.position).invert();
  const whole = toManifold(M, w, "the hole's shape has gaps, so its swing can't be swept.");
  // Fewer triangles in each copy: detail finer than the gaps between copies is lost in the sweep anyway.
  const base = whole.simplify(tol / 2);
  whole.delete();
  const copies: InstanceType<ManifoldLib["Manifold"]>[] = [];
  try {
    const poses: Matrix4[] = [];
    for (let i = 0; i <= count; i++) {
      const value = lo + ((hi - lo) * i) / count;
      const m = back.clone().multiply(jointMatrix(s.joint, value, s.position)).multiply(from).multiply(frame);
      poses.push(m);
      copies.push(base.transform(m.elements as Parameters<typeof base.transform>[0]));
    }
    if (s.joint.type === "hinge") copies.push(...logged("fill the gaps between the sweep's copies", () => sweepGaps(M, base, poses, tol)));
    const joined = M.Manifold.union(copies);
    // The seams between copies leave many tiny facets: merge those that change the shape by under 0.01 mm.
    const simpler = joined.simplify(0.01);
    try {
      return fromManifold(simpler);
    } finally {
      joined.delete();
      simpler.delete();
    }
  } finally {
    for (const c of [base, ...copies]) c.delete();
  }
}

/**
 * What the copies of a sweep miss between them: behind a sharp corner a
 * V-shaped notch, and past a thin part (a blade's edge, a pin's chamfer) a gap
 * the part really passes through, left standing as shards. Each face moving
 * forward fills the space it moves through between neighbouring copies.
 */
function sweepGaps(M: ManifoldLib, base: InstanceType<ManifoldLib["Manifold"]>, poses: Matrix4[], minGap: number) {
  const mesh = base.getMesh();
  const stride = mesh.numProp;
  const tris = mesh.triVerts;
  const nv = mesh.vertProperties.length / stride;
  const pts = Array.from({ length: nv }, (_, i) => new Vector3(mesh.vertProperties[i * stride], mesh.vertProperties[i * stride + 1], mesh.vertProperties[i * stride + 2]));
  const nt = tris.length / 3;
  // Each triangle's neighbours (across its edges), and its normal and middle.
  const edgeOwner = new Map<number, number>();
  const neighbours: number[][] = Array.from({ length: nt }, () => []);
  const normals: Vector3[] = [];
  const middles: Vector3[] = [];
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [pts[tris[t * 3]], pts[tris[t * 3 + 1]], pts[tris[t * 3 + 2]]];
    normals.push(b.clone().sub(a).cross(c.clone().sub(a)).normalize());
    middles.push(a.clone().add(b).add(c).divideScalar(3));
    for (let k = 0; k < 3; k++) {
      const [u, v] = [tris[t * 3 + k], tris[t * 3 + ((k + 1) % 3)]];
      const key = Math.min(u, v) * nv + Math.max(u, v);
      const other = edgeOwner.get(key);
      if (other === undefined) edgeOwner.set(key, t);
      else {
        neighbours[t].push(other);
        neighbours[other].push(t);
      }
    }
  }
  const fills: InstanceType<ManifoldLib["Manifold"]>[] = [];
  const side = new Float32Array(nt);
  const moved = new Float32Array(nt);
  const v = new Vector3();
  for (let i = 0; i + 1 < poses.length; i++) {
    // The step's motion in the shape's own frame: which way each triangle faces it.
    const step = poses[i].clone().invert().multiply(poses[i + 1]);
    for (let t = 0; t < nt; t++) {
      v.copy(middles[t]).applyMatrix4(step).sub(middles[t]);
      const len = v.length();
      moved[t] = len;
      side[t] = len > 1e-9 ? normals[t].dot(v) / len : 0;
    }
    const edge = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) {
      // Only the faces moving forward sweep new space (one along the motion, or one hardly moving,
      // leaves no more than the arc's own small sag between copies).
      if (moved[t] < minGap || side[t] < 0.02) continue;
      edge[t] = 1;
    }
    // Neighbouring forward faces nearly in one plane (within the tolerance) fill as one:
    // far fewer pieces to join, and the shape strays from the true sweep by no more than the tolerance.
    const done = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) {
      if (!edge[t] || done[t]) continue;
      done[t] = 1;
      const n = normals[t];
      const d = n.dot(middles[t]);
      const ids = new Set<number>();
      const add = (k: number) => {
        for (let j = 0; j < 3; j++) ids.add(tris[k * 3 + j]);
      };
      add(t);
      const queue = [t];
      while (queue.length && ids.size < 60) {
        const k = queue.shift()!;
        for (const m of neighbours[k]) {
          if (!edge[m] || done[m] || normals[m].dot(n) < 0.95) continue;
          const vs = [0, 1, 2].map((j) => pts[tris[m * 3 + j]]);
          if (vs.some((p) => Math.abs(n.dot(p) - d) > minGap / 2)) continue;
          done[m] = 1;
          add(m);
          queue.push(m);
        }
      }
      const corners = [...ids].flatMap((id) => [pts[id].clone().applyMatrix4(poses[i]), pts[id].clone().applyMatrix4(poses[i + 1])].map((q) => [q.x, q.y, q.z] as [number, number, number]));
      const hull = M.Manifold.hull(corners);
      if (hull.isEmpty()) hull.delete();
      else fills.push(hull);
    }
  }
  return fills;
}

/** The model without the solid parts hidden inside a merged group (and what's inside them). */
function withoutHiddenInside(features: Feature[], group: Feature): Feature[] {
  const inside = subtreeIds(features, group.id);
  const gone = new Set<string>();
  for (const x of features) if (x.id !== group.id && x.hidden && x.mode === "solid" && inside.has(x.id)) for (const id of subtreeIds(features, x.id)) gone.add(id);
  return gone.size ? features.filter((x) => !gone.has(x.id)) : features;
}

/** A big box filling one side of a tilted cut plane, around the shape's bounds lo..hi. */
function halfSpace(c: Clip, lo: number[], hi: number[]): Shape3D {
  const n = clipNormal(c);
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const [nx, ny, nz] = [n.x / len, n.y / len, n.z / len];
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 10;
  // Built with its cut face at z = 0 (keeping z < 0 for "below"), then turned so +Z is the normal.
  let box: Shape3D = makeBox([-size, -size, c.keep === "below" ? -2 * size : 0], [size, size, c.keep === "below" ? 0 : 2 * size]);
  const axis: [number, number, number] = [-ny, nx, 0]; // Z × normal
  const s = Math.hypot(axis[0], axis[1]);
  if (s > 1e-9) box = box.rotate((Math.atan2(s, nz) * 180) / Math.PI, [0, 0, 0], axis);
  else if (nz < 0) box = box.rotate(180, [0, 0, 0], [1, 0, 0]);
  // Onto the plane, at the point nearest the shape's middle.
  const mid = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
  const t = c.at - (nx * mid[0] + ny * mid[1] + nz * mid[2]);
  return box.translate(mid[0] + nx * t, mid[1] + ny * t, mid[2] + nz * t);
}

/** Keep one side of each cut (a split piece): intersect with a box covering that side. */
function applyClips(shape: Shape3D, clips: Clip[]): Shape3D {
  for (const c of clips) {
    const region = clipRegion(c, ...shape.boundingBox.bounds);
    if (!region) throw new Error("This piece's split is outside the object, so nothing is left of it.");
    shape = shape.intersect(region);
  }
  return shape;
}

/** The side of a split a piece keeps, as a solid covering a shape within `lo`..`hi` (null: none of it's on that side). */
function clipRegion(c: Clip, lo0: ArrayLike<number>, hi0: ArrayLike<number>): Shape3D | null {
  const lo = [0, 1, 2].map((i) => lo0[i] - 1);
  const hi = [0, 1, 2].map((i) => hi0[i] + 1);
  if (c.normal) return halfSpace(c, lo, hi);
  const i = { x: 0, y: 1, z: 2 }[c.axis];
  if (c.keep === "below") hi[i] = c.at;
  else lo[i] = c.at;
  if (hi[i] - lo[i] < 1e-6) return null;
  return makeBox(lo as [number, number, number], hi as [number, number, number]);
}

/** A split piece's side, as triangles: what's inside it, cut to its side (see clipsKid). */
function clipMesh(w: WorldMesh, clips: Clip[]): WorldMesh | null {
  for (const c of clips) {
    const region = clipRegion(c, ...meshBounds(w));
    if (!region) return null;
    w = meshBoolean(w, shapeTriangles(region), "intersect");
  }
  return w;
}

/**
 * Whether a split piece cuts something inside it to its side too: what was copied with it when it was split
 * does, but another split piece put inside it keeps its own side (the other half, say, to go with it).
 */
const clipsKid = (self: Feature | null, kid: Feature): self is Feature & { clips: Clip[] } => !!self && self.kind !== "group" && !!self.clips?.length && !kid.clips?.length;

/**
 * A threaded rod: a core cylinder plus a 60° thread ridge swept along a helix,
 * trimmed to length (the helix starts and ends past the ends, so they're cut clean).
 */
function buildThread(diameter: number, pitch: number, length: number): Shape3D {
  if (diameter <= 0 || pitch <= 0 || length <= 0) throw new Error("A thread needs a diameter, pitch and length above 0.");
  if (pitch > diameter / 3) throw new Error("The pitch is too big for this diameter (try a pitch under a third of it).");
  const rMajor = diameter / 2;
  const rMinor = rMajor - 0.54 * pitch; // Close to metric (ISO) thread depth.
  const base = rMinor - 0.05; // The ridge's foot sits just inside the core so they fuse.
  const z0 = -pitch;
  const p = (r: number, z: number): [number, number, number] => [r, 0, z0 + z * pitch];
  const outline = [p(base, -0.4), p(rMajor, -0.06), p(rMajor, 0.06), p(base, 0.4)];
  const profile = assembleWire(outline.map((a, i) => makeLine(a, outline[(i + 1) % outline.length])));
  const helix = makeHelix(pitch, length + 2 * pitch, base, [0, 0, z0]);
  const ridge = genericSweep(profile, helix, { frenet: true });
  // The core runs past both ends too: if its flat ends cut through the ridge, OpenCascade's fuse fails.
  const core = makeCylinder(rMinor, length + 4 * pitch, [0, 0, -2 * pitch]);
  return core.fuse(ridge).intersect(makeCylinder(rMajor + 1, length));
}

/**
 * A coil spring: the wire's cross-section (round, or square, which prints
 * better) swept along a helix. Flat ends: the coil runs past the ends and is
 * cut off level, so the spring stands flat.
 */
function buildSpring({ diameter, wire, pitch, height, section, ends }: SpringParams): Shape3D {
  const r = diameter / 2 - wire / 2; // The helix runs through the middle of the wire.
  if (wire <= 0 || pitch <= 0 || height <= wire) throw new Error("A spring needs a wire, pitch and height (taller than the wire).");
  if (wire >= pitch) throw new Error("The wire is thicker than the coil spacing, so the coils would overlap. Use a bigger pitch.");
  if (r <= wire / 2) throw new Error("The coil diameter is too small for this wire.");
  const z0 = ends ? -wire : wire / 2;
  const helix = makeHelix(pitch, ends ? height + 2 * wire : height - wire, r, [0, 0, z0]);
  let profile;
  if (section === "square") {
    // A square in the plane through the axis (like a thread's profile).
    const h = wire / 2;
    const sq: [number, number, number][] = [[r - h, 0, z0 - h], [r + h, 0, z0 - h], [r + h, 0, z0 + h], [r - h, 0, z0 + h]];
    profile = assembleWire(sq.map((a, i) => makeLine(a, sq[(i + 1) % sq.length])));
  } else {
    const t = Math.hypot(2 * Math.PI * r, pitch);
    profile = assembleWire([makeCircle(wire / 2, [r, 0, z0], [0, (2 * Math.PI * r) / t, pitch / t])]);
  }
  const coil = genericSweep(profile, helix, { frenet: true });
  if (!ends) return coil;
  const big = diameter + 2;
  return coil.intersect(makeBox([-big, -big, 0], [big, big, height]));
}

/**
 * A flat (zigzag) spring lying on the bed: straight strips across the width
 * (X) joined by half-ring bends, stacked along Y (the way it squashes), `depth`
 * thick in Z. Optional end plates span the full width at both ends.
 * Built standing up in X/Z, then laid down.
 */
function buildFlatSpring({ diameter: width, wire: t, pitch, height, depth, ends, bends }: SpringParams): Shape3D {
  if (t <= 0 || pitch <= 0 || depth <= 0 || height <= t) throw new Error("A flat spring needs a strip thickness, spacing, depth and height (taller than the strip).");
  if (bends === "sharp") return layFlat(zigzagStruts(width, t, pitch, height, depth, ends), depth);
  if (t >= pitch) throw new Error("The strip is thicker than the spacing, so the bends would touch. Use a bigger spacing.");
  const runs = Math.max(1, Math.floor((height - t) / pitch));
  const step = (height - t) / runs; // Spread the runs to fill the height exactly.
  const bend = step / 2; // Radius of the bends (to the strip's middle).
  const cx = width / 2 - bend - t / 2; // Where the bends' centres sit.
  if (cx <= 0) throw new Error("The spring is too narrow for this spacing. Make it wider or the spacing smaller.");
  const y0 = -depth / 2;
  const parts: Shape3D[] = [];
  for (let i = 0; i <= runs; i++) {
    const z = t / 2 + i * step;
    parts.push(makeBox([-cx, y0, z - t / 2], [cx, -y0, z + t / 2]));
    if (i === runs) break;
    // Bend up to the next run, alternating right and left.
    const side = i % 2 === 0 ? 1 : -1;
    const zc = z + bend;
    const ring = makeCylinder(bend + t / 2, depth, [side * cx, y0, zc], [0, 1, 0]).cut(makeCylinder(bend - t / 2, depth + 2, [side * cx, y0 - 1, zc], [0, 1, 0]));
    const half = side > 0 ? makeBox([cx, y0 - 1, zc - step], [cx + step + t, -y0 + 1, zc + step]) : makeBox([-cx - step - t, y0 - 1, zc - step], [-cx, -y0 + 1, zc + step]);
    parts.push(ring.intersect(half));
  }
  if (ends) {
    parts.push(makeBox([-width / 2, y0, 0], [width / 2, -y0, t]));
    parts.push(makeBox([-width / 2, y0, height - t], [width / 2, -y0, height]));
  }
  return layFlat(parts.reduce((a, b) => a.fuse(b)), depth);
}

/** Lay a spring built standing in X/Z (Y from -depth/2) down flat: Z becomes Y, sitting on the bed. */
function layFlat(shape: Shape3D, depth: number): Shape3D {
  return shape.rotate(-90, [0, 0, 0], [1, 0, 0]).translate(0, 0, depth / 2);
}

/**
 * A sharp zigzag spring standing in X/Z: straight struts going corner to corner
 * across the width, each rising by `pitch`, with a small round at each tip
 * (it stops the tips cracking when printed and flexed).
 */
function zigzagStruts(width: number, t: number, pitch: number, height: number, depth: number, ends: boolean): Shape3D {
  const struts = Math.max(1, Math.round((height - t) / pitch));
  const rise = (height - t) / struts; // Fill the height exactly.
  const cx = width / 2 - t / 2;
  if (cx <= t) throw new Error("The spring is too narrow for this strip width.");
  const len = Math.hypot(2 * cx, rise);
  // Struts going the same way are parallel; they must not touch each other.
  if ((2 * rise * 2 * cx) / len <= t * 1.1) throw new Error("The zigzag is too tight for this strip width: make the spacing bigger or the strip narrower.");
  const y0 = -depth / 2;
  const angle = (Math.atan2(rise, 2 * cx) * 180) / Math.PI;
  const parts: Shape3D[] = [];
  for (let i = 0; i <= struts; i++) {
    const x = i % 2 === 0 ? -cx : cx;
    const z = t / 2 + i * rise;
    parts.push(makeCylinder(t / 2, depth, [x, y0, z], [0, 1, 0]));
    if (i === struts) break;
    // From this corner to the opposite one, one step up.
    const dir = i % 2 === 0 ? 1 : -1;
    const strut = makeBox([-len / 2, y0, -t / 2], [len / 2, -y0, t / 2]).rotate(-dir * angle, [0, 0, 0], [0, 1, 0]);
    parts.push(strut.translate(0, 0, z + rise / 2));
  }
  if (ends) {
    parts.push(makeBox([-width / 2, y0, 0], [width / 2, -y0, t]));
    parts.push(makeBox([-width / 2, y0, height - t], [width / 2, -y0, height]));
  }
  return parts.reduce((a, b) => a.fuse(b));
}

/**
 * Lettering: each line drawn in the chosen font, lined up left/centre/right,
 * then the whole block centred on the origin and extruded up by `height`.
 */
function buildText(p: TextParams, lean: Lean = null, taper = 0): Shape3D {
  const family = fontFamily(p.font, p.bold);
  const font = fonts[family];
  if (!font) throw new Error(isCustomFont(p.font) ? "This text's imported font isn't in the model any more: pick another font." : "The font isn't loaded yet.");
  if (p.size <= 0 || p.height <= 0) throw new Error("Text needs a size and height above 0.");
  // `size` is the capital height; the font is drawn by its em size.
  const os2 = (font.tables as { os2?: { sCapHeight?: number } }).os2;
  const capRatio = (os2?.sCapHeight || 0.7 * font.unitsPerEm) / font.unitsPerEm;
  const em = p.size / capRatio;
  const lines = p.text.split("\n");
  let result: Drawing | null = null;
  lines.forEach((line, i) => {
    const y = -i * em * 1.25;
    // Letter by letter when spaced out, else the whole line (keeps the font's kerning).
    const pieces: { text: string; x: number }[] = [];
    if (p.spacing) {
      let x = 0;
      for (const ch of line) {
        pieces.push({ text: ch, x });
        x += font.getAdvanceWidth(ch, em) + p.spacing;
      }
    } else pieces.push({ text: line, x: 0 });
    const width = p.spacing ? pieces.reduce((w, c) => Math.max(w, c.x + font.getAdvanceWidth(c.text, em)), 0) : font.getAdvanceWidth(line, em);
    const shift = p.align === "left" ? 0 : p.align === "right" ? -width : -width / 2;
    for (const piece of pieces) {
      if (!piece.text.trim()) continue;
      const d = drawText(piece.text, { startX: piece.x + shift, startY: y, fontSize: em, fontFamily: family });
      result = result ? result.fuse(d) : d;
    }
  });
  if (!result) throw new Error("Type some text to make letters.");
  const drawing = result as Drawing;
  // Centre the block on the origin (left/right align keep their edge at x = 0).
  const [[x0, y0], [x1, y1]] = drawing.boundingBox.bounds;
  const dx = p.align === "center" ? -(x0 + x1) / 2 : 0;
  const placed = drawing.translate(dx, -(y0 + y1) / 2);
  return extrudeUp(placed, p.height, lean, taper);
}

/** A screw hole going down from z = 0 (with a little above it, so it cuts the face cleanly). */
function buildScrewHole(p: ScrewParams): Shape3D {
  const size = SCREW_SIZES[p.size];
  if (!size) throw new Error(`Unknown screw size ${p.size}.`);
  if (p.depth <= 0) throw new Error("A screw hole needs a depth above 0.");
  const r = size[p.fit] / 2;
  const top = 0.5;
  const pts: [number, number][] = [[0, -p.depth], [r, -p.depth]];
  if (p.head === "counterbore") {
    const depth = Math.min(size.boreDepth, p.depth);
    pts.push([r, -depth], [size.bore / 2, -depth], [size.bore / 2, top]);
  } else if (p.head === "countersink") {
    const R = size.sink / 2;
    const depth = Math.min(R - r, p.depth); // 90°: as deep as it is wide (per side).
    pts.push([r, -depth], [R, 0], [R + top, top]);
  } else if (p.head === "insert") {
    // The insert's hole (an extra millimetre deep, for the plastic it pushes down), then the screw's.
    const ins = INSERT_SIZES[p.size];
    const depth = Math.min(ins.length + 1, p.depth);
    pts.push([r, -depth], [ins.hole / 2, -depth], [ins.hole / 2, top]);
  } else pts.push([r, top]);
  pts.push([0, top]);
  const hole = revolveUpright(polygonDrawing(pts));
  if (p.head !== "nut") return hole;
  // A hex pocket the nut drops into, flats along X.
  const nut = NUT_SIZES[p.size];
  const corner = (nut.flats + NUT_PLAY) / Math.sqrt(3);
  const depth = Math.min(nut.thick + NUT_PLAY, p.depth);
  const hex = Array.from({ length: 6 }, (_, i) => [corner * Math.cos((i * Math.PI) / 3), corner * Math.sin((i * Math.PI) / 3)] as [number, number]);
  const pocket = extrudeUp(polygonDrawing(hex), depth + top, null).translate(0, 0, -depth);
  return hole.fuse(pocket);
}

/** A snap joint's half: the slotted peg with its catch, or the socket it clicks into (see SnapParams). */
function buildSnap(p: SnapParams): Shape3D {
  const { r, widest, land, catchAt, embed } = snapLayout(p);
  const c = p.catch;
  if (r <= 0 || p.depth <= 0 || c < 0) throw new Error("A snap joint needs a diameter and depth above 0.");
  if (catchAt < 0.5) throw new Error(`A snap joint this size needs a depth of at least ${(p.depth - catchAt + 0.5).toFixed(1)} mm for its catch.`);
  if (p.part === "socket") {
    // The bore, then a wider pocket from just before where the catch ends up (so it clicks home even if the print's a little off).
    const [bore, pocket, ledge, end] = [r + p.clearance, r + c + p.clearance, catchAt - 0.1, p.depth + snapHeadroom(p)];
    return revolveUpright(polygonDrawing([[0, -0.5], [bore, -0.5], [bore, ledge], [pocket, ledge], [pocket, end], [0, end]]));
  }
  // Sunk into its own part a little, so the two print as one.
  const tip = Math.max(0.6 * r, r - 0.4);
  const peg = revolveUpright(polygonDrawing([[0, -embed], [r, -embed], [r, catchAt], [r + c, widest - land], [r + c, widest], [tip, p.depth], [0, p.depth]]));
  // A slot down the tip, so its two halves squeeze together as the catch goes through the bore.
  const slot = Math.min(r, 2 * (c + p.clearance) + 0.3);
  const from = Math.max(0.5, Math.min(catchAt - 1, 0.3 * p.depth));
  return peg.cut(makeBaseBox(slot, 2 * (r + c) + 2, p.depth - from + 1).translate(0, 0, from));
}

function polygonDrawing(points: [number, number][]): Drawing {
  const pen = draw(points[0]);
  for (const p of points.slice(1)) pen.lineTo(p);
  return pen.close();
}

/** Spin a profile drawn as (distance from the axis, height) around the vertical Z axis. */
function revolveUpright(profile: Drawing): Shape3D {
  // Revolve about the drawing's Y axis, then stand it up so that axis is Z.
  const solid = (profile.sketchOnPlane("XY") as unknown as Solidifiable).revolve([0, 1, 0], { origin: [0, 0, 0], angle: 360 });
  return solid.rotate(90, [0, 0, 0], [1, 0, 0]);
}

/** `taper`: build it narrowing towards the top (only when a draft of its sides failed). */
function buildBase(f: Feature, taper = 0): Shape3D | null {
  const lean = LEAN_KINDS.has(f.kind) ? leanOf(f) : null;
  switch (f.kind) {
    case "box": {
      const { width: w, depth: d, height: h } = f.params;
      return lean ? facesSolid(boxFaces(-w / 2, -d / 2, w / 2, d / 2, h), lean) : makeBaseBox(w, d, h);
    }
    case "cylinder": {
      const { radius: rx, radiusY: ry, height } = f.params;
      if (rx === ry) return lean || taper ? extrudeUp(drawCircle(rx), height, lean, taper) : makeCylinder(rx, height);
      // Oval: extrude an ellipse (drawEllipse wants the larger radius first, along X).
      const d = rx >= ry ? drawEllipse(rx, ry) : drawEllipse(ry, rx).rotate(90);
      return extrudeUp(d, height, lean, taper);
    }
    case "sphere":
    {
      const { radius: rx, radiusY: ry, radiusZ: rz } = f.params;
      const round = rx === ry && ry === rz;
      return (round ? makeSphere(rx) : makeEllipsoid(rx, ry, rz)).translate(0, 0, rz);
    }
    case "cone": {
      const { radius: r, height: h } = f.params;
      let t = f.params.topRadius;
      if (taper) {
        // Its sides lean in further: a smaller top.
        t -= h * Math.tan((taper * Math.PI) / 180);
        if (t < -1e-9 || (r <= 0 && t <= 0)) throw new Error("The taper is too steep for this cone: its top would vanish.");
        t = Math.max(0, t);
      }
      if (r <= 0 && t <= 0) throw new Error("A cone needs a bottom or top diameter.");
      if (lean) {
        // Slanted: loft from the bottom circle to the shifted top one (or its tip).
        const [tx, ty] = lean;
        type Loftable = { loftWith(other: unknown[], config?: { endPoint?: [number, number, number] }): Shape3D };
        if (r <= 0) {
          const top = drawCircle(t).sketchOnPlane("XY", [h * tx, h * ty, h]) as unknown as Loftable;
          return top.loftWith([], { endPoint: [0, 0, 0] });
        }
        const bottom = drawCircle(r).sketchOnPlane("XY") as unknown as Loftable;
        if (t <= 0) return bottom.loftWith([], { endPoint: [h * tx, h * ty, h] });
        return bottom.loftWith([drawCircle(t).sketchOnPlane("XY", [h * tx, h * ty, h])]);
      }
      // Half the cone's outline (radius across, height up), spun around the vertical axis.
      return revolveUpright(polygonDrawing([[0, 0], ...(r > 0 ? [[r, 0] as [number, number]] : []), ...(t > 0 ? [[t, h] as [number, number]] : []), [0, h]]));
    }
    case "tube": {
      const { radius: r, wall, height: h } = f.params;
      if (wall >= r) throw new Error("The wall is as thick as the tube's radius, so there's no hole. Use a cylinder, or a thinner wall.");
      if (lean || taper) return extrudeUp(drawCircle(r).cut(drawCircle(r - wall)), h, lean, taper);
      return revolveUpright(polygonDrawing([[r - wall, 0], [r, 0], [r, h], [r - wall, h]]));
    }
    case "torus": {
      const { radius: r, tube: t } = f.params;
      if (2 * t >= r) throw new Error("The ring is too thick for its diameter: there'd be no hole in the middle.");
      return revolveUpright(drawCircle(t).translate(r - t, t));
    }
    case "wedge": {
      const { width: w, depth: d, height: h } = f.params;
      if (lean) {
        const c = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
        const [a, b] = [-d / 2, d / 2];
        return facesSolid(
          [
            [c(-w / 2, a, 0), c(-w / 2, b, 0), c(w / 2, b, 0), c(w / 2, a, 0)],
            [c(-w / 2, a, 0), c(-w / 2, a, h), c(-w / 2, b, h), c(-w / 2, b, 0)],
            [c(w / 2, a, 0), c(w / 2, b, 0), c(-w / 2, b, h), c(-w / 2, a, h)],
            [c(-w / 2, a, 0), c(w / 2, a, 0), c(-w / 2, a, h)],
            [c(-w / 2, b, 0), c(-w / 2, b, h), c(w / 2, b, 0)],
          ],
          lean,
        );
      }
      // The side profile (X across, Z up), extruded along Y and stood up.
      const side = polygonDrawing([[-w / 2, 0], [w / 2, 0], [-w / 2, h]]).sketchOnPlane("XY") as unknown as Solidifiable;
      return side.extrude(d).rotate(90, [0, 0, 0], [1, 0, 0]).translate(0, d / 2, 0);
    }
    case "pyramid": {
      const { width: w, depth: d, height: h } = f.params;
      const base = polygonDrawing([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]).sketchOnPlane("XY") as unknown as {
        loftWith(other: unknown[], config: { endPoint: [number, number, number] }): Shape3D;
      };
      return base.loftWith([], { endPoint: lean ? [h * lean[0], h * lean[1], h] : [0, 0, h] });
    }
    case "prism": {
      const { radius: r, height: h } = f.params;
      return extrudeUp(polygonDrawing(prismPoints(r, f.params.sides)), h, lean, taper);
    }
    case "hedron": {
      if (f.params.radius <= 0) throw new Error("A hedron needs a size above 0.");
      return facesSolid(hedron(f.params.faces, f.params.radius).faces, lean);
    }
    case "thread":
      return buildThread(f.params.diameter, f.params.pitch, f.params.length);
    case "spring":
      return f.params.style === "flat" ? buildFlatSpring(f.params) : buildSpring(f.params);
    case "gear": {
      const { teeth, module: m, thickness, bore } = f.params;
      if (m <= 0 || thickness <= 0) throw new Error("A gear needs a module and thickness above 0.");
      if (bore > 0 && bore / 2 >= (m * Math.round(teeth)) / 2 - 1.25 * m) throw new Error("The bore is wider than the gear's teeth go down to.");
      if (lean || taper) {
        const outline = pathDrawing(gearPath(teeth, m));
        return extrudeUp(bore > 0 ? outline.cut(drawCircle(bore / 2)) : outline, thickness, lean, taper);
      }
      let gear: Shape3D = (pathDrawing(gearPath(teeth, m)).sketchOnPlane("XY") as unknown as Solidifiable).extrude(thickness);
      if (bore > 0) gear = gear.cut(makeCylinder(bore / 2, thickness + 2, [0, 0, -1]));
      return gear;
    }
    case "star": {
      const { points, radius, inner, height } = f.params;
      if (radius <= 0 || inner <= 0 || height <= 0) throw new Error("A star needs sizes above 0.");
      return extrudeUp(polygonDrawing(starPoints(points, radius, inner)), height, lean, taper);
    }
    case "text":
      return buildText(f.params, lean, taper);
    case "screw":
      return buildScrewHole(f.params);
    case "snap":
      return buildSnap(f.params);
    case "sketch":
      if ((isGroove(f) || isSweepSketch(f)) && !lean && !taper) {
        // Exact solids (a STEP export) only: everything else uses the groove's triangles.
        const w = meshSketchTriangles(f);
        const solid = solidFromTriangles(w.vertices, w.triangles, [1, 1, 1], "bodies");
        knownTriangles.set(solid, w);
        return solid;
      }
      return buildSketch(f.params, lean, taper, f);
    case "imported":
      return importedShape(f.params);
    case "group":
    case "plane":
    case "sculpt": // Meshes, drawn and exported outside the kernel.
      return null;
  }
}

// ---- Imported solids -----------------------------------------------------------------------

/** Imported geometry, read once per `ref` (reading a big BREP takes a while). */
const importedCache = new Map<string, Shape3D>();

/**
 * Each imported solid's BREP text by ref. The app sends it only the first
 * time (it can be megabytes), and leaves it out of later requests.
 */
const brepStore = new Map<string, string>();
/** The same for faceted solids' triangles (`ImportedParams.mesh`). */
const meshStore = new Map<string, NonNullable<ImportedParams["mesh"]>>();

function rememberBreps(features: Feature[]) {
  for (const f of features) {
    if (f.kind !== "imported") continue;
    if (f.params.brep) brepStore.set(f.params.ref, f.params.brep);
    if (f.params.mesh) meshStore.set(f.params.ref, f.params.mesh);
  }
}

/** An imported solid's parameters for cache keys: its geometry is named by its ref (the data can be megabytes). */
const keyParams = (f: Feature) => {
  // A loft depends on the sketch it blends into, and where that is.
  // A sweep of another sketch's shape depends on that shape (not where its sketch sits).
  if (f.kind === "sketch" && f.params.operation === "sweep" && f.params.sweepProfile === "sketch") {
    const prof = modelFeatures.find((x) => x.id === f.params.sweepFrom);
    return { ...f.params, sweepShape: prof?.kind === "sketch" ? prof.params.entities : null };
  }
  if (f.kind === "sketch" && f.params.operation === "loft") {
    try {
      const { target, rel } = loftTarget(f.params, f);
      return { ...f.params, loftTarget: [target.params, rel.elements.map((v) => Math.round(v * 1e6) / 1e6)] };
    } catch {
      return f.params;
    }
  }
  const p = f.kind === "imported" ? { ...f.params, brep: undefined, mesh: undefined } : f.params;
  return clearanceOf(f) || sweepOf(f) ? { ...p, clearance: clearanceOf(f), sweep: sweepOf(f) } : p;
};

// ---- Faceted solids as triangles ---------------------------------------------------------
//
// A solid made from a mesh is thousands of flat facets. OpenCascade takes
// seconds to triangulate or cut one, so it's drawn and has holes cut from its
// triangles (with Manifold); its exact solid is made only when fillets,
// Show result or an export need it. Shapes made from triangles keep them here
// (in the shape's current frame), and placing a shape carries them along.

const knownTriangles = new WeakMap<Shape3D, WorldMesh>();

/** Each faceted solid's triangles at scale 1, by ref. */
const facetCache = new Map<string, WorldMesh>();

/** Triangles worked out from an older file's BREP (saved before they were kept), for the app to store. */
let facetMigrations: Record<string, WorldMesh> = {};

/** A faceted solid's triangles in its own frame, at its scale. */
function facetTriangles(p: ImportedParams): WorldMesh {
  let m = facetCache.get(p.ref);
  if (!m) {
    const stored = p.mesh ?? meshStore.get(p.ref);
    if (stored) m = { vertices: decodeFloats(stored.positions), triangles: decodeIndices(stored.indices) };
    else {
      // An older file: triangulate the exact solid once (slow), and hand the triangles back to keep.
      const t = logged("triangulate an older file's faceted solid (once)", () => importedBase(p).mesh({ tolerance: 0.02, angularTolerance: 0.15 }));
      m = { vertices: new Float32Array(t.vertices), triangles: new Uint32Array(t.triangles) };
      facetMigrations[p.ref] = m;
    }
    facetCache.set(p.ref, m);
  }
  if (p.scale.every((v) => v === 1)) return m;
  return { vertices: m.vertices.map((v, i) => v * p.scale[i % 3]), triangles: m.triangles };
}

/** Whether the model has solids made from meshes (then results and STL/3MF exports are worked out as triangles). */
const hasFaceted = (features: Feature[]) => features.some((f) => (f.kind === "imported" && !!f.params.faceted) || !!sweepOf(f) || plainGroove(f));

/** A groove or sweep with nothing done to it that needs its exact solid (as plainFaceted): made from triangles. */
const plainGroove = (f: Feature): f is Feature & { kind: "sketch" } => (isGroove(f) || isSweepSketch(f)) && !f.edgeOps.some((o) => o.size > 0) && !f.clips?.length && !f.shell && !f.tilt && !sweepOf(f) && !clearanceOf(f);

/** Points around a circle of radius r at height z, centred on (x, y). */
function ring(x: number, y: number, r: number, z: number, n = 24): [number, number, number][] {
  if (r <= 1e-6) return [[x, y, z]];
  return Array.from({ length: n }, (_, i) => [x + r * Math.cos((i / n) * 2 * Math.PI), y + r * Math.sin((i / n) * 2 * Math.PI), z] as [number, number, number]);
}

/** Just the turn of a sketch's plane (no offset). */
function planeTurn(p: SketchParams): Matrix4 {
  return sketchPlaneMatrix({ ...p, offset: 0 });
}

/** A sketch's first shape (not a stroke or guide) as a drawing, for a loft. */
function firstShape(p: SketchParams, what: string): Drawing {
  for (const e of p.entities) {
    if (e.mode !== "add" || e.type === "stroke" || !isProfile(e)) continue;
    const d = entityDrawing(e);
    if (d) return d;
  }
  throw new Error(`${what} has no closed shape to loft (a rectangle, circle, polygon, …).`);
}

/** Where a sketch's drawing plane sits in the world. */
const sketchWorld = (f: Feature & { kind: "sketch" }) => worldMatrix(modelFeatures, f.id).multiply(sketchPlaneMatrix(f.params));

/** The sketch a loft blends into, and where its drawing sits in the loft's drawing frame. */
function loftTarget(p: SketchParams, self: Feature | undefined): { target: Feature & { kind: "sketch" }; rel: Matrix4 } {
  const target = modelFeatures.find((x) => x.id === p.loftTo);
  if (!target || target.kind !== "sketch" || target.id === self?.id) throw new Error("Pick the sketch to loft to (in Loft to). It can be just a flat drawing.");
  if (!self || self.kind !== "sketch") throw new Error("The loft's sketch isn't in the model.");
  return { target, rel: sketchWorld(self).invert().multiply(sketchWorld(target)) };
}

/** A loft, in the sketch's drawing frame (XY): its first shape blended into the other sketch's first shape. */
function loftShape(p: SketchParams, self: Feature | undefined): Shape3D {
  const { target, rel } = loftTarget(p, self);
  const origin = new Vector3().setFromMatrixPosition(rel);
  const x = new Vector3(1, 0, 0).transformDirection(rel);
  const z = new Vector3(0, 0, 1).transformDirection(rel);
  if (Math.abs(z.z) < 1e-6 && Math.abs(origin.z) < 1e-6) throw new Error("The sketch to loft to lies in this sketch's plane: move it away (up, or to the side).");
  type Loftable = { loftWith(other: unknown, config?: { ruled?: boolean }): Shape3D };
  const from = firstShape(p, "This sketch").sketchOnPlane("XY") as unknown as Loftable;
  const plane = new Plane(origin.toArray() as [number, number, number], x.toArray() as [number, number, number], z.toArray() as [number, number, number]);
  const to = firstShape(target.params, target.name).sketchOnPlane(plane);
  return from.loftWith(to, { ruled: false });
}

/** A drawing's closed outlines as wires on a plane, each outer one with the holes inside it. */
function drawingWires(d: Drawing, plane: Plane | "XY" | "XZ"): { outer: Wire; holes: Wire[] }[] {
  const s = (typeof plane === "string" ? d.sketchOnPlane(plane) : d.sketchOnPlane(plane)) as unknown as Sketch | CompoundSketch | Sketches;
  const list: (Sketch | CompoundSketch)[] = "sketches" in s && !("outerSketch" in s) ? s.sketches : [s as Sketch | CompoundSketch];
  return list.map((k) => ("outerSketch" in k ? { outer: k.outerSketch.wire, holes: k.innerSketches.map((h) => h.wire) } : { outer: k.wire, holes: [] }));
}

/** Outlines swept along a spine into solids (their holes swept too, and cut out). */
function sweepWires(wires: { outer: Wire; holes: Wire[] }[], spine: Wire, config: GenericSweepConfig): Shape3D {
  let result: Shape3D | null = null;
  for (const { outer, holes } of wires) {
    let s = genericSweep(outer, spine, config, false);
    for (const h of holes) s = s.cut(genericSweep(h, spine, config, false));
    result = result ? result.fuse(s) : s;
  }
  if (!result) throw new Error("There's no closed shape to sweep.");
  return result;
}

/**
 * A revolve that rises by the pitch every turn: a coil, or a thread of any
 * profile. The profile is swept along a helix round the V axis; built round Z
 * (profile in XZ), then stood up so V is the axis, as a revolve's is.
 */
function coilShape(d: Drawing, p: SketchParams): Shape3D {
  const pitch = p.pitch ?? 0;
  const turns = p.angle / 360;
  if (turns <= 0) throw new Error("A coil needs an angle above 0 (360° for each turn).");
  const [[minU, minV], [maxU, maxV]] = d.boundingBox.bounds;
  const tall = maxV - minV;
  if (turns > 1 && tall >= pitch - 1e-6) throw new Error(`The shape is ${Math.round(tall * 100) / 100} mm tall, so turns ${pitch} mm apart would run into each other: make the rise per turn bigger than that.`);
  // Any radius works (the profile rides along rigidly); one near the profile keeps the sweep accurate.
  const r = Math.max(Math.abs((minU + maxU) / 2), 1);
  const helix = makeHelix(pitch, pitch * turns, r, [0, 0, 0], [0, 0, 1], !!p.coilLeft);
  return sweepWires(drawingWires(d, "XZ"), helix, { frenet: true }).rotate(-90, [0, 0, 0], [1, 0, 0]);
}

/** The sketch whose shape a sweep carries along its paths (its cross-section). */
function sweepProfileSketch(p: SketchParams, self: Feature | undefined): Feature & { kind: "sketch" } {
  const prof = modelFeatures.find((x) => x.id === p.sweepFrom);
  if (!prof || prof.kind !== "sketch" || prof.id === self?.id) throw new Error("Pick the sketch whose shape to sweep (in Shape). It can stay a flat drawing.");
  return prof;
}

/** All of a sketch's shapes as one drawing: what it adds, less what it cuts. */
function profileDrawing(p: SketchParams, what: string): Drawing {
  let d: Drawing | null = null;
  for (const e of p.entities.filter((e) => isProfile(e) && e.mode === "add")) {
    const x = entityDrawing(e);
    if (x) d = d ? d.fuse(x) : x;
  }
  if (!d) throw new Error(`${what} has no closed shape to sweep (draw a rectangle, circle, polygon… in it).`);
  for (const e of p.entities.filter((e) => isProfile(e) && e.mode === "subtract")) {
    const x = entityDrawing(e);
    if (x) d = d.cut(x);
  }
  return d;
}

/** Twice the signed area inside a loop of points (positive: counter-clockwise). */
const loopArea = (pts: [number, number][]) => pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0);

/**
 * A sweep's paths in its drawing frame: each brush stroke (a smooth curve
 * through its points) and each closed shape's outline, with which side of it
 * is outside (a closed outline run clockwise has its outside on the left).
 */
function sweepPaths(p: SketchParams): { spine: Wire; left: boolean }[] {
  const out: { spine: Wire; left: boolean }[] = [];
  for (const e of p.entities) {
    if (e.mode !== "add") continue;
    if (e.type === "stroke") {
      const line = strokeLine(e);
      const pts = line.filter((q, i) => i === 0 || Math.hypot(q[0] - line[i - 1][0], q[1] - line[i - 1][1]) > 1e-6).map(([x, y]) => [x, y, 0] as [number, number, number]);
      if (pts.length >= 2) out.push({ spine: assembleWire([pts.length === 2 ? makeLine(pts[0], pts[1]) : makeBSplineApproximation(pts, { tolerance: 1e-3 })]), left: false });
    } else if (isProfile(e)) {
      const d = entityDrawing(e);
      const left = loopArea(outline(e)) < 0;
      if (d) for (const w of drawingWires(d, "XY")) out.push({ spine: w.outer, left });
    }
  }
  return out;
}

/**
 * Another sketch's shape (the profile) swept along this sketch's paths, in
 * its drawing frame. The profile's origin rides on the path, with its V axis
 * pointing up out of this sketch's plane and its U axis to the right of the
 * path (outwards, round a closed shape).
 */
function profileSweep(p: SketchParams, self: Feature | undefined): Shape3D {
  const prof = sweepProfileSketch(p, self);
  const d = profileDrawing(prof.params, prof.name);
  const paths = sweepPaths(p);
  if (!paths.length) throw new Error("Draw the path in this sketch: a brush stroke (B), or a closed shape whose outline to follow.");
  let result: Shape3D | null = null;
  for (const { spine, left } of paths) {
    const o = spine.startPoint;
    const t = spine.tangentAt(0);
    const len = Math.hypot(t.x, t.y) || 1;
    const [tx, ty] = [t.x / len, t.y / len];
    // U to the right of the path and V up (Z): the plane faces back along the path. Flipped, U goes left.
    const plane = left ? new Plane([o.x, o.y, o.z], [-ty, tx, 0], [tx, ty, 0]) : new Plane([o.x, o.y, o.z], [ty, -tx, 0], [-tx, -ty, 0]);
    const s = sweepWires(drawingWires(d, plane), spine, { transitionMode: "right" });
    result = result ? result.fuse(s) : s;
  }
  return result!;
}

// ---- Outlines for sketches (project, offset) ---------------------------------------------------

type P2 = [number, number];
/** An edge of an outline in sketch coordinates: from a to b, straight, an arc, or another curve (`at` runs along it, 0 to 1). */
type OutlineEdge = { a: P2; b: P2; kind: "line" | "arc" | "curve"; at: (t: number) => P2 };

const dist2 = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

/** Edges chained end to end (either way round) into the closed loops they make; ends that don't close are dropped. */
function chainEdges(edges: OutlineEdge[], tol = 1e-3): OutlineEdge[][] {
  const left = edges.filter((e) => e.kind !== "line" || dist2(e.a, e.b) > tol);
  const loops: OutlineEdge[][] = [];
  while (left.length) {
    const loop = [left.shift()!];
    let end = loop[0].b;
    while (dist2(end, loop[0].a) > tol) {
      const i = left.findIndex((e) => dist2(e.a, end) <= tol || dist2(e.b, end) <= tol);
      if (i < 0) break;
      let e = left.splice(i, 1)[0];
      if (dist2(e.a, end) > tol) e = { a: e.b, b: e.a, kind: e.kind, at: ((f) => (t: number) => f(1 - t))(e.at) };
      loop.push(e);
      end = e.b;
    }
    if (dist2(end, loop[0].a) <= tol) loops.push(loop);
  }
  return loops;
}

/** A loop of edges as a sketch outline: a circle, or a polygon (arcs bend its edges; other curves become short straight steps). */
function edgeLoop(loop: OutlineEdge[], split = false): SketchLoop {
  if (loop.length === 1 && loop[0].kind === "arc") {
    const [p, q] = [loop[0].a, loop[0].at(0.5)];
    return { circle: [r4((p[0] + q[0]) / 2), r4((p[1] + q[1]) / 2), r4(dist2(p, q) / 2)] };
  }
  const points: P2[] = [];
  const bends: number[] = [];
  const arc = (a: P2, via: P2, b: P2) => {
    const d = [b[0] - a[0], b[1] - a[1]];
    const l = Math.hypot(d[0], d[1]) || 1;
    points.push([r4(a[0]), r4(a[1])]);
    bends.push(r4((via[0] - (a[0] + b[0]) / 2) * (-d[1] / l) + (via[1] - (a[1] + b[1]) / 2) * (d[0] / l)));
  };
  for (const e of loop) {
    if (e.kind === "line") {
      points.push([r4(e.a[0]), r4(e.a[1])]);
      bends.push(0);
    } else if (e.kind === "arc" && !split) arc(e.a, e.at(0.5), e.b);
    else if (e.kind === "arc") {
      arc(e.a, e.at(0.25), e.at(0.5));
      arc(e.at(0.5), e.at(0.75), e.b);
    } else {
      // Steps short enough to stay within about 0.02 mm of the curve.
      const n = Math.max(4, Math.min(64, Math.ceil(dist2(e.a, e.at(0.5)) + dist2(e.at(0.5), e.b))));
      for (let k = 0; k < n; k++) {
        const p = e.at(k / n);
        points.push([r4(p[0]), r4(p[1])]);
        bends.push(0);
      }
    }
  }
  // Straight edges in line with each other are one edge (an offset splits them where the old corners were).
  for (let i = 0; points.length > 3 && i < points.length; ) {
    const n = points.length;
    const prev = (i - 1 + n) % n;
    const [a, p, b] = [points[prev], points[i], points[(i + 1) % n]];
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
    const ahead = (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]) >= 0;
    if (!bends[prev] && !bends[i] && ahead && Math.abs(cross) <= 1e-6 * (dist2(a, b) || 1)) {
      points.splice(i, 1);
      bends.splice(i, 1);
    } else i++;
  }
  // A polygon needs three corners: halve the arcs of a two-edge loop (e.g. a slot's ends meeting).
  if (points.length < 3 && !split) return edgeLoop(loop, true);
  return { points, bends };
}

/** A replicad 1D shape (an edge) as an outline edge, its points taken through `map`. */
function outlineEdge(e: Edge, map: (x: number, y: number, z: number) => P2): OutlineEdge {
  const at = (t: number) => {
    const p = e.pointAt(t);
    return map(p.x, p.y, p.z);
  };
  const kind = e.geomType === "LINE" ? "line" : e.geomType === "CIRCLE" ? "arc" : "curve";
  return { a: at(0), b: at(1), kind, at };
}

/** The faces of `shape` in the sketch's plane as outlines (outer ones, and holes). */
function faceLoops(shape: Shape3D, map: (x: number, y: number, z: number) => P2): SketchLoop[] {
  const loops: SketchLoop[] = [];
  for (const face of shape.faces) {
    // (Both use up the face they're asked of.)
    const wires = [face.clone().outerWire(), ...face.innerWires()];
    wires.forEach((w, i) => {
      for (const loop of chainEdges(w.edges.map((e) => outlineEdge(e, map)))) loops.push({ ...edgeLoop(loop), ...(i ? { hole: true } : {}) });
    });
  }
  return loops;
}

/**
 * Where the rest of the model crosses sketch `id`'s plane: the model is cut
 * with a big flat face on that plane, and what's left of the face comes back
 * as outlines in the sketch. A plane lying on a face of the model gets that face.
 */
function sectionLoops(features: Feature[], id: string): SketchLoop[] {
  const self = features.find((f) => f.id === id);
  if (!self || self.kind !== "sketch") return [];
  const sub = subtreeIds(features, id);
  failures = {};
  const model = branch(features.filter((f) => !sub.has(f.id)), null);
  if (!model) throw new Error("There's nothing solid in the model to project.");
  const frame = sketchWorld(self);
  const back = frame.clone().invert();
  const o = new Vector3().setFromMatrixPosition(frame);
  const x = new Vector3(1, 0, 0).transformDirection(frame);
  const y = new Vector3(0, 1, 0).transformDirection(frame);
  const [lo, hi] = model.boundingBox.bounds;
  const size = 2 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + o.distanceTo(new Vector3(...lo)) + 10;
  const corner = (u: number, v: number) => o.clone().addScaledVector(x, u * size).addScaledVector(y, v * size).toArray() as [number, number, number];
  const sheet = makePolygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
  const v = new Vector3();
  const map = (px: number, py: number, pz: number): P2 => {
    v.set(px, py, pz).applyMatrix4(back);
    return [v.x, v.y];
  };
  const loops = faceLoops(model.intersect(sheet), map);
  if (!loops.length) throw new Error("The model doesn't cross this sketch's plane: move the sketch so its plane cuts through (or lies on a face of) what to project.");
  return loops;
}

/** A sketch shape's outline offset outwards by `distance` (inwards below 0), corners kept sharp. */
function offsetLoops(e: SketchEntity, distance: number): SketchLoop[] {
  const d = entityDrawing(e);
  if (!d) return [];
  let out: Drawing;
  try {
    out = d.offset(distance, { lineJoinType: "miter" });
  } catch {
    throw new Error(`Couldn't offset it by ${distance} mm: ${distance < 0 ? "it may be too thin to go in that far" : "try a smaller distance"}.`);
  }
  // A drawing is one outline (a blueprint), or several, each maybe with holes: all of them, in order.
  type Blue = { curves?: { geomType: string; firstParameter: number; lastParameter: number; value(t: number): [number, number] }[]; blueprints?: Blue[] };
  const flat: Blue[] = [];
  const walk = (b: Blue) => (b.blueprints ? b.blueprints.forEach(walk) : flat.push(b));
  walk((out as unknown as { innerShape: Blue }).innerShape);
  const loops = flat.flatMap((b) =>
    chainEdges(
      (b.curves ?? []).map((c): OutlineEdge => {
        const at = (t: number) => c.value(c.firstParameter + t * (c.lastParameter - c.firstParameter)) as P2;
        return { a: at(0), b: at(1), kind: c.geomType === "LINE" ? "line" : c.geomType === "CIRCLE" ? "arc" : "curve", at };
      }),
    ),
  );
  // Holes are the loops inside an odd number of others.
  const rings = loops.map((l) => l.flatMap((e) => [0, 0.25, 0.5, 0.75].map((t) => e.at(t))));
  const inside = (p: P2, ring: P2[]) => ring.reduce((c, a, k) => {
    const b = ring[(k + 1) % ring.length];
    return (a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0] ? !c : c;
  }, false);
  return loops.map((l, k) => {
    const depth = rings.filter((r, m) => m !== k && inside(l[0].at(0.5), r)).length;
    return { ...edgeLoop(l), ...(depth % 2 ? { hole: true } : {}) };
  });
}

/** A groove's or sweep's triangles in its own frame. */
const meshSketchTriangles = (f: Feature & { kind: "sketch" }) => (isGroove(f) ? grooveTriangles(f) : sweepSketchTriangles(f));

/** Where a sketch's drawing sits in its object's frame: shifted by its offset, then turned onto its plane. */
function sketchPlaneMatrix(p: SketchParams): Matrix4 {
  const m = new Matrix4().makeTranslation(0, 0, p.offset);
  for (const r of PLANE_ROTATIONS[p.plane]) m.premultiply(new Matrix4().makeRotationAxis(new Vector3(...r.axis), (r.degrees * Math.PI) / 180));
  return m;
}

const sweepCache = new Map<string, WorldMesh>();

/**
 * A sweep's triangles in its own frame: each brush stroke a tube as thick as
 * the stroke, centred on the sketch's plane, round (a ball hulled from point
 * to point) or square (a square across the stroke, its corners filled).
 */
function sweepSketchTriangles(f: Feature & { kind: "sketch" }): WorldMesh {
  const key = JSON.stringify(f.params);
  const hit = sweepCache.get(key);
  if (hit) return hit;
  const M = manifoldReady;
  if (!M) throw new Error("The mesh library isn't loaded.");
  const square = f.params.sweepProfile === "square";
  const pieces = [];
  for (const e of f.params.entities) {
    if (e.type !== "stroke" || e.mode !== "add") continue;
    const r = e.width / 2;
    const line = strokeLine(e);
    const path = line.length === 1 ? [line[0], line[0]] : line;
    if (!square) {
      const ball = ([x, y]: [number, number]) => {
        const pts: [number, number, number][] = [];
        for (let k = -5; k <= 5; k++) {
          const a = (k / 5) * (Math.PI / 2);
          pts.push(...ring(x, y, r * Math.cos(a), r * Math.sin(a), 20));
        }
        return pts;
      };
      for (let i = 0; i + 1 < path.length; i++) pieces.push(M.Manifold.hull([...ball(path[i]), ...ball(path[i + 1])]));
      continue;
    }
    // A square across the stroke at a point, facing along direction (dx, dy).
    const across = ([x, y]: [number, number], [dx, dy]: [number, number]) => {
      const len = Math.hypot(dx, dy) || 1;
      const [nx, ny] = [(-dy / len) * r, (dx / len) * r];
      return [-1, 1].flatMap((s) => [-1, 1].map((t) => [x + s * nx, y + s * ny, t * r] as [number, number, number]));
    };
    const dirs = path.slice(1).map((q, i) => [q[0] - path[i][0], q[1] - path[i][1]] as [number, number]);
    for (let i = 0; i + 1 < path.length; i++) {
      pieces.push(M.Manifold.hull([...across(path[i], dirs[i]), ...across(path[i + 1], dirs[i])]));
      // The corner where it turns: the squares of both directions, hulled.
      if (i > 0) pieces.push(M.Manifold.hull([...across(path[i], dirs[i - 1]), ...across(path[i], dirs[i])]));
    }
  }
  if (!pieces.length) throw new Error("A sweep needs a brush stroke to follow: draw one with the Brush tool (B).");
  try {
    const joined = M.Manifold.union(pieces);
    try {
      const w = transformMesh(fromManifold(joined), sketchPlaneMatrix(f.params));
      sweepCache.set(key, w);
      if (sweepCache.size > 64) sweepCache.delete(sweepCache.keys().next().value!);
      return w;
    } finally {
      joined.delete();
    }
  } finally {
    for (const p of pieces) p.delete();
  }
}

const grooveCache = new Map<string, WorldMesh>();

/**
 * A chisel groove's triangles in its own frame (Z into the object, from the
 * sketch's offset just outside the face down to its depth): the tip's
 * cross-section at each point of each stroke, hulled segment by segment and
 * joined. Quick, and exact for flat, V and round tips (a fillet along a
 * wandering stroke takes OpenCascade seconds, if it works at all).
 */
function grooveTriangles(f: Feature & { kind: "sketch" }): WorldMesh {
  const key = JSON.stringify(f.params);
  const hit = grooveCache.get(key);
  if (hit) return hit;
  const M = manifoldReady;
  if (!M) throw new Error("The mesh library isn't loaded.");
  const { offset, depth } = f.params;
  const top = offset;
  const bottom = offset + depth;
  const tip = f.params.groove!.tip;
  const pieces = [];
  for (const e of f.params.entities) {
    if (e.type !== "stroke") continue;
    const half = e.width / 2;
    // The tip's cross-section at a point on the stroke, as points to hull.
    const section = ([x, y]: [number, number]) => {
      const pts = ring(x, y, half, top);
      if (tip === "flat") pts.push(...ring(x, y, half, bottom));
      else if (tip === "v") pts.push([x, y, bottom]);
      else {
        // A ball at the floor (as big as fits), on a ring when the groove is wider than it is deep.
        const ball = Math.min(half, bottom - top);
        const core = half - ball;
        for (let k = 0; k <= 6; k++) {
          const a = (k / 6) * (Math.PI / 2);
          pts.push(...ring(x, y, core + ball * Math.cos(a), bottom - ball + ball * Math.sin(a)));
        }
      }
      return pts;
    };
    const line = strokeLine(e);
    const path = line.length === 1 ? [line[0], line[0]] : line;
    for (let i = 0; i + 1 < path.length; i++) pieces.push(M.Manifold.hull([...section(path[i]), ...section(path[i + 1])]));
  }
  try {
    const joined = M.Manifold.union(pieces);
    try {
      const w = fromManifold(joined);
      grooveCache.set(key, w);
      if (grooveCache.size > 64) grooveCache.delete(grooveCache.keys().next().value!);
      return w;
    } finally {
      joined.delete();
    }
  } finally {
    for (const p of pieces) p.delete();
  }
}

/** A faceted solid with nothing done to it that needs the exact solid (fillets, hollowing, tilt, splits). */
function plainFaceted(f: Feature): boolean {
  // Edge finishes that do nothing yet (no size, or no edges picked: as while picking them) don't count.
  const ops = f.edgeOps.filter((o) => o.size > 0 && !(o.target === "picked" && !o.points.length));
  return f.kind === "imported" && !!f.params.faceted && !ops.length && !f.edgeOps.some((o) => o.afterHoles) && !f.clips?.length && !f.shell && !f.tilt;
}

/** Triangles moved by a matrix (a mirroring one turns them back the right way out). */
function transformMesh(w: WorldMesh, m: Matrix4): WorldMesh {
  const v = new Vector3();
  const vertices = new Float32Array(w.vertices.length);
  for (let i = 0; i < vertices.length; i += 3) vertices.set(v.fromArray(w.vertices, i).applyMatrix4(m).toArray(), i);
  let triangles = w.triangles;
  if (m.determinant() < 0) {
    triangles = w.triangles.slice();
    for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]];
  }
  return { vertices, triangles };
}

function meshBounds(w: WorldMesh): [number[], number[]] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < w.vertices.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], w.vertices[i]);
    hi[i % 3] = Math.max(hi[i % 3], w.vertices[i]);
  }
  return [lo, hi];
}

/** A faceted solid for the view, straight from its triangles: smooth across facets, outlined (and pickable) at corners. */
function facetView(w: WorldMesh): MeshData {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(w.vertices, 3));
  g.setIndex(new BufferAttribute(w.triangles, 1));
  const creased = toCreasedNormals(g, (FACET_ANGLE * Math.PI) / 180);
  const corners = new EdgesGeometry(g, FACET_ANGLE);
  const edges = corners.getAttribute("position").array as Float32Array;
  // Each corner segment is its own pickable edge (a point on it finds the exact solid's edge).
  const groups = new Int32Array((edges.length / 6) * 3);
  for (let i = 0; i < edges.length / 6; i++) groups.set([i * 2, 2, i], i * 3);
  const mesh: MeshData = {
    id: "",
    vertices: creased.getAttribute("position").array as Float32Array,
    normals: creased.getAttribute("normal").array as Float32Array,
    triangles: Uint32Array.from({ length: creased.getAttribute("position").count }, (_, i) => i),
    edges,
    edgeGroups: groups,
  };
  for (const x of [g, creased, corners]) x.dispose();
  return mesh;
}

/**
 * A branch (an object with its solid children joined and its holes cut) as
 * triangles in its own frame, done with mesh booleans. Faceted solids go in
 * as their triangles; anything else is made exactly and then triangulated.
 */
type MeshCutter = { id: string; name: string; mesh: WorldMesh };

function branchTriangles(features: Feature[], f: Feature | null, inherited: MeshCutter[] = []): WorldMesh | null {
  const reaching = (list: MeshCutter[], x: Feature | null) => list.filter((c) => !x?.ignoreHoles?.includes(c.id));
  const cutAll = (w: WorldMesh, list: MeshCutter[], what: Feature | null) => {
    for (const c of list) {
      try {
        w = meshBoolean(w, c.mesh, "cut");
      } catch (err) {
        throw new Error(`the hole ${c.name} couldn't be cut${what ? ` from ${what.name}` : ""}: ${message(err)}`);
      }
    }
    return w;
  };
  const join = (w: WorldMesh | null, placed: WorldMesh) => {
    if (!w) return placed;
    try {
      return meshBoolean(w, placed, "fuse");
    } catch {
      // Not watertight enough to merge: kept as separate, overlapping shells (slicers join them).
      return joinMeshes(w, placed);
    }
  };
  // Fillets on a merged group, or a split group, need the exact result.
  if (f && f.kind === "group" && (isMergedGroup(f) || f.clips?.length)) {
    // A merged group's triangles are kept with its shape (triangulating a big rounded one takes a while).
    let tris: WorldMesh | null;
    if (f.kind === "group") tris = groupTriangles(features, f);
    else {
      const s = branch(features, f);
      tris = s && shapeTriangles(s);
      s?.delete();
    }
    return tris && cutAll(tris, reaching(inherited, f), f);
  }
  if (inherited.length || anyIgnoredHoles(features) || f?.clips?.length) {
    // Some objects ignore some holes: each piece is cut by the holes that reach it (as branchIgnoring does).
    // (And a split object's pieces: what's inside it is cut to its side as it's added, see clipsKid.)
    const kids = childrenOf(features, f?.id ?? null);
    const own: MeshCutter[] = [];
    for (const c of kids.filter((c) => c.mode === "hole")) {
      const k = branchTriangles(features, c);
      if (k) own.push({ id: c.id, name: c.name, mesh: transformMesh(k, localMatrix(c)) });
    }
    const cutters = reaching([...own, ...inherited], f);
    let w: WorldMesh | null = null;
    if (f && !(excludeTextured && isTextured(f) && f.kind !== "group") && f.kind !== "group") {
      const mine = ownTriangles(f);
      if (mine) w = cutAll(mine, cutters, f);
    }
    for (const k of kids.filter((c) => c.mode === "solid")) {
      if (excludeTextured && isTextured(k) && k.kind === "group") continue;
      const toK = reaching(cutters, k);
      const deep = toK.filter((c) => insideIgnores(features, k, c.id));
      const direct = toK.filter((c) => !deep.includes(c));
      const back = localMatrix(k).invert();
      const kk = branchTriangles(features, k, deep.map((c) => ({ ...c, mesh: transformMesh(c.mesh, back) })));
      const placed = kk && cutAll(transformMesh(kk, localMatrix(k)), direct, k);
      const kept = placed && clipsKid(f, k) ? clipMesh(placed, f.clips) : placed;
      if (kept) w = join(w, kept);
    }
    return w;
  }
  let w: WorldMesh | null = null;
  // As in branch(): with textures added as their own meshes, a textured object's own shape is left out.
  if (!f || (excludeTextured && isTextured(f) && f.kind !== "group")) w = null;
  else if (f.kind !== "group") w = ownTriangles(f);
  const kids = childrenOf(features, f?.id ?? null);
  for (const c of kids.filter((c) => c.mode === "solid")) {
    if (excludeTextured && isTextured(c) && c.kind === "group") continue;
    const k = branchTriangles(features, c);
    if (!k) continue;
    const placed = transformMesh(k, localMatrix(c));
    if (!w) w = placed;
    else {
      try {
        w = meshBoolean(w, placed, "fuse");
      } catch {
        // Not watertight enough to merge: kept as separate, overlapping shells (slicers join them).
        w = joinMeshes(w, placed);
      }
    }
  }
  if (!w) return null;
  for (const c of kids.filter((c) => c.mode === "hole")) {
    const k = branchTriangles(features, c);
    if (!k) continue;
    try {
      w = meshBoolean(w, transformMesh(k, localMatrix(c)), "cut");
    } catch (err) {
      throw new Error(`the hole ${c.name} couldn't be cut${f ? ` from ${f.name}` : ""}: ${message(err)}`);
    }
  }
  return w;
}

/** Two sets of triangles as one (no boolean: overlapping shells stay as they are). */
function joinMeshes(a: WorldMesh, b: WorldMesh): WorldMesh {
  const vertices = new Float32Array(a.vertices.length + b.vertices.length);
  vertices.set(a.vertices);
  vertices.set(b.vertices, a.vertices.length);
  const triangles = new Uint32Array(a.triangles.length + b.triangles.length);
  triangles.set(a.triangles);
  const shift = a.vertices.length / 3;
  for (let i = 0; i < b.triangles.length; i++) triangles[a.triangles.length + i] = b.triangles[i] + shift;
  return { vertices, triangles };
}

/** The imported geometry as it came in (cached; callers get a copy, since transforms use up their shape). */
function importedBase(p: ImportedParams): Shape3D {
  let shape = importedCache.get(p.ref);
  if (!shape) {
    const brep = p.brep || brepStore.get(p.ref);
    const mesh = p.mesh ?? meshStore.get(p.ref);
    if (brep) shape = logged("read an imported solid", () => deserializeShape(brep) as Shape3D);
    else if (mesh) shape = logged("make an exact solid from a mesh's triangles", () => solidFromTriangles(decodeFloats(mesh.positions), decodeIndices(mesh.indices), [1, 1, 1], "bodies"));
    else throw new Error("This imported solid has no geometry.");
    importedCache.set(p.ref, shape);
    if (importedCache.size > 64) evictShape(importedCache);
  }
  return shape.clone();
}

const isEven = ([x, y, z]: number[]) => Math.abs(x - y) < 1e-9 && Math.abs(y - z) < 1e-9;

/** Drop a cache's oldest shape and free it (OpenCascade's memory isn't reclaimed otherwise; callers only ever got clones). */
function evictShape(cache: Map<string, Shape3D>) {
  const [key, shape] = cache.entries().next().value!;
  cache.delete(key);
  shape.delete();
}

/** Stretched solids take a while to make, so they're kept too. */
const stretchedCache = new Map<string, Shape3D>();

function importedShape(p: ImportedParams): Shape3D {
  if (!p.scale.every((v) => v > 0)) throw new Error("The sizes need to be above 0.");
  if (p.faceted) {
    // Made from its triangles (scaled, evenly or not), and remembered with them.
    const w = facetTriangles(p);
    let shape: Shape3D;
    if (p.scale.every((v) => v === 1)) shape = importedBase(p);
    else {
      const key = `${p.ref}|${p.scale.join(",")}`;
      let made = stretchedCache.get(key);
      if (!made) {
        made = solidFromTriangles(w.vertices, w.triangles, [1, 1, 1], "bodies");
        stretchedCache.set(key, made);
        if (stretchedCache.size > 16) evictShape(stretchedCache);
      }
      shape = made.clone();
    }
    knownTriangles.set(shape, w);
    return shape;
  }
  if (isEven(p.scale)) return p.scale[0] === 1 ? importedBase(p) : importedBase(p).scale(p.scale[0], [0, 0, 0]);
  const key = `${p.ref}|${p.scale.join(",")}`;
  let shape = stretchedCache.get(key);
  if (!shape) {
    shape = stretchSolid(importedBase(p), p.scale as [number, number, number]);
    stretchedCache.set(key, shape);
    if (stretchedCache.size > 16) evictShape(stretchedCache);
  }
  return shape.clone();
}

/**
 * An exact solid stretched differently along X, Y and Z. OpenCascade here can
 * only scale evenly, so it's rebuilt from a fine triangulation: flat faces stay
 * flat (triangles on one plane are merged back into one face), curves become
 * small facets.
 */
function stretchSolid(shape: Shape3D, scale: [number, number, number]): Shape3D {
  const [lo, hi] = shape.boundingBox.bounds;
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const m = shape.mesh({ tolerance: Math.max(0.005, diag * 2e-4), angularTolerance: 0.1 });
  shape.delete();
  return solidFromTriangles(m.vertices, m.triangles, scale, "voids");
}

/**
 * A solid from triangles (scaled along each axis): OpenCascade reads them as an
 * STL, sews their corners into closed shells and merges each flat area back
 * into one face. `separate`: each closed shell is its own solid (a mesh file
 * with several bodies), and a mesh with gaps is refused; otherwise the shells
 * are one solid's outside and voids.
 */
function solidFromTriangles(vertices: ArrayLike<number>, triangles: ArrayLike<number>, [sx, sy, sz]: number[], mode: "voids" | "bodies" | "checked"): Shape3D {
  const separate = mode !== "voids";
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], vertices[i] * [sx, sy, sz][i % 3]);
    hi[i % 3] = Math.max(hi[i % 3], vertices[i] * [sx, sy, sz][i % 3]);
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const sewTolerance = Math.max(1e-5, diag * 1e-6);
  // OpenCascade can't make a face from a triangle with no area (mesh booleans leave a few):
  // leave out any thinner than the sewing tolerance, which closes the hairline gaps they leave.
  const keep: number[] = [];
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let t = 0; t < triangles.length; t += 3) {
    a.fromArray(vertices, triangles[t] * 3).multiply(new Vector3(sx, sy, sz));
    b.fromArray(vertices, triangles[t + 1] * 3).multiply(new Vector3(sx, sy, sz));
    c.fromArray(vertices, triangles[t + 2] * 3).multiply(new Vector3(sx, sy, sz));
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    const twiceArea = b.clone().sub(a).cross(c.clone().sub(a)).length();
    if (longest > 0 && twiceArea / longest > sewTolerance / 2) keep.push(t);
  }
  const n = keep.length;
  const stl = new DataView(new ArrayBuffer(84 + n * 50));
  // OpenCascade takes a file whose first bytes are all plain text for a text STL: mark it binary.
  stl.setUint8(0, 0xff);
  stl.setUint32(80, n, true);
  keep.forEach((t0, t) => {
    for (let k = 0; k < 3; k++) {
      const v = triangles[t0 + k] * 3;
      const at = 84 + t * 50 + 12 + k * 12;
      stl.setFloat32(at, vertices[v] * sx, true);
      stl.setFloat32(at + 4, vertices[v + 1] * sy, true);
      stl.setFloat32(at + 8, vertices[v + 2] * sz, true);
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const file = `/mesh-${Date.now()}-${Math.random().toString(36).slice(2)}.stl`;
  oc.FS.writeFile(file, new Uint8Array(stl.buffer));
  const reader = new oc.StlAPI_Reader();
  const shell = new oc.TopoDS_Shell();
  const temps: { delete(): void }[] = [];
  try {
    if (!reader.Read(shell, file)) throw new Error("OpenCascade couldn't read the triangles.");
    // The reader gives loose triangles: sew them into closed shells, merge each flat area back into one face.
    const sew = new oc.BRepBuilderAPI_Sewing(sewTolerance, true, true, true, false);
    sew.Add(shell);
    const progress = new oc.Message_ProgressRange();
    sew.Perform(progress);
    temps.push(sew, progress);
    if (mode === "checked" && sew.NbFreeEdges() > 0) throw new Error("the mesh has gaps (it isn't closed), so it can't be a solid.");
    const sewed = sew.SewedShape();
    const unify = new oc.ShapeUpgrade_UnifySameDomain(sewed, true, true, false);
    unify.Build();
    const unified = unify.Shape();
    const shells = new oc.TopExp_Explorer(unified, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    temps.push(sewed, unify, unified, shells);
    if (!separate) {
      const make = new oc.BRepBuilderAPI_MakeSolid();
      temps.push(make);
      for (; shells.More(); shells.Next()) make.Add(oc.TopoDS.Shell(shells.Current()));
      return cast(make.Solid()) as Shape3D;
    }
    const solids: Shape3D[] = [];
    for (; shells.More(); shells.Next()) {
      const make = new oc.BRepBuilderAPI_MakeSolid();
      make.Add(oc.TopoDS.Shell(shells.Current()));
      const solid = make.Solid();
      make.delete();
      // Triangles facing inwards would make a solid of everything but the shape: turn it the right way out.
      oc.BRepLib.OrientClosedSolid(solid);
      solids.push(cast(solid) as Shape3D);
    }
    if (!solids.length) throw new Error("the mesh has no closed shape in it.");
    const shape = (solids.length === 1 ? solids[0] : makeCompound(solids)) as Shape3D;
    if (mode === "checked" && !isValidShape(shape)) throw new Error("the mesh crosses through itself, so it can't be a solid.");
    return shape;
  } finally {
    for (const o of temps) o.delete();
    oc.FS.unlink(file);
    reader.delete();
    shell.delete();
  }
}

/** An imported solid whose curves are small flat facets: made from a mesh, or stretched unevenly. */
function isFaceted(f: Feature): boolean {
  return f.kind === "imported" && (!!f.params.faceted || !isEven(f.params.scale));
}

/**
 * A faceted solid's mesh, shaded smooth across the seams between facets and
 * outlined only at real corners (and only those edges can be picked).
 */
function softenFacets(m: MeshData): MeshData {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(m.vertices, 3));
  g.setIndex(new BufferAttribute(m.triangles, 1));
  const creased = toCreasedNormals(g, (FACET_ANGLE * Math.PI) / 180);
  const corners = new EdgesGeometry(g, FACET_ANGLE);
  const key = (a: ArrayLike<number>, i: number) => `${Math.round(a[i] * 1e3)},${Math.round(a[i + 1] * 1e3)},${Math.round(a[i + 2] * 1e3)}`;
  const segment = (a: ArrayLike<number>, i: number) => [key(a, i), key(a, i + 3)].sort().join("|");
  const cp = corners.getAttribute("position").array;
  const sharp = new Set<string>();
  for (let i = 0; i < cp.length; i += 6) sharp.add(segment(cp, i));
  // Keep the exact shape's edges whose every piece lies along a corner.
  const edges: number[] = [];
  const groups: number[] = [];
  for (let gi = 0; gi < m.edgeGroups.length; gi += 3) {
    const [start, count, edgeId] = [m.edgeGroups[gi], m.edgeGroups[gi + 1], m.edgeGroups[gi + 2]];
    let keep = true;
    for (let v = start; v < start + count && keep; v += 2) keep = sharp.has(segment(m.edges, v * 3));
    if (!keep) continue;
    groups.push(edges.length / 3, count, edgeId);
    for (let k = start * 3; k < (start + count) * 3; k++) edges.push(m.edges[k]);
  }
  const out: MeshData = {
    id: m.id,
    vertices: creased.getAttribute("position").array as Float32Array,
    normals: creased.getAttribute("normal").array as Float32Array,
    triangles: Uint32Array.from({ length: creased.getAttribute("position").count }, (_, i) => i),
    edges: new Float32Array(edges),
    edgeGroups: new Int32Array(groups),
  };
  for (const x of [g, creased, corners]) x.dispose();
  return out;
}

/** Stretched with nothing else done to it: shown as its exact shape's mesh, stretched (smooth, with its real edges). */
function plainStretch(f: Feature): f is Extract<Feature, { kind: "imported" }> {
  return f.kind === "imported" && !f.params.faceted && !isEven(f.params.scale) && !f.edgeOps.length && !f.clips?.length && !f.shell && !clearanceOf(f);
}

function stretchMesh(m: MeshData, [sx, sy, sz]: number[]): MeshData {
  const s = [sx, sy, sz];
  const vertices = m.vertices.map((v, i) => v * s[i % 3]);
  const edges = m.edges.map((v, i) => v * s[i % 3]);
  // Normals stretch the other way (inverse transpose), then back to unit length.
  const normals = m.normals.map((v, i) => v / s[i % 3]);
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l;
    normals[i + 1] /= l;
    normals[i + 2] /= l;
  }
  return { ...m, vertices, normals, edges };
}

/**
 * A closed mesh as solids, one per separate body, each with its own origin at
 * the middle of its base. Checked with Manifold (quick); the exact solid is
 * only made from the triangles later, if it's needed. Throws if the mesh has gaps.
 */
function meshSolids(file: ImportSource, M: ManifoldLib): ImportedSolid[] {
  const whole = toManifold(M, { vertices: file.vertices!, triangles: file.triangles! }, `${file.name}: the mesh has gaps (it isn't closed), so it can't be a solid.`);
  const bodies = whole.decompose();
  const out: ImportedSolid[] = [];
  bodies.forEach((body, i) => {
    const w = fromManifold(body);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < w.vertices.length; k++) {
      lo[k % 3] = Math.min(lo[k % 3], w.vertices[k]);
      hi[k % 3] = Math.max(hi[k % 3], w.vertices[k]);
    }
    const anchor: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]];
    for (let k = 0; k < w.vertices.length; k++) w.vertices[k] -= anchor[k % 3];
    out.push({
      kind: "solid",
      name: bodies.length > 1 ? `${file.name} ${i + 1}` : file.name,
      color: file.color,
      brep: "",
      size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
      anchor,
      faceted: true,
      mesh: w,
    });
  });
  for (const b of [whole, ...bodies]) b.delete();
  return out;
}

/**
 * Read STEP and BREP files and split them into their solids, each moved so its
 * own origin is the middle of its base (`anchor` says where that was). Faces
 * that aren't part of any solid come back as a mesh.
 */
async function importSolids(files: ImportSource[]): Promise<ImportedSolid[]> {
  const out: ImportedSolid[] = [];
  for (const file of files) {
    let shape: Shape3D;
    try {
      if (file.format === "mesh") {
        out.push(...meshSolids(file, await manifold()));
        continue;
      }
      shape = (file.format === "step" ? await importSTEP(new Blob([file.data!])) : deserializeShape(typeof file.data === "string" ? file.data : new TextDecoder().decode(file.data))) as Shape3D;
    } catch (err) {
      if (file.format === "mesh") throw new Error(`${file.name}: ${message(err)}`);
      throw new Error(`${file.name}: ${file.format === "step" ? "this isn't a STEP file OpenCascade can read" : "this isn't a BREP shape OpenCascade can read"} (${message(err)}).`);
    }
    // FreeCAD objects inside a Part container are placed by it (nearest container first).
    for (const pl of file.placements ?? []) {
      if (pl.angle) shape = shape.rotate(pl.angle, [0, 0, 0], pl.axis);
      shape = shape.translate(...pl.position);
    }
    const solids = shape.solids as unknown as Shape3D[];
    solids.forEach((solid, i) => {
      const { bounds } = solid.boundingBox;
      const [lo, hi] = bounds;
      const anchor: [number, number, number] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]];
      const local = solid.translate(-anchor[0], -anchor[1], -anchor[2]);
      out.push({
        kind: "solid",
        name: solids.length > 1 ? `${file.name} ${i + 1}` : file.name,
        color: file.color,
        brep: local.serialize(),
        size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
        anchor,
      });
    });
    if (!solids.length && shape.faces.length) {
      // Surfaces only (no closed solid): keep how it looks.
      const m = shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
      out.push({ kind: "mesh", name: file.name, color: file.color, vertices: new Float32Array(m.vertices), triangles: new Uint32Array(m.triangles) });
    }
  }
  return out;
}

function place(f: Feature, shape: Shape3D): Shape3D {
  const placed = placeShape(f, shape);
  const w = knownTriangles.get(shape);
  if (w) knownTriangles.set(placed, transformMesh(w, localMatrix(f)));
  return placed;
}

function placeShape(f: Feature, shape: Shape3D): Shape3D {
  // A mirrored object flips across its own YZ plane first (see Feature.mirrored).
  if (f.mirrored) shape = shape.mirror("YZ", [0, 0, 0]);
  const r = f.rotation;
  if (r.x) shape = shape.rotate(r.x, [0, 0, 0], [1, 0, 0]);
  if (r.y) shape = shape.rotate(r.y, [0, 0, 0], [0, 1, 0]);
  if (r.z) shape = shape.rotate(r.z, [0, 0, 0], [0, 0, 1]);
  shape = shape.translate(f.position.x, f.position.y, f.position.z);
  // Then the joint's motion: turned about its axis, or slid along it.
  const j = f.joint;
  if (j && j.value) {
    const { x, y, z } = j.axis;
    if (j.type === "hinge") shape = shape.rotate(j.value, [j.origin.x, j.origin.y, j.origin.z], [x, y, z]);
    else if (j.type === "orbit") {
      // Its origin goes round the circle; it keeps facing the same way.
      const m = jointMatrix(j, j.value, f.position).elements;
      shape = shape.translate(m[12], m[13], m[14]);
    } else {
      const len = Math.hypot(x, y, z) || 1;
      shape = shape.translate((x / len) * j.value, (y / len) * j.value, (z / len) * j.value);
    }
  }
  return shape;
}

/** Debug info: each step of the current build (null when it's off). */
let buildLog: BuildStep[] | null = null;

/** Run one step, timed and noted in the build log when Debug info is on. */
let logDepth = 0;

function logged<T>(step: string, fn: () => T): T {
  if (!buildLog) return fn();
  // Noted before it runs, so steps inside it come after it in the log.
  const entry: BuildStep = { step, ms: 0, depth: logDepth };
  buildLog.push(entry);
  const t = performance.now();
  logDepth++;
  try {
    return fn();
  } catch (err) {
    entry.error = message(err);
    throw err;
  } finally {
    logDepth--;
    entry.ms = Math.round(performance.now() - t);
  }
}

/** Features whose own geometry failed in the current build, with the reason. */
let failures: Record<string, string> = {};

function buildOwnSafe(f: Feature): Shape3D | null {
  try {
    return logged(`${f.name}: its shape`, () => buildOwn(f));
  } catch (err) {
    failures[f.id] = message(err);
    return null;
  }
}

/**
 * A branch's result in its own frame: the feature's own shape, fused with its
 * solid children, minus its hole children. `parentId` null means the whole model.
 */
/** A hole on its way down to the objects it cuts (in the frame of the branch it's passed into). */
type Cutter = { id: string; shape: Shape3D };

/** A copy of a shape (transforms use theirs up), keeping its triangles if it has them. */
function copyShape(s: Shape3D): Shape3D {
  const copy = s.clone();
  const w = knownTriangles.get(s);
  if (w) knownTriangles.set(copy, w);
  return copy;
}

/** A shape in the parent's frame brought into `f`'s own frame: place() undone. */
function unplace(f: Feature, shape: Shape3D): Shape3D {
  const w = knownTriangles.get(shape);
  const j = f.joint;
  if (j && j.value) {
    const { x, y, z } = j.axis;
    if (j.type === "hinge") shape = shape.rotate(-j.value, [j.origin.x, j.origin.y, j.origin.z], [x, y, z]);
    else if (j.type === "orbit") {
      const m = jointMatrix(j, j.value, f.position).elements;
      shape = shape.translate(-m[12], -m[13], -m[14]);
    } else {
      const len = Math.hypot(x, y, z) || 1;
      shape = shape.translate((-x / len) * j.value, (-y / len) * j.value, (-z / len) * j.value);
    }
  }
  shape = shape.translate(-f.position.x, -f.position.y, -f.position.z);
  const r = f.rotation;
  if (r.z) shape = shape.rotate(-r.z, [0, 0, 0], [0, 0, 1]);
  if (r.y) shape = shape.rotate(-r.y, [0, 0, 0], [0, 1, 0]);
  if (r.x) shape = shape.rotate(-r.x, [0, 0, 0], [1, 0, 0]);
  if (f.mirrored) shape = shape.mirror("YZ", [0, 0, 0]);
  if (w) knownTriangles.set(shape, transformMesh(w, localMatrix(f).invert()));
  return shape;
}

/** Whether something inside `f` (not `f` itself) ignores this hole. */
const insideIgnores = (features: Feature[], f: Feature, holeId: string) => someInside(features, f, (x) => x.id !== f.id && !!x.ignoreHoles?.includes(holeId));

/** Whether anything in `f`'s subtree (itself included) passes the test; the subtree is only worked out if something does. */
function someInside(features: Feature[], f: Feature, test: (x: Feature) => boolean): boolean {
  const hits = features.filter(test);
  if (!hits.length) return false;
  const sub = subtreeIds(features, f.id);
  return hits.some((x) => sub.has(x.id));
}

/**
 * branch() when some objects ignore some holes: instead of joining
 * everything and then cutting the holes, each piece is cut by the holes that
 * don't ignore it, and holes are passed down into the parts where something
 * inside ignores them. `inherited` are holes from outside, in this frame.
 */
function branchIgnoring(features: Feature[], self: Feature | null, inherited: Cutter[]): Shape3D | null {
  const kids = childrenOf(features, self?.id ?? null);
  const own: Cutter[] = [];
  for (const c of kids.filter((c) => c.mode === "hole")) {
    const s = branch(features, c);
    if (s) own.push({ id: c.id, shape: place(c, s) });
  }
  const cutters = [...own, ...inherited].filter((c) => !self?.ignoreHoles?.includes(c.id));
  const cutBy = (shape: Shape3D, list: Cutter[]) => list.reduce((s, c) => booleanSafe(s, c.shape, "cut"), shape);
  let result: Shape3D | null = null;
  const mine = self && !(excludeTextured && isTextured(self) && self.kind !== "group") ? buildOwnSafe(self) : null;
  if (mine) result = cutBy(mine, cutters);
  for (const k of kids.filter((c) => c.mode === "solid")) {
    if (excludeTextured && isTextured(k) && k.kind === "group") continue;
    const reaching = cutters.filter((c) => !k.ignoreHoles?.includes(c.id));
    // Holes something inside ignores go down into it; the rest cut its finished shape.
    const deep = reaching.filter((c) => insideIgnores(features, k, c.id));
    const direct = reaching.filter((c) => !deep.includes(c));
    const s = branch(features, k, deep.map((c) => ({ id: c.id, shape: unplace(k, copyShape(c.shape)) })));
    if (!s) continue;
    const placed = cutBy(clipsKid(self, k) ? applyClips(place(k, s), self.clips) : place(k, s), direct);
    result = result ? booleanSafe(result, placed, self?.overlap ? "intersect" : "fuse") : placed;
  }
  return result;
}

/**
 * Merged groups' finished shapes (joining and rounding them can take many
 * seconds), by what's in them, with the failures and size adjustments made on
 * the way. Callers get copies: placing a shape uses it up.
 */
const branchCache = new Map<string, { shape: Shape3D | null; failures: Record<string, string>; adjusted: Record<string, number>; tris?: WorldMesh | null }>();
const branchKey = (features: Feature[], self: Feature) => JSON.stringify([geometryKey(features, self.id), excludeTextured, unswept, afterHolesKey(self)]);

/** While set, hole groups are built without their sweep (it's then done on their triangles: see groupTriangles). */
let unswept = false;

/**
 * A hole group's shape as triangles in its own frame. A swept one is swept as
 * triangles and left that way: making its exact solid takes a minute or more,
 * and only a STEP export needs it.
 */
function groupTriangles(features: Feature[], f: Feature): WorldMesh | null {
  const s = unswept ? null : sweepOf(f);
  if (!s) {
    const shape = branch(features, f);
    const entry = branchCache.get(branchKey(features, f));
    const tris = entry && entry.shape ? (entry.tris ??= shape && shapeTriangles(shape)) : shape && shapeTriangles(shape);
    shape?.delete();
    return tris;
  }
  const was = unswept;
  unswept = true;
  try {
    const key = `group|${branchKey(features, f)}`;
    let w = sweptCache.get(key) ?? keptResult<WorldMesh>("sweeps", key);
    if (!w) {
      const base = groupTriangles(features, f);
      if (!base) return null;
      w = logged(`${f.name}: sweep the hole through ${fmtRange(s)}`, () => sweepMesh(base, s, clearanceOf(f)));
      keepResult("sweeps", key, w);
    }
    if (!sweptCache.has(key)) {
      sweptCache.set(key, w);
      if (sweptCache.size > 16) sweptCache.delete(sweptCache.keys().next().value!);
    }
    return w;
  } finally {
    unswept = was;
  }
}

function branch(features: Feature[], self: Feature | null, inherited: Cutter[] = []): Shape3D | null {
  // A merged group's shape depends only on what's inside it (unless something in it waits for outside holes).
  if (self && isMergedGroup(self) && !inherited.length && !someInside(features, self, (x) => x !== self && hasAfterHoles(x))) {
    const key = branchKey(features, self);
    let hit = branchCache.get(key);
    if (!hit) {
      const [outerFailures, outerAdjusted] = [failures, adjusted];
      [failures, adjusted] = [{}, {}];
      try {
        hit = { shape: branchNow(features, self, []), failures, adjusted };
      } finally {
        [failures, adjusted] = [Object.assign(outerFailures, failures), Object.assign(outerAdjusted, adjusted)];
      }
      branchCache.set(key, hit);
      if (branchCache.size > 12) {
        const [oldKey, old] = branchCache.entries().next().value!;
        branchCache.delete(oldKey);
        old.shape?.delete();
      }
      return hit.shape && copyShape(hit.shape);
    }
    Object.assign(failures, hit.failures);
    Object.assign(adjusted, hit.adjusted);
    return hit.shape && copyShape(hit.shape);
  }
  return branchNow(features, self, inherited);
}

function branchNow(features: Feature[], self: Feature | null, inherited: Cutter[] = []): Shape3D | null {
  if (inherited.length || anyIgnoredHoles(features)) {
    let result = branchIgnoring(features, self, inherited);
    if (result && self) result = finishBranch(self, result, childrenOf(features, self.id).length > 0);
    return result;
  }
  // With textures added as their own meshes, a textured object's own shape is left out here (its children stay).
  let result = self && !(excludeTextured && isTextured(self) && self.kind !== "group") ? buildOwnSafe(self) : null;
  const kids = childrenOf(features, self?.id ?? null);
  for (const c of kids.filter((c) => c.mode === "solid")) {
    if (excludeTextured && isTextured(c) && c.kind === "group") continue;
    const s = branch(features, c);
    if (s) {
      const placed = clipsKid(self, c) ? applyClips(place(c, s), self.clips) : place(c, s);
      result = result ? booleanSafe(result, placed, self?.overlap ? "intersect" : "fuse") : placed;
    }
  }
  if (!result) return null;
  for (const c of kids.filter((c) => c.mode === "hole")) {
    const s = branch(features, c);
    if (s) result = booleanSafe(result, place(c, s), "cut");
  }
  return self ? finishBranch(self, result, kids.length > 0) : result;
}

/** A merged group's fillets and hollowing (and a hole group's clearance and sweep), and a split's side, on a branch's result. */
function finishBranch(self: Feature, result: Shape3D, hasKids: boolean): Shape3D {
  if (isMergedGroup(self)) {
    try {
      result = applyEdgeOps(result, self.edgeOps, (o) => !o.afterHoles);
      if (self.shell) result = applyShell(result, self.shell);
      // Its own holes are already cut; the ones from outside it that reach it go first, so their edges can be rounded too.
      if (hasAfterHoles(self)) result = applyEdgeOps(cutByReachingHoles(self, result), self.edgeOps, (o) => !!o.afterHoles);
    } catch (err) {
      failures[self.id] = message(err); // Keep the unfinished shape so the rest still builds.
    }
    const by = clearanceOf(self);
    const s = sweepOf(self);
    try {
      if (by) result = logged(`${self.name}: grow the hole by ${by} mm (clearance)`, () => growSolid(result, by));
      if (s && !unswept) {
        const w = logged(`${self.name}: sweep the hole through ${fmtRange(s)}`, () => sweepMesh(shapeTriangles(result), s, by));
        result = logged("make the swept hole a solid", () => solidFromTriangles(w.vertices, w.triangles, [1, 1, 1], "bodies"));
        knownTriangles.set(result, w);
      }
    } catch (err) {
      failures[self.id] = message(err);
    }
  }
  // A split group keeps only its side, everything in it included (a split object's own shape is already
  // cut to its side, and what's inside it is as it's added: see clipsKid).
  if (self.kind === "group" && self.clips?.length && hasKids) {
    try {
      result = applyClips(result, self.clips);
    } catch (err) {
      failures[self.id] = message(err);
    }
  }
  return result;
}

const MESH_OPTS = { tolerance: 0.05, angularTolerance: 0.2 };

/** Helical shapes (threads, springs) have huge curved faces; a slightly coarser mesh draws ~3× faster. */
const HELIX_MESH_OPTS = { tolerance: 0.1, angularTolerance: 0.3 };

function toMesh(id: string, shape: Shape3D, kind?: Feature["kind"]): MeshData {
  const opts = kind === "thread" || kind === "spring" ? HELIX_MESH_OPTS : MESH_OPTS;
  const m = shape.mesh(opts);
  const e = shape.meshEdges(opts);
  return {
    id,
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    edges: new Float32Array(e.lines),
    edgeGroups: new Int32Array(e.edgeGroups.flatMap((g) => [g.start, g.count, g.edgeId])),
  };
}

// Local geometry doesn't depend on placement, so moving things never re-meshes.
const meshCache = new Map<string, { mesh: MeshData | null; adjusted: Record<string, number>; failures?: Record<string, string> }>();

function ownMesh(f: Feature): MeshData | null {
  // An imported solid's geometry is named by its ref (its BREP text can be megabytes).
  const key = JSON.stringify([f.kind, keyParams(f), f.edgeOps, f.clips ?? [], f.shell ?? null, f.tilt ?? null, isTextured(f) ? f.texture : null, afterHolesKey(f)]);
  if (!meshCache.has(key)) {
    const outer = adjusted;
    adjusted = {};
    try {
      if (sweepOf(f)) meshCache.set(key, { mesh: meshForView("", sweptTriangles(f), null), adjusted });
      else if (plainGroove(f)) meshCache.set(key, { mesh: meshForView("", meshSketchTriangles(f), null), adjusted });
      else if (f.kind === "imported" && plainFaceted(f)) meshCache.set(key, { mesh: textured(f, facetView(facetOwn(f))), adjusted });
      else if (plainStretch(f)) meshCache.set(key, { mesh: textured(f, stretchMesh(toMesh("", importedBase(f.params)), f.params.scale)), adjusted });
      else {
        const shape = buildOwn(f);
        const mesh = shape && toMesh("", shape, f.kind);
        meshCache.set(key, { mesh: mesh && textured(f, isFaceted(f) ? softenFacets(mesh) : mesh), adjusted });
      }
    } finally {
      adjusted = Object.assign(outer, adjusted);
    }
    if (meshCache.size > 500) meshCache.delete(meshCache.keys().next().value!);
  } else {
    Object.assign(adjusted, meshCache.get(key)!.adjusted);
  }
  const m = meshCache.get(key)!.mesh;
  if (!m) return null;
  // Copies, because the originals stay in the cache and buffers are transferred.
  return {
    id: f.id,
    vertices: m.vertices.slice(),
    normals: m.normals.slice(),
    triangles: m.triangles.slice(),
    edges: m.edges.slice(),
    edgeGroups: m.edgeGroups.slice(),
  };
}

// ---- Holes shown cut ------------------------------------------------------------------

/**
 * The holes that cut this object in the finished model: its own hole children,
 * and those of each ancestor it's joined to as a solid (top-level holes cut every
 * top-level solid). None for a hole, or for something that's part of a hole.
 */
function cuttingHoles(features: Feature[], f: Feature): Feature[] {
  if (f.mode === "hole") return [];
  // A merged group's own holes are already in its shape.
  const holes: Feature[] = isMergedGroup(f) ? [] : childrenOf(features, f.id).filter((c) => c.mode === "hole");
  let node = f;
  while (node.parentId) {
    const parent = features.find((x) => x.id === node.parentId);
    if (!parent) break;
    if (parent.mode === "hole") return [];
    holes.push(...childrenOf(features, parent.id).filter((c) => c.mode === "hole"));
    node = parent;
  }
  holes.push(...childrenOf(features, null).filter((c) => c.mode === "hole" && c.id !== node.id));
  return holes.filter((h) => !ignoresHole(features, f, h.id));
}

/** A shape in its object's frame, moved to where it is in the world (through its parents). */
function placeInWorld(features: Feature[], f: Feature, shape: Shape3D): Shape3D {
  let s = place(f, shape);
  for (let p = features.find((x) => x.id === f.parentId); p; p = features.find((x) => x.id === p!.parentId)) s = place(p, s);
  return s;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
/** What a feature's subtree looks like to the kernel (names, colours and visibility don't change geometry). */
const geometryKey = (features: Feature[], id: string) => {
  const sub = subtreeIds(features, id);
  return features
    .filter((x) => sub.has(x.id))
    .map((x) => [x.id, x.parentId, x.kind, x.mode, keyParams(x), x.position, x.rotation, x.edgeOps, x.clips, x.shell, x.tilt, x.mirrored, x.joint, x.ignoreHoles, x.combined, x.overlap]);
};

const cutCache = new Map<string, { mesh: MeshData | null; error?: string }>();
/** Objects' own triangles and edge lines (in their own frame) for cutting their holes, by their own geometry. */
const ownCutCache = new Map<string, { tris: WorldMesh; edges?: Float32Array }>();

/** Objects whose holes couldn't be cut in the last build, with why (shown as their build error). */
let cutFailures: Record<string, string> = {};

/**
 * The object as it ends up with the holes that reach it cut away, in its own
 * frame (so it shows where its own mesh would). Null when no hole touches it,
 * or the cut fails (it's then shown whole; Show result reports why).
 */
function cutMesh(features: Feature[], f: Feature): MeshData | null {
  if (f.kind === "plane" || f.kind === "sculpt" || (f.kind === "group" && !isMergedGroup(f))) return null;
  // Its own shape already has the holes its after-holes finishes needed cut into it: the rest are cut here.
  const first = hasAfterHoles(f) ? new Set(holesCutFirst(features, f).map((h) => h.id)) : null;
  const holes = cuttingHoles(features, f).filter((h) => !first?.has(h.id));
  if (!holes.length) return null;
  const world = worldMatrix(features, f.id);
  const before = afterHolesKey(f);
  const key = JSON.stringify([
    f.kind === "group" ? geometryKey(features, f.id) : [f.kind, keyParams(f), f.edgeOps, f.clips ?? [], f.shell ?? null, f.tilt ?? null, f.mirrored ?? false],
    before,
    world.elements.map(r6),
    holes.map((h) => [geometryKey(features, h.id), worldMatrix(features, h.id).elements.map(r6)]),
    isTextured(f) ? f.texture : null,
  ]);
  const keptCut = cutCache.has(key) ? undefined : keptResult<MeshData>("cuts", key);
  if (keptCut) cutCache.set(key, { mesh: keptCut });
  if (!cutCache.has(key)) {
    const outerFailures = failures;
    failures = {};
    let mesh: MeshData | null = null;
    let error: string | undefined;
    try {
      // Cut as triangles (Manifold): far quicker than OpenCascade's exact cut, and it's only for the view.
      // A textured object needs its exact shape for the pattern; if the triangles won't cut, the exact way still can.
      const quickCut = () => {
        // An exact shape's own edges (where its faces meet, rounded ones too) are kept where they're still on it.
        let ownEdges: Float32Array | undefined;
        let own: WorldMesh | null;
        if (f.kind === "group") own = branchTriangles(features, f);
        else if (f.kind === "imported" && plainFaceted(f)) own = facetOwn(f);
        else {
          // Its own triangles and edges don't change as holes come and go: kept (reading and meshing a big part takes a while).
          const ownKey = JSON.stringify([f.kind, keyParams(f), f.edgeOps, f.clips ?? [], f.shell ?? null, f.tilt ?? null, before]);
          let mine = ownCutCache.get(ownKey);
          if (!mine) {
            const shape = buildOwn(f)!;
            mine = { tris: shapeTriangles(shape), edges: knownTriangles.has(shape) ? undefined : new Float32Array(shape.meshEdges(MESH_OPTS).lines) };
            ownCutCache.set(ownKey, mine);
            if (ownCutCache.size > 32) ownCutCache.delete(ownCutCache.keys().next().value!);
          }
          own = mine.tris;
          ownEdges = mine.edges;
        }
        let w = own ? transformMesh(own, world) : null;
        const [lo, hi] = w ? meshBounds(w) : [[0, 0, 0], [-1, -1, -1]];
        let cut = false;
        for (const h of w ? holes : []) {
          const ht = branchTriangles(features, h);
          if (!ht) continue;
          const placed = transformMesh(ht, worldMatrix(features, h.id));
          const [a, b] = meshBounds(placed);
          if ([0, 1, 2].some((k) => a[k] > hi[k] || b[k] < lo[k])) continue;
          w = meshBoolean(w!, placed, "cut");
          cut = true;
        }
        if (cut && w) mesh = f.kind === "imported" && plainFaceted(f) ? facetView(transformMesh(w, world.clone().invert())) : meshForView(f.id, w, world, ownEdges);
      };
      const exactCut = () => {
        const own = f.kind === "group" ? branch(features, f) : buildOwn(f);
        if (own) {
          let shape = placeInWorld(features, f, own);
          const [lo, hi] = shape.boundingBox.bounds;
          let cut = false;
          for (const h of holes) {
            const hs = branch(features, h);
            if (!hs) continue;
            const placed = placeInWorld(features, h, hs);
            const [a, b] = placed.boundingBox.bounds;
            // Only holes that reach it.
            if ([0, 1, 2].some((k) => a[k] > hi[k] || b[k] < lo[k])) continue;
            shape = booleanSafe(shape, placed, "cut");
            cut = true;
          }
          if (cut) mesh = textured(f, toLocal(toMesh(f.id, shape, f.kind), world));
        }
      };
      if (isTextured(f)) exactCut();
      else if (isFaceted(f)) quickCut();
      else {
        try {
          logged("cut as triangles", quickCut);
        } catch {
          logged("cut exactly (the triangles wouldn't cut)", exactCut);
        }
      }
    } catch (err) {
      mesh = null;
      error = `its holes couldn't be cut: ${message(err)}`;
    } finally {
      failures = outerFailures;
    }
    cutCache.set(key, { mesh, error });
    if (mesh && !error) keepResult("cuts", key, mesh);
    // Moving a cut object makes a new entry each time, and a big part's mesh is megabytes: keep the recent few.
    if (cutCache.size > 40) cutCache.delete(cutCache.keys().next().value!);
  }
  const { mesh: m, error: cutError } = cutCache.get(key)!;
  if (cutError) cutFailures[f.id] = cutError;
  return m && { id: f.id, vertices: m.vertices.slice(), normals: m.normals.slice(), triangles: m.triangles.slice(), edges: m.edges.slice(), edgeGroups: m.edgeGroups.slice() };
}

/** A mesh made in world coordinates, moved into the frame `world` places things from. */
function toLocal(m: MeshData, world: import("three").Matrix4): MeshData {
  const inv = world.clone().invert();
  const nm = new Matrix3().getNormalMatrix(inv);
  const v = new Vector3();
  const points = (arr: Float32Array) => {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i += 3) out.set(v.fromArray(arr, i).applyMatrix4(inv).toArray(), i);
    return out;
  };
  const normals = new Float32Array(m.normals.length);
  for (let i = 0; i < normals.length; i += 3) normals.set(v.fromArray(m.normals, i).applyMatrix3(nm).normalize().toArray(), i);
  const triangles = m.triangles.slice();
  // Mirrored: the view flips it back, so its triangles must face the other way here.
  if (world.determinant() < 0) for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]];
  return { ...m, vertices: points(m.vertices), normals, triangles, edges: points(m.edges) };
}

// ---- Textures ---------------------------------------------------------------------------

/** Set while building results that add textured objects as their own meshes (see branch). */
let excludeTextured = false;

/** Has a printable texture (holes, planes and meshes don't take one). */
function isTextured(f: Feature): f is Feature & { texture: NonNullable<Feature["texture"]> } {
  return !!f.texture && f.mode === "solid" && f.kind !== "plane" && f.kind !== "sculpt";
}

/** A display mesh with the object's texture pressed into it (unchanged if it has none). */
function textured(f: Feature, m: MeshData): MeshData {
  if (!isTextured(f)) return m;
  const t = applyTexture(m.vertices, m.triangles, f.texture, f.kind);
  return { ...m, vertices: t.display.vertices, normals: t.display.normals, triangles: t.display.triangles };
}

/** Textured objects that aren't inside another textured object or a hole: each becomes its own mesh in results and exports. */
function texturedRoots(features: Feature[]): Feature[] {
  return features.filter((f) => {
    if (!isTextured(f)) return false;
    for (let p = features.find((x) => x.id === f.parentId); p; p = features.find((x) => x.id === p!.parentId)) if (p.mode === "hole" || isTextured(p)) return false;
    return true;
  });
}

/**
 * A textured object in the world: its finished shape with the holes that reach
 * it cut away, textured in its own frame. `display` has normals for the view.
 */
function texturedWorld(features: Feature[], f: Feature & { texture: NonNullable<Feature["texture"]> }) {
  const was = excludeTextured;
  excludeTextured = false;
  try {
    const own = f.kind === "group" ? branch(features, f) : buildOwn(f);
    if (!own) return null;
    let shape = placeInWorld(features, f, own);
    const [lo, hi] = shape.boundingBox.bounds;
    for (const h of cuttingHoles(features, f)) {
      const hs = branch(features, h);
      if (!hs) continue;
      const placed = placeInWorld(features, h, hs);
      const [a, b] = placed.boundingBox.bounds;
      if ([0, 1, 2].some((k) => a[k] > hi[k] || b[k] < lo[k])) continue;
      shape = shape.cut(placed);
    }
    const world = worldMatrix(features, f.id);
    const m = shape.mesh({ tolerance: 0.02, angularTolerance: 0.15 });
    const local = toLocal({ id: f.id, vertices: new Float32Array(m.vertices), normals: new Float32Array(m.normals), triangles: new Uint32Array(m.triangles), edges: new Float32Array(), edgeGroups: new Int32Array() }, world);
    const t = applyTexture(local.vertices, local.triangles, f.texture, f.kind);
    const toWorld = (arr: Float32Array, normals = false) => {
      const out = new Float32Array(arr.length);
      const v = new Vector3();
      const nm = new Matrix3().getNormalMatrix(world);
      for (let i = 0; i < arr.length; i += 3) out.set((normals ? v.fromArray(arr, i).applyMatrix3(nm).normalize() : v.fromArray(arr, i).applyMatrix4(world)).toArray(), i);
      return out;
    };
    // Mirrored: its triangles turn inside out on the way back, so they're flipped.
    const flip = (tris: Uint32Array) => {
      const out = tris.slice();
      if (world.determinant() < 0) for (let i = 0; i < out.length; i += 3) [out[i + 1], out[i + 2]] = [out[i + 2], out[i + 1]];
      return out;
    };
    return {
      vertices: toWorld(t.vertices),
      triangles: flip(t.triangles),
      display: { vertices: toWorld(t.display.vertices), normals: toWorld(t.display.normals, true), triangles: flip(t.display.triangles) },
    };
  } finally {
    excludeTextured = was;
  }
}

/** A binary STL of several triangle meshes. */
function stlBlob(meshes: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }[]): Blob {
  const n = meshes.reduce((sum, m) => sum + m.triangles.length / 3, 0);
  const view = new DataView(new ArrayBuffer(84 + n * 50));
  view.setUint32(80, n, true);
  let at = 84;
  for (const m of meshes)
    for (let t = 0; t < m.triangles.length; t += 3) {
      const [a, b, c] = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]].map((i) => [m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nrm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const l = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
      [...nrm.map((x) => x / l), ...a, ...b, ...c].forEach((x, k) => view.setFloat32(at + 4 * k, x, true));
      at += 50;
    }
  return new Blob([view.buffer], { type: "model/stl" });
}

// ---- Holes through meshes ------------------------------------------------------------------
// Meshes (imported STL/OBJ/3MF, sculpts) can't go through OpenCascade's exact booleans; holes
// cut them with Manifold, a mesh boolean library, instead.

type ManifoldLib = Awaited<ReturnType<typeof ManifoldModule>>;
let manifoldLib: Promise<ManifoldLib> | null = null;
const manifold = () =>
  (manifoldLib ??= ManifoldModule({ locateFile: () => manifoldWasm }).then((m) => {
    m.setup();
    return m;
  }));

/** The loaded library, for use inside synchronous builds (loaded at the start of each request). */
let manifoldReady: ManifoldLib | null = null;

/** Triangles as a Manifold solid; throws `gaps` if they don't close up. */
function toManifold(M: ManifoldLib, w: WorldMesh, gaps: string) {
  const mesh = new M.Mesh({ numProp: 3, vertProperties: w.vertices, triVerts: w.triangles });
  mesh.merge(); // Join corners that sit at the same place (STL files repeat them).
  try {
    return new M.Manifold(mesh);
  } catch {
    throw new Error(gaps);
  }
}

function fromManifold(m: { getMesh(): { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array } }): WorldMesh {
  const out = m.getMesh();
  const stride = out.numProp;
  const vertices = new Float32Array((out.vertProperties.length / stride) * 3);
  for (let i = 0, j = 0; i < out.vertProperties.length; i += stride, j += 3) vertices.set(out.vertProperties.subarray(i, i + 3), j);
  return { vertices, triangles: new Uint32Array(out.triVerts) };
}

/** A solid's surface as triangles, fine enough for booleans (flat facets come out exact). */
function shapeTriangles(shape: Shape3D): WorldMesh {
  const known = knownTriangles.get(shape);
  if (known) return known;
  const m = shape.mesh({ tolerance: 0.02, angularTolerance: 0.15 });
  return { vertices: new Float32Array(m.vertices), triangles: new Uint32Array(m.triangles) };
}

/** Joined or cut as meshes, with Manifold. */
type BooleanOp = "fuse" | "cut" | "intersect";

function meshBoolean(a: WorldMesh, b: WorldMesh, op: BooleanOp): WorldMesh {
  return logged(`mesh ${op} (${(a.triangles.length / 3).toLocaleString()} + ${(b.triangles.length / 3).toLocaleString()} triangles)`, () => meshBooleanNow(a, b, op));
}

function meshBooleanNow(a: WorldMesh, b: WorldMesh, op: BooleanOp): WorldMesh {
  const M = manifoldReady;
  if (!M) throw new Error("The mesh library isn't loaded.");
  const gaps = "a shape has gaps or crossing faces";
  const ma = toManifold(M, a, gaps);
  const mb = toManifold(M, b, gaps);
  const raw = op === "cut" ? ma.subtract(mb) : op === "intersect" ? ma.intersect(mb) : ma.add(mb);
  // Booleans leave slivers where faces nearly meet; they shade and outline as stray lines. Under 5 µm: gone.
  const r = raw.simplify(0.005);
  try {
    return fromManifold(r);
  } finally {
    for (const m of [ma, mb, raw, r]) m.delete();
  }
}

/**
 * A fuse or cut. OpenCascade's exact booleans can fail (or crash) on solids
 * made of thousands of facets, such as ones made from meshes; then it's done
 * as a mesh boolean instead and made back into a solid.
 */
function booleanSafe(a: Shape3D, b: Shape3D, op: BooleanOp): Shape3D {
  const viaMeshes = () => {
    const mesh = meshBoolean(shapeTriangles(a), shapeTriangles(b), op);
    if (!mesh.triangles.length) throw new Error(op === "cut" ? "the hole cuts away the whole object." : op === "intersect" ? "its shapes don't overlap anywhere." : "nothing is left.");
    const solid = solidFromTriangles(mesh.vertices, mesh.triangles, [1, 1, 1], "bodies");
    knownTriangles.set(solid, mesh);
    return solid;
  };
  // A faceted solid: OpenCascade would take many seconds (or fail), so straight to meshes.
  if (knownTriangles.has(a) || knownTriangles.has(b)) return logged(`${op} (as meshes: a solid made from a mesh)`, viaMeshes);
  try {
    return logged(`${op} (exact)`, () => {
      if (op !== "intersect") return op === "cut" ? a.cut(b) : a.fuse(b);
      const r = a.intersect(b);
      if (measureVolume(r) < 1e-9) throw new Error("its shapes don't overlap anywhere, so nothing is left.");
      return r;
    });
  } catch (err) {
    try {
      return logged(`${op} (as meshes, after the exact one failed)`, viaMeshes);
    } catch {
      throw err;
    }
  }
}

/** The centre of mass of a closed set of triangles (even density): each triangle's cone to the origin, weighted by its volume. */
function meshCentre(m: WorldMesh): [number, number, number] {
  const v = m.vertices;
  const t = m.triangles;
  let total = 0;
  const c = [0, 0, 0];
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, d] = [3 * t[i], 3 * t[i + 1], 3 * t[i + 2]];
    const vol = (v[a] * (v[b + 1] * v[d + 2] - v[b + 2] * v[d + 1]) - v[a + 1] * (v[b] * v[d + 2] - v[b + 2] * v[d]) + v[a + 2] * (v[b] * v[d + 1] - v[b + 1] * v[d])) / 6;
    total += vol;
    for (let k = 0; k < 3; k++) c[k] += (vol * (v[a + k] + v[b + k] + v[d + k])) / 4;
  }
  return total ? (c.map((x) => x / total) as [number, number, number]) : [0, 0, 0];
}

/**
 * Each moving part (hinged, sliding or orbiting, as it sits now) against the
 * rest of the model: where they overlap, and how close they come. Printed in
 * place, an overlap fuses it, and a gap much under 0.3 mm usually does too.
 */
function movingClashes(features: Feature[]): Clash[] {
  const M = manifoldReady;
  if (!M) throw new Error("The mesh library isn't loaded.");
  failures = {};
  const out: Clash[] = [];
  for (const f of features) {
    if (!f.joint || f.mode !== "solid" || insideMergedGroup(features, f.id)) continue;
    const sub = subtreeIds(features, f.id);
    const own = branchTriangles(features, f);
    const rest = branchTriangles(features.filter((x) => !sub.has(x.id)), null);
    if (!own || !rest) continue;
    let a, b, common;
    try {
      a = toManifold(M, transformMesh(own, worldMatrix(features, f.id)), "");
      b = toManifold(M, rest, "");
      common = a.intersect(b);
      const overlap = common.volume();
      if (overlap > 1e-3) {
        const w = fromManifold(common);
        const mesh = new Float32Array(w.triangles.length * 3);
        for (let i = 0; i < w.triangles.length; i++) mesh.set(w.vertices.subarray(3 * w.triangles[i], 3 * w.triangles[i] + 3), 3 * i);
        out.push({ id: f.id, overlap, gap: -1, mesh });
      } else {
        const gap = a.minGap(b, 1);
        out.push({ id: f.id, overlap: 0, gap: gap < 1 ? gap : -1 });
      }
    } catch {
      // A shape with gaps can't be checked; leave it out.
    } finally {
      for (const m of [a, b, common]) m?.delete();
    }
  }
  return out;
}

/** The area of a set of triangles' surface. */
function meshArea(m: WorldMesh): number {
  const { vertices: v, triangles: t } = m;
  let sum = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
    const [ux, uy, uz] = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
    const [wx, wy, wz] = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
    sum += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  }
  return sum;
}

/** The volume a closed set of triangles holds. */
function meshVolume(m: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): number {
  const { vertices: v, triangles: t } = m;
  let sum = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
    sum += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return sum / 6;
}

/**
 * A finished model's triangles for an STL. OpenCascade's meshing can leave
 * faces out of a tricky solid (a groove rounded along a curve), giving an open
 * mesh: if its volume doesn't match the solid's, the model is cut as triangles
 * instead (as the view does).
 */
function stlTriangles(shape: Shape3D, features: Feature[], withoutTextured = false): { vertices: ArrayLike<number>; triangles: ArrayLike<number> } {
  const m = shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
  const exact = measureVolume(shape);
  if (Math.abs(meshVolume(m) - exact) <= Math.abs(exact) * 0.002 + 0.05) return m;
  // Textured objects go in as their own meshes (see the export), so they're left out here too.
  const was = excludeTextured;
  excludeTextured = withoutTextured;
  try {
    return logged("mesh the model as triangles (the exact solid's mesh had gaps)", () => branchTriangles(features, null)) ?? m;
  } finally {
    excludeTextured = was;
  }
}

/** A quick fingerprint of a long string (a mesh's data), for cache keys. */
function fingerprint(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${h >>> 0}`;
}

type WorldMesh = { vertices: Float32Array; triangles: Uint32Array };
const meshCutCache = new Map<string, WorldMesh | null>();

/**
 * A mesh object with the holes that reach it cut away, in world coordinates.
 * Null when no hole reaches it. Throws if the mesh isn't closed (a boolean
 * needs a watertight mesh).
 */
async function cutMeshObject(features: Feature[], f: Extract<Feature, { kind: "sculpt" }>): Promise<WorldMesh | null> {
  const holes = cuttingHoles(features, f);
  if (!holes.length) return null;
  const world = worldMatrix(features, f.id);
  const key = JSON.stringify([
    fingerprint(f.params.positions),
    fingerprint(f.params.indices),
    world.elements.map(r6),
    holes.map((h) => [geometryKey(features, h.id), worldMatrix(features, h.id).elements.map(r6)]),
  ]);
  if (meshCutCache.has(key)) return meshCutCache.get(key)!;
  // The mesh in the world (a mirrored one's triangles turned back the right way out).
  const local = decodeFloats(f.params.positions);
  const tris = decodeIndices(f.params.indices).slice();
  const v = new Vector3();
  const pos = new Float32Array(local.length);
  for (let i = 0; i < local.length; i += 3) pos.set(v.fromArray(local, i).applyMatrix4(world).toArray(), i);
  if (world.determinant() < 0) for (let i = 0; i < tris.length; i += 3) [tris[i + 1], tris[i + 2]] = [tris[i + 2], tris[i + 1]];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]);
      hi[k] = Math.max(hi[k], pos[i + k]);
    }
  // The holes that reach it, as meshes.
  const cutters: WorldMesh[] = [];
  const outerFailures = failures;
  failures = {};
  try {
    for (const h of holes) {
      const ht = branchTriangles(features, h);
      if (!ht) continue;
      const placed = transformMesh(ht, worldMatrix(features, h.id));
      const [a, b] = meshBounds(placed);
      if ([0, 1, 2].some((k) => a[k] > hi[k] || b[k] < lo[k])) continue;
      cutters.push(placed);
    }
  } finally {
    failures = outerFailures;
  }
  let result: WorldMesh | null = null;
  if (cutters.length) {
    const M = await manifold();
    const gaps = (what: string) => `${what} has gaps or crossing faces, so holes can't cut it (holes need a closed, watertight mesh; repairing it in a slicer or mesh tool can fix this).`;
    const body = toManifold(M, { vertices: pos, triangles: tris }, gaps("This mesh"));
    const made = cutters.map((c) => toManifold(M, c, gaps("A hole")));
    let cut = body;
    for (const c of made) {
      const next = cut.subtract(c);
      if (cut !== body) cut.delete();
      cut = next;
    }
    result = fromManifold(cut);
    for (const m of [body, ...made, cut]) m.delete();
  }
  meshCutCache.set(key, result);
  if (meshCutCache.size > 50) meshCutCache.delete(meshCutCache.keys().next().value!);
  return result;
}

/** A mesh for the view: sharp edges kept and outlined (like an imported CAD mesh). */
/**
 * Line segments (pairs of points) that lie on a mesh's surface, within `eps`:
 * a shape's own edges that a cut left in place (those it cut away go).
 */
function edgesOnSurface(lines: Float32Array, vertices: Float32Array, triangles: Uint32Array, eps = 0.01): Float32Array {
  const cell = 2;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let t = 0; t < triangles.length / 3; t++) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++)
      for (let a = 0; a < 3; a++) {
        const v = vertices[triangles[t * 3 + k] * 3 + a];
        lo[a] = Math.min(lo[a], v - eps);
        hi[a] = Math.max(hi[a], v + eps);
      }
    for (let x = Math.floor(lo[0] / cell); x <= Math.floor(hi[0] / cell); x++)
      for (let y = Math.floor(lo[1] / cell); y <= Math.floor(hi[1] / cell); y++)
        for (let z = Math.floor(lo[2] / cell); z <= Math.floor(hi[2] / cell); z++) {
          const k = `${x},${y},${z}`;
          const list = grid.get(k);
          if (list) list.push(t);
          else grid.set(k, [t]);
        }
  }
  const [a, b, c, p, q] = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  const tri = new Triangle();
  const onSurface = (x: number, y: number, z: number) => {
    p.set(x, y, z);
    for (const t of grid.get(key(x, y, z)) ?? []) {
      a.fromArray(vertices, triangles[t * 3] * 3);
      b.fromArray(vertices, triangles[t * 3 + 1] * 3);
      c.fromArray(vertices, triangles[t * 3 + 2] * 3);
      tri.set(a, b, c).closestPointToPoint(p, q);
      if (q.distanceToSquared(p) <= eps * eps) return true;
    }
    return false;
  };
  const kept: number[] = [];
  for (let i = 0; i < lines.length; i += 6) {
    const [x0, y0, z0, x1, y1, z1] = lines.subarray(i, i + 6);
    if (onSurface((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)) kept.push(x0, y0, z0, x1, y1, z1);
  }
  return new Float32Array(kept);
}

function meshForView(id: string, w: WorldMesh, toFrame: import("three").Matrix4 | null, ownEdges?: Float32Array): MeshData {
  const g = new BufferGeometry();
  const vertices = w.vertices.slice();
  const triangles = w.triangles.slice();
  if (toFrame) {
    const inv = toFrame.clone().invert();
    const v = new Vector3();
    for (let i = 0; i < vertices.length; i += 3) vertices.set(v.fromArray(vertices, i).applyMatrix4(inv).toArray(), i);
    if (toFrame.determinant() < 0) for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]];
  }
  g.setAttribute("position", new BufferAttribute(vertices, 3));
  g.setIndex(new BufferAttribute(triangles, 1));
  const creased = toCreasedNormals(g, Math.PI / 6);
  const edges = new EdgesGeometry(g, 30);
  let lines = edges.getAttribute("position").array as Float32Array;
  if (ownEdges?.length) {
    const kept = edgesOnSurface(ownEdges, vertices, triangles);
    const all = new Float32Array(lines.length + kept.length);
    all.set(lines);
    all.set(kept, lines.length);
    lines = all;
  }
  const mesh: MeshData = {
    id,
    vertices: creased.getAttribute("position").array as Float32Array,
    normals: creased.getAttribute("normal").array as Float32Array,
    triangles: Uint32Array.from({ length: creased.getAttribute("position").count }, (_, i) => i),
    edges: lines,
    edgeGroups: new Int32Array(),
  };
  for (const x of [g, creased, edges]) x.dispose();
  return mesh;
}

function post(msg: KernelResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  // OpenCascade throws raw WebAssembly exceptions without a readable message.
  if (typeof WebAssembly !== "undefined" && "Exception" in WebAssembly && err instanceof (WebAssembly as unknown as { Exception: new () => object }).Exception) {
    return "the geometry kernel couldn't build this shape (check for overlapping or self-crossing outlines).";
  }
  return String(err);
}

self.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const req = event.data;
  try {
    await ready;
    await keptLoaded;
    adjusted = {};
    facetMigrations = {};
    excludeTextured = false; // In case an earlier request stopped half way.
    if ("features" in req) {
      (req as { features: Feature[] }).features = withHolesCuttingAround(req.features);
      modelFeatures = req.features;
      rememberBreps(req.features);
      await ensureFonts(req.features);
      // Mesh booleans stand in when OpenCascade's fail (see booleanSafe); have them ready.
      manifoldReady ??= await manifold();
    }
    if (req.type === "font") {
      // An imported font: check it can be read, and keep it for texts that use it.
      let font: Font;
      try {
        font = await loadFont(req.data, `${CUSTOM_FONT}${req.id}`, true);
      } catch {
        throw new Error("This font file can't be read (use a .ttf, .otf or .woff file; .woff2 isn't supported).");
      }
      fonts[`${CUSTOM_FONT}${req.id}`] = font;
      const names = font.names as unknown as Record<string, Record<string, string> | undefined>;
      const name = names.fullName?.en ?? names.fontFamily?.en ?? "Imported font";
      return post({ type: "fontLoaded", requestId: req.requestId, name });
    }
    buildLog = req.type === "build" && req.debug ? [] : null;
    logDepth = 0;
    if (req.type === "build") {
      const meshes: MeshData[] = [];
      let errors: Record<string, string> = {};
      if (req.combined) {
        failures = {};
        // Textured objects come out as their own meshes (their patterns can't go through the exact booleans).
        const roots = texturedRoots(req.features);
        excludeTextured = roots.length > 0;
        try {
          if (hasFaceted(req.features)) {
            const w = branchTriangles(req.features, null);
            if (w) meshes.push(meshForView("combined", w, null));
          } else {
            const shape = branch(req.features, null);
            if (shape) meshes.push(toMesh("combined", shape));
          }
          for (const f of roots) {
            const t = texturedWorld(req.features, f as Feature & { texture: NonNullable<Feature["texture"]> });
            if (t) meshes.push({ id: "combined", ...t.display, edges: new Float32Array(), edgeGroups: new Int32Array() });
          }
          // Meshes with holes through them (the view shows the others as they are).
          for (const f of req.features) {
            if (f.kind !== "sculpt") continue;
            try {
              const w = await cutMeshObject(req.features, f);
              if (w) meshes.push(meshForView(f.id, w, null));
            } catch (err) {
              failures[f.id] = message(err);
            }
          }
        } finally {
          excludeTextured = false;
        }
        errors = failures;
      } else {
        cutFailures = {};
        for (const f of req.features) {
          // Shapes inside a merged group are shown as part of the group's mesh.
          if (insideMergedGroup(req.features, f.id)) continue;
          try {
            if (f.kind === "sculpt") {
              if (!req.cuts) continue;
              const w = await cutMeshObject(req.features, f);
              if (w) meshes.push(meshForView(f.id, w, worldMatrix(req.features, f.id)));
              continue;
            }
            // A merged group is drawn as one shape: the parts hidden inside it are left out of that (just in the view).
            const shown = isMergedGroup(f) ? withoutHiddenInside(req.features, f) : req.features;
            const cut = req.cuts ? logged(`${f.name}: holes cut for the view`, () => cutMesh(shown, f)) : null;
            if (cut) meshes.push(cut);
            else if (isMergedGroup(f)) {
              failures = {};
              // Its mesh is kept like an object's own (see ownMesh): the group's shape is cached, but meshing it isn't quick.
              const key = `group|${branchKey(shown, f)}|${JSON.stringify(isTextured(f) ? f.texture : null)}`;
              let kept = meshCache.get(key);
              if (!kept) {
                const outer = adjusted;
                adjusted = {};
                try {
                  if (sweepOf(f)) {
                    // A swept hole group stays as triangles (see groupTriangles).
                    const w = logged(`${f.name}: its merged shape`, () => groupTriangles(shown, f));
                    kept = { mesh: w && { ...meshForView("", w, null), id: f.id }, adjusted, failures: { ...failures } };
                  } else {
                    const shape = logged(`${f.name}: its merged shape`, () => branch(shown, f));
                    kept = { mesh: shape && textured(f, toMesh(f.id, shape)), adjusted, failures: { ...failures } };
                    shape?.delete();
                  }
                } finally {
                  adjusted = Object.assign(outer, adjusted);
                }
                meshCache.set(key, kept);
              } else Object.assign(adjusted, kept.adjusted);
              Object.assign(errors, kept.failures ?? {});
              const m = kept.mesh;
              if (m) meshes.push({ id: f.id, vertices: m.vertices.slice(), normals: m.normals.slice(), triangles: m.triangles.slice(), edges: m.edges.slice(), edgeGroups: m.edgeGroups.slice() });
            } else {
              const m = logged(`${f.name}: its mesh for the view`, () => ownMesh(f));
              if (m) meshes.push(m);
            }
          } catch (err) {
            errors[f.id] = message(err);
          }
        }
      }
      if (!req.combined) errors = { ...cutFailures, ...errors };
      const transfer = meshes.flatMap((m) => [m.vertices.buffer, m.normals.buffer, m.triangles.buffer, m.edges.buffer, m.edgeGroups.buffer]);
      // Copies: the originals stay cached here.
      const facets = Object.fromEntries(Object.entries(facetMigrations).map(([ref, w]) => [ref, { vertices: w.vertices.slice(), triangles: w.triangles.slice() }]));
      const log = buildLog ?? undefined;
      buildLog = null;
      post({ type: "built", requestId: req.requestId, meshes, errors, adjusted, ...(Object.keys(facets).length ? { facets } : {}), ...(log ? { log } : {}) }, transfer);
    } else if (req.type === "meshOf" && req.preview) {
      // A placement preview: the same mesh (and cache entry) the build will use.
      const f = req.features.find((x) => x.id === req.id);
      let mesh: MeshData | null = null;
      try {
        mesh = f ? ownMesh(f) : null;
      } catch {
        // No preview for a shape that can't be built; the build will report why.
      }
      post({ type: "mesh", requestId: req.requestId, mesh }, mesh ? [mesh.vertices.buffer, mesh.normals.buffer, mesh.triangles.buffer, mesh.edges.buffer, mesh.edgeGroups.buffer] : []);
    } else if (req.type === "meshOf") {
      const f = req.features.find((x) => x.id === req.id);
      failures = {};
      const shape = f ? (f.kind === "group" ? branch(req.features, f) : buildOwn(f)) : null;
      // Finer than the display mesh, so curved surfaces come out smooth as clay.
      const m = shape ? shape.mesh({ tolerance: 0.02, angularTolerance: 0.2 }) : null;
      let mesh: MeshData | null = m
        ? { id: req.id, vertices: new Float32Array(m.vertices), normals: new Float32Array(m.normals), triangles: new Uint32Array(m.triangles), edges: new Float32Array(), edgeGroups: new Int32Array() }
        : null;
      // Turned into clay with its texture in it.
      if (mesh && f && isTextured(f)) {
        const t = applyTexture(mesh.vertices, mesh.triangles, f.texture, f.kind);
        mesh = { ...mesh, vertices: t.vertices, normals: new Float32Array(t.vertices.length), triangles: t.triangles };
      }
      post({ type: "mesh", requestId: req.requestId, mesh });
    } else if (req.type === "parts") {
      // One mesh per top-level object (holes at the top level cut each of them), for 3MF.
      failures = {};
      const roots = texturedRoots(req.features);
      excludeTextured = roots.length > 0;
      const top = childrenOf(req.features, null);
      const holes = top.flatMap((f): Cutter[] => {
        if (f.mode !== "hole") return [];
        const s = branch(req.features, f);
        return s ? [{ id: f.id, shape: place(f, s) }] : [];
      });
      const parts: MeshData[] = [];
      if (hasFaceted(req.features)) {
        const cutters: MeshCutter[] = top.filter((f) => f.mode === "hole").flatMap((h) => {
          const w = branchTriangles(req.features, h);
          return w ? [{ id: h.id, name: h.name, mesh: transformMesh(w, localMatrix(h)) }] : [];
        });
        for (const f of top) {
          if (f.mode === "hole") continue;
          // Holes it ignores leave it alone; ones only something inside it ignores go down into it.
          const reach = cutters.filter((c) => !f.ignoreHoles?.includes(c.id));
          const deep = reach.filter((c) => insideIgnores(req.features, f, c.id));
          const back = localMatrix(f).invert();
          const own = branchTriangles(req.features, f, deep.map((c) => ({ ...c, mesh: transformMesh(c.mesh, back) })));
          if (!own) continue;
          let w = transformMesh(own, localMatrix(f));
          for (const c of reach.filter((c) => !deep.includes(c))) w = meshBoolean(w, c.mesh, "cut");
          parts.push({ id: f.id, vertices: w.vertices, normals: new Float32Array(), triangles: w.triangles, edges: new Float32Array(), edgeGroups: new Int32Array() });
        }
      }
      for (const f of hasFaceted(req.features) ? [] : top) {
        if (f.mode === "hole") continue;
        const reach = holes.filter((c) => !f.ignoreHoles?.includes(c.id));
        const deep = reach.filter((c) => insideIgnores(req.features, f, c.id));
        let shape = branch(req.features, f, deep.map((c) => ({ id: c.id, shape: unplace(f, copyShape(c.shape)) })));
        if (!shape) continue;
        shape = place(f, shape);
        for (const h of reach.filter((c) => !deep.includes(c))) shape = booleanSafe(shape, h.shape, "cut");
        const m = shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
        parts.push({ id: f.id, vertices: new Float32Array(m.vertices), normals: new Float32Array(), triangles: new Uint32Array(m.triangles), edges: new Float32Array(), edgeGroups: new Int32Array() });
      }
      excludeTextured = false;
      // Each textured object is its own part, in place.
      for (const f of roots) {
        const t = texturedWorld(req.features, f as Feature & { texture: NonNullable<Feature["texture"]> });
        if (t) parts.push({ id: f.id, vertices: t.vertices, normals: new Float32Array(), triangles: t.triangles, edges: new Float32Array(), edgeGroups: new Int32Array() });
      }
      post({ type: "parts", requestId: req.requestId, parts }, parts.flatMap((m) => [m.vertices.buffer, m.triangles.buffer]));
    } else if (req.type === "export") {
      failures = {};
      // Textures go into STL (each textured object as its own closed mesh, overlapping the rest as slicers expect); STEP holds exact shapes only.
      const roots = req.format === "stl" ? texturedRoots(req.features) : [];
      excludeTextured = roots.length > 0;
      // With solids made from meshes, an STL is worked out as triangles (the exact way takes minutes).
      const asTriangles = req.format === "stl" && hasFaceted(req.features);
      const triangles = asTriangles ? branchTriangles(req.features, null) : null;
      const shape = asTriangles ? null : branch(req.features, null);
      excludeTextured = false;
      let blob: Blob;
      if (asTriangles) {
        const meshes: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }[] = triangles ? [triangles] : [];
        for (const f of roots) {
          const t = texturedWorld(req.features, f as Feature & { texture: NonNullable<Feature["texture"]> });
          if (t) meshes.push(t);
        }
        if (!meshes.length) throw new Error("Nothing to export: add at least one solid shape.");
        blob = stlBlob(meshes);
      } else if (roots.length) {
        const meshes: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }[] = [];
        if (shape) meshes.push(stlTriangles(shape, req.features, true));
        for (const f of roots) {
          const t = texturedWorld(req.features, f as Feature & { texture: NonNullable<Feature["texture"]> });
          if (t) meshes.push(t);
        }
        if (!meshes.length) throw new Error("Nothing to export: add at least one solid shape.");
        blob = stlBlob(meshes);
      } else {
        if (!shape) throw new Error("Nothing to export: add at least one solid shape.");
        blob = req.format === "step" ? shape.blobSTEP() : stlBlob([stlTriangles(shape, req.features)]);
      }
      // Anything that couldn't be built is missing from the file: say so rather than export it quietly without.
      const missing = Object.entries(failures).map(([id, why]) => `${req.features.find((f) => f.id === id)?.name ?? id} (${why})`);
      post({ type: "exported", requestId: req.requestId, blob, ...(missing.length ? { warning: `Left out of the file because they couldn't be built: ${missing.join("; ")}` } : {}) });
    } else if (req.type === "stats") {
      // As triangles (quick, and what an STL holds): the volume, the area of its surface, and its size.
      failures = {};
      const w = branchTriangles(req.features, null);
      let stats: ModelStats | null = null;
      if (w && w.triangles.length) {
        const [lo, hi] = meshBounds(w);
        stats = { volume: Math.abs(meshVolume(w)), area: meshArea(w), size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], centre: meshCentre(w) };
      }
      post({ type: "stats", requestId: req.requestId, stats });
    } else if (req.type === "clashes") {
      const clashes = movingClashes(req.features);
      post({ type: "clashes", requestId: req.requestId, clashes }, clashes.flatMap((c) => (c.mesh ? [c.mesh.buffer] : [])));
    } else if (req.type === "section") {
      post({ type: "loops", requestId: req.requestId, loops: sectionLoops(req.features, req.id) });
    } else if (req.type === "offset") {
      post({ type: "loops", requestId: req.requestId, loops: req.entities.flatMap((e) => offsetLoops(e, req.distance)) });
    } else if (req.type === "cutMeshes") {
      // Mesh objects with holes through them, as world triangles (for STL and 3MF exports).
      const out: Record<string, Float32Array> = {};
      for (const f of req.features) {
        if (f.kind !== "sculpt") continue;
        const w = await cutMeshObject(req.features, f);
        if (!w) continue;
        const soup = new Float32Array(w.triangles.length * 3);
        for (let i = 0; i < w.triangles.length; i++) soup.set(w.vertices.subarray(3 * w.triangles[i], 3 * w.triangles[i] + 3), 3 * i);
        out[f.id] = soup;
      }
      post({ type: "cutMeshes", requestId: req.requestId, meshes: out });
    } else if (req.type === "importSolids") {
      const parts = await importSolids(req.files);
      post({ type: "importedSolids", requestId: req.requestId, parts });
    }
  } catch (err) {
    post({ type: "error", requestId: req.requestId, message: message(err) });
  }
};

// The mesh library loads alongside OpenCascade (most models need it on their first build).
void manifold().then((m) => (manifoldReady ??= m));

ready.then(
  () => post({ type: "ready" }),
  (err) => post({ type: "error", requestId: -1, message: `Kernel failed to load: ${err}` }),
);
