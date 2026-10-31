@echo off
chcp 65001 >nul
title Sistema EAG (modo local) - nao feche esta janela
cd /d "%~dp0"

if not exist "server\node_modules" (
  echo Instalando dependencias pela primeira vez - precisa de internet...
  call npm install
  pushd server
  call npm install
  popd
  pushd client
  call npm install
  popd
)

if not exist "server\.env.local" (
  echo.
  echo Falta o arquivo server\.env.local.
  echo Copie server\.env.local.example para server\.env.local e preencha o administrador.
  pause
  exit /b 1
)

call npm run local
pause
