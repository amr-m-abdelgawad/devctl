export const VERSION = process.env.DEVCTL_VERSION ?? "0.1.0";

export function versionLine(): string {
  return `devctl ${VERSION}`;
}
