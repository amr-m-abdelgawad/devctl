const PR_SET_CHILD_SUBREAPER = 36;

/**
 * Ask Linux to make this process a child subreaper. Only compiled glibc builds
 * are expected to have libc.so.6; failure leaves reaping to PID 1.
 */
export async function enableChildSubreaper(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    return libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) === 0;
  } catch {
    return false;
  }
}
