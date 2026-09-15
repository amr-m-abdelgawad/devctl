import type { HttpClientView } from "./use-http-client.ts";
import type { Screen } from "../types.ts";

export function handleHttpClientKey(opts: {
  screen: Screen;
  view: HttpClientView;
  keyName: string;
  searchChord: boolean;
  shift: boolean;
}): boolean {
  if (opts.screen !== "httpclient") {
    return false;
  }
  const { view, keyName, searchChord } = opts;
  if (view.inputField !== "") {
    if (keyName === "escape") {
      view.endEdit();
      return true;
    }
    if ((keyName === "return" || keyName === "enter") && view.inputField !== "body") {
      view.endEdit();
      return true;
    }
    return true;
  }
  if (keyName === "tab") {
    view.cyclePane(opts.shift ? -1 : 1);
    return true;
  }
  if (searchChord || keyName === "f") {
    view.beginEdit("filter");
    return true;
  }
  if (keyName === "e") {
    view.beginEdit("url");
    return true;
  }
  if (keyName === "b") {
    view.beginEdit("body");
    return true;
  }
  if (keyName === "s") {
    void view.send();
    return true;
  }
  if (keyName === "v") {
    view.cycleEnv();
    return true;
  }
  if (keyName === "m") {
    view.cycleMethod();
    return true;
  }
  if (keyName === "[" || keyName === "h") {
    if (view.pane === "response") {
      view.cycleResponseTab(-1);
    } else {
      view.cycleRequestTab(-1);
    }
    return true;
  }
  if (keyName === "]" || keyName === "l") {
    if (view.pane === "response") {
      view.cycleResponseTab(1);
    } else {
      view.cycleRequestTab(1);
    }
    return true;
  }
  if ((keyName === "j" || keyName === "k" || keyName === "down" || keyName === "up") && view.pane !== "tree") {
    return true;
  }
  return false;
}
