import { LevelDebug, LevelError, LevelFatal, LevelInfo, LevelTrace, LevelUnknown, LevelWarn } from "./types.ts";

export const SeverityUnspecified = 0;
export const SeverityTrace = 1;
export const SeverityDebug = 5;
export const SeverityInfo = 9;
export const SeverityWarn = 13;
export const SeverityError = 17;
export const SeverityFatal = 21;
export const SeverityMax = 24;

const PINO_TRACE = 10;
const PINO_DEBUG = 20;
const PINO_INFO = 30;
const PINO_WARN = 40;
const PINO_ERROR = 50;
const PINO_FATAL = 60;
const SYSLOG_EMERG = 0;
const SYSLOG_ERROR = 3;
const SYSLOG_WARNING = 4;
const SYSLOG_NOTICE = 5;
const SYSLOG_INFO = 6;
const SYSLOG_DEBUG = 7;

const PINO_LEVELS: Record<number, number> = {
  [PINO_TRACE]: SeverityTrace,
  [PINO_DEBUG]: SeverityDebug,
  [PINO_INFO]: SeverityInfo,
  [PINO_WARN]: SeverityWarn,
  [PINO_ERROR]: SeverityError,
  [PINO_FATAL]: SeverityFatal,
};

export function severityTextFromNumber(n: number): string {
  if (n >= SeverityFatal && n <= SeverityMax) {
    return LevelFatal;
  }
  if (n >= SeverityError) {
    return LevelError;
  }
  if (n >= SeverityWarn) {
    return LevelWarn;
  }
  if (n >= SeverityInfo) {
    return LevelInfo;
  }
  if (n >= SeverityDebug) {
    return LevelDebug;
  }
  if (n >= SeverityTrace) {
    return LevelTrace;
  }
  return LevelUnknown;
}

export function severityNumberFromText(level: string): number {
  const upper = level.trim().toUpperCase();
  if (upper === LevelTrace || upper === "TRACE") {
    return SeverityTrace;
  }
  if (upper === LevelDebug || upper === "DBG" || upper === "DEBUG") {
    return SeverityDebug;
  }
  if (upper === LevelInfo || upper === "INFORMATION" || upper === "NOTICE" || upper === "INFORMATIONAL") {
    return SeverityInfo;
  }
  if (upper === LevelWarn || upper === "WARNING" || upper === "WARN") {
    return SeverityWarn;
  }
  if (upper === LevelError || upper === "ERR" || upper === "ERROR") {
    return SeverityError;
  }
  if (upper === LevelFatal || upper === "CRITICAL" || upper === "PANIC" || upper === "EMERGENCY" || upper === "ALERT" || upper === "FATAL") {
    return SeverityFatal;
  }
  return SeverityUnspecified;
}

export function severityNumberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return severityFromNumeric(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const named = severityNumberFromText(value);
    if (named !== SeverityUnspecified) {
      return named;
    }
    const n = Number(value);
    if (Number.isFinite(n)) {
      return severityFromNumeric(n);
    }
  }
  return undefined;
}

const OTLP_SEVERITY_BASE: Record<string, number> = {
  TRACE: SeverityTrace,
  DEBUG: SeverityDebug,
  INFO: SeverityInfo,
  WARN: SeverityWarn,
  ERROR: SeverityError,
  FATAL: SeverityFatal,
};

// Decode an OTLP LogRecord severityNumber, which OTLP/JSON may encode as the
// integer 1..24 or the enum name ("SEVERITY_NUMBER_ERROR", "…_INFO2"). Unlike
// severityNumberFromUnknown, this never applies pino's numeric convention, so a
// valid OTLP value like 10 (INFO2) or 20 (ERROR4) is kept as-is instead of being
// remapped to TRACE/DEBUG. Returns SeverityUnspecified when it cannot decode.
export function otlpSeverityNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampOtlpSeverity(Math.floor(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const raw = value.trim().toUpperCase();
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return clampOtlpSeverity(Math.floor(numeric));
    }
    const name = raw.startsWith("SEVERITY_NUMBER_") ? raw.slice("SEVERITY_NUMBER_".length) : raw;
    const match = /^([A-Z]+?)([2-4])?$/.exec(name);
    if (match) {
      const base = OTLP_SEVERITY_BASE[match[1] ?? ""];
      if (base !== undefined) {
        return base + (match[2] ? Number(match[2]) - 1 : 0);
      }
    }
  }
  return SeverityUnspecified;
}

function clampOtlpSeverity(n: number): number {
  return n >= SeverityTrace && n <= SeverityMax ? n : SeverityUnspecified;
}

export function isErrorSeverity(severityNumber: number): boolean {
  return severityNumber >= SeverityError;
}

export function meetsMinLevel(severityNumber: number, minLevel: string): boolean {
  const min = severityNumberFromText(minLevel);
  if (min === SeverityUnspecified) {
    return true;
  }
  const n = severityNumber === SeverityUnspecified ? SeverityInfo : severityNumber;
  return n >= min;
}

export function displaySeverityText(severityText: string): string {
  return severityText === LevelUnknown ? "—" : severityText;
}

function severityFromNumeric(n: number): number | undefined {
  const pino = PINO_LEVELS[n];
  if (pino !== undefined) {
    return pino;
  }
  if (n >= SeverityTrace && n <= SeverityMax) {
    return Math.floor(n);
  }
  return undefined;
}

export function syslogSeverity(n: number): number | undefined {
  if (n <= SYSLOG_EMERG) {
    return SeverityFatal;
  }
  if (n <= SYSLOG_ERROR) {
    return SeverityError;
  }
  if (n === SYSLOG_WARNING) {
    return SeverityWarn;
  }
  if (n === SYSLOG_NOTICE || n === SYSLOG_INFO) {
    return SeverityInfo;
  }
  if (n === SYSLOG_DEBUG) {
    return SeverityDebug;
  }
  return undefined;
}
