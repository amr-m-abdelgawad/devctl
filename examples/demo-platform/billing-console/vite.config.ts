import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function hubOrDirect(logicalUrl: string, fallback: string): Pick<ProxyOptions, "target" | "configure"> {
  const raw = logicalUrl || fallback;
  const parsed = new URL(raw);
  const proxyUrl = process.env.DEVCTL_PROXY_URL ?? "";
  if (proxyUrl !== "" && parsed.hostname.endsWith(".local")) {
    return {
      target: proxyUrl,
      configure(proxy) {
        proxy.on("proxyReq", (proxyReq) => {
          proxyReq.setHeader("Host", parsed.hostname);
          const name = process.env.DEVCTL_SERVICE_NAME;
          if (name) {
            proxyReq.setHeader("X-Devctl-Service", name);
          }
        });
      },
    };
  }
  return { target: raw };
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.SERVICE_PORT || 18003),
    strictPort: true,
    proxy: {
      "/api": {
        ...hubOrDirect(process.env.API_URL ?? "", "http://127.0.0.1:18000"),
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/auth": {
        ...hubOrDirect(process.env.AUTH_URL ?? "", "http://127.0.0.1:18001"),
        rewrite: (path) => path.replace(/^\/auth/, ""),
      },
    },
  },
});
