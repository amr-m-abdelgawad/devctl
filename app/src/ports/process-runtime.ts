import type { VolumeSeed } from "../domain/service/container-volumes.ts";
import type { ContainerLimits } from "../domain/service/container-limits.ts";

export type ProcessLineHandler = (stream: "stdout" | "stderr", line: string) => void;
/**
 * `pid` is the process that wrote the bytes, when the reader knows it. `end` marks the stream finished; its bytes are empty.
 * `readAtMs` is when the first of the bytes was read, which can be well before they are delivered.
 */
export type ProcessChunkMeta = { pid?: number; end?: boolean; readAtMs?: number };
export type ProcessChunkHandler = (stream: "stdout" | "stderr", bytes: Uint8Array, meta?: ProcessChunkMeta) => boolean;

export type ProcessSpec = {
  name: string;
  args: string[];
  shell: boolean;
  workDir: string;
  env: Record<string, string>;
  graceMs: number;
  captureStdout?: boolean;
  captureStderr?: boolean;
  onLine?: ProcessLineHandler;
  /** Raw service output. Returning false retries the same chunk. */
  onChunk?: ProcessChunkHandler;
  /** When true, stdout/stderr reads pause so a full spool can backpressure the child. */
  paused?: () => boolean;
  onExit?: (code: number, err?: Error) => void;
};

export type ProcessHandle = {
  name: string;
  pid: number;
  startTime: Date;
  workDir: string;
  args: string[];
  done: Promise<{ code: number; err?: Error }>;
};

export type ContainerLaunchSpec = {
  name: string;
  runtime: "docker" | "podman";
  containerName: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  ports: Record<string, number>;
  targetPorts: Record<string, number>;
  volumes: string[];
  // Named volumes to fill before the first run (#117).
  seeds?: VolumeSeed[];
  workDir: string;
  limits?: ContainerLimits;
  onLine?: ProcessLineHandler;
  onChunk?: ProcessChunkHandler;
  paused?: () => boolean;
  onExit?: (code: number, err?: Error) => void;
};

export type ProcessRuntime = {
  isRunning(name: string): boolean;
  runOnce(spec: Omit<ProcessSpec, "onExit">): Promise<{ code: number; stdout: string; stderr: string }>;
  startContainer(spec: ContainerLaunchSpec): Promise<ProcessHandle>;
  start(spec: ProcessSpec): Promise<ProcessHandle>;
  stop(name: string, graceMs: number): Promise<void>;
  get(name: string): ProcessHandle | undefined;
  all(): ProcessHandle[];
};
