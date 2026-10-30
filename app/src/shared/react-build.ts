import { createRequire } from "node:module";

type Env = Record<string, string | undefined>;

/**
 * Loads React's production build for this process, and returns the function
 * that puts the environment back. Call that before anything can start a
 * process: services inherit this environment, and their NODE_ENV is theirs.
 * A NODE_ENV already set is left alone, so `NODE_ENV=development` still gives
 * React's warnings.
 *
 * React chooses its build when it loads, from NODE_ENV. Releases fix it at
 * build time; a run from source has to set it here. The development build
 * records a performance entry for each render it times, with the changed
 * props in it: once the TUI held 50,000 log records, that kept it at a full
 * core and gigabytes of memory.
 *
 * Bun transpiled this run's JSX for development, to `jsxDEV`, before any of
 * this ran, and React's production dev-runtime has no `jsxDEV`. It gets one
 * here, on the production `jsx` and `jsxs`.
 */
export function loadProductionReact(env: Env = process.env): () => void {
  // In a release the build replaces this literal, so this always returns: it
  // has React's production build and no source tree to require from.
  if (process.env.NODE_ENV === "production" || env.NODE_ENV !== undefined) {
    return () => undefined;
  }
  env.NODE_ENV = "production";
  // By require: an import would fix the module's named exports before jsxDEV is set.
  const require = createRequire(import.meta.url);
  const devRuntime = require("react/jsx-dev-runtime") as { jsxDEV?: unknown };
  const { jsx, jsxs } = require("react/jsx-runtime") as typeof import("react/jsx-runtime");
  devRuntime.jsxDEV ??= (type: Parameters<typeof jsx>[0], props: Parameters<typeof jsx>[1], key: string | undefined, isStaticChildren: boolean) =>
    (isStaticChildren ? jsxs : jsx)(type, props, key);
  return () => {
    delete env.NODE_ENV;
  };
}
