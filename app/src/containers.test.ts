import { describe, expect, test } from "bun:test";
import { containerEnvironment, containerRunArgs, type ContainerLaunchSpec } from "./containers.ts";

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
      "--publish", "15432:5432", "--env", "POSTGRES_PASSWORD", "--env", "Z_VALUE",
      "--volume", "pgdata:/var/lib/postgresql/data", "postgres:16",
    ]);
    expect(args.join(" ")).not.toContain("do-not-leak");
  });

  test("preserves image-owned environment such as PATH", () => {
    expect(containerEnvironment({ PATH: "/host/bin", HOME: "/host", API_URL: "http://api" })).toEqual({ API_URL: "http://api" });
  });
});
