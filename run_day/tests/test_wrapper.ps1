<#
.SYNOPSIS
  Tests of start_sepolia_run.ps1: its refusal paths and one complete Reserve start, in a temporary folder.

.DESCRIPTION
  Nothing leaves the machine and no real env file is read: the test writes its own fake env file whose URL points at a closed
  local port (127.0.0.1:9), so the measurement process that the one positive case starts fails at once, which is all the case
  needs (the wrapper's checks, the keep-awake state, the monitor, the end-of-run record and the cleanup). The synthetic log
  comes from make_synth_log.js. Run it before 20:00 (the Run and Reserve guards depend on the time of day; the Run cases use
  -LateStart, which works until 19:59:30). Cleans up after itself.

    powershell -NoProfile -ExecutionPolicy Bypass -File tests\test_wrapper.ps1
#>
[CmdletBinding()]
param()
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$rd = Split-Path -Parent $here
$wrapper = Join-Path $rd 'start_sepolia_run.ps1'
$artifact = 'E:\Blockchain IAM\Journal2\Revision - 2\artifact_v1.1'
if ((Get-Date).TimeOfDay -gt [TimeSpan]::FromHours(20)) { throw 'run this test before 20:00: the guards of the wrapper depend on the time of day' }

$today = (Get-Date).ToString('yyyy-MM-dd')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('r2_wrapper_test_' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$t = [System.IO.Path]::GetFullPath($t)
if (-not $t.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $t) -notmatch '^r2_wrapper_test_[0-9a-f]{8}$') { throw 'test scratch path is outside its temporary root' }
[void](New-Item -ItemType Directory -Force $t)
$fakeEnv = Join-Path $t 'fake.env'
[System.IO.File]::WriteAllText($fakeEnv, "SEPOLIA_RPC_URL=https://127.0.0.1:9/v2/TESTONLYabcd1234`r`n")
$log = Join-Path $t "sepolia_${today}_n100.jsonl"
$monitor = Join-Path $t 'run_monitor.jsonl'
$pass = 0; $fail = 0
$measureBefore = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'measure-sepolia' }).Count

function Invoke-Wrapper([string[]]$extra) {
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper -OutDir $t -EnvFile $fakeEnv -TickSeconds 2 @extra | Out-String
  [pscustomobject]@{ Exit = $LASTEXITCODE; Out = $out }
}
function Expect([string]$name, $r, [int]$exit, [string[]]$has) {
  $problems = @()
  if ($r.Exit -ne $exit) { $problems += "exit $($r.Exit), expected $exit" }
  foreach ($h in $has) { if ($r.Out -notlike "*$h*") { $problems += "missing '$h'" } }
  if (Test-Path -LiteralPath (Join-Path $t 'sepolia_run.lock')) { $problems += 'a lock file was left' }
  if ($problems.Count) { $script:fail++; "WRONG  $name : $($problems -join '; ')"; ($r.Out -split "`n" | Select-Object -Last 6) | ForEach-Object { "         $_" } }
  else { $script:pass++; "right  $name" }
}

try {
  node (Join-Path $here 'make_synth_log.js') $artifact (Join-Path $here 'template_clean_block.jsonl') $today '3' $log $monitor | Out-Null

  Expect 'Run on another date' (Invoke-Wrapper @('-Mode', 'Run', '-ExpectedDate', '2000-01-01')) 1 @('the local date is')
  Expect 'Reserve without block and slot' (Invoke-Wrapper @('-Mode', 'Reserve', '-ExpectedDate', $today)) 1 @('Reserve needs -Block')
  Expect 'Run with a block argument' (Invoke-Wrapper @('-Mode', 'Run', '-Block', '3', '-ExpectedDate', $today)) 1 @('belong to -Mode Reserve only')
  Expect '-LateStart with Reserve' (Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '3', '-At', '20:40', '-LateStart', '-ExpectedDate', $today)) 1 @('-LateStart belongs to -Mode Run only')
  Expect 'Run with a wrong expected commit' (Invoke-Wrapper @('-Mode', 'Run', '-LateStart', '-ExpectedDate', $today, '-ExpectedCommit', 'deadbeef0000')) 1 @('artifact is at', 'expected deadbeef0000')
  Expect 'Run with a wrong record hash' (Invoke-Wrapper @('-Mode', 'Run', '-LateStart', '-ExpectedDate', $today, '-ExpectedRecordSha256', ('0' * 64))) 1 @('deployment record SHA-256 is')
  Expect 'Run with a wrong node version' (Invoke-Wrapper @('-Mode', 'Run', '-LateStart', '-ExpectedDate', $today, '-ExpectedNode', 'v1.0.0')) 1 @('node is')
  Expect 'Run while the log exists' (Invoke-Wrapper @('-Mode', 'Run', '-LateStart', '-ExpectedDate', $today)) 1 @('the log already exists')

  Set-Content (Join-Path $t 'sepolia_run.lock') 'held by the test'
  $r = Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '3', '-At', '20:40', '-ExpectedDate', $today)
  Remove-Item (Join-Path $t 'sepolia_run.lock') -Force
  if ($r.Exit -eq 1 -and $r.Out -like '*another run is active*') { $pass++; 'right  Reserve while a lock file exists' } else { $fail++; "WRONG  Reserve while a lock file exists: exit $($r.Exit)" }

  $savedLog = Join-Path $t 'main.jsonl.keep'; Move-Item $log $savedLog
  Expect 'Reserve without a log to append to' (Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '3', '-At', '20:40', '-ExpectedDate', $today)) 1 @('no log of the run to append to')
  Move-Item $savedLog $log
  Expect 'Reserve without a hash record' (Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '3', '-At', '20:40', '-ExpectedDate', $today)) 1 @('no record of this log')

  $sha = (Get-FileHash $log -Algorithm SHA256).Hash.ToLower(); $bytes = (Get-Item $log).Length
  $hashFile = Join-Path $t 'log_hashes.txt'
  Set-Content $hashFile ("time=x tag=run bytes={0} sha256={1} log={2}" -f ($bytes + 1), $sha, $log)
  Expect 'Reserve with a hash record that does not match the log' (Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '3', '-At', '20:40', '-ExpectedDate', $today)) 1 @('the log has changed since the last invocation ended')
  Set-Content $hashFile ("time=x tag=run bytes={0} sha256={1} log={2}" -f $bytes, $sha, $log)
  Expect 'Reserve for the wrong block (4; the plan names 3)' (Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '4', '-At', '20:40', '-ExpectedDate', $today)) 1 @('the plan names block 3 for the 20:40 slot, not block 4')
  Expect 'Reserve for the 21:20 slot (the plan names no block)' (Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '3', '-At', '21:20', '-ExpectedDate', $today)) 1 @('the plan names no block for the 21:20 slot')
  $env:NODE_OPTIONS = '--max-old-space-size=100'
  Expect 'NODE_OPTIONS set in the launching shell' (Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '3', '-At', '20:40', '-ExpectedDate', $today)) 1 @('NODE_OPTIONS is set')
  Remove-Item Env:NODE_OPTIONS

  # one complete start: the plan names block 3 for 20:40; the measurement process fails at once (closed port); the wrapper must
  # clear a bogus SEPOLIA_RPC_URL, hold and restore the execution state, write ticks and the hash record, and release the lock
  $env:SEPOLIA_RPC_URL = 'https://bogus.example.invalid/v2/SHOULDNOTBEUSED12345'
  $r = Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '3', '-At', '20:40', '-ExpectedDate', $today)
  Remove-Item Env:SEPOLIA_RPC_URL
  Expect 'Reserve for the planned block: a complete start and end' $r 1 @('SEPOLIA_RPC_URL was set in the environment and is cleared', 'log integrity:', 'plan check: block 3 in the 20:40 slot', 'confirmed (previous state 0x80000000, then 0x80000001)', 'measure-sepolia.js ended with exit code 1', 'execution state restored')
  $recorded = @(Get-Content $hashFile | Where-Object { $_ -match 'tag=reserve_b3_2040 ' }).Count
  if ($recorded -eq 1) { $pass++; 'right  the end of that invocation was recorded in log_hashes.txt' } else { $fail++; "WRONG  log_hashes.txt has $recorded record(s) for it" }
  $ticks = @(Get-Content (Join-Path $t 'reserve_b3_2040_monitor.jsonl') -ErrorAction SilentlyContinue)
  if ($ticks.Count -ge 1 -and ($ticks[0] | ConvertFrom-Json).wid) { $pass++; 'right  the monitor wrote ticks that carry a wrapper id' } else { $fail++; 'WRONG  no monitor tick with a wrapper id' }
  $names = if ($ticks.Count) { @(($ticks[0] | ConvertFrom-Json).PSObject.Properties.Name) } else { @() }
  $missing = @(@('rxBytes', 'txBytes', 'restartPending', 'cpuPct', 'gw', 'ifaces', 'gapSeconds', 'net', 'saltId') | Where-Object { $names -notcontains $_ })
  if ($ticks.Count -ge 1 -and $missing.Count -eq 0) { $pass++; 'right  a tick carries the traffic counters, the restart flag, the CPU and the network fields' } else { $fail++; "WRONG  a tick lacks: $($missing -join ', ')" }
  # every wrapper log line starts with the time and its zone, and the log names the hashes of the tooling that ran
  $wl = @(Get-Content (Join-Path $t 'reserve_b3_2040_wrapper.txt') -ErrorAction SilentlyContinue)
  $zoned = @($wl | Where-Object { $_ -match '^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d ' }).Count
  if ($wl.Count -ge 5 -and $zoned -eq $wl.Count) { $pass++; 'right  every line of the wrapper log starts with a time and its zone' } else { $fail++; "WRONG  $zoned of $($wl.Count) wrapper log lines start with a time and a zone" }
  $selfSha = (Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLower()
  $checkSha = (Get-FileHash -LiteralPath (Join-Path $rd 'check_sepolia_run.js') -Algorithm SHA256).Hash.ToLower()
  if (@($wl | Where-Object { $_ -like "*tooling SHA-256: start_sepolia_run.ps1 $selfSha; check_sepolia_run.js $checkSha*" }).Count -eq 1) { $pass++; 'right  the wrapper log holds the SHA-256 of the wrapper and of the checker' } else { $fail++; 'WRONG  the tooling hashes are missing or differ from the files' }
  # the machine description comes after the start of the measurement (a stuck WMI must not delay it)
  $iStart = ($wl | Select-String -SimpleMatch 'measure-sepolia.js started').LineNumber | Select-Object -First 1
  $iOs = ($wl | Select-String -Pattern ' OS |machine description not readable' | Select-Object -First 1).LineNumber
  if ($iStart -and $iOs -and $iOs -gt $iStart) { $pass++; 'right  the machine description is written after the node start' } else { $fail++; "WRONG  machine description at line $iOs, node start at line $iStart" }
  # the phase lock of the monitor ticks (with -TickSeconds 60 the wait ends at second 45): a pure function of the clock, tested
  # with a Get-Date that is shadowed inside the scriptblock only
  $fm = [regex]::Match((Get-Content -Raw -LiteralPath $wrapper), '(?s)  function Get-TickWaitMs \{.*?\r?\n  \}\r?\n')
  $phaseBad = @()
  if (-not $fm.Success) { $phaseBad += 'Get-TickWaitMs not found in the wrapper' }
  else {
    foreach ($case in @(@('00.000', 45000), @('39.900', 5100), @('40.100', 64900), @('44.500', 60500), @('46.000', 59000))) {
      $got = & {
        param($sec, $body)
        $fake = [datetime]::ParseExact("2026-11-11 08:00:$sec", 'yyyy-MM-dd HH:mm:ss.fff', [System.Globalization.CultureInfo]::InvariantCulture)
        function Get-Date { $fake }
        $TickSeconds = 60
        Invoke-Expression $body
        [int](Get-TickWaitMs)
      } $case[0] $fm.Value
      if ([math]::Abs($got - $case[1]) -gt 1) { $phaseBad += "at second $($case[0]) the wait is $got ms, expected $($case[1])" }
    }
  }
  if ($phaseBad.Count -eq 0) { $pass++; 'right  the monitor ticks are phase-locked to second 45 (5 clock positions)' } else { $fail++; "WRONG  phase lock: $($phaseBad -join '; ')" }
  # the salt is shared by the wrappers of one day: the file exists, the first tick names it (saltId), the first tick has a null CPU
  # (it would show the wrapper's own start-up), and a second wrapper (a rehearsal against the closed port) writes the same salt id,
  # the same gateway hash and the same network hash
  $first = $ticks[0] | ConvertFrom-Json
  $saltFile = Join-Path $t 'monitor_salt.txt'
  $saltOk = $false
  if (Test-Path -LiteralPath $saltFile) {
    $saltText = ([System.IO.File]::ReadAllText($saltFile)).Trim()
    $sha1 = [System.Security.Cryptography.SHA256]::Create()
    $expectId = (($sha1.ComputeHash([System.Text.Encoding]::ASCII.GetBytes('id:' + $saltText)) | Select-Object -First 4 | ForEach-Object { $_.ToString('x2') }) -join '')
    $saltOk = ($saltText.Length -ge 16) -and ($first.saltId -eq $expectId)
  }
  if ($saltOk) { $pass++; 'right  the day salt file exists and the first tick names it (saltId)' } else { $fail++; 'WRONG  the salt file or the saltId of the first tick is wrong' }
  if ($null -eq $first.cpuPct) { $pass++; 'right  the first tick carries no CPU reading (it would show the wrapper start-up)' } else { $fail++; "WRONG  the first tick has cpuPct $($first.cpuPct)" }
  $null = Invoke-Wrapper @('-Mode', 'Rehearsal')
  $rehMon = @(Get-ChildItem -LiteralPath $t -Filter 'rehearsal_*_monitor.jsonl' -ErrorAction SilentlyContinue)
  if ($rehMon.Count -ge 1) {
    $second = @(Get-Content -LiteralPath $rehMon[0].FullName)[0] | ConvertFrom-Json
    if (($second.saltId -eq $first.saltId) -and ($second.gw -eq $first.gw) -and ($second.net -eq $first.net)) { $pass++; 'right  a second wrapper reuses the salt: same saltId, gateway hash and network hash' } else { $fail++; 'WRONG  the second wrapper differs in saltId, gw or net' }
  } else { $fail++; 'WRONG  the rehearsal wrapper wrote no monitor file' }
  Expect 'a second Reserve start for the same slot renames the earlier outputs and is refused again only by the plan or the log' (Invoke-Wrapper @('-Mode', 'Reserve', '-Block', '3', '-At', '20:40', '-ExpectedDate', $today)) 1 @('kept under another name')
} finally {
  Remove-Item Env:NODE_OPTIONS, Env:SEPOLIA_RPC_URL -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue
}
$measureAfter = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'measure-sepolia' }).Count
if ($measureAfter -ne $measureBefore) { $fail++; "WRONG  a measure-sepolia.js process was left running ($measureBefore before, $measureAfter after)" } else { $pass++; 'right  no measurement process was left running' }
"`n$($pass + $fail) checks, $fail wrong"
exit $(if ($fail) { 1 } else { 0 })
