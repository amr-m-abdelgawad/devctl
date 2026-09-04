import { type CliRenderer } from "@opentui/core";

// OpenTUI owns the alternate screen, raw stdin, and mouse tracking. Spawning
// an interactive child (gcloud ADC login) with inherit stdio while that is
// still active writes over the TUI. suspend() returns the terminal to the
// user; resume() puts the TUI back.
export async function withSuspendedRenderer<T>(renderer: CliRenderer, work: () => Promise<T>): Promise<T> {
  renderer.suspend();
  try {
    return await work();
  } finally {
    renderer.resume();
    renderer.intermediateRender();
  }
}
