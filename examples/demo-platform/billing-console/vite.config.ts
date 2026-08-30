import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.SERVICE_PORT || 18003),
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.API_URL || "http://127.0.0.1:18000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/auth": {
        target: process.env.AUTH_URL || "http://127.0.0.1:18001",
        rewrite: (path) => path.replace(/^\/auth/, ""),
      },
    },
  },
});
