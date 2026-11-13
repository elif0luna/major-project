// Phase 8: SQLite persistence (DESIGN.md §33-35) using Node's built-in node:sqlite.
// Rows are only written by the harness, once per trial, in one transaction.
//
// Additions to the locked schema (approved in startup.md section 10):
//   experiment_run.condition_id          pairs the OFF and ON runs of one network condition
//   hit_event.shooter_saw_hit, hit_now, blocked_by_wall, rewind_ms
//   trial.tick_interval_mean_ms, tick_interval_max_ms
//   trial.extras_json                    proxy stats + bot counters for the trial
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS experiment_run (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  compensation_mode TEXT NOT NULL CHECK (compensation_mode IN ('OFF', 'ON')),
  tick_rate INTEGER NOT NULL,
  random_seed INTEGER NOT NULL,
  interpolation_delay_ms REAL NOT NULL,
  history_duration_ms REAL NOT NULL,
  notes TEXT,
  condition_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trial (
  trial_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  trial_number INTEGER NOT NULL,
  start_time REAL NOT NULL,
  end_time REAL,
  initial_state_json TEXT NOT NULL,
  tick_interval_mean_ms REAL,
  tick_interval_max_ms REAL,
  extras_json TEXT,
  FOREIGN KEY (run_id) REFERENCES experiment_run(run_id) ON DELETE CASCADE,
  UNIQUE (run_id, trial_number)
);

CREATE TABLE IF NOT EXISTS network_config (
  run_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('to_server', 'to_client')),
  delay_ms REAL NOT NULL CHECK (delay_ms >= 0),
  jitter_ms REAL NOT NULL CHECK (jitter_ms >= 0),
  loss REAL NOT NULL CHECK (loss >= 0 AND loss <= 1),
  seed INTEGER NOT NULL,
  PRIMARY KEY (run_id, player_id, direction),
  FOREIGN KEY (run_id) REFERENCES experiment_run(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hit_event (
  event_id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  attacker_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  input_seq INTEGER NOT NULL,
  client_time REAL NOT NULL,
  estimated_server_time REAL NOT NULL,
  rewind_time REAL NOT NULL,
  target_x REAL NOT NULL,
  target_y REAL NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  rejection_reason TEXT,
  shooter_saw_hit INTEGER,
  hit_now INTEGER NOT NULL,
  blocked_by_wall INTEGER NOT NULL,
  rewind_ms REAL NOT NULL,
  FOREIGN KEY (trial_id) REFERENCES trial(trial_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS correction_event (
  event_id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  predicted_x REAL NOT NULL,
  predicted_y REAL NOT NULL,
  authoritative_x REAL NOT NULL,
  authoritative_y REAL NOT NULL,
  correction_magnitude REAL NOT NULL,
  FOREIGN KEY (trial_id) REFERENCES trial(trial_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trial_run ON trial(run_id);
CREATE INDEX IF NOT EXISTS idx_run_condition ON experiment_run(condition_id);
CREATE INDEX IF NOT EXISTS idx_network_config_player ON network_config(run_id, player_id);
CREATE INDEX IF NOT EXISTS idx_hit_event_trial_tick ON hit_event(trial_id, tick);
CREATE INDEX IF NOT EXISTS idx_hit_event_trial_attacker ON hit_event(trial_id, attacker_id);
CREATE INDEX IF NOT EXISTS idx_correction_event_trial_tick ON correction_event(trial_id, tick);
CREATE INDEX IF NOT EXISTS idx_correction_event_trial_player ON correction_event(trial_id, player_id);
`;

export interface RunRow {
  runId: string;
  createdAt: string;
  mode: "OFF" | "ON";
  tickRate: number;
  randomSeed: number;
  interpolationDelayMs: number;
  historyDurationMs: number;
  notes: string;
  conditionId: string;
}

export interface NetworkConfigRow {
  playerId: string;
  direction: "to_server" | "to_client";
  delayMs: number;
  jitterMs: number;
  loss: number;
  seed: number;
}

export interface TrialRow {
  trialId: string;
  runId: string;
  trialNumber: number;
  startTime: number;
  endTime: number;
  initialStateJson: string;
  tickIntervalMeanMs: number;
  tickIntervalMaxMs: number;
  extrasJson: string;
}

export interface HitRow {
  tick: number;
  attackerId: string;
  targetId: string;
  inputSeq: number;
  clientTime: number;
  estimatedServerTime: number;
  rewindTime: number;
  targetX: number;
  targetY: number;
  accepted: boolean;
  rejectionReason: string;
  shooterSawHit: boolean | null;
  hitNow: boolean;
  blockedByWall: boolean;
  rewindMs: number;
}

export interface CorrectionRow {
  tick: number;
  playerId: string;
  predictedX: number;
  predictedY: number;
  authoritativeX: number;
  authoritativeY: number;
  magnitude: number;
}

export class ExperimentDb {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  hasTrial(runId: string, trialNumber: number): boolean {
    return this.db.prepare("SELECT 1 FROM trial WHERE run_id = ? AND trial_number = ?").get(runId, trialNumber) !== undefined;
  }

  hasRun(runId: string): boolean {
    return this.db.prepare("SELECT 1 FROM experiment_run WHERE run_id = ?").get(runId) !== undefined;
  }

  insertRun(run: RunRow, configs: NetworkConfigRow[]) {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO experiment_run (run_id, created_at, compensation_mode, tick_rate, random_seed,
             interpolation_delay_ms, history_duration_ms, notes, condition_id) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(run.runId, run.createdAt, run.mode, run.tickRate, run.randomSeed, run.interpolationDelayMs, run.historyDurationMs, run.notes, run.conditionId);
      const ins = this.db.prepare(
        "INSERT INTO network_config (run_id, player_id, direction, delay_ms, jitter_ms, loss, seed) VALUES (?,?,?,?,?,?,?)",
      );
      for (const c of configs) ins.run(run.runId, c.playerId, c.direction, c.delayMs, c.jitterMs, c.loss, c.seed);
    });
  }

  // One transaction per trial (DESIGN.md §35).
  insertTrial(trial: TrialRow, hits: HitRow[], corrections: CorrectionRow[]) {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO trial (trial_id, run_id, trial_number, start_time, end_time, initial_state_json,
             tick_interval_mean_ms, tick_interval_max_ms, extras_json) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(trial.trialId, trial.runId, trial.trialNumber, trial.startTime, trial.endTime, trial.initialStateJson, trial.tickIntervalMeanMs, trial.tickIntervalMaxMs, trial.extrasJson);

      const insHit = this.db.prepare(
        `INSERT INTO hit_event (event_id, trial_id, tick, attacker_id, target_id, action_type, input_seq, client_time,
           estimated_server_time, rewind_time, target_x, target_y, accepted, rejection_reason, shooter_saw_hit,
           hit_now, blocked_by_wall, rewind_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      hits.forEach((h, i) =>
        insHit.run(
          `${trial.trialId}:h${i}`, trial.trialId, h.tick, h.attackerId, h.targetId, "shot", h.inputSeq, h.clientTime,
          h.estimatedServerTime, h.rewindTime, h.targetX, h.targetY, h.accepted ? 1 : 0, h.rejectionReason,
          h.shooterSawHit === null ? null : h.shooterSawHit ? 1 : 0, h.hitNow ? 1 : 0, h.blockedByWall ? 1 : 0, h.rewindMs,
        ),
      );

      const insCor = this.db.prepare(
        `INSERT INTO correction_event (event_id, trial_id, tick, player_id, predicted_x, predicted_y,
           authoritative_x, authoritative_y, correction_magnitude) VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      corrections.forEach((c, i) =>
        insCor.run(`${trial.trialId}:c${i}`, trial.trialId, c.tick, c.playerId, c.predictedX, c.predictedY, c.authoritativeX, c.authoritativeY, c.magnitude),
      );
    });
  }

  private tx(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close() {
    this.db.close();
  }
}
