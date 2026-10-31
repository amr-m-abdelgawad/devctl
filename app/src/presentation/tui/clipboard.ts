import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type ClipboardService,
  type ClipboardWriteResult,
  type CliRenderer,
} from "@opentui/core";
import { hintError, KindGeneral } from "../../shared/errors.ts";

export type TuiClipboard = Pick<ClipboardService, "writeText" | "dispose">;

export function openTuiClipboard(renderer: CliRenderer): TuiClipboard {
  return createClipboard({
    host: createHostClipboard(),
    terminal: createRendererClipboardAdapter(renderer),
  });
}

export function clipboardWriteSucceeded(result: ClipboardWriteResult): boolean {
  return result.host.status === "written" || result.terminal.status === "attempted";
}

export function clipboardFailureDetail(result: ClipboardWriteResult): string {
  if (result.host.status === "failed") {
    return result.host.error.message;
  }
  if (result.terminal.status === "local-failure") {
    return "terminal clipboard write failed";
  }
  if (result.host.status === "timed-out" || result.host.status === "cancelled") {
    return result.host.status;
  }
  return "clipboard unavailable";
}

export async function writeClipboardText(clipboard: Pick<ClipboardService, "writeText">, text: string): Promise<void> {
  let result: ClipboardWriteResult;
  try {
    result = await clipboard.writeText(text, { destination: "best-available" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw hintError(KindGeneral, "clipboard unavailable", message);
  }
  if (!clipboardWriteSucceeded(result)) {
    throw hintError(KindGeneral, "clipboard unavailable", clipboardFailureDetail(result));
  }
}
