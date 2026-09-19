import { describe, expect, test } from "bun:test";
import { inspectIapOAuthClientFile } from "./iap-credentials.ts";

describe("inspectIapOAuthClientFile", () => {
  test("accepts authorized_user JSON whose client_id matches the route", () => {
    expect(
      inspectIapOAuthClientFile(
        { type: "authorized_user", client_id: "cid", client_secret: "s", refresh_token: "rt" },
        "cid",
      ),
    ).toEqual({ ok: true });
  });

  test("accepts a missing type when refresh_token and client_id are present", () => {
    expect(inspectIapOAuthClientFile({ client_id: "cid", refresh_token: "rt" }, "cid")).toEqual({ ok: true });
  });

  test("rejects a non-object, a wrong type, missing fields, and a client_id mismatch", () => {
    expect(inspectIapOAuthClientFile(null, "cid")).toEqual({ ok: false, issue: "malformed" });
    expect(inspectIapOAuthClientFile({ type: "service_account", client_id: "cid", refresh_token: "rt" }, "cid")).toEqual({
      ok: false,
      issue: "wrong_type",
    });
    expect(inspectIapOAuthClientFile({ type: "authorized_user", client_id: "cid" }, "cid")).toEqual({
      ok: false,
      issue: "missing_refresh_token",
    });
    expect(inspectIapOAuthClientFile({ refresh_token: "rt" }, "cid")).toEqual({ ok: false, issue: "missing_client_id" });
    expect(
      inspectIapOAuthClientFile({ type: "authorized_user", client_id: "other", refresh_token: "rt" }, "cid"),
    ).toEqual({ ok: false, issue: "client_id_mismatch" });
  });
});
