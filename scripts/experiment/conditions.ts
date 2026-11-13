// Phase 9/11: experiment conditions and presets.
//
// Every condition is a pair of players with different network quality:
//   slot A = the LOW-latency player (fixed, near-ideal link)
//   slot B = the HIGH-latency player (delay / jitter / loss vary per condition)
// The same parameters apply in both directions of a player's link. This is what the fairness
// metric |hit-rate_low - hit-rate_high| compares.
import { hashString } from "../../proxy/src/rng";

export interface LinkParams {
  delayMs: number;  // one-way, per direction
  jitterMs: number;
  loss: number;
}

export interface Condition {
  id: string;
  a: LinkParams; // low-latency player
  b: LinkParams; // high-latency player
}

export const LOW_LATENCY: LinkParams = { delayMs: 10, jitterMs: 0, loss: 0 };

export function makeCondition(delayMs: number, jitterMs: number, loss: number): Condition {
  return { id: `d${delayMs}_j${jitterMs}_l${loss}`, a: LOW_LATENCY, b: { delayMs, jitterMs, loss } };
}

export function grid(delays: number[], jitters: number[], losses: number[]): Condition[] {
  const out: Condition[] = [];
  for (const d of delays) for (const j of jitters) for (const l of losses) out.push(makeCondition(d, j, l));
  return out;
}

export interface Preset {
  description: string;
  delays: number[];
  jitters: number[];
  losses: number[];
  trials: number;
  durationSec: number;
}

export const PRESETS: Record<string, Preset> = {
  // ~3 minutes: proves the whole pipeline works end to end.
  quick: { description: "pipeline check", delays: [100], jitters: [0, 20], losses: [0], trials: 3, durationSec: 8 },
  // ~1.2 hours: enough for a mid-sized results chapter.
  standard: { description: "12 conditions x 10 trials", delays: [50, 100, 200], jitters: [0, 30], losses: [0, 0.05], trials: 10, durationSec: 15 },
  // ~5 hours: 16 conditions x 30 trials, the sample size the report promises.
  full: { description: "16 conditions x 30 trials", delays: [50, 100, 150, 200], jitters: [0, 30], losses: [0, 0.05], trials: 30, durationSec: 15 },
};

// Seeds. The run seed depends on (base seed, condition) only, NOT on the compensation mode, so the
// OFF and ON runs of a condition get the same proxy random streams and the same bot inputs.
export const runSeed = (base: number, conditionId: string) => hashString(`${base}:${conditionId}`);

export const DIRECTION_OFFSET = { A_toServer: 1, A_toClient: 2, B_toServer: 3, B_toClient: 4 } as const;

// The base seed stored in network_config for one direction of one player.
export const directionSeed = (rs: number, offset: number) => (rs + offset) >>> 0;

// The seed actually used in trial N: each trial gets its own stream, identical across OFF/ON.
export const trialSeed = (dirSeed: number, trialNumber: number) => (dirSeed + trialNumber * 8) >>> 0;

// Seed for a bot's movement script in trial N (slot "A" or "B").
export const moveSeed = (base: number, trialNumber: number, slot: "A" | "B") => hashString(`move:${base}:${trialNumber}:${slot}`);
