#Requires -Version 5.1
<#
.SYNOPSIS
    Jev System One Co-Processor Installer for Google Antigravity on Windows.
.DESCRIPTION
    Installs Jev Executive Decision Engine (PreInvocation) and Real-Time Code &
    Command Guardrails (PreToolUse) for Antigravity, Antigravity IDE, and CLI on Windows.
.PARAMETER Install
    Install or update the Jev plugin and hooks (default).
.PARAMETER Uninstall
    Remove the Jev plugin and hooks from Antigravity.
.PARAMETER Check
    Verify installation status and test Jev API connectivity.
.PARAMETER ApiKey
    Configure TYPESAFE_API_KEY in Windows User environment and plugin .env.
.EXAMPLE
    .\install.ps1 -ApiKey "your_typesafe_api_key_here"
    .\install.ps1 -Check
    .\install.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [Alias("-install")]
    [switch]$Install,
    [Alias("-uninstall")]
    [switch]$Uninstall,
    [Alias("-check")]
    [switch]$Check,
    [Alias("api-key", "-api-key", "key", "-key")]
    [string]$ApiKey,
    [Alias("-help", "h", "-h")]
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# Support bash-style flags (--install, --check, --uninstall, --api-key)
$rawArgs = @($args)
for ($i = 0; $i -lt $rawArgs.Count; $i++) {
    switch ($rawArgs[$i]) {
        '--install'   { $Install = $true }
        '--uninstall' { $Uninstall = $true }
        '--check'     { $Check = $true }
        '--api-key'   {
            if ($i + 1 -lt $rawArgs.Count) {
                $ApiKey = $rawArgs[$i + 1]
                $i++
            }
        }
        '-h'          { $Help = $true }
        '--help'      { $Help = $true }
    }
}

if ($Help) {
    Get-Help $MyInvocation.MyCommand.Path
    exit 0
}

# Determine default mode
$Mode = 'Install'
if ($Uninstall) {
    $Mode = 'Uninstall'
} elseif ($Check) {
    $Mode = 'Check'
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$ConfigDir = Join-Path $TargetHome ".gemini\config"
$PluginDest = Join-Path $ConfigDir "plugins\jev-coprocessor"

# ANSI color helpers
function Write-Cyan   { param([string]$Text) Write-Host $Text -ForegroundColor Cyan }
function Write-Green  { param([string]$Text) Write-Host $Text -ForegroundColor Green }
function Write-Yellow { param([string]$Text) Write-Host $Text -ForegroundColor Yellow }
function Write-Red    { param([string]$Text) Write-Host $Text -ForegroundColor Red }

function Find-NodeExecutable {
    # 1. In PATH
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # 2. Program Files default
    $pfNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path $pfNode) { return $pfNode }

    # 3. LocalAppData
    $localNode = Join-Path $env:LOCALAPPDATA "Programs\node\node.exe"
    if (Test-Path $localNode) { return $localNode }

    return $null
}

function Find-RgExecutable {
    # 1. In PATH
    $cmd = Get-Command rg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # 2. Antigravity IDE bundled ripgrep
    $ideRg = Join-Path $env:LOCALAPPDATA "Programs\Antigravity IDE\resources\app\node_modules\@vscode\ripgrep\bin\rg.exe"
    if (Test-Path $ideRg) { return $ideRg }

    # 3. VS Code bundled ripgrep
    $vsRg = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\resources\app\node_modules\@vscode\ripgrep\bin\rg.exe"
    if (Test-Path $vsRg) { return $vsRg }

    # 4. Program Files ripgrep
    $pfRg = Join-Path $env:ProgramFiles "ripgrep\rg.exe"
    if (Test-Path $pfRg) { return $pfRg }

    return $null
}

function Test-Prerequisites {
    $missing = $false

    # Git
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd -and -not (Test-Path "C:\Program Files\Git\cmd\git.exe")) {
        Write-Red "  x Missing required dependency: git"
        Write-Yellow "    Install Git via: winget install Git.Git"
        $missing = $true
    } else {
        Write-Green "  [OK] git found"
    }

    # Node.js
    $nodeExe = Find-NodeExecutable
    if (-not $nodeExe) {
        Write-Red "  x Missing required dependency: Node.js (>= 18)"
        Write-Yellow "    Install Node.js via: winget install OpenJS.NodeJS.LTS"
        $missing = $true
    } else {
        try {
            $ver = & $nodeExe -v
            Write-Green "  [OK] Node.js found: $ver ($nodeExe)"
        } catch {
            Write-Red "  x Failed to execute Node.js at $nodeExe"
            $missing = $true
        }
    }

    # Ripgrep
    $rgExe = Find-RgExecutable
    if (-not $rgExe) {
        Write-Yellow "  ! ripgrep (rg) not found in PATH or IDE bundle"
        Write-Yellow "    Install ripgrep via: winget install BurntSushi.ripgrep.MSVC"
    } else {
        Write-Green "  [OK] ripgrep found ($rgExe)"
    }

    if ($missing) {
        throw "Please install missing prerequisites before continuing."
    }
}

function Set-ApiKeyConfiguration {
    param([string]$Key)
    if ([string]::IsNullOrWhiteSpace($Key)) { return }

    # Set User environment variable permanently
    [System.Environment]::SetEnvironmentVariable("TYPESAFE_API_KEY", $Key, "User")
    $env:TYPESAFE_API_KEY = $Key

    # Persist in plugin .env and ~/.gemini/config/jev.env
    New-Item -ItemType Directory -Force -Path $PluginDest | Out-Null
    $pluginEnv = Join-Path $PluginDest ".env"
    "TYPESAFE_API_KEY=""$Key""" | Out-File -FilePath $pluginEnv -Encoding utf8 -Force

    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    $configEnv = Join-Path $ConfigDir "jev.env"
    "TYPESAFE_API_KEY=""$Key""" | Out-File -FilePath $configEnv -Encoding utf8 -Force

    Write-Green "  [OK] Configured TYPESAFE_API_KEY in Windows User environment, jev.env, and plugin .env"
}

function Update-ConfigJsonPlugin {
    param([bool]$Enable)
    $configFile = Join-Path $ConfigDir "config.json"
    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

    $cfg = @{}
    if (Test-Path $configFile) {
        try {
            $raw = Get-Content -Raw -Path $configFile -Encoding utf8
            if (-not [string]::IsNullOrWhiteSpace($raw)) {
                $cfg = $raw | ConvertFrom-Json -AsHashtable
            }
        } catch {
            $cfg = @{}
        }
    }

    if (-not $cfg.ContainsKey("plugins")) {
        $cfg["plugins"] = @{}
    }

    if ($Enable) {
        $cfg["plugins"]["jev-coprocessor"] = @{ enabled = $true }
    } else {
        $cfg["plugins"].Remove("jev-coprocessor")
    }

    $jsonStr = $cfg | ConvertTo-Json -Depth 10
    $jsonStr | Out-File -FilePath $configFile -Encoding utf8 -Force
}

function Generate-WindowsHooksJson {
    $hookCmdPath = "%USERPROFILE%/.gemini/config/plugins/jev-coprocessor/bin/jev-hook.cmd"

    $hooksObj = [ordered]@{
        "jev-intent-router" = [ordered]@{
            "enabled" = $true
            "PreInvocation" = @(
                [ordered]@{
                    "type" = "command"
                    "command" = """$hookCmdPath"" PreInvocation"
                    "timeout" = 6
                }
            )
        }
        "jev-tool-guardrail" = [ordered]@{
            "enabled" = $true
            "PreToolUse" = @(
                [ordered]@{
                    "matcher" = "replace_file_content|multi_replace_file_content|write_to_file|edit_file|write_file|read_file|view_file|run_command"
                    "hooks" = @(
                        [ordered]@{
                            "type" = "command"
                            "command" = """$hookCmdPath"" PreToolUse"
                            "timeout" = 6
                        }
                    )
                }
            )
        }
    }

    return ($hooksObj | ConvertTo-Json -Depth 10)
}

function Run-SmokeCheck {
    Write-Cyan "Running Jev Co-Processor Windows health check..."

    $hookMjs = Join-Path $PluginDest "bin\jev-hook.mjs"
    $hookCmd = Join-Path $PluginDest "bin\jev-hook.cmd"

    if (-not (Test-Path $hookMjs)) {
        Write-Red "  x Plugin script not found at $hookMjs"
        exit 1
    }
    Write-Green "  [OK] Plugin scripts present at $PluginDest"

    # Verify link into product directories
    foreach ($productDir in @("antigravity", "antigravity-ide")) {
        $agyDir = Join-Path $TargetHome ".gemini\$productDir"
        if (Test-Path $agyDir) {
            $agyHooks = Join-Path $agyDir "hooks.json"
            $agyPlugin = Join-Path $agyDir "plugins\jev-coprocessor"
            if ((Test-Path $agyHooks) -and (Test-Path $agyPlugin)) {
                Write-Green "  [OK] Integrated with $agyDir"
            } else {
                Write-Yellow "  ! Missing integration in $agyDir (run install.ps1 to repair)"
            }
        }
    }

    # Execute health check via jev-hook.cmd with test JSON on stdin
    $testPayload = '{"conversationId":"install-health-check","stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"go test ./... || true","Cwd":"C:\\"}}}'
    
    $nodeExe = Find-NodeExecutable
    if (-not $nodeExe) {
        Write-Red "  x Node.js executable could not be resolved for smoke check"
        exit 1
    }

    $out = $null
    try {
        if (Test-Path $hookCmd) {
            $out = $testPayload | & cmd.exe /c """$hookCmd"" PreToolUse" 2>&1
        } else {
            $out = $testPayload | & $nodeExe $hookMjs PreToolUse 2>&1
        }
    } catch {
        Write-Red "  x Execution of hook script failed: $_"
        exit 1
    }

    $outStr = ($out | Out-String).Trim()
    if ($outStr -match '"overwrite"') {
        Write-Green "  [OK] Live Jev System One API & PreToolUse overwrite verified: $outStr"
    } elseif ($outStr -match '"decision"\s*:\s*"allow"') {
        $apiKey = [System.Environment]::GetEnvironmentVariable("TYPESAFE_API_KEY", "User")
        if (-not $apiKey) { $apiKey = $env:TYPESAFE_API_KEY }
        if ($apiKey) {
            Write-Yellow "  ! Hook responded with allow: $outStr"
            Write-Yellow "    (TYPESAFE_API_KEY is configured; test verified locally)"
        } else {
            Write-Yellow "  ! Hook responded locally without API key: $outStr"
            Write-Yellow "    To activate live Jev decisions, run: .\install.ps1 -ApiKey ""your_typesafe_api_key"""
        }
    } else {
        Write-Yellow "  ! Hook output: $outStr"
    }
}

function Install-Plugin {
    Write-Cyan "=========================================================="
    Write-Cyan " Installing Jev System One Co-Processor for Antigravity   "
    Write-Cyan " (Windows Native Edition)                                 "
    Write-Cyan "=========================================================="

    Test-Prerequisites

    # Setup directories
    $destBin = Join-Path $PluginDest "bin"
    $destAssets = Join-Path $PluginDest "assets"
    New-Item -ItemType Directory -Force -Path $destBin, $destAssets, $ConfigDir | Out-Null

    # API key configuration
    if (-not [string]::IsNullOrWhiteSpace($ApiKey)) {
        Set-ApiKeyConfiguration -Key $ApiKey
    }

    # Copy plugin files
    Copy-Item (Join-Path $ScriptDir "plugins\jev-coprocessor\plugin.json") (Join-Path $PluginDest "plugin.json") -Force
    Copy-Item (Join-Path $ScriptDir "plugins\jev-coprocessor\README.md") (Join-Path $PluginDest "README.md") -Force
    Copy-Item (Join-Path $ScriptDir "plugins\jev-coprocessor\assets\logo.svg") (Join-Path $destAssets "logo.svg") -Force
    Copy-Item (Join-Path $ScriptDir "plugins\jev-coprocessor\bin\jev-client.mjs") (Join-Path $destBin "jev-client.mjs") -Force
    Copy-Item (Join-Path $ScriptDir "plugins\jev-coprocessor\bin\jev-hook.mjs") (Join-Path $destBin "jev-hook.mjs") -Force
    Copy-Item (Join-Path $ScriptDir "plugins\jev-coprocessor\bin\jev-hook.cmd") (Join-Path $destBin "jev-hook.cmd") -Force

    # Generate and write Windows hooks.json
    $hooksJsonContent = Generate-WindowsHooksJson
    $hooksJsonContent | Out-File -FilePath (Join-Path $ConfigDir "hooks.json") -Encoding utf8 -Force
    $hooksJsonContent | Out-File -FilePath (Join-Path $PluginDest "hooks.json") -Encoding utf8 -Force

    # Enable in config.json
    Update-ConfigJsonPlugin -Enable $true
    Write-Green "  [OK] Installed plugin and hooks to $ConfigDir"

    # Integrate into ~/.gemini/antigravity and ~/.gemini/antigravity-ide
    foreach ($productDir in @("antigravity", "antigravity-ide")) {
        $agyDir = Join-Path $TargetHome ".gemini\$productDir"
        $agyPlugins = Join-Path $agyDir "plugins"
        New-Item -ItemType Directory -Force -Path $agyPlugins | Out-Null

        # Copy hooks.json
        Copy-Item (Join-Path $ConfigDir "hooks.json") (Join-Path $agyDir "hooks.json") -Force

        # Create Junction or directory copy
        $agyPluginLink = Join-Path $agyPlugins "jev-coprocessor"
        if (Test-Path $agyPluginLink) {
            try {
                if ((Get-Item $agyPluginLink).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    [System.IO.Directory]::Delete($agyPluginLink)
                } else {
                    Remove-Item $agyPluginLink -Recurse -Force
                }
            } catch {
                # Fallback
            }
        }

        try {
            New-Item -ItemType Junction -Path $agyPluginLink -Target $PluginDest -ErrorAction Stop | Out-Null
            Write-Green "  [OK] Created junction for $productDir"
        } catch {
            # Fallback to copy if junction not supported
            Copy-Item $PluginDest $agyPluginLink -Recurse -Force
            Write-Green "  [OK] Copied plugin to $productDir (fallback)"
        }
    }

    Write-Host ""
    Run-SmokeCheck
    Write-Host ""
    Write-Green "Done! Jev System One Co-Processor is active by default for Antigravity & Antigravity IDE on Windows."
}

function Uninstall-Plugin {
    Write-Cyan "Uninstalling Jev System One Co-Processor on Windows..."

    foreach ($productDir in @("antigravity", "antigravity-ide")) {
        $agyDir = Join-Path $TargetHome ".gemini\$productDir"
        $hookFile = Join-Path $agyDir "hooks.json"
        if (Test-Path $hookFile) { Remove-Item $hookFile -Force }

        $agyPlugin = Join-Path $agyDir "plugins\jev-coprocessor"
        if (Test-Path $agyPlugin) {
            try {
                if ((Get-Item $agyPlugin).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    [System.IO.Directory]::Delete($agyPlugin)
                } else {
                    Remove-Item $agyPlugin -Recurse -Force
                }
            } catch {
                Remove-Item $agyPlugin -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $globalHook = Join-Path $ConfigDir "hooks.json"
    if (Test-Path $globalHook) { Remove-Item $globalHook -Force }

    if (Test-Path $PluginDest) {
        Remove-Item $PluginDest -Recurse -Force
    }

    Update-ConfigJsonPlugin -Enable $false
    Write-Green "[OK] Uninstalled Jev Co-Processor from Antigravity."
}

switch ($Mode) {
    'Install'   { Install-Plugin }
    'Uninstall' { Uninstall-Plugin }
    'Check'     { Run-SmokeCheck }
}
