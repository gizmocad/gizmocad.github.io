// The 3D view: Z-up scene, workplane grid, orbit camera, picking and a move gizmo.
// Features are mirrored as a THREE hierarchy, so moving a parent moves its children.
// In sketch mode the camera looks straight at the sketch plane and pointer
// events are reported in sketch coordinates instead of picking objects.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { MeshData } from "./kernel";
import { scenePalette } from "./theme";
import { PLANE_ROTATIONS, baseMatrix, clampJoint, jointMatrix, localMatrix, worldMatrix, type Feature, type Joint, type SketchParams, type Vec3 } from "./model";
import { featureExtents, isTilted, rulerLength, staysRound, type ResizeAnchor } from "./resize";
import { isClosed, outline, prismPoints } from "./sketchGeometry";
import { hedron } from "./hedron";
import { SculptMesh, creasedGeometry, isCadMesh, sculptGeometry, type BrushSettings } from "./sculpt";
import { ViewCube } from "./viewCube";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

/** Width of the floor grid, in mm. */
const FLOOR_SIZE = 500;

const COLORS = {
  solid: 0x3ddc97,
  selected: 0x4aa3ff,
  hole: 0xff6b6b,
  plane: 0x5b8def,
};

export interface ViewportEvents {
  /** A click picked an object (or empty space: null). `additive`: Shift/Ctrl-click, toggling it in the selection. */
  onSelect(id: string | null, additive?: boolean): void;
  /** Shift-drag drew a box: the objects inside it. */
  onBoxSelect(ids: string[]): void;
  /** Measure tool: a new reading (or null when cleared). */
  onMeasure(text: string | null): void;
  /** Called once when a gizmo drag finishes, with the snapped placement relative to the parent. */
  onTransformed(id: string, position: Vec3, rotation: Vec3): void;
  /** Double-click on an object. */
  onOpen(id: string): void;
  /** While resizing with the gizmo: scale factors along the object's own axes. */
  onResizing(id: string, scale: Vec3): void;
  /** A resize drag finished. */
  onResized(id: string, scale: Vec3, anchor?: ResizeAnchor): void;
  /** While turning/sliding a connected object by its joint: the joint's value (degrees or mm). */
  onJointMoving(id: string, value: number): void;
  /** A joint drag finished. */
  onJointMoved(id: string, value: number): void;
  /** A connection's pivot was dragged to a new place (in the parent's frame). */
  onPivotMoved(id: string, origin: Vec3): void;
  /** Placing a shape (or picking a point) started or ended. */
  onPlacementChange(): void;
}

export interface SketchPointer {
  kind: "down" | "move" | "up" | "dblclick" | "context";
  /** Sketch coordinates under the pointer (not snapped). */
  u: number;
  v: number;
  /** Size of one screen pixel in sketch units, for pick tolerances. */
  pixel: number;
  shift: boolean;
  /** Alt held: place freely, without point or grid snapping. */
  alt: boolean;
  clientX: number;
  clientY: number;
}

export type SketchPointerHandler = (e: SketchPointer) => void;

/** Sketch coordinates → the sketch feature's local frame. */
export function planeMatrix(p: Pick<SketchParams, "plane" | "offset">): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeTranslation(0, 0, p.offset ?? 0);
  for (const r of PLANE_ROTATIONS[p.plane]) {
    const rot = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...r.axis), THREE.MathUtils.degToRad(r.degrees));
    m.premultiply(rot);
  }
  return m;
}

/** "joint" turns/slides a connected object by its connection (other objects just move). */
export type GizmoMode = "translate" | "rotate" | "scale" | "joint" | "pivot";

type Vec3Tuple = [number, number, number];

/** Sculpting one sculpt object with brushes. */
export interface SculptSession {
  id: string;
  settings(): BrushSettings;
  /** A stroke finished; store the new vertex positions. */
  onCommit(positions: string): void;
}

/** See-through previews on an object: boxes (e.g. dividers to add) and cut planes. */
export interface PreviewSpec {
  id: string;
  style: "cut" | "add";
  boxes: [Vec3, Vec3][];
  /** Planes where normal · point = at, in the object's frame. */
  planes?: { normal: Vec3; at: number; active?: boolean }[];
  /** See-through copies of the object, placed by these matrices (elements) in its own frame: a Repeat preview. */
  copies?: number[][];
}

/** An arrow that drags a planned cut along its normal (in the object's frame). */
export interface CutHandle {
  id: string;
  normal: Vec3;
  at: number;
  onMove(at: number): void;
  onDone(at: number): void;
}

/** Placing a new shape: a see-through preview follows the pointer until a click puts it down. */
export interface PlacementSession {
  feature: Feature;
  /** Picking a point instead of placing a shape: show an arrow along the face's outward direction. */
  marker?: boolean;
  /** With `marker`: the object itself can be clicked too. */
  allowSelf?: boolean;
  /** Only pick an object (no preview); the object itself and what's inside it can't be picked. */
  pickOnly?: boolean;
  /** Only objects count: pointing at the empty build plate does nothing. */
  noGround?: boolean;
  /** Moving an existing object instead of adding one: preview it, and don't snap onto itself. */
  existing?: boolean;
  /** The point (in the shape's own frame) that touches the face. Default: its origin. */
  anchor?: Vec3;
  /** Turn about the face normal, in degrees. */
  spin?: number;
  /** World placement: position, and rotation in degrees (X, then Y, then Z). */
  onPlace(position: Vec3, rotation: Vec3, targetId: string | null): void;
  onCancel(): void;
}

/** Picking edges of one object for a fillet/chamfer. */
export interface EdgePickSession {
  id: string;
  /** Points on the currently picked edges (feature-local). */
  points: Vec3Tuple[];
  onPick(point: Vec3Tuple): void;
}

/** A point exactly on the edge: the middle vertex of its polyline (or the midpoint of a single segment). */
function edgePoint(pos: ArrayLike<number>, start: number, count: number): Vec3Tuple {
  const v = (i: number): Vec3Tuple => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  const segments = count / 2;
  if (segments <= 1) {
    const [a, b] = [v(start), v(start + 1)];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  }
  return v(start + 2 * Math.floor(segments / 2));
}

const samePoint = (a: Vec3Tuple, b: Vec3Tuple) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-3;

interface SketchSession {
  id: string;
  /** Plane + offset the camera was last aimed at. */
  planeKey: string;
  handler: SketchPointerHandler;
  saved: { position: THREE.Vector3; up: THREE.Vector3; target: THREE.Vector3 };
}

export class Viewport {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private perspCamera: THREE.PerspectiveCamera;
  private orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private root = new THREE.Group();
  private nodes = new Map<string, THREE.Object3D>();
  private grids = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private features = new Map<string, Feature>();
  /** The main selected object (it carries the gizmo); `selectedIds` holds every selected one. */
  private selectedId: string | null = null;
  private selectedIds = new Set<string>();
  /** While dragging the gizmo with several objects selected: where each of the others started (world). */
  private groupDrag: { start: THREE.Matrix4; others: { node: THREE.Object3D; world: THREE.Matrix4 }[] } | null = null;
  /** Measure tool: picked points (world) with the face normal there, the drawing, and its label. */
  private measure: { points: { p: THREE.Vector3; n: THREE.Vector3 | null }[]; group: THREE.Group; label: HTMLDivElement } | null = null;
  /** Section view: a plane cutting everything, showing the inside. */
  private section: { plane: THREE.Plane; axis: "x" | "y" | "z"; at: number; flip: boolean } | null = null;
  private sectionGroup = new THREE.Group();
  /** The print bed outline. */
  private bedGroup = new THREE.Group();
  /** Camera flying to fit objects in view. */
  private viewFly: { from: THREE.Vector3; to: THREE.Vector3; fromDist: number; toDist: number; fromZoom: number; toZoom: number; start: number } | null = null;
  private boxSelect: { x: number; y: number; el: HTMLDivElement } | null = null;
  private combined = false;
  private snap = 1;
  private sketch: SketchSession | null = null;
  private edgePick: EdgePickSession | null = null;
  private sculpt: {
    session: SculptSession;
    mesh: THREE.Mesh | null;
    tool: SculptMesh | null;
    stroke: { lastDab: THREE.Vector3; grabPlane?: THREE.Plane; grabStart?: THREE.Vector3 } | null;
  } | null = null;
  private brushRing: THREE.LineLoop;
  /** Resize: scale every axis together. Holding Shift during a drag flips this. */
  keepRatio = false;
  /** Move and Rotate along the object's own (turned) axes instead of the world's. */
  private localAxes = false;
  /** Resize: only the side whose handle is dragged moves; the opposite face stays put. */
  oneSide = false;
  /** Set when a one-sided resize drag starts: the fixed face, and where the object started. */
  private resizeAnchor: { axis: "x" | "y" | "z"; at: number; start: THREE.Vector3 } | null = null;
  private shiftHeld = false;
  /** Dimension lines shown on the selected object while resizing, and their labels. */
  private ruler = new THREE.Group();
  private rulerSpan: { node: THREE.Object3D; mids: THREE.Vector3[]; lengths: number[] } | null = null;
  // Filled in the constructor; empty until then because the theme setup redraws early.
  private rulerLabels: HTMLDivElement[] = [];
  /** Move mode: show snap points on objects and snap dragged objects' points onto them. */
  pointSnap = true;
  /** Draw the snap points (snapping still works with them hidden). */
  showPoints = true;
  private snapDots: THREE.Points[] = [];
  /** While moving: the dragged object's points (own frame) and every other object's (world). */
  private pointDrag: { local: THREE.Vector3[]; targets: THREE.Vector3[]; snapped: boolean } | null = null;
  /** Preview boxes on an object (in its own frame): a split's cut, or dividers about to be added. */
  private preview: PreviewSpec | null = null;
  private previewGroup = new THREE.Group();
  private placement: {
    session: PlacementSession;
    ghost: THREE.Group;
    /** Objects the pointer can't land on (the one being moved, and what's inside it). */
    skip: Set<string>;
    /** Point into the face instead of out of it (e.g. an axle pointing down through an object). */
    flipped: boolean;
    pointer: [number, number] | null;
    at: { position: THREE.Vector3; quaternion: THREE.Quaternion; id: string | null } | null;
    /** Snap points on the face under the pointer, and which face they were drawn for. */
    dots: THREE.Points | null;
    dotsKey: string;
  } | null = null;
  /** The mode picked in the toolbar; a connected object's gizmo may differ (its joint decides). */
  private userMode: GizmoMode = "translate";
  /** A split's cut plane, dragged with a one-arrow gizmo while the split tool is open. */
  private cutHandle: CutHandle | null = null;
  private cutProxy = new THREE.Object3D();
  /** Stand-in the gizmo drags for a connected object: it sits on the joint, turning or sliding along its axis. */
  private jointProxy = new THREE.Object3D();
  /** Stand-in for a connection's pivot in Pivot mode: moving it moves the connection, not the object. */
  private pivotProxy = new THREE.Object3D();
  private pivotFor: string | null = null;
  private jointDrag: { id: string; node: THREE.Object3D; joint: Joint; base: THREE.Matrix4; align: THREE.Quaternion; value: number } | null = null;
  /** The matched pair while snapping: a ring on the target and a guide line. */
  private snapHint = new THREE.Group();
  private edgeOverlay = new THREE.Group();
  private hoverEdge = -1;
  /** Children are drawn in sketch coordinates (U, V, 0) of the sketch being edited. */
  readonly sketchLayer = new THREE.Group();
  private sketchGrid: THREE.Group;
  private viewCube: ViewCube;
  private sketchWasOrtho = false;
  /** The camera swinging round to a view picked on the view cube. */
  private viewTurn: { from: THREE.Vector3; turn: THREE.Quaternion; distance: number; start: number } | null = null;

  constructor(private container: HTMLElement, private events: ViewportEvents) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color();
    this.perspCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    this.camera = this.perspCamera;
    this.camera.position.set(70, -90, 70);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(100, -60, 200);
    this.scene.add(sun);

    this.scene.add(this.grids, this.root, this.sectionGroup, this.bedGroup);

    this.sketchLayer.matrixAutoUpdate = false;
    this.sketchLayer.visible = false;
    this.sketchGrid = new THREE.Group();
    this.sketchLayer.add(this.sketchGrid);
    this.scene.add(this.sketchLayer);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.viewCube = new ViewCube(container, (dir) => this.lookFrom(dir));

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setTranslationSnap(this.snap);
    this.gizmo.setRotationSnap(THREE.MathUtils.degToRad(15));
    this.gizmo.addEventListener("objectChange", () => {
      const obj = this.gizmo.object;
      if (obj && obj === this.jointProxy) return this.followJoint();
      if (obj && obj === this.cutProxy) return this.followCut();
      if (obj && obj === this.pivotProxy) this.snapToPoints(obj);
      if (obj && this.gizmo.mode === "translate") this.snapToPoints(obj);
      if (obj && this.gizmo.mode !== "scale") this.followGroupDrag(obj);
      if (obj && this.gizmo.mode === "scale") {
        // A mirrored object's node has X scale −1; work with the size change only.
        const flip = this.features.get(obj.userData.id)?.mirrored ? -1 : 1;
        obj.scale.x *= flip;
        // The raw gizmo ratio is very twitchy (handles sit close to the centre), so soften it.
        // It's recomputed from the drag start on every move, so this doesn't compound.
        obj.scale.set(Math.pow(Math.abs(obj.scale.x), 0.5), Math.pow(Math.abs(obj.scale.y), 0.5), Math.pow(Math.abs(obj.scale.z), 0.5));
        if (this.keepRatio !== this.shiftHeld) {
          // Keep proportions: every axis follows whichever one is being dragged.
          const k = [obj.scale.x, obj.scale.y, obj.scale.z].reduce((a, b) => (Math.abs(Math.log(b)) > Math.abs(Math.log(a)) ? b : a), 1);
          obj.scale.setScalar(k);
        }
        const shape = this.features.get(obj.userData.id);
        if (shape?.kind === "hedron") {
          // A hedron only grows or shrinks as a whole.
          obj.scale.setScalar([obj.scale.x, obj.scale.y, obj.scale.z].reduce((a, b) => (Math.abs(Math.log(b)) > Math.abs(Math.log(a)) ? b : a), 1));
        } else if (shape && staysRound(shape)) {
          // Cones, tubes, rings and prisms stay round: X and Y follow whichever is being dragged.
          const r = Math.abs(Math.log(obj.scale.x)) >= Math.abs(Math.log(obj.scale.y)) ? obj.scale.x : obj.scale.y;
          obj.scale.x = obj.scale.y = r;
        }
        const anchor = this.resizeAnchor;
        if (anchor) {
          // Scaling happens about the origin; slide the object so the fixed face doesn't move.
          const local = new THREE.Vector3();
          local[anchor.axis] = anchor.at * (1 - obj.scale[anchor.axis]);
          local.x *= flip; // Its own X points the other way when mirrored.
          obj.position.copy(anchor.start).add(local.applyQuaternion(obj.quaternion));
        }
        this.events.onResizing(obj.userData.id, { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z });
        obj.scale.x *= flip;
      }
    });
    this.gizmo.addEventListener("mouseDown", () => {
      this.startResizeAnchor();
      this.startPointDrag();
      this.startGroupDrag();
    });
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.orbit.enabled = !e.value;
      if (!e.value) {
        this.commitDrag();
        this.groupDrag = null;
        this.pointDrag = null;
        this.showSnapHint(null);
      }
    });
    this.scene.add(this.gizmo.getHelper());
    this.applyTheme();

    const ringPts = Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2), 0));
    this.brushRing = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: 0xff8a00, depthTest: false, transparent: true }));
    this.brushRing.renderOrder = 30;
    this.brushRing.visible = false;
    this.scene.add(this.brushRing);

    this.snapHint.renderOrder = 46;
    this.scene.add(this.snapHint);

    this.ruler.renderOrder = 40;
    this.rulerLabels = (["x", "y", "z"] as const).map((axis) => {
      const el = document.createElement("div");
      el.className = `ruler-label ruler-${axis}`;
      el.hidden = true;
      container.appendChild(el);
      return el;
    });
    window.addEventListener("keydown", (e) => e.key === "Shift" && (this.shiftHeld = true));
    window.addEventListener("keyup", (e) => e.key === "Shift" && (this.shiftHeld = false));
    window.addEventListener("blur", () => (this.shiftHeld = false));

    this.setupPointer();
    this.setupSculptPointer();
    this.setupBoxSelect();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      if (!this.sketch) {
        this.stepViewTurn();
        this.stepViewFly();
        this.orbit.update();
      }
      this.updateMeasureLabel();
      this.updateRulerLabels();
      this.renderer.render(this.scene, this.camera);
      this.viewCube.render(this.camera, this.orbit.target);
    });
  }

  /** Re-colour the scene for the current light/dark theme. */
  applyTheme() {
    const pal = scenePalette();
    (this.scene.background as THREE.Color).setHex(pal.background);
    for (const g of [this.grids, this.sketchGrid]) {
      disposeTree(g);
      g.clear();
    }
    // Everything on the floor is drawn in a fixed order without depth writes, instead of at nearly the
    // same height: lines that close together flicker as the depth buffer can't tell which is in front.
    // 500 mm across: 10 mm squares, with 1 mm lines between.
    const fine = floorLayer(makeGrid(FLOOR_SIZE, FLOOR_SIZE, pal.gridFine, pal.gridFine, 0), -4);
    const major = floorLayer(makeGrid(FLOOR_SIZE, FLOOR_SIZE / 10, pal.gridMajor, pal.gridMinor, 0), -3);
    this.grids.add(fine, major, floorLayer(new THREE.AxesHelper(30), -1));
    this.sketchGrid.add(makeGrid(400, 40, pal.gridMajor, pal.gridMinor, -0.02, true), makeGrid(400, 400, pal.gridFine, pal.gridFine, -0.03, true));
    this.root.traverse((o) => {
      if (o instanceof THREE.LineSegments && (o.userData.groups || o.userData.meshEdges)) (o.material as THREE.LineBasicMaterial).color.setHex(pal.edge);
    });
    this.viewCube.setColors(pal.viewCube);
    this.applyAppearance();
  }

  /** Swing the camera round its target to look from `dir` (from the view cube), keeping the distance. */
  lookFrom(dir: THREE.Vector3) {
    if (this.sketch || !dir.lengthSq()) return;
    const offset = this.camera.position.clone().sub(this.orbit.target);
    const distance = offset.length();
    const to = dir.clone().normalize();
    // Straight down/up: lean a hair so the camera's Z-up still gives +Y up on screen.
    if (!to.x && !to.y) to.set(0, to.z > 0 ? -1e-4 : 1e-4, to.z).normalize();
    const from = offset.normalize();
    this.viewTurn = { from, turn: new THREE.Quaternion().setFromUnitVectors(from, to), distance, start: performance.now() };
  }

  private stepViewTurn() {
    const v = this.viewTurn;
    if (!v) return;
    const t = Math.min(1, (performance.now() - v.start) / 350);
    const ease = t * t * (3 - 2 * t);
    const q = new THREE.Quaternion().slerp(v.turn, ease);
    this.camera.position.copy(this.orbit.target).addScaledVector(v.from.clone().applyQuaternion(q), v.distance);
    this.camera.lookAt(this.orbit.target);
    if (t >= 1) this.viewTurn = null;
  }

  setLocalAxes(on: boolean) {
    this.localAxes = on;
    // Only the object gizmo follows this; connection and cut handles set their own space.
    if (this.gizmo.object && this.gizmo.object === this.nodes.get(this.selectedId ?? "")) this.gizmo.space = on ? "local" : "world";
  }

  get snapSize() {
    return this.snap;
  }

  setSnap(mm: number) {
    this.snap = mm;
    this.gizmo.setTranslationSnap(mm > 0 ? mm : null);
    this.gizmo.setRotationSnap(mm > 0 ? THREE.MathUtils.degToRad(15) : null);
  }

  /** Rebuild the displayed hierarchy. `combined` shows the boolean result as one read-only shape. */
  setScene(meshes: MeshData[], features: Feature[], combined: boolean) {
    this.gizmo.detach();
    disposeTree(this.root);
    this.root.clear();
    this.nodes.clear();
    this.features = new Map(features.map((f) => [f.id, f]));
    this.combined = combined;

    if (combined) {
      for (const data of meshes) this.root.add(buildMesh(data, false));
      // Sculpts aren't part of the kernel result; show them in place.
      for (const f of features) {
        if (f.kind !== "sculpt") continue;
        const mesh = buildSculptMesh(f);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(worldMatrix(features, f.id));
        delete mesh.userData.id;
        this.root.add(mesh);
      }
    } else {
      for (const f of features) {
        const node = new THREE.Group();
        node.position.set(f.position.x, f.position.y, f.position.z);
        const d = THREE.MathUtils.degToRad;
        node.rotation.set(d(f.rotation.x), d(f.rotation.y), d(f.rotation.z), "ZYX"); // X first, then Y, then Z.
        if (f.joint) localMatrix(f).decompose(node.position, node.quaternion, new THREE.Vector3()); // Where its joint has moved it.
        if (f.mirrored) node.scale.x = -1; // Flipped across its own YZ plane (three.js flips the faces to match).
        node.userData.id = f.id;
        node.visible = !f.hidden; // Hiding a node hides everything inside it too.
        if (f.kind === "group") node.add(new THREE.AxesHelper(8));
        if (f.kind === "plane") node.add(buildPlane(f.id, f.params.size));
        if (f.kind === "sculpt") node.add(buildSculptMesh(f, this.sculpt?.session.id !== f.id));
        if (f.kind === "sketch" && f.params.operation === "flat") {
          const parts = buildFlatSketch(f);
          if (parts.length) node.add(...parts);
        }
        this.nodes.set(f.id, node);
      }
      for (const f of features) {
        const parent = (f.parentId && this.nodes.get(f.parentId)) || this.root;
        parent.add(this.nodes.get(f.id)!);
      }
      for (const data of meshes) {
        const f = this.features.get(data.id);
        const node = this.nodes.get(data.id);
        if (!f || !node) continue;
        const mesh = buildMesh(data, f.mode === "hole");
        mesh.userData.id = f.id;
        node.add(mesh);
      }
    }
    this.root.updateMatrixWorld(true);
    if (this.sketch) this.updateSketchFrame(false);
    if (this.sculpt) this.bindSculptMesh();
    this.applyAppearance();
    this.drawEdgeOverlay();
    this.drawPreview();
  }

  /** A see-through box where a just-added shape goes, until the next build replaces the scene. */
  showPending(f: Feature, parentWorld: THREE.Matrix4) {
    const ext = featureExtents(f);
    if (!ext) return;
    const [a, b] = ext;
    const box = new THREE.Mesh(new THREE.BoxGeometry(b.x - a.x, b.y - a.y, b.z - a.z), ghostMaterial());
    box.geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    box.matrixAutoUpdate = false;
    box.matrix.copy(parentWorld).multiply(localMatrix(f));
    this.root.add(box); // The next setScene clears the root, taking this with it.
  }

  /** An object's extents in its own frame (exact for primitives, else from its mesh). */
  objectExtents(id: string): [Vec3, Vec3] | null {
    const node = this.nodes.get(id);
    const box = node ? this.localBox(id, node) : null;
    if (!box) return null;
    const v = (p: THREE.Vector3) => ({ x: p.x, y: p.y, z: p.z });
    return [v(box.min), v(box.max)];
  }

  /** Show (or clear, with null) see-through boxes on an object: a planned cut or new parts. */
  setPreview(preview: PreviewSpec | null) {
    this.preview = preview;
    this.drawPreview();
  }

  private drawPreview() {
    disposeTree(this.previewGroup);
    this.previewGroup.clear();
    this.previewGroup.removeFromParent();
    const p = this.preview;
    const node = p && this.nodes.get(p.id);
    if (!p || !node) return;
    const color = p.style === "cut" ? COLORS.hole : COLORS.selected;
    for (const [a, b] of p.boxes) {
      const size = new THREE.Vector3(Math.max(b.x - a.x, 0.05), Math.max(b.y - a.y, 0.05), Math.max(b.z - a.z, 0.05));
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size.x, size.y, size.z),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: p.style === "cut" ? 0.35 : 0.45, depthWrite: false, side: THREE.DoubleSide }),
      );
      mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      mesh.renderOrder = 20;
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color })));
      this.previewGroup.add(mesh);
    }
    // Copies (Repeat): the object's own meshes, see-through, at each place.
    if (p.copies?.length) {
      node.updateMatrixWorld(true);
      const toNode = node.matrixWorld.clone().invert();
      const parts: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
      node.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData.id && isShown(o)) parts.push({ geometry: o.geometry, matrix: toNode.clone().multiply(o.matrixWorld) });
      });
      for (const elements of p.copies) {
        const at = new THREE.Matrix4().fromArray(elements);
        for (const part of parts) {
          const ghost = new THREE.Mesh(part.geometry, ghostMaterial());
          ghost.matrixAutoUpdate = false;
          ghost.matrix.copy(at).multiply(part.matrix);
          ghost.userData.shared = true;
          ghost.renderOrder = 20;
          this.previewGroup.add(ghost);
        }
      }
    }
    // Cut planes, square or tilted: a sheet through the object (the one being dragged is brighter).
    const box = p.planes?.length ? this.localBox(p.id, node) : null;
    if (box) {
      const mid = box.getCenter(new THREE.Vector3());
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
      for (const pl of p.planes!) {
        const n = new THREE.Vector3(pl.normal.x, pl.normal.y, pl.normal.z).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        // Just big enough to cover the object: its corners measured across the sheet, plus a margin.
        const u = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        const v = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const span = (dir: THREE.Vector3) => {
          const d = corners.map((c) => c.clone().sub(mid).dot(dir));
          return [Math.min(...d) - 3, Math.max(...d) + 3];
        };
        const [[u0, u1], [v0, v1]] = [span(u), span(v)];
        const sheet = new THREE.Mesh(
          new THREE.PlaneGeometry(u1 - u0, v1 - v0).translate((u0 + u1) / 2, (v0 + v1) / 2, 0),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: pl.active ? 0.45 : 0.25, depthWrite: false, side: THREE.DoubleSide }),
        );
        sheet.quaternion.copy(q);
        sheet.position.copy(mid).addScaledVector(n, pl.at - n.dot(mid));
        sheet.renderOrder = 20;
        sheet.add(new THREE.LineSegments(new THREE.EdgesGeometry(sheet.geometry), new THREE.LineBasicMaterial({ color })));
        this.previewGroup.add(sheet);
      }
    }
    node.add(this.previewGroup);
  }

  // ---- Edge picking ------------------------------------------------------

  get sculptId() {
    return this.sculpt?.session.id ?? null;
  }

  enterSculpt(session: SculptSession) {
    this.sculpt = { session, mesh: null, tool: null, stroke: null };
    this.bindSculptMesh();
    this.applyAppearance();
  }

  exitSculpt() {
    this.sculpt = null;
    this.brushRing.visible = false;
    this.applyAppearance();
  }

  /** (Re)attach the brushes to the sculpt's current mesh, e.g. after a rebuild. */
  private bindSculptMesh() {
    const s = this.sculpt;
    if (!s) return;
    const node = this.nodes.get(s.session.id);
    const mesh = node?.children.find((c) => c instanceof THREE.Mesh && c.userData.sculpt) as THREE.Mesh | undefined;
    const f = this.features.get(s.session.id);
    if (mesh?.userData.creased && f?.kind === "sculpt") {
      // Brushes move shared corners: swap the sharp-edged display mesh for the plain one while sculpting.
      for (const c of mesh.children) disposeTree(c);
      mesh.clear();
      mesh.geometry.dispose();
      mesh.geometry = sculptGeometry(f.params);
      mesh.userData.creased = false;
    }
    if (mesh === s.mesh) return;
    s.mesh = mesh ?? null;
    s.tool = mesh ? new SculptMesh(mesh.geometry) : null;
  }

  private sculptHit(e: MouseEvent): THREE.Intersection | null {
    const mesh = this.sculpt?.mesh;
    if (!mesh) return null;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    return this.raycaster.intersectObject(mesh, false)[0] ?? null;
  }

  private showBrush(hit: THREE.Intersection | null) {
    const s = this.sculpt;
    if (!s || !hit || !hit.face) {
      this.brushRing.visible = false;
      return;
    }
    const r = s.session.settings().radius;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    this.brushRing.position.copy(hit.point).addScaledVector(normal, 0.05);
    this.brushRing.lookAt(hit.point.clone().add(normal));
    this.brushRing.scale.setScalar(r);
    this.brushRing.visible = true;
  }

  /** Left-drag on the sculpt sculpts; anywhere else the camera orbits as usual. */
  private setupSculptPointer() {
    // Capture phase on the container runs before OrbitControls sees the event.
    const host = this.container;
    host.addEventListener(
      "pointerdown",
      (e) => {
        const s = this.sculpt;
        if (!s?.tool || !s.mesh || e.button !== 0 || e.target !== this.renderer.domElement) return;
        const hit = this.sculptHit(e);
        if (!hit) return;
        e.stopPropagation();
        this.renderer.domElement.setPointerCapture(e.pointerId);
        const settings = s.session.settings();
        const local = s.mesh.worldToLocal(hit.point.clone());
        s.stroke = { lastDab: hit.point.clone() };
        if (settings.kind === "grab") {
          const normal = this.camera.getWorldDirection(new THREE.Vector3());
          s.stroke.grabPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
          s.stroke.grabStart = local;
          s.tool.startGrab(local, settings);
        } else {
          s.tool.dab(local, settings);
        }
      },
      true,
    );
    host.addEventListener(
      "pointermove",
      (e) => {
        const s = this.sculpt;
        if (!s?.tool || !s.mesh) return;
        const settings = s.session.settings();
        if (s.stroke?.grabPlane && s.stroke.grabStart) {
          this.raycaster.setFromCamera(this.ndc(e), this.camera);
          const p = this.raycaster.ray.intersectPlane(s.stroke.grabPlane, new THREE.Vector3());
          if (p) s.tool.drag(s.mesh.worldToLocal(p).sub(s.stroke.grabStart));
          this.brushRing.visible = false;
          return;
        }
        const hit = this.sculptHit(e);
        this.showBrush(hit);
        // Space dabs evenly along the stroke.
        if (s.stroke && hit && hit.point.distanceTo(s.stroke.lastDab) > settings.radius * 0.15) {
          s.tool.dab(s.mesh.worldToLocal(hit.point.clone()), settings);
          s.stroke.lastDab = hit.point.clone();
        }
      },
      true,
    );
    const finish = () => {
      const s = this.sculpt;
      if (!s?.stroke || !s.tool) return;
      s.stroke = null;
      s.session.onCommit(s.tool.encode());
    };
    host.addEventListener("pointerup", finish, true);
    host.addEventListener("pointercancel", finish, true);
    host.addEventListener("pointerleave", () => (this.brushRing.visible = false));
  }

  enterEdgePick(session: EdgePickSession) {
    this.edgePick = session;
    this.hoverEdge = -1;
    this.applyAppearance();
    this.drawEdgeOverlay();
  }

  updateEdgePick(points: Vec3Tuple[]) {
    if (!this.edgePick) return;
    this.edgePick.points = points;
    this.drawEdgeOverlay();
  }

  exitEdgePick() {
    this.edgePick = null;
    this.drawEdgeOverlay();
    this.applyAppearance();
  }

  /** The target object's edge lines, if it is shown. */
  private edgeLines(): THREE.LineSegments | null {
    const node = this.edgePick && this.nodes.get(this.edgePick.id);
    const mesh = node?.children.find((c) => c instanceof THREE.Mesh && c.userData.id === this.edgePick!.id);
    return (mesh?.children.find((c) => c instanceof THREE.LineSegments) as THREE.LineSegments | undefined) ?? null;
  }

  private drawEdgeOverlay() {
    disposeTree(this.edgeOverlay);
    this.edgeOverlay.clear();
    this.edgeOverlay.removeFromParent();
    const lines = this.edgeLines();
    if (!this.edgePick || !lines) return;
    lines.parent!.add(this.edgeOverlay);

    const pos = (lines.geometry.getAttribute("position") as THREE.BufferAttribute).array;
    const groups = lines.userData.groups as Int32Array;
    const all: number[] = [];
    const picked: number[] = [];
    const hover: number[] = [];
    for (let g = 0; g < groups.length / 3; g++) {
      const [start, count] = [groups[3 * g], groups[3 * g + 1]];
      const segment = Array.from(pos.slice(3 * start, 3 * (start + count)));
      const isPicked = this.edgePick.points.some((p) => samePoint(p, edgePoint(pos, start, count)));
      (isPicked ? picked : all).push(...segment);
      if (g === this.hoverEdge) hover.push(...segment);
    }
    const layer = (data: number[], color: number, order: number) => {
      if (!data.length) return;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute(data, 3));
      const seg = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
      seg.renderOrder = order;
      this.edgeOverlay.add(seg);
    };
    layer(all, 0x1f4e8c, 20);
    layer(picked, 0xff8a00, 21);
    layer(hover, 0x00b7ff, 22);
  }

  /** Index of the edge group under the pointer, or -1. */
  private edgeAt(e: MouseEvent): number {
    const lines = this.edgeLines();
    if (!lines) return -1;
    const pixel = this.pixelAt(new THREE.Vector3().setFromMatrixPosition(lines.matrixWorld));
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    this.raycaster.params.Line.threshold = pixel * 6;
    const hits = this.raycaster.intersectObject(lines, false);
    if (!hits.length) return -1;
    const index = hits[0].index ?? -1;
    const groups = lines.userData.groups as Int32Array;
    for (let g = 0; g < groups.length / 3; g++) {
      if (index >= groups[3 * g] && index < groups[3 * g] + groups[3 * g + 1]) return g;
    }
    return -1;
  }

  /** Select objects: `id` is the main one (with the gizmo), `others` are selected along with it. */
  select(id: string | null, others: Iterable<string> = []) {
    this.selectedId = id;
    this.selectedIds = new Set([...others, ...(id ? [id] : [])]);
    this.applyAppearance();
  }

  // ---- Sketch mode -------------------------------------------------------

  get sketchId() {
    return this.sketch?.id ?? null;
  }

  enterSketch(id: string, handler: SketchPointerHandler) {
    const f = this.features.get(id);
    if (!f || f.kind !== "sketch") return;
    this.exitSketch();
    // Sketching zooms by moving the camera, so it needs the perspective camera.
    this.sketchWasOrtho = this.orthographic;
    if (this.sketchWasOrtho) this.setOrthographic(false);
    this.setMeasuring(false);
    this.sketch = {
      id,
      planeKey: "",
      handler,
      saved: { position: this.camera.position.clone(), up: this.camera.up.clone(), target: this.orbit.target.clone() },
    };
    this.orbit.enabled = false;
    this.viewTurn = null;
    this.viewCube.visible = false;
    this.grids.visible = false;
    this.sketchLayer.visible = true;
    this.updateSketchFrame(true);
    this.applyAppearance();
  }

  exitSketch() {
    if (!this.sketch) return;
    const { saved } = this.sketch;
    this.sketch = null;
    this.camera.position.copy(saved.position);
    this.camera.up.copy(saved.up);
    this.orbit.target.copy(saved.target);
    this.camera.lookAt(saved.target);
    this.orbit.enabled = true;
    this.viewCube.visible = true;
    if (this.sketchWasOrtho) queueMicrotask(() => this.setOrthographic(true));
    this.grids.visible = true;
    this.sketchLayer.visible = false;
    this.applyAppearance();
  }

  /** Place the sketch layer on the sketch plane; optionally aim the camera at it. */
  private updateSketchFrame(aimCamera: boolean) {
    const s = this.sketch;
    if (!s) return;
    const f = this.features.get(s.id);
    const node = this.nodes.get(s.id);
    if (!f || f.kind !== "sketch" || !node) return;
    const key = `${f.params.plane}|${f.params.offset}`;
    if (key !== s.planeKey) {
      s.planeKey = key;
      aimCamera = true;
    }
    this.sketchLayer.matrix.copy(node.matrixWorld).multiply(planeMatrix(f.params));
    this.sketchLayer.matrixWorldNeedsUpdate = true;
    this.sketchLayer.updateMatrixWorld(true);
    if (!aimCamera) return;

    const origin = new THREE.Vector3().setFromMatrixPosition(this.sketchLayer.matrix);
    const basis = new THREE.Matrix4().extractRotation(this.sketchLayer.matrix);
    const normal = new THREE.Vector3(0, 0, 1).applyMatrix4(basis);
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(basis);
    this.camera.up.copy(up);
    this.camera.position.copy(origin).addScaledVector(normal, 160);
    this.camera.lookAt(origin);
  }

  private sketchPlaneWorld(): THREE.Plane {
    const m = this.sketchLayer.matrix;
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const normal = new THREE.Vector3(0, 0, 1).applyMatrix4(new THREE.Matrix4().extractRotation(m));
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
  }

  private rayToPlane(e: PointerEvent | MouseEvent | WheelEvent): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    return this.raycaster.ray.intersectPlane(this.sketchPlaneWorld(), new THREE.Vector3());
  }

  private toSketch(kind: SketchPointer["kind"], e: MouseEvent): SketchPointer | null {
    const p = this.rayToPlane(e);
    if (!p) return null;
    const pixel = this.pixelAt(p);
    p.applyMatrix4(this.sketchLayer.matrix.clone().invert());
    return { kind, u: p.x, v: p.y, pixel, shift: e.shiftKey, alt: e.altKey, clientX: e.clientX, clientY: e.clientY };
  }

  // ---- Internals ---------------------------------------------------------

  private applyAppearance() {
    const sketchId = this.sketch?.id;
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.userData.id) return;
      const f = this.features.get(o.userData.id);
      const mat = o.material as THREE.MeshStandardMaterial;
      const isHole = f?.mode === "hole";
      const selected = !this.combined && this.selectedIds.has(o.userData.id);
      const own = f?.color ? new THREE.Color(f.color).getHex() : COLORS.solid;
      mat.clippingPlanes = this.section && !this.sketch ? [this.section.plane] : null;
      for (const c of o.children) if (c instanceof THREE.LineSegments) (c.material as THREE.Material).clippingPlanes = mat.clippingPlanes;
      if (f?.kind === "plane") {
        mat.color.setHex(selected && !sketchId ? COLORS.selected : COLORS.plane);
        mat.opacity = sketchId ? 0.05 : 0.18;
        return;
      }
      if (o.userData.flat) {
        // A flat sketch's fill: faint, so it reads as a drawing rather than a solid.
        mat.color.setHex(selected && !sketchId ? COLORS.selected : isHole ? COLORS.hole : own);
        mat.opacity = sketchId ? 0.05 : selected ? 0.4 : 0.25;
        return;
      }
      const pickingThis = this.edgePick?.id === o.userData.id;
      mat.color.setHex(pickingThis ? scenePalette().picking : selected && !sketchId && !this.sculpt ? COLORS.selected : isHole ? COLORS.hole : own);
      let opacity = isHole ? 0.35 : 1;
      if (sketchId) opacity = o.userData.id === sketchId ? 0.3 : 0.1;
      mat.opacity = opacity;
      mat.transparent = opacity < 1;
      mat.depthWrite = opacity === 1;
    });

    let target = !this.combined && !this.sketch && !this.edgePick && !this.sculpt && !this.placement && !this.measure && this.selectedId ? this.nodes.get(this.selectedId) : undefined;
    if (target && !isShown(target)) target = undefined; // No gizmo on a hidden object.
    const f = target ? this.features.get(this.selectedId!) : undefined;
    this.jointDrag = null;
    this.jointProxy.removeFromParent();
    disposeTree(this.jointProxy);
    this.jointProxy.clear();
    this.gizmo.showX = this.gizmo.showY = this.gizmo.showZ = true;
    this.gizmo.space = this.localAxes ? "local" : "world";
    this.gizmo.setMode(this.userMode === "joint" || this.userMode === "pivot" ? "translate" : this.userMode);
    this.cutProxy.removeFromParent();
    this.pivotProxy.removeFromParent();
    disposeTree(this.pivotProxy);
    this.pivotProxy.clear();
    this.pivotFor = null;
    if (target && this.cutHandle?.id === f?.id) this.attachCutGizmo(target);
    else if (target && f?.joint && this.userMode === "joint") this.attachJointGizmo(f, f.joint, target);
    else if (target && f?.joint && this.userMode === "pivot") this.attachPivotGizmo(f, f.joint, target);
    else if (target) this.gizmo.attach(target);
    else this.gizmo.detach();
    this.drawRuler();
    this.drawSnapDots();
    this.drawSection();
  }

  setGizmoMode(mode: GizmoMode) {
    this.userMode = mode;
    this.applyAppearance(); // Re-attaches the gizmo (a connected object's depends on the mode).
  }


  // ---- Moving several objects -------------------------------------------------

  /** The other selected objects that move with the gizmo (not ones inside another selected object). */
  private groupFollowers(): THREE.Object3D[] {
    const nodes: THREE.Object3D[] = [];
    for (const id of this.selectedIds) {
      if (id === this.selectedId) continue;
      const node = this.nodes.get(id);
      if (!node) continue;
      // Inside a selected object: it moves with that one already.
      let inside = false;
      for (let p = node.parent; p; p = p.parent) if (p.userData.id && this.selectedIds.has(p.userData.id)) inside = true;
      if (!inside) nodes.push(node);
    }
    return nodes;
  }

  private startGroupDrag() {
    this.groupDrag = null;
    const obj = this.gizmo.object;
    if (!obj || obj.userData.id !== this.selectedId || this.gizmo.mode === "scale") return;
    const others = this.groupFollowers();
    if (!others.length) return;
    this.root.updateMatrixWorld(true);
    this.groupDrag = { start: obj.matrixWorld.clone(), others: others.map((node) => ({ node, world: node.matrixWorld.clone() })) };
  }

  /** The others follow the main object: the same move (and turn, about its origin). */
  private followGroupDrag(obj: THREE.Object3D) {
    const g = this.groupDrag;
    if (!g) return;
    obj.updateMatrixWorld(true);
    const delta = obj.matrixWorld.clone().multiply(g.start.clone().invert());
    for (const { node, world } of g.others) {
      const local = (node.parent ? node.parent.matrixWorld.clone().invert() : new THREE.Matrix4()).multiply(delta.clone().multiply(world));
      local.decompose(node.position, node.quaternion, node.scale);
    }
  }

  // ---- Box select -------------------------------------------------------------

  /** Shift-drag on empty space draws a selection box; Shift-click adds/removes one object. */
  private setupBoxSelect() {
    const el = this.renderer.domElement;
    const free = () => !this.sketch && !this.placement && !this.edgePick && !this.sculpt && !this.measure && !this.combined;
    this.container.addEventListener(
      "pointerdown",
      (e) => {
        if (e.target !== el || e.button !== 0 || !(e.shiftKey || e.ctrlKey || e.metaKey) || !free() || this.gizmo.axis) return;
        e.stopPropagation(); // Not an orbit.
        const box = document.createElement("div");
        box.className = "select-box";
        box.hidden = true;
        this.container.append(box);
        this.boxSelect = { x: e.clientX, y: e.clientY, el: box };
        el.setPointerCapture(e.pointerId);
      },
      true,
    );
    el.addEventListener("pointermove", (e) => {
      const b = this.boxSelect;
      if (!b) return;
      const r = this.container.getBoundingClientRect();
      const [x0, x1] = [Math.min(b.x, e.clientX), Math.max(b.x, e.clientX)];
      const [y0, y1] = [Math.min(b.y, e.clientY), Math.max(b.y, e.clientY)];
      b.el.hidden = x1 - x0 < 4 && y1 - y0 < 4;
      Object.assign(b.el.style, { left: `${x0 - r.left}px`, top: `${y0 - r.top}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    });
    el.addEventListener("pointerup", (e) => {
      const b = this.boxSelect;
      if (!b) return;
      this.boxSelect = null;
      b.el.remove();
      if (Math.hypot(e.clientX - b.x, e.clientY - b.y) < 4) {
        // A click: add or remove the object under it.
        const id = this.pick(e);
        if (id) this.events.onSelect(id, true);
        return;
      }
      const rect = el.getBoundingClientRect();
      const [x0, x1] = [Math.min(b.x, e.clientX) - rect.left, Math.max(b.x, e.clientX) - rect.left];
      const [y0, y1] = [Math.min(b.y, e.clientY) - rect.top, Math.max(b.y, e.clientY) - rect.top];
      const ids: string[] = [];
      this.root.updateMatrixWorld(true);
      for (const [id, node] of this.nodes) {
        if (!isShown(node) || this.features.get(id)?.kind === "group") continue;
        const box = this.localBox(id, node);
        if (!box) continue;
        // Inside when its middle is in the box on screen.
        const c = box.getCenter(new THREE.Vector3()).applyMatrix4(node.matrixWorld).project(this.camera);
        const sx = ((c.x + 1) / 2) * rect.width;
        const sy = ((1 - c.y) / 2) * rect.height;
        if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1 && c.z < 1) ids.push(id);
      }
      this.events.onBoxSelect(ids);
    });
  }

  // ---- Measuring ---------------------------------------------------------------

  get measuring() {
    return !!this.measure;
  }

  /** Start (or stop) the measure tool: click two points to get the distance between them. */
  setMeasuring(on: boolean) {
    if (!on) {
      if (this.measure) {
        disposeTree(this.measure.group);
        this.measure.group.removeFromParent();
        this.measure.label.remove();
      }
      this.measure = null;
      this.renderer.domElement.style.cursor = "";
      this.events.onMeasure(null);
      this.applyAppearance();
      return;
    }
    if (this.measure) return;
    const label = document.createElement("div");
    label.className = "measure-label";
    label.hidden = true;
    this.container.append(label);
    const group = new THREE.Group();
    this.scene.add(group);
    this.measure = { points: [], group, label };
    this.renderer.domElement.style.cursor = "crosshair";
    this.applyAppearance(); // No gizmo while measuring.
  }

  /** The point to measure from under the pointer: a snap point or edge vertex if one is close, else the surface. */
  private measurePoint(e: MouseEvent): { p: THREE.Vector3; n: THREE.Vector3 | null } | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.intersectObject(this.root, true).find((h) => h.object instanceof THREE.Mesh && h.face && h.object.userData.id && isShown(h.object) && !this.previewGroup.getObjectById(h.object.id));
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const toScreen = (p: THREE.Vector3) => {
      const v = p.clone().project(this.camera);
      return Math.hypot(((v.x + 1) / 2) * rect.width - sx, ((1 - v.y) / 2) * rect.height - sy);
    };
    let best: THREE.Vector3 | null = null;
    let bestPx = 12;
    const candidates = (id: string, node: THREE.Object3D) => {
      for (const p of this.snapPointsOf(id, node)) {
        const w = p.applyMatrix4(node.matrixWorld);
        const d = toScreen(w);
        if (d < bestPx) [best, bestPx] = [w, d];
      }
      // Corners and points along the object's edges.
      node.traverse((o) => {
        if (!(o instanceof THREE.LineSegments) || !o.userData.groups || !isShown(o)) return;
        const pos = o.geometry.getAttribute("position");
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          const d = toScreen(v);
          if (d < bestPx - 2) [best, bestPx] = [v.clone(), d + 2];
        }
      });
    };
    const id = hit?.object.userData.id as string | undefined;
    const node = id ? this.nodes.get(id) : undefined;
    if (id && node) candidates(id, node);
    const normal = hit ? (hit.normal ?? hit.face!.normal).clone().transformDirection(hit.object.matrixWorld) : null;
    if (best) return { p: best, n: null };
    if (hit) return { p: hit.point.clone(), n: normal };
    // Nothing under the pointer: the ground.
    const g = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return g ? { p: g, n: new THREE.Vector3(0, 0, 1) } : null;
  }

  private measureClick(e: MouseEvent) {
    const m = this.measure;
    const pt = m && this.measurePoint(e);
    if (!m || !pt) return;
    if (m.points.length >= 2) m.points = [];
    m.points.push(pt);
    this.drawMeasure();
  }

  private drawMeasure(hover?: { p: THREE.Vector3; n: THREE.Vector3 | null } | null) {
    const m = this.measure;
    if (!m) return;
    disposeTree(m.group);
    m.group.clear();
    const pts = [...m.points.map((x) => x.p), ...(hover && m.points.length === 1 ? [hover.p] : [])];
    if (hover && m.points.length !== 1) pts.push(hover.p);
    const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), DOT_MATERIALS.measure);
    dots.renderOrder = 50;
    m.group.add(dots);
    if (pts.length >= 2) {
      const [a, b] = pts;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xff3d9a, depthTest: false, transparent: true }));
      line.renderOrder = 50;
      m.group.add(line);
      // The X/Y/Z legs, faint.
      const legs = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, new THREE.Vector3(b.x, a.y, a.z), new THREE.Vector3(b.x, b.y, a.z), b]),
        new THREE.LineDashedMaterial({ color: 0xff3d9a, dashSize: 1, gapSize: 1, depthTest: false, transparent: true, opacity: 0.45 }),
      );
      legs.computeLineDistances();
      legs.renderOrder = 49;
      m.group.add(legs);
    }
    const final = m.points.length === 2;
    const text = pts.length >= 2 ? this.measureText(pts[0], pts[1], final ? m.points[0].n : null, final ? m.points[1].n : null) : null;
    m.label.hidden = !text;
    if (text) m.label.textContent = text;
    if (final || !hover) this.events.onMeasure(text);
  }

  private measureText(a: THREE.Vector3, b: THREE.Vector3, na: THREE.Vector3 | null, nb: THREE.Vector3 | null): string {
    const f = (v: number) => String(Math.round(v * 100) / 100 + 0);
    const d = b.clone().sub(a);
    let text = `${d.length().toFixed(2)} mm   ΔX ${Math.abs(d.x).toFixed(2)}  ΔY ${Math.abs(d.y).toFixed(2)}  ΔZ ${Math.abs(d.z).toFixed(2)}`;
    if (na && nb) {
      // Two faces: the angle between them too (0° parallel, 90° square).
      const angle = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(na.dot(nb)))));
      text += `   faces ${f(angle)}°`;
    }
    return text;
  }

  private updateMeasureLabel() {
    const m = this.measure;
    if (!m || m.label.hidden || m.group.children.length < 2) return;
    const pos = (m.group.children[1] as THREE.Line).geometry.getAttribute("position");
    const mid = new THREE.Vector3().fromBufferAttribute(pos, 0).add(new THREE.Vector3().fromBufferAttribute(pos, 1)).multiplyScalar(0.5).project(this.camera);
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    m.label.style.transform = `translate(${((mid.x + 1) / 2) * w}px, ${((1 - mid.y) / 2) * h}px) translate(-50%, -140%)`;
  }

  // ---- Section view -------------------------------------------------------------

  /** Cut the view open with a plane square to `axis` at `at` (it hides the + side, or the − side when flipped). Null turns it off. */
  setSection(section: { axis: "x" | "y" | "z"; at: number; flip: boolean } | null) {
    if (!section) this.section = null;
    else {
      const n = new THREE.Vector3(section.axis === "x" ? 1 : 0, section.axis === "y" ? 1 : 0, section.axis === "z" ? 1 : 0).multiplyScalar(section.flip ? 1 : -1);
      // Keeps points where n·p + constant ≥ 0.
      const plane = new THREE.Plane(n, section.flip ? -section.at : section.at);
      this.section = { plane, ...section };
    }
    // Clipping costs a little on every draw, so it's only on while a section is shown.
    this.renderer.localClippingEnabled = !!this.section;
    this.applyAppearance();
  }

  /** Solid caps where the section cuts through objects (their insides drawn flat), and the cut's outline. */
  private drawSection() {
    disposeTree(this.sectionGroup);
    this.sectionGroup.clear();
    const s = this.section;
    if (!s || this.sketch) return;
    this.root.updateMatrixWorld(true);
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.userData.id || o.userData.flat || !isShown(o)) return;
      const f = this.features.get(o.userData.id);
      if (!f || f.kind === "plane" || f.mode === "hole") return;
      // Back faces seen through the cut read as a solid cap.
      const cap = new THREE.Mesh(o.geometry, new THREE.MeshBasicMaterial({ color: 0xff8a3d, side: THREE.BackSide, clippingPlanes: [s.plane] }));
      cap.matrixAutoUpdate = false;
      cap.matrix.copy(o.matrixWorld);
      cap.userData.shared = true; // The geometry belongs to the object.
      this.sectionGroup.add(cap);
    });
    // The cut plane's outline across the model.
    const box = new THREE.Box3();
    this.root.traverse((o) => o instanceof THREE.Mesh && o.userData.id && isShown(o) && box.expandByObject(o));
    if (box.isEmpty()) return;
    const pad = 5;
    box.expandByScalar(pad);
    const [u, v] = s.axis === "x" ? ["y", "z"] : s.axis === "y" ? ["x", "z"] : ["x", "y"];
    const corner = (a: number, b: number) => {
      const p = new THREE.Vector3();
      p[s.axis] = s.at;
      p[u as "x"] = a ? box.max[u as "x"] : box.min[u as "x"];
      p[v as "x"] = b ? box.max[v as "x"] : box.min[v as "x"];
      return p;
    };
    const frame = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)]), new THREE.LineDashedMaterial({ color: 0xff8a3d, dashSize: 2, gapSize: 1.5 }));
    frame.computeLineDistances();
    this.sectionGroup.add(frame);
  }

  /** The model's world bounds (shown objects), or null if there's nothing. */
  modelBounds(onlyIds?: Set<string>, solidOnly = false): THREE.Box3 | null {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !isShown(o) || o.userData.flat) return;
      const id = o.userData.id as string | undefined;
      if (onlyIds && (!id || !onlyIds.has(id))) {
        // Inside a selected object counts too.
        let inside = false;
        for (let p = o.parent; p; p = p.parent) if (p.userData.id && onlyIds.has(p.userData.id)) inside = true;
        if (!inside) return;
      }
      // Holes cut the model rather than adding to it (unless one was asked about itself).
      if ((!onlyIds || (solidOnly && !onlyIds.has(id ?? ""))) && id && this.features.get(id)?.mode === "hole") return;
      box.expandByObject(o);
    });
    return box.isEmpty() ? null : box;
  }

  // ---- Camera: fit, zoom, perspective/orthographic ---------------------------------

  /** Where the camera is (world), e.g. to cut away the near side in a section view. */
  get cameraPosition(): Vec3 {
    const p = this.camera.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  get orthographic() {
    return this.camera === this.orthoCamera;
  }

  /** Switch between perspective and a flat (orthographic) view, keeping what's on screen about the same size. */
  setOrthographic(on: boolean) {
    if (on === this.orthographic || this.sketch) return;
    const target = this.orbit.target;
    const from = this.camera;
    const dist = from.position.distanceTo(target);
    const halfFov = THREE.MathUtils.degToRad(this.perspCamera.fov / 2);
    const to = on ? this.orthoCamera : this.perspCamera;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);
    if (on) {
      const halfH = dist * Math.tan(halfFov);
      this.orthoFrustum(halfH);
      this.orthoCamera.zoom = 1;
    } else {
      // The same view height as the flat view had.
      const halfH = (this.orthoCamera.top - this.orthoCamera.bottom) / 2 / this.orthoCamera.zoom;
      const d = halfH / Math.tan(halfFov);
      to.position.copy(target).addScaledVector(from.position.clone().sub(target).normalize(), d);
    }
    to.updateProjectionMatrix();
    this.camera = to;
    this.orbit.object = to;
    this.gizmo.camera = to;
    this.orbit.update();
    this.applyAppearance();
  }

  private orthoFrustum(halfH: number) {
    const { clientWidth: w, clientHeight: h } = this.container;
    const aspect = w && h ? w / h : 1;
    Object.assign(this.orthoCamera, { top: halfH, bottom: -halfH, left: -halfH * aspect, right: halfH * aspect });
    this.orthoCamera.updateProjectionMatrix();
  }

  /** Swing the view to fit the whole model, or just the selected objects. */
  fitView(selectionOnly = false) {
    if (this.sketch) return;
    const box = this.modelBounds(selectionOnly && this.selectedIds.size ? this.selectedIds : undefined);
    const sphere = box ? box.getBoundingSphere(new THREE.Sphere()) : new THREE.Sphere(new THREE.Vector3(), 60);
    const r = Math.max(sphere.radius, 5) * 1.15;
    const halfFov = THREE.MathUtils.degToRad(this.perspCamera.fov / 2);
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    // Fit the narrower of height and width.
    const fit = Math.min(Math.tan(halfFov), Math.tan(halfFov) * aspect);
    const fromDist = this.camera.position.distanceTo(this.orbit.target);
    this.viewFly = {
      from: this.orbit.target.clone(),
      to: sphere.center.clone(),
      fromDist,
      toDist: this.orthographic ? fromDist : r / fit,
      fromZoom: this.orthoCamera.zoom,
      toZoom: this.orthographic ? (this.orthoCamera.top * Math.min(1, aspect)) / r : this.orthoCamera.zoom,
      start: performance.now(),
    };
  }

  private stepViewFly() {
    const v = this.viewFly;
    if (!v) return;
    const t = Math.min(1, (performance.now() - v.start) / 350);
    const k = t * t * (3 - 2 * t);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.lerpVectors(v.from, v.to, k);
    this.camera.position.copy(this.orbit.target).addScaledVector(dir, v.fromDist + (v.toDist - v.fromDist) * k);
    if (this.orthographic) {
      this.orthoCamera.zoom = v.fromZoom + (v.toZoom - v.fromZoom) * k;
      this.orthoCamera.updateProjectionMatrix();
    }
    if (t >= 1) this.viewFly = null;
  }

  /**
   * A picture of the model (PNG, base64) from a set direction, framed to fit it
   * (or `ids`), at any size. It's drawn off screen with its own camera, so the
   * user's view doesn't move. Gizmo and snap dots are left out.
   */
  snapshot(opts: { view: string; ids?: string[]; width: number; height: number }): string {
    const { width: w, height: h } = opts;
    const fov = this.perspCamera.fov;
    const cam = new THREE.PerspectiveCamera(fov, w / h, 0.1, 100000);
    const box = this.modelBounds(opts.ids?.length ? new Set(opts.ids) : undefined);
    const sphere = box ? box.getBoundingSphere(new THREE.Sphere()) : new THREE.Sphere(new THREE.Vector3(0, 0, 10), 40);
    const r = Math.max(sphere.radius, 5) * 1.1;
    const DIRS: Record<string, [number, number, number]> = {
      iso: [1, -1.25, 0.95],
      front: [0, -1, 0],
      back: [0, 1, 0],
      left: [-1, 0, 0],
      right: [1, 0, 0],
      top: [0, 0, 1],
      bottom: [0, 0, -1],
    };
    if (opts.view === "current") {
      cam.position.copy(this.camera.position);
      cam.up.set(0, 0, 1);
      cam.lookAt(this.orbit.target);
    } else {
      const dir = new THREE.Vector3(...(DIRS[opts.view] ?? DIRS.iso)).normalize();
      const halfFov = THREE.MathUtils.degToRad(fov / 2);
      const fit = Math.min(Math.tan(halfFov), Math.tan(halfFov) * (w / h));
      cam.position.copy(sphere.center).addScaledVector(dir, r / fit);
      // Straight down/up: +Y is up in the picture, like the view cube's Top.
      cam.up.set(0, Math.abs(dir.z) > 0.999 ? 1 : 0, Math.abs(dir.z) > 0.999 ? 0 : 1);
      cam.lookAt(sphere.center);
    }
    cam.updateProjectionMatrix();

    const hidden = [this.gizmo.getHelper(), this.snapHint, this.brushRing, ...this.snapDots].filter((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    const target = new THREE.WebGLRenderTarget(w, h, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    const pixels = new Uint8Array(w * h * 4);
    try {
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.renderer.render(this.scene, cam);
      this.renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
    } finally {
      this.renderer.setRenderTarget(null);
      target.dispose();
      hidden.forEach((o) => (o.visible = true));
    }
    // WebGL rows run bottom-up; images run top-down.
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d")!;
    const image = g.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) image.data.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    g.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  }

  /** World size of one screen pixel at a point (for pick tolerances). */
  private pixelAt(p: THREE.Vector3): number {
    const h = this.renderer.domElement.clientHeight || 1;
    if (this.camera instanceof THREE.OrthographicCamera) return (this.camera.top - this.camera.bottom) / this.camera.zoom / h;
    return (2 * this.camera.position.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
  }

  // ---- Print bed -------------------------------------------------------------------

  /** Outline the printer's bed (centred on the origin) and its build height; null hides it. */
  setBed(bed: { width: number; depth: number; height: number } | null) {
    disposeTree(this.bedGroup);
    this.bedGroup.clear();
    if (!bed) return;
    const { width: w, depth: d, height: h } = bed;
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const base = [V(-w / 2, -d / 2, 0), V(w / 2, -d / 2, 0), V(w / 2, d / 2, 0), V(-w / 2, d / 2, 0)];
    const plate = floorLayer(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(base), new THREE.LineBasicMaterial({ color: 0x3e7bfa })), -2);
    const top = base.map((p) => p.clone().setZ(h));
    const posts = base.flatMap((p, i) => [p, top[i]]);
    const upper = top.flatMap((p, i) => [p, top[(i + 1) % 4]]);
    const frame = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([...posts, ...upper]), new THREE.LineDashedMaterial({ color: 0x3e7bfa, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.35 }));
    frame.computeLineDistances();
    this.bedGroup.add(plate, frame);
  }

  // ---- Split handle ----------------------------------------------------------

  /** Show (or remove, with null) an arrow on the selected object that drags a planned cut along its axis. */
  setCutHandle(handle: CutHandle | null) {
    const key = (h: CutHandle | null) => (h ? JSON.stringify([h.id, h.normal, h.at]) : "");
    const same = key(handle) === key(this.cutHandle);
    this.cutHandle = handle;
    if (!same && !this.gizmo.dragging) this.applyAppearance();
  }

  private attachCutGizmo(node: THREE.Object3D) {
    const h = this.cutHandle!;
    const box = this.localBox(h.id, node);
    if (!box) return void this.gizmo.attach(node);
    // In the object's own frame, on the cut plane by the object's middle, its Z along the cut's normal.
    const n = new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z).normalize();
    const c = box.getCenter(new THREE.Vector3());
    this.cutProxy.position.copy(c).addScaledVector(n, h.at - n.dot(c));
    this.cutProxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    node.add(this.cutProxy);
    this.cutProxy.updateMatrixWorld(true);
    this.gizmo.setMode("translate");
    this.gizmo.space = "local";
    this.gizmo.showX = this.gizmo.showY = false;
    this.gizmo.showZ = true;
    this.gizmo.attach(this.cutProxy);
  }

  /** The cut's arrow moved: keep it on its axis, inside the object, and report the new position. */
  private followCut() {
    const h = this.cutHandle;
    const node = h && this.nodes.get(h.id);
    const box = node && this.localBox(h.id, node);
    if (!h || !box) return;
    const p = this.cutProxy.position;
    const n = new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z).normalize();
    // How far along the normal the object reaches (its box corners), so the cut stays inside it.
    const reach = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => n.dot(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)));
    const [lo, hi] = [Math.min(...reach), Math.max(...reach)];
    const inset = Math.min(0.01, (hi - lo) / 4);
    const at = Math.round(Math.min(hi - inset, Math.max(lo + inset, n.dot(p))) * 1e4) / 1e4 + 0;
    const c = box.getCenter(new THREE.Vector3());
    p.copy(c).addScaledVector(n, at - n.dot(c));
    h.at = at;
    h.onMove(at);
  }

  // ---- Joints ----------------------------------------------------------------

  /** A connected object only moves by its joint: the gizmo shows just that ring (hinge) or arrow (slider). */
  private attachJointGizmo(f: Feature, j: Joint, node: THREE.Object3D) {
    const axis = new THREE.Vector3(j.axis.x, j.axis.y, j.axis.z).normalize();
    const align = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const proxy = this.jointProxy;
    (node.parent ?? this.root).add(proxy);
    this.placeJointProxy(j, align, j.value);
    // The axis, drawn through the pivot.
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -40), new THREE.Vector3(0, 0, 40)]),
      new THREE.LineDashedMaterial({ color: 0xff8a00, dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true }),
    );
    line.computeLineDistances();
    line.renderOrder = 30;
    if (j.type === "slider") line.position.z = -j.value; // Keep the line on the rail while the proxy slides.
    proxy.add(line);
    proxy.updateMatrixWorld(true);
    this.jointDrag = { id: f.id, node, joint: j, base: baseMatrix(f), align, value: j.value };
    this.gizmo.setMode(j.type === "slider" ? "translate" : "rotate");
    this.gizmo.space = "local";
    this.gizmo.showX = this.gizmo.showY = false;
    this.gizmo.attach(proxy);
  }

  /** Pivot mode: a move gizmo on the connection's pivot, with an arrow showing its axle. */
  private attachPivotGizmo(f: Feature, j: Joint, node: THREE.Object3D) {
    const p = this.pivotProxy;
    (node.parent ?? this.root).add(p);
    p.position.set(j.origin.x, j.origin.y, j.origin.z);
    const axis = new THREE.Vector3(j.axis.x, j.axis.y, j.axis.z).normalize();
    const arrow = new THREE.ArrowHelper(axis, new THREE.Vector3(), 25, 0xff8a00, 6, 4);
    arrow.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.depthTest = false;
      o.renderOrder = 31;
    });
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([axis.clone().multiplyScalar(-40), axis.clone().multiplyScalar(40)]),
      new THREE.LineDashedMaterial({ color: 0xff8a00, dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true }),
    );
    line.computeLineDistances();
    line.renderOrder = 30;
    p.add(arrow, line);
    p.updateMatrixWorld(true);
    this.pivotFor = f.id;
    this.gizmo.attach(p);
  }

  /** Dragging the pivot snaps it onto any object's points (its own part's too, e.g. a wheel's centre). */
  private startPivotDrag() {
    this.pointDrag = null;
    if (!this.pointSnap) return;
    this.root.updateMatrixWorld(true);
    const targets: THREE.Vector3[] = [];
    for (const [id, node] of this.nodes) {
      if (this.features.get(id)?.kind === "group" || !isShown(node)) continue;
      for (const pt of this.snapPointsOf(id, node)) targets.push(pt.applyMatrix4(node.matrixWorld));
    }
    this.pointDrag = { local: [new THREE.Vector3()], targets, snapped: false };
  }

  private placeJointProxy(j: Joint, align: THREE.Quaternion, value: number) {
    const p = this.jointProxy;
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(align);
    p.position.set(j.origin.x, j.origin.y, j.origin.z);
    if (j.type === "slider") {
      p.position.addScaledVector(axis, value);
      p.quaternion.copy(align);
    } else {
      p.quaternion.copy(align).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(value)));
    }
  }

  /** The gizmo moved the joint's stand-in: read the joint value off it and move the object to match. */
  private followJoint() {
    const d = this.jointDrag;
    if (!d) return;
    const j = d.joint;
    const p = this.jointProxy;
    let v: number;
    if (j.type !== "slider") {
      // The turn about the axis (any other tilt is ignored), unwrapped so it can go past ±180°.
      const q = d.align.clone().invert().multiply(p.quaternion);
      const turn = THREE.MathUtils.radToDeg(2 * Math.atan2(q.z, q.w));
      v = d.value + (((turn - d.value + 540) % 360) - 180);
    } else {
      const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(d.align);
      v = p.position.clone().sub(new THREE.Vector3(j.origin.x, j.origin.y, j.origin.z)).dot(axis);
    }
    v = clampJoint(j, Math.round(v * 1000) / 1000 + 0);
    d.value = v;
    this.placeJointProxy(j, d.align, v);
    const at = new THREE.Vector3().setFromMatrixPosition(d.base);
    jointMatrix(j, v, at).multiply(d.base).decompose(d.node.position, d.node.quaternion, new THREE.Vector3());
    this.events.onJointMoving(d.id, v);
  }

  setPointSnap(snap: boolean, show: boolean) {
    this.pointSnap = snap;
    this.showPoints = show;
    this.drawSnapDots();
  }

  // ---- Placing new shapes ---------------------------------------------------

  get placing() {
    return !!this.placement;
  }

  /** Start placing a new shape. Its exact preview arrives later via setPlacementMesh. */
  startPlacement(session: PlacementSession) {
    this.cancelPlacement();
    const ghost = new THREE.Group();
    ghost.visible = false;
    const f = session.feature;
    const source = session.existing ? this.nodes.get(f.id) : undefined;
    if (source) {
      // A see-through copy of the object as it looks now.
      source.updateMatrixWorld(true);
      // The ghost is placed without the mirror, so its copy carries the flip itself.
      const toLocal = source.matrixWorld.clone().multiply(new THREE.Matrix4().makeScale(f.mirrored ? -1 : 1, 1, 1)).invert();
      source.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !o.userData.id || !isShown(o)) return;
        const copy = new THREE.Mesh(o.geometry.clone(), ghostMaterial());
        copy.geometry.applyMatrix4(toLocal.clone().multiply(o.matrixWorld));
        ghost.add(copy);
      });
    } else if (session.pickOnly) {
      // Nothing to preview: the click just names an object.
    } else if (session.marker) {
      // An arrow out of the face: the joint's axis.
      ghost.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 30, 0xff8a00, 6, 4));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(5, 0.6, 8, 32), new THREE.MeshBasicMaterial({ color: 0xff8a00, depthTest: false, transparent: true }));
      ring.renderOrder = 31;
      ghost.add(ring);
    } else if (f.kind === "sculpt") ghost.add(ghostify(buildSculptMesh(f)));
    else if (f.kind === "plane") ghost.add(buildPlane("", f.params.size));
    else if (f.kind === "sketch" || f.kind === "group") ghost.add(new THREE.AxesHelper(10));
    else {
      // Until the exact shape arrives, show its bounding box.
      const ext = featureExtents(f);
      if (ext) {
        const [a, b] = ext;
        const box = new THREE.Mesh(new THREE.BoxGeometry(b.x - a.x, b.y - a.y, b.z - a.z), ghostMaterial());
        box.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        ghost.add(box);
      }
    }
    this.scene.add(ghost);
    const own = this.nodes.get(f.id);
    const avoid = source ?? ((session.marker && !session.allowSelf) || session.pickOnly ? own : undefined);
    this.placement = { session, ghost, at: null, flipped: false, pointer: null, skip: avoid ? this.movingIds(avoid) : new Set(), dots: null, dotsKey: "" };
    this.applyAppearance(); // No gizmo while placing.
    this.drawSnapDots(); // Only the face under the pointer gets dots.
    this.events.onPlacementChange();
    this.renderer.domElement.style.cursor = "crosshair";
  }

  /** Flip the placement direction: into the face instead of out of it. Returns the new state. */
  flipPlacement(): boolean {
    const p = this.placement;
    if (!p) return false;
    p.flipped = !p.flipped;
    if (p.pointer) this.placementHover(...p.pointer);
    return p.flipped;
  }

  /** The kernel's exact mesh for the shape being placed. */
  setPlacementMesh(id: string, mesh: MeshData | null) {
    const p = this.placement;
    if (!p || p.session.feature.id !== id || !mesh) return;
    disposeTree(p.ghost);
    p.ghost.clear();
    p.ghost.add(ghostify(buildMesh(mesh, false)));
  }

  cancelPlacement() {
    const p = this.placement;
    if (!p) return;
    this.endPlacement();
    p.session.onCancel();
  }

  private endPlacement() {
    const p = this.placement;
    if (!p) return;
    disposeTree(p.ghost);
    p.ghost.removeFromParent();
    this.showFaceDots(p, null);
    this.showSnapHint(null);
    this.placement = null;
    this.renderer.domElement.style.cursor = "";
    this.applyAppearance();
    this.drawSnapDots();
    this.events.onPlacementChange();
  }

  /** Move the preview to what's under the pointer (also used while dragging a shape button over the view). */
  placementHover(clientX: number, clientY: number) {
    const p = this.placement;
    if (!p) return;
    p.pointer = [clientX, clientY];
    const face = this.placementAt(clientX, clientY, p.skip, !!p.session.noGround);
    this.showFaceDots(p, face?.face ?? null);
    this.showSnapHint(face?.face?.snapped ? face.position : null, face?.position);
    if (face && p.flipped) face.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
    p.at = face && this.placeOnFace(face, p.session);
    p.ghost.visible = !!p.at;
    if (p.at) {
      p.ghost.position.copy(p.at.position);
      p.ghost.quaternion.copy(p.at.quaternion);
    }
  }

  placementDrop(clientX: number, clientY: number) {
    const p = this.placement;
    if (!p) return;
    this.placementHover(clientX, clientY);
    const at = p.at;
    if (!at) return;
    this.endPlacement();
    const r = new THREE.Euler().setFromQuaternion(at.quaternion, "ZYX");
    const deg = (v: number) => Math.round(THREE.MathUtils.radToDeg(v) * 1000) / 1000 + 0;
    const mm = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
    p.session.onPlace({ x: mm(at.position.x), y: mm(at.position.y), z: mm(at.position.z) }, { x: deg(r.x), y: deg(r.y), z: deg(r.z) }, at.id);
  }

  /**
   * Where a new shape goes for a pointer position: on the face under it (standing
   * out along the face, lined up with that object and snapped to its grid and
   * points), or on the ground grid.
   */
  private placementAt(
    clientX: number,
    clientY: number,
    skip: Set<string>,
    noGround = false,
  ): { position: THREE.Vector3; quaternion: THREE.Quaternion; id: string | null; face?: PlacementFace } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    const hit = this.raycaster
      .intersectObject(this.root, true)
      .find((h) => h.object instanceof THREE.Mesh && h.face && isShown(h.object) && !skip.has(h.object.userData.id) && !this.previewGroup.getObjectById(h.object.id));

    // The frame we snap in: the hit object's own frame, or the world for the ground.
    const node = hit && hit.object.userData.id ? this.nodes.get(hit.object.userData.id) : undefined;
    if (noGround && !node) return null; // Only real objects (not the plate, or the merged "Show result" view).
    const frame = node ? node.matrixWorld.clone() : new THREE.Matrix4();
    const frameQ = new THREE.Quaternion().setFromRotationMatrix(frame);
    let point: THREE.Vector3;
    let localNormal: THREE.Vector3;
    if (hit) {
      point = hit.point.clone();
      const n = (hit.normal ?? hit.face!.normal).clone().transformDirection(hit.object.matrixWorld);
      if (n.dot(this.raycaster.ray.direction) > 0) n.negate(); // Face the camera (planes are two-sided).
      localNormal = n.applyQuaternion(frameQ.clone().invert()).normalize();
    } else {
      if (noGround) return null;
      point = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3()) ?? new THREE.Vector3(NaN);
      if (Number.isNaN(point.x)) return null;
      localNormal = new THREE.Vector3(0, 0, 1);
    }
    // A face lined up with the object's axes: make it exact, so the new shape sits square on it.
    const axis = (["x", "y", "z"] as const).find((a) => Math.abs(localNormal[a]) > 0.9999);
    if (axis) localNormal.set(0, 0, 0)[axis] = Math.sign(localNormal[axis] || 1);

    const toFrame = frame.clone().invert();
    const local = point.clone().applyMatrix4(toFrame);
    const snapped = node && this.pointSnap ? this.snapOnFace(hit!.object.userData.id, node, local, localNormal, clientX - rect.left, clientY - rect.top) : null;
    if (snapped) local.copy(snapped);
    else if (axis && this.snap > 0) {
      // Grid snap across the face (not off it).
      for (const a of ["x", "y", "z"] as const) if (a !== axis) local[a] = Math.round(local[a] / this.snap) * this.snap;
    }
    const onFace = local.clone();
    const position = local.applyMatrix4(frame);
    const quaternion = frameQ.multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal));
    const id = node ? (hit!.object.userData.id as string) : null;
    const face = node && id ? { id, node, normal: localNormal, point: onFace, snapped: !!snapped } : undefined;
    return { position, quaternion, id, face };
  }

  /** While placing: dots on the snap points of the face under the pointer. */
  private showFaceDots(p: NonNullable<typeof this.placement>, face: PlacementFace | null) {
    const show = face && this.pointSnap && this.showPoints;
    const n = face?.normal;
    // The face's plane, rounded so small pointer moves on one face reuse the dots.
    const key = show ? `${face.id}|${n!.toArray().map((v) => v.toFixed(3))}|${n!.dot(face.point).toFixed(2)}` : "";
    if (key === p.dotsKey) return;
    p.dotsKey = key;
    if (p.dots) {
      p.dots.removeFromParent();
      p.dots.geometry.dispose();
      p.dots = null;
    }
    if (!show) return;
    const pts = this.snapPointsOf(face.id, face.node).filter((q) => Math.abs(q.clone().sub(face.point).dot(face.normal)) <= 0.01);
    if (!pts.length) return;
    p.dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), DOT_MATERIALS.other);
    p.dots.renderOrder = 44;
    face.node.add(p.dots);
  }

  /** Where the shape's own origin goes so its anchor sits on the face point, turned by its spin. */
  private placeOnFace(face: { position: THREE.Vector3; quaternion: THREE.Quaternion; id: string | null }, s: PlacementSession) {
    const quaternion = face.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(s.spin ?? 0)));
    const a = s.anchor ? new THREE.Vector3(s.anchor.x, s.anchor.y, s.anchor.z) : new THREE.Vector3();
    return { position: face.position.clone().sub(a.applyQuaternion(quaternion)), quaternion, id: face.id };
  }

  /** The hit object's snap point nearest the pointer that lies on this face, if close on screen. */
  private snapOnFace(id: string, node: THREE.Object3D, local: THREE.Vector3, normal: THREE.Vector3, sx: number, sy: number): THREE.Vector3 | null {
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    let best: THREE.Vector3 | null = null;
    let bestPx = 14;
    for (const p of this.snapPointsOf(id, node)) {
      if (Math.abs(p.clone().sub(local).dot(normal)) > 0.01) continue; // Not on this face's plane.
      const v = p.clone().applyMatrix4(node.matrixWorld).project(this.camera);
      const px = Math.hypot(((v.x + 1) / 2) * w - sx, ((1 - v.y) / 2) * h - sy);
      if (px < bestPx) {
        bestPx = px;
        best = p;
      }
    }
    return best;
  }

  // ---- Snap points ----------------------------------------------------------

  /**
   * Snap points in an object's own frame. Round shapes get points that lie on
   * them (centres, and the four sides of each circle); everything else gets the
   * corners, edge middles, face centres and centre of its box.
   */
  private snapPointsOf(id: string, node: THREE.Object3D): THREE.Vector3[] {
    // Split pieces use their (cut) box; the shape-specific points may be gone.
    const own = this.features.get(id);
    const f = own?.clips?.length || (own && isTilted(own)) ? undefined : own;
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    if (f?.kind === "cylinder") {
      const { radius: rx, radiusY: ry, height: h } = f.params;
      return [0, h / 2, h].flatMap((z) => [V(0, 0, z), V(rx, 0, z), V(-rx, 0, z), V(0, ry, z), V(0, -ry, z)]);
    }
    if (f?.kind === "cone" || f?.kind === "tube") {
      const { radius: r, height: h } = f.params;
      const top = f.kind === "cone" ? f.params.topRadius : r;
      const ring = (rad: number, z: number) => (rad > 0 ? [V(rad, 0, z), V(-rad, 0, z), V(0, rad, z), V(0, -rad, z)] : []);
      return [V(0, 0, 0), V(0, 0, h), ...ring(r, 0), ...ring(top, h)];
    }
    if (f?.kind === "torus") {
      const { radius: r, tube: t } = f.params;
      return [V(0, 0, t), V(r, 0, t), V(-r, 0, t), V(0, r, t), V(0, -r, t)];
    }
    if (f?.kind === "hedron") {
      // Corners, face centres and the middle.
      const { vertices, faces } = hedron(f.params.faces, f.params.radius);
      const mid = (pts: number[][]) => V(...([0, 1, 2].map((i) => pts.reduce((s, p) => s + p[i], 0) / pts.length) as [number, number, number]));
      return [...vertices.map((v) => V(...v)), ...faces.map(mid), mid(vertices)];
    }
    if (f?.kind === "prism") {
      const h = f.params.height;
      const corners = prismPoints(f.params.radius, f.params.sides);
      return [0, h].flatMap((z) => [V(0, 0, z), ...corners.map(([x, y]) => V(x, y, z))]);
    }
    if (f?.kind === "sphere") {
      const { radius: x, radiusY: y, radiusZ: z } = f.params;
      return [V(0, 0, z), V(x, 0, z), V(-x, 0, z), V(0, y, z), V(0, -y, z), V(0, 0, 0), V(0, 0, 2 * z)];
    }
    const box = this.localBox(id, node);
    if (!box) return [];
    const { min, max } = box;
    const pick = (a: number, b: number) => [a, (a + b) / 2, b];
    const pts: THREE.Vector3[] = [];
    for (const x of pick(min.x, max.x)) for (const y of pick(min.y, max.y)) for (const z of pick(min.z, max.z)) pts.push(new THREE.Vector3(x, y, z));
    // Flat shapes (planes) would repeat points; keep each once.
    return pts.filter((p, i) => pts.findIndex((q) => q.distanceToSquared(p) < 1e-10) === i);
  }

  private showsSnapPoints(): boolean {
    return this.pointSnap && !this.placement && this.gizmo.mode === "translate" && !!this.selectedId && !this.combined && !this.sketch && !this.edgePick && !this.sculpt;
  }

  /** Ids of a node and everything under it (they move together). */
  private movingIds(node: THREE.Object3D): Set<string> {
    const ids = new Set<string>();
    node.traverse((o) => o.userData.id && ids.add(o.userData.id));
    return ids;
  }

  /** Dots on the selected object (orange) and on everything it can snap to. */
  private drawSnapDots() {
    for (const d of this.snapDots) {
      d.removeFromParent();
      d.geometry.dispose();
    }
    this.snapDots = [];
    const selected = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
    if (!this.showsSnapPoints() || !this.showPoints || !selected) return;
    const moving = this.movingIds(selected);
    for (const n of this.groupFollowers()) this.movingIds(n).forEach((x) => moving.add(x));
    for (const [id, node] of this.nodes) {
      const own = id === this.selectedId;
      // Groups only get dots when they're the thing being moved; otherwise their children have them.
      if (!own && (moving.has(id) || this.features.get(id)?.kind === "group" || !isShown(node))) continue;
      const pts = this.snapPointsOf(id, node);
      if (!pts.length) continue;
      const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), own ? DOT_MATERIALS.own : DOT_MATERIALS.other);
      dots.renderOrder = own ? 45 : 44;
      node.add(dots);
      this.snapDots.push(dots);
    }
  }

  private startPointDrag() {
    this.pointDrag = null;
    const obj = this.gizmo.object;
    if (obj === this.pivotProxy) return this.startPivotDrag();
    if (!obj || obj === this.jointProxy || obj === this.cutProxy || !this.showsSnapPoints()) return;
    this.root.updateMatrixWorld(true);
    const moving = this.movingIds(obj);
    for (const n of this.groupFollowers()) this.movingIds(n).forEach((x) => moving.add(x));
    const targets: THREE.Vector3[] = [];
    for (const [id, node] of this.nodes) {
      if (moving.has(id) || this.features.get(id)?.kind === "group" || !isShown(node)) continue;
      for (const p of this.snapPointsOf(id, node)) targets.push(p.applyMatrix4(node.matrixWorld));
    }
    this.pointDrag = { local: this.snapPointsOf(obj.userData.id, obj), targets, snapped: false };
  }

  /**
   * After the gizmo moves the object: if one of its points is within a few pixels
   * of another object's point (along the axes being dragged), slide it there.
   */
  private snapToPoints(obj: THREE.Object3D) {
    const drag = this.pointDrag;
    if (!drag) return;
    drag.snapped = false;
    obj.updateMatrixWorld(true);
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    const toScreen = (p: THREE.Vector3) => {
      const v = p.clone().project(this.camera);
      return new THREE.Vector2(((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h);
    };
    // Only move along the axes the handle allows (the centre handle moves freely).
    const handle = this.gizmo.axis ?? "XYZ";
    const free = handle === "XYZ";
    // On its own axes, the handles point along the object's turned axes.
    const turn = this.gizmo.space === "local" ? obj.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    const axes = free ? [] : [...handle].map((a) => new THREE.Vector3(a === "X" ? 1 : 0, a === "Y" ? 1 : 0, a === "Z" ? 1 : 0).applyQuaternion(turn));
    const constrain = (d: THREE.Vector3) => (free ? d.clone() : axes.reduce((acc, u) => acc.addScaledVector(u, d.dot(u)), new THREE.Vector3()));

    const RADIUS = 10; // pixels
    let best: { move: THREE.Vector3; from: THREE.Vector3; to: THREE.Vector3; px: number } | null = null;
    const targetsOnScreen = drag.targets.map(toScreen);
    for (const p of drag.local) {
      const from = p.clone().applyMatrix4(obj.matrixWorld);
      const fromScreen = toScreen(from);
      drag.targets.forEach((to, i) => {
        // Free moves must land on the point; axis moves just line up with it.
        if (free && fromScreen.distanceTo(targetsOnScreen[i]) > RADIUS) return;
        const move = constrain(to.clone().sub(from));
        const px = fromScreen.distanceTo(toScreen(from.clone().add(move)));
        if (px <= RADIUS && (!best || px < best.px - 1e-6 || (Math.abs(px - best.px) < 1e-6 && from.distanceToSquared(to) < best.from.distanceToSquared(best.to)))) best = { move, from, to, px };
      });
    }
    const hit = best as { move: THREE.Vector3; from: THREE.Vector3; to: THREE.Vector3; px: number } | null;
    if (!hit) {
      this.showSnapHint(null);
      return;
    }
    const world = obj.getWorldPosition(new THREE.Vector3()).add(hit.move);
    obj.position.copy(obj.parent ? obj.parent.worldToLocal(world) : world);
    obj.updateMatrixWorld(true);
    drag.snapped = true;
    this.showSnapHint(hit.from.clone().add(hit.move), hit.to);
  }

  /** Highlight the matched points: a big dot on each and a guide line between them. */
  private showSnapHint(from: THREE.Vector3 | null, to?: THREE.Vector3) {
    for (const c of this.snapHint.children) (c as THREE.Points | THREE.Line).geometry.dispose();
    this.snapHint.clear();
    if (!from || !to) return;
    const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints([from, to]), DOT_MATERIALS.match);
    dots.renderOrder = 46;
    this.snapHint.add(dots);
    if (from.distanceTo(to) > 1e-6) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), DOT_MATERIALS.guide);
      line.computeLineDistances();
      line.renderOrder = 46;
      this.snapHint.add(line);
    }
  }

  // ---- Resize ruler --------------------------------------------------------

  /** The object's extents in its own frame: exact for primitives, else from its meshes. */
  private localBox(id: string, node: THREE.Object3D): THREE.Box3 | null {
    const f = this.features.get(id);
    const exact = f && featureExtents(f);
    if (exact) return new THREE.Box3(new THREE.Vector3(exact[0].x, exact[0].y, exact[0].z), new THREE.Vector3(exact[1].x, exact[1].y, exact[1].z));
    const own = node.children.filter((c) => c instanceof THREE.Mesh && c.userData.id === id);
    const meshes: THREE.Object3D[] = own.length ? own : [];
    if (!own.length) node.traverse((o) => o !== node && o instanceof THREE.Mesh && o.userData.id && meshes.push(o));
    const box = new THREE.Box3();
    const toNode = new THREE.Matrix4().copy(node.matrixWorld).invert();
    for (const m of meshes) {
      const mesh = m as THREE.Mesh;
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toNode, mesh.matrixWorld)));
    }
    return box.isEmpty() ? null : box;
  }

  /** Dimension lines along the selected object's X, Y and Z, while in Resize mode. */
  private drawRuler() {
    disposeTree(this.ruler);
    this.ruler.clear();
    this.ruler.removeFromParent();
    this.rulerSpan = null;
    const id = this.selectedId;
    const node = id ? this.nodes.get(id) : undefined;
    const show = this.gizmo.mode === "scale" && node && !this.combined && !this.sketch && !this.edgePick && !this.sculpt;
    const box = show ? this.localBox(id!, node!) : null;
    if (!show || !box) {
      this.rulerLabels.forEach((l) => (l.hidden = true));
      return;
    }
    const { min, max } = box;
    const size = box.getSize(new THREE.Vector3());
    const off = Math.max(2, 0.12 * Math.max(size.x, size.y, size.z));
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const tick = off * 0.35;
    const axes = [
      // X along the front-bottom edge, Y along the right-bottom edge, Z up the front-right corner.
      { color: 0xe5484d, a: V(min.x, min.y - off, min.z), b: V(max.x, min.y - off, min.z), ext: [[V(min.x, min.y, min.z), V(min.x, min.y - off - tick, min.z)], [V(max.x, min.y, min.z), V(max.x, min.y - off - tick, min.z)]] },
      { color: 0x30a46c, a: V(max.x + off, min.y, min.z), b: V(max.x + off, max.y, min.z), ext: [[V(max.x, min.y, min.z), V(max.x + off + tick, min.y, min.z)], [V(max.x, max.y, min.z), V(max.x + off + tick, max.y, min.z)]] },
      { color: 0x3e7bfa, a: V(max.x + off, min.y - off, min.z), b: V(max.x + off, min.y - off, max.z), ext: [[V(max.x, min.y, max.z), V(max.x + off, min.y - off, max.z)]] },
    ];
    for (const ax of axes) {
      const pts = [ax.a, ax.b, ...ax.ext.flat()];
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: ax.color, depthTest: false, transparent: true }));
      lines.renderOrder = 40;
      this.ruler.add(lines);
    }
    node!.add(this.ruler);
    this.rulerSpan = {
      node: node!,
      mids: axes.map((ax) => ax.a.clone().add(ax.b).multiplyScalar(0.5)),
      lengths: [size.x, size.y, size.z],
    };
  }

  /** Keep the ruler labels on their lines (and their values live while dragging). */
  private updateRulerLabels() {
    const span = this.rulerSpan;
    if (!span) return;
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    const scale = [span.node.scale.x, span.node.scale.y, span.node.scale.z];
    const names = ["X", "Y", "Z"];
    span.mids.forEach((mid, i) => {
      const label = this.rulerLabels[i];
      const length = span.lengths[i] * scale[i];
      const p = span.node.localToWorld(mid.clone()).project(this.camera);
      label.hidden = length < 1e-6 || p.z > 1;
      if (label.hidden) return;
      label.textContent = `${names[i]} ${rulerLength(length, this.snap).toFixed(2)} mm`;
      label.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -50%)`;
    });
  }

  /** In One side mode, work out which face stays fixed for the handle just grabbed. */
  private startResizeAnchor() {
    this.resizeAnchor = null;
    const obj = this.gizmo.object;
    const handle = this.gizmo.axis;
    if (!obj || !this.oneSide || this.gizmo.mode !== "scale" || (handle !== "X" && handle !== "Y" && handle !== "Z")) return;
    const box = this.localBox(obj.userData.id, obj);
    if (!box) return;
    const axis = handle.toLowerCase() as "x" | "y" | "z";
    // Each axis has a handle on both ends; the grab point says which end this is.
    // pointStart (grab point relative to the object, world axes) is set by the gizmo but not in its types.
    const grab = (this.gizmo as unknown as { pointStart: THREE.Vector3 }).pointStart.clone().applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()).invert());
    if (this.features.get(obj.userData.id)?.mirrored) grab.x = -grab.x; // Into its own (flipped) frame.
    const at = grab[axis] >= 0 ? box.min[axis] : box.max[axis];
    this.resizeAnchor = { axis, at, start: obj.position.clone() };
  }

  private commitDrag() {
    const obj = this.gizmo.object;
    if (!obj) return;
    if (obj === this.jointProxy && this.jointDrag) {
      this.events.onJointMoved(this.jointDrag.id, this.jointDrag.value);
      return;
    }
    if (obj === this.pivotProxy && this.pivotFor) {
      const mm = (v: number) => (this.pointDrag?.snapped || !this.snap ? Math.round(v * 1e4) / 1e4 : Math.round(v / this.snap) * this.snap) + 0;
      this.events.onPivotMoved(this.pivotFor, { x: mm(obj.position.x), y: mm(obj.position.y), z: mm(obj.position.z) });
      return;
    }
    if (obj === this.cutProxy && this.cutHandle) {
      this.cutHandle.onDone(this.cutHandle.at);
      return;
    }
    if (this.gizmo.mode === "scale") {
      // Sizes are baked into the object's dimensions, so the node itself never stays stretched.
      const flip = this.features.get(obj.userData.id)?.mirrored ? -1 : 1;
      const s = { x: Math.abs(obj.scale.x), y: obj.scale.y, z: obj.scale.z };
      const anchor = this.resizeAnchor;
      this.resizeAnchor = null;
      obj.scale.set(flip, 1, 1);
      if (anchor) obj.position.copy(anchor.start);
      if (Math.abs(s.x - 1) > 1e-4 || Math.abs(s.y - 1) > 1e-4 || Math.abs(s.z - 1) > 1e-4) {
        const dir = new THREE.Vector3();
        dir[anchor?.axis ?? "x"] = anchor?.axis === "x" ? flip : 1;
        dir.applyQuaternion(obj.quaternion);
        this.events.onResized(obj.userData.id, s, anchor ? { axis: anchor.axis, at: anchor.at, dir: { x: dir.x, y: dir.y, z: dir.z } } : undefined);
      }
      return;
    }
    // A point snap lands exactly on another object, which needn't be on the grid. On its own
    // axes the gizmo already snapped the move along them; rounding to the world grid would undo that.
    const grid = this.snap > 0 && !this.pointDrag?.snapped && this.gizmo.space !== "local" ? this.snap : 0;
    const round = (v: number) => (grid > 0 ? Math.round(v / grid) * grid : Math.round(v * 1e4) / 1e4) + 0;
    const deg = (r: number) => Math.round(THREE.MathUtils.radToDeg(r) * 1e4) / 1e4 + 0;
    const p = obj.position;
    const r = obj.rotation;
    this.events.onTransformed(obj.userData.id, { x: round(p.x), y: round(p.y), z: round(p.z) }, { x: deg(r.x), y: deg(r.y), z: deg(r.z) });
  }

  private ndc(e: MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private pick(e: MouseEvent): string | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    // The raycaster doesn't skip hidden objects by itself.
    const hit = this.raycaster.intersectObject(this.root, true).find((h) => h.object instanceof THREE.Mesh && h.object.userData.id && isShown(h.object));
    return (hit?.object.userData.id as string | undefined) ?? null;
  }

  private setupPointer() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    let panFrom: THREE.Vector3 | null = null;
    let panned = false;

    el.addEventListener("contextmenu", (e) => (this.sketch || this.placement) && e.preventDefault());

    el.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY };
      if (!this.sketch) return;
      if (e.button === 2 || e.button === 1) {
        panFrom = this.rayToPlane(e);
        panned = false;
        el.setPointerCapture(e.pointerId);
      } else if (e.button === 0) {
        const p = this.toSketch("down", e);
        if (p) this.sketch.handler(p);
      }
    });

    el.addEventListener("pointermove", (e) => {
      if (this.placement) {
        if (!e.buttons) this.placementHover(e.clientX, e.clientY);
        return;
      }
      if (this.measure && !e.buttons) {
        this.drawMeasure(this.measure.points.length < 2 ? this.measurePoint(e) : null);
        return;
      }
      if (this.edgePick) {
        const g = e.buttons ? -1 : this.edgeAt(e);
        if (g !== this.hoverEdge) {
          this.hoverEdge = g;
          this.drawEdgeOverlay();
        }
        el.style.cursor = g >= 0 ? "pointer" : "";
        return;
      }
      if (!this.sketch) return;
      if (panFrom) {
        const now = this.rayToPlane(e);
        if (now) {
          const delta = panFrom.clone().sub(now);
          this.camera.position.add(delta);
        }
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) panned = true;
        return;
      }
      const p = this.toSketch("move", e);
      if (p) this.sketch.handler(p);
    });

    el.addEventListener("pointerup", (e) => {
      if (this.sketch) {
        if (panFrom) {
          panFrom = null;
          // A right-click without dragging opens the context menu.
          if (!panned && e.button === 2) {
            const p = this.toSketch("context", e);
            if (p) this.sketch.handler(p);
          }
          return;
        }
        const p = this.toSketch("up", e);
        if (p && e.button === 0) this.sketch.handler(p);
        return;
      }
      if (this.placement) {
        // A click puts the shape down (a drag just orbits); a right-click cancels.
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        if (e.button === 2) this.cancelPlacement();
        else if (e.button === 0) this.placementDrop(e.clientX, e.clientY);
        return;
      }
      // Ignore drags (orbiting) and clicks that land on the gizmo.
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || this.gizmo.dragging || this.gizmo.axis) return;
      if (e.button !== 0 || this.sculpt) return;
      if (this.measure) return this.measureClick(e);
      if (this.edgePick) {
        const g = this.edgeAt(e);
        const lines = this.edgeLines();
        if (g >= 0 && lines) {
          const groups = lines.userData.groups as Int32Array;
          const pos = (lines.geometry.getAttribute("position") as THREE.BufferAttribute).array;
          this.edgePick.onPick(edgePoint(pos, groups[3 * g], groups[3 * g + 1]));
        }
        return;
      }
      const id = this.combined ? null : this.pick(e);
      this.events.onSelect(id, e.shiftKey || e.ctrlKey || e.metaKey);
    });

    el.addEventListener("dblclick", (e) => {
      if (this.placement) return;
      if (this.sketch) {
        const p = this.toSketch("dblclick", e);
        if (p) this.sketch.handler(p);
        return;
      }
      const id = this.combined ? null : this.pick(e);
      if (id) this.events.onOpen(id);
    });

    // In sketch mode, zoom towards the cursor while staying square to the plane.
    el.addEventListener(
      "wheel",
      (e) => {
        if (!this.sketch) return;
        e.preventDefault();
        const p = this.rayToPlane(e);
        if (!p) return;
        const factor = Math.pow(1.0015, e.deltaY);
        const next = this.camera.position.clone().sub(p).multiplyScalar(factor).add(p);
        if (next.distanceTo(p) > 2 && next.distanceTo(p) < 5000) this.camera.position.copy(next);
      },
      { passive: false },
    );
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();
    this.orthoFrustum((this.orthoCamera.top - this.orthoCamera.bottom) / 2 || 60);
  }
}

/** Draw a floor line set in the given order (before objects), without writing depth. */
function floorLayer<T extends THREE.Object3D>(obj: T, order: number): T {
  obj.renderOrder = order;
  obj.traverse((o) => {
    const m = (o as THREE.Line).material as THREE.Material | THREE.Material[] | undefined;
    for (const mat of m ? (Array.isArray(m) ? m : [m]) : []) mat.depthWrite = false;
  });
  return obj;
}

/** A grid in the XY plane. `onTop` keeps it from being hidden behind ghosted parts. */
function makeGrid(size: number, divisions: number, major: number, minor: number, z: number, onTop = false) {
  const grid = new THREE.GridHelper(size, divisions, major, minor);
  grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ.
  grid.position.z = z;
  if (onTop) {
    (grid.material as THREE.Material).depthTest = false;
    grid.renderOrder = -1;
  }
  return grid;
}

/**
 * A sculpt's mesh. One made from CAD geometry (an imported STL/3MF, or a
 * converted shape) is drawn like the other CAD objects: sharp edges kept and
 * outlined. While it's being sculpted (`sharp` false) it's plain clay.
 */
function buildSculptMesh(f: Extract<Feature, { kind: "sculpt" }>, sharp = true) {
  const cad = sharp && isCadMesh(f.params);
  const mesh = new THREE.Mesh(
    cad ? creasedGeometry(f.params) : sculptGeometry(f.params),
    new THREE.MeshStandardMaterial({ color: COLORS.solid, roughness: cad ? 0.6 : 0.55, metalness: 0.05, polygonOffset: cad, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
  );
  mesh.userData.id = f.id;
  mesh.userData.sculpt = true;
  if (cad) {
    mesh.userData.creased = true;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), new THREE.LineBasicMaterial({ color: scenePalette().edge }));
    edges.userData.meshEdges = true;
    mesh.add(edges);
  }
  return mesh;
}

/** A translucent square with an outline, showing a reference plane. */
function buildPlane(id: string, size: number) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ color: COLORS.plane, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.userData.id = id;
  const h = size / 2;
  const edge = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-h, -h, 0), new THREE.Vector3(h, -h, 0), new THREE.Vector3(h, h, 0), new THREE.Vector3(-h, h, 0), new THREE.Vector3(-h, -h, 0),
  ]);
  mesh.add(new THREE.Line(edge, new THREE.LineBasicMaterial({ color: COLORS.plane })));
  return mesh;
}

/**
 * A sketch that hasn't been extruded yet: its outlines as lines, plus a faint
 * fill of its closed shapes so it can be clicked and moved like other objects.
 */
function buildFlatSketch(f: Extract<Feature, { kind: "sketch" }>): THREE.Object3D[] {
  const frame = planeMatrix(f.params);
  const out: THREE.Object3D[] = [];
  const lineMat = new THREE.LineBasicMaterial({ color: scenePalette().sketchAdd });
  const guideMat = new THREE.LineDashedMaterial({ color: scenePalette().sketchConstruction, dashSize: 1.5, gapSize: 1 });
  for (const e of f.params.entities) {
    const pts = outline(e);
    if (!pts.length) continue;
    const guide = e.mode === "construction";
    if (pts.length === 1) {
      const dot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(pts[0][0], pts[0][1], 0)]), new THREE.PointsMaterial({ color: scenePalette().sketchConstruction, size: 5, sizeAttenuation: false }));
      dot.geometry.applyMatrix4(frame);
      out.push(dot);
      continue;
    }
    const closed = isClosed(e);
    const geom = new THREE.BufferGeometry().setFromPoints([...pts, ...(closed ? [pts[0]] : [])].map(([x, y]) => new THREE.Vector3(x, y, 0)));
    geom.applyMatrix4(frame);
    const line = new THREE.Line(geom, guide ? guideMat : lineMat);
    if (guide) line.computeLineDistances();
    out.push(line);
    if (closed && !guide && pts.length >= 3) {
      const fill = new THREE.Mesh(
        new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)))),
        new THREE.MeshBasicMaterial({ color: COLORS.solid, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
      );
      fill.geometry.applyMatrix4(frame);
      fill.userData.id = f.id;
      fill.userData.flat = true;
      out.push(fill);
    }
  }
  return out;
}

function buildMesh(data: MeshData, isHole: boolean) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.vertices, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.triangles, 1));
  const material = new THREE.MeshStandardMaterial({
    color: isHole ? COLORS.hole : COLORS.solid,
    roughness: 0.6,
    metalness: 0.05,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const edgeGeom = new THREE.BufferGeometry();
  edgeGeom.setAttribute("position", new THREE.BufferAttribute(data.edges, 3));
  const edges = new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({ color: scenePalette().edge }));
  edges.userData.groups = data.edgeGroups;
  mesh.add(edges);
  return mesh;
}

function ghostMaterial() {
  return new THREE.MeshStandardMaterial({ color: COLORS.selected, transparent: true, opacity: 0.45, depthWrite: false, roughness: 0.6 });
}

/** Make a mesh see-through for the placement preview. */
function ghostify(mesh: THREE.Mesh): THREE.Mesh {
  (mesh.material as THREE.Material).dispose();
  mesh.material = ghostMaterial();
  delete mesh.userData.id;
  return mesh;
}

/** Is this object drawn, i.e. neither it nor anything it sits in is hidden? */
function isShown(obj: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** A round dot, optionally with a dark rim so it reads on any background; the material colour tints the fill. */
function dotTexture(rim: boolean): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.beginPath();
  g.arc(16, 16, 12, 0, Math.PI * 2);
  g.fillStyle = "#fff";
  g.fill();
  if (rim) {
    g.lineWidth = 4;
    g.strokeStyle = "#1a1a1a";
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The object face under the pointer while placing, in that object's own frame. */
interface PlacementFace {
  id: string;
  node: THREE.Object3D;
  normal: THREE.Vector3;
  /** Where the pointer hit the face (before snapping). */
  point: THREE.Vector3;
  snapped: boolean;
}

const DOT_MATERIALS = (() => {
  const rimmed = dotTexture(true);
  const plain = dotTexture(false);
  const dot = (color: number, size: number, opacity = 1, map = rimmed) =>
    new THREE.PointsMaterial({ color, size, map, sizeAttenuation: false, transparent: true, opacity, alphaTest: 0.2, depthTest: false });
  return {
    own: dot(0x8c8c8c, 7, 0.9, plain),
    other: dot(0xbdbdbd, 7, 0.6),
    match: dot(0xff3d9a, 14),
    measure: dot(0xff3d9a, 11),
    guide: new THREE.LineDashedMaterial({ color: 0xff3d9a, dashSize: 1.5, gapSize: 1, depthTest: false, transparent: true }),
  };
})();

function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
      if (!o.userData.shared) o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
}
