# DSH Remote Desktop - Windows installer
#
# One-liner (no git, no manual copying):
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/tyrantblue/dsh-remote-desktop/main/agent/windows/install.ps1 | iex"
#
# It downloads the latest agent build from GitHub, extracts it under the install
# directory, keeps the user data (agent-password.txt, relay.txt, relay-code.txt,
# portable node\ folder), and then starts the native GUI (start-agent-gui.bat)
# when available, otherwise start-agent.bat.
#
# This file must stay PURE ASCII (Windows PowerShell 5.1 reads it fine without BOM).
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE 'dsh-remote-desktop'),
    [switch]$NoStart,
    [string]$Url,
    [string]$ZipPath
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Write-Step([string]$text) { Write-Host ("[dsh] " + $text) }
function Write-Fail([string]$text) { Write-Host ("[dsh] ERROR: " + $text) -ForegroundColor Red }

$repo = 'https://github.com/tyrantblue/dsh-remote-desktop'
$sources = @()
if ($Url) { $sources += $Url }
$sources += ($repo + '/releases/latest/download/dsh-remote-desktop-windows.zip')
$sources += ($repo + '/archive/refs/heads/main.zip')

$tempRoot = Join-Path $env:TEMP ('dsh-install-' + [guid]::NewGuid().ToString('N'))
$extractDir = Join-Path $tempRoot 'extract'
$zipFile = Join-Path $tempRoot 'agent.zip'
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

try {
    Write-Step 'DSH Remote Desktop - Windows controlled-end installer'
    Write-Step ('Install directory: ' + $InstallDir)

    $downloaded = $false
    if ($ZipPath) {
        if (-not (Test-Path -LiteralPath $ZipPath)) { throw ('local zip not found: ' + $ZipPath) }
        Copy-Item -LiteralPath $ZipPath -Destination $zipFile -Force
        $downloaded = $true
        Write-Step ('Using local archive: ' + $ZipPath)
    } else {
        foreach ($source in $sources) {
            try {
                Write-Step ('Downloading ' + $source)
                Invoke-WebRequest -Uri $source -OutFile $zipFile -UseBasicParsing
                $downloaded = $true
                break
            } catch {
                Write-Host ('[dsh] download failed: ' + $_.Exception.Message) -ForegroundColor Yellow
            }
        }
    }
    if (-not $downloaded) {
        throw 'could not download the agent archive. Download it manually from ' + $repo + '/releases and pass -ZipPath <file>.'
    }

    Write-Step 'Extracting...'
    Expand-Archive -LiteralPath $zipFile -DestinationPath $extractDir -Force

    $marker = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'remote-agent.mjs' |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'windows\start-agent.bat') } |
        Select-Object -First 1
    if ($null -eq $marker) { throw 'the archive does not contain agent\windows\start-agent.bat' }
    $sourceAgent = $marker.DirectoryName
    Write-Step ('Agent source: ' + $sourceAgent)

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $targetAgent = Join-Path $InstallDir 'agent'
    $targetWindows = Join-Path $targetAgent 'windows'

    # Keep user data from a previous install: password file, portable Node, logs.
    $passwordFile = Join-Path $targetWindows 'agent-password.txt'
    $keepPassword = $null
    if (Test-Path -LiteralPath $passwordFile) {
        $keepPassword = Get-Content -LiteralPath $passwordFile -Raw
    }
    $keepNode = $null
    $oldNode = Join-Path $targetWindows 'node'
    if (Test-Path -LiteralPath $oldNode) {
        $keepNode = Join-Path $tempRoot 'node-backup'
        Copy-Item -LiteralPath $oldNode -Destination $keepNode -Recurse -Force
    }
    # relay.txt holds the Harness address used for cross-NAT relay connections;
    # relay-code.txt holds the persistent relay access code. Neither must be
    # lost on an upgrade (the panel stores the access code).
    $relayFile = Join-Path $targetWindows 'relay.txt'
    $keepRelay = $null
    if (Test-Path -LiteralPath $relayFile) {
        $keepRelay = Get-Content -LiteralPath $relayFile -Raw
    }
    $relayCodeFile = Join-Path $targetWindows 'relay-code.txt'
    $keepRelayCode = $null
    if (Test-Path -LiteralPath $relayCodeFile) {
        $keepRelayCode = Get-Content -LiteralPath $relayCodeFile -Raw
    }

    if (Test-Path -LiteralPath $targetAgent) {
        Remove-Item -LiteralPath $targetAgent -Recurse -Force
    }
    Copy-Item -LiteralPath $sourceAgent -Destination $targetAgent -Recurse -Force
    Write-Step 'Agent files installed.'

    if ($null -ne $keepPassword) {
        [System.IO.File]::WriteAllText($passwordFile, $keepPassword, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
        Write-Step 'Kept the existing password file.'
    }
    if ($null -ne $keepNode -and (Test-Path -LiteralPath $keepNode)) {
        if (Test-Path -LiteralPath $oldNode) { Remove-Item -LiteralPath $oldNode -Recurse -Force }
        Copy-Item -LiteralPath $keepNode -Destination $oldNode -Recurse -Force
        Write-Step 'Kept the existing portable Node.js runtime.'
    }
    if ($null -ne $keepRelay) {
        [System.IO.File]::WriteAllText($relayFile, $keepRelay, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
        Write-Step 'Kept the existing relay.txt.'
    }
    if ($null -ne $keepRelayCode) {
        [System.IO.File]::WriteAllText($relayCodeFile, $keepRelayCode, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
        Write-Step 'Kept the existing relay-code.txt (persistent access code).'
    }

    $startBat = Join-Path $targetWindows 'start-agent.bat'
    $guiBat = Join-Path $targetWindows 'start-agent-gui.bat'
    $hasGui = Test-Path -LiteralPath $guiBat
    Write-Host ''
    Write-Host 'Installed:'
    Write-Host ('  agent:    ' + $targetAgent)
    if ($hasGui) {
        Write-Host ('  GUI:      ' + $guiBat + '  (recommended)')
        Write-Host ('  console:  ' + $startBat)
    } else {
        Write-Host ('  launcher: ' + $startBat)
    }
    Write-Host ('  password: ' + (Join-Path $targetWindows 'agent-password.txt') + ' (created on first start)')
    Write-Host ''
    Write-Host 'Kept across upgrades: agent-password.txt, relay.txt, relay-code.txt, node\'
    Write-Host ''
    Write-Host 'Cross-NAT / relay (no public IP or router port forwarding needed):'
    Write-Host ('  If the Harness is NOT on this LAN, set the Harness address in: ' + (Join-Path $targetWindows 'relay.txt'))
    Write-Host '  (or use the GUI). The access code is stored in relay-code.txt and stays'
    Write-Host '  the same after a restart, so a host saved in the panel keeps working.'
    Write-Host '  In the panel use "Relay" mode with that access code and the password.'
    Write-Host ''
    if ($NoStart) {
        Write-Host 'Start it with:'
        if ($hasGui) { Write-Host ('  "' + $guiBat + '"  (GUI)') }
        Write-Host ('  "' + $startBat + '"  (console)')
    } else {
        Write-Host 'Starting the agent. Allow it in the Windows Firewall prompt.'
        Write-Host 'Add this PC in the DSH "Remote Desktop" panel (LAN IP, or "Relay" mode).'
        if ($hasGui) {
            Start-Process -FilePath $guiBat
        } else {
            Start-Process -FilePath $startBat
        }
    }
}
catch {
    Write-Fail $_.Exception.Message
    Write-Host ''
    Write-Host 'Manual fallback: download the zip from'
    Write-Host ('  ' + $repo + '/releases')
    Write-Host 'extract it, and double-click agent\windows\start-agent-gui.bat (GUI)'
    Write-Host 'or agent\windows\start-agent.bat (console).'
    exit 1
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
