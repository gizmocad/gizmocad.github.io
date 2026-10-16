// Other file formats: 3MF export (meshes with colours, for slicers), and STL
// and SVG import. Kept free of app state so they're easy to test.

import type { Point2, SketchEntity } from "./model";
import { simplify } from "./sketchGeometry";

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
    // Centre the drawing on the origin.
    const xs = rings.flat().map((p) => p[0]);
    const ys = rings.flat().map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
    const centred = rings.map((ring) => ring.map(([x, y]) => [r4(x - cx), r4(y - cy)] as Point2));
    return centred.map((ring, i) => {
      const depth = centred.filter((other, j) => j !== i && Math.abs(area(other)) > Math.abs(area(ring)) && inside(ring[0], other)).length;
      return { id: newId(), mode: depth % 2 ? "subtract" : "add", type: "polygon", points: ring, bends: ring.map(() => 0) } as SketchEntity;
    });
  } finally {
    host.remove();
  }
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
