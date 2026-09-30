// End-to-end check of Phases 1-4 over real WebSockets on localhost (headless clients, no browser).
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { performance } from "node:perf_hooks";
import { startServer } from "../server/server";
import { GameClient } from "../client/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LAG = 30; // fake one-way delay => ~60 ms RTT
const srv = startServer(8099, { lagComp: true });
const mk = () => new GameClient({ url: "ws://localhost:8099", WS: WebSocket as any, now: () => performance.now(), fakeLagMs: LAG });

const a = mk(), b = mk();
a.connect(); b.connect();
let moveA = { dx: 1, dy: 0 }, moveB = { dx: 0, dy: 0 };
a.startInputLoop(() => ({ ...moveA, tag: false }));
b.startInputLoop(() => ({ ...moveB, tag: false }));

await sleep(1500);
assert.ok(a.ready && b.ready, "both players connected (Phase 1)");
assert.equal(new Set([a.playerId, b.playerId]).size, 2);

// PHASE 2: server-measured RTT (server's clock only) and client-side offset estimate
const rttSrv = srv.game.players.get(a.playerId)!.smoothedRtt!;
console.log(`  server-measured RTT: ${rttSrv.toFixed(1)} ms | client four-timestamp RTT: ${a.clock.rtt.toFixed(1)} ms`);
assert.ok(rttSrv > 55 && rttSrv < 100, "server RTT ~ 2*LAG");
assert.ok(Math.abs(a.clock.rtt - rttSrv) < 30, "client and server RTT agree");

// PHASE 3: prediction + reconciliation
const x0 = a.local.x;
await sleep(1500);
assert.ok(a.local.x - x0 > 250, "predicted movement ~200 u/s");
const maxCorr = Math.max(...a.corrections.slice(-60));
console.log(`  max correction while moving: ${maxCorr.toFixed(2)} units`);
assert.ok(maxCorr < 15, "reconciliation corrections stay small");
moveA = { dx: 0, dy: 0 };
await sleep(800);
const serverA = srv.game.players.get(a.playerId)!;
assert.ok(Math.hypot(a.local.x - serverA.x, a.local.y - serverA.y) < 1, "prediction converges to the server");

// PHASE 4: interpolation. Opponent is drawn behind the server position by ~ downstream + 100 ms.
moveB = { dx: 1, dy: 0 };
await sleep(600);
const rend = a.opponentRendered()!;
const serverB = srv.game.players.get(b.playerId)!;
const gap = serverB.x - rend.x;
console.log(`  opponent rendered ${gap.toFixed(1)} units behind the server (~${(gap / 200 * 1000).toFixed(0)} ms)`);
assert.ok(gap > 15 && gap < 60, "opponent rendered ~100 ms + latency in the past");

a.close(); b.close(); srv.close();
console.log("smoke test passed");
process.exit(0);
