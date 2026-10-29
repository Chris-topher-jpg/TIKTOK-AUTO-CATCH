@echo off
cd /d "%~dp0"
node service/main.mjs --export
pause
