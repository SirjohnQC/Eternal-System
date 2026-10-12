@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ---------------------------------------------------------------------
rem  Switch to and update a version of the game.
rem
rem    pull-claude.bat main     stable: main, fast-forwarded
rem    pull-claude.bat test     test build: test/latest (all open work,
rem                             rebuilt by Claude - reset to the remote)
rem    pull-claude.bat claude   newest origin/claude/* branch
rem    pull-claude.bat <name>   any branch, e.g. fix/planet-view-live-refresh
rem    pull-claude.bat          asks which one
rem ---------------------------------------------------------------------

set "MODE=%~1"
if "%MODE%"=="" (
  echo.
  echo  Which version?
  echo    [1] Stable      - main
  echo    [2] Test build  - test/latest, all open work combined
  echo    [3] Newest Claude branch - origin/claude/*
  echo.
  set /p "PICK=  Choose [1-3]: "
)
if "%MODE%"=="" (
  if "%PICK%"=="1" set "MODE=main"
  if "%PICK%"=="2" set "MODE=test"
  if "%PICK%"=="3" set "MODE=claude"
)
if "%MODE%"=="" (
  echo No choice made.
  exit /b 1
)

echo.
echo Fetching origin...
git fetch origin --prune
if errorlevel 1 (
  echo Fetch failed.
  exit /b 1
)

set "TARGET="
set "RESET="
if /i "%MODE%"=="main" (
  set "TARGET=origin/main"
) else if /i "%MODE%"=="test" (
  set "TARGET=origin/test/latest"
  set "RESET=1"
) else if /i "%MODE%"=="claude" (
  for /f "delims=" %%b in ('git for-each-ref --sort=-committerdate --count=1 "--format=%%(refname:short)" refs/remotes/origin/claude/') do set "TARGET=%%b"
) else (
  set "TARGET=origin/%MODE%"
)

if "%TARGET%"=="" (
  echo No matching remote branch found.
  exit /b 1
)
git rev-parse --verify "%TARGET%" >nul 2>&1
if errorlevel 1 (
  echo Remote branch %TARGET% not found.
  exit /b 1
)
rem The local branch has the same name, without "origin/".
set "LOCAL=%TARGET:origin/=%"

echo.
echo Target: %TARGET%
git --no-pager log -1 --format="  last commit: %%h %%s (%%cr)" "%TARGET%"

rem Never switch or reset over uncommitted work.
git diff --quiet
if errorlevel 1 goto dirty
git diff --cached --quiet
if errorlevel 1 goto dirty

for /f %%i in ('git rev-parse HEAD') do set "BEFORE=%%i"
for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD') do set "CURRENT=%%i"

if defined RESET (
  rem The test build is disposable: make the local branch match the remote exactly.
  git checkout -B "%LOCAL%" "%TARGET%"
  if errorlevel 1 goto failed
  git branch --set-upstream-to="%TARGET%" >nul 2>&1
  goto done
)

if /i not "%CURRENT%"=="%LOCAL%" (
  git show-ref --verify --quiet "refs/heads/%LOCAL%"
  if errorlevel 1 (
    git checkout -b "%LOCAL%" --track "%TARGET%"
    if errorlevel 1 goto failed
    goto done
  )
  git checkout "%LOCAL%"
  if errorlevel 1 goto failed
)

git merge-base --is-ancestor HEAD "%TARGET%"
if errorlevel 1 (
  echo.
  echo Your %LOCAL% has commits that %TARGET% does not have, so it cannot fast-forward.
  echo Commits only on your side:
  git --no-pager log --oneline "%TARGET%..HEAD"
  echo Resolve manually, e.g.:  git merge %TARGET%
  exit /b 1
)
git merge --ff-only "%TARGET%"
if errorlevel 1 goto failed

:done
for /f %%i in ('git rev-parse HEAD') do set "AFTER=%%i"
echo.
if "%BEFORE%"=="%AFTER%" (
  echo Already up to date at %AFTER:~0,7% on %LOCAL%.
) else (
  echo Now on %LOCAL%: %BEFORE:~0,7% -^> %AFTER:~0,7%
)

rem Dependencies changed? Install them.
git diff --quiet %BEFORE% %AFTER% -- package.json package-lock.json
if errorlevel 1 (
  echo.
  echo package.json changed - running npm install...
  call npm install
)

echo.
git --no-pager status -sb
echo.
echo Restart the dev server and hard-refresh the browser (Ctrl+F5).
echo The menu and Settings show the build: vX.Y.Z and the commit.
endlocal
exit /b 0

:dirty
echo.
echo You have uncommitted changes. Commit or stash them first:
git --no-pager status --short
exit /b 1

:failed
echo.
echo Git could not switch or update. A local edit may clash with an incoming
echo file; see the message above. "git status" shows what is modified.
exit /b 1
