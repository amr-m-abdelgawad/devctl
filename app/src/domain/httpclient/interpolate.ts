/**
 * Two-syntax interpolation: `${devctl refs}` first, then `{{bruno vars}}`.
 * Each pass is single-scan. Output of `{{}}` is never re-scanned for `${}`
 * so a repo `.bru` cannot smuggle `${token}` through a variable value.
 */
export function interpolateHttpClient(
  value: string,
  resolveDevctl: (value: string) => string,
  brunoVars: Record<string, string>,
): string {
  return applyBrunoVars(resolveDevctl(value), brunoVars);
}

export function applyBrunoVars(value: string, vars: Record<string, string>): string {
  let remaining = value;
  let out = "";
  for (;;) {
    const start = remaining.indexOf("{{");
    if (start < 0) {
      return out + remaining;
    }
    out += remaining.slice(0, start);
    const end = remaining.indexOf("}}", start + 2);
    if (end < 0) {
      return out + remaining;
    }
    const key = remaining.slice(start + 2, end).trim();
    const mapped = Object.hasOwn(vars, key) ? vars[key] ?? "" : remaining.slice(start, end + 2);
    out += mapped;
    remaining = remaining.slice(end + 2);
  }
}
