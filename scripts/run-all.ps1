# One command for everything after Phase 7:
#   checks -> experiment sweep (Phases 8, 9, 11) -> analysis (Phase 10)
#
#   .\scripts\run-all.ps1                      # quick pipeline check (~3 min)
#   .\scripts\run-all.ps1 -Preset standard     # ~1.2 hours
#   .\scripts\run-all.ps1 -Preset full         # ~5 hours (16 conditions x 30 trials)
#   .\scripts\run-all.ps1 -Preset standard -Fresh   # delete the old database first
#   .\scripts\run-all.ps1 -SkipChecks          # skip typecheck + unit tests
#
# Re-running the same command resumes: finished trials are skipped.
param(
  [ValidateSet("quick", "standard", "full")] [string]$Preset = "quick",
  [switch]$Fresh,
  [switch]$SkipChecks
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Run($cmd) { Write-Host "> $cmd" -ForegroundColor DarkGray; Invoke-Expression $cmd; if ($LASTEXITCODE) { throw "failed: $cmd" } }

Step "Python packages for the analysis"
Run "python -m pip install -q -r analysis/requirements.txt"

if (-not $SkipChecks) {
  Step "Typecheck + unit tests"
  Run "pnpm typecheck"
  Run "pnpm typecheck:scripts"
  Run "pnpm test"
}

if ($Fresh) { Step "Removing old database"; Run "pnpm exp:reset" }

Step "Experiment sweep: $Preset"
Run "pnpm exp -- --preset $Preset"

Step "Analysis"
Run "pnpm exp:analyze"

Write-Host "`nDone. Open data\analysis\summary.md and the fig_*.png files." -ForegroundColor Green
