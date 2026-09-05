import { KindConfiguration, newError } from "../../shared/errors.ts";

export function secretManagerFetcher(getAccessToken: () => Promise<string>): (resource: string) => Promise<string> {
  return async (resource: string): Promise<string> => {
    const versioned = resource.includes("/versions/") ? resource : `${resource}/versions/latest`;
    const token = await getAccessToken();
    const res = await fetch(`https://secretmanager.googleapis.com/v1/${versioned}:access`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw newError(KindConfiguration, `secret manager request failed for ${resource}: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { payload?: { data?: string } };
    if (!body.payload?.data) {
      throw newError(KindConfiguration, `secret manager response for ${resource} had no payload`);
    }
    return Buffer.from(body.payload.data, "base64").toString("utf8");
  };
}
