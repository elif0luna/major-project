// Phase 8: in-memory trial recorder. The game loop only pushes into arrays; nothing here
// touches disk. The harness collects the buffers over the control API when a trial ends and
// writes them to SQLite in one transaction (DESIGN.md §35).
import type { ShotRecord } from "./game";

export interface TrialRecording {
  trialId: string;
  shots: ShotRecord[];
  ticks: number;
  tickIntervalMeanMs: number;
  tickIntervalMaxMs: number;
}

export class Recorder {
  private trialId: string | null = null;
  private shots: ShotRecord[] = [];
  private ticks = 0;
  private intervalSum = 0;
  private intervalMax = 0;
  private lastTickAt: number | null = null;

  get active() {
    return this.trialId !== null;
  }

  begin(trialId: string) {
    this.trialId = trialId;
    this.shots = [];
    this.ticks = 0;
    this.intervalSum = 0;
    this.intervalMax = 0;
    this.lastTickAt = null;
  }

  // Call once per server tick with a monotonic timestamp (ms).
  onTick(nowMs: number) {
    if (this.trialId === null) return;
    if (this.lastTickAt !== null) {
      const dt = nowMs - this.lastTickAt;
      this.ticks++;
      this.intervalSum += dt;
      if (dt > this.intervalMax) this.intervalMax = dt;
    }
    this.lastTickAt = nowMs;
  }

  onShot(rec: ShotRecord) {
    if (this.trialId !== null) this.shots.push(rec);
  }

  end(): TrialRecording | null {
    if (this.trialId === null) return null;
    const out: TrialRecording = {
      trialId: this.trialId,
      shots: this.shots,
      ticks: this.ticks,
      tickIntervalMeanMs: this.ticks ? this.intervalSum / this.ticks : 0,
      tickIntervalMaxMs: this.intervalMax,
    };
    this.trialId = null;
    this.shots = [];
    return out;
  }
}
