import type { ContainerLaunchSpec, ProcessHandle, ProcessRuntime, ProcessSpec } from "../../ports/process-runtime.ts";

export class FakeProcessRuntime implements ProcessRuntime {
  isRunning(name: string): boolean { return this.handles.has(name); }
  async runOnce(): Promise<{ code: number; stdout: string; stderr: string }> { return { code: 0, stdout: "", stderr: "" }; }
  async startContainer(spec: ContainerLaunchSpec): Promise<ProcessHandle> {
    return this.start({ name: spec.name, args: spec.command, shell: false, workDir: spec.workDir, env: spec.env, graceMs: 0, onLine: spec.onLine, onExit: spec.onExit });
  }
  readonly started: ProcessSpec[] = [];
  readonly stopped: string[] = [];
  private readonly handles = new Map<string, ProcessHandle>();
  private nextPid = 1000;

  async start(spec: ProcessSpec): Promise<ProcessHandle> {
    this.started.push(spec);
    const handle: ProcessHandle = {
      name: spec.name,
      pid: this.nextPid,
      startTime: new Date(),
      workDir: spec.workDir,
      args: [...spec.args],
      done: Promise.resolve({ code: 0 }),
    };
    this.nextPid += 1;
    this.handles.set(spec.name, handle);
    return handle;
  }

  async stop(name: string, _graceMs: number): Promise<void> {
    this.stopped.push(name);
    this.handles.delete(name);
  }

  get(name: string): ProcessHandle | undefined {
    return this.handles.get(name);
  }

  all(): ProcessHandle[] {
    return [...this.handles.values()];
  }
}
