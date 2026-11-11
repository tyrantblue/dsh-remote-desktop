@echo off
rem ===========================================================================
rem  DSH Remote Desktop - Windows agent launcher
rem  Double-click this file to start the agent on this PC.
rem  The file must stay PURE ASCII: cmd.exe uses the OEM code page for console
rem  output, so non-ASCII text would be garbled. Chinese docs: README.zh.md.
rem
rem  Optional cross-NAT relay: put the Harness address (for example
rem  https://your-harness.example.com) on the first line of relay.txt next to
rem  this file. The launcher then appends --relay <address> to the agent.
rem  See README.zh.md section 8.
rem ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title DSH Remote Desktop - Agent for Windows

echo.
echo ===============================================================
echo  DSH Remote Desktop - Windows agent
echo ===============================================================
echo.

if not exist "%~dp0..\remote-agent.mjs" goto :missing_agent

rem ---- 1. find a Node.js runtime -------------------------------------------
set "NODE_CMD="
where node >nul 2>nul
if not errorlevel 1 set "NODE_CMD=node"
if not defined NODE_CMD if exist "%~dp0node\node.exe" set "NODE_CMD=%~dp0node\node.exe"
if not defined NODE_CMD goto :need_node
echo [1/4] Node.js found: %NODE_CMD%
echo.
goto :have_node

:need_node
echo [1/4] Portable Node.js was not found. Downloading it once, about 30 MB...
echo       https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12 } catch { }; $url='https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip'; $zip=Join-Path $env:TEMP 'node-v22.14.0-win-x64.zip'; $tmp=Join-Path $env:TEMP ('dsh-node-' + [guid]::NewGuid().ToString('N')); try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing; New-Item -ItemType Directory -Path $tmp -Force | Out-Null; Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force; $src=Join-Path $tmp 'node-v22.14.0-win-x64'; if (-not (Test-Path (Join-Path $src 'node.exe'))) { throw 'node.exe missing in the archive' }; if (Test-Path '%~dp0node') { Remove-Item -LiteralPath '%~dp0node' -Recurse -Force }; Move-Item -LiteralPath $src -Destination '%~dp0node'; Write-Host '       Download OK.' } catch { Write-Host ('       Download failed: ' + $_.Exception.Message); exit 1 } finally { if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue } }"
if exist "%~dp0node\node.exe" goto :node_ready
goto :node_failed

:node_ready
set "NODE_CMD=%~dp0node\node.exe"
echo       Node.js is ready in "%~dp0node".
echo.

:have_node

rem ---- 2. password file ----------------------------------------------------
echo [2/4] Access password
if exist "%~dp0agent-password.txt" goto :have_password
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$p = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ }); [System.IO.File]::WriteAllText('%~dp0agent-password.txt', $p, (New-Object System.Text.UTF8Encoding -ArgumentList $false))"
if not exist "%~dp0agent-password.txt" goto :password_failed
echo       Created a random password file.

:have_password
echo       Password file: "%~dp0agent-password.txt"
echo.

rem ---- 3. optional relay for cross-NAT access (relay.txt) ------------------
echo [3/4] Cross-NAT relay (optional)
set "RELAY_URL="
if not exist "%~dp0relay.txt" goto :relay_missing
for /f "usebackq eol=# tokens=*" %%L in ("%~dp0relay.txt") do if not defined RELAY_URL set "RELAY_URL=%%L"
if not defined RELAY_URL goto :relay_missing
rem allow a quoted value in relay.txt, then trim trailing spaces
set "RELAY_URL=%RELAY_URL:"=%"
:relay_trim
if not defined RELAY_URL goto :relay_missing
if not "%RELAY_URL:~-1%"==" " goto :relay_trimmed
set "RELAY_URL=%RELAY_URL:~0,-1%"
goto :relay_trim

:relay_trimmed
rem a line that starts with '#' after leading spaces is a comment too
if "%RELAY_URL:~0,1%"=="#" goto :relay_missing
if not defined RELAY_URL goto :relay_missing

:relay_ready
echo       Relay server: "%RELAY_URL%"
echo       The agent will connect out to this Harness. In the panel use the
echo       "Relay" mode with the access code printed in the agent log below.
echo.
goto :relay_after

:relay_missing
set "RELAY_URL="
echo       Not configured. If the Harness is NOT on this LAN, write its address
echo       on the first line of "%~dp0relay.txt", for example:
echo         https://your-harness.example.com
echo       Then run start-agent.bat again. LAN direct access works without it.
echo.

:relay_after

rem ---- 4. local IPv4 addresses + connection instructions -------------------
echo [4/4] IPv4 address of this PC on the local network:
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual -ErrorAction Stop | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress }); if ($addrs.Count -eq 0) { Write-Host '      no LAN IPv4 address found - run ipconfig to check' } else { foreach ($addr in $addrs) { Write-Host ('      - ' + $addr) } } } catch { ipconfig | Select-String 'IPv4' }"
echo.
echo  How to connect:
echo.
echo    A. Same LAN - direct connection (always available):
echo       1. Open the DSH Web UI and the "Remote Desktop" panel.
echo       2. Add a host: one of the IPv4 addresses above, TCP port 38080.
echo          For example: 192.168.1.23:38080
echo       3. Enter the password from "%~dp0agent-password.txt".
echo.
if defined RELAY_URL goto :connect_relay_ready
echo    B. Different networks - relay: NOT configured.
echo       To enable it, write the Harness address into "%~dp0relay.txt" and run
echo       start-agent.bat again (see [3/4] above and README section 8).
echo.
goto :connect_relay_done

:connect_relay_ready
echo    B. Different networks - relay via "%RELAY_URL%":
echo       1. Wait for the agent log below to print "[relay] connected" and the
echo          access code.
echo       2. In the panel add a host in "Relay" mode: access code + password.
echo       3. The access code changes on every start unless --relay-code is
echo          given; no router port forwarding is needed.

:connect_relay_done
echo.
echo  Notes:
echo    - Keep this window open while the panel is connected.
echo    - Direct mode: if Windows Firewall asks, click "Allow access".
echo      Private networks are enough; never expose port 38080 to the Internet.
echo    - Relay mode only makes outbound connections, so no firewall rule and no
echo      port forwarding are needed.
echo    - Press Ctrl+C in this window to stop the agent gracefully.
echo      If Ctrl+C does not stop it, run stop-agent.bat.
echo.
echo  Starting the agent on port 38080 ...
echo.

if defined RELAY_URL goto :run_with_relay
"%NODE_CMD%" "%~dp0..\remote-agent.mjs" --port 38080 --bind 0.0.0.0 --fs-root "%USERPROFILE%" --password-file "%~dp0agent-password.txt"
set "AGENT_EXIT=%ERRORLEVEL%"
goto :agent_stopped

:run_with_relay
"%NODE_CMD%" "%~dp0..\remote-agent.mjs" --port 38080 --bind 0.0.0.0 --fs-root "%USERPROFILE%" --password-file "%~dp0agent-password.txt" --relay "%RELAY_URL%"
set "AGENT_EXIT=%ERRORLEVEL%"

:agent_stopped
echo.
echo Agent stopped, exit code %AGENT_EXIT%.
if not "%AGENT_EXIT%"=="0" echo If it failed, check: netstat -ano and look for port 38080, or read the error above.
if defined RELAY_URL echo If the relay failed, look for "[relay] connect failed" above and check relay.txt.
echo.
pause
exit /b %AGENT_EXIT%

:missing_agent
echo ERROR: "%~dp0..\remote-agent.mjs" was not found.
echo Keep this .bat file inside the agent\windows folder of the DSH remote
echo desktop package, then run it again.
echo.
pause
exit /b 1

:node_failed
echo.
echo ERROR: the portable Node.js download did not finish.
echo.
echo Do it manually:
echo   1. Download this file in a browser:
echo        https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip
echo   2. Extract the zip and rename the extracted folder to "node" so that
echo      this file exists:
echo        %~dp0node\node.exe
echo   3. Run start-agent.bat again.
echo.
echo You can also install the official Node.js LTS from https://nodejs.org/
echo and make sure "node" works in the command prompt.
echo.
pause
exit /b 1

:password_failed
echo ERROR: could not create "%~dp0agent-password.txt".
echo Check that this folder is writable, then run start-agent.bat again.
echo.
pause
exit /b 1
