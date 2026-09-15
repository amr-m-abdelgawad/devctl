import { describe, expect, test } from "bun:test";
import { handleHttpClientKey } from "./keyboard-httpclient.ts";
import type { HttpClientView } from "./use-http-client.ts";

function view(partial: Partial<HttpClientView> = {}): HttpClientView {
  return {
    collections: [],
    tree: [],
    error: "",
    filter: "",
    setFilter: () => {},
    pane: "tree",
    setPane: () => {},
    requestTab: "params",
    setRequestTab: () => {},
    responseTab: "body",
    setResponseTab: () => {},
    inputField: "",
    setInputField: () => {},
    env: "",
    draft: {} as HttpClientView["draft"],
    setDraft: () => {},
    result: undefined,
    sending: false,
    refresh: async () => {},
    cycleEnv: () => {},
    cycleMethod: () => {},
    send: async () => {},
    beginEdit: () => {},
    endEdit: () => {},
    cyclePane: () => {},
    cycleRequestTab: () => {},
    cycleResponseTab: () => {},
    collection: undefined,
    row: undefined,
    ...partial,
  };
}

describe("handleHttpClientKey", () => {
  test("ignores other screens and captures send on the http client", () => {
    expect(handleHttpClientKey({ screen: "logs", view: view(), keyName: "s", searchChord: false, shift: false })).toBe(false);
    let sent = false;
    const http = view({ send: async () => { sent = true; } });
    expect(handleHttpClientKey({ screen: "httpclient", view: http, keyName: "s", searchChord: false, shift: false })).toBe(true);
    expect(sent).toBe(true);
  });

  test("esc ends an in-progress edit", () => {
    let ended = false;
    const http = view({ inputField: "url", endEdit: () => { ended = true; } });
    expect(handleHttpClientKey({ screen: "httpclient", view: http, keyName: "escape", searchChord: false, shift: false })).toBe(true);
    expect(ended).toBe(true);
  });
});
