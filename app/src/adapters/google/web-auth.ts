import { randomUUID } from "node:crypto";
import type { WebAuthentication, WebLoginState } from "../../ports/web-host.ts";
import { logoutGoogle } from "./google.ts";

type LoginChild = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: { write(value: string): unknown; flush(): unknown };
  exited: Promise<number>;
  kill(): void;
};
const ACTIVE = new Set<WebLoginState["phase"]>(["starting", "awaiting_code", "finishing"]);

/** gcloud owns OAuth, PKCE and ADC persistence; the web UI only relays its URL and one-time code. */
export class GoogleWebAuth implements WebAuthentication {
  private current?: WebLoginState;
  private child?: LoginChild;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly changed: () => Promise<void>,
    private readonly deps: { spawn?: () => LoginChild; revoke?: () => Promise<void>; timeoutMs?: number } = {},
  ) {}

  status(): WebLoginState | undefined {
    return this.current ? { ...this.current } : undefined;
  }
  start(): WebLoginState {
    if (this.current && ACTIVE.has(this.current.phase)) return { ...this.current };
    const id = randomUUID();
    this.current = { id, phase: "starting" };
    try {
      const child =
        this.deps.spawn?.() ??
        Bun.spawn(["gcloud", "auth", "application-default", "login", "--no-launch-browser", "--quiet"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NO_COLOR: "1" },
        });
      this.child = child;
      this.timer = setTimeout(() => {
        if (this.current?.id === id && ACTIVE.has(this.current.phase)) {
          this.current = { id, phase: "failed", error: "Sign-in expired. Start again to get a new link." };
          child.kill();
        }
      }, this.deps.timeoutMs ?? 600_000);
      this.timer.unref?.();
      void this.finish(id, child);
    } catch {
      this.current = { id, phase: "failed", error: "Unable to start gcloud. Install the Google Cloud CLI on the machine running devctl." };
    }
    return { ...this.current };
  }
  submit(id: string, code: string): WebLoginState {
    if (this.current?.id !== id || this.current.phase !== "awaiting_code" || !this.child)
      throw new Error("This sign-in session is no longer waiting for a code");
    if (!code.trim() || code.length > 8192 || /[\r\n\0]/.test(code)) throw new Error("Enter a single authorization code");
    this.child.stdin.write(`${code.trim()}\n`);
    this.child.stdin.flush();
    this.current = { id, phase: "finishing" };
    return { ...this.current };
  }
  cancel(id: string): void {
    if (this.current?.id !== id) throw new Error("Sign-in session changed. Refresh this page.");
    if (ACTIVE.has(this.current.phase)) {
      this.current = { id, phase: "cancelled" };
      clearTimeout(this.timer);
      this.child?.kill();
    }
  }
  async logout(): Promise<void> {
    if (this.current && ACTIVE.has(this.current.phase)) this.cancel(this.current.id);
    await (this.deps.revoke ?? logoutGoogle)();
    await this.changed();
  }
  dispose(): void {
    if (this.current && ACTIVE.has(this.current.phase)) this.cancel(this.current.id);
  }

  private async readUrl(id: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        tail = (tail + decoder.decode(next.value, { stream: true })).slice(-16_384);
        const url = /https:\/\/accounts\.google\.com\/[^\s\x1b]+(?=[\r\n\t ])/.exec(tail)?.[0];
        if (url && this.current?.id === id && this.current.phase === "starting") this.current = { id, phase: "awaiting_code", url };
      }
    } finally {
      reader.releaseLock();
    }
  }
  private async finish(id: string, child: LoginChild): Promise<void> {
    try {
      const [, , code] = await Promise.all([this.readUrl(id, child.stdout), this.readUrl(id, child.stderr), child.exited]);
      if (this.current?.id !== id || !ACTIVE.has(this.current.phase)) return;
      if (code !== 0) {
        this.current = { id, phase: "failed", error: `Google sign-in failed (exit ${code}). Start again to retry.` };
        return;
      }
      this.current = { id, phase: "finishing" };
      await this.changed();
      if (this.current?.id === id && this.current.phase === "finishing") this.current = { id, phase: "succeeded" };
    } catch {
      if (this.current?.id === id && ACTIVE.has(this.current.phase))
        this.current = { id, phase: "failed", error: "Unable to finish sign-in. Refresh identity and retry." };
    } finally {
      if (this.current?.id === id) {
        clearTimeout(this.timer);
        this.child = undefined;
      }
    }
  }
}
