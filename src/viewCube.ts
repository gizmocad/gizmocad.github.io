// The view orientation cube in the corner of the 3D view. It turns with the camera;
// clicking a face, edge or corner swings the camera round to look from that side.

import * as THREE from "three";

const SIZE = 90; // CSS pixels.
const FACES: { label: string; normal: [number, number, number]; up: [number, number, number] }[] = [
  { label: "RIGHT", normal: [1, 0, 0], up: [0, 0, 1] },
  { label: "LEFT", normal: [-1, 0, 0], up: [0, 0, 1] },
  { label: "BACK", normal: [0, 1, 0], up: [0, 0, 1] },
  { label: "FRONT", normal: [0, -1, 0], up: [0, 0, 1] },
  { label: "TOP", normal: [0, 0, 1], up: [0, 1, 0] },
  { label: "BOTTOM", normal: [0, 0, -1], up: [0, 1, 0] },
];

export interface ViewCubeColors {
  face: string;
  text: string;
  edge: number;
  highlight: number;
}

export class ViewCube {
  readonly element: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);
  private cube = new THREE.Group();
  private faces: THREE.Mesh[] = [];
  private outline: THREE.LineSegments;
  private hover: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;

  /** `onPick` gets the direction (from the target towards the camera) to look from. */
  constructor(parent: HTMLElement, private onPick: (direction: THREE.Vector3) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(SIZE, SIZE);
    this.element = this.renderer.domElement;
    this.element.className = "view-cube";
    this.element.title = "Click a face, edge or corner to look from that side";
    parent.appendChild(this.element);

    for (const f of FACES) {
      const n = new THREE.Vector3(...f.normal);
      const up = new THREE.Vector3(...f.up);
      const right = up.clone().cross(n);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(right, up, n).setPosition(n);
      mesh.userData.label = f.label;
      this.faces.push(mesh);
      this.cube.add(mesh);
    }
    this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial());
    this.cube.add(this.outline);

    // Axis lines from the corner: X red, Y green, Z blue.
    const corner = new THREE.Vector3(-1.04, -1.04, -1.04);
    for (const [dir, color] of [[[1, 0, 0], 0xe5534b], [[0, 1, 0], 0x3fb950], [[0, 0, 1], 0x4a8bff]] as const) {
      const end = corner.clone().addScaledVector(new THREE.Vector3(...dir), 2.5);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([corner, end]), new THREE.LineBasicMaterial({ color }));
      this.cube.add(line);
    }

    this.hover = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }));
    this.hover.visible = false;
    this.cube.add(this.hover);
    this.scene.add(this.cube);

    this.element.addEventListener("pointermove", (e) => this.showHover(this.pick(e)));
    this.element.addEventListener("pointerleave", () => this.showHover(null));
    this.element.addEventListener("pointerdown", (e) => {
      this.down = { x: e.clientX, y: e.clientY };
    });
    this.element.addEventListener("pointerup", (e) => {
      const d = this.down;
      this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return;
      const dir = this.pick(e);
      if (dir) this.onPick(dir);
    });
    this.element.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  setColors(c: ViewCubeColors) {
    for (const mesh of this.faces) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.map = labelTexture(mesh.userData.label, c);
      mat.needsUpdate = true;
    }
    (this.outline.material as THREE.LineBasicMaterial).color.setHex(c.edge);
    (this.hover.material as THREE.MeshBasicMaterial).color.setHex(c.highlight);
  }

  set visible(v: boolean) {
    this.element.hidden = !v;
  }

  /** Turn the cube to match the main camera (looking from `camera` towards `target`). */
  render(camera: THREE.Camera, target: THREE.Vector3) {
    if (this.element.hidden) return;
    const dir = camera.position.clone().sub(target).normalize();
    this.camera.position.copy(dir).multiplyScalar(8);
    this.camera.up.copy(camera.up);
    this.camera.quaternion.copy(camera.quaternion);
    this.renderer.render(this.scene, this.camera);
  }

  /** The face (one axis), edge (two) or corner (three) under the pointer, as a direction. */
  private pick(e: PointerEvent): THREE.Vector3 | null {
    const r = this.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.faces, false)[0];
    if (!hit) return null;
    const p = hit.point;
    const s = (v: number) => (Math.abs(v) > 0.6 ? Math.sign(v) : 0);
    return new THREE.Vector3(s(p.x), s(p.y), s(p.z));
  }

  private showHover(dir: THREE.Vector3 | null) {
    this.hover.visible = !!dir;
    this.element.style.cursor = dir ? "pointer" : "";
    if (!dir) return;
    // A thin box over just that face, edge or corner region.
    const size = (v: number) => (v ? 0.42 : 1.2);
    const at = (v: number) => v * 0.8;
    this.hover.scale.set(size(dir.x), size(dir.y), size(dir.z));
    this.hover.position.set(at(dir.x), at(dir.y), at(dir.z));
    this.hover.scale.multiplyScalar(1.01);
  }
}

function labelTexture(label: string, c: ViewCubeColors): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const g = canvas.getContext("2d")!;
  g.fillStyle = c.face;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = c.text;
  g.font = `600 ${label.length > 5 ? 25 : 30}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, 64, 66);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
