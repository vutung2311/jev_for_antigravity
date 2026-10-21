@echo off
set "SCRIPT_DIR=%~dp0"
set "HOOK_JS=%SCRIPT_DIR%jev-hook.mjs"

where node >nul 2>&1 && (
    node "%HOOK_JS%" %*
    exit /b
)

if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" "%HOOK_JS%" %*
    exit /b
)

if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
    "%LOCALAPPDATA%\Programs\node\node.exe" "%HOOK_JS%" %*
    exit /b
)

node "%HOOK_JS%" %*
