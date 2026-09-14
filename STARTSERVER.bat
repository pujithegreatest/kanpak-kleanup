@echo off
setlocal
cd /d "%~dp0"
title Kanpak Kleanup - Local Server
set "KANPAK_PYTHON="
where py >nul 2>nul
if not errorlevel 1 set "KANPAK_PYTHON=py -3"
if not defined KANPAK_PYTHON (
    where python >nul 2>nul
    if not errorlevel 1 set "KANPAK_PYTHON=python"
)
if not defined KANPAK_PYTHON (
    echo Python was not found. Install Python 3.11 or newer and enable Add Python to PATH.
    pause
    exit /b 1
)
echo Starting Kanpak Kleanup at http://127.0.0.1:5088
echo No package installation needed. Keep this window open while using the demo.
%KANPAK_PYTHON% server.py --open
pause
