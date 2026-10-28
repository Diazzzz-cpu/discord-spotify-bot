@echo off
title Stop Discord Music Bot
echo Stopping White Monster Energy Drink bot and Lavalink background processes...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'start-background|index\.js') -or ($_.Name -eq 'java.exe' -and $_.CommandLine -match 'Lavalink\.jar') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
if exist "%~dp0data\supervisor.pid" del /f /q "%~dp0data\supervisor.pid"
echo Bot and Lavalink have been stopped.
timeout /t 3 >nul
