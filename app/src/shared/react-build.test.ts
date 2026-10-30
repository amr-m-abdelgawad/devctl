import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProductionReact } from "./react-build.ts";

function withoutNodeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "NODE_ENV") {
      env[key] = value;
    }
  }
  return env;
}

// As `bun run src/bin.ts` does: a fresh process that Bun started in
// development mode, so this JSX is compiled to jsxDEV.
function inFreshProcess(body: string): unknown {
  const code = `
    import { loadProductionReact } from ${JSON.stringify(join(import.meta.dir, "react-build.ts"))};
    const restore = loadProductionReact();
    const react = await import("react");
    await import("react-reconciler");
    restore();
    ${body}
  `;
  const run = Bun.spawnSync({ cmd: [process.execPath, "-e", code], cwd: import.meta.dir, env: withoutNodeEnv(), stdout: "pipe", stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  return JSON.parse(run.stdout.toString());
}

describe("loadProductionReact", () => {
  test("leaves a NODE_ENV the user set, and loads nothing", () => {
    const env: Record<string, string | undefined> = { NODE_ENV: "development" };
    const restore = loadProductionReact(env);
    expect(env.NODE_ENV).toBe("development");
    restore();
    expect(env.NODE_ENV).toBe("development");
  });

  test("in a fresh run: production React, a working jsxDEV, and no NODE_ENV left for services", () => {
    expect(
      inFreshProcess(`
        const { jsxDEV } = await import("react/jsx-dev-runtime");
        const element = jsxDEV("box", { width: 1, children: "x" }, "k", false, undefined, undefined);
        console.log(JSON.stringify({ development: "captureOwnerStack" in react, type: element.type, key: element.key, env: process.env.NODE_ENV ?? null }));
      `),
    ).toEqual({ development: false, type: "box", key: "k", env: null });
  });

  test("bin.ts loads it before the CLI and restores the environment before running anything", () => {
    const bin = readFileSync(join(import.meta.dir, "..", "bin.ts"), "utf8");
    const load = bin.indexOf("loadProductionReact()");
    const client = bin.indexOf('import("./bootstrap/client.ts")');
    const cli = bin.indexOf('import("./presentation/cli/cli.ts")');
    const restore = bin.indexOf("restoreEnv()");
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(client);
    expect(cli).toBeLessThan(restore);
    expect(restore).toBeLessThan(bin.indexOf("execute("));
  });
});
