@echo off
rem ===========================================================================
rem  DSH Remote Desktop - start the native Windows GUI
rem
rem  Double-click this file. It starts gui.ps1 with a hidden console; the only
rem  visible window is the WinForms control panel. A console window may flash
rem  for a fraction of a second - that is normal.
rem
rem  -Sta is required by WinForms and by the clipboard. A second launch exits
rem  immediately (gui.ps1 enforces a single instance per user session).
rem
rem  Pure ASCII + CRLF: cmd.exe and Windows PowerShell 5.1 friendly.
rem ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0gui.ps1" goto :missing_gui

start "" powershell.exe -Sta -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0gui.ps1"
exit /b 0

:missing_gui
echo ERROR: gui.ps1 was not found next to start-agent-gui.bat.
echo Reinstall the Windows agent package, then run this file again.
echo.
pause
exit /b 1
