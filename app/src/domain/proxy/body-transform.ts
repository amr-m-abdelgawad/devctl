// 16 MiB. A transform has to buffer the whole body before forwarding, so this
// is a hard ceiling rather than an inspect-style truncated copy.
const TRANSFORM_MAX_MIB = 16;
const BYTES_PER_MIB = 1024 * 1024;
export const REQUEST_BODY_TRANSFORM_MAX_BYTES = TRANSFORM_MAX_MIB * BYTES_PER_MIB;

export type ResolvedBodyReplacement = {
  readonly replace: string;
  readonly with: string;
  readonly regex: boolean;
};

// `with` is inserted literally. `$` is not a regular-expression replacement
// pattern, so an env-expanded URL that contains `$` is not reinterpreted.
export function applyRequestBodyReplacements(body: string, rules: readonly ResolvedBodyReplacement[]): string {
  return rules.reduce((current, rule, index) => applyBodyReplacement(current, rule, index), body);
}

export function invalidBodyReplacement(rule: ResolvedBodyReplacement, index: number): string | undefined {
  if (rule.replace === "") {
    return `transform.request_body[${index}].replace is empty`;
  }
  if (!rule.regex) {
    return undefined;
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(rule.replace);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid regular expression";
    return `transform.request_body[${index}].replace is not a valid regular expression: ${detail}`;
  }
  if (pattern.test("")) {
    return `transform.request_body[${index}].replace matches an empty string`;
  }
  return undefined;
}

function applyBodyReplacement(body: string, rule: ResolvedBodyReplacement, index: number): string {
  const invalid = invalidBodyReplacement(rule, index);
  if (invalid !== undefined) {
    throw new Error(invalid);
  }
  if (!rule.regex) {
    return body.replaceAll(rule.replace, () => rule.with);
  }
  return body.replace(new RegExp(rule.replace, "g"), () => rule.with);
}
