import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { ConfigDirName, ConfigFileName, DEFAULT_PROXY_PORT, load } from "../../adapters/config/index.ts";
import { formatDoctor, runDoctor } from "../../adapters/doctor/doctor.ts";
import { KindConfiguration, newError } from "../../shared/errors.ts";
import { detectGoogle, loginGoogle } from "../../adapters/google/google.ts";

// Honors the same "config file or .devctl directory" convention as the
// global --config flag, but — unlike discover()'s explicit-path resolution —
// tolerates a target that doesn't exist yet, since setup's job is often to
// create it for the first time.
export function resolveSetupTarget(startDir: string, explicitConfig: string): { repo: string; cfgPath: string } {
  const cwd = startDir === "" ? process.cwd() : startDir;
  if (explicitConfig === "") {
    return { repo: cwd, cfgPath: join(cwd, ConfigDirName, ConfigFileName) };
  }
  const abs = resolve(explicitConfig);
  const isDir = existsSync(abs) ? statSync(abs).isDirectory() : !/\.ya?ml$/i.test(abs);
  if (!isDir) {
    const parent = dirname(abs);
    const repo = basename(parent) === ConfigDirName ? dirname(parent) : parent;
    return { repo, cfgPath: abs };
  }
  if (basename(abs) === ConfigDirName) {
    return { repo: dirname(abs), cfgPath: join(abs, ConfigFileName) };
  }
  return { repo: abs, cfgPath: join(abs, ConfigDirName, ConfigFileName) };
}

export function createStarterConfig(repo: string, name = basename(repo), project = "", profile = "", force = false): string {
  const cfgPath = join(repo, ConfigDirName, ConfigFileName);
  if (!force && existsSync(cfgPath)) {
    throw newError(KindConfiguration, `configuration already exists at ${cfgPath}; not overwriting`);
  }
  writeStarter(repo, name, project, profile);
  return cfgPath;
}

export async function runSetup(startDir: string, explicitConfig = "", force = false): Promise<void> {
  const { repo, cfgPath } = resolveSetupTarget(startDir, explicitConfig);
  if (!force && existsSync(cfgPath)) {
    writeLine(`Found existing configuration at ${cfgPath}; nothing written.`);
    writeLine("Pass --force to overwrite it, or edit it directly.");
    return;
  }
  const rl = createInterface({ input, output });
  const ask = async (prompt: string, def: string): Promise<string> => {
    const suffix = def !== "" ? ` [${def}]` : "";
    const line = (await rl.question(`${prompt}${suffix}: `)).trim();
    return line === "" ? def : line;
  };
  // Repository root is already settled (from --config or cwd) once --config
  // was given explicitly; asking again would just invite a mismatch between
  // what was passed and what setup actually writes to.
  const steps = explicitConfig === "" ? 9 : 8;
  let step = 0;
  const nextStep = (): number => {
    step += 1;
    return step;
  };
  writeLine(`devctl setup — ${steps} steps`);
  writeLine("");
  if (explicitConfig === "") {
    await ask(`${nextStep()}. Repository root`, repo);
  }
  const name = await ask(`${nextStep()}. Environment / project name`, basename(repo));
  const st = await detectGoogle("");
  const gproj = await ask(`${nextStep()}. Google Cloud project`, st.projectID);
  writeLine(`${nextStep()}. Authentication`);
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
  const sa = await ask(`${nextStep()}. Service account email to record (optional, never hard-coded at runtime)`, "");
  const audience = await ask(`${nextStep()}. IAP audience to record on a sample route (optional)`, "");
  const portRaw = await ask(`${nextStep()}. Proxy listen port`, String(DEFAULT_PROXY_PORT));
  const proxyPort = Number(portRaw) || DEFAULT_PROXY_PORT;
  const profile = await ask(`${nextStep()}. Default profile name (optional)`, "");
  rl.close();
  writeStarter(repo, name, gproj, profile, { sa, audience, proxyPort });
  writeLine("");
  writeLine(`Wrote starter configuration to ${cfgPath}`);
  writeLine(`${nextStep()}. Validation`);
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
