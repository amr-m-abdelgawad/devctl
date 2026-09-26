import { describe, expect, test } from "bun:test";
import { ProcessManager } from "../process/processes.ts";
import { seedVolume } from "./containers.ts";

// Docker is not installed on GitHub-hosted macOS runners. The Linux
// `container-tests` job sets DEVCTL_CONTAINER_TESTS=1; macos-tests does not.
const enabled = process.env.DEVCTL_CONTAINER_TESTS === "1";

describe.skipIf(!enabled)("container integration (requires Docker via DEVCTL_CONTAINER_TESTS=1)", () => {
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

describe.skipIf(!enabled)("volume seeding (#117, requires Docker)", () => {
  const run = async (...args: string[]) => {
    const proc = Bun.spawn({ cmd: ["docker", ...args], stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out: out.trim(), code };
  };

  test("a stack's volume is filled from its source once, and left alone after", async () => {
    const tag = `${process.pid}-${Date.now()}`;
    const from = `devctl-test-src-${tag}`;
    const volume = `devctl-test-dst-${tag}`;
    try {
      expect((await run("run", "--rm", "--volume", `${from}:/d`, "alpine:3.20", "sh", "-c", "echo seeded > /d/marker")).code).toBe(0);
      const lines: string[] = [];
      await seedVolume("docker", "alpine:3.20", { volume, from, required: false }, (_stream, line) => lines.push(line));
      expect(lines).toEqual([`devctl: seeding volume ${volume} from ${from}`]);
      expect((await run("run", "--rm", "--volume", `${volume}:/d`, "alpine:3.20", "cat", "/d/marker")).out).toBe("seeded");
      // Already there: not copied again, so the stack's own changes survive.
      await run("run", "--rm", "--volume", `${volume}:/d`, "alpine:3.20", "sh", "-c", "echo changed > /d/marker");
      await seedVolume("docker", "alpine:3.20", { volume, from, required: false });
      expect((await run("run", "--rm", "--volume", `${volume}:/d`, "alpine:3.20", "cat", "/d/marker")).out).toBe("changed");
    } finally {
      await run("volume", "rm", "--force", from, volume);
    }
  }, 60_000);

  test("a missing implicit source is skipped; a missing seed_from fails", async () => {
    const tag = `${process.pid}-${Date.now()}`;
    const volume = `devctl-test-dst-${tag}`;
    await seedVolume("docker", "alpine:3.20", { volume, from: `devctl-test-absent-${tag}`, required: false });
    expect((await run("volume", "inspect", volume)).code).not.toBe(0);
    await expect(seedVolume("docker", "alpine:3.20", { volume, from: `devctl-test-absent-${tag}`, required: true })).rejects.toThrow("does not exist");
  }, 30_000);
});

function handleStillManaged(manager: ProcessManager): boolean {
  return manager.get("fixture") !== undefined;
}
