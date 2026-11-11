@echo off
title OmniLoader - Universal Video Downloader
cd /d "%~dp0"

echo ========================================================
echo    OmniLoader - 100%% Ad-Free Universal Video Downloader
echo ========================================================
echo.
echo Starting server on http://localhost:3000 ...
echo Opening your browser in 2 seconds...
echo.

start "" "http://localhost:3000"
node server.js

pause

