@echo off
chcp 65001 > nul
where node > nul 2>&1
if errorlevel 1 (
  echo Node.js가 필요합니다. https://nodejs.org 에서 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)

if not exist node_modules (
  echo 필요한 파일을 설치합니다...
  call npm install
  if errorlevel 1 (
    echo 설치하지 못했습니다. 인터넷 연결을 확인해 주세요.
    pause
    exit /b 1
  )
)

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000'"
call npm run dev
