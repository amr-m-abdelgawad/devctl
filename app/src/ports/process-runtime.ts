export type ProcessLineHandler = (stream: "stdout" | "stderr", line: string) => void;

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
  workDir: string;
  onLine?: ProcessLineHandler;
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
