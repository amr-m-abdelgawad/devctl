import type {
  LlmCall,
  LlmCallFacets,
  LlmCallFilter,
  LlmCallIngest,
  LlmCallPage,
  LlmCallPageRequest,
  LlmSourceError,
} from "../domain/llm/llm.ts";

export type LlmCallStore = {
  upsert(calls: LlmCallIngest[]): void;
  queryPage(filter: LlmCallFilter, page?: LlmCallPageRequest): LlmCallPage;
  get(id: string): LlmCall | undefined;
  facets(filter: LlmCallFilter): LlmCallFacets;
  setSourceError(source: string, message: string, status?: number): void;
  clearSourceError(source: string): void;
  sourceErrors(): LlmSourceError[];
  setSecrets(extraMarkers: string[], extraPatterns: string[]): void;
  close(): void;
};
