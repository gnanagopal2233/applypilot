# ApplyPilot launcher for Windows. Right-click -> "Run with PowerShell" (or: powershell -ExecutionPolicy Bypass -File start.ps1)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Install Node.js 20+ from https://nodejs.org first." -ForegroundColor Red; exit 1 }
if (-not (Test-Path node_modules)) {
  Write-Host "First run: installing dependencies..." -ForegroundColor Cyan
  npm install
  npx playwright install chromium
}
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
Write-Host "Building..." -ForegroundColor Cyan
npx next build
Start-Process "http://localhost:3000"
Write-Host "ApplyPilot is running at http://localhost:3000  (Ctrl+C to stop)" -ForegroundColor Green
npx next start -p 3000
