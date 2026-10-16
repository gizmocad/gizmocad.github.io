// Light/dark theme. The page uses CSS variables (see style.css); the 3D view
// and sketch editor read their colours from the palette here.

export type ThemeSetting = "auto" | "light" | "dark";

export interface ScenePalette {
  background: number;
  gridMajor: number;
  gridMinor: number;
  gridFine: number;
  edge: number;
  picking: number;
  sketchAdd: number;
  sketchConstruction: number;
  sketchPreview: number;
  viewCube: { face: string; text: string; edge: number; highlight: number };
}

const LIGHT: ScenePalette = {
  background: 0xeef3f1,
  gridMajor: 0x7aa596,
  gridMinor: 0xc3d4cd,
  gridFine: 0xdde7e3,
  edge: 0x10261f,
  picking: 0xdfe8e4,
  sketchAdd: 0x13563f,
  sketchConstruction: 0x8a9a94,
  sketchPreview: 0x6b7f78,
  viewCube: { face: "#f8fbfa", text: "#2c4a40", edge: 0x7aa596, highlight: 0x4aa3ff },
};

const DARK: ScenePalette = {
  background: 0x151c1a,
  gridMajor: 0x3f6457,
  gridMinor: 0x2a3a35,
  gridFine: 0x1e2926,
  edge: 0x0a1411,
  picking: 0x56635e,
  sketchAdd: 0x6fe3b0,
  sketchConstruction: 0x7d8f88,
  sketchPreview: 0xa3b5ae,
  viewCube: { face: "#26322e", text: "#c9dad3", edge: 0x5d8577, highlight: 0x4aa3ff },
};

const STORAGE_KEY = "gizmocad.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function readSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    // Storage can be unavailable (private mode); fall back to auto.
  }
  return "auto";
}

let setting: ThemeSetting = readSetting();

export function themeSetting(): ThemeSetting {
  return setting;
}

export function isDark(): boolean {
  return setting === "dark" || (setting === "auto" && media.matches);
}

export function scenePalette(): ScenePalette {
  return isDark() ? DARK : LIGHT;
}

function apply() {
  const root = document.documentElement;
  if (setting === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = setting;
  listeners.forEach((fn) => fn());
}

export function setThemeSetting(next: ThemeSetting) {
  setting = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not persisted; still applies for this session.
  }
  apply();
}

/** Called whenever the effective theme may have changed (setting or OS preference). */
export function onThemeChange(fn: () => void) {
  listeners.add(fn);
}

media.addEventListener("change", () => setting === "auto" && apply());
apply();
