// Pure inspect of an already-parsed gcloud authorized_user JSON against a
// route's client_id. Adapters read the file; this never touches the filesystem.

export type IapOAuthClientInspectIssue =
  | "malformed"
  | "wrong_type"
  | "missing_refresh_token"
  | "missing_client_id"
  | "client_id_mismatch";

export type IapOAuthClientInspect =
  | { ok: true }
  | { ok: false; issue: IapOAuthClientInspectIssue };

export function inspectIapOAuthClientFile(parsed: unknown, routeClientId: string): IapOAuthClientInspect {
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, issue: "malformed" };
  }
  const obj = parsed as Record<string, unknown>;
  // Prefer type: authorized_user. A missing type is accepted when the mint
  // fields are present (same as resolveIapOAuthClient). Any other type is not
  // an authorized_user file.
  if (obj.type !== undefined && obj.type !== "authorized_user") {
    return { ok: false, issue: "wrong_type" };
  }
  const refreshToken = typeof obj.refresh_token === "string" ? obj.refresh_token : "";
  if (refreshToken === "") {
    return { ok: false, issue: "missing_refresh_token" };
  }
  const clientId = typeof obj.client_id === "string" ? obj.client_id : "";
  if (clientId === "") {
    return { ok: false, issue: "missing_client_id" };
  }
  if (clientId !== routeClientId.trim()) {
    return { ok: false, issue: "client_id_mismatch" };
  }
  return { ok: true };
}
