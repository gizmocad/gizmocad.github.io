// The document is a list of operations, not meshes. The 3D result is always
// rebuilt from this list by the kernel, which keeps dimensions exact and makes
// undo, saving and (later) parametric history straightforward.
//
import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from "three";
import { defaultSculpt, type SculptParams } from "./sculpt";
import type { HedronFaces } from "./hedron";

// Features form a tree through `parentId`. A feature's position and rotation
// are relative to its parent, and a hole only cuts within its parent's branch.

export type ShapeKind =
  | "box"
  | "cylinder"
  | "sphere"
  | "cone"
  | "tube"
  | "torus"
  | "wedge"
  | "pyramid"
  | "prism"
  | "hedron"
  | "thread"
  | "gear"
  | "spring"
  | "star"
  | "text"
  | "screw"
  | "sketch"
  | "group"
  | "plane"
  | "sculpt"
  | "imported";
export type Mode = "solid" | "hole";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoxParams {
  width: number;
  depth: number;
  height: number;
}
/** Equal radii make a round cylinder; different ones stretch it into an oval. */
export interface CylinderParams {
  /** Radius along X. */
  radius: number;
  radiusY: number;
  height: number;
}
/** A round cone, or a cut-off cone when the top radius isn't 0. */
export interface ConeParams {
  radius: number;
  topRadius: number;
  height: number;
}
/** A hollow cylinder (pipe). */
export interface TubeParams {
  /** Outer radius. */
  radius: number;
  wall: number;
  height: number;
}
/** A ring (doughnut) lying flat. */
export interface TorusParams {
  /** Outer radius, to the outside of the ring. */
  radius: number;
  /** Radius of the ring's cross-section. */
  tube: number;
}
/** A ramp: full height at -X, sloping down to nothing at +X. Pyramids share the shape of params. */
export interface WedgeParams {
  width: number;
  depth: number;
  height: number;
}
/** A threaded rod (metric-style 60° thread). Make it a hole for a threaded hole / nut. */
export interface ThreadParams {
  /** Outside (major) diameter. */
  diameter: number;
  /** Distance between threads. */
  pitch: number;
  length: number;
}
/** A spur gear with involute teeth. Outside diameter = module × (teeth + 2). */
export interface GearParams {
  teeth: number;
  module: number;
  thickness: number;
  /** Hole through the middle (0 = none). */
  bore: number;
}
/**
 * A spring. "coil": wire wound in a helix (round or square wire; flat ends
 * let it stand). "flat": a zigzag strip lying flat on the bed, squashing
 * along Y, with optional end plates to fix it by.
 */
export interface SpringParams {
  style: "coil" | "flat";
  /** Coil: outside diameter. Flat: overall width (X). */
  diameter: number;
  /** Coil: height (Z). Flat: length (Y), the way it squashes. */
  /** Thickness of the wire / strip. */
  wire: number;
  /** Distance between coils / zigzag runs. */
  pitch: number;
  height: number;
  /** Coil wire cross-section. */
  section: "round" | "square";
  /** Coil: flat (ground) ends. Flat: plates at both ends. */
  ends: boolean;
  /** Flat: its thickness (Z), i.e. its height on the print bed. */
  depth: number;
  /** Flat: rounded U bends, or a sharp V zigzag of straight struts. */
  bends: "round" | "sharp";
}
/** A star: `points` tips on the outer radius, dips on the inner one. */
export interface StarParams {
  points: number;
  radius: number;
  inner: number;
  height: number;
}
/** Raised (or, as a hole, engraved) lettering. `size` is the height of capital letters. */
export interface TextParams {
  text: string;
  /** A built-in font's key (see fonts.ts), or "custom:<id>" for one imported into the model. */
  font: string;
  bold: boolean;
  size: number;
  /** How far the letters stand up (Z). */
  height: number;
  /** Extra space between letters, in mm. */
  spacing: number;
  align: "left" | "center" | "right";
}
/**
 * A hole for a metric screw, going down into the face it sits on (Z ≤ 0).
 * `fit` picks the shaft size: "tap" for the screw to cut its own thread,
 * "close"/"normal"/"loose" clearance. `head` adds a counterbore or countersink.
 */
export interface ScrewParams {
  size: ScrewSize;
  fit: "tap" | "close" | "normal" | "loose";
  head: "none" | "counterbore" | "countersink";
  depth: number;
}
export type ScrewSize = "M2" | "M2.5" | "M3" | "M4" | "M5" | "M6" | "M8" | "M10";
/** Shaft diameters for each fit, and the head recess (counterbore Ø × depth, countersink Ø at 90°). ISO 273 / 4762 / 10642. */
export const SCREW_SIZES: Record<ScrewSize, { tap: number; close: number; normal: number; loose: number; bore: number; boreDepth: number; sink: number }> = {
  M2: { tap: 1.6, close: 2.2, normal: 2.4, loose: 2.6, bore: 4.4, boreDepth: 2.3, sink: 4.4 },
  "M2.5": { tap: 2.05, close: 2.7, normal: 2.9, loose: 3.1, bore: 5.5, boreDepth: 2.8, sink: 5.5 },
  M3: { tap: 2.5, close: 3.2, normal: 3.4, loose: 3.6, bore: 6.5, boreDepth: 3.3, sink: 6.7 },
  M4: { tap: 3.3, close: 4.3, normal: 4.5, loose: 4.8, bore: 8, boreDepth: 4.4, sink: 9 },
  M5: { tap: 4.2, close: 5.3, normal: 5.5, loose: 5.8, bore: 10, boreDepth: 5.4, sink: 11.2 },
  M6: { tap: 5, close: 6.4, normal: 6.6, loose: 7, bore: 11, boreDepth: 6.4, sink: 13.4 },
  M8: { tap: 6.8, close: 8.4, normal: 9, loose: 10, bore: 15, boreDepth: 8.6, sink: 17.9 },
  M10: { tap: 8.5, close: 10.5, normal: 11, loose: 12, bore: 18, boreDepth: 10.8, sink: 22.4 },
};
/** A straight prism on a regular polygon; `radius` is centre to corner. */
export interface PrismParams {
  radius: number;
  sides: number;
  height: number;
}
/**
 * Tilt: `taper` leans every side face in from straight up (negative: out),
 * keeping the base; `leanX`/`leanY` slant the whole shape so its top shifts
 * that way while the top and bottom stay flat and the same size.
 */
export interface Tilt {
  taper: number;
  leanX: number;
  leanY: number;
}

/** Kinds that can lean (they're built as straight extrusions or from flat faces). */
export const LEAN_KINDS = new Set<string>(["box", "cylinder", "tube", "cone", "wedge", "pyramid", "prism", "hedron", "gear", "star", "text", "sketch"]);

/** A regular polyhedron resting on a face; `radius` is centre to corner. */
export interface HedronParams {
  faces: HedronFaces;
  radius: number;
}
/**
 * One side of a cut: what's left of an object split in two. `at` is along the
 * object's own `axis`; "below" keeps the part where that coordinate is smaller.
 */
export interface Clip {
  axis: "x" | "y" | "z";
  at: number;
  keep: "below" | "above";
  /**
   * A tilted cut: the plane where normal · point = at (normal is a unit vector
   * in the object's frame). Without it, the cut is square to `axis`.
   */
  normal?: Vec3;
}

/** The cut plane's direction: its normal, or the axis it's square to. */
export function clipNormal(c: Clip): Vec3 {
  return c.normal ?? { x: c.axis === "x" ? 1 : 0, y: c.axis === "y" ? 1 : 0, z: c.axis === "z" ? 1 : 0 };
}

/**
 * A connection to the parent object that the object can only move along: a
 * hinge/axle turns it about an axis, a slider slides it along one. `origin` and
 * `axis` are in the parent's frame; the feature's own position/rotation are
 * where it sits when `value` is 0.
 */
export interface Joint {
  /** hinge: turns about the axis; orbit: circles the axis but keeps facing the same way; slider: slides along it. */
  type: "hinge" | "orbit" | "slider";
  origin: Vec3;
  /** Unit vector. */
  axis: Vec3;
  /** Degrees for a hinge, mm for a slider. */
  value: number;
  /** Optional limits on `value`. */
  min?: number;
  max?: number;
}

/** Equal radii make a sphere; different ones stretch it into an ellipsoid. */
/**
 * A solid brought in from another CAD program (STEP, BREP, FreeCAD), kept as
 * its exact OpenCascade geometry. Its own origin is the middle of its base.
 */
export interface ImportedParams {
  /** Names this geometry (the same for copies), so the kernel reads `brep` only once. */
  ref: string;
  /** The shape in OpenCascade's BREP text format, at scale 1. */
  brep: string;
  /** Its size at scale 1 (X, Y, Z). */
  size: [number, number, number];
  /**
   * Resized along X, Y and Z. Even: exact. Uneven: rebuilt from a fine
   * triangulation (exact solids can't be stretched along one axis), with the
   * exact shape kept so evening it out again brings it back.
   */
  scale: [number, number, number];
  /** Made from a mesh: its curves are small flat facets (shaded smooth, and only real corners count as edges). */
  faceted?: boolean;
  /**
   * A faceted solid's triangles (local frame, scale 1; base64 like a sculpt's).
   * It's drawn and has holes cut straight from these; the exact solid is only
   * made from them (and `brep` is then empty) when fillets or exports need it.
   */
  mesh?: { positions: string; indices: string };
}

export type TexturePattern = "knurl" | "ribs" | "rings" | "bumps" | "honeycomb" | "grid" | "bricks" | "waves" | "wood" | "rough";

/** A printable surface pattern on an object's finished shape (see texture.ts). */
export interface Texture {
  pattern: TexturePattern;
  /** How deep the pattern goes (mm). */
  depth: number;
  /** One repeat of the pattern (mm). */
  size: number;
  /** Which faces: the sides (not top or bottom), every face, or the top only. */
  faces: "sides" | "all" | "top";
  /** Wrapped around the object's Z axis (round things), projected flat onto each side, or picked by shape. */
  wrap: "auto" | "around" | "flat";
  /** Raised out of the surface instead of pressed into it (pressed in keeps the outside size). */
  raised: boolean;
}

export interface SphereParams {
  /** Radius along X. */
  radius: number;
  radiusY: number;
  radiusZ: number;
}

// ---- Sketches ------------------------------------------------------------

/** Plane the sketch is drawn on, in the feature's local frame. */
export type SketchPlane = "XY" | "XZ" | "YZ";
/** "flat" is just the drawing (no solid yet); new sketches start flat until extruded or revolved in the 3D view. */
export type SketchOperation = "flat" | "extrude" | "revolve";
/** Which way an extrusion goes from the sketch plane. */
export type ExtrudeDirection = "normal" | "reversed" | "both";
/**
 * "add" regions make up the profile, "subtract" regions cut holes in it, and
 * "construction" geometry is only a drawing aid (snap target, guide line).
 */
export type EntityMode = "add" | "subtract" | "construction";
export type Point2 = [number, number];

/** Angles are in degrees, counter-clockwise from +U. */
/**
 * A trim kept on a shape, so it stays editable as itself (a trimmed circle can
 * still be resized as a circle): "keep" only the part inside any of `shapes`,
 * "cut" away the part inside them, or "merge" them in. `shapes` are copies of
 * what it was trimmed against, as they were then.
 */
export interface SketchTrim {
  op: "keep" | "cut" | "merge";
  shapes: SketchEntity[];
}

export type SketchEntity = { id: string; mode: EntityMode; trims?: SketchTrim[] } & (
  | { type: "rect"; x: number; y: number; width: number; height: number; angle: number; radius: number }
  | { type: "circle"; x: number; y: number; radius: number }
  | { type: "ellipse"; x: number; y: number; rx: number; ry: number; angle: number }
  | { type: "ngon"; x: number; y: number; radius: number; sides: number; angle: number }
  | { type: "slot"; x1: number; y1: number; x2: number; y2: number; radius: number }
  /** `bends[i]` bows the edge from point i to i+1 into an arc (signed sagitta; 0 = straight). */
  | { type: "polygon"; points: Point2[]; bends: number[] }
  /** A smooth closed curve through its points. */
  | { type: "spline"; points: Point2[] }
  /** A freehand brush stroke: the area within width/2 of the path through `points`. */
  | { type: "stroke"; points: Point2[]; width: number }
  | { type: "point"; x: number; y: number }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number }
);

export type SketchEntityType = SketchEntity["type"];

/**
 * A piece of sketch geometry a constraint refers to: a point (a corner,
 * centre or end), an edge (a straight side or line) or a circle.
 * `index` numbers the points/edges of the entity (see constraints.ts).
 */
export interface SketchRef {
  entity: string;
  kind: "point" | "edge" | "circle";
  index: number;
}
export type ConstraintType = "horizontal" | "vertical" | "parallel" | "perpendicular" | "equal" | "tangent" | "coincident" | "distance" | "length" | "diameter" | "angle" | "fix";
export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  refs: SketchRef[];
  /** Dimensions: the length (mm), diameter (mm) or angle (degrees). Fix: the point's [u, v]. */
  value?: number;
  at?: Point2;
}

export interface SketchParams {
  plane: SketchPlane;
  /** Shift of the sketch plane along its normal. */
  offset: number;
  operation: SketchOperation;
  /** Extrusion distance along the plane normal. */
  depth: number;
  direction: ExtrudeDirection;
  /** Revolve angle in degrees, around the sketch's vertical (V) axis. */
  angle: number;
  entities: SketchEntity[];
  /** Dimensions and geometric rules the drawing keeps to (see constraints.ts). */
  constraints?: SketchConstraint[];
}

/**
 * Rotations (axis, degrees), applied in order, that take the XY plane to the
 * sketch plane. Sketch U maps to the first named axis and V to the second;
 * extrusion goes along the remaining one. Shared by the kernel and the viewport
 * so both agree exactly.
 */
export const PLANE_ROTATIONS: Record<SketchPlane, { axis: [number, number, number]; degrees: number }[]> = {
  XY: [],
  XZ: [{ axis: [1, 0, 0], degrees: 90 }],
  YZ: [
    { axis: [1, 0, 0], degrees: 90 },
    { axis: [0, 0, 1], degrees: 90 },
  ],
};

// ---- Edge finishing ------------------------------------------------------

export type EdgeOpType = "fillet" | "chamfer" | "bevel";
/** Which edges an operation rounds or bevels. "picked" uses the clicked edges in `points`. */
export type EdgeTarget = "all" | "top" | "bottom" | "vertical" | "picked";

export interface EdgeOp {
  id: string;
  type: EdgeOpType;
  /** Fillet radius, chamfer distance, or a bevel's distance along its flatter face. */
  size: number;
  /** Bevel only: the cut's angle from that face, in degrees (45 is a plain chamfer). */
  angle?: number;
  /** Bevel only: measure from the other face at each edge instead. */
  flip?: boolean;
  target: EdgeTarget;
  /** A point on each picked edge, in the feature's local frame. */
  points: [number, number, number][];
  /** Applied after the holes that reach the object are cut, so the edges they make can be rounded too. */
  afterHoles?: boolean;
}

/** Kinds that can have fillets/chamfers. A group's apply to its merged result. */
export const FINISHABLE: ShapeKind[] = ["box", "cylinder", "sphere", "cone", "tube", "torus", "wedge", "pyramid", "prism", "hedron", "gear", "star", "text", "sketch", "group", "imported"];

/** Hollow it out: walls `thickness` thick, optionally open at the top or bottom. */
export interface Shell {
  thickness: number;
  open: "none" | "top" | "bottom";
}

// ---- Features ------------------------------------------------------------

interface FeatureBase {
  id: string;
  name: string;
  mode: Mode;
  parentId: string | null;
  /** Relative to the parent. For primitives: centre in X/Y, bottom in Z. */
  position: Vec3;
  /** Rotation in degrees relative to the parent, applied about X, then Y, then Z. */
  rotation: Vec3;
  /** Fillets and chamfers, applied in order. */
  edgeOps: EdgeOp[];
  /**
   * See-through, and clicks, placing and snapping go through it (it, and
   * everything inside it), so things can be put inside or behind it. Still
   * part of the model and exports.
   */
  ghost?: boolean;
  /** Hidden from the view (it, and everything inside it). Still part of the model and exports. */
  hidden?: boolean;
  /** Set on the pieces of a split object: the side of each cut that this piece keeps. */
  clips?: Clip[];
  /** Connected to its parent by a hinge or slider. */
  joint?: Joint;
  /** Display (and 3MF) colour, e.g. "#3ddc97". Unset: the default colour. */
  color?: string;
  /**
   * Mirrored: flipped across its own YZ plane (X → −X) before it's turned and
   * placed. Mirroring along any axis is this plus a turn, so one flag covers all.
   */
  mirrored?: boolean;
  /** Hollowed out (after fillets, before splits). */
  shell?: Shell;
  /** Sides tapered and/or the whole shape leaning over (degrees). */
  tilt?: Tilt;
  /** A printable surface pattern on its finished shape (shown, and in STL/3MF exports). */
  texture?: Texture;
  /** Left out of the model (and exports) without deleting it: a switched-off history step. */
  suppressed?: boolean;
  /** Holes (by id) that don't cut it, or anything inside it, though they'd otherwise reach it. */
  ignoreHoles?: string[];
  /** Holes only: grown by this much (mm) on every side, so a part the same shape fits into what it cuts. */
  clearance?: number;
  /** Groups only: shown, and exported, as one joined shape rather than separate parts that move together. */
  combined?: boolean;
  /** Holes only: swept through a hinge's swing (or a slider's travel), so a moving part clears all of it. */
  sweep?: Sweep;
  /** A clearance cut with a copy of its object's hinge or slider: moving either joint moves the other (the object's id). */
  follows?: string;
}

/**
 * A hole swept along a joint's movement: the joint (in the hole's parent frame,
 * its value where the hole sits), the moving object's position (for an orbit),
 * the hole's own placement when it was made (so the sweep moves with the hole),
 * and the range of joint values (degrees, or mm for a slider) to clear.
 */
export interface Sweep {
  joint: Joint;
  position: Vec3;
  frame: number[];
  from: number;
  to: number;
  /** The moving part it was made from (shown swinging while an end is dragged). */
  source?: string;
  /** Switched off: the hole cuts just where it sits (the sweep is kept to switch back on). */
  off?: boolean;
}

export type Feature =
  | (FeatureBase & { kind: "box"; params: BoxParams })
  | (FeatureBase & { kind: "cylinder"; params: CylinderParams })
  | (FeatureBase & { kind: "sphere"; params: SphereParams })
  | (FeatureBase & { kind: "cone"; params: ConeParams })
  | (FeatureBase & { kind: "tube"; params: TubeParams })
  | (FeatureBase & { kind: "torus"; params: TorusParams })
  | (FeatureBase & { kind: "wedge"; params: WedgeParams })
  | (FeatureBase & { kind: "pyramid"; params: WedgeParams })
  | (FeatureBase & { kind: "prism"; params: PrismParams })
  | (FeatureBase & { kind: "hedron"; params: HedronParams })
  | (FeatureBase & { kind: "thread"; params: ThreadParams })
  | (FeatureBase & { kind: "gear"; params: GearParams })
  | (FeatureBase & { kind: "spring"; params: SpringParams })
  | (FeatureBase & { kind: "star"; params: StarParams })
  | (FeatureBase & { kind: "text"; params: TextParams })
  | (FeatureBase & { kind: "screw"; params: ScrewParams })
  | (FeatureBase & { kind: "sketch"; params: SketchParams })
  | (FeatureBase & { kind: "group"; params: Record<string, never> })
  /** A reference plane (its local XY). Sketches placed inside it are drawn on it. */
  | (FeatureBase & { kind: "plane"; params: { size: number } })
  /** A free-form mesh shaped with sculpting brushes (not part of CAD booleans). */
  | (FeatureBase & { kind: "sculpt"; params: SculptParams })
  /** An exact solid imported from a STEP, BREP or FreeCAD file. */
  | (FeatureBase & { kind: "imported"; params: ImportedParams });

export type SculptFeature = Extract<Feature, { kind: "sculpt" }>;

export type SketchFeature = Extract<Feature, { kind: "sketch" }>;

/** A font file imported into the model, so its texts build anywhere the model is opened. */
export interface ImportedFont {
  id: string;
  name: string;
  /** The font file, base64. */
  data: string;
}

export interface CadDocument {
  format: "gizmocad";
  version: 1;
  features: Feature[];
  fonts?: ImportedFont[];
}

export function emptyDocument(): CadDocument {
  return { format: "gizmocad", version: 1, features: [] };
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `f${Date.now().toString(36)}${counter}`;
}

function defaultParams(kind: ShapeKind): Feature["params"] {
  switch (kind) {
    case "box":
      return { width: 20, depth: 20, height: 20 };
    case "cylinder":
      return { radius: 10, radiusY: 10, height: 20 };
    case "sphere":
      return { radius: 10, radiusY: 10, radiusZ: 10 };
    case "cone":
      return { radius: 10, topRadius: 0, height: 20 };
    case "tube":
      return { radius: 10, wall: 2, height: 20 };
    case "torus":
      return { radius: 15, tube: 4 };
    case "wedge":
    case "pyramid":
      return { width: 20, depth: 20, height: 20 };
    case "prism":
      return { radius: 10, sides: 6, height: 20 };
    case "hedron":
      return { faces: 20, radius: 12 };
    case "thread":
      return { diameter: 10, pitch: 1.5, length: 20 };
    case "gear":
      return { teeth: 20, module: 1.5, thickness: 6, bore: 5 };
    case "spring":
      return { style: "coil", diameter: 20, wire: 2, pitch: 6, height: 30, section: "round", ends: true, depth: 8, bends: "round" };
    case "star":
      return { points: 5, radius: 15, inner: 7, height: 5 };
    case "text":
      return { text: "Text", font: "sans", bold: true, size: 10, height: 2, spacing: 0, align: "center" };
    case "screw":
      return { size: "M3", fit: "normal", head: "none", depth: 10 };
    case "sketch":
      return { plane: "XY", offset: 0, operation: "flat", depth: 10, direction: "normal", angle: 360, entities: [] };
    case "group":
      return {};
    case "plane":
      return { size: 60 };
    case "sculpt":
      return defaultSculpt();
    case "imported":
      return { ref: "", brep: "", size: [0, 0, 0], scale: [1, 1, 1] };
  }
}

/**
 * Colours new objects take in turn (the first one is the default colour). Not
 * the selection blue or the hole red, so selected objects and holes still stand out.
 */
export const AUTO_COLOURS = ["#3ddc97", "#ffb020", "#a77bff", "#f2d33c", "#ff7ac6"];

/** A colour for a new object: whichever of AUTO_COLOURS the model uses least (the earliest on a tie). */
export function nextColour(features: Feature[]): string {
  const counts = AUTO_COLOURS.map((c) => features.filter((f) => f.kind !== "group" && f.kind !== "plane" && f.mode === "solid" && (f.color ?? AUTO_COLOURS[0]).toLowerCase() === c).length);
  return AUTO_COLOURS[counts.indexOf(Math.min(...counts))];
}

export function createFeature(kind: ShapeKind, existing: Feature[], parentId: string | null = null): Feature {
  const n = existing.filter((f) => f.kind === kind).length + 1;
  const label = kind === "torus" ? "Ring" : kind === "screw" ? "Screw hole" : kind[0].toUpperCase() + kind.slice(1);
  return {
    id: newId(),
    name: `${label} ${n}`,
    kind,
    // A screw hole is for cutting; everything else starts solid.
    mode: kind === "screw" ? "hole" : "solid",
    parentId,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    edgeOps: [],
    params: defaultParams(kind),
  } as Feature;
}

/**
 * Parameter fields shown in the properties panel, per primitive kind. `factor`
 * converts the stored value for display: round shapes store a radius but show a
 * diameter, so the panel matches the overall sizes the resize ruler shows.
 */
export const PARAM_FIELDS: Partial<Record<ShapeKind, { key: string; label: string; factor?: number; count?: [number, number] }[]>> = {
  box: [
    { key: "width", label: "Width (X)" },
    { key: "depth", label: "Depth (Y)" },
    { key: "height", label: "Height (Z)" },
  ],
  cylinder: [
    { key: "radius", label: "Diameter X", factor: 2 },
    { key: "radiusY", label: "Diameter Y", factor: 2 },
    { key: "height", label: "Height" },
  ],
  sphere: [
    { key: "radius", label: "Diameter X", factor: 2 },
    { key: "radiusY", label: "Diameter Y", factor: 2 },
    { key: "radiusZ", label: "Diameter Z", factor: 2 },
  ],
  cone: [
    { key: "radius", label: "Bottom diameter", factor: 2 },
    { key: "topRadius", label: "Top diameter", factor: 2 },
    { key: "height", label: "Height" },
  ],
  tube: [
    { key: "radius", label: "Outer diameter", factor: 2 },
    { key: "wall", label: "Wall thickness" },
    { key: "height", label: "Height" },
  ],
  torus: [
    { key: "radius", label: "Outer diameter", factor: 2 },
    { key: "tube", label: "Ring thickness", factor: 2 },
  ],
  wedge: [
    { key: "width", label: "Width (X)" },
    { key: "depth", label: "Depth (Y)" },
    { key: "height", label: "Height (Z)" },
  ],
  pyramid: [
    { key: "width", label: "Width (X)" },
    { key: "depth", label: "Depth (Y)" },
    { key: "height", label: "Height (Z)" },
  ],
  prism: [
    { key: "radius", label: "Diameter (corners)", factor: 2 },
    { key: "sides", label: "Sides", count: [3, 64] },
    { key: "height", label: "Height" },
  ],
  thread: [
    { key: "diameter", label: "Diameter" },
    { key: "pitch", label: "Pitch" },
    { key: "length", label: "Length" },
  ],
  gear: [
    { key: "teeth", label: "Teeth", count: [6, 200] },
    { key: "module", label: "Module (tooth size)" },
    { key: "thickness", label: "Thickness" },
    { key: "bore", label: "Bore (hole) diameter" },
  ],
  star: [
    { key: "points", label: "Points", count: [3, 50] },
    { key: "radius", label: "Outer diameter", factor: 2 },
    { key: "inner", label: "Inner diameter", factor: 2 },
    { key: "height", label: "Height" },
  ],
  plane: [{ key: "size", label: "Display size" }],
};

// ---- Tree helpers --------------------------------------------------------

/** A group with fillets/chamfers (or a hollow, or a texture), or a hole group, is shown and picked as one merged shape. */
export function isMergedGroup(f: Feature): boolean {
  return f.kind === "group" && (!!f.combined || f.mode === "hole" || f.edgeOps.length > 0 || !!f.shell || !!f.texture);
}

/** Is `id` inside a merged group (so its own mesh isn't shown)? */
export function insideMergedGroup(features: Feature[], id: string): boolean {
  let f = features.find((x) => x.id === id);
  while (f?.parentId) {
    f = features.find((x) => x.id === f!.parentId);
    if (f && isMergedGroup(f)) return true;
  }
  return false;
}

export function childrenOf(features: Feature[], parentId: string | null): Feature[] {
  return features.filter((f) => f.parentId === parentId);
}

/** The ids of `id` and everything below it. */
export function subtreeIds(features: Feature[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of features) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}

const DEG = Math.PI / 180;

/** Where the feature sits relative to its parent before any joint motion: rotate X, then Y, then Z, then translate. */
export function baseMatrix(f: Feature): Matrix4 {
  const r = new Euler(f.rotation.x * DEG, f.rotation.y * DEG, f.rotation.z * DEG, "ZYX");
  return new Matrix4().compose(new Vector3(f.position.x, f.position.y, f.position.z), new Quaternion().setFromEuler(r), new Vector3(f.mirrored ? -1 : 1, 1, 1));
}

/** The flip of a mirrored feature (X → −X in its own frame); its own inverse. */
export function mirrorMatrix(f: Feature): Matrix4 {
  return new Matrix4().makeScale(f.mirrored ? -1 : 1, 1, 1);
}

/**
 * The motion a joint adds (in the parent's frame) at a given value. An orbit
 * only moves the object's origin (`at`, its unmoved position) around the circle.
 */
export function jointMatrix(j: Joint, value = j.value, at: Vec3 = { x: 0, y: 0, z: 0 }): Matrix4 {
  const axis = new Vector3(j.axis.x, j.axis.y, j.axis.z).normalize();
  if (j.type === "slider") return new Matrix4().makeTranslation(axis.x * value, axis.y * value, axis.z * value);
  const o = new Vector3(j.origin.x, j.origin.y, j.origin.z);
  if (j.type === "orbit") {
    const p = new Vector3(at.x, at.y, at.z);
    const moved = p.clone().sub(o).applyAxisAngle(axis, value * DEG).add(o);
    return new Matrix4().makeTranslation(moved.x - p.x, moved.y - p.y, moved.z - p.z);
  }
  return new Matrix4()
    .makeTranslation(o.x, o.y, o.z)
    .multiply(new Matrix4().makeRotationAxis(axis, value * DEG))
    .multiply(new Matrix4().makeTranslation(-o.x, -o.y, -o.z));
}

/** Keep a joint value within its limits. */
export function clampJoint(j: Joint, value: number): number {
  return Math.min(j.max ?? Infinity, Math.max(j.min ?? -Infinity, value));
}

/** The feature's transform relative to its parent, including any joint motion. */
export function localMatrix(f: Feature): Matrix4 {
  return f.joint ? jointMatrix(f.joint, f.joint.value, f.position).multiply(baseMatrix(f)) : baseMatrix(f);
}

export function worldMatrix(features: Feature[], id: string | null): Matrix4 {
  const f = id ? features.find((x) => x.id === id) : undefined;
  if (!f) return new Matrix4();
  return worldMatrix(features, f.parentId).multiply(localMatrix(f));
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0; // + 0 turns -0 into 0

/**
 * Move `id` under `newParentId` (null for top level) without it moving in the
 * world. Refuses to create a cycle. Returns false if nothing changed.
 */
export function reparent(features: Feature[], id: string, newParentId: string | null): boolean {
  const f = features.find((x) => x.id === id);
  if (!f || f.parentId === newParentId) return false;
  if (newParentId && subtreeIds(features, id).has(newParentId)) return false;

  const local = worldMatrix(features, newParentId).invert().multiply(worldMatrix(features, id));
  f.mirrored = local.determinant() < 0 || undefined;
  if (!f.mirrored) delete f.mirrored;
  setPlacement(f, local);
  f.parentId = newParentId;
  delete f.joint; // A joint belongs to the old parent; the object stays where it is now.
  return true;
}

function setPlacement(f: Feature, local: Matrix4) {
  const pos = new Vector3();
  const quat = new Quaternion();
  // The mirror stays a flag; only the turn and position are stored.
  local.clone().multiply(mirrorMatrix(f)).decompose(pos, quat, new Vector3());
  const rot = new Euler().setFromQuaternion(quat, "ZYX");
  f.position = { x: round6(pos.x), y: round6(pos.y), z: round6(pos.z) };
  f.rotation = { x: round6(rot.x / DEG), y: round6(rot.y / DEG), z: round6(rot.z / DEG) };
}

/**
 * Connect `id` to `parentId` (null: the ground) with a hinge or slider whose
 * pivot and axis are given in world terms: a point, and a rotation (degrees)
 * whose Z direction is the axis. The object stays where it is.
 */
export function addJoint(features: Feature[], id: string, parentId: string | null, type: Joint["type"], point: Vec3, rotation: Vec3) {
  const f = features.find((x) => x.id === id);
  if (!f) return;
  if (f.joint) removeJoint(features, id);
  if (f.parentId !== parentId) reparent(features, id, parentId);
  const toParent = worldMatrix(features, parentId).invert();
  const o = new Vector3(point.x, point.y, point.z).applyMatrix4(toParent);
  const r = new Euler(rotation.x * DEG, rotation.y * DEG, rotation.z * DEG, "ZYX");
  const axis = new Vector3(0, 0, 1).applyEuler(r).transformDirection(toParent);
  f.joint = {
    type,
    origin: { x: round6(o.x), y: round6(o.y), z: round6(o.z) },
    axis: { x: round6(axis.x), y: round6(axis.y), z: round6(axis.z) },
    value: 0,
  };
}

/**
 * Move/rotate an object to a new placement relative to its parent (as the
 * gizmo shows it, joint motion included). A connected object carries its
 * hinge/slider along: the pivot and axis move with it and the joint value stays.
 */
export function placeFeature(features: Feature[], id: string, position: Vec3, rotation: Vec3) {
  const f = features.find((x) => x.id === id);
  if (!f) return;
  const j = f.joint;
  if (!j) {
    f.position = position;
    f.rotation = rotation;
    return;
  }
  const r = new Euler(rotation.x * DEG, rotation.y * DEG, rotation.z * DEG, "ZYX");
  const target = new Matrix4().compose(new Vector3(position.x, position.y, position.z), new Quaternion().setFromEuler(r), new Vector3(f.mirrored ? -1 : 1, 1, 1));
  // The change, in the parent's frame, applied to the joint too.
  const delta = target.clone().multiply(localMatrix(f).invert());
  const o = new Vector3(j.origin.x, j.origin.y, j.origin.z).applyMatrix4(delta);
  const a = new Vector3(j.axis.x, j.axis.y, j.axis.z).transformDirection(delta);
  j.origin = { x: round6(o.x), y: round6(o.y), z: round6(o.z) };
  j.axis = { x: round6(a.x), y: round6(a.y), z: round6(a.z) };
  rebase(f, target);
}

/** Set where a connected object's at-zero placement is, so that with its joint it ends up at `target`. */
function rebase(f: Feature, target: Matrix4) {
  const j = f.joint!;
  if (j.type === "orbit") {
    // An orbit only moves the origin round the circle: undo that turn to find where it sits at 0.
    const o = new Vector3(j.origin.x, j.origin.y, j.origin.z);
    const a = new Vector3(j.axis.x, j.axis.y, j.axis.z).normalize();
    const p = new Vector3().setFromMatrixPosition(target).sub(o).applyAxisAngle(a, -j.value * DEG).add(o);
    return setPlacement(f, target.clone().setPosition(p));
  }
  setPlacement(f, jointMatrix(j).invert().multiply(target));
}

/**
 * Move a connection (its pivot and/or axis, in the parent's frame) without
 * moving the object: it stays exactly where it is now, at the same joint value.
 */
export function moveJointFrame(f: Feature, origin: Vec3, axis: Vec3 = f.joint?.axis ?? { x: 0, y: 0, z: 1 }) {
  const j = f.joint;
  if (!j) return;
  const now = localMatrix(f);
  const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
  j.origin = { x: round6(origin.x), y: round6(origin.y), z: round6(origin.z) };
  j.axis = { x: round6(axis.x / len), y: round6(axis.y / len), z: round6(axis.z / len) };
  rebase(f, now);
}

/** Take the joint off, leaving the object where the joint had moved it. */
export function removeJoint(features: Feature[], id: string) {
  const f = features.find((x) => x.id === id);
  if (!f?.joint) return;
  setPlacement(f, localMatrix(f));
  delete f.joint;
}

/** Place `id` at a world position/rotation (degrees), whatever its parent is. */
export function setWorldPlacement(features: Feature[], id: string, position: Vec3, rotation: Vec3) {
  const f = features.find((x) => x.id === id);
  if (!f) return;
  delete f.joint;
  // A mirrored object stays mirrored where it lands.
  const flipped = worldMatrix(features, id).determinant() < 0;
  const r = new Euler(rotation.x * DEG, rotation.y * DEG, rotation.z * DEG, "ZYX");
  const world = new Matrix4().compose(new Vector3(position.x, position.y, position.z), new Quaternion().setFromEuler(r), new Vector3(flipped ? -1 : 1, 1, 1));
  setWorldMatrix(features, id, world);
}

/** Move an object by a distance given in world terms (whatever its parent's turn). */
export function translateWorld(features: Feature[], id: string, delta: Vec3) {
  const f = features.find((x) => x.id === id);
  if (!f) return;
  // Frames only turn (and maybe mirror), so the rotation part converts a distance exactly.
  const toParent = new Matrix3().setFromMatrix4(worldMatrix(features, f.parentId).invert());
  const d = new Vector3(delta.x, delta.y, delta.z).applyMatrix3(toParent);
  f.position = { x: round6(f.position.x + d.x), y: round6(f.position.y + d.y), z: round6(f.position.z + d.z) };
  if (f.joint) f.joint.origin = { x: round6(f.joint.origin.x + d.x), y: round6(f.joint.origin.y + d.y), z: round6(f.joint.origin.z + d.z) };
}

/**
 * Set an object's whole world transform (it and everything inside it follow).
 * `world` may be mirrored; a connected object keeps its connection, carried along.
 */
export function setWorldMatrix(features: Feature[], id: string, world: Matrix4) {
  const f = features.find((x) => x.id === id);
  if (!f) return;
  const local = worldMatrix(features, f.parentId).invert().multiply(world);
  // The change, worked out before the mirror flag (part of the current placement) changes.
  const delta = local.clone().multiply(localMatrix(f).invert());
  f.mirrored = local.determinant() < 0 || undefined;
  if (!f.mirrored) delete f.mirrored;
  if (f.joint) {
    const o = new Vector3(f.joint.origin.x, f.joint.origin.y, f.joint.origin.z).applyMatrix4(delta);
    const a = new Vector3(f.joint.axis.x, f.joint.axis.y, f.joint.axis.z).transformDirection(delta);
    f.joint.origin = { x: round6(o.x), y: round6(o.y), z: round6(o.z) };
    f.joint.axis = { x: round6(a.x), y: round6(a.y), z: round6(a.z) };
    rebase(f, local);
    return;
  }
  setPlacement(f, local);
}

/**
 * Mirror an object (and everything in it) across a world plane through `center`
 * square to `axis`. Each part flips its own geometry and gets the placement that
 * puts the flipped copy where the mirror image is.
 */
export function mirrorFeature(features: Feature[], id: string, axis: "x" | "y" | "z", center: Vec3) {
  const f = features.find((x) => x.id === id);
  if (!f) return;
  const s = new Vector3(axis === "x" ? -1 : 1, axis === "y" ? -1 : 1, axis === "z" ? -1 : 1);
  const reflect = new Matrix4()
    .makeTranslation(center.x, center.y, center.z)
    .multiply(new Matrix4().makeScale(s.x, s.y, s.z))
    .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z));
  // Its own connection can't be mirrored onto the same parent, so it comes off; the object stays put first.
  if (f.joint) removeJoint(features, id);
  // Everything inside sits in its frame, so it follows (mirrored) by itself.
  setWorldMatrix(features, id, reflect.multiply(worldMatrix(features, id)));
}

// ---- Files ---------------------------------------------------------------

export function isCadDocument(value: unknown): value is CadDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    // "mintcad" is the app's earlier name; those files load the same.
    ["gizmocad", "mintcad"].includes((value as CadDocument).format) &&
    Array.isArray((value as CadDocument).features)
  );
}

/** Fill in fields that older files don't have. */
export function normalizeDocument(doc: CadDocument): CadDocument {
  doc.format = "gizmocad";
  for (const f of doc.features) {
    const legacy = f as Feature & { rotationZ?: number };
    f.parentId ??= null;
    if (f.parentId && !doc.features.some((p) => p.id === f.parentId)) f.parentId = null;
    f.rotation ??= { x: 0, y: 0, z: legacy.rotationZ ?? 0 };
    f.edgeOps ??= [];
    if (f.kind === "cylinder") f.params.radiusY ??= f.params.radius;
    if (f.kind === "imported" && typeof f.params.scale === "number") {
      const k = f.params.scale as number; // Saved before sizes could differ per axis.
      f.params.scale = [k, k, k];
    }
    if (f.kind === "spring") {
      // Springs from before the style options: round-wire coils with open ends.
      f.params.style ??= "coil";
      f.params.section ??= "round";
      f.params.ends ??= false;
      f.params.depth ??= 8;
      f.params.bends ??= "round";
    }
    if (f.kind === "sphere") {
      f.params.radiusY ??= f.params.radius;
      f.params.radiusZ ??= f.params.radius;
    }
    delete legacy.rotationZ;
    if (f.kind === "sketch") {
      const p = f.params;
      p.offset ??= 0;
      p.direction ??= "normal";
      for (const e of p.entities) {
        if (e.type === "rect") {
          e.angle ??= 0;
          e.radius ??= 0;
        }
        if (e.type === "polygon") e.bends ??= e.points.map(() => 0);
      }
    }
  }
  return doc;
}

/** Whether a hole leaves this object alone: it, or an object it's inside, is set to ignore that hole. */
export function ignoresHole(features: Feature[], f: Feature, holeId: string): boolean {
  for (let n: Feature | undefined = f; n; n = features.find((x) => x.id === n!.parentId)) if (n.ignoreHoles?.includes(holeId)) return true;
  return false;
}

/**
 * An object's colour. A group with none of its own takes its parts' colour
 * when they all share one (it's shown, and exported, as one shape).
 */
export function colourOf(features: Iterable<Feature>, f: Feature): string | undefined {
  if (f.color || f.kind !== "group") return f.color;
  const all = [...features];
  const inside = (x: Feature) => {
    for (let p = x.parentId; p; p = all.find((y) => y.id === p)?.parentId ?? null) if (p === f.id) return true;
    return false;
  };
  const parts = all.filter((x) => x.kind !== "group" && x.mode === "solid" && inside(x));
  const colours = new Set(parts.map((x) => x.color));
  if (colours.size === 1) return [...colours][0];
  // A combined shape is one solid in one colour: its first part's.
  return isMergedGroup(f) ? parts[0]?.color : undefined;
}

/** A hole's sweep (null for solids); a hole group's sweeps its joined shape. */
export const sweepOf = (f: Feature) => (f.mode === "hole" && f.kind !== "plane" && f.sweep && !f.sweep.off ? f.sweep : null);

/** How much a hole is grown on every side (0 for solids); a hole group's grows its joined shape. */
export const clearanceOf = (f: Feature) => (f.mode === "hole" && f.kind !== "plane" ? Math.max(0, f.clearance ?? 0) : 0);

/** Whether anything in the model ignores a hole (when nothing does, holes are cut the quicker usual way). */
export const anyIgnoredHoles = (features: Feature[]) => features.some((f) => f.ignoreHoles?.length);
