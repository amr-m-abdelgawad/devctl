import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GUIDE_SECTIONS } from "./guide.generated.ts";
import { getSetupGuide, MCP_TOOLS } from "./tools.ts";

// src/mcp -> src -> app -> repo root
const repoRoot = dirname(dirname(dirname(import.meta.dir)));
const skill = join(repoRoot, "skills", "devctl-onboard");

const SOURCES: Array<[keyof typeof GUIDE_SECTIONS, string]> = [
  ["procedure", join(skill, "SKILL.md")],
  ["authoring", join(skill, "references", "authoring.md")],
  ["discovery", join(skill, "references", "discovery.md")],
];

describe("setup guide", () => {
  // get_setup_guide has to serve this text from inside a `bun build --compile`
  // binary, which is one file with no repository beside it — so the guide
  // cannot be read from skills/ at runtime and is compiled in instead. That
  // makes a second copy of the same knowledge, and copies drift. This is the
  // guard: edit skills/, run `bun run sync-guide`, and this passes again.
  test.each(SOURCES)("the embedded %s section matches its skill file byte for byte", (key, file) => {
    // The `as string` widens GUIDE_SECTIONS' literal type: without it the
    // comparison is against a string *literal* type the size of the whole
    // guide, which no overload of toBe accepts.
    expect(GUIDE_SECTIONS[key] as string).toBe(readFileSync(file, "utf8"));
  });

  test("every section round-trips through the tool", () => {
    for (const [key] of SOURCES) {
      const result = getSetupGuide({ section: key }) as { section: string; text: string; sections: string[] };
      expect(result.section).toBe(key);
      expect(result.text).toBe(GUIDE_SECTIONS[key]);
      expect(result.sections).toEqual(["procedure", "authoring", "discovery"]);
    }
  });

  test("defaults to the procedure, including for an unknown section", () => {
    expect((getSetupGuide({}) as { section: string }).section).toBe("procedure");
    expect((getSetupGuide({ section: "nonsense" }) as { section: string }).section).toBe("procedure");
  });

  test("the declared enum matches the sections that actually exist", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_setup_guide");
    const schema = tool?.inputSchema as { properties: { section: { enum: string[] } } };
    expect(schema.properties.section.enum).toEqual(Object.keys(GUIDE_SECTIONS));
  });
});
