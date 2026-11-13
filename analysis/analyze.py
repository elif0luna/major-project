"""Phase 10: analysis pipeline.

    python analysis/analyze.py                      # data/experiments.sqlite -> data/analysis/
    python analysis/analyze.py --db data/verify.sqlite --out data/analysis-verify

Reads the SQLite file written by the sweep and produces
  trial_metrics.csv       one row per trial
  condition_summary.csv   mean / sd / 95% CI per condition and compensation mode
  paired_differences.csv  ON - OFF per matched trial pair, with bootstrap 95% CI
  fig_*.png               one figure per metric
  summary.md              the headline tables, ready to paste into the report

Metric definitions (DESIGN.md section 37):
  hit-confirmation accuracy  accepted / attempts, over attempts where the shooter's own screen
                             showed the opponent in a clear line of fire (shooter_saw_hit = 1)
  correction magnitude       mean px distance between predicted and corrected local position,
                             over reconciliations that actually moved the player (> 0.01 px)
  fairness                   |accuracy of low-latency shooter (A) - accuracy of high-latency shooter (B)|
  post-dodge acceptance      accepted shots whose target was no longer on the shot line at the
                             server's current time (hit_now = 0) / all accepted shots
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

import matplotlib # type: ignore

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # type: ignore # noqa: E402
import numpy as np  # type: ignore # noqa: E402
import pandas as pd  # type: ignore # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CORRECTION_EPS_PX = 0.01
BOOT = 10_000
COLORS = {"OFF": "#d1495b", "ON": "#2e86ab"}

METRICS = {
    "hit_accuracy": "Hit-confirmation accuracy",
    "fairness_gap": "Fairness gap |low - high| (accuracy)",
    "post_dodge_rate": "Post-dodge acceptance rate",
    "correction_mean_px": "Mean correction (px)",
    "rewind_mean_ms": "Mean rewind (ms)",
}


def load(db: Path) -> dict[str, pd.DataFrame]:
    con = sqlite3.connect(db)
    try:
        trials = pd.read_sql_query(
            """SELECT t.trial_id, t.run_id, t.trial_number, t.start_time, t.end_time,
                      t.tick_interval_mean_ms, t.tick_interval_max_ms,
                      r.condition_id, r.compensation_mode AS mode
               FROM trial t JOIN experiment_run r USING (run_id)""",
            con,
        )
        cfg = pd.read_sql_query(
            "SELECT run_id, player_id, direction, delay_ms, jitter_ms, loss FROM network_config", con
        )
        hits = pd.read_sql_query(
            """SELECT trial_id, attacker_id, accepted, shooter_saw_hit, hit_now, blocked_by_wall,
                      rejection_reason, rewind_ms FROM hit_event""",
            con,
        )
        corr = pd.read_sql_query(
            "SELECT trial_id, player_id, correction_magnitude AS mag FROM correction_event", con
        )
    finally:
        con.close()
    return {"trials": trials, "cfg": cfg, "hits": hits, "corr": corr}


def trial_metrics(d: dict[str, pd.DataFrame]) -> pd.DataFrame:
    trials, cfg, hits, corr = d["trials"], d["cfg"], d["hits"], d["corr"]

    # Condition parameters = the HIGH-latency player's (slot B) link; slot A is the fixed low-latency player.
    b = cfg[(cfg.player_id == "B") & (cfg.direction == "to_server")]
    b = b.rename(columns={"delay_ms": "delay_ms", "jitter_ms": "jitter_ms"})[["run_id", "delay_ms", "jitter_ms", "loss"]]
    out = trials.merge(b, on="run_id", how="left")

    seen = hits[hits.shooter_saw_hit == 1]
    rows = []
    for tid, g in seen.groupby("trial_id"):
        a_g, b_g = g[g.attacker_id == "A"], g[g.attacker_id == "B"]
        acc_a = a_g.accepted.mean() if len(a_g) else np.nan
        acc_b = b_g.accepted.mean() if len(b_g) else np.nan
        rows.append({
            "trial_id": tid,
            "attempts_seen": len(g),
            "hit_accuracy": g.accepted.mean(),
            "acc_low_latency": acc_a,
            "acc_high_latency": acc_b,
            "fairness_gap": abs(acc_a - acc_b) if len(a_g) and len(b_g) else np.nan,
        })
    out = out.merge(pd.DataFrame(rows), on="trial_id", how="left")

    acc_hits = hits[hits.accepted == 1]
    pdr = acc_hits.groupby("trial_id").apply(lambda g: (g.hit_now == 0).mean(), include_groups=False)
    out = out.merge(pdr.rename("post_dodge_rate"), left_on="trial_id", right_index=True, how="left")
    out = out.merge(hits.groupby("trial_id").rewind_ms.mean().rename("rewind_mean_ms"), left_on="trial_id", right_index=True, how="left")
    out = out.merge(hits.groupby("trial_id").size().rename("attempts_all"), left_on="trial_id", right_index=True, how="left")

    moved = corr[corr.mag > CORRECTION_EPS_PX]
    out = out.merge(moved.groupby("trial_id").mag.mean().rename("correction_mean_px"), left_on="trial_id", right_index=True, how="left")
    out = out.merge(moved.groupby("trial_id").mag.max().rename("correction_max_px"), left_on="trial_id", right_index=True, how="left")
    out = out.merge(moved.groupby("trial_id").size().rename("corrections_n"), left_on="trial_id", right_index=True, how="left")
    out["corrections_n"] = out["corrections_n"].fillna(0)
    out["correction_mean_px"] = out["correction_mean_px"].fillna(0.0)
    out["correction_max_px"] = out["correction_max_px"].fillna(0.0)
    return out.sort_values(["delay_ms", "jitter_ms", "loss", "mode", "trial_number"]).reset_index(drop=True)


def ci95(x: pd.Series) -> tuple[float, float]:
    x = x.dropna()
    if len(x) < 2:
        return (np.nan, np.nan)
    se = x.std(ddof=1) / np.sqrt(len(x))
    return (x.mean() - 1.96 * se, x.mean() + 1.96 * se)


def condition_summary(tm: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (cond, mode), g in tm.groupby(["condition_id", "mode"]):
        row = {"condition_id": cond, "mode": mode, "trials": len(g),
               "delay_ms": g.delay_ms.iloc[0], "jitter_ms": g.jitter_ms.iloc[0], "loss": g.loss.iloc[0]}
        for m in METRICS:
            lo, hi = ci95(g[m])
            row[f"{m}_mean"], row[f"{m}_sd"] = g[m].mean(), g[m].std(ddof=1)
            row[f"{m}_ci_lo"], row[f"{m}_ci_hi"] = lo, hi
        rows.append(row)
    return pd.DataFrame(rows).sort_values(["delay_ms", "jitter_ms", "loss", "mode"]).reset_index(drop=True)


def boot_ci(diff: np.ndarray, rng: np.random.Generator) -> tuple[float, float]:
    diff = diff[~np.isnan(diff)]
    if len(diff) < 2:
        return (np.nan, np.nan)
    means = rng.choice(diff, size=(BOOT, len(diff)), replace=True).mean(axis=1)
    return tuple(np.percentile(means, [2.5, 97.5]))  # type: ignore[return-value]


def paired_differences(tm: pd.DataFrame) -> pd.DataFrame:
    rng = np.random.default_rng(12345)
    rows = []
    wide = tm.pivot_table(index=["condition_id", "trial_number"], columns="mode", values=list(METRICS)).dropna(how="all")
    meta = tm.groupby("condition_id")[["delay_ms", "jitter_ms", "loss"]].first()
    for cond in wide.index.get_level_values(0).unique():
        w = wide.loc[cond]
        for m in METRICS:
            if (m, "ON") not in w or (m, "OFF") not in w:
                continue
            diff = (w[(m, "ON")] - w[(m, "OFF")]).to_numpy(dtype=float)
            valid = diff[~np.isnan(diff)]
            lo, hi = boot_ci(diff, rng)
            rows.append({
                "condition_id": cond, **meta.loc[cond].to_dict(), "metric": m, "pairs": len(valid),
                "mean_off": w[(m, "OFF")].mean(), "mean_on": w[(m, "ON")].mean(),
                "mean_diff_on_minus_off": valid.mean() if len(valid) else np.nan,
                "ci_lo": lo, "ci_hi": hi,
                "significant": bool(len(valid) > 1 and (lo > 0 or hi < 0)),
            })
    return pd.DataFrame(rows).sort_values(["metric", "delay_ms", "jitter_ms", "loss"]).reset_index(drop=True)


def plot_metric(cs: pd.DataFrame, metric: str, out: Path):
    facets = cs[["jitter_ms", "loss"]].drop_duplicates().sort_values(["jitter_ms", "loss"]).to_numpy()
    n = len(facets)
    cols = min(4, n)
    rows = int(np.ceil(n / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(4.2 * cols, 3.4 * rows), squeeze=False, sharey=True)
    for ax, (jit, loss) in zip(axes.ravel(), facets):
        sub = cs[(cs.jitter_ms == jit) & (cs.loss == loss)]
        for mode in ("OFF", "ON"):
            s = sub[sub["mode"] == mode].sort_values("delay_ms")
            if s.empty:
                continue
            y = s[f"{metric}_mean"]
            err = np.vstack([(y - s[f"{metric}_ci_lo"]).fillna(0), (s[f"{metric}_ci_hi"] - y).fillna(0)])
            ax.errorbar(s.delay_ms, y, yerr=err, marker="o", capsize=3, color=COLORS[mode], label=f"compensation {mode}")
        ax.set_title(f"jitter {jit:g} ms, loss {loss:.0%}", fontsize=10)
        ax.set_xlabel("high-latency player: one-way delay (ms)")
        ax.grid(alpha=0.3)
    for ax in axes.ravel()[n:]:
        ax.axis("off")
    axes[0][0].set_ylabel(METRICS[metric])
    axes[0][0].legend(fontsize=8)
    fig.suptitle(METRICS[metric] + " (mean, 95% CI)")
    fig.tight_layout()
    fig.savefig(out, dpi=150)
    plt.close(fig)


def fmt_table(df: pd.DataFrame) -> str:
    return df.to_markdown(index=False) if _has_tabulate() else "```\n" + df.to_string(index=False) + "\n```"


def _has_tabulate() -> bool:
    try:
        import tabulate  # type: ignore # noqa: F401
        return True
    except ImportError:
        return False


def write_summary(tm: pd.DataFrame, cs: pd.DataFrame, pd_: pd.DataFrame, out: Path):
    lines = ["# Experiment summary", ""]
    n_trials = len(tm)
    lines += [f"- Trials analysed: **{n_trials}** across **{tm.condition_id.nunique()}** conditions "
              f"(trials per condition and mode: {tm.groupby(['condition_id', 'mode']).size().min()}-"
              f"{tm.groupby(['condition_id', 'mode']).size().max()})",
              f"- Server tick interval: mean {tm.tick_interval_mean_ms.mean():.2f} ms "
              f"(target {1000 / 30:.2f}), worst single interval {tm.tick_interval_max_ms.max():.0f} ms",
              ""]

    lines += ["## Overall (all conditions pooled)", ""]
    overall = tm.groupby("mode")[list(METRICS)].mean().T
    overall.index = [METRICS[i] for i in overall.index]
    lines += [fmt_table(overall.round(4).reset_index().rename(columns={"index": "metric"})), ""]

    lines += ["## Paired difference ON - OFF per condition", "",
              "Positive accuracy difference = compensation helps. `significant` means the bootstrap 95% CI excludes 0.", ""]
    for m in METRICS:
        sub = pd_[pd_.metric == m][["condition_id", "pairs", "mean_off", "mean_on", "mean_diff_on_minus_off", "ci_lo", "ci_hi", "significant"]]
        if sub.empty:
            continue
        lines += [f"### {METRICS[m]}", "", fmt_table(sub.round(4)), ""]

    cols = ["condition_id", "mode", "trials", "hit_accuracy_mean", "fairness_gap_mean", "post_dodge_rate_mean", "correction_mean_px_mean"]
    lines += ["## Per-condition means", "", fmt_table(cs[cols].round(4)), ""]
    (out / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(ROOT / "data" / "experiments.sqlite"))
    ap.add_argument("--out", default=str(ROOT / "data" / "analysis"))
    args = ap.parse_args()

    db, out = Path(args.db), Path(args.out)
    if not db.exists():
        print(f"database not found: {db}\nrun a sweep first, e.g.  pnpm exp:quick", file=sys.stderr)
        return 1
    out.mkdir(parents=True, exist_ok=True)

    d = load(db)
    if d["trials"].empty:
        print("the database has no trials yet", file=sys.stderr)
        return 1

    tm = trial_metrics(d)
    cs = condition_summary(tm)
    diffs = paired_differences(tm)

    tm.to_csv(out / "trial_metrics.csv", index=False)
    cs.to_csv(out / "condition_summary.csv", index=False)
    diffs.to_csv(out / "paired_differences.csv", index=False)
    for m in METRICS:
        plot_metric(cs, m, out / f"fig_{m}.png")
    write_summary(tm, cs, diffs, out)

    print(f"analysed {len(tm)} trials, {tm.condition_id.nunique()} conditions")
    print(f"wrote CSVs, {len(METRICS)} figures and summary.md to {out}")
    headline = tm.groupby("mode")[["hit_accuracy", "fairness_gap", "post_dodge_rate", "correction_mean_px"]].mean().round(3)
    print(headline.to_string())
    return 0


if __name__ == "__main__":
    sys.exit(main())
