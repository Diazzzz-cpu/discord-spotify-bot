@echo off
title Discord Music Bot Launcher
echo ===================================================
echo   Discord Music Bot + Lavalink Launcher
echo ===================================================

echo [1/2] Starting Lavalink audio server in a separate window...
start "Lavalink Audio Server" cmd /k "cd /d "%~dp0lavalink" && java -jar Lavalink.jar"

echo [2/2] Waiting 6 seconds for Lavalink to initialize...
timeout /t 6 /nobreak >nul

echo Starting Discord Bot...
start "Discord Music Bot" cmd /k "cd /d "%~dp0" && npm start"

echo.
echo Both services have been launched in separate windows!
echo Keep both windows open while using the bot.
pause
