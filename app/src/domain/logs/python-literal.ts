import { isPlainObject, MAX_ANY_VALUE_DEPTH } from "./any-value.ts";

type Cursor = {
  readonly text: string;
  index: number;
};

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const fail: Parsed<never> = { ok: false };
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

export function parsePythonLiteral(text: string): unknown | undefined {
  const cursor: Cursor = { text, index: 0 };
  const parsed = parseValue(cursor, 0);
  if (!parsed.ok) {
    return undefined;
  }
  skipWs(cursor);
  if (cursor.index !== text.length) {
    return undefined;
  }
  return parsed.value;
}

export function parsePythonLiteralObject(text: string): Record<string, unknown> | undefined {
  const value = parsePythonLiteral(text);
  return isPlainObject(value) ? value : undefined;
}

function parseValue(cursor: Cursor, depth: number): Parsed<unknown> {
  skipWs(cursor);
  if (depth >= MAX_ANY_VALUE_DEPTH) {
    return fail;
  }
  const ch = cursor.text[cursor.index];
  if (ch === "{") {
    return parseObject(cursor, depth);
  }
  if (ch === "[") {
    return parseArray(cursor, depth);
  }
  if (ch === "'" || ch === '"') {
    return parseString(cursor);
  }
  if (ch === "-" || isDigit(ch)) {
    return parseNumber(cursor);
  }
  return parseKeyword(cursor);
}

function parseObject(cursor: Cursor, depth: number): Parsed<Record<string, unknown>> {
  cursor.index += 1;
  skipWs(cursor);
  if (cursor.text[cursor.index] === "}") {
    cursor.index += 1;
    return ok({});
  }
  const out: Record<string, unknown> = {};
  while (cursor.index < cursor.text.length) {
    const key = parseKey(cursor);
    if (key === undefined) {
      return fail;
    }
    skipWs(cursor);
    if (cursor.text[cursor.index] !== ":") {
      return fail;
    }
    cursor.index += 1;
    const parsed = parseValue(cursor, depth + 1);
    if (!parsed.ok) {
      return fail;
    }
    out[key] = parsed.value;
    skipWs(cursor);
    const sep = cursor.text[cursor.index];
    if (sep === ",") {
      cursor.index += 1;
      skipWs(cursor);
      if (cursor.text[cursor.index] === "}") {
        cursor.index += 1;
        return ok(out);
      }
    } else if (sep === "}") {
      cursor.index += 1;
      return ok(out);
    } else {
      return fail;
    }
  }
  return fail;
}

function parseArray(cursor: Cursor, depth: number): Parsed<unknown[]> {
  cursor.index += 1;
  skipWs(cursor);
  if (cursor.text[cursor.index] === "]") {
    cursor.index += 1;
    return ok([]);
  }
  const items: unknown[] = [];
  while (cursor.index < cursor.text.length) {
    const parsed = parseValue(cursor, depth + 1);
    if (!parsed.ok) {
      return fail;
    }
    items.push(parsed.value);
    skipWs(cursor);
    const sep = cursor.text[cursor.index];
    if (sep === ",") {
      cursor.index += 1;
      skipWs(cursor);
      if (cursor.text[cursor.index] === "]") {
        cursor.index += 1;
        return ok(items);
      }
    } else if (sep === "]") {
      cursor.index += 1;
      return ok(items);
    } else {
      return fail;
    }
  }
  return fail;
}

function parseKey(cursor: Cursor): string | undefined {
  skipWs(cursor);
  const start = cursor.index;
  const str = parseString(cursor);
  if (str.ok) {
    return str.value;
  }
  cursor.index = start;
  const num = parseNumber(cursor);
  if (num.ok) {
    return String(num.value);
  }
  cursor.index = start;
  return parseIdentifier(cursor);
}

function parseString(cursor: Cursor): Parsed<string> {
  const quote = cursor.text[cursor.index];
  if (quote !== "'" && quote !== '"') {
    return fail;
  }
  cursor.index += 1;
  let out = "";
  while (cursor.index < cursor.text.length) {
    const ch = cursor.text[cursor.index];
    if (ch === quote) {
      cursor.index += 1;
      return ok(out);
    }
    if (ch === "\\") {
      cursor.index += 1;
      const escaped = cursor.text[cursor.index];
      if (escaped === undefined) {
        return fail;
      }
      out += unescapeChar(escaped);
      cursor.index += 1;
    } else {
      out += ch;
      cursor.index += 1;
    }
  }
  return fail;
}

function parseNumber(cursor: Cursor): Parsed<number> {
  NUMBER_RE.lastIndex = cursor.index;
  const match = NUMBER_RE.exec(cursor.text);
  if (!match) {
    return fail;
  }
  const n = Number(match[0]);
  if (!Number.isFinite(n)) {
    return fail;
  }
  cursor.index = NUMBER_RE.lastIndex;
  return ok(n);
}

function parseKeyword(cursor: Cursor): Parsed<unknown> {
  if (takeWord(cursor, "True") || takeWord(cursor, "true")) {
    return ok(true);
  }
  if (takeWord(cursor, "False") || takeWord(cursor, "false")) {
    return ok(false);
  }
  if (takeWord(cursor, "None") || takeWord(cursor, "null")) {
    return ok(null);
  }
  return fail;
}

function parseIdentifier(cursor: Cursor): string | undefined {
  IDENT_RE.lastIndex = cursor.index;
  const match = IDENT_RE.exec(cursor.text);
  if (!match) {
    return undefined;
  }
  cursor.index = IDENT_RE.lastIndex;
  return match[0];
}

function takeWord(cursor: Cursor, word: string): boolean {
  if (!cursor.text.startsWith(word, cursor.index)) {
    return false;
  }
  const next = cursor.text[cursor.index + word.length];
  if (next !== undefined && isIdentContinue(next)) {
    return false;
  }
  cursor.index += word.length;
  return true;
}

function skipWs(cursor: Cursor): void {
  const { text } = cursor;
  while (cursor.index < text.length) {
    const ch = text[cursor.index];
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      return;
    }
    cursor.index += 1;
  }
}

function unescapeChar(ch: string): string {
  if (ch === "n") {
    return "\n";
  }
  if (ch === "t") {
    return "\t";
  }
  if (ch === "r") {
    return "\r";
  }
  return ch;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isIdentContinue(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}
