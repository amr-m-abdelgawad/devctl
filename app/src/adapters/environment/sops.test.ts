import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../domain/config/types.ts";
import { bunSopsRunner, detectSopsInputType, loadSopsEnvironment, mapSopsKeys, sopsConfigIssues, sopsDecryptArgs, type SopsCommandRunner } from "./sops.ts";

function cfgWith(file: string, sources: string[] = ["sops"]) {
  const dir = mkdtempSync(join(tmpdir(), "devctl-sops-"));
  const cfg = defaultConfig();
  cfg.repoRoot = dir;
  cfg.environment.sources = sources;
  cfg.environment.sops.file = file;
  return { dir, cfg };
}

describe("sops key map", () => {
  test("uppercases keys when key_map is omitted", () => {
    expect(mapSopsKeys({ my_api_key: "a", ALREADY: "b" }, {})).toEqual({ MY_API_KEY: "a", ALREADY: "b" });
  });

  test("renames mapped keys, shares one value, and still uppercases the rest", () => {
    const out = mapSopsKeys(
      { my_api_key_secret_name: "key", shared_token: "tok", other: "x" },
      {
        MY_API_KEY: "my_api_key_secret_name",
        SERVICE_A_TOKEN: "shared_token",
        SERVICE_B_TOKEN: "shared_token",
      },
    );
    expect(out).toEqual({
      MY_API_KEY: "key",
      SERVICE_A_TOKEN: "tok",
      SERVICE_B_TOKEN: "tok",
      OTHER: "x",
    });
    expect(out.MY_API_KEY_SECRET_NAME).toBeUndefined();
    expect(out.SHARED_TOKEN).toBeUndefined();
  });

  test("an explicit mapping wins when it collides with an uppercased raw key", () => {
    expect(mapSopsKeys({ foo: "raw", bar: "mapped" }, { FOO: "bar" })).toEqual({ FOO: "mapped" });
  });

  test("omits a mapped env var whose SOPS key is absent", () => {
    expect(mapSopsKeys({ other: "x" }, { MY_API_KEY: "missing" })).toEqual({ OTHER: "x" });
  });
});

describe("sops decrypt command", () => {
  test("detects json, yaml, and dotenv from the file name", () => {
    expect(detectSopsInputType("secrets.enc.json")).toBe("json");
    expect(detectSopsInputType("secrets.json.enc")).toBe("json");
    expect(detectSopsInputType("secrets.enc.yaml")).toBe("yaml");
    expect(detectSopsInputType("secrets.yml")).toBe("yaml");
    expect(detectSopsInputType(".env")).toBe("dotenv");
    expect(detectSopsInputType("secrets.env.enc")).toBe("dotenv");
    expect(detectSopsInputType("secrets.bin")).toBe("");
  });

  test("passes input type from the override or the extension", () => {
    expect(sopsDecryptArgs("/repo/secrets.enc.json", "")).toEqual([
      "sops", "--decrypt", "--output-type", "dotenv", "--input-type", "json", "/repo/secrets.enc.json",
    ]);
    expect(sopsDecryptArgs("/repo/secrets.enc.json", "dotenv")).toContain("--input-type");
    expect(sopsDecryptArgs("/repo/secrets.enc.json", "dotenv").at(-2)).toBe("dotenv");
    expect(sopsDecryptArgs("/repo/secrets.bin", "")).toEqual([
      "sops", "--decrypt", "--output-type", "dotenv", "/repo/secrets.bin",
    ]);
  });
});

describe("load sops environment", () => {
  test("does not run sops unless the source is listed", async () => {
    const { cfg } = cfgWith("secrets.enc.json", []);
    let called = false;
    const run: SopsCommandRunner = async () => {
      called = true;
      return { ok: true, stdout: "A=b\n", stderr: "", code: 0 };
    };
    expect(await loadSopsEnvironment(cfg, run)).toEqual({ values: {} });
    expect(called).toBe(false);
  });

  test("skips a missing file without running sops", async () => {
    const { cfg } = cfgWith("secrets.enc.json");
    const run: SopsCommandRunner = async () => {
      throw new Error("should not run");
    };
    const result = await loadSopsEnvironment(cfg, run);
    expect(result.values).toEqual({});
    expect(result.warning).toContain("file not found");
  });

  test("skips a path that leaves the repository", async () => {
    const { cfg } = cfgWith("../secrets.enc.json");
    const result = await loadSopsEnvironment(cfg, async () => ({ ok: true, stdout: "A=b\n", stderr: "", code: 0 }));
    expect(result.values).toEqual({});
    expect(result.warning).toContain("inside the repository");
  });

  test("skips a symlink that points outside the repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "devctl-sops-link-"));
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secrets.enc.json"), "{}\n");
    symlinkSync(join(outside, "secrets.enc.json"), join(repo, "secrets.enc.json"));
    const cfg = defaultConfig();
    cfg.repoRoot = repo;
    cfg.environment.sources = ["sops"];
    cfg.environment.sops.file = "secrets.enc.json";
    const result = await loadSopsEnvironment(cfg, async () => ({ ok: true, stdout: "LEAKED=1\n", stderr: "", code: 0 }));
    expect(result.values).toEqual({});
    expect(result.warning).toContain("inside the repository");
    expect(result.warning).not.toContain("LEAKED");
  });

  test("parses dotenv stdout and applies key_map", async () => {
    const { dir, cfg } = cfgWith("secrets.enc.json");
    writeFileSync(join(dir, "secrets.enc.json"), "{}\n");
    cfg.environment.sops.key_map = { MY_API_KEY: "my_api_key", SERVICE_B_TOKEN: "shared_token" };
    const seen: { cmd: string[]; cwd: string }[] = [];
    const run: SopsCommandRunner = async (spec) => {
      seen.push(spec);
      return { ok: true, stdout: "my_api_key=\"p@ss word\"\nshared_token=tok\nother=x\n", stderr: "", code: 0 };
    };
    const result = await loadSopsEnvironment(cfg, run);
    expect(result.warning).toBeUndefined();
    expect(result.values).toEqual({ MY_API_KEY: "p@ss word", SERVICE_B_TOKEN: "tok", OTHER: "x" });
    expect(seen[0]?.cwd).toBe(dir);
    expect(seen[0]?.cmd.slice(0, 4)).toEqual(["sops", "--decrypt", "--output-type", "dotenv"]);
    expect(seen[0]?.cmd).toContain("--input-type");
    expect(seen[0]?.cmd.at(-1)).toBe(realpathSync(join(dir, "secrets.enc.json")));
  });

  test("keeps decrypted values when key_map names a missing key", async () => {
    const { dir, cfg } = cfgWith("secrets.enc.yaml");
    writeFileSync(join(dir, "secrets.enc.yaml"), "{}\n");
    cfg.environment.sops.key_map = { MY_DB_PASSWORD: "absent" };
    const result = await loadSopsEnvironment(cfg, async () => ({ ok: true, stdout: "other=x\n", stderr: "", code: 0 }));
    expect(result.values).toEqual({ OTHER: "x" });
    expect(result.warning).toContain("MY_DB_PASSWORD→absent");
  });

  test("skips when sops is not on PATH and does not echo stdout", async () => {
    const { dir, cfg } = cfgWith("secrets.enc.json");
    writeFileSync(join(dir, "secrets.enc.json"), "{}\n");
    const result = await loadSopsEnvironment(cfg, async () => ({ ok: false, reason: "not_found", detail: "sops is not on PATH" }));
    expect(result).toEqual({ values: {}, warning: "sops environment source skipped: sops is not on PATH" });
  });

  test("skips a failed decrypt without including plaintext", async () => {
    const { dir, cfg } = cfgWith("secrets.enc.json");
    writeFileSync(join(dir, "secrets.enc.json"), "{}\n");
    const result = await loadSopsEnvironment(cfg, async () => ({
      ok: true,
      code: 1,
      stdout: "MY_API_KEY=super-secret\n",
      stderr: "Failed to get the data key\n",
    }));
    expect(result.values).toEqual({});
    expect(result.warning).toContain("Failed to get the data key");
    expect(result.warning).not.toContain("super-secret");
  });

  test("config issues require a file inside the repo when sops is listed", () => {
    const cfg = defaultConfig();
    cfg.repoRoot = "/repo";
    cfg.environment.sources = ["sops"];
    cfg.environment.sops.input_type = "xml";
    cfg.environment.sops.key_map = { MY_API_KEY: "" };
    expect(sopsConfigIssues(cfg).join("\n")).toContain("environment.sops.file is required");
    expect(sopsConfigIssues(cfg).join("\n")).toContain("input_type must be json, yaml, or dotenv");
    expect(sopsConfigIssues(cfg).join("\n")).toContain("key_map.MY_API_KEY");
    cfg.environment.sops = { file: "secrets.enc.json", input_type: "json", key_map: { MY_API_KEY: "my_api_key" } };
    expect(sopsConfigIssues(cfg)).toEqual([]);
  });
});

describe("bun sops runner", () => {
  test("reports a missing binary as not on PATH", async () => {
    const result = await bunSopsRunner({ cmd: ["__devctl_sops_missing__"], cwd: tmpdir() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });
});
