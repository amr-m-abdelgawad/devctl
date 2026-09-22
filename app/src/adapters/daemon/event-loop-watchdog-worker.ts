import { eventLoopStalled, watchdogTickAdvanced, WATCHDOG_TICK_MS } from "./event-loop-watchdog.ts";

let tick = 0;
let lastBeat = 0;
let lastTickAt = Date.now();

addEventListener("message", () => {
  lastBeat = tick;
});

setInterval(() => {
  const now = Date.now();
  if (watchdogTickAdvanced(now - lastTickAt)) {
    tick += 1;
  }
  lastTickAt = now;
  if (eventLoopStalled(tick - lastBeat)) {
    process.kill(process.pid, "SIGKILL");
  }
}, WATCHDOG_TICK_MS);
