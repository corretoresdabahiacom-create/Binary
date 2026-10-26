@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Trade AI Core - monitor (feche esta janela para parar)
where node >nul 2>nul || (echo [ERRO] Node.js nao encontrado. Instale a versao 20 ou superior em https://nodejs.org e rode de novo. & pause & exit /b 1)
for /f "tokens=1 delims=." %%v in ('node -v') do set NV=%%v
set NV=%NV:v=%
if %NV% LSS 20 (echo [ERRO] Node.js %NV% detectado; e preciso 20 ou superior. & pause & exit /b 1)
if not exist node_modules (echo Instalando dependencias... & call npm install --omit=dev || (echo [ERRO] npm install falhou. & pause & exit /b 1))
echo O monitor continua rodando mesmo com o navegador fechado. Para parar, feche esta janela.
start "" http://localhost:3000
node server/index.js
pause
