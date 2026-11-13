# Startup guide

How to run the project, what each part does, how to check that it works, and a step-by-step demo for a review panel. Covers Phases 0 to 7. What changed and why is in `updates.md`.

---

## 1. Prerequisites

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | 22.13 or newer (22.17 tested) | `node --version` |
| pnpm | 10.x | `pnpm --version` (install: `npm install -g pnpm`) |
| A modern browser | Chrome, Edge or Firefox (WebGL) | |

Python is not needed until Phase 10.

## 2. Install

```powershell
cd "e:\sem 7\Major proj\multiplayer-netcode"
pnpm install
```

## 3. Start everything

One command starts the game server, the proxy and the browser client:

```powershell
pnpm dev
```

| Process | Address | What it is |
| --- | --- | --- |
| Game server | `ws://localhost:8080` | Authoritative 30 Hz simulation |
| Proxy | `ws://localhost:8090` | Adds delay, jitter and loss per player and direction |
| Proxy control API | `http://127.0.0.1:8091` | Changes network conditions at runtime |
| Client | `http://localhost:5173` | Three.js game in the browser |

Or start them separately, each in its own terminal: `pnpm dev:server`, `pnpm dev:proxy`, `pnpm dev:client`.

To start the server with lag compensation OFF (PowerShell):

```powershell
$env:LAG_COMP = "0"; pnpm dev:server
```

Close that terminal, or run `Remove-Item env:LAG_COMP`, to go back to ON.

## 4. Open the game

Open two browser windows side by side, one per player:

| Window | URL | Route |
| --- | --- | --- |
| Player A | `http://localhost:5173/?port=8090&slot=A` | through proxy slot A |
| Player B | `http://localhost:5173/?port=8090&slot=B` | through proxy slot B |

`http://localhost:5173/` without parameters connects straight to the server, with no proxy.

Click **START GAME** in both windows.

| Control | Action |
| --- | --- |
| WASD / arrow keys | Move |
| Mouse | Aim |
| Left click / Space | Fire |
| Shift | Sprint (uses stamina) |
| P | Toggle client-side prediction |
| I | Toggle remote interpolation |
| Esc | Pause menu with network stats |

URL switches: `?pred=0` starts with prediction off, `?interp=0` starts with interpolation off. They combine with the proxy, e.g. `?port=8090&slot=A&pred=0&interp=0`.

### What is on screen

- **Green capsule:** you. **Red capsule:** the opponent. **Grey:** dead, respawning in 2 s.
- **Green ring under you** (prediction on): where the server says you are. Normally it sits under your capsule. When the network drops your inputs, the ring and the capsule separate until reconciliation pulls them back together.
- **Shot lines:** yellow = hit, blue = miss, grey = blocked by a wall.
- **HUD, top right:**
  - Route: direct, or via the proxy and which slot.
  - RTT: measured round trip.
  - Correction: how far the last reconciliation moved you, in px.
  - Prediction, Interpolation, Lag Compensation: ON or OFF.
- **Pause menu (Esc):**
  - Player id, tick, RTT, jitter and clock offset.
  - Last Shot, e.g. `HIT 1->2 rewound 312ms (current: miss)`. This means the server rewound 312 ms and accepted the hit, but against the opponent's current position it would have missed.

---

## 5. Changing the network while playing

The proxy is controlled from a terminal. Values are one-way, so `delay=100` on both directions adds about 200 ms of round trip.

```powershell
pnpm netctl status                                    # which slots are connected
pnpm netctl set A delay=100                           # 100 ms each way for player A
pnpm netctl set A delay=100 jitter=20 loss=0.05       # plus 20 ms jitter (sd) and 5 % loss
pnpm netctl set B delay=150 dir=up                    # only B -> server
pnpm netctl stats                                     # measured drops and delays per direction
pnpm netctl clear                                     # back to a perfect network
```

The same API works over plain HTTP, which is what the Phase 9 harness will use:

```powershell
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:8091/config -ContentType application/json `
  -Body '{"players":{"A":{"toServer":{"delayMs":80},"toClient":{"delayMs":80}}}}'
```

---

## 6. How each part works

### Shared code (`shared/src`)

Client and server import the same files, so prediction and the server cannot disagree about the rules.

- `constants.ts`: tick rate (30 Hz), arena 960×640, speed 220 units/s, combat values, history 1000 ms, interpolation delay 100 ms.
- `protocol.ts`: message types. `input` carries a sequence number, client time, movement, aim, fire/sprint bits and `viewDelay`. `snapshot` carries the tick, server time, all players and events. Also `ping`, `pong` and `welcome`.
- `sim.ts` → `stepPlayer()`: one fixed step of movement. It clamps and normalises the direction, applies sprint and stamina, collides with walls and clamps to the arena. It has no clock and no randomness, so the same inputs always give the same result.
- `interp.ts` → `samplePositions()`: position of every player at any time, interpolated between the two surrounding snapshots. The client uses it to draw the opponent, and the server uses it to rewind.
- `combat.ts`: ray versus circle (the player), ray versus rectangle (cover).
- `world.ts`: the seven cover walls.

### Server (`server/src`)

- `index.ts`: accepts up to 2 WebSocket players and runs the fixed-timestep loop. The loop corrects for drift, so ticks stay on schedule. Each tick it calls `game.update()` and broadcasts one snapshot. It answers pings immediately.
- `game.ts` → `Game`:
  - `queueInput()` checks each input: numbers must be finite and seq must be strictly increasing, otherwise it is dropped as stale or duplicate.
  - `update()` applies each player's queued inputs in order with `stepPlayer()`. Each input is one step, and a tick without input means no movement.
  - Fire inputs go to `tryShot()`: cooldown of 10 ticks, then a hit test against the rewound positions (ON) or the current positions (OFF).
  - Every shot event reports `hit`, `hitNow` (would it hit against current positions?), `rewindMs` and `compensated`.
- `lagcomp.ts` → `StateHistory`: positions of all players for the last 1000 ms, one entry per tick. `rewind(t)`:
  - a future `t` is clamped to now;
  - a `t` older than the history is refused, and the shot is judged on the current state;
  - players who were dead at `t` are left out.

### Client (`client/src`)

- `clock.ts`: sends 8 quick pings, then one per second. Offset = `serverTime − (t0 + t3) / 2`, averaged over the 3 lowest-RTT samples of the last 8. The estimate goes back to the server on later pings.
- `prediction.ts` → `Predictor`: applies each input immediately and keeps it until acknowledged. On every snapshot it resets to the server's state, drops the acknowledged inputs and replays the rest. The jump this causes is the correction magnitude.
- `interpolation.ts` → `RemoteView`: keeps the last 20 snapshots. The opponent is drawn at `estimated server now − rtt/2 − 100 ms`.
- `main.ts`: sends one input per tick. The input carries `viewDelay = rtt/2 + 100 ms`, which tells the server how old the picture on this screen was, so it can rewind to the same moment.
- `render.ts`: Three.js scene. `net.ts`: WebSocket. `input.ts`: keyboard and mouse. `config.ts`: URL switches.

### Proxy (`proxy/src`)

- `relay.ts`: each client gets a slot (A, B, ...) and its own upstream socket to the server. Each slot has two independent links, `toServer` and `toClient`.
- `link.ts`: for each arriving message, draw a drop decision and a delay `max(0, delay + Normal(0, jitter))`. Then the send time is `max(previous send time, arrival + delay)`, so messages never overtake each other (as on real TCP). Randomness is seeded, with one stream per message type, so the same seed reproduces the same drops.
- `pipe.ts`: the FIFO queue, served by a single timer.
- `index.ts`: WebSocket listener plus the HTTP control API.

---

## 7. How to check that it works

Run these from the project root.

| Command | Needs running | Checks | Expected |
| --- | --- | --- | --- |
| `pnpm typecheck` | nothing | TypeScript in server, client, proxy | no errors |
| `pnpm test` | nothing | 5 server tests + 12 proxy tests | `pass 5`, `pass 12`, `fail 0` |
| `pnpm smoke` | server | ids, clock sync, 30 Hz, input acks, exact movement, a hit, cooldown | `all checks passed` |
| `pnpm proxy:check` | server + proxy | measured delay, no reordering under jitter, loss rate, proxy stats | `all checks passed` |

What the unit tests prove:

- `server/test/game.test.ts`: a shot fired at where the target *was* hits with compensation ON and misses with OFF. Also: holding fire gives one shot per cooldown, four hits kill and respawn restores health, duplicate and stale inputs are ignored.
- `proxy/test/link.test.ts`: no reordering under heavy jitter, same seed gives the same drops, measured loss and delay distribution match the config, and config changes affect only later messages.

To run the smoke test through the proxy instead of directly: `$env:PORT = "8090"; pnpm smoke; Remove-Item env:PORT`.

---

## 8. Demo for a review panel (about 10 minutes)

Preparation: run `pnpm dev`. Open the two windows from section 4 side by side and keep a terminal visible for `netctl`.

**Step 1: The code is tested.** Run `pnpm test` and point at the 17 passing tests. Explain that the server and proxy logic is pure, so it is tested without a network.

**Step 2: The problem.** In window A, reload with `&pred=0&interp=0` added, then run `pnpm netctl set A delay=100`.

- Move with WASD. Your own player reacts about 200 ms late.
- This is the Phase 1 baseline: the client only draws what the server sends.

**Step 3: Client-side prediction.** Press **P** in window A.

- Movement is instant again, even though the network is still slow.
- The green ring (server position) trails slightly and stays under the capsule when you stop.
- HUD Correction stays at 0.0 px, because client and server run the same `stepPlayer()`.
- Now run `pnpm netctl set A delay=100 loss=0.2`. Correction becomes non-zero and the ring visibly separates: dropped inputs are steps the server never applied.

**Step 4: Interpolation.** Run `pnpm netctl set B delay=50 jitter=30 loss=0.1` and watch player B in window A.

- Press **I** to turn interpolation off: the opponent stutters and jumps.
- Press **I** again: smooth movement, drawn 100 ms in the past.

**Step 5: Lag compensation.** Run `pnpm netctl set A delay=120 jitter=0 loss=0`. Have player B strafe up and down while A shoots at B.

- Press Esc in window A: Last Shot shows e.g. `HIT 1->2 rewound 330ms (current: miss)`. The server rewound to what A saw and accepted the hit, although B had already moved.
- Then restart the server with `$env:LAG_COMP = "0"; pnpm dev:server` and reload both windows. The HUD shows Lag Compensation OFF, and the same shots now mostly miss.
- This is the trade-off the project measures: with compensation, the shooter gets what they saw, and the target can be hit after reaching cover.

**Step 6: The network is controlled and measured.** Run `pnpm netctl stats`. It shows, per player and direction, how many messages arrived and were dropped, and the measured delay mean and sd. These match the configured values. Then run `pnpm proxy:check` to show the automated version.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `EADDRINUSE` on 8080 / 8090 / 8091 | Another server or proxy is still running. Close it, or set `PORT` / `PROXY_PORT` / `CONTROL_PORT` |
| Start screen says "Disconnected: server full" | Two players are already connected (maybe an old tab). Close it and reload |
| "Disconnected: no free proxy slot" or "slot A is in use" | Both proxy slots are taken. Close the old tab |
| "proxy cannot reach game server" | The proxy is running but the server is not. Start `pnpm dev:server` |
| `pnpm smoke` reports odd ids or fails the hit | Restart the server first; the smoke test expects a fresh game |
| Shots never compensated right after joining | The clock needs about 1 s of pings first |

---

## 10. Before Phase 8 (SQLite): what you need to do

No database server and nothing to install. Node 22.13+ includes SQLite as the built-in module `node:sqlite`. It was checked on this machine: SQLite 3.50.0. It prints an "ExperimentalWarning" on first use, which is harmless. The database is a single file.

What I need from you before starting Phase 8:

1. **Where the database file lives.** Proposal: `data/experiments.sqlite`, with `data/` added to `.gitignore` so results are not committed by accident.
2. **Approval of three schema additions.** The schema in DESIGN.md §33 is locked, so these are explicit design changes:
   - `experiment_run.condition_id`: OFF and ON are separate runs in the locked schema, and this column is what pairs them for the matched comparison.
   - `hit_event.shooter_saw_hit`, `hit_event.hit_now`, `hit_event.blocked_by_wall`, `hit_event.rewind_ms`: the hit-accuracy and post-dodge metrics cannot be computed without them.
   - `trial.tick_interval_mean_ms`, `trial.tick_interval_max_ms`: the report's risk table promises that actual tick timing is logged.
3. **Damage during experiments.** Proposal: shots are hit-tested and logged as usual, but deal no damage. With damage, ON trials have more kills and respawns than OFF trials, so player paths diverge and the trials stop being matched. Normal play keeps damage.
4. **Optional, for showing the data to the panel:** install [DB Browser for SQLite](https://sqlitebrowser.org/) to open the `.sqlite` file and browse the tables.

For Phase 10 later, the analysis needs these Python packages, which are not installed yet (Python 3.11 is present):

```powershell
pip install pandas matplotlib numpy
```

---

## 11. Running Phases 8-11

See `updates.md` section 3. Short version: `.\scripts\run-all.ps1` (quick), `-Preset standard` or `-Preset full`. Nothing else is needed; the Python packages install automatically.
