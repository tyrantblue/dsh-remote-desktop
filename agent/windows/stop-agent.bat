@echo off
rem ===========================================================================
rem  DSH Remote Desktop - stop the Windows agent (fallback)
rem  The normal way to stop the agent is Ctrl+C in its console window.
rem  Use this file only when that window is gone or Ctrl+C does not work.
rem  Pure ASCII: cmd.exe prints with the OEM code page.
rem ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title DSH Remote Desktop - Stop agent

echo.
echo ===============================================================
echo  DSH Remote Desktop - stop the Windows agent
echo ===============================================================
echo.
echo Normal way: press Ctrl+C in the agent console window.
echo This fallback stops node.exe processes whose command line contains
echo remote-agent.mjs.
echo.

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$targets = @(); try { $targets = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*remote-agent.mjs*' }) } catch { try { $targets = @(Get-WmiObject Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*remote-agent.mjs*' }) } catch { Write-Host ('ERROR: cannot list processes: ' + $_.Exception.Message); exit 2 } }; if ($targets.Count -eq 0) { Write-Host 'No running remote-agent.mjs process found.'; Write-Host 'If the agent window is still open, press Ctrl+C in that window.' } else { foreach ($proc in $targets) { Write-Host ('Stopping PID ' + $proc.ProcessId + ' ...'); try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; Write-Host '  stopped.' } catch { Write-Host ('  failed: ' + $_.Exception.Message) } }; Write-Host ('Done. ' + $targets.Count + ' process(es) matched.') }"

echo.
echo The helper PowerShell process exits by itself when the agent stops.
echo.
pause
exit /b 0
