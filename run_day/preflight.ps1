<#
.SYNOPSIS
  Read-only preflight for the Sepolia run (SOP step 5). Sends no transaction, loads no key, changes no setting, and prints no
  part of the RPC URL. Prints PASS, WARN, FAIL and INFO lines; exit code 1 if any line is FAIL.

.DESCRIPTION
  Date and time window, time zone, clock against an HTTP date header, mains power, network (Wi-Fi up, no VPN adapter), the two
  Windows restart flags and Windows Update worker processes, background load (total CPU from the performance counters, which
  cover every process without elevation), free disk and an absent log, Node version, the artifact (commit, tracked files,
  contract hash, deployment record hash), sleep settings, and the chain (preflight_chain.js: chain id, round trips, predicted
  compute-unit draw, nonce, code, credential B). -WithPilot also runs the three-iteration pilot into a scratch log and applies
  the pilot gate (checks\gates_2026-11-09\check_pilot.js).
  -Rehearsal turns the date and time-window checks into INFO (for a rehearsal on another day).
#>
[CmdletBinding()]
param(
  [string]$ExpectedDate = '2026-11-12',
  [string]$ExpectedCommit = '73b4cca16e7c',
  [string]$ExpectedNode = 'v22.10.0',
  [string]$ExpectedRecordSha256 = '50bbf111484522a0adfee4d928dc51545acc8b8054989b3274e44128483c31d1',
  [string]$ExpectedContractSha256 = '2a4e07578c99c015bf6618a5c76b8149aadeebd8835b0fc632d9d6aef35060a3',
  [string]$Artifact = 'E:\Blockchain IAM\Journal2\Revision - 2\artifact_v1.1',
  [string]$EnvFile = 'E:\Blockchain IAM\PhD\.env',
  [string]$OutDir = 'C:\Users\Lenovo\.r2_run',
  [switch]$Rehearsal,
  [switch]$WithPilot,
  [switch]$Force,
  [switch]$LateStart,  # the start will be late and -LateStart will be given to the wrapper: the time window is a WARN
  [string]$CuLimit = ''  # the compute units per second of the Alchemy plan, read from the dashboard (the chain preflight assumes 300 without it)
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:fails = 0
$script:warns = 0
$script:lines = New-Object System.Collections.Generic.List[string]

function Add-Line([string]$level, [string]$text) {
  if ($level -eq 'FAIL') { $script:fails++ }
  if ($level -eq 'WARN') { $script:warns++ }
  $l = '{0} {1}' -f $level.PadRight(4), $text
  $script:lines.Add($l)
  Write-Host $l
}
function Check([bool]$ok, [string]$text, [string]$failLevel = 'FAIL') { if ($ok) { Add-Line 'PASS' $text } else { Add-Line $failLevel $text } }

$now = Get-Date
Add-Line 'INFO' "preflight at $($now.ToString('yyyy-MM-dd HH:mm:ss zzz')); expected run date $ExpectedDate$(if ($Rehearsal) { '; rehearsal: date and time-window checks are information only' })"

# The preflight sends requests on the run's API key and loads the CPU: it must not run while a block may be in progress.
$lockFile = Join-Path $OutDir 'sepolia_run.lock'
if ((Test-Path -LiteralPath $lockFile) -and -not $Force) {
  Add-Line 'FAIL' "a wrapper is running or left its lock file ($lockFile): the preflight would add traffic on the run's key and load to a run in progress. Use status.ps1, or pass -Force."
  exit 1
}

try {
  # ---- date, time, zone, clock ----------------------------------------------------------------------------------------
  if ($Rehearsal) { Add-Line 'INFO' "date $($now.ToString('yyyy-MM-dd')) (rehearsal)" }
  else {
    Check ($now.ToString('yyyy-MM-dd') -eq $ExpectedDate) "local date $($now.ToString('yyyy-MM-dd')) equals the run date $ExpectedDate"
    $first = [datetime]::ParseExact("$ExpectedDate 08:00", 'yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
    $minutes = ($first - $now).TotalMinutes
    if ($minutes -lt 0.5 -and $LateStart) { Add-Line 'WARN' "block 1 (08:00) is $([math]::Round(-$minutes, 1)) min past or less than 30 s away: with -LateStart the wrapper starts anyway and logs every passed slot as missed (they compete for the two reserve slots)" }
    elseif ($minutes -lt 0.5) { Add-Line 'FAIL' "block 1 (08:00) is $([math]::Round(-$minutes, 1)) min past or less than 30 s away: too late to start the run without -LateStart (a decision, see RUN_DAY.md)" }
    elseif ($minutes -lt 10) { Add-Line 'WARN' "only $([math]::Round($minutes, 1)) min to block 1 (08:00)" }
    else { Add-Line 'PASS' "$([math]::Round($minutes)) min to block 1 (08:00)" }
  }
  Check ((Get-TimeZone).Id -eq 'India Standard Time') "time zone $((Get-TimeZone).Id) (must be India Standard Time: the slots are local times)"
  try {
    $t0 = [DateTime]::UtcNow
    $resp = Invoke-WebRequest -Uri 'https://www.microsoft.com' -Method Head -UseBasicParsing -TimeoutSec 20
    $t1 = [DateTime]::UtcNow
    $remote = [DateTimeOffset]::Parse($resp.Headers['Date']).UtcDateTime
    $mid = $t0.AddTicks(($t1 - $t0).Ticks / 2)
    $offset = ($mid - $remote).TotalSeconds
    if ([math]::Abs($offset) -le 2.5) { Add-Line 'PASS' ("clock offset against an HTTP date header {0:N1} s (round trip {1:N0} ms)" -f $offset, ($t1 - $t0).TotalMilliseconds) }
    elseif ([math]::Abs($offset) -le 20) { Add-Line 'WARN' ("clock offset {0:N1} s against an HTTP date header; blocks may start that much off their slots" -f $offset) }
    else { Add-Line 'FAIL' ("clock offset {0:N1} s against an HTTP date header: set the clock before the run" -f $offset) }
  } catch { Add-Line 'WARN' "could not read an HTTP date header to check the clock ($($_.Exception.GetType().Name))" }

  # ---- environment the run would inherit (values are never shown) -------------------------------------------------------
  foreach ($name in 'SEPOLIA_RPC_URL', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS') {
    Check ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name))) "environment variable $name must not be set in this shell (a set value would be inherited by the run; the value is never shown)"
  }

  # ---- power, network -------------------------------------------------------------------------------------------------
  Add-Type -AssemblyName System.Windows.Forms
  $ps = [System.Windows.Forms.SystemInformation]::PowerStatus
  Check ($ps.PowerLineStatus -eq 'Online') "power line $($ps.PowerLineStatus), battery $([int]($ps.BatteryLifePercent * 100)) % (mains is essential: on battery a power request blocks Modern Standby for 5 minutes only)"
  $wifi = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.PhysicalMediaType -match 'Native 802.11|802.11' })
  Check ($wifi.Count -ge 1) "Wi-Fi adapter up: $(($wifi | ForEach-Object { "$($_.Name) $($_.LinkSpeed)" }) -join '; ')"
  $gw = @(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $o = $_.IPv4DefaultGateway.NextHop -split '\.'; "$($_.InterfaceAlias) via $($o[0]).$($o[1]).x.x" })
  Check ($gw.Count -ge 1) "default gateway: $($gw -join '; ') (the hotspot was in 10.25.x.x on 9-10 Nov)"
  if (@($gw | Where-Object { $_ -match ' via 10\.25\.' }).Count -eq 0) { Add-Line 'WARN' 'the default gateway is not in 10.25.x.x, where the phone hotspot was; confirm that the laptop is on the hotspot (the range may change when the hotspot is restarted) and note it' }
  $vpn = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -match 'VPN|WireGuard|TAP-|Tailscale|OpenVPN|Fortinet|Cisco|Nord|Proton|WARP' })
  Check ($vpn.Count -eq 0) "VPN adapters up: $(if ($vpn.Count) { ($vpn | ForEach-Object { $_.InterfaceDescription }) -join '; ' } else { 'none' })"
  $profileName = ''
  try {
    [void][Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime]
    $profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
    if ($profile) {
      $profileName = [string]$profile.ProfileName
      $cost = $profile.GetConnectionCost()
      Add-Line 'INFO' "connection cost type $($cost.NetworkCostType) (Unrestricted = not metered)"
    }
  } catch { Add-Line 'INFO' 'connection profile or cost not readable' }
  Check (-not [string]::IsNullOrWhiteSpace($profileName)) 'connection profile name present. If missing, reconnect to the phone hotspot and rerun preflight.'

  # ---- Windows restart, sleep settings --------------------------------------------------------------------------------
  $rr = Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  $rp = Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
  Check (-not $rr -and -not $rp) "restart pending: RebootRequired $rr, RebootPending $rp (a pending restart can end the run; pause evidence is checked below)"
  $paused = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' -ErrorAction SilentlyContinue)
  $pauseValue = if ($paused -and ($paused.PSObject.Properties.Name -contains 'PauseUpdatesExpiryTime')) { [string]$paused.PauseUpdatesExpiryTime } else { '' }
  $pauseExpiry = [DateTimeOffset]::MinValue
  $pauseKnown = [DateTimeOffset]::TryParse($pauseValue, [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeLocal, [ref]$pauseExpiry)
  $pauseRequired = [datetime]::new(2026, 11, 14, 0, 0, 0)
  if (-not $pauseKnown -or $pauseExpiry.LocalDateTime -lt $pauseRequired) {
    Add-Line 'WARN' 'Windows Update pause expiry is missing, unreadable or earlier than 14 Nov 2026 00:00 local time (it must cover 12 and 13 Nov in full). Check Windows Update settings.'
  }
  Add-Line 'INFO' "Windows Update pause value: $(if ($paused -and ($paused.PSObject.Properties.Name -contains 'PauseUpdatesExpiryTime')) { $paused.PauseUpdatesExpiryTime } else { 'not set' }); active hours $(if ($paused -and ($paused.PSObject.Properties.Name -contains 'ActiveHoursStart')) { "$($paused.ActiveHoursStart)-$($paused.ActiveHoursEnd)" } else { 'n/a' })"
  $timeouts = foreach ($q in @(@('SUB_SLEEP', 'STANDBYIDLE'), @('SUB_SLEEP', 'HIBERNATEIDLE'), @('SUB_VIDEO', 'VIDEOIDLE'))) {
    $line = (powercfg /q SCHEME_CURRENT $q[0] $q[1] | Select-String 'Current AC Power Setting Index')
    $v = if ($line) { [Convert]::ToInt32((($line.Line -split '0x')[1]).Trim(), 16) } else { -1 }
    "$($q[1])=$v"
  }
  Add-Line 'INFO' "timeouts on mains in seconds (0 = never): $($timeouts -join ', ')"

  # ---- Windows Update workers --------------------------------------------------------------------------------------------
  # Process names are visible without elevation (only the CPU time of protected processes is not).
  $wuWorkers = @(Get-Process -Name TiWorker, TrustedInstaller, MoUsoCoreWorker, UsoClient, wuauclt -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName } | Sort-Object -Unique)
  Check ($wuWorkers.Count -eq 0) "Windows Update worker processes running: $(if ($wuWorkers.Count) { $wuWorkers -join ', ' } else { 'none' }) (a download or install under way loads the CPU and the network and can end in a restart: look at Settings > Windows Update)" 'WARN'

  # ---- background load ------------------------------------------------------------------------------------------------
  # Performance counters read through .NET: they work without elevation and cover every process (Get-Process .CPU is empty for the
  # protected ones: svchost, Defender, the update installer), and an instance that exits between two reads is simply skipped
  # (Get-Counter throws on it).
  function Read-Category([string]$name) { (New-Object System.Diagnostics.PerformanceCounterCategory($name)).ReadCategory() }
  function Get-Rate($first, $second) { [System.Diagnostics.CounterSampleCalculator]::ComputeCounterValue($first.Sample, $second.Sample) }
  $cores = [Environment]::ProcessorCount
  $procA = Read-Category 'Process'; $cpuA = Read-Category 'Processor'
  Start-Sleep -Seconds 10
  $procB = Read-Category 'Process'; $cpuB = Read-Category 'Processor'
  $totalPct = Get-Rate $cpuA['% Processor Time']['_Total'] $cpuB['% Processor Time']['_Total']
  $busy = New-Object System.Collections.Generic.List[object]
  foreach ($n in $procB['% Processor Time'].Keys) {
    if ($n -eq '_Total' -or $n -eq 'Idle') { continue }
    if (-not $procA['% Processor Time'].Contains($n)) { continue }
    $busy.Add([pscustomobject]@{ Name = $n; Pct = (Get-Rate $procA['% Processor Time'][$n] $procB['% Processor Time'][$n]) / $cores })
  }
  $top = @($busy | Sort-Object Pct -Descending | Select-Object -First 3)
  $loadLevel = if ($totalPct -gt 20) { 'FAIL' } elseif ($totalPct -gt 10) { 'WARN' } else { 'PASS' }
  Add-Line $loadLevel ("total CPU over 10 s {0:N1} % of {1} logical CPUs (PASS up to 10 %, WARN above 10 %, FAIL above 20 %); top three of {2} processes: {3}" -f $totalPct, $cores, $busy.Count, (($top | ForEach-Object { '{0} {1:N1} %' -f $_.Name, $_.Pct }) -join '; '))
  $nodeProcs = $null
  try { $nodeProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 10) }
  catch { Add-Line 'WARN' "could not list the node processes through WMI ($($_.Exception.GetType().Name)): look in Task Manager for a measure-sepolia.js process" }
  if ($null -ne $nodeProcs) {
    $stray = @($nodeProcs | Where-Object { $_.CommandLine -match 'measure-sepolia' })
    Check ($stray.Count -eq 0) "no measure-sepolia.js process is running or waiting for a slot ($($stray.Count) found; one that waits uses no CPU but draws on the same key at its slot)"
    $lsp = @($nodeProcs | Where-Object { $_.CommandLine -match 'aws-lsp|codewhisperer' })
    if ($lsp.Count) { Add-Line 'INFO' "Amazon Q language server running (pid $(($lsp | ForEach-Object { $_.ProcessId }) -join ',')); its CPU is part of the load above (on 9 Nov it used about one core for some minutes); the live log is written outside the workspace" }
  }

  # ---- disk, node, log -------------------------------------------------------------------------------------------------
  [void](New-Item -ItemType Directory -Force $OutDir)
  $free = (Get-PSDrive -Name ((Split-Path -Qualifier $OutDir).TrimEnd(':'))).Free
  Check ($free -ge 2GB) "free space on the drive of $OutDir : $([math]::Round($free / 1GB, 1)) GB" 'WARN'
  $runLog = Join-Path $OutDir "sepolia_${ExpectedDate}_n100.jsonl"
  Check (-not (Test-Path -LiteralPath $runLog)) "the log of the run does not exist yet ($runLog)" 'WARN'
  Check (-not (Test-Path -LiteralPath (Join-Path $OutDir 'sepolia_run.lock'))) 'no lock file of another run' 'WARN'
  $nodeVersion = (& node --version).Trim()
  Check ($nodeVersion -eq $ExpectedNode) "node $nodeVersion (the local run, the pilot and the deployment used $ExpectedNode)"
  $ethersVersion = (Get-Content -Raw -LiteralPath (Join-Path $Artifact 'node_modules\ethers\package.json') | ConvertFrom-Json).version
  Check ($ethersVersion -eq '5.8.0') "ethers $ethersVersion installed in the artifact (the local run, the pilot and the deployment used 5.8.0)"

  # ---- artifact -------------------------------------------------------------------------------------------------------
  $describe = (& git -C $Artifact describe --always --dirty --abbrev=12).Trim()
  Check ($describe -eq $ExpectedCommit) "artifact commit $describe (expected $ExpectedCommit, not dirty)"
  & git -C $Artifact diff --quiet
  Check ($LASTEXITCODE -eq 0) 'no tracked file of the artifact has changed'
  $contractSha = (Get-FileHash -LiteralPath (Join-Path $Artifact 'contracts\DIDRegistry.sol') -Algorithm SHA256).Hash.ToLower()
  Check ($contractSha -eq $ExpectedContractSha256) 'contracts\DIDRegistry.sol equals the freeze record'
  $record = Join-Path $Artifact 'results\sepolia_v1.1_deployment.json'
  $recordSha = (Get-FileHash -LiteralPath $record -Algorithm SHA256).Hash.ToLower()
  Check ($recordSha -eq $ExpectedRecordSha256) "deployment record SHA-256 $($recordSha.Substring(0, 12))... equals the recorded value"
  Check (Test-Path -LiteralPath $EnvFile) 'env file present (not read here)'

  # ---- chain (read-only) -----------------------------------------------------------------------------------------------
  Add-Line 'INFO' '--- chain (preflight_chain.js) ---'
  $chainErr = Join-Path $OutDir ("preflight_chain_stderr_{0}.txt" -f (Get-Date).ToString('yyyyMMdd_HHmmss'))
  $eapBefore = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # under 'Stop', Windows PowerShell 5.1 throws on the first stderr line that is redirected
  try {
    $chainArgs = @('--root', $Artifact, '--env', $EnvFile, '--deployment', $record)
    if ($CuLimit) { $chainArgs += @('--cu-limit', $CuLimit) }
    $chain = @(& node (Join-Path $here 'preflight_chain.js') @chainArgs 2> $chainErr)
    $chainExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $eapBefore }
  foreach ($c in $chain) { if ($c -match '^FAIL') { $script:fails++ } elseif ($c -match '^WARN') { $script:warns++ }; $script:lines.Add($c); Write-Host $c }
  # Fail closed: a crashed or silent chain script must not look like a clean preflight.
  $chainFails = @($chain | Where-Object { $_ -match '^FAIL' }).Count
  if ($chainExit -ne 0 -and $chainFails -eq 0) { Add-Line 'FAIL' "preflight_chain.js ended with exit code $chainExit and printed no FAIL line" }
  if (@($chain | Where-Object { $_ -match '^PASS credential B through the pipeline' }).Count -eq 0) { Add-Line 'FAIL' 'the chain preflight did not reach its last check (credential B through the pipeline): the chain checks are incomplete' }
  if ((Test-Path -LiteralPath $chainErr) -and (Get-Item -LiteralPath $chainErr).Length -gt 0) { Add-Line 'WARN' "preflight_chain.js wrote to stderr (see $chainErr)" }
  else { Remove-Item -LiteralPath $chainErr -Force -ErrorAction SilentlyContinue }

  # ---- optional pilot ---------------------------------------------------------------------------------------------------
  if ($WithPilot) {
    Add-Line 'INFO' '--- pilot (3 iterations, block lag 0; not a result) ---'
    $pilotLog = Join-Path $OutDir ("pilot_{0}.jsonl" -f (Get-Date).ToString('yyyyMMdd_HHmmss'))
    Push-Location $Artifact
    & node scripts\measure-sepolia.js --pilot --block-lag 0 --deployment $record --log $pilotLog --env $EnvFile | ForEach-Object { Add-Line 'INFO' $_ }
    $pilotExit = $LASTEXITCODE
    Pop-Location
    Check ($pilotExit -eq 0) "pilot process exit code $pilotExit"
    $pg = & node (Join-Path $Artifact '..\checks\gates_2026-11-09\check_pilot.js') $Artifact $EnvFile $pilotLog 0
    $pgExit = $LASTEXITCODE
    foreach ($c in $pg) { $script:lines.Add($c); Write-Host $c }
    Check ($pgExit -eq 0) 'pilot gate (checks\gates_2026-11-09\check_pilot.js: every check it prints) passed'
  }
} catch {
  Add-Line 'FAIL' "preflight stopped: $($_.Exception.GetType().Name): $($_.Exception.Message.Split([char]10)[0])"
}

Add-Line 'INFO' "preflight result: $($script:fails) FAIL, $($script:warns) WARN"
try {
  [void](New-Item -ItemType Directory -Force $OutDir)
  $report = Join-Path $OutDir ("preflight_{0}.txt" -f (Get-Date).ToString('yyyyMMdd_HHmmss'))
  [System.IO.File]::WriteAllLines($report, $script:lines, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "report: $report"
} catch { Write-Host 'report not written' }
exit $(if ($script:fails) { 1 } else { 0 })
