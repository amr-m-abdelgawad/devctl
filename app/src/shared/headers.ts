export function headerValue(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  return (raw ?? "").split(",")[0]?.trim() ?? "";
}
