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

const HIGH_CONFIDENCE_NAMES = new Set([
  "password",
  "passwd",
  "secret",
  "client_secret",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "id_token",
  "private_key",
  "authorization",
  "cookie",
  "set-cookie",
  "access_key",
  "auth_key",
]);

const EXACT_METADATA_NAMES = new Set([
  "TOKEN_TYPE",
  "TOKEN_COUNT",
  "TOKEN_IDS",
  "PAGE_TOKEN",
  "NEXT_PAGE_TOKEN",
  "SECRET_NAME",
  "SECRET_ID",
  "PASSWORD_CHANGED_AT",
]);

export const REDACTED_VALUE = "********";

const MIN_JWT_SEGMENT = 16;
const MIN_OPAQUE_CREDENTIAL = 20;
const OPAQUE_CREDENTIAL_RE = /^[A-Za-z0-9._~+/-]+=*$/;

export class Detector {
  private nameMarkers: string[];
  private patterns: RegExp[];
  private redactEnabled: boolean;

  constructor(extraMarkers: string[], extraPatterns: string[], redact = true) {
    this.redactEnabled = redact;
    this.nameMarkers = [];
    this.patterns = [];
    this.applyLists(extraMarkers, extraPatterns);
  }

  get redacts(): boolean {
    return this.redactEnabled;
  }

  // Mutates in place (rather than requiring callers to swap the instance) so
  // long-lived holders of this Detector — LogManager, ProxyServer — pick up
  // a configuration reload without themselves being reconstructed.
  // Omit `redact` to keep the current on/off flag.
  update(extraMarkers: string[], extraPatterns: string[], redact?: boolean): void {
    if (typeof redact === "boolean") {
      this.redactEnabled = redact;
    }
    this.applyLists(extraMarkers, extraPatterns);
  }

  isSecretName(name: string): boolean {
    if (!this.redactEnabled || name === "" || isExactTokenKey(name) || isExemptMetadataName(name)) {
      return false;
    }
    const last = lastSegment(name);
    return isHighConfidence(name) || isHighConfidence(last) || this.markersMatch(name) || this.markersMatch(last);
  }

  // A field named exactly `token` (logprob pieces, not `API_TOKEN`) is masked
  // only when the value itself looks like a credential.
  isConditionalTokenName(name: string): boolean {
    return this.redactEnabled && name !== "" && !isExemptMetadataName(name) && isExactTokenKey(name);
  }

  masksString(name: string, value: string): boolean {
    if (!this.redactEnabled || value === "") {
      return false;
    }
    if (this.isConditionalTokenName(name)) {
      return looksLikeCredential(value);
    }
    return this.isSecretName(name);
  }

  redactValue(name: string, value: string): string {
    if (!this.redactEnabled || value === "") {
      return value;
    }
    if (this.masksString(name, value) || this.matchesPattern(value)) {
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
    if (!this.redactEnabled || text === "") {
      return text;
    }
    let out = text;
    for (const re of this.patterns) {
      out = out.replace(re, REDACTED_VALUE);
    }
    return redactKnownTokens(out);
  }

  private applyLists(extraMarkers: string[], extraPatterns: string[]): void {
    this.nameMarkers = [...DEFAULT_NAME_MARKERS, ...extraMarkers];
    this.patterns = extraPatterns.flatMap((pattern) => {
      try {
        return [new RegExp(pattern)];
      } catch {
        return [];
      }
    });
  }

  private markersMatch(name: string): boolean {
    const upper = name.toUpperCase();
    return this.nameMarkers.some((marker) => nameContainsMarker(upper, marker.toUpperCase()));
  }

  private matchesPattern(value: string): boolean {
    return this.patterns.some((re) => re.test(value));
  }
}

function isHighConfidence(name: string): boolean {
  return HIGH_CONFIDENCE_NAMES.has(name.toLowerCase());
}

function isExactTokenKey(name: string): boolean {
  return name.toLowerCase() === "token";
}

function isExemptMetadataName(name: string): boolean {
  const upper = name.toUpperCase();
  return isExemptMetadataToken(upper) || isExemptMetadataToken(lastSegment(upper));
}

function isExemptMetadataToken(upper: string): boolean {
  if (EXACT_METADATA_NAMES.has(upper)) {
    return true;
  }
  return (
    upper.endsWith("_URL") ||
    upper.endsWith("_ENDPOINT") ||
    upper.endsWith("_TOKEN_COUNT") ||
    upper.endsWith("_TOKEN_TYPE") ||
    upper.endsWith("_TOKEN_IDS") ||
    upper.endsWith("_PAGE_TOKEN") ||
    upper.endsWith("_SECRET_NAME") ||
    upper.endsWith("_SECRET_ID") ||
    upper.endsWith("_PASSWORD_CHANGED_AT")
  );
}

function lastSegment(name: string): string {
  const parts = name.split(/[./:_-]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? name;
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

function looksLikeCredential(value: string): boolean {
  if (isStandaloneJwt(value) || /^ya29\.[A-Za-z0-9_-]+$/.test(value)) {
    return true;
  }
  return value.length >= MIN_OPAQUE_CREDENTIAL && OPAQUE_CREDENTIAL_RE.test(value);
}

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

function isStandaloneJwt(value: string): boolean {
  return value.startsWith(JWT_PREFIX) && jwtEnd(value, 0) === value.length;
}

function jwtEnd(text: string, start: number): number {
  let i = start;
  let dots = 0;
  let segLen = 0;
  const segLens: number[] = [];
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (isJwtChar(code)) {
      segLen += 1;
      i += 1;
    } else if (code === DOT_CODE && segLen > 0 && dots < 2) {
      segLens.push(segLen);
      dots += 1;
      segLen = 0;
      i += 1;
    } else {
      break;
    }
  }
  segLens.push(segLen);
  const longEnough = segLens.length === 3 && segLens.every((len) => len >= MIN_JWT_SEGMENT);
  return dots === 2 && longEnough ? i : -1;
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
  let out = "";
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf("bearer ", i);
    if (idx < 0) {
      return out + text.slice(i);
    }
    const boundary = idx === 0 || !isWordChar(text[idx - 1] ?? "");
    const start = idx + "bearer ".length;
    let end = start;
    while (end < text.length && !isSpace(text[end] ?? "")) {
      end += 1;
    }
    const token = text.slice(start, end);
    if (boundary && looksLikeCredential(token)) {
      out += text.slice(i, start) + REDACTED_VALUE;
      i = end;
    } else {
      out += text.slice(i, idx + 1);
      i = idx + 1;
    }
  }
  return out;
}

function isWordChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
