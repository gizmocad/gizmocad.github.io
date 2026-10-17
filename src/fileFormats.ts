// Other file formats: 3MF export (meshes with colours, for slicers), and STL
// and SVG import. Kept free of app state so they're easy to test.

import type { Point2, SketchEntity } from "./model";
import { bendPoint, simplify } from "./sketchGeometry";

// ---- 3MF ----------------------------------------------------------------------------

export interface MeshPart {
  name: string;
  /** "#rrggbb" */
  color: string;
  /** Flat xyz, world coordinates in mm. */
  vertices: Float32Array;
  triangles: Uint32Array;
}

const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** A 3MF file: each part a separate object with its own colour (slicers show and keep them apart). */
export function build3mf(parts: MeshPart[]): Blob {
  const n = (v: number) => String(Math.round(v * 1e5) / 1e5);
  const materials = parts.map((p) => `<base name="${xmlEscape(p.name)}" displaycolor="${p.color.toUpperCase()}FF"/>`).join("");
  const objects = parts
    .map((p, i) => {
      const verts: string[] = [];
      for (let k = 0; k < p.vertices.length; k += 3) verts.push(`<vertex x="${n(p.vertices[k])}" y="${n(p.vertices[k + 1])}" z="${n(p.vertices[k + 2])}"/>`);
      const tris: string[] = [];
      for (let k = 0; k < p.triangles.length; k += 3) tris.push(`<triangle v1="${p.triangles[k]}" v2="${p.triangles[k + 1]}" v3="${p.triangles[k + 2]}"/>`);
      return `<object id="${i + 2}" type="model" name="${xmlEscape(p.name)}" pid="1" pindex="${i}"><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`;
    })
    .join("");
  const items = parts.map((_, i) => `<item objectid="${i + 2}"/>`).join("");
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Application">GizmoCAD</metadata>` +
    `<resources><basematerials id="1">${materials}</basematerials>${objects}</resources><build>${items}</build></model>`;
  const types =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return zip([
    ["[Content_Types].xml", types],
    ["_rels/.rels", rels],
    ["3D/3dmodel.model", model],
  ]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive with the files stored uncompressed (3MF readers accept that). */
function zip(files: [string, string][]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, 0, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: "model/3mf" });
}

// ---- 3MF import ---------------------------------------------------------------------------

/** One printable part from a 3MF: its triangles in world millimetres (the file's build placement applied). */
export interface ImportedPart {
  name: string;
  /** "#rrggbb", if the file gives it one. */
  color?: string;
  vertices: Float32Array;
  triangles: Uint32Array;
}

export type ZipEntry = { method: number; raw: Uint8Array };

/** The files in a zip archive (read from its central directory; unpacked only when asked for). Names are lower-cased. */
export function readZip(buffer: ArrayBuffer, kind = "3MF"): Map<string, ZipEntry> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`it isn't a ${kind} file (${kind} files are zip archives).`);
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  if (p === 0xffffffff) throw new Error("it uses ZIP64 (over 4 GB), which isn't supported.");
  const names = new TextDecoder();
  const files = new Map<string, ZipEntry>();
  for (let k = 0; k < count; k++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("its zip directory is damaged.");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const local = view.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    files.set(name.replace(/^\//, "").toLowerCase(), { method, raw: bytes.subarray(dataAt, dataAt + size) });
  }
  return files;
}

export async function unzipEntry(e: ZipEntry): Promise<Uint8Array> {
  if (e.method === 0) return e.raw;
  if (e.method !== 8) throw new Error(`it uses zip compression method ${e.method}, which isn't supported.`);
  const stream = new Blob([e.raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A 3×4 affine transform as 3MF writes it: rows m00 m01 m02 / m10 m11 m12 / m20 m21 m22 / m30 m31 m32 (points are row vectors). */
type Affine = number[];
const IDENTITY: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseAffine = (s: string | null): Affine => {
  const v = (s ?? "").trim().split(/[\s,]+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
};
/** First `a`, then `b`. */
function compose(a: Affine, b: Affine): Affine {
  const out: number[] = [];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++) out.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0));
  return out;
}
const det = (m: Affine) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

const UNITS: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const PRODUCTION_NS = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";

/** The parts of a 3MF file (from slicers or other CAD): one per build item, with names and colours where given. */
export async function parse3mf(buffer: ArrayBuffer): Promise<ImportedPart[]> {
  const zip = readZip(buffer);
  const text = async (path: string) => {
    const e = zip.get(path.replace(/^\//, "").toLowerCase());
    return e ? new TextDecoder().decode(await unzipEntry(e)) : null;
  };
  // The main model is named in the package's relationships (usually 3D/3dmodel.model).
  let root = "3D/3dmodel.model";
  const rels = await text("_rels/.rels");
  const rel = rels && [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => /3dmodel/i.test(/Type="([^"]*)"/.exec(r)?.[1] ?? ""));
  if (rel) root = /Target="([^"]*)"/.exec(rel)?.[1] ?? root;

  const docs = new Map<string, Document>();
  const load = async (path: string): Promise<Document> => {
    const key = path.replace(/^\//, "").toLowerCase();
    let d = docs.get(key);
    if (!d) {
      const t = await text(key);
      if (t === null) throw new Error(`a model part it refers to (${path}) is missing.`);
      d = new DOMParser().parseFromString(t, "application/xml");
      if (d.getElementsByTagName("parsererror").length) throw new Error(`its model (${path}) isn't valid XML.`);
      docs.set(key, d);
    }
    return d;
  };
  const kids = (el: Element, name: string) => [...el.children].filter((c) => c.localName === name);
  const all = (el: Document | Element, name: string) => [...el.getElementsByTagNameNS("*", name)];
  const rootDoc = await load(root);
  const scale = UNITS[rootDoc.documentElement.getAttribute("unit") ?? "millimeter"] ?? 1;

  /** A colour from a material or colour group (pid) and its entry (pindex). */
  const colorOf = (doc: Document, pid: string | null, pindex: string | null): string | undefined => {
    if (!pid) return undefined;
    const group = [...all(doc, "basematerials"), ...all(doc, "colorgroup")].find((g) => g.getAttribute("id") === pid);
    if (!group) return undefined;
    const entry = [...group.children][Number(pindex ?? 0)];
    const c = entry?.getAttribute("displaycolor") ?? entry?.getAttribute("color");
    return c && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7).toLowerCase() : undefined;
  };

  type Found = { verts: number[]; tris: number[]; color?: string; name?: string };
  /** An object's triangles (its own mesh and its components'), placed by `m`. */
  const collect = async (path: string, id: string, m: Affine, out: Found, depth = 0): Promise<void> => {
    if (depth > 32) throw new Error("its components refer to each other in a loop.");
    const doc = await load(path);
    const obj = all(doc, "object").find((o) => o.getAttribute("id") === id);
    if (!obj) throw new Error(`object ${id} is missing.`);
    out.name ??= obj.getAttribute("name") ?? undefined;
    const mesh = kids(obj, "mesh")[0];
    if (mesh) {
      const base = out.verts.length / 3;
      const flip = det(m) < 0; // A mirroring placement turns the triangles inside out unless they're reversed.
      for (const v of all(kids(mesh, "vertices")[0] ?? mesh, "vertex")) {
        const [x, y, z] = ["x", "y", "z"].map((k) => Number(v.getAttribute(k)));
        out.verts.push(
          (x * m[0] + y * m[3] + z * m[6] + m[9]) * scale,
          (x * m[1] + y * m[4] + z * m[7] + m[10]) * scale,
          (x * m[2] + y * m[5] + z * m[8] + m[11]) * scale,
        );
      }
      const tris = all(kids(mesh, "triangles")[0] ?? mesh, "triangle");
      for (const t of tris) {
        const [a, b, c] = ["v1", "v2", "v3"].map((k) => base + Number(t.getAttribute(k)));
        out.tris.push(a, flip ? c : b, flip ? b : c);
      }
      out.color ??= colorOf(doc, obj.getAttribute("pid"), obj.getAttribute("pindex")) ?? colorOf(doc, tris[0]?.getAttribute("pid") ?? null, tris[0]?.getAttribute("p1") ?? null);
    }
    for (const comp of all(kids(obj, "components")[0] ?? document.createElement("x"), "component")) {
      const next = comp.getAttributeNS(PRODUCTION_NS, "path") ?? comp.getAttribute("p:path") ?? path;
      await collect(next, comp.getAttribute("objectid") ?? "", compose(parseAffine(comp.getAttribute("transform")), m), out, depth + 1);
    }
  };

  const parts: ImportedPart[] = [];
  const build = all(rootDoc, "build")[0];
  const items = build ? kids(build, "item") : [];
  for (const [i, item] of items.entries()) {
    const found: Found = { verts: [], tris: [] };
    await collect(item.getAttributeNS(PRODUCTION_NS, "path") ?? item.getAttribute("p:path") ?? root, item.getAttribute("objectid") ?? "", parseAffine(item.getAttribute("transform")), found);
    if (!found.tris.length) continue;
    const bad = found.tris.some((v) => v >= found.verts.length / 3 || v < 0 || !Number.isInteger(v));
    if (bad) throw new Error("a triangle refers to a corner that isn't there.");
    parts.push({ name: item.getAttribute("name") || found.name || `Part ${i + 1}`, color: found.color, vertices: new Float32Array(found.verts), triangles: new Uint32Array(found.tris) });
  }
  if (!parts.length) throw new Error("it has no parts to print in it.");
  return parts;
}

// ---- STL import ---------------------------------------------------------------------------

/** Triangles from a binary or ASCII STL (corners not shared yet). */
export function parseStl(buffer: ArrayBuffer): { vertices: Float32Array; triangles: Uint32Array } {
  const view = new DataView(buffer);
  const count = buffer.byteLength >= 84 ? view.getUint32(80, true) : 0;
  let vertices: Float32Array;
  if (buffer.byteLength === 84 + count * 50 && count > 0) {
    vertices = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
      const o = 84 + t * 50 + 12; // Skip the normal.
      for (let k = 0; k < 9; k++) vertices[t * 9 + k] = view.getFloat32(o + 4 * k, true);
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const nums: number[] = [];
    for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(+m[1], +m[2], +m[3]);
    if (!nums.length || nums.some((v) => !Number.isFinite(v))) throw new Error("This doesn't look like an STL file.");
    vertices = new Float32Array(nums);
  }
  const triangles = new Uint32Array(vertices.length / 3).map((_, i) => i);
  return { vertices, triangles };
}

// ---- SVG import ------------------------------------------------------------------------------

/**
 * Closed outlines from an SVG (paths and basic shapes, with their transforms),
 * as sketch polygons in mm with Y up, centred on the origin. Shapes inside an
 * odd number of others become cut-outs (like SVG's usual fill rule).
 */
export function svgToEntities(text: string, newId: () => string): SketchEntity[] {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) throw new Error("This doesn't look like an SVG file.");
  // Measure it in the page (the browser works out lengths and transforms).
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  const vb = svg.viewBox?.baseVal;
  // Without a size, the browser would squeeze it into 300×150; use the viewBox's own units.
  if (vb && vb.width && !svg.getAttribute("width")) svg.setAttribute("width", String(vb.width));
  if (vb && vb.height && !svg.getAttribute("height")) svg.setAttribute("height", String(vb.height));
  host.append(svg);
  document.body.append(host);
  try {
    const PX = 25.4 / 96; // CSS pixels → mm
    const rings: Point2[][] = [];
    const shapes = svg.querySelectorAll<SVGGeometryElement>("path, rect, circle, ellipse, polygon, polyline");
    for (const el of shapes) {
      if (el.closest("defs, clipPath, mask, symbol")) continue;
      const ctm = el.getCTM();
      if (!ctm) continue;
      const pieces = el instanceof SVGPathElement ? splitSubpaths(el.getAttribute("d") ?? "").map((d) => {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", d);
        el.parentNode!.insertBefore(p, el);
        return p;
      }) : [el];
      for (const piece of pieces) {
        const length = piece.getTotalLength();
        if (length > 0) {
          const scale = Math.hypot(ctm.a, ctm.b) * PX; // mm per user unit, roughly
          const step = Math.max(0.05 / Math.max(scale, 1e-9), length / 3000);
          const pts: Point2[] = [];
          for (let s = 0; s <= length; s += step) {
            const q = piece.getPointAtLength(s);
            pts.push([(ctm.a * q.x + ctm.c * q.y + ctm.e) * PX, -(ctm.b * q.x + ctm.d * q.y + ctm.f) * PX]);
          }
          const ring = simplify(pts, 0.02);
          if (ring.length > 2 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-6) ring.pop();
          if (ring.length >= 3 && Math.abs(area(ring)) > 1e-4) rings.push(ring);
        }
        if (piece !== el) piece.remove();
      }
    }
    if (!rings.length) throw new Error("No closed shapes found in this SVG.");
    return outlinesToEntities(rings.map((points) => ({ points })), newId);
  } finally {
    host.remove();
  }
}

/** A closed outline from a drawing: corners, optionally with arcs (see the polygon's `bends`), or an exact circle. */
export interface Outline {
  points: Point2[];
  bends?: number[];
  circle?: { x: number; y: number; r: number };
}

/**
 * Closed outlines as sketch shapes, centred on the origin. Shapes inside an odd
 * number of others become cut-outs (like the usual even-odd fill rule).
 */
export function outlinesToEntities(outlines: Outline[], newId: () => string): SketchEntity[] {
  const xs = outlines.flatMap((o) => o.points.map((p) => p[0]));
  const ys = outlines.flatMap((o) => o.points.map((p) => p[1]));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
  const rings = outlines.map((o) => o.points.map(([x, y]) => [r4(x - cx), r4(y - cy)] as Point2));
  // For telling what's inside what, arcs count by their middles too (two arcs can make a whole round end).
  const filled = rings.map((ring, i) => ring.flatMap((a, k) => (outlines[i].bends?.[k] ? [a, bendPoint(a, ring[(k + 1) % ring.length], outlines[i].bends![k])] : [a])));
  const areas = filled.map((ring) => Math.abs(area(ring)));
  return outlines.map((o, i) => {
    const depth = filled.filter((other, j) => j !== i && areas[j] > areas[i] && inside(filled[i][0], other)).length;
    const mode = depth % 2 ? "subtract" : "add";
    if (o.circle) return { id: newId(), mode, type: "circle", x: r4(o.circle.x - cx), y: r4(o.circle.y - cy), radius: r4(o.circle.r) } as SketchEntity;
    return { id: newId(), mode, type: "polygon", points: rings[i], bends: o.bends?.map(r4) ?? rings[i].map(() => 0) } as SketchEntity;
  });
}

function area(ring: Point2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function inside(p: Point2, ring: Point2[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Split path data into one string per subpath, each starting with an absolute
 * M (a relative "m" depends on where the previous subpath ended, so we track it).
 */
function splitSubpaths(d: string): string[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let cur: string[] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;
  const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  let cmd = "";
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const lower = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase();
    const n = ARGS[lower];
    if (n === undefined) break;
    const args = tokens.slice(i, i + n).map(Number);
    i += n;
    if (lower === "m") {
      if (cur.length) out.push(cur.join(" "));
      x = rel ? x + args[0] : args[0];
      y = rel ? y + args[1] : args[1];
      [sx, sy] = [x, y];
      cur = [`M ${x} ${y}`];
      cmd = rel ? "l" : "L"; // Further pairs are line-tos.
      continue;
    }
    if (lower === "z") {
      cur.push("Z");
      [x, y] = [sx, sy];
      continue;
    }
    cur.push(`${cmd} ${args.join(" ")}`);
    if (lower === "h") x = rel ? x + args[0] : args[0];
    else if (lower === "v") y = rel ? y + args[0] : args[0];
    else {
      x = rel ? x + args[n - 2] : args[n - 2];
      y = rel ? y + args[n - 1] : args[n - 1];
    }
    if (n === 0) break;
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

// ---- Autosave -----------------------------------------------------------------------------------

const DB = "gizmocad";
const STORE = "autosave";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Keep a copy of the document in the browser (IndexedDB holds big sculpts that localStorage can't). */
export async function autosave(json: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ json, at: Date.now() }, "doc");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadAutosave(): Promise<{ json: string; at: number } | null> {
  const db = await openDb();
  const value = await new Promise<{ json: string; at: number } | null>((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get("doc");
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}
