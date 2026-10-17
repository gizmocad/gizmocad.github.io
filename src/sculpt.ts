// Sculpting works on a triangle mesh (clay), not on the exact CAD kernel, which
// can't be pushed and pulled freely. This module builds the starting meshes,
// stores them compactly in the document, and implements the brushes.

import * as THREE from "three";
import { mergeVertices, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

export type SculptBase = "sphere" | "cube";
export type SculptDetail = "normal" | "high";
export type BrushKind = "draw" | "inflate" | "smooth" | "flatten" | "grab";

export interface SculptParams {
  /** "converted" = made from a CAD object with "Sculpt this object"; "imported" = an STL/3MF mesh. */
  base: SculptBase | "converted" | "imported";
  size: number;
  detail: SculptDetail;
  /** Vertex positions (Float32, base64). The object's local frame: bottom at z = 0. */
  positions: string;
  /** Triangle indices (Uint32, base64). */
  indices: string;
}

// ---- Storage -------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const encodeFloats = (a: Float32Array) => toBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
export const encodeIndices = (a: Uint32Array) => toBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
export const decodeFloats = (s: string) => new Float32Array(fromBase64(s).buffer);
export const decodeIndices = (s: string) => new Uint32Array(fromBase64(s).buffer);

/** A fresh, evenly subdivided starting mesh. */
export function baseMesh(base: SculptBase, size: number, detail: SculptDetail): Pick<SculptParams, "positions" | "indices"> {
  let geom: THREE.BufferGeometry =
    base === "sphere"
      ? new THREE.IcosahedronGeometry(size / 2, detail === "high" ? 40 : 24)
      : new THREE.BoxGeometry(size, size, size, ...(Array(3).fill(detail === "high" ? 40 : 24) as [number, number, number]));
  geom.deleteAttribute("normal");
  geom.deleteAttribute("uv");
  geom = mergeVertices(geom, 1e-4);
  geom.translate(0, 0, size / 2); // Sit on the workplane, like the other shapes.
  const pos = new Float32Array(geom.getAttribute("position").array);
  const idx = new Uint32Array(geom.getIndex()!.array);
  geom.dispose();
  return { positions: encodeFloats(pos), indices: encodeIndices(idx) };
}

export function defaultSculpt(): SculptParams {
  return { base: "sphere", size: 30, detail: "normal", ...baseMesh("sphere", 30, "normal") };
}

export function sculptGeometry(p: SculptParams): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(decodeFloats(p.positions), 3));
  geom.setIndex(new THREE.BufferAttribute(decodeIndices(p.indices), 1));
  geom.computeVertexNormals();
  return geom;
}

/** Made from CAD geometry (imported, or converted from a shape): drawn with its sharp edges kept. */
export function isCadMesh(p: SculptParams): boolean {
  return p.base === "imported" || p.base === "converted";
}

/**
 * For display: faces meeting at more than `crease` degrees keep a sharp edge
 * (smooth shading would round off every corner of a CAD part), gentle curves
 * stay smooth. Not for sculpting, which needs the shared corners.
 */
export function creasedGeometry(p: SculptParams, crease = 30): THREE.BufferGeometry {
  const smooth = sculptGeometry(p);
  const creased = toCreasedNormals(smooth, THREE.MathUtils.degToRad(crease));
  smooth.dispose();
  return creased;
}

// ---- Remeshing -------------------------------------------------------------

/** Vertex budgets: enough for detail, small enough to sculpt smoothly. */
const TARGET_VERTICES: Record<SculptDetail, number> = { normal: 8000, high: 20000 };
const MAX_VERTICES = 80000;

/** Join vertices that share a position, so the surface is one connected skin. */
function weld(positions: Float32Array, indices: Uint32Array): { positions: Float32Array; indices: Uint32Array } {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  const merged = mergeVertices(g, 1e-4);
  const out = { positions: new Float32Array(merged.getAttribute("position").array), indices: new Uint32Array(merged.getIndex()!.array) };
  g.dispose();
  merged.dispose();
  return out;
}

function surfaceArea(pos: Float32Array, idx: Uint32Array): number {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i < idx.length; i += 3) {
    a.fromArray(pos, 3 * idx[i]);
    b.fromArray(pos, 3 * idx[i + 1]);
    c.fromArray(pos, 3 * idx[i + 2]);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return area;
}

/**
 * Split every edge longer than `maxEdge` at its midpoint (shared between the
 * two triangles, so the surface stays watertight), repeating until all edges
 * are short enough or the vertex cap is hit.
 */
function subdivide(positions: Float32Array, indices: Uint32Array, maxEdge: number): { positions: Float32Array; indices: Uint32Array } {
  const pos = Array.from(positions);
  let idx = Array.from(indices);
  const max2 = maxEdge * maxEdge;
  const len2 = (i: number, j: number) => (pos[3 * i] - pos[3 * j]) ** 2 + (pos[3 * i + 1] - pos[3 * j + 1]) ** 2 + (pos[3 * i + 2] - pos[3 * j + 2]) ** 2;

  for (let pass = 0; pass < 12 && pos.length / 3 < MAX_VERTICES; pass++) {
    const mids = new Map<string, number>();
    const mid = (i: number, j: number) => {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      let m = mids.get(key);
      if (m === undefined) {
        m = pos.length / 3;
        pos.push((pos[3 * i] + pos[3 * j]) / 2, (pos[3 * i + 1] + pos[3 * j + 1]) / 2, (pos[3 * i + 2] + pos[3 * j + 2]) / 2);
        mids.set(key, m);
      }
      return m;
    };
    // Decide splits per edge first, so both triangles sharing an edge agree.
    const split = new Set<string>();
    for (let t = 0; t < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const [i, j] = [idx[t + k], idx[t + ((k + 1) % 3)]];
        if (len2(i, j) > max2) split.add(i < j ? `${i},${j}` : `${j},${i}`);
      }
    }
    // Stop rather than blow past the vertex cap.
    if (!split.size || pos.length / 3 + split.size > MAX_VERTICES) break;
    const isSplit = (i: number, j: number) => split.has(i < j ? `${i},${j}` : `${j},${i}`);
    const next: number[] = [];
    for (let t = 0; t < idx.length; t += 3) {
      let [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const flags = [isSplit(a, b), isSplit(b, c), isSplit(c, a)];
      const count = flags.filter(Boolean).length;
      if (count === 0) {
        next.push(a, b, c);
        continue;
      }
      if (count === 3) {
        const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
        next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
        continue;
      }
      // Rotate (keeping winding) so the split edges come first.
      while (!(count === 1 ? flags[0] : flags[0] && flags[1])) {
        [a, b, c] = [b, c, a];
        flags.push(flags.shift()!);
      }
      if (count === 1) {
        const ab = mid(a, b);
        next.push(a, ab, c, ab, b, c);
      } else {
        const [ab, bc] = [mid(a, b), mid(b, c)];
        next.push(ab, b, bc);
        // Split the remaining quad a-ab-bc-c along its shorter diagonal.
        if (len2(a, bc) < len2(ab, c)) next.push(a, ab, bc, a, bc, c);
        else next.push(a, ab, c, ab, bc, c);
      }
    }
    idx = next;
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Turn any triangle mesh (e.g. a CAD object's tessellation) into sculptable clay. */
export function meshToSculpt(vertices: Float32Array, triangles: Uint32Array, detail: SculptDetail = "normal"): SculptParams {
  const welded = weld(vertices, triangles);
  const area = surfaceArea(welded.positions, welded.indices);
  // Equilateral triangles of side L cover ~0.433·L² each, with about half as many vertices.
  const edge = Math.sqrt(area / (0.433 * 2 * TARGET_VERTICES[detail]));
  // Halving edges overshoots, so only split edges well over the target; they end up between 0.75× and 1.5× it.
  const fine = subdivide(welded.positions, welded.indices, edge * 1.5);
  const box = new THREE.Box3().setFromArray(fine.positions);
  const size = Math.max(...box.getSize(new THREE.Vector3()).toArray());
  return { base: "converted", size: Math.round(size * 100) / 100, detail, positions: encodeFloats(fine.positions), indices: encodeIndices(fine.indices) };
}

/** An imported mesh (e.g. an STL) as a sculpt, kept as it is (only duplicate corners merged). */
export function importedMesh(vertices: Float32Array, triangles: Uint32Array): SculptParams {
  const welded = weld(vertices, triangles);
  const box = new THREE.Box3().setFromArray(welded.positions);
  const size = Math.max(...box.getSize(new THREE.Vector3()).toArray());
  return { base: "imported", size: Math.round(size * 100) / 100, detail: "normal", positions: encodeFloats(welded.positions), indices: encodeIndices(welded.indices) };
}

/** Make an existing sculpt's mesh about twice as dense, keeping its shape. */
export function addDetail(p: SculptParams): Pick<SculptParams, "positions" | "indices"> | null {
  const pos = decodeFloats(p.positions);
  const idx = decodeIndices(p.indices);
  if (pos.length / 3 * 2 > MAX_VERTICES) return null;
  const avg = Math.sqrt((surfaceArea(pos, idx) / (idx.length / 3)) / 0.433);
  const fine = subdivide(pos, idx, avg * 0.9);
  return { positions: encodeFloats(fine.positions), indices: encodeIndices(fine.indices) };
}

/** Scale the sculpt (sculpting kept) about its local origin. */
export function scaleSculpt(p: SculptParams, factor: number): Pick<SculptParams, "positions" | "size"> {
  const pos = decodeFloats(p.positions).map((v) => v * factor);
  return { positions: encodeFloats(pos), size: Math.round(p.size * factor * 100) / 100 };
}

export function vertexCount(p: SculptParams): number {
  // From the base64 text's length (decoding a big mesh just to count it is slow): 12 bytes a point.
  const s = p.positions;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return ((s.length / 4) * 3 - padding) / 12;
}

// ---- Brushes -------------------------------------------------------------

export interface BrushSettings {
  kind: BrushKind;
  /** Brush radius in mm. */
  radius: number;
  /** 0–1. */
  strength: number;
  /** Push in instead of out (draw/inflate). */
  invert: boolean;
  /** Mirror strokes across the object's X = 0 plane. */
  symmetry: boolean;
}

/** Smooth falloff: 1 at the centre, 0 at the brush edge. */
const falloff = (d: number, r: number) => {
  const t = Math.max(0, 1 - d / r);
  return t * t * (3 - 2 * t);
};

/** Mesh data for sculpting, with vertex neighbours precomputed for smoothing. */
export class SculptMesh {
  readonly positions: Float32Array;
  readonly neighbors: number[][];
  private grab: { weights: Map<number, number>; start: Float32Array }[] = [];

  constructor(readonly geometry: THREE.BufferGeometry) {
    this.positions = geometry.getAttribute("position").array as Float32Array;
    const idx = geometry.getIndex()!.array;
    const sets = Array.from({ length: this.positions.length / 3 }, () => new Set<number>());
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]];
      sets[a].add(b).add(c);
      sets[b].add(a).add(c);
      sets[c].add(a).add(b);
    }
    this.neighbors = sets.map((s) => [...s]);
  }

  private normals() {
    return this.geometry.getAttribute("normal").array as Float32Array;
  }

  /** Vertices within `r` of `p`, with their falloff weights. */
  private within(p: THREE.Vector3, r: number): Map<number, number> {
    const out = new Map<number, number>();
    const pos = this.positions;
    const r2 = r * r;
    for (let i = 0; i < pos.length / 3; i++) {
      const dx = pos[3 * i] - p.x;
      const dy = pos[3 * i + 1] - p.y;
      const dz = pos[3 * i + 2] - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r2) out.set(i, falloff(Math.sqrt(d2), r));
    }
    return out;
  }

  /** The brush centres: the hit point, plus its mirror image when symmetry is on. */
  private centres(p: THREE.Vector3, s: BrushSettings): THREE.Vector3[] {
    return s.symmetry && Math.abs(p.x) > s.radius * 0.05 ? [p, new THREE.Vector3(-p.x, p.y, p.z)] : [p];
  }

  /** Apply one dab of the brush at `p` (local coordinates). */
  dab(p: THREE.Vector3, s: BrushSettings) {
    if (s.kind === "grab") return;
    const pos = this.positions;
    const nrm = this.normals();
    const step = s.strength * s.radius * 0.08 * (s.invert ? -1 : 1);
    for (const c of this.centres(p, s)) {
      const hit = this.within(c, s.radius);
      if (!hit.size) continue;
      // Average normal and centre of the affected area.
      const n = new THREE.Vector3();
      const centre = new THREE.Vector3();
      let total = 0;
      for (const [i, w] of hit) {
        n.x += nrm[3 * i] * w;
        n.y += nrm[3 * i + 1] * w;
        n.z += nrm[3 * i + 2] * w;
        centre.x += pos[3 * i] * w;
        centre.y += pos[3 * i + 1] * w;
        centre.z += pos[3 * i + 2] * w;
        total += w;
      }
      n.normalize();
      centre.divideScalar(total);

      if (s.kind === "smooth") {
        const next = new Map<number, [number, number, number]>();
        for (const [i, w] of hit) {
          const nb = this.neighbors[i];
          let [ax, ay, az] = [0, 0, 0];
          for (const j of nb) {
            ax += pos[3 * j];
            ay += pos[3 * j + 1];
            az += pos[3 * j + 2];
          }
          const k = Math.min(1, w * s.strength);
          next.set(i, [
            pos[3 * i] + (ax / nb.length - pos[3 * i]) * k,
            pos[3 * i + 1] + (ay / nb.length - pos[3 * i + 1]) * k,
            pos[3 * i + 2] + (az / nb.length - pos[3 * i + 2]) * k,
          ]);
        }
        for (const [i, v] of next) pos.set(v, 3 * i);
        continue;
      }

      for (const [i, w] of hit) {
        if (s.kind === "draw") {
          pos[3 * i] += n.x * step * w;
          pos[3 * i + 1] += n.y * step * w;
          pos[3 * i + 2] += n.z * step * w;
        } else if (s.kind === "inflate") {
          pos[3 * i] += nrm[3 * i] * step * w;
          pos[3 * i + 1] += nrm[3 * i + 1] * step * w;
          pos[3 * i + 2] += nrm[3 * i + 2] * step * w;
        } else if (s.kind === "flatten") {
          // Move towards the plane through the area's centre.
          const d = (pos[3 * i] - centre.x) * n.x + (pos[3 * i + 1] - centre.y) * n.y + (pos[3 * i + 2] - centre.z) * n.z;
          const k = Math.min(1, w * s.strength * 0.5);
          pos[3 * i] -= n.x * d * k;
          pos[3 * i + 1] -= n.y * d * k;
          pos[3 * i + 2] -= n.z * d * k;
        }
      }
    }
    this.update();
  }

  /** Grab: remember what's under the brush, then move it with `drag`. */
  startGrab(p: THREE.Vector3, s: BrushSettings) {
    this.grab = this.centres(p, s).map((c) => ({ weights: this.within(c, s.radius), start: this.positions.slice() }));
  }

  /** Move grabbed vertices by `delta` (local), mirrored in X for the symmetric copy. */
  drag(delta: THREE.Vector3) {
    this.grab.forEach((g, k) => {
      const dx = k === 1 ? -delta.x : delta.x;
      for (const [i, w] of g.weights) {
        this.positions[3 * i] = g.start[3 * i] + dx * w;
        this.positions[3 * i + 1] = g.start[3 * i + 1] + delta.y * w;
        this.positions[3 * i + 2] = g.start[3 * i + 2] + delta.z * w;
      }
    });
    this.update();
  }

  private update() {
    this.geometry.getAttribute("position").needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }

  /** Positions to store in the document. */
  encode(): string {
    return encodeFloats(this.positions);
  }
}

// ---- Export --------------------------------------------------------------

/** World-space triangles of a sculpt (flat xyz × 3 per triangle). */
export function sculptTriangles(p: SculptParams, world: THREE.Matrix4): Float32Array {
  const pos = decodeFloats(p.positions);
  const idx = decodeIndices(p.indices);
  const out = new Float32Array(idx.length * 3);
  const v = new THREE.Vector3();
  // A mirrored placement turns triangles inside out; swap two corners to keep them facing outwards.
  const flip = world.determinant() < 0;
  for (let i = 0; i < idx.length; i++) {
    const corner = flip ? i - (i % 3) + [0, 2, 1][i % 3] : i;
    v.fromArray(pos, 3 * idx[corner]).applyMatrix4(world);
    out.set([v.x, v.y, v.z], 3 * i);
  }
  return out;
}

/** Append triangles to a binary STL (or build a new one from just these triangles). */
export async function appendToStl(stl: Blob | null, triangles: Float32Array[]): Promise<Blob> {
  const base = stl ? new Uint8Array(await stl.arrayBuffer()) : null;
  const existing = base ? new DataView(base.buffer).getUint32(80, true) : 0;
  const extra = triangles.reduce((n, t) => n + t.length / 9, 0);
  const out = new ArrayBuffer(84 + (existing + extra) * 50);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);
  if (base) bytes.set(base.subarray(0, 84 + existing * 50));
  view.setUint32(80, existing + extra, true);
  let o = 84 + existing * 50;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const tris of triangles) {
    for (let t = 0; t < tris.length; t += 9) {
      a.fromArray(tris, t);
      b.fromArray(tris, t + 3);
      c.fromArray(tris, t + 6);
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      [n, a, b, c].forEach((vec, k) => {
        view.setFloat32(o + 12 * k, vec.x, true);
        view.setFloat32(o + 12 * k + 4, vec.y, true);
        view.setFloat32(o + 12 * k + 8, vec.z, true);
      });
      o += 50;
    }
  }
  return new Blob([out], { type: "model/stl" });
}
