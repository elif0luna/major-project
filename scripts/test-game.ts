// Deterministic unit tests for Phases 1, 3 (server side) and 5 -- no network involved.
import assert from "node:assert/strict";
import { Game } from "../server/game";
import { MAX_INPUT_QUEUE, MAX_SPEED, TAG_PRESSED, TICK_RATE } from "../shared/protocol";

const bx = (k: number) => 300 + k * (10 / 3); // B moves right at 200 u/s (10/3 units per tick)

/** Run to tick T-1 (B follows bx), send one tag from A with viewTick, process tick T. */
function scenario(o: { lagComp: boolean; T: number; viewTick: number; rtt?: number; extraTags?: number }) {
  const g = new Game({ lagComp: o.lagComp });
  g.addPlayer("A"); g.addPlayer("B");
  g.debugSetPosition("A", 400, 300);
  g.addRttSample("A", o.rtt ?? 60);
  for (let k = 1; k < o.T; k++) { g.debugSetPosition("B", bx(k), 300); g.tick(); }
  const res = g.handleInput("A", { type: "input", seq: 1, clientTime: 1, dx: 0, dy: 0, inputBits: TAG_PRESSED, viewTick: o.viewTick });
  assert.equal(res, "ok");
  g.debugSetPosition("B", bx(o.T), 300);
  g.tick();
  return { g, log: g.hitLog[g.hitLog.length - 1] };
}

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("  ok -", name); };

t("compensation ON: honest tag on a moving target is accepted (rewound ~167 ms)", () => {
  const { log } = scenario({ lagComp: true, T: 46, viewTick: 36 });
  assert.equal(log.accepted, true);
  assert.ok(Math.abs(log.rewindMs - (10 * 1000) / TICK_RATE) < 1);
});

t("compensation OFF: the same tag misses (target already moved 53 units away)", () => {
  const { log } = scenario({ lagComp: false, T: 46, viewTick: 36 });
  assert.equal(log.accepted, false);
  assert.ok(log.hitDist > 30);
});

t("cheater claims an old viewTick: rewind is CLAMPED to 200 ms and the tag is rejected", () => {
  const { log } = scenario({ lagComp: true, T: 60, viewTick: 30 });
  assert.equal(log.rewindMs, 200);
  assert.ok(log.requestedRewindMs > 400);
  assert.equal(log.accepted, false);
});

t("cheater claims a future viewTick: rejected (bad_view)", () => {
  const { log } = scenario({ lagComp: true, T: 46, viewTick: 46 });
  assert.equal(log.reason, "bad_view");
});

t("very high RTT disables compensation (rewind 0)", () => {
  const { log } = scenario({ lagComp: true, T: 46, viewTick: 36, rtt: 400 });
  assert.equal(log.rewindMs, 0);
});

t("tag spam: second tag inside the cooldown is rejected", () => {
  const { g } = scenario({ lagComp: true, T: 46, viewTick: 36 });
  g.handleInput("A", { type: "input", seq: 2, clientTime: 2, dx: 0, dy: 0, inputBits: TAG_PRESSED, viewTick: 40 });
  g.tick();
  assert.equal(g.hitLog[g.hitLog.length - 1].reason, "cooldown");
});

t("replayed / out-of-order seq and backwards clientTime are dropped", () => {
  const g = new Game({ lagComp: true }); g.addPlayer("A");
  const m = (seq: number, clientTime: number) => ({ type: "input", seq, clientTime, dx: 0, dy: 0, inputBits: 0, viewTick: 0 });
  assert.equal(g.handleInput("A", m(5, 10)), "ok");
  assert.equal(g.handleInput("A", m(5, 11)), "stale_seq");
  assert.equal(g.handleInput("A", m(4, 12)), "stale_seq");
  assert.equal(g.handleInput("A", m(6, 9)), "time_backwards");
});

t("Infinity / NaN / wrong types are rejected and never corrupt state", () => {
  const g = new Game({ lagComp: true }); g.addPlayer("A");
  const evil = JSON.parse('{"type":"input","seq":1,"clientTime":1,"dx":1e999,"dy":0,"inputBits":0,"viewTick":0}');
  assert.equal(g.handleInput("A", evil), "bad_axis");
  assert.equal(g.handleInput("A", { type: "input", seq: 1, clientTime: 1, dx: "1", dy: 0, inputBits: 0, viewTick: 0 }), "bad_axis");
  g.tick();
  const p = g.players.get("A")!;
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

t("huge dx is clamped: (100000,0) moves at exactly MAX_SPEED", () => {
  const g = new Game({ lagComp: true }); g.addPlayer("A");
  g.handleInput("A", { type: "input", seq: 1, clientTime: 1, dx: 100000, dy: 0, inputBits: 0, viewTick: 0 });
  const x0 = g.players.get("A")!.x; g.tick();
  assert.ok(Math.abs(g.players.get("A")!.x - x0 - MAX_SPEED / TICK_RATE) < 1e-9);
});

t("input flooding: queue is bounded and only ONE step happens per tick", () => {
  const g = new Game({ lagComp: true }); g.addPlayer("A");
  for (let s = 1; s <= 100; s++) g.handleInput("A", { type: "input", seq: s, clientTime: s, dx: 1, dy: 0, inputBits: 0, viewTick: 0 });
  assert.ok(g.players.get("A")!.queue.length <= MAX_INPUT_QUEUE);
  const x0 = g.players.get("A")!.x; g.tick();
  assert.ok(Math.abs(g.players.get("A")!.x - x0 - MAX_SPEED / TICK_RATE) < 1e-9);
});

console.log(`${n} game tests passed`);
