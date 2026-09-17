export const WEB_CONTROL_TOKEN_KEY = "devctl.web.controlToken";

// The control token is delivered in the URL fragment (`#token=…`), which is
// never sent as Referer or logged by proxies. The SPA also uses the fragment
// for routing (`#/services`), so extract only the `token` param and hand back
// the remaining fragment untouched for the router.
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

export function captureControlToken(): void {
  const { token, nextHash } = takeTokenFromHash(window.location.hash);
  if (token === "") {
    return;
  }
  sessionStorage.setItem(WEB_CONTROL_TOKEN_KEY, token);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
}

export function controlAuthHeaders(): Record<string, string> {
  try {
    const token = sessionStorage.getItem(WEB_CONTROL_TOKEN_KEY) ?? "";
    if (token === "") {
      return {};
    }
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}
