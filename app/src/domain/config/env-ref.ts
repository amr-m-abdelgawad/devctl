function envRefPattern(): RegExp {
  return /\$\{(?:env\.)?([A-Za-z_][A-Za-z0-9_]*)\}/g;
}

export function envRefsIn(value: string): string[] {
  return [...value.matchAll(envRefPattern())].map((match) => match[1] ?? "");
}

export function interpolateEnvRefs(value: string, env: Record<string, string | undefined>): { value: string; missing: string[] } {
  const missing: string[] = [];
  const interpolated = value.replace(envRefPattern(), (_whole, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === "") {
      missing.push(name);
      return "";
    }
    return resolved;
  });
  return { value: interpolated, missing };
}

const TOKEN_PLACEHOLDER = "${token}";
const TOKEN_SENTINEL = "\0DEVCTL_TOKEN\0";

/**
 * Interpolate `${NAME}` / `${env.NAME}` while leaving `${token}` for the
 * caller to fill (or substituting it when `token` is non-empty). `${token}`
 * must not be treated as process env `token`.
 */
export function interpolateEnvRefsProtectingToken(
  value: string,
  env: Record<string, string | undefined>,
  token = "",
): { value: string; missing: string[] } {
  const protectedValue = value.includes(TOKEN_PLACEHOLDER) ? value.replaceAll(TOKEN_PLACEHOLDER, TOKEN_SENTINEL) : value;
  const result = interpolateEnvRefs(protectedValue, env);
  return {
    value: result.value.replaceAll(TOKEN_SENTINEL, token === "" ? TOKEN_PLACEHOLDER : token),
    missing: result.missing,
  };
}

/** The `${NAME}` template as written, or undefined when the value is a literal secret. */
export function secretTemplateLabel(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || envRefsIn(trimmed).length === 0) {
    return undefined;
  }
  return trimmed;
}

/**
 * True when the value is exactly one complete `${NAME}` / `${env.NAME}`
 * reference with no surrounding literal text. A pure literal (no reference at
 * all) is not a whole ref; callers that accept literals must check that
 * separately. Used to reject "mixed" secret values like `prefix-${SECRET}`,
 * which would silently interpolate to a half-literal token.
 */
export function isWholeEnvRef(value: string): boolean {
  return /^\$\{(?:env\.)?[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
}

export function findTemplateRefs(value: string): string[] {
  const refs: string[] = [];
  let remaining = value;
  for (;;) {
    const start = remaining.indexOf("${");
    if (start < 0) {
      return refs;
    }
    const end = remaining.slice(start).indexOf("}");
    if (end < 0) {
      return refs;
    }
    refs.push(remaining.slice(start + 2, start + end));
    remaining = remaining.slice(start + end + 1);
  }
}
