import { applyExtraAuthHeaders, headerHasAuthorization } from "./identity.ts";

const GET = "GET";
const HEAD = "HEAD";

export type AuthorizedFetch = (input: string, init: RequestInit) => Promise<Response>;

export type AuthorizedSendRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type AuthorizedSendAuth = {
  token?: string;
  extraHeaders?: Record<string, string>;
};

export async function authorizedSend(
  req: AuthorizedSendRequest,
  auth: AuthorizedSendAuth,
  fetchImpl: AuthorizedFetch,
): Promise<Response> {
  const headers = { ...req.headers };
  if (auth.token !== undefined) {
    if (!headerHasAuthorization(headers)) {
      headers.authorization = `Bearer ${auth.token}`;
    }
    applyExtraAuthHeaders(headers, auth.extraHeaders, auth.token);
  }
  const method = (req.method || GET).toUpperCase();
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
  return fetchImpl(req.url, {
    method,
    headers,
    body: method === GET || method === HEAD ? undefined : req.body,
    redirect: "manual",
    signal,
  });
}
