// Phase 0 decisions: fixed 30 Hz tick, JSON encoding. Used by BOTH sides.
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const TICK_DT = 1 / TICK_RATE; // seconds per tick

export const ARENA_W = 960;
export const ARENA_H = 640;
export const PLAYER_RADIUS = 16;
export const PLAYER_SPEED = 220; // px/s
export const SPRINT_MULTIPLIER = 1.42;
export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_STAMINA = 100;
export const STAMINA_DRAIN_PER_SEC = 34;
export const STAMINA_REGEN_PER_SEC = 24;
export const RESPAWN_TICKS = TICK_RATE * 2;

export const SERVER_PORT = 8080;
export const MAX_PLAYERS = 2;         // the experiment is strictly two-player

// Phase 2: clock sync
export const PING_BURST = 8;          // quick pings at startup so we converge fast
export const PING_BURST_GAP_MS = 100;
export const PING_INTERVAL_MS = 1000; // steady-state

// Phase 4: interpolation
export const INTERPOLATION_DELAY_MS = 100; // remote entities are drawn this far in the past

// Phase 5+: shooter mechanics + lag compensation
export const INPUT_FIRE = 1;          // inputBits bit0
export const INPUT_SPRINT = 2;        // inputBits bit1
export const SHOT_RANGE = 620;
export const SHOT_RADIUS = PLAYER_RADIUS; // hitscan tests against the body circle
export const SHOT_DAMAGE = 25;
export const FIRE_COOLDOWN_TICKS = 10;
export const HISTORY_DURATION_MS = 1000; // server keeps this much past state for rewind
export const MAX_VIEW_DELAY_MS = 500;    // upper bound on the client-reported viewDelay
