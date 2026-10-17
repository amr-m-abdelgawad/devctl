import { meetsMinLevel } from "./severity.ts";
import type { LogFacets, LogFilter, LogRecord } from "./types.ts";

// One combination of the three facet dimensions, and how many records of
// the window have it.
type Combination = {
  readonly service: string;
  readonly severityNumber: number;
  readonly severityText: string;
  readonly source: string;
  count: number;
};

// Combinations no record has any more are dropped once this many pile up.
const COMPACT_ABOVE = 1_024;

/**
 * Counts the records of the logical window (the last `size` seqs) by
 * service, level and source, kept as records arrive: one slot a seq says
 * which combination it had, so the record that leaves the window when a new
 * one enters is uncounted without being read. Facets for a filter on only
 * those three dimensions are then exact over the whole window, however much
 * of it memory still holds.
 */
export class FacetWindow {
  private readonly slots: Int32Array;
  private combinations: Combination[] = [];
  private ids = new Map<string, number>();

  constructor(private readonly size: number) {
    this.slots = new Int32Array(size).fill(-1);
  }

  /** Counts a record entering the window. The one `size` seqs before it leaves. */
  add(record: LogRecord): void {
    const slot = record.seq % this.size;
    const leaving = this.slots[slot]!;
    if (leaving >= 0) {
      this.combinations[leaving]!.count -= 1;
    }
    const key = `${record.service}\0${record.severityNumber}\0${record.severityText}\0${record.source}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      this.compact();
      id = this.combinations.length;
      this.ids.set(key, id);
      this.combinations.push({ service: record.service, severityNumber: record.severityNumber, severityText: record.severityText, source: record.source, count: 0 });
    }
    this.combinations[id]!.count += 1;
    this.slots[slot] = id;
  }

  /**
   * Facets for a filter on service, level and source alone. As everywhere,
   * each breakdown ignores its own dimension and keeps the other two.
   */
  facets(filter: Pick<LogFilter, "services" | "level" | "source">): LogFacets {
    const services = filter.services !== undefined && filter.services.length > 0 ? new Set(filter.services) : undefined;
    const out: LogFacets = { total: 0, byService: {}, byLevel: {}, bySource: {} };
    for (const row of this.combinations) {
      if (row.count === 0) {
        continue;
      }
      const inServices = services === undefined || services.has(row.service);
      const inLevel = !filter.level || meetsMinLevel(row.severityNumber, filter.level);
      const inSource = !filter.source || row.source === filter.source;
      if (inServices && inLevel && inSource) {
        out.total += row.count;
      }
      if (inLevel && inSource) {
        out.byService[row.service] = (out.byService[row.service] ?? 0) + row.count;
      }
      if (inServices && inSource) {
        out.byLevel[row.severityText] = (out.byLevel[row.severityText] ?? 0) + row.count;
      }
      if (inServices && inLevel) {
        out.bySource[row.source] = (out.bySource[row.source] ?? 0) + row.count;
      }
    }
    return out;
  }

  // Level text is whatever a service logged, so combinations can pile up
  // while few are still in the window. Renumbers the live ones.
  private compact(): void {
    if (this.combinations.length < COMPACT_ABOVE || this.combinations.filter((row) => row.count > 0).length * 2 > this.combinations.length) {
      return;
    }
    const renumbered = new Int32Array(this.combinations.length).fill(-1);
    const kept: Combination[] = [];
    const ids = new Map<string, number>();
    for (const [key, id] of this.ids) {
      const row = this.combinations[id]!;
      if (row.count > 0) {
        renumbered[id] = kept.length;
        ids.set(key, kept.length);
        kept.push(row);
      }
    }
    for (let slot = 0; slot < this.slots.length; slot += 1) {
      const id = this.slots[slot]!;
      this.slots[slot] = id < 0 ? -1 : renumbered[id]!;
    }
    this.combinations = kept;
    this.ids = ids;
  }
}

/** True when a filter narrows only by service, level and source, the dimensions `FacetWindow` counts. */
export function filtersDimensionsOnly(filter: LogFilter): boolean {
  return !filter.search && !filter.since && !filter.until && !filter.traceId && !filter.requestId && filter.attribute === undefined;
}
