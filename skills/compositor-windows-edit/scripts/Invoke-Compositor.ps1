<#
.SYNOPSIS
Call the local Compositor MCP bridge without installing Node.js.
.DESCRIPTION
Uses the packaged application in Node mode. Does not start the GUI or retry edits.
Arguments are read from a UTF-8 JSON file. Preview/result paths must be new files.
.EXAMPLE
./scripts/Invoke-Compositor.ps1 -ListTools
.EXAMPLE
./scripts/Invoke-Compositor.ps1 -Tool compositor_get_state -ResultPath C:\Task\work\state-01.json
.EXAMPLE
./scripts/Invoke-Compositor.ps1 -Tool compositor_get_canvas -ImagePath C:\Task\work\preview-01.png
.EXAMPLE
./scripts/Invoke-Compositor.ps1 -Tool compositor_edit -ArgsFile C:\Task\work\edit.json
#>
[CmdletBinding(DefaultParameterSetName = 'Tool')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Tool')]
    [ValidateSet('compositor_get_state', 'compositor_get_canvas', 'compositor_edit', 'compositor_open_image', 'compositor_export')]
    [string]$Tool,

    [Parameter(Mandatory = $true, ParameterSetName = 'List')]
    [switch]$ListTools,

    [Parameter(ParameterSetName = 'Tool')]
    [string]$ArgsFile,

    [Parameter(ParameterSetName = 'Tool')]
    [string]$ImagePath,

    [string]$ResultPath,
    [string]$AppDir
)

$ErrorActionPreference = 'Stop'
$compositorPreviousMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
$compositorPreviousEncoding = [Console]::OutputEncoding
$compositorExitCode = 1

try {
    if ($Tool -eq 'compositor_get_canvas' -and [string]::IsNullOrWhiteSpace($ImagePath)) {
        throw 'compositor_get_canvas requires -ImagePath for a new PNG preview file.'
    }
    if ($ImagePath -and $Tool -ne 'compositor_get_canvas') {
        throw '-ImagePath is only valid with compositor_get_canvas.'
    }
    foreach ($compositorOutputPath in @($ImagePath, $ResultPath)) {
        if ($compositorOutputPath -and (Test-Path -LiteralPath $compositorOutputPath)) {
            throw "Output already exists; refusing to overwrite: $compositorOutputPath"
        }
    }

    $compositorSkillRoot = Split-Path -Parent $PSScriptRoot
    $compositorSelectedDirectory = $AppDir
    if ([string]::IsNullOrWhiteSpace($compositorSelectedDirectory)) {
        $compositorSelectedDirectory = [Environment]::GetEnvironmentVariable('COMPOSITOR_APP_DIR', 'Process')
    }
    if ([string]::IsNullOrWhiteSpace($compositorSelectedDirectory)) {
        $compositorConfigFile = Join-Path $compositorSkillRoot 'local-config.json'
        if (-not (Test-Path -LiteralPath $compositorConfigFile -PathType Leaf)) {
            throw "Missing local-config.json. Supply -AppDir or COMPOSITOR_APP_DIR: $compositorConfigFile"
        }
        $compositorConfig = Get-Content -LiteralPath $compositorConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($compositorConfig.appDirectory -isnot [string] -or [string]::IsNullOrWhiteSpace($compositorConfig.appDirectory)) {
            throw 'local-config.json must contain a nonempty appDirectory string.'
        }
        $compositorSelectedDirectory = $compositorConfig.appDirectory
        if (-not [IO.Path]::IsPathRooted($compositorSelectedDirectory)) {
            $compositorSelectedDirectory = Join-Path $compositorSkillRoot $compositorSelectedDirectory
        }
    }
    $compositorSelectedDirectory = [IO.Path]::GetFullPath($compositorSelectedDirectory)
    $compositorHelper = Join-Path $PSScriptRoot 'mcp-client.mjs'
    $compositorServer = Join-Path $compositorSelectedDirectory 'scripts\mcp-server.mjs'
    if (-not (Test-Path -LiteralPath $compositorHelper -PathType Leaf)) { throw "MCP helper is missing: $compositorHelper" }
    if (-not (Test-Path -LiteralPath $compositorServer -PathType Leaf)) { throw "Application MCP bridge is missing: $compositorServer" }

    $compositorRuntime = Join-Path $compositorSelectedDirectory 'Compositor Windows.exe'
    if (-not (Test-Path -LiteralPath $compositorRuntime -PathType Leaf)) {
        $compositorNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $compositorNode) { throw 'Packaged Compositor Windows.exe was not found and Node.js is unavailable. Check -AppDir.' }
        $compositorRuntime = $compositorNode.Source
    }
    $compositorArguments = @($compositorHelper, '--app-dir', $compositorSelectedDirectory)
    if ($ListTools) { $compositorArguments += '--list-tools' }
    else { $compositorArguments += @('--tool', $Tool) }
    if ($ArgsFile) { $compositorArguments += @('--args-file', [IO.Path]::GetFullPath($ArgsFile)) }
    if ($ImagePath) { $compositorArguments += @('--image-path', [IO.Path]::GetFullPath($ImagePath)) }
    if ($ResultPath) { $compositorArguments += @('--result-path', [IO.Path]::GetFullPath($ResultPath)) }

    # Process-local only; finally restores both settings even when the helper fails.
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', '1', 'Process')
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    # The packaged EXE uses the GUI subsystem. A pipeline makes Windows
    # PowerShell wait for it and update LASTEXITCODE before this script returns.
    & $compositorRuntime @compositorArguments | ForEach-Object { [Console]::Out.WriteLine([string]$_) }
    $compositorExitCode = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("Compositor: " + $_.Exception.Message)
    $compositorExitCode = 1
} finally {
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $compositorPreviousMode, 'Process')
    [Console]::OutputEncoding = $compositorPreviousEncoding
}

exit $compositorExitCode
