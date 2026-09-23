[CmdletBinding()]
param(
    [switch]$WithBrowser
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspacePath = Split-Path -Parent $PSScriptRoot
$npmCommand = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    $npmCommand = Get-Command 'npm' -ErrorAction Stop
}

function Invoke-NpmGate {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "Running $Name..."
    & $npmCommand.Source @Arguments
    $commandExitCode = $LASTEXITCODE
    if ($commandExitCode -ne 0) {
        throw "$Name failed (exit code $commandExitCode)."
    }
    Write-Host "PASS: $Name"
}

Push-Location -LiteralPath $workspacePath
try {
    foreach ($requiredPath in @('docs/prd.md', 'quality_gates.yaml', 'package.json', 'package-lock.json')) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required file missing: $requiredPath"
        }
    }

    $package = Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $configuredScripts = @($package.scripts.PSObject.Properties.Name)
    $requiredScripts = @('lint', 'typecheck', 'test', 'build')
    if ($WithBrowser) { $requiredScripts += 'test:e2e' }
    foreach ($script in $requiredScripts) {
        if ($configuredScripts -notcontains $script) {
            throw "Gate not configured: npm run $script"
        }
    }

    Invoke-NpmGate -Name 'lint' -Arguments @('run', 'lint')
    Invoke-NpmGate -Name 'typecheck' -Arguments @('run', 'typecheck')
    Invoke-NpmGate -Name 'unit tests' -Arguments @('test')
    Invoke-NpmGate -Name 'production build' -Arguments @('run', 'build')

    if (-not (Test-Path -LiteralPath 'dist/index.html' -PathType Leaf)) {
        throw 'Production build did not produce dist/index.html.'
    }

    if ($WithBrowser) {
        Invoke-NpmGate -Name 'browser tests' -Arguments @('run', 'test:e2e')
    }
    else {
        Write-Host 'Browser tests: not run (use -WithBrowser to include them).'
    }

    Write-Host 'PASS: All requested verification gates completed.'
}
finally {
    Pop-Location
}
