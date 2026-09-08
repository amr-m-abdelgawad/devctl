

export function googleProjectDisplay(
  cfg?: { google?: { project_id?: string } },
  identity?: { project?: string; project_source?: string },
  google?: { projectID?: string; projectSource?: string },
): { project: string; source: string } {
  const configured = cfg?.google?.project_id ?? "";
  if (configured !== "") {
    return { project: configured, source: "configuration" };
  }
  const detected = identity?.project || google?.projectID || "";
  const source = identity?.project_source || google?.projectSource || "";
  return { project: detected, source };
}
