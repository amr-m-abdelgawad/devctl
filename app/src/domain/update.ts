export const NPM_PACKAGE = "@amr-m-abdelgawad/devctl";
export const HOMEBREW_FORMULA_URL =
  "https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/homebrew/devctl.rb";
export const DAEMON_RESTART_HINT = "restart the daemon with `devctl down` then start again";

const NPM_PACKAGE_DIR = "/@amr-m-abdelgawad/devctl/";
const NPX_CACHE_DIR = "/_npx/";
const SOURCE_ENTRY = "/src/bin.ts";
const HOMEBREW_CELLAR = "/cellar/devctl/";

export type InstallKind = "npm" | "npx" | "homebrew" | "release" | "source" | "unknown";

export type InstallChannel = {
  kind: InstallKind;
  /** argv to run when this channel can self-update. */
  command?: string[];
  hint: string;
};

export type UpdateCheck = {
  current: string;
  latest: string;
  newer: boolean;
  hint: string;
  kind: InstallKind;
  command?: string[];
};

export function formatUpdateStatus(result: UpdateCheck): string {
  if (result.newer) {
    return `update available ${result.current} → ${result.latest}  ${result.hint}`;
  }
  if (result.latest !== "") {
    return `${result.current} up to date`;
  }
  return `${result.current} (latest unavailable)`;
}

export function detectInstall(input: {
  scriptPath: string;
  execPath: string;
  standalone: boolean;
}): InstallChannel {
  const script = posixPath(input.scriptPath);
  const exec = posixPath(input.execPath);
  if (!input.standalone && script.includes(NPM_PACKAGE_DIR)) {
    if (script.includes(NPX_CACHE_DIR)) {
      return { kind: "npx", hint: `npx ${NPM_PACKAGE}@latest` };
    }
    const command = npmInstallCommand();
    return { kind: "npm", command, hint: command.join(" ") };
  }
  if (input.standalone && exec.toLowerCase().includes(HOMEBREW_CELLAR)) {
    return {
      kind: "homebrew",
      command: ["brew", "reinstall", "--formula", HOMEBREW_FORMULA_URL],
      hint: `brew reinstall --formula ${HOMEBREW_FORMULA_URL}`,
    };
  }
  if (input.standalone) {
    return {
      kind: "release",
      hint: "re-download the matching GitHub Release binary — see docs/installation.md",
    };
  }
  if (script.endsWith(SOURCE_ENTRY)) {
    return { kind: "source", hint: "git pull && cd app && bun install" };
  }
  return {
    kind: "unknown",
    hint: `npm install --global ${NPM_PACKAGE}@latest  # alternatives: Homebrew or the unsigned GitHub Release binaries — see docs/installation.md`,
  };
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

export function npmInstallCommand(): string[] {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return [npm, "install", "--global", `${NPM_PACKAGE}@latest`];
}

function posixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function parseSemver(value: string): number[] {
  return value
    .replace(/^v/, "")
    .split(".")
    .slice(0, 3)
    .map((part) => {
      const n = Number.parseInt(part.replace(/[^0-9].*$/, ""), 10);
      return Number.isFinite(n) ? n : 0;
    });
}
