import { Command } from "commander";

export function configFlag(cmd: Command): string {
  const opts = cmd.optsWithGlobals() as { config?: string };
  return opts.config ?? "";
}

export function writeOut(text: string): void {
  try {
    process.stdout.write(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
      process.exit(0);
    }
    throw err;
  }
}
