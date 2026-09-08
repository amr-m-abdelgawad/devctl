import { describe, expect, test } from "bun:test";
import { applyInstall, checkUpdate, githubUpdate, spawnInstall } from "./update.ts";
import { compareSemver, detectInstall, formatUpdateStatus, HOMEBREW_FORMULA_URL, NPM_PACKAGE } from "../../domain/update.ts";
import { VERSION } from "../../version.ts";

describe("update", () => {
  test("compareSemver orders dotted versions", () => {
    expect(compareSemver("0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "1.0.0")).toBe(-1);
  });

  test("detectInstall maps each documented install path", () => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    expect(detectInstall({
      scriptPath: "/usr/local/lib/node_modules/@amr-m-abdelgawad/devctl/dist/devctl.js",
      execPath: "/usr/local/lib/node_modules/bun/bin/bun.exe",
      standalone: false,
    })).toMatchObject({ kind: "npm", command: [npm, "install", "--global", `${NPM_PACKAGE}@latest`] });

    expect(detectInstall({
      scriptPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@amr-m-abdelgawad\\devctl\\dist\\devctl.js",
      execPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe",
      standalone: false,
    }).kind).toBe("npm");

    expect(detectInstall({
      scriptPath: "/home/me/.npm/_npx/123/@amr-m-abdelgawad/devctl/dist/devctl.js",
      execPath: "/home/me/.npm/_npx/123/node_modules/bun/bin/bun.exe",
      standalone: false,
    }).kind).toBe("npx");

    expect(detectInstall({
      scriptPath: "",
      execPath: "/opt/homebrew/Cellar/devctl/0.2.3/bin/devctl",
      standalone: true,
    })).toMatchObject({
      kind: "homebrew",
      command: ["brew", "reinstall", "--formula", HOMEBREW_FORMULA_URL],
    });

    expect(detectInstall({
      scriptPath: "status",
      execPath: "/usr/local/bin/devctl",
      standalone: true,
    }).kind).toBe("release");

    expect(detectInstall({
      scriptPath: "/Users/me/devctl/app/src/bin.ts",
      execPath: "/Users/me/.bun/bin/bun",
      standalone: false,
    }).kind).toBe("source");

    expect(detectInstall({
      scriptPath: "/tmp/scratch.js",
      execPath: "/usr/bin/bun",
      standalone: false,
    }).kind).toBe("unknown");
  });

  test("checkUpdate reports a newer GitHub release and the detected install command", async () => {
    const channel = detectInstall({
      scriptPath: "/usr/local/lib/node_modules/@amr-m-abdelgawad/devctl/dist/devctl.js",
      execPath: "/usr/local/lib/node_modules/bun/bin/bun.exe",
      standalone: false,
    });
    const result = await checkUpdate(async () => new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 }), channel);
    expect(result.current).toBe(VERSION);
    expect(result.latest).toBe("9.9.9");
    expect(result.newer).toBe(true);
    expect(result.kind).toBe("npm");
    expect(result.command).toEqual([process.platform === "win32" ? "npm.cmd" : "npm", "install", "--global", `${NPM_PACKAGE}@latest`]);
    expect(result.hint).toContain(`${process.platform === "win32" ? "npm.cmd" : "npm"} install --global`);
  });

  test("formatUpdateStatus reports availability without installing", () => {
    expect(formatUpdateStatus({ current: "0.2.0", latest: "0.3.0", newer: true, hint: "npm i", kind: "npm" })).toContain("0.2.0 → 0.3.0");
    expect(formatUpdateStatus({ current: "0.2.0", latest: "0.2.0", newer: false, hint: "npm i", kind: "npm" })).toBe("0.2.0 up to date");
    expect(formatUpdateStatus({ current: "0.2.0", latest: "", newer: false, hint: "npm i", kind: "unknown" })).toBe("0.2.0 (latest unavailable)");
  });

  test("checkUpdate treats HTTP errors and fetch failures as unavailable", async () => {
    const channel = detectInstall({
      scriptPath: "/usr/local/lib/node_modules/@amr-m-abdelgawad/devctl/dist/devctl.js",
      execPath: "/usr/local/lib/node_modules/bun/bin/bun.exe",
      standalone: false,
    });
    const failed = await checkUpdate(async () => new Response("no", { status: 503 }), channel);
    expect(failed.latest).toBe("");
    expect(failed.newer).toBe(false);
    const thrown = await checkUpdate(async () => {
      throw new Error("offline");
    }, channel);
    expect(thrown.latest).toBe("");
  });

  test("githubUpdate wires check and apply", async () => {
    const updates = githubUpdate(async () => new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }));
    const check = await updates.check();
    expect(check.latest).toBe("1.0.0");
    const applied = await updates.apply([process.execPath, "-e", ""]);
    expect(applied.code).toBe(0);
  });

  test("spawnInstall captures stdout when not inheriting", async () => {
    const result = await spawnInstall([process.execPath, "-e", "process.stdout.write('ok')"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  test("applyInstall runs the channel command", async () => {
    const calls: string[][] = [];
    const result = await applyInstall(["npm", "install", "--global", `${NPM_PACKAGE}@latest`], async (command) => {
      calls.push([...command]);
      return { code: 0, stdout: "added 1 package", stderr: "" };
    });
    expect(calls).toEqual([["npm", "install", "--global", `${NPM_PACKAGE}@latest`]]);
    expect(result.code).toBe(0);
  });
});
