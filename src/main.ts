import { Kernel } from "./kernel";
import { resizeFeature, sizeReadout } from "./resize";
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
} from "./model";
import { SketchEditor, type MenuItem, type SketchTool } from "./sketcher";
import { gearOuterRadius, removePoint } from "./sketchGeometry";
import { addDetail, appendToStl, baseMesh, meshToSculpt, scaleSculpt, sculptTriangles, vertexCount, type BrushKind, type BrushSettings, type SculptBase } from "./sculpt";
import { openTextFile, saveFile } from "./storage";
import { formatLength, parseLength } from "./units";
import { onThemeChange, setThemeSetting, themeSetting, type ThemeSetting } from "./theme";
import { Viewport, type GizmoMode, type PreviewSpec } from "./viewport";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---- State ---------------------------------------------------------------

let doc: CadDocument = emptyDocument();
let selectedId: string | null = null;
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
  mutate(doc.features);
  refresh();
}

function restore(from: string[], to: string[]) {
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push(JSON.stringify(doc));
  doc = JSON.parse(snapshot);
  if (selectedId && !findFeature(selectedId)) selectedId = null;
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
  onSelect(id) {
    selectObject(id);
  },
  onTransformed(id, position, rotation) {
    commit((features) => placeFeature(features, id, position, rotation));
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
  const features = structuredClone(doc.features);
  try {
    await kernel.ready;
    const combined = showCombined && !editingSketchId && !edgePick && !sculptingId;
    const { meshes, errors, adjusted } = await kernel.build(edgePick ? featuresForPicking(features) : features, combined);
    if (token !== buildToken) return; // A newer edit superseded this build.
    buildErrors = errors;
    const adjustmentsChanged = JSON.stringify(adjusted) !== JSON.stringify(edgeAdjustments);
    if (!edgePick) edgeAdjustments = adjusted;
    viewport.setScene(meshes, features, combined);
    viewport.select(combined ? null : selectedId);
    if (editingSketchId && viewport.sketchId !== editingSketchId) viewport.enterSketch(editingSketchId, (e) => sketchEditor?.handle(e));
    renderObjectList();
    if (adjustmentsChanged && !edgePick && !editingSketchId) renderProperties();

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
  ($("#undo") as HTMLButtonElement).disabled = undoStack.length === 0;
  ($("#redo") as HTMLButtonElement).disabled = redoStack.length === 0;
}

function selectObject(id: string | null) {
  if (sculptingId && id !== sculptingId) stopSculpt();
  if (editingSketchId && id !== editingSketchId) stopSketchEdit();
  if (edgePick && id !== edgePick.featureId) stopEdgePick();
  selectedId = id;
  renderPanels();
  viewport.select(id);
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
  const transforming = !!f && !editingSketchId && !sculptingId && !edgePick && !showCombined && !viewport.placing;
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
  sketch: "✎",
  group: "▤",
  plane: "◇",
  sculpt: "✋",
};

const EYE_OPEN = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_SHUT = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17.6 17.6 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

/** Show or hide an object (and everything inside it) in the view. */
function toggleHidden(id: string) {
  commit((features) => {
    const f = features.find((x) => x.id === id);
    if (!f) return;
    if (f.hidden) delete f.hidden;
    else f.hidden = true;
  });
}

/** Is the object, or anything it sits inside, hidden? */
function hiddenInView(f: Feature): boolean {
  for (let p: Feature | undefined = f; p; p = p.parentId ? (findFeature(p.parentId) ?? undefined) : undefined) if (p.hidden) return true;
  return false;
}

const panelKey = (ed: SketchEditor) => `${ed.tool}|${ed.newMode}|${ed.ngonSides}|${ed.brushWidth}|${[...ed.selected].join(",")}`;

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
  const walk = (parentId: string | null, depth: number) => {
    for (const f of childrenOf(doc.features, parentId)) {
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
  li.className = [f.id === selectedId ? "selected" : "", buildErrors[f.id] ? "failed" : "", hiddenInView(f) ? "hidden-obj" : ""].join(" ");
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
  li.onclick = () => selectObject(f.id);
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
    for (const clones of pieces) features.push(...clones);
  });
  splitDraft = null;
  selectedId = pieces[0][0].id;
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
    features.push(group, ...walls);
    let host = f.parentId;
    while (host && childrenOf(features, host).some((c) => c.mode === "hole")) host = features.find((x) => x.id === host)?.parentId ?? null;
    if (host !== f.parentId) reparent(features, group.id, host);
  });
  dividerDraft = null;
  selectedId = group.id;
  renderPanels();
  setNotice(`Added ${walls.length} divider${walls.length > 1 ? "s" : ""}.`);
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

// ---- Properties ----------------------------------------------------------

function renderProperties() {
  // The split/divider tools close when another object (or none) is selected.
  if (splitDraft && splitDraft.id !== selectedId) splitDraft = null;
  if (dividerDraft && dividerDraft.id !== selectedId) dividerDraft = null;
  renderPropertiesPanel();
  viewport.setPreview(editingSketchId || sculptingId ? null : cutPreviewBoxes());
  // While splitting, an arrow on the highlighted cut drags it.
  syncCutHandle();
}

function renderPropertiesPanel() {
  const panel = $("#properties");
  const f = selected();
  if (editingSketchId && sketchEditor && editingSketch()) return renderSketchPanel(panel, editingSketch()!, sketchEditor);
  const sculpting = findFeature(sculptingId);
  if (sculpting?.kind === "sculpt") return panel.replaceChildren(...sculptPanel(sculpting));
  if (!f) {
    panel.innerHTML = `<p class="hint">Select an object to edit its exact dimensions.</p>`;
    panel.append(
      hint("Fields accept units and maths, e.g. <code>1in</code>, <code>2.5cm</code>, <code>40/3</code>."),
      hint("Drag objects onto each other in the list to make parent/child groups. Children move with their parent, and a child hole only cuts its parent."),
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
  // A flat sketch has no solid yet, so nothing to round, cut or sculpt.
  const flat = f.kind === "sketch" && f.params.operation === "flat";
  if (FINISHABLE.includes(f.kind) && !flat) {
    items.push(...edgeSection(f, update));
    const sculpt = button("✋ Sculpt this object", () => void convertToSculpt(f.id), "wide");
    sculpt.title = "Turn this object into clay you can sculpt with brushes (Ctrl+Z to undo)";
    items.push(section("Sculpt"), sculpt, hint(f.kind === "group" ? "The group's merged shape becomes one piece of clay." : "Turns the exact shape into clay; dimensions and fillets stop being editable."));
  }

  items.push(...connectionSection(f, update));
  if (!["group", "plane", "sculpt"].includes(f.kind) && !flat) items.push(...cutSection(f));

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
    onPlace(position, rotation) {
      setPlacingButton(null);
      f.position = position;
      f.rotation = rotation;
      // Placed in world terms; moving it into the group keeps it where it was put.
      if (parentId) {
        const probe = [...structuredClone(doc.features), structuredClone(f)];
        reparent(probe, f.id, parentId);
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
  commit((features) => features.push(f));
  selectedId = f.id;
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
  const f = selected();
  if (!f) return;
  const clones = cloneSubtree(f);
  const root = clones[0];
  root.name = `${f.name} copy`;
  root.position.x += 10;
  root.position.y += 10;
  commit((features) => features.push(...clones));
  selectedId = root.id;
  renderPanels();
}

function deleteSelected() {
  if (!selectedId) return;
  const ids = subtreeIds(doc.features, selectedId);
  if (editingSketchId && ids.has(editingSketchId)) stopSketchEdit();
  selectedId = null;
  commit((features) => {
    const keep = features.filter((f) => !ids.has(f.id));
    features.splice(0, features.length, ...keep);
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
    toggleHidden(selectedId);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    deleteSelected();
  } else if (e.key === "Escape") {
    if (edgePick) stopEdgePick();
    else selectObject(null);
  }
});

kernel.ready.catch((err: Error) => setStatus(err.message, true));
refresh();
