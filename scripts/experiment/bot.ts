// Phase 9: a deterministic scripted client. It runs the REAL client logic (Clock, Predictor,
// RemoteView), so prediction, reconciliation and interpolation behave as in the browser.
//
// Determinism: movement comes from a seeded generator indexed by input number, so the input
// trajectory is identical for the OFF and ON trial of a matched pair. Aim and fire decisions
// follow what the bot *sees* (its interpolated view of the opponent), like a human would.
import {
  INTERPOLATION_DELAY_MS, PING_BURST, PING_BURST_GAP_MS, PING_INTERVAL_MS, SHOT_RADIUS, SHOT_RANGE, INPUT_FIRE, TICK_MS,
  decode, encode, firstWallDistance, makeShotRay, rayCircleDistance,
  type ClientInput, type ClientMessage, type PlayerSnap, type ServerMessage, type ServerSnapshot,
} from "../../shared/src/index";
import { Clock } from "../../client/src/clock";
import { RemoteView } from "../../client/src/interpolation";
import { Predictor } from "../../client/src/prediction";
import { mulberry32 } from "../../proxy/src/rng";

export const FIRE_EVERY_INPUTS = 12; // a bit above the 10-tick server cooldown\n\n// Open vertical lanes either side of the centre wall (see shared/src/world.ts).\nconst LANES = { A: { xMin: 310, xMax: 414 }, B: { xMin: 546, xMax: 650 } } as const;\nconst LANE_Y_MIN = 170;\nconst LANE_Y_MAX = 470;

// Open vertical lanes either side of the centre wall (see shared/src/world.ts).
const LANES = { A: { xMin: 310, xMax: 414 }, B: { xMin: 546, xMax: 650 } } as const;
const LANE_Y_MIN = 170;
const LANE_Y_MAX = 470;

const clientNow = () => performance.timeOrigin + performance.now();

export interface BotCorrection {
  tick: number;
  predictedX: number;
  predictedY: number;
  authoritativeX: number;
  authoritativeY: number;
  magnitude: number;
}

export class Bot {
  readonly ws: WebSocket;
  id = 0;
  clock = new Clock();
  predictor = new Predictor();
  view = new RemoteView();
  latest: ServerSnapshot | null = null;
  firstSnapshot: ServerSnapshot | null = null;

  seq = 0;
  inputsSent = 0;
  firesSent = 0;
  snapshots = 0;
  corrections: BotCorrection[] = [];
  shotLog = new Map<number, { sawHit: boolean }>(); // by input seq

  private timers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private closed = false;

  readonly lane: { xMin: number; xMax: number };

  constructor(url: string, private moveSeed: number, slot: "A" | "B") {
    this.lane = LANES[slot];
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
    this.ws.addEventListener("close", () => (this.closed = true));
  }

  // Resolves once connected AND welcomed (so this.id is known).
  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`bot connect timed out (${this.ws.url})`)), timeoutMs);
      const done = () => { if (this.id > 0) { clearTimeout(t); resolve(); } };
      this.ws.addEventListener("message", done);
      this.ws.addEventListener("error", () => { clearTimeout(t); reject(new Error(`cannot connect to ${this.ws.url}`)); });
      this.ws.addEventListener("close", (e) => { clearTimeout(t); reject(new Error(`closed during connect: ${e.reason || e.code}`)); });
    });
  }

  private send(m: ClientMessage) {
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(m));
  }

  private onMessage(raw: string) {
    const m = decode<ServerMessage>(raw);
    if (!m) return;
    if (m.t === "welcome") this.id = m.id;
    else if (m.t === "pong") this.clock.onPong(m, clientNow());
    else if (m.t === "snapshot") this.onSnapshot(m);
  }

  private onSnapshot(s: ServerSnapshot) {
    this.latest = s;
    this.firstSnapshot ??= s;
    this.snapshots++;
    this.view.push(s);
    const own = s.players.find((p) => p.id === this.id);
    if (!own) return;
    const before = this.predictor.state;
    const mag = this.predictor.reconcile(own);
    if (before && this.predictor.state) {
      this.corrections.push({
        tick: s.tick,
        predictedX: before.x,
        predictedY: before.y,
        authoritativeX: this.predictor.state.x,
        authoritativeY: this.predictor.state.y,
        magnitude: mag,
      });
    }
  }

  // ---- clock sync (same schedule as the browser client, but stoppable) ----
  startPings() {
    const ping = () => {
      const m: ClientMessage = { t: "ping", clientTime: clientNow() };
      if (this.clock.offset !== null && this.clock.rtt !== null) {
        m.offset = this.clock.offset;
        m.rtt = this.clock.rtt;
      }
      this.send(m);
    };
    for (let i = 0; i < PING_BURST; i++) this.later(i * PING_BURST_GAP_MS, ping);
    const every = () => { ping(); this.later(PING_INTERVAL_MS, every); };
    this.later(PING_BURST * PING_BURST_GAP_MS, every);
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.closed) fn(); }, ms);
    this.timers.add(t);
  }

  get synced() {
    return this.clock.offset !== null && this.predictor.state !== null && this.snapshots > 3;
  }

  private viewDelayMs() {
    return (this.clock.rtt ?? 0) / 2 + INTERPOLATION_DELAY_MS;
  }

  // ---- scripted inputs at the server tick rate ----
  startInputs() {
    this.running = true;
    const rng = mulberry32(this.moveSeed);
    let left = 0, vert = 0, n = 0, lastFireN = -Infinity;
    const otherId = this.id === 1 ? 2 : 1;
    let nextAt = performance.now();

    const step = () => {
      if (!this.running || this.closed) return;
      // Movement script: strafe up/down in an open lane (A: left of the centre wall, B: right of it),
      // holding a direction for 8-25 inputs and sometimes stopping. The segment draws consume the RNG
      // identically every trial, whatever the network does. Lane limits only use the bot's own
      // predicted position, so they steer the bot into the lane first (spawns are outside it).
      if (left <= 0) {
        left = 8 + Math.floor(rng() * 18);
        vert = rng() < 0.15 ? 0 : rng() < 0.5 ? -1 : 1;
      }
      left--;
      const me = this.predictor.state;
      let dx = 0, dy = vert;
      if (me) {
        if (me.x < this.lane.xMin) dx = 1;
        else if (me.x > this.lane.xMax) dx = -1;
        if (me.y < LANE_Y_MIN) dy = 1;
        else if (me.y > LANE_Y_MAX) dy = -1;
      }
      const own = this.predictor.state;
      const serverNow = this.clock.serverTimeNow();
      if (own && serverNow !== null) {
        const shown = this.view.sample(serverNow - this.viewDelayMs()).get(otherId);
        let aimX = 1, aimY = 0, dist = Infinity;
        if (shown) {
          const vx = shown.x - own.x, vy = shown.y - own.y;
          dist = Math.hypot(vx, vy);
          if (dist > 1e-3) { aimX = vx / dist; aimY = vy / dist; }
        }
        const fire = shown !== undefined && dist <= SHOT_RANGE && n - lastFireN >= FIRE_EVERY_INPUTS &&
          this.lineOfSight(own, aimX, aimY, otherId, shown);
        if (fire) lastFireN = n;

        const input: ClientInput = {
          t: "input", seq: ++this.seq, clientTime: clientNow(), dx, dy, aimX, aimY,
          inputBits: fire ? INPUT_FIRE : 0, viewDelay: this.viewDelayMs(),
        };
        this.predictor.applyLocal(input);
        this.send(input);
        this.inputsSent++;

        if (fire && shown) {
          this.firesSent++;
          // Did the shooter's own screen show a hit? Same geometry the server uses, evaluated on
          // the bot's predicted position (after this input) and the interpolated opponent.
          const p = this.predictor.state!;
          this.shotLog.set(input.seq, { sawHit: this.lineOfSight(p, aimX, aimY, otherId, shown) });
        }
        n++;
      }

      nextAt += TICK_MS;
      this.later(Math.max(0, nextAt - performance.now()), step);
    };
    step();
  }

  private lineOfSight(from: { x: number; y: number }, aimX: number, aimY: number, otherId: number, shown: { x: number; y: number }) {
    const ray = makeShotRay(from.x, from.y, aimX, aimY);
    const wall = firstWallDistance(ray);
    const d = rayCircleDistance(ray, { id: otherId, x: shown.x, y: shown.y, radius: SHOT_RADIUS });
    return d !== null && (wall === null || d <= wall);
  }

  stopInputs() {
    this.running = false;
  }

  close() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.closed = true;
    try { this.ws.close(1000, "trial over"); } catch { /* already closed */ }
  }

  ownSnap(): PlayerSnap | undefined {
    return this.latest?.players.find((p) => p.id === this.id);
  }
}
