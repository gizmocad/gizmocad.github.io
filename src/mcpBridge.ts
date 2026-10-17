// The app's side of MCP support: a connection to the GizmoCAD MCP server
// (mcp/gizmocad-mcp.mjs, run by an AI assistant on this computer). The server
// passes on the assistant's tool calls; they're carried out here as normal,
// undoable edits and answered with what happened.

import { BUILT_IN_FONTS } from "./fonts";
import {
  FINISHABLE,
  createFeature,
  nextColour,
  isCadDocument,
  newId,
  normalizeDocument,
  reparent,
  subtreeIds,
  type CadDocument,
  type EdgeOp,
  type Texture,
  type TexturePattern,
  type Feature,
  type ShapeKind,
  type SketchEntity,
  type Vec3,
} from "./model";

export const DEFAULT_MCP_PORT = 7473;

/** What the bridge needs from the app. */
export interface BridgeHost {
  features(): Feature[];
  /** Apply an undoable change. */
  commit(mutate: (features: Feature[]) => void): void;
  /** Add new objects where new objects go (at the history marker). */
  insert(features: Feature[], items: Feature[]): void;
  /** Wait until the model has been rebuilt after the latest change. */
  settle(): Promise<void>;
  /** Build errors by object id, and fillets/chamfers that were shrunk (op id → size used). */
  errors(): Record<string, string>;
  adjusted(): Record<string, number>;
  /** World bounding box of these objects as shown. */
  bounds(ids: string[]): { min: Vec3; max: Vec3 } | null;
  select(ids: string[]): void;
  deleteIds(ids: string[]): void;
  group(ids: string[]): string | null;
  undo(): boolean;
  redo(): boolean;
  load(doc: CadDocument): void;
  document(): CadDocument;
  export(format: "stl" | "step" | "3mf"): Promise<Blob>;
  /** Import files into the model (side by side, one undo step). */
  importFiles(files: { name: string; data: ArrayBuffer }[]): Promise<{ ids: string[]; note: string; failed: string[] }>;
  screenshot(opts: { view: string; ids?: string[]; width: number; height: number; showResult: boolean }): Promise<string>;
  /** A short message in the status bar. */
  notify(text: string): void;
}

export type BridgeState = "off" | "connecting" | "connected";

type Args = Record<string, unknown>;

/** Keeps a connection to the MCP server open while switched on (retrying until it's running). */
export class McpBridge {
  state: BridgeState = "off";
  private socket: WebSocket | null = null;
  private retry = 0;
  private enabled = false;
  private port = DEFAULT_MCP_PORT;
  /** Calls run one at a time, in order, so each sees the result of the last. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private host: BridgeHost,
    private onState: (state: BridgeState) => void,
  ) {}

  setEnabled(on: boolean, port = this.port) {
    const changed = on !== this.enabled || port !== this.port;
    this.enabled = on;
    this.port = port;
    if (!changed) return;
    clearTimeout(this.retry);
    this.socket?.close();
    this.socket = null;
    if (on) this.connect();
    else this.setState("off");
  }

  private setState(state: BridgeState) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }

  private connect() {
    if (!this.enabled) return;
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch {
      this.retry = window.setTimeout(() => this.connect(), 3000);
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", app: "GizmoCAD", url: location.href }));
      this.setState("connected");
    };
    ws.onmessage = (e) => {
      let msg: { id: number; method: string; params: Args };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      this.queue = this.queue.then(() => this.answer(ws, msg));
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      if (!this.enabled) return;
      // The server runs while the assistant does: keep trying until it's there.
      this.setState("connecting");
      this.retry = window.setTimeout(() => this.connect(), 2000);
    };
  }

  private async answer(ws: WebSocket, msg: { id: number; method: string; params: Args }) {
    let reply: object;
    try {
      reply = { id: msg.id, ok: true, result: await run(this.host, msg.method, msg.params ?? {}) };
    } catch (err) {
      reply = { id: msg.id, ok: false, error: (err as Error).message ?? String(err) };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  }
}

// ---- Commands ---------------------------------------------------------------------

async function run(host: BridgeHost, method: string, a: Args): Promise<unknown> {
  switch (method) {
    case "get_model":
      await host.settle();
      return describeModel(host, !!a.include_sketch_geometry);

    case "add_object": {
      const kind = a.kind as ShapeKind;
      if (!ADDABLE.includes(kind)) throw new Error(`Unknown kind "${String(a.kind)}". Use one of: ${ADDABLE.join(", ")}.`);
      const parent = a.parent ? need(host, String(a.parent)) : null;
      const f = createFeature(kind, host.features(), parent?.id ?? null);
      if (kind !== "group" && kind !== "plane" && kind !== "screw") f.color = nextColour(host.features());
      applyFields(f, a);
      host.commit((features) => host.insert(features, [f]));
      host.notify(`AI assistant added ${f.name}.`);
      return report(host, [f.id], { id: f.id, name: f.name });
    }

    case "update_object": {
      const f = need(host, String(a.id));
      // Check everything on a copy first, so a bad value changes nothing.
      applyFields(structuredClone(f), a);
      const parentId = a.parent === undefined ? undefined : a.parent ? need(host, String(a.parent)).id : null;
      if (parentId && subtreeIds(host.features(), f.id).has(parentId)) throw new Error("An object can't go inside itself or its own children.");
      host.commit((features) => {
        if (parentId !== undefined) reparent(features, f.id, parentId);
        applyFields(features.find((x) => x.id === f.id)!, a);
      });
      host.notify(`AI assistant changed ${f.name}.`);
      return report(host, [f.id], { id: f.id, name: findIn(host, f.id)?.name });
    }

    case "delete_objects": {
      const ids = list(a.ids);
      const found = ids.map((id) => need(host, id));
      host.deleteIds(found.map((f) => f.id));
      host.notify(`AI assistant deleted ${found.map((f) => f.name).join(", ")}.`);
      await host.settle();
      return { deleted: found.map((f) => ({ id: f.id, name: f.name })) };
    }

    case "group_objects": {
      const ids = list(a.ids).map((id) => need(host, id).id);
      if (!ids.length) throw new Error("Give the ids of the objects to group.");
      const id = host.group(ids);
      if (!id) throw new Error("Couldn't group those objects.");
      if (a.name !== undefined || a.mode !== undefined)
        host.commit((features) => {
          const g = features.find((x) => x.id === id)!;
          if (typeof a.name === "string" && a.name.trim()) g.name = a.name.trim();
          if (a.mode === "solid" || a.mode === "hole") g.mode = a.mode;
        });
      host.notify(`AI assistant grouped ${ids.length} objects.`);
      return report(host, [id], { id, name: findIn(host, id)?.name, children: ids });
    }

    case "screenshot": {
      await host.settle();
      const clamp = (v: unknown, d: number) => Math.round(Math.min(1600, Math.max(64, typeof v === "number" && Number.isFinite(v) ? v : d)));
      const view = typeof a.view === "string" ? a.view : "iso";
      if (!VIEWS.includes(view)) throw new Error(`Unknown view "${view}". Use one of: ${VIEWS.join(", ")}.`);
      const ids = a.ids === undefined ? undefined : list(a.ids).map((id) => need(host, id).id);
      const png = await host.screenshot({ view, ids, width: clamp(a.width, 800), height: clamp(a.height, 600), showResult: !!a.show_result });
      const failed = Object.keys(host.errors()).length;
      return { png, note: failed ? `${failed} object(s) failed to build (see get_model).` : undefined };
    }

    case "select_objects": {
      const ids = list(a.ids).map((id) => need(host, id).id);
      host.select(ids);
      return { selected: ids };
    }

    case "undo":
    case "redo": {
      const steps = Math.max(1, Math.min(100, Math.round(typeof a.steps === "number" ? a.steps : 1)));
      let done = 0;
      while (done < steps && (method === "undo" ? host.undo() : host.redo())) done++;
      await host.settle();
      return { [method === "undo" ? "undone" : "redone"]: done, objects: host.features().length };
    }

    case "new_model":
      host.load({ format: "gizmocad", version: 1, features: [] });
      host.notify("AI assistant started a new model.");
      await host.settle();
      return { ok: true };

    case "load": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(a.json));
      } catch {
        throw new Error("That file isn't valid JSON, so it isn't a GizmoCAD model.");
      }
      if (!isCadDocument(parsed)) throw new Error("That isn't a GizmoCAD (.gizmocad) model.");
      host.load(normalizeDocument(parsed));
      host.notify("AI assistant opened a model.");
      await host.settle();
      return describeModel(host, false);
    }

    case "import": {
      const files = (Array.isArray(a.files) ? a.files : []).map((f: Args) => {
        const bytes = Uint8Array.from(atob(String(f.base64)), (c) => c.charCodeAt(0));
        return { name: String(f.name), data: bytes.buffer };
      });
      const result = await host.importFiles(files);
      if (!result.ids.length) throw new Error(result.failed.join("; ") || "Nothing was imported.");
      await host.settle();
      const box = host.bounds(result.ids);
      return { imported: result.ids, note: result.note, ...(result.failed.length ? { failed: result.failed } : {}), ...(box ? { world_bounds: roundBox(box) } : {}) };
    }

    case "export": {
      await host.settle();
      const format = a.format;
      let blob: Blob;
      if (format === "gizmocad") blob = new Blob([JSON.stringify(host.document(), null, 2)]);
      else if (format === "stl" || format === "step" || format === "3mf") blob = await host.export(format);
      else throw new Error(`Can't save as "${String(format)}".`);
      return { base64: await toBase64(blob) };
    }

    default:
      throw new Error(`GizmoCAD doesn't know the command "${method}" (the MCP server may be newer than this GizmoCAD: reload the page).`);
  }
}

const ADDABLE: ShapeKind[] = ["box", "cylinder", "sphere", "cone", "tube", "torus", "wedge", "pyramid", "prism", "hedron", "thread", "gear", "spring", "star", "text", "screw", "sketch", "group", "plane"];
const VIEWS = ["iso", "front", "back", "left", "right", "top", "bottom", "current"];

/** Allowed values for parameters that are a choice. */
const CHOICES: Record<string, (string | number)[]> = {
  "hedron.faces": [4, 6, 8, 12, 20],
  "text.font": BUILT_IN_FONTS.map((f) => f.key),
  "text.align": ["left", "center", "right"],
  "screw.size": ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10"],
  "screw.fit": ["tap", "close", "normal", "loose"],
  "screw.head": ["none", "counterbore", "countersink"],
  "spring.style": ["coil", "flat"],
  "spring.section": ["round", "square"],
  "spring.bends": ["round", "sharp"],
  "sketch.plane": ["XY", "XZ", "YZ"],
  "sketch.operation": ["flat", "extrude", "revolve"],
  "sketch.direction": ["normal", "reversed", "both"],
};

const findIn = (host: BridgeHost, id: string) => host.features().find((f) => f.id === id);

/** The object with this id (or, failing that, this exact name). */
function need(host: BridgeHost, idOrName: string): Feature {
  const f = findIn(host, idOrName) ?? host.features().find((x) => x.name === idOrName);
  if (!f) throw new Error(`There's no object "${idOrName}" (get_model lists them).`);
  return f;
}

function list(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error("Expected a list of object ids.");
  return v.map(String);
}

const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a number.`);
  return v;
};

function vec(v: unknown, current: Vec3, what: string): Vec3 {
  if (typeof v !== "object" || v === null) throw new Error(`${what} must be {x, y, z}.`);
  const o = v as Partial<Vec3>;
  return {
    x: o.x === undefined ? current.x : num(o.x, `${what}.x`),
    y: o.y === undefined ? current.y : num(o.y, `${what}.y`),
    z: o.z === undefined ? current.z : num(o.z, `${what}.z`),
  };
}

/** Apply a tool call's fields to a feature (in place), checking each. */
function applyFields(f: Feature, a: Args) {
  if (typeof a.name === "string" && a.name.trim()) f.name = a.name.trim();
  if (a.mode !== undefined) {
    if (a.mode !== "solid" && a.mode !== "hole") throw new Error('mode must be "solid" or "hole".');
    f.mode = a.mode;
  }
  if (a.position !== undefined) f.position = vec(a.position, f.position, "position");
  if (a.rotation !== undefined) f.rotation = vec(a.rotation, f.rotation, "rotation");
  if (a.color !== undefined) {
    if (a.color === null || a.color === "") delete f.color;
    else if (typeof a.color === "string" && /^#[0-9a-f]{6}$/i.test(a.color)) f.color = a.color.toLowerCase();
    else throw new Error('color must look like "#e05252".');
  }
  if (a.ignore_holes !== undefined) {
    const ids = a.ignore_holes as string[];
    if (!Array.isArray(ids)) throw new Error("ignore_holes is a list of hole ids ([] lets every hole cut it again).");
    if (ids.length) f.ignoreHoles = [...new Set(ids)];
    else delete f.ignoreHoles;
  }
  if (a.ghost !== undefined) {
    if (a.ghost) f.ghost = true;
    else delete f.ghost;
  }
  if (a.hidden !== undefined) {
    if (a.hidden) f.hidden = true;
    else delete f.hidden;
  }
  if (a.mirrored !== undefined) {
    if (a.mirrored) f.mirrored = true;
    else delete f.mirrored;
  }
  if (a.params !== undefined) applyParams(f, a.params);
  if (a.edges !== undefined) {
    if (!Array.isArray(a.edges)) throw new Error("edges must be a list.");
    if (a.edges.length && !FINISHABLE.includes(f.kind)) throw new Error(`A ${f.kind} can't have fillets, chamfers or bevels.`);
    f.edgeOps = a.edges.map((e: Args, i): EdgeOp => {
      const type = e.type;
      if (type !== "fillet" && type !== "chamfer" && type !== "bevel") throw new Error(`edges[${i}].type must be fillet, chamfer or bevel.`);
      const target = e.edges ?? "all";
      if (!["all", "top", "bottom", "vertical"].includes(target as string)) throw new Error(`edges[${i}].edges must be all, top, bottom or vertical.`);
      const size = num(e.size, `edges[${i}].size`);
      if (size <= 0) throw new Error(`edges[${i}].size must be above 0.`);
      const op: EdgeOp = { id: newId(), type, size, target: target as EdgeOp["target"], points: [] };
      if (type === "bevel") op.angle = Math.min(89, Math.max(1, e.angle === undefined ? 30 : num(e.angle, `edges[${i}].angle`)));
      return op;
    });
  }
  if (a.hollow !== undefined) {
    if (a.hollow === null) delete f.shell;
    else {
      const h = a.hollow as Args;
      const thickness = num(h.thickness, "hollow.thickness");
      if (thickness <= 0) throw new Error("hollow.thickness must be above 0.");
      const open = h.open ?? "top";
      if (open !== "none" && open !== "top" && open !== "bottom") throw new Error("hollow.open must be none, top or bottom.");
      f.shell = { thickness, open };
    }
  }
  if (a.texture !== undefined) {
    if (a.texture === null) delete f.texture;
    else {
      const t = a.texture as Args;
      const patterns = ["knurl", "ribs", "rings", "bumps", "honeycomb", "grid", "bricks", "waves", "wood", "rough"];
      if (!patterns.includes(t.pattern as string)) throw new Error(`texture.pattern must be one of: ${patterns.join(", ")}.`);
      const faces = t.faces ?? "sides";
      if (!["sides", "all", "top"].includes(faces as string)) throw new Error("texture.faces must be sides, all or top.");
      const wrap = t.wrap ?? "auto";
      if (!["auto", "around", "flat"].includes(wrap as string)) throw new Error("texture.wrap must be auto, around or flat.");
      const depth = t.depth === undefined ? 0.6 : num(t.depth, "texture.depth");
      const size = t.size === undefined ? 2 : num(t.size, "texture.size");
      if (depth <= 0 || size <= 0) throw new Error("texture.depth and texture.size must be above 0.");
      f.texture = { pattern: t.pattern as TexturePattern, depth: Math.min(depth, 10), size: Math.max(0.3, size), faces: faces as Texture["faces"], wrap: wrap as Texture["wrap"], raised: t.raised === true };
    }
  }
  if (a.tilt !== undefined) {
    if (a.tilt === null) delete f.tilt;
    else {
      const t = a.tilt as Args;
      const deg = (v: unknown, what: string) => (v === undefined ? 0 : Math.max(-60, Math.min(60, num(v, what))));
      const tilt = { taper: deg(t.taper, "tilt.taper"), leanX: deg(t.leanX, "tilt.leanX"), leanY: deg(t.leanY, "tilt.leanY") };
      if (tilt.taper || tilt.leanX || tilt.leanY) f.tilt = tilt;
      else delete f.tilt;
    }
  }
}

function applyParams(f: Feature, given: unknown) {
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error("params must be an object.");
  if (f.kind === "sculpt") throw new Error("Sculpted objects can't be edited this way.");
  if (f.kind === "imported") {
    const keys = Object.keys(given as Args);
    const scale = (given as Args).scale;
    const list = typeof scale === "number" ? [scale, scale, scale] : scale;
    if (keys.some((k) => k !== "scale") || !Array.isArray(list) || list.length !== 3 || !list.every((v) => typeof v === "number" && v > 0)) {
      throw new Error("An imported solid only has a scale: a number above 0 for all sides (1 = as imported), or [x, y, z]. Uneven scales turn its curves into small flat facets.");
    }
    f.params.scale = list as [number, number, number];
    return;
  }
  const params = f.params as unknown as Args;
  const next = { ...params };
  for (const [key, value] of Object.entries(given as Args)) {
    if (!(key in params) || key === "constraints") {
      const known = Object.keys(params).filter((k) => k !== "constraints");
      throw new Error(known.length ? `A ${f.kind} has no "${key}" parameter. Its parameters: ${known.join(", ")}.` : `A ${f.kind} has no parameters.`);
    }
    if (f.kind === "sketch" && key === "entities") {
      next.entities = sketchEntities(value);
      continue;
    }
    const choices = CHOICES[`${f.kind}.${key}`];
    if (choices) {
      if (!choices.includes(value as string | number)) throw new Error(`${f.kind} ${key} must be one of: ${choices.join(", ")}.`);
    } else if (typeof value !== typeof params[key]) {
      throw new Error(`${f.kind} ${key} must be a ${typeof params[key]}.`);
    } else if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${f.kind} ${key} must be a finite number.`);
    }
    next[key] = value;
  }
  (f as { params: unknown }).params = next;
  // Sketch constraints refer to the old drawing's shapes: a new drawing drops them.
  if (f.kind === "sketch" && "entities" in (given as Args)) delete f.params.constraints;
}

/** Sketch shapes from a tool call: each checked, with ids and defaults filled in. */
function sketchEntities(value: unknown): SketchEntity[] {
  if (!Array.isArray(value)) throw new Error("entities must be a list of shapes.");
  return value.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`entities[${i}] must be an object.`);
    const e = raw as Args;
    const at = `entities[${i}]`;
    const mode = e.mode ?? "add";
    if (mode !== "add" && mode !== "subtract" && mode !== "construction") throw new Error(`${at}.mode must be add, subtract or construction.`);
    const n = (key: string, d?: number) => (e[key] === undefined && d !== undefined ? d : num(e[key], `${at}.${key}`));
    const positive = (key: string) => {
      const v = n(key);
      if (v <= 0) throw new Error(`${at}.${key} must be above 0.`);
      return v;
    };
    const points = () => {
      if (!Array.isArray(e.points) || e.points.length < 3) throw new Error(`${at}.points needs at least 3 [u, v] points.`);
      return e.points.map((p, j) => {
        if (!Array.isArray(p) || p.length !== 2) throw new Error(`${at}.points[${j}] must be [u, v].`);
        return [num(p[0], `${at}.points[${j}][0]`), num(p[1], `${at}.points[${j}][1]`)] as [number, number];
      });
    };
    const base = { id: newId(), mode } as const;
    switch (e.type) {
      case "rect":
        return { ...base, type: "rect", x: n("x", 0), y: n("y", 0), width: positive("width"), height: positive("height"), angle: n("angle", 0), radius: n("radius", 0) };
      case "circle":
        return { ...base, type: "circle", x: n("x", 0), y: n("y", 0), radius: positive("radius") };
      case "ellipse":
        return { ...base, type: "ellipse", x: n("x", 0), y: n("y", 0), rx: positive("rx"), ry: positive("ry"), angle: n("angle", 0) };
      case "ngon": {
        const sides = Math.round(n("sides", 6));
        if (sides < 3 || sides > 64) throw new Error(`${at}.sides must be 3–64.`);
        return { ...base, type: "ngon", x: n("x", 0), y: n("y", 0), radius: positive("radius"), sides, angle: n("angle", 0) };
      }
      case "slot":
        return { ...base, type: "slot", x1: n("x1"), y1: n("y1"), x2: n("x2"), y2: n("y2"), radius: positive("radius") };
      case "polygon": {
        const pts = points();
        const bends = Array.isArray(e.bends) ? pts.map((_, j) => (e.bends as unknown[])[j] === undefined ? 0 : num((e.bends as unknown[])[j], `${at}.bends[${j}]`)) : pts.map(() => 0);
        return { ...base, type: "polygon", points: pts, bends };
      }
      case "spline":
        return { ...base, type: "spline", points: points() };
      case "line":
        return { ...base, type: "line", x1: n("x1"), y1: n("y1"), x2: n("x2"), y2: n("y2") };
      case "point":
        return { ...base, type: "point", x: n("x"), y: n("y") };
      default:
        throw new Error(`${at}.type must be rect, circle, ellipse, ngon, slot, polygon, spline, line or point.`);
    }
  });
}

/** After a change: wait for the rebuild, then say where things ended up and what went wrong. */
async function report(host: BridgeHost, ids: string[], result: Args): Promise<Args> {
  await host.settle();
  const errors = host.errors();
  const adjusted = host.adjusted();
  const out: Args = { ...result };
  const touched = new Set(ids.flatMap((id) => [...subtreeIds(host.features(), id)]));
  const errs = Object.entries(errors).filter(([id]) => touched.has(id));
  if (errs.length) out.build_errors = Object.fromEntries(errs.map(([id, msg]) => [findIn(host, id)?.name ?? id, msg]));
  const box = host.bounds(ids);
  if (box) out.world_bounds = roundBox(box);
  const shrunk: string[] = [];
  for (const id of ids)
    for (const op of findIn(host, id)?.edgeOps ?? [])
      if (adjusted[`${op.id}@angle`] !== undefined) shrunk.push(`bevel at ${op.angle}° didn't fit at ${op.size} mm, so it was made flatter: ${adjusted[`${op.id}@angle`]}°`);
      else if (adjusted[op.id] !== undefined) shrunk.push(adjusted[op.id] > 0 ? `${op.type} ${op.size} mm was too big for these edges; ${adjusted[op.id]} mm was used` : `${op.type} couldn't be applied to these edges at any size`);
  if (shrunk.length) out.notes = shrunk;
  return out;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0;
const roundBox = (b: { min: Vec3; max: Vec3 }) => ({
  min: { x: r3(b.min.x), y: r3(b.min.y), z: r3(b.min.z) },
  max: { x: r3(b.max.x), y: r3(b.max.y), z: r3(b.max.z) },
  size: { x: r3(b.max.x - b.min.x), y: r3(b.max.y - b.min.y), z: r3(b.max.z - b.min.z) },
});

function describeModel(host: BridgeHost, sketchGeometry: boolean) {
  const errors = host.errors();
  const objects = host.features().map((f) => {
    const o: Args = { id: f.id, name: f.name, kind: f.kind, mode: f.mode, parent: f.parentId, position: f.position, rotation: f.rotation };
    if (f.kind === "sculpt") o.params = "(a sculpted mesh)";
    else if (f.kind === "imported") o.params = { scale: f.params.scale, size: f.params.size.map((v, i) => r3(v * f.params.scale[i])), note: "an imported solid; only scale can change (a number, or [x, y, z])" };
    else if (f.kind === "sketch" && !sketchGeometry) {
      const { entities, constraints, ...rest } = f.params;
      o.params = { ...rest, entities: `${entities.length} shape(s): ${[...new Set(entities.map((e) => e.type))].join(", ") || "none"} (include_sketch_geometry for details)` };
      if (constraints?.length) o.constraints = constraints.length;
    } else o.params = f.params;
    if (f.edgeOps.length) o.edges = f.edgeOps.map((op) => ({ type: op.type, size: op.size, edges: op.target, ...(op.angle !== undefined ? { angle: op.angle } : {}) }));
    if (f.shell) o.hollow = f.shell;
    if (f.tilt) o.tilt = f.tilt;
    if (f.texture) o.texture = f.texture;
    if (f.color) o.color = f.color;
    if (f.mirrored) o.mirrored = true;
    if (f.hidden) o.hidden = true;
    if (f.ghost) o.ghost = true;
    if (f.ignoreHoles?.length) o.ignore_holes = f.ignoreHoles;
    if (f.suppressed) o.switched_off = true;
    if (f.joint) o.joint = f.joint.type;
    if (f.clips?.length) o.split_piece = true;
    const box = host.bounds([f.id]);
    if (box) o.world_bounds = roundBox(box);
    if (errors[f.id]) o.build_error = errors[f.id];
    return o;
  });
  const all = host.bounds(host.features().filter((f) => !f.parentId && f.mode === "solid").map((f) => f.id));
  return { objects, model_bounds: all ? roundBox(all) : null, units: "mm" };
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
