'use strict';
// The same value is written in several files of run_day and in the frozen measurement script (the slots, the reserve slots, the
// expected commit, Node and ethers versions, the two hashes, the date, the 90 s gap, the 120 s start window, the 30 s margin).
// This test reads those files as text, extracts every copy with its own pattern, and requires
//   (a) that each pattern finds exactly the expected number of copies (an edit that changes a line's shape fails loudly instead
//       of passing silently), and
//   (b) that every copy equals the value pre-registered below. The table below is a deliberate second copy: a wrong edit of one
//       file, or of this table alone, fails the test.
// It also checks the two hashes against the files on disk, and that RUN_DAY.md names every script of the folder.
// No network; nothing is written.
//
//   node tests/test_consistency.js <artifact root>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [root] = process.argv.slice(2);
if (!root || process.argv.length !== 3) {
  console.error('usage: node tests/test_consistency.js <artifact root>');
  process.exit(2);
}
const RD = path.join(__dirname, '..');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---- the pre-registered values ------------------------------------------------------------------------------------------
const SLOTS = ['08:00', '09:20', '10:40', '12:00', '13:20', '14:40', '16:00', '17:20', '18:40', '20:00'];
const RESERVE = ['20:40', '21:20'];
const DATE = '2026-11-12';
const COMMIT = '73b4cca16e7c';
const NODE = 'v22.10.0';
const ETHERS = '5.8.0';
const RECORD_SHA = '50bbf111484522a0adfee4d928dc51545acc8b8054989b3274e44128483c31d1';
const CONTRACT_SHA = '2a4e07578c99c015bf6618a5c76b8149aadeebd8835b0fc632d9d6aef35060a3';

const FILES = {
  checker: path.join(RD, 'check_sepolia_run.js'),
  wrapper: path.join(RD, 'start_sepolia_run.ps1'),
  preflight: path.join(RD, 'preflight.ps1'),
  chain: path.join(RD, 'preflight_chain.js'),
  analysis: path.join(RD, 'analysis_primary.js'),
  status: path.join(RD, 'status.ps1'),
  runday: path.join(RD, 'RUN_DAY.md'),
  testCheck: path.join(__dirname, 'test_check_sepolia_run.js'),
  synth: path.join(__dirname, 'make_synth_log.js'),
  measure: path.join(root, 'scripts', 'measure-sepolia.js'),
};
const TEXT = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));

let n = 0;
let wrong = 0;
const report = (name, problem) => {
  n += 1;
  if (problem) wrong += 1;
  console.log(`${problem ? 'WRONG' : 'right'}  ${String(n).padStart(2)}. ${name}${problem ? `: ${problem}` : ''}`);
};
// every match of `re` in the file, parsed by `parse`, must equal `expected`; there must be exactly `count` matches
function check(name, file, re, parse, expected, count = 1) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const found = [...TEXT[file].matchAll(new RegExp(re.source, flags))].map((m) => parse(m));
  if (found.length !== count) return report(name, `${found.length} copies found, expected ${count} (pattern ${re})`);
  const bad = found.filter((v) => JSON.stringify(v) !== JSON.stringify(expected));
  return report(name, bad.length ? `found ${JSON.stringify(bad[0])}, pre-registered ${JSON.stringify(expected)}` : null);
}
const jsArray = (m) => JSON.parse(m[1].replace(/'/g, '"'));
const str = (m) => m[1];
const num = (m) => Number(m[1]);

// slots
const SLOTS_JS = /const SLOTS = (\[[^\]]*\]);/;
check('slots: check_sepolia_run.js', 'checker', SLOTS_JS, jsArray, SLOTS);
check('slots: measure-sepolia.js (frozen)', 'measure', SLOTS_JS, jsArray, SLOTS);
check('slots: tests/test_check_sepolia_run.js', 'testCheck', SLOTS_JS, jsArray, SLOTS);
check('slots: tests/make_synth_log.js', 'synth', SLOTS_JS, jsArray, SLOTS);
check('slots: status.ps1', 'status', /\$slots = ([^\r\n]+)/, (m) => m[1].split(',').map((s) => s.trim().replace(/'/g, '')), SLOTS);
check('first slot: the wrapper (-Mode Run)', 'wrapper', /\$slotText = if \(\$Mode -eq 'Run'\) \{ '(\d\d:\d\d)' \}/, str, SLOTS[0]);
// reserve slots
check('reserve slots: check_sepolia_run.js', 'checker', /const RESERVE_SLOTS = (\[[^\]]*\]);/, jsArray, RESERVE);
check('reserve slots: the checker\'s --plan-slot test', 'checker', /!\[('\d\d:\d\d'), ('\d\d:\d\d')\]\.includes\(planSlot\)/, (m) => [m[1], m[2]].map((s) => s.replace(/'/g, '')), RESERVE);
check('reserve slots: the wrapper\'s -At', 'wrapper', /\$At -notmatch '\^\((\d\d:\d\d)\|(\d\d:\d\d)\)\$'/, (m) => [m[1], m[2]], RESERVE);
check('reserve slots: the wrapper\'s plan line', 'wrapper', /-notmatch '\^PLAN \((\d\d:\d\d)\|(\d\d:\d\d)\) /, (m) => [m[1], m[2]], RESERVE);
// date, commit, versions
check('date: start_sepolia_run.ps1', 'wrapper', /\$ExpectedDate = '(\d{4}-\d\d-\d\d)'/, str, DATE);
check('date: preflight.ps1', 'preflight', /\$ExpectedDate = '(\d{4}-\d\d-\d\d)'/, str, DATE);
check('date: status.ps1', 'status', /\$ExpectedDate = '(\d{4}-\d\d-\d\d)'/, str, DATE);
check('date: check_sepolia_run.js', 'checker', /opt\('--date', '(\d{4}-\d\d-\d\d)'\)/, str, DATE);
check('commit: start_sepolia_run.ps1', 'wrapper', /\$ExpectedCommit = '([0-9a-f]{12})'/, str, COMMIT);
check('commit: preflight.ps1', 'preflight', /\$ExpectedCommit = '([0-9a-f]{12})'/, str, COMMIT);
check('commit: check_sepolia_run.js', 'checker', /opt\('--expect-commit', '([0-9a-f]{12})'\)/, str, COMMIT);
check('node: start_sepolia_run.ps1', 'wrapper', /\$ExpectedNode = '(v[\d.]+)'/, str, NODE);
check('node: preflight.ps1', 'preflight', /\$ExpectedNode = '(v[\d.]+)'/, str, NODE);
check('node: check_sepolia_run.js', 'checker', /opt\('--expect-node', '(v[\d.]+)'\)/, str, NODE);
check('ethers: check_sepolia_run.js', 'checker', /opt\('--expect-ethers', 'ethers\/([\d.]+)'\)/, str, ETHERS);
check('ethers: preflight.ps1', 'preflight', /\$ethersVersion -eq '([\d.]+)'/, str, ETHERS);
// hashes, against the files on disk too
check('record SHA-256: start_sepolia_run.ps1', 'wrapper', /\$ExpectedRecordSha256 = '([0-9a-f]{64})'/, str, RECORD_SHA);
check('record SHA-256: preflight.ps1', 'preflight', /\$ExpectedRecordSha256 = '([0-9a-f]{64})'/, str, RECORD_SHA);
check('contract SHA-256: preflight.ps1', 'preflight', /\$ExpectedContractSha256 = '([0-9a-f]{64})'/, str, CONTRACT_SHA);
{
  const record = path.join(root, 'results', 'sepolia_v1.1_deployment.json');
  report('the deployment record on disk has the pre-registered SHA-256', fs.existsSync(record) ? (sha256(record) === RECORD_SHA ? null : `it is ${sha256(record)}`) : 'record not found');
  const contract = path.join(root, 'contracts', 'DIDRegistry.sol');
  report('contracts/DIDRegistry.sol has the pre-registered SHA-256', fs.existsSync(contract) ? (sha256(contract) === CONTRACT_SHA ? null : `it is ${sha256(contract)}`) : 'contract not found');
}
// windows and thresholds
check('sleep gap: check_sepolia_run.js GAP_S', 'checker', /const GAP_S = (\d+);/, num, 90);
check('sleep gap: status.ps1 filter', 'status', /gapSeconds -gt (\d+)/, num, 90);
check('sleep gap: status.ps1 text', 'status', /gap over (\d+) s/, num, 90);
check('start window: check_sepolia_run.js', 'checker', /const START_WINDOW_S = (\d+);/, num, 120);
check('start window: measure-sepolia.js (frozen), seconds', 'measure', /const START_WINDOW_MS = (\d+) \* 60 \* 1000;/, (m) => Number(m[1]) * 60, 120);
check('monitor window before the start: check_sepolia_run.js', 'checker', /const LOOKBACK_S = (\d+);/, num, 90);
check('monitor window after the start: check_sepolia_run.js', 'checker', /const LOOKAHEAD_S = (\d+);/, num, 120);
check('slow request limit: check_sepolia_run.js', 'checker', /const SLOW_MS = (\d+);/, num, 10000);
check('start margin: start_sepolia_run.ps1 (two uses), seconds', 'wrapper', /AddSeconds\(-(\d+)\)/, num, 30, 2);
check('start margin: preflight.ps1, seconds', 'preflight', /\$minutes -lt ([\d.]+) -and \$LateStart/, (m) => Number(m[1]) * 60, 30);
check('warm-up iterations: check_sepolia_run.js', 'checker', /const WARMUP = (\d+);/, num, 2);
check('warm-up iterations: measure-sepolia.js (frozen)', 'measure', /const WARMUP = (\d+);/, num, 2);
check('timed iterations: check_sepolia_run.js', 'checker', /const TIMED = (\d+);/, num, 10);
check('timed iterations: measure-sepolia.js (frozen)', 'measure', /const TIMED = (\d+);/, num, 10);
check('tick period default: start_sepolia_run.ps1', 'wrapper', /\$TickSeconds = (\d+),/, num, 60);
{
  // a tick comes every 60 s, up to 65 s apart (phase lock to second 45, a wait pushed to the next minute inside 5 s of the target)
  // and the checker calls a gap above GAP_S a sleep: the margin between the two must stay
  const gap = Number(/const GAP_S = (\d+);/.exec(TEXT.checker)[1]);
  // the longest wait is derived from the wrapper: a minute plus the seconds inside which a wait is pushed to the next minute
  const push = /if \(\$next -le \$now\.AddSeconds\((\d+)\)\)/.exec(TEXT.wrapper);
  const longest = push ? 60 + Number(push[1]) : NaN;
  report(`the sleep gap (${gap} s) exceeds the longest tick wait (${longest} s, derived from the wrapper) by 20 s`, Number.isFinite(longest) && gap >= longest + 20 ? null : `GAP_S ${gap}, longest wait ${longest}`);
}
// copies of the thresholds in the analysis tool and the day rule in the checker
check('minimum rows of a short block: check_sepolia_run.js', 'checker', /const MIN_ROWS = (\d+);/, num, 5);
check('minimum rows of a block in a range: analysis_primary.js', 'analysis', /const MIN_CLUSTER_ROWS = (\d+);/, num, 5);
check('slow request limit (ms): analysis_primary.js', 'analysis', /const SLOW_MS = (\d+);/, num, 10000);
check('day rule, slots needed: check_sepolia_run.js', 'checker', /const DAY_MIN_SLOTS = (\d+);/, num, 8);
check('day rule, rows needed: check_sepolia_run.js', 'checker', /const DAY_MIN_ROWS = (\d+);/, num, 80);
check('start margin: preflight.ps1, both uses, seconds', 'preflight', /\$minutes -lt (0\.5)\b/, (m) => Number(m[1]) * 60, 30, 2);
// the documentation names every script of the folder, and the commit
{
  const names = ['preflight.ps1', 'preflight_chain.js', 'start_sepolia_run.ps1', 'status.ps1', 'check_sepolia_run.js', 'analysis_primary.js', 'test_check_sepolia_run.js', 'test_wrapper.ps1', 'test_consistency.js', 'mutation.js', 'make_synth_log.js', 'template_clean_block.jsonl'];
  const missing = names.filter((f) => !TEXT.runday.includes(f));
  report('RUN_DAY.md names every script and test of the folder', missing.length ? `not named: ${missing.join(', ')}` : null);
  const present = [...fs.readdirSync(RD), ...fs.readdirSync(__dirname).map((f) => path.join('tests', f))].filter((f) => /\.(ps1|js|jsonl)$/.test(f)).map((f) => path.basename(f));
  const unknown = present.filter((f) => !names.includes(f));
  report('the folder holds no script that this list does not know', unknown.length ? `unlisted: ${unknown.join(', ')}` : null);
  report('RUN_DAY.md names the frozen commit', TEXT.runday.includes(COMMIT) ? null : `${COMMIT} not found`);
  report('RUN_DAY.md names the run date', TEXT.runday.includes('12 Nov 2026') || TEXT.runday.includes(DATE) ? null : 'the date is not named');
}

// Parse the preflight source without executing it.
{
  const parser = "$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile(" +
    "'" + FILES.preflight.replace(/'/g, "''") + "',[ref]$t,[ref]$e);if($e.Count){$e;exit 1}";
  const parsed = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-Command', parser], { encoding: 'utf8' });
  report('preflight parses without execution', parsed.status === 0 ? null : 'PowerShell parse failed');
  report('preflight fails an empty profile and warns on short or missing pause',
    /Check \(-not \[string\]::IsNullOrWhiteSpace\(\$profileName\)\)/.test(TEXT.preflight) &&
    TEXT.preflight.includes('[datetime]::new(2026, 11, 14, 0, 0, 0)') &&
    TEXT.preflight.includes("Add-Line 'WARN' 'Windows Update pause expiry") &&
    !TEXT.preflight.includes('Windows Update is not paused') ? null : 'profile or pause checks differ');
}
console.log(`\n${n} consistency checks, ${wrong} wrong`);
process.exit(wrong ? 1 : 0);
