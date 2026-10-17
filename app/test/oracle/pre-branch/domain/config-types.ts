// Frozen from main@ed58322 app/src/domain/config/types.ts (the two log types
// the LogManager append path reads) for the ingest oracle. Do not edit.
export type ServiceLogMultilineConfig = {
  start?: string;
  continuation?: string;
  max_wait_ms?: number;
  max_lines?: number;
};

export type ServiceLogConfig = {
  stdout: boolean;
  stderr: boolean;
  multiline?: ServiceLogMultilineConfig;
  dedupe_access_line?: boolean;
};
