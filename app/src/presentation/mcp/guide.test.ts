import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GUIDE_SECTIONS } from "./guide.generated.ts";
import { getSetupGuide, MCP_TOOLS } from "./tools.ts";

// src/presentation/mcp -> presentation -> src -> app -> repo root
const repoRoot = dirname(dirname(dirname(dirname(import.meta.dir))));
const onboard = join(repoRoot, "skills", "devctl-onboard");
const debug = join(repoRoot, "skills", "devctl-debug");

const SOURCES: Array<[keyof typeof GUIDE_SECTIONS, string]> = [
  ["procedure", join(onboard, "SKILL.md")],
  ["authoring", join(onboard, "references", "authoring.md")],
  ["discovery", join(onboard, "references", "discovery.md")],
  ["debug", join(debug, "SKILL.md")],
];

describe("setup guide", () => {
  // get_setup_guide has to serve this text from inside a `bun build --compile`
  // binary, which is one file with no repository beside it — so the guide
  // cannot be read from skills/ at runtime and is compiled in instead. That
  // makes a second copy of the same knowledge, and copies drift. This is the
  // guard: edit skills/, run `bun run sync-guide`, and this passes again.
  test.each(SOURCES)("the embedded %s section matches its skill file", (key, file) => {
    // Line endings are normalized on the disk side because they cannot be
    // compared meaningfully: JavaScript normalizes line terminators inside
    // template literals, so on a CRLF checkout (Windows, core.autocrlf=true)
    // the embedded value is LF while the file on disk is CRLF. Content is
    // what this guards; sync-guide.ts normalizes on write for the same reason.
    // The `as string` widens GUIDE_SECTIONS' literal type: without it the
    // comparison is against a string *literal* type the size of the whole
    // guide, which no overload of toBe accepts.
    expect(GUIDE_SECTIONS[key] as string).toBe(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  });

  test("every section round-trips through the tool", () => {
    for (const [key] of SOURCES) {
      const result = getSetupGuide({ section: key }) as { section: string; text: string; sections: string[] };
      expect(result.section).toBe(key);
      expect(result.text).toBe(GUIDE_SECTIONS[key]);
      expect(result.sections).toEqual(["procedure", "authoring", "discovery", "debug"]);
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
