@echo off
chcp 65001 >nul
start "" "http://localhost:8080"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
