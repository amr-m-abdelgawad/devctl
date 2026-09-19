import { createServer } from "node:http";
import * as http2 from "node:http2";
import type { ServerHttp2Stream } from "node:http2";
import { describe, expect, test } from "bun:test";
import { emptyHealth } from "../../domain/config/types.ts";
import { checkHealth, grpcHealthOrigin, healthCheckerFactory, type HealthPlugin } from "./health.ts";

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

  test("command type is unhealthy instead of throwing when the spawn itself fails", async () => {
    const cfg = emptyHealth();
    cfg.type = "command";
    cfg.command = { args: ["true"], shell: false };
    // A nonexistent cwd makes Bun.spawn throw synchronously rather than
    // merely producing a nonzero exit — checkHealth must catch that too.
    const result = await checkHealth(cfg, 0, {}, "/definitely/does/not/exist/xyz", { ...process.env } as Record<string, string>);
    expect(result.status).toBe("UNHEALTHY");
  });

  test("a throwing plugin check is treated as unhealthy, not a rejection", async () => {
    const cfg = emptyHealth();
    cfg.type = "custom";
    const plugin: HealthPlugin = {
      name: "custom",
      check: async () => {
        throw new Error("plugin exploded");
      },
    };
    const result = await checkHealth(cfg, 0, {}, process.cwd(), {}, [plugin]);
    expect(result.status).toBe("UNHEALTHY");
    expect(result.message).toContain("plugin exploded");
  });

  test("healthCheckerFactory looks up a plugin by type", async () => {
    const plugin: HealthPlugin = {
      name: "custom",
      check: async () => ({ status: "HEALTHY", message: "ok" }),
    };
    const factory = healthCheckerFactory([plugin]);
    const checker = factory.lookup("custom");
    expect(checker).toBeDefined();
    const result = await checker!.check(emptyHealth(), { pid: 1, ports: {}, workDir: ".", env: {} });
    expect(result.status).toBe("HEALTHY");
    expect(factory.lookup("missing")).toBeUndefined();
  });
});


test("health checker factory supplies builtins and case-insensitive plugin overrides", async () => {
  const factory = healthCheckerFactory([]);
  for (const kind of ["HTTP", "tcp", "command", "process", "grpc"]) expect(factory.lookup(kind)).toBeDefined();
  const overriding = healthCheckerFactory([{ name: "PROCESS", check: async () => ({ status: "HEALTHY", message: "plugin override" }) }]);
  const cfg = { ...emptyHealth(), type: "process" };
  const result = await overriding.lookup("Process")!.check(cfg, { pid: 0, ports: {}, workDir: "", env: {} });
  expect(result).toEqual({ status: "HEALTHY", message: "plugin override" });
});

const GRPC_SERVING = 1;
const GRPC_NOT_SERVING = 2;
const GRPC_SERVICE_UNKNOWN = 3;

function grpcFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

async function startHealthServer(status: number, grpcStatus = "0"): Promise<{ address: string; close: () => Promise<void> }> {
  const server = http2.createServer();
  server.on("stream", (raw) => {
    const stream = raw as ServerHttp2Stream;
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": grpcStatus }));
      stream.end(grpcFrame(Buffer.from([0x08, status])));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return { address: `127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("grpc health", () => {
  test("SERVING is healthy", async () => {
    const server = await startHealthServer(GRPC_SERVING);
    const cfg = { ...emptyHealth(), type: "grpc", address: server.address };
    const result = await checkHealth(cfg, 0, {}, process.cwd(), {});
    expect(result).toEqual({ status: "HEALTHY", message: "SERVING" });
    await server.close();
  });

  test("NOT_SERVING is unhealthy", async () => {
    const server = await startHealthServer(GRPC_NOT_SERVING);
    const cfg = { ...emptyHealth(), type: "grpc", address: server.address };
    const result = await checkHealth(cfg, 0, {}, process.cwd(), {});
    expect(result.status).toBe("UNHEALTHY");
    expect(result.message).toBe("NOT_SERVING");
    await server.close();
  });

  test("SERVICE_UNKNOWN is unhealthy", async () => {
    const server = await startHealthServer(GRPC_SERVICE_UNKNOWN);
    const cfg = { ...emptyHealth(), type: "grpc", address: server.address, grpc_service: "temporal.api.workflowservice.v1.WorkflowService" };
    const result = await checkHealth(cfg, 0, {}, process.cwd(), {});
    expect(result.status).toBe("UNHEALTHY");
    expect(result.message).toBe("SERVICE_UNKNOWN");
    await server.close();
  });

  test("RPC failure is unhealthy", async () => {
    const server = await startHealthServer(GRPC_SERVING, "14");
    const cfg = { ...emptyHealth(), type: "grpc", address: server.address };
    const result = await checkHealth(cfg, 0, {}, process.cwd(), {});
    expect(result.status).toBe("UNHEALTHY");
    expect(result.message).toContain("grpc-status");
    await server.close();
  });

  test("connection failure is unhealthy", async () => {
    const cfg = { ...emptyHealth(), type: "grpc", address: "127.0.0.1:1" };
    const result = await checkHealth(cfg, 0, {}, process.cwd(), {});
    expect(result.status).toBe("UNHEALTHY");
  });

  test("health origins bracket IPv6 hosts", () => {
    expect(grpcHealthOrigin("http", "::1", 50051)).toBe("http://[::1]:50051");
    expect(grpcHealthOrigin("https", "127.0.0.1", 50051)).toBe("https://127.0.0.1:50051");
  });

  test("missing address is unhealthy", async () => {
    const cfg = { ...emptyHealth(), type: "grpc", address: "" };
    const result = await checkHealth(cfg, 0, {}, process.cwd(), {});
    expect(result.status).toBe("UNHEALTHY");
    expect(result.message).toContain("no grpc address");
  });
});
