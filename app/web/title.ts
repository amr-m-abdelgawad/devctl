const PRODUCT = "devctl";

export function repoDisplayName(project: string | undefined, repoRoot: string | undefined): string {
  const named = (project ?? "").trim();
  if (named !== "") {
    return named;
  }
  const root = (repoRoot ?? "").trim().replace(/[/\\]+$/, "");
  if (root === "") {
    return "";
  }
  const parts = root.split(/[/\\]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? "";
}

export function consoleDocumentTitle(pageLabel: string, project = ""): string {
  const page = pageLabel.trim() === "" ? "Console" : pageLabel.trim();
  const name = project.trim();
  if (name === "") {
    return `${page} · ${PRODUCT}`;
  }
  return `${page} · ${name} · ${PRODUCT}`;
}
