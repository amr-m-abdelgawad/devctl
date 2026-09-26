import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { formatComposeImport, importComposeYaml } from "./compose-import.ts";

const SAMPLE = `
services:
  db:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_PASSWORD: secret
    volumes: [dbdata:/var/lib/postgresql/data]
    networks: [backend]
  api:
    command: ["bun", "run", "dev"]
    working_dir: invoices-api
    ports:
      - "18000:8000"
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://db/app
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/healthz"]
    build: .
    env_file: .env
networks:
  backend: {}
`;

describe("compose import", () => {
  test("maps modeled fields and lists dropped ones", () => {
    const result = importComposeYaml(SAMPLE, "demo");
    expect(result.yaml).toContain("image: postgres:16");
    expect(result.yaml).toContain("command:");
    expect(result.yaml).toContain("working_dir: invoices-api");
    expect(result.yaml).toContain("- db");
    expect(result.yaml).not.toContain("build:");
    expect(result.yaml).not.toContain("networks:");
    expect(result.profileServices).toEqual(["api"]);
    expect(result.dropped.some((row) => row.field === "build" && row.service === "api")).toBe(true);
    expect(result.dropped.some((row) => row.field === "volumes" && row.service === "db")).toBe(true);
    expect(formatComposeImport(result)).toContain("Dropped fields:");
  });

  test("published ports import as a name → port map with matching container ports (#135)", () => {
    const result = importComposeYaml(`
services:
  cache:
    image: redis:7-alpine
    ports: ["6379:6379"]
  web:
    image: nginx:1.27
    ports:
      - "127.0.0.1:18080:80"
      - "9443:443/tcp"
      - "9000"
      - 9001
  api:
    image: example/api:1
    ports:
      - target: 3000
        published: "13000"
      - target: 3001
      - "7000-7001:7000-7001"
      - "\${API_PORT}:3002"
      - "70000:80"
  local:
    command: ["bun", "run", "dev"]
    ports: ["18000:8000"]
`, "demo");
    const services = (parse(result.yaml) as { services: Record<string, { ports?: unknown; container?: { ports?: unknown } }> }).services;
    expect(services.cache).toMatchObject({ ports: { http: 6379 }, container: { ports: { http: 6379 } } });
    expect(services.web).toMatchObject({
      ports: { http: 18080, port2: 9443, port3: "auto", port4: "auto" },
      container: { ports: { http: 80, port2: 443, port3: 9000, port4: 9001 } },
    });
    expect(services.api).toMatchObject({ ports: { http: 13000, port2: "auto" }, container: { ports: { http: 3000, port2: 3001 } } });
    expect(services.local?.ports).toEqual({ http: 18000 });
    expect(result.dropped.filter((row) => row.service === "api").map((row) => row.field)).toEqual(["ports[2]", "ports[3]", "ports[4]"]);
  });
});
