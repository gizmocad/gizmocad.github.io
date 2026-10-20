// Parses length input such as "25.4", "1in", "2.5 cm", "10/3" or "1in + 2mm"
// into millimetres. Returns null when the text isn't a valid length.

const UNIT_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  '"': 25.4,
  ft: 304.8,
};

// A number (with an optional unit), an operator, or a parameter's name.
const TOKEN = /\s*(?:(\d*\.?\d+(?:e[+-]?\d+)?)\s*(mm|cm|m|in|"|ft)?(?![a-z_0-9])|([-+*/()])|([a-z_][a-z0-9_]*))/y;

type Token = { num: number } | { op: string } | { name: string };

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const m = TOKEN.exec(src);
    if (!m) return null;
    if (m[1] !== undefined) tokens.push({ num: parseFloat(m[1]) * (m[2] ? UNIT_MM[m[2]] : 1) });
    else if (m[3] !== undefined) tokens.push({ op: m[3] });
    else tokens.push({ name: m[4] });
  }
  return tokens;
}

/** The parameter names an expression uses (lower case). */
export function expressionNames(text: string): string[] {
  return (tokenize(text.trim().toLowerCase()) ?? []).flatMap((t) => ("name" in t ? [t.name] : []));
}

/** Whether a name can be a parameter's: letters, digits and _, not starting with a digit, and not a unit. */
export const validName = (name: string) => /^[a-z_][a-z0-9_]*$/i.test(name) && !(name.toLowerCase() in UNIT_MM);

/** `vars`: parameters' values by (lower-case) name, which the text may use. */
export function parseLength(text: string, vars: Record<string, number> = {}): number | null {
  const maybeTokens = tokenize(text.trim().toLowerCase());
  if (!maybeTokens || maybeTokens.length === 0) return null;
  const tokens = maybeTokens;
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (t: Token | undefined, op: string) => !!t && "op" in t && t.op === op;

  // expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ; factor := num | '-' factor | '(' expr ')'
  function factor(): number {
    const t = tokens[i++];
    if (!t) throw new Error("unexpected end");
    if ("num" in t) return t.num;
    if ("name" in t) {
      if (!(t.name in vars)) throw new Error(`unknown name ${t.name}`);
      return vars[t.name];
    }
    if (t.op === "-") return -factor();
    if (t.op === "+") return factor();
    if (t.op === "(") {
      const v = expr();
      if (!isOp(tokens[i++], ")")) throw new Error("missing )");
      return v;
    }
    throw new Error("unexpected token");
  }
  function term(): number {
    let v = factor();
    while (isOp(peek(), "*") || isOp(peek(), "/")) {
      const op = (tokens[i++] as { op: string }).op;
      v = op === "*" ? v * factor() : v / factor();
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (isOp(peek(), "+") || isOp(peek(), "-")) {
      const op = (tokens[i++] as { op: string }).op;
      v = op === "+" ? v + term() : v - term();
    }
    return v;
  }

  try {
    const value = expr();
    return i === tokens.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function formatLength(mm: number): string {
  return String(Math.round(mm * 1e4) / 1e4);
}
