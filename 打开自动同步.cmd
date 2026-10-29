@echo off
cd /d "%~dp0"
node service/launch.mjs
if errorlevel 1 pause
