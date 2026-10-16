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

export type KernelRequest =
  | { type: "build"; requestId: number; features: Feature[]; combined: boolean }
  | { type: "export"; requestId: number; features: Feature[]; format: "stl" | "step" }
  /** `preview`: the normal display mesh (cached, so building the same shape next is instant). */
  | { type: "meshOf"; requestId: number; features: Feature[]; id: string; preview?: boolean };

export type KernelResponse =
  | { type: "ready" }
  | { type: "built"; requestId: number; meshes: MeshData[]; errors: Record<string, string>; adjusted: Record<string, number> }
  | { type: "exported"; requestId: number; blob: Blob }
  | { type: "mesh"; requestId: number; mesh: MeshData | null }
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
        else p.resolve(msg.blob as never);
      };
    });
  }

  private request<T>(req: DistributiveOmit<KernelRequest, "requestId">): Promise<T> {
    const requestId = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: never) => void, reject });
      // Features are plain JSON, so cloning them is safe and cheap.
      this.worker.postMessage({ ...req, requestId } as KernelRequest);
    });
  }

  /** Builds meshes; per-feature failures come back in `errors` instead of failing the whole build. */
  build(features: Feature[], combined: boolean): Promise<BuildResult> {
    return this.request({ type: "build", features, combined });
  }

  /**
   * One object's finished shape as a fine mesh, in its own frame: its own
   * geometry with fillets, or for a group, the merged result of its contents.
   */
  meshOf(features: Feature[], id: string, preview = false): Promise<MeshData | null> {
    return this.request({ type: "meshOf", features, id, preview });
  }

  export(features: Feature[], format: "stl" | "step"): Promise<Blob> {
    return this.request({ type: "export", features, format });
  }
}
