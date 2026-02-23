param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pythonSimilarityDir = Join-Path $projectRoot "python-similarity"

$pythonCandidates = @(
  (Join-Path $projectRoot ".venv\Scripts\python.exe"),
  (Join-Path $pythonSimilarityDir ".venv\Scripts\python.exe")
)

$pythonExe = $null
foreach ($candidate in $pythonCandidates) {
  if (Test-Path $candidate) {
    $pythonExe = $candidate
    break
  }
}

if (-not $pythonExe) {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) {
    $pythonExe = "python"
  }
}

if (-not $pythonExe) {
  throw "Python executable was not found. Create .venv or install python on PATH."
}

Write-Host "[dev:python] using Python: $pythonExe"

if ($DryRun) {
  exit 0
}

Push-Location $pythonSimilarityDir
try {
  & $pythonExe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
}
finally {
  Pop-Location
}
