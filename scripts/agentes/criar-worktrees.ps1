# Cria uma worktree por agente, com banco local próprio (cópia do .dados-local) e portas próprias.
# Uso (na raiz do EAG, com o sistema do evento FECHADO):  powershell -ExecutionPolicy Bypass -File scripts\agentes\criar-worktrees.ps1
$ErrorActionPreference = "Stop"
$root = (git rev-parse --show-toplevel).Trim()
Set-Location $root
$pai = Split-Path $root -Parent

$agentes = @(
  @{ nome = "claude"; branch = "agente/claude";      api = 3011; pg = 5452 },
  @{ nome = "agy";    branch = "agente/antigravity"; api = 3021; pg = 5462 }
)

# Copiar o banco com o evento ligado gera cópia inconsistente.
if (Get-NetTCPConnection -LocalPort 5442 -State Listen -ErrorAction SilentlyContinue) {
  Write-Error "O sistema do evento esta aberto (porta 5442). Feche e rode de novo."
}

# rodar-agente.bat não vai para o git (o exclude é compartilhado por todas as worktrees).
$exclude = Join-Path $root ".git\info\exclude"
if (-not (Select-String -Path $exclude -Pattern "rodar-agente.bat" -Quiet)) { Add-Content $exclude "rodar-agente.bat" }

foreach ($a in $agentes) {
  $dir = Join-Path $pai ("EAG-" + $a.nome)
  if (-not (Test-Path $dir)) {
    if (git branch --list $a.branch) { git worktree add $dir $a.branch } else { git worktree add $dir -b $a.branch main }
  }

  # Banco: sempre uma CÓPIA do evento, nunca o original.
  if ((Test-Path "$root\.dados-local\postgres\PG_VERSION") -and -not (Test-Path "$dir\.dados-local")) {
    Copy-Item "$root\.dados-local" "$dir\.dados-local" -Recurse
    Remove-Item "$dir\.dados-local\postgres\postmaster.pid" -ErrorAction SilentlyContinue
  }
  # Só o .env.local (modo local). O server\.env aponta para a nuvem e NÃO é copiado.
  if (Test-Path "$root\server\.env.local") { Copy-Item "$root\server\.env.local" "$dir\server\.env.local" -Force }

  @"
@echo off
chcp 65001 >nul
title EAG - agente $($a.nome) (porta $($a.api))
cd /d "%~dp0"
set PORT=$($a.api)
set LOCAL_PG_PORT=$($a.pg)
call npm run local
pause
"@ | Set-Content "$dir\rodar-agente.bat" -Encoding UTF8

  Write-Host "`n== Instalando dependencias em $dir ==" -ForegroundColor Cyan
  Push-Location $dir
  npm install; npm install --prefix server; npm install --prefix client
  Pop-Location
  Write-Host "OK: $dir  (branch $($a.branch), http://localhost:$($a.api))" -ForegroundColor Green
}
Write-Host "`nPronto. Abra um terminal em ..\EAG-claude (claude) e outro em ..\EAG-agy (agy)."
