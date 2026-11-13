# Real-Time Multiplayer Networking Under Unreliable Network Conditions

A research-oriented two-player browser game for studying how server-side lag compensation affects hit validation and player fairness under controlled network degradation.

The game is intentionally small. The main contribution is the networking system and the reproducible experimental setup, not the gameplay itself.

## Research Question

> How does server-side lag compensation affect collision accuracy and player fairness in a real-time multiplayer game under controlled network degradation?

The primary experimental comparison is **lag compensation OFF vs ON** while varying network conditions such as latency, jitter, and application-level message loss.

---

## Project Status

| Phase | Status |
| --- | --- |
| 0: Design lock | Complete |
| 1: Authoritative server + dumb client | Complete (`?pred=0&interp=0` reproduces it) |
| 2: Clock sync / RTT | Complete |
| 3: Prediction + reconciliation | Complete |
| 4: Remote interpolation | Complete |
| 5: Server history + lag compensation | Complete |
| 6: Minimal shooter rules + Three.js client | Complete |
| 7: Network degradation proxy | Complete (`proxy/`, see `updates.md`) |
| 8: SQLite instrumentation | Not started (correction hook exists in `Predictor.onCorrection`) |
| 9: Deterministic experiment harness | Not started |
| 10: Analysis pipeline | Not started |
| 11: Full sweep + write-up | Not started |

The design is locked for implementation. Changes to protocol fields, timestamp semantics, proxy ordering, network configuration, database schema, compensation boundaries, or simulation tick semantics should be treated as explicit design changes.

---

## System Overview

Clients connect either straight to the server (port 8080) or through the Phase 7 proxy (port 8090):

```text
Client A <-> Proxy Relay A <-> Server
Client B <-> Proxy Relay B <-> Server
```

Each client has its own relay pair, so the two players can be given different network conditions.

The proxy is an **application-level WebSocket relay**. It receives complete WebSocket messages and can independently delay, jitter, or drop messages in each direction.

---

## Core Design

### Authoritative simulation

The server owns the official game state. It runs the simulation at a fixed **30 Hz** timestep and is responsible for:

- player positions and velocities
- aim direction
- health, stamina, death, respawn, and score
- input validation
- arena bounds
- cover collision and shot results
- simulation tick/state

Clients never submit authoritative positions, velocities, health, shot results, or tick state.

### Client-side prediction and reconciliation

The local browser predicts its own movement immediately instead of waiting for a server response.

Each input has a sequence number. The client keeps unacknowledged inputs in a buffer. When a server snapshot arrives, the client:

1. resets the local player to the authoritative state,
2. removes acknowledged inputs using `lastProcessedInputSeq`,
3. replays the remaining unacknowledged inputs locally.

### Remote-player interpolation

Prediction and reconciliation apply only to the local player. Remote players are rendered from a snapshot interpolation buffer using an initial **100 ms interpolation delay**.

### Clock synchronization

Clients and the server use separate monotonic clocks. A four-timestamp ping/pong exchange estimates clock offset:

```text
t0 = client sends ping
t1 = server receives ping
t2 = server sends pong
t3 = client receives pong
```

Offset:

```text
offset = ((t1 - t0) + (t2 - t3)) / 2
```

RTT:

```text
RTT = (t3 - t0) - (t2 - t1)
```

The server answers a ping synchronously inside the message handler, so t1 and t2 are the same instant and the pong carries a single `serverTime`. The client keeps the last 8 samples and averages the offset of the 3 with the lowest RTT, since those have the least queuing error.

The server never trusts raw `clientTime` on its own. For lag compensation it converts the input timestamp with the offset the client reports on its pings.

### Server-side lag compensation

The server keeps approximately **1 second of recent authoritative history**.

When a fire input is received, the server:

```text
clientTime
    ↓
clientTime + estimated clock offset
    ↓
estimated server time
    ↓
validate rewind range
    ↓
find bracketing historical snapshots
    ↓
interpolate target position
    ↓
perform hitscan ray test with wall occlusion
    ↓
resolve action using current authoritative state
```

The simulation is not rolled back. Historical state is used only for hit validation.

An input older than the available history is not lag-compensated: the shot is judged against the current state, as with compensation OFF, and the event reports `compensated: false`. A future timestamp is clamped to the current server time. Players who were dead at the rewound time cannot be hit.

### Controlled network degradation

The proxy independently controls each direction:

```text
Player A -> Server
Server   -> Player A
Player B -> Server
Server   -> Player B
```

Each direction has its own:

- base delay
- jitter
- loss probability
- random seed
- FIFO forwarding queue

Jitter must not create artificial application-level message reordering. Each direction uses a FIFO send queue.

---

## Technology Stack

| Component | Technology |
| --- | --- |
| Browser client | TypeScript + Three.js |
| Client transport | Native WebSocket API |
| Server | Node.js + TypeScript |
| WebSocket server | `ws` |
| Network proxy | Node.js + TypeScript |
| Message encoding | JSON |
| Experiment storage | SQLite |
| Data analysis | Python + pandas + matplotlib |
| Build tooling | Vite |
| Version control | Git + GitHub |

The current design uses Node.js/TypeScript for the proxy. Rust is not part of the current implementation plan.

---

## Repository Structure

```text
multiplayer-netcode/
├─ package.json              # root scripts only
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ README.md
│
├─ shared/                   # @netcode/shared, used by both client and server
│  └─ src/
│     ├─ index.ts            # re-exports everything
│     ├─ constants.ts        # tick rate, arena, speeds, combat, history, interpolation
│     ├─ protocol.ts         # message types, encode/decode
│     ├─ sim.ts              # deterministic stepPlayer(state, input, dt)
│     ├─ interp.ts           # samplePositions(): client interpolation and server rewind
│     ├─ world.ts            # static arena cover and collision helpers
│     └─ combat.ts           # pure hitscan and wall-occlusion helpers
│
├─ server/
│  ├─ src/
│  │  ├─ index.ts            # WebSocket bootstrap and fixed-timestep loop
│  │  ├─ game.ts             # authoritative simulation, combat, snapshots
│  │  ├─ lagcomp.ts          # state history and rewind
│  │  └─ time.ts             # the server clock
│  └─ test/
│     └─ game.test.ts        # lag compensation ON/OFF, cooldown, death/respawn, input acks
│
├─ client/
│  ├─ index.html
│  └─ src/
│     ├─ main.ts             # wiring, menus, input loop
│     ├─ config.ts           # URL switches (?pred, ?interp, ?lag)
│     ├─ net.ts              # WebSocket send/receive
│     ├─ clock.ts            # ping/pong clock sync
│     ├─ input.ts            # keyboard and mouse to input commands
│     ├─ prediction.ts       # prediction and reconciliation
│     ├─ interpolation.ts    # remote player snapshot buffer
│     ├─ render.ts           # Three.js arena renderer
│     └─ style.css
│
└─ scripts/
   ├─ smoke-test.ts          # two fake clients against a running server
   ├─ proxy-check.ts         # end-to-end check of delay, jitter, ordering and loss through the proxy
   └─ netctl.ts              # change proxy network conditions from the terminal
```

```text
proxy/                       # Phase 7 network degradation proxy
├─ src/
│  ├─ index.ts               # WebSocket listener + HTTP control API
│  ├─ relay.ts               # per-player slots, one upstream socket per client
│  ├─ link.ts                # delay / jitter / loss / FIFO model (pure, unit-tested)
│  ├─ pipe.ts                # FIFO send queue with a single timer
│  └─ rng.ts                 # seeded PRNG and normal sampling
└─ test/
   └─ link.test.ts
```

SQLite instrumentation, bots and the analysis pipeline (Phases 8 to 11) are not in the repository yet.

---

## Simulation Constants

All values live in `shared/src/constants.ts` so client and server cannot disagree:

```ts
TICK_RATE = 30;                 // TICK_DT = 1 / 30 s
ARENA_W = 960;  ARENA_H = 640;
PLAYER_RADIUS = 16;
PLAYER_SPEED = 220;             // world units / second
SPRINT_MULTIPLIER = 1.42;       // costs stamina
SHOT_RANGE = 620;
SHOT_RADIUS = PLAYER_RADIUS;
SHOT_DAMAGE = 25;
FIRE_COOLDOWN_TICKS = 10;
PLAYER_MAX_HEALTH = 100;
RESPAWN_TICKS = 60;             // 2 s
MAX_PLAYERS = 2;

HISTORY_DURATION_MS = 1000;
INTERPOLATION_DELAY_MS = 100;
MAX_VIEW_DELAY_MS = 500;        // cap on the client-reported viewDelay
```

The coordinate system uses a top-left origin:

```text
(0,0) ─────────────────────────────► +X
  │
  │
  │
  ▼
 +Y
```

Player positions are continuous and the authoritative server enforces arena bounds.

---

## Network Protocol

All application messages are JSON objects with a `t` discriminator. `shared/src/protocol.ts` is the source of truth; the summary below is kept in sync with it.

### Client input

```ts
type ClientInput = {
  t: "input";
  seq: number;
  clientTime: number;
  dx: number;
  dy: number;
  aimX: number;
  aimY: number;
  inputBits: number;
  viewDelay: number;
};
```

Semantics:

- `seq`: monotonically increasing input sequence number
- `clientTime`: monotonic client timestamp when the input was generated
- `dx`, `dy`: movement direction only
- `aimX`, `aimY`: shot direction
- `inputBits`: discrete action bitmask (`INPUT_FIRE`, `INPUT_SPRINT`)
- `viewDelay`: how far in the past the client was drawing the opponent, `rtt / 2` plus the interpolation delay if interpolation is on. The server rewinds to `clientTime + offset - viewDelay`.

Movement is **not** encoded in `inputBits`.

The first defined action bits are:

```ts
const INPUT_FIRE = 0x1;
const INPUT_SPRINT = 0x2;
```

### Server snapshot

```ts
type ServerSnapshot = {
  t: "snapshot";
  tick: number;
  serverTime: number;
  players: {
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
  }[];
  events: {
    kind: "shot";
    attacker: number;
    target: number | null;
    hit: boolean;
    hitNow: boolean;
    damage: number;
    killed: boolean;
    blockedByWall: boolean;
    fromX: number; fromY: number;
    toX: number; toY: number;
    tick: number;
    rewindMs: number;
    compensated: boolean;
  }[];   // plus join / leave / respawn events
};
```

### Ping request / response

```ts
type PingRequest = {
  t: "ping";
  clientTime: number;
  offset?: number;
  rtt?: number;
};
```

```ts
type PongResponse = {
  t: "pong";
  clientTime: number;
  serverTime: number;
};
```

The exact protocol is defined in `shared/src/protocol.ts`.

---

## Server Input Rules

`stepPlayer()` in `shared/src/sim.ts` clamps each of `dx`, `dy` to `[-1, 1]` and rescales the vector if its length is above 1, then applies speed:

```ts
let dx = clamp(input.dx, -1, 1);
let dy = clamp(input.dy, -1, 1);
const len = Math.hypot(dx, dy);
if (len > 1) { dx /= len; dy /= len; }

x += dx * speed * DT;   // speed = PLAYER_SPEED, x1.42 while sprinting
y += dy * speed * DT;
```

Inputs such as `(1, 0)` and `(100000, 0)` therefore move at the same speed, and diagonals are not faster than straight lines.

One server tick (`Game.update()`):

```text
1. For each player, take the inputs queued since the last tick
   (already validated on arrival: finite numbers, seq strictly increasing)
2. Dead players: discard inputs (still acked), count down respawn
3. Alive players: apply each input in seq order with stepPlayer()
   (movement, stamina, wall collision, arena clamp),
   then resolve INPUT_FIRE against history if compensation is ON
4. Record positions in the history buffer
5. Build the snapshot and broadcast it
```

Each input moves the player exactly one step. If no input arrived for a player during a tick, that player does not move. The server does not repeat the previous input, because the client predicts one step per input it sends; repeating inputs on the server would make every late input show up as a prediction error.

A discrete action such as `INPUT_FIRE` is handled the same way: if that message is dropped, the shot is lost and is not reconstructed.

---

## Proxy Model

The proxy works at the WebSocket message level rather than manipulating raw TCP packets.

For each direction, a configuration has the form:

```ts
type DirectionConfig = {
  delayMs: number;
  jitterMs: number;
  loss: number;
  seed: number;
};
```

Per-player configuration:

```ts
type PlayerNetworkConfig = {
  toServer: DirectionConfig;
  toClient: DirectionConfig;
};
```

Overall configuration:

```ts
type ProxyConfig = {
  players: Record<string, PlayerNetworkConfig>;
};
```

The proxy exposes (HTTP on `127.0.0.1:8091`):

```http
GET  /health         relay slots, connected?, queue lengths
GET  /config         current config
PUT  /config         partial updates allowed, e.g. {"players":{"A":{"toServer":{"delayMs":80}}}}
GET  /stats          per direction: arrived, dropped, drop rate, drawn and actual delay (mean, sd, min, max)
POST /stats/reset
```

The `players` keys are relay slot names (`A`, `B`, or any other name a client asks for with `?slot=`), not server player ids. That way a slot can be configured before anyone connects. A PUT is validated completely before anything is applied, so a bad request changes nothing.

Configuration changes apply atomically to future arrivals. Messages already scheduled for forwarding keep the configuration that was active when they arrived.

The jitter model is:

```text
delay[i] = max(0, baseDelay + Normal(0, jitterSigma))
```

where `jitterMs` represents the standard deviation.

Departure times preserve FIFO order:

```text
sendTime[i] = max(
    sendTime[i - 1],
    arrivalTime[i] + jitteredDelay[i]
)
```

Randomness is seeded per direction, with one independent stream per message type (`input`, `ping`, `snapshot`, ...). The k-th input of a trial therefore gets the same drop and delay draw in every trial with the same seed, even if pings interleave differently. Matched OFF/ON trials see identical network draws.

---

## Experimental Methodology

The project is designed for repeatable experiments rather than informal gameplay testing.

A trial is controlled by:

- initial game state
- bot input trajectory
- simulation constants
- tick rate
- network configuration
- proxy random seed
- compensation mode

Matched OFF/ON trials use the same initial state and deterministic input trajectory, and reuse the same proxy random stream where practical.

The primary independent variable is:

```text
Lag Compensation: OFF / ON
```

Network degradation is varied independently through:

```text
Latency × Jitter × Message Loss
```

---

## Experimental Metrics

### Hit-confirmation accuracy

The rate at which hit attempts are accepted correctly against the known simulation state at the relevant input time.

### Correction magnitude

The distance between predicted and authoritative local-player positions when reconciliation occurs:

```text
sqrt(
  (predicted_x - authoritative_x)^2 +
  (predicted_y - authoritative_y)^2
)
```

### Fairness metric

```text
|hit-rate_low-latency - hit-rate_high-latency|
```

### Target-side post-dodge acceptance rate

The fraction of accepted shots where the target had already moved away from the shot line on the target's displayed timeline.

---

## Experiment Data

SQLite is used for experiment persistence, not live game-state updates.

The planned schema contains:

```text
experiment_run
trial
network_config
hit_event
correction_event
```

Runtime events are buffered in memory and flushed after a trial or run rather than performing synchronous database writes in the simulation hot path.

This keeps instrumentation from introducing the same timing disturbance that the experiments are trying to measure.

---

## Development Phases

The implementation follows the locked phase plan:

```text
Phase 0  Design Lock
   ↓
Phase 1  Bare authoritative server + dumb client
   ↓
Phase 2  Clock synchronization / RTT estimation
   ↓
Phase 3  Client-side prediction + reconciliation
   ↓
Phase 4  Remote entity interpolation
   ↓
Phase 5  Server history + lag compensation
   ↓
Phase 6  Minimal shooter rules
   ↓
Phase 7  Network degradation proxy
   ↓
Phase 8  Instrumentation + SQLite
   ↓
Phase 9  Deterministic experiment harness
   ↓
Phase 10 Analysis pipeline
   ↓
Phase 11 Full experiment sweep + write-up
```

### Phase 1 baseline

The first implementation target is intentionally minimal:

```text
Node + TypeScript authoritative server
        +
TypeScript browser client
        +
native WebSocket
        +
30 Hz fixed timestep
        +
raw server-authoritative movement
        +
localhost end-to-end validation
```

The Phase 1 client deliberately renders only server broadcasts. Prediction, reconciliation, interpolation, lag compensation, the proxy, and the experiment harness are added later.

This gives a working baseline before synchronization features are introduced.

---

## Scope

### Included

- two-player Three.js arena shooter
- authoritative server simulation
- hitscan shooting, cover, health, stamina, death, respawn, and scoring
- real-time WebSocket communication
- client-side prediction and reconciliation
- remote-player interpolation
- clock synchronization
- server-side lag compensation
- controlled latency, jitter, and message loss
- deterministic bot-based experiments
- SQLite experiment logging
- Python-based analysis and visualization

### Out of scope

- matchmaking
- accounts/authentication
- persistent game worlds
- cloud-scale deployment
- entity-component architecture
- generic N-player gameplay abstractions
- protocol-version negotiation
- binary protocol optimization
- production-grade distributed infrastructure

The game is a controlled experimental vehicle, not a commercial multiplayer game.

---

## Local Development

The primary development and demonstration environment is local or a controlled local network.

The project should first be validated end to end on `localhost` before controlled network degradation and automated experiments are introduced.

Useful local commands:

```bash
pnpm dev              # server (8080) + proxy (8090, control 8091) + client (5173)
pnpm dev:server       # run the WebSocket server
pnpm dev:proxy        # run the network degradation proxy
pnpm dev:client       # run the Vite/Three.js client
pnpm test             # server game tests + proxy delay/drop tests
pnpm smoke            # connect two fake clients to a running server
pnpm proxy:check      # verify delay, jitter, ordering and loss through the running proxy
pnpm netctl status    # proxy status; see scripts/netctl.ts for all commands
```

`startup.md` has a step-by-step walkthrough, including a demo script for a review panel.

If port `8080` is already occupied, run the server with `PORT=8081` and the client with `VITE_SERVER_PORT=8081`.

Experiment switches:

| Switch | Effect |
| --- | --- |
| `LAG_COMP=0` (server env) | lag compensation OFF |
| `?pred=0` (client URL) | no client-side prediction, the Phase 1 baseline |
| `?interp=0` (client URL) | draw remote players at the latest snapshot |
| `?port=8090&slot=A` (client URL) | connect through the proxy, relay slot A |
| `pnpm netctl set A delay=100 jitter=10 loss=0.05` | change slot A's network while playing |
| `P` / `I` keys in game | toggle prediction / interpolation live |

The server accepts two players. A third connection is closed with code 1013 ("server full").

---

## Design Principles

The project keeps four concerns separate:

```text
Game simulation
    -> authoritative server

Player responsiveness
    -> client prediction + reconciliation

Remote visual smoothness
    -> snapshot interpolation

Experimental network conditions
    -> application-level proxy
```

Lag compensation changes **hit validation only**. It does not change movement simulation, client prediction, reconciliation, interpolation, server tick rate, or server authority.

---

## References

1. I. Fette and A. Melnikov, **The WebSocket Protocol**, RFC 6455, IETF, 2011.
2. MDN Web Docs, **WebSocket API (WebSockets)**.
3. `ws`, **Node.js WebSocket library**.
4. Y. W. Bernier, **Latency Compensating Methods in Client/Server In-game Protocol Design and Optimization**, Valve, 2001.
5. C. Savery and T. C. Nicholas Graham, **Timelines: simplifying the programming of lag compensation for the next generation of networked games**, Multimedia Systems, 2013.

---

## Project Team

- Himanshi Sharma (2023Btech035)
- Kopal Jain (2023Btech044)
- Vinay Lunawat (2023Btech098)

**Faculty Guide:** Devendra Bhavsar

**Institute:** Institute of Engineering and Technology (IET), JK Lakshmipat University

---

## Design Documentation

The Phase 0 design document (`docs/DESIGN.md`) is kept outside the repository with the project reports. Where it and the code disagree, the code and this README describe the current behaviour.
