import { createServer } from "node:http";
import { describe, expect, test } from "bun:test";
import { emptyHealth } from "./config/types.ts";
import { checkHealth } from "./health.ts";

describe("health checks", () => {
  test("process type is healthy when pid is alive", async () => {
    const cfg = emptyHealth();
    cfg.type = "process";
    const result = await checkHealth(cfg, process.pid, {}, process.cwd(), {});
    expect(result.status).toBe("HEALTHY");
  });

  test("process type is unhealthy when pid is dead", async () => {
    const cfg = emptyHealth();
    cfg.type = "process";
    const result = await checkHealth(cfg, 999_999_999, {}, process.cwd(), {});
    expect(result.status).toBe("UNHEALTHY");
  });

  test("unknown type is unhealthy", async () => {
    const cfg = emptyHealth();
    cfg.type = "laser";
    const result = await checkHealth(cfg, process.pid, {}, process.cwd(), {});
    expect(result.status).toBe("UNHEALTHY");
    expect(result.message).toContain("unknown health type");
  });

  test("http type is healthy on 200", async () => {
    const server = createServer((_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const cfg = emptyHealth();
    cfg.type = "http";
    cfg.url = `http://127.0.0.1:${port}/`;
    const result = await checkHealth(cfg, 0, {}, process.cwd(), {});
    expect(result.status).toBe("HEALTHY");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("command type succeeds on exit 0", async () => {
    const cfg = emptyHealth();
    cfg.type = "command";
    cfg.command = { args: ["true"], shell: false };
    const result = await checkHealth(cfg, 0, {}, process.cwd(), { ...process.env } as Record<string, string>);
    expect(result.status).toBe("HEALTHY");
  });
});
