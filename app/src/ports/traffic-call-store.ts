import type {
  TrafficCall,
  TrafficCallFilter,
  TrafficCallIngest,
  TrafficCallPage,
  TrafficCallPageRequest,
} from "../domain/traffic/traffic.ts";

export type TrafficCallStore = {
  upsert(calls: TrafficCallIngest[]): void;
  queryPage(filter: TrafficCallFilter, page?: TrafficCallPageRequest): TrafficCallPage;
  get(id: string): TrafficCall | undefined;
  setSecrets(extraMarkers: string[], extraPatterns: string[], redact?: boolean): void;
  close(): void;
};
