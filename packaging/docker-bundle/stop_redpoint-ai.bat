@echo off
REM RedpointAI - stop launcher. Truly stops the stack (docker compose down), so it
REM won't auto-restart with Docker. Your data is kept (SQLite lives in a named volume).
cd /d "%~dp0"
title RedpointAI - Stop

echo(
echo   Stopping RedpointAI...
docker compose down --remove-orphans
REM Sweep any lingering container of OURS that compose down missed - identified by the compose
REM project label, or by one of our four exact images for bundles that predate
REM COMPOSE_PROJECT_NAME (their containers were named after the extraction folder). Same
REM identity set as start's sweep and the image prune - trailing colons included, so a rep's
REM "rp-ai-server-experiment:1.0" container is not matched. Deliberately ours-only: stopping
REM the RedpointAI stack is no reason to touch someone else's container, even one on our ports.
for /f %%i in ('docker ps -aq --filter "label=com.docker.compose.project=redpointai"') do docker rm -f %%i >nul 2>&1
for /f "tokens=1" %%i in ('docker ps -a --format "{{.ID}} {{.Image}}" 2^>nul ^| findstr /c:" rp-ai-server:" /c:" rp-ai-web:" /c:" rp-ai-mcp-rpi:" /c:" rp-ai-mcp-drh:"') do docker rm -f %%i >nul 2>&1
echo(
echo   RedpointAI is stopped. Your data is kept.
echo   Double-click start_redpoint-ai.bat to run it again.
echo(
pause
