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
  const { indices, masks: triMask } = subdivide(positions, base, masks, edge, TRIANGLE_BUDGET);
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

  // How the pattern lies on the surface.
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v++) {
    minX = Math.min(minX, positions[3 * v]);
    maxX = Math.max(maxX, positions[3 * v]);
    minY = Math.min(minY, positions[3 * v + 1]);
    maxY = Math.max(maxY, positions[3 * v + 1]);
  }
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2];
  let radius = 0;
  for (let v = 0; v < count; v++) radius = Math.max(radius, Math.hypot(positions[3 * v] - cx, positions[3 * v + 1] - cy));
  const around = tex.wrap === "around" || (tex.wrap === "auto" && ROUND_KINDS.has(kind));
  // Around: a whole number of repeats, so there's no seam.
  const repeats = Math.max(1, Math.round((2 * Math.PI * radius) / size));

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
    const d = tex.raised ? tex.depth * h : -tex.depth * (1 - h);
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
