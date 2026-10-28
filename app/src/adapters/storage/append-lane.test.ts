import { describe, expect, test } from "bun:test";
import { LANE_CREDIT_BYTES, LANE_MAX_BYTES, LANE_PAUSE_BYTES } from "../../domain/logs/budgets.ts";
import type { LogIngest } from "../../domain/logs/logs.ts";
import { AppendLane, type LaneItem } from "./append-lane.ts";

function event(message: string): LogIngest {
  return { service: "otlp", source: "otlp", level: "INFO", message, pid: 0 };
}

const MIB = 1024 * 1024;
const big = (i: number): LogIngest => event(`${i} ${"x".repeat(MIB - 512)}`);

function lane(accept = true): { lane: AppendLane; sent: LaneItem[][] } {
  const sent: LaneItem[][] = [];
  return {
    sent,
    lane: new AppendLane((items) => {
      sent.push(items);
      return accept;
    }),
  };
}

describe("AppendLane", () => {
  test("appends leave together, at most once a tick, with their event times", async () => {
    const { lane: appends, sent } = lane();
    for (let i = 0; i < 1_000; i += 1) {
      appends.push(event(`line ${i}`), 1_000 + i);
    }
    expect(sent).toHaveLength(0);
    await Bun.sleep(15);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((item) => item.atMs)).toEqual(Array.from({ length: 1_000 }, (_, i) => 1_000 + i));
    appends.push(event("next"), 5_000);
    await Bun.sleep(15);
    expect(sent).toHaveLength(2);
  });

  test("stops at the credit window until the worker acks, then sends the rest in order", async () => {
    const { lane: appends, sent } = lane();
    for (let i = 0; i < 8; i += 1) {
      appends.push(big(i), i);
    }
    await Bun.sleep(15);
    const sentIds = (): number[] => sent.flat().map((item) => item.id);
    expect(sentIds()).toEqual([1, 2, 3, 4]);
    expect(sent.flat().length * MIB).toBeLessThanOrEqual(LANE_CREDIT_BYTES);
    appends.ack(2);
    await Bun.sleep(15);
    expect(sentIds()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("an acked append is let go at once, not when the lane next compacts", async () => {
    // Nothing here keeps what was sent, as the worker's side does not.
    const appends = new AppendLane(() => true);
    const refs: WeakRef<LogIngest>[] = [];
    for (let i = 0; i < 200; i += 1) {
      const sentEvent = event(`line ${i} ${"x".repeat(2_000)}`);
      refs.push(new WeakRef(sentEvent));
      appends.push(sentEvent, i);
    }
    await Bun.sleep(15);
    appends.ack(200);
    expect(appends.heldCount()).toBe(0);
    // A WeakRef made in this turn keeps its target until the turn ends.
    await Bun.sleep(0);
    Bun.gc(true);
    await Bun.sleep(0);
    Bun.gc(true);
    const alive = refs.filter((ref) => ref.deref() !== undefined).length;
    // The collector may still see one or two on the stack; the lane held all 200 until its next compaction.
    expect(alive).toBeLessThan(20);
  });

  test("hands over exactly the unacked appends, oldest first", async () => {
    const { lane: appends } = lane();
    for (let i = 1; i <= 5; i += 1) {
      appends.push(event(`e${i}`), 100 * i);
    }
    await Bun.sleep(15);
    appends.ack(3);
    const unacked = appends.takeUnacked();
    expect(unacked.map((item) => [item.id, item.atMs, item.event.message])).toEqual([[4, 400, "e4"], [5, 500, "e5"]]);
    expect(appends.heldCount()).toBe(0);
  });

  test("a restarted worker gets every unacked append again", async () => {
    const { lane: appends, sent } = lane();
    appends.push(event("a"), 1);
    appends.push(event("b"), 2);
    await Bun.sleep(15);
    appends.ack(1);
    appends.resend();
    await Bun.sleep(15);
    expect(sent.map((batch) => batch.map((item) => item.event.message))).toEqual([["a", "b"], ["b"]]);
  });

  test("sendAll posts everything at once, past the credit window", () => {
    const { lane: appends, sent } = lane();
    for (let i = 0; i < 8; i += 1) {
      appends.push(big(i), i);
    }
    appends.sendAll();
    expect(sent.flat().map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("a backed-up lane asks producers to wait, and past its cap counts what it turns away", () => {
    // Sends fail, as they would to a worker that stopped taking them.
    const { lane: appends } = lane(false);
    let pushed = 0;
    while (!appends.backlogged()) {
      appends.push(big(pushed), pushed);
      pushed += 1;
    }
    expect(pushed * MIB).toBeGreaterThanOrEqual(LANE_PAUSE_BYTES);
    for (let i = 0; i < LANE_MAX_BYTES / MIB; i += 1) {
      appends.push(big(pushed + i), pushed + i);
    }
    expect(appends.heldCount() * MIB).toBeLessThanOrEqual(LANE_MAX_BYTES);
    expect(appends.lost).toBeGreaterThan(0);
    expect(appends.heldCount() + appends.lost).toBe(pushed + LANE_MAX_BYTES / MIB);
  });
});
