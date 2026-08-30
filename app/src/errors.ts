export const ExitSuccess = 0;
export const ExitGeneral = 1;
export const ExitConfig = 2;
export const ExitAuthn = 3;
export const ExitAuthz = 4;
export const ExitStartup = 5;
export const ExitHealth = 6;
export const ExitProxy = 7;

export const KindConfiguration = "configuration";
export const KindServiceNotFound = "service_not_found";
export const KindDependency = "dependency";
export const KindProcessStart = "process_start";
export const KindAuthentication = "authentication";
export const KindAuthorization = "authorization";
export const KindToken = "token";
export const KindImpersonation = "impersonation";
export const KindIAP = "iap";
export const KindProxy = "proxy";
export const KindHealthCheck = "health_check";
export const KindGeneral = "general";

export type ErrorKind =
  | typeof KindConfiguration
  | typeof KindServiceNotFound
  | typeof KindDependency
  | typeof KindProcessStart
  | typeof KindAuthentication
  | typeof KindAuthorization
  | typeof KindToken
  | typeof KindImpersonation
  | typeof KindIAP
  | typeof KindProxy
  | typeof KindHealthCheck
  | typeof KindGeneral;

export class DevctlError extends Error {
  readonly kind: ErrorKind;
  readonly hint: string;
  readonly service: string;
  readonly causeError?: Error;

  constructor(kind: ErrorKind, message: string, options?: { hint?: string; cause?: Error; service?: string }) {
    super(options?.cause ? `${kind}: ${message}: ${options.cause.message}` : `${kind}: ${message}`);
    this.name = "DevctlError";
    this.kind = kind;
    this.hint = options?.hint ?? "";
    this.service = options?.service ?? "";
    this.causeError = options?.cause;
  }

  exitCode(): number {
    switch (this.kind) {
      case KindConfiguration:
      case KindServiceNotFound:
      case KindDependency:
        return ExitConfig;
      case KindAuthentication:
      case KindToken:
      case KindIAP:
        return ExitAuthn;
      case KindAuthorization:
      case KindImpersonation:
        return ExitAuthz;
      case KindProcessStart:
        return ExitStartup;
      case KindHealthCheck:
        return ExitHealth;
      case KindProxy:
        return ExitProxy;
      default:
        return ExitGeneral;
    }
  }
}

export function newError(kind: ErrorKind, message: string): DevctlError {
  return new DevctlError(kind, message);
}

export function wrapError(kind: ErrorKind, message: string, cause: unknown): DevctlError {
  const err = cause instanceof Error ? cause : new Error(String(cause));
  return new DevctlError(kind, message, { cause: err });
}

export function withHint(err: DevctlError, hint: string): DevctlError {
  return new DevctlError(err.kind, err.message.replace(`${err.kind}: `, "").split(": ")[0] ?? err.message, {
    hint,
    cause: err.causeError,
    service: err.service,
  });
}

export function hintError(kind: ErrorKind, message: string, hint: string, service = ""): DevctlError {
  return new DevctlError(kind, message, { hint, service });
}

export function isKind(err: unknown, kind: ErrorKind): boolean {
  return err instanceof DevctlError && err.kind === kind;
}

export function exitCode(err: unknown): number {
  if (err instanceof DevctlError) {
    return err.exitCode();
  }
  return ExitGeneral;
}

export type SerializedError = {
  error: string;
  kind?: ErrorKind;
  hint?: string;
  service?: string;
};

export function serializeError(err: unknown): SerializedError {
  if (err instanceof DevctlError) {
    return { error: humanMessage(err), kind: err.kind, hint: err.hint, service: err.service };
  }
  return { error: humanMessage(err) };
}

export function parseError(raw: SerializedError | string): DevctlError {
  if (typeof raw === "string") {
    return newError(KindGeneral, raw);
  }
  if (raw.kind) {
    return new DevctlError(raw.kind, raw.error.replace(`${raw.kind}: `, ""), { hint: raw.hint, service: raw.service });
  }
  return newError(KindGeneral, raw.error);
}

export function humanMessage(err: unknown): string {
  if (err instanceof DevctlError) {
    if (err.hint !== "") {
      return `${plainMessage(err)} — ${err.hint}`;
    }
    return plainMessage(err);
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function plainMessage(err: DevctlError): string {
  const prefix = `${err.kind}: `;
  if (err.message.startsWith(prefix)) {
    const rest = err.message.slice(prefix.length);
    const causeSuffix = err.causeError ? `: ${err.causeError.message}` : "";
    if (causeSuffix !== "" && rest.endsWith(causeSuffix)) {
      return rest.slice(0, rest.length - causeSuffix.length);
    }
    return rest;
  }
  return err.message;
}
