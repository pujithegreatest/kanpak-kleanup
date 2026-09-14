@echo off
setlocal
cd /d "%~dp0"
title Kanpak Kleanup - Local Network Demo
set "KANPAK_PYTHON="
where py >nul 2>nul
if not errorlevel 1 set "KANPAK_PYTHON=py -3"
if not defined KANPAK_PYTHON (
    where python >nul 2>nul
    if not errorlevel 1 set "KANPAK_PYTHON=python"
)
if not defined KANPAK_PYTHON (
    echo Install Python 3.11 or newer and enable Add Python to PATH.
    pause
    exit /b 1
)
echo Other devices on your trusted local network can open http://THIS-PC-IP:5088
echo Keep this window open. Use STARTSERVER.bat for this computer only.
%KANPAK_PYTHON% server.py --host 0.0.0.0 --open
pause
