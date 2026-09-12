import { stringifyAnyValue } from "./any-value.ts";
import { recordSearchText, requestIdOf } from "./display.ts";
import { compileLogSearch } from "./regex.ts";
import { meetsMinLevel } from "./severity.ts";
import type { LogFilter, LogRecord } from "./types.ts";

export type LogMatcher = (ev: LogRecord) => boolean;

export function matchesLogDimensions(filter: LogFilter, ev: LogRecord): boolean {
  if (filter.services && filter.services.length > 0 && !filter.services.includes(ev.service)) {
    return false;
  }
  if (filter.level && !meetsMinLevel(ev.severityNumber, filter.level)) {
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
  if (filter.traceId && ev.traceId !== filter.traceId) {
    return false;
  }
  if (filter.requestId && requestIdOf(ev) !== filter.requestId && ev.traceId !== filter.requestId) {
    return false;
  }
  if (filter.attribute) {
    const actual = ev.attributes[filter.attribute.key];
    if (stringifyAnyValue(actual ?? null) !== filter.attribute.value) {
      return false;
    }
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
      return (ev) => re.test(recordSearchText(ev));
    }
  }
  const needle = filter.search.toLowerCase();
  return (ev) => recordSearchText(ev).toLowerCase().includes(needle);
}

export function createLogMatcher(filter: LogFilter): LogMatcher {
  const search = createSearchMatcher(filter);
  return (ev) => matchesLogDimensions(filter, ev) && search(ev);
}

export function matchLog(filter: LogFilter, ev: LogRecord): boolean {
  return createLogMatcher(filter)(ev);
}
