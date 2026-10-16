// Saving and opening files. The desktop app (Tauri) uses native dialogs; the
// website falls back to a download link and a file picker.

const isTauri = "__TAURI_INTERNALS__" in window;

export async function saveFile(blob: Blob, suggestedName: string, filterName: string, extension: string): Promise<void> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: suggestedName, filters: [{ name: filterName, extensions: [extension] }] });
    if (path) await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Returns the chosen file's text, or null if the user cancelled. */
export async function openTextFile(input: HTMLInputElement): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, filters: [{ name: "GizmoCAD model", extensions: ["gizmocad", "mintcad", "json"] }] });
    return typeof path === "string" ? readTextFile(path) : null;
  }
  return new Promise((resolve) => {
    input.value = "";
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? file.text() : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Pick a file to import (by extension); returns its name and bytes, or null if cancelled. */
export async function openImportFile(input: HTMLInputElement, extensions: string[], filterName: string): Promise<{ name: string; data: ArrayBuffer } | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, filters: [{ name: filterName, extensions }] });
    if (typeof path !== "string") return null;
    const bytes = await readFile(path);
    return { name: path.split(/[\\/]/).pop() ?? path, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  }
  return new Promise((resolve) => {
    input.value = "";
    input.accept = extensions.map((e) => `.${e}`).join(",");
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, data: await file.arrayBuffer() } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
