import { VERSION } from "./version.ts";

const RELEASES_URL = "https://api.github.com/repos/amr-m-abdelgawad/devctl/releases/latest";
const INSTALL_HINT =
  "brew install --formula https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/homebrew/devctl.rb  # or download the GitHub Release binary — see docs/installation.md";

export type UpdateCheck = {
  current: string;
  latest: string;
  newer: boolean;
  hint: string;
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function checkUpdate(fetchFn: FetchLike = fetch): Promise<UpdateCheck> {
  try {
    const resp = await fetchFn(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!resp.ok) {
      return { current: VERSION, latest: "", newer: false, hint: INSTALL_HINT };
    }
    const body = (await resp.json()) as { tag_name?: string };
    const latest = (body.tag_name ?? "").replace(/^v/, "");
    return {
      current: VERSION,
      latest,
      newer: latest !== "" && compareSemver(latest, VERSION) > 0,
      hint: INSTALL_HINT,
    };
  } catch {
    return { current: VERSION, latest: "", newer: false, hint: INSTALL_HINT };
  }
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function parseSemver(value: string): number[] {
  return value
    .replace(/^v/, "")
    .split(".")
    .slice(0, 3)
    .map((part) => {
      const n = Number.parseInt(part.replace(/[^0-9].*$/, ""), 10);
      return Number.isFinite(n) ? n : 0;
    });
}
