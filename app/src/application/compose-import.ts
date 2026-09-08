import { parse, stringify } from "yaml";

export type DroppedComposeField = {
  service: string;
  field: string;
  reason: string;
};

export type ComposeImportResult = {
  yaml: string;
  dropped: DroppedComposeField[];
  services: string[];
  profileServices: string[];
};

const DROPPED_KEYS: Record<string, string> = {
  build: "not modeled; use a local command or pre-built image",
  networks: "not modeled",
  deploy: "not modeled",
  replicas: "not modeled",
  env_file: "per-service env_file is dropped; set environment.sources at the project level",
  volumes: "not modeled on import",
  labels: "not modeled",
  restart: "use service.restart in authoring",
  expose: "use ports",
  privileged: "not modeled",
  user: "not modeled",
  entrypoint: "not modeled; command is mapped when present",
  hostname: "not modeled",
  extra_hosts: "not modeled",
  cap_add: "not modeled",
  cap_drop: "not modeled",
  mem_limit: "not modeled",
  cpus: "not modeled",
  scale: "not modeled",
};

export function importComposeYaml(raw: string, projectName = "imported"): ComposeImportResult {
  const doc = parse(raw) as unknown;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("compose file is not a mapping");
  }
  const root = doc as Record<string, unknown>;
  const servicesIn = isRecord(root.services) ? root.services : {};
  const dropped: DroppedComposeField[] = [];
  if (root.networks !== undefined) {
    dropped.push({ service: "(root)", field: "networks", reason: DROPPED_KEYS.networks ?? "not modeled" });
  }
  const services: Record<string, Record<string, unknown>> = {};
  const profileServices: string[] = [];
  for (const [name, spec] of Object.entries(servicesIn)) {
    if (!isRecord(spec)) {
      continue;
    }
    const mapped = mapComposeService(name, spec, dropped);
    services[name] = mapped.body;
    if (!mapped.container) {
      profileServices.push(name);
    }
  }
  const yaml = stringify({
    version: 1,
    project: { name: projectName },
    services,
    profiles: {
      default: { services: profileServices },
    },
  });
  return { yaml, dropped, services: Object.keys(services), profileServices };
}

export function formatComposeImport(result: ComposeImportResult): string {
  const lines = [result.yaml.trimEnd(), "", "Dropped fields:"];
  if (result.dropped.length === 0) {
    lines.push("(none)");
  } else {
    lines.push("service\tfield\treason");
    for (const row of result.dropped) {
      lines.push(`${row.service}\t${row.field}\t${row.reason}`);
    }
  }
  if (result.profileServices.length < result.services.length) {
    lines.push("");
    lines.push("Container services were omitted from profile default so first start does not require Docker.");
  }
  return `${lines.join("\n")}\n`;
}

function mapComposeService(
  name: string,
  spec: Record<string, unknown>,
  dropped: DroppedComposeField[],
): { body: Record<string, unknown>; container: boolean } {
  for (const key of Object.keys(spec)) {
    const reason = DROPPED_KEYS[key];
    if (reason) {
      dropped.push({ service: name, field: key, reason });
    }
  }
  const body: Record<string, unknown> = {};
  const command = mapCommand(spec.command);
  if (command) {
    body.command = command;
  }
  const workingDir = typeof spec.working_dir === "string" ? spec.working_dir : typeof spec.workingDir === "string" ? spec.workingDir : "";
  if (workingDir !== "") {
    body.working_dir = workingDir;
  }
  const deps = mapDependsOn(spec.depends_on);
  if (deps.length > 0) {
    body.dependencies = deps;
  }
  const env = mapEnvironment(spec.environment);
  if (Object.keys(env).length > 0) {
    body.environment = { defaults: env };
  }
  const ports = mapPorts(spec.ports);
  if (ports.host.length > 0) {
    body.ports = ports.host;
  }
  const health = mapHealthcheck(spec.healthcheck);
  if (health) {
    body.health = health;
  }
  const image = typeof spec.image === "string" ? spec.image : "";
  const container = image !== "";
  if (container) {
    body.container = {
      image,
      ...(ports.container && Object.keys(ports.container).length > 0 ? { ports: ports.container } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  return { body, container };
}

function mapCommand(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return ["sh", "-c", value];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return undefined;
}

function mapDependsOn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (isRecord(value)) {
    return Object.keys(value);
  }
  return [];
}

function mapEnvironment(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }
      const eq = item.indexOf("=");
      if (eq === -1) {
        out[item] = "";
      } else {
        out[item.slice(0, eq)] = item.slice(eq + 1);
      }
    }
    return out;
  }
  if (isRecord(value)) {
    for (const [key, raw] of Object.entries(value)) {
      out[key] = raw === undefined || raw === null ? "" : String(raw);
    }
  }
  return out;
}

function mapPorts(value: unknown): { host: Array<{ name: string; value: number }>; container: Record<string, number> } {
  const host: Array<{ name: string; value: number }> = [];
  const container: Record<string, number> = {};
  if (!Array.isArray(value)) {
    return { host, container };
  }
  let i = 0;
  for (const item of value) {
    const parsed = parseComposePort(item);
    if (!parsed) {
      continue;
    }
    i += 1;
    const name = i === 1 ? "http" : `port${i}`;
    host.push({ name, value: parsed.host });
    container[name] = parsed.container;
  }
  return { host, container };
}

function parseComposePort(value: unknown): { host: number; container: number } | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { host: value, container: value };
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/\/(tcp|udp)$/i, "");
    const parts = cleaned.split(":");
    const last = Number(parts[parts.length - 1]);
    const host = parts.length > 1 ? Number(parts[parts.length - 2]) : last;
    if (!Number.isFinite(last) || !Number.isFinite(host)) {
      return undefined;
    }
    return { host, container: last };
  }
  if (isRecord(value)) {
    const published = Number(value.published ?? value.target);
    const target = Number(value.target ?? value.published);
    if (!Number.isFinite(published) || !Number.isFinite(target)) {
      return undefined;
    }
    return { host: published, container: target };
  }
  return undefined;
}

function mapHealthcheck(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || value.disable === true) {
    return undefined;
  }
  const test = mapCommand(value.test);
  if (!test || (test[0] === "CMD" && test.length === 1) || test[0] === "NONE") {
    return undefined;
  }
  const args = test[0] === "CMD" || test[0] === "CMD-SHELL" ? test.slice(1) : test;
  if (args.length === 0) {
    return undefined;
  }
  return { type: "command", command: args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
