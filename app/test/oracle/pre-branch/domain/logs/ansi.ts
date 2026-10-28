// Frozen from main@ed58322 app/src/domain/logs/ansi.ts for the ingest oracle. Do not edit.
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI, "");
}
