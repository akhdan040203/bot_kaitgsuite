@echo off
cls
echo Ngecek dependencies dulu bang...
echo.

:: Cek node_modules
IF EXIST node_modules (
    echo [+] Developed by Waroengku
    echo [+] Gaskeun lah...
    echo.
) ELSE (
    echo [!] Sabar ye, lagi install dulu nih...
    echo.
    npm install
    IF %ERRORLEVEL% NEQ 0 (
        echo.
        echo [X] Waduh error nih gan! Gagal install dependencies
        echo [!] Coba cek koneksi internet lu dah, trus jalanin lagi...
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [+] Mantap! Udah keinstall semua nih
    echo [+] Gas lah kita...
)

:: Cek file gsuite.txt
IF NOT EXIST gsuite.txt (
    echo [X] File gsuite.txt gak ada gan!
    echo [!] Bikin dulu file gsuite.txt di folder ini...
    echo.
    pause
    exit /b 1
)

FOR /F "usebackq delims=" %%A IN (gsuite.txt) DO SET GSUITE_CONTENT=%%A
IF "%GSUITE_CONTENT%"=="" (
    echo [X] File gsuite.txt kosong nih gan!
    echo [!] Tambahin isi dulu file gsuite.txt, trus jalanin lagi...
    echo.
    pause
    exit /b 1
)

echo [*] Oke mulai jalan ya...
echo.
node app.js
IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo [X] Anjir error nih aplikasinya!
    echo [!] Cek dulu deh file app.js nya ada apa kaga...
    echo.
    pause
    exit /b 1
)

echo.
echo [+] Sip! Udah kelar nih bang
echo [+] Pencet apa aja buat cabut...
pause > nul
