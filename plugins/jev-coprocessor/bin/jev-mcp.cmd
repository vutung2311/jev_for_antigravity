@echo off
set "SCRIPT_DIR=%~dp0"
set "MCP_JS=%SCRIPT_DIR%jev-mcp.mjs"

where node >nul 2>&1 && (
    node --no-warnings --experimental-sqlite "%MCP_JS%" %*
    exit /b
)

if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" --no-warnings --experimental-sqlite "%MCP_JS%" %*
    exit /b
)

if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
    "%LOCALAPPDATA%\Programs\node\node.exe" --no-warnings --experimental-sqlite "%MCP_JS%" %*
    exit /b
)

node --no-warnings --experimental-sqlite "%MCP_JS%" %*
