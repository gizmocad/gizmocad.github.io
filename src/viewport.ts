// The 3D view: Z-up scene, workplane grid, orbit camera, picking and a move gizmo.
// Features are mirrored as a THREE hierarchy, so moving a parent moves its children.
// In sketch mode the camera looks straight at the sketch plane and pointer
// events are reported in sketch coordinates instead of picking objects.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { MeshData } from "./kernel";
import { scenePalette } from "./theme";
import { PLANE_ROTATIONS, baseMatrix, clampJoint, colourOf, jointMatrix, localMatrix, sweepOf, worldMatrix, type Feature, type Joint, type SketchEntity, type SketchParams, type Vec3 } from "./model";
import { featureExtents, isTilted, rulerLength, staysRound, type ResizeAnchor } from "./resize";
import { bounds, isClosed, outline, prismPoints, sketchRegion } from "./sketchGeometry";
import { hedron } from "./hedron";
import { SculptMesh, creasedGeometry, isCadMesh, sculptGeometry, type BrushSettings } from "./sculpt";
import { ViewCube } from "./viewCube";
import { parseLength } from "./units";

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
  /** A resize drag finished (`exact`: a size typed on the ruler, not snapped to the grid). */
  onResized(id: string, scale: Vec3, anchor?: ResizeAnchor | ResizeAnchor[], exact?: boolean): void;
  /** While turning/sliding a connected object by its joint: the joint's value (degrees or mm). */
  onJointMoving(id: string, value: number): void;
  /** A joint drag finished. */
  onJointMoved(id: string, value: number): void;
  /** One end of a swept clearance cut's swing (or slide) was dragged to a new value. */
  onSweepMoved(id: string, end: "from" | "to", value: number): void;
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

/** Methods the drawing loop itself calls every frame (they mustn't count as changes). */
const RENDER_LOOP = new Set(["stepViewTurn", "stepViewFly", "updateMeasureLabel", "updateRulerLabels", "viewMoved", "rememberView", "invalidate"]);

export class Viewport {
  private needsRender = true;
  private lastView: { camera: THREE.Camera; matrix: number[]; projection: number[]; width: number; height: number } | null = null;
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
  /** See-through view: everything faint with every edge showing ("xray"), or drawn as its triangles ("wire"). */
  private seeThrough: "off" | "xray" | "wire" = "off";
  /** The print bed outline. */
  private bedGroup = new THREE.Group();
  /** Camera flying to fit objects in view. */
  private viewFly: { from: THREE.Vector3; to: THREE.Vector3; fromDist: number; toDist: number; fromZoom: number; toZoom: number; start: number } | null = null;
  private boxSelect: { x: number; y: number; el: HTMLDivElement } | null = null;
  /** While dragging a selection box: what it would select, highlighted already. */
  private boxPreview = new Set<string>();
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
  /** Set when a one-sided resize drag starts: the fixed face (from the gizmo, and in the object's own frame), and where the gizmo started. */
  private resizeAnchor: { axis: "x" | "y" | "z"; at: number; own: number; start: THREE.Vector3 } | null = null;
  private shiftHeld = false;
  /** Dimension lines shown on the selected object while resizing, and their labels. */
  private ruler = new THREE.Group();
  private rulerSpan: { node: THREE.Object3D; mids: THREE.Vector3[]; lengths: number[] } | null = null;
  // Filled in the constructor; empty until then because the theme setup redraws early.
  private rulerLabels: HTMLDivElement[] = [];
  /** The ruler label being typed into, if any. */
  private rulerEditing: HTMLDivElement | null = null;
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
  /** Stand-in the gizmo moves for a sketch: it sits on the sketch's shapes (its origin can be well away from them), and the sketch follows it. */
  private moveProxy = new THREE.Object3D();
  private moveFor: { id: string; node: THREE.Object3D; centre: THREE.Vector3; start: { proxy: THREE.Matrix4; node: THREE.Matrix4 } | null } | null = null;
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
        this.events.onResizing(this.heldNode(obj).userData.id, { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z });
        obj.scale.x *= flip;
      }
      if (obj && obj === this.moveProxy) this.followProxy();
    });
    this.gizmo.addEventListener("mouseDown", () => {
      this.startProxyDrag();
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
      el.title = "Click to type a size";
      el.onpointerdown = (e) => e.stopPropagation();
      el.onclick = () => this.editRuler(el, "xyz".indexOf(axis));
      container.appendChild(el);
      return el;
    });
    window.addEventListener("keydown", (e) => e.key === "Shift" && (this.shiftHeld = true));
    window.addEventListener("keyup", (e) => e.key === "Shift" && (this.shiftHeld = false));
    window.addEventListener("blur", () => (this.shiftHeld = false));

    this.setupPointer();
    this.setupSculptPointer();
    this.setupSwingPointer();
    this.setupChiselPointer();
    this.setupFacePickPointer();
    this.setupBoxSelect();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    // Drawn only when something may have changed: the view sits idle otherwise
    // (redrawing a big model 60 times a second keeps the computer busy for nothing).
    for (const type of ["pointerdown", "pointermove", "pointerup", "wheel", "keydown", "keyup", "dragover", "drop"]) {
      window.addEventListener(type, () => (this.needsRender = true), { capture: true, passive: true });
    }
    // Every call from the app (new meshes, selection, theme, tools…) may change what's shown.
    for (const name of Object.getOwnPropertyNames(Viewport.prototype)) {
      const method = Object.getOwnPropertyDescriptor(Viewport.prototype, name)?.value;
      if (name === "constructor" || typeof method !== "function" || RENDER_LOOP.has(name)) continue;
      (this as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        this.needsRender = true;
        return (method as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
    this.renderer.setAnimationLoop(() => {
      if (!this.sketch) {
        this.stepViewTurn();
        this.stepViewFly();
        this.orbit.update();
      }
      if (!this.needsRender && !this.viewTurn && !this.viewFly && !this.viewMoved()) return;
      this.needsRender = false;
      this.rememberView();
      this.updateMeasureLabel();
      this.updateRulerLabels();
      this.renderer.render(this.scene, this.camera);
      this.viewCube.render(this.camera, this.orbit.target);
    });
  }

  /** Redraw on the next frame (for changes made from outside, such as the sketch editor's drawing). */
  invalidate() {
    this.needsRender = true;
  }

  /**
   * Whether the camera moved visibly since the last drawing. The orbit's easing
   * keeps nudging it by invisible amounts (thousandths of a pixel) for seconds,
   * so tiny changes don't count.
   */
  private viewMoved(): boolean {
    const c = this.camera;
    c.updateMatrixWorld();
    const last = this.lastView;
    const el = this.renderer.domElement;
    if (!last || last.camera !== c || last.width !== el.clientWidth || last.height !== el.clientHeight) return true;
    const a = c.matrixWorld.elements;
    const scale = Math.max(1e-6, c.position.distanceTo(this.orbit.target));
    for (let i = 0; i < 16; i++) {
      const tolerance = i >= 12 ? 2e-5 * scale : 2e-5; // Its position (relative to how far away it looks), then its turn.
      if (Math.abs(a[i] - last.matrix[i]) > tolerance) return true;
    }
    const p = c.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(p[i] - last.projection[i]) > 1e-5 * Math.max(1, Math.abs(p[i]))) return true;
    return false;
  }

  private rememberView() {
    const el = this.renderer.domElement;
    this.lastView = { camera: this.camera, matrix: [...this.camera.matrixWorld.elements], projection: [...this.camera.projectionMatrix.elements], width: el.clientWidth, height: el.clientHeight };
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
    const obj = this.gizmo.object;
    if (obj && (obj === this.moveProxy || obj === this.nodes.get(this.selectedId ?? ""))) this.gizmo.space = on ? "local" : "world";
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
        // Meshes with holes through them came back from the kernel cut; the rest are shown as they are.
        if (f.kind !== "sculpt" || meshes.some((m) => m.id === f.id)) continue;
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
        // A mesh with holes through it comes back from the kernel cut (unless it's being sculpted: then the brushes need its own mesh).
        const sculpting = this.sculpt?.session.id === f.id;
        if (f.kind === "sculpt" && (sculpting || !meshes.some((m) => m.id === f.id))) node.add(buildSculptMesh(f, !sculpting));
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
        if (!f || !node || (f.kind === "sculpt" && this.sculpt?.session.id === f.id)) continue;
        const mesh = buildMesh(data, f.mode === "hole");
        mesh.userData.id = f.id;
        node.add(mesh);
      }
    }
    this.root.updateMatrixWorld(true);
    if (this.printCheckOn) this.drawPrintCheck();
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
    // The print check's marks are 3D: they come back when sketching ends.
    this.printCheckGroup.removeFromParent();
    this.clashGroup.visible = false;
    this.updateSketchFrame(true);
    this.applyAppearance();
  }

  /**
   * Start sketching straight away, without waiting for the next build to draw
   * the scene (a model with big imported parts can take a while, and a failed
   * build would otherwise leave no grid to draw on). The sketch is placed from
   * the model; the build fills in the rest when it's done.
   */
  enterSketchNow(sketch: Feature, features: Feature[], handler: SketchPointerHandler) {
    this.features.set(sketch.id, sketch);
    if (!this.nodes.has(sketch.id)) {
      const node = new THREE.Group();
      node.userData.id = sketch.id;
      node.matrixAutoUpdate = false;
      node.matrix.copy(worldMatrix(features, sketch.id));
      this.root.add(node);
      this.nodes.set(sketch.id, node);
      node.updateMatrixWorld(true);
    }
    this.enterSketch(sketch.id, handler);
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
    this.flattenOntoSketch();
    this.clashGroup.visible = true;
    if (this.printCheckOn) this.drawPrintCheck();
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
    // Where the sketch sits in the model (the model itself is drawn flattened while sketching).
    const world = node.matrix.clone();
    for (let p = node.parent; p && p !== this.root; p = p.parent) world.premultiply(p.matrix);
    this.sketchLayer.matrix.copy(world).multiply(planeMatrix(f.params));
    this.sketchLayer.matrixWorldNeedsUpdate = true;
    this.sketchLayer.updateMatrixWorld(true);
    this.flattenOntoSketch();
    if (!aimCamera) return;

    const origin = new THREE.Vector3().setFromMatrixPosition(this.sketchLayer.matrix);
    const basis = new THREE.Matrix4().extractRotation(this.sketchLayer.matrix);
    const normal = new THREE.Vector3(0, 0, 1).applyMatrix4(basis);
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(basis);
    this.camera.up.copy(up);
    this.camera.position.copy(origin).addScaledVector(normal, 160);
    this.camera.lookAt(origin);
  }

  /**
   * While sketching, the rest of the model is drawn squashed flat onto the
   * sketch's plane, so it reads as 2D outlines to draw against rather than
   * solids. (Not quite zero thickness: lighting needs the matrix invertible.)
   */
  private flattenOntoSketch() {
    this.root.matrixAutoUpdate = false;
    if (this.sketch) {
      const plane = this.sketchLayer.matrix;
      this.root.matrix.copy(plane).multiply(new THREE.Matrix4().makeScale(1, 1, 1e-3)).multiply(plane.clone().invert());
    } else this.root.matrix.identity();
    this.root.updateMatrixWorld(true);
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

  /** Is this object (or anything it's inside) a ghost: see-through, and clicked, placed and snapped through? */
  private isGhost(o: THREE.Object3D): boolean {
    for (let x: THREE.Object3D | null = o; x; x = x.parent) if (x.userData.id && this.features.get(x.userData.id)?.ghost) return true;
    return false;
  }

  /** Shown, and not a ghost: something a click or placement can land on. */
  private solidTarget(o: THREE.Object3D): boolean {
    return isShown(o) && !this.isGhost(o);
  }

  private applyAppearance() {
    const sketchId = this.sketch?.id;
    const see = sketchId || this.sculpt ? "off" : this.seeThrough;
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      // Show result's shapes belong to no one object: they only take the see-through view.
      if (!o.userData.id && this.combined && o.parent === this.root) return this.setLook(o, see === "xray" ? 0.22 : see === "wire" ? 0.45 : 1, see);
      if (!o.userData.id) return;
      const f = this.features.get(o.userData.id);
      const mat = o.material as THREE.MeshStandardMaterial;
      const isHole = f?.mode === "hole";
      const selected = !this.combined && (this.selectedIds.has(o.userData.id) || this.boxPreview.has(o.userData.id));
      const colour = f && colourOf(this.features.values(), f);
      const own = colour ? new THREE.Color(colour).getHex() : COLORS.solid;
      // The sketch being edited shows as its drawing only: its extruded (or revolved) solid is hidden until editing ends.
      o.visible = !(sketchId && o.userData.id === sketchId && !o.userData.flat);
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
      if (sketchId) opacity = 0.1;
      if (this.isGhost(o)) opacity = Math.min(opacity, selected ? 0.35 : 0.2);
      if (see === "xray") opacity = Math.min(opacity, selected ? 0.4 : 0.22);
      if (see === "wire") opacity = Math.min(opacity, selected ? 0.7 : 0.45);
      this.setLook(o, opacity, see);
    });

    let target = !this.combined && !this.sketch && !this.edgePick && !this.sculpt && !this.placement && !this.measure && !this.chisel && this.selectedId ? this.nodes.get(this.selectedId) : undefined;
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
    this.moveProxy.removeFromParent();
    this.moveFor = null;
    if (target && this.cutHandle?.id === f?.id) this.attachCutGizmo(target);
    else if (target && f?.joint && this.userMode === "joint") this.attachJointGizmo(f, f.joint, target);
    else if (target && f?.joint && this.userMode === "pivot") this.attachPivotGizmo(f, f.joint, target);
    else if (target) this.attachObjectGizmo(target, f);
    else this.gizmo.detach();
    this.drawRuler();
    this.drawSnapDots();
    this.drawSection();
    this.drawSwing(target && f ? { f, node: target } : null);
  }

  // ---- Picking one face of an object (lay flat) --------------------------------------------------

  private facePick: { id: string; onPick: (normal: Vec3, point: Vec3, local: Vec3) => void; own: boolean } | null = null;

  /**
   * Wait for a click on object `id`: hands back the clicked face's outward
   * normal and the point (world), and the point in the frame of the mesh hit.
   * `own`: only the object's own shape counts, not what's inside it.
   */
  startFacePick(id: string, onPick: (normal: Vec3, point: Vec3, local: Vec3) => void, own = false) {
    this.facePick = { id, onPick, own };
    this.renderer.domElement.style.cursor = "crosshair";
  }

  stopFacePick() {
    if (!this.facePick) return;
    this.facePick = null;
    this.renderer.domElement.style.cursor = "";
  }

  get pickingFace(): string | null {
    return this.facePick?.id ?? null;
  }

  /** Where object `id` (with what's inside it) would reach if it were placed at `world` instead: its box (world). */
  boundsAt(id: string, world: THREE.Matrix4): THREE.Box3 | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    node.updateMatrixWorld(true);
    // From where it is now to where it would be.
    const move = world.clone().multiply(node.matrixWorld.clone().invert());
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    node.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.userData.id || this.features.get(o.userData.id)?.mode === "hole") return;
      const pos = o.geometry.getAttribute("position");
      const m = move.clone().multiply(o.matrixWorld);
      for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
    });
    return box.isEmpty() ? null : box;
  }

  private setupFacePickPointer() {
    this.container.addEventListener(
      "pointerdown",
      (e) => {
        const fp = this.facePick;
        const node = fp && this.nodes.get(fp.id);
        if (!fp || !node || e.button !== 0 || e.target !== this.renderer.domElement) return;
        this.raycaster.setFromCamera(this.ndc(e), this.camera);
        const hit = this.raycaster.intersectObject(node, true).find((h) => h.object instanceof THREE.Mesh && h.face && isShown(h.object) && (!fp.own || h.object.userData.id === fp.id));
        if (!hit) return;
        e.stopPropagation();
        // The triangle's own normal (not the smoothed one): the face as it is.
        const normal = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld);
        if (normal.dot(this.raycaster.ray.direction) > 0) normal.negate();
        const local = hit.object.worldToLocal(hit.point.clone());
        this.stopFacePick();
        fp.onPick({ x: normal.x, y: normal.y, z: normal.z }, { x: hit.point.x, y: hit.point.y, z: hit.point.z }, { x: local.x, y: local.y, z: local.z });
      },
      true,
    );
  }

  // ---- Chisel: drag across an object's face to carve a groove -------------------------------------

  private chisel: {
    id: string;
    onStroke: (points: Vec3[], normal: Vec3) => void;
    /** The stroke being drawn: on the plane of the face it started on (world). */
    stroke: { plane: THREE.Plane; points: THREE.Vector3[]; line: THREE.Line } | null;
  } | null = null;

  /** Carve object `id`: each drag across its surface hands back the stroke's points and the face's outward normal (world). */
  startChisel(id: string, onStroke: (points: Vec3[], normal: Vec3) => void) {
    this.stopChisel();
    this.chisel = { id, onStroke, stroke: null };
    this.renderer.domElement.style.cursor = "crosshair";
    this.applyAppearance();
  }

  stopChisel() {
    if (!this.chisel) return;
    this.chisel.stroke?.line.removeFromParent();
    if (this.chisel.stroke) disposeTree(this.chisel.stroke.line);
    this.chisel = null;
    this.renderer.domElement.style.cursor = "";
    this.applyAppearance();
  }

  get chiseling(): string | null {
    return this.chisel?.id ?? null;
  }

  private setupChiselPointer() {
    // Capture phase on the container runs before OrbitControls sees the event: a drag on the object carves, elsewhere it turns the view.
    const host = this.container;
    host.addEventListener(
      "pointerdown",
      (e) => {
        const c = this.chisel;
        const node = c && this.nodes.get(c.id);
        if (!c || !node || e.button !== 0 || e.target !== this.renderer.domElement) return;
        this.raycaster.setFromCamera(this.ndc(e), this.camera);
        const hit = this.raycaster.intersectObject(node, true).find((h) => h.object instanceof THREE.Mesh && h.face && isShown(h.object));
        if (!hit) return;
        e.stopPropagation();
        this.renderer.domElement.setPointerCapture(e.pointerId);
        const normal = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld);
        if (normal.dot(this.raycaster.ray.direction) > 0) normal.negate();
        const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff8a00, depthTest: false, transparent: true }));
        line.renderOrder = 34;
        this.scene.add(line);
        c.stroke = { plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point), points: [hit.point.clone()], line };
      },
      true,
    );
    host.addEventListener(
      "pointermove",
      (e) => {
        const st = this.chisel?.stroke;
        if (!st) return;
        e.stopPropagation();
        this.raycaster.setFromCamera(this.ndc(e), this.camera);
        const p = this.raycaster.ray.intersectPlane(st.plane, new THREE.Vector3());
        // A point every half millimetre or so is plenty (the stroke is smoothed into a groove).
        if (!p || p.distanceTo(st.points.at(-1)!) < 0.5) return;
        st.points.push(p);
        st.line.geometry.dispose();
        st.line.geometry = new THREE.BufferGeometry().setFromPoints(st.points);
        this.needsRender = true;
      },
      true,
    );
    const finish = (e: PointerEvent) => {
      const c = this.chisel;
      const st = c?.stroke;
      if (!c || !st) return;
      e.stopPropagation();
      c.stroke = null;
      st.line.removeFromParent();
      disposeTree(st.line);
      this.needsRender = true;
      if (st.points.length < 2) return;
      const v = (p: THREE.Vector3) => ({ x: p.x, y: p.y, z: p.z });
      c.onStroke(st.points.map(v), v(st.plane.normal));
    };
    host.addEventListener("pointerup", finish, true);
    host.addEventListener("pointercancel", finish, true);
  }

  // ---- A swept clearance cut's swing: its arc (or slide), with a handle at each end to drag ----------

  private swing: {
    id: string;
    group: THREE.Group;
    handles: { end: "from" | "to"; mesh: THREE.Mesh }[];
    /** Where a joint value puts the handle, in the group's frame. */
    at: (value: number) => THREE.Vector3;
    /** The joint value nearest a point (in the group's frame), continuing on from `near`. */
    valueAt: (p: THREE.Vector3, near: number) => number;
    axis: THREE.Vector3;
    centre: THREE.Vector3;
    slider: boolean;
    from: number;
    to: number;
    drag: { end: "from" | "to"; plane: THREE.Plane; value: number } | null;
    /** The part that swings (made into this cut), shown moving with the handle being dragged. */
    source: { node: THREE.Object3D; joint: Joint; base: THREE.Matrix4 } | null;
    /** The part's outline at each end of the swing (beside the part, in its parent's frame). */
    outlines: { group: THREE.Group; ends: { end: "from" | "to"; obj: THREE.Object3D }[] } | null;
  } | null = null;

  private drawSwing(sel: { f: Feature; node: THREE.Object3D } | null) {
    const keepDrag = this.swing?.drag && this.swing.id === sel?.f.id ? this.swing.drag : null;
    if (this.swing) {
      this.swing.group.removeFromParent();
      disposeTree(this.swing.group);
      if (this.swing.outlines) {
        this.swing.outlines.group.removeFromParent();
        disposeTree(this.swing.outlines.group);
      }
      this.swing = null;
    }
    const s = sel ? (sweepOf(sel.f) ?? undefined) : undefined;
    if (!sel || !s || this.selectedIds.size > 1) return;
    const { f, node } = sel;
    const j = s.joint;
    // The sweep is kept in the frame the hole had when it was made; the hole may have moved since.
    const frame = new THREE.Matrix4().fromArray(s.frame);
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(localMatrix(f)).multiply(frame.clone().invert());
    (node.parent ?? this.root).add(group);
    const axis = new THREE.Vector3(j.axis.x, j.axis.y, j.axis.z).normalize();
    const o = new THREE.Vector3(j.origin.x, j.origin.y, j.origin.z);
    // The hole's own origin as it was made: where the joint's value put it (its shown shape is the whole swept area).
    const centre = new THREE.Vector3().setFromMatrixPosition(frame);
    const slider = j.type === "slider";
    let at: (v: number) => THREE.Vector3;
    let valueAt: (p: THREE.Vector3, near: number) => number;
    let size: number;
    if (slider) {
      at = (v) => centre.clone().addScaledVector(axis, v - j.value);
      valueAt = (p) => Math.round((j.value + p.clone().sub(centre).dot(axis)) * 10) / 10;
      size = Math.max(1, Math.abs(s.to - s.from) * 0.04);
    } else {
      // Round the axis, through the hole's middle.
      const along = axis.clone().multiplyScalar(centre.clone().sub(o).dot(axis));
      const hub = o.clone().add(along);
      let arm = centre.clone().sub(hub);
      if (arm.length() < 1) arm = new THREE.Vector3(1, 0, 0).cross(axis).lengthSq() > 0.01 ? new THREE.Vector3(1, 0, 0).cross(axis) : new THREE.Vector3(0, 1, 0).cross(axis);
      // On the cut's outer edge: as far out from the axis as its shape reaches.
      let radius = Math.max(arm.length(), 10);
      (node.parent ?? this.root).updateMatrixWorld(true);
      group.updateMatrixWorld(true);
      const toGroup = group.matrixWorld.clone().invert();
      const v = new THREE.Vector3();
      node.traverse((m) => {
        if (!(m instanceof THREE.Mesh) || m.userData.id !== f.id) return;
        const pos = m.geometry.getAttribute("position");
        const toFrame = toGroup.clone().multiply(m.matrixWorld);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(toFrame).sub(hub);
          radius = Math.max(radius, v.sub(axis.clone().multiplyScalar(v.dot(axis))).length());
        }
      });
      arm.setLength(radius);
      at = (v) => hub.clone().add(arm.clone().applyAxisAngle(axis, ((v - j.value) * Math.PI) / 180));
      valueAt = (p, near) => {
        const r = p.clone().sub(hub);
        r.sub(axis.clone().multiplyScalar(r.dot(axis)));
        let angle = (Math.atan2(arm.clone().cross(r).dot(axis), arm.dot(r)) * 180) / Math.PI + j.value;
        // Keep going round (past 180°) rather than jumping back.
        angle += Math.round((near - angle) / 360) * 360;
        return Math.round(angle);
      };
      size = Math.max(1, radius * 0.06);
    }
    const color = 0xff8a00;
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    line.renderOrder = 32;
    group.add(line);
    const handles = (["from", "to"] as const).map((end) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
      mesh.renderOrder = 33;
      mesh.userData.swingEnd = end;
      group.add(mesh);
      return { end, mesh };
    });
    // The part it was made from: recorded on newer cuts; otherwise the jointed part that this cut leaves alone.
    const src = (s.source && this.features.get(s.source)) || [...this.features.values()].find((x) => x.joint && x.ignoreHoles?.includes(f.id));
    const srcNode = src?.joint ? this.nodes.get(src.id) : undefined;
    const source = src?.joint && srcNode ? { node: srcNode, joint: src.joint, base: baseMatrix(src) } : null;
    const outlines = source ? this.swingOutlines(source.node, color) : null;
    this.swing = { id: f.id, group, handles, at, valueAt, axis, centre, slider, from: s.from, to: s.to, drag: keepDrag, source, outlines };
    if (keepDrag) this.swing[keepDrag.end] = keepDrag.value;
    this.placeSwing();
  }

  /** The part's edges (hidden or not), as an outline at each end of the swing. */
  private swingOutlines(node: THREE.Object3D, color: number): NonNullable<NonNullable<typeof this.swing>["outlines"]> | null {
    node.updateMatrixWorld(true);
    const toNode = node.matrixWorld.clone().invert();
    const parts: THREE.BufferGeometry[] = [];
    node.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.userData.id) return;
      const lines = o.children.find((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
      const g = lines ? lines.geometry.clone() : new THREE.EdgesGeometry(o.geometry, 30);
      parts.push(g.applyMatrix4(toNode.clone().multiply((lines ?? o).matrixWorld)));
    });
    if (!parts.length) return null;
    const group = new THREE.Group();
    const material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.55 });
    const ends = (["from", "to"] as const).map((end) => {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      for (const g of parts) {
        const l = new THREE.LineSegments(g, material);
        l.renderOrder = 31;
        l.raycast = () => {}; // Only an outline: clicks go through it.
        obj.add(l);
      }
      group.add(obj);
      return { end, obj };
    });
    (node.parent ?? this.root).add(group);
    return { group, ends };
  }

  /** Show the swinging part at a joint value (its own value puts it back). */
  private poseSource(value: number) {
    const src = this.swing?.source;
    if (!src) return;
    const at = new THREE.Vector3().setFromMatrixPosition(src.base);
    jointMatrix(src.joint, value, at).multiply(src.base.clone()).decompose(src.node.position, src.node.quaternion, new THREE.Vector3());
    this.needsRender = true;
  }

  /** Lay the arc and the handles out for the current range. */
  private placeSwing() {
    const w = this.swing;
    if (!w) return;
    const [lo, hi] = [Math.min(w.from, w.to), Math.max(w.from, w.to)];
    const steps = w.slider ? 1 : Math.max(2, Math.ceil((hi - lo) / 3));
    const pts = Array.from({ length: steps + 1 }, (_, i) => w.at(lo + ((hi - lo) * i) / steps));
    const line = w.group.children[0] as THREE.Line;
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    for (const h of w.handles) h.mesh.position.copy(w.at(w[h.end]));
    w.group.updateMatrixWorld(true);
    const src = w.source;
    if (src && w.outlines) {
      const pos = new THREE.Vector3().setFromMatrixPosition(src.base);
      for (const o of w.outlines.ends) {
        o.obj.matrix.copy(jointMatrix(src.joint, w[o.end], pos).multiply(src.base));
        o.obj.updateMatrixWorld(true);
      }
    }
  }

  private swingHandleAt(e: PointerEvent): { end: "from" | "to"; mesh: THREE.Mesh } | null {
    const w = this.swing;
    if (!w) return null;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hit = this.raycaster.intersectObjects(w.handles.map((h) => h.mesh), false)[0];
    return hit ? w.handles.find((h) => h.mesh === hit.object)! : null;
  }

  private setupSwingPointer() {
    // Capture phase on the container: a handle is grabbed before the camera or the gizmo see the click.
    const host = this.container;
    host.addEventListener(
      "pointerdown",
      (e) => {
        const w = this.swing;
        if (!w || e.button !== 0 || e.target !== this.renderer.domElement) return;
        const h = this.swingHandleAt(e);
        if (!h) return;
        e.stopPropagation();
        this.renderer.domElement.setPointerCapture(e.pointerId);
        // Drag across the plane square to the axis (a hinge), or along the rail facing the camera (a slider).
        const toWorld = w.group.matrixWorld;
        const point = h.mesh.getWorldPosition(new THREE.Vector3());
        const axis = w.axis.clone().transformDirection(toWorld);
        let normal = axis;
        if (w.slider) {
          const view = this.camera.getWorldDirection(new THREE.Vector3());
          normal = axis.clone().cross(view.clone().cross(axis)).normalize();
          if (normal.lengthSq() < 1e-6) normal = view;
        }
        w.drag = { end: h.end, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point), value: w[h.end] };
        this.poseSource(w[h.end]);
      },
      true,
    );
    host.addEventListener(
      "pointermove",
      (e) => {
        const w = this.swing;
        if (!w) return;
        if (!w.drag) {
          if (!e.buttons && e.target === this.renderer.domElement) this.renderer.domElement.style.cursor = this.swingHandleAt(e) ? "grab" : "";
          return;
        }
        e.stopPropagation();
        this.raycaster.setFromCamera(this.ndc(e), this.camera);
        const p = this.raycaster.ray.intersectPlane(w.drag.plane, new THREE.Vector3());
        if (!p) return;
        const value = w.valueAt(p.applyMatrix4(w.group.matrixWorld.clone().invert()), w.drag.value);
        if (value === w.drag.value) return;
        w.drag.value = value;
        w[w.drag.end] = value;
        this.placeSwing();
        this.poseSource(value);
        this.needsRender = true;
      },
      true,
    );
    const finish = () => {
      const w = this.swing;
      if (!w?.drag) return;
      const { end, value } = w.drag;
      w.drag = null;
      // The part stays where it was dragged: the change moves it there for good.
      this.events.onSweepMoved(w.id, end, value);
    };
    host.addEventListener("pointerup", finish, true);
    host.addEventListener("pointercancel", finish, true);
  }

  /** An object's opacity, and the see-through view's wireframe and edges showing through. */
  private setLook(o: THREE.Mesh, opacity: number, see: "off" | "xray" | "wire") {
    const mat = o.material as THREE.MeshStandardMaterial;
    mat.wireframe = see === "wire";
    // Edges behind other objects show too.
    for (const c of o.children) if (c instanceof THREE.LineSegments) (c.material as THREE.Material).depthTest = see === "off";
    mat.opacity = opacity;
    // An opaque material's shader ignores opacity: switching it needs a recompile.
    if (mat.transparent !== opacity < 1) mat.needsUpdate = true;
    mat.transparent = opacity < 1;
    mat.depthWrite = opacity === 1;
  }

  setGizmoMode(mode: GizmoMode) {
    this.userMode = mode;
    this.applyAppearance(); // Re-attaches the gizmo (a connected object's depends on the mode).
  }


  // ---- A sketch's gizmo, on its shapes -----------------------------------------

  /** The gizmo on an object: a sketch's sits on its shapes (its origin can be anywhere), others' on their origin. */
  private attachObjectGizmo(node: THREE.Object3D, f: Feature | undefined) {
    const centre = f?.kind === "sketch" ? sketchCentre(f) : null;
    if (!f || !centre || centre.lengthSq() < 1e-12 || !node.parent) return void this.gizmo.attach(node);
    node.updateMatrix();
    const p = this.moveProxy;
    p.position.copy(centre).applyMatrix4(node.matrix);
    p.quaternion.copy(node.quaternion);
    p.scale.set(1, 1, 1);
    node.parent.add(p);
    p.updateMatrixWorld(true);
    this.moveFor = { id: f.id, node, centre, start: null };
    this.gizmo.attach(p);
  }

  /** What a gizmo drag moves: the sketch for its stand-in, else the dragged node itself. */
  private heldNode(obj: THREE.Object3D): THREE.Object3D {
    return obj === this.moveProxy && this.moveFor ? this.moveFor.node : obj;
  }

  private startProxyDrag() {
    const m = this.moveFor;
    if (!m || this.gizmo.object !== this.moveProxy) return;
    this.moveProxy.updateMatrix();
    m.node.updateMatrix();
    m.start = { proxy: this.moveProxy.matrix.clone(), node: m.node.matrix.clone() };
  }

  /** The sketch follows its stand-in: moved, turned or resized about the middle of its shapes. */
  private followProxy() {
    const m = this.moveFor;
    if (!m?.start) return;
    this.moveProxy.updateMatrix();
    this.moveProxy.matrix.clone().multiply(m.start.proxy.clone().invert()).multiply(m.start.node).decompose(m.node.position, m.node.quaternion, m.node.scale);
  }

  /** Resizing a sketch keeps the middle of its shapes still (and in One side mode, the side held). */
  private sketchAnchors(s: Vec3, held?: { axis: "x" | "y" | "z"; at: number }): ResizeAnchor[] {
    const m = this.moveFor!;
    const flip = this.features.get(m.id)?.mirrored ? -1 : 1;
    return (["x", "y", "z"] as const)
      .filter((axis) => Math.abs(s[axis] - 1) > 1e-4)
      .map((axis) => {
        const dir = new THREE.Vector3();
        dir[axis] = axis === "x" ? flip : 1;
        dir.applyQuaternion(m.node.quaternion);
        return { axis, at: held?.axis === axis ? held.at : m.centre[axis], dir: { x: dir.x, y: dir.y, z: dir.z } };
      });
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
    if (!obj || this.heldNode(obj).userData.id !== this.selectedId || this.gizmo.mode === "scale") return;
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
      // Light up what it would select, as it goes.
      const inside = new Set(b.el.hidden ? [] : this.idsInBox(b.x, b.y, e.clientX, e.clientY));
      if (inside.size !== this.boxPreview.size || [...inside].some((id) => !this.boxPreview.has(id))) {
        this.boxPreview = inside;
        this.applyAppearance();
      }
    });
    el.addEventListener("pointerup", (e) => {
      const b = this.boxSelect;
      if (!b) return;
      this.boxSelect = null;
      b.el.remove();
      if (this.boxPreview.size) {
        this.boxPreview = new Set();
        this.applyAppearance();
      }
      if (Math.hypot(e.clientX - b.x, e.clientY - b.y) < 4) {
        // A click: add or remove the object under it.
        const id = this.pick(e);
        if (id) this.events.onSelect(id, true);
        return;
      }
      this.events.onBoxSelect(this.idsInBox(b.x, b.y, e.clientX, e.clientY));
    });
  }

  /** The objects inside a box dragged on screen (corners in client pixels): those whose middle is in it. */
  private idsInBox(ax: number, ay: number, bx: number, by: number): string[] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const [x0, x1] = [Math.min(ax, bx) - rect.left, Math.max(ax, bx) - rect.left];
    const [y0, y1] = [Math.min(ay, by) - rect.top, Math.max(ay, by) - rect.top];
    const ids: string[] = [];
    this.root.updateMatrixWorld(true);
    for (const [id, node] of this.nodes) {
      if (!this.solidTarget(node) || this.features.get(id)?.kind === "group") continue;
      const box = this.localBox(id, node);
      if (!box) continue;
      const c = box.getCenter(new THREE.Vector3()).applyMatrix4(node.matrixWorld).project(this.camera);
      const sx = ((c.x + 1) / 2) * rect.width;
      const sy = ((1 - c.y) / 2) * rect.height;
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1 && c.z < 1) ids.push(id);
    }
    return ids;
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
    const hit = this.raycaster.intersectObject(this.root, true).find((h) => h.object instanceof THREE.Mesh && h.face && h.object.userData.id && this.solidTarget(h.object) && !this.previewGroup.getObjectById(h.object.id));
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

  // ---- See-through view ------------------------------------------------------------

  setSeeThrough(style: "off" | "xray" | "wire") {
    this.seeThrough = style;
    this.applyAppearance();
  }

  /** Where object `id` (and what's inside it, as shown) crosses a plane: line segments (world). */
  crossSection(id: string, point: Vec3, normal: Vec3): [Vec3, Vec3][] {
    const node = this.nodes.get(id);
    if (!node) return [];
    node.updateMatrixWorld(true);
    const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    const d0 = n.dot(new THREE.Vector3(point.x, point.y, point.z));
    const out: [Vec3, Vec3][] = [];
    const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const v = (p: THREE.Vector3) => ({ x: p.x, y: p.y, z: p.z });
    node.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.userData.id || this.features.get(o.userData.id)?.mode === "hole") return;
      const pos = o.geometry.getAttribute("position");
      const index = o.geometry.getIndex();
      const count = index ? index.count : pos.count;
      for (let i = 0; i < count; i += 3) {
        const at = (k: number, into: THREE.Vector3) => into.fromBufferAttribute(pos, index ? index.getX(i + k) : i + k).applyMatrix4(o.matrixWorld);
        const corners = [at(0, a), at(1, b), at(2, c)];
        const side = corners.map((p) => n.dot(p) - d0);
        const hits: THREE.Vector3[] = [];
        for (let k = 0; k < 3; k++) {
          const [p, q] = [corners[k], corners[(k + 1) % 3]];
          const [sp, sq] = [side[k], side[(k + 1) % 3]];
          if ((sp < 0) !== (sq < 0)) hits.push(p.clone().lerp(q, sp / (sp - sq)));
        }
        if (hits.length === 2) out.push([v(hits[0]), v(hits[1])]);
      }
    });
    return out;
  }

  // ---- Print check: overhangs and thin walls ------------------------------------------

  private printCheckOn = false;
  private printCheckGroup = new THREE.Group();
  /** What the last print check found: area of overhangs and of thin walls (mm²). */
  printCheckResult: { overhang: number; thin: number } | null = null;

  /** Show (or hide) where the model would print badly: overhangs past `angle`° and walls under `wall` mm. */
  setPrintCheck(on: boolean) {
    this.printCheckOn = on;
    this.drawPrintCheck();
    if (!on) this.setClashes([]);
  }

  private clashGroup = new THREE.Group();

  /** Where moving parts overlap what they move against (triangles, world): drawn in purple, through everything. */
  setClashes(meshes: Float32Array[]) {
    this.clashGroup.removeFromParent();
    disposeTree(this.clashGroup);
    this.clashGroup = new THREE.Group();
    for (const pts of meshes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xb04cff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
      m.renderOrder = 30;
      m.raycast = () => {};
      this.clashGroup.add(m);
    }
    if (meshes.length) this.scene.add(this.clashGroup);
    this.clashGroup.visible = !this.sketch;
    this.invalidate();
  }

  private drawPrintCheck(angle = 45, wall = 0.8) {
    this.printCheckGroup.removeFromParent();
    disposeTree(this.printCheckGroup);
    this.printCheckGroup = new THREE.Group();
    this.printCheckResult = null;
    if (this.sketch) return; // Drawn again when sketching ends (the model is flattened meanwhile).
    this.needsRender = true;
    if (!this.printCheckOn) return;
    this.root.updateMatrixWorld(true);
    // The solids as shown (holes already cut), in the world.
    const solids: { pos: Float32Array; count: number }[] = [];
    let bed = Infinity;
    this.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.userData.id || !isShown(o)) return;
      const f = this.features.get(o.userData.id);
      if (!f || f.mode === "hole" || f.kind === "plane") return;
      const g = o.geometry;
      const src = g.getAttribute("position");
      const index = g.getIndex();
      const count = index ? index.count : src.count;
      const pos = new Float32Array(count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        v.fromBufferAttribute(src, index ? index.getX(i) : i).applyMatrix4(o.matrixWorld);
        pos.set([v.x, v.y, v.z], i * 3);
        bed = Math.min(bed, v.z);
      }
      solids.push({ pos, count });
    });
    const down = Math.cos((angle * Math.PI) / 180);
    const over: number[] = [];
    const thin: number[] = [];
    let overArea = 0;
    let thinArea = 0;
    const [a, b, c, n, mid, e1, e2, p, q] = Array.from({ length: 9 }, () => new THREE.Vector3());
    for (const { pos, count } of solids) {
      // Triangles by grid cell, to find the ones near a point quickly.
      const cell = Math.max(wall * 2, 1);
      const grid = new Map<string, number[]>();
      const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      for (let t = 0; t < count; t += 3) {
        const lo = [0, 1, 2].map((k) => Math.min(pos[t * 3 + k], pos[t * 3 + 3 + k], pos[t * 3 + 6 + k]));
        const hi = [0, 1, 2].map((k) => Math.max(pos[t * 3 + k], pos[t * 3 + 3 + k], pos[t * 3 + 6 + k]));
        for (let x = Math.floor(lo[0] / cell); x <= Math.floor(hi[0] / cell); x++)
          for (let y = Math.floor(lo[1] / cell); y <= Math.floor(hi[1] / cell); y++)
            for (let z = Math.floor(lo[2] / cell); z <= Math.floor(hi[2] / cell); z++) {
              const k = `${x},${y},${z}`;
              const list = grid.get(k);
              if (list) list.push(t);
              else grid.set(k, [t]);
            }
      }
      const tri = new THREE.Triangle();
      const ray = new THREE.Ray();
      for (let t = 0; t < count; t += 3) {
        a.fromArray(pos, t * 3);
        b.fromArray(pos, t * 3 + 3);
        c.fromArray(pos, t * 3 + 6);
        n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
        const area = n.length() / 2;
        if (area < 1e-9) continue;
        n.normalize();
        mid.copy(a).add(b).add(c).divideScalar(3);
        const pts = [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z];
        // Facing down more steeply than the angle, and not sitting on the bed.
        if (n.z < -down && mid.z > bed + 0.2) {
          over.push(...pts);
          overArea += area;
        }
        // A short look straight into the part: another surface within `wall` means it's thin there.
        ray.set(p.copy(mid).addScaledVector(n, -1e-3), q.copy(n).negate());
        const end = p.clone().addScaledVector(q, wall);
        const cells = new Set([key(p.x, p.y, p.z), key(end.x, end.y, end.z), key((p.x + end.x) / 2, (p.y + end.y) / 2, (p.z + end.z) / 2)]);
        let hit = false;
        for (const k of cells) {
          for (const o of grid.get(k) ?? []) {
            if (o === t) continue;
            tri.set(e1.fromArray(pos, o * 3), e2.fromArray(pos, o * 3 + 3), new THREE.Vector3().fromArray(pos, o * 3 + 6));
            const at = ray.intersectTriangle(tri.a, tri.b, tri.c, false, new THREE.Vector3());
            if (at && at.distanceTo(p) > 0.02 && at.distanceTo(p) < wall) {
              hit = true;
              break;
            }
          }
          if (hit) break;
        }
        if (hit) {
          thin.push(...pts);
          thinArea += area;
        }
      }
    }
    const layer = (pts: number[], color: number, order: number) => {
      if (!pts.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false }));
      m.renderOrder = order;
      m.raycast = () => {};
      this.printCheckGroup.add(m);
    };
    layer(over, 0xff8a00, 20);
    layer(thin, 0xff3355, 21);
    this.scene.add(this.printCheckGroup);
    this.printCheckResult = { overhang: overArea, thin: thinArea };
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

  /**
   * Where the line through `at` (world) along `dir` crosses from object `a` into object `b`, or from
   * `b` into `a`, if they meet (or overlap a little) there: the point nearest `at`, and the way from `a` to `b`.
   */
  meetingAlong(a: string, b: string, at: Vec3, dir: Vec3): { point: Vec3; dir: Vec3 } | null {
    const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
    const p = new THREE.Vector3(at.x, at.y, at.z);
    // Each part's stretches along the line, from one end of the model to the other.
    const spans = (id: string) => this.alongLine(id, p.clone().addScaledVector(d, -1e4), d);
    const [sa, sb] = [spans(a), spans(b)];
    let best: { t: number; sign: number } | null = null;
    for (const [aIn, aOut] of sa)
      for (const [bIn, bOut] of sb) {
        for (const [t, sign, gap] of [[(aOut + bIn) / 2, 1, Math.abs(aOut - bIn)], [(bOut + aIn) / 2, -1, Math.abs(bOut - aIn)]]) {
          if (gap > 0.5) continue;
          if (!best || Math.abs(t - 1e4) < Math.abs(best.t - 1e4)) best = { t, sign };
        }
      }
    if (!best) return null;
    const q = p.clone().addScaledVector(d, best.t - 1e4);
    return { point: { x: q.x, y: q.y, z: q.z }, dir: { x: d.x * best.sign, y: d.y * best.sign, z: d.z * best.sign } };
  }

  /**
   * How far from `from` (world) along `dir` the object `id` (and what's inside it) ends: where a
   * ray going that way comes out of it. Null if it doesn't go through it.
   */
  exitAlong(id: string, from: Vec3, dir: Vec3): number | null {
    const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
    const out = this.alongLine(id, new THREE.Vector3(from.x, from.y, from.z), d).find(([, end]) => end > 1e-6);
    return out ? out[1] : null;
  }

  /** Where a ray from `from` along unit `d` is inside object `id` (and what's inside it): [in, out] distances (in may be 0, starting inside). */
  private alongLine(id: string, from: THREE.Vector3, d: THREE.Vector3, inside = true): [number, number][] {
    const node = this.nodes.get(id);
    if (!node) return [];
    this.root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    // `inside`: what's inside it counts as it (only shown things); otherwise just its own shape, hidden or not.
    if (inside) node.traverse((o) => o instanceof THREE.Mesh && o.userData.id && this.features.get(o.userData.id)?.mode !== "hole" && isShown(o) && meshes.push(o));
    else for (const o of node.children) if (o instanceof THREE.Mesh && o.userData.id === id) meshes.push(o);
    // Its far sides face away from the ray: hit from behind, so both sides count.
    const sides = meshes.map((m) => (m.material as THREE.Material).side);
    meshes.forEach((m) => ((m.material as THREE.Material).side = THREE.DoubleSide));
    try {
      const spans: [number, number][] = [];
      let start: number | null = null;
      for (const h of new THREE.Raycaster(from, d).intersectObjects(meshes, false)) {
        const leaving = !!h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).dot(d) > 0;
        if (!leaving) start ??= h.distance;
        else {
          spans.push([start ?? 0, h.distance]);
          start = null;
        }
      }
      return spans;
    } finally {
      meshes.forEach((m, i) => ((m.material as THREE.Material).side = sides[i]));
    }
  }

  /**
   * The solid objects (not in `skip`, hidden or not) a line from `from` (world) along `dir` is inside
   * at distance `at`, shown ones first; else the last one it goes into before then.
   */
  partsAlong(from: Vec3, dir: Vec3, at: number, skip: Set<string>): string[] {
    const start = new THREE.Vector3(from.x, from.y, from.z);
    const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
    const inside: string[] = [];
    let last: { id: string; t: number } | null = null;
    for (const id of this.nodes.keys()) {
      if (skip.has(id) || this.features.get(id)?.mode !== "solid" || this.features.get(id)?.kind === "group") continue;
      for (const [enter, leave] of this.alongLine(id, start, d, false)) {
        if (enter <= at && leave >= at) inside.push(id);
        else if (enter <= at && (!last || enter > last.t)) last = { id, t: enter };
      }
    }
    const shown = (id: string) => isShown(this.nodes.get(id)!);
    const found = [...new Set(inside)].sort((a, b) => Number(shown(b)) - Number(shown(a)));
    return found.length ? found : last ? [last.id] : [];
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
      if (this.features.get(id)?.kind === "group" || !this.solidTarget(node)) continue;
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
      .find((h) => h.object instanceof THREE.Mesh && h.face && this.solidTarget(h.object) && !skip.has(h.object.userData.id) && !this.previewGroup.getObjectById(h.object.id));

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
   * Snap points in an object's own frame: those of its shape (see shapeSnapPoints),
   * a sketch's centres (see sketchCentres), and a connected object's pivot, to line
   * up an axle, a hinge or a pin with.
   */
  private snapPointsOf(id: string, node: THREE.Object3D): THREE.Vector3[] {
    const pts = this.shapeSnapPoints(id, node);
    const f = this.features.get(id);
    const extra = f?.kind === "sketch" ? sketchCentres(f) : [];
    if (f?.joint && node.parent) {
      // The pivot sits in the parent's frame (it stays put as the object turns or slides about it).
      const o = f.joint.origin;
      extra.push(new THREE.Vector3(o.x, o.y, o.z).applyMatrix4(node.parent.matrixWorld).applyMatrix4(node.matrixWorld.clone().invert()));
    }
    for (const p of extra) if (!pts.some((q) => q.distanceToSquared(p) < 1e-6)) pts.push(p);
    return pts;
  }

  /**
   * Snap points of an object's shape. Round shapes get points that lie on
   * them (centres, and the four sides of each circle); everything else gets the
   * corners, edge middles, face centres and centre of its box.
   */
  private shapeSnapPoints(id: string, node: THREE.Object3D): THREE.Vector3[] {
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
      if (!own && (moving.has(id) || this.features.get(id)?.kind === "group" || !this.solidTarget(node))) continue;
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
    const held = this.heldNode(obj);
    const moving = this.movingIds(held);
    for (const n of this.groupFollowers()) this.movingIds(n).forEach((x) => moving.add(x));
    const targets: THREE.Vector3[] = [];
    for (const [id, node] of this.nodes) {
      if (moving.has(id) || this.features.get(id)?.kind === "group" || !this.solidTarget(node)) continue;
      for (const p of this.snapPointsOf(id, node)) targets.push(p.applyMatrix4(node.matrixWorld));
    }
    let local = this.snapPointsOf(held.userData.id, held);
    if (held !== obj) {
      // A sketch's points, seen from its gizmo's stand-in.
      const toObj = obj.matrixWorld.clone().invert().multiply(held.matrixWorld);
      local = local.map((p) => p.applyMatrix4(toObj));
    }
    this.pointDrag = { local, targets, snapped: false };
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
      this.rulerEditing = null;
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
      // While dragging, the size it will snap to; otherwise the size it is.
      const shown = this.gizmo.dragging ? rulerLength(length, this.snap) : length;
      if (this.rulerEditing !== label) label.textContent = `${names[i]} ${shown.toFixed(2)} mm`;
      label.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -50%)`;
    });
  }

  /** Turn a ruler label into a box to type the object's size along that axis (Enter sets it, Esc cancels). */
  private editRuler(label: HTMLDivElement, i: number) {
    const span = this.rulerSpan;
    if (!span || this.rulerEditing === label) return;
    const length = span.lengths[i] * [span.node.scale.x, span.node.scale.y, span.node.scale.z][i];
    this.rulerEditing = label;
    const input = document.createElement("input");
    input.className = "ruler-input";
    input.value = Math.abs(length).toFixed(2);
    input.size = Math.max(5, input.value.length + 1);
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      if (this.rulerEditing === label) this.rulerEditing = null;
      const value = parseLength(input.value);
      label.replaceChildren();
      if (apply && value !== null && Number.isFinite(value) && value > 0) this.resizeTo(i, value);
    };
    input.onkeydown = (e) => {
      e.stopPropagation(); // Typing mustn't trigger shortcuts.
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    };
    input.onblur = () => finish(true);
    label.replaceChildren(`${"XYZ"[i]} `, input, " mm");
    input.focus();
    input.select();
  }

  /** Resize the selected object so it measures `size` along its own axis `i` (as a ruler drag would, but exact). */
  private resizeTo(i: number, size: number) {
    const id = this.selectedId;
    const obj = id ? this.nodes.get(id) : undefined;
    const f = id ? this.features.get(id) : undefined;
    const box = obj && f ? this.localBox(id!, obj) : null;
    if (!obj || !f || !box) return;
    const axis = (["x", "y", "z"] as const)[i];
    const current = box.max[axis] - box.min[axis];
    if (current < 1e-6 || Math.abs(size - current) < 1e-6) return;
    const k = size / current;
    const s = { x: 1, y: 1, z: 1 };
    s[axis] = k;
    if (this.keepRatio || f.kind === "hedron") s.x = s.y = s.z = k;
    else if (staysRound(f) && axis !== "z") s.x = s.y = k;
    // The same fixed side as dragging: One side keeps the low end, and so does an imported object's height.
    const imported = f.kind === "imported" || (f.kind === "sculpt" && f.params.base === "imported");
    let anchor: ResizeAnchor | undefined;
    if (this.oneSide || (imported && axis === "z")) {
      const flip = f.mirrored ? -1 : 1;
      const dir = new THREE.Vector3();
      dir[axis] = axis === "x" ? flip : 1;
      dir.applyQuaternion(obj.quaternion);
      anchor = { axis, at: box.min[axis], dir: { x: dir.x, y: dir.y, z: dir.z } };
    }
    this.events.onResized(id!, s, this.moveFor?.id === id ? this.sketchAnchors(s, anchor) : anchor, true);
  }

  /** In One side mode, work out which face stays fixed for the handle just grabbed. */
  private startResizeAnchor() {
    this.resizeAnchor = null;
    const obj = this.gizmo.object;
    const handle = this.gizmo.axis;
    if (!obj || this.gizmo.mode !== "scale" || (handle !== "X" && handle !== "Y" && handle !== "Z")) return;
    const node = this.heldNode(obj);
    const f = this.features.get(node.userData.id);
    // An imported object's origin needn't be at the bottom of its shape: its bottom stays put, as other shapes' does.
    const imported = f?.kind === "imported" || (f?.kind === "sculpt" && f.params.base === "imported");
    if (!this.oneSide && !(imported && handle === "Z")) return;
    const box = this.localBox(node.userData.id, node);
    if (!box) return;
    const axis = handle.toLowerCase() as "x" | "y" | "z";
    const flip = f?.mirrored ? -1 : 1;
    // A sketch's gizmo sits on its shapes, on unflipped axes: where the fixed side is from there.
    const fromGizmo = (at: number) => (obj === this.moveProxy ? (at - this.moveFor!.centre[axis]) * (axis === "x" ? flip : 1) : at);
    if (!this.oneSide) {
      this.resizeAnchor = { axis, at: fromGizmo(box.min[axis]), own: box.min[axis], start: obj.position.clone() };
      return;
    }
    // Each axis has a handle on both ends; the grab point says which end this is.
    // pointStart (grab point relative to the object, world axes) is set by the gizmo but not in its types.
    const grab = (this.gizmo as unknown as { pointStart: THREE.Vector3 }).pointStart.clone().applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()).invert());
    if (flip < 0) grab.x = -grab.x; // Into its own (flipped) frame.
    const at = grab[axis] >= 0 ? box.min[axis] : box.max[axis];
    this.resizeAnchor = { axis, at: fromGizmo(at), own: at, start: obj.position.clone() };
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
      const m = obj === this.moveProxy ? this.moveFor : null;
      if (m) {
        m.start?.node.decompose(m.node.position, m.node.quaternion, m.node.scale);
        if (Math.abs(s.x - 1) > 1e-4 || Math.abs(s.y - 1) > 1e-4 || Math.abs(s.z - 1) > 1e-4) this.events.onResized(m.id, s, this.sketchAnchors(s, anchor ? { axis: anchor.axis, at: anchor.own } : undefined));
        return;
      }
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
    // A sketch's gizmo is on its shapes, put on the grid by the gizmo; its origin follows wherever.
    const held = this.heldNode(obj);
    const grid = this.snap > 0 && !this.pointDrag?.snapped && this.gizmo.space !== "local" && held === obj ? this.snap : 0;
    const round = (v: number) => (grid > 0 ? Math.round(v / grid) * grid : Math.round(v * 1e4) / 1e4) + 0;
    const deg = (r: number) => Math.round(THREE.MathUtils.radToDeg(r) * 1e4) / 1e4 + 0;
    const p = held.position;
    const r = held.rotation;
    this.events.onTransformed(held.userData.id, { x: round(p.x), y: round(p.y), z: round(p.z) }, { x: deg(r.x), y: deg(r.y), z: deg(r.z) });
  }

  private ndc(e: MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private pick(e: MouseEvent): string | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    // The raycaster doesn't skip hidden objects by itself.
    const hit = this.raycaster.intersectObject(this.root, true).find((h) => h.object instanceof THREE.Mesh && h.object.userData.id && this.solidTarget(h.object));
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
    // Resizing clears the canvas: draw again now, before the page is shown, or it flashes blank for a frame.
    this.renderer.render(this.scene, this.camera);
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
/** The middle of a sketch's added shapes (or its cut-outs, or guides, if that's all it has), in the sketch object's own frame. */
function sketchCentre(f: Extract<Feature, { kind: "sketch" }>): THREE.Vector3 | null {
  const all = f.params.entities;
  const shapes = [all.filter((e) => e.mode === "add"), all.filter((e) => e.mode === "subtract"), all].find((list) => list.length) ?? [];
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const e of shapes) {
    const [a, b] = bounds(e);
    for (const i of [0, 1]) {
      lo[i] = Math.min(lo[i], a[i]);
      hi[i] = Math.max(hi[i], b[i]);
    }
  }
  if (!(lo[0] <= hi[0] && lo[1] <= hi[1])) return null;
  return new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0).applyMatrix4(planeMatrix(f.params));
}

function buildFlatSketch(f: Extract<Feature, { kind: "sketch" }>): THREE.Object3D[] {
  const frame = planeMatrix(f.params);
  const out: THREE.Object3D[] = [];
  const lineMat = new THREE.LineBasicMaterial({ color: scenePalette().sketchAdd });
  const cutMat = new THREE.LineBasicMaterial({ color: COLORS.hole });
  const guideMat = new THREE.LineDashedMaterial({ color: scenePalette().sketchConstruction, dashSize: 1.5, gapSize: 1 });
  const fillWith = (shape: THREE.Shape) => {
    const fill = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color: COLORS.solid, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
    );
    fill.geometry.applyMatrix4(frame);
    fill.userData.id = f.id;
    fill.userData.flat = true;
    out.push(fill);
  };
  // Filled where it'll be solid: its added shapes less its cut-outs.
  const region = sketchRegion(f.params.entities);
  const v2 = (ring: [number, number][]) => ring.map(([x, y]) => new THREE.Vector2(x, y));
  for (const [outer, ...holes] of region ?? []) {
    if (outer.length < 3) continue;
    const shape = new THREE.Shape(v2(outer));
    shape.holes = holes.filter((h) => h.length >= 3).map((h) => new THREE.Path(v2(h)));
    fillWith(shape);
  }
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
    const line = new THREE.Line(geom, guide ? guideMat : e.mode === "subtract" ? cutMat : lineMat);
    if (guide) line.computeLineDistances();
    out.push(line);
    // (If the cut-outs couldn't be worked out, each added shape is filled on its own.)
    if (!region && closed && e.mode === "add" && pts.length >= 3) fillWith(new THREE.Shape(v2(pts)));
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

/**
 * Where a sketch's round shapes are centred (circles, also those merged into another shape,
 * ellipses, regular polygons, each end of a slot) and its points, in its own frame: on its plane
 * and at the far end of its extrusion.
 */
function sketchCentres(f: Extract<Feature, { kind: "sketch" }>): THREE.Vector3[] {
  const p = f.params;
  const uv: [number, number][] = [];
  const collect = (e: SketchEntity) => {
    if (e.type === "circle" || e.type === "ellipse" || e.type === "ngon" || e.type === "point") uv.push([e.x, e.y]);
    if (e.type === "slot") uv.push([e.x1, e.y1], [e.x2, e.y2]);
    for (const t of e.trims ?? []) if (t.op === "merge" || t.op === "hull") t.shapes.forEach(collect);
  };
  p.entities.forEach(collect);
  // How far it reaches from its plane, along the plane's normal.
  const d = p.operation === "extrude" ? Math.abs(p.depth) : 0;
  const down = (p.direction === "reversed") !== p.depth < 0;
  const levels = p.direction === "both" ? [-d, 0, d] : d ? [0, down ? -d : d] : [0];
  const frame = planeMatrix({ plane: p.plane, offset: 0 });
  return uv.flatMap(([u, v]) => levels.map((w) => new THREE.Vector3(u, v, (p.offset ?? 0) + w).applyMatrix4(frame)));
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
