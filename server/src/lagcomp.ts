// Phase 5: server-side state history and rewind for lag-compensated hit tests.
//
// The simulation is never rolled back. History is only read to answer
// "where was everyone at server time t?" for a hit test.
import { HISTORY_DURATION_MS, samplePositions, type Pos, type TimelineEntry } from "@netcode/shared";

export interface HistoryPlayer {
  id: number;
  x: number;
  y: number;
  alive: boolean;
}

interface HistoryEntry extends TimelineEntry {
  players: ReadonlyArray<HistoryPlayer>;
}

export type RewindResult =
  | { ok: true; time: number; rewindMs: number; positions: Map<number, Pos> }
  | { ok: false; reason: "no-history" | "too-old" };

export class StateHistory {
  private entries: HistoryEntry[] = [];

  // Called once per tick, after movement and combat, so stored positions are legal positions.
  record(time: number, players: Iterable<HistoryPlayer>) {
    this.entries.push({
      time,
      players: [...players].map(({ id, x, y, alive }) => ({ id, x, y, alive })),
    });
    const oldest = time - HISTORY_DURATION_MS;
    while (this.entries.length > 1 && this.entries[0]!.time < oldest) this.entries.shift();
  }

  get size() {
    return this.entries.length;
  }

  // Reconstruct positions at server time `t`.
  //  - t in the future  -> clamped to `now`
  //  - t older than the oldest stored entry -> rejected (caller falls back to current state).
  //    Clamping instead would let a client ask for the oldest target position on purpose.
  //  - players that were dead (or not yet joined) at t are left out, so they cannot be hit.
  rewind(t: number, now: number): RewindResult {
    if (this.entries.length === 0) return { ok: false, reason: "no-history" };

    const time = Math.min(t, now);
    if (time < this.entries[0]!.time) return { ok: false, reason: "too-old" };

    const positions = samplePositions(this.entries, time);

    // The two entries that bracket `time` (or the last one if time is past it).
    let i = this.entries.length - 1;
    while (i > 0 && this.entries[i]!.time > time) i--;
    const before = this.entries[i]!;
    const after = this.entries[i + 1] ?? before;
    const aliveIn = (e: HistoryEntry, id: number) => e.players.some((p) => p.id === id && p.alive);
    for (const id of positions.keys()) {
      if (!aliveIn(before, id) || !aliveIn(after, id)) positions.delete(id);
    }

    return { ok: true, time, rewindMs: now - time, positions };
  }
}
