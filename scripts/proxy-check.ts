// Phase 7 end-to-end check: game server + proxy must be running (fresh server recommended).
//   terminal 1: pnpm dev:server    terminal 2: pnpm dev:proxy    terminal 3: pnpm proxy:check
//
// Verifies through the real relay that
//   - the configured delay shows up in the measured RTT,
//   - jitter never reorders messages (pongs and snapshots stay in order),
//   - the configured loss shows up in the snapshot rate,
//   - the proxy's own measured stats match the config.
import { decode, encode, type ClientMessage, type ServerMessage } from "../shared/src/index";

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

const PROXY = process.env.PROXY_URL ?? "ws://localhost:8090";
const API = process.env.PROXY_CONTROL ?? "http://127.0.0.1:8091";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("FAIL  timed out");
  process.exit(1);
}, 60_000);

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const dir = (delayMs: number, jitterMs: number, loss: number, seed: number) => ({ delayMs, jitterMs, loss, seed });
async function setA(up: ReturnType<typeof dir>, down: ReturnType<typeof dir>) {
  await api("PUT", "/config", { players: { A: { toServer: up, toClient: down } } });
  await api("POST", "/stats/reset");
}

class Probe {
  ws = new WebSocket(`${PROXY}/?slot=A`);
  rtts: number[] = [];
  pongOrder: number[] = [];
  ticks: number[] = [];

  constructor() {
    this.ws.addEventListener("message", (e) => {
      const m = decode<ServerMessage>(String(e.data));
      if (m?.t === "pong") {
        this.rtts.push(performance.now() - m.clientTime);
        this.pongOrder.push(m.clientTime);
      } else if (m?.t === "snapshot") this.ticks.push(m.tick);
    });
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", () => rej(new Error(`cannot connect to ${PROXY}`)));
      this.ws.addEventListener("close", (e) => rej(new Error(`closed: ${e.reason || e.code}`)));
    });
  }
  send(m: ClientMessage) {
    this.ws.send(encode(m));
  }
  reset() {
    this.rtts = [];
    this.pongOrder = [];
    this.ticks = [];
  }
}

const inOrder = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]!);

async function main() {
  try {
    await api("GET", "/health");
  } catch {
    throw new Error(`proxy control API not reachable at ${API} (run "pnpm dev:proxy")`);
  }

  await setA(dir(0, 0, 0, 1), dir(0, 0, 0, 2));
  const p = new Probe();
  await p.open();
  await sleep(300);

  // 1) fixed delay: 60 ms each way -> RTT about 120 ms
  await setA(dir(60, 0, 0, 1), dir(60, 0, 0, 2));
  p.reset();
  for (let i = 0; i < 15; i++) { p.send({ t: "ping", clientTime: performance.now() }); await sleep(50); }
  await sleep(300);
  const rtt = median(p.rtts);
  check("fixed delay shows up in RTT", p.rtts.length === 15 && Math.abs(rtt - 120) < 15, `(median ${rtt.toFixed(1)} ms, expected ~120)`);

  // 2) jitter: 50 +- 20 ms each way, pings every 10 ms -> without FIFO they would overtake each other
  await setA(dir(50, 20, 0, 11), dir(50, 20, 0, 12));
  p.reset();
  for (let i = 0; i < 100; i++) { p.send({ t: "ping", clientTime: performance.now() }); await sleep(10); }
  await sleep(500);
  check("jitter does not reorder pongs", p.pongOrder.length === 100 && inOrder(p.pongOrder), `(${p.pongOrder.length} pongs)`);
  check("jitter does not reorder snapshots", p.ticks.length > 20 && inOrder(p.ticks), `(${p.ticks.length} snapshots)`);
  check("jitter widens RTT spread", sd(p.rtts) > 5, `(RTT sd ${sd(p.rtts).toFixed(1)} ms)`);

  // 3) loss: 30 % on server -> client, no delay -> about 21 of 30 snapshots/s get through
  await setA(dir(0, 0, 0, 21), dir(0, 0, 0.3, 22));
  p.reset();
  await sleep(3000);
  const rate = p.ticks.length / 3;
  check("loss shows up in snapshot rate", rate > 17 && rate < 25, `(${rate.toFixed(1)}/s, expected ~21)`);
  check("dropped snapshots leave gaps, never reordering", inOrder(p.ticks) && p.ticks.some((t, i) => i > 0 && t - p.ticks[i - 1]! > 1));
  const stats = (await api("GET", "/stats")) as { A: { toClient: { dropRate: number } } };
  check("proxy stats report the configured loss", Math.abs(stats.A.toClient.dropRate - 0.3) < 0.1, `(dropRate ${stats.A.toClient.dropRate})`);

  await setA(dir(0, 0, 0, 1), dir(0, 0, 0, 2));
  p.ws.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`FAIL  ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
