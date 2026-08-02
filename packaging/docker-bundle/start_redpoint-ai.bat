@echo off
REM RedpointAI - rep double-click launcher. Pin to this script's own folder so it
REM works double-clicked, run-as-admin, or from any prompt. Idempotent / re-runnable.
cd /d "%~dp0"
setlocal enabledelayedexpansion
title RedpointAI

echo(
echo   ==== RedpointAI ====
echo(

REM --- 1. Is Docker running? ---
docker info >nul 2>&1
if errorlevel 1 (
  echo   Docker Desktop is not running.
  echo(
  echo   Install/start Docker Desktop, wait until it says "Engine running",
  echo   then double-click start_redpoint-ai.bat again:
  echo       https://www.docker.com/products/docker-desktop/
  echo(
  pause
  exit /b 1
)

REM --- 2. Clear any prior / old-version stack (no-op on first run). The fixed
REM        COMPOSE_PROJECT_NAME in .env makes this target the same stack always. ---
echo   Clearing any previous RedpointAI stack...
docker compose down --remove-orphans >nul 2>&1
REM Leftover-container sweep, in two passes with DIFFERENT blast radius. The rule: a
REM container is ours only if we can prove it by identity - compose project label, or an
REM rp-ai-* image. Ours gets removed; anything else is never removed, only stopped.
REM
REM Pass 1 - OURS, removed. The label is exact (unlike a name= filter, which substring-
REM matches and would also catch a rep's own "my-redpointai-test"). The image pass then
REM covers bundles that predate COMPOSE_PROJECT_NAME, whose containers were named after
REM the extraction folder: they still run these same four images (older ones a subset).
REM Must run BEFORE the image prune below, or {{.Image}} shows a bare sha256 once the tag
REM is gone. Matched on the four exact repos - the SAME identity set as the prune, not an
REM rp-ai-* prefix - so a rep's own rp-ai-experiment container is not swept up while we
REM carefully spare the image it came from. Each literal keeps its trailing colon: docker
REM renders {{.Image}} as repo:tag, and without the colon " rp-ai-server" would also match
REM a rep's "rp-ai-server-experiment:1.0". Every bundle container is tagged (compose pins
REM image: rp-ai-<svc>:<ver>), and the label pass above independently covers ours.
for /f %%i in ('docker ps -aq --filter "label=com.docker.compose.project=redpointai"') do docker rm -f %%i >nul 2>&1
for /f "tokens=1" %%i in ('docker ps -a --format "{{.ID}} {{.Image}}" 2^>nul ^| findstr /c:" rp-ai-server:" /c:" rp-ai-web:" /c:" rp-ai-mcp-rpi:" /c:" rp-ai-mcp-drh:"') do docker rm -f %%i >nul 2>&1
REM
REM Pass 2 - THEIRS. Whatever still holds 3000-3003 after pass 1 is by definition not ours
REM (a rep's own app, a colleague's database). It has to release the port or we cannot bind,
REM but it does NOT have to be destroyed: docker stop frees the port and is one click to undo,
REM where rm -f would delete the container and any anonymous volume for good. Announced on
REM screen rather than silenced, so the rep can see exactly what we touched.
for /f "tokens=1,2" %%a in ('docker ps --filter "publish=3000" --filter "publish=3001" --filter "publish=3002" --filter "publish=3003" --format "{{.ID}} {{.Names}}"') do (
  echo   Port needed - stopping %%b ^(not RedpointAI; restart it from Docker Desktop^)
  docker stop %%a >nul 2>&1
)

REM --- 3. Load the prebuilt images (idempotent: skip if already present) ---
docker image inspect rp-ai-server:__VERSION__ >nul 2>&1
if errorlevel 1 (
  echo   Loading RedpointAI images ^(one time, ~1-3 min^)...
  docker load -i "%~dp0rp-ai-images.tar"
  if errorlevel 1 (
    echo   Could not load rp-ai-images.tar. Make sure the whole zip was extracted.
    pause
    exit /b 1
  )
) else (
  echo   Images already loaded - skipping.
)

REM Prune orphaned OLD-version RedpointAI images so repeated / upgraded runs don't pile
REM up a fresh set of 4 in Docker Desktop. Runs UNCONDITIONALLY at top level - deliberately
REM NOT inside the if-block above, for two reasons: (1) cmd.exe consumes the single carets
REM on a piped `for /f` in-clause when it sits inside ( ), silently no-op-ing the loop;
REM (2) the load is skipped whenever the current images are already present, yet any old
REM versions must still be cleaned. Scoped to our four exact repositories rather than an
REM rp-ai-* glob, so a rep's own image (rp-ai-experiment) is not swept up; a bare reference=
REM matches every tag of that repo, and same-key filters OR. The current version is excluded
REM and kept; the prior stack's containers are already down (step 2), so removal is safe.
for /f "delims=" %%i in ('docker images --filter "reference=rp-ai-server" --filter "reference=rp-ai-web" --filter "reference=rp-ai-mcp-rpi" --filter "reference=rp-ai-mcp-drh" --format "{{.Repository}}:{{.Tag}}" 2^>nul ^| findstr /v /c:":__VERSION__"') do docker rmi %%i >nul 2>&1

REM --- 4. Start (reload+retry once heals a stale/partial same-tag image without
REM        re-loading the ~1.4 GB tar on every normal launch) ---
echo   Starting containers...
docker compose up -d
if errorlevel 1 (
  echo   First start failed - reloading images and retrying once...
  docker load -i "%~dp0rp-ai-images.tar" >nul 2>&1
  docker compose up -d
)
if errorlevel 1 (
  echo(
  echo   Still could not start - a port ^(3000-3003^) may be held, or Docker is low on resources.
  echo   Restart Docker Desktop, then double-click start_redpoint-ai.bat again.
  echo(
  pause
  exit /b 1
)

REM --- 5. Wait for the web app, then open the browser ---
echo   Waiting for the app to come up ^(first start can take a minute^)...
set /a tries=0
:waitloop
set /a tries+=1
curl -s -o nul http://localhost:3001 && goto ready
if !tries! geq 90 goto timeout
timeout /t 2 /nobreak >nul
goto waitloop

:ready
echo(
echo   All 4 services are up and running:
echo(
echo       server    localhost:3000
echo       web       localhost:3001    ^<- this is the app
echo       mcp-rpi   localhost:3002
echo       mcp-drh   localhost:3003
echo(
start "" "http://localhost:3001"
echo   RedpointAI is running  -^>  http://localhost:3001  ^(opened in your browser^)
echo(
echo   You're all set - you can close this window; RedpointAI keeps running.
echo   To STOP it: double-click  stop_redpoint-ai.bat  (in this folder). Otherwise it
echo   stays running and restarts with Docker - that's intended.
echo(
pause
exit /b 0

:timeout
echo(
echo   The app did not answer on http://localhost:3001 yet.
echo   Give it another minute and open http://localhost:3001 in your browser.
echo(
pause
exit /b 1
