import { watch, type FSWatcher } from "node:fs";
import { join, relative } from "node:path";
import type { ServiceConfig, ServiceWatchConfig } from "../../domain/config/types.ts";
import { shouldRestartOnWatch } from "../../domain/service/watch.ts";

export type ServiceWatchHost = {
  repoRoot(): string;
  log(service: string, level: string, message: string): void;
  isActive(name: string): boolean;
  restart(name: string): Promise<void>;
};

type WatchEntry = {
  readonly signature: string;
  readonly watch: ServiceWatchConfig;
  readonly handles: FSWatcher[];
  timer?: ReturnType<typeof setTimeout>;
};

/** Opt-in per-service fs.watch. Domain policy decides whether a path should restart. */
export class ServiceWatchers {
  private readonly entries = new Map<string, WatchEntry>();

  constructor(private readonly host: ServiceWatchHost) {}

  sync(services: Record<string, ServiceConfig>): void {
    const wanted = new Set<string>();
    for (const [name, svc] of Object.entries(services)) {
      if (!svc.watch.enabled || svc.watch.paths.length === 0) {
        this.stop(name);
        continue;
      }
      wanted.add(name);
      const signature = JSON.stringify(svc.watch);
      if (this.entries.get(name)?.signature === signature) {
        continue;
      }
      this.stop(name);
      this.start(name, svc.watch);
    }
    for (const name of [...this.entries.keys()]) {
      if (!wanted.has(name)) {
        this.stop(name);
      }
    }
  }

  watched(): string[] {
    return [...this.entries.keys()].sort();
  }

  close(): void {
    for (const name of [...this.entries.keys()]) {
      this.stop(name);
    }
  }

  private start(name: string, cfg: ServiceWatchConfig): void {
    const handles: FSWatcher[] = [];
    const root = this.host.repoRoot();
    for (const raw of cfg.paths) {
      const prefix = raw.replaceAll("\\", "/").replace(/\/$/, "");
      if (prefix === "" || prefix === ".") {
        this.host.log(name, "WARN", "service.watch skipped a whole-repo path; list concrete directories");
        continue;
      }
      const abs = join(root, prefix);
      try {
        const handle = watch(abs, { recursive: true }, (_event, filename) => {
          const changed = filename ? join(abs, filename.toString()) : abs;
          const rel = relative(root, changed).replaceAll("\\", "/");
          if (!shouldRestartOnWatch(cfg, rel)) {
            return;
          }
          this.schedule(name, cfg.debounce_ms);
        });
        handles.push(handle);
      } catch {
        this.host.log(name, "WARN", `unable to watch ${prefix}`);
      }
    }
    if (handles.length === 0) {
      return;
    }
    this.entries.set(name, { signature: JSON.stringify(cfg), watch: cfg, handles });
    this.host.log(name, "INFO", `watching ${cfg.paths.join(", ")}`);
  }

  private schedule(name: string, debounceMs: number): void {
    const entry = this.entries.get(name);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (!this.host.isActive(name)) {
        return;
      }
      this.host.log(name, "INFO", "watch: restarting after file change");
      void this.host.restart(name).catch((err) => {
        this.host.log(name, "WARN", err instanceof Error ? err.message : String(err));
      });
    }, debounceMs);
  }

  private stop(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    for (const handle of entry.handles) {
      handle.close();
    }
    this.entries.delete(name);
  }
}
