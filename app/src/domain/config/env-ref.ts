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
