import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
if (!existsSync(`${root}/node_modules/vite`)) {
  console.log("INFO billing-console installing dependencies");
  const install = Bun.spawn(["bun", "install"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await install.exited) !== 0) {
    process.exit(1);
  }
}

const port = process.env.SERVICE_PORT || "18003";
const vite = Bun.spawn(["bunx", "--bun", "vite", "--host", "127.0.0.1", "--port", port, "--strictPort"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
process.exit(await vite.exited);
