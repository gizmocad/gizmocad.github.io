// Main-thread side of the kernel: a small promise-based API over the worker.

import type { Feature } from "./model";

export interface MeshData {
  id: string;
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  /** Flat list of line-segment endpoints for drawing edges. */
  edges: Float32Array;
  /** (start vertex, vertex count, edge id) triples: which segments belong to which edge. */
  edgeGroups: Int32Array;
}

/** A STEP or BREP file (or one FreeCAD object's shape) to import. */
export interface ImportSource {
  name: string;
  format: "step" | "brep" | "mesh";
  data?: ArrayBuffer | string;
  /** A "mesh": its triangles, made into a solid (a mesh with gaps is refused). */
  vertices?: Float32Array;
  triangles?: Uint32Array;
  color?: string;
  /** FreeCAD Part containers it sits in, nearest first: turn (degrees about `axis`), then move. */
  placements?: { position: [number, number, number]; axis: [number, number, number]; angle: number }[];
}

/** One solid from an imported file (its own origin moved to the middle of its base), or its loose surfaces as a mesh. */
export type ImportedSolid =
  | { kind: "solid"; name: string; color?: string; brep: string; size: [number, number, number]; anchor: [number, number, number]; faceted?: boolean }
  | { kind: "mesh"; name: string; color?: string; vertices: Float32Array; triangles: Uint32Array };

export type KernelRequest =
  /** `cuts`: show each object with the holes that reach it cut away. */
  | { type: "build"; requestId: number; features: Feature[]; combined: boolean; cuts?: boolean }
  | { type: "export"; requestId: number; features: Feature[]; format: "stl" | "step" }
  /** One finished mesh per top-level object, in world coordinates (for 3MF). */
  | { type: "parts"; requestId: number; features: Feature[] }
  /** `preview`: the normal display mesh (cached, so building the same shape next is instant). */
  | { type: "meshOf"; requestId: number; features: Feature[]; id: string; preview?: boolean }
  | { type: "importSolids"; requestId: number; files: ImportSource[] }
  /** A font imported into the model, for texts whose font is "custom:<id>". */
  | { type: "font"; requestId: number; id: string; data: ArrayBuffer }
  /** Mesh objects that holes cut, as world triangles. */
  | { type: "cutMeshes"; requestId: number; features: Feature[] };

export type KernelResponse =
  | { type: "ready" }
  | { type: "built"; requestId: number; meshes: MeshData[]; errors: Record<string, string>; adjusted: Record<string, number> }
  | { type: "exported"; requestId: number; blob: Blob }
  | { type: "mesh"; requestId: number; mesh: MeshData | null }
  | { type: "parts"; requestId: number; parts: MeshData[] }
  | { type: "importedSolids"; requestId: number; parts: ImportedSolid[] }
  | { type: "fontLoaded"; requestId: number; name: string }
  | { type: "cutMeshes"; requestId: number; meshes: Record<string, Float32Array> }
  | { type: "error"; requestId: number; message: string };

export interface BuildResult {
  meshes: MeshData[];
  errors: Record<string, string>;
  /** Fillet/chamfer op id → the safe size actually used (0 = couldn't apply). */
  adjusted: Record<string, number>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Pending = { resolve: (value: never) => void; reject: (err: Error) => void };

export class Kernel {
  private worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module" });
  private pending = new Map<number, Pending>();
  private nextId = 1;
  readonly ready: Promise<void>;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<KernelResponse>) => {
        const msg = event.data;
        if (msg.type === "ready") return resolve();
        if (msg.type === "error" && msg.requestId === -1) return reject(new Error(msg.message));
        const p = this.pending.get(msg.requestId);
        if (!p) return;
        this.pending.delete(msg.requestId);
        if (msg.type === "error") p.reject(new Error(msg.message));
        else if (msg.type === "built") p.resolve({ meshes: msg.meshes, errors: msg.errors, adjusted: msg.adjusted } as never);
        else if (msg.type === "mesh") p.resolve(msg.mesh as never);
        else if (msg.type === "parts" || msg.type === "importedSolids") p.resolve(msg.parts as never);
        else if (msg.type === "fontLoaded") p.resolve(msg.name as never);
        else if (msg.type === "cutMeshes") p.resolve(msg.meshes as never);
        else p.resolve(msg.blob as never);
      };
    });
  }

  /** Imported solids whose BREP text the worker already has (it keeps them by ref). */
  private sentBreps = new Set<string>();

  /**
   * A copy of the features for the worker. Imported geometry it already has
   * (it can be megabytes) is left out rather than copied for every rebuild.
   */
  snapshot(features: Feature[]): Feature[] {
    return features.map((f) =>
      f.kind === "imported" && f.params.brep && this.sentBreps.has(f.params.ref) ? structuredClone({ ...f, params: { ...f.params, brep: "" } }) : structuredClone(f),
    );
  }

  private request<T>(req: DistributiveOmit<KernelRequest, "requestId">): Promise<T> {
    const requestId = this.nextId++;
    if ("features" in req) {
      req = { ...req, features: this.snapshot(req.features) };
      for (const f of req.features) if (f.kind === "imported" && f.params.brep) this.sentBreps.add(f.params.ref);
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: never) => void, reject });
      this.worker.postMessage({ ...req, requestId } as KernelRequest);
    });
  }

  /** Builds meshes; per-feature failures come back in `errors` instead of failing the whole build. */
  build(features: Feature[], combined: boolean, cuts = false): Promise<BuildResult> {
    return this.request({ type: "build", features, combined, cuts });
  }

  /**
   * One object's finished shape as a fine mesh, in its own frame: its own
   * geometry with fillets, or for a group, the merged result of its contents.
   */
  meshOf(features: Feature[], id: string, preview = false): Promise<MeshData | null> {
    return this.request({ type: "meshOf", features, id, preview });
  }

  /** Each top-level object's finished mesh (world coordinates), with top-level holes cut from it. */
  parts(features: Feature[]): Promise<MeshData[]> {
    return this.request({ type: "parts", features });
  }

  /** Solids from STEP/BREP files, split into one per solid. */
  importSolids(files: ImportSource[]): Promise<ImportedSolid[]> {
    return this.request({ type: "importSolids", files });
  }

  /** Give the kernel an imported font; resolves to the font's name (rejects if it can't be read). */
  loadFont(id: string, data: ArrayBuffer): Promise<string> {
    return this.request({ type: "font", id, data });
  }

  /** Mesh objects (imported meshes, sculpts) that holes cut: their cut triangles in world coordinates, by id. */
  cutMeshes(features: Feature[]): Promise<Record<string, Float32Array>> {
    return this.request({ type: "cutMeshes", features });
  }

  export(features: Feature[], format: "stl" | "step"): Promise<Blob> {
    return this.request({ type: "export", features, format });
  }
}
