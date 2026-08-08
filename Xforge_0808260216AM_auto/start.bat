@echo off
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js is not installed. Get it from https://nodejs.org (LTS version) and run this again.
    pause
    exit /b 1
)

if exist .port del .port
start /B node server.js > codex-agent-gui.log 2>&1

set count=0
:waitloop
if exist .port goto found
timeout /t 1 /nobreak >nul
set /a count+=1
if %count% lss 15 goto waitloop

echo Server didn't start. Check codex-agent-gui.log
pause
exit /b 1

:found
set /p PORT=<.port
set URL=http://localhost:%PORT%

set CHROME="%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set CHROMEX86="%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
set EDGE="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"

if exist %CHROME% (
    start "" %CHROME% --new-window "--app=%URL%" --window-size=1180,760
) else if exist %CHROMEX86% (
    start "" %CHROMEX86% --new-window "--app=%URL%" --window-size=1180,760
) else if exist %EDGE% (
    start "" %EDGE% --new-window "--app=%URL%" --window-size=1180,760
) else (
    start "" %URL%
)

echo codex-agent is running at %URL%
echo Close this window to stop the server.
pause
