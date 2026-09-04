import { describe, expect, test } from "bun:test";
import { ProcessManager } from "./processes.ts";

const enabled = process.env.DEVCTL_CONTAINER_TESTS === "1";

describe.skipIf(!enabled)("container integration", () => {
  test("captures logs and stops/removes a managed Docker container", async () => {
    const name = `devctl-test-${process.pid}-${Date.now()}`;
    const lines: string[] = [];
    const manager = new ProcessManager();
    await manager.startContainer({
      name: "fixture", runtime: "docker", containerName: name, image: "alpine:3.20",
      command: ["sh", "-c", "echo ready; sleep 30"], env: {}, ports: {}, targetPorts: {}, volumes: [], workDir: "",
      onLine: (_stream, line) => lines.push(line),
    });
    for (let i = 0; i < 40 && !lines.includes("ready"); i += 1) await Bun.sleep(50);
    expect(lines).toContain("ready");
    expect(handleStillManaged(manager)).toBe(true);
    await manager.stop("fixture", 1_000);
    expect(manager.get("fixture")).toBeUndefined();
    const inspect = Bun.spawn({ cmd: ["docker", "inspect", name], stdout: "ignore", stderr: "ignore" });
    expect(await inspect.exited).not.toBe(0);
  }, 30_000);

  test("reports the container's real exit code", async () => {
    const manager = new ProcessManager();
    const handle = await manager.startContainer({
      name: "failure", runtime: "docker", containerName: `devctl-test-exit-${process.pid}-${Date.now()}`,
      image: "alpine:3.20", command: ["sh", "-c", "exit 7"], env: {}, ports: {}, targetPorts: {}, volumes: [], workDir: "",
    });
    expect((await handle.done).code).toBe(7);
    const inspect = Bun.spawn({ cmd: ["docker", "inspect", handle.container?.id ?? ""], stdout: "ignore", stderr: "ignore" });
    expect(await inspect.exited).not.toBe(0);
  }, 30_000);
});

function handleStillManaged(manager: ProcessManager): boolean {
  return manager.get("fixture") !== undefined;
}
