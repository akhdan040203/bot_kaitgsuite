@echo off
cd /d "%~dp0WA OTP API"
if not exist node_modules (
    call npm install
    if errorlevel 1 (
        echo Gagal menginstal dependency OTP API.
        pause
        exit /b 1
    )
)
call npm start
pause
