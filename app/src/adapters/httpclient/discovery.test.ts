import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { osFileSystem } from "../system/filesystem.ts";
import { discoverCollections } from "./discovery.ts";
import { findRequest } from "../../domain/httpclient/request.ts";

const fixtureRoot = join(import.meta.dir, "fixtures");

describe("Bruno collection discovery", () => {
  test("walks bruno.json markers into a normalized tree", () => {
    const collections = discoverCollections(osFileSystem, fixtureRoot, []);
    const sample = collections.find((item) => item.id === "sample-collection");
    expect(sample?.name).toBe("Fixture API");
    expect(sample?.source).toBe("bruno");
    expect(sample?.readonly).toBe(true);
    expect(sample?.environments.map((env) => env.name)).toEqual(["local"]);
    const health = findRequest(sample?.items ?? [], "health");
    expect(health?.method).toBe("GET");
    expect(health?.url).toBe("{{baseUrl}}/health");
    const echo = findRequest(sample?.items ?? [], "echo");
    expect(echo?.method).toBe("POST");
    expect(echo?.body.mode).toBe("json");
  });
});
