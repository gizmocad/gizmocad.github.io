import { Kernel, type BuildStep, type ImportedSolid, type ModelStats } from "./kernel";
import { featureExtents, resizeFeature, sizeReadout } from "./resize";
import {
  childrenOf,
  createFeature,
  FINISHABLE,
  INSERT_SIZES,
  NUT_PLAY,
  NUT_SIZES,
  baseMatrix,
  ignoresHole,
  emptyDocument,
  isCadDocument,
  nextColour,
  newId,
  normalizeDocument,
  PARAM_FIELDS,
  LEAN_KINDS,
  type Tilt,
  reparent,
  setWorldPlacement,
  addJoint,
  removeJoint,
  placeFeature,
  moveJointFrame,
  clampJoint,
  subtreeIds,
  type CadDocument,
  type ImportedFont,
  type ImportedParams,
  type Texture,
  type TexturePattern,
  type Feature,
  type Point2,
  type ShapeKind,
  type EdgeOp,
  type EdgeTarget,
  type EntityMode,
  type SketchEntity,
  type SketchEntityType,
  type SketchFeature,
  type Variable,
  type SketchOperation,
  type ScrewParams,
  type GrooveTip,
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
  colourOf,
  isMergedGroup,
} from "./model";
import { Box3, BufferAttribute, BufferGeometry, EdgesGeometry, Matrix4, Quaternion, Vector3 } from "three";
import { CONSTRAINT_LABEL, constraintFits, measure as measureConstraint, refPoints as refPointsOf, solveSketch } from "./constraints";
import { autosave, build3mf, loadAutosave, outlinesToEntities, parse3mf, parseStl, svgToEntities, type ImportedPart, type MeshPart } from "./fileFormats";
import { fcstdSketches, parseDxf, parseFcstd, parseGltf, parseObj, parseOff, parsePly, stem, type PickedFile } from "./importFormats";
import { SketchEditor, type MenuItem, type SketchTool } from "./sketcher";
import { bounds as sketchBounds, gearOuterRadius, removePoint } from "./sketchGeometry";
import { HEDRON_FACES, HEDRON_NAMES, type HedronFaces } from "./hedron";
import { BUILT_IN_FONTS, CUSTOM_FONT, builtInFont, builtInFontUrl, fontFamily, isCustomFont } from "./fonts";
import { addDetail, appendToStl, baseMesh, decodeFloats, decodeIndices, encodeFloats, encodeIndices, importedMesh, meshToSculpt, scaleSculpt, sculptTriangles, vertexCount, type BrushKind, type BrushSettings, type SculptBase } from "./sculpt";
import { openImportFiles, openTextFile, saveFile } from "./storage";
import { expressionNames, formatLength, parseLength, validName } from "./units";
import { onThemeChange, setThemeSetting, themeSetting, type ThemeSetting } from "./theme";
import { Viewport, type GizmoMode, type PreviewSpec } from "./viewport";
import { DEFAULT_MCP_PORT, McpBridge, type BridgeState } from "./mcpBridge";

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
let splitDraft: { id: string; axis: Axis; tilt: number; toward: Axis; cuts: number[]; active: number; pins?: number } | null = null;
/** Dowel pins for splits: diameter, how deep each hole goes into each piece, and the holes' extra width. */
const dowel = { diameter: 3, depth: 5, play: 0.15 };
let dividerDraft: { id: string; axis: "x" | "y"; count: number; thickness: number; height: number } | null = null;

/** The sketch currently being edited, if any. */
let sketchEditor: SketchEditor | null = null;
let editingSketchId: string | null = null;

/** Apply a change to the document, recording it for undo. */
/** Undo history is capped by count and by memory (sculpt meshes make snapshots large). */
const UNDO_LIMIT = { steps: 200, bytes: 120_000_000 };
let undoBytes = 0;

function commit(mutate: (features: Feature[]) => void) {
  // Part of a larger change (parameters re-applied): one undo step and one update for all of it.
  if (batching) {
    mutate(doc.features);
    keepPendingExpr();
    return;
  }
  const snapshot = undoSnapshot();
  undoStack.push(snapshot);
  undoBytes += snapshot.length;
  while (undoStack.length > UNDO_LIMIT.steps || (undoBytes > UNDO_LIMIT.bytes && undoStack.length > 1)) undoBytes -= undoStack.shift()!.length;
  redoStack.length = 0;
  // Sketches with constraints: note their drawing before the change, so the solver can tell what was edited.
  const before = new Map(doc.features.flatMap((f) => (f.kind === "sketch" && f.params.constraints?.length ? [[f.id, structuredClone(f.params.entities)] as const] : [])));
  const jointsBefore = new Map(doc.features.flatMap((f) => (f.joint ? [[f.id, f.joint.value] as const] : [])));
  mutate(doc.features);
  keepPendingExpr();
  followJoints(jointsBefore);
  for (const f of doc.features) {
    if (f.kind !== "sketch" || !f.params.constraints?.length) continue;
    const result = solveSketch(f.params.entities, f.params.constraints, before.get(f.id));
    if (result.dead.length) f.params.constraints = f.params.constraints.filter((c) => !result.dead.includes(c.id));
    if (result.error > 1e-3) setNotice("These constraints can't all be met at once: remove one, or change a dimension.");
  }
  refresh();
}

/** A clearance cut and the object it follows swing together: whichever joint just moved, the other matches it. */
function followJoints(before: Map<string, number>) {
  for (const h of doc.features) {
    const src = h.follows ? findFeature(h.follows) : undefined;
    if (!h.joint || !src?.joint) continue;
    if (src.joint.value !== before.get(src.id)) h.joint.value = src.joint.value;
    else if (h.joint.value !== before.get(h.id)) src.joint.value = h.joint.value;
  }
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

/** Imported solids' geometry (BREP text, triangles) by ref: undo steps leave it out (it never changes, and can be megabytes). */
const geometryStore = new Map<string, Pick<ImportedParams, "brep" | "mesh">>();

/** The model for the undo history: everything but the imported fonts' files and solids' geometry (they'd fill it up fast). */
function undoSnapshot() {
  for (const f of doc.features) if (f.kind === "imported") geometryStore.set(f.params.ref, { brep: f.params.brep, mesh: f.params.mesh });
  return JSON.stringify({ ...doc, fonts: undefined }, function (this: Record<string, unknown>, key, value) {
    return (key === "brep" || key === "mesh") && typeof this.ref === "string" ? undefined : value;
  });
}

/**
 * Faceted solids from older files were saved as just their (huge) BREP; the
 * kernel hands back their triangles, which are kept instead from now on.
 */
function keepFacets(facets: Record<string, { vertices: Float32Array; triangles: Uint32Array }>) {
  for (const [ref, w] of Object.entries(facets)) {
    const mesh = { positions: encodeFloats(w.vertices), indices: encodeIndices(w.triangles) };
    geometryStore.set(ref, { brep: "", mesh });
    for (const f of doc.features) if (f.kind === "imported" && f.params.ref === ref) Object.assign(f.params, { brep: "", mesh });
  }
  scheduleAutosave();
}

function mergeFonts(a: ImportedFont[] | undefined, b: ImportedFont[] | undefined): ImportedFont[] | undefined {
  const all = [...(a ?? []), ...(b ?? [])].filter((f, i, list) => list.findIndex((g) => g.id === f.id) === i);
  return all.length ? all : undefined;
}

function restore(from: string[], to: string[]) {
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push(undoSnapshot());
  // Undo steps don't carry the imported fonts (they're only ever added): keep the ones there are.
  const fonts = doc.fonts;
  doc = JSON.parse(snapshot);
  doc.fonts = mergeFonts(doc.fonts, fonts);
  for (const f of doc.features) if (f.kind === "imported") Object.assign(f.params, { brep: "", ...geometryStore.get(f.params.ref) });
  selectedIds = selectedIds.filter((id) => findFeature(id));
  if (selectedId && !findFeature(selectedId)) selectedId = selectedIds[0] ?? null;
  if (historyMarker !== null && historyMarker > doc.features.length) historyMarker = doc.features.length;
  if (editingSketchId && !findFeature(editingSketchId)) stopSketchEdit();
  if (edgePick && !pickedOp()) stopEdgePick();
  if (sculptingId && findFeature(sculptingId)?.kind !== "sculpt") stopSculpt();
  refresh();
}

/** Undo or redo from the buttons or keys, and say what it was. */
function undoRedo(redo: boolean) {
  const [from, to] = redo ? [redoStack, undoStack] : [undoStack, redoStack];
  if (!from.length) return setNotice(redo ? "Nothing to redo." : "Nothing to undo.");
  const before = doc.features;
  restore(from, to);
  // Undoing takes a step back, so the step itself went from the state now to the one before.
  const what = redo ? describeStep(before, doc.features) : describeStep(doc.features, before);
  const left = from.length;
  setNotice(`${redo ? "Redid" : "Undid"} ${what}${left ? ` · ${left} more to ${redo ? "redo" : "undo"}` : ""}`);
  const b = $(redo ? "#redo" : "#undo");
  b.classList.remove("flash");
  void b.offsetWidth; // Restart the animation.
  b.classList.add("flash");
}

/** A few words for what changed from `a` to `b`, such as "moving Cylinder 1" or "deleting Box 2". */
function describeStep(a: Feature[], b: Feature[]): string {
  const plain = (f: Feature) => JSON.stringify(f, (key, value) => (key === "brep" || key === "mesh" ? undefined : value));
  const added = b.filter((f) => !a.some((x) => x.id === f.id));
  const removed = a.filter((f) => !b.some((x) => x.id === f.id));
  const changed = b.filter((f) => {
    const old = a.find((x) => x.id === f.id);
    return old && plain(old) !== plain(f);
  });
  const names = (list: Feature[]) => (list.length === 1 ? list[0].name : list.length === 2 ? `${list[0].name} and ${list[1].name}` : `${list[0].name} and ${list.length - 1} others`);
  if (added.length && !removed.length) return `adding ${names(added)}`;
  if (removed.length && !added.length) return `deleting ${names(removed)}`;
  if (added.length || removed.length) return "a change to the model";
  if (!changed.length) return "a step";
  if (changed.length > 1) return `changing ${names(changed)}`;
  // One object: which of its settings changed.
  const f = changed[0];
  const old = a.find((x) => x.id === f.id)!;
  const keys = (Object.keys({ ...old, ...f }) as (keyof Feature)[]).filter((k) => JSON.stringify(old[k]) !== JSON.stringify(f[k]));
  const only = (...ks: string[]) => keys.every((k) => ks.includes(k));
  if (only("position", "rotation", "joint", "mirrored")) return `moving ${f.name}`;
  if (only("name")) return `renaming ${old.name}`;
  if (only("color")) return `the colour of ${f.name}`;
  if (only("mode")) return `making ${f.name} a ${f.mode}`;
  if (only("edgeOps")) return `edge finishes on ${f.name}`;
  if (only("hidden")) return `${f.hidden ? "hiding" : "showing"} ${f.name}`;
  if (only("ghost")) return `ghosting ${f.name}`;
  if (only("sweep")) return `the swing of ${f.name}`;
  if (only("combined")) return `${f.combined ? "combining" : "separating"} ${f.name}`;
  if (only("clearance")) return `the clearance of ${f.name}`;
  if (only("parentId", "position", "rotation")) return `regrouping ${f.name}`;
  if (only("params", "position")) return `editing ${f.name}`;
  return `changing ${f.name}`;
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

// A progress bar while the kernel works on something that takes a moment (not for quick updates, so it doesn't flicker).
const busyEl = $("#busy");
let busySince = 0;
let busyWhat: string | null = null;
let busyTimer = 0;
let idleTimer = 0;
function showBusy() {
  clearTimeout(busyTimer);
  if (!busyWhat) return void (busyEl.hidden = true);
  const ms = performance.now() - busySince;
  busyEl.hidden = ms < 250;
  const secs = Math.floor(ms / 1000);
  busyEl.querySelector(".busy-label")!.textContent = `${busyWhat}…${secs >= 2 ? ` ${secs} s` : ""}`;
  busyTimer = window.setTimeout(showBusy, ms < 250 ? 260 - ms : 1005 - (ms % 1000));
}
kernel.onWorking = (what) => {
  clearTimeout(idleTimer);
  if (!what) {
    // A moment's grace: one build often follows straight on from another.
    idleTimer = window.setTimeout(() => ((busyWhat = null), showBusy()), 150);
    return;
  }
  if (!busyWhat) busySince = performance.now();
  busyWhat = what;
  showBusy();
};
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
  onSweepMoved(id, end, value) {
    commit((features) => {
      const f = features.find((x) => x.id === id);
      if (!f?.sweep) return;
      f.sweep[end] = value;
      // The part it was made from goes to where the end was dragged (and stays there).
      const src = f.sweep.source ? features.find((x) => x.id === f.sweep!.source) : undefined;
      if (src?.joint) src.joint.value = clampJoint(src.joint, value);
    });
  },
  onJointMoved(id, value) {
    commit((features) => {
      const f = features.find((x) => x.id === id);
      if (f?.joint) f.joint.value = value;
    });
  },
  onResized(id, scale, anchor, exact) {
    commit((features) => resizeFeature(features, id, scale, exact ? 0 : viewport.snapSize, anchor));
  },
  onOpen(id) {
    const kind = findFeature(id)?.kind;
    if (kind === "sketch") startSketchEdit(id);
    if (kind === "sculpt") startSculpt(id);
  },
});

let buildToken = 0;
/** The latest rebuild, so others (the AI bridge) can wait for the model to catch up. */
let latestBuild: Promise<void> = Promise.resolve();
let buildRunning = false;
let buildAgain = false;
/**
 * Rebuild the model. While a build is running, further edits are gathered
 * into one more build when it's done, instead of the kernel working through
 * every one of them in turn (with slow models, that piled up into long lags).
 */
function rebuild(): Promise<void> {
  if (buildRunning) {
    buildAgain = true;
    return latestBuild;
  }
  buildRunning = true;
  latestBuild = (async () => {
    try {
      do {
        buildAgain = false;
        await buildNow();
      } while (buildAgain);
    } finally {
      buildRunning = false;
    }
  })();
  return latestBuild;
}

/** Wait until the model is built as it is now (a newer edit's build replaces an older one). */
async function settle() {
  for (let p = latestBuild; ; p = latestBuild) {
    await p;
    if (p === latestBuild) return;
  }
}

async function buildNow() {
  const token = ++buildToken;
  const started = performance.now();
  const features = kernel.snapshot(activeFeatures(doc.features));
  try {
    await kernel.ready;
    await syncFonts();
    const combined = showCombined && !editingSketchId && !edgePick && !sculptingId;
    // Holes are shown cut, except while picking edges (the picked edges are the object's own).
    const { meshes, errors, adjusted, facets, log } = await kernel.build(edgePick ? featuresForPicking(features) : features, combined, !edgePick, debugOn);
    if (facets) keepFacets(facets);
    if (token !== buildToken) return; // A newer edit superseded this build.
    if (debugOn) showDebug(log ?? [], errors, features, performance.now() - started, combined);
    buildErrors = errors;
    const adjustmentsChanged = JSON.stringify(adjusted) !== JSON.stringify(edgeAdjustments);
    if (!edgePick) edgeAdjustments = adjusted;
    viewport.setScene(meshes, features, combined);
    reportPrintCheck();
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

/** Goes up with every change to the model (for results worked out from it, such as the print estimate). */
let modelRevision = 0;

function refresh() {
  modelRevision++;
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
  $("#undo").title = `Undo (Ctrl+Z)${undoStack.length ? `: ${undoStack.length} step${undoStack.length === 1 ? "" : "s"} back` : ""}`;
  $("#redo").title = `Redo (Ctrl+Shift+Z)${redoStack.length ? `: ${redoStack.length} step${redoStack.length === 1 ? "" : "s"} forward` : ""}`;
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
  if (viewport.chiseling && id !== viewport.chiseling) stopChisel();
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
  if (f.params.base === "imported") clay.add(new Option("Imported mesh", "imported"));
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
    const mesh = await kernel.meshOf(doc.features, id);
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

/**
 * Turn a mesh (an imported one, or clay) into a solid, so it takes fillets,
 * chamfers, holes, shells and textures like any other object. Flat areas
 * become single faces; curves stay as their small flat facets.
 */
async function convertToSolid(id: string) {
  const f = findFeature(id);
  if (!f || f.kind !== "sculpt") return;
  const tris = decodeIndices(f.params.indices);
  setStatus("Making it a solid…");
  let solids: ImportedSolid[];
  try {
    solids = await kernel.importSolids([{ name: f.name, format: "mesh", vertices: decodeFloats(f.params.positions), triangles: tris }]);
  } catch (err) {
    setStatus(`Couldn't make ${(err as Error).message.replace(`${f.name}: `, "it a solid: ")}`, true);
    return;
  }
  const parts = solids.filter((s): s is Extract<ImportedSolid, { kind: "solid" }> => s.kind === "solid");
  if (!parts.length) return setStatus("Couldn't make it a solid: the mesh has no closed shape in it.", true);
  // Each solid's own origin is the middle of its base: move the object so it stays where it was.
  const placed = baseMatrix(f);
  const at = (anchor: number[]) => {
    const v = new Vector3(...anchor).applyMatrix4(placed);
    return { x: round4(v.x), y: round4(v.y), z: round4(v.z) };
  };
  commit((features) => {
    const t = features.find((x) => x.id === id);
    if (!t) return;
    parts.forEach((p, i) => {
      const params = { ref: newId(), brep: p.brep, size: p.size, scale: [1, 1, 1] as [number, number, number], faceted: true, ...(p.mesh ? { mesh: encodeMesh(p.mesh) } : {}) };
      if (i === 0) {
        Object.assign(t, { kind: "imported", mode: "solid", edgeOps: [], params, position: at(p.anchor) });
        return;
      }
      // Separate bodies in one mesh become objects of their own beside it.
      const extra = structuredClone(t) as Feature;
      Object.assign(extra, { id: newId(), name: `${t.name} ${i + 1}`, params, position: at(p.anchor) });
      features.push(extra);
    });
  });
  setNotice(`${f.name} is now a solid${parts.length > 1 ? ` (${parts.length} pieces)` : ""}: it can take fillets, chamfers and holes. Ctrl+Z turns it back into a mesh.`);
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
  // The grid comes up now, not after the rebuild (which can be slow, or fail, with big imported parts).
  const sketch = findFeature(id);
  if (sketch) viewport.enterSketchNow(sketch, doc.features, (e) => sketchEditor?.handle(e));
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
  renderVariables();
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
  show("#lay-flat", transforming && (mode === "translate" || mode === "rotate") && !f?.joint);
  show("#local-axes", transforming && (mode === "translate" || mode === "rotate"));
  show("#keep-ratio, #one-side", transforming && mode === "scale");
  show("#points-option", (transforming && (mode === "translate" || mode === "pivot")) || viewport.placing);
}

/** An object's icon: imported meshes get their own, not the sculpting hand. */
const kindIcon = (f: Feature) => (f.kind === "sculpt" && f.params.base === "imported" ? "◬" : KIND_ICON[f.kind]);

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
  hedron: "⬟",
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
  imported: "◈",
};

const EYE_OPEN = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_SHUT = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17.6 17.6 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

/** Show or hide objects (and everything inside them) in the view; several go the way the first one goes. */
const GHOST = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 20V10a7 7 0 0 1 14 0v10l-2.3-1.6L14.3 20 12 18.4 9.7 20l-2.4-1.6z"/><circle cx="9.5" cy="10.5" r="0.6" fill="currentColor"/><circle cx="14.5" cy="10.5" r="0.6" fill="currentColor"/></svg>`;

/** Make objects ghosts (see-through, clicked and placed through) or solid again; several go the way the first one goes. */
function toggleGhost(id: string, more: string[] = []) {
  const ghost = !findFeature(id)?.ghost;
  commit((features) => {
    for (const x of [id, ...more]) {
      const f = features.find((y) => y.id === x);
      if (!f) continue;
      if (ghost) f.ghost = true;
      else delete f.ghost;
    }
  });
  setNotice(ghost ? "Ghosted: you can click, place and snap through it. Select it in the list to move it; G or the ghost button makes it solid again." : "Not a ghost any more.");
}

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

const panelKey = (ed: SketchEditor) => `${ed.tool}|${ed.newMode}|${ed.ngonSides}|${ed.brushWidth}|${[...ed.selected].join(",")}|${JSON.stringify(ed.picked)}|${ed.activePoint}`;

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

/** Objects with no colour of their own show in this one (as the view does). */
const DEFAULT_COLOUR = "#3ddc97";

/** Groups folded shut in the list (remembered in this browser). */
const folded = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem("gizmocad.folded") ?? "[]") as string[];
    } catch {
      return [];
    }
  })(),
);

function toggleFolded(id: string) {
  if (!folded.delete(id)) folded.add(id);
  try {
    localStorage.setItem("gizmocad.folded", JSON.stringify([...folded].filter((x) => findFeature(x))));
  } catch {
    // Not remembered; it still works for now.
  }
  renderObjectList();
}

function renderObjectList() {
  const list = $("#object-list");
  const rows: HTMLLIElement[] = [];
  // Rolled-back history steps aren't part of the model right now, so they're left out.
  const upTo = historyMarker === null ? doc.features : doc.features.slice(0, historyMarker);
  const listed = new Set(upTo.map((f) => f.id));
  const shown = upTo.map((f) => (f.parentId && !listed.has(f.parentId) ? { ...f, parentId: null } : f));
  // Each object's children, listed once (not searched for row by row).
  const kids = new Map<string | null, Feature[]>();
  for (const f of shown) {
    const list = kids.get(f.parentId);
    if (list) list.push(f);
    else kids.set(f.parentId, [f]);
  }
  /** Everything inside `f`, at any depth. */
  const insideOf = (f: Feature, into = new Set<string>()) => {
    for (const c of kids.get(f.id) ?? []) if (!into.has(c.id)) insideOf(c, into.add(c.id));
    return into;
  };
  const walk = (parentId: string | null, depth: number) => {
    for (const f of kids.get(parentId) ?? []) {
      rows.push(objectRow(f, depth, insideOf(f)));
      if (!folded.has(f.id)) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  list.replaceChildren(...rows);
}

let draggingId: string | null = null;

function objectRow(f: Feature, depth: number, inside: Set<string>) {
  const li = document.createElement("li");
  const shut = inside.size > 0 && folded.has(f.id);
  // Folded shut with the selection inside: the group's row shows where it is.
  const holdsSelected = shut && selectedIds.some((id) => inside.has(id));
  li.className = [selectedIds.includes(f.id) ? "selected" : "", holdsSelected ? "holds-selected" : "", buildErrors[f.id] ? "failed" : "", hiddenInView(f) ? "hidden-obj" : "", f.suppressed ? "suppressed" : ""].join(" ");
  li.style.paddingLeft = `${8 + depth * 16}px`;
  li.draggable = true;
  li.innerHTML = `<span class="name"><button class="fold"></button><span class="swatch"></span><span class="kind"></span><span></span></span><span class="row-end"><span class="tag ${f.mode}"></span><button class="eye ghost-btn"></button><button class="eye"></button></span>`;
  li.querySelector(".tag")!.textContent = (f.kind === "group" ? "group" : f.mode) + (shut ? ` · ${inside.size}` : "");
  const fold = li.querySelector<HTMLButtonElement>(".fold")!;
  if (inside.size) {
    fold.textContent = shut ? "▸" : "▾";
    fold.title = shut ? `Open (${inside.size} inside)` : "Fold shut";
    fold.setAttribute("aria-expanded", String(!shut));
    fold.onclick = (e) => {
      e.stopPropagation();
      toggleFolded(f.id);
    };
    fold.ondblclick = (e) => e.stopPropagation();
  } else fold.disabled = true;
  const ghost = li.querySelector<HTMLButtonElement>(".ghost-btn")!;
  ghost.innerHTML = GHOST;
  ghost.title = f.ghost ? "Make solid again (G)" : "Ghost (G): see-through, and click or place things through it";
  ghost.setAttribute("aria-label", `${f.ghost ? "Unghost" : "Ghost"} ${f.name}`);
  ghost.setAttribute("aria-pressed", String(!!f.ghost));
  ghost.classList.toggle("off", !!f.ghost);
  ghost.onclick = (e) => {
    e.stopPropagation();
    toggleGhost(f.id);
  };
  ghost.ondblclick = (e) => e.stopPropagation();
  const eye = li.querySelector<HTMLButtonElement>(".eye:not(.ghost-btn)")!;
  eye.innerHTML = f.hidden ? EYE_SHUT : EYE_OPEN;
  eye.title = f.hidden ? "Show (H)" : "Hide (H)";
  eye.setAttribute("aria-label", `${f.hidden ? "Show" : "Hide"} ${f.name}`);
  eye.classList.toggle("off", !!f.hidden);
  eye.onclick = (e) => {
    e.stopPropagation();
    toggleHidden(f.id);
  };
  eye.ondblclick = (e) => e.stopPropagation();
  li.querySelector(".kind")!.textContent = kindIcon(f);
  // Its colour, as in the view: holes are a red ring, a group of mixed colours an empty one.
  const swatch = li.querySelector<HTMLElement>(".swatch")!;
  // A combined shape (or a hole group) and its parts show the colour the whole shape is drawn in.
  let merged: Feature | undefined;
  for (let p: Feature | null | undefined = f; p; p = findFeature(p.parentId)) if (isMergedGroup(p)) merged = p;
  const hole = f.mode === "hole" || merged?.mode === "hole";
  const colour = hole ? null : merged ? (colourOf(doc.features, merged) ?? DEFAULT_COLOUR) : (colourOf(doc.features, f) ?? (f.kind === "group" || f.kind === "plane" ? null : DEFAULT_COLOUR));
  swatch.classList.toggle("hole", hole);
  if (colour) swatch.style.background = colour;
  else swatch.classList.add("empty");
  li.querySelector(".name > span:last-child")!.textContent = f.name;
  li.title = buildErrors[f.id] ? `${f.name}: ${buildErrors[f.id]}` : f.name;
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
  const probe = kernel.snapshot(doc.features);
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
  // In an object's panel, a field can take parameters: it's known by its label (and which one, when repeated).
  let link: { id: string; key: string } | undefined;
  if (fieldContext && !opts.unit?.includes("°")) {
    const n = fieldContext.counts.get(label) ?? 0;
    fieldContext.counts.set(label, n + 1);
    link = { id: fieldContext.id, key: n ? `${label}#${n}` : label };
    fieldAppliers.set(`${link.id}|${link.key}`, onChange);
  }
  const input = lengthInput(value, onChange, opts, link);
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

function lengthInput(value: number, onChange: (mm: number) => void, opts: { min?: number; unit?: string } = {}, link?: { id: string; key: string }) {
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.spellcheck = false;
  const initial = formatLength(value) + (opts.unit ?? "");
  input.value = initial;
  // Set from parameters: shows the value, and the expression while it's being edited.
  const expr = link ? findFeature(link.id)?.exprs?.[link.key] : undefined;
  if (expr) {
    input.classList.add("linked");
    input.title = `= ${expr} (from parameters)`;
    input.addEventListener("focus", () => {
      input.value = expr;
      input.select();
    });
  }
  const apply = () => {
    const text = input.value.trim();
    if (expr && text === expr) {
      input.value = initial;
      return;
    }
    const names = opts.unit ? [] : expressionNames(text);
    const parsed = opts.unit ? parseFloat(text) : parseLength(text, variableValues());
    const valid = parsed !== null && Number.isFinite(parsed) && (opts.min === undefined || parsed > opts.min);
    input.classList.toggle("invalid", !valid);
    if (!valid) {
      if (names.length) input.title = `Unknown parameter${names.length > 1 ? "s" : ""}: add ${names.join(", ")} under Parameters`;
      return;
    }
    if (link) pendingExpr = { ...link, expr: names.length ? text : null };
    try {
      if (parsed !== value) onChange(parsed);
      else if ((expr ?? null) !== (names.length ? text : null)) commit(() => {}); // Just the link changes.
    } finally {
      pendingExpr = null;
    }
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
    const hinge = button("⟳ Hinge", () => startConnect(f.id, "hinge"));
    hinge.title = "Attach this object to another so it can only turn around an axis (wheels, lids, doors)";
    const orbit = button("◎ Orbit", () => startConnect(f.id, "orbit"));
    orbit.title = "Attach this object so it circles around an axis while staying upright (Ferris-wheel cabins, planets)";
    const slider = button("↔ Slider", () => startConnect(f.id, "slider"));
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
    button("Remove connection", () => commit((features) => removeJoint(features, f.id)), "wide danger"),
  );
  return items;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Pick where to connect: click a point on another object; the face there sets the axis. */
function startConnect(id: string, type: "hinge" | "orbit" | "slider") {
  const f = findFeature(id);
  if (!f) return;
  // targetId null: the ground (the object stays top-level and moves on a fixed axis).
  const connect = (targetId: string | null, point: Vec3, rotation: Vec3) => {
    setStatus("");
    commit((features) => addJoint(features, id, targetId, type, point, rotation));
    setGizmoMode("joint");
    setNotice(`${f.name} is now connected to ${findFeature(targetId)?.name ?? "the ground"}. Drag the ${type === "slider" ? "arrow" : "ring"} to move it (${type === "slider" ? "Slide" : "Spin"}, J); Move and Rotate move it with its connection.`);
  };
  viewport.startPlacement({
    feature: f,
    marker: true,
    allowSelf: true,
    onPlace(point, rotation, targetId) {
      if (!targetId || !subtreeIds(doc.features, id).has(targetId)) return connect(targetId, point, rotation);
      // Picked on the object itself (e.g. the middle of a wheel): now pick what it attaches to.
      viewport.startPlacement({
        feature: f,
        pickOnly: true,
        onPlace(_p, _r, other) {
          connect(other, point, rotation);
        },
        onCancel() {
          setStatus("");
        },
      });
      setStatus(`Now click the object ${f.name} attaches to, or the empty ground to fix it to the ground. Esc to cancel.`);
    },
    onCancel() {
      setStatus("");
    },
  });
  setStatus(
    type !== "slider"
      ? `${type === "orbit" ? `Click the centre ${f.name} circles around` : `Click where ${f.name} turns`}, on it, on the object it attaches to, or on the ground. The arrow is the axle; F flips it (e.g. down under an object). Esc to cancel.`
      : `Click a face of ${f.name} or of what it slides on (or the ground): it slides along the arrow. F flips it (e.g. down). Esc to cancel.`,
  );
}


// ---- Text and screw holes -----------------------------------------------------

// ---- Fonts ------------------------------------------------------------------------------

/** Imported fonts the kernel has been given (it keeps them until the page reloads). */
const sentFonts = new Set<string>();
const base64ToBuffer = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Give the kernel the model's imported fonts it doesn't have yet. */
async function syncFonts() {
  for (const font of doc.fonts ?? []) {
    if (sentFonts.has(font.id)) continue;
    sentFonts.add(font.id);
    await kernel.loadFont(font.id, base64ToBuffer(font.data)).catch(() => sentFonts.delete(font.id));
  }
}

/** The model as saved: imported fonts that no text uses are left out. */
function savedDocument(): CadDocument {
  const used = new Set(doc.features.flatMap((f) => (f.kind === "text" ? [f.params.font] : [])));
  const fonts = (doc.fonts ?? []).filter((x) => used.has(CUSTOM_FONT + x.id));
  return { ...doc, fonts: fonts.length ? fonts : undefined };
}

/** Pick a font file and use it for this text. It's kept in the model, so the model opens anywhere. */
async function importFont(textId: string) {
  const [file] = await openImportFiles($("#import-input"), ["ttf", "otf", "woff"], "Font files");
  if (!file) return;
  if (file.data.byteLength > 8e6) return setStatus("That font file is over 8 MB; pick a smaller one.", true);
  const data = bufferToBase64(file.data);
  let font = doc.fonts?.find((x) => x.data === data);
  try {
    if (!font) {
      const id = newId();
      const name = await kernel.loadFont(id, file.data);
      sentFonts.add(id);
      font = { id, name, data };
    }
  } catch (err) {
    return setStatus(`Couldn't use ${file.name}: ${(err as Error).message}`, true);
  }
  const chosen = font;
  commit((features) => {
    doc.fonts = mergeFonts(doc.fonts, [chosen]);
    const t = features.find((x) => x.id === textId);
    if (t?.kind === "text") t.params.font = CUSTOM_FONT + chosen.id;
  });
  setNotice(`Using ${chosen.name}. It's saved inside the model, so the model opens with it anywhere.`);
}

/** CSS families for previews, loaded once each. */
const previewFaces = new Map<string, string>();
function previewFamily(font: string, bold: boolean): string {
  const family = fontFamily(font, bold);
  let css = previewFaces.get(family);
  if (!css) {
    css = `gz-${family.replace(/[^a-z0-9-]/gi, "_")}`;
    const custom = isCustomFont(font) ? doc.fonts?.find((x) => CUSTOM_FONT + x.id === font) : undefined;
    const source = custom ? base64ToBuffer(custom.data) : `url(${builtInFontUrl(family)})`;
    if (custom || builtInFontUrl(family)) {
      const face = new FontFace(css, source);
      document.fonts.add(face);
      void face.load().catch(() => {});
    }
    previewFaces.set(family, css);
  }
  return `"${css}", sans-serif`;
}

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
  // Imported fonts, and some built-in ones, come in one weight only.
  if (isCustomFont(p.font) || !builtInFont(p.font)?.bold) {
    check.disabled = true;
    bold.title = "This font has no bold version";
  }

  const fontSelect = document.createElement("select");
  for (const font of BUILT_IN_FONTS) fontSelect.add(new Option(`${font.name} (${font.style})`, font.key));
  const imported = doc.fonts ?? [];
  if (imported.length) {
    const group = document.createElement("optgroup");
    group.label = "Imported";
    for (const font of imported) group.append(new Option(font.name, CUSTOM_FONT + font.id));
    fontSelect.add(group);
  }
  if (![...fontSelect.options].some((o) => o.value === p.font)) fontSelect.add(new Option("(missing font)", p.font));
  fontSelect.add(new Option("Import a font file…", "import"));
  fontSelect.value = p.font;
  fontSelect.onchange = () => {
    if (fontSelect.value === "import") {
      fontSelect.value = p.font;
      void importFont(f.id);
    } else set((t) => (t.font = fontSelect.value));
  };
  // The text in its font (the first line).
  const preview = document.createElement("div");
  preview.className = "font-preview";
  preview.textContent = p.text.split("\n")[0].slice(0, 40) || "Aa Bb Cc 123";
  preview.style.fontFamily = previewFamily(p.font, p.bold);
  preview.style.fontWeight = p.bold && !check.disabled ? "700" : "400";
  return [
    box,
    hint("Shift+Enter starts a new line."),
    labeled("Font", fontSelect),
    preview,
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

/** Taper the sides and/or lean the whole shape over. */
function tiltSection(f: Feature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const tilt = f.tilt ?? { taper: 0, leanX: 0, leanY: 0 };
  const set = (key: keyof Tilt, v: number) =>
    update((t) => {
      const next = { ...(t.tilt ?? { taper: 0, leanX: 0, leanY: 0 }), [key]: Math.max(-60, Math.min(60, v)) };
      t.tilt = next.taper || next.leanX || next.leanY ? next : undefined;
    });
  const deg = { unit: "°", plain: true };
  const canLean = LEAN_KINDS.has(f.kind) && !(f.kind === "sketch" && (f.params.operation !== "extrude" || f.params.plane !== "XY"));
  // Round-all-over shapes have no sides to taper (and can't lean).
  if (!canLean && f.kind !== "sketch" && f.kind !== "imported") return [];
  const items: HTMLElement[] = [section("Tilt"), lengthField("Taper sides", tilt.taper, (v) => set("taper", v), deg)];
  if (canLean) items.push(lengthField("Lean X", tilt.leanX, (v) => set("leanX", v), deg), lengthField("Lean Y", tilt.leanY, (v) => set("leanY", v), deg));
  items.push(
    hint(
      canLean
        ? "Taper leans the sides in (negative: out), keeping the base. Lean slants the whole shape so its top shifts along X or Y."
        : "Taper leans the sides in (negative: out), keeping the base. This shape can't lean over.",
    ),
  );
  if (f.tilt) items.push(button("Straighten", () => update((t) => (t.tilt = undefined)), "link"));
  return items;
}

const SIZE_LABELS = ["Width (X)", "Depth (Y)", "Height (Z)"];

/** An imported solid's size along each axis, and its overall scale. */
function importedFields(f: Extract<Feature, { kind: "imported" }>, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const f6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const setScale = (scale: number[]) => update((t) => t.kind === "imported" && (t.params.scale = scale.map(f6) as [number, number, number]));
  const { size, scale } = f.params;
  const even = Math.abs(scale[0] - scale[1]) < 1e-9 && Math.abs(scale[1] - scale[2]) < 1e-9;
  const items: HTMLElement[] = SIZE_LABELS.map((label, i) =>
    lengthField(label, Math.round(size[i] * scale[i] * 1e4) / 1e4, (v) => size[i] > 1e-9 && resizeAlong(f.id, i, v / (size[i] * scale[i]), 0), { min: 0 }),
  );
  if (even) {
    items.push(
      lengthField("Scale", Math.round(scale[0] * 1e6) / 1e4, (v) => setScale([v / 100, v / 100, v / 100]), { min: 0, unit: "%" }),
      hint(
        f.params.faceted
          ? "A solid made from a mesh: it can be a hole, take fillets and chamfers (on its corners; curves are small smooth facets), and be split."
          : "An exact solid from another CAD program: it can be a hole, take fillets and chamfers, and be split. Sizes that change in proportion keep it exact.",
      ),
    );
  } else {
    // The most it was resized along any axis, for all of them.
    const k = scale.reduce((a, b) => (Math.abs(Math.log(b)) > Math.abs(Math.log(a)) ? b : a));
    items.push(
      hint(
        f.params.faceted
          ? "Stretched unevenly. Even it out to resize it in proportion again."
          : "Stretched unevenly: for holes, fillets and exports its curved faces become small flat facets (an exact solid can only be scaled evenly). Even it out to get the exact shape back.",
      ),
      button(`Even out (${fmt(k * 100)}% all round)`, () => setScale([k, k, k]), "wide"),
    );
  }
  return items;
}

/** A mesh's size along each axis: each one stretches it along that axis. */
/** The last mesh measured, so the panel doesn't decode a big mesh again on every edit. */
let meshExtents: { positions: string; lo: number[]; hi: number[] } | null = null;

function meshSizeFields(f: SculptFeature): HTMLElement[] {
  if (meshExtents?.positions !== f.params.positions) {
    const pos = decodeFloats(f.params.positions);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], pos[i + k]);
        hi[k] = Math.max(hi[k], pos[i + k]);
      }
    meshExtents = { positions: f.params.positions, lo, hi };
  }
  const { lo, hi } = meshExtents;
  return SIZE_LABELS.map((label, i) => {
    const now = hi[i] - lo[i];
    return lengthField(label, Math.round(now * 1e4) / 1e4, (v) => now > 1e-9 && resizeAlong(f.id, i, v / now, lo[2]), { min: 0 });
  });
}

/**
 * Resize an imported object along its own axis `i` by `factor` from the side
 * panel, as the resize handles do: its height grows up from its bottom
 * (`bottomZ`, in its own frame), as other shapes' does.
 */
function resizeAlong(id: string, i: number, factor: number, bottomZ: number) {
  const s = { x: 1, y: 1, z: 1 };
  s[(["x", "y", "z"] as const)[i]] = factor;
  commit((features) => {
    const f = features.find((x) => x.id === id);
    if (!f) return;
    const up = new Vector3(0, 0, 1).transformDirection(baseMatrix(f));
    resizeFeature(features, id, s, 0, i === 2 ? { axis: "z", at: bottomZ, dir: { x: up.x, y: up.y, z: up.z } } : undefined);
  });
}

function hedronFields(f: Extract<Feature, { kind: "hedron" }>, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const set = (mutate: (p: typeof f.params) => void) => update((t) => t.kind === "hedron" && mutate(t.params));
  return [
    stacked(
      "Faces",
      segmented(
        HEDRON_FACES.map((n) => ({ value: String(n), label: String(n), title: HEDRON_NAMES[n] })),
        String(f.params.faces),
        (v) => set((t) => (t.faces = Number(v) as HedronFaces)),
      ),
    ),
    hint(HEDRON_NAMES[f.params.faces]),
    lengthField("Diameter (corners)", f.params.radius * 2, (v) => set((t) => (t.radius = Math.max(0.01, v / 2))), { min: 0 }),
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
  const nut = NUT_SIZES[p.size];
  const ins = INSERT_SIZES[p.size];
  // What's at the top of the hole: for the screw's head, a nut, or a threaded insert.
  const head = document.createElement("select");
  const HEADS: [ScrewParams["head"], string, string][] = [
    ["none", "Plain hole", "Just the hole"],
    ["counterbore", "Counterbore", `A ${d.bore} mm pocket ${d.boreDepth} mm deep, so a socket head sits flush`],
    ["countersink", "Countersink", `A 90° cone ${d.sink} mm wide, for flat (countersunk) heads`],
    ["nut", "Nut trap", `A hex pocket for an ${p.size} nut: ${nut.flats + NUT_PLAY} mm across the flats, ${nut.thick + NUT_PLAY} mm deep`],
    ["insert", "Heat-set insert", `A ${ins.hole} mm hole ${ins.length + 1} mm deep for an ${p.size} threaded insert`],
  ];
  for (const [value, label, title] of HEADS) {
    const o = new Option(label, value);
    o.title = title;
    head.add(o);
  }
  head.value = p.head;
  head.title = HEADS.find(([v]) => v === p.head)?.[2] ?? "";
  head.onchange = () => set((t) => (t.head = head.value as ScrewParams["head"]));
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
    labeled("Top", head),
    lengthField("Depth", p.depth, (v) => set((t) => (t.depth = v)), { min: 0 }),
    hint(
      p.head === "nut"
        ? `Hole ${d[p.fit]} mm, with a nut trap at the top (${nut.flats + NUT_PLAY} mm across the flats, ${nut.thick + NUT_PLAY} mm deep). Rotate the hole to line the hex up; flip it over to put the nut at the bottom.`
        : p.head === "insert"
          ? `A ${ins.hole} mm hole ${ins.length + 1} mm deep for a heat-set insert (press it in with a soldering iron), then ${d[p.fit]} mm for the screw. Insert sizes vary by maker: check yours.`
          : `Hole ${d[p.fit]} mm. It goes down into the face it's placed on. For 3D printing, holes come out a little small: Normal or Loose fit allows for that.`,
    ),
  ];
}

// ---- Colour, hollow, mirror, repeat ---------------------------------------------

const SWATCHES = ["#3ddc97", "#4aa3ff", "#ff6b6b", "#ffb020", "#a77bff", "#f2d33c", "#ff7ac6", "#f2f2f2", "#555b66"];

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

const TEXTURES: { value: TexturePattern; label: string; size: number; depth: number }[] = [
  { value: "knurl", label: "Diamond knurl", size: 2, depth: 0.6 },
  { value: "ribs", label: "Straight ribs", size: 2, depth: 0.6 },
  { value: "rings", label: "Rings", size: 2, depth: 0.5 },
  { value: "bumps", label: "Bumps", size: 3, depth: 0.8 },
  { value: "honeycomb", label: "Honeycomb", size: 5, depth: 0.6 },
  { value: "grid", label: "Square grid", size: 3, depth: 0.6 },
  { value: "bricks", label: "Bricks", size: 8, depth: 0.6 },
  { value: "waves", label: "Waves", size: 4, depth: 0.6 },
  { value: "wood", label: "Wood grain", size: 3, depth: 0.4 },
  { value: "rough", label: "Rough (fuzzy)", size: 1, depth: 0.3 },
];

/** A printable surface pattern on the object. */
function textureSection(f: Feature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const tex = f.texture;
  const set = (change: Partial<Texture>) => update((t) => t.texture && Object.assign(t.texture, change));
  const pick = document.createElement("select");
  pick.add(new Option("None", ""));
  for (const t of TEXTURES) pick.add(new Option(t.label, t.value));
  pick.value = tex?.pattern ?? "";
  pick.onchange = () => {
    const chosen = TEXTURES.find((t) => t.value === pick.value);
    update((t) => {
      if (!chosen) delete t.texture;
      // A new pattern starts at its own usual size and depth.
      else t.texture = { pattern: chosen.value, size: chosen.size, depth: chosen.depth, faces: t.texture?.faces ?? "sides", wrap: t.texture?.wrap ?? "auto", raised: t.texture?.raised ?? false };
    });
  };
  const items: HTMLElement[] = [section("Texture"), labeled("Pattern", pick)];
  if (!tex) return items;
  items.push(
    lengthField("Depth", tex.depth, (v) => set({ depth: Math.min(v, 10) }), { min: 0 }),
    lengthField("Repeat size", tex.size, (v) => set({ size: Math.max(0.3, v) }), { min: 0 }),
    labeled(
      "On",
      segmented(
        [
          { value: "sides", label: "Sides" },
          { value: "all", label: "All" },
          { value: "top", label: "Top" },
        ],
        tex.faces,
        (v) => set({ faces: v }),
      ),
    ),
    labeled(
      "Wrap",
      segmented(
        [
          { value: "auto", label: "Auto" },
          { value: "around", label: "Around" },
          { value: "flat", label: "Flat" },
        ],
        tex.wrap,
        (v) => set({ wrap: v }),
      ),
    ),
    segmented(
      [
        { value: "in", label: "Pressed in" },
        { value: "out", label: "Raised" },
      ],
      tex.raised ? "out" : "in",
      (v) => set({ raised: v === "out" }),
    ),
    hint(
      "A real pattern that prints: shown here, and in STL and 3MF exports (STEP files get the plain shape). Pressed in keeps the outside size. " +
        "<b>Around</b> wraps it round the object (for cylinders), <b>Flat</b> lays it on each side. Keep the depth under about a third of the size for clean prints.",
    ),
  );
  return items;
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
    const open = button("⁂ Repeat", () => {
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
  group.title = "Put them in a new group (Ctrl+G): they move together but stay separate parts";
  const combine = button("⧉ Combine", combineSelected);
  combine.title = "Join them into one shape: it moves, rounds and exports as one (you can split it back up)";
  actions.append(group, combine, button("Duplicate", duplicateSelected), button(`Delete ${selectedIds.length}`, deleteSelected, "danger"));
  items.push(...estimateSection());
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
  groupIds(ids);
  setNotice(`Grouped ${ids.length} objects.`);
}

/** Join the selected objects into one shape (a combined group), which moves, rounds and exports as one. */
function combineSelected() {
  const ids = topSelected();
  // A selected object inside another selected one (e.g. a part and its parent) joins in too.
  const inner = selectedIds.filter((id) => !ids.includes(id) && findFeature(id));
  if (ids.length + inner.length < 2) return;
  groupIds(ids, true, inner);
  setNotice(`Combined ${ids.length + inner.length} objects into one. Untick "Combine into one shape" on the group to keep them as separate parts.`);
}

/**
 * Put objects (none inside another) into a new group around them; returns the
 * group's id. `inner` (objects inside those) are lifted out into the group too.
 */
function groupIds(ids: string[], combined = false, inner: string[] = []): string {
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
    for (const id of [...ids, ...inner]) reparent(features, id, group.id);
    if (combined) {
      const g = features.find((x) => x.id === group.id);
      if (g) g.combined = true;
    }
  });
  selectedIds = [group.id];
  selectedId = group.id;
  renderPanels();
  return group.id;
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
let historyKey = "";
function renderHistory() {
  // Only rebuild the strip when something it shows changed.
  const key = JSON.stringify([historyMarker, selectedIds, doc.features.map((f) => [f.id, f.name, f.kind, f.suppressed])]);
  if (key === historyKey) return;
  historyKey = key;
  const bar = $("#history-steps");
  const chips: HTMLElement[] = [];
  const end = historyMarker ?? doc.features.length;
  doc.features.forEach((f, i) => {
    if (i === end && historyMarker !== null) chips.push(markerEl());
    const chip = document.createElement("button");
    chip.className = ["step", i >= end ? "future" : "", f.suppressed ? "off" : "", selectedIds.includes(f.id) ? "selected" : ""].join(" ");
    chip.textContent = `${kindIcon(f)} ${f.name}`;
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
/**
 * The holes that would cut this object: its own, its parents', and the
 * top-level ones (as the kernel works it out), whether or not it ignores them.
 */
function holesReaching(features: Feature[], f: Feature): Feature[] {
  if (f.mode === "hole") return [];
  const holes = childrenOf(features, f.id).filter((c) => c.mode === "hole");
  let node = f;
  while (node.parentId) {
    const parent = features.find((x) => x.id === node.parentId);
    if (!parent) break;
    if (parent.mode === "hole") return []; // Part of a hole: it doesn't get cut.
    holes.push(...childrenOf(features, parent.id).filter((c) => c.mode === "hole"));
    node = parent;
  }
  holes.push(...childrenOf(features, null).filter((c) => c.mode === "hole" && c.id !== node.id));
  return holes;
}

/** A group's parts as one joined shape, or separate parts that move together. */
function combineSection(f: Feature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  // Rounding, hollowing or texturing a group works on its joined shape, so those keep it combined.
  const needed = f.edgeOps.length > 0 || !!f.shell || !!f.texture;
  const row = checkToggle("Combine into one shape", isMergedGroup(f), (on) => update((t) => (on ? (t.combined = true) : delete t.combined)));
  if (needed) {
    (row.querySelector("input") as HTMLInputElement).disabled = true;
    row.title = "Its edge finishes, hollowing or texture work on the joined shape, so it stays combined";
  }
  return [
    section("Combine"),
    row,
    hint(
      isMergedGroup(f)
        ? "Its parts are joined into one shape: it shows, rounds and exports as one solid. Holes inside the group cut it."
        : "Its parts move together but stay separate shapes. Tick to join them into one solid (where they touch or overlap becomes one).",
    ),
  ];
}

/** Clearance on a hole; on a solid, a quick way to make a hole it fits into. */
function fitSection(f: Feature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  if (f.kind === "sketch" && f.params.operation === "flat") return [];
  if (f.mode === "hole") {
    const items: HTMLElement[] = [
      section("Clearance"),
      lengthField("Clearance", f.clearance ?? 0, (v) => update((t) => (v > 0 ? (t.clearance = v) : delete t.clearance))),
      hint("Grows this hole by this much on every side, so a part the same shape fits into what it cuts. About 0.2 mm is a snug fit on most printers; 0.3–0.5 mm slides freely."),
    ];
    const s = f.sweep;
    // What it can sweep with: its own earlier sweep, or the moving part it was made from.
    const src = s?.source ? findFeature(s.source) : f.follows ? findFeature(f.follows) : doc.features.find((x) => x.joint && x.ignoreHoles?.includes(f.id));
    const type = s?.joint.type ?? src?.joint?.type;
    if (!type) return items;
    const slider = type === "slider";
    const on = checkToggle(slider ? "Clear the full slide" : "Clear the full swing", !!s && !s.off, (want) => {
      if (want) sweepClearanceCut(f.id);
      else update((t) => t.sweep && (t.sweep.off = true));
    });
    items.push(section(slider ? "Slide" : "Swing"), on);
    if (s && !s.off) {
      const unit = slider ? {} : { unit: "°", plain: true };
      items.push(
        lengthField("From", s.from, (v) => update((t) => t.sweep && (t.sweep.from = v)), unit),
        lengthField("To", s.to, (v) => update((t) => t.sweep && (t.sweep.to = v)), unit),
        hint(`Swept through its ${slider ? "slider's travel" : "hinge's swing"} (the values the ${slider ? "slider" : "hinge"} shows), so the moving part clears all of it. Untick to cut just where it sits.`),
      );
    } else items.push(hint(`Tick to sweep it through ${src?.name ?? "its part"}'s ${slider ? "travel" : "swing"}, so the moving part clears all of it.`));
    return items;
  }
  const make = button("Make a clearance cut", () => makeClearanceCut(f.id, !!f.joint && sweepNext), "wide");
  make.title = "Add a copy of this as a hole 0.2 mm bigger all round, which cuts what this overlaps but not this object";
  const items: HTMLElement[] = [section("Clearance cut")];
  if (f.joint) {
    const j = f.joint;
    const row = checkToggle(j.type === "slider" ? "Clear the full slide" : "Clear the full swing", sweepNext, (on) => {
      sweepNext = on;
      renderPanels();
    });
    row.title = `Sweep the cut along the ${j.type === "slider" ? "slider" : "hinge"}: it starts at 0 to 0; drag its orange ends to stretch it`;
    items.push(row);
  }
  items.push(make, hint(f.joint && sweepNext ? "Cuts a path 0.2 mm bigger all round where this moves, in whatever it passes through. It starts at 0 to 0: drag its orange ends to stretch it." : "For a peg, lid or insert: place it where it goes, then this cuts a socket 0.2 mm bigger all round in whatever it overlaps. Change the clearance on the new hole."));
  return items;
}

/** Whether a new clearance cut sweeps through its object's movement. */
let sweepNext = true;

/** The joint values a new swept clearance cut clears: none yet (0 to 0); its ends are dragged out, or follow the hinge. */
function sweepRange(_j: NonNullable<Feature["joint"]>): [number, number] {
  return [0, 0];
}

/** A copy of an object as a hole with clearance, which the object itself ignores (so only what it sits in is cut). */
function makeClearanceCut(id: string, sweep = false) {
  const f = findFeature(id);
  if (!f) return;
  // A group, or an object with things inside it: a hole group around a copy of all of it, grown as one shape.
  const whole = f.kind === "group" || childrenOf(doc.features, f.id).length > 0;
  const copies = whole ? cloneSubtree(f) : [];
  let hole: Feature;
  if (!whole) hole = { ...structuredClone(f), id: newId(), name: `${f.name} clearance`, mode: "hole", clearance: 0.2 } as Feature;
  else if (f.kind === "group") hole = Object.assign(copies.shift()!, { name: `${f.name} clearance`, mode: "hole", clearance: 0.2 });
  else {
    hole = { ...createFeature("group", doc.features, f.parentId), name: `${f.name} clearance`, mode: "hole", clearance: 0.2 };
    // The copied object sits at the group's origin (the group takes its place in the world).
    Object.assign(copies[0], { parentId: hole.id, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } });
    for (const k of ["joint", "ignoreHoles", "mirrored"] as const) delete copies[0][k];
  }
  for (const k of ["shell", "texture", "joint", "ignoreHoles", "color", "combined"] as const) delete hole[k];
  commit((features) => {
    const t = features.find((x) => x.id === id);
    if (!t) return;
    t.ignoreHoles = [...(t.ignoreHoles ?? []), hole.id];
    insertFeatures(features, [hole, ...copies]);
    // Where the object is now: a hinge or slider may have moved it from its own position (unless the hole gets the joint too).
    setWorldMatrix(features, hole.id, worldMatrix(features, id));
    const h = features.find((x) => x.id === hole.id);
    if (sweep && t.joint && h) {
      const [from, to] = sweepRange(t.joint);
      h.sweep = { joint: structuredClone(t.joint), position: { ...t.position }, frame: localMatrix(h).toArray(), from, to, source: t.id };
    } else if (t.joint && h) {
      // Its own copy of the hinge or slider (beside the object, so in the same frame), moving with the object's.
      Object.assign(h, { position: { ...t.position }, rotation: { ...t.rotation }, joint: structuredClone(t.joint), follows: t.id });
      if (t.mirrored) h.mirrored = true;
      else delete h.mirrored;
    }
  });
  selectedIds = [hole.id];
  selectedId = hole.id;
  renderPanels();
  const moves = f.joint && !sweep ? ` It has a copy of ${f.name}'s ${f.joint.type === "slider" ? "slider" : "hinge"} and moves with it.` : "";
  setNotice(`${hole.name} cuts a socket 0.2 mm bigger than ${f.name} in whatever it overlaps. ${f.name} isn't cut by it.${moves} Move them together by selecting both.`);
}

/** Sweep a clearance cut through its part's movement again: its kept sweep, or a new one from the part. */
function sweepClearanceCut(id: string) {
  commit((features) => {
    const h = features.find((x) => x.id === id);
    if (!h) return;
    if (h.sweep) {
      delete h.sweep.off;
      return;
    }
    const t = (h.follows && features.find((x) => x.id === h.follows)) || features.find((x) => x.joint && x.ignoreHoles?.includes(h.id));
    if (!t?.joint) return;
    // A swept cut stays put: one that swung with its part keeps where it is now, without the joint.
    const world = worldMatrix(features, h.id);
    delete h.joint;
    delete h.follows;
    setWorldMatrix(features, h.id, world);
    const [from, to] = sweepRange(t.joint);
    h.sweep = { joint: structuredClone(t.joint), position: { ...t.position }, frame: localMatrix(h).toArray(), from, to, source: t.id };
  });
}

// ---- Chisel ------------------------------------------------------------------------------

/** The chisel's settings, kept for the next groove. */
const chisel: { width: number; depth: number; tip: GrooveTip } = { width: 3, depth: 2, tip: "round" };

/** Carve grooves into an object by dragging across it. */
function chiselSection(f: Feature): HTMLElement[] {
  const on = viewport.chiseling === f.id;
  const toggle = button(on ? "Stop chiselling" : "🪓 Chisel", () => (on ? stopChisel() : startChisel(f.id)), on ? "primary wide" : "wide");
  toggle.title = "Drag across this object to carve a groove into it (each stroke is a hole you can change or delete)";
  const items: HTMLElement[] = [section("Chisel"), toggle];
  if (on) {
    items.push(
      lengthField("Width", chisel.width, (v) => ((chisel.width = Math.max(0.1, v)), renderProperties())),
      lengthField("Depth", chisel.depth, (v) => ((chisel.depth = Math.max(0.05, v)), renderProperties())),
      labeled(
        "Tip",
        segmented(
          [
            { value: "flat" as const, label: "Flat", title: "Square-bottomed groove" },
            { value: "v" as const, label: "V", title: "V-shaped groove" },
            { value: "round" as const, label: "Round", title: "Round-bottomed groove" },
          ],
          chisel.tip,
          (tip) => ((chisel.tip = tip), renderProperties()),
        ),
      ),
      hint("Drag across a face to carve a groove; it follows that face's flat plane. Each stroke is a hole inside this object (its sketch can be edited). Esc to stop."),
    );
  }
  return items;
}

function startChisel(id: string) {
  stopSketchEdit();
  stopEdgePick();
  viewport.startChisel(id, (points, normal) => carveGroove(id, points, normal));
  setStatus("Chisel: drag across the object to carve a groove. Esc to stop.");
  renderPanels();
}

function stopChisel() {
  if (!viewport.chiseling) return;
  viewport.stopChisel();
  setStatus("");
  renderPanels();
}

/** A path with the points that stray under `tol` from the line between their neighbours left out (Ramer–Douglas–Peucker). */
function simplifyPath(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [dx, dy] = [pts[b][0] - ax, pts[b][1] - ay];
    const len = Math.hypot(dx, dy) || 1;
    let far = -1;
    let farDist = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > farDist) [far, farDist] = [i, d];
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return pts.filter((_, i) => keep[i]);
}

/** A groove along a stroke (world points on a face's plane, and its outward normal): a sketch stroke cut into the object as a hole. */
function carveGroove(id: string, points: Vec3[], normal: Vec3) {
  const target = findFeature(id);
  if (!target) return;
  const { width, depth, tip } = chisel;
  // The groove's frame: Z into the object, X along the stroke's start, on the face where the stroke began.
  const z = new Vector3(-normal.x, -normal.y, -normal.z).normalize();
  const origin = new Vector3(points[0].x, points[0].y, points[0].z);
  const along = new Vector3(points.at(-1)!.x, points.at(-1)!.y, points.at(-1)!.z).sub(origin);
  let x = along.sub(z.clone().multiplyScalar(along.dot(z)));
  if (x.lengthSq() < 1e-9) x = Math.abs(z.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  x = x.sub(z.clone().multiplyScalar(x.dot(z))).normalize();
  const y = z.clone().cross(x);
  const world = new Matrix4().makeBasis(x, y, z).setPosition(origin);
  const r2 = (v: number) => Math.round(v * 100) / 100 + 0;
  // Thinned to the corners that matter (within 0.1 mm of the drag): a point every half millimetre makes
  // dozens of tiny faces, which a rounded or V tip can't follow cleanly.
  const uv = simplifyPath(
    points.map((p) => {
      const d = new Vector3(p.x, p.y, p.z).sub(origin);
      return [d.dot(x), d.dot(y)] as [number, number];
    }),
    0.1,
  ).map(([u, v]) => [r2(u), r2(v)] as [number, number]);
  const groove = createFeature("sketch", doc.features, id) as SketchFeature;
  const n = doc.features.filter((f) => f.name.startsWith("Groove ")).length + 1;
  // Starts a little outside the face, so the cut opens cleanly through it.
  const lip = 0.05;
  Object.assign(groove, { name: `Groove ${n}`, mode: "hole" as const });
  groove.params = { ...groove.params, operation: "extrude", offset: -lip, depth: depth + lip, direction: "normal", entities: [{ id: newId(), mode: "add", type: "stroke", points: uv, width }], groove: { tip } };
  commit((features) => {
    insertFeatures(features, [groove]);
    setWorldMatrix(features, groove.id, world);
  });
  setNotice(`Carved ${groove.name} (${fmt(width)} mm wide, ${fmt(depth)} mm deep) into ${target.name}. Keep dragging for more; Esc to stop.`);
}

/** Which holes cut this object: untick one and it leaves this object (and everything inside it) alone. */
function holesSection(f: Feature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const holes = holesReaching(activeFeatures(doc.features), f);
  if (!holes.length) return [];
  const items: HTMLElement[] = [section("Cut by holes")];
  for (const h of holes) {
    const inherited = !f.ignoreHoles?.includes(h.id) && ignoresHole(doc.features, f, h.id);
    const row = checkToggle(h.name, !ignoresHole(doc.features, f, h.id), (on) =>
      update((t) => {
        const list = (t.ignoreHoles ?? []).filter((id) => id !== h.id);
        if (!on) list.push(h.id);
        t.ignoreHoles = list.length ? list : undefined;
      }),
    );
    if (inherited) {
      // Ignored because an object it's inside ignores it: change it there.
      (row.querySelector("input") as HTMLInputElement).disabled = true;
      row.title = "An object this is inside ignores this hole";
    }
    items.push(row);
  }
  items.push(hint("Untick a hole to keep it from cutting this object (and anything inside it). It still cuts everything else it reaches."));
  return items;
}

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
    items.push(
      lengthField("Alignment pins", d.pins ?? 0, (v) => ((d.pins = Math.max(0, Math.min(6, Math.round(v)))), renderProperties()), { plain: true }),
      ...(d.pins
        ? [
            lengthField("Pin diameter", dowel.diameter, (v) => ((dowel.diameter = Math.max(0.5, v)), renderProperties())),
            lengthField("Pin depth", dowel.depth, (v) => ((dowel.depth = Math.max(0.5, v)), renderProperties())),
            hint(`Each cut gets ${d.pins} pin hole${d.pins > 1 ? "s" : ""} ${fmt(dowel.diameter + dowel.play)} mm wide, ${fmt(dowel.depth)} mm into each piece, and the pins to print (${fmt(dowel.diameter)} mm × ${fmt(dowel.depth * 2 - 0.5)} mm) go beside the model. 1.75 mm filament or steel dowels work too.`),
          ]
        : []),
    );
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
    }, "danger");
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
  const split = button("✂ Split", () => {
    dividerDraft = null;
    const axis: Axis = max.x - min.x >= max.y - min.y ? "x" : "y";
    splitDraft = { id: f.id, axis, tilt: 0, toward: "z", cuts: [mid(axis)], active: 0 };
    renderProperties();
  });
  split.title = "Cut this object into separate pieces, straight or at an angle";
  const dividers = button("▥ Dividers", () => {
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
  // Pins: where each cut crosses the object (worked out now, while it's whole), holes in the pieces either side.
  const world = worldMatrix(doc.features, id);
  const n = new Vector3(normal?.x ?? (d.axis === "x" ? 1 : 0), normal?.y ?? (d.axis === "y" ? 1 : 0), normal?.z ?? (d.axis === "z" ? 1 : 0));
  const worldN = n.clone().transformDirection(world);
  const pinSpots = d.pins ? cuts.map((at) => pinPositions(id, n.clone().multiplyScalar(at).applyMatrix4(world), worldN, d.pins!)) : [];
  const allPieces = [[id], ...pieces.map((c) => [c[0].id])];
  commit((features) => {
    const orig = features.find((x) => x.id === id)!;
    orig.name = `${name} A`;
    orig.clips = [...(orig.clips ?? []), clip(cuts[0], "below")];
    for (const clones of pieces) insertFeatures(features, clones);
    // A hole through the cut for each pin, in both pieces it joins (each keeps only its own side of it).
    const holes: Feature[] = [];
    pinSpots.forEach((spots, k) => {
      for (const spot of spots)
        for (const [pieceId] of [allPieces[k], allPieces[k + 1]]) {
          const h = createFeature("cylinder", features, pieceId);
          Object.assign(h, { name: "Pin hole", mode: "hole" as const, params: { ...h.params, radius: (dowel.diameter + dowel.play) / 2, radiusY: (dowel.diameter + dowel.play) / 2, height: dowel.depth * 2 } });
          insertFeatures(features, [h]);
          setWorldMatrix(features, h.id, alongAxis(spot, worldN).multiply(new Matrix4().makeTranslation(0, 0, -dowel.depth)));
          holes.push(h);
        }
    });
    // The pins to print: upright beside the model.
    const count = pinSpots.flat().length;
    if (count) {
      const box = viewport.modelBounds(new Set([id]));
      const group = createFeature("group", features, null);
      group.name = "Dowel pins";
      insertFeatures(features, [group]);
      setWorldMatrix(features, group.id, new Matrix4().makeTranslation((box?.max.x ?? 0) + 10, box?.min.y ?? 0, 0));
      for (let i = 0; i < count; i++) {
        const pin = createFeature("cylinder", features, group.id);
        const r = dowel.diameter / 2;
        Object.assign(pin, { name: `Pin ${i + 1}`, position: { x: 0, y: i * (dowel.diameter + 4), z: 0 }, params: { ...pin.params, radius: r, radiusY: r, height: dowel.depth * 2 - 0.5 } });
        // A small chamfer on both ends, so it starts into its holes easily.
        pin.edgeOps = [{ id: newId(), type: "chamfer", size: Math.min(0.3, r / 3), target: "all", points: [] }];
        insertFeatures(features, [pin]);
      }
    }
  });
  splitDraft = null;
  selectedId = pieces[0][0].id;
  selectedIds = [selectedId];
  renderPanels();
  const pinCount = pinSpots.flat().length;
  const missing = d.pins ? cuts.length * d.pins - pinCount : 0;
  setNotice(
    `Split ${name} into ${cuts.length + 1} pieces (A–${letter(cuts.length)}). Move any piece to pull them apart.` +
      (pinCount ? ` ${pinCount} pin hole${pinCount > 1 ? "s" : ""} in each joint face, and the pins to print are in “Dowel pins”.` : "") +
      (missing > 0 ? ` (${missing} pin${missing > 1 ? "s" : ""} didn't fit: the cut face is too narrow there.)` : ""),
  );
}

/** A frame at `point` whose Z points along `dir` (world). */
function alongAxis(point: Vector3, dir: Vector3): Matrix4 {
  const z = dir.clone().normalize();
  const x = Math.abs(z.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  x.sub(z.clone().multiplyScalar(x.dot(z))).normalize();
  return new Matrix4().makeBasis(x, z.clone().cross(x), z).setPosition(point);
}

/**
 * Where to put `count` pins on a cut through an object (world): inside its
 * cross-section, at least a pin's width plus 1.2 mm from the edge, spread as
 * far apart as they go (the first where there's most room).
 */
function pinPositions(id: string, point: Vector3, normal: Vector3, count: number): Vector3[] {
  const segs = viewport.crossSection(id, point, normal);
  if (!segs.length) return [];
  const frame = alongAxis(point, normal);
  const toPlane = frame.clone().invert();
  const flat = segs.map(([a, b]) => [new Vector3(a.x, a.y, a.z).applyMatrix4(toPlane), new Vector3(b.x, b.y, b.z).applyMatrix4(toPlane)] as const);
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const s of flat) for (const p of s) (lo[0] = Math.min(lo[0], p.x)), (lo[1] = Math.min(lo[1], p.y)), (hi[0] = Math.max(hi[0], p.x)), (hi[1] = Math.max(hi[1], p.y));
  const inside = (x: number, y: number) => {
    let crossings = 0;
    for (const [a, b] of flat) if ((a.y > y) !== (b.y > y) && x < a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x)) crossings++;
    return crossings % 2 === 1;
  };
  const room = (x: number, y: number) => {
    let best = Infinity;
    for (const [a, b] of flat) {
      const [dx, dy] = [b.x - a.x, b.y - a.y];
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
    }
    return best;
  };
  const need = dowel.diameter / 2 + dowel.play + 1.2;
  const step = Math.max(hi[0] - lo[0], hi[1] - lo[1]) / 40;
  const spots: { x: number; y: number; room: number }[] = [];
  for (let x = lo[0] + step / 2; x < hi[0]; x += step)
    for (let y = lo[1] + step / 2; y < hi[1]; y += step) {
      if (!inside(x, y)) continue;
      const r = room(x, y);
      if (r >= need) spots.push({ x, y, room: r });
    }
  if (!spots.length) return [];
  // One pin: where there's most room. More: from the far end, each next as far as it can be from those chosen.
  const [mx, my] = [spots.reduce((t, s) => t + s.x, 0) / spots.length, spots.reduce((t, s) => t + s.y, 0) / spots.length];
  const chosen = [count === 1 ? spots.reduce((a, b) => (b.room > a.room ? b : a)) : spots.reduce((a, b) => (Math.hypot(b.x - mx, b.y - my) > Math.hypot(a.x - mx, a.y - my) ? b : a))];
  while (chosen.length < count) {
    let far: (typeof spots)[number] | null = null;
    let farDist = 2 * need;
    for (const s of spots) {
      const dist = Math.min(...chosen.map((c) => Math.hypot(c.x - s.x, c.y - s.y)));
      if (dist > farDist) [far, farDist] = [s, dist];
    }
    if (!far) break;
    chosen.push(far);
  }
  return chosen.map((c) => new Vector3(c.x, c.y, 0).applyMatrix4(frame));
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
  // With nothing selected (and no sketch or sculpt open) the right panel steps aside for the view.
  document.body.classList.toggle("nothing-selected", !f && !(editingSketchId && sketchEditor) && !findFeature(sculptingId));
  if (editingSketchId && sketchEditor && editingSketch()) return renderSketchPanel(panel, editingSketch()!, sketchEditor);
  const sculpting = findFeature(sculptingId);
  if (sculpting?.kind === "sculpt") return panel.replaceChildren(...sculptPanel(sculpting));
  if (f && selectedIds.length > 1) return panel.replaceChildren(...multiPanel());
  if (!f) {
    // The panel is hidden now (see nothing-selected); the tips are in GizmoCAD ▸ Tips & shortcuts.
    panel.replaceChildren();
    return;
  }
  panel.replaceChildren(...objectItems(f));
}

/**
 * An object's panel. Built off the page too (`offscreen`), to re-apply its
 * fields that use parameters when those change.
 */
function objectItems(f: Feature, offscreen = false): HTMLElement[] {
  const outer = [fieldContext, offscreenPanel] as const;
  fieldContext = { id: f.id, counts: new Map() };
  offscreenPanel = offscreen;
  try {
    return objectItemsNow(f);
  } finally {
    [fieldContext, offscreenPanel] = outer;
  }
}

function objectItemsNow(f: Feature): HTMLElement[] {
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
      ...fitSection(f, update),
    );
  }
  if (f.kind === "group") {
    // A hole group cuts with all its parts joined as one shape.
    const mode = segmented(
      [
        { value: "solid", label: "Solid" },
        { value: "hole", label: "Hole", title: "Cut its parts, joined as one shape, out of what they overlap" },
      ],
      f.mode,
      (m) => update((t) => (t.mode = m)),
      "mode",
    );
    items.push(mode, ...(f.mode === "hole" ? fitSection(f, update) : [...combineSection(f, update), ...fitSection(f, update)]));
  }
  if (f.mode === "solid" && f.kind !== "plane" && f.kind !== "sculpt" && !(f.kind === "sketch" && f.params.operation === "flat")) items.push(...chiselSection(f));

  if (f.kind === "sculpt") {
    const solid = button("◆ Make it a solid", () => void convertToSolid(f.id), "wide");
    solid.title = "Turn the mesh into a solid that takes fillets, chamfers, holes and textures like any other object (Ctrl+Z to undo)";
    items.push(
      button("✋ Sculpt", () => startSculpt(f.id), "primary wide"),
      section("Size"),
      ...meshSizeFields(f),
      section("Solid"),
      solid,
      hint("A mesh can't be a hole or take fillets, chamfers, shells or textures. As a solid it can; flat areas become single faces, curves keep their small facets."),
      section("Clay"),
      ...sculptSettings(f, update),
    );
  } else if (f.kind === "sketch") {
    items.push(section("Sketch"), ...sketchSettings(f, update), button("✎ Edit sketch", () => startSketchEdit(f.id), "primary wide"));
  } else if (f.kind === "spring") {
    items.push(section("Spring"), ...springFields(f, update));
  } else if (f.kind === "text") {
    items.push(section("Text"), ...textFields(f, update));
  } else if (f.kind === "screw") {
    items.push(section("Screw hole"), ...screwFields(f, update));
  } else if (f.kind === "hedron") {
    items.push(section("Size"), ...hedronFields(f, update));
  } else if (f.kind === "imported") {
    items.push(section("Size"), ...importedFields(f, update));
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
  if (f.kind !== "group" && f.kind !== "plane" && f.kind !== "sculpt" && !(f.kind === "sketch" && f.params.operation === "flat")) items.push(...tiltSection(f, update));
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
  if (f.kind !== "plane" && f.mode === "solid") items.push(...estimateSection());
  // A flat sketch has no solid yet, so nothing to round, cut or sculpt.
  const flat = f.kind === "sketch" && f.params.operation === "flat";
  if (FINISHABLE.includes(f.kind) && !flat) {
    if (f.kind === "text") {
      // The geometry kernel can't reliably round or bevel font outlines (it fails on most letters).
      items.push(section("Edges"), hint("Letters can't be rounded or bevelled: font outlines are too complex for the geometry kernel. For softer letters, pick a bolder font or make them taller."));
    } else {
      items.push(...edgeSection(f, update));
      items.push(...shellSection(f, update));
    }
    if (f.mode === "solid") items.push(...textureSection(f, update));
    const sculpt = button("✋ Sculpt this object", () => void convertToSculpt(f.id), "wide");
    sculpt.title = "Turn this object into clay you can sculpt with brushes (Ctrl+Z to undo)";
    items.push(section("Sculpt"), sculpt, hint(f.kind === "group" ? "The group's merged shape becomes one piece of clay." : "Turns the exact shape into clay; dimensions and fillets stop being editable."));
  }

  if (f.kind !== "plane") items.push(...holesSection(f, update));
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

  return items;
}

const TARGETS: { value: EdgeTarget; label: string }[] = [
  { value: "all", label: "All edges" },
  { value: "top", label: "Top edges" },
  { value: "bottom", label: "Bottom edges" },
  { value: "vertical", label: "Vertical edges" },
  { value: "picked", label: "Picked edges" },
];

/** A checkbox with its label. */
function checkToggle(label: string, on: boolean, onChange: (on: boolean) => void) {
  const row = document.createElement("label");
  row.className = "toggle";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = on;
  check.onchange = () => onChange(check.checked);
  row.append(check, ` ${label}`);
  return row;
}

/** Corner edges found on each mesh-made solid (by ref): working them out takes a moment on a big mesh. */
const cornerCounts = new Map<string, number>();

/**
 * How many corner edges a mesh-made solid has: places where its facets meet
 * at more than 30° (as the kernel counts them), with each run of joined
 * pieces counted once (a cylinder's rim is one edge, not dozens). Null if its
 * triangles aren't to hand yet (an older file, until it's been converted).
 */
function cornerEdgeCount(f: Extract<Feature, { kind: "imported" }>): number | null {
  const known = cornerCounts.get(f.params.ref);
  if (known !== undefined) return known;
  const mesh = f.params.mesh ?? geometryStore.get(f.params.ref)?.mesh;
  if (!mesh) return null;
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(decodeFloats(mesh.positions), 3));
  g.setIndex(new BufferAttribute(decodeIndices(mesh.indices), 1));
  const edges = new EdgesGeometry(g, 30);
  const p = edges.getAttribute("position").array;
  const key = (i: number) => `${Math.round(p[i] * 1e4)},${Math.round(p[i + 1] * 1e4)},${Math.round(p[i + 2] * 1e4)}`;
  const ends: [string, string][] = [];
  const at = new Map<string, number[]>();
  for (let i = 0; i < p.length; i += 6) {
    const pair: [string, string] = [key(i), key(i + 3)];
    for (const k of pair) at.set(k, [...(at.get(k) ?? []), ends.length]);
    ends.push(pair);
  }
  // Follow each run through points where exactly two pieces meet.
  const seen = new Uint8Array(ends.length);
  let count = 0;
  for (let s = 0; s < ends.length; s++) {
    if (seen[s]) continue;
    count++;
    seen[s] = 1;
    for (const start of ends[s]) {
      let point = start;
      let from = s;
      for (;;) {
        const here = at.get(point)!;
        if (here.length !== 2) break;
        const next = here[0] === from ? here[1] : here[0];
        if (seen[next]) break;
        seen[next] = 1;
        point = ends[next][0] === point ? ends[next][1] : ends[next][0];
        from = next;
      }
    }
  }
  g.dispose();
  edges.dispose();
  cornerCounts.set(f.params.ref, count);
  return count;
}

function edgeSection(f: Feature, update: (mutate: (f: Feature) => void) => void): HTMLElement[] {
  const items: HTMLElement[] = [section("Edges: fillet, chamfer & bevel")];
  const fromMesh = f.kind === "imported" && !!f.params.faceted;
  if (f.kind === "imported" && f.params.faceted) {
    // A mesh has no real edges: say what can be rounded before anyone tries.
    const corners = cornerEdgeCount(f);
    const found =
      corners === null ? "" : corners === 0 ? " <b>No sharp corners:</b> this shape is smooth all over, so there's nothing to round." : ` <b>${corners} corner edge${corners === 1 ? "" : "s"} found.</b>`;
    items.push(
      hint(
        `Made from a mesh: only sharp corners (where its facets meet at more than 30°) can be rounded, and curved edges made of many small facets may fail.${found} For full fillet support, import the part as a STEP file.`,
      ),
    );
  }
  const setOp = (opId: string, mutate: (op: EdgeOp) => void) =>
    update((t) => {
      const op = t.edgeOps.find((o) => o.id === opId);
      if (op) mutate(op);
    });

  const OP_NAME: Record<EdgeOp["type"], string> = { fillet: "Fillet", chamfer: "Chamfer", bevel: "Bevel" };
  f.edgeOps.forEach((op, n) => {
    const box = document.createElement("div");
    box.className = `edge-op${edgePick?.opId === op.id ? " picking" : ""}`;

    // Its name and a remove button, then the type on its own full-width row (so all three fit).
    const head = document.createElement("div");
    head.className = "edge-op-head";
    const name = document.createElement("strong");
    name.textContent = `${OP_NAME[op.type]} ${n + 1}`;
    const remove = button("✕", () => {
      if (edgePick?.opId === op.id) stopEdgePick();
      update((t) => (t.edgeOps = t.edgeOps.filter((o) => o.id !== op.id)));
    }, "icon danger");
    remove.title = "Remove";
    head.append(name, remove);
    const type = segmented(
      [
        { value: "fillet", label: "Fillet", title: "Round the edges" },
        { value: "chamfer", label: "Chamfer", title: "Cut the edges flat at 45°" },
        { value: "bevel", label: "Bevel", title: "Cut the edges flat at any angle: a distance along the flatter face, and the cut's angle from it" },
      ],
      op.type,
      (v) => setOp(op.id, (o) => (o.type = v)),
    );

    const target = document.createElement("select");
    for (const o of TARGETS) target.add(new Option(o.label, o.value));
    target.value = op.target;
    target.onchange = () => {
      const value = target.value as EdgeTarget;
      setOp(op.id, (o) => (o.target = value));
      if (value === "picked" && !op.points.length) startEdgePick(f.id, op.id);
    };

    box.append(head, type, lengthField(op.type === "fillet" ? "Radius" : "Distance", op.size, (v) => setOp(op.id, (o) => (o.size = v)), { min: 0 }));
    if (op.type === "bevel") {
      box.append(
        lengthField("Angle", op.angle ?? 45, (v) => setOp(op.id, (o) => (o.angle = Math.min(89, Math.max(1, v)))), { unit: "°", plain: true }),
        checkToggle("Measure from the other face", !!op.flip, (on) => setOp(op.id, (o) => (o.flip = on || undefined))),
      );
    }
    box.append(labeled("Edges", target));
    if (f.kind !== "group" && (op.afterHoles || holesReaching(activeFeatures(doc.features), f).length)) {
      const after = checkToggle("After holes", !!op.afterHoles, (on) => setOp(op.id, (o) => (on ? (o.afterHoles = true) : delete o.afterHoles)));
      after.title = "Cut the holes that reach this object first, so the edges they make can be rounded too";
      box.append(after);
    }

    // Too big for this shape: say what size was used instead, and offer to adopt it.
    const used = edgeAdjustments[op.id];
    if (used !== undefined) {
      const note = document.createElement("div");
      note.className = "safe-note";
      const some = edgeAdjustments[`${op.id}@edges`];
      if (used >= 0 && some) {
        const rest = edgeAdjustments[`${op.id}@rest`];
        const others = rest !== undefined ? `the rest ${formatLength(rest)} mm (the most they can take beside them)` : `the rest the full ${formatLength(op.size)} mm`;
        note.append(used > 0 ? `Too big for ${some} of the edges: they use ${formatLength(used)} mm (the largest that fits there), ${others}.` : `Too big for ${some} of the edges, so they're left sharp; ${others}.`);
      } else if (used > 0) {
        note.append(`Too big for these edges, so ${formatLength(used)} mm (the largest safe size) is used.`);
        note.append(button(`Set to ${formatLength(used)}`, () => setOp(op.id, (o) => (o.size = used)), "link"));
        // Ways to keep it bigger: a chamfer can become a flatter bevel; a fillet can round fewer edges.
        if (op.type === "chamfer") {
          const toBevel = button(`Make it a bevel (keeps ${formatLength(op.size)} mm)`, () => setOp(op.id, (o) => ((o.type = "bevel"), (o.angle = 45))), "link");
          toBevel.title = "A bevel can be flatter than 45°, so it fits at the full distance";
          note.append(" ", toBevel);
        } else if (op.type === "fillet" && op.target === "all") {
          const topOnly = button("Round the top edges only", () => setOp(op.id, (o) => (o.target = "top")), "link");
          topOnly.title = "On a thin part the top and bottom roundings meet in the middle; rounding only the top allows a radius up to about the thickness";
          note.append(" ", topOnly);
        }
      } else if (fromMesh) {
        note.append(
          "These edges can't be rounded at any size, so this step is skipped. On a solid made from a mesh, curved edges made of many small facets usually can't be: try a smaller size, fewer edges (Picked edges), or import the part as a STEP file.",
        );
      } else {
        note.append("These edges can't be rounded at any size, so this step is skipped.");
      }
      box.append(note);
    }
    const flatter = edgeAdjustments[`${op.id}@angle`];
    if (flatter !== undefined) {
      const note = document.createElement("div");
      note.className = "safe-note";
      note.append(`Too steep to fit at ${formatLength(op.size)} mm, so the cut is made flatter: ${formatLength(flatter)}°.`);
      note.append(button(`Set to ${formatLength(flatter)}°`, () => setOp(op.id, (o) => (o.angle = flatter)), "link"));
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
  // With holes cutting into it, a new finish goes after them, so the hole edges can be picked and rounded too.
  // (Only holes that touch it: rounding after holes cuts them first, which a far-off hole would only slow down.)
  const mine = viewport.modelBounds(new Set([f.id]));
  const afterHoles =
    f.kind !== "group" &&
    f.mode === "solid" &&
    holesReaching(activeFeatures(doc.features), f).some((h) => {
      const box = viewport.modelBounds(new Set([h.id]));
      return !mine || !box || box.intersectsBox(mine);
    });
  const newOp = (type: EdgeOp["type"]) =>
    update((t) => t.edgeOps.push({ id: newId(), type, size: 1, target: "all", points: [], ...(type === "bevel" ? { angle: 30 } : {}), ...(afterHoles ? { afterHoles: true } : {}) }));
  add.className = "actions edge-add";
  add.append(button("+ Fillet", () => newOp("fillet")), button("+ Chamfer", () => newOp("chamfer")), button("+ Bevel", () => newOp("bevel")));
  items.push(add);
  if (f.kind === "group") items.push(hint("Rounding a group merges its shapes first, so you can round edges where they meet, or the rim of a hole."));
  return items;
}

function parentSelect(f: Feature) {
  const sel = document.createElement("select");
  sel.className = "wide";
  const blocked = subtreeIds(doc.features, f.id);
  sel.add(new Option("None (top level)", ""));
  // As the tree in the list: indented under their parents, so which is which is clear (names can repeat).
  const walk = (parentId: string | null, depth: number) => {
    for (const p of childrenOf(doc.features, parentId)) {
      const o = new Option(`${"\u00a0\u00a0\u00a0".repeat(depth)}${depth ? "└ " : ""}${kindIcon(p)} ${p.name}`, p.id);
      // Not into itself or anything inside it.
      if (blocked.has(p.id)) o.disabled = true;
      sel.add(o);
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  sel.value = f.parentId ?? "";
  sel.onchange = () => moveTo(f.id, sel.value || null);
  return sel;
}

/** The other sketches in the model (a loft can blend into one). */
const otherSketches = (s: SketchFeature) => doc.features.filter((x): x is SketchFeature => x.kind === "sketch" && x.id !== s.id);

function sweepFields(s: SketchFeature, set: (mutate: (p: SketchFeature["params"]) => void) => void): HTMLElement[] {
  const strokes = s.params.entities.filter((e) => e.type === "stroke" && e.mode === "add").length;
  return [
    labeled(
      "Profile",
      segmented(
        [
          { value: "round" as const, label: "Round", title: "Round tubes" },
          { value: "square" as const, label: "Square", title: "Square tubes" },
        ],
        s.params.sweepProfile ?? "round",
        (v) => set((p) => (p.sweepProfile = v)),
      ),
    ),
    hint(
      strokes
        ? `Each brush stroke (${strokes}) becomes a tube as thick as the stroke, centred on the sketch's plane. Change a stroke's width in the sketch to change the tube's.`
        : "Draw the path with the Brush tool (B) in this sketch: each stroke becomes a tube as thick as the stroke.",
    ),
  ];
}

function loftFields(s: SketchFeature, set: (mutate: (p: SketchFeature["params"]) => void) => void): HTMLElement[] {
  const others = otherSketches(s);
  if (!others.length) return [hint("Add a second sketch for this one to blend into: place it above (or anywhere off this sketch's plane) and draw a closed shape in it. It can stay flat.")];
  const to = document.createElement("select");
  for (const o of others) to.add(new Option(o.name, o.id));
  to.value = s.params.loftTo ?? "";
  to.onchange = () => set((p) => (p.loftTo = to.value));
  return [
    labeled("Loft to", to),
    hint("This sketch's first closed shape blends smoothly into the first one in the sketch picked; move or tilt that sketch to change where (and how) it ends. The other sketch can stay flat."),
  ];
}

/** A chisel groove's width, depth (below the face) and tip. */
function grooveFields(s: SketchFeature, set: (mutate: (p: SketchFeature["params"]) => void) => void): HTMLElement[] {
  const lip = Math.max(0, -s.params.offset);
  const stroke = s.params.entities.find((e) => e.type === "stroke");
  return [
    lengthField("Width", stroke?.type === "stroke" ? stroke.width : 0, (v) => set((p) => p.entities.forEach((e) => e.type === "stroke" && (e.width = Math.max(0.1, v))))),
    lengthField("Depth", Math.round((s.params.depth - lip) * 1e4) / 1e4, (v) => set((p) => (p.depth = Math.max(0.05, v) + lip))),
    labeled(
      "Tip",
      segmented(
        [
          { value: "flat" as const, label: "Flat", title: "Square-bottomed groove" },
          { value: "v" as const, label: "V", title: "V-shaped groove" },
          { value: "round" as const, label: "Round", title: "Round-bottomed groove" },
        ],
        s.params.groove!.tip,
        (tip) => set((p) => (p.groove = { tip })),
      ),
    ),
  ];
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
    const sweep = button("〰 Sweep", () => set((p) => (p.operation = "sweep")));
    sweep.title = "Turn the sketch's brush strokes into tubes (pipes, handles, rails)";
    const loft = button("◭ Loft", () => set((p) => ((p.operation = "loft"), (p.loftTo ??= otherSketches(s)[0]?.id))));
    loft.title = "Blend the sketch's shape into another sketch's shape (square to round, wide to narrow…)";
    row.append(extrude, revolve, sweep, loft);
    return [hint("This sketch is flat: it's only a drawing for now. Make it 3D:"), row, ...placement];
  }
  const op = document.createElement("select");
  for (const [value, label] of [
    ["flat", "Flat (just a drawing)"],
    ["extrude", "Extrude"],
    ["revolve", "Revolve (spin round V)"],
    ["sweep", "Sweep (strokes become tubes)"],
    ["loft", "Loft (blend into another sketch)"],
  ] as const)
    op.add(new Option(label, value));
  op.value = s.params.operation;
  op.onchange = () => set((p) => ((p.operation = op.value as SketchOperation), op.value === "loft" && (p.loftTo ??= otherSketches(s)[0]?.id)));
  return [
    labeled("Make 3D by", op),
    ...(s.params.operation === "sweep" ? sweepFields(s, set) : []),
    ...(s.params.operation === "loft" ? loftFields(s, set) : []),
    ...(s.params.groove && s.params.operation === "extrude" ? grooveFields(s, set) : []),
    ...(s.params.operation === "extrude" && !s.params.groove
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
    const setSides = (v: number) => ((ed.ngonSides = clampSides(v)), renderProperties());
    items.push(lengthField("Sides", ed.ngonSides, setSides, { min: 3, plain: true }), sidePresets(ed.ngonSides, setSides));
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
    if (e.trims?.length) {
      // Trimmed but still itself: its sizes above still work; the trim follows.
      const n = e.trims.length;
      items.push(
        hint(`Trimmed ${n === 1 ? "once" : `${n} times`}: it keeps its own handles and sizes, and the trimmed edge stays where it was.`),
        button(n === 1 ? "Undo the trim" : "Undo the last trim", () => updateEntity(e.id, (t) => (t.trims = t.trims?.slice(0, -1).length ? t.trims.slice(0, -1) : undefined))),
      );
    }
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
    const remove = button("✕", () => setConstraints((cs) => cs.splice(cs.findIndex((x) => x.id === c.id), 1)), "icon danger");
    remove.title = "Remove this constraint";
    row.append(remove);
    items.push(row);
  }
  return items;
}

const clampSides = (v: number) => Math.max(3, Math.min(64, Math.round(v)));

/** One-click side counts for N-gons (the Sides field takes any count up to 64). */
function sidePresets(current: number, onPick: (sides: number) => void) {
  const options = [3, 4, 5, 6, 8, 10, 12].map((n) => ({ value: String(n), label: String(n), title: `${n} sides` }));
  return segmented(options, String(current), (v) => onPick(Number(v)));
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
      return [
        num("Centre U", "x"),
        num("Centre V", "y"),
        num("Radius", "radius", { min: 0 }),
        lengthField("Sides", e.sides, (v) => updateEntity(e.id, (t) => t.type === "ngon" && (t.sides = clampSides(v))), { min: 3, plain: true }),
        sidePresets(e.sides, (v) => updateEntity(e.id, (t) => t.type === "ngon" && (t.sides = v))),
        num("Angle", "angle", deg),
      ];
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
  const list = document.createElement("div");
  list.className = "point-list";
  const head = document.createElement("div");
  head.className = "point-row head";
  head.innerHTML = e.type === "polygon" ? "<span></span><span>U (mm)</span><span>V (mm)</span><span>Bend (mm)</span><span></span>" : "<span></span><span>U (mm)</span><span>V (mm)</span><span></span>";
  if (e.type === "spline") head.classList.add("no-bend");
  list.append(head);
  const active = sketchEditor?.activePoint ?? null;
  e.points.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = `point-row${e.type === "spline" ? " no-bend" : ""}${i === active ? " active" : ""}`;
    // Clicking a row shows its point in the view (and clicking a point in the view highlights its row).
    row.addEventListener("pointerdown", () => {
      if (!sketchEditor) return;
      sketchEditor.setActivePoint(i);
      sketchPanelKey = panelKey(sketchEditor); // Already shown here: don't rebuild the panel under the pointer.
      list.querySelectorAll(".point-row.active").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
    });
    const label = document.createElement("span");
    label.textContent = `P${i + 1}`;
    const setPoint = (axis: 0 | 1, v: number) => updateEntity(e.id, (t) => (t.type === "polygon" || t.type === "spline") && (t.points[i][axis] = v));
    row.append(label, lengthInput(p[0], (v) => setPoint(0, v)), lengthInput(p[1], (v) => setPoint(1, v)));
    if (e.type === "polygon") {
      const bend = lengthInput(e.bends[i] ?? 0, (v) => updateEntity(e.id, (t) => t.type === "polygon" && (t.bends[i] = v)));
      bend.title = `Curve the edge from P${i + 1} to P${((i + 1) % e.points.length) + 1} (0 = straight)`;
      row.append(bend);
    }
    const remove = button("✕", () => updateEntity(e.id, (t) => removePoint(t, i)), "icon danger");
    remove.disabled = e.points.length <= 3;
    remove.title = "Delete point";
    row.append(remove);
    list.append(row);
    if (i === active) requestAnimationFrame(() => (list.scrollTop = row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2));
  });
  const rows: HTMLElement[] = [list];
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
  // Each new object stands out from the last ones (holes are shown red anyway).
  if (kind !== "group" && kind !== "plane" && kind !== "screw") f.color = nextColour(doc.features);
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
        const probe = [...kernel.snapshot(doc.features), structuredClone(f)];
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

/** Turn the selected object so the face clicked next sits flat on the bed (Z = 0), staying where it is across the bed. */
function layFlat() {
  const f = selected();
  if (!f || editingSketchId || sculptingId) {
    if (!f) setNotice("Select an object first, then click Lay flat.");
    return;
  }
  if (viewport.pickingFace) {
    viewport.stopFacePick();
    $("#lay-flat").classList.remove("on");
    setStatus("");
    return;
  }
  if (f.joint) {
    setNotice(`${f.name} is connected by a${f.joint.type === "orbit" ? "n orbit" : ` ${f.joint.type}`}: remove the connection to lay it flat.`);
    return;
  }
  $("#lay-flat").classList.add("on");
  setStatus(`Click the face of ${f.name} that should sit on the bed. Esc to cancel.`);
  viewport.startFacePick(f.id, (normal) => {
    $("#lay-flat").classList.remove("on");
    setStatus("");
    const world = worldMatrix(doc.features, f.id);
    const box = viewport.modelBounds(new Set([f.id]));
    const centre = box ? box.getCenter(new Vector3()) : new Vector3().setFromMatrixPosition(world);
    // Turn the face to point straight down, about the object's middle.
    const turn = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(normal.x, normal.y, normal.z).normalize(), new Vector3(0, 0, -1)));
    let placed = new Matrix4().makeTranslation(centre.x, centre.y, centre.z).multiply(turn).multiply(new Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z)).multiply(world);
    // Then down (or up) onto the bed.
    const after = viewport.boundsAt(f.id, placed);
    if (after) placed = new Matrix4().makeTranslation(0, 0, -after.min.z).multiply(placed);
    commit((features) => setWorldMatrix(features, f.id, placed));
    setNotice(`${f.name} now lies on that face.`);
  });
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
  deleteIds(selectedIds);
}

/** Delete objects and everything inside them. */
function deleteIds(targets: string[]) {
  const ids = new Set(targets.flatMap((id) => [...subtreeIds(doc.features, id)]));
  if (editingSketchId && ids.has(editingSketchId)) stopSketchEdit();
  if (sculptingId && ids.has(sculptingId)) stopSculpt();
  if (edgePick && ids.has(edgePick.featureId)) stopEdgePick();
  selectedIds = selectedIds.filter((id) => !ids.has(id));
  selectedId = selectedId && !ids.has(selectedId) ? selectedId : (selectedIds[0] ?? null);
  commit((features) => {
    const before = features.length;
    const keep = features.filter((f) => !ids.has(f.id));
    // Steps removed before the history marker move it back.
    if (historyMarker !== null) historyMarker -= features.slice(0, historyMarker).filter((f) => ids.has(f.id)).length;
    features.splice(0, before, ...keep);
  });
}

/** The model as an STL or STEP file. */
/**
 * What an export holds: the selected objects, each with the holes that reach
 * it still cut (lifted out of their groups, keeping where they are), or the
 * whole model when nothing is selected. `label` names the selection.
 */
// ---- Parameters ------------------------------------------------------------------------
//
// Named values (`wall = 2`) that any length field can use (`wall*2`). A field
// typed with a parameter keeps its expression (by its label in the object's
// panel), and changing a parameter re-applies them all as one undo step.

/** The parameters' values by lower-case name (each can use the ones before it). */
function variableValues(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of doc.variables ?? []) {
    if (!validName(v.name)) continue;
    const n = parseLength(v.value, out);
    if (n !== null) out[v.name.toLowerCase()] = n;
  }
  return out;
}

/** While an object's panel is being built: its id, and how many fields of each label so far. */
let fieldContext: { id: string; counts: Map<string, number> } | null = null;
/** An object's panel built only to re-apply its fields (no estimates or other work). */
let offscreenPanel = false;
/** Fields' setters, by object id and field key, from the last time their panel was built. */
const fieldAppliers = new Map<string, (mm: number) => void>();
/** The expression a field change goes with (kept on the object by the commit it makes). */
let pendingExpr: { id: string; key: string; expr: string | null } | null = null;
/** Changes made as one (no undo step or update of their own). */
let batching = false;

function keepPendingExpr() {
  const p = pendingExpr;
  if (!p) return;
  const f = doc.features.find((x) => x.id === p.id);
  if (!f) return;
  const exprs = { ...(f.exprs ?? {}) };
  if (p.expr) exprs[p.key] = p.expr;
  else delete exprs[p.key];
  if (Object.keys(exprs).length) f.exprs = exprs;
  else delete f.exprs;
}

/** Change the parameters, and every field that uses them, as one step. */
function changeVariables(mutate: (vars: Variable[]) => void) {
  commit(() => {
    doc.variables = [...(doc.variables ?? [])];
    mutate(doc.variables);
    if (!doc.variables.length) delete doc.variables;
    reapplyVariables();
  });
}

/** Set every field that uses parameters from them again (inside a commit). */
function reapplyVariables() {
  const vars = variableValues();
  const was = batching;
  batching = true;
  try {
    for (const f of doc.features.filter((x) => x.exprs)) {
      objectItems(f, true); // Builds its panel's fields, so their setters are known.
      for (const [key, expr] of Object.entries(f.exprs ?? {})) {
        const v = parseLength(expr, vars);
        const set = fieldAppliers.get(`${f.id}|${key}`);
        if (v !== null && set) set(v);
      }
    }
  } finally {
    batching = was;
  }
}

function renderVariables() {
  const box = $("#variables");
  const vars = doc.variables ?? [];
  const values = variableValues();
  const rows = vars.map((v, i) => {
    const row = document.createElement("div");
    row.className = "variable";
    const name = document.createElement("input");
    name.value = v.name;
    name.spellcheck = false;
    name.classList.toggle("invalid", !validName(v.name));
    name.title = "Its name: letters, digits and _ (not a unit like mm or in)";
    const value = document.createElement("input");
    value.value = v.value;
    value.spellcheck = false;
    const n = values[v.name.toLowerCase()];
    value.classList.toggle("invalid", n === undefined);
    value.title = n === undefined ? "Not a number: check the maths, and that any names it uses are above it" : `= ${formatLength(n)} mm`;
    for (const input of [name, value]) input.onkeydown = (e) => (e.key === "Enter" && input.blur(), e.stopPropagation());
    name.onchange = () => {
      const next = name.value.trim();
      if (!next || next === v.name) return;
      // Fields using the old name use the new one.
      const re = new RegExp(`\\b${v.name}\\b`, "gi");
      changeVariables((list) => {
        list[i] = { ...list[i], name: next };
        for (let k = i + 1; k < list.length; k++) list[k] = { ...list[k], value: list[k].value.replace(re, next) };
        for (const f of doc.features) if (f.exprs) f.exprs = Object.fromEntries(Object.entries(f.exprs).map(([key, e]) => [key, e.replace(re, next)]));
      });
    };
    value.onchange = () => changeVariables((list) => (list[i] = { ...list[i], value: value.value.trim() }));
    const remove = button("✕", () => changeVariables((list) => list.splice(i, 1)), "icon danger");
    remove.title = `Remove ${v.name} (fields using it keep their value)`;
    const eq = document.createElement("span");
    eq.textContent = "=";
    row.append(name, eq, value, remove);
    return row;
  });
  const add = button("+ Parameter", () => {
    let k = vars.length + 1;
    while (vars.some((v) => v.name === `p${k}`)) k++;
    changeVariables((list) => list.push({ name: `p${k}`, value: "10" }));
  });
  add.title = "A named value (wall = 2) that any size field can use: type wall*2 and it follows the parameter";
  box.replaceChildren(...rows, add);
}

// ---- Print estimate -------------------------------------------------------------------

/** Filament densities (g/cm³). */
const MATERIALS: Record<string, number> = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, Nylon: 1.14, "PLA-CF": 1.3, Resin: 1.15 };
const PRINT_KEY = "gizmocad.print";
const printSettings: { material: string; infill: number; price: number } = (() => {
  try {
    return { material: "PLA", infill: 15, price: 25, ...(JSON.parse(localStorage.getItem(PRINT_KEY) ?? "{}") as object) };
  } catch {
    return { material: "PLA", infill: 15, price: 25 };
  }
})();

/**
 * Roughly what a print takes: the walls, top and bottom (two 0.4 mm lines,
 * about 0.8 mm all over its surface) are solid, the inside is the infill.
 */
function printEstimate(stats: ModelStats) {
  const shell = Math.min(stats.volume, stats.area * 0.8);
  const printed = shell + (stats.volume - shell) * (printSettings.infill / 100); // mm³
  const grams = (printed / 1000) * (MATERIALS[printSettings.material] ?? 1.24);
  const metres = printed / (Math.PI * 0.875 ** 2) / 1000; // 1.75 mm filament
  return { grams, metres, cost: (grams / 1000) * printSettings.price };
}

const describeEstimate = (stats: ModelStats) => {
  const { grams, metres, cost } = printEstimate(stats);
  return `${grams < 10 ? grams.toFixed(1) : Math.round(grams)} g of ${printSettings.material} at ${printSettings.infill}% infill, ${metres.toFixed(metres < 10 ? 1 : 0)} m of 1.75 mm filament, about ${cost.toFixed(2)} at ${printSettings.price}/kg`;
};

/** The last estimate worked out, and what for (the model's revision and the selection). */
let estimate: { key: string; stats: ModelStats | null } | null = null;
let estimating: string | null = null;

function estimateSection(): HTMLElement[] {
  if (offscreenPanel) return [];
  const key = `${modelRevision}|${topSelected().join(",")}`;
  if (estimate?.key !== key && estimating !== key) {
    estimating = key;
    kernel
      .stats(exportFeatures().features)
      .then((stats) => {
        estimate = { key, stats };
        if (`${modelRevision}|${topSelected().join(",")}` === key) renderProperties();
      })
      .catch(() => (estimate = { key, stats: null }))
      .finally(() => estimating === key && (estimating = null));
  }
  const save = () => {
    store(PRINT_KEY, JSON.stringify(printSettings));
    renderProperties();
  };
  const material = document.createElement("select");
  for (const name of Object.keys(MATERIALS)) material.add(new Option(name, name));
  material.value = printSettings.material;
  material.onchange = () => ((printSettings.material = material.value), save());
  const out = document.createElement("div");
  out.className = "estimate";
  const s = estimate?.key === key ? estimate.stats : null;
  if (!s) out.textContent = estimate?.key === key ? "Nothing solid to print." : "Working it out…";
  else {
    const { grams, metres, cost } = printEstimate(s);
    const solid = (s.volume / 1000) * (MATERIALS[printSettings.material] ?? 1.24);
    out.innerHTML = `<b>${grams < 10 ? grams.toFixed(1) : Math.round(grams)} g</b> · ${metres.toFixed(metres < 10 ? 1 : 0)} m of filament · about <b>${cost.toFixed(2)}</b><br><span class="muted">${(s.volume / 1000).toFixed(2)} cm³ (${solid.toFixed(1)} g if solid) · ${s.size.map((v) => v.toFixed(1)).join(" × ")} mm</span>`;
  }
  return [
    section("Print estimate"),
    labeled("Material", material),
    lengthField("Infill", printSettings.infill, (v) => ((printSettings.infill = Math.min(100, Math.max(0, v))), save()), { unit: "%", plain: true }),
    lengthField("Price per kg", printSettings.price, (v) => ((printSettings.price = Math.max(0, v)), save()), { unit: "", plain: true }),
    out,
    hint("A rough guide: walls, top and bottom about 0.8 mm thick and solid, the inside at the infill. Your slicer gives the exact figure."),
  ];
}

/** What an export holds: the selected objects' names, or null for the whole model. */
function exportLabel(): string | null {
  const all = new Set(activeFeatures(doc.features).map((f) => f.id));
  const names = topSelected()
    .filter((id) => all.has(id))
    .map((id) => findFeature(id)!.name);
  return !names.length ? null : names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} selected objects`;
}

function exportFeatures(): { features: Feature[]; label: string | null } {
  const all = activeFeatures(doc.features);
  const targets = topSelected().filter((id) => all.some((f) => f.id === id));
  if (!targets.length) return { features: all, label: null };
  // Copies to place and change; shallow is enough (only top-level fields are replaced), and imported geometry can be megabytes.
  const features = all.map((f) => ({ ...f }) as Feature);
  const inTargets = (id: string) => targets.some((t) => subtreeIds(features, t).has(id));
  const holes = new Set<string>();
  for (const id of targets) {
    const f = features.find((x) => x.id === id)!;
    for (const h of holesReaching(features, f)) if (!ignoresHole(features, f, h.id) && !inTargets(h.id)) holes.add(h.id);
  }
  const keep = new Set<string>();
  for (const id of [...targets, ...holes]) {
    reparent(features, id, null);
    for (const x of subtreeIds(features, id)) keep.add(x);
  }
  const out = features.filter((f) => keep.has(f.id));
  // A selected hole exports as its shape.
  for (const f of out) if (targets.includes(f.id) && f.mode === "hole") f.mode = "solid";
  return { features: out, label: exportLabel() };
}

/** A file name from an object's name. */
const fileStem = (label: string | null) => (label ? label.replace(/[\\/:*?"<>|]+/g, "").trim() || "gizmocad-model" : "gizmocad-model");

async function modelFile(format: "stl" | "step", features: Feature[] = doc.features): Promise<Blob> {
  const sculpts = features.filter((f): f is SculptFeature => f.kind === "sculpt");
  let blob: Blob | null = null;
  try {
    blob = await kernel.export(features, format);
  } catch (err) {
    // A model made only of sculpts has nothing for the kernel to export.
    if (!(format === "stl" && sculpts.length && /Nothing to export/.test((err as Error).message))) throw err;
  }
  // Sculpts are meshes: they go into STL (with any holes cut through them), but STEP only holds exact solids.
  if (format === "stl" && sculpts.length) {
    const cut = await kernel.cutMeshes(activeFeatures(features));
    blob = await appendToStl(blob, sculpts.map((f) => cut[f.id] ?? sculptTriangles(f.params, worldMatrix(features, f.id))));
  }
  return blob!;
}

async function exportModel(format: "stl" | "step") {
  const { features, label } = exportFeatures();
  setStatus(`Exporting ${label ? `${label} as ` : ""}${format.toUpperCase()}…`);
  const sculpts = features.filter((f): f is SculptFeature => f.kind === "sculpt");
  try {
    const blob = await modelFile(format, features);
    const warning = kernel.exportWarning;
    await saveFile(blob, `${fileStem(label)}.${format}`, format.toUpperCase(), format);
    if (warning) setStatus(`Exported, but: ${warning}`, true);
    else if (format === "step" && sculpts.length) setStatus("Sculpted objects aren't in the STEP file (STEP only holds exact solids); export STL to include them.");
    else setStatus(label ? `Exported ${label} only (nothing selected exports everything).` : "");
  } catch (err) {
    setStatus(`Export failed: ${(err as Error).message}`, true);
  }
}

async function saveDocument() {
  const blob = new Blob([JSON.stringify(savedDocument(), null, 2)], { type: "application/json" });
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
// Files dropped anywhere on the window are imported (instead of the browser opening them).
const draggingFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
window.addEventListener("dragover", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
});
window.addEventListener("drop", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  const files = [...e.dataTransfer!.files];
  void Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))).then(importFiles);
});
$("#undo").onclick = () => undoRedo(false);
$("#redo").onclick = () => undoRedo(true);
$("#snap").onchange = (e) => {
  viewport.setSnap(parseFloat((e.target as HTMLSelectElement).value));
};
viewport.setSnap(parseFloat(($("#snap") as HTMLSelectElement).value)); // In case the browser brought back an earlier choice.
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
  if (open) {
    // The exports say whether they'll hold the selection or the whole model.
    const label = exportLabel();
    appMenu.querySelectorAll<HTMLElement>("[id^=export-] .note").forEach((note) => {
      note.dataset.usual ??= note.textContent ?? "";
      note.textContent = label ? `only ${label}` : note.dataset.usual;
    });
  }
  appMenu.hidden = !open;
  appMenuButton.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("menu-open", open);
}
appMenuButton.onclick = () => setAppMenu(appMenu.hidden !== false);
// Picking an item closes it (the theme item stays open, to see the change).
appMenu.addEventListener("click", (e) => (e.target as HTMLElement).closest("button") && (e.target as HTMLElement).closest("#theme, #debug-toggle") === null && setAppMenu(false));
window.addEventListener("pointerdown", (e) => !appMenu.hidden && !(e.target as HTMLElement).closest(".app-menu-wrap") && setAppMenu(false), true);
window.addEventListener("keydown", (e) => e.key === "Escape" && !appMenu.hidden && (setAppMenu(false), e.stopImmediatePropagation()), true);

// ---- Debug info ---------------------------------------------------------------------
//
// Each update's steps (every object's shape, fillet and hole cut), how long
// they took, and errors in full: to see what's slow or failing, and to copy
// into a bug report.

let debugOn = (() => {
  try {
    return localStorage.getItem("gizmocad.debug") === "on";
  } catch {
    return false;
  }
})();
const debugPanel = $("#debug-panel");

function setDebug(on: boolean) {
  debugOn = on;
  try {
    localStorage.setItem("gizmocad.debug", on ? "on" : "off");
  } catch {
    // Not remembered; it still works for now.
  }
  $("#debug-state").textContent = on ? "on" : "off";
  debugPanel.hidden = !on;
  if (on) {
    debugPanel.textContent = "Debug info: make a change (or it shows after the next update).";
    void rebuild();
  }
}
$("#debug-toggle").onclick = () => setDebug(!debugOn);
setDebug(debugOn);

function showDebug(log: BuildStep[], errors: Record<string, string>, features: Feature[], totalMs: number, combined: boolean) {
  const kernelMs = log.reduce((sum, s) => sum + (s.depth ? 0 : s.ms), 0);
  const name = (id: string) => features.find((f) => f.id === id)?.name ?? id;
  const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
  const lines = [
    `GizmoCAD debug info, ${new Date().toLocaleString()}`,
    `Update: ${ms(totalMs)} in all${combined ? " (Show result)" : ""}; ${features.length} objects`,
    ...Object.entries(errors).map(([id, e]) => `ERROR ${name(id)}: ${e}`),
    "Steps, in order:",
    ...log.map((s) => `  ${ms(s.ms).padStart(8)}  ${"  ".repeat(s.depth)}${s.step}${s.error ? `  ✗ ${s.error}` : ""}`),
    "Objects:",
    ...features.map((f) => {
      const extra = f.kind === "imported" ? (f.params.faceted ? " (made from a mesh)" : " (exact)") : "";
      const finishes = [f.edgeOps.length && `${f.edgeOps.length} edge finish(es)`, f.shell && "hollow", f.tilt && "tilt", f.clips?.length && "split", f.texture && "texture"].filter(Boolean).join(", ");
      return `  ${f.name}: ${f.kind}${extra}, ${f.mode}${f.parentId ? `, inside ${name(f.parentId)}` : ""}${finishes ? `, ${finishes}` : ""}`;
    }),
  ];
  const slow = [...log].sort((a, b) => b.ms - a.ms).filter((s) => s.ms >= 50 || s.error).slice(0, 12);
  const head = document.createElement("div");
  head.className = "debug-head";
  const title = document.createElement("b");
  title.textContent = `Last update: ${ms(totalMs)}`;
  const copy = button("Copy details", () => {
    void navigator.clipboard.writeText(lines.join("\n")).then(
      () => setNotice("Debug details copied: paste them into your message."),
      () => setStatus("Couldn't copy (the browser blocked it).", true),
    );
  }, "link");
  const close = button("✕", () => setDebug(false), "link");
  close.title = "Turn Debug info off";
  head.append(title, copy, close);
  const errorRows = Object.entries(errors).map(([id, e]) => {
    const row = document.createElement("div");
    row.className = "debug-error";
    row.textContent = `${name(id)}: ${e}`;
    return row;
  });
  const steps = document.createElement("ol");
  for (const s of slow) {
    const li = document.createElement("li");
    li.className = s.error ? "debug-error" : "";
    li.textContent = `${ms(s.ms)}  ${s.step}${s.error ? ` ✗ ${s.error}` : ""}`;
    steps.append(li);
  }
  const note = document.createElement("div");
  note.className = "debug-note";
  note.textContent = slow.length
    ? `Slowest steps (geometry work ${ms(kernelMs)}; the rest is drawing and the app).`
    : `Nothing took long (geometry work ${ms(kernelMs)}; the rest is drawing and the app).`;
  debugPanel.replaceChildren(head, ...errorRows, note, steps);
}

$("#save").onclick = () => void saveDocument();
$("#open").onclick = () => void openDocument();
$("#export-stl").onclick = () => void exportModel("stl");
$("#print-estimate").onclick = async () => {
  const { features, label } = exportFeatures();
  setNotice("Working out the print estimate…");
  try {
    const stats = await kernel.stats(features);
    setNotice(stats ? `${label ?? "The whole model"}: ${describeEstimate(stats)} (${(stats.volume / 1000).toFixed(2)} cm³).` : "Nothing solid to print.");
  } catch (err) {
    setNotice(`The print estimate failed: ${(err as Error).message}`);
  }
};
$("#export-step").onclick = () => void exportModel("step");

// ---- AI assistant (MCP) ------------------------------------------------------------

/** Carries out an AI assistant's tool calls (via the local MCP server) as normal, undoable edits. */
const mcp = new McpBridge(
  {
    features: () => doc.features,
    commit,
    insert: insertFeatures,
    settle,
    errors: () => buildErrors,
    adjusted: () => edgeAdjustments,
    bounds(ids) {
      const box = ids.length ? viewport.modelBounds(new Set(ids), true) : null;
      return box && { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
    },
    select(ids) {
      selectedIds = ids;
      selectedId = ids[0] ?? null;
      renderPanels();
      viewport.select(selectedId, selectedIds);
    },
    deleteIds,
    group(ids) {
      // Only the outermost: anything inside another listed object goes along with it.
      const set = new Set(ids);
      const tops = ids.filter((id) => {
        for (let p = findFeature(id)?.parentId ?? null; p; p = findFeature(p)?.parentId ?? null) if (set.has(p)) return false;
        return true;
      });
      return tops.length ? groupIds(tops) : null;
    },
    undo() {
      if (!undoStack.length) return false;
      restore(undoStack, redoStack);
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      restore(redoStack, undoStack);
      return true;
    },
    load(next) {
      stopSketchEdit();
      stopSculpt();
      stopEdgePick();
      undoStack.push(JSON.stringify(doc));
      redoStack.length = 0;
      doc = next;
      selectedId = null;
      selectedIds = [];
      historyMarker = null;
      refresh();
    },
    document: () => savedDocument(),
    importFiles,
    export: (format) => (format === "3mf" ? file3mf() : modelFile(format)),
    async screenshot(opts) {
      const was = showCombined;
      if (opts.showResult !== was) {
        showCombined = opts.showResult;
        void rebuild();
        await settle();
      }
      try {
        return viewport.snapshot(opts);
      } finally {
        if (showCombined !== was) {
          showCombined = was;
          void rebuild();
        }
      }
    },
    notify: setNotice,
  },
  (state) => showMcpState(state),
);

const mcpDialog = $("#mcp-dialog") as HTMLDialogElement;
const mcpEnabled = $("#mcp-enabled") as HTMLInputElement;
const mcpPort = $("#mcp-port") as HTMLInputElement;
const MCP_KEYS = { enabled: "gizmocad.mcp.enabled", port: "gizmocad.mcp.port" };
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered (private window): it's just a convenience.
  }
};

const MCP_STATE_TEXT: Record<BridgeState, string> = {
  off: "Off: no AI assistant can reach this model.",
  connecting:
    "Waiting for the MCP server… It starts when your AI assistant does. (If the browser asks to allow access to devices on your local network, allow it.)",
  connected: "Connected ✓ The assistant can see and change this model.",
};
function showMcpState(state: BridgeState) {
  $("#mcp-state").textContent = MCP_STATE_TEXT[state];
  $("#mcp-state").dataset.state = state;
  $("#mcp-menu-state").textContent = state === "connected" ? "connected" : state === "connecting" ? "waiting" : "off";
  $("#mcp-badge").hidden = state !== "connected";
}

function mcpPortValue() {
  const n = Math.round(Number(mcpPort.value));
  return n > 0 && n < 65536 ? n : DEFAULT_MCP_PORT;
}

function updateMcpSnippets() {
  const port = mcpPortValue();
  const env = port === DEFAULT_MCP_PORT ? "" : ` --env GIZMOCAD_MCP_PORT=${port}`;
  $("#mcp-snippet-code").textContent = `claude mcp add gizmocad${env} -- node /full/path/to/gizmocad-mcp.mjs`;
  const envLine = port === DEFAULT_MCP_PORT ? "" : `,\n      "env": { "GIZMOCAD_MCP_PORT": "${port}" }`;
  $("#mcp-snippet-desktop").textContent = `{\n  "mcpServers": {\n    "gizmocad": {\n      "command": "node",\n      "args": ["/full/path/to/gizmocad-mcp.mjs"]${envLine}\n    }\n  }\n}`;
}

mcpPort.value = stored(MCP_KEYS.port) ?? String(DEFAULT_MCP_PORT);
mcpEnabled.checked = stored(MCP_KEYS.enabled) === "1";
updateMcpSnippets();
showMcpState("off");
mcp.setEnabled(mcpEnabled.checked, mcpPortValue());

mcpEnabled.onchange = () => {
  store(MCP_KEYS.enabled, mcpEnabled.checked ? "1" : "0");
  mcp.setEnabled(mcpEnabled.checked, mcpPortValue());
};
mcpPort.onchange = () => {
  mcpPort.value = String(mcpPortValue());
  store(MCP_KEYS.port, mcpPort.value);
  updateMcpSnippets();
  mcp.setEnabled(mcpEnabled.checked, mcpPortValue());
};
mcpPort.onkeydown = (e) => e.stopPropagation();
const openMcpDialog = () => mcpDialog.showModal();
$("#tips-open").onclick = () => ($("#tips-dialog") as HTMLDialogElement).showModal();
$("#mcp-open").onclick = openMcpDialog;
$("#mcp-badge").onclick = openMcpDialog;
$("#mcp-download").onclick = async () => {
  try {
    const res = await fetch("./mcp/gizmocad-mcp.mjs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await saveFile(await res.blob(), "gizmocad-mcp.mjs", "JavaScript", "mjs");
  } catch (err) {
    setStatus(`Couldn't download the MCP server: ${(err as Error).message}`, true);
  }
};
mcpDialog.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => {
  b.onclick = () => {
    void navigator.clipboard?.writeText($(`#${b.dataset.copy}`).textContent ?? "").then(() => {
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    });
  };
});


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

/** See-through view: off → X-ray → wireframe → off. */
const SEE_THROUGH = ["off", "xray", "wire"] as const;
let seeThrough: (typeof SEE_THROUGH)[number] = "off";
function cycleSeeThrough() {
  seeThrough = SEE_THROUGH[(SEE_THROUGH.indexOf(seeThrough) + 1) % SEE_THROUGH.length];
  viewport.setSeeThrough(seeThrough);
  const b = $("#see-through");
  b.classList.toggle("on", seeThrough !== "off");
  b.textContent = seeThrough === "wire" ? "▦" : "◫";
  setStatus(seeThrough === "xray" ? "X-ray: objects are see-through, with every edge showing. X again for wireframe." : seeThrough === "wire" ? "Wireframe: every object drawn as its triangles. X again turns it off." : "");
}
$("#see-through").onclick = cycleSeeThrough;
let printCheckOn = false;
/** Say what the print check found (after each update while it's on). */
function reportPrintCheck() {
  const r = viewport.printCheckResult;
  if (!printCheckOn || !r) return;
  const cm2 = (mm2: number) => (mm2 / 100).toFixed(mm2 < 1000 ? 2 : 1);
  setNotice(
    !r.overhang && !r.thin
      ? "Print check: no overhangs past 45° and no walls under 0.8 mm."
      : `Print check: ${r.overhang ? `overhangs past 45° (orange, ${cm2(r.overhang)} cm²) need supports or a different orientation (try Lay flat)` : "no overhangs past 45°"}; ${r.thin ? `walls under 0.8 mm (red, ${cm2(r.thin)} cm²) may print badly or not at all` : "no walls under 0.8 mm"}.`,
  );
}
$("#print-check").onclick = () => {
  printCheckOn = !printCheckOn;
  $("#print-check").classList.toggle("on", printCheckOn);
  viewport.setPrintCheck(printCheckOn);
  if (printCheckOn) reportPrintCheck();
  else setNotice("");
};
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
  // Saved a little after editing stops, when the browser is idle, so it never gets in the way.
  const save = () => autosave(JSON.stringify(savedDocument())).catch(() => {});
  autosaveTimer = window.setTimeout(() => ("requestIdleCallback" in window ? requestIdleCallback(save, { timeout: 5000 }) : save()), 2000);
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

/** Everything Import reads. Support files (.mtl, .bin, textures) come along with the model that uses them. */
const IMPORT_TYPES = ["step", "stp", "fcstd", "brep", "brp", "stl", "3mf", "obj", "ply", "off", "glb", "gltf", "svg", "dxf", "gizmocad", "mintcad", "json", "mtl", "bin", "png", "jpg", "jpeg"];
const SUPPORT_FILE = /\.(mtl|bin|png|jpe?g)$/i;
/** Space between files imported together (mm). */
const IMPORT_GAP = 10;
/** More parts than this (e.g. a game model's hundreds of pieces) are merged by colour. */
const MAX_IMPORT_PARTS = 100;

/** One imported file's new objects, centred on the grid. */
interface ImportBatch {
  features: Feature[];
  /** The footprint: min X, max X, min Y, max Y (mm). */
  box: [number, number, number, number];
  /** What came in, e.g. "part.step: 3 solids". */
  note: string;
  /** What can be done with it (said once per kind). */
  tail: string;
  /** Fonts its texts use (from another GizmoCAD model). */
  fonts?: ImportedFont[];
}

async function importFile() {
  const files = await openImportFiles($("#import-input"), IMPORT_TYPES, "3D models, CAD files and drawings");
  if (files.length) await importFiles(files);
}

/** Import files side by side along X, all in one undo step. Returns the new top-level objects and what happened. */
async function importFiles(files: PickedFile[]): Promise<{ ids: string[]; note: string; failed: string[] }> {
  const models = files.filter((f) => !SUPPORT_FILE.test(f.name));
  if (!models.length) {
    const why = "Those files go along with a model: pick them together with the .obj or .gltf that uses them.";
    setStatus(why, true);
    return { ids: [], note: "", failed: [why] };
  }
  const batches: ImportBatch[] = [];
  const failed: string[] = [];
  for (const [i, file] of models.entries()) {
    setStatus(`Importing ${file.name}${models.length > 1 ? ` (${i + 1} of ${models.length})` : ""}…`);
    try {
      batches.push(await importBatch(file, files));
    } catch (err) {
      failed.push(`${file.name}: ${(err as Error).message}`);
    }
  }
  if (batches.length) {
    let right = batches[0].box[1];
    for (const b of batches.slice(1)) {
      const dx = right + IMPORT_GAP - b.box[0];
      for (const f of topLevel(b.features)) f.position.x = round4(f.position.x + dx);
      right = b.box[1] + dx;
    }
    const made = batches.flatMap((b) => b.features);
    stopSketchEdit();
    commit((features) => {
      insertFeatures(features, made);
      doc.fonts = mergeFonts(doc.fonts, batches.flatMap((b) => b.fonts ?? []));
    });
    selectedIds = topLevel(made).map((f) => f.id);
    selectedId = selectedIds[0];
    renderPanels();
    viewport.fitView();
  }
  const note = batches.length ? `Imported ${batches.map((b) => b.note).join("; ")}. ${[...new Set(batches.map((b) => b.tail))].join(" ")}`.trim() : "";
  const problems = failed.length ? `Couldn't import ${failed.join(" · ")}` : "";
  // With something imported, the rebuild shows the notice; with nothing, the error stays up.
  if (note) setNotice(problems ? `${note} ${problems}` : note);
  else setStatus(problems, true);
  return { ids: batches.length ? selectedIds.slice() : [], note, failed };
}

/** The ones not inside another of them. */
const topLevel = (features: Feature[]) => features.filter((f) => !f.parentId || !features.some((g) => g.id === f.parentId));

async function importBatch(file: PickedFile, all: PickedFile[]): Promise<ImportBatch> {
  const ext = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase() ?? "";
  const title = stem(file.name);
  switch (ext) {
    case "step":
    case "stp":
      return solidBatch(title, file.name, await kernel.importSolids([{ name: title, format: "step", data: file.data }]));
    case "brep":
    case "brp":
      return solidBatch(title, file.name, await kernel.importSolids([{ name: title, format: "brep", data: file.data }]));
    case "fcstd": {
      const { sources, skipped } = await parseFcstd(file);
      // Its sketches too, as flat drawings to edit (hidden if they were in FreeCAD), placed with the solids.
      const sketches = (await fcstdSketches(file, newId).catch(() => [])).map((sk): Placed => {
        const f = createFeature("sketch", doc.features) as SketchFeature;
        Object.assign(f, { name: sk.name, position: sk.position, rotation: sk.rotation });
        f.params.entities = sk.entities;
        if (sk.hidden) f.hidden = true;
        return { feature: f, min: sk.min, max: sk.max };
      });
      if (!sources.length && !sketches.length) throw new Error(skipped ? "its shapes are saved in FreeCAD's binary format, which can't be read here. Export it from FreeCAD as STEP instead." : "it has no visible solid objects.");
      const parts = sources.length ? await kernel.importSolids(sources) : [];
      const pieces = [...parts.map((p): Placed => (p.kind === "mesh" ? meshPiece(p, p.name) : solidPiece(p))), ...sketches];
      const solids = parts.length;
      const what = [solids && `${solids} solid${solids === 1 ? "" : "s"}`, sketches.length && `${sketches.length} sketch${sketches.length === 1 ? "" : "es"}`].filter(Boolean).join(" and ");
      const batch = placeBatch(title, pieces, `${file.name}: ${what}${pieces.length > 1 ? " (grouped)" : ""}`, sketches.length ? `${SOLID_TAIL} FreeCAD's sketches come in as flat drawings (hidden if they were hidden there): double-click one to edit it, or extrude it.` : SOLID_TAIL);
      if (skipped) batch.note += ` (${skipped} object${skipped === 1 ? "" : "s"} in FreeCAD's binary format left out)`;
      return batch;
    }
    case "stl": {
      const { vertices, triangles } = parseStl(file.data);
      return meshBatch(title, file.name, [{ name: title, vertices, triangles }]);
    }
    case "3mf":
      return meshBatch(title, file.name, await parse3mf(file.data));
    case "obj":
      return meshBatch(title, file.name, parseObj(file, all));
    case "off":
      return meshBatch(title, file.name, parseOff(file));
    case "ply":
      return meshBatch(title, file.name, await parsePly(file));
    case "glb":
    case "gltf":
      return meshBatch(title, file.name, await parseGltf(file, all));
    case "svg":
      return sketchBatch(title, file.name, svgToEntities(new TextDecoder().decode(file.data), newId), 0);
    case "dxf": {
      const { outlines, open } = parseDxf(file);
      return sketchBatch(title, file.name, outlinesToEntities(outlines, newId), open);
    }
    case "gizmocad":
    case "mintcad":
    case "json":
      return modelBatch(title, file);
    default:
      throw new Error("GizmoCAD can't read this kind of file.");
  }
}

/** A piece placed where it sits in the file (its own origin is the middle of its base), and its extents there. */
type Placed = { feature: Feature; min: number[]; max: number[] };

/**
 * Centre the pieces on the grid together, keeping where they sit relative to
 * each other; several go into a group named after the file.
 */
function placeBatch(title: string, pieces: Placed[], note: string, tail: string): ImportBatch {
  const lo = [0, 1, 2].map((k) => Math.min(...pieces.map((p) => p.min[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...pieces.map((p) => p.max[k])));
  const shift = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]];
  const group = pieces.length > 1 ? createFeature("group", doc.features) : null;
  if (group) group.name = title;
  for (const { feature: f } of pieces) {
    f.position = { x: round4(f.position.x + shift[0]), y: round4(f.position.y + shift[1]), z: round4(f.position.z + shift[2]) };
    if (group) f.parentId = group.id;
  }
  const features = pieces.map((p) => p.feature);
  return { features: group ? [group, ...features] : features, box: [lo[0] + shift[0], hi[0] + shift[0], lo[1] + shift[1], hi[1] + shift[1]], note, tail };
}

/** A mesh part as an object whose own origin is the middle of its base. */
function meshPiece(part: ImportedPart, name: string): Placed {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.vertices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], part.vertices[i + k]);
      max[k] = Math.max(max[k], part.vertices[i + k]);
    }
  const anchor = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
  const local = part.vertices.slice();
  for (let i = 0; i < local.length; i += 3) for (let k = 0; k < 3; k++) local[i + k] -= anchor[k];
  const f = createFeature("sculpt", doc.features) as SculptFeature;
  f.name = name;
  f.params = importedMesh(local, part.triangles);
  f.position = { x: anchor[0], y: anchor[1], z: anchor[2] };
  if (part.color) f.color = part.color;
  return { feature: f, min, max };
}

const MESH_TAIL = "Big meshes and ones with gaps stay meshes: they can be moved, sculpted and exported, and holes cut them. Select one and click Make it a solid to try for fillets, chamfers and the rest.";
const SOLID_TAIL = "Imported solids are exact: they can be holes, take fillets and chamfers, and be split; they resize evenly.";
const FACETED_TAIL = "Closed meshes became solids: they can be holes, take fillets and chamfers (on their corners) and be split.";

/** Closed meshes up to this many triangles come in as solids (fillets on bigger ones would take minutes). */
const SOLID_MESH_LIMIT = 200000;

/** A mesh as solids, one per closed body; null if it can't be one (gaps, or crossing itself). */
async function meshSolids(part: ImportedPart, name: string): Promise<Extract<ImportedSolid, { kind: "solid" }>[] | null> {
  try {
    const solids = await kernel.importSolids([{ name, format: "mesh", vertices: part.vertices, triangles: part.triangles, color: part.color }]);
    return solids.every((s) => s.kind === "solid") && solids.length ? (solids as Extract<ImportedSolid, { kind: "solid" }>[]) : null;
  } catch {
    return null;
  }
}

async function meshBatch(title: string, fileName: string, parts: ImportedPart[]): Promise<ImportBatch> {
  if (parts.length > MAX_IMPORT_PARTS) parts = mergeByColor(parts, title);
  const pieces: Placed[] = [];
  let meshes = 0;
  for (const p of parts) {
    const name = parts.length > 1 ? p.name : title;
    const solids = p.triangles.length / 3 <= SOLID_MESH_LIMIT ? await meshSolids(p, name) : null;
    if (solids) pieces.push(...solids.map(solidPiece));
    else (pieces.push(meshPiece(p, name)), meshes++);
  }
  const tris = parts.reduce((s, p) => s + p.triangles.length / 3, 0);
  const solids = pieces.length - meshes;
  const what = [solids && `${solids} solid${solids === 1 ? "" : "s"}`, meshes && `${meshes} mesh${meshes === 1 ? "" : "es"}`].filter(Boolean).join(" and ");
  return placeBatch(title, pieces, `${fileName}: ${what}${pieces.length > 1 ? " (grouped)" : ""}, ${tris.toLocaleString()} triangles`, meshes ? MESH_TAIL : FACETED_TAIL);
}

/** One part per colour. */
function mergeByColor(parts: ImportedPart[], title: string): ImportedPart[] {
  const byColor = new Map<string, ImportedPart[]>();
  for (const p of parts) byColor.set(p.color ?? "", [...(byColor.get(p.color ?? "") ?? []), p]);
  return [...byColor].map(([color, list], i) => {
    const vertices = new Float32Array(list.reduce((s, p) => s + p.vertices.length, 0));
    const triangles = new Uint32Array(list.reduce((s, p) => s + p.triangles.length, 0));
    let [v, t] = [0, 0];
    for (const p of list) {
      vertices.set(p.vertices, v);
      for (let k = 0; k < p.triangles.length; k++) triangles[t + k] = p.triangles[k] + v / 3;
      v += p.vertices.length;
      t += p.triangles.length;
    }
    return { name: byColor.size > 1 ? `${title} ${i + 1}` : title, color: color || undefined, vertices, triangles };
  });
}

/** Exact solids (and any loose surfaces, as meshes) from STEP, BREP or FreeCAD files. */
function solidBatch(title: string, fileName: string, parts: ImportedSolid[]): ImportBatch {
  if (!parts.length) throw new Error("it has no solids or surfaces in it.");
  const pieces = parts.map((p): Placed => (p.kind === "mesh" ? meshPiece(p, p.name) : solidPiece(p)));
  const solids = parts.filter((p) => p.kind === "solid").length;
  const meshes = parts.length - solids;
  const what = [solids && `${solids} solid${solids === 1 ? "" : "s"}`, meshes && `${meshes} surface mesh${meshes === 1 ? "" : "es"}`].filter(Boolean).join(" and ");
  return placeBatch(title, pieces, `${fileName}: ${what}${parts.length > 1 ? " (grouped)" : ""}`, SOLID_TAIL);
}

const encodeMesh = (w: { vertices: Float32Array; triangles: Uint32Array }) => ({ positions: encodeFloats(w.vertices), indices: encodeIndices(w.triangles) });

/** An imported solid as an object whose own origin is the middle of its base. */
function solidPiece(p: Extract<ImportedSolid, { kind: "solid" }>): Placed {
  const f = createFeature("imported", doc.features) as Extract<Feature, { kind: "imported" }>;
  f.name = p.name;
  f.params = { ref: newId(), brep: p.brep, size: p.size, scale: [1, 1, 1], ...(p.faceted ? { faceted: true } : {}), ...(p.mesh ? { mesh: encodeMesh(p.mesh) } : {}) };
  f.position = { x: p.anchor[0], y: p.anchor[1], z: p.anchor[2] };
  if (p.color) f.color = p.color;
  const [w, d, h] = p.size;
  return { feature: f, min: [p.anchor[0] - w / 2, p.anchor[1] - d / 2, p.anchor[2]], max: [p.anchor[0] + w / 2, p.anchor[1] + d / 2, p.anchor[2] + h] };
}

/** A 2D drawing as a sketch, extruded 3 mm. */
function sketchBatch(title: string, fileName: string, entities: SketchEntity[], open: number): ImportBatch {
  const f = createFeature("sketch", doc.features) as SketchFeature;
  f.name = title;
  f.params.entities = entities;
  f.params.operation = "extrude";
  f.params.depth = 3;
  const boxes = entities.map((e) => sketchBounds(e));
  const box: ImportBatch["box"] = [Math.min(...boxes.map((b) => b[0][0])), Math.max(...boxes.map((b) => b[1][0])), Math.min(...boxes.map((b) => b[0][1])), Math.max(...boxes.map((b) => b[1][1]))];
  const skipped = open ? ` (${open} unclosed line${open === 1 ? "" : "s"} left out)` : "";
  return {
    features: [f],
    box,
    note: `${fileName}: ${entities.length} shape${entities.length === 1 ? "" : "s"} as a sketch${skipped}`,
    tail: "Drawings come in as sketches extruded 3 mm: change it in the panel, or double-click to edit the drawing.",
  };
}

/** Another GizmoCAD model brought into this one (as a group if it has several objects). */
async function modelBatch(title: string, file: PickedFile): Promise<ImportBatch> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(file.data));
  } catch {
    throw new Error("it isn't a GizmoCAD model.");
  }
  if (!isCadDocument(parsed)) throw new Error("it isn't a GizmoCAD model.");
  const incoming = normalizeDocument(parsed).features;
  const fonts = parsed.fonts;
  if (!incoming.length) throw new Error("it's empty.");
  // New ids, so the same model can come in more than once.
  const ids = new Map(incoming.map((f) => [f.id, newId()]));
  for (const f of incoming) {
    f.id = ids.get(f.id)!;
    f.parentId = f.parentId ? (ids.get(f.parentId) ?? null) : null;
    for (const op of f.edgeOps) op.id = newId();
  }
  const features = [...incoming];
  let top = features.filter((f) => !f.parentId);
  if (top.length > 1) {
    const group = createFeature("group", doc.features);
    group.name = title;
    for (const f of top) f.parentId = group.id;
    features.unshift(group);
    top = [group];
  }
  // Its footprint, from the finished shapes.
  const box = new Box3();
  const v = new Vector3();
  const live = features.filter((f) => !f.suppressed);
  for (const m of await kernel.parts(live)) for (let i = 0; i < m.vertices.length; i += 3) box.expandByPoint(v.fromArray(m.vertices, i));
  for (const f of live) if (f.kind === "sculpt") box.union(new Box3().setFromArray(sculptTriangles(f.params, worldMatrix(live, f.id))));
  if (box.isEmpty()) box.set(new Vector3(), new Vector3());
  const t = top[0];
  t.position = { x: round4(t.position.x - (box.min.x + box.max.x) / 2), y: round4(t.position.y - (box.min.y + box.max.y) / 2), z: round4(t.position.z - box.min.z) };
  const [hx, hy] = [(box.max.x - box.min.x) / 2, (box.max.y - box.min.y) / 2];
  const n = incoming.length;
  return { features, fonts, box: [-hx, hx, -hy, hy], note: `${file.name}: ${n} object${n === 1 ? "" : "s"}${top[0].kind === "group" && n > 1 ? " (grouped)" : ""}`, tail: "" };
}

/** The model as a 3MF file: each part its own object, with its colour. */
async function file3mf(chosen: Feature[] = activeFeatures(doc.features)): Promise<Blob> {
  const features = kernel.snapshot(chosen);
  const meshes = await kernel.parts(features);
  const parts: MeshPart[] = meshes.map((m) => {
    const f = features.find((x) => x.id === m.id)!;
    return { name: f.name, color: colourOf(features, f) ?? "#3ddc97", vertices: m.vertices, triangles: m.triangles };
  });
  // Sculpts (meshes) go in as their own objects, with any holes cut through them.
  const cut = await kernel.cutMeshes(features);
  for (const f of features) {
    if (f.kind !== "sculpt") continue;
    const tris = cut[f.id] ?? sculptTriangles(f.params, worldMatrix(features, f.id));
    parts.push({ name: f.name, color: f.color ?? "#3ddc97", vertices: tris, triangles: new Uint32Array(tris.length / 3).map((_, i) => i) });
  }
  if (!parts.length) throw new Error("Nothing to export: add at least one solid shape.");
  return build3mf(parts);
}

async function export3mf() {
  const { features, label } = exportFeatures();
  setStatus(`Exporting ${label ? `${label} as ` : ""}3MF…`);
  try {
    await saveFile(await file3mf(features), `${fileStem(label)}.3mf`, "3MF", "3mf");
    setStatus(label ? `Exported ${label} only (nothing selected exports everything).` : "");
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
$("#lay-flat").onclick = () => layFlat();
const pointSnapSelect = $("#point-snap") as HTMLSelectElement;
const POINT_SNAP_KEY = "gizmocad.pointSnap";
const applyPointSnap = () => viewport.setPointSnap(pointSnapSelect.value !== "off", pointSnapSelect.value === "show");
pointSnapSelect.onchange = () => {
  applyPointSnap();
  store(POINT_SNAP_KEY, pointSnapSelect.value);
};
// Remembered between visits, and applied now (a browser can also bring back the menu's last choice on reload).
const savedPointSnap = stored(POINT_SNAP_KEY);
if (savedPointSnap && [...pointSnapSelect.options].some((o) => o.value === savedPointSnap)) pointSnapSelect.value = savedPointSnap;
applyPointSnap();
const localAxesButton = $("#local-axes");
function toggleLocalAxes() {
  const on = !localAxesButton.classList.contains("on");
  localAxesButton.classList.toggle("on", on);
  localAxesButton.setAttribute("aria-pressed", String(on));
  viewport.setLocalAxes(on);
}
localAxesButton.onclick = toggleLocalAxes;
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
    undoRedo(e.shiftKey);
    return;
  }
  if (mod && key === "y") {
    e.preventDefault();
    undoRedo(true);
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
  if (!mod && key === "x") return cycleSeeThrough();
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
  if (!mod && key === "l") return toggleLocalAxes();
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
  } else if (!mod && key === "g" && selectedId) {
    toggleGhost(selectedId, selectedIds.filter((x) => x !== selectedId));
  } else if (!mod && key === "h" && selectedId) {
    toggleHidden(selectedId, selectedIds.filter((x) => x !== selectedId));
  } else if (e.key === "Delete" || e.key === "Backspace") {
    deleteSelected();
  } else if (e.key === "Escape") {
    if (viewport.pickingFace) layFlat();
    else if (viewport.chiseling) stopChisel();
    else if (edgePick) stopEdgePick();
    else selectObject(null);
  }
});

// ---- Help under section titles ----------------------------------------------------
//
// A section's help text is folded away behind a "?" on its title; the sections
// whose help is open are remembered. Help with no section above it stays shown.

const HELP_KEY = "gizmocad.help";
const helpOpen = new Set<string>(
  (() => {
    try {
      return JSON.parse(stored(HELP_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  })(),
);

/** The section title above an element in the panel (searching earlier siblings, then the parents' ones). */
function sectionAbove(el: Element, panel: Element): HTMLElement | null {
  for (let node: Element | null = el; node && node !== panel; node = node.parentElement) {
    for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) if (prev.classList.contains("section")) return prev as HTMLElement;
  }
  return null;
}

function foldHelp(panel: Element) {
  for (const p of panel.querySelectorAll<HTMLElement>(".units-hint:not([data-help])")) {
    const title = sectionAbove(p, panel);
    p.dataset.help = title ? "folded" : "shown";
    if (!title) continue;
    const name = (title.dataset.title ??= title.textContent ?? "");
    p.hidden = !helpOpen.has(name);
    if (title.querySelector(".help-btn")) continue;
    const btn = document.createElement("button");
    btn.className = "help-btn";
    btn.textContent = "?";
    const show = (open: boolean) => {
      btn.classList.toggle("on", open);
      btn.title = open ? "Hide the help" : "Show help for this";
      btn.setAttribute("aria-expanded", String(open));
    };
    show(helpOpen.has(name));
    btn.onclick = () => {
      const open = !helpOpen.has(name);
      if (open) helpOpen.add(name);
      else helpOpen.delete(name);
      store(HELP_KEY, JSON.stringify([...helpOpen]));
      show(open);
      // Every help paragraph under this title (up to the next one).
      for (const q of panel.querySelectorAll<HTMLElement>('.units-hint[data-help="folded"]')) if (sectionAbove(q, panel) === title) q.hidden = !open;
    };
    title.append(btn);
  }
}
for (const panel of document.querySelectorAll(".panel")) {
  foldHelp(panel);
  new MutationObserver(() => foldHelp(panel)).observe(panel, { childList: true, subtree: true });
}

// ---- Resizable side panels ------------------------------------------------------------

const PANEL_KEY = "gizmocad.panels";
const panelWidths = (() => {
  try {
    return { left: 220, right: 260, ...(JSON.parse(stored(PANEL_KEY) ?? "{}") as { left?: number; right?: number }) };
  } catch {
    return { left: 220, right: 260 };
  }
})();
const setPanelWidths = () => {
  document.body.style.setProperty("--left-w", `${panelWidths.left}px`);
  document.body.style.setProperty("--right-w", `${panelWidths.right}px`);
};
setPanelWidths();
for (const side of ["left", "right"] as const) {
  const grip = document.createElement("div");
  grip.className = `panel-grip ${side}`;
  grip.title = "Drag to make this panel wider or narrower (double-click: back to normal)";
  grip.onpointerdown = (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("dragging");
    const move = (m: PointerEvent) => {
      const w = side === "left" ? m.clientX : window.innerWidth - m.clientX;
      panelWidths[side] = Math.round(Math.max(180, Math.min(window.innerWidth * 0.4, w)));
      setPanelWidths();
    };
    const up = () => {
      grip.classList.remove("dragging");
      for (const [type, fn] of [["pointermove", move], ["pointerup", up], ["pointercancel", up]] as const) grip.removeEventListener(type, fn as EventListener);
      store(PANEL_KEY, JSON.stringify(panelWidths));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };
  grip.ondblclick = () => {
    panelWidths[side] = side === "left" ? 220 : 260;
    setPanelWidths();
    store(PANEL_KEY, JSON.stringify(panelWidths));
  };
  document.body.append(grip);
}

kernel.ready.catch((err: Error) => setStatus(err.message, true));
loadBed();
refresh();
void restoreAutosave();
