// DOM-free client logic: used by the browser (main.ts) AND by headless bots/tests (Phase 9).
import {
  ClientInput, ServerSnapshot, PlayerSnapshot, TagEvent, TAG_PRESSED, TICK_MS,
  INTERPOLATION_DELAY_MS, RTT_WINDOW,
} from "../shared/protocol";
import { dist, stepMovement } from "../shared/sim";

export interface ClientOptions {
  url: string;
  WS: new (url: string) => any; // browser WebSocket or the `ws` package class
  now: () => number;            // performance.now
  predict?: boolean;            // PHASE 3 (false = Phase 1 "dumb client")
  interp?: boolean;             // PHASE 4 (false = render latest snapshot)
  fakeLagMs?: number;           // TEST ONLY: one-way artificial delay, replaced by the Phase 7 proxy
}

type Snap = { tick: number; serverTime: number; recv: number; players: PlayerSnapshot[] };
export type TagLogEntry = {
  seq: number; viewTick: number;
  own: { x: number; y: number };
  opponentRendered: { x: number; y: number } | null; // ground truth: what the attacker saw
};

export class GameClient {
  playerId = "";
  ready = false;
  local = { x: 0, y: 0, vx: 0, vy: 0 };       // own position shown on screen
  pending: { seq: number; dx: number; dy: number }[] = []; // PHASE 3: unacked inputs
  seq = 0;
  snaps: Snap[] = [];
  events: TagEvent[] = [];
  corrections: number[] = [];                 // PHASE 3: correction magnitudes (Phase 8 input)
  tagLog: TagLogEntry[] = [];                 // PHASE 4: ground truth for measurement
  clock = { offset: NaN, rtt: NaN };          // PHASE 2: client-side four-timestamp estimate
  private clockSamples: { offset: number; rtt: number }[] = [];
  private tickOffsetSamples: number[] = [];   // PHASE 4: render clock samples
  private rt = 0;                             // last render tick (kept monotonic)
  private ws: any;
  private timers: any[] = [];
  private predict: boolean;
  private interp: boolean;

  constructor(private o: ClientOptions) {
    this.predict = o.predict ?? true;
    this.interp = o.interp ?? true;
  }

  connect(): void {
    this.ws = new this.o.WS(this.o.url);
    this.ws.onmessage = (ev: any) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      const lag = this.o.fakeLagMs ?? 0;
      if (lag > 0) setTimeout(() => this.onMessage(raw), lag); else this.onMessage(raw);
    };
    this.timers.push(setInterval(() => this.send({ type: "cping", clientTime: this.o.now() }), 1000));
  }

  close(): void { this.timers.forEach(clearInterval); try { this.ws?.close(); } catch {} }

  private send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const s = JSON.stringify(msg);
    const lag = this.o.fakeLagMs ?? 0;
    if (lag > 0) setTimeout(() => { if (this.ws.readyState === 1) this.ws.send(s); }, lag); else this.ws.send(s);
  }

  private onMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case "welcome": this.playerId = m.playerId; this.ready = true; break;
      case "snapshot": this.onSnapshot(m as ServerSnapshot); break;
      case "ping": this.send({ type: "pong", nonce: m.nonce }); break; // server measures RTT itself
      case "cpong": this.onClockPong(m); break;
    }
  }

  // ---------- PHASE 2 (client side) ----------
  private onClockPong(m: { clientTime: number; serverReceiveTime: number; serverSendTime: number }): void {
    const t0 = m.clientTime, t1 = m.serverReceiveTime, t2 = m.serverSendTime, t3 = this.o.now();
    const offset = ((t1 - t0) + (t2 - t3)) / 2;
    const rtt = (t3 - t0) - (t2 - t1);
    this.clockSamples.push({ offset, rtt });
    if (this.clockSamples.length > RTT_WINDOW) this.clockSamples.shift();
    const best = this.clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a)); // min-RTT sample
    this.clock = { offset: best.offset, rtt: best.rtt };
  }

  // ---------- Snapshots, PHASE 3 reconciliation ----------
  private onSnapshot(s: ServerSnapshot): void {
    const recv = this.o.now();
    this.snaps.push({ tick: s.tick, serverTime: s.serverTime, recv, players: s.players });
    if (this.snaps.length > 40) this.snaps.shift();
    // render clock sample: server tick expressed against the client clock (min-delay = max sample)
    this.tickOffsetSamples.push(s.tick - recv / TICK_MS);
    if (this.tickOffsetSamples.length > 120) this.tickOffsetSamples.shift();
    for (const e of s.events) this.events.push(e);
    const me = s.players.find((p) => p.id === this.playerId);
    if (me) this.reconcile(me);
  }

  private reconcile(me: PlayerSnapshot): void {
    const before = { x: this.local.x, y: this.local.y };
    if (!this.predict) { this.local = { x: me.x, y: me.y, vx: me.vx, vy: me.vy }; return; }
    this.pending = this.pending.filter((i) => i.seq > me.lastProcessedInputSeq); // drop acked
    const st = { x: me.x, y: me.y, vx: me.vx, vy: me.vy };                        // reset to authority
    for (const i of this.pending) stepMovement(st, i.dx, i.dy);                    // replay the rest
    this.local = st;
    this.corrections.push(dist(before, st));
    if (this.corrections.length > 20000) this.corrections.shift();
  }

  // ---------- PHASE 4: interpolation ----------
  /** Fractional server tick the opponent is rendered at (= "viewTick" sent with inputs). */
  renderTick(): number {
    const last = this.snaps[this.snaps.length - 1];
    if (!last) return 0;
    if (!this.interp) return last.tick;
    const off = Math.max(...this.tickOffsetSamples);
    let t = this.o.now() / TICK_MS + off - INTERPOLATION_DELAY_MS / TICK_MS;
    t = Math.min(t, last.tick); // never extrapolate
    t = Math.max(t, this.rt);   // never go backwards
    this.rt = t;
    return t;
  }

  opponentRendered(): { x: number; y: number } | null {
    if (this.snaps.length === 0) return null;
    const opp = (s: Snap) => s.players.find((p) => p.id !== this.playerId);
    const rt = this.renderTick();
    let a = this.snaps[0];
    for (const s of this.snaps) { if (s.tick <= rt) a = s; else break; }
    const b = this.snaps.find((s) => s.tick > a.tick) ?? a;
    const pa = opp(a), pb = opp(b);
    if (!pa || !pb) return null;
    const f = b.tick === a.tick ? 0 : Math.min(1, Math.max(0, (rt - a.tick) / (b.tick - a.tick)));
    return { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f };
  }

  // ---------- Input (fixed 60 Hz) ----------
  sendInput(dx: number, dy: number, tag: boolean): void {
    if (!this.ready) return;
    const seq = ++this.seq;
    const viewTick = this.renderTick();
    const msg: ClientInput = {
      type: "input", seq, clientTime: this.o.now(), dx, dy,
      inputBits: tag ? TAG_PRESSED : 0, viewTick,
    };
    this.send(msg);
    if (this.predict) { stepMovement(this.local, dx, dy); this.pending.push({ seq, dx, dy }); }
    if (tag) this.tagLog.push({ seq, viewTick, own: { x: this.local.x, y: this.local.y }, opponentRendered: this.opponentRendered() });
  }

  /** Calls getInput exactly TICK_RATE times per second on average (accumulator, not raw setInterval). */
  startInputLoop(getInput: () => { dx: number; dy: number; tag: boolean }): void {
    let last = this.o.now(), acc = 0;
    this.timers.push(setInterval(() => {
      const t = this.o.now(); acc += t - last; last = t;
      let n = 0;
      while (acc >= TICK_MS && n < 5) { const i = getInput(); this.sendInput(i.dx, i.dy, i.tag); acc -= TICK_MS; n++; }
      if (n === 5) acc = 0;
    }, 4));
  }
}
