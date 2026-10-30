// Stable per-service color palette, shared by the trace waterfall, the
// dependency graph, and log service tags so the whole UI reads as one system.
// Red is deliberately absent — it is reserved for errors.
const SERVICE_COLORS = Array.from({ length: 8 }, (_, index) => `var(--service-${index})`);

export const ERROR_COLOR = "var(--danger)";

export function serviceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return SERVICE_COLORS[hash % SERVICE_COLORS.length] ?? SERVICE_COLORS[0]!;
}
