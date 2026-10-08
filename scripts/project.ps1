param(
  [ValidateSet('install', 'dev', 'typecheck', 'test', 'build', 'start', 'worker', 'doctor')]
  [string]$Action = 'dev'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
Push-Location -LiteralPath $taskRoot
try {
  $taskPnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if (-not $taskPnpm) { $taskPnpm = Get-Command pnpm -ErrorAction SilentlyContinue }
  if ($taskPnpm) {
    $taskManagerPath = $taskPnpm.Source
  } else {
    $taskManagerPath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
    if (-not (Test-Path -LiteralPath $taskManagerPath)) {
      throw 'pnpm not found. Install Node.js 24 and pnpm 11, then retry. See README.md.'
    }
  }
  if ($Action -eq 'install') { & $taskManagerPath install --frozen-lockfile }
  else { & $taskManagerPath run $Action }
  if ($LASTEXITCODE -ne 0) { throw "Project command failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
