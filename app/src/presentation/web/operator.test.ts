import { expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import type { StatusSnapshot } from "../../domain/status.ts";
import type { WebHost } from "../../ports/web-host.ts";
import { REDACTED_VALUE } from "../../shared/redaction.ts";
import { callWebOperator, webMcpTools } from "./operator.ts";

function fixture() {
  const cfg = defaultConfig();
  const calls: unknown[] = [];
  const status = { repo_root: "/repo", mcp: { running: true, disabled_tools: ["exec_service"] } } as StatusSnapshot;
  const api = {
    config: () => cfg,
    status: () => status,
    validateConfigText: (text: string) => (text === "invalid" ? ["invalid config"] : []),
    exec: async (service: string, command: string[], printEnv?: boolean) => {
      calls.push({ service, command, printEnv });
      return {
        service,
        code: 7,
        stdout: "Authorization: Bearer very-secret-value-for-testing",
        stderr: "",
        environment: { API_TOKEN: "private-value", NAME: "ok" },
      };
    },
    operator: {
      readConfig: () => ({ path: "/repo/.devctl/config.yaml", text: "version: 1", revision: "rev", exists: true }),
      saveConfig: async (text: string, revision: string) => {
        calls.push({ text, revision });
        return { saved: true, issues: [] };
      },
      refreshAuth: async () => {
        calls.push("refresh");
        return {} as StatusSnapshot["identity"];
      },
      invalidateAuth: async () => {
        calls.push("invalidate");
      },
      freePort: async (holder: unknown) => {
        calls.push(holder);
        return "stopped" as const;
      },
      mcpConnection: () => ({ url: "http://127.0.0.1:18700/mcp", token: "private-mcp-bearer" }),
      rotateMcp: async () => {
        calls.push("rotate");
      },
      setMcpTools: async (disabled: string[]) => {
        status.mcp!.disabled_tools = disabled;
        return disabled;
      },
      bootstrapLogs: () => "",
      planStart: () => ({ profile: "local", waves: [["db"], ["api"]], steps: [] }),
      planStop: () => ({ profile: "", waves: [["api"], ["db"]], steps: [] }),
      shutdown: (stopServices: boolean) => {
        calls.push({ shutdown: stopServices });
      },
    },
  } as unknown as WebHost;
  return { api, calls };
}

test("operator mutations require explicit confirmation; config validation does not write", async () => {
  const { api, calls } = fixture();
  expect(await callWebOperator(api, "config_validate", { text: "invalid" })).toEqual({ issues: ["invalid config"] });
  await expect(callWebOperator(api, "config_save", { text: "draft", revision: "rev" })).rejects.toThrow("confirm");
  expect(calls).toEqual([]);
  await callWebOperator(api, "config_save", { text: "draft", revision: "rev", path: "/untrusted", confirm: true });
  expect(calls).toEqual([{ text: "draft", revision: "rev" }]);
});

test("exec is separate from agent MCP permissions and redacts its output; environment reveal is explicit", async () => {
  const { api, calls } = fixture();
  await expect(callWebOperator(api, "service_exec", { service: "api", command: ["echo", "hello"] })).rejects.toThrow();
  const result = (await callWebOperator(api, "service_exec", { service: "api", command: ["echo", "hello world"], confirm: true })) as {
    code: number;
    stdout: string;
  };
  expect(result.code).toBe(7);
  expect(result.stdout).not.toContain("very-secret-value");
  expect(calls[0]).toMatchObject({ command: ["echo", "hello world"] });
  const redacted = (await callWebOperator(api, "service_environment", { service: "api" })) as { environment: Record<string, string> };
  expect(redacted.environment).toEqual({ API_TOKEN: REDACTED_VALUE, NAME: "ok" });
  await expect(callWebOperator(api, "service_environment", { service: "api", reveal: true })).rejects.toThrow();
  expect(await callWebOperator(api, "service_environment", { service: "api", reveal: true, confirm: true })).toMatchObject({
    environment: { API_TOKEN: "private-value" },
  });
  expect(webMcpTools(api).find((tool) => tool.name === "exec_service")?.enabled).toBe(false);
});

test("MCP tools reject unknown names and connection snippets are available only on explicit request", async () => {
  const { api } = fixture();
  await expect(callWebOperator(api, "mcp_tools", { disabled: ["invented"], confirm: true })).rejects.toThrow("Unknown");
  const tools = (await callWebOperator(api, "mcp_tools", { disabled: ["exec_service", "stop_services"], confirm: true })) as ReturnType<
    typeof webMcpTools
  >;
  expect(tools.find((tool) => tool.name === "stop_services")?.enabled).toBe(false);
  const connection = (await callWebOperator(api, "mcp_connection", {})) as { snippets: Array<{ text: string }> };
  expect(connection.snippets).toHaveLength(4);
  expect(connection.snippets[0]?.text).toContain("private-mcp-bearer");
});

test("port cleanup and shutdown validate the reviewed target and never infer a destructive default", async () => {
  const { api, calls } = fixture();
  await expect(callWebOperator(api, "doctor_free_port", { port: 3000, pid: 42, command: "node" })).rejects.toThrow();
  await expect(callWebOperator(api, "doctor_free_port", { port: -1, pid: 42, command: "node", confirm: true })).rejects.toThrow();
  expect(calls).toHaveLength(0);
  await callWebOperator(api, "doctor_free_port", { port: 3000, pid: 42, command: "node", confirm: true });
  await expect(callWebOperator(api, "doctor_free_ports", { holders: [{ port: 3000, pid: 42, command: "node" }] })).rejects.toThrow("confirm");
  await expect(callWebOperator(api, "doctor_free_ports", { holders: [], confirm: true })).rejects.toThrow("at least one");
  await expect(callWebOperator(api, "doctor_free_ports", { holders: [{ port: 0, pid: 42, command: "node" }], confirm: true })).rejects.toThrow(
    "valid port",
  );
  await expect(callWebOperator(api, "session_shutdown", { confirm: true })).rejects.toThrow("Choose");
  await callWebOperator(api, "session_shutdown", { stop_services: false, confirm: true });
  expect(calls).toEqual([{ port: 3000, pid: 42, command: "node" }, { shutdown: false }]);
});

test("freeing several ports confirms once and still reports a holder that changed", async () => {
  const { api } = fixture();
  api.operator!.freePort = async (holder) => {
    if (holder.pid === 2) throw new Error("port 18004 changed");
    return holder.port === 18005 ? "already-free" : "stopped";
  };
  expect(
    await callWebOperator(api, "doctor_free_ports", {
      confirm: true,
      holders: [
        { port: 18003, pid: 1, command: "bun" },
        { port: 18004, pid: 2, command: "node" },
        { port: 18005, pid: 3, command: "python" },
      ],
    }),
  ).toEqual({
    results: [
      { port: 18003, pid: 1, command: "bun", result: "stopped" },
      { port: 18004, pid: 2, command: "node", error: "port 18004 changed" },
      { port: 18005, pid: 3, command: "python", result: "already-free" },
    ],
  });
});

test("starter and Compose import produce reviewable drafts without saving or accepting invalid ports", async () => {
  const { api, calls } = fixture();
  const starter = (await callWebOperator(api, "config_starter", {
    name: "demo",
    project: "test-project",
    profile: "local",
    sa: "dev@example.test",
    audience: "https://api.example.test",
    proxyPort: 18812,
  })) as { text: string };
  expect(starter.text).toContain("name: demo");
  expect(starter.text).toContain("project_id: test-project");
  expect(starter.text).toContain("port: 18812");
  expect(starter.text).toContain("audience: https://api.example.test");
  expect(starter.text).toContain("service_account: dev@example.test");
  for (const proxyPort of [0, 65536, 2.5, "18812"])
    await expect(callWebOperator(api, "config_starter", { proxyPort })).rejects.toThrow("Proxy port");
  const imported = (await callWebOperator(api, "config_import", {
    text: "services:\n  api:\n    image: nginx:alpine\n    deploy:\n      replicas: 2\n",
  })) as { yaml: string; dropped: unknown[] };
  expect(imported.yaml).toContain("nginx:alpine");
  expect(imported.dropped.length).toBeGreaterThan(0);
  expect(calls).toEqual([]);
});

test("auth operations use the injected adapter and review sign-out before revoking", async () => {
  const { api, calls } = fixture();
  await expect(callWebOperator(api, "auth_start", {})).rejects.toThrow("unavailable");
  await expect(callWebOperator(api, "auth_code", { id: "id", code: "code" })).rejects.toThrow("unavailable");
  await expect(callWebOperator(api, "auth_logout", { confirm: true })).rejects.toThrow("unavailable");
  api.operator!.auth = {
    start: () => ({ id: "id", phase: "starting" }),
    status: () => ({ id: "id", phase: "awaiting_code" }),
    submit: (id, code) => {
      calls.push({ id, code });
      return { id, phase: "finishing" };
    },
    cancel: (id) => {
      calls.push({ cancel: id });
    },
    logout: async () => {
      calls.push("logout");
    },
    dispose: () => {},
  };
  expect(await callWebOperator(api, "auth_start", {})).toMatchObject({ id: "id", phase: "starting" });
  expect(await callWebOperator(api, "auth_code", { id: "id", code: "fixture-code" })).toMatchObject({ phase: "finishing" });
  await callWebOperator(api, "auth_cancel", { id: "id" });
  await callWebOperator(api, "auth_refresh", {});
  await expect(callWebOperator(api, "auth_logout", {})).rejects.toThrow("confirm");
  await callWebOperator(api, "auth_logout", { confirm: true });
  await callWebOperator(api, "auth_invalidate", { confirm: true });
  expect(calls).toEqual([{ id: "id", code: "fixture-code" }, { cancel: "id" }, "refresh", "logout", "invalidate"]);
});

test("plans stay read-only and unavailable operator capabilities fail clearly", async () => {
  const { api, calls } = fixture();
  expect(await callWebOperator(api, "plan_start", { profile: "local", services: ["api"] })).toMatchObject({ waves: [["db"], ["api"]] });
  expect(await callWebOperator(api, "plan_stop", {})).toMatchObject({ waves: [["api"], ["db"]] });
  await callWebOperator(api, "mcp_rotate", { confirm: true });
  expect(calls).toEqual(["rotate"]);
  api.status().mcp!.running = false;
  await expect(callWebOperator(api, "mcp_connection", {})).rejects.toThrow("Start MCP");
  await expect(callWebOperator(api, "service_exec", { service: 123, command: [], confirm: true })).rejects.toThrow("text");
  await expect(callWebOperator(api, "service_exec", { service: "api", command: "echo", confirm: true })).rejects.toThrow("list");
  delete api.exec;
  await expect(callWebOperator(api, "service_environment", { service: "api" })).rejects.toThrow("unavailable");
  await expect(callWebOperator(api, "unknown", {})).rejects.toThrow("Unknown");
  delete api.operator;
  await expect(callWebOperator(api, "config_validate", { text: "valid" })).rejects.toThrow("unavailable");
});
