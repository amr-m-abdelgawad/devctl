const MAX_LOG_SEARCH_REGEX = 200;
const MAX_LOG_REGEX_QUANTIFIERS = 8;
const MAX_LOG_REGEX_DEPTH = 2;

type RegexAtom = "none" | "atom" | "quantified-group" | "quant";

type RegexParser = {
  readonly raw: string;
  i: number;
  readonly out: string[];
  quantifiers: number;
  depth: number;
  lastAtom: RegexAtom;
  readonly groupQuant: boolean[];
};

export function compileLogSearch(pattern: string): RegExp | undefined {
  const source = rewriteLogRegex(pattern);
  if (source === undefined) {
    return undefined;
  }
  return new RegExp(source);
}

function rewriteLogRegex(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > MAX_LOG_SEARCH_REGEX) {
    return undefined;
  }
  const parser: RegexParser = {
    raw,
    i: 0,
    out: [],
    quantifiers: 0,
    depth: 0,
    lastAtom: "none",
    groupQuant: [],
  };
  if (!parseRegexBody(parser) || parser.i !== raw.length || parser.depth !== 0) {
    return undefined;
  }
  return parser.out.join("");
}

function parseRegexBody(parser: RegexParser): boolean {
  while (parser.i < parser.raw.length) {
    if (parser.raw[parser.i] === ")") {
      return true;
    }
    if (!parseRegexPart(parser)) {
      return false;
    }
  }
  return true;
}

function parseRegexPart(parser: RegexParser): boolean {
  const ch = parser.raw[parser.i] ?? "";
  if (ch === "|") {
    return emitOp(parser, "|", "none");
  }
  if (ch === "^") {
    return emitOp(parser, "^", "none");
  }
  if (ch === "$") {
    return emitOp(parser, "$", "none");
  }
  if (ch === ".") {
    return emitOp(parser, ".", "atom");
  }
  if (ch === "(") {
    return parseGroup(parser);
  }
  if (ch === "[") {
    return parseClass(parser);
  }
  if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
    return parseQuantifier(parser);
  }
  if (ch === "\\") {
    return parseEscape(parser);
  }
  parser.out.push(RegExp.escape(ch));
  parser.i += 1;
  parser.lastAtom = "atom";
  return true;
}

function emitOp(parser: RegexParser, op: string, atom: RegexAtom): boolean {
  parser.out.push(op);
  parser.i += 1;
  parser.lastAtom = atom;
  return true;
}

function parseGroup(parser: RegexParser): boolean {
  parser.i += 1;
  parser.depth += 1;
  if (parser.depth > MAX_LOG_REGEX_DEPTH) {
    return false;
  }
  parser.groupQuant.push(false);
  parser.out.push("(?:");
  if (!parseRegexBody(parser) || parser.raw[parser.i] !== ")") {
    return false;
  }
  parser.out.push(")");
  parser.i += 1;
  parser.depth -= 1;
  const innerQuant = parser.groupQuant.pop() === true;
  parser.lastAtom = innerQuant ? "quantified-group" : "atom";
  return true;
}

function parseQuantifier(parser: RegexParser): boolean {
  const ch = parser.raw[parser.i] ?? "";
  if (ch === "{" || parser.lastAtom === "none" || parser.lastAtom === "quant" || parser.lastAtom === "quantified-group") {
    return false;
  }
  if (parser.quantifiers >= MAX_LOG_REGEX_QUANTIFIERS) {
    return false;
  }
  if (ch === "*") {
    parser.out.push("*");
  } else if (ch === "+") {
    parser.out.push("+");
  } else if (ch === "?") {
    parser.out.push("?");
  } else {
    return false;
  }
  parser.i += 1;
  parser.quantifiers += 1;
  const parent = parser.groupQuant.length - 1;
  if (parent >= 0) {
    parser.groupQuant[parent] = true;
  }
  if (parser.raw[parser.i] === "?") {
    parser.out.push("?");
    parser.i += 1;
  }
  parser.lastAtom = "quant";
  return true;
}

function parseClass(parser: RegexParser): boolean {
  parser.i += 1;
  parser.out.push("[");
  if (parser.raw[parser.i] === "^") {
    parser.out.push("^");
    parser.i += 1;
  }
  if (parser.raw[parser.i] === "]") {
    parser.out.push(RegExp.escape("]"));
    parser.i += 1;
  }
  while (parser.i < parser.raw.length && parser.raw[parser.i] !== "]") {
    const ch = parser.raw[parser.i] ?? "";
    if (ch === "\\") {
      if (!parseEscape(parser)) {
        return false;
      }
    } else if (ch === "-") {
      parser.out.push("-");
      parser.i += 1;
    } else {
      parser.out.push(RegExp.escape(ch));
      parser.i += 1;
    }
  }
  if (parser.raw[parser.i] !== "]") {
    return false;
  }
  parser.out.push("]");
  parser.i += 1;
  parser.lastAtom = "atom";
  return true;
}

function parseEscape(parser: RegexParser): boolean {
  const next = parser.raw[parser.i + 1];
  if (next === undefined) {
    return false;
  }
  if (next === "d") {
    parser.out.push("\\d");
  } else if (next === "D") {
    parser.out.push("\\D");
  } else if (next === "w") {
    parser.out.push("\\w");
  } else if (next === "W") {
    parser.out.push("\\W");
  } else if (next === "s") {
    parser.out.push("\\s");
  } else if (next === "S") {
    parser.out.push("\\S");
  } else if (next === "n") {
    parser.out.push("\\n");
  } else if (next === "t") {
    parser.out.push("\\t");
  } else if (next === "r") {
    parser.out.push("\\r");
  } else if (next === "b") {
    parser.out.push("\\b");
  } else if (next === "B") {
    parser.out.push("\\B");
  } else {
    parser.out.push(RegExp.escape(next));
  }
  parser.i += 2;
  parser.lastAtom = "atom";
  return true;
}
