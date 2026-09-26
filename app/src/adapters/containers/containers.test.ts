import { describe, expect, test } from "bun:test";
import { DEFAULT_CONTAINER_CPUS, DEFAULT_CONTAINER_MEMORY, DEFAULT_CONTAINER_PIDS_LIMIT } from "../../domain/service/container-limits.ts";
import { containerEnvironment, containerRunArgs, seedCopyArgs, type ContainerLaunchSpec } from "./containers.ts";

describe("container runtime", () => {
  test("builds a deterministic run command without putting secret values in argv", () => {
    const spec: ContainerLaunchSpec = {
      name: "postgres", runtime: "docker", containerName: "devctl-repo-postgres",
      image: "postgres:16", command: [], workDir: "/repo",
      env: { Z_VALUE: "visible", POSTGRES_PASSWORD: "do-not-leak" },
      ports: { db: 15432 }, targetPorts: { db: 5432 },
      volumes: ["pgdata:/var/lib/postgresql/data"],
    };
    const args = containerRunArgs(spec);
    expect(args).toEqual([
      "run", "--detach", "--name", "devctl-repo-postgres", "--label", "devctl.managed=true",
      "--memory", DEFAULT_CONTAINER_MEMORY, "--cpus", DEFAULT_CONTAINER_CPUS, "--pids-limit", String(DEFAULT_CONTAINER_PIDS_LIMIT),
      "--publish", "127.0.0.1:15432:5432", "--env", "POSTGRES_PASSWORD", "--env", "Z_VALUE",
      "--volume", "pgdata:/var/lib/postgresql/data", "postgres:16",
    ]);
    expect(args.join(" ")).not.toContain("do-not-leak");
  });

  test("applies declared user, read-only root, and dropped capabilities", () => {
    const spec: ContainerLaunchSpec = {
      name: "app", runtime: "docker", containerName: "devctl-repo-app",
      image: "app:local", command: [], workDir: "/repo",
      env: {}, ports: {}, targetPorts: {}, volumes: [],
      limits: { user: "65534:65534", memory: "512m", cpus: "0.5", readOnly: true, capDrop: ["ALL"], pidsLimit: 64 },
    };
    expect(containerRunArgs(spec)).toEqual([
      "run", "--detach", "--name", "devctl-repo-app", "--label", "devctl.managed=true",
      "--user", "65534:65534", "--read-only", "--cap-drop", "ALL",
      "--memory", "512m", "--cpus", "0.5", "--pids-limit", "64",
      "app:local",
    ]);
  });

  test("preserves image-owned environment such as PATH", () => {
    expect(containerEnvironment({ PATH: "/host/bin", HOME: "/host", API_URL: "http://api" })).toEqual({ API_URL: "http://api" });
  });
});

test("a volume seed copies with the service's image, source read-only", () => {
  expect(seedCopyArgs("postgres:16", { volume: "devctl-abc-pgdata", from: "pgdata", required: false })).toEqual([
    "run", "--rm",
    "--volume", "pgdata:/devctl-seed-from:ro",
    "--volume", "devctl-abc-pgdata:/devctl-seed-to",
    "--entrypoint", "cp", "postgres:16", "-a", "/devctl-seed-from/.", "/devctl-seed-to/",
  ]);
});
