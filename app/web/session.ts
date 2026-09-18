export const WEB_CONTROL_TOKEN_KEY = "devctl.web.controlToken";

// The control token is delivered in the URL fragment (`#token=…`), which is
// never sent as Referer or logged by proxies. The SPA also uses the fragment
// for routing (`#/services`), so extract only the `token` param and hand back
// the remaining fragment untouched for the router. Persist in localStorage
// (not sessionStorage) so closing the tab and reopening the same origin
// stays authorized, matching the disk-backed MCP/web tokens.
export function takeTokenFromHash(hash: string): { token: string; nextHash: string } {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const token = params.get("token") ?? "";
  if (token === "") {
    return { token: "", nextHash: hash };
  }
  params.delete("token");
  const rest = params.toString();
  return { token, nextHash: rest === "" ? "" : `#${rest}` };
}

let memoryToken = "";

function readStoredToken(): string {
  try {
    return window.localStorage.getItem(WEB_CONTROL_TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

function writeStoredToken(token: string): void {
  memoryToken = token;
  window.localStorage.setItem(WEB_CONTROL_TOKEN_KEY, token);
}

export function captureControlToken(): void {
  const { token, nextHash } = takeTokenFromHash(window.location.hash);
  if (token === "") {
    return;
  }
  try {
    writeStoredToken(token);
  } catch {
    // Private mode may refuse persistence. Keep the in-memory copy so this
    // document stays authorized after the fragment is stripped.
    memoryToken = token;
  }
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
}

export function forgetControlToken(): void {
  memoryToken = "";
  try {
    window.localStorage.removeItem(WEB_CONTROL_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function controlAuthHeaders(): Record<string, string> {
  const token = readStoredToken();
  if (token === "") {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}
