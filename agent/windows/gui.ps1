# =============================================================================
# gui.ps1 - native WinForms control panel for the DSH Windows agent
# =============================================================================
# Started by start-agent-gui.bat (hidden console):
#   powershell.exe -Sta -NoLogo -NoProfile -ExecutionPolicy Bypass
#                  -WindowStyle Hidden -File gui.ps1
#
# What it does:
#   * edits relay.txt (Harness address, empty = LAN direct only) and
#     relay-code.txt (persistent relay access code);
#   * shows/copies/regenerates agent-password.txt;
#   * starts/stops remote-agent.mjs with the same arguments as start-agent.bat
#     (plus --relay / --relay-code-file when a relay server is configured),
#     without a console window (CreateNoWindow);
#   * streams the agent stdout/stderr into the log box and parses the
#     "[relay] connected ..." line into the status area.
#
# No command line arguments are required. For static validation the inline C#
# helper can be dumped instead of running the GUI:
#   powershell -NoProfile -File gui.ps1 --dump-csharp <path>
#   DS_REMOTE_DUMP_CSHARP=<path> powershell -NoProfile -File gui.ps1
#
# Requires Windows PowerShell 5.1 (.NET Framework 4.5). This file must stay
# PURE ASCII so Windows PowerShell 5.1 never mis-decodes it.
# =============================================================================

$ErrorActionPreference = 'Stop'

# ---- optional: dump the inline C# helper, then exit ------------------------
# Supports: --dump-csharp <path> | --dump-csharp | --dump-csharp=<path>
#           DS_REMOTE_DUMP_CSHARP=<path>
$script:DumpToStdout = $false
$script:DumpPath = $null
$script:ArgIndex = 0
while ($script:ArgIndex -lt $args.Count) {
    $script:ArgValue = [string]$args[$script:ArgIndex]
    if ($script:ArgValue -eq '--dump-csharp') {
        if (($script:ArgIndex + 1) -lt $args.Count) {
            $script:NextValue = [string]$args[$script:ArgIndex + 1]
            if (-not $script:NextValue.StartsWith('-')) {
                $script:DumpPath = $script:NextValue
                $script:ArgIndex = $script:ArgIndex + 1
            } else {
                $script:DumpToStdout = $true
            }
        } else {
            $script:DumpToStdout = $true
        }
    } elseif ($script:ArgValue.StartsWith('--dump-csharp=')) {
        $script:DumpPath = $script:ArgValue.Substring(14)
    }
    $script:ArgIndex = $script:ArgIndex + 1
}
if ($null -ne $env:DS_REMOTE_DUMP_CSHARP) {
    if ([string]$env:DS_REMOTE_DUMP_CSHARP -ne '' -and $null -eq $script:DumpPath) {
        $script:DumpPath = [string]$env:DS_REMOTE_DUMP_CSHARP
    }
}

# ---- inline C# helper (log pump for the child process) ---------------------
# The WinForms timer drains a thread-safe queue; a plain .NET thread owned by
# this tiny class reads stdout/stderr, so no PowerShell scriptblock ever runs
# on a background thread (that would deadlock the WinForms message loop).
$csharp = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

public sealed class DsRemoteGuiLogPump
{
    private readonly Queue<string> _lines = new Queue<string>();
    private readonly object _gate = new object();

    public void Pump(StreamReader reader)
    {
        if (reader == null) { return; }
        Thread thread = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    lock (_gate) { _lines.Enqueue(line); }
                }
            }
            catch (Exception)
            {
                // The pipe closes when the agent exits; nothing to do here.
            }
        });
        thread.IsBackground = true;
        thread.Name = "dsh-gui-log";
        thread.Start();
    }

    public string[] Drain(int maxLines)
    {
        if (maxLines < 1) { maxLines = 1; }
        List<string> result = new List<string>();
        lock (_gate)
        {
            while (result.Count < maxLines && _lines.Count > 0)
            {
                result.Add(_lines.Dequeue());
            }
        }
        return result.ToArray();
    }
}
'@

if ($script:DumpToStdout -or $null -ne $script:DumpPath) {
    $script:DumpEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
    if ($null -ne $script:DumpPath) {
        $script:DumpFullPath = [System.IO.Path]::GetFullPath($script:DumpPath)
        [System.IO.File]::WriteAllText($script:DumpFullPath, $csharp + [char]10, $script:DumpEncoding)
        [Console]::Error.WriteLine('csharp dumped to ' + $script:DumpFullPath)
    } else {
        [Console]::Out.Write($csharp + [char]10)
        [Console]::Out.Flush()
    }
    exit 0
}

# ---- load WinForms / System.Drawing ---------------------------------------
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
} catch {
    [Console]::Error.WriteLine('gui_init_failed: cannot load System.Windows.Forms: ' + $_.Exception.Message)
    exit 2
}
try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
} catch {
    [Console]::Error.WriteLine('gui_init_failed: cannot load System.Drawing: ' + $_.Exception.Message)
    exit 2
}

# ---- compile the log pump helper defined above ---------------------------
# The class is only defined as source text until this point; without the
# compilation step the Start button used to fail with "cannot find type
# DsRemoteGuiLogPump" (the source was only used by --dump-csharp).
try {
    if (-not ('DsRemoteGuiLogPump' -as [type])) {
        Add-Type -TypeDefinition $csharp -Language CSharp -ReferencedAssemblies 'System.dll' -ErrorAction Stop
    }
} catch {
    $script:InitMessage = 'gui_init_failed: cannot compile the log pump helper: ' + $_.Exception.Message
    [Console]::Error.WriteLine($script:InitMessage)
    try {
        [void][System.Windows.Forms.MessageBox]::Show(
            $script:InitMessage,
            'DSH Remote Desktop Agent',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
    } catch { }
    exit 3
}

# ---- paths and script state ----------------------------------------------
$script:WindowsDir = $PSScriptRoot
if (-not $script:WindowsDir) {
    $script:WindowsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$script:AgentDir = Split-Path -Parent $script:WindowsDir
$script:AgentJs = Join-Path $script:AgentDir 'remote-agent.mjs'
$script:RelayFile = Join-Path $script:WindowsDir 'relay.txt'
$script:RelayCodeFile = Join-Path $script:WindowsDir 'relay-code.txt'
$script:PasswordFile = Join-Path $script:WindowsDir 'agent-password.txt'
$script:DefaultPort = '38080'
$script:GuiMutex = $null
$script:MutexAcquired = $false
$script:AgentProcess = $null
$script:AgentRunning = $false
$script:LogPump = $null
$script:LogPending = New-Object System.Text.StringBuilder
$script:LogBufferLimit = 500
$script:RelayState = 'idle'
$script:RelayCode = ''
$script:ListenUrl = ''
$script:FsRoot = ''
$script:LastStateText = ''
$script:LastRelayText = ''
$script:LastListenText = ''
$script:LastFsRootText = ''
$script:Timer = $null
$script:Form = $null

# ===========================================================================
# small utility functions
# ===========================================================================
function Show-Message {
    param([string]$Text, [string]$Title = 'DSH Remote Desktop Agent', [string]$Kind = 'Information')
    $icon = [System.Windows.Forms.MessageBoxIcon]::Information
    if ($Kind -eq 'Warning') { $icon = [System.Windows.Forms.MessageBoxIcon]::Warning }
    if ($Kind -eq 'Error') { $icon = [System.Windows.Forms.MessageBoxIcon]::Error }
    [void][System.Windows.Forms.MessageBox]::Show($Text, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}

function Confirm-Action {
    param([string]$Text, [string]$Title = 'DSH Remote Desktop Agent')
    $answer = [System.Windows.Forms.MessageBox]::Show($Text, $Title, [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    return ($answer -eq [System.Windows.Forms.DialogResult]::Yes)
}

function Read-TextFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $text = [System.IO.File]::ReadAllText($Path)
        # Tolerate a UTF-8 BOM from editors; the GUI itself always writes no BOM.
        if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) {
            $text = $text.Substring(1)
        }
        return $text
    } catch { return $null }
}

function Write-TextFile {
    param([string]$Path, [string]$Text)
    $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Remove-FileIfPresent {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        try { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue } catch { }
    }
}

# relay.txt: first non-blank, non-comment line is the Harness address.
function Read-RelayServer {
    if (-not (Test-Path -LiteralPath $script:RelayFile)) { return '' }
    $raw = Read-TextFile $script:RelayFile
    if ($null -eq $raw) { return '' }
    foreach ($rawLine in ($raw -split "`r?`n")) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0) { continue }
        if ($line.StartsWith('#')) { continue }
        return $line
    }
    return ''
}

function Write-RelayServer {
    param([string]$Value)
    $value = $Value.Trim()
    if ($value.Length -eq 0) {
        Remove-FileIfPresent $script:RelayFile
        return
    }
    Write-TextFile $script:RelayFile ($value + [Environment]::NewLine)
}

# relay-code.txt: one code per file (the agent reuses it on every start).
function Read-RelayCode {
    $raw = Read-TextFile $script:RelayCodeFile
    if ($null -eq $raw) { return '' }
    foreach ($rawLine in ($raw -split "`r?`n")) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0) { continue }
        return $line
    }
    return ''
}

function Write-RelayCode {
    param([string]$Code)
    $code = $Code.Trim()
    if ($code.Length -eq 0) {
        Remove-FileIfPresent $script:RelayCodeFile
        return
    }
    Write-TextFile $script:RelayCodeFile ($code + [Environment]::NewLine)
}

function Read-Password {
    $raw = Read-TextFile $script:PasswordFile
    if ($null -eq $raw) { return '' }
    return $raw.Trim()
}

function Write-Password {
    param([string]$Password)
    Write-TextFile $script:PasswordFile $Password.Trim()
}

function New-RandomPassword {
    $password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
    return $password
}

function New-RelayAccessCode {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    $chars = New-Object 'System.Collections.Generic.List[char]'
    for ($i = 0; $i -lt 10; $i++) {
        $chars.Add($alphabet[(Get-Random -Maximum $alphabet.Length)])
    }
    return (-join $chars.ToArray())
}

function Test-RelayCodeFormat {
    param([string]$Code)
    if ($Code.Length -lt 6 -or $Code.Length -gt 32) { return $false }
    return ($Code -match '^[A-Za-z0-9_-]+$')
}

function Find-Node {
    $portable = Join-Path $script:WindowsDir 'node\node.exe'
    if (Test-Path -LiteralPath $portable) { return $portable }
    $command = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    if ($null -eq $command) { $command = Get-Command 'node' -ErrorAction SilentlyContinue }
    if ($null -ne $command) {
        if ($null -ne $command.Source -and $command.Source.Length -gt 0) { return $command.Source }
        if ($null -ne $command.Path -and $command.Path.Length -gt 0) { return $command.Path }
    }
    return ''
}

# Quote one argument for the Windows command line (paths may contain spaces).
function Quote-Arg {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    return '"' + $Value + '"'
}

function New-GuiPoint {
    param([int]$X, [int]$Y)
    return (New-Object System.Drawing.Point -ArgumentList $X, $Y)
}

function New-GuiSize {
    param([int]$Width, [int]$Height)
    return (New-Object System.Drawing.Size -ArgumentList $Width, $Height)
}

function New-GuiFont {
    param([string]$Family, [double]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular)
    return (New-Object System.Drawing.Font -ArgumentList $Family, ([single]$Size), $Style)
}

function Set-ClipboardText {
    param([string]$Text)
    if ($null -eq $Text -or $Text.Length -eq 0) {
        Show-Message 'There is nothing to copy yet.' 'DSH Remote Desktop Agent' 'Warning'
        return $false
    }
    try {
        [System.Windows.Forms.Clipboard]::SetText($Text)
        return $true
    } catch {
        Show-Message ('Could not copy to the clipboard: ' + $_.Exception.Message) 'DSH Remote Desktop Agent' 'Warning'
        return $false
    }
}

# ===========================================================================
# status / log helpers
# ===========================================================================
function Add-LogText {
    param([string]$Text)
    if ($null -eq $Text) { return }
    $stamp = (Get-Date).ToString('HH:mm:ss')
    [void]$script:LogPending.AppendLine('[' + $stamp + '] ' + $Text)
}

function Process-LogLine {
    param([string]$Line)
    if ($Line -match 'listening on (https?://\S+)') {
        $script:ListenUrl = $Matches[1]
    }
    if ($Line -match 'fsRoot: (.+)$') {
        $script:FsRoot = $Matches[1].Trim()
    }
    if ($Line -match '\[relay\] connected') {
        $script:RelayState = 'connected'
        if ($Line -match '([A-Za-z0-9_-]{6,32})\s*$') {
            $script:RelayCode = $Matches[1]
        }
    } elseif ($Line -match '\[relay\] connect failed') {
        $script:RelayState = 'retrying'
    } elseif ($Line -match '\[relay\] disabled') {
        $script:RelayState = 'disabled'
    } elseif ($Line -match '\[relay\] stopped') {
        $script:RelayState = 'stopped'
    } elseif ($Line -match '\[relay\] code:\s*([A-Za-z0-9_-]{6,32})') {
        $script:RelayCode = $Matches[1]
    }
    if ($Line -match '\[remote-agent\] received SIGTERM') {
        $script:RelayState = 'stopped'
    }
}

function Flush-Log {
    if ($script:LogPending.Length -eq 0) { return }
    $text = $script:LogPending.ToString()
    [void]$script:LogPending.Clear()
    $script:txtLog.AppendText($text)
    $allLines = $script:txtLog.Lines
    if ($allLines.Length -gt $script:LogBufferLimit) {
        $start = $allLines.Length - $script:LogBufferLimit
        $script:txtLog.Text = ($allLines[$start..($allLines.Length - 1)] -join ([Environment]::NewLine))
    }
    $script:txtLog.SelectionStart = $script:txtLog.TextLength
    $script:txtLog.ScrollToCaret()
}

function Update-ProcessState {
    if ($null -eq $script:AgentProcess) {
        $script:AgentRunning = $false
        return
    }
    $process = $script:AgentProcess
    $exited = $false
    try { $exited = $process.HasExited } catch { $exited = $true }
    if (-not $exited) {
        $script:AgentRunning = $true
        return
    }
    $exitCode = 'unknown'
    try { $exitCode = [string]$process.ExitCode } catch { }
    Add-LogText ('Agent process exited (exit code ' + $exitCode + ').')
    $script:AgentProcess = $null
    $script:AgentRunning = $false
    $script:RelayState = 'stopped'
    $script:ListenUrl = ''
}

function Update-Buttons {
    if ($null -eq $script:btnStart) { return }
    $script:btnStart.Enabled = -not $script:AgentRunning
    $script:btnStop.Enabled = $script:AgentRunning
}

function Update-StatusLabels {
    if ($null -eq $script:lblState) { return }

    $stateText = 'Agent: stopped'
    if ($script:AgentRunning) {
        $pidText = ''
        try { $pidText = ' (PID ' + $script:AgentProcess.Id + ')' } catch { }
        $stateText = 'Agent: running' + $pidText
    }

    $relayText = 'Relay: not configured (LAN direct only)'
    if ($script:txtRelay.Text.Trim().Length -gt 0) {
        if ($script:RelayState -eq 'connected') {
            $relayText = 'Relay: connected, access code ' + $script:RelayCode
        } elseif ($script:RelayState -eq 'retrying') {
            $relayText = 'Relay: connect failed, retrying (code ' + $script:RelayCode + ')'
        } elseif ($script:RelayState -eq 'disabled') {
            $relayText = 'Relay: disabled by the agent (see log)'
        } elseif ($script:RelayState -eq 'stopped') {
            $relayText = 'Relay: stopped (code ' + $script:RelayCode + ')'
        } elseif ($script:AgentRunning) {
            $relayText = 'Relay: connecting, access code ' + $script:RelayCode
        } else {
            $relayText = 'Relay: configured, agent not running (code ' + $script:RelayCode + ')'
        }
    }

    $listenText = 'Listening: -'
    if ($script:AgentRunning) {
        if ($script:ListenUrl.Length -gt 0) { $listenText = 'Listening: ' + $script:ListenUrl }
        else { $listenText = 'Listening: starting ...' }
    }

    $fsRootText = 'fsRoot: '
    if ($script:FsRoot.Length -gt 0) { $fsRootText = $fsRootText + $script:FsRoot }
    else { $fsRootText = $fsRootText + $env:USERPROFILE }

    if ($stateText -ne $script:LastStateText) {
        $script:LastStateText = $stateText
        $script:lblState.Text = $stateText
    }
    if ($relayText -ne $script:LastRelayText) {
        $script:LastRelayText = $relayText
        $script:lblRelay.Text = $relayText
    }
    if ($listenText -ne $script:LastListenText) {
        $script:LastListenText = $listenText
        $script:lblListen.Text = $listenText
    }
    if ($fsRootText -ne $script:LastFsRootText) {
        $script:LastFsRootText = $fsRootText
        $script:lblFsRoot.Text = $fsRootText
    }
}

function Sync-RelayCodeFromFile {
    $fromFile = Read-RelayCode
    if ($fromFile.Length -eq 0) { return }
    if (-not (Test-RelayCodeFormat $fromFile)) { return }
    if ($fromFile -eq $script:RelayCode) { return }
    $script:RelayCode = $fromFile
    if ($script:txtCode.Focused) { return }
    if ($script:txtCode.Text.Trim() -ne $fromFile) {
        $script:txtCode.Text = $fromFile
        Add-LogText 'Relay code loaded from relay-code.txt: ' + $fromFile
    }
}

function Update-Ui {
    try {
        if ($null -ne $script:LogPump) {
            $lines = $script:LogPump.Drain(200)
            foreach ($line in $lines) {
                Add-LogText $line
                Process-LogLine $line
            }
        }
        Flush-Log
        Update-ProcessState
        Sync-RelayCodeFromFile
        Update-StatusLabels
        Update-Buttons
    } catch {
        Add-LogText ('UI update error: ' + $_.Exception.Message)
        Flush-Log
    }
}

# ===========================================================================
# settings / agent lifecycle
# ===========================================================================
function Save-Settings {
    $relay = $script:txtRelay.Text.Trim()
    if ($relay.Length -gt 0) {
        if ($relay -notmatch '^(?i)(https?|wss?)://') {
            Show-Message 'The relay server must be a URL starting with http:// or https://. Leave it empty to use LAN direct connections only.' 'DSH Remote Desktop Agent' 'Warning'
            return $false
        }
        while ($relay.EndsWith('/') -and -not $relay.EndsWith('://')) {
            $relay = $relay.Substring(0, $relay.Length - 1)
        }
        $script:txtRelay.Text = $relay
    }
    $code = $script:txtCode.Text.Trim()
    if ($code.Length -gt 0) {
        if (-not (Test-RelayCodeFormat $code)) {
            Show-Message 'The relay code must be 6-32 characters of A-Z a-z 0-9 _ -. Leave it empty to let the agent create one.' 'DSH Remote Desktop Agent' 'Warning'
            return $false
        }
    }
    Write-RelayServer $relay
    Write-RelayCode $code
    $script:RelayCode = $code
    Add-LogText 'Settings saved (relay.txt, relay-code.txt).'
    return $true
}

function Initialize-Password {
    $current = Read-Password
    if ($current.Length -eq 0) {
        $generated = New-RandomPassword
        Write-Password $generated
        Add-LogText 'Created a new password file (agent-password.txt).'
        $current = $generated
    }
    $script:txtPassword.Text = $current
}

function Start-Agent {
    if ($script:AgentRunning) { return }

    $portText = $script:txtPort.Text.Trim()
    $port = 0
    if (-not [int]::TryParse($portText, [ref]$port)) {
        Show-Message 'The port must be a number between 1 and 65535.' 'DSH Remote Desktop Agent' 'Warning'
        return
    }
    if ($port -lt 1 -or $port -gt 65535) {
        Show-Message 'The port must be a number between 1 and 65535.' 'DSH Remote Desktop Agent' 'Warning'
        return
    }

    if (-not (Save-Settings)) { return }

    if (-not (Test-Path -LiteralPath $script:AgentJs)) {
        Show-Message ('remote-agent.mjs was not found at: ' + $script:AgentJs + [Environment]::NewLine + 'Reinstall the Windows agent package.') 'DSH Remote Desktop Agent' 'Error'
        return
    }

    $node = Find-Node
    if ($node.Length -eq 0) {
        $answer = Confirm-Action ('Node.js was not found next to the agent (' + (Join-Path $script:WindowsDir 'node\node.exe') + ') and it is not on PATH.' + [Environment]::NewLine + [Environment]::NewLine + 'Run start-agent.bat once to download the portable Node.js, then come back.' + [Environment]::NewLine + [Environment]::NewLine + 'Open the agent folder now?')
        if ($answer) { Open-Folder }
        return
    }

    if ((Read-Password).Length -eq 0) { Initialize-Password }

    $profileDir = $env:USERPROFILE
    if ($null -eq $profileDir -or $profileDir.Length -eq 0) {
        $profileDir = [Environment]::GetFolderPath('UserProfile')
    }

    $relay = $script:txtRelay.Text.Trim()
    $arguments = New-Object 'System.Collections.Generic.List[string]'
    $arguments.Add((Quote-Arg $script:AgentJs))
    $arguments.Add('--port')
    $arguments.Add([string]$port)
    $arguments.Add('--bind')
    $arguments.Add('0.0.0.0')
    $arguments.Add('--fs-root')
    $arguments.Add((Quote-Arg $profileDir))
    $arguments.Add('--password-file')
    $arguments.Add((Quote-Arg $script:PasswordFile))
    if ($relay.Length -gt 0) {
        $arguments.Add('--relay')
        $arguments.Add((Quote-Arg $relay))
        $arguments.Add('--relay-code-file')
        $arguments.Add((Quote-Arg $script:RelayCodeFile))
    }

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node
    $startInfo.Arguments = ($arguments.ToArray() -join ' ')
    $startInfo.WorkingDirectory = $script:AgentDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    try {
        $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    } catch { }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        $started = $process.Start()
    } catch {
        Show-Message ('Could not start the agent: ' + $_.Exception.Message) 'DSH Remote Desktop Agent' 'Error'
        return
    }
    if (-not $started) {
        Show-Message 'The agent process did not start.' 'DSH Remote Desktop Agent' 'Error'
        return
    }

    if (-not ('DsRemoteGuiLogPump' -as [type])) {
        Show-Message 'The log helper failed to load. Restart this window; if it keeps failing, run start-agent.bat (console mode) instead.' 'DSH Remote Desktop Agent' 'Error'
        try { $process.Kill() } catch { }
        return
    }
    $script:LogPump = New-Object DsRemoteGuiLogPump
    $script:LogPump.Pump($process.StandardOutput)
    $script:LogPump.Pump($process.StandardError)
    $script:AgentProcess = $process
    $script:AgentRunning = $true
    $script:RelayState = 'starting'
    $script:ListenUrl = ''
    Add-LogText ('Agent started: ' + $node + ' ' + $startInfo.Arguments)
    if ($relay.Length -gt 0) {
        Add-LogText ('Relay mode: ' + $relay + ' (access code file: ' + $script:RelayCodeFile + ')')
    } else {
        Add-LogText 'LAN direct mode only (relay server is empty).'
    }
    Update-Buttons
    Update-StatusLabels
}

function Stop-Agent {
    $process = $script:AgentProcess
    if ($null -eq $process) {
        $script:AgentRunning = $false
        Update-Buttons
        Update-StatusLabels
        return
    }
    Add-LogText 'Stopping the agent ...'
    $processId = 0
    try { $processId = $process.Id } catch { }
    try {
        if (-not $process.HasExited) { $process.Kill() }
    } catch {
        Add-LogText ('Kill failed: ' + $_.Exception.Message)
    }
    if ($processId -gt 0) {
        try {
            $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
            if (-not (Test-Path -LiteralPath $taskkill)) { $taskkill = 'taskkill.exe' }
            & $taskkill /T /F /PID $processId 2>$null | Out-Null
        } catch { }
    }
    try { [void]$process.WaitForExit(5000) } catch { }
    $script:AgentProcess = $null
    $script:AgentRunning = $false
    $script:RelayState = 'stopped'
    $script:ListenUrl = ''
    Add-LogText 'Agent stopped.'
    Update-Buttons
    Update-StatusLabels
}

# ===========================================================================
# button handlers
# ===========================================================================
function Copy-RelayServer {
    $value = $script:txtRelay.Text.Trim()
    if ($value.Length -eq 0) {
        Show-Message 'relay.txt is empty: this agent only accepts LAN direct connections. Paste the Harness address (panel: Add host -> Relay -> Copy relay.txt) and save.' 'DSH Remote Desktop Agent' 'Information'
        return
    }
    if (Set-ClipboardText $value) {
        Add-LogText 'relay.txt content copied to the clipboard.'
        Flush-Log
    }
}

function Regenerate-RelayCode {
    $code = New-RelayAccessCode
    $script:txtCode.Text = $code
    $script:RelayCode = $code
    Write-RelayCode $code
    Add-LogText ('New relay code generated and saved: ' + $code)
    Flush-Log
    if ($script:AgentRunning) {
        Show-Message ('The new relay code is saved in relay-code.txt.' + [Environment]::NewLine + [Environment]::NewLine + 'The running agent still uses the previous code. Stop and start the agent to apply it.') 'DSH Remote Desktop Agent' 'Information'
    }
}

function Copy-RelayCode {
    $code = $script:txtCode.Text.Trim()
    if (Set-ClipboardText $code) {
        Add-LogText 'Relay code copied to the clipboard.'
        Flush-Log
    }
}

function Copy-Password {
    $password = $script:txtPassword.Text.Trim()
    if (Set-ClipboardText $password) {
        Add-LogText 'Password copied to the clipboard.'
        Flush-Log
    }
}

function Regenerate-Password {
    $answer = Confirm-Action ('Generate a new 16 character password and write it to agent-password.txt?' + [Environment]::NewLine + [Environment]::NewLine + 'A running agent keeps the old password until it is restarted.')
    if (-not $answer) { return }
    $password = New-RandomPassword
    Write-Password $password
    $script:txtPassword.Text = $password
    Add-LogText 'New password generated and saved (agent-password.txt).'
    Flush-Log
    if ($script:AgentRunning) {
        Show-Message 'The new password is saved. Stop and start the agent to use it.' 'DSH Remote Desktop Agent' 'Information'
    }
}

function Open-Folder {
    try {
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $script:WindowsDir + '"')
    } catch {
        Show-Message ('Could not open the folder: ' + $_.Exception.Message) 'DSH Remote Desktop Agent' 'Warning'
    }
}

# ===========================================================================
# window
# ===========================================================================
function New-MainForm {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'DSH Remote Desktop Agent'
    $form.ClientSize = (New-GuiSize 968 741)
    $form.MinimumSize = (New-GuiSize 880 640)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'Sizable'
    $form.MaximizeBox = $true
    $form.ShowInTaskbar = $true
    $form.Font = (New-GuiFont 'Segoe UI' 9)
    $script:Form = $form

    $topLeftRight = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
    $topRight = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Right

    # ---- relay group ------------------------------------------------------
    $grpRelay = New-Object System.Windows.Forms.GroupBox
    $grpRelay.Text = 'Relay (optional, for cross-NAT / different networks)'
    $grpRelay.Location = (New-GuiPoint 12 12)
    $grpRelay.Size = (New-GuiSize 944 152)
    $grpRelay.Anchor = $topLeftRight
    $form.Controls.Add($grpRelay)

    $lblRelay = New-Object System.Windows.Forms.Label
    $lblRelay.Text = 'Relay server (Harness address; empty = LAN direct only):'
    $lblRelay.Location = (New-GuiPoint 12 22)
    $lblRelay.AutoSize = $true
    $grpRelay.Controls.Add($lblRelay)

    $script:txtRelay = New-Object System.Windows.Forms.TextBox
    $script:txtRelay.Location = (New-GuiPoint 12 42)
    $script:txtRelay.Size = (New-GuiSize 580 24)
    $script:txtRelay.Anchor = $topLeftRight
    $grpRelay.Controls.Add($script:txtRelay)

    $lblRelayHint = New-Object System.Windows.Forms.Label
    $lblRelayHint.Text = 'Paste your Harness origin here. In the panel: Add host -> mode "Relay" -> button "Copy relay.txt".'
    $lblRelayHint.Location = (New-GuiPoint 12 70)
    $lblRelayHint.AutoSize = $true
    $lblRelayHint.ForeColor = [System.Drawing.Color]::DimGray
    $grpRelay.Controls.Add($lblRelayHint)

    $btnCopyRelayTxt = New-Object System.Windows.Forms.Button
    $btnCopyRelayTxt.Text = 'Copy relay.txt'
    $btnCopyRelayTxt.Location = (New-GuiPoint 604 40)
    $btnCopyRelayTxt.Size = (New-GuiSize 150 26)
    $btnCopyRelayTxt.Anchor = $topRight
    $grpRelay.Controls.Add($btnCopyRelayTxt)

    $script:btnSave = New-Object System.Windows.Forms.Button
    $script:btnSave.Text = 'Save settings'
    $script:btnSave.Location = (New-GuiPoint 766 40)
    $script:btnSave.Size = (New-GuiSize 160 26)
    $script:btnSave.Anchor = $topRight
    $grpRelay.Controls.Add($script:btnSave)

    $lblCode = New-Object System.Windows.Forms.Label
    $lblCode.Text = 'Relay code (persisted in relay-code.txt; stays the same after a restart):'
    $lblCode.Location = (New-GuiPoint 12 98)
    $lblCode.AutoSize = $true
    $grpRelay.Controls.Add($lblCode)

    $script:txtCode = New-Object System.Windows.Forms.TextBox
    $script:txtCode.Location = (New-GuiPoint 12 118)
    $script:txtCode.Size = (New-GuiSize 300 24)
    $grpRelay.Controls.Add($script:txtCode)

    $btnRegenCode = New-Object System.Windows.Forms.Button
    $btnRegenCode.Text = 'Regenerate'
    $btnRegenCode.Location = (New-GuiPoint 320 116)
    $btnRegenCode.Size = (New-GuiSize 130 26)
    $grpRelay.Controls.Add($btnRegenCode)

    $btnCopyCode = New-Object System.Windows.Forms.Button
    $btnCopyCode.Text = 'Copy code'
    $btnCopyCode.Location = (New-GuiPoint 458 116)
    $btnCopyCode.Size = (New-GuiSize 110 26)
    $grpRelay.Controls.Add($btnCopyCode)

    $lblCodeHint = New-Object System.Windows.Forms.Label
    $lblCodeHint.Text = 'Leave empty and the agent creates one, then saves it here.'
    $lblCodeHint.Location = (New-GuiPoint 578 121)
    $lblCodeHint.AutoSize = $true
    $lblCodeHint.ForeColor = [System.Drawing.Color]::DimGray
    $grpRelay.Controls.Add($lblCodeHint)

    # ---- agent group ------------------------------------------------------
    $grpAgent = New-Object System.Windows.Forms.GroupBox
    $grpAgent.Text = 'Agent'
    $grpAgent.Location = (New-GuiPoint 12 174)
    $grpAgent.Size = (New-GuiSize 944 148)
    $grpAgent.Anchor = $topLeftRight
    $form.Controls.Add($grpAgent)

    $lblPassword = New-Object System.Windows.Forms.Label
    $lblPassword.Text = 'Password (agent-password.txt):'
    $lblPassword.Location = (New-GuiPoint 12 22)
    $lblPassword.AutoSize = $true
    $grpAgent.Controls.Add($lblPassword)

    $script:txtPassword = New-Object System.Windows.Forms.TextBox
    $script:txtPassword.Location = (New-GuiPoint 12 42)
    $script:txtPassword.Size = (New-GuiSize 400 24)
    $script:txtPassword.ReadOnly = $true
    $grpAgent.Controls.Add($script:txtPassword)

    $btnCopyPwd = New-Object System.Windows.Forms.Button
    $btnCopyPwd.Text = 'Copy password'
    $btnCopyPwd.Location = (New-GuiPoint 420 40)
    $btnCopyPwd.Size = (New-GuiSize 140 26)
    $grpAgent.Controls.Add($btnCopyPwd)

    $btnRegenPwd = New-Object System.Windows.Forms.Button
    $btnRegenPwd.Text = 'Regenerate password'
    $btnRegenPwd.Location = (New-GuiPoint 568 40)
    $btnRegenPwd.Size = (New-GuiSize 180 26)
    $grpAgent.Controls.Add($btnRegenPwd)

    $lblPort = New-Object System.Windows.Forms.Label
    $lblPort.Text = 'Port:'
    $lblPort.Location = (New-GuiPoint 772 22)
    $lblPort.AutoSize = $true
    $grpAgent.Controls.Add($lblPort)

    $script:txtPort = New-Object System.Windows.Forms.TextBox
    $script:txtPort.Location = (New-GuiPoint 772 42)
    $script:txtPort.Size = (New-GuiSize 80 24)
    $grpAgent.Controls.Add($script:txtPort)

    $lblAgentHint = New-Object System.Windows.Forms.Label
    $lblAgentHint.Text = 'Password and relay code changes apply after the agent is restarted. The agent listens on all interfaces (0.0.0.0).'
    $lblAgentHint.Location = (New-GuiPoint 12 74)
    $lblAgentHint.AutoSize = $true
    $lblAgentHint.ForeColor = [System.Drawing.Color]::DimGray
    $grpAgent.Controls.Add($lblAgentHint)

    $script:btnStart = New-Object System.Windows.Forms.Button
    $script:btnStart.Text = 'Start agent'
    $script:btnStart.Location = (New-GuiPoint 12 100)
    $script:btnStart.Size = (New-GuiSize 170 32)
    $grpAgent.Controls.Add($script:btnStart)

    $script:btnStop = New-Object System.Windows.Forms.Button
    $script:btnStop.Text = 'Stop agent'
    $script:btnStop.Location = (New-GuiPoint 192 100)
    $script:btnStop.Size = (New-GuiSize 170 32)
    $script:btnStop.Enabled = $false
    $grpAgent.Controls.Add($script:btnStop)

    $btnOpenFolder = New-Object System.Windows.Forms.Button
    $btnOpenFolder.Text = 'Open folder'
    $btnOpenFolder.Location = (New-GuiPoint 372 100)
    $btnOpenFolder.Size = (New-GuiSize 150 32)
    $grpAgent.Controls.Add($btnOpenFolder)

    # ---- status group -----------------------------------------------------
    $grpStatus = New-Object System.Windows.Forms.GroupBox
    $grpStatus.Text = 'Status'
    $grpStatus.Location = (New-GuiPoint 12 330)
    $grpStatus.Size = (New-GuiSize 944 122)
    $grpStatus.Anchor = $topLeftRight
    $form.Controls.Add($grpStatus)

    $script:lblState = New-Object System.Windows.Forms.Label
    $script:lblState.Text = 'Agent: stopped'
    $script:lblState.Location = (New-GuiPoint 14 24)
    $script:lblState.AutoSize = $true
    $script:lblState.Font = (New-GuiFont 'Segoe UI' 9 ([System.Drawing.FontStyle]::Bold))
    $grpStatus.Controls.Add($script:lblState)

    $script:lblRelay = New-Object System.Windows.Forms.Label
    $script:lblRelay.Text = 'Relay: not configured (LAN direct only)'
    $script:lblRelay.Location = (New-GuiPoint 14 50)
    $script:lblRelay.AutoSize = $true
    $grpStatus.Controls.Add($script:lblRelay)

    $script:lblListen = New-Object System.Windows.Forms.Label
    $script:lblListen.Text = 'Listening: -'
    $script:lblListen.Location = (New-GuiPoint 14 72)
    $script:lblListen.AutoSize = $true
    $grpStatus.Controls.Add($script:lblListen)

    $script:lblFsRoot = New-Object System.Windows.Forms.Label
    $script:lblFsRoot.Text = 'fsRoot: -'
    $script:lblFsRoot.Location = (New-GuiPoint 14 94)
    $script:lblFsRoot.AutoSize = $true
    $grpStatus.Controls.Add($script:lblFsRoot)

    # ---- log --------------------------------------------------------------
    $lblLog = New-Object System.Windows.Forms.Label
    $lblLog.Text = 'Log (last 500 lines):'
    $lblLog.Location = (New-GuiPoint 12 460)
    $lblLog.AutoSize = $true
    $form.Controls.Add($lblLog)

    $script:txtLog = New-Object System.Windows.Forms.TextBox
    $script:txtLog.Multiline = $true
    $script:txtLog.ReadOnly = $true
    $script:txtLog.WordWrap = $false
    $script:txtLog.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $script:txtLog.Font = (New-GuiFont 'Consolas' 8.5)
    $script:txtLog.Location = (New-GuiPoint 12 482)
    $script:txtLog.Size = (New-GuiSize 944 239)
    $script:txtLog.Anchor = $topLeftRight -bor [System.Windows.Forms.AnchorStyles]::Bottom
    $form.Controls.Add($script:txtLog)

    # ---- handlers ---------------------------------------------------------
    $btnCopyRelayTxt.add_Click({ Copy-RelayServer })
    $script:btnSave.add_Click({ if (Save-Settings) { Update-StatusLabels } })
    $btnRegenCode.add_Click({ Regenerate-RelayCode })
    $btnCopyCode.add_Click({ Copy-RelayCode })
    $btnCopyPwd.add_Click({ Copy-Password })
    $btnRegenPwd.add_Click({ Regenerate-Password })
    $script:btnStart.add_Click({ Start-Agent; Flush-Log })
    $script:btnStop.add_Click({ Stop-Agent; Flush-Log })
    $btnOpenFolder.add_Click({ Open-Folder })
    $form.add_FormClosing({
        param($sender, $closingEvent)
        if ($script:AgentRunning) {
            $answer = [System.Windows.Forms.MessageBox]::Show(
                'The agent is still running. Stop it and close the window?',
                'DSH Remote Desktop Agent',
                [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Question)
            if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
                $closingEvent.Cancel = $true
                return
            }
            Stop-Agent
        }
        if ($null -ne $script:Timer) { $script:Timer.Stop() }
    })

    return $form
}

# ===========================================================================
# main
# ===========================================================================
try {
    # One GUI instance per user session; a second launch just exits.
    try {
        $script:GuiMutex = New-Object System.Threading.Mutex -ArgumentList $false, 'DSHRemoteDesktopAgentGui'
        $acquired = $false
        try {
            $acquired = $script:GuiMutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) {
            [void][System.Windows.Forms.MessageBox]::Show('The DSH Remote Desktop agent GUI is already running.', 'DSH Remote Desktop Agent', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
            exit 0
        }
        $script:MutexAcquired = $true
    } catch {
        $script:GuiMutex = $null
        $script:MutexAcquired = $false
    }

    [System.Windows.Forms.Application]::EnableVisualStyles()
    [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

    $null = New-MainForm

    $script:txtRelay.Text = Read-RelayServer
    $script:txtCode.Text = Read-RelayCode
    $script:RelayCode = $script:txtCode.Text.Trim()
    $script:txtPort.Text = $script:DefaultPort
    Initialize-Password

    Add-LogText 'DSH Remote Desktop Agent GUI started.'
    Add-LogText ('Agent folder: ' + $script:AgentDir)
    Add-LogText ('relay.txt:    ' + $script:RelayFile)
    Add-LogText ('relay-code:   ' + $script:RelayCodeFile)
    Add-LogText ('password:     ' + $script:PasswordFile)
    $node = Find-Node
    if ($node.Length -eq 0) {
        Add-LogText 'Node.js not found. Run start-agent.bat once to download the portable Node.js before starting the agent.'
    } else {
        Add-LogText ('Node.js:      ' + $node)
    }
    if ($script:txtRelay.Text.Trim().Length -gt 0) {
        Add-LogText 'Relay server configured; the panel must use the "Relay" mode with the access code + password.'
    } else {
        Add-LogText 'No relay server configured: LAN direct connections only (IP:38080). Set a Harness address to enable cross-NAT relay.'
    }
    Flush-Log
    Update-StatusLabels
    Update-Buttons

    $script:Timer = New-Object System.Windows.Forms.Timer
    $script:Timer.Interval = 250
    $script:Timer.add_Tick({ Update-Ui })
    $script:Timer.Start()

    [System.Windows.Forms.Application]::Run($script:Form)
    exit 0
} catch {
    try {
        [void][System.Windows.Forms.MessageBox]::Show(('The GUI could not start: ' + $_.Exception.Message), 'DSH Remote Desktop Agent', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch { }
    [Console]::Error.WriteLine('gui_init_failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $script:Timer) {
        try { $script:Timer.Stop() } catch { }
    }
    if ($null -ne $script:AgentProcess) {
        try { if (-not $script:AgentProcess.HasExited) { $script:AgentProcess.Kill() } } catch { }
    }
    if ($script:MutexAcquired -and $null -ne $script:GuiMutex) {
        try { $script:GuiMutex.ReleaseMutex() } catch { }
    }
    if ($null -ne $script:GuiMutex) {
        try { $script:GuiMutex.Dispose() } catch { }
    }
}
