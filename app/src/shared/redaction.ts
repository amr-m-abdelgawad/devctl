const DEFAULT_NAME_MARKERS = [
  "PASSWORD",
  "SECRET",
  "TOKEN",
  "PRIVATE_KEY",
  "CLIENT_SECRET",
  "API_KEY",
  "CREDENTIAL",
  "ACCESS_KEY",
  "AUTH_KEY",
];

export const REDACTED_VALUE = "********";

export class Detector {
  private nameMarkers: string[];
  private patterns: RegExp[];

  constructor(extraMarkers: string[], extraPatterns: string[]) {
    this.nameMarkers = [...DEFAULT_NAME_MARKERS, ...extraMarkers];
    this.patterns = extraPatterns.flatMap((pattern) => {
      try {
        return [new RegExp(pattern)];
      } catch {
        return [];
      }
    });
  }

  // Mutates in place (rather than requiring callers to swap the instance) so
  // long-lived holders of this Detector — LogManager, ProxyServer — pick up
  // a configuration reload without themselves being reconstructed.
  update(extraMarkers: string[], extraPatterns: string[]): void {
    this.nameMarkers = [...DEFAULT_NAME_MARKERS, ...extraMarkers];
    this.patterns = extraPatterns.flatMap((pattern) => {
      try {
        return [new RegExp(pattern)];
      } catch {
        return [];
      }
    });
  }

  isSecretName(name: string): boolean {
    const upper = name.toUpperCase();
    return this.nameMarkers.some((marker) => nameContainsMarker(upper, marker.toUpperCase()));
  }

  redactValue(name: string, value: string): string {
    if (value === "") {
      return value;
    }
    if (this.isSecretName(name)) {
      return REDACTED_VALUE;
    }
    if (this.patterns.some((re) => re.test(value))) {
      return REDACTED_VALUE;
    }
    return value;
  }

  redactMap(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      out[key] = this.redactValue(key, value);
    }
    return out;
  }

  redactText(text: string): string {
    if (text === "") {
      return text;
    }
    let out = text;
    for (const re of this.patterns) {
      out = out.replace(re, REDACTED_VALUE);
    }
    return redactKnownTokens(out);
  }
}

// Match a marker as a delimited token (`API_TOKEN`, `x-token`) rather than a
// substring of a longer word — `prompt_tokens` contains TOKEN inside TOKENS.
function nameContainsMarker(upperName: string, marker: string): boolean {
  if (upperName === marker) {
    return true;
  }
  let from = 0;
  while (from <= upperName.length - marker.length) {
    const idx = upperName.indexOf(marker, from);
    if (idx < 0) {
      return false;
    }
    const beforeOk = idx === 0 || isNameDelimiter(upperName[idx - 1] ?? "");
    const afterIdx = idx + marker.length;
    const afterOk = afterIdx >= upperName.length || isNameDelimiter(upperName[afterIdx] ?? "");
    if (beforeOk && afterOk) {
      return true;
    }
    from = idx + 1;
  }
  return false;
}

function isNameDelimiter(ch: string): boolean {
  return ch === "_" || ch === "-" || ch === "." || ch === "/" || ch === ":";
}

const GOOGLE_ACCESS_RE = /ya29\.[A-Za-z0-9_-]+/g;

const TOKEN_ASSIGN_RE = /\b(id_token|access_token)=([^\s&"']+)/gi;

const JWT_PREFIX = "eyJ";
const DOT_CODE = 46;

function redactKnownTokens(text: string): string {
  let out = redactBearer(text);
  out = redactJwts(out);
  GOOGLE_ACCESS_RE.lastIndex = 0;
  out = out.replace(GOOGLE_ACCESS_RE, REDACTED_VALUE);
  TOKEN_ASSIGN_RE.lastIndex = 0;
  return out.replace(TOKEN_ASSIGN_RE, `$1=${REDACTED_VALUE}`);
}

// Linear scan; `/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g` is a
// polynomial-ReDoS finding on log lines that start with `eyJ` and repeat it.
function redactJwts(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(JWT_PREFIX, i);
    if (start < 0) {
      return out + text.slice(i);
    }
    out += text.slice(i, start);
    const end = jwtEnd(text, start);
    if (end > start) {
      out += REDACTED_VALUE;
      i = end;
    } else {
      const skipTo = skipJwtRun(text, start);
      out += text.slice(start, skipTo);
      i = skipTo;
    }
  }
  return out;
}

function jwtEnd(text: string, start: number): number {
  let i = start;
  let dots = 0;
  let segLen = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (isJwtChar(code)) {
      segLen += 1;
      i += 1;
    } else if (code === DOT_CODE && segLen > 0 && dots < 2) {
      dots += 1;
      segLen = 0;
      i += 1;
    } else {
      break;
    }
  }
  return dots === 2 && segLen > 0 ? i : -1;
}

function skipJwtRun(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (!isJwtChar(code) && code !== DOT_CODE) {
      break;
    }
    i += 1;
  }
  return i > start ? i : start + 1;
}

function isJwtChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 95
  );
}

function redactBearer(text: string): string {
  const lower = text.toLowerCase();
  const authPrefix = "authorization: bearer ";
  const authIdx = lower.indexOf(authPrefix);
  if (authIdx >= 0) {
    return replaceToken(text, authIdx + authPrefix.length);
  }
  const bearerIdx = lower.indexOf("bearer ");
  if (bearerIdx < 0) {
    return text;
  }
  return replaceToken(text, bearerIdx + "bearer ".length);
}

function replaceToken(text: string, start: number): string {
  let end = start;
  while (end < text.length && !isSpace(text[end] ?? "")) {
    end += 1;
  }
  return text.slice(0, start) + REDACTED_VALUE + text.slice(end);
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
