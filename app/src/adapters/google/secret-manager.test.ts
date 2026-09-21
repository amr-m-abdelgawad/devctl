import { describe, expect, test } from "bun:test";
import { KindAuthorization, KindConfiguration } from "../../shared/errors.ts";
import { secretManagerFetcher } from "./secret-manager.ts";

const SECRET = "projects/demo/secrets/db-pass";
const VERSIONED = `${SECRET}/versions/latest`;

describe("secretManagerFetcher", () => {
  test("decodes the latest payload and versions an unversioned name", async () => {
    const restore = stubFetch(async (url, init) => {
      expect(url).toBe(`https://secretmanager.googleapis.com/v1/${VERSIONED}:access`);
      expect(header(init, "Authorization")).toBe("Bearer tok");
      return jsonResponse(200, { payload: { data: Buffer.from("s3cret", "utf8").toString("base64") } });
    });
    try {
      const fetchSecret = secretManagerFetcher(async () => "tok");
      expect(await fetchSecret(SECRET)).toBe("s3cret");
    } finally {
      restore();
    }
  });

  test("keeps an explicit version in the request path", async () => {
    const versioned = `${SECRET}/versions/3`;
    const restore = stubFetch(async (url) => {
      expect(url).toBe(`https://secretmanager.googleapis.com/v1/${versioned}:access`);
      return jsonResponse(200, { payload: { data: Buffer.from("v3", "utf8").toString("base64") } });
    });
    try {
      const fetchSecret = secretManagerFetcher(async () => "tok");
      expect(await fetchSecret(versioned)).toBe("v3");
    } finally {
      restore();
    }
  });

  test("treats HTTP 401 and 403 as authorization failures", async () => {
    for (const status of [401, 403]) {
      const restore = stubFetch(async () => jsonResponse(status, {}));
      try {
        const fetchSecret = secretManagerFetcher(async () => "tok");
        await expect(fetchSecret(SECRET)).rejects.toMatchObject({ kind: KindAuthorization });
      } finally {
        restore();
      }
    }
  });

  test("treats other HTTP failures as configuration errors", async () => {
    const restore = stubFetch(async () => jsonResponse(404, {}));
    try {
      const fetchSecret = secretManagerFetcher(async () => "tok");
      await expect(fetchSecret(SECRET)).rejects.toMatchObject({ kind: KindConfiguration });
    } finally {
      restore();
    }
  });

  test("rejects a successful response with no payload", async () => {
    const restore = stubFetch(async () => jsonResponse(200, {}));
    try {
      const fetchSecret = secretManagerFetcher(async () => "tok");
      await expect(fetchSecret(SECRET)).rejects.toMatchObject({ kind: KindConfiguration });
    } finally {
      restore();
    }
  });

  test("treats a non-JSON success body as a configuration error", async () => {
    const restore = stubFetch(async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const fetchSecret = secretManagerFetcher(async () => "tok");
      await expect(fetchSecret(SECRET)).rejects.toMatchObject({ kind: KindConfiguration });
    } finally {
      restore();
    }
  });
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => impl(String(input), init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function header(init: RequestInit | undefined, name: string): string | null {
  if (!init?.headers) {
    return null;
  }
  return new Headers(init.headers).get(name);
}
