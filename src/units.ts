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

const TOKEN = /\s*(?:(\d*\.?\d+(?:e[+-]?\d+)?)\s*(mm|cm|m|in|"|ft)?|([-+*/()]))/y;

type Token = { num: number } | { op: string };

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const m = TOKEN.exec(src);
    if (!m) return null;
    if (m[1] !== undefined) tokens.push({ num: parseFloat(m[1]) * (m[2] ? UNIT_MM[m[2]] : 1) });
    else tokens.push({ op: m[3] });
  }
  return tokens;
}

export function parseLength(text: string): number | null {
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
