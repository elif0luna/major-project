// Phases 9 + 11: the deterministic experiment harness and sweep runner.
//
//   pnpm exp:quick                       pipeline check (~3 min)
//   pnpm exp:sweep                       standard sweep (~1.2 h)
//   pnpm exp:full                        full sweep (~5 h)
//   pnpm exp -- --preset standard --trials 5 --duration 10 --delays 50,150 --jitters 0 --losses 0,0.05
//
// For every condition and trial number it runs a MATCHED pair: compensation OFF and ON with the
// same bot input scripts, the same initial state and the same proxy random streams. OFF and ON
// stacks are alternated trial by trial (and the order flips every trial) so slow drift in machine
// load hits both equally. Results go to SQLite; the run is resumable (finished trials are skipped).
import { resolve } from "node:path";
import {
  HISTORY_DURATION_MS, INTERPOLATION_DELAY_MS, TICK_RATE,
} from "../../shared/src/index";
import { Bot } from "./bot";
import { DIRECTION_OFFSET, PRESETS, directionSeed, grid, moveSeed, runSeed, trialSeed, type Condition } from "./conditions";
import { ExperimentDb, type CorrectionRow, type HitRow, type NetworkConfigRow } from "./db";
import { ROOT, Stack, http, sleep } from "./stack";

type Mode = "OFF" | "ON";
type Slot = "A" | "B";

// ---------------- CLI ----------------
function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = "true";
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}
const nums = (s: string) => s.split(/[,\s]+/).filter(Boolean).map(Number);

const args = parseArgs(process.argv.slice(2));
const presetName = args.preset ?? "quick";
const preset = PRESETS[presetName];
if (!preset) {
  console.error(`unknown preset "${presetName}". Available: ${Object.keys(PRESETS).join(", ")}`);
  process.exit(1);
}
const trials = Number(args.trials ?? preset.trials);
const durationSec = Number(args.duration ?? preset.durationSec);
const conditions: Condition[] = grid(
  args.delays ? nums(args.delays) : preset.delays,
  args.jitters ? nums(args.jitters) : preset.jitters,
  args.losses ? nums(args.losses) : preset.losses,
);
const baseSeed = Number(args.seed ?? 1234);
const sweepName = args.name ?? `${presetName}-s${baseSeed}`;
const dbPath = resolve(ROOT, args.db ?? "data/experiments.sqlite");
const basePort = Number(args["base-port"] ?? 8100);

if (![trials, durationSec, baseSeed, basePort].every(Number.isFinite) || trials < 1 || durationSec < 1 || conditions.length === 0) {
  console.error("invalid arguments (trials/duration must be >= 1 and the condition grid must not be empty)");
  process.exit(1);
}

// ---------------- one trial ----------------
interface TrialResult {
  startTime: number;
  endTime: number;
  initialState: unknown;
  tickMean: number;
  tickMax: number;
  hits: HitRow[];
  corrections: CorrectionRow[];
  extras: unknown;
}

async function runTrial(stack: Stack, cond: Condition, runId: string, rs: number, trialNumber: number): Promise<TrialResult> {
  const trialId = `${runId}:t${trialNumber}`;
  await stack.waitIdle();

  // Per-trial proxy streams: identical for the OFF and ON trial of a pair.
  const cfg = (p: Condition["a"], upOff: number, downOff: number) => ({
    toServer: { ...p, seed: trialSeed(directionSeed(rs, upOff), trialNumber) },
    toClient: { ...p, seed: trialSeed(directionSeed(rs, downOff), trialNumber) },
  });
  await http("PUT", `${stack.proxyApi}/config`, {
    players: {
      A: cfg(cond.a, DIRECTION_OFFSET.A_toServer, DIRECTION_OFFSET.A_toClient),
      B: cfg(cond.b, DIRECTION_OFFSET.B_toServer, DIRECTION_OFFSET.B_toClient),
    },
  });
  await http("POST", `${stack.proxyApi}/stats/reset`);

  // Slot A connects first so it always becomes player id 1 (and B id 2).
  const bots: Record<Slot, Bot> = {
    A: new Bot(`${stack.proxyUrl}/?slot=A`, moveSeed(baseSeed, trialNumber, "A"), "A"),
    B: new Bot(`${stack.proxyUrl}/?slot=B`, moveSeed(baseSeed, trialNumber, "B"), "B"),
  };
  try {
    await bots.A.connect();
    await bots.B.connect();
    bots.A.startPings();
    bots.B.startPings();

    // Warm-up: no inputs, so both players are still on their spawn points. Wait for the ping burst
    // to finish and the clock offset + first snapshots to exist.
    const warmDeadline = Date.now() + 15_000;
    await sleep(1000);
    while (!(bots.A.synced && bots.B.synced)) {
      if (Date.now() > warmDeadline) throw new Error("clock sync did not converge");
      await sleep(50);
    }
    await sleep(300);

    const initialState = { tick: bots.A.latest!.tick, players: bots.A.latest!.players.map(({ id, x, y, vx, vy }) => ({ id, x, y, vx, vy })) };

    await http("POST", `${stack.serverApi}/trial/begin`, { trialId });
    const startTime = Date.now();
    bots.A.startInputs();
    bots.B.startInputs();
    await sleep(durationSec * 1000);
    bots.A.stopInputs();
    bots.B.stopInputs();
    // Let in-flight messages (and their shot events) arrive before closing the books.
    const drain = 500 + 4 * Math.max(cond.a.delayMs, cond.b.delayMs) + 4 * Math.max(cond.a.jitterMs, cond.b.jitterMs);
    await sleep(drain);

    const rec = await http<{
      shots: {
        tick: number; attackerId: number; targetId: number | null; inputSeq: number; clientTime: number;
        estimatedServerTime: number; rewindTime: number; targetX: number | null; targetY: number | null;
        accepted: boolean; hitNow: boolean; blockedByWall: boolean; rewindMs: number; rejectionReason: string;
      }[];
      ticks: number; tickIntervalMeanMs: number; tickIntervalMaxMs: number;
    }>("POST", `${stack.serverApi}/trial/end`);
    const endTime = Date.now();
    const proxyStats = await http("GET", `${stack.proxyApi}/stats`);

    const slotOf = (id: number): Slot => (id === 1 ? "A" : "B");
    const hits: HitRow[] = rec.shots
      .filter((s) => s.targetId !== null)
      .map((s) => ({
        tick: s.tick,
        attackerId: slotOf(s.attackerId),
        targetId: slotOf(s.targetId!),
        inputSeq: s.inputSeq,
        clientTime: s.clientTime,
        estimatedServerTime: s.estimatedServerTime,
        rewindTime: s.rewindTime,
        targetX: s.targetX ?? 0,
        targetY: s.targetY ?? 0,
        accepted: s.accepted,
        rejectionReason: s.rejectionReason,
        shooterSawHit: bots[slotOf(s.attackerId)].shotLog.get(s.inputSeq)?.sawHit ?? null,
        hitNow: s.hitNow,
        blockedByWall: s.blockedByWall,
        rewindMs: s.rewindMs,
      }));

    const corrections: CorrectionRow[] = (["A", "B"] as Slot[]).flatMap((slot) =>
      bots[slot].corrections.map((c) => ({ playerId: slot, ...c })),
    );

    const botInfo = (b: Bot) => ({
      inputsSent: b.inputsSent, firesSent: b.firesSent, snapshots: b.snapshots,
      rttMs: b.clock.rtt, offsetMs: b.clock.offset,
    });
    return {
      startTime, endTime, initialState,
      tickMean: rec.tickIntervalMeanMs, tickMax: rec.tickIntervalMaxMs,
      hits, corrections,
      extras: { proxy: proxyStats, bots: { A: botInfo(bots.A), B: botInfo(bots.B) }, serverTicks: rec.ticks },
    };
  } finally {
    bots.A.close();
    bots.B.close();
  }
}

// ---------------- sweep ----------------
const fmt = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

async function main() {
  const db = new ExperimentDb(dbPath);
  const stacks: Record<Mode, Stack> = {
    OFF: new Stack("OFF", false, { server: basePort, serverControl: basePort + 1, proxy: basePort + 2, proxyControl: basePort + 3 }),
    ON: new Stack("ON", true, { server: basePort + 10, serverControl: basePort + 11, proxy: basePort + 12, proxyControl: basePort + 13 }),
  };

  console.log(`sweep "${sweepName}": ${conditions.length} conditions x ${trials} trials x 2 modes, ${durationSec} s each`);
  console.log(`database: ${dbPath}`);
  const estimate = conditions.length * trials * 2 * (durationSec + 5);
  console.log(`estimated time: ~${fmt(estimate)}  (Ctrl+C is safe; re-run the same command to resume)\n`);

  let stopping = false;
  process.on("SIGINT", () => { stopping = true; console.log("\nstopping after the current trial..."); });

  try {
    await Promise.all([stacks.OFF.start(), stacks.ON.start()]);
    const health = await http<{ historyDurationMs: number }>("GET", `${stacks.ON.serverApi}/health`);

    const runIds = new Map<string, string>();
    for (const cond of conditions) {
      const rs = runSeed(baseSeed, cond.id);
      for (const mode of ["OFF", "ON"] as Mode[]) {
        const runId = `${sweepName}:${cond.id}:${mode}`;
        runIds.set(`${cond.id}:${mode}`, runId);
        if (db.hasRun(runId)) continue;
        const configs: NetworkConfigRow[] = [];
        for (const [slot, p, up, down] of [
          ["A", cond.a, DIRECTION_OFFSET.A_toServer, DIRECTION_OFFSET.A_toClient],
          ["B", cond.b, DIRECTION_OFFSET.B_toServer, DIRECTION_OFFSET.B_toClient],
        ] as const) {
          configs.push({ playerId: slot, direction: "to_server", delayMs: p.delayMs, jitterMs: p.jitterMs, loss: p.loss, seed: directionSeed(rs, up) });
          configs.push({ playerId: slot, direction: "to_client", delayMs: p.delayMs, jitterMs: p.jitterMs, loss: p.loss, seed: directionSeed(rs, down) });
        }
        db.insertRun({
          runId, createdAt: new Date().toISOString(), mode, tickRate: TICK_RATE, randomSeed: rs,
          interpolationDelayMs: INTERPOLATION_DELAY_MS, historyDurationMs: health.historyDurationMs ?? HISTORY_DURATION_MS,
          notes: JSON.stringify({ sweep: sweepName, preset: presetName, durationSec, baseSeed, damage: false }),
          conditionId: cond.id,
        }, configs);
      }
    }

    const total = conditions.length * trials * 2;
    let done = 0;
    const t0 = Date.now();
    for (let n = 1; n <= trials && !stopping; n++) {
      for (const cond of conditions) {
        // Alternate which mode goes first so neither one is always run on the "fresher" machine.
        const order: Mode[] = n % 2 === 1 ? ["OFF", "ON"] : ["ON", "OFF"];
        for (const mode of order) {
          if (stopping) break;
          const runId = runIds.get(`${cond.id}:${mode}`)!;
          if (db.hasTrial(runId, n)) { done++; continue; }

          let result: TrialResult | null = null;
          for (let attempt = 1; attempt <= 2 && !result; attempt++) {
            try {
              result = await runTrial(stacks[mode], cond, runId, runSeed(baseSeed, cond.id), n);
            } catch (err) {
              console.error(`  trial failed (attempt ${attempt}): ${err instanceof Error ? err.message : err}`);
              await sleep(1000);
            }
          }
          if (!result) throw new Error(`trial ${runId} #${n} failed twice, aborting (completed trials are saved)`);

          db.insertTrial({
            trialId: `${runId}:t${n}`, runId, trialNumber: n, startTime: result.startTime, endTime: result.endTime,
            initialStateJson: JSON.stringify(result.initialState), tickIntervalMeanMs: result.tickMean,
            tickIntervalMaxMs: result.tickMax, extrasJson: JSON.stringify(result.extras),
          }, result.hits, result.corrections);

          done++;
          const acc = result.hits.length ? result.hits.filter((h) => h.accepted).length / result.hits.length : NaN;
          const elapsed = (Date.now() - t0) / 1000;
          const eta = (elapsed / Math.max(1, done)) * (total - done);
          console.log(
            `[${done}/${total}] ${cond.id} ${mode} #${n}: ${result.hits.length} shots, ${(acc * 100).toFixed(0)}% accepted, ` +
            `${result.corrections.length} corrections, tick ${result.tickMean.toFixed(1)}/${result.tickMax.toFixed(0)} ms  (ETA ${fmt(eta)})`,
          );
        }
      }
    }
    console.log(stopping ? "\nstopped early; progress is saved." : "\nsweep finished.");
  } finally {
    await Promise.all([stacks.OFF.stop(), stacks.ON.stop()]);
    db.close();
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
