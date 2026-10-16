import { Kernel } from "./kernel";
import { featureExtents, resizeFeature, sizeReadout } from "./resize";
import {
  childrenOf,
  createFeature,
  FINISHABLE,
  emptyDocument,
  isCadDocument,
  newId,
  normalizeDocument,
  PARAM_FIELDS,
  reparent,
  setWorldPlacement,
  addJoint,
  removeJoint,
  placeFeature,
  moveJointFrame,
  clampJoint,
  subtreeIds,
  type CadDocument,
  type Feature,
  type Point2,
  type ShapeKind,
  type EdgeOp,
  type EdgeTarget,
  type EntityMode,
  type SketchEntity,
  type SketchEntityType,
  type SketchFeature,
  type SculptFeature,
  type Vec3,
  worldMatrix,
  mirrorFeature,
  setWorldMatrix,
  translateWorld,
  localMatrix,
  SCREW_SIZES,
  type ScrewSize,
  type SketchConstraint,
  type SketchRef,
  type ConstraintType,
} from "./model";
import { Box3, Matrix4, Vector3 } from "three";
import { CONSTRAINT_LABEL, constraintFits, measure as measureConstraint, refPoints as refPointsOf, solveSketch } from "./constraints";
import { autosave, build3mf, loadAutosave, parseStl, svgToEntities, type MeshPart } from "./fileFormats";
import { SketchEditor, type MenuItem, type SketchTool } from "./sketcher";
import { gearOuterRadius, removePoint } from "./sketchGeometry";
import { addDetail, appendToStl, baseMesh, importedMesh, meshToSculpt, scaleSculpt, sculptTriangles, vertexCount, type BrushKind, type BrushSettings, type SculptBase } from "./sculpt";
import { openImportFile, openTextFile, saveFile } from "./storage";
import { formatLength, parseLength } from "./units";
import { onThemeChange, setThemeSetting, themeSetting, type ThemeSetting } from "./theme";
import { Viewport, type GizmoMode, type PreviewSpec } from "./viewport";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---- State ---------------------------------------------------------------

let doc: CadDocument = emptyDocument();
/** The main selected object (it gets the gizmo and the panel); `selectedIds` is everything selected. */
let selectedId: string | null = null;
let selectedIds: string[] = [];
/**
 * History: the model is shown as it was after the first `historyMarker` steps
 * (objects in the order they were made); null shows everything. New objects
 * go in at the marker.
 */
let historyMarker: number | null = null;
/** Copied objects (as JSON), for pasting here or in another window. */
let clipboard: string | null = null;
let showCombined = false;
/** The toolbar's Move / Rotate / Resize choice. */
let gizmoMode: GizmoMode = "translate";
let buildErrors: Record<string, string> = {};
/** Fillets/chamfers that were too big and got shrunk to a safe size (op id → size used). */
let edgeAdjustments: Record<string, number> = {};
const undoStack: string[] = [];
const redoStack: string[] = [];

/** The sculpt object being sculpted, if any, and the brush settings. */
let sculptingId: string | null = null;
const brush: BrushSettings = { kind: "draw", radius: 5, strength: 0.5, invert: false, symmetry: false };
let shiftHeld = false;
window.addEventListener("keydown", (e) => e.key === "Shift" && (shiftHeld = true));
window.addEventListener("keyup", (e) => e.key === "Shift" && (shiftHeld = false));
window.addEventListener("blur", () => (shiftHeld = false));

/** The fillet/chamfer whose edges are being picked in the viewport, if any. */
let edgePick: { featureId: string; opId: string } | null = null;
type Axis = "x" | "y" | "z";
/** The Split / Dividers tools while open for an object (previewed in the view until applied). */
/**
 * The split tool's plan: parallel cuts along `axis`, optionally tilted by
 * `tilt` degrees towards `toward`; `cuts` are positions along the cut normal
 * and `active` is the one the arrow drags.
 */
let splitDraft: { id: string; axis: Axis; tilt: number; toward: Axis; cuts: number[]; active: number } | null = null;
let dividerDraft: { id: string; axis: "x" | "y"; count: number; thickness: number; height: number } | null = null;

/** The sketch currently being edited, if any. */
let sketchEditor: SketchEditor | null = null;
let editingSketchId: string | null = null;

/** Apply a change to the document, recording it for undo. */
/** Undo history is capped by count and by memory (sculpt meshes make snapshots large). */
const UNDO_LIMIT = { steps: 200, bytes: 120_000_000 };
let undoBytes = 0;

function commit(mutate: (features: Feature[]) => void) {
  const snapshot = JSON.stringify(doc);
  undoStack.push(snapshot);
  undoBytes += snapshot.length;
  while (undoStack.length > UNDO_LIMIT.steps || (undoBytes > UNDO_LIMIT.bytes && undoStack.length > 1)) undoBytes -= undoStack.shift()!.length;
  redoStack.length = 0;
  // Sketches with constraints: note their drawing before the change, so the solver can tell what was edited.
  const before = new Map(doc.features.flatMap((f) => (f.kind === "sketch" && f.params.constraints?.length ? [[f.id, structuredClone(f.params.entities)] as const] : [])));
  mutate(doc.features);
  for (const f of doc.features) {
    if (f.kind !== "sketch" || !f.params.constraints?.length) continue;
    const result = solveSketch(f.params.entities, f.params.constraints, before.get(f.id));
    if (result.dead.length) f.params.constraints = f.params.constraints.filter((c) => !result.dead.includes(c.id));
    if (result.error > 1e-3) setNotice("These constraints can't all be met at once: remove one, or change a dimension.");
  }
  refresh();
}

/** Add new objects at the history marker (or the end), moving the marker past them. */
function insertFeatures(features: Feature[], items: Feature[]) {
  if (historyMarker === null || historyMarker >= features.length) {
    features.push(...items);
    if (historyMarker !== null) historyMarker = features.length;
    return;
  }
  features.splice(historyMarker, 0, ...items);
  historyMarker += items.length;
}

/**
 * The objects that make up the model right now: up to the history marker, and
 * not switched off (suppressed). Something inside a missing object moves to the top level.
 */
function activeFeatures(features: Feature[]): Feature[] {
  const upTo = historyMarker === null ? features : features.slice(0, historyMarker);
  const off = new Set<string>();
  for (const f of features) if (f.suppressed) subtreeIds(features, f.id).forEach((id) => off.add(id));
  const kept = upTo.filter((f) => !off.has(f.id));
  const ids = new Set(kept.map((f) => f.id));
  return kept.map((f) => (f.parentId && !ids.has(f.parentId) ? { ...f, parentId: null, joint: undefined } : f));
}

const isActive = (id: string) => activeFeatures(doc.features).some((f) => f.id === id);

function restore(from: string[], to: string[]) {
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push(JSON.stringify(doc));
  doc = JSON.parse(snapshot);
  selectedIds = selectedIds.filter((id) => findFeature(id));
  if (selectedId && !findFeature(selectedId)) selectedId = selectedIds[0] ?? null;
  if (historyMarker !== null && historyMarker > doc.features.length) historyMarker = doc.features.length;
  if (editingSketchId && !findFeature(editingSketchId)) stopSketchEdit();
  if (edgePick && !pickedOp()) stopEdgePick();
  if (sculptingId && findFeature(sculptingId)?.kind !== "sculpt") stopSculpt();
  refresh();
}

const findFeature = (id: string | null) => doc.features.find((f) => f.id === id) ?? null;
const selected = () => findFeature(selectedId);
const editingSketch = () => findFeature(editingSketchId) as SketchFeature | null;

// ---- Kernel + viewport ---------------------------------------------------

const status = $("#status");

/** A short message that survives the rebuild that follows the change it describes. */
let notice = "";
let noticeTimer = 0;
function setNotice(text: string) {
  notice = text;
  setStatus(text);
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    if (status.textContent === notice) setStatus("");
    notice = "";
  }, 8000);
}

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
  status.hidden = !text;
}

const kernel = new Kernel();
const viewport = new Viewport($("#viewport"), {
  onSelect(id, additive) {
    selectObject(id, additive);
  },
  onBoxSelect(ids) {
    if (!ids.length) return;
    selectedIds = [...new Set([...selectedIds, ...ids])];
    selectedId = selectedId && selectedIds.includes(selectedId) ? selectedId : ids[0];
    renderPanels();
    viewport.select(selectedId, selectedIds);
  },
  onMeasure(text) {
    setStatus(text ?? (viewport.measuring ? MEASURE_HINT : ""));
  },
  onTransformed(id, position, rotation) {
    // Other selected objects move by the same amount (turned about this one's origin).
    const others = topSelected().filter((x) => x !== id);
    const before = new Map(others.map((x) => [x, worldMatrix(doc.features, x)]));
    const start = worldMatrix(doc.features, id);
    commit((features) => {
      placeFeature(features, id, position, rotation);
      const delta = worldMatrix(features, id).multiply(start.invert());
      for (const x of others) setWorldMatrix(features, x, delta.clone().multiply(before.get(x)!));
    });
  },
  onResizing(id, scale) {
    const f = findFeature(id);
    if (f) setStatus(`Resize: ${sizeReadout(f, scale, viewport.snapSize)}`);
  },
  onJointMoving(id, value) {
    const f = findFeature(id);
    if (f?.joint) setStatus(`${f.name}: ${f.joint.type === "slider" ? `${fmt(value)} mm` : `${fmt(value)}°`}`);
  },
  onPlacementChange() {
    updateToolbar();
  },
  onPivotMoved(id, origin) {
    commit((features) => {
      const f = features.find((x) => x.id === id);
      if (f) moveJointFrame(f, origin);
    });
  },
  onJointMoved(id, value) {
    commit((features) => {
      const f = features.find((x) => x.id === id);
      if (f?.joint) f.joint.value = value;
    });
  },
  onResized(id, scale, anchor) {
    commit((features) => resizeFeature(features, id, scale, viewport.snapSize, anchor));
  },
  onOpen(id) {
    const kind = findFeature(id)?.kind;
    if (kind === "sketch") startSketchEdit(id);
    if (kind === "sculpt") startSculpt(id);
  },
});

let buildToken = 0;
async function rebuild() {
  const token = ++buildToken;
  const features = structuredClone(activeFeatures(doc.features));
  try {
    await kernel.ready;
    const combined = showCombined && !editingSketchId && !edgePick && !sculptingId;
    const { meshes, errors, adjusted } = await kernel.build(edgePick ? featuresForPicking(features) : features, combined);
    if (token !== buildToken) return; // A newer edit superseded this build.
    buildErrors = errors;
    const adjustmentsChanged = JSON.stringify(adjusted) !== JSON.stringify(edgeAdjustments);
    if (!edgePick) edgeAdjustments = adjusted;
    viewport.setScene(meshes, features, combined);
    viewport.select(combined ? null : selectedId, combined ? [] : selectedIds);
    if (editingSketchId && viewport.sketchId !== editingSketchId) viewport.enterSketch(editingSketchId, (e) => sketchEditor?.handle(e));
    renderObjectList();
    if (adjustmentsChanged && !edgePick && !editingSketchId) renderProperties();

    checkBed();
    renderHistory();
    const failed = Object.keys(errors).map((id) => features.find((f) => f.id === id)?.name ?? id);
    if (failed.length) setStatus(`Couldn't build ${failed.join(", ")}: ${Object.values(errors)[0]}`, true);
    else if (editingSketchId) setStatus(notice);
    else setStatus(features.length ? notice : "Add a shape from the left panel to get started.");
  } catch (err) {
    if (token === buildToken) setStatus(`Error: ${(err as Error).message}`, true);
  }
}

function refresh() {
  if (edgePick && !pickedOp()) {
    // The operation (or its object) was removed while picking.
    edgePick = null;
    viewport.exitEdgePick();
    document.body.classList.remove("picking");
  }
  if (edgePick) viewport.updateEdgePick(pickedOp()?.points ?? []);
  renderPanels();
  sketchEditor?.render();
  void rebuild();
  scheduleAutosave();
  ($("#undo") as HTMLButtonElement).disabled = undoStack.length === 0;
  ($("#redo") as HTMLButtonElement).disabled = redoStack.length === 0;
}

/** Select an object; `additive` (Shift/Ctrl-click) adds it to the selection, or takes it out again. */
function selectObject(id: string | null, additive = false) {
  if (additive && id) {
    if (selectedIds.includes(id)) {
      selectedIds = selectedIds.filter((x) => x !== id);
      id = selectedId === id ? (selectedIds.at(-1) ?? null) : selectedId;
    } else selectedIds = [...selectedIds, id];
  } else selectedIds = id ? [id] : [];
  if (sculptingId && id !== sculptingId) stopSculpt();
  if (editingSketchId && id !== editingSketchId) stopSketchEdit();
  if (edgePick && id !== edgePick.featureId) stopEdgePick();
  selectedId = id;
  renderPanels();
  viewport.select(id, selectedIds);
}

/** The selected objects, minus any inside another selected one (those move with it). */
function topSelected(): string[] {
  const set = new Set(selectedIds);
  return selectedIds.filter((id) => {
    for (let p = findFeature(id)?.parentId ?? null; p; p = findFeature(p)?.parentId ?? null) if (set.has(p)) return false;
    return !!findFeature(id);
  });
}

// ---- Sculpting ------------------------------------------------------------

function startSculpt(id: string) {
  stopSketchEdit();
  stopEdgePick();
  sculptingId = id;
  selectedId = id;
  if (showCombined) {
    showCombined = false;
    ($("#combined") as HTMLInputElement).checked = false;
  }
  viewport.enterSculpt({
    id,
    // Holding Shift flips Draw/Inflate (carve / deflate).
    settings: () => ({ ...brush, invert: brush.invert !== shiftHeld }),
    onCommit(positions) {
      commit((features) => {
        const f = features.find((x) => x.id === id);
        if (f?.kind === "sculpt") f.params.positions = positions;
      });
    },
  });
  document.body.classList.add("sculpting");
  refresh();
}

function stopSculpt() {
  if (!sculptingId) return;
  sculptingId = null;
  viewport.exitSculpt();
  document.body.classList.remove("sculpting");
  refresh();
}

const BRUSHES: { value: BrushKind; label: string; key: string; title: string }[] = [
  { value: "draw", label: "Draw", key: "D", title: "Build up (or carve with Shift / Invert)" },
  { value: "inflate", label: "Inflate", key: "I", title: "Swell outwards along the surface (Shift to shrink)" },
  { value: "smooth", label: "Smooth", key: "S", title: "Even out bumps" },
  { value: "flatten", label: "Flatten", key: "F", title: "Press the surface flat" },
  { value: "grab", label: "Grab", key: "G", title: "Pull a region around" },
];

function sculptPanel(f: SculptFeature): HTMLElement[] {
  const title = document.createElement("h3");
  title.textContent = `✋ Sculpting ${f.name}`;
  const brushes = document.createElement("div");
  brushes.className = "tool-grid";
  for (const b of BRUSHES) {
    const el = button(b.label, () => ((brush.kind = b.value), renderProperties()), b.value === brush.kind ? "active" : "");
    el.title = `${b.title} (${b.key})`;
    brushes.append(el);
  }
  const symmetry = document.createElement("label");
  symmetry.className = "toggle";
  symmetry.innerHTML = `<input type="checkbox" /> Mirror across X`;
  const box = symmetry.querySelector("input")!;
  box.checked = brush.symmetry;
  box.onchange = () => (brush.symmetry = box.checked);
  return [
    title,
    section("Brush"),
    brushes,
    lengthField("Radius", brush.radius, (v) => ((brush.radius = v), renderProperties()), { min: 0 }),
    lengthField("Strength", Math.round(brush.strength * 100), (v) => ((brush.strength = Math.min(1, Math.max(0.01, v / 100))), renderProperties()), { min: 0, unit: "%" }),
    ...(brush.kind === "draw" || brush.kind === "inflate"
      ? [labeled("Direction", segmented([{ value: "out", label: "Out" }, { value: "in", label: "In" }], brush.invert ? "in" : "out", (v) => ((brush.invert = v === "in"), renderProperties())))]
      : []),
    symmetry,
    button("✓ Done sculpting", stopSculpt, "primary wide"),
    hint("Drag on the object to sculpt; drag elsewhere to orbit, right-drag to pan. Hold Shift to invert. [ and ] change the radius. Every stroke can be undone."),
  ];
}

/** Clay shape, size and mesh detail for a sculpt. Every change is a normal undo step. */
function sculptSettings(f: SculptFeature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const setParams = (mutate: (p: SculptFeature["params"]) => void) => update((t) => t.kind === "sculpt" && mutate(t.params));

  const clay = document.createElement("select");
  if (f.params.base === "converted") clay.add(new Option("Converted object", "converted"));
  clay.add(new Option("Sphere", "sphere"));
  clay.add(new Option("Cube", "cube"));
  clay.value = f.params.base;
  clay.onchange = () => {
    const base = clay.value as SculptBase;
    setParams((p) => Object.assign(p, { base, detail: "normal" }, baseMesh(base, p.size, "normal")));
    setNotice(`Started over with a fresh ${base}. Ctrl+Z brings back the previous shape.`);
  };

  const verts = vertexCount(f.params);
  const detail = button(`Add detail (${verts.toLocaleString()} points)`, () => {
    const finer = addDetail(f.params);
    if (finer) setParams((p) => Object.assign(p, finer));
    else setStatus("This sculpt already has as much detail as GizmoCAD allows.", true);
  }, "wide");
  detail.title = "Make the mesh finer so small features can be sculpted. Your shape is kept.";

  return [
    labeled("Clay", clay),
    lengthField("Size", f.params.size, (v) => setParams((p) => Object.assign(p, scaleSculpt(p, v / p.size))), { min: 0 }),
    detail,
    hint("Choosing a clay shape starts over (Ctrl+Z to undo). Size scales your sculpt; Add detail refines it without changing the shape."),
  ];
}

/** Turn a CAD object into clay: its finished shape (or a group's merged result) becomes a sculpt mesh. */
async function convertToSculpt(id: string) {
  const f = findFeature(id);
  if (!f) return;
  setStatus("Turning it into clay…");
  try {
    const mesh = await kernel.meshOf(structuredClone(doc.features), id);
    if (!mesh || !mesh.triangles.length) {
      setStatus("This object has no shape to sculpt yet.", true);
      return;
    }
    const params = meshToSculpt(mesh.vertices, mesh.triangles);
    // A group's contents are now part of its clay, so they go away.
    const merged = f.kind === "group" ? subtreeIds(doc.features, id) : new Set<string>();
    merged.delete(id);
    commit((features) => {
      const t = features.find((x) => x.id === id);
      if (!t) return;
      Object.assign(t, { kind: "sculpt", mode: "solid", edgeOps: [], params });
      features.splice(0, features.length, ...features.filter((x) => !merged.has(x.id)));
    });
    setNotice(`${f.name} is now clay. Exact sizes and fillets no longer apply; Ctrl+Z turns it back.`);
    startSculpt(id);
  } catch (err) {
    setStatus(`Couldn't turn it into clay: ${(err as Error).message}`, true);
  }
}

// ---- Edge picking --------------------------------------------------------

function pickedOp(): EdgeOp | null {
  if (!edgePick) return null;
  return findFeature(edgePick.featureId)?.edgeOps.find((o) => o.id === edgePick!.opId) ?? null;
}

/**
 * While picking edges for an operation, show the shape as it is just before
 * that operation, so the edges you click are the ones it will act on.
 */
function featuresForPicking(features: Feature[]): Feature[] {
  const f = features.find((x) => x.id === edgePick?.featureId);
  const i = f?.edgeOps.findIndex((o) => o.id === edgePick?.opId) ?? -1;
  if (f && i >= 0) f.edgeOps = [...f.edgeOps.slice(0, i), { ...f.edgeOps[i], size: 0 }]; // size 0 = skipped, but keeps a group merged
  return features;
}

function startEdgePick(featureId: string, opId: string) {
  stopSketchEdit();
  edgePick = { featureId, opId };
  if (showCombined) {
    showCombined = false;
    ($("#combined") as HTMLInputElement).checked = false;
  }
  viewport.enterEdgePick({
    id: featureId,
    points: pickedOp()?.points ?? [],
    onPick(point) {
      commit((features) => {
        const op = features.find((f) => f.id === featureId)?.edgeOps.find((o) => o.id === opId);
        if (!op) return;
        const i = op.points.findIndex((p) => Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]) < 1e-3);
        if (i >= 0) op.points.splice(i, 1);
        else op.points.push(point.map((v) => Math.round(v * 1e5) / 1e5) as [number, number, number]);
      });
    },
  });
  document.body.classList.add("picking");
  refresh();
}

function stopEdgePick() {
  if (!edgePick) return;
  edgePick = null;
  viewport.exitEdgePick();
  document.body.classList.remove("picking");
  refresh();
}

// ---- Sketch editing ------------------------------------------------------

function startSketchEdit(id: string) {
  if (editingSketchId === id) return;
  stopSketchEdit();
  stopEdgePick();
  stopSculpt();
  editingSketchId = id;
  selectedId = id;
  sketchEditor = new SketchEditor(viewport.sketchLayer, {
    entities: () => editingSketch()?.params.entities ?? [],
    constraints: () => editingSketch()?.params.constraints ?? [],
    commit: (mutate) =>
      commit((features) => {
        const s = features.find((f) => f.id === id);
        if (s?.kind === "sketch") mutate(s.params.entities);
      }),
    changed: () => sketchStateChanged(),
    snapSize: () => viewport.snapSize,
    menu: (items, x, y) => showMenu(items, x, y),
    notify: (text) => setNotice(text),
  });
  if (showCombined) {
    showCombined = false;
    ($("#combined") as HTMLInputElement).checked = false;
  }
  document.body.classList.add("sketching");
  refresh();
}

function stopSketchEdit() {
  if (!editingSketchId) return;
  const sketch = findFeature(editingSketchId);
  if (sketch?.kind === "sketch" && sketch.params.operation === "flat" && sketch.params.entities.length) {
    setNotice("Sketch finished. It stays flat until you Extrude or Revolve it in the panel.");
  }
  sketchEditor?.dispose();
  sketchEditor = null;
  editingSketchId = null;
  viewport.exitSketch();
  document.body.classList.remove("sketching");
  renderPanels();
  void rebuild();
}

/** Re-render the sketch panel only when something it shows changed; always update the cursor readout. */
let sketchPanelKey = "";
function sketchStateChanged() {
  const ed = sketchEditor;
  if (!ed) return;
  const key = panelKey(ed);
  if (key !== sketchPanelKey) renderProperties();
  const coords = document.getElementById("sketch-cursor");
  if (coords) coords.textContent = ed.cursor ? `U ${formatLength(ed.cursor[0])}   V ${formatLength(ed.cursor[1])}` : "";
}

// ---- Panels --------------------------------------------------------------

function renderPanels() {
  renderObjectList();
  renderProperties();
  updateToolbar();
}

/** Show only the transform controls that apply right now. */
function updateToolbar() {
  const f = selected();
  // Moving things around: an object is selected in the normal 3D view.
  const transforming = !!f && !editingSketchId && !sculptingId && !edgePick && !showCombined && !viewport.placing && !viewport.measuring;
  const show = (sel: string, on: boolean) => document.querySelectorAll<HTMLElement>(sel).forEach((el) => (el.hidden = !on));
  // Spin/Slide only applies to connected objects; anything else just moves in that mode.
  const mode = (gizmoMode === "joint" || gizmoMode === "pivot") && !f?.joint ? "translate" : gizmoMode;
  show(".gizmo-mode", transforming);
  show("[data-gizmo=joint]", transforming && !!f?.joint);
  // Pivot goes with Spin/Slide: it's how you set up what those turn around.
  show("[data-gizmo=pivot]", transforming && !!f?.joint && (mode === "joint" || mode === "pivot"));
  const joint = $("[data-gizmo=joint]");
  joint.textContent = f?.joint?.type === "slider" ? "Slide" : "Spin";
  joint.title = f?.joint?.type === "slider" ? "Slide it along its connection (J)" : "Turn it on its connection (J)";
  document.querySelectorAll<HTMLButtonElement>("[data-gizmo]").forEach((b) => b.classList.toggle("active", b.dataset.gizmo === mode));
  show("#snap-face", transforming && mode === "translate" && !f?.joint);
  show("#keep-ratio, #one-side", transforming && mode === "scale");
  show("#points-option", (transforming && (mode === "translate" || mode === "pivot")) || viewport.placing);
}

const KIND_ICON: Record<ShapeKind, string> = {
  box: "▣",
  cylinder: "◍",
  sphere: "●",
  cone: "▲",
  tube: "◎",
  torus: "◯",
  wedge: "◣",
  pyramid: "△",
  prism: "⬢",
  thread: "⩫",
  gear: "⚙",
  spring: "➰",
  star: "★",
  text: "T",
  screw: "⊚",
  sketch: "✎",
  group: "▤",
  plane: "◇",
  sculpt: "✋",
};

const EYE_OPEN = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_SHUT = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17.6 17.6 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

/** Show or hide objects (and everything inside them) in the view; several go the way the first one goes. */
function toggleHidden(id: string, more: string[] = []) {
  const hide = !findFeature(id)?.hidden;
  commit((features) => {
    for (const x of [id, ...more]) {
      const f = features.find((y) => y.id === x);
      if (!f) continue;
      if (hide) f.hidden = true;
      else delete f.hidden;
    }
  });
}

/** Is the object, or anything it sits inside, hidden? */
function hiddenInView(f: Feature): boolean {
  for (let p: Feature | undefined = f; p; p = p.parentId ? (findFeature(p.parentId) ?? undefined) : undefined) if (p.hidden) return true;
  return false;
}

const panelKey = (ed: SketchEditor) => `${ed.tool}|${ed.newMode}|${ed.ngonSides}|${ed.brushWidth}|${[...ed.selected].join(",")}|${JSON.stringify(ed.picked)}`;

// ---- Context menu --------------------------------------------------------

const menuEl = document.createElement("div");
menuEl.className = "context-menu";
menuEl.hidden = true;
document.body.append(menuEl);

function showMenu(items: MenuItem[], x: number, y: number) {
  menuEl.replaceChildren(
    ...items.map((item) => {
      const b = document.createElement("button");
      b.textContent = item.label;
      b.disabled = !!item.disabled;
      if (item.danger) b.className = "danger";
      b.onclick = () => {
        hideMenu();
        item.action();
      };
      return b;
    }),
  );
  menuEl.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(x, w - r.width - 4)}px`;
  menuEl.style.top = `${Math.min(y, h - r.height - 4)}px`;
}

function hideMenu() {
  menuEl.hidden = true;
}

window.addEventListener("pointerdown", (e) => !menuEl.contains(e.target as Node) && hideMenu(), true);

function renderObjectList() {
  const list = $("#object-list");
  const rows: HTMLLIElement[] = [];
  // Rolled-back history steps aren't part of the model right now, so they're left out.
  const upTo = historyMarker === null ? doc.features : doc.features.slice(0, historyMarker);
  const listed = new Set(upTo.map((f) => f.id));
  const shown = upTo.map((f) => (f.parentId && !listed.has(f.parentId) ? { ...f, parentId: null } : f));
  const walk = (parentId: string | null, depth: number) => {
    for (const f of childrenOf(shown, parentId)) {
      rows.push(objectRow(f, depth));
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  list.replaceChildren(...rows);
}

let draggingId: string | null = null;

function objectRow(f: Feature, depth: number) {
  const li = document.createElement("li");
  li.className = [selectedIds.includes(f.id) ? "selected" : "", buildErrors[f.id] ? "failed" : "", hiddenInView(f) ? "hidden-obj" : "", f.suppressed ? "suppressed" : ""].join(" ");
  li.style.paddingLeft = `${8 + depth * 16}px`;
  li.draggable = true;
  li.innerHTML = `<span class="name"><span class="kind"></span><span></span></span><span class="row-end"><span class="tag ${f.mode}">${f.kind === "group" ? "group" : f.mode}</span><button class="eye"></button></span>`;
  const eye = li.querySelector<HTMLButtonElement>(".eye")!;
  eye.innerHTML = f.hidden ? EYE_SHUT : EYE_OPEN;
  eye.title = f.hidden ? "Show (H)" : "Hide (H)";
  eye.setAttribute("aria-label", `${f.hidden ? "Show" : "Hide"} ${f.name}`);
  eye.classList.toggle("off", !!f.hidden);
  eye.onclick = (e) => {
    e.stopPropagation();
    toggleHidden(f.id);
  };
  eye.ondblclick = (e) => e.stopPropagation();
  li.querySelector(".kind")!.textContent = KIND_ICON[f.kind];
  li.querySelector(".name > span:last-child")!.textContent = f.name;
  if (buildErrors[f.id]) li.title = buildErrors[f.id];
  li.onclick = (e) => selectObject(f.id, e.shiftKey || e.ctrlKey || e.metaKey);
  li.ondblclick = () => f.kind === "sketch" && startSketchEdit(f.id);

  // Drag onto another object to make it the parent.
  li.ondragstart = (e) => {
    draggingId = f.id;
    e.dataTransfer!.effectAllowed = "move";
    e.stopPropagation();
  };
  li.ondragend = () => {
    draggingId = null;
    document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  };
  li.ondragover = (e) => {
    if (!draggingId || subtreeIds(doc.features, draggingId).has(f.id)) return;
    e.preventDefault();
    e.stopPropagation();
    li.classList.add("drop-target");
  };
  li.ondragleave = () => li.classList.remove("drop-target");
  li.ondrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggingId) moveTo(draggingId, f.id);
  };
  return li;
}

function moveTo(id: string, parentId: string | null) {
  const probe = structuredClone(doc.features);
  if (!reparent(probe, id, parentId)) return;
  commit((features) => reparent(features, id, parentId));
}

// Dropping on empty space in the list moves an object back to the top level.
const objectList = $("#object-list");
objectList.ondragover = (e) => {
  if (!draggingId) return;
  e.preventDefault();
  objectList.classList.add("drop-target");
};
objectList.ondragleave = (e) => e.target === objectList && objectList.classList.remove("drop-target");
objectList.ondrop = (e) => {
  e.preventDefault();
  objectList.classList.remove("drop-target");
  if (draggingId) moveTo(draggingId, null);
};

// ---- Form helpers --------------------------------------------------------

/** A text input that accepts lengths with units/arithmetic and commits on Enter or blur. */
/**
 * A labelled number field. Lengths show "mm" after the value; `unit` (° or %)
 * is typed into the value instead, and `plain` is for counts with no unit.
 */
function lengthField(label: string, value: number, onChange: (mm: number) => void, opts: { min?: number; unit?: string; plain?: boolean } = {}) {
  const row = document.createElement("label");
  row.className = "field";
  row.innerHTML = `<span></span>`;
  row.querySelector("span")!.textContent = label;
  const input = lengthInput(value, onChange, opts);
  if (opts.unit || opts.plain) {
    row.append(input);
  } else {
    const wrap = document.createElement("span");
    wrap.className = "with-unit";
    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = "mm";
    wrap.append(input, unit);
    row.append(wrap);
  }
  return row;
}

function lengthInput(value: number, onChange: (mm: number) => void, opts: { min?: number; unit?: string } = {}) {
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.spellcheck = false;
  const initial = formatLength(value) + (opts.unit ?? "");
  input.value = initial;
  const apply = () => {
    const parsed = opts.unit ? parseFloat(input.value) : parseLength(input.value);
    const valid = parsed !== null && Number.isFinite(parsed) && (opts.min === undefined || parsed > opts.min);
    input.classList.toggle("invalid", !valid);
    if (valid && parsed !== value) onChange(parsed);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.value = initial;
      input.blur();
    }
    e.stopPropagation();
  });
  input.addEventListener("blur", apply);
  return input;
}

function section(title: string) {
  const el = document.createElement("div");
  el.className = "section";
  el.textContent = title;
  return el;
}

/** A row of toggle buttons; `variant` adds a colour class to the active one. */
function segmented<T extends string>(options: { value: T; label: string; title?: string }[], current: T, onPick: (v: T) => void, variant = "") {
  const el = document.createElement("div");
  el.className = "segmented";
  for (const o of options) {
    const b = document.createElement("button");
    b.textContent = o.label;
    if (o.title) b.title = o.title;
    b.className = o.value === current ? `active ${variant ? `${variant}-${o.value}` : ""}` : "";
    b.onclick = () => o.value !== current && onPick(o.value);
    el.append(b);
  }
  return el;
}

/** A label over a full-width control (for rows of buttons too wide to sit beside their label). */
function stacked(label: string, control: HTMLElement) {
  const row = labeled(label, control);
  row.classList.add("stacked");
  return row;
}

function labeled(label: string, control: HTMLElement) {
  const row = document.createElement("label");
  row.className = "field wide-control";
  const span = document.createElement("span");
  span.textContent = label;
  row.append(span, control);
  return row;
}

function button(text: string, onClick: () => void, className = "") {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = className;
  b.onclick = onClick;
  return b;
}

function hint(html: string) {
  const p = document.createElement("p");
  p.className = "units-hint";
  p.innerHTML = html;
  return p;
}

// ---- Springs ----------------------------------------------------------------

/** A spring's settings: coil or flat, and the sizes that style uses. */
function springFields(f: Extract<Feature, { kind: "spring" }>, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const p = f.params;
  const set = (mutate: (p: typeof f.params) => void) => update((t) => t.kind === "spring" && mutate(t.params));
  const flat = p.style === "flat";
  const items: HTMLElement[] = [
    labeled(
      "Style",
      segmented(
        [
          { value: "coil", label: "Coil", title: "Wire wound in a helix" },
          { value: "flat", label: "Flat", title: "A zigzag strip that prints flat on the bed: easier to 3D print, squashes along Z" },
        ],
        p.style,
        (v) => set((t) => (t.style = v)),
      ),
    ),
  ];
  if (flat) {
    items.push(
      labeled(
        "Bends",
        segmented(
          [
            { value: "round", label: "Rounded", title: "U-shaped bends: gentle, springy" },
            { value: "sharp", label: "Sharp", title: "A V zigzag of straight struts: stiffer and more compact" },
          ],
          p.bends,
          (v) => set((t) => (t.bends = v)),
        ),
      ),
    );
  } else {
    items.push(
      labeled(
        "Wire",
        segmented(
          [
            { value: "round", label: "Round" },
            { value: "square", label: "Square", title: "Square wire prints more reliably" },
          ],
          p.section,
          (v) => set((t) => (t.section = v)),
        ),
      ),
    );
  }
  items.push(
    labeled(
      flat ? "End plates" : "Ends",
      segmented(
        [
          { value: "off", label: flat ? "None" : "Open" },
          { value: "on", label: flat ? "Both" : "Flat", title: flat ? "Solid plates at the top and bottom, to fix the spring by" : "Ground flat so it stands upright" },
        ],
        p.ends ? "on" : "off",
        (v) => set((t) => (t.ends = v === "on")),
      ),
    ),
    lengthField(flat ? "Width (X)" : "Coil diameter", p.diameter, (v) => set((t) => (t.diameter = v)), { min: 0 }),
    lengthField(flat ? "Length (Y)" : "Height (Z)", p.height, (v) => set((t) => (t.height = v)), { min: 0 }),
    ...(flat ? [lengthField("Thickness (Z)", p.depth, (v) => set((t) => (t.depth = v)), { min: 0 })] : []),
    lengthField(flat ? "Strip width" : "Wire thickness", p.wire, (v) => set((t) => (t.wire = v)), { min: 0 }),
    lengthField(flat ? "Spacing" : "Pitch (coil spacing)", p.pitch, (v) => set((t) => (t.pitch = v)), { min: 0 }),
  );
  if (flat) items.push(hint("Lies flat on the bed, so it prints with no supports, and squashes along Y. A wider strip, less spacing or more thickness makes it stiffer."));
  return items;
}

// ---- Connections (hinges and sliders) ----------------------------------------

/** The "Connection" panel section: add a hinge/slider, or edit the one there is. */
function connectionSection(f: Feature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const items: HTMLElement[] = [section("Connection")];
  const j = f.joint;
  if (!j) {
    const row = document.createElement("div");
    row.className = "actions";
    const hinge = button("⟳ Hinge / axle…", () => startConnect(f.id, "hinge"));
    hinge.title = "Attach this object to another so it can only turn around an axis (wheels, lids, doors)";
    const orbit = button("◎ Orbit…", () => startConnect(f.id, "orbit"));
    orbit.title = "Attach this object so it circles around an axis while staying upright (Ferris-wheel cabins, planets)";
    const slider = button("↔ Slider…", () => startConnect(f.id, "slider"));
    slider.title = "Attach this object to another so it can only slide along a line (drawers, sliders)";
    row.append(hinge, orbit, slider);
    items.push(row);
    return items;
  }
  const parent = findFeature(f.parentId);
  const setJoint = (mutate: (j: NonNullable<Feature["joint"]>) => void) => update((t) => t.joint && mutate(t.joint));
  const hingeType = j.type !== "slider"; // Hinges and orbits both turn by an angle.
  const unit = hingeType ? { unit: "°" } : {};
  items.push(
    hint(`${j.type === "hinge" ? "Turns on a hinge/axle" : j.type === "orbit" ? "Orbits (stays upright)" : "Slides"} on <b>${escapeHtml(parent?.name ?? "the ground")}</b> and moves with it. Use <b>${hingeType ? "Spin" : "Slide"}</b> (J) in the toolbar and drag the ${hingeType ? "ring" : "arrow"} to move it on its connection; Move and Rotate move it together with its connection.`),
    ...(hingeType
      ? [
          labeled(
            "Moves by",
            segmented(
              [
                { value: "hinge" as const, label: "Spinning", title: "Hinge/axle: turns as it goes round" },
                { value: "orbit" as const, label: "Orbiting", title: "Orbit: goes round the axis but keeps facing the same way" },
              ],
              j.type as "hinge" | "orbit",
              (v) => setJoint((t) => (t.type = v)),
            ),
          ),
        ]
      : []),
    lengthField(hingeType ? "Angle" : "Distance", j.value, (v) => setJoint((t) => (t.value = clampJoint(t, v))), unit),
    labeled(
      "Limits",
      segmented(
        [
          { value: "off", label: "Off" },
          { value: "on", label: "On", title: "Stop the movement between a minimum and a maximum" },
        ],
        j.min !== undefined || j.max !== undefined ? "on" : "off",
        (v) =>
          setJoint((t) => {
            if (v === "on") {
              t.min = Math.min(t.value, hingeType ? 0 : 0);
              t.max = Math.max(t.value, hingeType ? 90 : 20);
            } else {
              delete t.min;
              delete t.max;
            }
          }),
      ),
    ),
  );
  if (j.min !== undefined || j.max !== undefined) {
    items.push(
      lengthField("Min", j.min ?? 0, (v) => setJoint((t) => ((t.min = v), (t.value = clampJoint(t, t.value)))), unit),
      lengthField("Max", j.max ?? 0, (v) => setJoint((t) => ((t.max = v), (t.value = clampJoint(t, t.value)))), unit),
    );
  }
  const axisName = (["x", "y", "z"] as const).find((a) => Math.abs(Math.abs(j.axis[a]) - 1) < 1e-6);
  items.push(
    labeled(
      "Axis",
      segmented(
        [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
          { value: "z", label: "Z" },
          { value: "flip", label: "⇄", title: "Reverse the direction" },
        ],
        (axisName ?? "") as "x",
        // Changing the connection leaves the object where it is.
        (v) =>
          update((t) =>
            moveJointFrame(t, t.joint!.origin, v === "flip" ? { x: -t.joint!.axis.x, y: -t.joint!.axis.y, z: -t.joint!.axis.z } : { x: v === "x" ? 1 : 0, y: v === "y" ? 1 : 0, z: v === "z" ? 1 : 0 }),
          ),
      ),
    ),
    ...(["x", "y", "z"] as const).map((a) => lengthField(`Pivot ${a.toUpperCase()}`, j.origin[a], (v) => update((t) => moveJointFrame(t, { ...t.joint!.origin, [a]: v })))),
  );
  const row = document.createElement("div");
  row.className = "actions";
  const pivot = button("✥ Move pivot", () => setGizmoMode("pivot"), gizmoMode === "pivot" ? "primary" : "");
  pivot.title = "Drag the connection's pivot (P); the object stays where it is";
  const repick = button("Re-pick…", () => startConnect(f.id, j.type));
  repick.title = "Click a new point for the connection; the object stays where it is";
  row.append(pivot, repick);
  items.push(
    row,
    hint("Pivot fields are in the parent's frame. Moving the pivot or changing the axis doesn't move the object."),
    button("Remove connection", () => commit((features) => removeJoint(features, f.id)), "wide"),
  );
  return items;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Pick where to connect: click a point on another object; the face there sets the axis. */
function startConnect(id: string, type: "hinge" | "orbit" | "slider") {
  const f = findFeature(id);
  if (!f) return;
  const connect = (targetId: string, point: Vec3, rotation: Vec3) => {
    setStatus("");
    commit((features) => addJoint(features, id, targetId, type, point, rotation));
    setGizmoMode("joint");
    setNotice(`${f.name} is now connected to ${findFeature(targetId)?.name}. Drag the ${type === "slider" ? "arrow" : "ring"} to move it (${type === "slider" ? "Slide" : "Spin"}, J); Move and Rotate move it with its connection.`);
  };
  viewport.startPlacement({
    feature: f,
    marker: true,
    allowSelf: true,
    noGround: true,
    onPlace(point, rotation, targetId) {
      if (!targetId) return;
      if (!subtreeIds(doc.features, id).has(targetId)) return connect(targetId, point, rotation);
      // Picked on the object itself (e.g. the middle of a wheel): now pick what it attaches to.
      viewport.startPlacement({
        feature: f,
        pickOnly: true,
        noGround: true,
        onPlace(_p, _r, other) {
          if (other) connect(other, point, rotation);
        },
        onCancel() {
          setStatus("");
        },
      });
      setStatus(`Now click the object ${f.name} attaches to. Esc to cancel.`);
    },
    onCancel() {
      setStatus("");
    },
  });
  setStatus(
    type !== "slider"
      ? `${type === "orbit" ? `Click the centre ${f.name} circles around` : `Click where ${f.name} turns`}, on it or on the object it attaches to. The arrow is the axle; F flips it (e.g. down under an object). Esc to cancel.`
      : `Click a face of ${f.name} or of what it slides on: it slides along the arrow. F flips it (e.g. down). Esc to cancel.`,
  );
}


// ---- Text and screw holes -----------------------------------------------------

function textFields(f: Extract<Feature, { kind: "text" }>, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const p = f.params;
  const set = (mutate: (p: typeof f.params) => void) => update((t) => t.kind === "text" && mutate(t.params));
  const box = document.createElement("textarea");
  box.className = "text-input";
  box.rows = Math.min(4, Math.max(1, p.text.split("\n").length));
  box.value = p.text;
  box.spellcheck = false;
  box.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      box.blur();
    }
  };
  box.onblur = () => box.value !== p.text && set((t) => (t.text = box.value));
  const bold = document.createElement("label");
  bold.className = "toggle";
  bold.innerHTML = `<input type="checkbox" /> Bold`;
  const check = bold.querySelector("input")!;
  check.checked = p.bold;
  check.onchange = () => set((t) => (t.bold = check.checked));
  return [
    box,
    hint("Shift+Enter starts a new line."),
    labeled(
      "Font",
      segmented(
        [
          { value: "sans", label: "Sans" },
          { value: "serif", label: "Serif" },
          { value: "mono", label: "Mono" },
        ],
        p.font,
        (v) => set((t) => (t.font = v)),
      ),
    ),
    bold,
    labeled(
      "Align",
      segmented(
        [
          { value: "left", label: "Left" },
          { value: "center", label: "Centre" },
          { value: "right", label: "Right" },
        ],
        p.align,
        (v) => set((t) => (t.align = v)),
      ),
    ),
    lengthField("Letter height", p.size, (v) => set((t) => (t.size = v)), { min: 0 }),
    lengthField("Thickness (Z)", p.height, (v) => set((t) => (t.height = v)), { min: 0 }),
    lengthField("Letter spacing", p.spacing, (v) => set((t) => (t.spacing = v))),
    hint("Make it a <b>Hole</b> and sink it into a face to engrave the text instead. Letters under about 5 mm tall are hard to print."),
  ];
}

function screwFields(f: Extract<Feature, { kind: "screw" }>, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const p = f.params;
  const set = (mutate: (p: typeof f.params) => void) => update((t) => t.kind === "screw" && mutate(t.params));
  const size = document.createElement("select");
  for (const k of Object.keys(SCREW_SIZES)) size.add(new Option(k, k));
  size.value = p.size;
  size.onchange = () => set((t) => (t.size = size.value as ScrewSize));
  const d = SCREW_SIZES[p.size];
  return [
    labeled("Screw", size),
    stacked(
      "Fit",
      segmented(
        [
          { value: "tap", label: "Tap", title: `${d.tap} mm: the screw cuts its own thread (plastic or wood)` },
          { value: "close", label: "Close", title: `${d.close} mm clearance` },
          { value: "normal", label: "Normal", title: `${d.normal} mm clearance` },
          { value: "loose", label: "Loose", title: `${d.loose} mm clearance` },
        ],
        p.fit,
        (v) => set((t) => (t.fit = v)),
      ),
    ),
    stacked(
      "Head",
      segmented(
        [
          { value: "none", label: "None" },
          { value: "counterbore", label: "Counterbore", title: `A ${d.bore} mm pocket ${d.boreDepth} mm deep, so a socket head sits flush` },
          { value: "countersink", label: "Countersink", title: `A 90° cone ${d.sink} mm wide, for flat (countersunk) heads` },
        ],
        p.head,
        (v) => set((t) => (t.head = v)),
      ),
    ),
    lengthField("Depth", p.depth, (v) => set((t) => (t.depth = v)), { min: 0 }),
    hint(`Hole ${d[p.fit]} mm. It goes down into the face it's placed on. For 3D printing, holes come out a little small: Normal or Loose fit allows for that.`),
  ];
}

// ---- Colour, hollow, mirror, repeat ---------------------------------------------

const SWATCHES = ["#3ddc97", "#4aa3ff", "#ff6b6b", "#ffb020", "#a77bff", "#ff7ac6", "#f2f2f2", "#555b66"];

/** Colour swatches (plus a picker) for one or more objects. */
function colourRow(ids: string[], current: string | undefined): HTMLElement {
  const row = document.createElement("div");
  row.className = "swatches";
  const setColour = (c: string | undefined) =>
    commit((features) => {
      for (const id of ids) {
        const t = features.find((x) => x.id === id);
        if (!t) continue;
        if (c) t.color = c;
        else delete t.color;
      }
    });
  const plain = button("", () => setColour(undefined), `swatch none${current ? "" : " active"}`);
  plain.title = "Default colour";
  row.append(plain);
  for (const c of SWATCHES) {
    const b = button("", () => setColour(c), `swatch${current === c ? " active" : ""}`);
    b.style.background = c;
    b.title = c;
    row.append(b);
  }
  const pick = document.createElement("input");
  pick.type = "color";
  pick.value = current ?? "#3ddc97";
  pick.title = "Any colour";
  pick.onchange = () => setColour(pick.value);
  row.append(pick);
  return row;
}

function shellSection(f: Feature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const items: HTMLElement[] = [section("Hollow")];
  const sh = f.shell;
  items.push(
    segmented(
      [
        { value: "off", label: "Solid" },
        { value: "on", label: "Hollow", title: "Hollow it out, keeping walls of a set thickness" },
      ],
      sh ? "on" : "off",
      (v) => update((t) => (v === "on" ? (t.shell = { thickness: 2, open: "top" }) : delete t.shell)),
    ),
  );
  if (sh) {
    items.push(
      lengthField("Wall thickness", sh.thickness, (v) => update((t) => t.shell && (t.shell.thickness = v)), { min: 0 }),
      labeled(
        "Open",
        segmented(
          [
            { value: "top", label: "Top", title: "No top: a cup or open box" },
            { value: "bottom", label: "Bottom", title: "No bottom: a cover or lid" },
            { value: "none", label: "Closed", title: "Sealed, with an empty pocket inside" },
          ],
          sh.open,
          (v) => update((t) => t.shell && (t.shell.open = v)),
        ),
      ),
    );
  }
  return items;
}

/** The middle of some objects' combined bounds (world), e.g. to mirror them in place. */
function centreOf(ids: string[]): Vec3 | null {
  const box = viewport.modelBounds(new Set(ids));
  if (!box) return null;
  const c = box.getCenter(new Vector3());
  return { x: c.x, y: c.y, z: c.z };
}

function mirrorSection(ids: string[]): HTMLElement[] {
  const row = document.createElement("div");
  row.className = "actions";
  for (const axis of ["x", "y", "z"] as const) {
    const b = button(`⇋ ${axis.toUpperCase()}`, () => mirrorObjects(ids, axis));
    b.title = `Flip ${ids.length > 1 ? "them" : "it"} along ${axis.toUpperCase()}, in place`;
    row.append(b);
  }
  return [section("Mirror"), row];
}

function mirrorObjects(ids: string[], axis: "x" | "y" | "z") {
  const c = centreOf(ids);
  if (!c) return;
  const roots = ids.length > 1 ? topSelected() : ids;
  const connected = roots.filter((id) => findFeature(id)?.joint).length;
  commit((features) => roots.forEach((id) => mirrorFeature(features, id, axis, c)));
  if (connected) setNotice("Mirroring took the connection off; add it again if it's needed.");
}

/** Repeat: copies in a row, a grid, or around a circle. */
type PatternDraft = { id: string; type: "linear" | "grid" | "circular"; count: number; countY: number; axis: Axis; spacing: number; spacingY: number; angle: number; centre: Vec3; turn: boolean };
let patternDraft: PatternDraft | null = null;

function patternSection(f: Feature): HTMLElement[] {
  const items: HTMLElement[] = [section("Repeat")];
  const d = patternDraft?.id === f.id ? patternDraft : null;
  if (!d) {
    const open = button("⁂ Repeat…", () => {
      const ext = viewport.objectExtents(f.id);
      const width = ext ? ext[1].x - ext[0].x : 10;
      // Around the parent's middle (or the origin) by default: e.g. holes round a plate.
      patternDraft = { id: f.id, type: "linear", count: 3, countY: 2, axis: "x", spacing: Math.round((width + 5) * 100) / 100, spacingY: Math.round((width + 5) * 100) / 100, angle: 360, centre: { x: 0, y: 0, z: 0 }, turn: true };
      renderProperties();
    }, "wide");
    open.title = "Make copies in a row, a grid, or around a circle (e.g. holes round a flange)";
    items.push(open);
    return items;
  }
  const re = () => renderProperties();
  items.push(
    segmented(
      [
        { value: "linear", label: "Row" },
        { value: "grid", label: "Grid" },
        { value: "circular", label: "Circle" },
      ],
      d.type,
      (v) => ((d.type = v), re()),
    ),
  );
  if (d.type === "circular") {
    items.push(
      lengthField("Copies (total)", d.count, (v) => ((d.count = Math.max(2, Math.min(200, Math.round(v)))), re()), { min: 1, plain: true }),
      lengthField("Total angle", d.angle, (v) => ((d.angle = Math.max(-360, Math.min(360, v))), re()), { unit: "°" }),
      lengthField("Centre X", d.centre.x, (v) => ((d.centre.x = v), re())),
      lengthField("Centre Y", d.centre.y, (v) => ((d.centre.y = v), re())),
    );
    const turn = document.createElement("label");
    turn.className = "toggle";
    turn.innerHTML = `<input type="checkbox" /> Turn copies to face the centre`;
    const box = turn.querySelector("input")!;
    box.checked = d.turn;
    box.onchange = () => ((d.turn = box.checked), re());
    items.push(turn, hint("Around a vertical axis through the centre (in the parent's frame, or the world's)."));
  } else {
    items.push(
      lengthField(d.type === "grid" ? "Copies along X" : "Copies (total)", d.count, (v) => ((d.count = Math.max(1, Math.min(200, Math.round(v)))), re()), { min: 0, plain: true }),
    );
    if (d.type === "linear") items.push(labeled("Direction", segmented(AXES, d.axis, (v) => ((d.axis = v), re()))));
    items.push(lengthField(d.type === "grid" ? "Spacing X" : "Spacing", d.spacing, (v) => ((d.spacing = v), re())));
    if (d.type === "grid") items.push(lengthField("Copies along Y", d.countY, (v) => ((d.countY = Math.max(1, Math.min(200, Math.round(v)))), re()), { min: 0, plain: true }), lengthField("Spacing Y", d.spacingY, (v) => ((d.spacingY = v), re())));
  }
  const n = patternTransforms(d).length;
  const row = document.createElement("div");
  row.className = "actions";
  row.append(button(`⁂ Add ${n} cop${n === 1 ? "y" : "ies"}`, () => applyPattern(f.id, d), "primary"), button("Cancel", () => ((patternDraft = null), re())));
  items.push(row, hint("The blue copies show where they go. Each copy is a normal object you can still edit (holes keep cutting)."));
  return items;
}

/** Where each copy goes, as a move in the parent's frame (the original, at 0, isn't included). */
function patternTransforms(d: PatternDraft): Matrix4[] {
  const out: Matrix4[] = [];
  if (d.type === "circular") {
    const full = Math.abs(Math.abs(d.angle) - 360) < 1e-9;
    const step = (d.angle / (full ? d.count : Math.max(1, d.count - 1))) * (Math.PI / 180);
    const c = d.centre;
    const f = findFeature(d.id);
    const at = f ? new Vector3(f.position.x, f.position.y, f.position.z) : new Vector3();
    for (let i = 1; i < d.count; i++) {
      if (d.turn) {
        out.push(new Matrix4().makeTranslation(c.x, c.y, 0).multiply(new Matrix4().makeRotationZ(step * i)).multiply(new Matrix4().makeTranslation(-c.x, -c.y, 0)));
      } else {
        // Only the position goes round; it keeps facing the same way.
        const p = at.clone().sub(new Vector3(c.x, c.y, 0)).applyAxisAngle(new Vector3(0, 0, 1), step * i).add(new Vector3(c.x, c.y, 0));
        out.push(new Matrix4().makeTranslation(p.x - at.x, p.y - at.y, 0));
      }
    }
    return out;
  }
  const ny = d.type === "grid" ? d.countY : 1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < d.count; i++) {
      if (!i && !j) continue;
      const v = new Vector3();
      if (d.type === "grid") v.set(i * d.spacing, j * d.spacingY, 0);
      else v[d.axis] = i * d.spacing;
      out.push(new Matrix4().makeTranslation(v.x, v.y, v.z));
    }
  }
  return out;
}

/** The copies' placements in the object's own frame (for the preview). */
function patternPreview(d: PatternDraft): Matrix4[] {
  const f = findFeature(d.id);
  if (!f) return [];
  const L = localMatrix(f);
  return patternTransforms(d).map((t) => L.clone().invert().multiply(t).multiply(L));
}

function applyPattern(id: string, d: PatternDraft) {
  const f = findFeature(id);
  if (!f) return;
  const parentWorld = worldMatrix(doc.features, f.parentId);
  const transforms = patternTransforms(d);
  const copies = transforms.map((t, i) => {
    const clones = cloneSubtree(f);
    clones[0].name = `${f.name} (${i + 2})`;
    return { clones, world: parentWorld.clone().multiply(t).multiply(localMatrix(f)) };
  });
  commit((features) => {
    for (const c of copies) {
      insertFeatures(features, c.clones);
      setWorldMatrix(features, c.clones[0].id, c.world);
    }
  });
  patternDraft = null;
  renderProperties();
  setNotice(`Added ${copies.length} cop${copies.length === 1 ? "y" : "ies"} of ${f.name}.`);
}

// ---- Several objects selected ---------------------------------------------------

function multiPanel(): HTMLElement[] {
  const ids = topSelected();
  const title = document.createElement("h3");
  title.textContent = `${selectedIds.length} objects selected`;
  const items: HTMLElement[] = [title, section("Align")];
  const AX = [
    { axis: "x" as const, labels: ["⇤ Left", "Centre", "Right ⇥"] },
    { axis: "y" as const, labels: ["Front", "Centre", "Back"] },
    { axis: "z" as const, labels: ["Bottom", "Middle", "Top"] },
  ];
  for (const { axis, labels } of AX) {
    const row = document.createElement("div");
    row.className = "align-row";
    const tag = document.createElement("span");
    tag.textContent = axis.toUpperCase();
    row.append(tag, ...(["min", "mid", "max"] as const).map((where, i) => {
      const b = button(labels[i], () => alignObjects(ids, axis, where));
      b.title = `Line up their ${labels[i].replace(/[⇤⇥ ]/g, "").toLowerCase()} ${axis === "z" ? "" : "sides "}along ${axis.toUpperCase()}`;
      return b;
    }));
    items.push(row);
  }
  if (ids.length >= 3) {
    const row = document.createElement("div");
    row.className = "actions";
    for (const axis of ["x", "y", "z"] as const) {
      const b = button(`Space ${axis.toUpperCase()}`, () => distributeObjects(ids, axis));
      b.title = `Even gaps between them along ${axis.toUpperCase()} (the outer two stay put)`;
      row.append(b);
    }
    items.push(section("Distribute"), row);
  }
  items.push(section("Colour"), colourRow(selectedIds, findFeature(selectedId)?.color), ...mirrorSection(selectedIds));
  const actions = document.createElement("div");
  actions.className = "actions";
  const group = button("▤ Group", groupSelected);
  group.title = "Put them in a new group (Ctrl+G)";
  actions.append(group, button("Duplicate", duplicateSelected), button(`Delete ${selectedIds.length}`, deleteSelected, "danger"));
  items.push(section("Selection"), actions, hint("Drag the gizmo to move them all together. Shift-click adds or removes one; Esc clears the selection."));
  return items;
}

/** World bounds of one object (and what's inside it): exact for a plain primitive, else from its mesh. */
function boundsOf(id: string) {
  const f = findFeature(id);
  const ext = f && !childrenOf(doc.features, id).length ? featureExtents(f) : null;
  if (!ext) return viewport.modelBounds(new Set([id]));
  const world = worldMatrix(doc.features, id);
  const box = new Box3();
  for (let i = 0; i < 8; i++) box.expandByPoint(new Vector3(i & 1 ? ext[1].x : ext[0].x, i & 2 ? ext[1].y : ext[0].y, i & 4 ? ext[1].z : ext[0].z).applyMatrix4(world));
  return box;
}

function alignObjects(ids: string[], axis: Axis, where: "min" | "mid" | "max") {
  const boxes = ids.map((id) => ({ id, box: boundsOf(id) })).filter((x) => x.box);
  if (boxes.length < 2) return;
  const pick = (b: NonNullable<ReturnType<typeof boundsOf>>) => (where === "min" ? b.min[axis] : where === "max" ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2);
  const all = boxes.map((x) => x.box!);
  const target = where === "min" ? Math.min(...all.map((b) => b.min[axis])) : where === "max" ? Math.max(...all.map((b) => b.max[axis])) : (Math.min(...all.map((b) => b.min[axis])) + Math.max(...all.map((b) => b.max[axis]))) / 2;
  commit((features) => {
    for (const { id, box } of boxes) {
      const d = Math.round((target - pick(box!)) * 1e4) / 1e4;
      if (Math.abs(d) > 1e-9) translateWorld(features, id, { x: axis === "x" ? d : 0, y: axis === "y" ? d : 0, z: axis === "z" ? d : 0 });
    }
  });
}

function distributeObjects(ids: string[], axis: Axis) {
  const boxes = ids.map((id) => ({ id, box: boundsOf(id)! })).filter((x) => x.box).sort((a, b) => a.box.min[axis] + a.box.max[axis] - (b.box.min[axis] + b.box.max[axis]));
  if (boxes.length < 3) return;
  const span = boxes.at(-1)!.box.max[axis] - boxes[0].box.min[axis];
  const sizes = boxes.reduce((s, x) => s + (x.box.max[axis] - x.box.min[axis]), 0);
  const gap = (span - sizes) / (boxes.length - 1);
  commit((features) => {
    let at = boxes[0].box.max[axis] + gap;
    for (const { id, box } of boxes.slice(1, -1)) {
      const d = Math.round((at - box.min[axis]) * 1e4) / 1e4;
      translateWorld(features, id, { x: axis === "x" ? d : 0, y: axis === "y" ? d : 0, z: axis === "z" ? d : 0 });
      at += box.max[axis] - box.min[axis] + gap;
    }
  });
}

/** Put the selected objects into a new group (they stay where they are). */
function groupSelected() {
  const ids = topSelected();
  if (!ids.length) return;
  const parents = new Set(ids.map((id) => findFeature(id)?.parentId ?? null));
  const parentId = parents.size === 1 ? [...parents][0] : null;
  const group = createFeature("group", doc.features, parentId);
  const box = viewport.modelBounds(new Set(ids));
  commit((features) => {
    insertFeatures(features, [group]);
    if (box) {
      const c = box.getCenter(new Vector3());
      setWorldMatrix(features, group.id, new Matrix4().makeTranslation(Math.round(c.x * 100) / 100, Math.round(c.y * 100) / 100, Math.round(box.min.z * 100) / 100));
    }
    for (const id of ids) reparent(features, id, group.id);
  });
  selectedIds = [group.id];
  selectedId = group.id;
  renderPanels();
  setNotice(`Grouped ${ids.length} objects.`);
}

// ---- Copy and paste --------------------------------------------------------------

const CLIP_MARK = "gizmocad-clipboard";

function copySelected() {
  const ids = topSelected();
  if (!ids.length) return;
  // Each copied object with everything inside it; tops keep their place in the world.
  const items = ids.flatMap((id) => {
    const sub = subtreeIds(doc.features, id);
    return doc.features.filter((f) => sub.has(f.id)).map((f) => ({ feature: f, world: f.id === id ? worldMatrix(doc.features, id).toArray() : null }));
  });
  clipboard = JSON.stringify({ [CLIP_MARK]: 1, items });
  navigator.clipboard?.writeText(clipboard).catch(() => {});
  setNotice(`Copied ${ids.length} object${ids.length > 1 ? "s" : ""}. Ctrl+V pastes (in this or another GizmoCAD window).`);
}

async function paste() {
  let text = clipboard;
  try {
    const sys = await navigator.clipboard?.readText();
    if (sys && sys.includes(CLIP_MARK)) text = sys;
  } catch {
    // No permission to read the system clipboard: use our own copy.
  }
  if (!text) return;
  let data: { items: { feature: Feature; world: number[] | null }[] };
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }
  const idMap = new Map(data.items.map((x) => [x.feature.id, newId()]));
  const roots: { id: string; world: Matrix4 }[] = [];
  const features = data.items.map(({ feature, world }) => {
    const f = structuredClone(feature);
    f.id = idMap.get(feature.id)!;
    if (world) {
      // A top: pasted at the top level, a little to the side of the original.
      f.parentId = null;
      delete f.joint;
      const m = new Matrix4().fromArray(world);
      m.premultiply(new Matrix4().makeTranslation(10, 10, 0));
      roots.push({ id: f.id, world: m });
      f.name = findFeature(feature.id) ? `${feature.name} copy` : feature.name;
    } else f.parentId = idMap.get(f.parentId!) ?? null;
    return f;
  });
  commit((all) => {
    insertFeatures(all, features);
    for (const r of roots) setWorldMatrix(all, r.id, r.world);
  });
  // Next paste goes further along.
  clipboard = JSON.stringify({ [CLIP_MARK]: 1, items: data.items.map((x) => ({ ...x, world: x.world ? new Matrix4().fromArray(x.world).premultiply(new Matrix4().makeTranslation(10, 10, 0)).toArray() : null })) });
  selectedIds = roots.map((r) => r.id);
  selectedId = selectedIds[0] ?? null;
  renderPanels();
}

// ---- History ------------------------------------------------------------------------

/** The strip of steps under the view: roll back to see (and edit) the model as it was, switch steps off. */
function renderHistory() {
  const bar = $("#history-steps");
  const chips: HTMLElement[] = [];
  const end = historyMarker ?? doc.features.length;
  doc.features.forEach((f, i) => {
    if (i === end && historyMarker !== null) chips.push(markerEl());
    const chip = document.createElement("button");
    chip.className = ["step", i >= end ? "future" : "", f.suppressed ? "off" : "", selectedIds.includes(f.id) ? "selected" : ""].join(" ");
    chip.textContent = `${KIND_ICON[f.kind]} ${f.name}`;
    chip.title = `${i + 1}. ${f.name}${f.suppressed ? " (switched off)" : ""}${i >= end ? " (after the marker: not in the model right now)" : ""}. Right-click for options.`;
    chip.onclick = () => (i < end ? selectObject(f.id) : setNotice(`${f.name} comes after the history marker; roll forward to see it.`));
    chip.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(
        [
          { label: "Roll back to here", action: () => setHistoryMarker(i + 1) },
          { label: "Roll back to before this", action: () => setHistoryMarker(i) },
          { label: f.suppressed ? "Switch on" : "Switch off (suppress)", action: () => commit((fs) => {
            const t = fs.find((x) => x.id === f.id);
            if (t) t.suppressed = !t.suppressed || undefined;
            if (t && !t.suppressed) delete t.suppressed;
          }) },
          { label: "Delete", danger: true, action: () => ((selectedIds = [f.id]), (selectedId = f.id), deleteSelected()) },
        ],
        e.clientX,
        e.clientY,
      );
    };
    chips.push(chip);
  });
  if (historyMarker === null || historyMarker >= doc.features.length) chips.push(markerEl());
  bar.replaceChildren(...chips);
  ($("#history-back") as HTMLButtonElement).disabled = end === 0;
  ($("#history-forward") as HTMLButtonElement).disabled = historyMarker === null;
  ($("#history-end") as HTMLButtonElement).disabled = historyMarker === null;
  $("#history").classList.toggle("rolled-back", historyMarker !== null);
  const n = doc.features.length;
  $("#history-count").textContent = historyMarker === null ? `${n} step${n === 1 ? "" : "s"}` : `Step ${historyMarker} of ${n}`;
}

function markerEl() {
  const m = document.createElement("span");
  m.className = "history-marker";
  m.title = "The model is shown as it is at this point. New objects go here.";
  return m;
}

function setHistoryMarker(at: number | null) {
  historyMarker = at === null || at >= doc.features.length ? null : Math.max(0, at);
  // Objects after the marker can't stay selected.
  const active = new Set(activeFeatures(doc.features).map((f) => f.id));
  selectedIds = selectedIds.filter((id) => active.has(id));
  if (selectedId && !active.has(selectedId)) selectedId = selectedIds[0] ?? null;
  if (historyMarker !== null) setNotice(`Rolled back to step ${historyMarker}: later steps are hidden until you roll forward. Edits here flow through to them.`);
  refresh();
}

// ---- Split & dividers -----------------------------------------------------

const AXES: { value: Axis; label: string }[] = [
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
  { value: "z", label: "Z" },
];

/** The "Split & dividers" panel section: closed, it's two buttons; open, the tool's settings. */
function cutSection(f: Feature): HTMLElement[] {
  const ext = viewport.objectExtents(f.id);
  if (!ext) return [];
  const [min, max] = ext;
  const items: HTMLElement[] = [section("Split & dividers")];
  const mid = (a: Axis) => Math.round(((min[a] + max[a]) / 2) * 1e4) / 1e4 + 0;

  if (splitDraft?.id === f.id) {
    const d = splitDraft;
    const [lo, hi] = splitRange(d, min, max);
    // Changing the direction spreads the cuts evenly again across the new range.
    const redirect = (change: Partial<typeof d>) => {
      Object.assign(d, change);
      if (d.toward === d.axis) d.toward = AXES.find((a) => a.value !== d.axis)!.value;
      spreadCuts(d, ...splitRange(d, min, max));
      renderProperties();
    };
    items.push(
      labeled("Cut across", segmented(AXES, d.axis, (axis) => redirect({ axis }))),
      lengthField("Tilt", d.tilt, (v) => redirect({ tilt: Math.max(-89, Math.min(89, v)) }), { unit: "°" }),
    );
    if (d.tilt) {
      items.push(labeled("Tilt towards", segmented(AXES.filter((a) => a.value !== d.axis), d.toward, (toward) => redirect({ toward }))));
    }
    d.cuts.forEach((at, i) => {
      const field = lengthField(d.cuts.length > 1 ? `Cut ${i + 1} at` : "Cut at", at, (v) => ((d.cuts[i] = v), (d.active = i), renderProperties()));
      if (i === d.active && d.cuts.length > 1) field.classList.add("active-cut");
      field.addEventListener("focusin", () => {
        if (d.active !== i) {
          d.active = i;
          viewport.setPreview(cutPreviewBoxes());
          syncCutHandle();
        }
      });
      items.push(field);
    });
    const tools = document.createElement("div");
    tools.className = "actions";
    const add = button("+ Cut", () => {
      // Into the middle of the biggest gap.
      const pts = [lo, ...[...d.cuts].sort((a, b) => a - b), hi];
      let best = 0;
      for (let i = 1; i < pts.length - 1; i++) if (pts[i + 1] - pts[i] > pts[best + 1] - pts[best]) best = i;
      d.cuts.push(Math.round(((pts[best] + pts[best + 1]) / 2) * 100) / 100);
      d.active = d.cuts.length - 1;
      renderProperties();
    });
    add.title = "Add another cut, for more pieces";
    const remove = button("− Cut", () => {
      d.cuts.splice(d.active, 1);
      d.active = Math.min(d.active, d.cuts.length - 1);
      renderProperties();
    });
    remove.disabled = d.cuts.length < 2;
    remove.title = "Remove the highlighted cut";
    const even = button("Even spacing", () => (spreadCuts(d, lo, hi), renderProperties()));
    even.title = "Space the cuts evenly, making equal pieces";
    tools.append(add, remove, even);
    items.push(
      tools,
      hint(
        `${d.cuts.length + 1} pieces. Red planes show the cuts: drag the arrow to move the highlighted one${d.cuts.length > 1 ? " (click a cut's field to pick it)" : ""}. ` +
          `Cuts can go from ${fmt(lo)} to ${fmt(hi)} mm. All pieces stay editable.`,
      ),
    );
    const row = document.createElement("div");
    row.className = "actions";
    row.append(button(`✂ Split into ${d.cuts.length + 1}`, () => splitObject(f.id, d), "primary"), button("Cancel", closeCutTools));
    items.push(row);
    return items;
  }

  if (dividerDraft?.id === f.id) {
    const d = dividerDraft;
    items.push(
      labeled(
        "Walls across",
        segmented(
          [
            { value: "x", label: "X", title: "Walls at even steps along X (each wall runs along Y)" },
            { value: "y", label: "Y", title: "Walls at even steps along Y (each wall runs along X)" },
          ],
          d.axis,
          (axis) => ((d.axis = axis), renderProperties()),
        ),
      ),
      lengthField("Dividers", d.count, (v) => ((d.count = Math.max(1, Math.min(50, Math.round(v)))), renderProperties()), { min: 1, plain: true }),
      lengthField("Thickness", d.thickness, (v) => ((d.thickness = v), renderProperties()), { min: 0 }),
      lengthField("Height", d.height, (v) => ((d.height = v), renderProperties()), { min: 0 }),
      hint("Evenly spaced walls, added as boxes in a new “Dividers” group so you can still move or resize them. The blue shapes show where they go."),
    );
    const row = document.createElement("div");
    row.className = "actions";
    row.append(button("▥ Add dividers", () => addDividers(f.id), "primary"), button("Cancel", closeCutTools));
    items.push(row);
    return items;
  }

  const row = document.createElement("div");
  row.className = "actions";
  const split = button("✂ Split in two…", () => {
    dividerDraft = null;
    const axis: Axis = max.x - min.x >= max.y - min.y ? "x" : "y";
    splitDraft = { id: f.id, axis, tilt: 0, toward: "z", cuts: [mid(axis)], active: 0 };
    renderProperties();
  });
  split.title = "Cut this object into separate pieces, straight or at an angle";
  const dividers = button("▥ Dividers…", () => {
    splitDraft = null;
    dividerDraft = { id: f.id, axis: max.x - min.x >= max.y - min.y ? "x" : "y", count: 1, thickness: 2, height: Math.round((max.z - min.z) * 1e4) / 1e4 };
    renderProperties();
  });
  dividers.title = "Add evenly spaced divider walls, e.g. inside a tray";
  row.append(split, dividers);
  items.push(row);
  return items;
}

const fmt = (v: number) => String(Math.round(v * 100) / 100 + 0);

function closeCutTools() {
  splitDraft = null;
  dividerDraft = null;
  renderProperties();
}

/** Where the open tool's preview goes, in the object's own frame. */
function cutPreviewBoxes(): PreviewSpec | null {
  const draft = splitDraft ?? dividerDraft;
  const ext = draft && viewport.objectExtents(draft.id);
  if (!draft || !ext) return null;
  const [min, max] = ext;
  if (splitDraft) {
    const normal = splitNormal(splitDraft);
    return { id: draft.id, boxes: [], style: "cut", planes: splitDraft.cuts.map((at, i) => ({ normal, at, active: i === splitDraft!.active })) };
  }
  return { id: draft.id, boxes: dividerBoxes(dividerDraft!, min, max), style: "add" };
}

/** The cuts' direction: the axis, tilted by `tilt` degrees towards `toward`. */
function splitNormal(d: NonNullable<typeof splitDraft>): Vec3 {
  const unit = (a: Axis) => ({ x: a === "x" ? 1 : 0, y: a === "y" ? 1 : 0, z: a === "z" ? 1 : 0 });
  const t = (d.tilt * Math.PI) / 180;
  const [a, b] = [unit(d.axis), unit(d.toward)];
  const r = (v: number) => Math.round(v * 1e9) / 1e9 + 0;
  return { x: r(a.x * Math.cos(t) + b.x * Math.sin(t)), y: r(a.y * Math.cos(t) + b.y * Math.sin(t)), z: r(a.z * Math.cos(t) + b.z * Math.sin(t)) };
}

/** How far the object reaches along the cut normal (from its box corners). */
function splitRange(d: NonNullable<typeof splitDraft>, min: Vec3, max: Vec3): [number, number] {
  const n = splitNormal(d);
  const reach = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => n.x * (i & 1 ? max.x : min.x) + n.y * (i & 2 ? max.y : min.y) + n.z * (i & 4 ? max.z : min.z));
  return [Math.min(...reach), Math.max(...reach)];
}

function spreadCuts(d: NonNullable<typeof splitDraft>, lo: number, hi: number) {
  const k = d.cuts.length;
  d.cuts = d.cuts.map((_, i) => Math.round((lo + ((hi - lo) * (i + 1)) / (k + 1)) * 100) / 100 + 0);
}

/** The arrow on the highlighted cut (or none when the split tool is closed). */
function syncCutHandle() {
  const d = splitDraft;
  viewport.setCutHandle(
    d && !editingSketchId && !sculptingId
      ? {
          id: d.id,
          normal: splitNormal(d),
          at: d.cuts[d.active],
          onMove(at) {
            d.cuts[d.active] = at;
            viewport.setPreview(cutPreviewBoxes());
            setStatus(`Cut ${d.cuts.length > 1 ? `${d.active + 1} ` : ""}at ${fmt(at)} mm`);
          },
          onDone(at) {
            d.cuts[d.active] = at;
            setStatus("");
            renderProperties();
          },
        }
      : null,
  );
}

function dividerBoxes(d: NonNullable<typeof dividerDraft>, min: Vec3, max: Vec3): [Vec3, Vec3][] {
  const other = d.axis === "x" ? "y" : "x";
  return Array.from({ length: d.count }, (_, i) => {
    const c = min[d.axis] + ((max[d.axis] - min[d.axis]) * (i + 1)) / (d.count + 1);
    const a = { x: 0, y: 0, z: min.z };
    const b = { x: 0, y: 0, z: min.z + d.height };
    a[d.axis] = c - d.thickness / 2;
    b[d.axis] = c + d.thickness / 2;
    a[other] = min[other];
    b[other] = max[other];
    return [a, b];
  });
}

/** Cut an object (and what's inside it) in two: it keeps one side, a copy keeps the other. */
/**
 * Cut an object (and what's inside it) into pieces at the planned cuts: it
 * keeps the first piece, and a copy keeps each of the others.
 */
function splitObject(id: string, d: NonNullable<typeof splitDraft>) {
  const f = findFeature(id);
  const ext = viewport.objectExtents(id);
  if (!f || !ext) return;
  const [lo, hi] = splitRange(d, ...ext);
  const cuts = [...new Set(d.cuts.map((c) => Math.round(c * 1e4) / 1e4))].sort((a, b) => a - b);
  if (cuts.some((c) => c <= lo + 1e-6 || c >= hi - 1e-6)) {
    setNotice(`Every cut must go through the object: keep them between ${fmt(lo)} and ${fmt(hi)} mm.`);
    return;
  }
  const normal = d.tilt ? splitNormal(d) : undefined;
  const clip = (at: number, keep: "below" | "above") => ({ axis: d.axis, at, keep, ...(normal ? { normal } : {}) });
  const name = f.name;
  const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
  // Piece i lies between cut i-1 and cut i.
  const pieces = cuts.map((_, i) => {
    const clones = cloneSubtree(f);
    const root = clones[0];
    root.name = `${name} ${letter(i + 1)}`;
    root.clips = [...(f.clips ?? []), clip(cuts[i], "above"), ...(i + 1 < cuts.length ? [clip(cuts[i + 1], "below")] : [])];
    return clones;
  });
  commit((features) => {
    const orig = features.find((x) => x.id === id)!;
    orig.name = `${name} A`;
    orig.clips = [...(orig.clips ?? []), clip(cuts[0], "below")];
    for (const clones of pieces) insertFeatures(features, clones);
  });
  splitDraft = null;
  selectedId = pieces[0][0].id;
  selectedIds = [selectedId];
  renderPanels();
  setNotice(`Split ${name} into ${cuts.length + 1} pieces (A–${letter(cuts.length)}). Move any piece to pull them apart.`);
}

/**
 * Add the planned dividers as boxes in a new group placed like the object.
 * They go beside the object (not inside it) so its holes don't cut them; if
 * it sits in a group with holes, they go outside that group too.
 */
function addDividers(id: string) {
  const f = findFeature(id);
  const d = dividerDraft;
  const ext = viewport.objectExtents(id);
  if (!f || !d || !ext || d.thickness <= 0 || d.height <= 0) return;
  const group = createFeature("group", doc.features, f.parentId);
  group.name = "Dividers";
  group.position = { ...f.position };
  group.rotation = { ...f.rotation };
  const walls = dividerBoxes(d, ext[0], ext[1]).map(([a, b], i) => {
    const w = createFeature("box", [], group.id) as Extract<Feature, { kind: "box" }>;
    w.name = `Divider ${i + 1}`;
    w.params = { width: round4(b.x - a.x), depth: round4(b.y - a.y), height: round4(b.z - a.z) };
    w.position = { x: round4((a.x + b.x) / 2), y: round4((a.y + b.y) / 2), z: round4(a.z) };
    return w;
  });
  commit((features) => {
    insertFeatures(features, [group, ...walls]);
    let host = f.parentId;
    while (host && childrenOf(features, host).some((c) => c.mode === "hole")) host = features.find((x) => x.id === host)?.parentId ?? null;
    if (host !== f.parentId) reparent(features, group.id, host);
  });
  dividerDraft = null;
  selectedId = group.id;
  selectedIds = [group.id];
  renderPanels();
  setNotice(`Added ${walls.length} divider${walls.length > 1 ? "s" : ""}.`);
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

// ---- Properties ----------------------------------------------------------

function renderProperties() {
  // The split/divider/repeat tools close when another object (or none) is selected.
  if (splitDraft && splitDraft.id !== selectedId) splitDraft = null;
  if (dividerDraft && dividerDraft.id !== selectedId) dividerDraft = null;
  if (patternDraft && (patternDraft.id !== selectedId || selectedIds.length > 1)) patternDraft = null;
  renderPropertiesPanel();
  const preview = patternDraft ? { id: patternDraft.id, style: "add" as const, boxes: [], copies: patternPreview(patternDraft).map((m) => m.toArray()) } : cutPreviewBoxes();
  viewport.setPreview(editingSketchId || sculptingId ? null : preview);
  // While splitting, an arrow on the highlighted cut drags it.
  syncCutHandle();
}

function renderPropertiesPanel() {
  const panel = $("#properties");
  const f = selected();
  if (editingSketchId && sketchEditor && editingSketch()) return renderSketchPanel(panel, editingSketch()!, sketchEditor);
  const sculpting = findFeature(sculptingId);
  if (sculpting?.kind === "sculpt") return panel.replaceChildren(...sculptPanel(sculpting));
  if (f && selectedIds.length > 1) return panel.replaceChildren(...multiPanel());
  if (!f) {
    panel.innerHTML = `<p class="hint">Select an object to edit its exact dimensions.</p>`;
    panel.append(
      hint("Fields accept units and maths, e.g. <code>1in</code>, <code>2.5cm</code>, <code>40/3</code>."),
      hint("Drag objects onto each other in the list to make parent/child groups. Children move with their parent, and a child hole only cuts its parent."),
      hint("Shift-click or Shift-drag a box to select several objects, then align, group or move them together."),
    );
    return;
  }
  const update = (mutate: (f: Feature) => void) =>
    commit((features) => {
      const target = features.find((x) => x.id === f.id);
      if (target) mutate(target);
    });

  const name = document.createElement("input");
  name.className = "name-input";
  name.value = f.name;
  name.onkeydown = (e) => {
    if (e.key === "Enter") name.blur();
    e.stopPropagation();
  };
  name.onblur = () => name.value.trim() && name.value !== f.name && update((t) => (t.name = name.value.trim()));

  const items: HTMLElement[] = [name];

  if (f.kind !== "group" && f.kind !== "plane" && f.kind !== "sculpt") {
    items.push(
      segmented(
        [
          { value: "solid", label: "Solid" },
          { value: "hole", label: "Hole" },
        ],
        f.mode,
        (m) => update((t) => (t.mode = m)),
        "mode",
      ),
    );
  }

  if (f.kind === "sculpt") {
    items.push(button("✋ Sculpt", () => startSculpt(f.id), "primary wide"), section("Clay"), ...sculptSettings(f, update));
  } else if (f.kind === "sketch") {
    items.push(section("Sketch"), ...sketchSettings(f, update), button("✎ Edit sketch", () => startSketchEdit(f.id), "primary wide"));
  } else if (f.kind === "spring") {
    items.push(section("Spring"), ...springFields(f, update));
  } else if (f.kind === "text") {
    items.push(section("Text"), ...textFields(f, update));
  } else if (f.kind === "screw") {
    items.push(section("Screw hole"), ...screwFields(f, update));
  } else if (PARAM_FIELDS[f.kind]) {
    items.push(
      section("Size"),
      ...PARAM_FIELDS[f.kind]!.map(({ key, label, factor = 1, count }) =>
        lengthField(
          label,
          (f.params as unknown as Record<string, number>)[key] * factor,
          (v) => update((t) => ((t.params as unknown as Record<string, number>)[key] = count ? Math.max(count[0], Math.min(count[1], Math.round(v))) : v / factor)),
          count ? { min: count[0], plain: true } : { min: 0 },
        ),
      ),
    );
  }
  if (f.kind === "thread") {
    items.push(hint("For a nut or threaded hole, make it a <b>Hole</b> inside the part. For 3D printing, add about 0.3 mm to a hole's diameter so the bolt fits."));
  }
  if (f.kind === "gear") {
    const { teeth, module: m } = f.params;
    items.push(
      hint(
        `Outside diameter ${fmt(gearOuterRadius(teeth, m) * 2)} mm. Two gears mesh when they share the same module, ` +
          `with their centres (teeth₁ + teeth₂) × module ÷ 2 apart (e.g. ${fmt(((Math.round(teeth) + 10) * m) / 2)} mm to a 10-tooth gear).`,
      ),
    );
  }

  items.push(
    section(f.joint ? `Position at ${f.joint.type === "slider" ? "0 mm" : "0°"} (relative to parent)` : f.parentId ? "Position (relative to parent)" : "Position"),
    ...(["x", "y", "z"] as const).map((axis) => lengthField(axis.toUpperCase(), f.position[axis], (v) => update((t) => (t.position[axis] = v)))),
    section("Rotation"),
    ...(["x", "y", "z"] as const).map((axis) =>
      lengthField(`Around ${axis.toUpperCase()}`, f.rotation[axis], (v) => update((t) => (t.rotation[axis] = v)), { unit: "°" }),
    ),
    section("Parent"),
    parentSelect(f),
  );
  if (f.kind !== "plane" && f.kind !== "group") items.push(section("Colour"), colourRow([f.id], f.color));
  // A flat sketch has no solid yet, so nothing to round, cut or sculpt.
  const flat = f.kind === "sketch" && f.params.operation === "flat";
  if (FINISHABLE.includes(f.kind) && !flat) {
    items.push(...edgeSection(f, update));
    items.push(...shellSection(f, update));
    const sculpt = button("✋ Sculpt this object", () => void convertToSculpt(f.id), "wide");
    sculpt.title = "Turn this object into clay you can sculpt with brushes (Ctrl+Z to undo)";
    items.push(section("Sculpt"), sculpt, hint(f.kind === "group" ? "The group's merged shape becomes one piece of clay." : "Turns the exact shape into clay; dimensions and fillets stop being editable."));
  }

  items.push(...connectionSection(f, update));
  if (!["group", "plane", "sculpt"].includes(f.kind) && !flat) items.push(...cutSection(f));
  if (f.kind !== "plane") items.push(...mirrorSection([f.id]), ...patternSection(f));

  const kids = childrenOf(doc.features, f.id).length;
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(button("Duplicate", duplicateSelected), button(kids ? `Delete (+${kids})` : "Delete", deleteSelected, "danger"));
  items.push(actions);
  if (f.kind === "group") items.push(hint("Groups have no shape of their own. Add shapes to a group by selecting it and clicking a shape, or by dragging in the list."));
  if (f.kind === "plane") {
    items.splice(1, 0, button("✎ New sketch on this plane", () => addShape("sketch"), "primary wide"));
    items.push(hint("Tilt the plane with the rotation fields or the rotate gizmo (E). Sketches and shapes inside it follow it."));
  }

  panel.replaceChildren(...items);
}

const TARGETS: { value: EdgeTarget; label: string }[] = [
  { value: "all", label: "All edges" },
  { value: "top", label: "Top edges" },
  { value: "bottom", label: "Bottom edges" },
  { value: "vertical", label: "Vertical edges" },
  { value: "picked", label: "Picked edges" },
];

function edgeSection(f: Feature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const items: HTMLElement[] = [section("Edges: fillet & chamfer")];
  const setOp = (opId: string, mutate: (op: EdgeOp) => void) =>
    update((t) => {
      const op = t.edgeOps.find((o) => o.id === opId);
      if (op) mutate(op);
    });

  f.edgeOps.forEach((op) => {
    const box = document.createElement("div");
    box.className = `edge-op${edgePick?.opId === op.id ? " picking" : ""}`;

    const head = document.createElement("div");
    head.className = "edge-op-head";
    head.append(
      segmented(
        [
          { value: "fillet", label: "◜ Fillet", title: "Round the edges" },
          { value: "chamfer", label: "◸ Chamfer", title: "Bevel the edges with a flat cut" },
        ],
        op.type,
        (v) => setOp(op.id, (o) => (o.type = v)),
      ),
      button("✕", () => {
        if (edgePick?.opId === op.id) stopEdgePick();
        update((t) => (t.edgeOps = t.edgeOps.filter((o) => o.id !== op.id)));
      }, "icon"),
    );
    (head.lastElementChild as HTMLElement).title = "Remove";

    const target = document.createElement("select");
    for (const o of TARGETS) target.add(new Option(o.label, o.value));
    target.value = op.target;
    target.onchange = () => {
      const value = target.value as EdgeTarget;
      setOp(op.id, (o) => (o.target = value));
      if (value === "picked" && !op.points.length) startEdgePick(f.id, op.id);
    };

    box.append(head, lengthField(op.type === "fillet" ? "Radius" : "Distance", op.size, (v) => setOp(op.id, (o) => (o.size = v)), { min: 0 }), labeled("Edges", target));

    // Too big for this shape: say what size was used instead, and offer to adopt it.
    const used = edgeAdjustments[op.id];
    if (used !== undefined) {
      const note = document.createElement("div");
      note.className = "safe-note";
      if (used > 0) {
        note.append(`Too big for these edges, so ${formatLength(used)} mm (the largest safe size) is used.`);
        note.append(button(`Set to ${formatLength(used)}`, () => setOp(op.id, (o) => (o.size = used)), "link"));
      } else {
        note.append("These edges can't be rounded at any size, so this step is skipped.");
      }
      box.append(note);
    }

    if (op.target === "picked") {
      const picking = edgePick?.opId === op.id;
      const row = document.createElement("div");
      row.className = "pick-row";
      const count = document.createElement("span");
      count.textContent = `${op.points.length} edge${op.points.length === 1 ? "" : "s"} picked`;
      row.append(count, button(picking ? "✓ Done" : "Pick edges", () => (picking ? stopEdgePick() : startEdgePick(f.id, op.id)), picking ? "primary" : ""));
      box.append(row);
      if (picking) box.append(hint("Click edges in the view to add or remove them. Orange = picked."));
    }
    items.push(box);
  });

  const add = document.createElement("div");
  add.className = "actions";
  const newOp = (type: EdgeOp["type"]) => update((t) => t.edgeOps.push({ id: newId(), type, size: 1, target: "all", points: [] }));
  add.append(button("+ Fillet", () => newOp("fillet")), button("+ Chamfer", () => newOp("chamfer")));
  items.push(add);
  if (f.kind === "group") items.push(hint("Rounding a group merges its shapes first, so you can round edges where they meet, or the rim of a hole."));
  return items;
}

function parentSelect(f: Feature) {
  const sel = document.createElement("select");
  sel.className = "wide";
  const blocked = subtreeIds(doc.features, f.id);
  sel.add(new Option("None (top level)", ""));
  for (const p of doc.features) if (!blocked.has(p.id)) sel.add(new Option(`${KIND_ICON[p.kind]} ${p.name}`, p.id));
  sel.value = f.parentId ?? "";
  sel.onchange = () => moveTo(f.id, sel.value || null);
  return sel;
}

/**
 * Sketch settings. While drawing (`drawing`), only where the sketch sits; in
 * the 3D view, also how it becomes a solid (a new sketch stays flat until then).
 */
function sketchSettings(s: SketchFeature, update: (mutate: (f: Feature) => void) => void, drawing = false): HTMLElement[] {
  const set = (mutate: (p: SketchFeature["params"]) => void) => update((t) => t.kind === "sketch" && mutate(t.params));
  const placement = [
    labeled(
      "Plane",
      segmented(
        (["XY", "XZ", "YZ"] as const).map((v) => ({ value: v, label: v })),
        s.params.plane,
        (v) => set((p) => (p.plane = v)),
      ),
    ),
    lengthField("Plane offset", s.params.offset, (v) => set((p) => (p.offset = v))),
  ];
  if (drawing) return placement;
  if (s.params.operation === "flat") {
    const row = document.createElement("div");
    row.className = "actions";
    const extrude = button("⬆ Extrude", () => set((p) => (p.operation = "extrude")), "primary");
    extrude.title = "Pull the sketch's shapes up into a solid";
    const revolve = button("⟳ Revolve", () => set((p) => (p.operation = "revolve")));
    revolve.title = "Spin the sketch's shapes around its V axis (green line) into a solid";
    row.append(extrude, revolve);
    return [hint("This sketch is flat: it's only a drawing for now. Make it 3D:"), row, ...placement];
  }
  return [
    labeled(
      "Make 3D by",
      segmented(
        [
          { value: "flat", label: "Flat", title: "Back to just the drawing, no solid" },
          { value: "extrude", label: "Extrude" },
          { value: "revolve", label: "Revolve", title: "Spin the profile around the sketch's V axis (green line)" },
        ],
        s.params.operation,
        (v) => set((p) => (p.operation = v)),
      ),
    ),
    ...(s.params.operation === "extrude"
      ? [
          lengthField("Depth", s.params.depth, (v) => set((p) => (p.depth = v))),
          labeled(
            "Direction",
            segmented(
              [
                { value: "normal", label: "Up", title: "Extrude along the plane normal" },
                { value: "reversed", label: "Down", title: "Extrude the other way" },
                { value: "both", label: "Both", title: "Extrude the depth to both sides of the plane" },
              ],
              s.params.direction,
              (v) => set((p) => (p.direction = v)),
            ),
          ),
        ]
      : [lengthField("Angle", s.params.angle, (v) => set((p) => (p.angle = Math.min(360, v))), { min: 0, unit: "°" })]),
    ...placement,
  ];
}

const TOOLS: { value: SketchTool; label: string; key: string; title: string }[] = [
  { value: "select", label: "↖ Select", key: "V", title: "Select, box-select, move and edit shapes. Shift-click adds to the selection. Right-click for options." },
  { value: "point", label: "• Point", key: "O", title: "Reference point to snap to" },
  { value: "line", label: "╱ Line", key: "L", title: "Construction line: a guide to snap to" },
  { value: "rect", label: "▭ Rect", key: "R", title: "Rectangle: drag, or click two corners" },
  { value: "circle", label: "◯ Circle", key: "C", title: "Circle: drag from the centre" },
  { value: "ellipse", label: "⬭ Ellipse", key: "E", title: "Ellipse: drag from the centre to a corner" },
  { value: "ngon", label: "⬡ N-gon", key: "N", title: "Regular polygon: drag from the centre to a corner" },
  { value: "slot", label: "⊂⊃ Slot", key: "S", title: "Slot: drag from one end to the other" },
  { value: "polygon", label: "⬠ Polygon", key: "P", title: "Polygon: click points; close on the first point, double-click or Enter. Drag the orange edge dots to curve edges." },
  { value: "spline", label: "∿ Curve", key: "U", title: "Smooth curve through the points you click. Click the first point again to close it (or double-click / Enter). The dashed part shows how it closes. Put points closer together for tighter bends; hold Alt to place a point off the grid." },
  { value: "brush", label: "≋ Brush", key: "B", title: "Paint freehand: hold and drag. The stroke becomes a shape as wide as the brush." },
  { value: "trim", label: "✂ Trim", key: "T", title: "Click a guide line to cut it back to where it crosses. Click a shape's edge where it runs inside another shape to merge them (or trim it back, if one adds and one cuts); click the part sticking out to trim that off; click a shape's edge on one side of a guide line crossing it to cut that side away." },
  { value: "constrain", label: "📐 Constrain", key: "K", title: "Click points, edges or circles (one or two), then pick a rule or dimension in the panel: horizontal, parallel, equal, tangent, a length…" },
  { value: "split", label: "⫽ Split", key: "X", title: "Click a line or brush stroke to cut it in two there; click a shape's edge to add a corner there (rectangles and N-gons become editable polygons)" },
];

const ENTITY_LABEL: Record<SketchEntityType, string> = {
  rect: "Rectangle",
  circle: "Circle",
  ellipse: "Ellipse",
  ngon: "N-gon",
  slot: "Slot",
  polygon: "Polygon",
  spline: "Curve",
  point: "Point",
  line: "Line",
  stroke: "Brush stroke",
};

const MODE_OPTIONS: { value: EntityMode; label: string; title: string }[] = [
  { value: "add", label: "Add", title: "Part of the solid" },
  { value: "subtract", label: "Cut", title: "Cuts a hole in the solid" },
  { value: "construction", label: "Guide", title: "Construction geometry: drawn dashed, only used for snapping" },
];

const modeTag = (m: EntityMode) => (m === "add" ? ["solid", "add"] : m === "subtract" ? ["hole", "cut"] : ["guide", "guide"]);

function renderSketchPanel(panel: HTMLElement, s: SketchFeature, ed: SketchEditor) {
  sketchPanelKey = panelKey(ed);
  const updateSketch = (mutate: (f: Feature) => void) =>
    commit((features) => {
      const t = features.find((x) => x.id === s.id);
      if (t) mutate(t);
    });
  const updateEntity = (id: string, mutate: (e: SketchEntity) => void) =>
    updateSketch((t) => {
      const e = t.kind === "sketch" ? t.params.entities.find((x) => x.id === id) : undefined;
      if (e) mutate(e);
    });

  const title = document.createElement("h3");
  title.textContent = `✎ ${s.name}`;
  const cursor = document.createElement("div");
  cursor.id = "sketch-cursor";
  cursor.className = "cursor-readout";

  const tools = document.createElement("div");
  tools.className = "tool-grid";
  for (const tool of TOOLS) {
    const b = button(tool.label, () => ed.setTool(tool.value), tool.value === ed.tool ? "active" : "");
    b.title = `${tool.title} (${tool.key})`;
    tools.append(b);
  }

  const items: HTMLElement[] = [title, tools];
  if (ed.tool === "brush") {
    items.push(lengthField("Brush width", ed.brushWidth, (v) => ((ed.brushWidth = v), ed.render(), renderProperties()), { min: 0 }));
  }
  if (ed.tool === "ngon") {
    items.push(lengthField("Sides", ed.ngonSides, (v) => ((ed.ngonSides = Math.max(3, Math.min(64, Math.round(v)))), renderProperties()), { min: 2, plain: true }));
  }
  if (!["select", "point", "line"].includes(ed.tool)) {
    items.push(labeled("New shapes", segmented(MODE_OPTIONS, ed.newMode, (m) => ((ed.newMode = m), sketchStateChanged(), ed.render()), "entity")));
  }
  items.push(cursor);
  if (ed.tool === "constrain") items.push(...constrainPicker(s, ed, updateSketch));
  items.push(...constraintList(s, updateSketch));

  // Shape list.
  const entities = s.params.entities;
  items.push(section(`Shapes (${entities.length})`));
  if (!entities.length) {
    items.push(hint("Pick a tool and draw on the grid. The cursor snaps to existing points (orange ring) and to the grid."));
  } else {
    const list = document.createElement("ul");
    list.className = "entity-list";
    const counts: Partial<Record<SketchEntityType, number>> = {};
    for (const e of entities) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      const li = document.createElement("li");
      li.className = ed.selected.has(e.id) ? "selected" : "";
      const [tagClass, tagText] = modeTag(e.mode);
      li.innerHTML = `<span></span><span class="tag ${tagClass}">${tagText}</span>`;
      li.firstElementChild!.textContent = `${ENTITY_LABEL[e.type]} ${counts[e.type]}`;
      li.onclick = (ev) => {
        if (ev.shiftKey) {
          if (ed.selected.has(e.id)) ed.selected.delete(e.id);
          else ed.selected.add(e.id);
        } else ed.selected = new Set([e.id]);
        ed.render();
        renderProperties();
      };
      list.append(li);
    }
    items.push(list);
  }

  // Selection editor.
  const sel = entities.filter((e) => ed.selected.has(e.id));
  if (sel.length > 1) {
    items.push(section(`${sel.length} shapes selected`));
    if (sel.some((e) => e.type !== "point" && e.type !== "line")) items.push(segmented(MODE_OPTIONS, sel[0].mode, (m) => ed.setSelectedMode(m), "entity"));
  } else if (sel.length === 1) {
    const e = sel[0];
    items.push(section(`Edit ${ENTITY_LABEL[e.type].toLowerCase()}`));
    if (e.type !== "point" && e.type !== "line") items.push(segmented(MODE_OPTIONS, e.mode, (m) => updateEntity(e.id, (t) => (t.mode = m)), "entity"));
    items.push(...entityFields(e, updateEntity));
  }
  if (sel.length) {
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(button("Duplicate", () => ed.duplicateSelected()), button(sel.length > 1 ? `Delete ${sel.length}` : "Delete", () => ed.deleteSelected(), "danger"));
    if (sel.length > 1) {
      const trim = button("✂ Trim overlaps", () => ed.trimSelected());
      trim.title = "Merge the selected shapes where they overlap, removing the lines inside";
      actions.append(trim);
    }
    items.push(actions);
  }

  items.push(section("Sketch settings"), ...sketchSettings(s, updateSketch, true));
  items.push(button("✓ Finish sketch", stopSketchEdit, "primary wide"));
  items.push(hint("Right-click a shape for options, or empty space to select all. Drag dots to reshape; orange dots bend polygon edges into arcs. Right-drag pans, scroll zooms. Esc cancels."));
  panel.replaceChildren(...items);
  sketchStateChanged();
}

// ---- Sketch constraints ---------------------------------------------------------

const REF_KIND_LABEL = { point: "point", edge: "edge", circle: "circle" } as const;

/** "Rectangle 1 edge 2", for lists and hints. */
function refLabel(s: SketchFeature, r: SketchRef): string {
  const entities = s.params.entities;
  const e = entities.find((x) => x.id === r.entity);
  if (!e) return "?";
  const n = entities.filter((x) => x.type === e.type).indexOf(e) + 1;
  const single = (e.type === "line" && r.kind === "edge") || (e.type === "circle" && r.kind === "circle") || (e.type === "point" && r.kind === "point");
  return `${ENTITY_LABEL[e.type]} ${n}${single ? "" : ` ${REF_KIND_LABEL[r.kind]} ${r.index + 1}`}`;
}

const CONSTRAINT_TYPES: { type: ConstraintType; title: string }[] = [
  { type: "horizontal", title: "Make the edge (or the line between two points) horizontal" },
  { type: "vertical", title: "Make the edge (or the line between two points) vertical" },
  { type: "parallel", title: "Make two edges parallel" },
  { type: "perpendicular", title: "Make two edges square to each other" },
  { type: "equal", title: "Make two edges the same length, or two circles the same size" },
  { type: "tangent", title: "Make an edge (or circle) just touch a circle" },
  { type: "coincident", title: "Join two points, or put a point on an edge or circle" },
  { type: "length", title: "Set an edge's length" },
  { type: "distance", title: "Set the distance between two points (or a point and an edge)" },
  { type: "diameter", title: "Set a circle's diameter" },
  { type: "angle", title: "Set the angle between two edges" },
  { type: "fix", title: "Pin a point where it is" },
];

/** With the Constrain tool: what's picked, and the rules that fit it. */
function constrainPicker(s: SketchFeature, ed: SketchEditor, updateSketch: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const items: HTMLElement[] = [section("Constrain")];
  if (!ed.picked.length) {
    items.push(hint("Click one or two points, edges or circles in the drawing (orange when picked)."));
    return items;
  }
  items.push(hint(`Picked: ${ed.picked.map((r) => refLabel(s, r)).join(" + ")}`));
  const fits = CONSTRAINT_TYPES.filter((c) => constraintFits(c.type, ed.picked));
  if (!fits.length) {
    items.push(hint("No rule fits these. Try two edges, an edge and a circle, or two points."));
    return items;
  }
  const grid = document.createElement("div");
  grid.className = "tool-grid";
  for (const c of fits) {
    const b = button(CONSTRAINT_LABEL[c.type], () => {
      const refs = ed.picked;
      const value = measureConstraint(c.type, refs, s.params.entities);
      const constraint: SketchConstraint = { id: newId(), type: c.type, refs, ...(value !== undefined ? { value } : {}) };
      if (c.type === "fix") {
        // Pinned where it is now.
        const at = fixPoint(s, refs[0]);
        if (at) constraint.at = at;
      }
      ed.picked = [];
      updateSketch((t) => t.kind === "sketch" && (t.params.constraints = [...(t.params.constraints ?? []), constraint]));
    });
    b.title = c.title;
    grid.append(b);
  }
  items.push(grid);
  return items;
}

function fixPoint(s: SketchFeature, ref: SketchRef): Point2 | undefined {
  const e = s.params.entities.find((x) => x.id === ref.entity);
  return e ? refPointsOf(e)[ref.index] : undefined;
}

/** The constraints on this sketch, with their values to edit and a ✕ to remove each. */
function constraintList(s: SketchFeature, updateSketch: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const list = s.params.constraints ?? [];
  if (!list.length) return [];
  const items: HTMLElement[] = [section(`Constraints (${list.length})`)];
  const setConstraints = (mutate: (cs: SketchConstraint[]) => void) => updateSketch((t) => t.kind === "sketch" && mutate((t.params.constraints ??= [])));
  for (const c of list) {
    const row = document.createElement("div");
    row.className = "constraint-row";
    const label = document.createElement("span");
    label.textContent = `${CONSTRAINT_LABEL[c.type]}: ${c.refs.map((r) => refLabel(s, r)).join(", ")}`;
    label.title = label.textContent;
    row.append(label);
    if (["distance", "length", "diameter", "angle"].includes(c.type)) {
      const input = lengthInput(c.value ?? 0, (v) => setConstraints((cs) => {
        const t = cs.find((x) => x.id === c.id);
        if (t) t.value = v;
      }), c.type === "angle" ? { unit: "°" } : { min: 0 });
      row.append(input);
    }
    const remove = button("✕", () => setConstraints((cs) => cs.splice(cs.findIndex((x) => x.id === c.id), 1)), "icon");
    remove.title = "Remove this constraint";
    row.append(remove);
    items.push(row);
  }
  return items;
}

/** Numeric fields for one sketch entity. */
function entityFields(e: SketchEntity, updateEntity: (id: string, mutate: (e: SketchEntity) => void) => void): HTMLElement[] {
  type Num = { [k: string]: number };
  const num = (label: string, key: string, opts: { min?: number; unit?: string; plain?: boolean } = {}) =>
    lengthField(label, (e as unknown as Num)[key], (v) => updateEntity(e.id, (t) => ((t as unknown as Num)[key] = v)), opts);
  const deg = { unit: "°" };
  switch (e.type) {
    case "rect":
      return [num("Centre U", "x"), num("Centre V", "y"), num("Width", "width", { min: 0 }), num("Height", "height", { min: 0 }), num("Corner radius", "radius"), num("Angle", "angle", deg)];
    case "circle":
      return [num("Centre U", "x"), num("Centre V", "y"), num("Radius", "radius", { min: 0 }), diameterField(e, updateEntity)];
    case "ellipse":
      return [num("Centre U", "x"), num("Centre V", "y"), num("Radius U", "rx", { min: 0 }), num("Radius V", "ry", { min: 0 }), num("Angle", "angle", deg)];
    case "ngon":
      return [num("Centre U", "x"), num("Centre V", "y"), num("Radius", "radius", { min: 0 }), num("Sides", "sides", { min: 2, plain: true }), num("Angle", "angle", deg)];
    case "slot":
      return [num("Start U", "x1"), num("Start V", "y1"), num("End U", "x2"), num("End V", "y2"), num("Radius", "radius", { min: 0 })];
    case "point":
      return [num("U", "x"), num("V", "y")];
    case "line":
      return [num("Start U", "x1"), num("Start V", "y1"), num("End U", "x2"), num("End V", "y2")];
    case "polygon":
    case "spline":
      return pointRows(e, updateEntity);
    case "stroke":
      return [num("Width", "width", { min: 0 }), hint(`${e.points.length} points. Drag the dots to adjust the path.`)];
  }
}

function diameterField(e: Extract<SketchEntity, { type: "circle" }>, updateEntity: (id: string, mutate: (e: SketchEntity) => void) => void) {
  return lengthField("Diameter", e.radius * 2, (v) => updateEntity(e.id, (t) => t.type === "circle" && (t.radius = v / 2)), { min: 0 });
}

function pointRows(e: Extract<SketchEntity, { type: "polygon" | "spline" }>, updateEntity: (id: string, mutate: (e: SketchEntity) => void) => void): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const head = document.createElement("div");
  head.className = "point-row head";
  head.innerHTML = e.type === "polygon" ? "<span></span><span>U (mm)</span><span>V (mm)</span><span>Bend (mm)</span><span></span>" : "<span></span><span>U (mm)</span><span>V (mm)</span><span></span>";
  if (e.type === "spline") head.classList.add("no-bend");
  rows.push(head);
  e.points.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = `point-row${e.type === "spline" ? " no-bend" : ""}`;
    const label = document.createElement("span");
    label.textContent = `P${i + 1}`;
    const setPoint = (axis: 0 | 1, v: number) => updateEntity(e.id, (t) => (t.type === "polygon" || t.type === "spline") && (t.points[i][axis] = v));
    row.append(label, lengthInput(p[0], (v) => setPoint(0, v)), lengthInput(p[1], (v) => setPoint(1, v)));
    if (e.type === "polygon") {
      const bend = lengthInput(e.bends[i] ?? 0, (v) => updateEntity(e.id, (t) => t.type === "polygon" && (t.bends[i] = v)));
      bend.title = `Curve the edge from P${i + 1} to P${((i + 1) % e.points.length) + 1} (0 = straight)`;
      row.append(bend);
    }
    const remove = button("✕", () => updateEntity(e.id, (t) => removePoint(t, i)), "icon");
    remove.disabled = e.points.length <= 3;
    remove.title = "Delete point";
    row.append(remove);
    rows.push(row);
  });
  rows.push(
    button("+ Add point", () =>
      updateEntity(e.id, (t) => {
        if (t.type !== "polygon" && t.type !== "spline") return;
        const [a, b] = [t.points[t.points.length - 1], t.points[0]];
        t.points.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Point2);
        if (t.type === "polygon") t.bends.push(0);
      }),
    ),
  );
  return rows;
}

function deleteSketchEntity() {
  sketchEditor?.deleteSelected();
}

// ---- Commands ------------------------------------------------------------

/**
 * Start adding a shape: a preview follows the pointer, and a click puts it on
 * the face under it (or the ground). Groups have no shape, so they're added
 * straight away.
 */
function addShape(kind: ShapeKind) {
  // Adding while a group is selected puts the new shape inside it.
  const sel = selected();
  const parentId = sel?.kind === "group" || sel?.kind === "plane" ? sel.id : null;
  stopSketchEdit();
  stopSculpt();
  const f = createFeature(kind, doc.features, null);
  if (kind === "group") {
    f.parentId = parentId;
    finishAdd(f);
    return;
  }
  // Nothing selected while placing, so clicks can't grab the gizmo.
  if (selectedId) selectObject(null);
  setPlacingButton(kind);
  viewport.startPlacement({
    feature: f,
    onPlace(position, rotation, targetId) {
      setPlacingButton(null);
      f.position = position;
      f.rotation = rotation;
      // A screw hole goes beside the object it's put on (in the same group), so it cuts it.
      const into = kind === "screw" && targetId ? (findFeature(targetId)?.parentId ?? null) : parentId;
      // Placed in world terms; moving it into the group keeps it where it was put.
      if (into) {
        const probe = [...structuredClone(doc.features), structuredClone(f)];
        reparent(probe, f.id, into);
        Object.assign(f, probe.at(-1));
      }
      finishAdd(f);
    },
    onCancel() {
      setPlacingButton(null);
      setStatus("");
    },
  });
  setStatus(`Click to place the ${f.name.replace(/ \d+$/, "").toLowerCase()} on a face or the grid (F flips it under the face). Esc to cancel.`);
  if (kind !== "sculpt" && kind !== "plane" && kind !== "sketch") {
    kernel.meshOf([f], f.id, true).then((mesh) => viewport.setPlacementMesh(f.id, mesh)).catch(() => {});
  }
}

/** Move the selected object onto a face: it follows the pointer until a click puts it down. */
function snapToFace() {
  const f = selected();
  if (!f || editingSketchId || sculptingId) {
    if (!f) setNotice("Select an object first, then click Onto face.");
    return;
  }
  if (f.joint) {
    setNotice(`${f.name} is connected by a${f.joint.type === "orbit" ? "n orbit" : ` ${f.joint.type}`}: move it with its gizmo, or remove the connection first.`);
    return;
  }
  const ext = viewport.objectExtents(f.id);
  if (!ext) return;
  const [min, max] = ext;
  $("#snap-face").classList.add("on");
  const done = () => $("#snap-face").classList.remove("on");
  viewport.startPlacement({
    feature: f,
    existing: true,
    // Its bottom middle goes on the face; it keeps its turn if it was only turned flat.
    anchor: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: min.z },
    spin: f.rotation.x === 0 && f.rotation.y === 0 ? f.rotation.z : 0,
    onPlace(position, rotation) {
      done();
      setStatus("");
      commit((features) => setWorldPlacement(features, f.id, position, rotation));
    },
    onCancel() {
      done();
      setStatus("");
    },
  });
  setStatus(`Click a face to put ${f.name} on it (or the grid). Esc to cancel.`);
}

function setPlacingButton(kind: ShapeKind | null) {
  document.querySelectorAll<HTMLElement>("[data-add]").forEach((b) => b.classList.toggle("placing", b.dataset.add === kind));
}

function finishAdd(f: Feature) {
  commit((features) => insertFeatures(features, [f]));
  selectedId = f.id;
  selectedIds = [f.id];
  // Until the kernel has built it, show its size where it goes (threads and springs take a few seconds).
  viewport.showPending(f, worldMatrix(doc.features, f.parentId));
  if (f.kind === "thread" || f.kind === "spring") setStatus(`Building ${f.name}…`);
  if (f.kind === "sketch") startSketchEdit(f.id);
  else if (f.kind === "sculpt") startSculpt(f.id);
  else renderPanels();
}

/** Copies of an object and everything inside it, with new ids; the first is the copy of the object. */
function cloneSubtree(f: Feature): Feature[] {
  const ids = subtreeIds(doc.features, f.id);
  const idMap = new Map([...ids].map((id) => [id, newId()]));
  const clones = doc.features
    .filter((x) => ids.has(x.id))
    .map((x) => ({ ...structuredClone(x), id: idMap.get(x.id)!, parentId: x.id === f.id ? x.parentId : idMap.get(x.parentId!)! }) as Feature);
  return clones.sort((a, b) => Number(b.id === idMap.get(f.id)) - Number(a.id === idMap.get(f.id)));
}

function duplicateSelected() {
  const roots = topSelected().map((id) => findFeature(id)!).filter(Boolean);
  if (!roots.length) return;
  const all = roots.map((f) => {
    const clones = cloneSubtree(f);
    const root = clones[0];
    root.name = `${f.name} copy`;
    return { clones, world: new Matrix4().makeTranslation(10, 10, 0).multiply(worldMatrix(doc.features, f.id)) };
  });
  commit((features) => {
    for (const c of all) {
      insertFeatures(features, c.clones);
      setWorldMatrix(features, c.clones[0].id, c.world);
    }
  });
  selectedIds = all.map((c) => c.clones[0].id);
  selectedId = selectedIds[0];
  renderPanels();
}

function deleteSelected() {
  if (!selectedIds.length && selectedId) selectedIds = [selectedId];
  if (!selectedIds.length) return;
  const ids = new Set(selectedIds.flatMap((id) => [...subtreeIds(doc.features, id)]));
  if (editingSketchId && ids.has(editingSketchId)) stopSketchEdit();
  selectedId = null;
  selectedIds = [];
  commit((features) => {
    const before = features.length;
    const keep = features.filter((f) => !ids.has(f.id));
    // Steps removed before the history marker move it back.
    if (historyMarker !== null) historyMarker -= features.slice(0, historyMarker).filter((f) => ids.has(f.id)).length;
    features.splice(0, before, ...keep);
  });
}

async function exportModel(format: "stl" | "step") {
  setStatus(`Exporting ${format.toUpperCase()}…`);
  const sculpts = doc.features.filter((f): f is SculptFeature => f.kind === "sculpt");
  try {
    let blob: Blob | null = null;
    try {
      blob = await kernel.export(structuredClone(doc.features), format);
    } catch (err) {
      // A model made only of sculpts has nothing for the kernel to export.
      if (!(format === "stl" && sculpts.length && /Nothing to export/.test((err as Error).message))) throw err;
    }
    // Sculpts are meshes: they go into STL, but STEP only holds exact solids.
    if (format === "stl" && sculpts.length) blob = await appendToStl(blob, sculpts.map((f) => sculptTriangles(f.params, worldMatrix(doc.features, f.id))));
    await saveFile(blob!, `gizmocad-model.${format}`, format.toUpperCase(), format);
    setStatus(format === "step" && sculpts.length ? "Sculpted objects aren't in the STEP file (STEP only holds exact solids); export STL to include them." : "");
  } catch (err) {
    setStatus(`Export failed: ${(err as Error).message}`, true);
  }
}

async function saveDocument() {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  await saveFile(blob, "model.gizmocad", "GizmoCAD model", "gizmocad");
}

async function openDocument() {
  const text = await openTextFile($("#file-input"));
  if (text === null) return;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isCadDocument(parsed)) throw new Error("Not a GizmoCAD file.");
    stopSketchEdit();
    undoStack.push(JSON.stringify(doc));
    redoStack.length = 0;
    doc = normalizeDocument(parsed);
    selectedId = null;
    refresh();
  } catch (err) {
    setStatus(`Could not open file: ${(err as Error).message}`, true);
  }
}

// ---- Wiring --------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((b) => {
  b.onclick = () => addShape(b.dataset.add as ShapeKind);
  // Or drag the button into the view and drop the shape where it should go.
  if (b.dataset.add === "group") return;
  b.draggable = true;
  b.ondragstart = (e) => {
    e.dataTransfer!.setData("text/plain", b.dataset.add!);
    e.dataTransfer!.effectAllowed = "copy";
    addShape(b.dataset.add as ShapeKind);
  };
  b.ondragend = () => viewport.placing && viewport.cancelPlacement();
});
const viewportEl = $("#viewport");
viewportEl.addEventListener("dragover", (e) => {
  if (!viewport.placing) return;
  e.preventDefault();
  viewport.placementHover(e.clientX, e.clientY);
});
viewportEl.addEventListener("drop", (e) => {
  if (!viewport.placing) return;
  e.preventDefault();
  viewport.placementDrop(e.clientX, e.clientY);
});
$("#undo").onclick = () => restore(undoStack, redoStack);
$("#redo").onclick = () => restore(redoStack, undoStack);
$("#snap").onchange = (e) => {
  viewport.setSnap(parseFloat((e.target as HTMLSelectElement).value));
};
$("#combined").onchange = (e) => {
  showCombined = (e.target as HTMLInputElement).checked;
  if (showCombined) stopSketchEdit();
  updateToolbar();
  void rebuild();
};
$("#new").onclick = () => {
  if (!doc.features.length) return;
  stopSketchEdit();
  selectedId = null;
  commit((features) => features.splice(0));
};
const THEME_LABEL: Record<ThemeSetting, string> = { auto: "Theme: Auto", light: "Theme: Light", dark: "Theme: Dark" };
const NEXT_THEME: Record<ThemeSetting, ThemeSetting> = { auto: "light", light: "dark", dark: "auto" };
const themeButton = $("#theme");
themeButton.textContent = THEME_LABEL[themeSetting()];
themeButton.onclick = () => {
  setThemeSetting(NEXT_THEME[themeSetting()]);
  themeButton.textContent = THEME_LABEL[themeSetting()];
};
onThemeChange(() => {
  viewport.applyTheme();
  sketchEditor?.render();
});

// The GizmoCAD menu: file, export and theme.
const appMenu = $("#app-menu");
const appMenuButton = $("#app-menu-button");
function setAppMenu(open: boolean) {
  appMenu.hidden = !open;
  appMenuButton.setAttribute("aria-expanded", String(open));
}
appMenuButton.onclick = () => setAppMenu(appMenu.hidden !== false);
// Picking an item closes it (the theme item stays open, to see the change).
appMenu.addEventListener("click", (e) => (e.target as HTMLElement).closest("button") && (e.target as HTMLElement).closest("#theme") === null && setAppMenu(false));
window.addEventListener("pointerdown", (e) => !appMenu.hidden && !(e.target as HTMLElement).closest(".app-menu-wrap") && setAppMenu(false), true);
window.addEventListener("keydown", (e) => e.key === "Escape" && !appMenu.hidden && (setAppMenu(false), e.stopImmediatePropagation()), true);

$("#save").onclick = () => void saveDocument();
$("#open").onclick = () => void openDocument();
$("#export-stl").onclick = () => void exportModel("stl");
$("#export-step").onclick = () => void exportModel("step");


// ---- Measure, section, camera ------------------------------------------------------

const MEASURE_HINT = "Measure: click two points (corners and edges snap). Faces give their angle too. Esc or M to stop.";

function setMeasuring(on: boolean) {
  if (on) {
    stopSketchEdit();
    stopEdgePick();
    stopSculpt();
    if (viewport.placing) viewport.cancelPlacement();
  }
  viewport.setMeasuring(on);
  $("#measure").classList.toggle("on", on);
  setStatus(on ? MEASURE_HINT : "");
  updateToolbar();
}

/** Section view: on/off, which axis, where, and which side is cut away. */
let sectionView: { axis: Axis; at: number; flip: boolean } | null = null;

function setSectionView(next: typeof sectionView) {
  sectionView = next;
  viewport.setSection(sectionView);
  $("#section").classList.toggle("on", !!sectionView);
  const panel = $("#section-panel");
  panel.hidden = !sectionView;
  if (!sectionView) return;
  const box = viewport.modelBounds();
  const [lo, hi] = box ? [box.min[sectionView.axis], box.max[sectionView.axis]] : [-50, 50];
  const slider = $("#section-at") as HTMLInputElement;
  slider.min = String(Math.floor(lo - 1));
  slider.max = String(Math.ceil(hi + 1));
  slider.step = "0.1";
  slider.value = String(sectionView.at);
  $("#section-value").textContent = `${fmt(sectionView.at)} mm`;
  panel.querySelectorAll<HTMLButtonElement>("[data-section-axis]").forEach((b) => b.classList.toggle("active", b.dataset.sectionAxis === sectionView!.axis));
}

function toggleSection() {
  if (sectionView) return setSectionView(null);
  const box = viewport.modelBounds();
  const c = box ? box.getCenter(new Vector3()) : new Vector3();
  setSectionView({ axis: "y", at: Math.round(c.y * 10) / 10, flip: nearSide("y", c.y) });
}

/** Cut away the side facing the camera, so the inside shows. */
const nearSide = (axis: Axis, at: number) => viewport.cameraPosition[axis] < at;

$("#section").onclick = toggleSection;
$("#section-close").onclick = () => setSectionView(null);
($("#section-at") as HTMLInputElement).oninput = (e) => sectionView && setSectionView({ ...sectionView, at: parseFloat((e.target as HTMLInputElement).value) });
$("#section-flip").onclick = () => sectionView && setSectionView({ ...sectionView, flip: !sectionView.flip });
document.querySelectorAll<HTMLButtonElement>("[data-section-axis]").forEach((b) => {
  b.onclick = () => {
    if (!sectionView) return;
    const axis = b.dataset.sectionAxis as Axis;
    const box = viewport.modelBounds();
    const at = box ? Math.round(box.getCenter(new Vector3())[axis] * 10) / 10 : 0;
    setSectionView({ ...sectionView, axis, at, flip: nearSide(axis, at) });
  };
});
$("#measure").onclick = () => setMeasuring(!viewport.measuring);
$("#fit-all").onclick = () => viewport.fitView();
$("#fit-selected").onclick = () => viewport.fitView(true);

// ---- Print bed ----------------------------------------------------------------------

const BEDS: Record<string, { label: string; size: [number, number, number] | null }> = {
  none: { label: "None", size: null },
  ender3: { label: "Creality Ender 3 (220 × 220 × 250)", size: [220, 220, 250] },
  mk4: { label: "Prusa MK4 (250 × 210 × 220)", size: [250, 210, 220] },
  mini: { label: "Prusa Mini (180 × 180 × 180)", size: [180, 180, 180] },
  bambu: { label: "Bambu X1 / P1 / A1 (256 × 256 × 256)", size: [256, 256, 256] },
  a1mini: { label: "Bambu A1 mini (180 × 180 × 180)", size: [180, 180, 180] },
  custom: { label: "Custom…", size: null },
};
const BED_KEY = "gizmocad.bed";
let bed: [number, number, number] | null = null;

function loadBed() {
  try {
    const saved = JSON.parse(localStorage.getItem(BED_KEY) ?? "null") as { key: string; size: [number, number, number] | null } | null;
    if (saved) {
      ($("#bed") as HTMLSelectElement).value = saved.key;
      bed = saved.size;
    }
  } catch {
    // Unreadable or no storage: no bed.
  }
  viewport.setBed(bed && { width: bed[0], depth: bed[1], height: bed[2] });
}

const bedSelect = $("#bed") as HTMLSelectElement;
for (const [key, b] of Object.entries(BEDS)) bedSelect.add(new Option(b.label, key));
bedSelect.onchange = () => {
  let size = BEDS[bedSelect.value]?.size ?? null;
  if (bedSelect.value === "custom") {
    const answer = prompt("Bed size in mm: width × depth × height", bed ? bed.join(" x ") : "200 x 200 x 200");
    const nums = answer?.split(/[x×*, ]+/).map(Number).filter((v) => v > 0);
    size = nums && nums.length >= 2 ? [nums[0], nums[1], nums[2] ?? 200] : null;
    if (!size) bedSelect.value = "none";
  }
  bed = size;
  try {
    localStorage.setItem(BED_KEY, JSON.stringify({ key: bedSelect.value, size }));
  } catch {
    // Not saved, but still shown.
  }
  viewport.setBed(bed && { width: bed[0], depth: bed[1], height: bed[2] });
  checkBed();
};

/** Warn when the model doesn't fit the chosen printer. */
function checkBed() {
  const warn = $("#bed-warning");
  const box = bed ? viewport.modelBounds() : null;
  if (!bed || !box) return void (warn.hidden = true);
  const [w, d, h] = bed;
  const e = 1e-6;
  const fits = box.min.x >= -w / 2 - e && box.max.x <= w / 2 + e && box.min.y >= -d / 2 - e && box.max.y <= d / 2 + e && box.min.z >= -e && box.max.z <= h + e;
  warn.hidden = fits;
  const size = box.getSize(new Vector3());
  warn.textContent = `⚠ Outside the print bed: the model is ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm${box.min.z < -e ? " and goes below the bed" : ""}.`;
}

// ---- Autosave ----------------------------------------------------------------------

let autosaveTimer = 0;
let autosaveReady = false;
function scheduleAutosave() {
  if (!autosaveReady) return; // Not before the last session has been checked, or it'd be overwritten.
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => autosave(JSON.stringify(doc)).catch(() => {}), 800);
}

/** Bring back the last session's model (if this one is still empty). */
async function restoreAutosave() {
  try {
    const saved = await loadAutosave();
    if (saved && !doc.features.length) {
      const parsed: unknown = JSON.parse(saved.json);
      if (isCadDocument(parsed) && parsed.features.length) {
        doc = normalizeDocument(parsed);
        setNotice(`Restored your work from ${new Date(saved.at).toLocaleString()}. (New in the GizmoCAD menu starts over.)`);
        refresh();
      }
    }
  } catch {
    // No storage (private window): nothing to restore.
  }
  autosaveReady = true;
}

// ---- Import and 3MF -------------------------------------------------------------------

async function importFile() {
  const file = await openImportFile($("#import-input"), ["stl", "svg"], "STL mesh or SVG drawing");
  if (!file) return;
  try {
    if (/\.svg$/i.test(file.name)) {
      const entities = svgToEntities(new TextDecoder().decode(file.data), newId);
      const f = createFeature("sketch", doc.features) as SketchFeature;
      f.name = file.name.replace(/\.svg$/i, "");
      f.params.entities = entities;
      f.params.operation = "extrude";
      f.params.depth = 3;
      finishImport(f);
      setNotice(`Imported ${entities.length} shape${entities.length === 1 ? "" : "s"} from ${file.name} as a sketch, extruded 3 mm (change it in the panel; double-click to edit the drawing).`);
    } else {
      const { vertices, triangles } = parseStl(file.data);
      const f = createFeature("sculpt", doc.features) as SculptFeature;
      f.name = file.name.replace(/\.stl$/i, "");
      f.params = importedMesh(vertices, triangles);
      // Sit it on the grid, centred.
      const v = new Float32Array(vertices);
      let [minX, minY, minZ, maxX, maxY] = [Infinity, Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < v.length; i += 3) {
        minX = Math.min(minX, v[i]);
        maxX = Math.max(maxX, v[i]);
        minY = Math.min(minY, v[i + 1]);
        maxY = Math.max(maxY, v[i + 1]);
        minZ = Math.min(minZ, v[i + 2]);
      }
      f.position = { x: -(minX + maxX) / 2, y: -(minY + maxY) / 2, z: -minZ };
      finishImport(f);
      setNotice(`Imported ${file.name} (${(triangles.length / 3).toLocaleString()} triangles) as a mesh: move, sculpt and export it to STL or 3MF. Meshes can't be holes or take fillets.`);
    }
  } catch (err) {
    setStatus(`Couldn't import ${file.name}: ${(err as Error).message}`, true);
  }
}

function finishImport(f: Feature) {
  stopSketchEdit();
  commit((features) => insertFeatures(features, [f]));
  selectedId = f.id;
  selectedIds = [f.id];
  renderPanels();
  viewport.fitView();
}

async function export3mf() {
  setStatus("Exporting 3MF…");
  try {
    const features = structuredClone(activeFeatures(doc.features));
    const meshes = await kernel.parts(features);
    const parts: MeshPart[] = meshes.map((m) => {
      const f = features.find((x) => x.id === m.id)!;
      return { name: f.name, color: f.color ?? "#3ddc97", vertices: m.vertices, triangles: m.triangles };
    });
    // Sculpts (meshes) go in as their own objects.
    for (const f of features) {
      if (f.kind !== "sculpt") continue;
      const tris = sculptTriangles(f.params, worldMatrix(features, f.id));
      parts.push({ name: f.name, color: f.color ?? "#3ddc97", vertices: tris, triangles: new Uint32Array(tris.length / 3).map((_, i) => i) });
    }
    if (!parts.length) throw new Error("Nothing to export: add at least one solid shape.");
    await saveFile(build3mf(parts), "gizmocad-model.3mf", "3MF", "3mf");
    setStatus("");
  } catch (err) {
    setStatus(`Export failed: ${(err as Error).message}`, true);
  }
}

$("#import").onclick = () => void importFile();
$("#export-3mf").onclick = () => void export3mf();
$("#history-back").onclick = () => setHistoryMarker((historyMarker ?? doc.features.length) - 1);
$("#history-forward").onclick = () => setHistoryMarker((historyMarker ?? doc.features.length) + 1);
$("#history-end").onclick = () => setHistoryMarker(null);
$("#history-toggle").onclick = () => $("#history").classList.toggle("collapsed");

const SKETCH_KEYS: Record<string, SketchTool> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.value]));

function setGizmoMode(mode: GizmoMode) {
  gizmoMode = mode;
  viewport.setGizmoMode(mode);
  renderProperties(); // The Connection section shows which mode is on.
  updateToolbar();
}
document.querySelectorAll<HTMLButtonElement>("[data-gizmo]").forEach((b) => (b.onclick = () => setGizmoMode(b.dataset.gizmo as GizmoMode)));
const keepRatioButton = $("#keep-ratio");
keepRatioButton.onclick = () => {
  viewport.keepRatio = !viewport.keepRatio;
  keepRatioButton.classList.toggle("on", viewport.keepRatio);
  keepRatioButton.setAttribute("aria-pressed", String(viewport.keepRatio));
  if (viewport.keepRatio) setGizmoMode("scale");
};
$("#snap-face").onclick = () => (viewport.placing ? viewport.cancelPlacement() : snapToFace());
const pointSnapSelect = $("#point-snap") as HTMLSelectElement;
pointSnapSelect.onchange = () => viewport.setPointSnap(pointSnapSelect.value !== "off", pointSnapSelect.value === "show");
const oneSideButton = $("#one-side");
oneSideButton.onclick = () => {
  viewport.oneSide = !viewport.oneSide;
  oneSideButton.classList.toggle("on", viewport.oneSide);
  oneSideButton.setAttribute("aria-pressed", String(viewport.oneSide));
  if (viewport.oneSide) setGizmoMode("scale");
};

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === "Escape" && viewport.placing) {
    viewport.cancelPlacement();
    return;
  }
  if (viewport.measuring && (e.key === "Escape" || (!mod && key === "m"))) {
    setMeasuring(false);
    return;
  }
  if (viewport.placing && !mod && key === "f") {
    // Point into the face instead: e.g. an axle down through an object, or a shape hanging under a face.
    const flipped = viewport.flipPlacement();
    setStatus(flipped ? "Flipped: pointing into the face (F to flip back). Click to place, Esc to cancel." : "Pointing out of the face (F flips it). Click to place, Esc to cancel.");
    return;
  }
  if (mod && key === "z") {
    e.preventDefault();
    if (e.shiftKey) restore(redoStack, undoStack);
    else restore(undoStack, redoStack);
    return;
  }
  if (mod && key === "y") {
    e.preventDefault();
    restore(redoStack, undoStack);
    return;
  }

  if (sculptingId) {
    if (e.key === "Escape") stopSculpt();
    else if (e.key === "[" || e.key === "]") {
      brush.radius = Math.max(0.5, Math.round(brush.radius * (e.key === "]" ? 1.2 : 1 / 1.2) * 10) / 10);
      renderProperties();
    } else {
      const b = BRUSHES.find((x) => x.key.toLowerCase() === key);
      if (b && !mod) {
        brush.kind = b.value;
        renderProperties();
      }
    }
    return;
  }
  if (sketchEditor) {
    hideMenu();
    if (e.key === "Escape" && !sketchEditor.cancel()) stopSketchEdit();
    else if (e.key === "Enter") sketchEditor.finishShape();
    else if (e.key === "Delete" || e.key === "Backspace") deleteSketchEntity();
    else if (mod && key === "a") {
      e.preventDefault();
      sketchEditor.selectAll();
    } else if (mod && key === "d") {
      e.preventDefault();
      sketchEditor.duplicateSelected();
    } else if (!mod && SKETCH_KEYS[key]) sketchEditor.setTool(SKETCH_KEYS[key]);
    return;
  }
  if (!mod && key === "m") return setMeasuring(true);
  if (e.key === "Home") return viewport.fitView();
  if (e.key === "." && !mod) return viewport.fitView(true);
  if (mod && key === "a") {
    e.preventDefault();
    const active = activeFeatures(doc.features);
    selectedIds = active.filter((f) => !f.parentId).map((f) => f.id);
    selectedId = selectedIds[0] ?? null;
    renderPanels();
    viewport.select(selectedId, selectedIds);
    return;
  }
  if (mod && key === "g") {
    e.preventDefault();
    return groupSelected();
  }
  if (mod && key === "c") return copySelected();
  if (mod && key === "x") {
    copySelected();
    return deleteSelected();
  }
  if (mod && key === "v") {
    e.preventDefault();
    return void paste();
  }
  if (!mod && key === "w") setGizmoMode("translate");
  if (!mod && key === "e") setGizmoMode("rotate");
  if (!mod && key === "r") setGizmoMode("scale");
  if (!mod && key === "j" && selected()?.joint) setGizmoMode("joint");
  if (!mod && key === "p" && selected()?.joint) setGizmoMode("pivot");

  if (mod && key === "d") {
    e.preventDefault();
    duplicateSelected();
  } else if (!mod && key === "f" && selectedId) {
    snapToFace();
  } else if (!mod && key === "h" && selectedId) {
    toggleHidden(selectedId, selectedIds.filter((x) => x !== selectedId));
  } else if (e.key === "Delete" || e.key === "Backspace") {
    deleteSelected();
  } else if (e.key === "Escape") {
    if (edgePick) stopEdgePick();
    else selectObject(null);
  }
});

kernel.ready.catch((err: Error) => setStatus(err.message, true));
loadBed();
refresh();
void restoreAutosave();
