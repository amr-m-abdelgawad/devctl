import { describe, expect, test } from "bun:test";
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
});
