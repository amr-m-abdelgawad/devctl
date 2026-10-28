import { expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { Controller } from "../../../application/client-runtime.ts";
import { LLM_OPERATION_CHAT, LLM_STATUS_OK, type LlmCall } from "../../../domain/llm/llm.ts";
import { TRAFFIC_TRANSPORT_HTTP, type TrafficCall } from "../../../domain/traffic/traffic.ts";
import { useLlmView } from "./use-llm-view.ts";
import { useTrafficView } from "./use-traffic-view.ts";

async function mountHook<P, T>(hook: (props: P) => T, initial: P) {
  let current: T;
  function Harness() {
    const [props] = useState(initial);
    current = hook(props);
    return null;
  }
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(createElement(Harness), { width: 40, height: 5 });
  });
  return {
    get value() {
      return current!;
    },
    async close() {
      await act(async () => setup.renderer.destroy());
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function llmRow(id: string, seq: number, full = false): LlmCall {
  return {
    seq,
    id,
    source: "proxy",
    sourceType: "proxy",
    timestamp: `2026-01-01T00:00:0${seq}.000Z`,
    status: LLM_STATUS_OK,
    model: "gpt-4o",
    operation: LLM_OPERATION_CHAT,
    attributes: full ? {} : { body: "omitted" },
    request: full ? { prompt: `full ${id} v${seq}` } : undefined,
  };
}

function llmController(rows: () => LlmCall[], getLlmCall: (id: string) => Promise<LlmCall | undefined>, pages: unknown[]): Controller {
  const controller = {
    llmCallsPage: async (req: unknown) => {
      pages.push(req);
      return { calls: rows(), nextCursor: "", hasNext: false, errors: [] };
    },
    getLlmCall,
  };
  return controller as unknown as Controller;
}

test("the llm view lists summaries and fetches only the selected call in full", async () => {
  const rows = [llmRow("b", 2), llmRow("a", 1)];
  const pages: unknown[] = [];
  const fetched: string[] = [];
  const controller = llmController(() => rows, async (id) => {
    fetched.push(id);
    return llmRow(id, rows.find((row) => row.id === id)?.seq ?? 0, true);
  }, pages);
  const mounted = await mountHook(useLlmView, { controller, screen: "llm" as const });
  try {
    await act(async () => {});
    expect(pages[0]).toMatchObject({ summary: true });
    expect(fetched).toEqual(["b"]);
    expect(mounted.value.page.calls[0]?.request).toEqual({ prompt: "full b v2" });
    expect(mounted.value.page.calls[1]?.request).toBeUndefined();
    await act(async () => mounted.value.pick(1));
    expect(fetched).toEqual(["b", "a"]);
    expect(mounted.value.page.calls[1]?.request).toEqual({ prompt: "full a v1" });
    expect(mounted.value.page.calls[0]?.request).toBeUndefined();
  } finally {
    await mounted.close();
  }
});

test("a late answer for an earlier selection is ignored, and an open overlay picks up the full call", async () => {
  const rows = [llmRow("b", 2), llmRow("a", 1)];
  const answers = new Map<string, ReturnType<typeof deferred<LlmCall | undefined>>>();
  const controller = llmController(() => rows, (id) => {
    const answer = deferred<LlmCall | undefined>();
    answers.set(id, answer);
    return answer.promise;
  }, []);
  const mounted = await mountHook(useLlmView, { controller, screen: "llm" as const });
  try {
    await act(async () => {});
    await act(async () => mounted.value.pick(1));
    await act(async () => mounted.value.setDetail(mounted.value.page.calls[1]));
    expect(mounted.value.detail?.request).toBeUndefined();
    await act(async () => answers.get("a")?.resolve(llmRow("a", 1, true)));
    expect(mounted.value.detail?.request).toEqual({ prompt: "full a v1" });
    await act(async () => answers.get("b")?.resolve(llmRow("b", 2, true)));
    expect(mounted.value.page.calls[0]?.request).toBeUndefined();
    expect(mounted.value.page.calls[1]?.request).toEqual({ prompt: "full a v1" });
  } finally {
    await mounted.close();
  }
});

test("a newer version of the selected call is refetched while the older one stays shown", async () => {
  let rows = [llmRow("b", 2)];
  const answers: Array<ReturnType<typeof deferred<LlmCall | undefined>>> = [];
  const controller = llmController(() => rows, () => {
    const answer = deferred<LlmCall | undefined>();
    answers.push(answer);
    return answer.promise;
  }, []);
  const mounted = await mountHook(useLlmView, { controller, screen: "llm" as const });
  try {
    await act(async () => {});
    await act(async () => answers[0]?.resolve(llmRow("b", 2, true)));
    rows = [llmRow("b", 3)];
    await act(async () => mounted.value.refresh());
    expect(answers).toHaveLength(2);
    expect(mounted.value.page.calls[0]?.request).toEqual({ prompt: "full b v2" });
    await act(async () => answers[1]?.resolve(llmRow("b", 3, true)));
    expect(mounted.value.page.calls[0]?.request).toEqual({ prompt: "full b v3" });
  } finally {
    await mounted.close();
  }
});

test("the traffic view lists summaries and fetches the selected hop in full", async () => {
  const hop = (full: boolean): TrafficCall => ({
    seq: 1,
    id: "h1",
    timestamp: "2026-01-01T00:00:01.000Z",
    method: "POST",
    path: "/v1",
    route: "api",
    transport: TRAFFIC_TRANSPORT_HTTP,
    status: 200,
    attributes: {},
    request: full ? { encoding: "utf8", text: '{"id":1}' } : { omitted: true },
  });
  const pages: unknown[] = [];
  const controller = {
    trafficCallsPage: async (req: unknown) => {
      pages.push(req);
      return { calls: [hop(false)], nextCursor: "", hasNext: false };
    },
    getTrafficCall: async () => hop(true),
  } as unknown as Controller;
  const mounted = await mountHook(useTrafficView, { controller, screen: "proxy" as const });
  try {
    await act(async () => {});
    expect(pages[0]).toMatchObject({ summary: true });
    expect(mounted.value.page.calls[0]?.request?.text).toBe('{"id":1}');
  } finally {
    await mounted.close();
  }
});
