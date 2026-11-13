import { TICK_DT, stepPlayer, type ClientInput, type PlayerSnap, type PlayerState } from "@netcode/shared";

const MAX_PENDING = 120;

// Phase 3: client-side prediction + server reconciliation. DOM-free on purpose.
export class Predictor {
  state: PlayerState | null = null;
  lastCorrection = 0;
  onCorrection: ((magnitudePx: number, ackedSeq: number) => void) | null = null; // Phase 8 hooks here
  private pending: ClientInput[] = []; // sent but not yet acknowledged

  // Drop all local state (used when prediction is switched off).
  reset() {
    this.state = null;
    this.pending = [];
    this.lastCorrection = 0;
  }

  // Apply immediately, remember until the server acknowledges it.
  applyLocal(input: ClientInput) {
    if (!this.state) return; // wait for the first authoritative snapshot
    this.state = stepPlayer(this.state, input, TICK_DT);
    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  // Authoritative state arrived: reset to it, drop acked inputs, replay the rest.
  // Returns the correction magnitude in px (how wrong the prediction was).
  reconcile(own: PlayerSnap): number {
    const before = this.state;
    this.pending = this.pending.filter((i) => i.seq > own.lastProcessedInputSeq);

    let s: PlayerState = { ...own };
    for (const input of this.pending) s = stepPlayer(s, input, TICK_DT);
    this.state = s;

    const mag = before ? Math.hypot(s.x - before.x, s.y - before.y) : 0;
    this.lastCorrection = mag;
    this.onCorrection?.(mag, own.lastProcessedInputSeq);
    return mag;
  }
}