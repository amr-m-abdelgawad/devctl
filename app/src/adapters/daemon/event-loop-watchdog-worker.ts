import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { connect } from "node:net";
import { eventLoopStalled, watchdogTickAdvanced, WATCHDOG_TICK_MS } from "./event-loop-watchdog.ts";
import { WEDGE_STALL_TICKS } from "../../domain/daemon/liveness.ts";
import { wedgePath, writeHeartbeatAtomic, type HeartbeatFile } from "./heartbeat.ts";
import { readLockFile, releaseLockFile } from "../storage/lock.ts";
import { lockPath } from "../storage/storage.ts";

type Beat = {
  type: "beat" | "listening";
  repoRoot?: string;
  session?: string;
  identity?: string;
  socket?: string;
  token?: string;
};

let tick = 0;
let lastBeat = 0;
let lastTickAt = Date.now();
let listening = false;
let rpcOkAge = 0;
let repoRoot = "";
let session = "";
let identity = "";
let socketPath = "";
let token = "";

addEventListener("message", (event: MessageEvent<Beat>) => {
  const data = event.data;
  if (data.type === "listening") {
    listening = true;
  }
  lastBeat = tick;
  if (typeof data.repoRoot === "string" && data.repoRoot !== "") {
    repoRoot = data.repoRoot;
  }
  if (typeof data.session === "string") {
    session = data.session;
  }
  if (typeof data.identity === "string") {
    identity = data.identity;
  }
  if (typeof data.socket === "string") {
    socketPath = data.socket;
  }
  if (typeof data.token === "string") {
    token = data.token;
  }
});

setInterval(() => {
  const now = Date.now();
  if (watchdogTickAdvanced(now - lastTickAt)) {
    tick += 1;
  }
  lastTickAt = now;
  const mainStallTicks = tick - lastBeat;
  if (listening) {
    void probeRpc().then((ok) => {
      rpcOkAge = ok ? 0 : rpcOkAge + 1;
      publish(mainStallTicks);
      if (eventLoopStalled(mainStallTicks, WEDGE_STALL_TICKS) && rpcOkAge >= WEDGE_STALL_TICKS) {
        markWedge(repoRoot);
        process.kill(process.pid, "SIGKILL");
      }
    });
    return;
  }
  publish(mainStallTicks);
}, WATCHDOG_TICK_MS);

function publish(mainStallTicks: number): void {
  if (repoRoot === "") {
    return;
  }
  const beat: HeartbeatFile = {
    pid: process.pid,
    identity,
    session,
    workerTick: tick,
    mainStallTicks,
    rpcOkAgeTicks: listening ? rpcOkAge : 0,
    degraded: false,
    writtenAtMs: Date.now(),
  };
  try {
    writeHeartbeatAtomic(repoRoot, beat);
  } catch {
    // a full disk must not kill the daemon from the watchdog
  }
}

function markWedge(root: string): void {
  if (root === "") {
    return;
  }
  try {
    const path = wedgePath(root);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, { mode: 0o600 });
    const lock = readLockFile(lockPath(root));
    if (lock?.pid === process.pid && lock.nonce) {
      releaseLockFile(lockPath(root), lock.nonce);
    }
  } catch {
    // still kill; a leftover lock is reclaimed by the next start
  }
}

function probeRpc(): Promise<boolean> {
  if (socketPath === "" || token === "") {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let buf = "";
    const finish = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 200);
    socket.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ auth: token, id: "wd", method: "ping" })}\n`);
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) {
        clearTimeout(timer);
        finish(buf.includes("session") && !buf.includes("\"error\""));
      }
    });
  });
}
