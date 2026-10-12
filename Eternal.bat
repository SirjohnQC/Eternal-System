@echo off
rem ============================================================
rem  Eternal System: Genesis - easy launcher
rem  Double-click this file, or run it from a terminal.
rem ============================================================
title Eternal System: Genesis
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found on your PATH.
  echo  Install the LTS version from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo  First run detected - installing dependencies, one time only...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  Dependency install failed. See the messages above.
    pause
    exit /b 1
  )
)

:menu
cls
set "BRANCH=(not a git checkout)"
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
echo ============================================
echo    ETERNAL SYSTEM: GENESIS
echo ============================================
echo    Version: %BRANCH%
echo.
echo    [1]  Play       - opens the game in your browser
echo    [2]  Run tests  - the full test suite
echo    [3]  Build      - production bundle into dist
echo    [4]  Update     - switch version: stable, test build, newest Claude
echo    [5]  Quit
echo.
set /p "choice=  Choose an option [1-5]: "

if "%choice%"=="1" goto play
if "%choice%"=="2" goto test
if "%choice%"=="3" goto build
if "%choice%"=="4" goto update
if "%choice%"=="5" exit /b 0
goto menu

:play
cls
echo  Starting the game - a browser tab will open automatically.
echo  Leave this window open while you play.
echo  Press Ctrl+C here then Y to stop the server and return.
echo.
call npm run dev
echo.
echo  Server stopped.
pause
goto menu

:test
cls
echo  Running the test suite...
echo.
call npm test
echo.
pause
goto menu

:build
cls
echo  Building the production bundle...
echo.
call npm run build
echo.
pause
goto menu

:update
cls
where git >nul 2>nul
if errorlevel 1 (
  echo  Git was not found on your PATH. Install it from https://git-scm.com/ first.
  pause
  goto menu
)
rem One block, read at once: the update may rewrite this file, so nothing
rem after it is read from disk; the launcher restarts as the new version.
(
  call "%~dp0pull-claude.bat"
  echo.
  echo  Restarting the launcher so it runs the updated version...
  pause
  start "" "%~f0"
  exit
)
