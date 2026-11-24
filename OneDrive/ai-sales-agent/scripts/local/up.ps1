# Start the whole system on this computer (Windows PowerShell).
#   scripts\local\up.ps1                          first run also creates .env.local
#   scripts\local\up.ps1 -AdminEmail you@x.com    ... and makes that address a platform admin
#   scripts\local\up.ps1 -Voice                   also start the AI-calls server (needs a tunnel: docs/run-locally.md)
param([string]$AdminEmail = "", [string]$AnthropicKey = "", [switch]$Voice)
$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path "$PSScriptRoot\..\..")

docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Error "Docker is not running. Start Docker Desktop and try again."; exit 1 }

if (-not (Test-Path .env.local)) {
    $a = @("scripts/local/setup.py")
    if ($AdminEmail) { $a += @("--admin-email", $AdminEmail) }
    if ($AnthropicKey) { $a += @("--anthropic-key", $AnthropicKey) }
    python @a
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

$compose = @("compose", "-f", "docker-compose.local.yml", "--env-file", ".env.local")
if ($Voice) { $compose += @("--profile", "voice") }
docker @compose up -d --build
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "Waiting for the API ..."
for ($i = 0; $i -lt 90; $i++) {
    try { if ((Invoke-WebRequest -UseBasicParsing http://localhost:3100/health -TimeoutSec 2).StatusCode -eq 200) { break } } catch { Start-Sleep -Seconds 2 }
}
Write-Host ""
Write-Host "  Dashboard  http://localhost:5180   (create an account here)"
Write-Host "  API        http://localhost:3100"
Write-Host "  Mailpit    http://localhost:8025   (every email the platform sends)"
Write-Host "  Logs       docker compose -f docker-compose.local.yml --env-file .env.local logs -f api scheduler"
Write-Host "  Stop       scripts\local\down.ps1"
