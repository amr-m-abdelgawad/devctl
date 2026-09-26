import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_PORT_SLOTS, pickSlot, type InstanceSlot } from "../../domain/net/port-slots.ts";
import { hintError, KindGeneral } from "../../shared/errors.ts";
import { repoID } from "../../shared/repo-id.ts";
import { ensureDir, homeDir, writeFileSecure } from "./storage.ts";

// The slot registry for parallel stacks (#117): which checkout holds which
// port slot, shared by every checkout under one DEVCTL_HOME. A slot is sticky:
// it stays with its checkout across restarts and supervisor crashes, and is
// freed by a full `devctl down` or `devctl instances prune`.

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

type Registry = { version: 1; instances: InstanceSlot[] };

export function instancesPath(): string {
  return join(homeDir(), "instances.json");
}

export function readInstances(): InstanceSlot[] {
  return readRegistry().instances.slice().sort((a, b) => a.slot - b.slot);
}

/** This checkout's slot, or 0 when it holds none. Never claims. */
export function currentSlot(repoRoot: string): number {
  const id = repoID(repoRoot);
  return readRegistry().instances.find((entry) => repoID(entry.repoRoot) === id)?.slot ?? 0;
}

/** This checkout's slot, claiming the lowest free one if it has none. */
export function claimSlot(repoRoot: string, now = new Date()): number {
  return withRegistry((registry) => {
    const root = resolve(repoRoot);
    const id = repoID(root);
    const own = registry.instances.find((entry) => repoID(entry.repoRoot) === id);
    if (own) {
      return own.slot;
    }
    const slot = pickSlot(registry.instances, root);
    if (slot === undefined) {
      throw hintError(
        KindGeneral,
        `all ${MAX_PORT_SLOTS} port slots are taken by other checkouts`,
        "run `devctl instances` to see them, and `devctl down` in one you're done with (or `devctl instances prune` for deleted checkouts)",
      );
    }
    registry.instances.push({ slot, repoRoot: root, claimedAt: now.toISOString() });
    return slot;
  });
}

export function recordInstancePorts(repoRoot: string, ports: Record<string, number>): void {
  withRegistry((registry) => {
    const id = repoID(repoRoot);
    const own = registry.instances.find((entry) => repoID(entry.repoRoot) === id);
    if (own) {
      own.ports = ports;
    }
  });
}

export function releaseSlot(repoRoot: string): void {
  withRegistry((registry) => {
    const id = repoID(repoRoot);
    registry.instances = registry.instances.filter((entry) => repoID(entry.repoRoot) !== id);
  });
}

function readRegistry(): Registry {
  const path = instancesPath();
  if (!existsSync(path)) {
    return { version: 1, instances: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { instances?: unknown };
    const instances = Array.isArray(parsed.instances) ? parsed.instances.filter(isSlot) : [];
    return { version: 1, instances };
  } catch {
    return { version: 1, instances: [] };
  }
}

function isSlot(value: unknown): value is InstanceSlot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return Number.isInteger(entry.slot) && typeof entry.repoRoot === "string" && typeof entry.claimedAt === "string";
}

// Read-modify-write under an exclusive lock file, written atomically, so two
// checkouts starting at once can't take the same slot.
function withRegistry<T>(update: (registry: Registry) => T): T {
  ensureDir(homeDir());
  const lock = `${instancesPath()}.lock`;
  acquire(lock);
  try {
    const registry = readRegistry();
    const result = update(registry);
    const tmp = `${instancesPath()}.${process.pid}.tmp`;
    writeFileSecure(tmp, `${JSON.stringify(registry, null, 2)}\n`);
    renameSync(tmp, instancesPath());
    return result;
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

function acquire(lock: string): void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    // A holder that crashed mid-update leaves the lock behind; it is only
    // ever held for one read-modify-write.
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lock);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) {
      throw hintError(KindGeneral, `timed out waiting for ${lock}`, "if no other devctl is starting, delete the lock file");
    }
    Bun.sleepSync(20);
  }
}
