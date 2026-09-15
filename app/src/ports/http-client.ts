import type {
  HttpClientCollection,
  HttpClientCollectionSummary,
  HttpClientResponse,
  HttpClientSendInput,
} from "../domain/httpclient/request.ts";
import type { TokenGateDecision } from "../domain/httpclient/token-gate.ts";

export type HttpClientSendResult = {
  id: string;
  url: string;
  response: HttpClientResponse;
  tokenDecision: TokenGateDecision;
  authAttached: boolean;
};

export type HttpClientSendState =
  | { status: "pending"; id: string }
  | { status: "ok"; id: string; result: HttpClientSendResult }
  | { status: "error"; id: string; error: string }
  | { status: "cancelled"; id: string };

export type HttpClientBodyPage = {
  body: string;
  size: number;
  truncated: boolean;
};

export type HttpClientRuntime = {
  listCollections(): HttpClientCollectionSummary[];
  getCollection(id: string): HttpClientCollection;
  send(input: HttpClientSendInput): Promise<HttpClientSendResult>;
  start(input: HttpClientSendInput): string;
  result(id: string): HttpClientSendState | undefined;
  body(id: string, offset?: number, limit?: number): HttpClientBodyPage;
  cancel(id: string): boolean;
};
