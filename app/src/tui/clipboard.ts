export function clipboardCommands(): string[][] {
  if (process.platform === "darwin") {
    return [["pbcopy"]];
  }
  if (process.platform === "win32") {
    return [["clip"]];
  }
  return [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ];
}

export async function writeClipboard(text: string): Promise<void> {
  const attempts = clipboardCommands();
  let last: Error | undefined;
  for (const cmd of attempts) {
    try {
      await pipeTo(cmd, text);
      return;
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw last ?? new Error("clipboard unavailable");
}

async function pipeTo(cmd: string[], text: string): Promise<void> {
  const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  proc.stdin.write(text);
  await proc.stdin.end();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd[0]} exited ${code}`);
  }
}
