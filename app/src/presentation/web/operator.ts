import type { WebHost } from "../../ports/web-host.ts";
import { importComposeYaml } from "../../application/compose-import.ts";
import { defaultStarterAnswers, starterConfigYaml } from "../../application/setup-starter.ts";
import { mcpSnippets } from "../mcp/snippets.ts";
import { detectorFor, callMcpTool, MCP_TOOLS } from "../mcp/tools.ts";

function text(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string") throw new Error(`${key} must be text`);
  return args[key];
}
function names(args: Record<string, unknown>, key: string): string[] {
  const list = args[key];
  if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) throw new Error(`${key} must be a list of strings`);
  return list;
}
function confirm(args: Record<string, unknown>): void {
  if (args.confirm !== true) throw new Error("Review and confirm this action first");
}

export function webMcpTools(host: WebHost) {
  const disabled = new Set(host.status().mcp?.disabled_tools ?? ["exec_service"]);
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    label: tool.label,
    summary: tool.summary,
    category: tool.category,
    mutates: tool.mutates === true,
    enabled: !disabled.has(tool.name),
  }));
}

export async function callWebOperator(host: WebHost, action: string, args: Record<string, unknown>): Promise<unknown> {
  const operator = host.operator;
  if (!operator) throw new Error("Operator controls are unavailable on this supervisor");
  switch (action) {
    case "config_validate":
      return { issues: host.validateConfigText(text(args, "text")) };
    case "config_save":
      confirm(args);
      return operator.saveConfig(text(args, "text"), text(args, "revision"));
    case "config_import":
      return importComposeYaml(text(args, "text"), host.config().project.name || "imported");
    case "config_starter": {
      const answers = defaultStarterAnswers(host.status().repo_root, host.config().google.project_id);
      for (const key of ["name", "project", "profile", "sa", "audience"] as const)
        if (typeof args[key] === "string") answers[key] = args[key];
      if (args.proxyPort !== undefined) {
        if (typeof args.proxyPort !== "number" || !Number.isInteger(args.proxyPort) || args.proxyPort < 1 || args.proxyPort > 65535)
          throw new Error("Proxy port must be between 1 and 65535");
        answers.proxyPort = args.proxyPort;
      }
      return { text: starterConfigYaml(answers) };
    }
    case "auth_start": {
      if (!operator.auth) throw new Error("Browser sign-in is unavailable");
      return operator.auth.start();
    }
    case "auth_code": {
      if (!operator.auth) throw new Error("Browser sign-in is unavailable");
      return operator.auth.submit(text(args, "id"), text(args, "code"));
    }
    case "auth_cancel":
      operator.auth?.cancel(text(args, "id"));
      return { ok: true };
    case "auth_refresh":
      return operator.refreshAuth();
    case "auth_logout":
      confirm(args);
      if (!operator.auth) throw new Error("Browser sign-out is unavailable");
      await operator.auth.logout();
      return { ok: true };
    case "auth_invalidate":
      confirm(args);
      await operator.invalidateAuth();
      return { ok: true };
    case "service_exec":
      confirm(args);
      return callMcpTool(host, "exec_service", { service: text(args, "service"), command: names(args, "command"), confirm: true });
    case "service_environment": {
      if (!host.exec) throw new Error("Environment resolution is unavailable");
      if (args.reveal === true) confirm(args);
      const result = await host.exec(text(args, "service"), [], true);
      return {
        environment: args.reveal === true ? (result.environment ?? {}) : detectorFor(host.config()).redactMap(result.environment ?? {}),
      };
    }
    case "mcp_tools": {
      confirm(args);
      const disabled = names(args, "disabled");
      if (disabled.some((name) => !MCP_TOOLS.some((tool) => tool.name === name))) throw new Error("Unknown MCP tool");
      await operator.setMcpTools(disabled);
      return webMcpTools(host);
    }
    case "mcp_connection": {
      const connection = operator.mcpConnection();
      if (!host.status().mcp?.running) throw new Error("Start MCP before copying its connection details");
      return { url: connection.url, snippets: mcpSnippets(connection.url, connection.token) };
    }
    case "mcp_rotate":
      confirm(args);
      await operator.rotateMcp();
      return { ok: true };
    case "doctor_free_port": {
      confirm(args);
      const port = args.port,
        pid = args.pid;
      if (
        !Number.isInteger(port) ||
        typeof port !== "number" ||
        port < 1 ||
        port > 65535 ||
        !Number.isInteger(pid) ||
        typeof pid !== "number" ||
        pid <= 0
      )
        throw new Error("A valid port and process ID are required");
      return { result: await operator.freePort({ port, pid, command: text(args, "command") }) };
    }
    case "plan_start":
      return operator.planStart({
        services: args.services === undefined ? undefined : names(args, "services"),
        profile: typeof args.profile === "string" ? args.profile : undefined,
      });
    case "plan_stop":
      return operator.planStop(args.services === undefined ? [] : names(args, "services"));
    case "session_shutdown":
      confirm(args);
      if (typeof args.stop_services !== "boolean") throw new Error("Choose whether to stop services");
      operator.shutdown(args.stop_services);
      return { ok: true };
    default:
      throw new Error("Unknown operator action");
  }
}
