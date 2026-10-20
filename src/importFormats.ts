// Reading other programs' files: meshes (OBJ, OFF, PLY, glTF/GLB), 2D drawings
// (DXF) and FreeCAD documents (whose shapes the kernel then reads). Kept free
// of app state so they're easy to test.

import { BufferGeometry, Euler, LoadingManager, Matrix4, Quaternion, Vector3, type Mesh, type Object3D } from "three";
import type { ImportSource } from "./kernel";
import { readZip, unzipEntry, type ImportedPart, type Outline } from "./fileFormats";
import type { Point2, SketchEntity, Vec3 } from "./model";

/** A picked file: its name and bytes. */
export interface PickedFile {
  name: string;
  data: ArrayBuffer;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** The file's name without its folder or extension. */
export const stem = (name: string) => baseName(name).replace(/\.[^.]+$/, "");
/** Another picked file by name (ignoring folders and case): what an OBJ's .mtl or a glTF's .bin is found by. */
function findFile(files: PickedFile[], ref: string): PickedFile | undefined {
  let want = ref;
  try {
    want = decodeURIComponent(ref);
  } catch {
    // Not URI-encoded.
  }
  want = baseName(want).toLowerCase();
  return files.find((f) => baseName(f.name).toLowerCase() === want);
}
const text = (data: ArrayBuffer) => new TextDecoder().decode(data);
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;

/** A part from corner indices into a shared corner list, keeping only the corners it uses. */
function compact(name: string, color: string | undefined, verts: ArrayLike<number>, tris: number[]): ImportedPart {
  const count = verts.length / 3;
  const remap = new Map<number, number>();
  const out: number[] = [];
  const triangles = new Uint32Array(tris.length);
  tris.forEach((v, i) => {
    if (!Number.isInteger(v) || v < 0 || v >= count) throw new Error("a face refers to a corner that isn't there.");
    let n = remap.get(v);
    if (n === undefined) {
      n = remap.size;
      remap.set(v, n);
      out.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
    }
    triangles[i] = n;
  });
  return { name, color, vertices: new Float32Array(out), triangles };
}

// ---- OBJ ---------------------------------------------------------------------------------

/** Material colours (diffuse) from an .mtl file. */
function parseMtl(source: string): Map<string, string> {
  const colors = new Map<string, string>();
  let current = "";
  for (const raw of source.split(/\r?\n/)) {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    if (cmd === "newmtl") current = rest.join(" ");
    else if (cmd === "Kd" && current && rest.length >= 3) colors.set(current, hex(+rest[0], +rest[1], +rest[2]));
  }
  return colors;
}

/** An OBJ's objects/groups as parts; colours come from its .mtl if that was picked too. */
export function parseObj(file: PickedFile, others: PickedFile[]): ImportedPart[] {
  const source = text(file.data);
  const colors = new Map<string, string>();
  for (const m of source.matchAll(/^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/gm)) {
    const mtl = findFile(others, m[1]);
    if (mtl) for (const [k, v] of parseMtl(text(mtl.data))) colors.set(k, v);
  }
  const verts: number[] = [];
  type Part = { name: string; color?: string; tris: number[]; by?: string };
  const parts: Part[] = [];
  let material: string | undefined;
  let current: Part = { name: stem(file.name), tris: [] };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const [cmd, ...rest] = line.split(/\s+/);
    if (cmd === "v") verts.push(+rest[0], +rest[1], +rest[2]);
    else if ((cmd === "o" || cmd === "g") && rest.length) {
      const name = rest.join(" ");
      if (!current.tris.length) {
        // Nothing in it yet: just name it (an object's name wins over a group's).
        if (!(cmd === "g" && current.by === "o")) Object.assign(current, { name, by: cmd });
        continue;
      }
      parts.push(current);
      current = { name, tris: [], color: material && colors.get(material), by: cmd };
    } else if (cmd === "usemtl") {
      material = rest.join(" ");
      // A part takes the material its first faces use.
      if (!current.tris.length) current.color = colors.get(material) ?? current.color;
    } else if (cmd === "f") {
      const count = verts.length / 3;
      const ids = rest.map((t) => {
        const i = parseInt(t, 10);
        return i < 0 ? count + i : i - 1;
      });
      for (let k = 1; k + 1 < ids.length; k++) current.tris.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  if (current.tris.length) parts.push(current);
  if (verts.some((v) => !Number.isFinite(v))) throw new Error("some of its corners aren't numbers.");
  if (!parts.length) throw new Error("it has no faces (only points or lines).");
  return parts.map((p) => compact(p.name, p.color, verts, p.tris));
}

// ---- OFF ---------------------------------------------------------------------------------

/** An OFF mesh (Geomview's Object File Format), as one part. */
export function parseOff(file: PickedFile): ImportedPart[] {
  const lines = text(file.data)
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
  const head = /^(ST)?(C)?(N)?(4)?OFF\b/i.exec(lines[0] ?? "");
  if (!head) throw new Error("it doesn't start with OFF, so it isn't an OFF file.");
  if (head[4]) throw new Error("it's a 4D OFF file, which isn't supported.");
  // The counts can share the header's line.
  const afterHead = lines[0].slice(head[0].length).trim();
  let at = afterHead ? 0 : 1;
  const counts = (afterHead || lines[1] || "").split(/\s+/).map(Number);
  at += 1;
  const [nv, nf] = counts;
  if (!Number.isInteger(nv) || !Number.isInteger(nf)) throw new Error("its vertex and face counts are missing.");
  const verts: number[] = [];
  for (let i = 0; i < nv; i++) {
    const v = (lines[at + i] ?? "").split(/\s+/).map(Number);
    verts.push(v[0], v[1], v[2]);
  }
  at += nv;
  const tris: number[] = [];
  for (let i = 0; i < nf; i++) {
    const v = (lines[at + i] ?? "").split(/\s+/).map(Number);
    const n = v[0];
    for (let k = 2; k < n; k++) tris.push(v[1], v[k], v[k + 1]);
  }
  if (verts.some((v) => !Number.isFinite(v))) throw new Error("some of its corners aren't numbers.");
  if (!tris.length) throw new Error("it has no faces.");
  return [compact(stem(file.name), undefined, verts, tris)];
}

// ---- Through three.js's loaders: PLY and glTF ---------------------------------------------

/** A three.js mesh's triangles, placed by `m` (and its corners mapped by `map`). */
function meshPart(name: string, color: string | undefined, geo: BufferGeometry, m: Matrix4, map: (v: Vector3) => [number, number, number]): ImportedPart | null {
  const pos = geo.getAttribute("position");
  if (!pos) return null;
  const v = new Vector3();
  const vertices = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) vertices.set(map(v.fromBufferAttribute(pos, i).applyMatrix4(m)), i * 3);
  const index = geo.index ? Array.from(geo.index.array) : Array.from({ length: pos.count }, (_, i) => i);
  const triangles = new Uint32Array(index.length - (index.length % 3));
  const flip = m.determinant() < 0; // A mirroring placement turns the triangles inside out unless they're reversed.
  for (let i = 0; i < triangles.length; i += 3) {
    triangles[i] = index[i];
    triangles[i + 1] = index[flip ? i + 2 : i + 1];
    triangles[i + 2] = index[flip ? i + 1 : i + 2];
  }
  return triangles.length ? { name, color, vertices, triangles } : null;
}

/** A PLY mesh (ASCII or binary), as one part. */
export async function parsePly(file: PickedFile): Promise<ImportedPart[]> {
  if (!text(file.data.slice(0, 3)).startsWith("ply")) throw new Error("it doesn't start with \"ply\", so it isn't a PLY file.");
  const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
  const geo = new PLYLoader().parse(file.data);
  if (!geo.index) throw new Error("it has no faces (it's a point cloud).");
  const part = meshPart(stem(file.name), undefined, geo, new Matrix4(), (v) => [v.x, v.y, v.z]);
  if (!part) throw new Error("it has no faces.");
  return [part];
}

// A 1×1 transparent PNG, for textures we don't need.
const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** A glTF/GLB scene's meshes as parts (glTF is in metres with Y up; these come out in mm with Z up). */
export async function parseGltf(file: PickedFile, others: PickedFile[]): Promise<ImportedPart[]> {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const urls: string[] = [];
  const missing = new Set<string>();
  const manager = new LoadingManager();
  // A .gltf's buffers are separate files: they come from the other picked files.
  manager.setURLModifier((url) => {
    if (/^(data|blob):/.test(url)) return url;
    const found = findFile(others, url);
    if (found) {
      const u = URL.createObjectURL(new Blob([found.data]));
      urls.push(u);
      return u;
    }
    if (/\.(png|jpe?g|webp|ktx2|gif|bmp)$/i.test(url)) return BLANK_PNG; // Textures aren't used.
    missing.add(baseName(url));
    return "data:application/octet-stream;base64,";
  });
  try {
    const gltf = await new GLTFLoader(manager).parseAsync(file.data, "").catch((err: unknown) => {
      if (missing.size) throw new Error(`it needs ${[...missing].join(", ")}: pick ${missing.size === 1 ? "that file" : "those files"} together with it.`);
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(/draco/i.test(why) ? "it uses Draco compression, which isn't supported. Export it without compression." : why);
    });
    const parts: ImportedPart[] = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o: Object3D) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const c = (material as { color?: { getHexString(): string } } | undefined)?.color;
      const name = mesh.name || mesh.parent?.name || stem(file.name);
      const part = meshPart(name, c ? `#${c.getHexString()}` : undefined, mesh.geometry, mesh.matrixWorld, (v) => [v.x * 1000, -v.z * 1000, v.y * 1000]);
      if (part) parts.push(part);
    });
    if (!parts.length) throw new Error("it has no meshes.");
    return parts;
  } finally {
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}

// ---- DXF ---------------------------------------------------------------------------------

type P = Point2;
/** An open or closed run of straight lines and arcs: `vias[k]` is the middle of the arc from point k to k+1 (null: straight). */
type Piece = { points: P[]; vias: (P | null)[]; closed: boolean };
type Circle = { c: P; r: number };
/** 2D affine map: x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Affine2 = [number, number, number, number, number, number];
const IDENTITY2: Affine2 = [1, 0, 0, 1, 0, 0];
const apply = (m: Affine2, [x, y]: P): P => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** First `inner`, then `outer`. */
const then = (outer: Affine2, inner: Affine2): Affine2 => [
  outer[0] * inner[0] + outer[2] * inner[1],
  outer[1] * inner[0] + outer[3] * inner[1],
  outer[0] * inner[2] + outer[2] * inner[3],
  outer[1] * inner[2] + outer[3] * inner[3],
  outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
  outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
];

/** DXF $INSUNITS → mm. Unitless drawings are taken as mm. */
const DXF_UNITS: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 25.4e-6, 9: 0.0254, 10: 914.4, 14: 100 };

type Entity = { type: string; codes: [number, string][] };

/** The drawing's closed outlines (lines and arcs joined end to end, circles, closed polylines, ellipses and splines) in mm. */
export function parseDxf(file: PickedFile): { outlines: Outline[]; open: number } {
  const source = text(file.data);
  if (source.startsWith("AutoCAD Binary DXF")) throw new Error("it's a binary DXF; save it as an ASCII DXF instead.");
  const lines = source.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) throw new Error("it isn't a DXF file (or it's damaged).");
    pairs.push([code, lines[i + 1].trim()]);
  }
  if (!pairs.some(([c, v]) => c === 0 && v === "SECTION")) throw new Error("it isn't a DXF file.");

  // Sections: the header's units, block definitions and the drawing's entities.
  let unit = 1;
  const blocks = new Map<string, { base: P; entities: Entity[] }>();
  const entities: Entity[] = [];
  let section = "";
  let block: { name: string; base: P; entities: Entity[] } | null = null;
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0 && value === "SECTION") {
      section = pairs[i + 1]?.[0] === 2 ? pairs[i + 1][1] : "";
      continue;
    }
    if (section === "HEADER" && code === 9 && value === "$INSUNITS") unit = DXF_UNITS[parseInt(pairs[i + 1]?.[1] ?? "0", 10)] ?? 1;
    if ((section !== "ENTITIES" && section !== "BLOCKS") || code !== 0) continue;
    // An entity: its codes until the next 0.
    const e: Entity = { type: value, codes: [] };
    for (let k = i + 1; k < pairs.length && pairs[k][0] !== 0; k++) e.codes.push(pairs[k]);
    if (value === "BLOCK") {
      const num = (c: number) => Number(e.codes.find(([k]) => k === c)?.[1] ?? 0);
      block = { name: e.codes.find(([k]) => k === 2)?.[1] ?? "", base: [num(10), num(20)], entities: [] };
    } else if (value === "ENDBLK") {
      if (block) blocks.set(block.name, block);
      block = null;
    } else if (section === "BLOCKS") block?.entities.push(e);
    else entities.push(e);
  }

  const pieces: Piece[] = [];
  const circles: Circle[] = [];
  const add = (list: Entity[], m: Affine2, depth: number) => {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const num = (c: number, d = 0) => {
        const v = e.codes.find(([k]) => k === c);
        return v ? Number(v[1]) : d;
      };
      if (num(67) === 1) continue; // Paper space (title blocks, layouts).
      // Arcs, circles and polylines are drawn in their own plane; seen from below, X is mirrored.
      const ocs: Affine2 = num(230, 1) < 0 ? then(m, [-1, 0, 0, 1, 0, 0]) : m;
      const at = (mm: Affine2, p: P) => apply(mm, p);
      switch (e.type) {
        case "LINE":
          pieces.push({ points: [at(m, [num(10), num(20)]), at(m, [num(11), num(21)])], vias: [null], closed: false });
          break;
        case "CIRCLE": {
          const scale = Math.sqrt(Math.abs(ocs[0] * ocs[3] - ocs[1] * ocs[2]));
          circles.push({ c: at(ocs, [num(10), num(20)]), r: num(40) * scale });
          break;
        }
        case "ARC": {
          const [cx, cy, r] = [num(10), num(20), num(40)];
          let [a0, a1] = [num(50), num(51)].map((d) => (d * Math.PI) / 180);
          while (a1 <= a0) a1 += 2 * Math.PI;
          const pt = (a: number): P => at(ocs, [cx + r * Math.cos(a), cy + r * Math.sin(a)]);
          if (a1 - a0 > 2 * Math.PI - 1e-9) circles.push({ c: at(ocs, [cx, cy]), r: r * Math.sqrt(Math.abs(ocs[0] * ocs[3] - ocs[1] * ocs[2])) });
          else pieces.push({ points: [pt(a0), pt(a1)], vias: [pt((a0 + a1) / 2)], closed: false });
          break;
        }
        case "LWPOLYLINE": {
          const verts: { p: P; bulge: number }[] = [];
          for (const [k, v] of e.codes) {
            if (k === 10) verts.push({ p: [Number(v), 0], bulge: 0 });
            else if (k === 20 && verts.length) verts[verts.length - 1].p[1] = Number(v);
            else if (k === 42 && verts.length) verts[verts.length - 1].bulge = Number(v);
          }
          const piece = bulgePiece(verts, (num(70) & 1) === 1);
          if (piece) pieces.push(mapPiece(piece, ocs));
          break;
        }
        case "POLYLINE": {
          // Its corners follow as VERTEX entities until SEQEND.
          const flags = num(70);
          const verts: { p: P; bulge: number }[] = [];
          for (i++; i < list.length && list[i].type === "VERTEX"; i++) {
            const v = list[i].codes;
            const get = (c: number) => Number(v.find(([k]) => k === c)?.[1] ?? 0);
            if (get(70) & 16) continue; // A spline's frame point, not on the curve.
            verts.push({ p: [get(10), get(20)], bulge: get(42) });
          }
          if (flags & (16 | 64)) break; // Polygon and polyface meshes are 3D surfaces.
          const piece = bulgePiece(verts, (flags & 1) === 1);
          if (piece) pieces.push(mapPiece(piece, flags & 8 ? m : ocs)); // 3D polylines are in world coordinates.
          break;
        }
        case "ELLIPSE": {
          const c: P = [num(10), num(20)];
          const major: P = [num(11), num(21)];
          const ratio = num(40, 1);
          const sign = num(230, 1) < 0 ? -1 : 1;
          const minor: P = [-major[1] * ratio * sign, major[0] * ratio * sign];
          const [t0, t1raw] = [num(41, 0), num(42, 2 * Math.PI)];
          let t1 = t1raw;
          while (t1 <= t0) t1 += 2 * Math.PI;
          const full = t1 - t0 > 2 * Math.PI - 1e-6;
          const n = Math.max(8, Math.ceil(((t1 - t0) / (2 * Math.PI)) * 96));
          const pts: P[] = [];
          for (let k = 0; k <= (full ? n - 1 : n); k++) {
            const t = t0 + ((t1 - t0) * k) / n;
            pts.push(at(m, [c[0] + major[0] * Math.cos(t) + minor[0] * Math.sin(t), c[1] + major[1] * Math.cos(t) + minor[1] * Math.sin(t)]));
          }
          pieces.push({ points: pts, vias: pts.map(() => null), closed: full });
          break;
        }
        case "SPLINE": {
          const pts = splinePoints(e.codes, num(70), num(71, 3));
          if (pts.length < 2) break;
          const closed = (num(70) & 1) === 1 || dist(pts[0], pts[pts.length - 1]) < 1e-9;
          if (closed && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
          const placed = pts.map((p) => at(m, p));
          pieces.push({ points: placed, vias: placed.map(() => null), closed });
          break;
        }
        case "SOLID":
        case "TRACE": {
          // A filled triangle or quad (corners 3 and 4 are swapped in DXF's order).
          const q: P[] = [[num(10), num(20)], [num(11), num(21)], [num(13), num(23)], [num(12), num(22)]].map((p) => at(ocs, p as P));
          if (dist(q[2], q[3]) < 1e-12) q.pop();
          pieces.push({ points: q, vias: q.map(() => null), closed: true });
          break;
        }
        case "INSERT": {
          const b = blocks.get(e.codes.find(([k]) => k === 2)?.[1] ?? "");
          if (!b || depth > 16) break;
          const [sx, sy] = [num(41, 1), num(42, 1)];
          const rot = (num(50) * Math.PI) / 180;
          const [cols, rows] = [Math.max(1, num(70, 1)), Math.max(1, num(71, 1))];
          const [dc, dr] = [num(44), num(45)];
          for (let r = 0; r < rows; r++)
            for (let col = 0; col < cols; col++) {
              const [cs, sn] = [Math.cos(rot), Math.sin(rot)];
              // Block base to origin, scale, place the grid copy, turn, then move to the insertion point.
              const local: Affine2 = then([cs, sn, -sn, cs, num(10), num(20)], then([1, 0, 0, 1, col * dc, r * dr], [sx, 0, 0, sy, -b.base[0] * sx, -b.base[1] * sy]));
              add(b.entities, then(ocs, local), depth + 1);
            }
          break;
        }
      }
    }
  };
  add(entities, IDENTITY2, 0);

  // Join loose lines and arcs end to end into closed loops.
  const pts = [...pieces.flatMap((p) => p.points), ...circles.flatMap((c) => [[c.c[0] - c.r, c.c[1] - c.r] as P, [c.c[0] + c.r, c.c[1] + c.r] as P])];
  if (!pts.length) throw new Error("it has no lines, arcs or shapes in it.");
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const tol = Math.max(size * 1e-5, 1e-9);
  const loops: Piece[] = pieces.filter((p) => p.closed || (p.points.length > 2 && dist(p.points[0], p.points[p.points.length - 1]) <= tol));
  for (const p of loops) {
    if (!p.closed) {
      // Ends on its start: drop the repeated corner (its last segment becomes the closing one).
      p.points.pop();
      p.closed = true;
    }
  }
  const loose = pieces.filter((p) => !loops.includes(p));
  const used = new Set<Piece>();
  let open = 0;
  for (const first of loose) {
    if (used.has(first)) continue;
    used.add(first);
    const chain: Piece = { points: [...first.points], vias: [...first.vias], closed: false };
    for (;;) {
      const end = chain.points[chain.points.length - 1];
      if (chain.points.length > 2 && dist(end, chain.points[0]) <= tol) {
        chain.points.pop();
        chain.closed = true;
        break;
      }
      const next = loose.find((p) => !used.has(p) && (dist(p.points[0], end) <= tol || dist(p.points[p.points.length - 1], end) <= tol));
      if (!next) break;
      used.add(next);
      const forward = dist(next.points[0], end) <= tol;
      const pts2 = forward ? next.points : [...next.points].reverse();
      const vias = forward ? next.vias : [...next.vias].reverse();
      chain.points.push(...pts2.slice(1));
      chain.vias.push(...vias);
    }
    if (chain.closed) loops.push(chain);
    else open++;
  }

  const outlines: Outline[] = [];
  const s = (p: P): P => [p[0] * unit, p[1] * unit];
  for (const c of circles) {
    if (c.r <= 0) continue;
    const ring = Array.from({ length: 48 }, (_, k) => s([c.c[0] + c.r * Math.cos((k * Math.PI) / 24), c.c[1] + c.r * Math.sin((k * Math.PI) / 24)]));
    outlines.push({ points: ring, circle: { x: c.c[0] * unit, y: c.c[1] * unit, r: c.r * unit } });
  }
  for (const loop of loops) {
    const points = loop.points.map(s);
    if (points.length < 2) continue;
    const bends = points.map((a, k) => {
      const via = loop.vias[k];
      if (!via) return 0;
      const b = points[(k + 1) % points.length];
      const v = s(via);
      const d: P = [b[0] - a[0], b[1] - a[1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      // Signed distance of the arc's middle from its chord, to the left of travel (the polygon's `bends`).
      return ((v[0] - (a[0] + b[0]) / 2) * -d[1] + (v[1] - (a[1] + b[1]) / 2) * d[0]) / l;
    });
    if (points.length === 2 && !bends.some((b) => b)) continue;
    outlines.push({ points, bends });
  }
  if (!outlines.length) throw new Error(open ? "none of its lines join up into closed shapes." : "it has no closed shapes in it.");
  return { outlines, open };
}

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Polyline corners with DXF bulges (tan of a quarter of each arc's angle; + is counter-clockwise). */
function bulgePiece(verts: { p: P; bulge: number }[], closed: boolean): Piece | null {
  if (verts.length < 2) return null;
  const points = verts.map((v) => v.p);
  const vias = verts.slice(0, closed ? verts.length : verts.length - 1).map((v, k) => {
    if (!v.bulge) return null;
    const a = v.p;
    const b = verts[(k + 1) % verts.length].p;
    const l = dist(a, b);
    if (l < 1e-12) return null;
    // The arc's middle sits off the chord's middle by bulge·l/2, to the right for counter-clockwise.
    const sag = (v.bulge * l) / 2;
    return [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / l) * sag, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / l) * sag] as P;
  });
  return { points, vias, closed };
}

function mapPiece(p: Piece, m: Affine2): Piece {
  return { points: p.points.map((q) => apply(m, q)), vias: p.vias.map((v) => (v ? apply(m, v) : null)), closed: p.closed };
}

/** Points along a DXF spline: evaluated from its control points (rational too), or its fit points if that's all it has. */
function splinePoints(codes: [number, string][], flags: number, degree: number): P[] {
  const knots: number[] = [];
  const weights: number[] = [];
  const ctrl: P[] = [];
  const fit: P[] = [];
  for (const [k, v] of codes) {
    if (k === 40) knots.push(Number(v));
    else if (k === 41) weights.push(Number(v));
    else if (k === 10) ctrl.push([Number(v), 0]);
    else if (k === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = Number(v);
    else if (k === 11) fit.push([Number(v), 0]);
    else if (k === 21 && fit.length) fit[fit.length - 1][1] = Number(v);
  }
  const n = ctrl.length;
  const p = degree;
  if (n <= p || knots.length !== n + p + 1) return fit;
  const w = weights.length === n && flags & 4 ? weights : ctrl.map(() => 1);
  const [t0, t1] = [knots[p], knots[n]];
  const samples = Math.min(4000, Math.max(32, n * 12));
  const out: P[] = [];
  for (let s = 0; s <= samples; s++) {
    const t = Math.min(t0 + ((t1 - t0) * s) / samples, t1 - 1e-12 * Math.max(1, Math.abs(t1)));
    // de Boor's algorithm in homogeneous coordinates.
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = Array.from({ length: p + 1 }, (_, j) => {
      const c = ctrl[k - p + j];
      const wt = w[k - p + j];
      return [c[0] * wt, c[1] * wt, wt];
    });
    for (let r = 1; r <= p; r++)
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = knots[i + p - r + 1] - knots[i];
        const a = den > 0 ? (t - knots[i]) / den : 0;
        d[j] = d[j].map((v, q) => (1 - a) * d[j - 1][q] + a * v);
      }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}

// ---- FreeCAD -----------------------------------------------------------------------------

/** Each visible solid object in a FreeCAD document, with its label, colour and the Part containers it sits in. */
export async function parseFcstd(file: PickedFile): Promise<{ sources: ImportSource[]; skipped: number }> {
  const zip = readZip(file.data, "FreeCAD");
  const read = async (name: string) => {
    const e = zip.get(name.toLowerCase());
    return e ? unzipEntry(e) : null;
  };
  const xml = async (name: string) => {
    const bytes = await read(name);
    if (!bytes) return null;
    const d = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
    return d.getElementsByTagName("parsererror").length ? null : d;
  };
  const doc = await xml("Document.xml");
  if (!doc) throw new Error("it has no readable Document.xml, so it isn't a FreeCAD document.");
  const gui = await xml("GuiDocument.xml");

  const kids = (el: Element | null | undefined, tag: string) => (el ? [...el.children].filter((c) => c.tagName === tag) : []);
  const types = new Map(kids(doc.querySelector("Objects"), "Object").map((o) => [o.getAttribute("name") ?? "", o.getAttribute("type") ?? ""]));
  const props = (holder: Element | undefined) => new Map(kids(kids(holder, "Properties")[0], "Property").map((p) => [p.getAttribute("name") ?? "", p]));
  const data = new Map(kids(doc.querySelector("ObjectData"), "Object").map((o) => [o.getAttribute("name") ?? "", props(o)]));
  const views = new Map(kids(gui?.querySelector("ViewProviderData"), "ViewProvider").map((o) => [o.getAttribute("name") ?? "", props(o)]));

  const parentOf = new Map<string, string>();
  for (const [name, p] of data) for (const link of p.get("Group")?.querySelectorAll("Link") ?? []) parentOf.set(link.getAttribute("value") ?? "", name);
  const visible = (name: string) => {
    const v = data.get(name)?.get("Visibility") ?? views.get(name)?.get("Visibility");
    return v?.querySelector("Bool")?.getAttribute("value") !== "false";
  };

  const sources: ImportSource[] = [];
  let skipped = 0;
  for (const [name, p] of data) {
    const type = types.get(name) ?? "";
    const shapeFile = p.get("Shape")?.querySelector("Part")?.getAttribute("file");
    if (!shapeFile || !visible(name) || /^Sketcher::|Part2DObject|^App::(Origin|Line|Plane|Point)/.test(type)) continue;
    // A body's features are shown through the body's own shape.
    const parent = parentOf.get(name);
    if (parent && types.get(parent) === "PartDesign::Body") continue;
    // Part containers move what's in them; a hidden one hides it.
    const placements: NonNullable<ImportSource["placements"]> = [];
    let hidden = false;
    for (let up = parent; up; up = parentOf.get(up)) {
      if (types.get(up) !== "App::Part") continue;
      if (!visible(up)) hidden = true;
      const pl = data.get(up)?.get("Placement")?.querySelector("PropertyPlacement");
      if (!pl) continue;
      const n = (k: string) => Number(pl.getAttribute(k) ?? 0);
      placements.push({ position: [n("Px"), n("Py"), n("Pz")], axis: [n("Ox"), n("Oy"), n("Oz") || (n("Ox") || n("Oy") ? 0 : 1)], angle: (n("A") * 180) / Math.PI });
    }
    if (hidden) continue;
    const bytes = await read(shapeFile);
    if (!bytes?.length) continue; // An empty shape (e.g. a body with nothing in it yet).
    const brep = new TextDecoder().decode(bytes);
    if (!brep.trimStart().startsWith("CASCADE Topology")) {
      skipped++; // Saved in FreeCAD's binary shape format.
      continue;
    }
    const label = p.get("Label")?.querySelector("String")?.getAttribute("value") || name;
    sources.push({ name: label, format: "brep", data: brep, color: await fcColor(views.get(name), read), placements });
  }
  return { sources, skipped };
}

/** An object's colour: FreeCAD 1.0 keeps it in a ShapeAppearance material file, older versions in ShapeColor. */
async function fcColor(view: Map<string, Element> | undefined, read: (name: string) => Promise<Uint8Array | null>): Promise<string | undefined> {
  const unpack = (v: number) => `#${[v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const list = view?.get("ShapeAppearance")?.querySelector("MaterialList")?.getAttribute("file");
  if (list) {
    const bytes = await read(list);
    // A count, then each material: ambient, diffuse, … colours packed as RGBA.
    if (bytes && bytes.length >= 12) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (dv.getUint32(0, true) >= 1) return unpack(dv.getUint32(8, true));
    }
  }
  const old = view?.get("ShapeColor")?.querySelector("PropertyColor")?.getAttribute("value");
  return old ? unpack(Number(old)) : undefined;
}

// ---- FreeCAD sketches ------------------------------------------------------------------

/** A FreeCAD sketch as a GizmoCAD one: where it sits (world), and its drawing. */
export interface FcSketch {
  name: string;
  hidden: boolean;
  position: Vec3;
  /** Degrees, X then Y then Z. */
  rotation: Vec3;
  entities: SketchEntity[];
  /** Its outline's corners (world), for placing it with the rest. */
  min: number[];
  max: number[];
}

/** A point on a (rational) B-spline at parameter u (de Boor). */
function bspline(poles: { x: number; y: number; w: number }[], knots: number[], degree: number, u: number): Point2 {
  let k = degree;
  while (k < knots.length - degree - 2 && u >= knots[k + 1]) k++;
  const d = Array.from({ length: degree + 1 }, (_, j) => {
    const p = poles[Math.min(poles.length - 1, Math.max(0, j + k - degree))];
    return [p.x * p.w, p.y * p.w, p.w];
  });
  for (let r = 1; r <= degree; r++)
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree;
      const den = knots[i + degree - r + 1] - knots[i];
      const a = den ? (u - knots[i]) / den : 0;
      d[j] = d[j].map((v, c) => (1 - a) * d[j - 1][c] + a * v);
    }
  return [d[degree][0] / d[degree][2], d[degree][1] / d[degree][2]];
}

/**
 * The sketches in a FreeCAD document, for editing: closed chains of lines,
 * arcs and curves become shapes (arcs as bowed edges), circles and ellipses
 * themselves, points points, and lines that don't close (or are construction
 * geometry) guide lines.
 */
export async function fcstdSketches(file: PickedFile, newId: () => string): Promise<FcSketch[]> {
  const zip = readZip(file.data, "FreeCAD");
  const e = zip.get("document.xml");
  if (!e) return [];
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(await unzipEntry(e)), "application/xml");
  const kids = (el: Element | null | undefined, tag: string) => (el ? [...el.children].filter((c) => c.tagName === tag) : []);
  const types = new Map(kids(doc.querySelector("Objects"), "Object").map((o) => [o.getAttribute("name") ?? "", o.getAttribute("type") ?? ""]));
  const props = (holder: Element | undefined) => new Map(kids(kids(holder, "Properties")[0], "Property").map((p) => [p.getAttribute("name") ?? "", p]));
  const data = new Map(kids(doc.querySelector("ObjectData"), "Object").map((o) => [o.getAttribute("name") ?? "", props(o)]));
  const parentOf = new Map<string, string>();
  for (const [name, p] of data) for (const link of p.get("Group")?.querySelectorAll("Link") ?? []) parentOf.set(link.getAttribute("value") ?? "", name);
  const placement = (name: string) => {
    const pl = data.get(name)?.get("Placement")?.querySelector("PropertyPlacement");
    if (!pl) return new Matrix4();
    const n = (k: string) => Number(pl.getAttribute(k) ?? 0);
    return new Matrix4().compose(new Vector3(n("Px"), n("Py"), n("Pz")), new Quaternion(n("Q0"), n("Q1"), n("Q2"), n("Q3")).normalize(), new Vector3(1, 1, 1));
  };
  const num = (el: Element, k: string) => Number(el.getAttribute(k) ?? 0);
  const out: FcSketch[] = [];
  for (const [name, p] of data) {
    if (types.get(name) !== "Sketcher::SketchObject") continue;
    // Where it sits: its own placement, inside its body's and part's.
    let world = placement(name);
    for (let up = parentOf.get(name); up; up = parentOf.get(up)) if (/^(App::Part|PartDesign::Body)$/.test(types.get(up) ?? "")) world = placement(up).multiply(world);
    type Seg = { a: Point2; b: Point2; bend: number; via?: Point2[] };
    const segs: Seg[] = [];
    const entities: SketchEntity[] = [];
    const guide = (a: Point2, b: Point2) => entities.push({ id: newId(), mode: "construction", type: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
    for (const g of p.get("Geometry")?.querySelectorAll("Geometry") ?? []) {
      const flags = g.querySelector("GeoExtension")?.getAttribute("geometryModeFlags") ?? "";
      const construction = g.querySelector("Construction")?.getAttribute("value") === "1" || flags.at(-2) === "1";
      const line = g.querySelector("LineSegment");
      const circle = g.querySelector("Circle");
      const arc = g.querySelector("ArcOfCircle");
      const ellipse = g.querySelector("Ellipse");
      const spline = g.querySelector("BSplineCurve");
      const point = g.querySelector("GeomPoint");
      if (point) {
        // Points that belong to other geometry (an arc's centre, a spline's knots) are FreeCAD's own helpers.
        if (g.querySelector("GeoExtension")?.getAttribute("internalGeometryType") === "0") entities.push({ id: newId(), mode: "add", type: "point", x: num(point, "X"), y: num(point, "Y") });
        continue;
      }
      if (line) {
        const a: Point2 = [num(line, "StartX"), num(line, "StartY")];
        const b: Point2 = [num(line, "EndX"), num(line, "EndY")];
        if (construction) guide(a, b);
        else segs.push({ a, b, bend: 0 });
      } else if (arc) {
        const [cx, cy, r] = [num(arc, "CenterX"), num(arc, "CenterY"), num(arc, "Radius")];
        let [s0, e0] = [num(arc, "StartAngle"), num(arc, "EndAngle")];
        if (num(arc, "NormalZ") < 0) [s0, e0] = [-e0, -s0];
        if (e0 < s0) e0 += 2 * Math.PI;
        const at = (t: number): Point2 => [cx + r * Math.cos(t), cy + r * Math.sin(t)];
        const [a, b, m] = [at(s0), at(e0), at((s0 + e0) / 2)];
        // Its sagitta: how far its middle sits to the left of the chord from start to end.
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const len = Math.hypot(dx, dy) || 1;
        const bend = ((m[0] - (a[0] + b[0]) / 2) * -dy + (m[1] - (a[1] + b[1]) / 2) * dx) / len;
        if (!construction) segs.push({ a, b, bend });
      } else if (circle && !construction) {
        entities.push({ id: newId(), mode: "add", type: "circle", x: num(circle, "CenterX"), y: num(circle, "CenterY"), radius: num(circle, "Radius") });
      } else if (ellipse && !construction) {
        entities.push({ id: newId(), mode: "add", type: "ellipse", x: num(ellipse, "CenterX"), y: num(ellipse, "CenterY"), rx: num(ellipse, "MajorRadius"), ry: num(ellipse, "MinorRadius"), angle: (num(ellipse, "AngleXU") * 180) / Math.PI });
      } else if (spline && !construction) {
        const poles = [...spline.querySelectorAll("Pole")].map((q) => ({ x: num(q, "X"), y: num(q, "Y"), w: num(q, "Weight") || 1 }));
        const knots = [...spline.querySelectorAll("Knot")].flatMap((k) => Array<number>(Math.max(1, num(k, "Mult"))).fill(num(k, "Value")));
        const degree = num(spline, "Degree");
        if (poles.length < 2 || knots.length !== poles.length + degree + 1) continue;
        const [u0, u1] = [knots[degree], knots[knots.length - degree - 1]];
        const n = Math.max(12, poles.length * 6);
        const pts = Array.from({ length: n + 1 }, (_, i) => bspline(poles, knots, degree, u0 + ((u1 - u0) * i) / n));
        if (spline.getAttribute("IsPeriodic") === "1") entities.push({ id: newId(), mode: "add", type: "polygon", points: pts.slice(0, -1), bends: pts.slice(0, -1).map(() => 0) });
        else segs.push({ a: pts[0], b: pts[n], bend: 0, via: pts.slice(1, -1) });
      }
    }
    // Chain the lines, arcs and curves end to end into closed shapes.
    const near = (p: Point2, q: Point2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3;
    const used = new Set<number>();
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      const chain: Seg[] = [segs[i]];
      for (;;) {
        const end = chain.at(-1)!.b;
        if (near(end, chain[0].a)) break;
        const j = segs.findIndex((s, k) => !used.has(k) && (near(s.a, end) || near(s.b, end)));
        if (j < 0) break;
        used.add(j);
        const s = segs[j];
        chain.push(near(s.a, end) ? s : { a: s.b, b: s.a, bend: -s.bend, via: s.via?.slice().reverse() });
      }
      if (chain.length > 1 && near(chain.at(-1)!.b, chain[0].a)) {
        const points: Point2[] = [];
        const bends: number[] = [];
        for (const s of chain) {
          points.push(s.a);
          bends.push(s.bend);
          for (const v of s.via ?? []) (points.push(v), bends.push(0));
        }
        entities.push({ id: newId(), mode: "add", type: "polygon", points, bends });
      } else
        for (const s of chain) {
          const pts = [s.a, ...(s.via ?? []), s.b];
          for (let k = 0; k + 1 < pts.length; k++) guide(pts[k], pts[k + 1]);
        }
    }
    if (!entities.length) continue;
    // As in FreeCAD, a shape inside another is a hole in it (inside two, solid again, and so on).
    const closed = entities.filter((en) => en.type === "polygon" || en.type === "circle" || en.type === "ellipse");
    const someInside = (en: SketchEntity): Point2 => (en.type === "polygon" ? en.points[0] : en.type === "circle" || en.type === "ellipse" ? [en.x, en.y] : [0, 0]);
    const contains = (outer: SketchEntity, [x, y]: Point2) => {
      if (outer.type === "circle") return Math.hypot(x - outer.x, y - outer.y) < outer.radius;
      if (outer.type === "ellipse") {
        const t = (-outer.angle * Math.PI) / 180;
        const [dx, dy] = [x - outer.x, y - outer.y];
        const [u, v] = [dx * Math.cos(t) - dy * Math.sin(t), dx * Math.sin(t) + dy * Math.cos(t)];
        return (u / outer.rx) ** 2 + (v / outer.ry) ** 2 < 1;
      }
      if (outer.type !== "polygon") return false;
      let inside = false;
      const pts = outer.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
        if (pts[i][1] > y !== pts[j][1] > y && x < pts[j][0] + ((y - pts[j][1]) / (pts[i][1] - pts[j][1])) * (pts[i][0] - pts[j][0])) inside = !inside;
      return inside;
    };
    for (const en of closed) {
      const depth = closed.filter((o) => o !== en && contains(o, someInside(en))).length;
      if (depth % 2 === 1) en.mode = "subtract";
    }
    const round = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
    for (const en of entities) {
      if (en.type === "polygon") (en.points = en.points.map(([x, y]) => [round(x), round(y)])), (en.bends = en.bends.map(round));
    }
    // Its outline's box, in the world.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const en of entities) {
      if (en.type === "polygon") for (const [x, y] of en.points) (xs.push(x), ys.push(y));
      else if (en.type === "circle" || en.type === "point") (xs.push(en.x - (en.type === "circle" ? en.radius : 0), en.x + (en.type === "circle" ? en.radius : 0)), ys.push(en.y - (en.type === "circle" ? en.radius : 0), en.y + (en.type === "circle" ? en.radius : 0)));
      else if (en.type === "ellipse") (xs.push(en.x - en.rx, en.x + en.rx), ys.push(en.y - en.rx, en.y + en.rx));
      else if (en.type === "line") (xs.push(en.x1, en.x2), ys.push(en.y1, en.y2));
    }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const x of [Math.min(...xs), Math.max(...xs)])
      for (const y of [Math.min(...ys), Math.max(...ys)]) {
        const v = new Vector3(x, y, 0).applyMatrix4(world);
        for (const [k, c] of [v.x, v.y, v.z].entries()) (min[k] = Math.min(min[k], c)), (max[k] = Math.max(max[k], c));
      }
    const pos = new Vector3().setFromMatrixPosition(world);
    const rot = new Euler().setFromRotationMatrix(world, "ZYX");
    const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 1e4) / 1e4 + 0;
    const label = p.get("Label")?.querySelector("String")?.getAttribute("value") || name;
    const shown = p.get("Visibility")?.querySelector("Bool")?.getAttribute("value");
    out.push({ name: label, hidden: shown === "false", position: { x: round(pos.x), y: round(pos.y), z: round(pos.z) }, rotation: { x: deg(rot.x), y: deg(rot.y), z: deg(rot.z) }, entities, min, max });
  }
  return out;
}
