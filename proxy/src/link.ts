// Phase 7: the delay/jitter/loss model for ONE direction of ONE relay
// (e.g. "player A -> server"). Pure logic, no sockets, so it is unit-tested directly.
//
//   drop if u < loss
//   delay[i]    = max(0, delayMs + Normal(0, jitterMs))          (jitterMs = std. deviation)
//   sendTime[i] = max(sendTime[i-1], arrival[i] + delay[i])        (FIFO: never reorders)
import { hashString, mulberry32, normal, type Rng } from "./rng";

export interface DirectionConfig {
  delayMs: number;  // base one-way delay added by the proxy
  jitterMs: number; // standard deviation of the normal jitter
  loss: number;     // probability in [0, 1] that a message is dropped
  seed: number;     // unsigned 32-bit integer
}

export const IDEAL: DirectionConfig = { delayMs: 0, jitterMs: 0, loss: 0, seed: 1 };

// Returns an error message, or null if the config is valid.
export function validateDirection(c: unknown): string | null {
  if (!c || typeof c !== "object") return "must be an object";
  const d = c as Record<string, unknown>;
  const finite = (k: string) => typeof d[k] === "number" && Number.isFinite(d[k]);
  if (!finite("delayMs") || (d.delayMs as number) < 0 || (d.delayMs as number) > 10_000) return "delayMs must be 0..10000";
  if (!finite("jitterMs") || (d.jitterMs as number) < 0 || (d.jitterMs as number) > 5_000) return "jitterMs must be 0..5000";
  if (!finite("loss") || (d.loss as number) < 0 || (d.loss as number) > 1) return "loss must be 0..1";
  if (!Number.isInteger(d.seed) || (d.seed as number) < 0 || (d.seed as number) > 0xffffffff) return "seed must be an integer 0..4294967295";
  return null;
}

// Running mean / standard deviation (Welford), so stats cost O(1) memory.
export class RunningStats {
  n = 0;
  mean = 0;
  min = Infinity;
  max = -Infinity;
  private m2 = 0;

  add(x: number) {
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }

  get sd() {
    return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0;
  }

  toJSON() {
    return this.n === 0
      ? { n: 0 }
      : { n: this.n, mean: round(this.mean), sd: round(this.sd), min: round(this.min), max: round(this.max) };
  }
}

const round = (x: number) => Math.round(x * 100) / 100;

export class LinkStats {
  arrived = 0;
  dropped = 0;
  scheduled = 0;
  drawnDelay = new RunningStats();  // the sampled delay, before FIFO
  actualDelay = new RunningStats(); // sendTime - arrival, including any FIFO wait

  toJSON() {
    return {
      arrived: this.arrived,
      dropped: this.dropped,
      scheduled: this.scheduled,
      dropRate: this.arrived ? round(this.dropped / this.arrived) : 0,
      drawnDelayMs: this.drawnDelay,
      actualDelayMs: this.actualDelay,
    };
  }
}

export class Link {
  private cfg: DirectionConfig;
  // One random stream per message type ("input", "ping", "snapshot", ...).
  // The k-th input therefore gets the same drop/delay draw in every trial with the same
  // seed, even if pings interleave differently. That keeps matched OFF/ON trials matched.
  private streams = new Map<string, Rng>();
  private lastSendAt = -Infinity;
  stats = new LinkStats();

  constructor(cfg: DirectionConfig = IDEAL) {
    this.cfg = { ...cfg };
  }

  get config(): DirectionConfig {
    return { ...this.cfg };
  }

  // Takes effect for messages arriving from now on. Already-scheduled messages keep the
  // send time they were given. Setting a config restarts the random streams from the seed.
  setConfig(cfg: DirectionConfig) {
    this.cfg = { ...cfg };
    this.streams.clear();
  }

  // New connection on this relay: the FIFO constraint only applies within one connection.
  resetQueue() {
    this.lastSendAt = -Infinity;
  }

  resetStats() {
    this.stats = new LinkStats();
  }

  // Decide the fate of a message arriving at `arrival` (ms). Returns its send time, or null if dropped.
  schedule(arrival: number, streamKey = ""): number | null {
    const cfg = this.cfg; // snapshot: the decision uses the config active at arrival
    let rng = this.streams.get(streamKey);
    if (!rng) {
      rng = mulberry32((cfg.seed ^ hashString(streamKey)) >>> 0);
      this.streams.set(streamKey, rng);
    }

    // Always consume both draws, so a drop does not shift the jitter of later messages.
    const dropDraw = rng();
    const z = normal(rng);
    this.stats.arrived++;

    if (dropDraw < cfg.loss) {
      this.stats.dropped++;
      return null;
    }

    const drawn = Math.max(0, cfg.delayMs + z * cfg.jitterMs);
    const sendAt = Math.max(this.lastSendAt, arrival + drawn);
    this.lastSendAt = sendAt;

    this.stats.scheduled++;
    this.stats.drawnDelay.add(drawn);
    this.stats.actualDelay.add(sendAt - arrival);
    return sendAt;
  }
}
