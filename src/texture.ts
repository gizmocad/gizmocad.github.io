// Surface textures that really print (knurling, ribs, bumps, honeycomb…): an
// object's finished mesh is subdivided finely and each point is pushed in (or
// out) by a repeating pattern, like a slicer's fuzzy skin. Runs in the kernel
// worker; the exact shape stays as it is, so the object can still be edited.

import { BufferAttribute, BufferGeometry } from "three";
import { mergeVertices, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import type { Texture, TexturePattern } from "./model";

/** Kinds that are round about their own Z axis: "auto" wraps the pattern around them. */
const ROUND_KINDS = new Set(["cylinder", "cone", "tube", "torus", "thread", "spring", "gear", "sphere", "screw", "prism", "star"]);

/** Most triangles a textured surface may have (keeps the view and exports responsive). */
const TRIANGLE_BUDGET = 900_000;

// ---- Patterns: height 0 (bottom of the texture) to 1 (the original surface) --------------

const frac = (t: number) => t - Math.floor(t);
/** 0 at whole numbers, 1 halfway between. */
const tri = (t: number) => 1 - Math.abs(2 * frac(t) - 1);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const smooth = (a: number, b: number, t: number) => {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
};

function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth value noise in 3D, 0–1. */
function noise3(x: number, y: number, z: number): number {
  const [xi, yi, zi] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [u, v, w] = [x - xi, y - yi, z - zi].map((t) => t * t * (3 - 2 * t));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

/** Distance from (x, y) to the nearest point of a hexagonal lattice (spacing 1 along x), and that offset. */
function hexOffset(x: number, y: number): [number, number] {
  const h = Math.sqrt(3);
  const ax = frac(x) - 0.5;
  const ay = frac(y / h) * h - h / 2;
  const bx = frac(x - 0.5) - 0.5;
  const by = frac((y - h / 2) / h) * h - h / 2;
  return ax * ax + ay * ay < bx * bx + by * by ? [ax, ay] : [bx, by];
}

/**
 * The pattern's height at (u, v), in pattern units (one repeat = 1). `p` is the
 * point in pattern units too, for patterns that use 3D noise (no seams).
 */
function patternHeight(pattern: TexturePattern, u: number, v: number, p: [number, number, number]): number {
  switch (pattern) {
    case "knurl":
      // Diamond knurling: two sets of crossing grooves leave little pyramids.
      return Math.min(tri(u + v), tri(u - v));
    case "ribs":
      return tri(u);
    case "rings":
      return tri(v);
    case "bumps": {
      const [dx, dy] = hexOffset(u, v);
      const d = Math.hypot(dx, dy) / 0.42;
      return d < 1 ? Math.sqrt(1 - d * d) : 0;
    }
    case "honeycomb": {
      const [dx, dy] = hexOffset(v, u); // Cells with flat sides up and down.
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const d = Math.max(ax * 0.5 + ay * (Math.sqrt(3) / 2), ax); // 0.5 at a cell's sides.
      return smooth(0.5, 0.4, d);
    }
    case "grid": {
      const d = Math.max(Math.abs(frac(u) - 0.5), Math.abs(frac(v) - 0.5));
      return smooth(0.45, 0.36, d);
    }
    case "bricks": {
      const row = Math.floor(v * 2);
      const bu = frac(u + (row % 2 ? 0.5 : 0));
      const bv = frac(v * 2);
      const d = Math.max(Math.abs(bu - 0.5) * 2, Math.abs(bv - 0.5) * 2); // 1 at the mortar lines.
      return smooth(0.94, 0.8, d);
    }
    case "waves":
      return 0.5 + 0.25 * (Math.sin(2 * Math.PI * u) + Math.sin(2 * Math.PI * v));
    case "wood": {
      const wobble = 0.8 * noise3(p[0] * 0.35, p[1] * 0.35, p[2] * 0.08);
      return 0.5 + 0.5 * Math.sin(2 * Math.PI * (u + wobble));
    }
    case "rough": {
      const n = noise3(p[0] * 2, p[1] * 2, p[2] * 2) * 0.6 + noise3(p[0] * 4.3, p[1] * 4.3, p[2] * 4.3) * 0.4;
      return n;
    }
  }
}

// ---- Creases ------------------------------------------------------------------------------

/**
 * Where a pattern has sharp creases (the ridges and valleys of grooves, the edges of a grid's
 * squares), along u and v (in repeats) and along the diagonals u + v and u − v. The mesh is cut
 * exactly along them before it's pushed, so they come out straight instead of zig-zagging between
 * whatever points happen to be nearby.
 */
function creaseLines(pattern: TexturePattern): { u: number[]; v: number[]; diagonal: number[] } {
  const halves = [0, 0.5];
  const edges = (a: number[]) => a.flatMap((t) => [t, 1 - t]);
  switch (pattern) {
    case "ribs":
      return { u: halves, v: [], diagonal: [] };
    case "rings":
      return { u: [], v: halves, diagonal: [] };
    case "knurl":
      // Two sets of crossing grooves (the diagonals), and where one takes over from the other.
      return { u: halves, v: halves, diagonal: halves };
    case "grid":
      return { u: edges([0.05, 0.14]), v: edges([0.05, 0.14]), diagonal: [] };
    case "bricks":
      // Rows are half a repeat high; every other row's joints are half a repeat along.
      return { u: edges([0.03, 0.1]).flatMap((t) => [t, frac(t + 0.5)]), v: edges([0.03, 0.1]).flatMap((t) => [t / 2, t / 2 + 0.5]), diagonal: [] };
    default:
      return { u: [], v: [], diagonal: [] };
  }
}

type Plane = { n: [number, number, number]; offsets: number[] };

/** Offsets `k + t` (t from `within`, one repeat long) covering lo..hi, scaled by `scale`. */
function spread(within: number[], lo: number, hi: number, scale: number): number[] {
  const out: number[] = [];
  for (let k = Math.floor(lo / scale) - 1; k <= Math.ceil(hi / scale) + 1; k++) for (const t of within) out.push((k + t) * scale);
  return [...new Set(out.map((x) => Math.round(x * 1e6) / 1e6))].sort((a, b) => a - b);
}

/**
 * Cut every triangle crossing one of the planes along it (each set of parallel planes in turn), so
 * the creases they mark are edges of the mesh. Shared edges are cut at the same new point on both
 * sides, so it stays closed.
 */
function sliceAlong(positions: number[], indices: number[], masks: number[], planes: Plane[], maxTriangles: number) {
  let idx = indices;
  let mask = masks;
  for (const { n, offsets } of planes) {
    if (!offsets.length) continue;
    // A set of planes is cut in full or not at all (half cut, the mesh would have gaps).
    const before = positions.length;
    let over = false;
    const s = (v: number) => n[0] * positions[3 * v] + n[1] * positions[3 * v + 1] + n[2] * positions[3 * v + 2];
    const cuts = new Map<string, number>();
    // A plane passing within a micron of a corner goes through it (cutting there would only leave a sliver).
    const eps = 1e-3;
    // The point where edge a–b crosses plane i (the same one for both triangles sharing the edge).
    const cut = (a: number, b: number, i: number) => {
      const key = `${Math.min(a, b)},${Math.max(a, b)},${i}`;
      let m = cuts.get(key);
      if (m === undefined) {
        const [sa, sb] = [s(a), s(b)];
        const t = (offsets[i] - sa) / (sb - sa);
        m = positions.length / 3;
        for (let k = 0; k < 3; k++) positions.push(positions[3 * a + k] + t * (positions[3 * b + k] - positions[3 * a + k]));
        cuts.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    const nextMask: number[] = [];
    // The first plane (from `from` on) strictly crossing a triangle: the planes before it don't reach it.
    const first = (lo: number, hi: number, from: number) => {
      for (let i = from; i < offsets.length && offsets[i] < hi - eps; i++) if (offsets[i] > lo + eps) return i;
      return -1;
    };
    const split = (a: number, b: number, c: number, m: number, from: number): void => {
      const [sa, sb, sc] = [s(a), s(b), s(c)];
      if (over) return;
      if (next.length / 3 > maxTriangles) {
        over = true;
        return;
      }
      const i = first(Math.min(sa, sb, sc), Math.max(sa, sb, sc), from);
      if (i < 0) {
        next.push(a, b, c);
        nextMask.push(m);
        return;
      }
      const d = offsets[i];
      const side = (x: number) => (Math.abs(x - d) <= eps ? 0 : x < d ? -1 : 1);
      let [p, q, r] = [a, b, c];
      let [xp, xq, xr] = [side(sa), side(sb), side(sc)];
      // Turned (keeping the winding) so p is the corner on the plane, or alone on its side.
      for (let k = 0; k < 3 && !(xp === 0 || (xp !== xq && xp !== xr && xq === xr)); k++) {
        [p, q, r] = [q, r, p];
        [xp, xq, xr] = [xq, xr, xp];
      }
      if (xp === 0) {
        const qr = cut(q, r, i);
        split(p, q, qr, m, i + 1);
        split(p, qr, r, m, i + 1);
      } else {
        const [pq, rp] = [cut(p, q, i), cut(r, p, i)];
        split(p, pq, rp, m, i + 1);
        split(pq, q, r, m, i + 1);
        split(pq, r, rp, m, i + 1);
      }
    };
    for (let t = 0; t < idx.length && !over; t += 3) split(idx[t], idx[t + 1], idx[t + 2], mask[t / 3], 0);
    if (over) {
      // Too many triangles: this set (and any after it) is left out, and the pattern drawn as before here.
      positions.length = before;
      break;
    }
    idx = next;
    mask = nextMask;
  }
  return { indices: idx, masks: mask };
}

/**
 * Join corners at (nearly) the same spot and drop the triangles that leaves with no area, keeping
 * each one's mask: where several creases cross at a point, cutting along them all leaves slivers
 * whose corners land on top of each other (a slicer would join those, tearing the surface).
 */
function weld(positions: number[], indices: number[], masks: number[], tolerance: number) {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  const welded = mergeVertices(g, tolerance);
  const joined = welded.getIndex()!.array as Uint32Array;
  const merged = welded.getAttribute("position").array as Float32Array;
  positions.length = merged.length;
  for (let i = 0; i < merged.length; i++) positions[i] = merged[i];
  const idx: number[] = [];
  const mask: number[] = [];
  for (let t = 0; t < joined.length; t += 3) {
    const [a, b, c] = [joined[t], joined[t + 1], joined[t + 2]];
    if (a === b || b === c || c === a) continue;
    idx.push(a, b, c);
    mask.push(masks[t / 3]);
  }
  g.dispose();
  welded.dispose();
  return { indices: idx, masks: mask };
}

// ---- Subdividing --------------------------------------------------------------------------

/** Split edges longer than `maxEdge` (only where a textured triangle touches them) until none are; each new triangle keeps its parent's mask. */
function subdivide(positions: number[], indices: number[], masks: number[], maxEdge: number, maxTriangles: number) {
  const max2 = maxEdge * maxEdge;
  const len2 = (i: number, j: number) => (positions[3 * i] - positions[3 * j]) ** 2 + (positions[3 * i + 1] - positions[3 * j + 1]) ** 2 + (positions[3 * i + 2] - positions[3 * j + 2]) ** 2;
  const key = (i: number, j: number) => (i < j ? i * 4194304 + j : j * 4194304 + i);
  let idx = indices;
  let mask = masks;
  for (let pass = 0; pass < 24; pass++) {
    const split = new Set<number>();
    for (let t = 0; t < idx.length; t += 3) {
      if (!mask[t / 3]) continue;
      for (let k = 0; k < 3; k++) {
        const [i, j] = [idx[t + k], idx[t + ((k + 1) % 3)]];
        if (len2(i, j) > max2) split.add(key(i, j));
      }
    }
    if (!split.size || idx.length / 3 + split.size * 2 > maxTriangles) break;
    const mids = new Map<number, number>();
    const mid = (i: number, j: number) => {
      const k = key(i, j);
      let m = mids.get(k);
      if (m === undefined) {
        m = positions.length / 3;
        positions.push((positions[3 * i] + positions[3 * j]) / 2, (positions[3 * i + 1] + positions[3 * j + 1]) / 2, (positions[3 * i + 2] + positions[3 * j + 2]) / 2);
        mids.set(k, m);
      }
      return m;
    };
    const next: number[] = [];
    const nextMask: number[] = [];
    const put = (m: number, ...tris: number[]) => {
      next.push(...tris);
      for (let n = 0; n < tris.length / 3; n++) nextMask.push(m);
    };
    for (let t = 0; t < idx.length; t += 3) {
      let [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const m = mask[t / 3];
      const flags = [split.has(key(a, b)), split.has(key(b, c)), split.has(key(c, a))];
      const count = flags.filter(Boolean).length;
      if (count === 0) put(m, a, b, c);
      else if (count === 3) {
        const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
        put(m, a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      } else {
        // Rotate (keeping the winding) so the split edges come first.
        while (!(count === 1 ? flags[0] : flags[0] && flags[1])) {
          [a, b, c] = [b, c, a];
          flags.push(flags.shift()!);
        }
        if (count === 1) {
          const ab = mid(a, b);
          put(m, a, ab, c, ab, b, c);
        } else {
          const [ab, bc] = [mid(a, b), mid(b, c)];
          put(m, ab, b, bc);
          if (len2(a, bc) < len2(ab, c)) put(m, a, ab, bc, a, bc, c);
          else put(m, a, ab, c, ab, bc, c);
        }
      }
    }
    idx = next;
    mask = nextMask;
  }
  return { indices: idx, masks: mask };
}

// ---- Corners ----------------------------------------------------------------------------

/**
 * How much of the pattern each point gets (0–1): it fades out within `reach` of a sharp corner
 * between textured faces (a box's edge with every face textured), so the two sides' grooves don't
 * run into each other there, and the corner prints crisp.
 */
function cornerFade(positions: number[], indices: number[], masks: number[], normals: Float32Array, reach: number): Float32Array {
  const count = positions.length / 3;
  const fade = new Float32Array(count).fill(1);
  if (reach <= 0) return fade;
  // Corner points: a textured face around them turns more than 30° from the way the point faces.
  const flat = new Float32Array(count).fill(1);
  for (let t = 0; t < indices.length; t += 3) {
    if (!masks[t / 3]) continue;
    const [i, j, k] = [indices[t], indices[t + 1], indices[t + 2]];
    const e1 = [0, 1, 2].map((c) => positions[3 * j + c] - positions[3 * i + c]);
    const e2 = [0, 1, 2].map((c) => positions[3 * k + c] - positions[3 * i + c]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!len) continue;
    for (const v of [i, j, k]) {
      const vl = Math.hypot(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]) || 1;
      const dot = (n[0] * normals[3 * v] + n[1] * normals[3 * v + 1] + n[2] * normals[3 * v + 2]) / (len * vl);
      flat[v] = Math.min(flat[v], dot);
    }
  }
  // How far each point is from the nearest corner point, along the surface (up to `reach`).
  // (At full precision: rounded, a distance could look shorter than itself and the point be queued again and again.)
  const dist = new Float64Array(count).fill(Infinity);
  // A small heap of (distance, point), in typed arrays (a big mesh has hundreds of thousands of points).
  let heapD = new Float64Array(1024);
  let heapV = new Int32Array(1024);
  let size = 0;
  const swap = (a: number, b: number) => {
    [heapD[a], heapD[b]] = [heapD[b], heapD[a]];
    [heapV[a], heapV[b]] = [heapV[b], heapV[a]];
  };
  const push = (d: number, v: number) => {
    if (size === heapD.length) {
      const [nd, nv] = [new Float64Array(size * 2), new Int32Array(size * 2)];
      nd.set(heapD);
      nv.set(heapV);
      [heapD, heapV] = [nd, nv];
    }
    heapD[size] = d;
    heapV[size] = v;
    for (let i = size++; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= heapD[i]) break;
      swap(p, i);
      i = p;
    }
  };
  const pop = () => {
    const v = heapV[0];
    size--;
    heapD[0] = heapD[size];
    heapV[0] = heapV[size];
    for (let i = 0; ; ) {
      const [l, r] = [2 * i + 1, 2 * i + 2];
      let m = i;
      if (l < size && heapD[l] < heapD[m]) m = l;
      if (r < size && heapD[r] < heapD[m]) m = r;
      if (m === i) break;
      swap(m, i);
      i = m;
    }
    return v;
  };
  for (let v = 0; v < count; v++)
    if (flat[v] < Math.cos(Math.PI / 6)) {
      dist[v] = 0;
      push(0, v);
    }
  if (!size) return fade;
  // Each point's neighbours (along the triangles' edges), packed: point v's are at start[v]..start[v + 1].
  const start = new Int32Array(count + 1);
  for (const v of indices) start[v + 1] += 2;
  for (let v = 0; v < count; v++) start[v + 1] += start[v];
  const fill = start.slice(0, count);
  const near = new Int32Array(start[count]);
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const [a, b] = [indices[t + k], indices[t + ((k + 1) % 3)]];
      near[fill[a]++] = b;
      near[fill[b]++] = a;
    }
  while (size) {
    const d = heapD[0];
    const v = pop();
    if (d > dist[v]) continue;
    for (let n = start[v]; n < start[v + 1]; n++) {
      const w = near[n];
      const nd = d + Math.hypot(positions[3 * w] - positions[3 * v], positions[3 * w + 1] - positions[3 * v + 1], positions[3 * w + 2] - positions[3 * v + 2]);
      if (nd < dist[w] && nd < reach) {
        dist[w] = nd;
        push(nd, w);
      }
    }
  }
  for (let v = 0; v < count; v++) if (dist[v] < reach) fade[v] = smooth(0, reach, dist[v]);
  return fade;
}

// ---- Applying ---------------------------------------------------------------------------

export interface TexturedMesh {
  /** Indexed and watertight (for exports). */
  vertices: Float32Array;
  triangles: Uint32Array;
  /** For the view: corners split at sharp edges, with normals. */
  display: { vertices: Float32Array; normals: Float32Array; triangles: Uint32Array };
  /** Made coarser than asked, to stay within the triangle budget. */
  coarser: boolean;
}

/**
 * Texture a closed mesh given in the object's own frame (Z up). `kind` picks
 * how "auto" wraps the pattern: around round shapes, flat onto the rest.
 */
export function applyTexture(vertices: ArrayLike<number>, triangles: ArrayLike<number>, tex: Texture, kind: string): TexturedMesh {
  // Shared corners joined, so pushing them keeps the surface closed.
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(vertices), 3));
  g.setIndex(new BufferAttribute(new Uint32Array(triangles), 1));
  const welded = mergeVertices(g, 1e-4);
  const positions = Array.from(welded.getAttribute("position").array as Float32Array);
  // Joining corners collapses some triangles to nothing (e.g. at a sphere's poles): drop those.
  const joined = welded.getIndex()!.array as Uint32Array;
  const base: number[] = [];
  for (let t = 0; t < joined.length; t += 3) {
    const [a, b, c] = [joined[t], joined[t + 1], joined[t + 2]];
    if (a !== b && b !== c && c !== a) base.push(a, b, c);
  }
  g.dispose();
  welded.dispose();

  // Which triangles get the pattern (by which way they face), and how much surface that is.
  const masks: number[] = [];
  let area = 0;
  for (let t = 0; t < base.length; t += 3) {
    const [a, b, c] = [base[t], base[t + 1], base[t + 2]].map((i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    const nz = len > 0 ? n[2] / len : 0;
    const on = tex.faces === "all" || (tex.faces === "sides" && Math.abs(nz) < 0.7) || (tex.faces === "top" && nz >= 0.7);
    masks.push(on ? 1 : 0);
    if (on) area += len / 2;
  }

  const size = Math.max(0.2, tex.size);
  // Fine enough to draw the pattern (about 6 points per repeat), but within the budget.
  const wanted = Math.max(0.1, size / 6);
  const budgetEdge = Math.sqrt(area / (0.433 * TRIANGLE_BUDGET * 0.9));
  const edge = Math.max(wanted, budgetEdge);

  // How the pattern lies on the surface.
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let v = 0; v < positions.length / 3; v++) {
    minX = Math.min(minX, positions[3 * v]);
    maxX = Math.max(maxX, positions[3 * v]);
    minY = Math.min(minY, positions[3 * v + 1]);
    maxY = Math.max(maxY, positions[3 * v + 1]);
  }
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2];
  let radius = 0;
  for (let v = 0; v < positions.length / 3; v++) radius = Math.max(radius, Math.hypot(positions[3 * v] - cx, positions[3 * v + 1] - cy));
  const around = tex.wrap === "around" || (tex.wrap === "auto" && ROUND_KINDS.has(kind));
  // Around: a whole number of repeats, so there's no seam.
  const repeats = Math.max(1, Math.round((2 * Math.PI * radius) / size));

  // The creases, as planes through the part: cut along them first (just where the textured faces are).
  const lines = creaseLines(tex.pattern);
  const planes: Plane[] = [];
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const facing = new Set<number>();
  for (let t = 0; t < base.length; t += 3) {
    if (!masks[t / 3]) continue;
    for (const i of base.slice(t, t + 3))
      for (let k = 0; k < 3; k++) {
        box[k] = Math.min(box[k], positions[3 * i + k]);
        box[k + 3] = Math.max(box[k + 3], positions[3 * i + k]);
      }
    const [a, b, c] = [base[t], base[t + 1], base[t + 2]].map((i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])].map(Math.abs);
    facing.add(n.indexOf(Math.max(...n))); // Which way it faces most: which pair of axes the pattern's laid on.
  }
  const along = (n: [number, number, number], within: number[], scale = size) => {
    if (!within.length) return;
    const ends = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => n[0] * box[c & 1 ? 3 : 0] + n[1] * box[c & 2 ? 4 : 1] + n[2] * box[c & 4 ? 5 : 2]);
    planes.push({ n, offsets: spread(within, Math.min(...ends), Math.max(...ends), scale) });
  };
  if (box[0] <= box[3]) {
    if (around) {
      along([0, 0, 1], lines.v);
      // Lines along the axis: a plane through it at each crease's angle (one plane covers the opposite side too).
      const angles = spread(lines.u, 0, repeats, 1).map((u) => Math.round((((u / repeats) * 2 * Math.PI) % Math.PI) * 1e6) / 1e6);
      for (const a of new Set(angles.map((x) => (x < 0 ? x + Math.PI : x)))) {
        const n: [number, number, number] = [-Math.sin(a), Math.cos(a), 0];
        planes.push({ n, offsets: [n[0] * cx + n[1] * cy] });
      }
    } else {
      // As patternHeight lays it: facing X it's (y, z), facing Y (x, z), facing up or down (x, y).
      const axes: [number, number][] = [...facing].map((f) => (f === 0 ? [1, 2] : f === 1 ? [0, 2] : [0, 1]));
      const unit = (k: number): [number, number, number] => [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
      for (const [ua, va] of axes) {
        along(unit(ua), lines.u);
        along(unit(va), lines.v);
        if (lines.diagonal.length) {
          const r = Math.SQRT1_2;
          const plus = unit(ua).map((x, k) => (x + unit(va)[k]) * r) as [number, number, number];
          const minus = unit(ua).map((x, k) => (x - unit(va)[k]) * r) as [number, number, number];
          along(plus, lines.diagonal, size * r);
          along(minus, lines.diagonal, size * r);
        }
      }
    }
  }
  // Each set of planes once (sides facing X and Y share the Z ones).
  const unique = [...new Map(planes.map((p) => [`${p.n.map((x) => x.toFixed(6))}|${p.offsets[0]}|${p.offsets.length}`, p])).values()];
  let sliced = { indices: base, masks };
  if (unique.length) {
    const cut = sliceAlong(positions, base, masks, unique, TRIANGLE_BUDGET * 0.6);
    sliced = weld(positions, cut.indices, cut.masks, 1e-4);
  }
  const { indices, masks: triMask } = subdivide(positions, sliced.indices, sliced.masks, edge, TRIANGLE_BUDGET);
  const count = positions.length / 3;

  // Each corner's normal (from the faces around it) and how much of it is textured.
  const normals = new Float32Array(count * 3);
  const weight = new Float32Array(count);
  const touching = new Uint16Array(count);
  for (let t = 0; t < indices.length; t += 3) {
    const [i, j, k] = [indices[t], indices[t + 1], indices[t + 2]];
    const ax = positions[3 * j] - positions[3 * i];
    const ay = positions[3 * j + 1] - positions[3 * i + 1];
    const az = positions[3 * j + 2] - positions[3 * i + 2];
    const bx = positions[3 * k] - positions[3 * i];
    const by = positions[3 * k + 1] - positions[3 * i + 1];
    const bz = positions[3 * k + 2] - positions[3 * i + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    for (const v of [i, j, k]) {
      normals[3 * v] += nx;
      normals[3 * v + 1] += ny;
      normals[3 * v + 2] += nz;
      weight[v] += triMask[t / 3];
      touching[v]++;
    }
  }

  const fade = cornerFade(positions, indices, triMask, normals, 2 * Math.abs(tex.depth));
  const out = new Float32Array(positions);
  for (let v = 0; v < count; v++) {
    // Only points wholly inside the textured faces move: where they meet plain faces the edge stays crisp (and the plain faces flat).
    if (!touching[v] || weight[v] < touching[v]) continue;
    let [nx, ny, nz] = [normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]];
    const nl = Math.hypot(nx, ny, nz) || 1;
    [nx, ny, nz] = [nx / nl, ny / nl, nz / nl];
    const [x, y, z] = [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]];
    const p: [number, number, number] = [x / size, y / size, z / size];
    let h: number;
    if (around) {
      const angle = Math.atan2(y - cy, x - cx);
      h = patternHeight(tex.pattern, (angle / (2 * Math.PI)) * repeats, z / size, p);
    } else {
      // Projected from the side it faces most, blended where it turns.
      const w = [nx ** 4, ny ** 4, nz ** 4];
      const sum = w[0] + w[1] + w[2] || 1;
      h =
        (w[0] * patternHeight(tex.pattern, y / size, z / size, p) +
          w[1] * patternHeight(tex.pattern, x / size, z / size, p) +
          w[2] * patternHeight(tex.pattern, x / size, y / size, p)) /
        sum;
    }
    // Pressed in (peaks at the original surface), or raised out of it.
    const d = (tex.raised ? tex.depth * h : -tex.depth * (1 - h)) * fade[v];
    out[3 * v] = x + nx * d;
    out[3 * v + 1] = y + ny * d;
    out[3 * v + 2] = z + nz * d;
  }

  const tris = new Uint32Array(indices);
  const shown = new BufferGeometry();
  shown.setAttribute("position", new BufferAttribute(out, 3));
  shown.setIndex(new BufferAttribute(tris, 1));
  const creased = toCreasedNormals(shown, Math.PI / 4);
  const display = {
    vertices: creased.getAttribute("position").array as Float32Array,
    normals: creased.getAttribute("normal").array as Float32Array,
    triangles: Uint32Array.from({ length: creased.getAttribute("position").count }, (_, i) => i),
  };
  shown.dispose();
  creased.dispose();
  return { vertices: out, triangles: tris, display, coarser: budgetEdge > wanted };
}
