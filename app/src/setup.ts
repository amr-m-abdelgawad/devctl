import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, join } from "node:path";
import { DEFAULT_PROXY_PORT, load } from "./config/index.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { detectGoogle, loginGoogle } from "./google.ts";

export function createStarterConfig(repo: string, name = basename(repo), project = "", profile = ""): string {
  writeStarter(repo, name, project, profile);
  return join(repo, ".devctl", "config.yaml");
}

export async function runSetup(startDir: string): Promise<void> {
  const rl = createInterface({ input, output });
  const ask = async (prompt: string, def: string): Promise<string> => {
    const suffix = def !== "" ? ` [${def}]` : "";
    const line = (await rl.question(`${prompt}${suffix}: `)).trim();
    return line === "" ? def : line;
  };
  writeLine("devctl setup — 9 steps");
  writeLine("");
  const cwd = startDir === "" ? process.cwd() : startDir;
  const repo = await ask("1. Repository root", cwd);
  const name = await ask("2. Environment / project name", basename(repo));
  const st = await detectGoogle("");
  const gproj = await ask("3. Google Cloud project", st.projectID);
  writeLine("4. Authentication");
  if (!st.adcAvailable) {
    writeLine("   ADC is not available. Run: gcloud auth application-default login");
    const now = await ask("   Run login now? (y/N)", "n");
    if (now.toLowerCase() === "y") {
      try {
        await loginGoogle();
      } catch (err) {
        writeLine(`   login failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    writeLine("   ✓ Application Default Credentials available");
    if (st.userEmail !== "") {
      writeLine(`   user: ${st.userEmail}`);
    }
  }
  const sa = await ask("5. Service account email to record (optional, never hard-coded at runtime)", "");
  const audience = await ask("6. IAP audience to record on a sample route (optional)", "");
  const portRaw = await ask("7. Proxy listen port", String(DEFAULT_PROXY_PORT));
  const proxyPort = Number(portRaw) || DEFAULT_PROXY_PORT;
  const profile = await ask("8. Default profile name (optional)", "");
  rl.close();
  const cfgPath = join(repo, ".devctl", "config.yaml");
  if (!existsSync(cfgPath)) {
    writeStarter(repo, name, gproj, profile, { sa, audience, proxyPort });
    writeLine("");
    writeLine(`Wrote starter configuration to ${cfgPath}`);
  }
  writeLine("9. Validation");
  try {
    const cfg = load(repo, "");
    const report = await runDoctor(cfg);
    writeLine(formatDoctor(report));
  } catch (err) {
    writeLine(`   configuration is not valid yet: ${err instanceof Error ? err.message : String(err)}`);
    writeLine("   edit .devctl/config.yaml and run `devctl config validate`");
  }
}

function writeStarter(
  repo: string,
  name: string,
  project: string,
  profile: string,
  extra: { sa: string; audience: string; proxyPort: number } = { sa: "", audience: "", proxyPort: DEFAULT_PROXY_PORT },
): void {
  const dir = join(repo, ".devctl");
  mkdirSync(join(dir, "services"), { recursive: true });
  mkdirSync(join(dir, "profiles"), { recursive: true });
  mkdirSync(join(dir, "proxy"), { recursive: true });
  writeFileSync(
    join(dir, "config.yaml"),
    `# yaml-language-server: $schema=https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/schema/devctl.config.schema.json
version: 1

project:
  name: ${name}

google:
  project_id: ${project}

profiles:${profile === "" ? " {}" : `\n  ${profile}:\n    services: []`}

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
`,
  );
}

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}
