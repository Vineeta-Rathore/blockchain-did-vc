<#
.SYNOPSIS
  Read-only status of a run started by start_sepolia_run.ps1: processes, the last monitor tick, the console, and what the
  log holds so far. Changes nothing and prints no part of the RPC URL.
#>
[CmdletBinding()]
param(
  [string]$OutDir = 'C:\Users\Lenovo\.r2_run',
  [string]$Tag = 'run',
  [string]$ExpectedDate = '2026-11-12'
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$slots = '08:00', '09:20', '10:40', '12:00', '13:20', '14:40', '16:00', '17:20', '18:40', '20:00'
$now = Get-Date
"now: $($now.ToString('yyyy-MM-dd HH:mm:ss')) IST"

$wl = Join-Path $OutDir "${Tag}_wrapper.txt"
$sl = Join-Path $OutDir "${Tag}_console.txt"
$el = Join-Path $OutDir "${Tag}_stderr.txt"
$ml = Join-Path $OutDir "${Tag}_monitor.jsonl"
$log = Join-Path $OutDir "sepolia_${ExpectedDate}_n100.jsonl"

"lock file (a wrapper is active): $(Test-Path -LiteralPath (Join-Path $OutDir 'sepolia_run.lock'))"
$runActive = $false
$netSummary = 'EMPTY'
if (Test-Path -LiteralPath $wl) {
  $w = Get-Content -LiteralPath $wl
  $text = $w -join "`n"
  # the wrapper log also holds refused attempts of the same tag; the pids file is written only by the wrapper that holds the lock
  $wpid = ''; $npid = ''
  $pf = Join-Path $OutDir "${Tag}_pids.txt"
  if (Test-Path -LiteralPath $pf) {
    $pt = (Get-Content -LiteralPath $pf) -join "`n"
    $m = [regex]::Match($pt, 'wrapper=(\d+)'); if ($m.Success) { $wpid = $m.Groups[1].Value }
    $m = [regex]::Match($pt, 'node=(\d+)'); if ($m.Success) { $npid = $m.Groups[1].Value }
  }
  foreach ($pair in @(@('wrapper', $wpid, 'powershell|pwsh'), @('measurement', $npid, '^node$'))) {
    if ($pair[1]) {
      $p = Get-Process -Id ([int]$pair[1]) -ErrorAction SilentlyContinue
      $state = if ($p -and $p.ProcessName -match $pair[2]) { 'running' } elseif ($p) { "not running (that id now belongs to $($p.ProcessName))" } else { 'not running' }
      if ($state -eq 'running') { $runActive = $true }
      "$($pair[0]) process $($pair[1]): $state"
    }
  }
  "wrapper log (last 4 lines):"; $w | Select-Object -Last 4 | ForEach-Object { "  $_" }
} else { "no wrapper log for tag '$Tag' in $OutDir" }

if (Test-Path -LiteralPath $ml) {
  $ticks = @(Get-Content -LiteralPath $ml | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_ -and ($_.PSObject.Properties.Name -contains 't') })
  if ($ticks.Count) {
    $last = $ticks[$ticks.Count - 1]
    $lastUtc = if ($last.t -is [DateTime]) { $last.t.ToUniversalTime() } else { [DateTime]::Parse([string]$last.t, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal) }
    $age = ([DateTime]::UtcNow - $lastUtc).TotalSeconds
    $names = @($last.PSObject.Properties.Name)
    if (($names -contains 'net') -and ($names -contains 'saltId') -and
        -not [string]::IsNullOrWhiteSpace([string]$last.net) -and
        -not [string]::IsNullOrWhiteSpace([string]$last.saltId)) { $netSummary = 'present' }
    $restart = if ($names -contains 'restartPending') { $last.restartPending } else { 'n/a' }
    $rxKB = 'n/a'
    if ($ticks.Count -ge 2 -and $names -contains 'rxBytes' -and @($ticks[$ticks.Count - 2].PSObject.Properties.Name) -contains 'rxBytes') { $rxKB = [math]::Round(($last.rxBytes - $ticks[$ticks.Count - 2].rxBytes) / 1024) }
    "last monitor tick $([math]::Round($age)) s ago (ticks come about every 60 s): power $($last.power), battery $($last.batteryPct) %, Wi-Fi up $($last.wifiUp), VPN adapters $($last.vpn), CPU $($last.cpuPct) %, measurement alive $($last.node.alive), restart pending $restart, $rxKB KB received since the previous tick"
    $gaps = @($ticks | Where-Object { $_.gapSeconds -gt 90 }).Count
    $off = @($ticks | Where-Object { $_.power -ne 'Online' }).Count
    "monitor: $($ticks.Count) ticks; ticks with a gap over 90 s: $gaps; ticks not on mains: $off"
  } else { "monitor file has no readable tick yet" }
}

$runSummary = if ($runActive) { 'running' } else { 'not running' }
"summary: $runSummary; net: $netSummary"

if (Test-Path -LiteralPath $sl) {
  $c = @(Get-Content -LiteralPath $sl)
  "console: $(@($c | Where-Object { $_ -match '^block \d+ .*done' }).Count) block(s) done, $(@($c | Where-Object { $_ -match 'missed' }).Count) missed; last lines:"
  $c | Select-Object -Last 3 | ForEach-Object { "  $_" }
}
if ((Test-Path -LiteralPath $el) -and (Get-Item -LiteralPath $el).Length -gt 0) { "STDERR HAS CONTENT:"; Get-Content -LiteralPath $el -Tail 5 | ForEach-Object { "  $_" } }

if (Test-Path -LiteralPath $log) {
  $rows = @(Get-Content -LiteralPath $log | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_ })
  "log: $($rows.Count) lines, $((Get-Item -LiteralPath $log).Length) bytes, written $([math]::Round(($now - (Get-Item -LiteralPath $log).LastWriteTime).TotalSeconds)) s ago"
  "  by kind: $(($rows | Group-Object kind | ForEach-Object { "$($_.Name) $($_.Count)" }) -join ', ')"
  $errs = @($rows | Where-Object { $_.PSObject.Properties.Name -contains 'error' -and $_.error })
  "  rows with an error: $($errs.Count)$(if ($errs.Count) { ' (' + (($errs | Group-Object error | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', ') + ')' })"
  "  blocks missed: $(@($rows | Where-Object { $_.kind -eq 'block_missed' } | ForEach-Object { $_.block }) -join ', ')"
}
$next = $slots | Where-Object { [datetime]::ParseExact("$ExpectedDate $_", 'yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture) -gt $now } | Select-Object -First 1
"next slot: $(if ($next) { $next } else { 'none today' })"
