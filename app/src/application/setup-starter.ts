import { basename } from "node:path";
import { DEFAULT_PROXY_PORT } from "../domain/config/types.ts";

export type SetupFieldId = "repo" | "name" | "project" | "auth" | "sa" | "audience" | "port" | "profile" | "write";

export type SetupField = {
  readonly id: SetupFieldId;
  readonly title: string;
  readonly prompt: string;
};

export const SETUP_FIELDS: readonly SetupField[] = [
  { id: "repo", title: "Repository", prompt: "Repository root" },
  { id: "name", title: "Environment", prompt: "Environment / project name" },
  { id: "project", title: "Google project", prompt: "Google Cloud project" },
  { id: "auth", title: "Authentication", prompt: "Run gcloud ADC login now? (y/N)" },
  { id: "sa", title: "Service account", prompt: "Service account email to record (optional)" },
  { id: "audience", title: "IAP", prompt: "IAP audience to record on a sample route (optional)" },
  { id: "port", title: "Ports", prompt: "Proxy listen port" },
  { id: "profile", title: "Profiles", prompt: "Default profile name (optional)" },
  { id: "write", title: "Validation", prompt: "Write starter configuration" },
];

export type StarterAnswers = {
  name: string;
  project: string;
  profile: string;
  sa: string;
  audience: string;
  proxyPort: number;
};

export function defaultStarterAnswers(repo: string, detectedProject = ""): StarterAnswers {
  return {
    name: basename(repo),
    project: detectedProject,
    profile: "",
    sa: "",
    audience: "",
    proxyPort: DEFAULT_PROXY_PORT,
  };
}

export function parseProxyPort(raw: string, fallback = DEFAULT_PROXY_PORT): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function starterConfigYaml(answers: StarterAnswers): string {
  const extra = answers;
  return `# yaml-language-server: $schema=https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/schema/devctl.config.schema.json
version: 1

project:
  name: ${answers.name}

google:
  project_id: ${answers.project}

profiles:${answers.profile === "" ? " {}" : `\n  ${answers.profile}:\n    services: []`}

services:
  app:
    command: ["echo", "replace this with your service's start command"]

proxy:
  enabled: true
  listen:
    host: 127.0.0.1
    port: ${extra.proxyPort}${
      extra.audience === ""
        ? ""
        : `
  routes:
    - name: sample
      match:
        host: sample.local
      upstream:
        url: http://127.0.0.1:8081
      auth:
        type: iap
        audience: ${extra.audience}
        identity: ${extra.sa === "" ? "user" : `{ type: service_account, service_account: ${extra.sa} }`}
`
    }

logs:
  max_memory_events: 50000
  persistence:
    enabled: true
    directory: ~/.devctl/logs
    retention_days: 14

auth:
  refresh_threshold_seconds: 300

shutdown:
  stop_services_on_exit: true
  grace_seconds: 10
`;
}
