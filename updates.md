# Updates

A running log of the work done on the project after the mid-term report, newest phase last. Each entry says what changed, why, and how it was checked.

---

## 1. Audit of Phases 0 to 6 against the mid-term report

The code was compared with `docs/Phases.docx` and `docs/major_project_midTerm_report.docx`. Phases 0 to 6 worked, but several things described as complete were not true in the code.

### Fixed in the code

| Problem | Fix |
| --- | --- |
| `server/src/lagcomp.ts` was an empty file; history lived inside `game.ts` | History and rewind moved into `lagcomp.ts` (`StateHistory`) |
| Shots older than the history were silently clamped to the oldest entry. DESIGN.md forbids this and the report says they are rejected | Such shots are now not compensated and are judged against the current state (`compensated: false`) |
| A player who had just respawned could be hit at the spot where they died | Rewind skips players who were dead at the rewound time |
| The server accepted any number of players; the report says two | `MAX_PLAYERS = 2`, a third connection is closed with code 1013 "server full" |
| Hit radius was 18; the report says 16 | `SHOT_RADIUS = PLAYER_RADIUS` (16) |
| Constant names differed from the report | `HISTORY_DURATION_MS = 1000`, `INTERPOLATION_DELAY_MS = 100` |
| `pnpm smoke` printed nothing and exited 0 when the server was not running | It now fails with a clear message and a 30 s timeout |
| Turning prediction off left old inputs in the buffer | `Predictor.reset()` |
| Stray `</div>`, unused `<pre id="hud">`, page title "Tag Protocol" | Removed / renamed to "Net Strike" |
| Six empty placeholder files (`admin.ts`, `recoder.ts`, `rooms.ts`, `storage.ts`, `bot.ts`, `lag-proxy.ts`) | Deleted |

### Fixed in the docs

README: removed a leftover chat comment, a broken box diagram, emoji status icons and links to files that do not exist (`PROTOCOL.md`, `docs/phases.md`). Corrected the message discriminator (`t`, not `type`), the movement rules, the tick order and the constants. DESIGN.md: 60 Hz and the old tag-game constants replaced with the shooter's 30 Hz values, with notes where the shipped protocol differs.

### Still wrong in the mid-term report (to correct in the end-term report)

1. The abstract says "This end-term report".
2. §5.3 says movement is persistent when an input is missing. It is not: a tick without input means no movement, which keeps prediction exact (one input = one step on both sides).
3. §6.1 cites `PROTOCOL.md` and `docs/phases.md`, which do not exist.
4. The "four-timestamp" clock sync sends one server time, because the server replies inside the message handler (t1 = t2). Same formula, one sentence of explanation needed.
5. Fig. 7 (ten-step tick order) does not match the code. The real order is in the README.
6. Not stated as a limitation: the server uses each client's self-reported clock offset and `viewDelay` (capped at 500 ms).
7. Phases.docx lists "round reset" for Phase 6; the game has respawn and score, no rounds.

### Verified

Typecheck, 5 server unit tests, client build, `pnpm smoke` against a live server. A throwaway two-bot test at about 220 ms round trip gave 0.000 px prediction error over about 600 reconciliations. With lag compensation ON the server agreed with the shooter's screen on 35/35 shots; with OFF it rejected all 11 shots the shooter saw as hits.

---

## 2. Phase 7: network degradation proxy

### What was built

A standalone Node/TypeScript service in `proxy/`:

```text
Client A --ws--> proxy :8090 (slot A) --ws--> server :8080
Client B --ws--> proxy :8090 (slot B) --ws--> server :8080
                 control API http://127.0.0.1:8091
```

| File | What it does |
| --- | --- |
| `proxy/src/link.ts` | The model for one direction: seeded loss and delay draws, FIFO send times, running stats. No sockets, so it is unit-tested directly |
| `proxy/src/pipe.ts` | FIFO send queue with one timer serving the head of the queue |
| `proxy/src/relay.ts` | Relay slots. Each client gets its own upstream socket to the server, and each slot has two links (`toServer`, `toClient`) |
| `proxy/src/index.ts` | WebSocket listener and HTTP control API (`/health`, `/config`, `/stats`, `/stats/reset`) |
| `proxy/src/rng.ts` | mulberry32 PRNG, FNV-1a hash, Box-Muller normal |
| `proxy/test/link.test.ts` | 12 unit tests |
| `scripts/proxy-check.ts` | End-to-end check through the running proxy (`pnpm proxy:check`) |
| `scripts/netctl.ts` | Terminal tool to change conditions while playing (`pnpm netctl set A delay=100 jitter=10 loss=0.05`) |

The client takes `?port=8090&slot=A` to connect through the proxy, and the HUD shows the route. The old dev-only `?lag=` switch was removed, since the proxy replaces it (the report said it would).

### Design decisions

**Per message, per direction, at the application layer.** The proxy receives whole WebSocket messages and decides for each one, in each direction: drop with probability `loss`, otherwise delay by `max(0, delayMs + Normal(0, jitterMs))`. Nothing is done at the OS or TCP level.

**FIFO.** `sendTime[i] = max(sendTime[i-1], arrival[i] + delay[i])`. A real WebSocket runs over TCP and never reorders, so the proxy must not either. One timer serves the head of each queue. Separate `setTimeout` calls per message can fire out of order when two send times fall within the same millisecond.

**Normal jitter rather than Pareto** (Phases.docx asks for the choice to be justified). A normal distribution has one parameter that matches the usual meaning of "jitter = X ms" (the standard deviation), so conditions are easy to state and to check: the proxy reports the measured mean and sd. Pareto has a more realistic heavy tail, but for shape ≤ 2 its variance is infinite. "30 ms jitter" then has no clear meaning, and 30 trials per condition would be dominated by a few extreme delays. FIFO already gives the delivered delay a right tail: a message that draws a long delay holds back the ones behind it. Heavy-tailed jitter is listed as future work.

**One random stream per message type.** Each direction has a seed, and the proxy derives a separate stream for `input`, `ping` and `snapshot` messages from it. The k-th input of a trial therefore gets the same drop and delay draw in every trial with the same seed, even if pings interleave differently. This is what makes "matched OFF/ON trials reuse the same proxy random stream" (report §4.10) hold in practice.

**Configs are keyed by relay slot (`A`, `B`), not by server player id.** DESIGN.md §23 keys them by player id, but the proxy only learns the id after the server's welcome message, and the harness needs to configure a slot before the bot connects. The structure is otherwise the one in DESIGN.md (`players: Record<string, {toServer, toClient}>`). Any slot name works, so a third player needs no change.

**Config changes** apply only to messages that arrive afterwards. Messages already queued keep their send time. A PUT is validated completely before anything is applied, and every direction it mentions is re-seeded.

### How it was verified

`pnpm test` runs 12 proxy unit tests:

- an ideal link forwards immediately;
- 10 000 messages with 40 ms jitter at 1 ms spacing are never reordered;
- the same seed gives identical drops and delays, and a different seed does not;
- re-applying a config restarts the stream;
- a 10 % loss setting gives 10 % ± 0.6 % drops over 50 000 messages;
- with 100 ± 10 ms configured, the sampled delays measure mean 100 ± 0.3 and sd 10 ± 0.3;
- delay is never negative;
- a config change affects only later arrivals;
- interleaved pings do not change which inputs are dropped;
- invalid configs are rejected;
- the pipe delivers in order with real timers.

`pnpm proxy:check` against the live server and proxy (results from this run):

| Check | Configured | Measured |
| --- | --- | --- |
| RTT with 60 ms each way | ~120 ms | median 125.8 ms |
| Ordering with 50 ± 20 ms jitter, pings 10 ms apart | no reordering | 100/100 pongs and 63/63 snapshots in order |
| RTT spread with jitter | > 5 ms | sd 20.2 ms |
| Snapshot rate with 30 % loss server→client | ~21/s | 20.3/s, gaps but no reordering |
| Proxy's own drop rate | 0.30 | 0.33 |

`pnpm smoke` also passes through the proxy (`PORT=8090`). That run covered ids, clock sync, the 30 Hz rate, input acks, exact movement, a lag-compensated hit and the cooldown.

### Limitations to state in the report

- Loss is application-message loss, not packet loss. Real TCP would retransmit and turn loss into delay.
- Delays have about 1 ms of timer granularity. The measured RTT was about 6 ms above the configured 120 ms; that includes the server's handling and the timer.
- With large jitter, the delivered delay (`actualDelayMs` in `/stats`) is larger than the drawn delay (`drawnDelayMs`), because of FIFO waiting. Report both.

---

## 3. Phases 8-11: instrumentation, harness, analysis, sweep

Your answers to the "Before Phase 8" questions were taken as the proposals in `startup.md` section 10: database at `data/experiments.sqlite` (`data/` is in `.gitignore`), the three schema additions approved, no damage during experiments.

### What was built

| File | Phase | What it does |
| --- | --- | --- |
| `server/src/recorder.ts` | 8 | In-memory buffers for shot records and tick-interval stats. Nothing touches disk during a trial |
| `server/src/game.ts`, `index.ts` | 8 | `onShot` hook, `DAMAGE=0` mode, a localhost control API (`CONTROL_PORT`: `/health`, `/trial/begin`, `/trial/end`), and a fresh deterministic world whenever the last player leaves |
| `scripts/experiment/db.ts` | 8 | SQLite schema (DESIGN.md §33-34 plus the approved additions) and one-transaction-per-trial writes |
| `scripts/experiment/bot.ts` | 9 | Scripted client using the real `Clock`, `Predictor` and `RemoteView`. Seeded vertical strafing in an open lane; fires only with a clear line of sight on what it sees |
| `scripts/experiment/stack.ts` | 9 | Starts/stops a server + proxy pair as child processes |
| `scripts/experiment/conditions.ts` | 9, 11 | Presets, condition grid, seed derivation |
| `scripts/experiment/sweep.ts` | 9, 11 | The harness and sweep runner (resumable) |
| `analysis/analyze.py` | 10 | Metrics, CSVs, figures, `summary.md` |
| `scripts/run-all.ps1` | all | Checks, sweep and analysis in one command |

### How to run it

```powershell
.\scripts\run-all.ps1                       # quick pipeline check, about 3 minutes
.\scripts\run-all.ps1 -Preset standard      # 12 conditions x 10 trials, about 1.2 hours
.\scripts\run-all.ps1 -Preset full          # 16 conditions x 30 trials, about 5 hours
```

Or step by step: `pnpm exp:quick` / `pnpm exp:sweep` / `pnpm exp:full`, then `pnpm exp:analyze`. Custom grid (quote lists in PowerShell):
`pnpm exp -- --preset standard --trials 5 --duration 10 --delays "50,150" --jitters "0,30" --losses "0,0.05"`.
`pnpm exp:reset` deletes the database. Output goes to `data/analysis/` (`summary.md`, `fig_*.png`, CSVs).

### Design decisions

- **Matched pairs.** For each condition and trial number the OFF and ON trials use the same bot movement seeds, the same spawn state and the same proxy streams. Run seed = hash(base seed, condition), independent of the mode; trial seed = run seed + 8 x trial number. The two stacks run side by side and alternate trial by trial, with the order flipping every trial.
- **Two players with unequal links.** Slot A is the low-latency player (10 ms each way, no jitter or loss). Slot B is the high-latency player, and the condition grid varies B's delay, jitter and loss. This is what the fairness metric needs.
- **Server ids map to slots by connect order** (A is always id 1). `player_id` in the database is `A` or `B`, the same names as `network_config`.
- **Metric operationalisation.**
  - Hit-confirmation accuracy: the fraction of shots accepted among those where the shooter's own interpolated screen showed a clear line of fire (`shooter_saw_hit = 1`).
  - Post-dodge acceptance: accepted shots with `hit_now = 0`, divided by all accepted shots.
  - Correction magnitude: averaged over reconciliations that moved the player more than 0.01 px. Every reconciliation is stored.
- **Statistics.** 95% CIs per condition, and a paired ON-OFF difference per condition with a 10 000-resample bootstrap CI.

### Schema additions beyond DESIGN.md §33 (all approved)

`experiment_run.condition_id`; `hit_event.shooter_saw_hit / hit_now / blocked_by_wall / rewind_ms`; `trial.tick_interval_mean_ms / tick_interval_max_ms`. One further column, not on the approved list: `trial.extras_json` (proxy stats and bot counters per trial).

### How it was verified

- `pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm test` (12 proxy + 5 server tests) all pass.
- Two small end-to-end sweeps (8 trials each, deleted afterwards) ran through the real server + proxy + bots. OFF and ON had identical shot counts per pair (for example 28/28, 34/34), so the pairing works. Results in the 8-second runs with 100 ms delay, 20 ms jitter: hit accuracy about 54-65% with compensation OFF and 92-100% with ON. Pooled over the first 8-trial run, fairness gap 0.33 -> 0.06 and post-dodge rate 0 -> 41%.
- `analyze.py` produced the CSVs, five figures and `summary.md` from that data.
- **Not verified:** the `standard` and `full` presets were never run to completion, only the quick-sized runs above. Actual sweep durations are estimates.

### Known limitations to state in the report

- Bots are scripted, not humans. Their aim follows the interpolated view, so they model a competent but not adaptive player.
- Trials last 8-15 s and the lane geometry is fixed; results are specific to this arena and movement model.
- Damage is off in experiments, so kills, respawns and rounds are not exercised.
- Machine load affects timing; tick interval mean/max per trial are stored so noisy trials can be excluded.
- `significant` in `paired_differences.csv` means the bootstrap CI excludes 0; it is not a corrected multiple-comparison test.
