const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const MCP_TOKEN_TTL_DAYS = 7;
export const MCP_TOKEN_TTL_MS = MCP_TOKEN_TTL_DAYS * MS_PER_DAY;

export function formatMcpTokenAge(ageMs: number): string {
  const days = Math.floor(ageMs / MS_PER_DAY);
  if (days >= 1) {
    return `${days}d`;
  }
  const hours = Math.floor(ageMs / MS_PER_HOUR);
  if (hours >= 1) {
    return `${hours}h`;
  }
  return "<1h";
}
