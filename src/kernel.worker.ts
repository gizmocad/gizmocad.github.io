// Runs OpenCascade (via replicad) off the main thread so the UI never freezes.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { EdgeFinder, assembleWire, cast, draw, drawCircle, drawEllipse, drawText, genericSweep, getOC, loadFont, makeBaseBox, makeBox, makeCircle, makeCylinder, makeHelix, makeLine, makeEllipsoid, makePolygon, makeSolid, makeSphere, setOC, type Drawing, type Shape3D } from "replicad";
import {
  PLANE_ROTATIONS,
  SCREW_SIZES,
  LEAN_KINDS,
  childrenOf,
  insideMergedGroup,
  isMergedGroup,
  type Clip,
  clipNormal,
  type ScrewParams,
  type Shell,
  type SpringParams,
  type TextParams,
  jointMatrix,
  type EdgeOp,
  type Feature,
  type SketchEntity,
  type SketchParams,
} from "./model";
import sans400 from "@fontsource/roboto/files/roboto-latin-400-normal.woff?url";
import sans700 from "@fontsource/roboto/files/roboto-latin-700-normal.woff?url";
import serif400 from "@fontsource/roboto-slab/files/roboto-slab-latin-400-normal.woff?url";
import serif700 from "@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url";
import mono400 from "@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff?url";
import mono700 from "@fontsource/roboto-mono/files/roboto-mono-latin-700-normal.woff?url";
import { entityPath, gearPath, isProfile, prismPoints, starPoints, strokePieces, type Path } from "./sketchGeometry";
import type { KernelRequest, KernelResponse, MeshData } from "./kernel";
import { hedron } from "./hedron";

/** Fonts for text, bundled with the app (Roboto family, OFL/Apache licensed). */
const FONT_FILES: Record<string, string> = {
  "sans-400": sans400,
  "sans-700": sans700,
  "serif-400": serif400,
  "serif-700": serif700,
  "mono-400": mono400,
  "mono-700": mono700,
};
type Font = Awaited<ReturnType<typeof loadFont>>;
const fonts: Record<string, Font> = {};

const ready = (async () => {
  const oc = await opencascade({ locateFile: () => wasmUrl });
  setOC(oc as Parameters<typeof setOC>[0]);
  await Promise.all(Object.entries(FONT_FILES).map(async ([name, url]) => (fonts[name] = await loadFont(url, name))));
})();

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
function buildSketch(p: SketchParams, featureLean: Lean, taper = 0): Shape3D | null {
  if (p.operation === "flat") return null; // Just a drawing until it's extruded or revolved.
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

type EdgeFilter = Parameters<Shape3D["fillet"]>[1];

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
  let lo = 0;
  let hi = op.size;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (tryEdgeOp(shape, op, mid)) lo = mid;
    else hi = mid;
  }
  const safe = Math.floor(lo * 0.98 * 100) / 100;
  const result = safe > 0 ? tryEdgeOp(shape, op, safe) : null;
  adjusted[op.id] = result ? safe : 0;
  return result ?? shape;
}

/** Apply fillets/chamfers in order, shrinking any that are too big for the shape. */
function applyEdgeOps(shape: Shape3D, ops: EdgeOp[]): Shape3D {
  for (const [i, op] of ops.entries()) {
    if (op.size <= 0 || (op.target === "picked" && op.points.length === 0)) continue;
    try {
      shape = safeEdgeOp(shape, op);
    } catch {
      const label = `${op.type === "fillet" ? "Fillet" : op.type === "bevel" ? "Bevel" : "Chamfer"} ${i + 1}`;
      throw new Error(`${label}: its edges no longer exist; pick them again.`);
    }
  }
  return shape;
}

/** The feature's own geometry with its fillets/chamfers, in its local frame. */
function buildOwn(f: Feature): Shape3D | null {
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
  if (shape && finished && f.edgeOps.length) shape = applyEdgeOps(shape, f.edgeOps);
  if (shape && finished && f.shell) shape = applyShell(shape, f.shell);
  return shape && f.clips?.length ? applyClips(shape, f.clips) : shape;
}

/**
 * Hollow a solid: walls `thickness` thick. Open at the top or bottom, the face
 * there is removed (a cup or box); closed, the inside is an empty pocket.
 */
function applyShell(shape: Shape3D, s: Shell): Shape3D {
  if (s.thickness <= 0) return shape;
  const [[, , zMin], [, , zMax]] = shape.boundingBox.bounds;
  try {
    if (s.open !== "none") {
      const z = s.open === "top" ? zMax : zMin;
      const result = shape.shell(s.thickness, (f) => f.inPlane("XY", z)); // Positive: walls go inward, outside size kept.
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
    const [lo, hi] = shape.boundingBox.bounds.map((p) => [...p]) as [number[], number[]];
    for (let i = 0; i < 3; i++) {
      lo[i] -= 1;
      hi[i] += 1;
    }
    if (c.normal) {
      shape = shape.intersect(halfSpace(c, lo, hi));
      continue;
    }
    const i = { x: 0, y: 1, z: 2 }[c.axis];
    if (c.keep === "below") hi[i] = c.at;
    else lo[i] = c.at;
    if (hi[i] - lo[i] < 1e-6) throw new Error("This piece's split is outside the object, so nothing is left of it.");
    shape = shape.intersect(makeBox(lo as [number, number, number], hi as [number, number, number]));
  }
  return shape;
}

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
  const font = fonts[`${p.font}-${p.bold ? 700 : 400}`];
  if (!font) throw new Error("The font isn't loaded yet.");
  if (p.size <= 0 || p.height <= 0) throw new Error("Text needs a size and height above 0.");
  const family = `${p.font}-${p.bold ? 700 : 400}`;
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
  } else pts.push([r, top]);
  pts.push([0, top]);
  return revolveUpright(polygonDrawing(pts));
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
    case "sketch":
      return buildSketch(f.params, lean, taper);
    case "group":
    case "plane":
    case "sculpt": // Meshes, drawn and exported outside the kernel.
      return null;
  }
}

function place(f: Feature, shape: Shape3D): Shape3D {
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

/** Features whose own geometry failed in the current build, with the reason. */
let failures: Record<string, string> = {};

function buildOwnSafe(f: Feature): Shape3D | null {
  try {
    return buildOwn(f);
  } catch (err) {
    failures[f.id] = message(err);
    return null;
  }
}

/**
 * A branch's result in its own frame: the feature's own shape, fused with its
 * solid children, minus its hole children. `parentId` null means the whole model.
 */
function branch(features: Feature[], self: Feature | null): Shape3D | null {
  let result = self ? buildOwnSafe(self) : null;
  const kids = childrenOf(features, self?.id ?? null);
  for (const c of kids.filter((c) => c.mode === "solid")) {
    const s = branch(features, c);
    if (s) {
      const placed = place(c, s);
      result = result ? result.fuse(placed) : placed;
    }
  }
  if (!result) return null;
  for (const c of kids.filter((c) => c.mode === "hole")) {
    const s = branch(features, c);
    if (s) result = result.cut(place(c, s));
  }
  if (self && isMergedGroup(self)) {
    try {
      result = applyEdgeOps(result, self.edgeOps);
      if (self.shell) result = applyShell(result, self.shell);
    } catch (err) {
      failures[self.id] = message(err); // Keep the unfinished shape so the rest still builds.
    }
  }
  // A split piece keeps only its side, children included.
  if (self?.clips?.length && kids.length) {
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
const meshCache = new Map<string, { mesh: MeshData | null; adjusted: Record<string, number> }>();

function ownMesh(f: Feature): MeshData | null {
  const key = JSON.stringify([f.kind, f.params, f.edgeOps, f.clips ?? [], f.shell ?? null, f.tilt ?? null]);
  if (!meshCache.has(key)) {
    const outer = adjusted;
    adjusted = {};
    try {
      const shape = buildOwn(f);
      meshCache.set(key, { mesh: shape ? toMesh("", shape, f.kind) : null, adjusted });
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
    adjusted = {};
    if (req.type === "build") {
      const meshes: MeshData[] = [];
      let errors: Record<string, string> = {};
      if (req.combined) {
        failures = {};
        const shape = branch(req.features, null);
        errors = failures;
        if (shape) meshes.push(toMesh("combined", shape));
      } else {
        for (const f of req.features) {
          // Shapes inside a merged group are shown as part of the group's mesh.
          if (insideMergedGroup(req.features, f.id)) continue;
          try {
            if (isMergedGroup(f)) {
              failures = {};
              const shape = branch(req.features, f);
              Object.assign(errors, failures);
              if (shape) meshes.push(toMesh(f.id, shape));
            } else {
              const m = ownMesh(f);
              if (m) meshes.push(m);
            }
          } catch (err) {
            errors[f.id] = message(err);
          }
        }
      }
      const transfer = meshes.flatMap((m) => [m.vertices.buffer, m.normals.buffer, m.triangles.buffer, m.edges.buffer, m.edgeGroups.buffer]);
      post({ type: "built", requestId: req.requestId, meshes, errors, adjusted }, transfer);
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
      const mesh: MeshData | null = m
        ? { id: req.id, vertices: new Float32Array(m.vertices), normals: new Float32Array(m.normals), triangles: new Uint32Array(m.triangles), edges: new Float32Array(), edgeGroups: new Int32Array() }
        : null;
      post({ type: "mesh", requestId: req.requestId, mesh });
    } else if (req.type === "parts") {
      // One mesh per top-level object (holes at the top level cut each of them), for 3MF.
      failures = {};
      const top = childrenOf(req.features, null);
      const holes = top.filter((f) => f.mode === "hole").map((f) => {
        const s = branch(req.features, f);
        return s ? place(f, s) : null;
      });
      const parts: MeshData[] = [];
      for (const f of top) {
        if (f.mode === "hole") continue;
        let shape = branch(req.features, f);
        if (!shape) continue;
        shape = place(f, shape);
        for (const h of holes) if (h) shape = shape.cut(h);
        const m = shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
        parts.push({ id: f.id, vertices: new Float32Array(m.vertices), normals: new Float32Array(), triangles: new Uint32Array(m.triangles), edges: new Float32Array(), edgeGroups: new Int32Array() });
      }
      post({ type: "parts", requestId: req.requestId, parts }, parts.flatMap((m) => [m.vertices.buffer, m.triangles.buffer]));
    } else if (req.type === "export") {
      failures = {};
      const shape = branch(req.features, null);
      if (!shape) throw new Error("Nothing to export: add at least one solid shape.");
      const blob = req.format === "step" ? shape.blobSTEP() : shape.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 });
      post({ type: "exported", requestId: req.requestId, blob });
    }
  } catch (err) {
    post({ type: "error", requestId: req.requestId, message: message(err) });
  }
};

ready.then(
  () => post({ type: "ready" }),
  (err) => post({ type: "error", requestId: -1, message: `Kernel failed to load: ${err}` }),
);
