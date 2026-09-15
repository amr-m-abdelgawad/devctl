import type { DevctlConfig } from "../../domain/config/types.ts";
import {
  VIRTUAL_COLLECTION_ID,
  collectionSummary,
  findRequest,
  type HttpClientCollection,
  type HttpClientRequest,
  type HttpClientSendInput,
} from "../../domain/httpclient/request.ts";
import type { Clock } from "../../ports/clock.ts";
import type { FileSystem } from "../../ports/filesystem.ts";
import type {
  HttpClientBodyPage,
  HttpClientRuntime as HttpClientRuntimePort,
  HttpClientSendResult,
  HttpClientSendState,
} from "../../ports/http-client.ts";
import { KindGeneral, newError } from "../../shared/errors.ts";
import type { TokenManager } from "../google/token.ts";
import { executeHttpClientRequest } from "./execute.ts";
import { discoverCollections } from "./discovery.ts";
import { virtualDevctlCollection } from "./virtual-collection.ts";

const RESULT_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 50;
const DEFAULT_BODY_PAGE = 256 * 1024;

export type HttpClientRuntimeDeps = {
  cfg: () => DevctlConfig;
  tokens: TokenManager;
  clock: Clock;
  userEmail: () => string;
  ports: () => Map<string, Record<string, number>>;
  processEnv: () => NodeJS.ProcessEnv;
  fs: FileSystem;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  log?: (message: string) => void;
};

type Stored = {
  state: HttpClientSendState;
  abort?: AbortController;
  expiresAt: number;
};

export class HttpClientRuntime implements HttpClientRuntimePort {
  private readonly deps: HttpClientRuntimeDeps;
  private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  private readonly results = new Map<string, Stored>();
  private seq = 0;

  constructor(deps: HttpClientRuntimeDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  listCollections() {
    return this.loadCollections().map(collectionSummary);
  }

  getCollection(id: string): HttpClientCollection {
    const collection = this.loadCollections().find((item) => item.id === id);
    if (!collection) {
      throw newError(KindGeneral, `unknown collection "${id}"`);
    }
    return collection;
  }

  async send(input: HttpClientSendInput): Promise<HttpClientSendResult> {
    const id = this.start(input);
    const state = await this.wait(id);
    if (state.status === "ok") {
      return state.result;
    }
    if (state.status === "cancelled") {
      throw newError(KindGeneral, "request cancelled");
    }
    throw newError(KindGeneral, state.status === "error" ? state.error : "request failed");
  }

  start(input: HttpClientSendInput): string {
    this.evict();
    this.seq += 1;
    const id = `http-${this.seq}`;
    const abort = new AbortController();
    this.results.set(id, { state: { status: "pending", id }, abort, expiresAt: this.deps.clock.unixMs() + RESULT_TTL_MS });
    void this.run(id, input, abort.signal);
    return id;
  }

  result(id: string): HttpClientSendState | undefined {
    const state = this.results.get(id)?.state;
    if (!state || state.status !== "ok") {
      return state;
    }
    return {
      status: "ok",
      id: state.id,
      result: {
        ...state.result,
        response: { ...state.result.response, body: "" },
      },
    };
  }

  body(id: string, offset = 0, limit = DEFAULT_BODY_PAGE): HttpClientBodyPage {
    const state = this.results.get(id)?.state;
    if (!state || state.status !== "ok") {
      return { body: "", size: 0, truncated: false };
    }
    const full = state.result.response.body;
    const size = full.length;
    const start = Math.max(0, offset);
    const end = limit > 0 ? start + limit : full.length;
    return {
      body: full.slice(start, end),
      size: state.result.response.size,
      truncated: state.result.response.truncated || end < size,
    };
  }

  cancel(id: string): boolean {
    const stored = this.results.get(id);
    if (!stored || stored.state.status !== "pending") {
      return false;
    }
    stored.abort?.abort();
    stored.state = { status: "cancelled", id };
    return true;
  }

  private async run(id: string, input: HttpClientSendInput, signal: AbortSignal): Promise<void> {
    try {
      const collections = this.loadCollections();
      const { collection, request } = resolveTarget(collections, input);
      const result = await executeHttpClientRequest(collection, request, input, {
        cfg: this.deps.cfg(),
        tokens: this.deps.tokens,
        userEmail: this.deps.userEmail(),
        livePorts: this.deps.ports(),
        processEnv: this.deps.processEnv(),
        fetch: this.fetchImpl,
        signal,
      });
      result.id = id;
      const stored = this.results.get(id);
      if (!stored || stored.state.status === "cancelled") {
        return;
      }
      stored.state = { status: "ok", id, result };
      stored.expiresAt = this.deps.clock.unixMs() + RESULT_TTL_MS;
      this.deps.log?.(`http client ${id} ${result.response.status} ${result.url}`);
    } catch (err) {
      const stored = this.results.get(id);
      if (!stored || stored.state.status === "cancelled") {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      stored.state = { status: "error", id, error: message };
      this.deps.log?.(`http client ${id} failed: ${message}`);
    }
  }

  private async wait(id: string): Promise<HttpClientSendState> {
    for (;;) {
      const state = this.results.get(id)?.state;
      if (!state) {
        throw newError(KindGeneral, `unknown request "${id}"`);
      }
      if (state.status !== "pending") {
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private loadCollections(): HttpClientCollection[] {
    const cfg = this.deps.cfg();
    const discovered = discoverCollections(this.deps.fs, cfg.repoRoot, cfg.httpclient.search_paths);
    return [virtualDevctlCollection(cfg), ...discovered];
  }

  private evict(): void {
    const now = this.deps.clock.unixMs();
    for (const [id, stored] of this.results) {
      if (stored.expiresAt <= now && stored.state.status !== "pending") {
        this.results.delete(id);
      }
    }
    if (this.results.size <= MAX_RESULTS) {
      return;
    }
    const extra = this.results.size - MAX_RESULTS;
    const ids = [...this.results.keys()].slice(0, extra);
    for (const id of ids) {
      const stored = this.results.get(id);
      if (stored?.state.status !== "pending") {
        this.results.delete(id);
      }
    }
  }
}

function resolveTarget(
  collections: HttpClientCollection[],
  input: HttpClientSendInput,
): { collection?: HttpClientCollection; request: HttpClientRequest } {
  if (input.inline) {
    const collection = input.collectionId ? collections.find((item) => item.id === input.collectionId) : undefined;
    return { collection, request: input.inline };
  }
  const collectionId = input.collectionId || VIRTUAL_COLLECTION_ID;
  const collection = collections.find((item) => item.id === collectionId);
  if (!collection) {
    throw newError(KindGeneral, `unknown collection "${collectionId}"`);
  }
  const requestId = input.requestId ?? "";
  const request = findRequest(collection.items, requestId);
  if (!request) {
    throw newError(KindGeneral, `unknown request "${requestId}" in collection "${collectionId}"`);
  }
  return { collection, request };
}
