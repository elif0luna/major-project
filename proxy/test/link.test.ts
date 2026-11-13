import test from "node:test";
import assert from "node:assert/strict";
import { IDEAL, Link, validateDirection, type DirectionConfig } from "../src/link";
import { Pipe, streamKeyOf } from "../src/pipe";

const cfg = (c: Partial<DirectionConfig>): DirectionConfig => ({ ...IDEAL, ...c });

// Feed `n` messages arriving every `gapMs` and return their send times (null = dropped).
function run(link: Link, n: number, gapMs = 1, key = "input") {
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) out.push(link.schedule(i * gapMs, key));
  return out;
}

test("ideal link forwards immediately and drops nothing", () => {
  const out = run(new Link(IDEAL), 1000);
  out.forEach((at, i) => assert.equal(at, i));
});

test("FIFO: heavy jitter never reorders messages", () => {
  // jitter (40 ms) far larger than the 1 ms gap between messages: unconstrained it would reorder constantly
  const out = run(new Link(cfg({ delayMs: 50, jitterMs: 40, seed: 7 })), 10_000).filter((x): x is number => x !== null);
  for (let i = 1; i < out.length; i++) assert.ok(out[i]! >= out[i - 1]!, `message ${i} overtook ${i - 1}`);
});

test("same seed gives identical drops and delays; a different seed does not", () => {
  const c = cfg({ delayMs: 80, jitterMs: 15, loss: 0.1, seed: 12345 });
  const a = run(new Link(c), 2000);
  const b = run(new Link(c), 2000);
  const other = run(new Link({ ...c, seed: 999 }), 2000);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, other);
});

test("setConfig restarts the random stream from the seed", () => {
  const c = cfg({ delayMs: 30, jitterMs: 10, loss: 0.2, seed: 42 });
  const link = new Link(c);
  const first = run(link, 500);
  link.setConfig(c);
  link.resetQueue();
  assert.deepEqual(run(link, 500), first);
});

test("loss rate matches the configured probability", () => {
  const link = new Link(cfg({ loss: 0.1, seed: 3 }));
  const out = run(link, 50_000);
  const rate = out.filter((x) => x === null).length / out.length;
  assert.ok(Math.abs(rate - 0.1) < 0.006, `drop rate ${rate}`);
  assert.equal(link.stats.dropped, out.filter((x) => x === null).length);
});

test("sampled delay has the configured mean and standard deviation", () => {
  const link = new Link(cfg({ delayMs: 100, jitterMs: 10, seed: 11 }));
  run(link, 50_000, 50); // 50 ms gaps: FIFO waits are rare, but we check the drawn delay anyway
  const s = link.stats.drawnDelay;
  assert.ok(Math.abs(s.mean - 100) < 0.3, `mean ${s.mean}`);
  assert.ok(Math.abs(s.sd - 10) < 0.3, `sd ${s.sd}`);
});

test("delay never goes negative even when jitter exceeds the base delay", () => {
  const link = new Link(cfg({ delayMs: 5, jitterMs: 50, seed: 5 }));
  for (let i = 0; i < 5000; i++) {
    const at = link.schedule(i * 100);
    assert.ok(at === null || at >= i * 100);
  }
});

test("a config change affects only messages that arrive after it", () => {
  const link = new Link(cfg({ delayMs: 200 }));
  const before = link.schedule(0, "input");
  link.setConfig(cfg({ delayMs: 0 }));
  const after = link.schedule(10, "input");
  assert.equal(before, 200); // already scheduled: keeps the old delay
  assert.equal(after, 200);  // new delay 0, but FIFO keeps it behind the earlier message
  assert.equal(link.schedule(500, "input"), 500);
});

test("streams per message type: interleaved pings do not change the fate of inputs", () => {
  const c = cfg({ delayMs: 40, jitterMs: 10, loss: 0.2, seed: 77 });
  const plain = new Link(c);
  const mixed = new Link(c);
  const inputsPlain: (number | null)[] = [];
  const inputsMixed: (number | null)[] = [];
  for (let i = 0; i < 300; i++) {
    inputsPlain.push(plain.schedule(i * 33, "input") === null ? null : 1);
    if (i % 7 === 0) mixed.schedule(i * 33 - 1, "ping");
    inputsMixed.push(mixed.schedule(i * 33, "input") === null ? null : 1);
  }
  assert.deepEqual(inputsMixed, inputsPlain);
});

test("validateDirection rejects bad configs", () => {
  assert.equal(validateDirection(cfg({ delayMs: 10, jitterMs: 2, loss: 0.5, seed: 9 })), null);
  assert.ok(validateDirection(cfg({ delayMs: -1 })));
  assert.ok(validateDirection(cfg({ loss: 1.5 })));
  assert.ok(validateDirection(cfg({ jitterMs: Number.NaN })));
  assert.ok(validateDirection(cfg({ seed: 1.5 })));
  assert.ok(validateDirection(null));
});

test("streamKeyOf reads the message type", () => {
  assert.equal(streamKeyOf('{"t":"input","seq":1}'), "input");
  assert.equal(streamKeyOf('{"t":"snapshot","tick":3}'), "snapshot");
  assert.equal(streamKeyOf("not json"), "");
});

test("Pipe delivers in order with real timers, minus dropped messages", async () => {
  const link = new Link(cfg({ delayMs: 15, jitterMs: 10, loss: 0.2, seed: 21 }));
  const got: string[] = [];
  const pipe = new Pipe(link, (d) => got.push(d));
  const sent: string[] = [];
  for (let i = 0; i < 100; i++) {
    const msg = `{"t":"input","seq":${i}}`;
    sent.push(msg);
    pipe.push(msg);
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(pipe.pending, 0);
  assert.equal(got.length, link.stats.scheduled);
  const order = got.map((m) => sent.indexOf(m));
  for (let i = 1; i < order.length; i++) assert.ok(order[i]! > order[i - 1]!);
  assert.ok(got.length < 100 && got.length > 60, `${got.length} delivered`);
});
