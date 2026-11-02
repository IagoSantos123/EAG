@echo off
chcp 65001 >nul
title Sistema EAG - MODO DE TESTE (porta 3002)
cd /d "%~dp0"

if not exist "server\.env.local" (
  echo Falta o arquivo server\.env.local. Rode o iniciar-local.bat primeiro.
  pause
  exit /b 1
)

call npm run local-teste
pause
