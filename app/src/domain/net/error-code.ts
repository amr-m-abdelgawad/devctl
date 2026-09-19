/** Node/Bun system errors expose a string `code` such as `EADDRINUSE`. */
export function systemErrorCode(err: unknown): string {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return "";
  }
  const code = err.code;
  return typeof code === "string" ? code : "";
}

/** Keep the OS code in the message; `humanMessage` otherwise strips the cause. */
export function withErrorCode(message: string, err: unknown): string {
  const code = systemErrorCode(err);
  return code === "" ? message : `${message} (${code})`;
}
