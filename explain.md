# How this project works

This file explains what each folder does, which part controls which, and how to collect the Phase 11 data.

---

## 1. The idea in one paragraph

Two players shoot each other in a small arena. The **server** is the only place where the game really happens. Each player's **client** shows a guess of the world, because the network is slow. The **proxy** sits between clients and server and makes the network worse on purpose (delay, jitter, packet loss). The **experiment harness** replaces human players with scripted **bots**, runs the same match twice (lag compensation OFF, then ON) under many network conditions, and saves every shot to a **SQLite** file. A **Python script** turns that file into tables and graphs.

The research question: does server-side lag compensation make hit detection more accurate and more fair when the network is bad?

---

## 2. The big picture

```text
  NORMAL PLAY (you in a browser)

  browser client A ──┐
                     ├─ ws :8090 ─► PROXY ── ws :8080 ─► SERVER
  browser client B ──┘          (adds delay/loss)      (runs the game)
        ▲                            ▲
        │ opens http://localhost:5173│ pnpm netctl set A delay=100 ...
        └─ Vite dev server           └─ proxy control API :8091


  EXPERIMENTS (no humans, no browser)

  scripts/experiment/sweep.ts   <- the boss, started by `pnpm exp:*`
        │ starts two copies of server+proxy as child processes:
        │
        ├─ "OFF" stack:  server (LAG_COMP=0) + proxy      ports 8100-8103
        └─ "ON"  stack:  server (LAG_COMP=1) + proxy      ports 8110-8113
        │
        │ for every trial it:
        │   1. sets the proxy's network conditions (HTTP, control API)
        │   2. starts two bots that connect through the proxy
        │   3. tells the server to start recording (HTTP, control API)
        │   4. lets the bots play for N seconds
        │   5. asks the server for the recorded shots
        │   6. writes everything to data/experiments.sqlite (one transaction)
        ▼
  data/experiments.sqlite ──► analysis/analyze.py ──► data/analysis/ (summary.md, figures, CSVs)
```

Who manages whom:

| Manager | Manages | How |
| --- | --- | --- |
| `scripts/run-all.ps1` | everything below | runs the other commands in order |
| `scripts/experiment/sweep.ts` | servers, proxies, bots, the database | child processes + HTTP control APIs |
| proxy control API (`:8091`) | the network conditions | `PUT /config`, `GET /stats` |
| server control API (`CONTROL_PORT`) | recording of shots | `POST /trial/begin`, `POST /trial/end` |
| Server | the game world | 30 Hz loop, the only authority |
| Clients / bots | nothing authoritative | they send inputs and draw what the server says |

---

## 3. Folder by folder

### `shared/` — the rules both sides agree on

Code used by the server, the client and the bots, so everyone calculates the same thing.

| File | What it holds |
| --- | --- |
| `constants.ts` | tick rate (30 Hz), arena size, speeds, damage, cooldown, history length (1000 ms), interpolation delay (100 ms) |
| `protocol.ts` | the message types (`input`, `ping`, `pong`, `snapshot`, `welcome`, shot events) and `encode`/`decode` (JSON) |
| `sim.ts` | `stepPlayer()`: how one input moves one player. Used by the server to move players and by the client to predict |
| `world.ts` | wall rectangles and collision |
| `combat.ts` | the hitscan maths: ray vs. circle, ray vs. wall |
| `interp.ts` | `samplePositions()`: finds positions between two snapshots. Used by the client for interpolation and by the server to rewind |

### `server/` — the authority

| File | What it does |
| --- | --- |
| `src/index.ts` | opens the WebSocket on port 8080, runs the fixed 30 Hz loop, sends a snapshot to every client each tick. Reads env vars: `LAG_COMP`, `DAMAGE`, `PORT`, `CONTROL_PORT`. Has the small HTTP control API used by experiments |
| `src/game.ts` | the `Game` class: players, input queues, movement, shooting, respawn. `tryShot()` is where lag compensation happens |
| `src/lagcomp.ts` | `StateHistory`: stores about 1 second of past positions and rewinds to a given time |
| `src/time.ts` | the single server clock |
| `src/recorder.ts` | Phase 8: collects shot records and tick timing **in memory** during a trial |
| `test/game.test.ts` | unit tests |

How a shot is judged: the server takes the shooter's `clientTime`, converts it to server time with the client's reported clock offset, subtracts `viewDelay` (what the shooter was looking at), rewinds the **target** to that moment and tests the ray. With compensation OFF it tests against the current position instead.

### `client/` — the browser game (Phases 1 to 6)

Built with Vite and Three.js. It is for humans, demos and screenshots.

| File | What it does |
| --- | --- |
| `main.ts` | game loop, ties everything together |
| `net.ts` | the WebSocket connection (direct or via proxy) |
| `clock.ts` | NTP-style clock sync (offset and RTT from ping/pong) |
| `prediction.ts` | client-side prediction and reconciliation. Reports how far the server corrected you |
| `interpolation.ts` | draws the other player slightly in the past, smoothly |
| `input.ts` | keyboard and mouse |
| `render.ts` | 3D drawing and HUD |
| `config.ts` | URL switches: `?pred=0`, `?interp=0`, `?port=8090&slot=A` |

`clock.ts`, `prediction.ts` and `interpolation.ts` are also imported by the bots, so the bots behave like real clients.

### `proxy/` — the network degrader (Phase 7)

Sits between client and server and treats every message separately, in each direction.

| File | What it does |
| --- | --- |
| `src/index.ts` | WebSocket listener on 8090 and HTTP control API on 8091 |
| `src/relay.ts` | one relay slot per player (`A`, `B`). Each slot opens its own connection to the server and has two links |
| `src/link.ts` | the model for one direction: drop with probability `loss`, otherwise delay by `delay + Normal(0, jitter)`, keep order (FIFO), keep stats |
| `src/pipe.ts` | a queue with one timer, so messages leave in order |
| `src/rng.ts` | seeded random numbers, so the same seed gives the same drops and delays |
| `test/link.test.ts` | 12 unit tests |

Nothing is random without a seed. That is what makes OFF and ON trials comparable.

### `scripts/` — tools and the experiment machinery

| File | What it does |
| --- | --- |
| `smoke-test.ts` | `pnpm smoke`: quick check that a running server works |
| `proxy-check.ts` | `pnpm proxy:check`: checks that the proxy really delays, drops and keeps order |
| `netctl.ts` | `pnpm netctl set A delay=100 ...`: change network conditions by hand while you play |
| `run-all.ps1` | **one command** for checks, sweep and analysis |
| `experiment/sweep.ts` | **the harness**: parses options, runs the matched trials, saves results |
| `experiment/conditions.ts` | the presets (`quick`, `standard`, `full`) and how seeds are derived |
| `experiment/stack.ts` | starts and stops a server + proxy pair |
| `experiment/bot.ts` | the scripted player |
| `experiment/db.ts` | the SQLite schema and writes |
| `experiment/reset-db.ts` | deletes the database |

### `analysis/` — Phase 10

`analyze.py` reads the database and writes CSVs, five figures and `summary.md`. `requirements.txt` lists the Python packages.

### `data/` — created when you run an experiment

`experiments.sqlite` (raw results) and `analysis/` (tables and figures). It is in `.gitignore`.

### `docs/`, `README.md`, `startup.md`, `updates.md`

`DESIGN.md` is the locked design. `README.md` is the project overview. `startup.md` is how to install and run. `updates.md` is the change log and the list of limitations for the report.

---

## 4. What a bot does

A bot (`scripts/experiment/bot.ts`) is a client without a screen. It:

1. connects through the proxy (`ws://localhost:<proxy>/?slot=A` or `B`),
2. syncs its clock with the same `Clock` class as the browser,
3. every 33 ms sends one input: **movement** from a seeded script (up/down strafing in an open lane), **aim** at where it sees the opponent (interpolated, in the past), **fire** about every 12 inputs when it has a clear line of sight,
4. predicts its own movement and reconciles with the server, writing down every correction,
5. remembers, for each shot, whether **its own screen showed a hit** (`shooter_saw_hit`).

Slot A is the **low-latency** player (10 ms each way, clean). Slot B is the **high-latency** player. The conditions change only B's link. The fairness metric compares A's and B's hit rates.

---

## 5. What is saved, and what the metrics mean

Tables: `experiment_run` (one per condition and mode), `trial`, `network_config`, `hit_event` (one row per shot), `correction_event` (one row per reconciliation).

| Metric | Meaning | Good for ON means |
| --- | --- | --- |
| Hit-confirmation accuracy | of the shots the shooter saw hitting, how many the server accepted | higher |
| Fairness gap | the difference in that accuracy between the low-latency and high-latency player | lower |
| Post-dodge acceptance | share of accepted hits where the target had already moved away on the server's current state | the price of compensation, expect it above 0 |
| Correction magnitude | how far prediction was wrong (px) | not expected to change with compensation, it is a prediction metric |

---

## 6. Collecting the data for Phase 11

### Before you start

- Close heavy programs (browsers with many tabs, video, builds). Machine load makes the server tick late and adds noise.
- Plug the laptop in and stop it from sleeping.
- Do not run `pnpm dev` or any server on ports 8100 to 8113. The harness uses these ports.

### Step 1: quick check (3 minutes)

```powershell
.\scripts\run-all.ps1
```

It must finish with "Done". Open `data\analysis\summary.md` and look at the figures. If this fails, do not start a long run.

### Step 2: clean the test data

The quick run wrote to the real database. Start the real sweep from an empty one:

```powershell
.\scripts\run-all.ps1 -Preset standard -Fresh
```

### Step 3: choose the size

| Preset | Conditions | Trials each | Length | Time | Use it for |
| --- | --- | --- | --- | --- | --- |
| `quick` | 2 | 3 | 8 s | about 3 min | checking the setup |
| `standard` | 12 (delay 50/100/200, jitter 0/30, loss 0/5%) | 10 | 15 s | about 1.2 h | first real results, drafts |
| `full` | 16 (delay 50/100/150/200, jitter 0/30, loss 0/5%) | 30 | 15 s | about 5 h | the final report numbers |

Suggested path: run `standard` first, read `summary.md`, then run `full` overnight with `-Fresh` so the two do not mix.

```powershell
.\scripts\run-all.ps1 -Preset full -Fresh
```

### Step 4: if it stops

Press Ctrl+C to stop safely (it finishes the current trial). Run the **same command without `-Fresh`** to resume. Finished trials are skipped. Do not add `-Fresh` when resuming, because it deletes the database.

### Step 5: read the results

Everything is in `data\analysis\`:

- `summary.md`: headline tables
- `fig_hit_accuracy.png`, `fig_fairness_gap.png`, `fig_post_dodge_rate.png`, `fig_correction_mean_px.png`, `fig_rewind_mean_ms.png`
- `paired_differences.csv`: ON minus OFF per condition, with a confidence interval and a `significant` flag
- `condition_summary.csv`, `trial_metrics.csv`: the tables behind the figures

To re-run only the analysis: `pnpm exp:analyze`.

### Step 6: check the data is trustworthy

- In `summary.md`, the **worst tick interval**. The target is 33.3 ms. A few trials with spikes above 100 ms are normal. If the average is above about 34 ms, the machine was overloaded. Re-run those conditions on a quiet machine.
- Each condition should have the same number of trials for OFF and ON.
- With compensation ON, accuracy should go up and the fairness gap should go down, especially at high delay. If it does not, say so in the report and explain it. Do not hide it.
- `updates.md` section 3 lists the limitations to write down (scripted bots, short trials, no damage).

### Custom runs

```powershell
pnpm exp -- --preset standard --trials 5 --duration 10 --delays "50,150" --jitters "0,30" --losses "0,0.05" --name my-test --db data/my-test.sqlite
pnpm exp:analyze -- --db data/my-test.sqlite --out data/analysis-my-test
```

Use a different `--name` or `--db` for each custom run so results do not mix with the main database.

### Commands at a glance

| Command | What it does |
| --- | --- |
| `.\scripts\run-all.ps1 [-Preset quick/standard/full] [-Fresh] [-SkipChecks]` | everything |
| `pnpm exp:quick`, `exp:sweep`, `exp:full` | sweep only |
| `pnpm exp:analyze` | analysis only |
| `pnpm exp:reset` | delete the database |
| `pnpm test`, `pnpm typecheck`, `pnpm typecheck:scripts` | checks |
| `pnpm dev` | server + proxy + client for playing by hand |
| `pnpm netctl ...` | change network conditions while playing |

---

## 7. Try it by hand (for a demo)

```powershell
pnpm dev                      # server :8080, proxy :8090, client (Vite)
```

Open two browser windows: `http://localhost:5173/?port=8090&slot=A` and `...?port=8090&slot=B`. Then in another terminal:

```powershell
pnpm netctl set B delay=100 jitter=10 loss=0.05
pnpm netctl stats
pnpm netctl clear
```

Toggle lag compensation by starting the server with `LAG_COMP=0` or `LAG_COMP=1`.
