// Strip a matched path prefix from an inbound request URL when forwarding.
// Query string is preserved. Empty matchPath is a no-op. Inspector/logs keep
// the inbound URL; only the hop to upstream uses the rewrite.
export function stripMatchPrefix(requestUrl: string, matchPath: string): string {
  if (matchPath === "") {
    return requestUrl;
  }
  const queryAt = requestUrl.indexOf("?");
  const pathname = queryAt === -1 ? requestUrl : requestUrl.slice(0, queryAt);
  const search = queryAt === -1 ? "" : requestUrl.slice(queryAt);
  if (!pathname.startsWith(matchPath)) {
    return requestUrl;
  }
  let rest = pathname.slice(matchPath.length);
  if (rest === "" || rest[0] !== "/") {
    rest = `/${rest}`;
  }
  return `${rest}${search}`;
}
