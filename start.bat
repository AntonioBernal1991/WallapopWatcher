@echo off
title Wallapop Watcher
cd /d "%~dp0"
echo.
echo   Vigilando Wallapop. Cierra esta ventana o pulsa Ctrl+C para parar.
echo.
node watcher.js
pause
