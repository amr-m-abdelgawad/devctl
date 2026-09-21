import { KindAuthorization, KindConfiguration, hintError, newError, wrapError } from "../../shared/errors.ts";

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

export function secretManagerFetcher(getAccessToken: () => Promise<string>): (resource: string) => Promise<string> {
  return async (resource: string): Promise<string> => {
    const versioned = resource.includes("/versions/") ? resource : `${resource}/versions/latest`;
    const token = await getAccessToken();
    const res = await fetch(`https://secretmanager.googleapis.com/v1/${versioned}:access`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN) {
      throw hintError(
        KindAuthorization,
        `secret manager request failed for ${resource}: HTTP ${res.status}`,
        "verify Secret Manager IAM, or rely on dotenv / .devctl/secrets.env when you do not have access",
      );
    }
    if (!res.ok) {
      throw newError(KindConfiguration, `secret manager request failed for ${resource}: HTTP ${res.status}`);
    }
    let body: { payload?: { data?: string } };
    try {
      body = (await res.json()) as { payload?: { data?: string } };
    } catch (err) {
      throw wrapError(KindConfiguration, `secret manager response for ${resource} was not JSON`, err);
    }
    if (!body.payload?.data) {
      throw newError(KindConfiguration, `secret manager response for ${resource} had no payload`);
    }
    return Buffer.from(body.payload.data, "base64").toString("utf8");
  };
}
