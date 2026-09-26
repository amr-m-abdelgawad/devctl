import { spawn, type Subprocess } from "bun";
import { KindProcessStart, newError, wrapError } from "../../shared/errors.ts";
import type { LineHandler } from "../process/processes.ts";

import { emptyContainer } from "../../domain/config/types.ts";
import { resolvedContainerLimits } from "../../domain/service/container-limits.ts";
import type { ContainerLaunchSpec } from "../../ports/process-runtime.ts";
import type { VolumeSeed } from "../../domain/service/container-volumes.ts";
export type { ContainerLaunchSpec } from "../../ports/process-runtime.ts";

export type ContainerControl = {
  id: string;
  runtime: "docker" | "podman";
  containerName: string;
  done: Promise<{ code: number; err?: Error }>;
  running: () => boolean;
  stop: (graceMs: number) => Promise<void>;
};

export async function startContainer(spec: ContainerLaunchSpec): Promise<ContainerControl> {
  await removeStopped(spec.runtime, spec.containerName);
  for (const seed of spec.seeds ?? []) {
    await seedVolume(spec.runtime, spec.image, seed, spec.onLine);
  }
  const args = containerRunArgs(spec);
  const launched = await runCaptured(spec.runtime, args, spec.env);
  if (launched.code !== 0 || launched.stdout.trim() === "") {
    throw newError(KindProcessStart, `failed to start ${spec.containerName}: ${launched.stderr.trim() || "container runtime returned no id"}`);
  }
  const id = launched.stdout.trim().split(/\s+/)[0] ?? "";
  return attachControl(spec.runtime, spec.containerName, id, spec.onLine, spec.onExit);
}

export function containerRunArgs(spec: ContainerLaunchSpec): string[] {
  const args = ["run", "--detach", "--name", spec.containerName, "--label", "devctl.managed=true"];
  const limits = spec.limits ?? resolvedContainerLimits(emptyContainer());
  if (limits.user !== "") {
    args.push("--user", limits.user);
  }
  if (limits.readOnly) {
    args.push("--read-only");
  }
  for (const cap of limits.capDrop) {
    args.push("--cap-drop", cap);
  }
  args.push("--memory", limits.memory, "--cpus", limits.cpus, "--pids-limit", String(limits.pidsLimit));
  for (const [name, hostPort] of Object.entries(spec.ports)) {
    const target = spec.targetPorts[name] ?? hostPort;
    args.push("--publish", `127.0.0.1:${hostPort}:${target}`);
  }
  for (const key of Object.keys(spec.env).sort()) args.push("--env", key);
  for (const volume of spec.volumes) args.push("--volume", volume);
  args.push(spec.image, ...spec.command);
  return args;
}

const IMAGE_OWNED_ENV = new Set(["PATH", "HOME", "HOSTNAME", "PWD", "OLDPWD", "SHLVL", "_", "TMPDIR"]);

export function containerEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !IMAGE_OWNED_ENV.has(key)));
}

export async function adoptContainer(
  runtime: "docker" | "podman",
  containerName: string,
  onLine?: LineHandler,
  onExit?: (code: number, err?: Error) => void,
): Promise<ContainerControl | undefined> {
  const inspected = await runCaptured(runtime, ["inspect", "--format", "{{.Id}} {{.State.Running}}", containerName], process.env as Record<string, string>);
  if (inspected.code !== 0) return undefined;
  const [id, running] = inspected.stdout.trim().split(/\s+/);
  if (!id || running !== "true") return undefined;
  return attachControl(runtime, containerName, id, onLine, onExit);
}

function attachControl(
  runtime: "docker" | "podman",
  containerName: string,
  id: string,
  onLine?: LineHandler,
  onExit?: (code: number, err?: Error) => void,
): ContainerControl {
  let alive = true;
  const logs = spawn({ cmd: [runtime, "logs", "--follow", id], stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  void pump(logs.stdout, "stdout", onLine);
  void pump(logs.stderr, "stderr", onLine);
  const waiter = spawn({ cmd: [runtime, "wait", id], stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const done = Promise.all([new Response(waiter.stdout as ReadableStream).text(), waiter.exited]).then(async ([text, waitCode]) => {
    alive = false;
    logs.kill();
    const parsed = Number.parseInt(text.trim(), 10);
    const code = Number.isFinite(parsed) ? parsed : (waitCode ?? 1);
    const err = code === 0 ? undefined : new Error(`container exited with code ${code}`);
    await runCaptured(runtime, ["rm", "--force", id], process.env as Record<string, string>);
    onExit?.(code, err);
    return { code, err };
  });
  return {
    id, runtime, containerName, done,
    running: () => alive,
    stop: async (graceMs) => {
      const seconds = Math.max(1, Math.ceil(graceMs / 1000));
      await runCaptured(runtime, ["stop", "--time", String(seconds), id], process.env as Record<string, string>);
      await done;
    },
  };
}

/**
 * Fills a stack's named volume the first time it is used (#117): copies
 * `seed.from` into it with the service's own image (`cp -a`, so ownership and
 * modes carry over). A volume that already exists is left alone, so a seed
 * runs once per stack.
 */
export async function seedVolume(runtime: "docker" | "podman", image: string, seed: VolumeSeed, onLine?: LineHandler): Promise<void> {
  const env = process.env as Record<string, string>;
  if ((await runCaptured(runtime, ["volume", "inspect", seed.volume], env)).code === 0) {
    return;
  }
  if ((await runCaptured(runtime, ["volume", "inspect", seed.from], env)).code !== 0) {
    if (seed.required) {
      throw newError(KindProcessStart, `seed_from volume "${seed.from}" for ${seed.volume} does not exist`);
    }
    return;
  }
  const created = await runCaptured(runtime, ["volume", "create", "--label", "devctl.managed=true", seed.volume], env);
  if (created.code !== 0) {
    throw newError(KindProcessStart, `failed to create volume ${seed.volume}: ${created.stderr.trim()}`);
  }
  onLine?.("stderr", `devctl: seeding volume ${seed.volume} from ${seed.from}`);
  const copied = await runCaptured(runtime, seedCopyArgs(image, seed), env);
  if (copied.code !== 0) {
    // Leave no half-filled volume behind: the next start seeds it again.
    await runCaptured(runtime, ["volume", "rm", "--force", seed.volume], env);
    throw newError(
      KindProcessStart,
      `failed to seed volume ${seed.volume} from ${seed.from} (the copy runs \`cp\` in ${image}): ${copied.stderr.trim()}`,
    );
  }
}

export function seedCopyArgs(image: string, seed: VolumeSeed): string[] {
  return ["run", "--rm", "--volume", `${seed.from}:/devctl-seed-from:ro`, "--volume", `${seed.volume}:/devctl-seed-to`, "--entrypoint", "cp", image, "-a", "/devctl-seed-from/.", "/devctl-seed-to/"];
}

async function removeStopped(runtime: string, name: string): Promise<void> {
  const inspected = await runCaptured(runtime, ["inspect", "--format", "{{.State.Running}}", name], process.env as Record<string, string>);
  if (inspected.code === 0 && inspected.stdout.trim() === "false") await runCaptured(runtime, ["rm", "--force", name], process.env as Record<string, string>);
}

async function runCaptured(runtime: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc: Subprocess = spawn({ cmd: [runtime, ...args], env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited,
    ]);
    return { code: code ?? 1, stdout, stderr };
  } catch (err) {
    throw wrapError(KindProcessStart, `unable to run ${runtime}`, err);
  }
}

async function pump(stream: ReadableStream<Uint8Array> | number | undefined, kind: "stdout" | "stderr", handler?: LineHandler): Promise<void> {
  if (!stream || typeof stream === "number" || !handler) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    buffer += decoder.decode(item.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handler(kind, line.replace(/\r$/, ""));
  }
  if (buffer !== "") handler(kind, buffer);
}
