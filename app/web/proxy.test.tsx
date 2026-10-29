import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultConfig, emptyRouteAuth } from "../src/domain/config/types.ts";
import { getConfigSummary } from "../src/presentation/mcp/tools.ts";
import { ProxyPage } from "./pages/proxy.tsx";
import type { ConfigSummary } from "./types.ts";

test("proxy routes render the real API host/path match object", () => {
  const cfg = defaultConfig();
  const route = {
    name: "billing",
    match: { host: "billing.localhost", path: "/v1/" },
    upstream: { url: "http://127.0.0.1:9000", service: "", port: "" },
    auth: emptyRouteAuth(),
  };
  cfg.proxy.routes = [route];
  const config = getConfigSummary(cfg) as ConfigSummary;
  const html = renderToStaticMarkup(<ProxyPage config={config} busy={false} onControl={() => {}} />);
  expect(html).toContain("billing.localhost/v1/");
  expect(html).not.toContain("[object Object]");
});
