// Stable per-service color palette, shared by the trace waterfall, the
// dependency graph, and log service tags so the whole UI reads as one system.
// Red is deliberately absent — it is reserved for errors.
const SERVICE_COLORS = [
  "#77ddba", // teal
  "#8ec8d8", // cyan
  "#e8c586", // gold
  "#b6a6f0", // violet
  "#8fd694", // green
  "#e0a9c4", // pink
  "#9fb8e8", // periwinkle
  "#e6b088", // amber
];

export const ERROR_COLOR = "#f4868d";

export function serviceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return SERVICE_COLORS[hash % SERVICE_COLORS.length] ?? SERVICE_COLORS[0]!;
}
