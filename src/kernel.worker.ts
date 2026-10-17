// Runs OpenCascade (via replicad) off the main thread so the UI never freezes.

import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { EdgeFinder, type Edge, assembleWire, cast, deserializeShape, draw, drawCircle, drawEllipse, drawText, genericSweep, getOC, importSTEP, loadFont, makeBaseBox, makeBox, makeCircle, makeCompound, makeCylinder, makeHelix, makeLine, makeEllipsoid, makePolygon, makeSolid, makeSphere, setOC, type Drawing, type Shape3D } from "replicad";
import {
  PLANE_ROTATIONS,
  SCREW_SIZES,
  LEAN_KINDS,
  childrenOf,
  subtreeIds,
  worldMatrix,
  insideMergedGroup,
  isMergedGroup,
  type Clip,
  clipNormal,
  type ScrewParams,
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
import { entityPath, gearPath, isProfile, outline, prismPoints, starPoints, strokePieces, type Path } from "./sketchGeometry";
import type { BuildStep, ImportedSolid, ImportSource, KernelRequest, KernelResponse, MeshData } from "./kernel";
import { hedron } from "./hedron";
import { CUSTOM_FONT, builtInFontUrl, fontFamily, isCustomFont } from "./fonts";
import { Matrix3, Matrix4, Vector3 } from "three";
import { applyTexture } from "./texture";
import { BufferAttribute, BufferGeometry, EdgesGeometry } from "three";
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
    for (const t of e.trims ?? []) {
      if (!d) return null;
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
function applyEdgeOps(shape: Shape3D, ops: EdgeOp[]): Shape3D {
  for (const [i, op] of ops.entries()) {
    if (op.size <= 0 || (op.target === "picked" && op.points.length === 0)) continue;
    const label = `${op.type === "fillet" ? "Fillet" : op.type === "bevel" ? "Bevel" : "Chamfer"} ${i + 1}`;
    if (facetedBuild && op.target !== "picked" && !facetedTargets(shape, op).length)
      throw new Error(`${label}: there are no corners there to ${op.type === "fillet" ? "round" : "cut"} (its curves are smooth).`);
    try {
      shape = logged(`${label} (${op.size} mm, ${op.target} edges)`, () => safeEdgeOp(shape, op));
    } catch {
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
  if (shape && finished && f.edgeOps.length) {
    facetedBuild = isFaceted(f);
    try {
      shape = applyEdgeOps(shape, f.edgeOps);
    } finally {
      facetedBuild = false;
    }
  }
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
const keyParams = (f: Feature) => (f.kind === "imported" ? { ...f.params, brep: undefined, mesh: undefined } : f.params);

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
const hasFaceted = (features: Feature[]) => features.some((f) => f.kind === "imported" && !!f.params.faceted);

/** A faceted solid with nothing done to it that needs the exact solid (fillets, hollowing, tilt, splits). */
function plainFaceted(f: Feature): boolean {
  // Edge finishes that do nothing yet (no size, or no edges picked: as while picking them) don't count.
  const ops = f.edgeOps.filter((o) => o.size > 0 && !(o.target === "picked" && !o.points.length));
  return f.kind === "imported" && !!f.params.faceted && !ops.length && !f.clips?.length && !f.shell && !f.tilt;
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
function branchTriangles(features: Feature[], f: Feature | null): WorldMesh | null {
  // Fillets on a merged group, or a split, need the exact result.
  if (f && ((f.kind === "group" && isMergedGroup(f)) || f.clips?.length)) {
    const s = branch(features, f);
    return s && shapeTriangles(s);
  }
  let w: WorldMesh | null = null;
  // As in branch(): with textures added as their own meshes, a textured object's own shape is left out.
  if (!f || (excludeTextured && isTextured(f) && f.kind !== "group")) w = null;
  else if (f.kind === "imported" && plainFaceted(f)) w = facetTriangles(f.params);
  else if (f.kind !== "group") {
    const own = buildOwnSafe(f);
    if (own) w = shapeTriangles(own);
  }
  const kids = childrenOf(features, f?.id ?? null);
  for (const c of kids.filter((c) => c.mode === "solid")) {
    if (excludeTextured && isTextured(c) && c.kind === "group") continue;
    const k = branchTriangles(features, c);
    if (k) w = w ? meshBoolean(w, transformMesh(k, localMatrix(c)), "fuse") : transformMesh(k, localMatrix(c));
  }
  if (!w) return null;
  for (const c of kids.filter((c) => c.mode === "hole")) {
    const k = branchTriangles(features, c);
    if (k) w = meshBoolean(w, transformMesh(k, localMatrix(c)), "cut");
  }
  return w;
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
    if (importedCache.size > 64) importedCache.delete(importedCache.keys().next().value!);
  }
  return shape.clone();
}

const isEven = ([x, y, z]: number[]) => Math.abs(x - y) < 1e-9 && Math.abs(y - z) < 1e-9;

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
        if (stretchedCache.size > 16) stretchedCache.delete(stretchedCache.keys().next().value!);
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
    if (stretchedCache.size > 16) stretchedCache.delete(stretchedCache.keys().next().value!);
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
  const n = triangles.length / 3;
  const stl = new DataView(new ArrayBuffer(84 + n * 50));
  // OpenCascade takes a file whose first bytes are all plain text for a text STL: mark it binary.
  stl.setUint8(0, 0xff);
  stl.setUint32(80, n, true);
  for (let t = 0; t < n; t++)
    for (let c = 0; c < 3; c++) {
      const v = triangles[t * 3 + c] * 3;
      const at = 84 + t * 50 + 12 + c * 12;
      stl.setFloat32(at, vertices[v] * sx, true);
      stl.setFloat32(at + 4, vertices[v + 1] * sy, true);
      stl.setFloat32(at + 8, vertices[v + 2] * sz, true);
    }
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
    const sew = new oc.BRepBuilderAPI_Sewing(Math.max(1e-5, diag * 1e-6), true, true, true, false);
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
  return f.kind === "imported" && !f.params.faceted && !isEven(f.params.scale) && !f.edgeOps.length && !f.clips?.length && !f.shell;
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
function branch(features: Feature[], self: Feature | null): Shape3D | null {
  // With textures added as their own meshes, a textured object's own shape is left out here (its children stay).
  let result = self && !(excludeTextured && isTextured(self) && self.kind !== "group") ? buildOwnSafe(self) : null;
  const kids = childrenOf(features, self?.id ?? null);
  for (const c of kids.filter((c) => c.mode === "solid")) {
    if (excludeTextured && isTextured(c) && c.kind === "group") continue;
    const s = branch(features, c);
    if (s) {
      const placed = place(c, s);
      result = result ? booleanSafe(result, placed, "fuse") : placed;
    }
  }
  if (!result) return null;
  for (const c of kids.filter((c) => c.mode === "hole")) {
    const s = branch(features, c);
    if (s) result = booleanSafe(result, place(c, s), "cut");
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
  // An imported solid's geometry is named by its ref (its BREP text can be megabytes).
  const key = JSON.stringify([f.kind, keyParams(f), f.edgeOps, f.clips ?? [], f.shell ?? null, f.tilt ?? null, isTextured(f) ? f.texture : null]);
  if (!meshCache.has(key)) {
    const outer = adjusted;
    adjusted = {};
    try {
      if (f.kind === "imported" && plainFaceted(f)) meshCache.set(key, { mesh: textured(f, facetView(facetTriangles(f.params))), adjusted });
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
  return holes;
}

/** A shape in its object's frame, moved to where it is in the world (through its parents). */
function placeInWorld(features: Feature[], f: Feature, shape: Shape3D): Shape3D {
  let s = place(f, shape);
  for (let p = features.find((x) => x.id === f.parentId); p; p = features.find((x) => x.id === p!.parentId)) s = place(p, s);
  return s;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
/** What a feature's subtree looks like to the kernel (names, colours and visibility don't change geometry). */
const geometryKey = (features: Feature[], id: string) =>
  features
    .filter((x) => subtreeIds(features, id).has(x.id))
    .map((x) => [x.id, x.parentId, x.kind, x.mode, keyParams(x), x.position, x.rotation, x.edgeOps, x.clips, x.shell, x.tilt, x.mirrored, x.joint]);

const cutCache = new Map<string, { mesh: MeshData | null; error?: string }>();

/** Objects whose holes couldn't be cut in the last build, with why (shown as their build error). */
let cutFailures: Record<string, string> = {};

/**
 * The object as it ends up with the holes that reach it cut away, in its own
 * frame (so it shows where its own mesh would). Null when no hole touches it,
 * or the cut fails (it's then shown whole; Show result reports why).
 */
function cutMesh(features: Feature[], f: Feature): MeshData | null {
  if (f.kind === "plane" || f.kind === "sculpt" || (f.kind === "group" && !isMergedGroup(f))) return null;
  const holes = cuttingHoles(features, f);
  if (!holes.length) return null;
  const world = worldMatrix(features, f.id);
  const key = JSON.stringify([
    f.kind === "group" ? geometryKey(features, f.id) : [f.kind, keyParams(f), f.edgeOps, f.clips ?? [], f.shell ?? null, f.tilt ?? null, f.mirrored ?? false],
    world.elements.map(r6),
    holes.map((h) => [geometryKey(features, h.id), worldMatrix(features, h.id).elements.map(r6)]),
    isTextured(f) ? f.texture : null,
  ]);
  if (!cutCache.has(key)) {
    const outerFailures = failures;
    failures = {};
    let mesh: MeshData | null = null;
    let error: string | undefined;
    try {
      // A solid made from a mesh is cut as triangles: far quicker than OpenCascade (it's only for the view).
      const quick = isFaceted(f) && !isTextured(f);
      if (quick) {
        const own = f.kind === "imported" && plainFaceted(f) ? facetTriangles(f.params) : shapeTriangles(buildOwn(f)!);
        let w = transformMesh(own, world);
        const [lo, hi] = meshBounds(w);
        let cut = false;
        for (const h of holes) {
          const ht = branchTriangles(features, h);
          if (!ht) continue;
          const placed = transformMesh(ht, worldMatrix(features, h.id));
          const [a, b] = meshBounds(placed);
          if ([0, 1, 2].some((k) => a[k] > hi[k] || b[k] < lo[k])) continue;
          w = meshBoolean(w, placed, "cut");
          cut = true;
        }
        if (cut) mesh = f.kind === "imported" && plainFaceted(f) ? facetView(transformMesh(w, world.clone().invert())) : meshForView(f.id, w, world);
      } else {
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
      }
    } catch (err) {
      mesh = null;
      error = `its holes couldn't be cut: ${message(err)}`;
    } finally {
      failures = outerFailures;
    }
    cutCache.set(key, { mesh, error });
    if (cutCache.size > 200) cutCache.delete(cutCache.keys().next().value!);
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
function meshBoolean(a: WorldMesh, b: WorldMesh, op: "fuse" | "cut"): WorldMesh {
  return logged(`mesh ${op} (${(a.triangles.length / 3).toLocaleString()} + ${(b.triangles.length / 3).toLocaleString()} triangles)`, () => meshBooleanNow(a, b, op));
}

function meshBooleanNow(a: WorldMesh, b: WorldMesh, op: "fuse" | "cut"): WorldMesh {
  const M = manifoldReady;
  if (!M) throw new Error("The mesh library isn't loaded.");
  const gaps = "a shape has gaps or crossing faces";
  const ma = toManifold(M, a, gaps);
  const mb = toManifold(M, b, gaps);
  const r = op === "cut" ? ma.subtract(mb) : ma.add(mb);
  try {
    return fromManifold(r);
  } finally {
    for (const m of [ma, mb, r]) m.delete();
  }
}

/**
 * A fuse or cut. OpenCascade's exact booleans can fail (or crash) on solids
 * made of thousands of facets, such as ones made from meshes; then it's done
 * as a mesh boolean instead and made back into a solid.
 */
function booleanSafe(a: Shape3D, b: Shape3D, op: "fuse" | "cut"): Shape3D {
  const viaMeshes = () => {
    const mesh = meshBoolean(shapeTriangles(a), shapeTriangles(b), op);
    if (!mesh.triangles.length) throw new Error(op === "cut" ? "the hole cuts away the whole object." : "nothing is left.");
    const solid = solidFromTriangles(mesh.vertices, mesh.triangles, [1, 1, 1], "bodies");
    knownTriangles.set(solid, mesh);
    return solid;
  };
  // A faceted solid: OpenCascade would take many seconds (or fail), so straight to meshes.
  if (knownTriangles.has(a) || knownTriangles.has(b)) return logged(`${op} (as meshes: a solid made from a mesh)`, viaMeshes);
  try {
    return logged(`${op} (exact)`, () => (op === "cut" ? a.cut(b) : a.fuse(b)));
  } catch (err) {
    try {
      return logged(`${op} (as meshes, after the exact one failed)`, viaMeshes);
    } catch {
      throw err;
    }
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
function meshForView(id: string, w: WorldMesh, toFrame: import("three").Matrix4 | null): MeshData {
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
  const mesh: MeshData = {
    id,
    vertices: creased.getAttribute("position").array as Float32Array,
    normals: creased.getAttribute("normal").array as Float32Array,
    triangles: Uint32Array.from({ length: creased.getAttribute("position").count }, (_, i) => i),
    edges: edges.getAttribute("position").array as Float32Array,
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
    adjusted = {};
    facetMigrations = {};
    excludeTextured = false; // In case an earlier request stopped half way.
    if ("features" in req) {
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
            const cut = req.cuts ? logged(`${f.name}: holes cut for the view`, () => cutMesh(req.features, f)) : null;
            if (cut) meshes.push(cut);
            else if (isMergedGroup(f)) {
              failures = {};
              const shape = branch(req.features, f);
              Object.assign(errors, failures);
              if (shape) meshes.push(textured(f, toMesh(f.id, shape)));
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
      const holes = top.filter((f) => f.mode === "hole").map((f) => {
        const s = branch(req.features, f);
        return s ? place(f, s) : null;
      });
      const parts: MeshData[] = [];
      if (hasFaceted(req.features)) {
        const cutters = top.filter((f) => f.mode === "hole").flatMap((h) => {
          const w = branchTriangles(req.features, h);
          return w ? [transformMesh(w, localMatrix(h))] : [];
        });
        for (const f of top) {
          if (f.mode === "hole") continue;
          const own = branchTriangles(req.features, f);
          if (!own) continue;
          let w = transformMesh(own, localMatrix(f));
          for (const c of cutters) w = meshBoolean(w, c, "cut");
          parts.push({ id: f.id, vertices: w.vertices, normals: new Float32Array(), triangles: w.triangles, edges: new Float32Array(), edgeGroups: new Int32Array() });
        }
      }
      for (const f of hasFaceted(req.features) ? [] : top) {
        if (f.mode === "hole") continue;
        let shape = branch(req.features, f);
        if (!shape) continue;
        shape = place(f, shape);
        for (const h of holes) if (h) shape = shape.cut(h);
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
        if (shape) meshes.push(shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 }));
        for (const f of roots) {
          const t = texturedWorld(req.features, f as Feature & { texture: NonNullable<Feature["texture"]> });
          if (t) meshes.push(t);
        }
        if (!meshes.length) throw new Error("Nothing to export: add at least one solid shape.");
        blob = stlBlob(meshes);
      } else {
        if (!shape) throw new Error("Nothing to export: add at least one solid shape.");
        blob = req.format === "step" ? shape.blobSTEP() : shape.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 });
      }
      post({ type: "exported", requestId: req.requestId, blob });
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

ready.then(
  () => post({ type: "ready" }),
  (err) => post({ type: "error", requestId: -1, message: `Kernel failed to load: ${err}` }),
);
