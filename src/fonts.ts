// Fonts for text: the ones bundled with the app (all free: OFL or Apache
// licensed, from Fontsource), and helpers for fonts people import themselves.
// Shared by the panel (previews) and the kernel (letter outlines).

import sans400 from "@fontsource/roboto/files/roboto-latin-400-normal.woff?url";
import sans700 from "@fontsource/roboto/files/roboto-latin-700-normal.woff?url";
import serif400 from "@fontsource/roboto-slab/files/roboto-slab-latin-400-normal.woff?url";
import serif700 from "@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url";
import mono400 from "@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff?url";
import mono700 from "@fontsource/roboto-mono/files/roboto-mono-latin-700-normal.woff?url";
import rounded400 from "@fontsource/nunito/files/nunito-latin-400-normal.woff?url";
import rounded700 from "@fontsource/nunito/files/nunito-latin-700-normal.woff?url";
import condensed400 from "@fontsource/oswald/files/oswald-latin-400-normal.woff?url";
import condensed700 from "@fontsource/oswald/files/oswald-latin-700-normal.woff?url";
import poster400 from "@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url";
import stencil400 from "@fontsource/stardos-stencil/files/stardos-stencil-latin-400-normal.woff?url";
import stencil700 from "@fontsource/stardos-stencil/files/stardos-stencil-latin-700-normal.woff?url";
import script400 from "@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url";
import techno400 from "@fontsource/orbitron/files/orbitron-latin-400-normal.woff?url";
import techno700 from "@fontsource/orbitron/files/orbitron-latin-700-normal.woff?url";
import comic400 from "@fontsource/comic-neue/files/comic-neue-latin-400-normal.woff?url";
import comic700 from "@fontsource/comic-neue/files/comic-neue-latin-700-normal.woff?url";
import handwriting400 from "@fontsource/caveat/files/caveat-latin-400-normal.woff?url";
import handwriting700 from "@fontsource/caveat/files/caveat-latin-700-normal.woff?url";
import blackletter400 from "@fontsource/unifrakturmaguntia/files/unifrakturmaguntia-latin-400-normal.woff?url";
import cartoon400 from "@fontsource/luckiest-guy/files/luckiest-guy-latin-400-normal.woff?url";

export interface BuiltInFont {
  key: string;
  /** The typeface's own name. */
  name: string;
  /** What it looks like, for the menu. */
  style: string;
  regular: string;
  /** Fonts without a bold weight use the regular one. */
  bold?: string;
}

export const BUILT_IN_FONTS: BuiltInFont[] = [
  { key: "sans", name: "Roboto", style: "plain", regular: sans400, bold: sans700 },
  { key: "serif", name: "Roboto Slab", style: "serif", regular: serif400, bold: serif700 },
  { key: "mono", name: "Roboto Mono", style: "typewriter", regular: mono400, bold: mono700 },
  { key: "rounded", name: "Nunito", style: "rounded", regular: rounded400, bold: rounded700 },
  { key: "condensed", name: "Oswald", style: "narrow", regular: condensed400, bold: condensed700 },
  { key: "poster", name: "Bebas Neue", style: "tall capitals", regular: poster400 },
  { key: "stencil", name: "Stardos Stencil", style: "stencil", regular: stencil400, bold: stencil700 },
  { key: "techno", name: "Orbitron", style: "sci-fi", regular: techno400, bold: techno700 },
  { key: "cartoon", name: "Luckiest Guy", style: "cartoon", regular: cartoon400 },
  { key: "comic", name: "Comic Neue", style: "comic", regular: comic400, bold: comic700 },
  { key: "script", name: "Pacifico", style: "joined script", regular: script400 },
  { key: "handwriting", name: "Caveat", style: "handwriting", regular: handwriting400, bold: handwriting700 },
  { key: "blackletter", name: "UnifrakturMaguntia", style: "old English", regular: blackletter400 },
];

export const builtInFont = (key: string) => BUILT_IN_FONTS.find((f) => f.key === key);

/** A text's `font` for a font imported into the model. */
export const CUSTOM_FONT = "custom:";
export const isCustomFont = (font: string) => font.startsWith(CUSTOM_FONT);

/** The kernel's name for a font at a weight (imported fonts have just the one). */
export function fontFamily(font: string, bold: boolean): string {
  if (isCustomFont(font)) return font;
  const f = builtInFont(font) ?? BUILT_IN_FONTS[0];
  return `${f.key}-${bold && f.bold ? 700 : 400}`;
}

/** Where a built-in family's file is. */
export function builtInFontUrl(family: string): string | undefined {
  const [key, weight] = family.split("-");
  const f = builtInFont(key);
  return f && (weight === "700" ? f.bold : f.regular);
}
