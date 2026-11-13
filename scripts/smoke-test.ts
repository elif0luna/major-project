// End-to-end check against a RUNNING server (fresh start recommended):
//   terminal 1: pnpm dev:server      terminal 2: pnpm smoke
// Uses Node's built-in global WebSocket (Node 22+), so it needs no dependencies.
import {
  INPUT_FIRE, PLAYER_SPEED, SERVER_PORT, TICK_DT, TICK_MS,
  decode, encode,
  type ClientMessage, type GameEvent, type PlayerSnap, type ServerMessage, type ServerSnapshot,
} from "../shared/src/index";

declare const process: { env: Record<string, string | undefined>; exitCode?: number; exit(code: number): never };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = Number(process.env.PORT ?? SERVER_PORT);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`);
  if (!ok) failures++;
}

// Without this, an unreachable server leaves the open() promise pending, the event
// loop drains, and the script exits 0 having printed nothing.
setTimeout(() => {
  console.error(`FAIL  timed out (is the server running on ws://localhost:${port}?)`);
  process.exit(1);
}, 30_000);

class Bot {
  ws = new WebSocket(`ws://localhost:${port}`);
  id = 0;
  seq = 0;
  latest: ServerSnapshot | null = null;
  snapshots = 0;
  pongs = 0;
  offset = 0;
  rtt = 0;
  shots: Extract<GameEvent, { kind: "shot" }>[] = [];

  constructor() {
    this.ws.addEventListener("message", (e) => {
      const m = decode<ServerMessage>(String(e.data));
      if (!m) return;
      if (m.t === "welcome") this.id = m.id;
      else if (m.t === "pong") {
        const t3 = performance.now();
        this.pongs++;
        this.rtt = t3 - m.clientTime;
        this.offset = m.serverTime - (m.clientTime + t3) / 2;
      } else if (m.t === "snapshot") {
        this.latest = m;
        this.snapshots++;
        for (const ev of m.events) if (ev.kind === "shot" && ev.attacker === this.id) this.shots.push(ev);
      }
    });
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", () => rej(new Error(`cannot connect to ws://localhost:${port}`)));
      this.ws.addEventListener("close", (e) => rej(new Error(`connection closed: ${e.reason || e.code}`)));
    });
  }
  send(m: ClientMessage) {
    this.ws.send(encode(m));
  }
  ping() {
    this.send({ t: "ping", clientTime: performance.now(), ...(this.pongs ? { offset: this.offset, rtt: this.rtt } : {}) });
  }
  input(dx: number, dy: number, inputBits = 0, aimX = dx || 1, aimY = dy) {
    this.send({ t: "input", seq: ++this.seq, clientTime: performance.now(), dx, dy, aimX, aimY, inputBits, viewDelay: this.rtt / 2 });
  }
  me(): PlayerSnap {
    return this.latest!.players.find((p) => p.id === this.id)!;
  }
}

async function main() {
  const a = new Bot();
  const b = new Bot();
  await Promise.all([a.open(), b.open()]);
  await sleep(300);
  check("both players got distinct ids", a.id > 0 && b.id > 0 && a.id !== b.id, `(${a.id}, ${b.id})`);

  // Phase 2: clock sync (two rounds so the second one carries a report)
  a.ping(); await sleep(100); a.ping(); await sleep(150);
  check("pong received", a.pongs >= 2, `(rtt ${a.rtt.toFixed(1)} ms, offset ${a.offset.toFixed(1)})`);

  // Phase 1: tick rate
  const s0 = a.snapshots;
  await sleep(1000);
  const rate = a.snapshots - s0;
  check("snapshot rate ~30 Hz", rate >= 24 && rate <= 36, `(${rate}/s)`);

  // Phase 3 groundwork: server acks inputs and moves exactly one step per input
  const x0 = a.me().x;
  for (let i = 0; i < 10; i++) { a.input(1, 0); await sleep(TICK_MS); }
  await sleep(150);
  const expected = 10 * PLAYER_SPEED * TICK_DT;
  check("all 10 inputs acked", a.me().lastProcessedInputSeq === a.seq, `(${a.me().lastProcessedInputSeq}/${a.seq})`);
  check("moved exactly 10 steps", Math.abs(a.me().x - x0 - expected) < 1, `(${(a.me().x - x0).toFixed(1)} vs ${expected.toFixed(1)})`);

  // Phase 5+: chase into reliable close range and fire a hitscan shot.
  for (let i = 0; i < 240; i++) {
    const me = a.me();
    const them = a.latest!.players.find((p) => p.id === b.id)!;
    const dx = them.x - me.x;
    const dy = them.y - me.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 80) break;
    a.input(dx / dist, dy / dist, 0, dx / dist, dy / dist);
    await sleep(TICK_MS);
  }

  const me = a.me();
  const them = a.latest!.players.find((p) => p.id === b.id)!;
  const aimLen = Math.hypot(them.x - me.x, them.y - me.y);
  a.input(0, 0, INPUT_FIRE, (them.x - me.x) / aimLen, (them.y - me.y) / aimLen);
  await sleep(150);
  check("shot event produced and hit", a.shots.length > 0 && a.shots[0]!.hit, a.shots[0] ? `(compensated=${a.shots[0].compensated}, rewind ${a.shots[0].rewindMs.toFixed(0)} ms)` : "");

  // cooldown: three more fire inputs right away must not create more attempts
  const before = a.shots.length;
  for (let i = 0; i < 3; i++) { a.input(0, 0, INPUT_FIRE, (them.x - me.x) / aimLen, (them.y - me.y) / aimLen); await sleep(TICK_MS); }
  await sleep(100);
  check("fire cooldown enforced", a.shots.length === before, `(${a.shots.length} attempts)`);

  a.ws.close(); b.ws.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`FAIL  ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
