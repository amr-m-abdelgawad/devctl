import { existsSync } from "node:fs";
import { join } from "node:path";
import { clampLogPageSize, createLogMatcher, decodeLogCursor, type LogFilter, type LogPage, type LogPageDirection, type LogPageRequest } from "../../domain/logs/logs.ts";
import { indexedSource, pageSource, seqIndexed, type SeqSource } from "./log-page.ts";
import { isJsonlSessionDir, isSessionName, loadSessionEvents } from "./session-files.ts";
import { readBudget, SessionReader } from "./session-reader.ts";

// Sessions being paged keep their reader, with its index and cache.
const READERS = 2;

/**
 * Pages the persisted sessions under one logs root by seq, each page within
 * a read budget, so older history stays reachable without reading a session
 * whole. With no cursor a page is the session's newest matches. Cursors are
 * plain seqs, as history pages have always returned.
 */
export class SessionHistory {
  private readonly readers = new Map<string, SessionReader>();

  constructor(
    private readonly root: string,
    private readonly scanBytes: number,
    private readonly scanMs: number,
  ) {}

  page(session: string, filter: LogFilter, request: LogPageRequest = {}): LogPage {
    const limit = clampLogPageSize(request.limit);
    const cursor = historyCursorSeq(request.cursor);
    const direction: LogPageDirection = cursor === undefined ? "backward" : (request.direction ?? "backward");
    const result = pageSource(this.source(session, filter), { cursor, direction, limit });
    const firstSeq = result.events[0]?.seq;
    const lastSeq = result.events[result.events.length - 1]?.seq;
    return {
      events: result.events,
      prevCursor: String(firstSeq ?? result.prevFrontier ?? cursor ?? 0),
      nextCursor: String(lastSeq ?? result.nextFrontier ?? cursor ?? 0),
      hasNext: result.hasNext,
      hasPrev: result.hasPrev,
      sessionChanged: false,
    };
  }

  private source(session: string, filter: LogFilter): SeqSource {
    const matches = createLogMatcher(filter);
    const dir = join(this.root, session);
    if (!isSessionName(session) || !existsSync(dir)) {
      return indexedSource(seqIndexed([]), matches);
    }
    if (!isJsonlSessionDir(dir)) {
      return indexedSource(seqIndexed(loadSessionEvents(session, this.root)), matches);
    }
    let reader = this.readers.get(dir);
    this.readers.delete(dir);
    reader ??= new SessionReader(dir);
    this.readers.set(dir, reader);
    for (const oldest of this.readers.keys()) {
      if (this.readers.size <= READERS) {
        break;
      }
      this.readers.delete(oldest);
    }
    const budget = readBudget(this.scanBytes, this.scanMs);
    return reader.source({ matches, services: filter.services, key: matchCacheKey(filter) }, 1, reader.lastSeq(budget) + 1, budget);
  }
}

// History pages have always returned plain seqs as cursors; a live-window
// cursor is taken for its seq.
function historyCursorSeq(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const seq = Number(raw);
  return Number.isInteger(seq) ? seq : decodeLogCursor(raw)?.seq;
}

// Names a filter that keeps only some records of the files it reads, so its
// matches are worth remembering. A filter by service alone reads just that
// service's files, where every record matches.
export function matchCacheKey(filter: LogFilter): string | undefined {
  const { level, source, search, regex, since, until, traceId, requestId, attribute } = filter;
  const selective = [level, source, search, since, until, traceId, requestId].some((value) => value !== undefined && value !== "") || attribute !== undefined;
  if (!selective) {
    return undefined;
  }
  const services = [...(filter.services ?? [])].sort();
  return JSON.stringify([services, level ?? "", source ?? "", search ?? "", regex === true, since ?? "", until ?? "", traceId ?? "", requestId ?? "", attribute ?? null]);
}
