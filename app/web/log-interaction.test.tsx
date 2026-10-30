import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LogList } from "./components/log-list.tsx";
import { ConsoleShell } from "./components/shell.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import type { LogRow } from "./types.ts";
import { logIdentity } from "./logs.ts";

test("a large log stream renders a bounded window with an accessible selected record and explicit inspect controls", () => {
  const events: LogRow[] = Array.from({ length: 1_000 }, (_, index) => ({
    seq: index + 1,
    timestamp: "2026-10-29T14:30:00.000Z",
    service: "billing-api",
    source: "stdout",
    severityText: "INFO",
    level: "INFO",
    message: `event-${index}`,
  }));
  const html = renderToStaticMarkup(
    <LogList
      events={events}
      selectedId="seq:1"
      onSelect={() => {}}
      onInspect={() => {}}
      wrapMode="focus"
      showTimestamps
      showMeta
      follow={false}
      onPin={() => {}}
      onJumpLatest={() => {}}
      newer={0}
      onReachTop={() => {}}
    />,
  );
  expect(html).toContain("event-0");
  expect(html).not.toContain("event-999");
  const rendered = [...html.matchAll(/role="option"/g)].length;
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(40);
  const active = /aria-activedescendant="([^"]+)"/.exec(html)?.[1];
  expect(active).toBeDefined();
  expect(html).toContain(`id="${active}" role="option" aria-selected="true"`);
  expect(html).toContain("Inspect log from billing-api at");
});

test("navigation keeps accessible page names independent of visible labels and exposes its collapse control", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <ConsoleShell route="logs" project="demo" services={[]} busy={false} error="" onReload={() => {}} notice={null} update={null}>
        <p>Stream content</p>
      </ConsoleShell>
    </TooltipProvider>,
  );
  expect(html).toContain('aria-label="Collapse navigation"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('aria-label="Logs"');
  expect(html).toContain('aria-label="Configuration"');
  expect(html).toContain('aria-label="devctl overview"');
  expect(html).toContain("Stream content");
});

test("split log lists keep distinct active-descendant IDs even when both panes show the same unsequenced record", () => {
  const event: LogRow = {
    timestamp: "2026-10-29T14:30:00.000Z",
    service: "api",
    source: "stderr",
    level: "ERROR",
    severityText: "ERROR",
    message: "Upstream unavailable",
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const props = {
    events: [event],
    selectedId: logIdentity(event),
    onSelect: () => {},
    onInspect: () => {},
    wrapMode: "clip" as const,
    showTimestamps: false,
    showMeta: false,
    follow: false,
    onPin: () => {},
    onJumpLatest: () => {},
    newer: 0,
    onReachTop: () => {},
  };
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <LogList {...props} />
      <LogList {...props} />
    </TooltipProvider>,
  );
  const activeIds = [...html.matchAll(/aria-activedescendant="([^"]+)"/g)].map((match) => match[1]);
  expect(activeIds).toHaveLength(2);
  expect(new Set(activeIds).size).toBe(2);
  for (const id of activeIds) expect(html).toContain(`id="${id}" role="option" aria-selected="true"`);
  expect(html).toContain("Upstream unavailable");
  expect(html).toContain("log-event-error");
});

test("an empty filtered stream exposes its message without an invalid active descendant", () => {
  const html = renderToStaticMarkup(
    <LogList
      events={[]}
      selectedId="stale-selection"
      onSelect={() => {}}
      onInspect={() => {}}
      wrapMode="focus"
      showTimestamps
      showMeta
      follow={false}
      onPin={() => {}}
      onJumpLatest={() => {}}
      newer={0}
      onReachTop={() => {}}
      empty="No matching log records."
    />,
  );
  expect(html).toContain("No matching log records.");
  expect(html).not.toContain("aria-activedescendant");
});

test("a search marks the matching text inside the log row", () => {
  const html = renderToStaticMarkup(
    <LogList
      events={[
        {
          seq: 1,
          timestamp: "2026-10-29T14:30:00.000Z",
          service: "billing-api",
          source: "stdout",
          severityText: "INFO",
          level: "INFO",
          message: "cache miss for inv-2200",
        },
      ]}
      selectedId=""
      onSelect={() => {}}
      onInspect={() => {}}
      wrapMode="clip"
      showTimestamps
      showMeta
      follow={false}
      onPin={() => {}}
      onJumpLatest={() => {}}
      newer={0}
      onReachTop={() => {}}
      search="inv-2200"
    />,
  );
  expect(html).toContain('class="log-search-hit"');
  expect(html).toContain("inv-2200");
  expect(html).toContain("cache miss for ");
});
