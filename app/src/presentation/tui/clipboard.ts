import { hintError, KindGeneral } from "../../shared/errors.ts";

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

export function availableClipboardCommands(): string[][] {
  return clipboardCommands().filter((cmd) => {
    const bin = cmd[0];
    return typeof bin === "string" && Bun.which(bin) !== null;
  });
}

export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

export function clipboardUnavailableHint(): string {
  if (process.platform === "linux") {
    return "install wl-clipboard (Wayland) or xclip (X11)";
  }
  return "no clipboard helper found";
}

export async function writeClipboard(text: string): Promise<void> {
  const attempts = availableClipboardCommands();
  let last: Error | undefined;
  for (const cmd of attempts) {
    try {
      await pipeTo(cmd, text);
      return;
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (process.platform !== "win32") {
    try {
      await writeOsc52(text);
      return;
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw hintError(KindGeneral, "clipboard unavailable", last ? `${clipboardUnavailableHint()} (${last.message})` : clipboardUnavailableHint());
}

async function writeOsc52(text: string): Promise<void> {
  const seq = osc52Sequence(text);
  try {
    await Bun.write("/dev/tty", seq);
  } catch {
    const ok = process.stderr.write(seq);
    if (!ok) {
      throw new Error("terminal clipboard write failed");
    }
  }
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
