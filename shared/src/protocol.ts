// Phase 0: the protocol spec. Single source of truth for client + server.
//
// Clock convention: serverTime ~= clientTime + offset
//   clientTime = performance.timeOrigin + performance.now() in the browser
//   serverTime = serverNow() on the server (epoch ms, sub-ms precision)
//
// The pong carries a single serverTime: the server replies synchronously inside the
// message handler, so its receive (t1) and send (t2) times are the same instant and
//   offset = ((t1 - t0) + (t2 - t3)) / 2  reduces to  serverTime - (t0 + t3) / 2
//   RTT    = (t3 - t0) - (t2 - t1)        reduces to  t3 - t0

export interface ClientInput {
  t: "input";
  seq: number;        // increments per input; used for reconciliation (Phase 3)
  clientTime: number; // ms, client clock, stamped when the input was created
  dx: number;         // -1..1
  dy: number;         // -1..1
  aimX: number;       // normalized aim direction
  aimY: number;
  inputBits: number;  // bit0 = fire, bit1 = sprint
  // Phase 5: how far behind the client's estimated server time the world it was
  // looking at was (ms). = rtt/2 (+ interpolation delay if interpolating).
  // Server rewinds to: clientTime + offset - viewDelay.
  viewDelay: number;
}

export interface PingRequest {
  t: "ping";
  clientTime: number; // t0
  // Piggy-backed report of the client's latest estimate, so the server can
  // convert input timestamps to server time (Phase 5) and log per-player latency (Phase 8).
  offset?: number;
  rtt?: number;
}

export interface PingResponse {
  t: "pong";
  clientTime: number; // t0 echoed back
  serverTime: number; // server clock when handled
}

export interface Welcome {
  t: "welcome";
  id: number;
  tickRate: number;
  lagComp: boolean;   // is server-side compensation enabled? (for the HUD)
}

export interface PlayerSnap {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aimX: number;
  aimY: number;
  health: number;
  stamina: number;
  alive: boolean;
  respawnTicks: number;
  score: number;
  lastProcessedInputSeq: number;
}

export type GameEvent =
  | { kind: "join"; id: number }
  | { kind: "leave"; id: number }
  | {
      kind: "shot";           // every shot ATTEMPT, hit or miss (Phase 8 logs these)
      attacker: number;
      seq: number;            // input seq that fired the shot (lets the harness join bot-side and server-side logs)
      target: number | null;  // who was hit (null = miss)
      hit: boolean;           // the server's verdict
      hitNow: boolean;        // would it have hit against CURRENT positions?
      damage: number;
      killed: boolean;
      blockedByWall: boolean;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      tick: number;
      rewindMs: number;       // how far back the server looked (0 if uncompensated)
      compensated: boolean;   // was history actually used?
    }
  | { kind: "respawn"; id: number; x: number; y: number; tick: number };

export interface ServerSnapshot {
  t: "snapshot";
  tick: number;
  serverTime: number;
  players: PlayerSnap[];
  events: GameEvent[];
}

export type ClientMessage = ClientInput | PingRequest;
export type ServerMessage = ServerSnapshot | PingResponse | Welcome;

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T extends ClientMessage | ServerMessage>(raw: string): T | null {
  try {
    const msg = JSON.parse(raw);
    if (msg && typeof msg === "object" && typeof msg.t === "string") return msg as T;
  } catch {
    /* fall through */
  }
  return null;
}
