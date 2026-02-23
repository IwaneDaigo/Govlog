param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$healthUrl = "http://127.0.0.1:8000/health"
$maxAttempts = 120

if ($DryRun) {
  Write-Host "[dev:api:similarity] dry-run OK"
  exit 0
}

Write-Host "[dev:api:similarity] waiting for Python similarity API: $healthUrl"

for ($i = 1; $i -le $maxAttempts; $i++) {
  try {
    $res = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
    if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 500) {
      Write-Host "[dev:api:similarity] similarity API is ready."
      break
    }
  }
  catch {
    # keep waiting
  }

  if ($i -eq $maxAttempts) {
    throw "Similarity API did not become ready within $maxAttempts seconds."
  }

  Start-Sleep -Seconds 1
}

Push-Location $projectRoot
try {
  $env:SIMILARITY_API_BASE_URL = "http://127.0.0.1:8000"
  pnpm --filter @gov-sync/api dev
}
finally {
  Pop-Location
}
