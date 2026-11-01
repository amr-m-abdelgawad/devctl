import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_PORT_SLOTS, pickSlot, type InstanceSlot, type PortOwner } from "../../domain/net/port-slots.ts";
import type { PortHolder } from "../../domain/net/ports.ts";
import { hintError, KindGeneral } from "../../shared/errors.ts";
import { repoID } from "../../shared/repo-id.ts";
import { lockIsLive, readLockFile } from "./lock.ts";
import { currentInstance, ensureDir, homeDir, readPersistedStateFile, writeFileSecure } from "./storage.ts";

// The slot registry for parallel stacks (#117): which stack holds which port
// slot, shared by every checkout under one DEVCTL_HOME. A stack is a checkout,
// or a named `--instance` of one; every function here acts on this process's
// instance of `repoRoot`. A slot is sticky: it stays with its stack across
// restarts and supervisor crashes, and is freed by a full `devctl down` or
// `devctl instances prune`.

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

type Registry = { version: 1; instances: InstanceSlot[] };

export function instancesPath(): string {
  return join(homeDir(), "instances.json");
}

export function readInstances(): InstanceSlot[] {
  return readRegistry().instances.slice().sort((a, b) => a.slot - b.slot);
}

/**
 * This stack's slot or, when it holds none, the slot a start would claim now:
 * a stack that hasn't started must not read the ports of the stack in slot 0
 * as its own. 0 when every slot is taken. Never claims.
 */
export function currentSlot(repoRoot: string): number {
  const id = ownID(repoRoot);
  const { instances } = readRegistry();
  const own = instances.find((entry) => entryID(entry) === id);
  return own?.slot ?? pickSlot(instances, resolve(repoRoot), currentInstance()) ?? 0;
}

/**
 * The other stack a port's holder belongs to, if any, going by what that stack
 * recorded. `running` is false once its supervisor is gone: then nobody is left
 * to stop what it left behind, and the holder may be freed from here.
 */
export function otherStackOwning(repoRoot: string, holder: PortHolder): PortOwner | undefined {
  const id = ownID(repoRoot);
  for (const entry of readRegistry().instances) {
    if (entryID(entry) === id) {
      continue;
    }
    const dir = join(homeDir(), "state", entryID(entry));
    const lock = readLockFile(join(dir, "devctl.lock"));
    if (lock?.pid === holder.pid || stackRecorded(entry, dir, holder)) {
      return { stack: entry, running: lock !== undefined && lockIsLive(lock) };
    }
  }
  return undefined;
}

function stackRecorded(entry: InstanceSlot, dir: string, holder: PortHolder): boolean {
  if (Object.values(entry.ports ?? {}).includes(holder.port)) {
    return true;
  }
  // The port as well as the pid: a worker or a container's port proxy holds a
  // service's port under a pid devctl never recorded.
  const processes = readPersistedStateFile(join(dir, "state.json"))?.processes ?? [];
  return processes.some((proc) => proc.pid === holder.pid || Object.values(proc.ports).includes(holder.port));
}

function ownID(repoRoot: string): string {
  return repoID(repoRoot, currentInstance());
}

function entryID(entry: InstanceSlot): string {
  return repoID(entry.repoRoot, entry.instance ?? "");
}

/**
 * This checkout's slot, claiming the lowest free one if it has none.
 * `claimed` is true only when this call created the claim.
 */
export function claimSlot(repoRoot: string, now = new Date()): { slot: number; claimed: boolean } {
  return withRegistry((registry) => {
    const root = resolve(repoRoot);
    const instance = currentInstance();
    const id = repoID(root, instance);
    const own = registry.instances.find((entry) => entryID(entry) === id);
    if (own) {
      return { slot: own.slot, claimed: false };
    }
    const slot = pickSlot(registry.instances, root, instance);
    if (slot === undefined) {
      throw hintError(
        KindGeneral,
        `all ${MAX_PORT_SLOTS} port slots are taken by other stacks`,
        "run `devctl instances` to see them, and `devctl down` in one you're done with (or `devctl instances prune` for deleted checkouts)",
      );
    }
    registry.instances.push({ slot, repoRoot: root, ...(instance === "" ? {} : { instance }), claimedAt: now.toISOString() });
    return { slot, claimed: true };
  });
}

/**
 * Claim this checkout's slot for a start. If the start fails, a slot this
 * attempt claimed is given back: a start that never got going holds no
 * ports. One the checkout already held stays, since its services may still
 * run from before (`down --keep-services`).
 */
export async function startWithSlot<T>(repoRoot: string, start: (slot: number) => Promise<T>): Promise<T> {
  const { slot, claimed } = claimSlot(repoRoot);
  try {
    return await start(slot);
  } catch (err) {
    if (claimed) {
      releaseSlot(repoRoot);
    }
    throw err;
  }
}

export function recordInstancePorts(repoRoot: string, ports: Record<string, number>): void {
  withRegistry((registry) => {
    const id = ownID(repoRoot);
    const own = registry.instances.find((entry) => entryID(entry) === id);
    if (own) {
      own.ports = ports;
    }
  });
}

export function releaseSlot(repoRoot: string): void {
  withRegistry((registry) => {
    const id = ownID(repoRoot);
    registry.instances = registry.instances.filter((entry) => entryID(entry) !== id);
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
  return (
    Number.isInteger(entry.slot) &&
    typeof entry.repoRoot === "string" &&
    typeof entry.claimedAt === "string" &&
    (entry.instance === undefined || typeof entry.instance === "string")
  );
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
