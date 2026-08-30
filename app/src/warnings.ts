const METADATA_WARNING = "MetadataLookupWarning";
const METADATA_PREFIX = "received unexpected error =";

let warningsSilenced = false;

export function isGcpMetadataWarning(message: string, type = ""): boolean {
  if (type === METADATA_WARNING) {
    return true;
  }
  return message.includes(METADATA_WARNING) || message.startsWith(METADATA_PREFIX);
}

export function silenceGcpMetadataWarnings(): void {
  if (warningsSilenced) {
    return;
  }
  warningsSilenced = true;
  const original = process.emitWarning.bind(process) as (warning: unknown, ...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const type = warningType(args[0]);
    const message = warningMessage(warning);
    if (isGcpMetadataWarning(message, type)) {
      return;
    }
    original(warning, ...args);
  }) as typeof process.emitWarning;
}

export function holdStderrForTui(): () => void {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    const text = chunkText(chunk);
    if (isGcpMetadataWarning(text)) {
      const done = typeof encoding === "function" ? encoding : typeof callback === "function" ? callback : undefined;
      if (typeof done === "function") {
        done();
      }
      return true;
    }
    if (typeof encoding === "function") {
      return write(chunk as string, encoding as (err?: Error | null) => void);
    }
    return write(chunk as string, encoding as BufferEncoding, callback as ((err?: Error | null) => void) | undefined);
  }) as typeof process.stderr.write;
  return () => {
    process.stderr.write = write;
  };
}

function warningMessage(warning: unknown): string {
  if (typeof warning === "string") {
    return warning;
  }
  if (warning instanceof Error) {
    return warning.message;
  }
  return String(warning);
}

function warningType(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg && typeof arg === "object" && "type" in arg && typeof arg.type === "string") {
    return arg.type;
  }
  return "";
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return new TextDecoder().decode(chunk);
  }
  return "";
}
