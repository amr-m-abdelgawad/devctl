import { describe, expect, test } from "bun:test";
import {
  HELP_COMMANDS,
  HELP_DISPLAY,
  HELP_FOOTER_ROWS,
  HELP_NAVIGATION,
  HELP_OVERLAY_BORDER,
  HELP_SECTION_BORDER,
  HELP_SERVICES,
  helpContentHeight,
  helpIsStacked,
  helpOverlayHeight,
  helpSectionHeight,
  logBindings,
} from "./Help.tsx";

describe("help overlay layout", () => {
  test("section height keeps every binding plus the border", () => {
    expect(helpSectionHeight(5)).toBe(5 + HELP_SECTION_BORDER);
    expect(helpSectionHeight(logBindings("cmd+c").length)).toBe(15 + HELP_SECTION_BORDER);
  });

  test("wide height fits nav, full logs, commands, and footer without clipping", () => {
    const logCount = logBindings("cmd+c").length;
    const pad = 1;
    const gap = 1;
    const height = helpOverlayHeight({ stacked: false, logCount, pad, gap });
    const top = Math.max(helpSectionHeight(HELP_NAVIGATION.length), helpSectionHeight(HELP_SERVICES.length));
    const logs = helpSectionHeight(logCount);
    const bottom = Math.max(helpSectionHeight(HELP_COMMANDS.length), helpSectionHeight(HELP_DISPLAY.length));
    expect(height).toBe(HELP_OVERLAY_BORDER + pad * 2 + top + logs + bottom + HELP_FOOTER_ROWS + gap * 3);
    expect(height).toBeGreaterThan(logs);
  });

  test("stacked height is the sum of every section", () => {
    const logCount = logBindings("ctrl+c").length;
    const stacked = helpOverlayHeight({ stacked: true, logCount, pad: 0, gap: 0 });
    const wide = helpOverlayHeight({ stacked: false, logCount, pad: 0, gap: 0 });
    expect(stacked).toBeGreaterThan(wide);
    expect(helpIsStacked(50)).toBe(true);
    expect(helpIsStacked(80)).toBe(false);
  });

  test("content height reserves the full logs block", () => {
    const logCount = logBindings("cmd+c").length;
    const inner = helpContentHeight({ stacked: false, logCount, pad: 1, gap: 1 });
    expect(inner).toBeGreaterThanOrEqual(helpSectionHeight(logCount));
  });
});
