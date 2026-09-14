const JWT_SEGMENTS = 3;

export function jwtExpiry(token: string): Date | undefined {
  const parts = token.split(".");
  if (parts.length < JWT_SEGMENTS - 1 || !parts[1]) {
    return undefined;
  }
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as { exp?: number };
    if (typeof payload.exp === "number") {
      return new Date(payload.exp * 1000);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function decodeBase64Url(input: string): string {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return atob(padded);
}
