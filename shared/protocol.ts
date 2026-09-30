// ===== Simulation constants (PHASE 0: locked, shared by client + server) =====
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

export const ARENA_WIDTH = 1000;
export const ARENA_HEIGHT = 600;
export const PLAYER_RADIUS = 15;
export const MAX_SPEED = 200; // world units / second
export const TAG_RADIUS = 30;

export const HISTORY_DURATION_MS = 1000;
export const INTERPOLATION_DELAY_MS = 100;

// ===== Anti-cheat constants (PHASE 0 threat model) =====
export const MAX_REWIND_MS = 200; // hard cap on lag compensation (tune: must exceed max tested RTT + interpolation delay)
export const REWIND_MARGIN_MS = 50; // slack for jitter + input queueing
export const RTT_TOO_HIGH_MS = 300; // above this, compensation is disabled for that player
export const TAG_COOLDOWN_MS = 500;
export const MAX_INPUT_QUEUE = 8;
export const MAX_MSGS_PER_SEC = 300;

export const PING_INTERVAL_MS = 1000;
export const RTT_WINDOW = 10;

export const TAG_PRESSED = 0x1;

// ===== Messages =====
export type ClientInput = {
  type: "input";
  seq: number;
  clientTime: number; // sanity checks only; never used to choose the rewind time
  dx: number;
  dy: number;
  inputBits: number;
  viewTick: number; // (fractional) server tick the opponent was rendered at
};

export type PlayerSnapshot = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  lastProcessedInputSeq: number;
};

export type TagEvent = {
  type: "tag";
  attackerId: string;
  targetId: string;
  accepted: boolean;
  targetX: number;
  targetY: number;
};

export type ServerSnapshot = {
  type: "snapshot";
  playerId: string;
  tick: number;
  serverTime: number;
  players: PlayerSnapshot[];
  events: TagEvent[];
};

export type Welcome = { type: "welcome"; playerId: string; tickRate: number };

// Server-initiated ping: server measures RTT on its own clock
export type ServerPing = { type: "ping"; nonce: number; serverSendTime: number };
export type ClientPong = { type: "pong"; nonce: number };

// Client-initiated four-timestamp clock sync (diagnostics / rendering stats only)
export type ClockPing = { type: "cping"; clientTime: number };
export type ClockPong = {
  type: "cpong";
  clientTime: number;
  serverReceiveTime: number;
  serverSendTime: number;
};
