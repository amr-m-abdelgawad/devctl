import { describe, expect, test } from "bun:test";
import { namedVolume, scopeVolumes, volumeConfigIssues } from "./container-volumes.ts";

const PREFIX = "devctl-0123456789abcdef-";

describe("container volumes per stack", () => {
  test("only named volumes are recognized", () => {
    expect(namedVolume("pgdata:/var/lib/postgresql/data")).toBe("pgdata");
    expect(namedVolume("pg.data_1:/data:ro")).toBe("pg.data_1");
    for (const spec of ["./data:/data", "/abs/data:/data", "~/data:/data", "/data", "C:\\data:/data", "C:/data:/data"]) {
      expect(namedVolume(spec)).toBeUndefined();
    }
  });

  test("named volumes get the stack prefix and a seed from the unprefixed volume", () => {
    const out = scopeVolumes({ volumes: ["pgdata:/var/lib/postgresql/data:rw", "./init:/docker-entrypoint-initdb.d"], seed_from: {}, shared_volumes: [] }, PREFIX);
    expect(out.volumes).toEqual([`${PREFIX}pgdata:/var/lib/postgresql/data:rw`, "./init:/docker-entrypoint-initdb.d"]);
    expect(out.seeds).toEqual([{ volume: `${PREFIX}pgdata`, from: "pgdata", required: false }]);
  });

  test("seed_from names the source; shared volumes pass through unseeded", () => {
    const out = scopeVolumes({ volumes: ["pgdata:/data", "gocache:/root/.cache"], seed_from: { pgdata: "pgdata-fixture" }, shared_volumes: ["gocache"] }, PREFIX);
    expect(out.volumes).toEqual([`${PREFIX}pgdata:/data`, "gocache:/root/.cache"]);
    expect(out.seeds).toEqual([{ volume: `${PREFIX}pgdata`, from: "pgdata-fixture", required: true }]);
  });

  test("seed_from and shared_volumes may only name the container's named volumes", () => {
    expect(volumeConfigIssues("services.db", { volumes: ["pgdata:/data", "./x:/x"], seed_from: { pgdata: "snap" }, shared_volumes: [] })).toEqual([]);
    expect(volumeConfigIssues("services.db", { volumes: ["pgdata:/data"], seed_from: { other: "snap", pgdata: "not a name" }, shared_volumes: ["x"] })).toEqual([
      'services.db.container.shared_volumes: "x" is not a named volume in container.volumes',
      "services.db.container.seed_from.other: not a named volume in container.volumes",
      'services.db.container.seed_from.pgdata: "not a name" is not a volume name',
    ]);
    expect(volumeConfigIssues("services.db", { volumes: ["pgdata:/data"], seed_from: { pgdata: "snap" }, shared_volumes: ["pgdata"] })[0]).toContain("a shared volume is never seeded");
  });
});
