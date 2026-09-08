import { LEVEL_ORDER, type LogEvent, type LogFilter } from "./types.ts";
import { compileLogSearch } from "./regex.ts";

export type LogMatcher = (ev: LogEvent) => boolean;

export function matchesLogDimensions(filter: LogFilter, ev: LogEvent): boolean {
  if (filter.services && filter.services.length > 0 && !filter.services.includes(ev.service)) {
    return false;
  }
  if (filter.level && (LEVEL_ORDER[ev.level] ?? 2) < (LEVEL_ORDER[filter.level] ?? 2)) {
    return false;
  }
  if (filter.source && ev.source !== filter.source) {
    return false;
  }
  if (filter.since && ev.timestamp < filter.since) {
    return false;
  }
  if (filter.until && ev.timestamp > filter.until) {
    return false;
  }
  return true;
}

export function createSearchMatcher(filter: LogFilter): LogMatcher {
  if (!filter.search) {
    return () => true;
  }
  if (filter.regex) {
    const re = compileLogSearch(filter.search);
    if (re) {
      return (ev) => re.test(ev.message) || (ev.raw !== undefined && re.test(ev.raw));
    }
  }
  const needle = filter.search.toLowerCase();
  return (ev) => ev.message.toLowerCase().includes(needle) || (ev.raw !== undefined && ev.raw.toLowerCase().includes(needle));
}

export function createLogMatcher(filter: LogFilter): LogMatcher {
  const search = createSearchMatcher(filter);
  return (ev) => matchesLogDimensions(filter, ev) && search(ev);
}

export function matchLog(filter: LogFilter, ev: LogEvent): boolean {
  return createLogMatcher(filter)(ev);
}
