<#
.SYNOPSIS
  Starts scripts/measure-sepolia.js for the Sepolia run (SOP step 5) inside a wrapper that keeps Windows awake and records
  the state of the laptop once a minute.

.DESCRIPTION
  -Mode Run        the ten blocks of Thu 12 Nov (08:00 ... 20:00 IST). Refuses to start on another date, after 07:59:30, on
                   another commit than the frozen one, or if the log already exists. -LateStart allows a start after 07:59:30
                   (until 19:59:30) as a decision: every block whose slot has passed is logged as missed, which is a predefined
                   failure that competes for the two reserve slots (lowest block first); if more than two would be lost, the
                   run moves to 13 Nov (-ExpectedDate 2026-11-13 here and --date in the checker).
  -Mode Reserve    one block again in a reserve slot (-Block k -At 20:40 or 21:20), appended to the log of the run.
  -Mode Rehearsal  one block at once (--only-block 1 --no-wait) into a scratch log; nothing of it is a result.

  The wrapper holds SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) for as long as the measurement runs. On
  mains this blocks Modern Standby (Microsoft, "Prepare software for modern standby"); no power setting is changed. It checks
  that the state took effect (a second call returns the first call's flags) and restores it when the process ends.

  The live log, the console output of the measurement and the monitor file are written to -OutDir, outside every workspace
  (an editor's file watcher and indexer must not react to each appended row). They are copied into the artifact after the run.
  The wrapper never reads the env file; measure-sepolia.js reads one line of it and prints no part of the URL.

  Start it detached, for example (one string: the array form splits a path that holds spaces):
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "<this file>" -Mode Run'

  -Mode Reserve also checks, before it starts anything, that the log is exactly as the last invocation left it (size and
  SHA-256 in log_hashes.txt) and that the checker's plan names this block for this slot (check_sepolia_run.js --plan-slot);
  -AcceptUnrecordedLog lets it go on when the main run left no record (it did not end normally) or no monitor file.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Run', 'Reserve', 'Rehearsal')][string]$Mode,
  [ValidateRange(0, 10)][int]$Block = 0,
  [string]$At = '',
  [string]$ExpectedDate = '2026-11-12',
  [string]$ExpectedCommit = '73b4cca16e7c',
  [string]$ExpectedNode = 'v22.10.0',
  [string]$ExpectedRecordSha256 = '50bbf111484522a0adfee4d928dc51545acc8b8054989b3274e44128483c31d1',
  [string]$Artifact = 'E:\Blockchain IAM\Journal2\Revision - 2\artifact_v1.1',
  [string]$EnvFile = 'E:\Blockchain IAM\PhD\.env',
  [string]$OutDir = 'C:\Users\Lenovo\.r2_run',
  [ValidateRange(2, 60)][int]$TickSeconds = 60,   # the checker treats a gap over 90 s between ticks as a sleep
  [switch]$AcceptUnrecordedLog,
  [switch]$LateStart   # -Mode Run after 07:59:30: a decision; blocks whose slot has passed are logged as missed
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
$exitCode = 1
$lock = $null
$lockPath = Join-Path $OutDir 'sepolia_run.lock'
$powerReady = $false
$proc = $null
$wrapperLog = $null   # set once the output folder exists; Write-Log writes to the screen only until then

function Write-Log([string]$text) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'), $text
  # a failure to write the log (disk full, a scan holding the file) must not end the monitor or skip the cleanup
  try { if ($script:wrapperLog) { [System.IO.File]::AppendAllText($script:wrapperLog, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false))) } } catch { }
  try { Write-Host $line } catch { }
}
function Stop-Wrapper([string]$why) { throw $why }

try {
  [void](New-Item -ItemType Directory -Force $OutDir)
  $stamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
  switch ($Mode) {
    'Run'       { $tag = 'run' }
    'Reserve'   { $tag = 'reserve_b{0}_{1}' -f $Block, $At.Replace(':', '') }
    'Rehearsal' { $tag = "rehearsal_$stamp" }
  }
  $wrapperLog = Join-Path $OutDir "${tag}_wrapper.txt"
  $stdoutFile = Join-Path $OutDir "${tag}_console.txt"
  $stderrFile = Join-Path $OutDir "${tag}_stderr.txt"
  $monitorFile = Join-Path $OutDir "${tag}_monitor.jsonl"
  $record = Join-Path $Artifact 'results\sepolia_v1.1_deployment.json'
  Write-Log "wrapper start: mode $Mode, tag $tag, pid $PID"

  # ---- arguments of the mode ------------------------------------------------------------------------------------------
  if ($Mode -eq 'Reserve') {
    if ($Block -lt 1 -or $At -notmatch '^(20:40|21:20)$') { Stop-Wrapper 'Reserve needs -Block 1-10 and -At 20:40 or 21:20' }
  } elseif ($Block -ne 0 -or $At -ne '') { Stop-Wrapper '-Block and -At belong to -Mode Reserve only' }
  if ($LateStart -and $Mode -ne 'Run') { Stop-Wrapper '-LateStart belongs to -Mode Run only' }

  # ---- one wrapper at a time ------------------------------------------------------------------------------------------
  try {
    $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  } catch { Stop-Wrapper "another run is active, or its lock file is stale: $lockPath" }
  $bytes = [System.Text.Encoding]::ASCII.GetBytes("pid=$PID tag=$tag")
  $lock.Write($bytes, 0, $bytes.Length); $lock.Flush()
  # status.ps1 reads these; a refused attempt never reaches this point, so it cannot overwrite them
  $pidFile = Join-Path $OutDir "${tag}_pids.txt"
  [System.IO.File]::WriteAllText($pidFile, "wrapper=$PID`r`n")

  # ---- date, time, machine, code --------------------------------------------------------------------------------------
  if ((Get-TimeZone).Id -ne 'India Standard Time') { Stop-Wrapper "time zone is $((Get-TimeZone).Id), not India Standard Time" }
  if ($Mode -ne 'Rehearsal') {
    $today = (Get-Date).ToString('yyyy-MM-dd')
    if ($today -ne $ExpectedDate) { Stop-Wrapper "the local date is $today; the run is on $ExpectedDate" }
    $slotText = if ($Mode -eq 'Run') { '08:00' } else { $At }
    $slot = [datetime]::ParseExact("$ExpectedDate $slotText", 'yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
    if ((Get-Date) -gt $slot.AddSeconds(-30)) {
      if (-not $LateStart) { Stop-Wrapper "too late to start: the $slotText slot is less than 30 s away or has passed (-LateStart starts anyway, as a decision: see RUN_DAY.md)" }
      $lastSlot = [datetime]::ParseExact("$ExpectedDate 20:00", 'yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
      if ((Get-Date) -gt $lastSlot.AddSeconds(-30)) { Stop-Wrapper 'too late even for -LateStart: the last slot (20:00) is less than 30 s away or has passed' }
      Write-Log 'LATE START, by decision (-LateStart): every block whose slot has passed will be logged as missed, a predefined failure that competes for the two reserve slots'
    } elseif ($LateStart) { Write-Log 'NOTE: -LateStart was given but it is not late; starting normally' }
  }
  $nodeExe = (Get-Command node -ErrorAction Stop).Source
  $nodeVersion = (& $nodeExe --version).Trim()
  if ($nodeVersion -ne $ExpectedNode) { Stop-Wrapper "node is $nodeVersion, expected $ExpectedNode" }
  if (-not (Test-Path -LiteralPath (Join-Path $Artifact 'scripts\measure-sepolia.js'))) { Stop-Wrapper 'artifact folder is wrong: scripts\measure-sepolia.js not found' }
  $describe = (& git -C $Artifact describe --always --dirty --abbrev=12).Trim()
  if ($describe -ne $ExpectedCommit) { Stop-Wrapper "artifact is at $describe, expected $ExpectedCommit (not dirty)" }
  if (-not (Test-Path -LiteralPath $record)) { Stop-Wrapper 'deployment record not found' }
  $recordSha = (Get-FileHash -LiteralPath $record -Algorithm SHA256).Hash.ToLower()
  if ($recordSha -ne $ExpectedRecordSha256) { Stop-Wrapper "deployment record SHA-256 is $recordSha, expected $ExpectedRecordSha256" }
  if (-not (Test-Path -LiteralPath $EnvFile)) { Stop-Wrapper 'env file not found (it is not read here)' }
  $free = (Get-PSDrive -Name ((Split-Path -Qualifier $OutDir).TrimEnd(':'))).Free
  if ($free -lt 1GB) { Stop-Wrapper "less than 1 GB free on the drive of $OutDir" }
  foreach ($name in 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS') {
    if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name))) { Stop-Wrapper "environment variable $name is set; the run must not inherit it" }
  }
  if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable('SEPOLIA_RPC_URL'))) {
    # rpc.js lets this variable win over the env file; the checker and the preflight read the file
    Remove-Item Env:\SEPOLIA_RPC_URL
    Write-Log 'SEPOLIA_RPC_URL was set in the environment and is cleared for this run (the value is not shown); the run reads the env file only'
  }

  # ---- the log of this mode -------------------------------------------------------------------------------------------
  switch ($Mode) {
    'Run'       { $log = Join-Path $OutDir "sepolia_${ExpectedDate}_n100.jsonl"; if (Test-Path -LiteralPath $log) { Stop-Wrapper "the log already exists: $log" } }
    'Reserve'   { $log = Join-Path $OutDir "sepolia_${ExpectedDate}_n100.jsonl"; if (-not (Test-Path -LiteralPath $log)) { Stop-Wrapper "no log of the run to append to: $log" } }
    'Rehearsal' { [void](New-Item -ItemType Directory -Force (Join-Path $OutDir 'rehearsal')); $log = Join-Path $OutDir "rehearsal\rehearsal_$stamp.jsonl" }
  }
  foreach ($f in @($stdoutFile, $stderrFile, $monitorFile)) {
    if (Test-Path -LiteralPath $f) {
      $old = "$f.old_$stamp"
      Move-Item -LiteralPath $f -Destination $old
      Write-Log "an earlier output file was kept under another name: $old"
    }
  }

  # ---- Reserve: the log must be as the last invocation left it, and this block must be the plan's for this slot ---------
  if ($Mode -eq 'Reserve') {
    $hashFile = Join-Path $OutDir 'log_hashes.txt'
    $recorded = @()
    if (Test-Path -LiteralPath $hashFile) { $recorded = @(Get-Content -LiteralPath $hashFile | Where-Object { $_.EndsWith("log=$log") } | Select-Object -Last 1) }
    if ($recorded.Count -gt 0 -and $recorded[0] -match 'bytes=(\d+) sha256=([0-9a-f]{64}) ') {
      $recBytes = [int64]$Matches[1]; $recSha = $Matches[2]
      $nowBytes = (Get-Item -LiteralPath $log).Length
      $nowSha = (Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash.ToLower()
      if ($recBytes -ne $nowBytes -or $recSha -ne $nowSha) { Stop-Wrapper 'the log has changed since the last invocation ended (size or SHA-256 differ from log_hashes.txt); it must not be appended to' }
      Write-Log "log integrity: $nowBytes bytes, SHA-256 $($nowSha.Substring(0, 12))... equal to the record of the last invocation"
    } elseif (-not $AcceptUnrecordedLog) {
      Stop-Wrapper 'there is no record of this log in log_hashes.txt (the last invocation did not end normally?); pass -AcceptUnrecordedLog to go on'
    } else { Write-Log 'WARNING: no record of the log in log_hashes.txt; -AcceptUnrecordedLog was given' }

    $mainMonitor = Join-Path $OutDir 'run_monitor.jsonl'
    # No in-progress guard for the plan call (--in-progress-window 0): the lock file, which this wrapper holds, tells whether
    # another wrapper runs; the age of the log would only delay a start by two minutes after a main run that was killed.
    $planArgs = @((Join-Path $PSScriptRoot 'check_sepolia_run.js'), '--root', $Artifact, '--env', $EnvFile, '--deployment', $record, '--log', $log, '--date', $ExpectedDate, '--plan-slot', $At, '--in-progress-window', '0')
    if (Test-Path -LiteralPath $mainMonitor) { $planArgs += @('--monitor', $mainMonitor) }
    elseif ($AcceptUnrecordedLog) { $planArgs += '--no-monitor' }
    else { Stop-Wrapper "the monitor file of the main run is missing ($mainMonitor); pass -AcceptUnrecordedLog to plan without it" }
    $planStderr = Join-Path $OutDir ("reserve_plan_{0}.stderr.txt" -f $At.Replace(':',''))
    $savedPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $planOut = @(& $nodeExe @planArgs 2> $planStderr)
      $planExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedPreference
    }
    $first = Get-Content -LiteralPath $planStderr -ErrorAction SilentlyContinue | Where-Object { $_.Trim() } | Select-Object -First 1
    $safeFirst = 'none'
    if ($first) {
      # Keep only a recognised diagnostic class or code. Never copy untrusted detail from stderr into the run log.
      $kind = [regex]::Match($first, '\b(SyntaxError|TypeError|ReferenceError|RangeError|Error|ENOENT|EACCES|MODULE_NOT_FOUND|usage)\b')
      $safeFirst = if ($kind.Success) { "$($kind.Value): [details redacted]" } else { '[details redacted]' }
    }
    Write-Log "reserve plan checker exit $planExit; stderr first line: $safeFirst"
    $planLine = @($planOut | Where-Object { $_ -match '^PLAN ' } | Select-Object -Last 1)
    if ($planLine.Count -eq 0 -or $planLine[0] -notmatch '^PLAN (20:40|21:20) (\d+|none)$') { Stop-Wrapper "the plan could not be read from the checker (exit code $planExit)" }
    $planned = ($planLine[0] -split ' ')[2]
    if ($planned -eq 'none') { Stop-Wrapper "the plan names no block for the $At slot" }
    if ([int]$planned -ne $Block) { Stop-Wrapper "the plan names block $planned for the $At slot, not block $Block" }
    Write-Log "plan check: block $Block in the $At slot is the one the plan names"
  }

  # ---- keep Windows awake; prove that the state took effect ---------------------------------------------------------
  Add-Type -Namespace R2 -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern uint SetThreadExecutionState(uint esFlags);'
  Add-Type -AssemblyName System.Windows.Forms
  $flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
  $first = [R2.Power]::SetThreadExecutionState($flags)
  $powerReady = $true
  if ($first -eq 0) { Stop-Wrapper 'SetThreadExecutionState failed' }
  $second = [R2.Power]::SetThreadExecutionState($flags)
  if ($second -ne $flags) { Stop-Wrapper ('the execution state did not take effect (second call returned 0x{0:X8})' -f $second) }
  Write-Log ('execution state ES_CONTINUOUS | ES_SYSTEM_REQUIRED set and confirmed (previous state 0x{0:X8}, then 0x{1:X8})' -f $first, $second)

  # ---- what is about to run -------------------------------------------------------------------------------------------
  Write-Log "mode $Mode; artifact $describe; deployment record SHA-256 $($recordSha.Substring(0, 12))...; node $nodeVersion"
  try {
    # the verdict of the day must be tied to the code that gave it: the hashes of this wrapper and of the checker
    $selfSha = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLower()
    $checkSha = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'check_sepolia_run.js') -Algorithm SHA256).Hash.ToLower()
    Write-Log "tooling SHA-256: start_sepolia_run.ps1 $selfSha; check_sepolia_run.js $checkSha"
  } catch { Write-Log "tooling hashes not readable ($($_.Exception.GetType().Name))" }
  Write-Log "log $log; console $stdoutFile; monitor $monitorFile"

  # ---- start the measurement ------------------------------------------------------------------------------------------
  $argString = 'scripts\measure-sepolia.js --deployment "{0}" --log "{1}" --env "{2}" --block-lag 0' -f $record, $log, $EnvFile
  switch ($Mode) {
    'Reserve'   { $argString += " --only-block $Block --at $At" }
    'Rehearsal' { $argString += ' --only-block 1 --no-wait' }
  }
  $proc = Start-Process -FilePath $nodeExe -ArgumentList $argString -WorkingDirectory $Artifact -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -WindowStyle Hidden -PassThru
  [void]$proc.Handle   # keeps the handle, so that ExitCode is readable after the process ends
  [System.IO.File]::AppendAllText($pidFile, "node=$($proc.Id)`r`n")
  Write-Log "measure-sepolia.js started, pid $($proc.Id); arguments: $($argString -replace [regex]::Escape($EnvFile), '<env file>')"

  # ---- record the machine (after the start: these lookups only feed log lines, and a stuck WMI must not delay the run) ----
  try {
    $cpuName = (Get-CimInstance Win32_Processor -OperationTimeoutSec 5 | Select-Object -First 1).Name
    $os = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 5
    $powerPlanLine = (powercfg /getactivescheme) -join ' '
    $powerPlan = if ($powerPlanLine -match '\(([^)]+)\)') { $Matches[1] } else { 'unknown' }
    $power = [System.Windows.Forms.SystemInformation]::PowerStatus
    Write-Log "OS $($os.Caption) $($os.Version); CPU $cpuName; $([math]::Round($os.TotalVisibleMemorySize / 1MB)) GB RAM; power plan $powerPlan; power line $($power.PowerLineStatus), battery $([int]($power.BatteryLifePercent * 100)) %"
  } catch { Write-Log "machine description not readable ($($_.Exception.GetType().Name))" }
  try {
    # the plan records the connection type of each block: the wrapper log holds the adapter and the gateway range
    $wifi = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up -and $_.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211 } | Select-Object -First 1
    $range = 'none'
    if ($wifi) { $g = @($wifi.GetIPProperties().GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork }) | Select-Object -First 1; if ($g) { $o = $g.Address.ToString() -split '\.'; $range = "$($o[0]).$($o[1]).x.x" } }
    Write-Log "connection: Wi-Fi adapter $(if ($wifi) { $wifi.Description } else { 'none up' }); default gateway range $range (the phone hotspot has been in 10.25.x.x); the plan expects a mobile hotspot"
  } catch { Write-Log "connection description not readable ($($_.Exception.GetType().Name))" }

  # ---- monitor: one line a minute, in-process calls only --------------------------------------------------------------
  $counter = $null
  try { $counter = New-Object System.Diagnostics.PerformanceCounter('Processor', '% Processor Time', '_Total'); [void]$counter.NextValue() } catch { $counter = $null }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  # The salt is shared by every wrapper of the day (a file in the output folder, made by the first wrapper), so that the ticks of
  # the main wrapper and of a reserve wrapper are comparable. Without a salt a hash of the gateway address or of the network name
  # could be reversed by trying addresses and names. If the file cannot be used, this wrapper takes a salt of its own and says so;
  # its ticks carry another saltId, and the checker then does not compare their network identity with the start of the run.
  $saltFile = Join-Path $OutDir 'monitor_salt.txt'
  $salt = $null
  try {
    if (-not (Test-Path -LiteralPath $saltFile)) { try { [System.IO.File]::WriteAllText($saltFile, [guid]::NewGuid().ToString('N'), [System.Text.Encoding]::ASCII) } catch { } }
    $salt = ([System.IO.File]::ReadAllText($saltFile)).Trim()
    if ($salt.Length -lt 16) { $salt = $null }
  } catch { $salt = $null }
  if (-not $salt) { Write-Log 'monitor salt: the shared file could not be used; this wrapper has a salt of its own'; $salt = [guid]::NewGuid().ToString('N') }
  $saltId = (($sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes('id:' + $salt)) | Select-Object -First 4 | ForEach-Object { $_.ToString('x2') }) -join '')   # names the salt without revealing it
  $wid = [guid]::NewGuid().ToString('N').Substring(0, 8)   # unique per wrapper, unlike the pid; the checker compares ticks of one wrapper only
  $lastTick = $null
  $tickCount = 0
  try { [void][Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime] } catch { Write-Log 'the name of the connected network is not readable here: the ticks carry no network identity' }
  function Add-Tick {
    $now = [DateTime]::UtcNow
    $gap = if ($script:lastTick) { ($now - $script:lastTick).TotalSeconds } else { 0 }
    $script:lastTick = $now
    $ps = [System.Windows.Forms.SystemInformation]::PowerStatus
    $ifaces = New-Object System.Collections.Generic.List[string]
    $wifiUp = $false; $vpn = 0; $gw = ''; $rx = [int64]0; $tx = [int64]0
    # ifaces and gw describe the uplink only (interfaces with an IPv4 default gateway): virtual adapters (WSL, VirtualBox)
    # come and go on their own and are not a change of the network the run uses.
    foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($n.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
      if ($n.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
      if ($n.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211) { $wifiUp = $true }
      if ($n.Description -match 'VPN|WireGuard|TAP-|Tailscale|OpenVPN|Fortinet|Cisco|Nord|Proton|WARP') { $vpn++ }
      $gateways = @($n.GetIPProperties().GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork })
      if ($gateways.Count) {
        $ifaces.Add(('{0}:{1}' -f $n.NetworkInterfaceType, $n.Name))
        foreach ($g in $gateways) { $gw += $g.Address.ToString() + ';' }
        try { $st = $n.GetIPv4Statistics(); $rx += $st.BytesReceived; $tx += $st.BytesSent } catch { }   # cumulative bytes of the uplink
      }
    }
    $gwHash = if ($gw) { (($script:sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($script:salt + $gw)) | Select-Object -First 4 | ForEach-Object { $_.ToString('x2') }) -join '') } else { '' }
    $restart = $false
    try { $restart = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') } catch { }
    $cpu = $null
    if ($script:counter) { try { $cpu = [math]::Round($script:counter.NextValue(), 1) } catch { $cpu = $null } }
    $script:tickCount++
    if ($script:tickCount -eq 1) { $cpu = $null }   # the first reading covers the wrapper's own start-up, not the machine
    # The name of the connected network (the Wi-Fi profile name), hashed with the day's salt: the checker compares it with the
    # first tick of the run, so that a change of network that stays is seen in every later block. No profile gives ''.
    $netHash = ''
    try {
      $cp = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
      if ($cp) { $netHash = (($script:sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($script:salt + 'net:' + [string]$cp.ProfileName)) | Select-Object -First 4 | ForEach-Object { $_.ToString('x2') }) -join '') }
    } catch { $netHash = '' }
    $nodeInfo = $null
    $p = Get-Process -Id $script:proc.Id -ErrorAction SilentlyContinue
    if ($p) { $nodeInfo = [ordered]@{ alive = $true; cpuSec = [math]::Round($p.CPU, 1); wsMB = [int]($p.WorkingSet64 / 1MB) } } else { $nodeInfo = [ordered]@{ alive = $false } }
    $tick = [ordered]@{
      t = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); w = $PID; wid = $script:wid; gapSeconds = [math]::Round($gap, 1)
      power = [string]$ps.PowerLineStatus; batteryPct = [int]($ps.BatteryLifePercent * 100)
      wifiUp = $wifiUp; ifaces = @($ifaces); vpn = $vpn; gw = $gwHash; cpuPct = $cpu; node = $nodeInfo
      rxBytes = $rx; txBytes = $tx; restartPending = $restart; net = $netHash; saltId = $script:saltId
    }
    [System.IO.File]::AppendAllText($script:monitorFile, ((ConvertTo-Json $tick -Compress -Depth 4) + "`n"), $script:utf8)
  }
  function Get-TickWaitMs {
    if ($TickSeconds -ne 60) { return $TickSeconds * 1000 }
    # Phase-locked to second 45 of the wall clock. A block starts at second 0 of its minute and its requests take 25-35 s at
    # the usual round trips, so a tick does not fall inside a block (at slower round trips a block is longer and may contain one).
    $now = Get-Date
    $next = $now.Date.AddHours($now.Hour).AddMinutes($now.Minute).AddSeconds(45)
    if ($next -le $now.AddSeconds(5)) { $next = $next.AddMinutes(1) }
    return [int][math]::Max(1000, ($next - $now).TotalMilliseconds)
  }
  while (-not $proc.HasExited) {
    try { Add-Tick } catch { Write-Log "monitor tick failed: $($_.Exception.GetType().Name)" }
    [void]$proc.WaitForExit((Get-TickWaitMs))
  }
  try { Add-Tick } catch { Write-Log "last monitor tick failed: $($_.Exception.GetType().Name)" }

  # ---- the end --------------------------------------------------------------------------------------------------------
  $exitCode = [int]$proc.ExitCode
  Write-Log "measure-sepolia.js ended with exit code $exitCode"
  if (Test-Path -LiteralPath $log) {
    $rowCount = (Get-Content -LiteralPath $log | Measure-Object -Line).Lines
    $logBytes = (Get-Item -LiteralPath $log).Length
    $logSha = (Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash.ToLower()
    Write-Log "log: $rowCount lines, $logBytes bytes, SHA-256 $logSha"
    [System.IO.File]::AppendAllText((Join-Path $OutDir 'log_hashes.txt'), (('time={0} tag={1} bytes={2} sha256={3} log={4}' -f [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'), $tag, $logBytes, $logSha, $log) + "`r`n"), $utf8)
  }
  foreach ($pair in @(@('console', $stdoutFile), @('stderr', $stderrFile))) {
    if (Test-Path -LiteralPath $pair[1]) {
      $tail = @(Get-Content -LiteralPath $pair[1] -Tail 6)
      Write-Log "$($pair[0]) (last $($tail.Count) lines):"
      foreach ($l in $tail) { Write-Log "    $l" }
    }
  }
} catch {
  Write-Log "STOPPED: $($_.Exception.Message)"
} finally {
  if ($proc -and -not $proc.HasExited) { Write-Log "the wrapper ends while measure-sepolia.js (pid $($proc.Id)) is still running; it is left running" }
  if ($powerReady) { [void][R2.Power]::SetThreadExecutionState($ES_CONTINUOUS); Write-Log 'execution state restored' }
  if ($lock) {
    $lock.Dispose()
    for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $lockPath); $i++) {
      try { Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 300 }
    }
    if (Test-Path -LiteralPath $lockPath) { Write-Log "THE LOCK FILE COULD NOT BE REMOVED: $lockPath (delete it by hand before the next wrapper; see RUN_DAY.md)" }
  }
}
exit $exitCode
