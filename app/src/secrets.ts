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
  private readonly nameMarkers: string[];
  private readonly patterns: RegExp[];

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

  isSecretName(name: string): boolean {
    const upper = name.toUpperCase();
    return this.nameMarkers.some((marker) => upper.includes(marker.toUpperCase()));
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
    return redactBearer(out);
  }
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
