@echo off
setlocal
cd /d "%~dp0"

set "CODEX_PNPM=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"

if exist "%CODEX_PNPM%" goto run_codex_pnpm
where pnpm.cmd >nul 2>nul
if not errorlevel 1 goto run_pnpm
where npm.cmd >nul 2>nul
if not errorlevel 1 goto run_npm

echo Node.js and npm are required.
echo Install Node.js from https://nodejs.org and run this file again.
pause
exit /b 1

:open_browser
start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000'"
exit /b 0

:run_codex_pnpm
call :open_browser
call "%CODEX_PNPM%" dev
goto finish

:run_pnpm
call :open_browser
call pnpm.cmd dev
goto finish

:run_npm
if not exist node_modules (
  echo Installing required packages...
  call npm.cmd install
  if errorlevel 1 goto install_failed
)
call :open_browser
call npm.cmd run dev
goto finish

:install_failed
echo Package installation failed. Check your internet connection.
pause
exit /b 1

:finish
if errorlevel 1 (
  echo The app could not start. Copy this window and send it to Codex.
  pause
)
endlocal
