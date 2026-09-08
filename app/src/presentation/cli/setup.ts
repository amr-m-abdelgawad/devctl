import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_PROXY_PORT } from "../../domain/config/types.ts";
import { ConfigDirName, ConfigFileName } from "../../domain/config/paths.ts";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { defaultStarterAnswers, parseProxyPort, SETUP_FIELDS, starterConfigYaml, type StarterAnswers } from "../../application/setup-starter.ts";
import { KindConfiguration, newError } from "../../shared/errors.ts";

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
  writeStarter(repo, { ...defaultStarterAnswers(repo, project), name, profile });
  return cfgPath;
}

export async function runSetup(client: Pick<ClientRuntime, "detectGoogle" | "loginGoogle" | "load" | "runDoctor" | "formatDoctor">, startDir: string, explicitConfig = "", force = false): Promise<void> {
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
  let step = 0;
  const nextStep = (): number => {
    step += 1;
    return step;
  };
  writeLine(`devctl setup — ${SETUP_FIELDS.length} steps`);
  writeLine("");
  if (explicitConfig === "") {
    await ask(`${nextStep()}. Repository root`, repo);
  }
  const answers: StarterAnswers = defaultStarterAnswers(repo, "");
  const name = await ask(`${nextStep()}. ${SETUP_FIELDS[1]?.prompt}`, basename(repo));
  answers.name = name;
  const st = await client.detectGoogle("");
  const gproj = await ask(`${nextStep()}. ${SETUP_FIELDS[2]?.prompt}`, st.projectID);
  answers.project = gproj;
  writeLine(`${nextStep()}. ${SETUP_FIELDS[3]?.title}`);
  if (!st.adcAvailable) {
    writeLine("   ADC is not available. Run: gcloud auth application-default login");
    const now = await ask("   Run login now? (y/N)", "n");
    if (now.toLowerCase() === "y") {
      try {
        await client.loginGoogle();
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
  answers.sa = await ask(`${nextStep()}. ${SETUP_FIELDS[4]?.prompt}`, "");
  answers.audience = await ask(`${nextStep()}. ${SETUP_FIELDS[5]?.prompt}`, "");
  const portRaw = await ask(`${nextStep()}. ${SETUP_FIELDS[6]?.prompt}`, String(DEFAULT_PROXY_PORT));
  answers.proxyPort = parseProxyPort(portRaw);
  answers.profile = await ask(`${nextStep()}. ${SETUP_FIELDS[7]?.prompt}`, "");
  rl.close();
  writeStarter(repo, answers);
  writeLine("");
  writeLine(`Wrote starter configuration to ${cfgPath}`);
  writeLine(`${nextStep()}. Validation`);
  try {
    const cfg = client.load(repo, "");
    const report = await client.runDoctor.execute(cfg);
    writeLine(client.formatDoctor(report));
  } catch (err) {
    writeLine(`   configuration is not valid yet: ${err instanceof Error ? err.message : String(err)}`);
    writeLine("   edit .devctl/config.yaml and run `devctl config validate`");
  }
}

export function writeStarter(repo: string, answers: StarterAnswers): void {
  const dir = join(repo, ".devctl");
  mkdirSync(join(dir, "services"), { recursive: true });
  mkdirSync(join(dir, "profiles"), { recursive: true });
  mkdirSync(join(dir, "proxy"), { recursive: true });
  writeFileSync(join(dir, "config.yaml"), starterConfigYaml(answers));
}

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}
