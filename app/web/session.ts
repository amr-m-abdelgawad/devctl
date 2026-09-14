export const WEB_CONTROL_TOKEN_KEY = "devctl.web.controlToken";

export function takeTokenFromSearch(search: string): { token: string; nextSearch: string } {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const token = params.get("token") ?? "";
  if (token === "") {
    return { token: "", nextSearch: search };
  }
  params.delete("token");
  const rest = params.toString();
  return { token, nextSearch: rest === "" ? "" : `?${rest}` };
}

export function captureControlToken(): void {
  const { token, nextSearch } = takeTokenFromSearch(window.location.search);
  if (token === "") {
    return;
  }
  sessionStorage.setItem(WEB_CONTROL_TOKEN_KEY, token);
  window.history.replaceState(null, "", `${window.location.pathname}${nextSearch}${window.location.hash}`);
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
