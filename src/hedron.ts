// Regular polyhedra (Platonic solids), shared by the kernel, the resize rules and snap points.

export type HedronFaces = 4 | 6 | 8 | 12 | 20;
export const HEDRON_FACES: HedronFaces[] = [4, 6, 8, 12, 20];
export const HEDRON_NAMES: Record<HedronFaces, string> = { 4: "Tetrahedron", 6: "Cube", 8: "Octahedron", 12: "Dodecahedron", 20: "Icosahedron" };

type V = [number, number, number];
const PHI = (1 + Math.sqrt(5)) / 2;

const cyclic = (a: number, b: number, c: number): V[] => [[a, b, c], [b, c, a], [c, a, b]];
const signs = (v: V): V[] => {
  const out: V[] = [];
  for (const sx of v[0] ? [1, -1] : [1]) for (const sy of v[1] ? [1, -1] : [1]) for (const sz of v[2] ? [1, -1] : [1]) out.push([v[0] * sx, v[1] * sy, v[2] * sz]);
  return out;
};
const CUBE: V[] = signs([1, 1, 1]);
const OCTA: V[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const TETRA: V[] = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
const ICOSA: V[] = cyclic(0, 1, PHI).flatMap(signs);
const DODECA: V[] = [...CUBE, ...cyclic(0, 1 / PHI, PHI).flatMap(signs)];

const CORNERS: Record<HedronFaces, V[]> = { 4: TETRA, 6: CUBE, 8: OCTA, 12: DODECA, 20: ICOSA };

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: V): V => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

const cache = new Map<string, { vertices: V[]; faces: V[][] }>();

/**
 * A regular polyhedron resting on a face: that face is on z = 0, centred on the
 * origin, with one of its edges along X. `radius` is centre to corner. Each
 * face lists its corners counter-clockwise seen from outside.
 */
export function hedron(faces: HedronFaces, radius: number): { vertices: V[]; faces: V[][] } {
  const key = `${faces}|${radius}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const corners = CORNERS[faces] ?? CORNERS[20];
  const scale = radius / Math.hypot(...corners[0]);
  const verts = corners.map((v) => v.map((c) => c * scale) as V);
  // Each face's outward direction: a plane through three corners with every corner on its inner side.
  const eps = 1e-6 * radius;
  const normals: V[] = [];
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++)
      for (let k = j + 1; k < verts.length; k++) {
        const c = cross(sub(verts[j], verts[i]), sub(verts[k], verts[i]));
        if (Math.hypot(...c) < eps) continue;
        let n = unit(c);
        if (dot(n, verts[i]) < 0) n = [-n[0], -n[1], -n[2]];
        const d = dot(n, verts[i]);
        if (verts.every((v) => dot(v, n) <= d + eps) && !normals.some((m) => dot(m, n) > 1 - 1e-9)) normals.push(n);
      }
  const faceList = normals.map((n) => {
    const far = Math.max(...verts.map((v) => dot(v, n)));
    const on = verts.filter((v) => Math.abs(dot(v, n) - far) < 1e-6 * radius);
    const c = on.reduce((s, v) => [s[0] + v[0] / on.length, s[1] + v[1] / on.length, s[2] + v[2] / on.length] as V, [0, 0, 0] as V);
    // Order the corners around the face's centre, counter-clockwise about its outward normal.
    const u = unit(sub(on[0], c));
    const w = cross(n, u);
    return on.sort((a, b) => Math.atan2(dot(sub(a, c), w), dot(sub(a, c), u)) - Math.atan2(dot(sub(b, c), w), dot(sub(b, c), u)));
  });
  // Turn the first face's normal to -Z, then spin so its first edge runs along X, then sit it on z = 0.
  const bottom = faceList[0];
  const n = unit(cross(sub(bottom[1], bottom[0]), sub(bottom[2], bottom[0])));
  const down: V = [0, 0, -1];
  const axis = cross(n, down);
  const s = Math.hypot(...axis);
  const c = dot(n, down);
  const rotate = (v: V): V => {
    if (s < 1e-12) return c > 0 ? v : [v[0], -v[1], -v[2]];
    const k = unit(axis);
    const kv = cross(k, v);
    const kd = dot(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
  };
  let turned = faceList.map((f) => f.map(rotate));
  const [a, b] = turned[0];
  const spin = -Math.atan2(b[1] - a[1], b[0] - a[0]);
  const [cs, sn] = [Math.cos(spin), Math.sin(spin)];
  const z0 = Math.min(...turned.flat().map((v) => v[2]));
  const clean = (x: number) => Math.round(x * 1e9) / 1e9 + 0;
  turned = turned.map((f) => f.map(([x, y, z]) => [clean(x * cs - y * sn), clean(x * sn + y * cs), clean(z - z0)] as V));
  const seen = new Map<string, V>();
  for (const v of turned.flat()) seen.set(v.join(","), v);
  const result = { vertices: [...seen.values()], faces: turned };
  cache.set(key, result);
  return result;
}

/** The shape's extents in its own frame. */
export function hedronBox(faces: HedronFaces, radius: number): [V, V] {
  const vs = hedron(faces, radius).vertices;
  const min = [0, 1, 2].map((i) => Math.min(...vs.map((v) => v[i]))) as V;
  const max = [0, 1, 2].map((i) => Math.max(...vs.map((v) => v[i]))) as V;
  return [min, max];
}
