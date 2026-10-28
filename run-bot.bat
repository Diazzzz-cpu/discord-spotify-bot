@echo off
title Discord Music Bot - Background Launcher
cd /d "%~dp0"
echo Starting Spotbot + Lavalink in the background...
wscript.exe "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SpotbotStartup.vbs"
echo Done! Spotbot is running silently in the background.
timeout /t 3 >nul
