// Interactive 2D drawing on a sketch plane. Tools create entities; the select
// tool picks, box-selects, moves, and edits entities through their handles
// (the dots). The cursor snaps to existing points first, then to the grid.
// Everything is drawn into the viewport's sketch layer in sketch coordinates.

import * as THREE from "three";
import { newId, type EntityMode, type Point2, type SketchConstraint, type SketchEntity, type SketchRef } from "./model";
import { CONSTRAINT_GLYPH, constraintAnchor, refAt, refGeometry } from "./constraints";
import {
  bounds,
  canSplit,
  cornerAt,
  roundCorner,
  handles,
  hitTest,
  mergeOverlaps,
  insertPoint,
  isClosed,
  moveHandle,
  nearestEdge,
  outline,
  rectCorners,
  removePoint,
  round,
  snapPoints,
  splinePieces,
  splitAt,
  strokePath,
  trimAt,
  type TrimResult,
  translateEntity,
  type Handle,
} from "./sketchGeometry";
import { scenePalette } from "./theme";
import type { SketchPointer } from "./viewport";

/** A ruler length: always two decimals, e.g. "20.00". */
const twoPlaces = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);

export type SketchTool = "select" | "point" | "line" | "rect" | "circle" | "ellipse" | "ngon" | "slot" | "polygon" | "spline" | "brush" | "split" | "trim" | "constrain" | "corner";

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface SketchHost {
  entities(): SketchEntity[];
  /** The sketch's constraints (dimensions and rules), for drawing their labels. */
  constraints(): SketchConstraint[];
  /** Apply an undoable change to the sketch's entities. */
  commit(mutate: (entities: SketchEntity[]) => void): void;
  /** Tool, selection or cursor changed; refresh any UI that shows them. */
  changed(): void;
  /** Grid snap size in sketch units (0 = off). */
  snapSize(): number;
  /** Show a context menu at screen coordinates. */
  menu(items: MenuItem[], x: number, y: number): void;
  /** A short message for the user (e.g. what a trim did). */
  notify(text: string): void;
}

type P = Point2;

const COLOR = {
  // add, construction and preview depend on the theme; see themed().
  add: 0,
  subtract: 0xd23c3c,
  construction: 0,
  selected: 0x2f86ff,
  preview: 0,
  handle: 0x2f86ff,
  edgeHandle: 0xf09a2a,
  snap: 0xf09a2a,
  axisU: 0xd65a5a,
  axisV: 0x3fae6a,
  dimension: 0x7a5af8,
};

/** Tools that are drawn with two points (drag, or click twice). */
const TWO_POINT = new Set<SketchTool>(["line", "rect", "circle", "ellipse", "ngon", "slot"]);

type Drag =
  | { kind: "move"; from: P; offset: P }
  | { kind: "handle"; id: string; key: string; preview: SketchEntity }
  | { kind: "box"; from: P; to: P; additive: boolean };

export class SketchEditor {
  tool: SketchTool = "rect";
  /** Mode for new closed shapes. Points and lines are always construction. */
  newMode: EntityMode = "add";
  ngonSides = 6;
  /** Brush stroke width in sketch units. */
  brushWidth = 4;
  /** Corner tool: the radius of a rounded corner, or how far back along each edge a bevel cuts. */
  cornerSize = 2;
  cornerBevel = false;
  /** Raw samples of the brush stroke being painted. */
  private brushing: P[] | null = null;
  selected = new Set<string>();
  cursor: P | null = null;
  /** Constrain tool: the points/edges/circles clicked so far (at most two). */
  picked: SketchRef[] = [];

  private content = new THREE.Group();
  /** Start point for two-point tools, or points placed so far for polygon/curve. */
  private drawing: P[] = [];
  private skipUp = false;
  private drag: Drag | null = null;
  /** The picked point of the selected polygon or curve (its index), shown in the view and the panel. */
  activePoint: number | null = null;
  /** Sketch units per screen pixel, from the last pointer event (for sizing the ruler). */
  private pixel = 0.1;
  /** The existing point the cursor is snapped to, if any. */
  private snappedTo: P | null = null;

  constructor(private layer: THREE.Group, private host: SketchHost) {
    layer.add(this.content);
    this.render();
  }

  dispose() {
    this.clearContent();
    this.layer.remove(this.content);
  }

  get busy() {
    return this.drawing.length > 0 || this.drag !== null || this.brushing !== null;
  }

  setTool(tool: SketchTool) {
    this.tool = tool;
    this.picked = [];
    this.drawing = [];
    this.drag = null;
    this.render();
    this.host.changed();
  }

  /** Escape: abandon the shape in progress, then the selection. Returns false if there was nothing to do. */
  cancel(): boolean {
    if (this.busy) {
      this.drawing = [];
      this.drag = null;
      this.brushing = null;
    } else if (this.picked.length) {
      this.picked = [];
      this.host.changed();
    } else if (this.selected.size) {
      this.selected.clear();
      this.host.changed();
    } else {
      return false;
    }
    this.render();
    return true;
  }

  // ---- Commands (also used by the panel and keyboard) ----------------------

  selectAll() {
    this.selected = new Set(this.host.entities().map((e) => e.id));
    this.render();
    this.host.changed();
  }

  deleteSelected() {
    if (!this.selected.size) return;
    const ids = new Set(this.selected);
    this.selected.clear();
    this.host.commit((entities) => entities.splice(0, entities.length, ...entities.filter((e) => !ids.has(e.id))));
  }

  duplicateSelected() {
    if (!this.selected.size) return;
    const offset = Math.max(this.host.snapSize(), 1) * 5;
    const copies = this.host
      .entities()
      .filter((e) => this.selected.has(e.id))
      .map((e) => {
        const c = { ...structuredClone(e), id: newId() };
        translateEntity(c, [offset, -offset]);
        return c;
      });
    this.selected = new Set(copies.map((c) => c.id));
    this.host.commit((entities) => entities.push(...copies));
  }

  setSelectedMode(mode: EntityMode) {
    const ids = new Set(this.selected);
    this.host.commit((entities) => {
      for (const e of entities) if (ids.has(e.id) && isClosed(e)) e.mode = mode;
    });
  }

  /** Close the polygon or curve being drawn (Enter / double-click). */
  finishShape() {
    const pts = dedupe(this.drawing);
    this.drawing = [];
    if (pts.length < 3 || (this.tool !== "polygon" && this.tool !== "spline")) return this.render();
    if (this.tool === "polygon") this.add({ id: newId(), mode: this.newMode, type: "polygon", points: pts, bends: pts.map(() => 0) });
    else this.add({ id: newId(), mode: this.newMode, type: "spline", points: pts });
  }

  // ---- Pointer handling ----------------------------------------------------

  handle(e: SketchPointer) {
    const raw: P = [e.u, e.v];
    this.pixel = e.pixel;
    const exclude = this.drag?.kind === "move" ? this.selected : this.drag?.kind === "handle" ? new Set([this.drag.id]) : undefined;
    const p = e.alt ? ((this.snappedTo = null), [round(raw[0]), round(raw[1])] as P) : this.snap(raw, e.pixel, exclude);

    if (this.tool === "brush") return this.handleBrush(e, raw, p);

    if (e.kind === "move") {
      this.cursor = p;
      if (this.drag?.kind === "move") this.drag.offset = [p[0] - this.drag.from[0], p[1] - this.drag.from[1]];
      if (this.drag?.kind === "handle") {
        const original = this.host.entities().find((x) => x.id === (this.drag as { id: string }).id);
        if (original) {
          this.drag.preview = structuredClone(original);
          moveHandle(this.drag.preview, this.drag.key, p);
        }
      }
      if (this.drag?.kind === "box") this.drag.to = raw;
      this.render();
      this.host.changed();
      return;
    }

    if (e.kind === "context") return this.contextMenu(raw, p, e);
    if (this.tool === "select") return this.handleSelect(e, raw, p);
    if (this.tool === "polygon" || this.tool === "spline") return this.handleMultiPoint(e.kind, p);
    if (this.tool === "split") {
      if (e.kind === "down") this.splitUnder(raw, e.pixel);
      return;
    }
    if (this.tool === "constrain") {
      if (e.kind === "down") {
        // Click points, edges or circles to pick them (again to unpick); the panel offers what fits.
        const ref = refAt(this.host.entities(), raw, 8 * e.pixel);
        const same = (r: SketchRef) => ref && r.entity === ref.entity && r.kind === ref.kind && r.index === ref.index;
        if (!ref) this.picked = [];
        else if (this.picked.some(same)) this.picked = this.picked.filter((r) => !same(r));
        else this.picked = [...this.picked.slice(-1), ref];
        this.render();
        this.host.changed();
      }
      return;
    }
    if (this.tool === "corner") {
      if (e.kind === "down") this.roundCornerAt(raw, e.pixel);
      return;
    }
    if (this.tool === "trim") {
      if (e.kind === "down") {
        const r = trimAt(this.host.entities(), raw, 6 * e.pixel, newId);
        if (r) this.applyTrim(r);
        else this.host.notify("Nothing to trim there: click a guide line, or a shape's edge where it runs inside another shape.");
      }
      return;
    }
    if (this.tool === "point") {
      if (e.kind === "down") this.add({ id: newId(), mode: "construction", type: "point", x: p[0], y: p[1] });
      return;
    }

    // Two-point tools: drag out, or click start then click end.
    if (e.kind === "down") {
      if (this.drawing.length === 0) {
        this.drawing = [p];
      } else {
        this.finishTwoPoint(this.drawing[0], p);
        this.skipUp = true;
      }
    } else if (e.kind === "up") {
      if (this.skipUp) {
        this.skipUp = false;
        return;
      }
      const start = this.drawing[0];
      if (start && (start[0] !== p[0] || start[1] !== p[1])) this.finishTwoPoint(start, p);
    }
  }

  /** Object snap (existing points, origin) within a few pixels, else grid snap. */
  private snap(raw: P, pixel: number, exclude?: Set<string>): P {
    const tolerance = 10 * pixel;
    let best: P | null = null;
    let bestD = tolerance;
    const consider = (q: P) => {
      const d = Math.hypot(q[0] - raw[0], q[1] - raw[1]);
      if (d < bestD) [best, bestD] = [q, d];
    };
    consider([0, 0]);
    for (const e of this.host.entities()) if (!exclude?.has(e.id)) snapPoints(e).forEach(consider);
    // Only the first point of a shape being drawn is a target (to close it), so new points can sit close to the last one.
    if (this.drawing.length) consider(this.drawing[0]);
    this.snappedTo = best;
    if (best) return [round(best[0]), round(best[1])];
    const g = this.host.snapSize();
    return g > 0 ? [round(Math.round(raw[0] / g) * g), round(Math.round(raw[1] / g) * g)] : [round(raw[0]), round(raw[1])];
  }

  private finishTwoPoint(a: P, b: P) {
    this.drawing = [];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) return this.render();
    const id = newId();
    const mode = this.newMode;
    switch (this.tool) {
      case "line":
        return this.add({ id, mode: "construction", type: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
      case "rect":
        if (!dx || !dy) return this.render();
        return this.add({ id, mode, type: "rect", x: round((a[0] + b[0]) / 2), y: round((a[1] + b[1]) / 2), width: round(Math.abs(dx)), height: round(Math.abs(dy)), angle: 0, radius: 0 });
      case "circle":
        return this.add({ id, mode, type: "circle", x: a[0], y: a[1], radius: round(length) });
      case "ellipse":
        if (!dx || !dy) return this.render();
        return this.add({ id, mode, type: "ellipse", x: a[0], y: a[1], rx: round(Math.abs(dx)), ry: round(Math.abs(dy)), angle: 0 });
      case "ngon":
        return this.add({ id, mode, type: "ngon", x: a[0], y: a[1], radius: round(length), sides: this.ngonSides, angle: round((Math.atan2(dy, dx) * 180) / Math.PI) });
      case "slot":
        return this.add({ id, mode, type: "slot", x1: a[0], y1: a[1], x2: b[0], y2: b[1], radius: round(Math.max(length / 6, 0.5)) });
    }
  }

  /**
   * Brush: paint freehand while the button is held. The start snaps like other
   * tools; the rest follows the pointer, then gets smoothed into a stroke.
   */
  private handleBrush(e: SketchPointer, raw: P, snapped: P) {
    if (e.kind === "down") {
      this.brushing = [snapped];
    } else if (e.kind === "move") {
      this.cursor = snapped;
      const last = this.brushing?.[this.brushing.length - 1];
      // Sample every few pixels so the path isn't cluttered with jitter.
      if (this.brushing && last && Math.hypot(raw[0] - last[0], raw[1] - last[1]) > 3 * e.pixel) this.brushing.push(raw);
      this.render();
      this.host.changed();
    } else if (e.kind === "up" && this.brushing) {
      const samples = this.brushing;
      this.brushing = null;
      const points = strokePath(samples, this.brushWidth);
      if (points.length) this.add({ id: newId(), mode: this.newMode, type: "stroke", points, width: this.brushWidth });
      else this.render();
    }
  }

  private handleMultiPoint(kind: SketchPointer["kind"], p: P) {
    if (kind === "dblclick") return this.finishShape();
    if (kind !== "down") return;
    const first = this.drawing[0];
    if (first && this.drawing.length >= 3 && first[0] === p[0] && first[1] === p[1]) return this.finishShape();
    const last = this.drawing[this.drawing.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) this.drawing.push(p);
    this.render();
  }

  /** The handle of a selected entity under the raw pointer, if any. */
  private handleAt(raw: P, pixel: number): { entity: SketchEntity; handle: Handle } | null {
    let best: { entity: SketchEntity; handle: Handle; d: number } | null = null;
    for (const entity of this.host.entities()) {
      if (!this.selected.has(entity.id)) continue;
      for (const handle of handles(entity)) {
        const d = Math.hypot(handle.p[0] - raw[0], handle.p[1] - raw[1]);
        if (d <= 8 * pixel && (!best || d < best.d)) best = { entity, handle, d };
      }
    }
    return best;
  }

  private handleSelect(e: SketchPointer, raw: P, p: P) {
    if (e.kind === "down") {
      const h = this.selected.size === 1 || !e.shift ? this.handleAt(raw, e.pixel) : null;
      // Clicking a polygon's or curve's point (or edge dot) shows which one it is.
      const index = h && (h.entity.type === "polygon" || h.entity.type === "spline") ? /^[vm](\d+)$/.exec(h.handle.key) : null;
      this.activePoint = index ? Number(index[1]) : null;
      if (h && h.handle.kind !== "center") {
        this.selected = new Set([h.entity.id]);
        this.drag = { kind: "handle", id: h.entity.id, key: h.handle.key, preview: structuredClone(h.entity) };
      } else {
        const hit = hitTest(this.host.entities(), raw, 6 * e.pixel);
        if (hit) {
          if (e.shift) {
            if (this.selected.has(hit)) this.selected.delete(hit);
            else this.selected.add(hit);
          } else if (!this.selected.has(hit)) {
            this.selected = new Set([hit]);
          }
          if (this.selected.has(hit)) this.drag = { kind: "move", from: p, offset: [0, 0] };
        } else {
          if (!e.shift) this.selected.clear();
          this.drag = { kind: "box", from: raw, to: raw, additive: e.shift };
        }
      }
      this.render();
      this.host.changed();
    } else if (e.kind === "up" && this.drag) {
      const drag = this.drag;
      this.drag = null;
      if (drag.kind === "move" && (drag.offset[0] || drag.offset[1])) {
        const ids = new Set(this.selected);
        this.host.commit((entities) => entities.filter((x) => ids.has(x.id)).forEach((x) => translateEntity(x, drag.offset)));
      } else if (drag.kind === "handle") {
        this.host.commit((entities) => {
          const target = entities.find((x) => x.id === drag.id);
          if (target) Object.assign(target, drag.preview);
        });
      } else if (drag.kind === "box") {
        const [x0, x1] = [Math.min(drag.from[0], drag.to[0]), Math.max(drag.from[0], drag.to[0])];
        const [y0, y1] = [Math.min(drag.from[1], drag.to[1]), Math.max(drag.from[1], drag.to[1])];
        if (x1 - x0 > 0 && y1 - y0 > 0) {
          for (const ent of this.host.entities()) {
            const [[bx0, by0], [bx1, by1]] = bounds(ent);
            if (bx0 >= x0 && bx1 <= x1 && by0 >= y0 && by1 <= y1) this.selected.add(ent.id);
          }
        }
        this.render();
        this.host.changed();
      } else {
        this.render();
      }
    }
  }

  private contextMenu(raw: P, p: P, e: SketchPointer) {
    const items: MenuItem[] = [];
    const commitOn = (id: string, mutate: (x: SketchEntity) => void) =>
      this.host.commit((entities) => {
        const t = entities.find((x) => x.id === id);
        if (t) mutate(t);
      });

    if (this.drawing.length >= 3 && (this.tool === "polygon" || this.tool === "spline")) {
      items.push({ label: "Close shape", action: () => this.finishShape() });
    }
    if (this.drawing.length) items.push({ label: "Cancel drawing", action: () => this.cancel() });

    const h = this.handleAt(raw, e.pixel);
    const hitId = h?.entity.id ?? hitTest(this.host.entities(), raw, 6 * e.pixel);
    const hit = this.host.entities().find((x) => x.id === hitId);

    if (h && (h.entity.type === "polygon" || h.entity.type === "spline")) {
      const idx = Number(h.handle.key.slice(1));
      const ent = h.entity;
      if (h.handle.kind === "vertex") {
        items.push({ label: "Delete point", disabled: ent.points.length <= 3, action: () => commitOn(ent.id, (x) => removePoint(x, idx)) });
      } else if (h.handle.kind === "edge" && ent.type === "polygon") {
        items.push({ label: "Add point here", action: () => commitOn(ent.id, (x) => insertPoint(x, idx)) });
        items.push({ label: "Straighten edge", disabled: !ent.bends[idx], action: () => commitOn(ent.id, (x) => x.type === "polygon" && (x.bends[idx] = 0)) });
      }
    }

    if (hit) {
      if (!this.selected.has(hit.id)) this.selected = new Set([hit.id]);
      const many = this.selected.size > 1;
      if (!many) {
        items.push({ label: "Edit…", action: () => this.host.changed() });
        if (canSplit(hit)) {
          const two = hit.type === "line" || hit.type === "stroke";
          items.push({ label: two ? "Split here" : "Add corner here", action: () => this.splitEntity(hit, raw) });
        }
        if ((hit.type === "polygon" || hit.type === "spline") && !h) {
          const edge = nearestEdge(hit, raw);
          items.push({ label: "Add point on edge", action: () => commitOn(hit.id, (x) => insertPoint(x, edge)) });
        }
      }
      items.push({ label: many ? `Duplicate ${this.selected.size} shapes` : "Duplicate", action: () => this.duplicateSelected() });
      if (isClosed(hit)) {
        items.push(
          { label: "Make Add", disabled: !many && hit.mode === "add", action: () => this.setSelectedMode("add") },
          { label: "Make Cut", disabled: !many && hit.mode === "subtract", action: () => this.setSelectedMode("subtract") },
          { label: "Make Construction", disabled: !many && hit.mode === "construction", action: () => this.setSelectedMode("construction") },
        );
      }
      items.push({ label: many ? `Delete ${this.selected.size} shapes` : "Delete", danger: true, action: () => this.deleteSelected() });
    } else if (!this.drawing.length) {
      items.push({ label: "Select all", action: () => this.selectAll() });
      if (this.tool !== "select") items.push({ label: "Select tool", action: () => this.setTool("select") });
    }

    this.render();
    this.host.changed();
    if (items.length) this.host.menu(items, e.clientX, e.clientY);
    void p;
  }

  /** Merge the selected shapes wherever they overlap. */
  trimSelected() {
    const r = mergeOverlaps(this.host.entities().filter((x) => this.selected.has(x.id)), newId);
    if (r) this.applyTrim(r);
    else this.host.notify("None of the selected shapes overlap (shapes only merge with the same kind: add with add, cut with cut).");
  }

  private applyTrim(r: TrimResult) {
    const gone = new Set(r.remove);
    this.selected = new Set(r.add.map((x) => x.id));
    this.host.commit((entities) => {
      // The results go where the first removed shape was, keeping the drawing order.
      const at = entities.findIndex((x) => gone.has(x.id));
      const kept = entities.filter((x) => !gone.has(x.id));
      kept.splice(at < 0 ? kept.length : Math.min(at, kept.length), 0, ...r.add);
      entities.splice(0, entities.length, ...kept);
    });
    this.host.notify(r.message);
    this.host.changed();
  }

  /** Split the line/stroke/outline under the pointer at that spot. */
  private splitUnder(raw: P, pixel: number): boolean {
    const id = hitTest(this.host.entities(), raw, 6 * pixel);
    const target = this.host.entities().find((x) => x.id === id);
    return !!target && this.splitEntity(target, raw);
  }

  private splitEntity(target: SketchEntity, at: P): boolean {
    const pieces = splitAt(structuredClone(target), at, newId());
    if (!pieces) return false;
    this.selected = new Set(pieces.map((x) => x.id));
    this.host.commit((entities) => {
      const i = entities.findIndex((x) => x.id === target.id);
      if (i >= 0) entities.splice(i, 1, ...pieces);
    });
    this.host.changed();
    return true;
  }

  /** Round (or bevel) the shape's corner nearest the pointer. */
  private roundCornerAt(raw: P, pixel: number) {
    let best: { e: SketchEntity; i: number; d: number } | null = null;
    for (const e of this.host.entities()) {
      const c = cornerAt(e, raw, 10 * pixel);
      if (c && (!best || c.d < best.d)) best = { e, i: c.index, d: c.d };
    }
    if (!best) return this.host.notify("Click a corner of a polygon, rectangle or N-gon (where two straight edges meet).");
    const rounded = roundCorner(best.e, best.i, this.cornerSize, this.cornerBevel);
    if (!rounded) return this.host.notify(`A ${this.cornerBevel ? "bevel" : "radius"} of ${this.cornerSize} mm doesn't fit at that corner: try a smaller one.`);
    this.selected = new Set([rounded.id]);
    this.host.commit((entities) => {
      const i = entities.findIndex((x) => x.id === rounded.id);
      if (i >= 0) entities[i] = rounded;
    });
    this.host.changed();
  }

  /** Add new shapes (copies, offsets, projected outlines…), selecting them. */
  addShapes(shapes: SketchEntity[]) {
    if (!shapes.length) return;
    this.selected = new Set(shapes.map((x) => x.id));
    this.host.commit((entities) => entities.push(...shapes));
    this.host.changed();
  }

  private add(entity: SketchEntity) {
    this.selected = new Set([entity.id]);
    this.host.commit((entities) => entities.push(entity));
    this.host.changed();
  }

  // ---- Drawing -------------------------------------------------------------

  private clearContent() {
    for (const child of [...this.content.children]) {
      this.content.remove(child);
      if (child instanceof THREE.Sprite) child.material.dispose(); // Its texture is shared (cached).
      else if (child instanceof THREE.Line || child instanceof THREE.Points || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  /** Highlight one point of the selected polygon or curve (from its row in the panel, which updates itself). */
  setActivePoint(index: number | null) {
    if (index === this.activePoint) return;
    this.activePoint = index;
    this.render();
  }

  /** The selected polygon or curve, while exactly one is selected. */
  private pointEntity(): Extract<SketchEntity, { type: "polygon" | "spline" }> | null {
    if (this.selected.size !== 1) return null;
    const id = [...this.selected][0];
    const e = this.drag?.kind === "handle" && this.drag.id === id ? this.drag.preview : this.host.entities().find((x) => x.id === id);
    return e && (e.type === "polygon" || e.type === "spline") ? e : null;
  }

  render() {
    const pal = scenePalette();
    COLOR.add = pal.sketchAdd;
    COLOR.construction = pal.sketchConstruction;
    COLOR.preview = pal.sketchPreview;
    this.clearContent();
    this.addLine([[-1000, 0], [1000, 0]], COLOR.axisU, false, { opacity: 0.6 });
    this.addLine([[0, -1000], [0, 1000]], COLOR.axisV, false, { opacity: 0.6 });

    const drag = this.drag;
    for (const original of this.host.entities()) {
      let e = original;
      if (drag?.kind === "handle" && drag.id === e.id) e = drag.preview;
      if (drag?.kind === "move" && this.selected.has(e.id)) {
        e = structuredClone(e);
        translateEntity(e, drag.offset);
      }
      const selected = this.selected.has(e.id);
      const color = selected ? COLOR.selected : COLOR[e.mode];
      const pts = outline(e);
      if (e.type === "point") this.addPoints(pts, color, 7);
      else this.addLine(pts, color, isClosed(e), { dashed: e.mode === "construction" });
      if (selected && this.selected.size <= 20) this.addHandles(e);
    }

    this.drawConstraints();

    // The picked point: ringed and numbered, matching its row in the panel.
    const pe = this.pointEntity();
    if (pe && this.activePoint !== null && this.activePoint < pe.points.length) {
      const pt = pe.points[this.activePoint];
      this.addPoints([pt], COLOR.snap, 14);
      if (drag?.kind !== "handle") this.addLabel(`P${this.activePoint + 1}`, pt, false); // While dragging, the ruler says it all.
    } else if (!pe) this.activePoint = null;

    // Ruler: live sizes of the shape being drawn or reshaped.
    if (drag?.kind === "handle") this.drawRuler(drag.preview, drag.key);

    // Box selection.
    if (drag?.kind === "box") {
      const [a, b] = [drag.from, drag.to];
      this.addLine([a, [b[0], a[1]], b, [a[0], b[1]]], COLOR.selected, true, { dashed: true });
    }

    // Shape in progress.
    const c = this.cursor;
    const previewColor = this.newMode === "subtract" ? COLOR.subtract : this.newMode === "construction" ? COLOR.construction : COLOR.preview;
    if (this.drawing.length && c) {
      const a = this.drawing[0];
      const preview = this.previewEntity(a, c);
      if (preview) {
        this.addLine(outline(preview), previewColor, isClosed(preview), { dashed: true });
        this.drawRuler(preview);
      }
      if ((this.tool === "polygon" || this.tool === "spline") && this.drawing.length) {
        const last = this.drawing[this.drawing.length - 1];
        this.segmentRuler(last, c);
      }
      // On the first point (with enough points), a click closes the shape: show it finished.
      const first = this.drawing[0];
      const closing = this.drawing.length >= 3 && c[0] === first[0] && c[1] === first[1];
      if (this.tool === "polygon") {
        this.addLine(closing ? this.drawing : [...this.drawing, c], previewColor, closing);
        if (!closing && this.drawing.length >= 2) this.addLine([c, first], previewColor, false, { dashed: true });
      }
      if (this.tool === "spline") {
        // Solid: the curve through the points so far and the cursor; dashed: how it closes back to the start.
        const last = this.drawing[this.drawing.length - 1];
        const onLast = c[0] === last[0] && c[1] === last[1]; // Just clicked: don't count that point twice.
        const pieces = splinePieces(closing || onLast ? this.drawing : [...this.drawing, c]);
        if (!pieces.length) this.addLine([...this.drawing, c], previewColor, false);
        pieces.forEach((piece, i) => this.addLine(piece, previewColor, false, closing || i < pieces.length - 1 ? {} : { dashed: true }));
      }
      this.addPoints(this.drawing, previewColor, 6);
      // The start point is the target for closing the shape.
      if ((this.tool === "polygon" || this.tool === "spline") && this.drawing.length >= 3) this.addPoints([first], closing ? COLOR.selected : previewColor, closing ? 14 : 10);
    }

    // Brush: the stroke being painted, and the brush size at the cursor.
    if (this.tool === "brush") {
      if (this.brushing?.length) this.addLine(outline({ id: "", mode: "add", type: "stroke", points: this.brushing, width: this.brushWidth }), previewColor, true);
      if (c) this.addLine(outline({ id: "", mode: "add", type: "circle", x: c[0], y: c[1], radius: this.brushWidth / 2 }), COLOR.selected, true, { opacity: 0.7 });
    }

    // Snap indicator and cursor.
    if (this.snappedTo && this.tool !== "select") this.addRing(this.snappedTo, COLOR.snap);
    if (c && this.tool !== "select") {
      const s = 1.5;
      this.addLine([[c[0] - s, c[1]], [c[0] + s, c[1]]], COLOR.selected, false);
      this.addLine([[c[0], c[1] - s], [c[0], c[1] + s]], COLOR.selected, false);
    }
  }

  /** Each constraint's symbol (or a dimension's value) by its geometry, and the Constrain tool's picks. */
  private drawConstraints() {
    const entities = this.host.entities();
    const constraints = this.host.constraints();
    // Several labels on the same spot (e.g. Horizontal and a Length on one line) stack up instead of hiding each other.
    const used = new Map<string, number>();
    for (const c of constraints) {
      const at = constraintAnchor(c, entities);
      if (!at) continue;
      const key = `${Math.round(at[0] * 10)},${Math.round(at[1] * 10)}`;
      const stack = used.get(key) ?? 0;
      used.set(key, stack + 1);
      const value = c.value !== undefined && ["distance", "length", "diameter", "angle"].includes(c.type);
      const text = value ? `${c.type === "diameter" ? "Ø" : ""}${Math.round(c.value! * 100) / 100}${c.type === "angle" ? "°" : ""}` : CONSTRAINT_GLYPH[c.type];
      // A distance between two points gets a dimension line.
      if (c.type === "distance" && c.refs.length === 2) {
        const [a, b] = c.refs.map((r) => refGeometry(r, entities));
        if (a?.kind === "point" && b?.kind === "point") this.addLine([a.p, b.p], COLOR.dimension, false, { dashed: true });
      }
      this.addLabel(text, at, value, stack);
    }
    for (const ref of this.picked) {
      const g = refGeometry(ref, entities);
      if (!g) continue;
      if (g.kind === "point") this.addPoints([g.p], COLOR.snap, 13);
      else if (g.kind === "edge") {
        this.addLine([g.a, g.b], COLOR.snap, false);
        this.addPoints([g.a, g.b], COLOR.snap, 6);
      } else this.addLine(outline({ id: "", mode: "add", type: "circle", x: g.c[0], y: g.c[1], radius: g.r }), COLOR.snap, true);
    }
  }

  // ---- Ruler ---------------------------------------------------------------

  /** Dimension lines for a shape: its sizes as they change (like the Resize ruler in 3D). */
  private drawRuler(e: SketchEntity, key?: string) {
    const mm = (v: number) => `${twoPlaces(v)} mm`;
    const centre = (pts: P[]): P => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    switch (e.type) {
      case "line":
        return this.segmentRuler([e.x1, e.y1], [e.x2, e.y2]);
      case "rect": {
        const k = rectCorners(e);
        const c = centre(k);
        this.dimension(k[0], k[1], `W ${mm(e.width)}`, c);
        this.dimension(k[1], k[2], `H ${mm(e.height)}`, c);
        return;
      }
      case "circle":
        return this.radiusRuler([e.x, e.y], e.radius, `Ø ${mm(2 * e.radius)}`);
      case "ngon":
        return this.radiusRuler([e.x, e.y], e.radius, `Ø ${mm(2 * e.radius)} · ${e.sides} sides`, e.angle);
      case "ellipse":
        this.radiusRuler([e.x, e.y], e.rx, `W ${mm(2 * e.rx)}`, e.angle);
        this.radiusRuler([e.x, e.y], e.ry, `H ${mm(2 * e.ry)}`, e.angle + 90);
        return;
      case "slot":
        return this.dimension([e.x1, e.y1], [e.x2, e.y2], `${mm(Math.hypot(e.x2 - e.x1, e.y2 - e.y1))} · W ${mm(2 * e.radius)}`);
      case "polygon":
      case "spline": {
        // Dragging a point: the edges either side of it.
        const i = key ? Number(/^v(\d+)$/.exec(key)?.[1] ?? NaN) : NaN;
        if (Number.isNaN(i)) return;
        const n = e.points.length;
        const c = centre(e.points);
        const p = e.points[i];
        const prev = e.points[(i - 1 + n) % n];
        const next = e.points[(i + 1) % n];
        const before = e.type === "polygon" || i > 0 ? Math.hypot(p[0] - prev[0], p[1] - prev[1]) : null;
        const after = e.type === "polygon" || i < n - 1 ? Math.hypot(next[0] - p[0], next[1] - p[1]) : null;
        // Short edges on screen: one combined label by the point instead of two that would overlap.
        const short = [before, after].some((l) => l !== null && l / this.pixel < 90);
        if (before !== null) this.dimension(prev, p, short ? "" : mm(before), c);
        if (after !== null) this.dimension(p, next, short ? "" : mm(after), c);
        if (short) {
          const out = Math.hypot(p[0] - c[0], p[1] - c[1]) || 1;
          const at: P = [p[0] + ((p[0] - c[0]) / out) * 40 * this.pixel, p[1] + ((p[1] - c[1]) / out) * 40 * this.pixel];
          this.addLabel([before, after].filter((l) => l !== null).map((l) => mm(l!)).join(" · "), at, true, 0, true);
        }
        return;
      }
    }
  }

  /** A straight run's length and angle. */
  private segmentRuler(a: P, b: P) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) return;
    const deg = Math.round(((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) * 10) / 10;
    this.dimension(a, b, `${twoPlaces(len)} mm · ${deg + 0}°`);
  }

  /** A line from a centre out to its size, labelled. */
  private radiusRuler(c: P, r: number, text: string, angle = 0) {
    if (r <= 0) return;
    const t = (angle * Math.PI) / 180;
    const end: P = [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
    this.addLine([c, end], COLOR.dimension, false, { dashed: true });
    this.addLabel(text, [(c[0] + end[0]) / 2, (c[1] + end[1]) / 2], true, 0, true);
  }

  /** A dimension line beside a–b (on the side away from `inside`), with extension lines and a centred label. */
  private dimension(a: P, b: P, text: string, inside?: P) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) return;
    let n: P = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    const mid: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (inside && (mid[0] - inside[0]) * n[0] + (mid[1] - inside[1]) * n[1] < 0) n = [-n[0], -n[1]];
    const off = 22 * this.pixel;
    const a2: P = [a[0] + n[0] * off, a[1] + n[1] * off];
    const b2: P = [b[0] + n[0] * off, b[1] + n[1] * off];
    this.addLine([a, [a[0] + n[0] * off * 1.3, a[1] + n[1] * off * 1.3]], COLOR.dimension, false, { opacity: 0.5 });
    this.addLine([b, [b[0] + n[0] * off * 1.3, b[1] + n[1] * off * 1.3]], COLOR.dimension, false, { opacity: 0.5 });
    this.addLine([a2, b2], COLOR.dimension, false);
    if (text) this.addLabel(text, [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2], true, 0, true);
  }

  private addLabel(text: string, at: P, dimension: boolean, stack = 0, centred = false) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(text, dimension), depthTest: false, sizeAttenuation: false }));
    const tex = sprite.material.map!;
    const aspect = (tex.image as HTMLCanvasElement).width / (tex.image as HTMLCanvasElement).height;
    const size = centred ? 0.024 : 0.032; // Ruler labels are a little smaller: there can be several close together.
    sprite.scale.set(size * aspect, size, 1);
    // Just above and right of the anchor, clear of the line (stacked upwards); ruler labels sit on their line.
    if (centred) sprite.center.set(0.5, 0.5);
    else sprite.center.set(-0.1, -0.2 - 1.15 * stack);
    sprite.position.set(at[0], at[1], 0);
    sprite.renderOrder = 12;
    this.content.add(sprite);
  }

  private previewEntity(a: P, b: P): SketchEntity | null {
    if (!TWO_POINT.has(this.tool)) return null;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const base = { id: "", mode: this.newMode };
    switch (this.tool) {
      case "line":
        return { ...base, mode: "construction", type: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
      case "rect":
        return { ...base, type: "rect", x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, width: Math.abs(dx), height: Math.abs(dy), angle: 0, radius: 0 };
      case "circle":
        return { ...base, type: "circle", x: a[0], y: a[1], radius: length };
      case "ellipse":
        return { ...base, type: "ellipse", x: a[0], y: a[1], rx: Math.abs(dx), ry: Math.abs(dy), angle: 0 };
      case "ngon":
        return { ...base, type: "ngon", x: a[0], y: a[1], radius: length, sides: this.ngonSides, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
      case "slot":
        return { ...base, type: "slot", x1: a[0], y1: a[1], x2: b[0], y2: b[1], radius: Math.max(length / 6, 0.5) };
      default:
        return null;
    }
  }

  private addHandles(e: SketchEntity) {
    const hs = handles(e);
    const main = hs.filter((h) => h.kind !== "edge").map((h) => h.p);
    const edges = hs.filter((h) => h.kind === "edge").map((h) => h.p);
    this.addPoints(main, COLOR.handle, 9);
    if (edges.length) this.addPoints(edges, COLOR.edgeHandle, 7);
  }

  private addLine(points: P[], color: number, closed: boolean, opts: { opacity?: number; dashed?: boolean } = {}) {
    if (points.length < 2) return;
    const pts = points.map(([u, v]) => new THREE.Vector3(u, v, 0));
    if (closed && opts.dashed) pts.push(pts[0].clone());
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const opacity = opts.opacity ?? 1;
    const common = { color, depthTest: false, transparent: opacity < 1, opacity };
    const mat = opts.dashed ? new THREE.LineDashedMaterial({ ...common, dashSize: 1.2, gapSize: 0.8 }) : new THREE.LineBasicMaterial(common);
    const line = closed && !opts.dashed ? new THREE.LineLoop(geom, mat) : new THREE.Line(geom, mat);
    if (opts.dashed) line.computeLineDistances();
    line.renderOrder = 10;
    this.content.add(line);
  }

  private addPoints(points: P[], color: number, size: number) {
    if (!points.length) return;
    const geom = new THREE.BufferGeometry().setFromPoints(points.map(([u, v]) => new THREE.Vector3(u, v, 0)));
    const pts = new THREE.Points(geom, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }));
    pts.renderOrder = 11;
    this.content.add(pts);
  }

  private addRing(p: P, color: number) {
    const r = 1.2;
    const ring = Array.from({ length: 24 }, (_, i) => [p[0] + r * Math.cos((i / 24) * Math.PI * 2), p[1] + r * Math.sin((i / 24) * Math.PI * 2)] as P);
    this.addLine(ring, color, true);
  }
}

/** Constraint labels as small badges; cached, since the sketch redraws on every pointer move. */
const labelCache = new Map<string, THREE.CanvasTexture>();
function labelTexture(text: string, dimension: boolean): THREE.CanvasTexture {
  const key = `${dimension}|${text}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  // Ruler labels change on every pointer move: keep only the most recent ones.
  if (labelCache.size > 300) {
    for (const [k, t] of [...labelCache].slice(0, 150)) {
      t.dispose();
      labelCache.delete(k);
    }
  }
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const font = "600 28px system-ui, sans-serif";
  g.font = font;
  c.width = Math.ceil(g.measureText(text).width) + 20;
  c.height = 40;
  g.font = font;
  g.fillStyle = dimension ? "#7a5af8" : "#f09a2a";
  g.beginPath();
  g.roundRect(1, 1, c.width - 2, c.height - 2, 9);
  g.fill();
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, c.width / 2, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  labelCache.set(key, tex);
  return tex;
}

function dedupe(points: P[]): P[] {
  const out = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first[0] === last[0] && first[1] === last[1]) out.pop();
  return out;
}
