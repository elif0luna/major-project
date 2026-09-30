import {
  ClientInput, PlayerSnapshot, ServerSnapshot, TagEvent,
  TICK_MS, TAG_PRESSED, TAG_RADIUS, TAG_COOLDOWN_MS, MAX_INPUT_QUEUE,
  HISTORY_DURATION_MS, INTERPOLATION_DELAY_MS, MAX_REWIND_MS, REWIND_MARGIN_MS,
  RTT_TOO_HIGH_MS, RTT_WINDOW, ARENA_HEIGHT,
} from "../shared/protocol";
import { sanitizeAxis, stepMovement } from "../shared/sim";

export interface HitLog {
  tick: number; attackerId: string; targetId: string;
  accepted: boolean; reason: string;
  viewTick: number; requestedRewindMs: number; rewindMs: number;
  hitDist: number; targetX: number; targetY: number; trueTargetX: number; trueTargetY: number;
}

export class Player {
  x = 0; y = 0; vx = 0; vy = 0;
  queue: ClientInput[] = [];
  lastSeq = 0;
  lastProcessedSeq = 0;
  lastClientTime = -Infinity;
  moveDx = 0; moveDy = 0;
  tagReadyTick = 0;
  lastTagViewTick = -Infinity;
  rttSamples: number[] = [];
  smoothedRtt: number | null = null;
  constructor(public id: string) {}
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const HISTORY_TICKS = Math.ceil(HISTORY_DURATION_MS / TICK_MS);
const COOLDOWN_TICKS = Math.ceil(TAG_COOLDOWN_MS / TICK_MS);

export class Game {
  tickNo = 0;
  players = new Map<string, Player>();
  history: { tick: number; pos: Record<string, { x: number; y: number }> }[] = [];
  hitLog: HitLog[] = [];
  lagComp: boolean;

  constructor(opts: { lagComp: boolean }) {
    this.lagComp = opts.lagComp;
  }

  addPlayer(id: string): void {
    const p = new Player(id);
    p.x = id === "A" ? 200 : 800;
    p.y = ARENA_HEIGHT / 2;
    this.players.set(id, p);
  }
  removePlayer(id: string): void { this.players.delete(id); }
  debugSetPosition(id: string, x: number, y: number): void {
    const p = this.players.get(id)!; p.x = x; p.y = y;
  }

  /** PHASE 2: server-measured RTT samples; median over a sliding window. */
  addRttSample(id: string, rttMs: number): void {
    const p = this.players.get(id); if (!p) return;
    p.rttSamples.push(rttMs);
    if (p.rttSamples.length > RTT_WINDOW) p.rttSamples.shift();
    const s = [...p.rttSamples].sort((a, b) => a - b);
    p.smoothedRtt = s[Math.floor(s.length / 2)];
  }

  /** Validate + enqueue an input. Identity comes from the connection (`id`), never the message. */
  handleInput(id: string, raw: unknown): string {
    const p = this.players.get(id); if (!p) return "no_player";
    const m = raw as Record<string, unknown> | null;
    if (!m || typeof m !== "object" || m.type !== "input") return "bad_type";
    const dx = sanitizeAxis(m.dx), dy = sanitizeAxis(m.dy);
    if (dx === null || dy === null) return "bad_axis";
    if (!isNum(m.seq) || !Number.isSafeInteger(m.seq)) return "bad_seq";
    if (m.seq <= p.lastSeq) return "stale_seq";
    if (!isNum(m.clientTime)) return "bad_time";
    if (m.clientTime < p.lastClientTime) return "time_backwards";
    if (!isNum(m.viewTick)) return "bad_view";
    if (!isNum(m.inputBits) || !Number.isInteger(m.inputBits)) return "bad_bits";
    p.lastSeq = m.seq;
    p.lastClientTime = m.clientTime;
    if (p.queue.length >= MAX_INPUT_QUEUE) p.queue.shift(); // flood protection: bounded queue
    p.queue.push({
      type: "input", seq: m.seq, clientTime: m.clientTime, dx, dy,
      inputBits: m.inputBits & 0xff, viewTick: m.viewTick,
    });
    return "ok";
  }

  /** One fixed simulation step. Order follows the design doc. */
  tick(): Map<string, ServerSnapshot> {
    this.tickNo++;
    const tagRequests: { p: Player; input: ClientInput }[] = [];
    // 1-4: exactly ONE input per player per tick, then movement (persistent if queue empty)
    for (const p of this.players.values()) {
      const input = p.queue.shift();
      if (input) { p.moveDx = input.dx; p.moveDy = input.dy; p.lastProcessedSeq = input.seq; }
      stepMovement(p, p.moveDx, p.moveDy); // also clamps to arena
      if (input && (input.inputBits & TAG_PRESSED)) tagRequests.push({ p, input });
    }
    // 5-6: discrete actions / hit-tested actions (PHASE 5)
    const events: TagEvent[] = [];
    for (const { p, input } of tagRequests) {
      const ev = this.resolveTag(p, input);
      if (ev) events.push(ev);
    }
    // 8: record history AFTER movement + resolution
    const pos: Record<string, { x: number; y: number }> = {};
    for (const p of this.players.values()) pos[p.id] = { x: p.x, y: p.y };
    this.history.push({ tick: this.tickNo, pos });
    while (this.history.length > HISTORY_TICKS + 1) this.history.shift();
    // 9: snapshots
    const players: PlayerSnapshot[] = [...this.players.values()].map((p) => ({
      id: p.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, lastProcessedInputSeq: p.lastProcessedSeq,
    }));
    const out = new Map<string, ServerSnapshot>();
    for (const id of this.players.keys()) {
      out.set(id, { type: "snapshot", playerId: id, tick: this.tickNo, serverTime: this.tickNo * TICK_MS, players, events });
    }
    return out;
  }

  // ---------- PHASE 5: history + lag compensation ----------

  /** Server-side cap: RTT + interpolation delay + margin, hard-capped at MAX_REWIND_MS. */
  allowedRewindMs(p: Player): number {
    const rtt = p.smoothedRtt ?? 0;
    if (rtt > RTT_TOO_HIGH_MS) return 0; // compensation disabled for very laggy players
    return Math.min(rtt + INTERPOLATION_DELAY_MS + REWIND_MARGIN_MS, MAX_REWIND_MS);
  }

  private entryAt(t: number): Record<string, { x: number; y: number }> | null {
    if (t === this.tickNo) {
      const pos: Record<string, { x: number; y: number }> = {};
      for (const p of this.players.values()) pos[p.id] = { x: p.x, y: p.y };
      return pos;
    }
    if (this.history.length === 0) return null;
    const idx = t - this.history[0].tick;
    return idx >= 0 && idx < this.history.length ? this.history[idx].pos : null;
  }

  /** Interpolated position of a player at a (fractional) tick. */
  positionAt(id: string, tf: number): { x: number; y: number } | null {
    const t0 = Math.floor(tf);
    const a = this.entryAt(t0)?.[id];
    const b = this.entryAt(t0 + 1)?.[id] ?? a;
    if (!a || !b) return null;
    const f = tf - t0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  private log(l: HitLog): void {
    this.hitLog.push(l);
    if (this.hitLog.length > 10000) this.hitLog.shift();
  }

  private rejectTag(att: Player, tgtId: string, input: ClientInput, reason: string): null {
    this.log({
      tick: this.tickNo, attackerId: att.id, targetId: tgtId, accepted: false, reason,
      viewTick: input.viewTick, requestedRewindMs: 0, rewindMs: 0, hitDist: NaN,
      targetX: NaN, targetY: NaN, trueTargetX: NaN, trueTargetY: NaN,
    });
    return null;
  }

  private resolveTag(att: Player, input: ClientInput): TagEvent | null {
    const tick = this.tickNo;
    const target = [...this.players.values()].find((q) => q.id !== att.id);
    if (!target) return this.rejectTag(att, "", input, "no_target");
    if (tick < att.tagReadyTick) return this.rejectTag(att, target.id, input, "cooldown");
    // viewTick must be a tick the server has already broadcast, and must not go backwards
    if (input.viewTick > tick - 1 || input.viewTick < 0) return this.rejectTag(att, target.id, input, "bad_view");
    if (input.viewTick < att.lastTagViewTick) return this.rejectTag(att, target.id, input, "view_backwards");

    att.tagReadyTick = tick + COOLDOWN_TICKS;
    att.lastTagViewTick = input.viewTick;

    const requestedMs = (tick - input.viewTick) * TICK_MS;
    let rewindMs = 0;
    let tx = target.x, ty = target.y;
    if (this.lagComp) {
      rewindMs = Math.min(requestedMs, this.allowedRewindMs(att)); // clamp, never trust the request
      const pos = this.positionAt(target.id, tick - rewindMs / TICK_MS);
      if (pos) { tx = pos.x; ty = pos.y; } else rewindMs = 0;
    }
    const d = Math.hypot(att.x - tx, att.y - ty);
    const accepted = d <= TAG_RADIUS;
    this.log({
      tick, attackerId: att.id, targetId: target.id, accepted, reason: accepted ? "hit" : "miss",
      viewTick: input.viewTick, requestedRewindMs: requestedMs, rewindMs, hitDist: d,
      targetX: tx, targetY: ty, trueTargetX: target.x, trueTargetY: target.y,
    });
    return { type: "tag", attackerId: att.id, targetId: target.id, accepted, targetX: tx, targetY: ty };
  }
}
