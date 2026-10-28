@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title PoliceTools - Prepaid Card Batch OCR
cd /d "%~dp0"
if errorlevel 1 goto directory_error

set "POLICE_ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "POLICE_ARCH=%PROCESSOR_ARCHITEW6432%"
if /i "%POLICE_ARCH%"=="ARM64" goto arm64
if /i "%POLICE_ARCH%"=="AMD64" goto amd64
echo This package requires 64-bit Windows on x64 or ARM64.
echo 此啟動工具支援 64 位元 x64 或 ARM64 Windows。
pause
exit /b 1

:arm64
set "POLICE_BINARY=%~dp0local-server\bin\police-ocr-server-windows-arm64.exe"
goto launch

:amd64
set "POLICE_BINARY=%~dp0local-server\bin\police-ocr-server-windows-amd64.exe"

:launch
if not exist "%POLICE_BINARY%" goto incomplete
if not exist "%~dp0docs\index.html" goto incomplete
"%POLICE_BINARY%" --root "%~dp0docs" %*
set "POLICE_EXIT=%ERRORLEVEL%"
if "%POLICE_EXIT%"=="0" exit /b 0
echo.
echo If Windows blocked the program, review the system message and your organization's policy.
echo 若 Windows 顯示阻擋訊息，請確認來源並依系統或組織政策處理。
echo No Python installation is required. Do not close this window until you have read the error.
pause
exit /b %POLICE_EXIT%

:incomplete
echo The project is incomplete. Extract the entire ZIP before starting.
echo 專案檔案不完整。請先完整解壓縮 ZIP，再雙擊啟動工具。
pause
exit /b 1

:directory_error
echo Cannot open this project folder. Copy it to a local drive and try again.
pause
exit /b 1
