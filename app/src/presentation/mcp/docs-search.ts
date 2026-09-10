import { GUIDE_SECTIONS } from "./guide.generated.ts";
import { DOC_PAGES } from "./docs.generated.ts";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const TITLE_SCORE = 12;
const PATH_SCORE = 8;
const BODY_HIT_CAP = 8;
const PHRASE_BONUS = 15;
const SNIPPET_MAX = 400;
const SNIPPET_LINES = 5;
const MIN_TOKEN = 2;
const MIN_PHRASE = 4;

export type SearchDocsHit = {
  path: string;
  title: string;
  score: number;
  snippet: string;
};

export type SearchDocsResult = {
  query: string;
  hits: SearchDocsHit[];
};

type DocPage = {
  path: string;
  title: string;
  body: string;
};

function guidePages(): DocPage[] {
  return [
    { path: "skills/devctl-onboard/SKILL.md", title: "Onboard procedure", body: GUIDE_SECTIONS.procedure },
    { path: "skills/devctl-onboard/references/authoring.md", title: "Onboard authoring", body: GUIDE_SECTIONS.authoring },
    { path: "skills/devctl-onboard/references/discovery.md", title: "Onboard discovery", body: GUIDE_SECTIONS.discovery },
  ];
}

function allPages(): DocPage[] {
  return [...DOC_PAGES, ...guidePages()];
}

export type GetDocResult = {
  path: string;
  title: string;
  body: string;
};

// Return a full doc page by path. search_docs returns short snippets for
// discovery; this returns the complete page so a caller can actually read it.
// Matches the exact path a hit reports, or a unique basename suffix (so
// "proxy.md" resolves to "docs/proxy.md"). Throws with the available paths on a
// miss, matching search_docs's throw-on-bad-input style.
export function getDoc(path: string): GetDocResult {
  const p = path.trim();
  if (p === "") {
    throw new Error("path is required");
  }
  const pages = allPages();
  const exact = pages.find((page) => page.path === p);
  const matches = exact ? [exact] : pages.filter((page) => page.path.endsWith(`/${p}`));
  if (matches.length !== 1) {
    throw new Error(`no unique doc for path "${p}"; available: ${pages.map((page) => page.path).join(", ")}`);
  }
  const page = matches[0]!;
  return { path: page.path, title: page.title, body: page.body };
}

function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length >= MIN_TOKEN);
}

function scorePage(page: DocPage, terms: string[]): number {
  const hayTitle = page.title.toLowerCase();
  const hayPath = page.path.toLowerCase();
  const hayBody = page.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (hayTitle.includes(term)) {
      score += TITLE_SCORE;
    }
    if (hayPath.includes(term)) {
      score += PATH_SCORE;
    }
    const hits = hayBody.split(term).length - 1;
    score += Math.min(hits, BODY_HIT_CAP);
  }
  const phrase = terms.join(" ");
  if (phrase.length >= MIN_PHRASE && hayBody.includes(phrase)) {
    score += PHRASE_BONUS;
  }
  return score;
}

function snippet(body: string, terms: string[]): string {
  const lines = body.split("\n");
  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start < lines.length; start++) {
    const window = lines.slice(start, start + SNIPPET_LINES).join("\n").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (window.includes(term)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  const chunk = lines.slice(bestStart, bestStart + SNIPPET_LINES).join("\n").trim();
  if (chunk.length <= SNIPPET_MAX) {
    return chunk;
  }
  return `${chunk.slice(0, SNIPPET_MAX).trimEnd()}…`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function searchDocs(query: string, limit?: number): SearchDocsResult {
  const q = query.trim();
  const terms = tokens(q);
  if (terms.length === 0) {
    throw new Error("query is required");
  }
  const cap = clampLimit(limit);
  const hits = allPages()
    .map((page) => ({
      path: page.path,
      title: page.title,
      score: scorePage(page, terms),
      snippet: snippet(page.body, terms),
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, cap);
  return { query: q, hits };
}
