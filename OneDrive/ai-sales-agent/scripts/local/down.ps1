# Stop the local system. Your data is kept.   -Wipe also deletes the local database.
param([switch]$Wipe)
$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$compose = @("compose", "-f", "docker-compose.local.yml", "--env-file", ".env.local", "--profile", "voice")
if ($Wipe) { docker @compose down -v } else { docker @compose down }
