@echo off
rem Git rewrites this very file when it switches versions, and cmd reads a
rem running .bat from disk line by line - so run from a copy in %TEMP%.
if /i not "%~2"=="--from-temp" (
  copy /y "%~f0" "%TEMP%\eternal-pull-claude.bat" >nul
  set "ETERNAL_REPO=%~dp0"
  call "%TEMP%\eternal-pull-claude.bat" "%~1" --from-temp
  exit /b
)
setlocal EnableExtensions
cd /d "%ETERNAL_REPO%"

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

rem Files the launcher itself dirties are not the player's work: npm install
rem rewrites package-lock.json, and Windows line endings made the asset
rem files show as modified. Put them back so they never block an update.
git config core.autocrlf false
git diff --quiet -- package-lock.json
if errorlevel 1 (
  echo  Restoring package-lock.json ^(rewritten by npm install, not your work^).
  git checkout -- package-lock.json
)

rem Your own edits to the game's files never block an update and are never
rem lost: they are put aside (git stash), the version is switched, and they
rem are put back on top. Untracked files (New_Idea.txt, your notes) are never
rem touched by any of this.
set "STASHED="
git diff --quiet
if errorlevel 1 goto stash
git diff --cached --quiet
if errorlevel 1 goto stash
goto stashed

:stash
echo.
echo  Putting your local changes aside while updating:
git --no-pager status --short --untracked-files=no
git stash push -m "Eternal launcher: changes put aside before an update" >nul
if errorlevel 1 (
  echo  Could not put them aside. Nothing was changed.
  exit /b 1
)
set "STASHED=1"

:stashed

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
  call :putback
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

rem Your changes go back before npm runs (npm rewrites package-lock.json).
call :putback

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

:failed
echo.
echo Git could not switch or update; see the message above.
call :putback
exit /b 1

rem Put the changes set aside before the update back on top of the version
rem now checked out. If they clash with what changed, the game is left as the
rem new version, clean, and the changes stay safe in the stash.
:putback
if not defined STASHED exit /b 0
git stash apply >nul 2>&1
if errorlevel 1 (
  git reset --hard -q
  echo.
  echo  Your local changes clash with this version, so they were NOT put back.
  echo  They are kept safe in the stash. To see them:   git stash show -p
  echo  To try putting them back yourself:             git stash pop
  exit /b 0
)
git stash drop -q
echo.
echo  Your local changes were put back on top of this version.
exit /b 0
