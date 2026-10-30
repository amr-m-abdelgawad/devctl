import { expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import type { WebHost } from "../../ports/web-host.ts";
import { WebHttpServer } from "./server.ts";

const TOKEN = "test-operator-session-bearer";

async function fixture() {
  const calls: unknown[] = [];
  const config = defaultConfig();
  const host = {
    config: () => config,
    status: () => ({ mcp: { running: true, disabled_tools: ["exec_service"] } }),
    validateConfigText: () => [],
    exec: async () => ({ service: "api", code: 4, stdout: "Bearer test-secret-credential-value", stderr: "" }),
    operator: {
      readConfig: () => ({
        path: "/repo/.devctl/config.yaml",
        text: "# preserve comments\nAPI_TOKEN: private-config-value\n",
        revision: "revision",
        exists: true,
      }),
      saveConfig: async (text: string, revision: string) => {
        calls.push({ text, revision });
        return { saved: true, issues: [] };
      },
      bootstrapLogs: () => "Bearer test-secret-credential-value",
      auth: {
        status: () => ({ id: "login", phase: "awaiting_code", url: "https://accounts.google.com/o/oauth2/auth?test=1" }),
        submit: (_id: string, code: string) => {
          calls.push({ submitted: code.length });
          return { id: "login", phase: "finishing" };
        },
      },
    },
  } as unknown as WebHost;
  const server = new WebHttpServer({ host: "127.0.0.1", port: 0, token: TOKEN, hostApi: host });
  await server.start();
  const base = `http://127.0.0.1:${server.listenPort()}`;
  const get = (path: string, token = TOKEN) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const post = (action: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/operator`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}`, Origin: base, ...headers },
      body: JSON.stringify({ action, args }),
    });
  return { server, calls, base, get, post };
}

test("operator reads require authorization, avoid caching private documents, and redact bootstrap logs", async () => {
  const { server, get } = await fixture();
  try {
    for (const path of ["/api/config/document", "/api/auth/login", "/api/mcp/tools", "/api/supervisor/logs"]) {
      expect((await get(path, "wrong-token")).status).toBe(401);
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(await (await get("/api/config/document")).json()).toMatchObject({
      text: "# preserve comments\nAPI_TOKEN: private-config-value\n",
    });
    expect(await (await get("/api/supervisor/logs")).text()).not.toContain("test-secret-credential-value");
    const wrongMethod = await get("/api/operator");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  } finally {
    await server.stop();
  }
});

test("operator writes enforce bearer, origin, JSON, and action confirmation before execution", async () => {
  const { server, calls, post } = await fixture();
  const args = { text: "draft", revision: "revision", confirm: true };
  try {
    expect((await post("config_save", args, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post("config_save", args, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("config_save", args, { Origin: "" })).status).toBe(403);
    expect((await post("config_save", args, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post("config_save", { ...args, confirm: false })).status).toBe(400);
    expect((await post("invented_action", {})).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await post("config_save", args)).status).toBe(200);
    expect(calls).toEqual([{ text: "draft", revision: "revision" }]);
    const exec = await post("service_exec", { service: "api", command: ["false"], confirm: true });
    expect(exec.status).toBe(200);
    expect(await exec.json()).toMatchObject({ code: 4, stdout: "Bearer ********" });
  } finally {
    await server.stop();
  }
});

test("operator config drafts accept more than control's 64 KiB but reject bodies above 1 MiB", async () => {
  const { server, calls, post } = await fixture();
  try {
    expect((await post("config_save", { text: "#".repeat(70 * 1024), revision: "revision", confirm: true })).status).toBe(200);
    expect((await post("config_save", { text: "#".repeat(1_048_576), revision: "revision", confirm: true })).status).toBe(413);
    expect(calls).toHaveLength(1);
  } finally {
    await server.stop();
  }
});

test("login code submission returns only session state, never the authorization code", async () => {
  const { server, calls, post } = await fixture();
  try {
    const response = await post("auth_code", { id: "login", code: "private-one-time-code" });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("private-one-time-code");
    expect(JSON.parse(body)).toEqual({ id: "login", phase: "finishing" });
    expect(calls).toEqual([{ submitted: 21 }]);
  } finally {
    await server.stop();
  }
});
