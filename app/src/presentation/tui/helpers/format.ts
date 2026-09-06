

export function clipText(value: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (value.length <= max) {
    return value;
  }
  if (max === 1) {
    return "…";
  }
  return `${value.slice(0, max - 1)}…`;
}

export function padClip(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (value.length >= width) {
    return clipText(value, width);
  }
  return value.padEnd(width);
}

// Shared gauge glyph: a block-character bar. Color selection stays at each
// call site since severity semantics differ per section (health ratio vs.
// error ratio vs. restart budget).
export function renderBar(ratio: number, len = 20): string {
  const safeRatio = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(safeRatio * len);
  return "█".repeat(filled) + "░".repeat(Math.max(0, len - filled));
}

const MS_PER_SECOND = 1000;

const MS_PER_MINUTE = 60 * MS_PER_SECOND;

const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const MS_PER_DAY = 24 * MS_PER_HOUR;

export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < MS_PER_SECOND) {
    return "< 1s";
  }
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

const KB_PER_MB = 1024;

const MB_PER_GB = 1024;

export function formatMemoryKB(kb: number): string {
  if (!Number.isFinite(kb) || kb < 0) {
    return "—";
  }
  const mb = kb / KB_PER_MB;
  if (mb >= MB_PER_GB) {
    return `${(mb / MB_PER_GB).toFixed(1)}G`;
  }
  if (mb >= 1) {
    return `${Math.round(mb)}M`;
  }
  return `${Math.round(kb)}K`;
}

export function formatCpuPercent(pct: number): string {
  if (!Number.isFinite(pct) || pct < 0) {
    return "—";
  }
  return `${pct.toFixed(1)}%`;
}
