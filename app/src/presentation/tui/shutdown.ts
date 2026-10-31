// A signal cannot show the quit confirm.
// `stop_services_on_exit: false` detaches. `true` stops services.
// Unset stops them on an explicit SIGTERM, SIGINT, or SIGQUIT.
// SIGHUP is the terminal closing: that always detaches, so a closed window
// does not take the stack down.
export function detachOnTermination(stopServicesOnExit: boolean | undefined): boolean {
  return stopServicesOnExit === false;
}

export function detachOnSignal(signal: string, stopServicesOnExit: boolean | undefined): boolean {
  if (signal === "SIGHUP") {
    return true;
  }
  return detachOnTermination(stopServicesOnExit);
}

const SIGNAL_EXIT_CODE: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
};

export function signalExitCode(signal: string): number {
  return SIGNAL_EXIT_CODE[signal] ?? 1;
}

export function formatTuiFailure(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  try {
    return String(reason);
  } catch {
    return "unknown error";
  }
}
