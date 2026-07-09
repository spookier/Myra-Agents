@echo off
setlocal

set "REPO=C:\Users\w202418\.copilot\repos\Myra-Agents"

cd /d "%REPO%" || (
  echo Could not find repository at:
  echo   %REPO%
  pause
  exit /b 1
)

where bun >nul 2>&1 || (
  echo Bun is not installed or not on PATH.
  echo Install it first: https://bun.sh/
  pause
  exit /b 1
)

if not exist "packages\shared\package.json" (
  echo Initializing git submodules...
  git submodule update --init || goto :fail
)

if not exist "node_modules" (
  echo Installing dependencies...
  call bun install || goto :fail
)

echo Launching Myra Agents...
call bun run tauri:dev
goto :eof

:fail
echo.
echo Launch failed.
pause
exit /b 1
