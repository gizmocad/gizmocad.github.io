// Resizing with the gizmo. The drag gives scale factors along the object's own
// X/Y/Z; instead of storing a stretch, we bake them into the object's real
// dimensions so every size stays exact and editable.

import { SCREW_SIZES, snapHeadroom, snapLayout, subtreeIds, syncSnapPair, type Feature, type SketchEntity, type SketchPlane, type Vec3 } from "./model";
import { decodeFloats, encodeFloats } from "./sculpt";
import { hedronBox } from "./hedron";
import { gearOuterRadius, prismPoints, round, starPoints } from "./sketchGeometry";

/** Round a length to the snap grid (never down to zero). */
function snapLength(v: number, snap: number): number {
  const r = snap > 0 ? Math.round(v / snap) * snap : Math.round(v * 1e4) / 1e4;
  return Math.max(r, snap > 0 ? snap : 0.01) + 0;
}

/** Round shapes snap their diameter (what the ruler and panel show), not their radius. */
function snapRadius(r: number, snap: number): number {
  return snapLength(2 * r, snap) / 2;
}

/** Shapes that stay round across X/Y take whichever of the two changed more. */
export function roundFactor(s: Vec3): number {
  return Math.abs(Math.log(s.x)) >= Math.abs(Math.log(s.y)) ? s.x : s.y;
}

/** Kinds whose X and Y always resize together. */
const ROUND_KINDS = new Set(["cone", "tube", "torus", "prism", "thread", "gear", "spring", "star", "text", "screw", "snap"]);

/** Does this object stay round across X/Y when resized (so X and Y change together)? */
export function staysRound(f: Feature): boolean {
  return ROUND_KINDS.has(f.kind) && !(f.kind === "spring" && f.params.style === "flat");
}

/** For groups and other cases that need one factor: whichever axis changed most. */
export function dominantFactor(s: Vec3): number {
  return [s.x, s.y, s.z].reduce((best, v) => (Math.abs(Math.log(v)) > Math.abs(Math.log(best)) ? v : best), 1);
}

/** Which local axes the sketch's U, V and normal lie along. */
const PLANE_AXES: Record<SketchPlane, ["x" | "y" | "z", "x" | "y" | "z", "x" | "y" | "z"]> = {
  XY: ["x", "y", "z"],
  XZ: ["x", "z", "y"],
  YZ: ["y", "z", "x"],
};

function scaleEntity(e: SketchEntity, su: number, sv: number) {
  const even = Math.sqrt(su * sv);
  const u = (x: number) => round(x * su);
  const v = (y: number) => round(y * sv);
  switch (e.type) {
    case "rect":
      [e.x, e.y, e.width, e.height] = [u(e.x), v(e.y), round(e.width * su), round(e.height * sv)];
      e.radius = round(e.radius * Math.min(su, sv));
      break;
    case "circle":
      if (Math.abs(su - sv) < 1e-6) [e.x, e.y, e.radius] = [u(e.x), v(e.y), round(e.radius * su)];
      else {
        // Stretched unevenly, a circle becomes an ellipse.
        const r = e.radius;
        delete (e as Partial<typeof e>).radius;
        Object.assign(e, { type: "ellipse", x: u(e.x), y: v(e.y), rx: round(r * su), ry: round(r * sv), angle: 0 });
      }
      break;
    case "ellipse":
      [e.x, e.y, e.rx, e.ry] = [u(e.x), v(e.y), round(e.rx * su), round(e.ry * sv)];
      break;
    case "ngon":
      [e.x, e.y, e.radius] = [u(e.x), v(e.y), round(e.radius * even)];
      break;
    case "slot":
    case "line":
      [e.x1, e.y1, e.x2, e.y2] = [u(e.x1), v(e.y1), u(e.x2), v(e.y2)];
      if (e.type === "slot") e.radius = round(e.radius * even);
      break;
    case "point":
      [e.x, e.y] = [u(e.x), v(e.y)];
      break;
    case "polygon":
    case "spline":
    case "stroke":
      e.points = e.points.map(([x, y]) => [u(x), v(y)]);
      if (e.type === "polygon") e.bends = e.bends.map((b) => round(b * even));
      if (e.type === "stroke") {
        e.width = round(e.width * even);
        if (e.bends) e.bends = e.bends.map((b) => round(b * even));
      }
      break;
  }
}

/** Scale one feature's own size by local factors `s`. */
function scaleOwn(f: Feature, s: Vec3, snap: number) {
  switch (f.kind) {
    case "box":
      f.params.width = snapLength(f.params.width * s.x, snap);
      f.params.depth = snapLength(f.params.depth * s.y, snap);
      f.params.height = snapLength(f.params.height * s.z, snap);
      break;
    case "cylinder":
      // X and Y stretch on their own, turning a round cylinder into an oval one.
      f.params.radius = snapRadius(f.params.radius * s.x, snap);
      f.params.radiusY = snapRadius(f.params.radiusY * s.y, snap);
      f.params.height = snapLength(f.params.height * s.z, snap);
      break;
    case "sphere":
      // Each axis stretches on its own, turning a sphere into an ellipsoid.
      f.params.radius = snapRadius(f.params.radius * s.x, snap);
      f.params.radiusY = snapRadius(f.params.radiusY * s.y, snap);
      f.params.radiusZ = snapRadius(f.params.radiusZ * s.z, snap);
      break;
    case "wedge":
    case "pyramid":
      f.params.width = snapLength(f.params.width * s.x, snap);
      f.params.depth = snapLength(f.params.depth * s.y, snap);
      f.params.height = snapLength(f.params.height * s.z, snap);
      break;
    case "cone": {
      // Cones, tubes, rings and prisms stay round in X/Y: follow whichever of X/Y changed more.
      const k = roundFactor(s);
      f.params.radius = snapRadius(f.params.radius * k, snap);
      f.params.topRadius = round(f.params.topRadius * k);
      f.params.height = snapLength(f.params.height * s.z, snap);
      break;
    }
    case "tube":
      // The wall keeps its thickness (unless the tube gets too small for it).
      f.params.radius = snapRadius(f.params.radius * roundFactor(s), snap);
      f.params.wall = Math.min(f.params.wall, round(f.params.radius * 0.9));
      f.params.height = snapLength(f.params.height * s.z, snap);
      break;
    case "torus":
      f.params.radius = snapRadius(f.params.radius * roundFactor(s), snap);
      f.params.tube = Math.min(snapRadius(f.params.tube * s.z, snap), round(f.params.radius * 0.45));
      break;
    case "prism":
      f.params.radius = snapRadius(f.params.radius * roundFactor(s), snap);
      f.params.height = snapLength(f.params.height * s.z, snap);
      break;
    case "hedron":
      // It only grows or shrinks as a whole: follow whichever axis changed most.
      f.params.radius = snapRadius(f.params.radius * dominantFactor(s), snap);
      break;
    case "imported": {
      const { size, scale } = f.params;
      const f6 = (v: number) => Math.round(v * 1e6) / 1e6;
      const factors = [s.x, s.y, s.z];
      if (Math.abs(s.x - s.y) < 1e-9 && Math.abs(s.y - s.z) < 1e-9) {
        // Kept in proportion: one factor for all (snapping each side separately would stretch it unevenly).
        const axis = [0, 1, 2].reduce((a, b) => (size[b] * scale[b] > size[a] * scale[a] ? b : a));
        const len = size[axis] * scale[axis];
        const k = len > 1e-9 ? snapLength(len * s.x, snap) / len : s.x;
        f.params.scale = scale.map((v) => f6(v * k)) as [number, number, number];
      } else {
        f.params.scale = scale.map((v, i) => (factors[i] === 1 || size[i] < 1e-9 ? v : f6(snapLength(size[i] * v * factors[i], snap) / size[i]))) as [number, number, number];
      }
      break;
    }
    case "thread":
      // The pitch is a standard size, so it stays; the diameter and length change.
      f.params.diameter = snapLength(f.params.diameter * roundFactor(s), snap);
      f.params.length = snapLength(f.params.length * s.z, snap);
      break;
    case "gear":
      // Same tooth count; bigger teeth (module) make a bigger gear.
      f.params.module = round(f.params.module * roundFactor(s));
      f.params.bore = round(f.params.bore * roundFactor(s));
      f.params.thickness = snapLength(f.params.thickness * s.z, snap);
      break;
    case "spring":
      if (f.params.style === "flat") {
        // Lying flat: width X, length Y (with the zigzag spacing), thickness Z.
        f.params.diameter = snapLength(f.params.diameter * s.x, snap);
        f.params.pitch = round(f.params.pitch * s.y);
        f.params.height = snapLength(f.params.height * s.y, snap);
        f.params.depth = snapLength(f.params.depth * s.z, snap);
        break;
      }
      f.params.diameter = snapLength(f.params.diameter * roundFactor(s), snap);
      f.params.pitch = round(f.params.pitch * s.z); // Same number of coils, stretched or squashed.
      f.params.height = snapLength(f.params.height * s.z, snap);
      break;
    case "star":
      f.params.radius = snapRadius(f.params.radius * roundFactor(s), snap);
      f.params.inner = round(f.params.inner * roundFactor(s));
      f.params.height = snapLength(f.params.height * s.z, snap);
      break;
    case "plane":
      f.params.size = snapLength(f.params.size * dominantFactor(s), snap);
      break;
    case "text":
      // Letters keep their proportions: the size follows X/Y, the height Z.
      f.params.size = round(f.params.size * roundFactor(s));
      f.params.spacing = round(f.params.spacing * roundFactor(s));
      f.params.height = snapLength(f.params.height * s.z, snap);
      break;
    case "screw":
      // Screw sizes are standard; only the depth changes.
      f.params.depth = snapLength(f.params.depth * s.z, snap);
      break;
    case "snap":
      f.params.diameter = snapLength(f.params.diameter * roundFactor(s), snap);
      f.params.depth = snapLength(f.params.depth * s.z, snap);
      break;
    case "sketch": {
      const [ua, va, na] = PLANE_AXES[f.params.plane];
      for (const e of f.params.entities) scaleEntity(e, s[ua], s[va]);
      if (f.params.operation === "extrude") f.params.depth = snapLength(f.params.depth * s[na], snap);
      f.params.offset = round(f.params.offset * s[na]);
      break;
    }
    case "sculpt": {
      const pos = decodeFloats(f.params.positions);
      // Its sizes land on the grid like other shapes' (one factor for all when kept in proportion).
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], pos[i + k]);
          hi[k] = Math.max(hi[k], pos[i + k]);
        }
      const ext = [0, 1, 2].map((k) => hi[k] - lo[k]);
      const raw = [s.x, s.y, s.z];
      const snapped = (k: number, factor: number) => (ext[k] > 1e-9 ? snapLength(ext[k] * factor, snap) / ext[k] : factor);
      let k3: number[];
      if (Math.abs(s.x - s.y) < 1e-9 && Math.abs(s.y - s.z) < 1e-9) {
        const big = [0, 1, 2].reduce((a, b) => (ext[b] > ext[a] ? b : a));
        k3 = raw.map(() => snapped(big, s.x));
      } else k3 = raw.map((factor, k) => (factor === 1 ? 1 : snapped(k, factor)));
      // The caller's factors follow the snapped sizes (for the one-side anchor and children's places);
      // without a grid (inside a resized group) they're left alone, as one shared factor.
      if (snap > 0) [s.x, s.y, s.z] = k3;
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] *= s.x;
        pos[i + 1] *= s.y;
        pos[i + 2] *= s.z;
      }
      f.params.positions = encodeFloats(pos);
      f.params.size = round(f.params.size * dominantFactor(s));
      break;
    }
    case "group":
      break;
  }
  // Picked fillet edges are stored as points on the shape; keep them on it.
  for (const op of f.edgeOps) op.points = op.points.map(([x, y, z]) => [x * s.x, y * s.y, z * s.z]);
  // A split piece's cut moves with the shape (a tilted cut also changes its tilt when stretched unevenly).
  for (const c of f.clips ?? []) {
    if (!c.normal) {
      c.at = round(c.at * s[c.axis]);
      continue;
    }
    const n = c.normal;
    const p = { x: n.x * c.at * s.x, y: n.y * c.at * s.y, z: n.z * c.at * s.z };
    const m = { x: n.x / s.x, y: n.y / s.y, z: n.z / s.z };
    const len = Math.hypot(m.x, m.y, m.z);
    c.normal = { x: m.x / len, y: m.y / len, z: m.z / len };
    c.at = round(c.normal.x * p.x + c.normal.y * p.y + c.normal.z * p.z);
  }
}

/**
 * A one-sided resize: the face at `at` (a coordinate along the object's own
 * `axis`) stays put. `dir` is that axis expressed in the parent's frame.
 */
export interface ResizeAnchor {
  axis: "x" | "y" | "z";
  at: number;
  dir: Vec3;
}

/** How much the object really grew along `axis`, after snapping. */
function actualFactor(before: Feature, after: Feature, axis: "x" | "y" | "z", s: Vec3): number {
  if (after.kind === "group") return dominantFactor(s);
  const a = featureExtents(before);
  const b = featureExtents(after);
  if (a && b) {
    const len = a[1][axis] - a[0][axis];
    return len > 1e-9 ? (b[1][axis] - b[0][axis]) / len : s[axis];
  }
  if (before.kind === "sketch" && after.kind === "sketch" && before.params.operation === "extrude" && PLANE_AXES[before.params.plane][2] === axis) {
    return before.params.depth > 1e-9 ? after.params.depth / before.params.depth : s[axis];
  }
  return s[axis];
}

/**
 * Apply a resize from the gizmo. Groups resize evenly with everything inside
 * them; other objects resize along their own axes, and their children keep
 * their relative places (but not their sizes). With an anchor, the object also
 * moves so only the dragged side changes (with one on each axis, a middle stays put).
 */
export function resizeFeature(features: Feature[], id: string, s: Vec3, snap: number, anchor?: ResizeAnchor | ResizeAnchor[]) {
  const f = features.find((x) => x.id === id);
  if (!f) return;
  // A snap peg or socket grows about its own axis and base, so it stays on the centre it was put on (and lined up with its other half).
  const anchors = anchor && f.kind !== "snap" ? [anchor].flat() : [];
  const before = anchors.length ? structuredClone(f) : null;
  resizeOwnTree(features, f, s, snap);
  syncSnapPair(features, f);
  const [was, now] = before ? [featureExtents(before), featureExtents(f)] : [null, null];
  for (const a of anchors) {
    // The anchor face sat at `at`; after scaling about the origin it sits at at·k, so move back by the difference.
    let shift = a.at * (1 - actualFactor(before!, f, a.axis, s));
    // Not every shape grows evenly from its origin (a screw's head stands a set amount proud): when the fixed
    // side is one of its ends, where that end went is measured instead.
    if (was && now) {
      if (Math.abs(a.at - was[0][a.axis]) < 0.05) shift = was[0][a.axis] - now[0][a.axis];
      else if (Math.abs(a.at - was[1][a.axis]) < 0.05) shift = was[1][a.axis] - now[1][a.axis];
    }
    f.position = {
      x: round(f.position.x + a.dir.x * shift),
      y: round(f.position.y + a.dir.y * shift),
      z: round(f.position.z + a.dir.z * shift),
    };
  }
}

function resizeOwnTree(features: Feature[], f: Feature, s: Vec3, snap: number) {
  const id = f.id;
  if (f.kind === "group") {
    const k = dominantFactor(s);
    const even = { x: k, y: k, z: k };
    for (const sub of subtreeIds(features, id)) {
      const g = features.find((x) => x.id === sub)!;
      if (sub !== id) {
        g.position = { x: round(g.position.x * k), y: round(g.position.y * k), z: round(g.position.z * k) };
        if (g.joint) g.joint.origin = { x: round(g.joint.origin.x * k), y: round(g.joint.origin.y * k), z: round(g.joint.origin.z * k) };
      }
      scaleOwn(g, even, 0);
    }
    return;
  }
  scaleOwn(f, s, snap);
  for (const c of features.filter((x) => x.parentId === id)) {
    c.position = { x: round(c.position.x * s.x), y: round(c.position.y * s.y), z: round(c.position.z * s.z) };
    // A child's hinge or slider is fixed to this object, so its pivot moves with the resize.
    if (c.joint) c.joint.origin = { x: round(c.joint.origin.x * s.x), y: round(c.joint.origin.y * s.y), z: round(c.joint.origin.z * s.z) };
  }
}

/**
 * Exact extents of a primitive in its own frame (min, max corners), for the
 * resize ruler. Null for shapes whose extents come from their mesh instead.
 */
export function featureExtents(f: Feature): [Vec3, Vec3] | null {
  const ext = baseExtents(f);
  // A tilted cut's piece, or a tapered or leaning shape, has no simple box; its mesh gives its extents instead.
  if (!ext || f.clips?.some((c) => c.normal) || isTilted(f)) return null;
  // A split piece only reaches its cut.
  for (const c of f.clips ?? []) {
    if (c.keep === "below") ext[1][c.axis] = Math.min(ext[1][c.axis], c.at);
    else ext[0][c.axis] = Math.max(ext[0][c.axis], c.at);
  }
  return ext;
}

function baseExtents(f: Feature): [Vec3, Vec3] | null {
  switch (f.kind) {
    case "box": {
      const { width: w, depth: d, height: h } = f.params;
      return [{ x: -w / 2, y: -d / 2, z: 0 }, { x: w / 2, y: d / 2, z: h }];
    }
    case "cylinder": {
      const { radius: x, radiusY: y, height: h } = f.params;
      return [{ x: -x, y: -y, z: 0 }, { x, y, z: h }];
    }
    case "sphere": {
      const { radius: x, radiusY: y, radiusZ: z } = f.params;
      return [{ x: -x, y: -y, z: 0 }, { x, y, z: 2 * z }];
    }
    case "cone": {
      const r = Math.max(f.params.radius, f.params.topRadius);
      return [{ x: -r, y: -r, z: 0 }, { x: r, y: r, z: f.params.height }];
    }
    case "tube": {
      const { radius: r, height: h } = f.params;
      return [{ x: -r, y: -r, z: 0 }, { x: r, y: r, z: h }];
    }
    case "torus": {
      const { radius: r, tube: t } = f.params;
      return [{ x: -r, y: -r, z: 0 }, { x: r, y: r, z: 2 * t }];
    }
    case "wedge":
    case "pyramid": {
      const { width: w, depth: d, height: h } = f.params;
      return [{ x: -w / 2, y: -d / 2, z: 0 }, { x: w / 2, y: d / 2, z: h }];
    }
    case "thread": {
      const r = f.params.diameter / 2;
      return [{ x: -r, y: -r, z: 0 }, { x: r, y: r, z: f.params.length }];
    }
    case "gear": {
      const r = gearOuterRadius(f.params.teeth, f.params.module);
      return [{ x: -r, y: -r, z: 0 }, { x: r, y: r, z: f.params.thickness }];
    }
    case "spring": {
      const r = f.params.diameter / 2;
      if (f.params.style === "flat") return [{ x: -r, y: 0, z: 0 }, { x: r, y: f.params.height, z: f.params.depth }];
      return [{ x: -r, y: -r, z: 0 }, { x: r, y: r, z: f.params.height }];
    }
    case "snap": {
      const p = f.params;
      const { r, embed } = snapLayout(p);
      const socket = p.part === "socket";
      const R = r + p.catch + (socket ? p.clearance : 0);
      return [{ x: -R, y: -R, z: socket ? -0.5 : -embed }, { x: R, y: R, z: socket ? p.depth + snapHeadroom(p) : p.depth }];
    }
    case "screw": {
      const size = SCREW_SIZES[f.params.size];
      const r = Math.max(size[f.params.fit], f.params.head === "counterbore" ? size.bore : f.params.head === "countersink" ? size.sink + 1 : 0) / 2;
      return [{ x: -r, y: -r, z: -f.params.depth }, { x: r, y: r, z: 0.5 }];
    }
    case "star": {
      const pts = starPoints(f.params.points, f.params.radius, f.params.inner);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return [{ x: Math.min(...xs), y: Math.min(...ys), z: 0 }, { x: Math.max(...xs), y: Math.max(...ys), z: f.params.height }];
    }
    case "imported": {
      const [x, y, z] = f.params.size.map((v, i) => (v * f.params.scale[i]) / 2);
      return [{ x: -x, y: -y, z: 0 }, { x, y, z: 2 * z }];
    }
    case "hedron": {
      const [a, b] = hedronBox(f.params.faces, f.params.radius);
      return [{ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }];
    }
    case "prism": {
      const pts = prismPoints(f.params.radius, f.params.sides);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return [{ x: Math.min(...xs), y: Math.min(...ys), z: 0 }, { x: Math.max(...xs), y: Math.max(...ys), z: f.params.height }];
    }
    default:
      return null;
  }
}

/** Tapered or leaning (its shape-specific points and box no longer apply). */
export function isTilted(f: Feature): boolean {
  return !!f.tilt && (!!f.tilt.taper || !!f.tilt.leanX || !!f.tilt.leanY);
}

/** A length as the resize will commit it: snapped to the grid. */
export function rulerLength(v: number, snap: number): number {
  return snapLength(v, snap);
}

/** Short size readout while dragging, e.g. "24 × 20 × 20 mm". */
export function sizeReadout(f: Feature, s: Vec3, snap: number): string {
  const probe = structuredClone(f);
  scaleOwn(probe, f.kind === "group" ? { x: dominantFactor(s), y: dominantFactor(s), z: dominantFactor(s) } : s, f.kind === "group" ? 0 : snap);
  const n = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
  switch (probe.kind) {
    case "box":
      return `${n(probe.params.width)} × ${n(probe.params.depth)} × ${n(probe.params.height)} mm`;
    case "cylinder": {
      const { radius: x, radiusY: y, height: h } = probe.params;
      return x === y ? `Ø ${n(x * 2)} × ${n(h)} mm` : `${n(x * 2)} × ${n(y * 2)} × ${n(h)} mm`;
    }
    case "sphere": {
      const { radius: x, radiusY: y, radiusZ: z } = probe.params;
      return x === y && y === z ? `Ø ${n(x * 2)} mm` : `${n(x * 2)} × ${n(y * 2)} × ${n(z * 2)} mm`;
    }
    case "sketch":
      return probe.params.operation === "extrude" ? `depth ${n(probe.params.depth)} mm, outline ×${n(s[PLANE_AXES[probe.params.plane][0]])}` : "resizing outline";
    default: {
      const ext = featureExtents(probe);
      if (ext) return `${n(ext[1].x - ext[0].x)} × ${n(ext[1].y - ext[0].y)} × ${n(ext[1].z - ext[0].z)} mm`;
      return f.kind === "group" ? `×${n(dominantFactor(s))} (evenly)` : `×${n(s.x)} / ×${n(s.y)} / ×${n(s.z)}`;
    }
  }
}
