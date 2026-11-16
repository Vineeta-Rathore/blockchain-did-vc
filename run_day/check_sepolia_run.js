#!/usr/bin/env node
/**
 * Gate checks for the log of the Sepolia run (SOP 4.5, plan D1-B) and the plan for the reserve slots.
 * Read-only: it reads the log, the deployment record, optionally the wrapper's monitor file, and one line of the env file
 * (SEPOLIA_RPC_URL, only to scan the log for parts of it). It prints no part of the URL.
 *
 *   node check_sepolia_run.js --root <artifact folder> --env <env file> --deployment <record> --log <log.jsonl>
 *        (--monitor <monitor.jsonl> [--monitor ...] | --no-monitor) [--date 2026-11-12] [--rehearsal]
 *        [--plan-slot 20:40|21:20] [--in-progress-window <seconds>] [--blocks-json <file>] [--values] [--now <ISO-time>]
 *        [--expect-commit 73b4cca16e7c] [--expect-node v22.10.0] [--expect-ethers ethers/5.8.0]
 *
 * --blocks-json writes the verdict as JSON (the status, reasons and usable row counts of every block of every invocation, the
 * plan, the day rule, which invocation stands for each slot, the SHA-256 of the checker and of the log), for
 * analysis_primary.js. It is written by the full report only. No latency value is printed or written unless --values is given
 * (the cold-start time and the estimated compute-unit draw of each block): the decisions of the day use status, reasons, row
 * counts and the day rule only.
 *
 * Exit code: 0 = every gate holds and every block is clean (or covered by a clean repetition); 1 = a gate failed, or a block
 * failed or is missing (the plan for the reserve slots is printed); 2 = usage error; 3 = the checker itself crashed (a
 * redacted stack goes to stderr); 4 = with --plan-slot: the plan names no block for that slot; 5 = the main run is still in
 * progress (an invocation has no footer, and the log or a monitor file was written less than --in-progress-window seconds ago,
 * default 120): no verdict yet.
 * The first output line is the SHA-256 of this file, so that a verdict can be tied to the code that gave it.
 *
 * Definitions fixed before the run (LOG.md, "Run-day addendum"):
 *  - A block FAILS (a predefined failure of the plan) if one of its rows has an error (an RPC or HTTP error, HTTP 429), takes
 *    over 10 s, fails its sanity check (P: not valid; S, C, Bt: the reads are not as expected) or its request-count check
 *    (eth_blockNumber once; P, S and C four eth_call; Bt one batch and no eth_call; no eth_chainId), if the block was missed
 *    or started more than 2 minutes late (laptop asleep or paused), or if it is incomplete. With --monitor, a block also
 *    fails if a monitor tick whose interval overlaps [start - 90 s, start + 120 s] shows a gap over 90 s (the laptop slept or
 *    was suspended) or, between ticks of one wrapper inside that window, a change of network (the default gateway, or the
 *    interfaces that carry a default route, or the Wi-Fi link down, or a VPN adapter up).
 *    Recorded as notes only, never as failures (they are not in the plan's list): mains lost, a Windows restart pending,
 *    the CPU above 25 % in a tick, and more than 1 MB received in the minute of a tick.
 *  - A block is UNFIT if it is short (fewer than 5 usable timed rows in some mode, or no rows) or was run on another network
 *    than the start of the run (a monitor tick in its window carries another network identity than the first tick).
 *  - Only the first two failed blocks get the reserve slots 20:40 and 21:20, each repeated once. Order: unfit blocks first, then
 *    the other failed blocks; the lowest block number first within each group.
 *  - The day rule: the day stands if at least 8 of the 10 slots are covered (the main block, or its repetition when the main
 *    block is unfit and the repetition is not, is fit) and every mode has at least 80 usable timed rows in the primary dataset
 *    (one cluster per slot); otherwise the day is failed. The verdict is printed only when it is final, that is when no planned
 *    repetition of an unfit block is still to run; before that the line says NOT FINAL.
 *  - Unreplaced off-network clusters are excluded from the primary. Other failed blocks keep usable rows: the analysis (scripts/analyze-latency.js) counts every row that succeeded,
 *    and a repeated block is its own cluster.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);
const root = opt('--root');
const envFile = opt('--env');
const recordFile = opt('--deployment');
const logFile = opt('--log');
const date = opt('--date', '2026-11-12');
const nowArg = opt('--now');
const nowMs = has('--now') ? (typeof nowArg === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(nowArg) ? Date.parse(nowArg) : NaN) : Date.now();
// --monitor may be given several times: the main wrapper's file and one for each reserve invocation.
const monitorFiles = argv.reduce((list, a, i) => (a === '--monitor' && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? [...list, argv[i + 1]] : list), []);
const monitorFile = monitorFiles.length ? monitorFiles.join(', ') : null;
const noMonitor = has('--no-monitor');
const showValues = has('--values');
const rehearsal = has('--rehearsal');
const planSlot = opt('--plan-slot');
const monitorMissing = !rehearsal && !monitorFiles.length && !noMonitor;
const expectCommit = opt('--expect-commit', '73b4cca16e7c');
const expectNode = opt('--expect-node', 'v22.10.0');
const expectEthers = opt('--expect-ethers', 'ethers/5.8.0');
const expectOverrides = [
  ['--expect-commit', expectCommit, '73b4cca16e7c'],
  ['--expect-node', expectNode, 'v22.10.0'],
  ['--expect-ethers', expectEthers, 'ethers/5.8.0'],
].filter(([option, value, builtIn]) => has(option) && value !== builtIn).map(([option]) => option);
const inProgressWindowArg = opt('--in-progress-window', '120');
const inProgressWindowS = /^\d+$/.test(inProgressWindowArg) ? Number(inProgressWindowArg) : NaN;
const blocksJsonFile = opt('--blocks-json');
if (!root || !envFile || !recordFile || !logFile || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(nowMs) ||
    (planSlot !== null && !['20:40', '21:20'].includes(planSlot)) || (monitorFiles.length && noMonitor) || !(inProgressWindowS >= 0) ||
    (argv.includes('--blocks-json') && !blocksJsonFile)) {
  console.error('usage: node check_sepolia_run.js --root <artifact> --env <env file> --deployment <record> --log <log> [--date YYYY-MM-DD] (--monitor <file> [--monitor <file> ...] | --no-monitor) [--rehearsal] [--plan-slot 20:40|21:20] [--in-progress-window <seconds>] [--blocks-json <file>] [--values] [--now <ISO-time>] [--expect-commit <describe>] [--expect-node <version>] [--expect-ethers <version>]');
  process.exit(2);
}

const R = require(path.join(root, 'scripts', 'lib', 'rpc.js'));
const M = require(path.join(root, 'scripts', 'lib', 'sepolia-modes.js'));

const IST_MIN = 330;
const SLOTS = ['08:00', '09:20', '10:40', '12:00', '13:20', '14:40', '16:00', '17:20', '18:40', '20:00'];
const RESERVE_SLOTS = ['20:40', '21:20'];
const WARMUP = 2;
const TIMED = 10;
const ITERATIONS = WARMUP + TIMED;
const START_WINDOW_S = 120; // a block must start within 2 minutes of its slot (SOP gate; the script's own START_WINDOW_MS)
const SLOW_MS = 10000;
const GAP_S = 90; // a gap between two monitor ticks above this is a sleep or a pause (ticks come every 60 s)
const LOOKBACK_S = 90; // the monitor window of a block starts this long before it ...
const LOOKAHEAD_S = 120; // ... and ends this long after it started
const NOTE_CPU_PCT = 25;
const NOTE_RX_BYTES = 1000000;
const CU_ITERATION = 4 * 10 + 16 * 26; // four eth_blockNumber (10 CU) and sixteen eth_call (26 CU)
const CU_BLOCK_EXTRA = 10 + (10 + 2 * 26); // cold start; cache check
const EXPECTED_REQUESTS = { P: { eth_call: 4 }, S: { eth_call: 4 }, C: { eth_call: 4 }, Bt: { batch: 1 } };
const MODES = ['P', 'S', 'C', 'Bt'];
const MIN_ROWS = 5; // a block with fewer usable timed rows than this in any mode is "short"
const DAY_MIN_SLOTS = 8; // the day stands if at least this many slots are covered ...
const DAY_MIN_ROWS = 80; // ... and every mode has at least this many usable timed rows in the primary dataset

const out = [];
const say = (t = '') => out.push(t);
const SELF_SHA = require('crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
say(`check_sepolia_run.js SHA-256 ${SELF_SHA}`);
if (has('--now')) say(`CLOCK OVERRIDE: --now ${nowArg} (tests and documented replay only; the day decisions use the real clock)`);
let gateFailures = 0;
let fatalGateFailures = 0;
const gates = [];
const gate = (id, fatal, ok, text) => {
  gates.push({ id, fatal, ok: !!ok });
  if (!ok && fatal) fatalGateFailures += 1;
  text += ' [' + id + (fatal ? '; fatal' : '') + ']';
  say(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) gateFailures += 1;
};

const slotMs = (hhmm) => {
  if (typeof hhmm !== 'string' || !/^\d\d:\d\d$/.test(hhmm)) return NaN;
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - IST_MIN * 60000;
};
const istClock = (ms) => (Number.isFinite(ms) && Math.abs(ms) < 8.6e15 ? new Date(ms + IST_MIN * 60000).toISOString().slice(11, 19) : '-');
const nextDayLabel = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const failedDayAction = date === '2026-11-13' ? 'no third day; no headline' : 'run ' + nextDayLabel + ' once, in full';
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

// ---- inputs ---------------------------------------------------------------------------------------------------------
delete process.env.SEPOLIA_RPC_URL;
let url = null;
try {
  url = R.readRpcUrl(envFile);
} catch {
  url = null;
}
const redact = R.makeRedactor(url);
process.on('uncaughtException', (error) => {
  process.stderr.write(`${redact(String((error && error.stack) || error))}\n`, () => process.exit(3));
});
const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
const logBytes = fs.readFileSync(logFile);
const text = logBytes.toString('utf8');
const LOG_SHA = require('crypto').createHash('sha256').update(logBytes).digest('hex');
const rows = [];
const badLines = [];
text.split(/\r?\n/).forEach((line, i) => {
  if (!line.trim()) return;
  try {
    rows.push({ ...JSON.parse(line), _line: i + 1 });
  } catch {
    badLines.push(i + 1);
  }
});

// The monitor file (one line a minute, written by the wrapper). A file that is missing, empty or partly unreadable is a
// failed gate, never a silent pass: without ticks the sleep and network-change rules cannot be applied.
const ticks = [];
const monitorHashes = [];
let badTicks = 0;
for (const file of monitorFiles) {
  let monitorText = '';
  try {
    const buf = fs.readFileSync(file);
    monitorText = buf.toString('utf8');
    monitorHashes.push({ name: path.basename(file), sha256: require('crypto').createHash('sha256').update(buf).digest('hex') });
  } catch { badTicks += 1; }
  for (const l of monitorText.split(/\r?\n/).filter(Boolean)) {
    try {
      const t = JSON.parse(l);
      const ms = Date.parse(t.t);
      if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new Error('no time');
      ticks.push({ ...t, ms });
    } catch { badTicks += 1; }
  }
}
ticks.sort((a, b) => a.ms - b.ms);
const monitorUsable = ticks.length > 0;
const identityText = (x) => typeof x === 'string' && x.trim().length > 0;
const baseline = ticks.find((t) => identityText(t.net) && identityText(t.saltId));
const baselineValid = Boolean(baseline);
const comparableIdentity = (t) => baselineValid && t.ms >= baseline.ms &&
  identityText(t.net) && identityText(t.saltId) && t.saltId === baseline.saltId;
if (monitorFiles.length) gate('NETWORK_BASELINE', false, baselineValid, baselineValid ? 'network identity baseline present' : 'network identity baseline missing');

// ---- row-level rules ------------------------------------------------------------------------------------------------
// A timed row that the analysis counts (scripts/analyze-latency.js usable(), without warm-up and pilot rows): it has a time, no
// error, and P is valid, S, C and Bt are sane. This is the one definition of "usable" in the checker.
const isTimedUsable = (r, mode) => r.kind === 'sepolia' && r.mode === mode && r.warmup === false && !r.pilot && !r.error &&
  Number.isFinite(r.total_ms) && (mode === 'P' ? r.valid === true : r.sane === true);

function rowIssues(r) {
  const issues = [];
  if (r.error !== undefined && r.error !== null) {
    issues.push(`ERROR:${r.error}`);
    if (/HTTP_429/.test(String(r.error))) issues.push('HTTP_429');
    return issues;
  }
  if (!Number.isFinite(r.total_ms) || r.total_ms <= 0) issues.push('NO_TIME');
  else if (r.total_ms > SLOW_MS) issues.push('REQUEST_OVER_10S');
  if (r.mode === 'S' && Array.isArray(r.reads_ms) && r.reads_ms.some((x) => x > SLOW_MS)) issues.push('REQUEST_OVER_10S');
  // S, C and Bt read the block number (an eth_blockNumber request) before their timer; in P it is inside total_ms.
  if (r.mode !== 'P' && Number.isFinite(r.b0_ms) && r.b0_ms > SLOW_MS) issues.push('REQUEST_OVER_10S');
  const requests = r.requests || {};
  const expected = { eth_blockNumber: 1, ...EXPECTED_REQUESTS[r.mode] };
  for (const [method, n] of Object.entries(expected)) {
    if ((requests[method] || 0) !== n) issues.push(`REQUEST_COUNT:${r.mode}:${method}=${requests[method] || 0}`);
  }
  for (const method of Object.keys(requests)) {
    if (!(method in expected)) issues.push(`REQUEST_COUNT:${r.mode}:unexpected ${method}`);
  }
  if ((r.chainIdDuringTimer || 0) !== 0 || requests.eth_chainId) issues.push('CHAIN_ID_DURING_TIMER');
  if (r.mode === 'P') {
    if (r.valid !== true || r.reason !== 'VALID') issues.push('SANITY:P not valid');
  } else if (r.sane !== true) {
    issues.push(`SANITY:${r.mode} reads not as expected`);
  }
  if (!Number.isInteger(r.blockNumber)) issues.push('NO_BLOCK_NUMBER');
  return [...new Set(issues)];
}

// ---- block-level evaluation -----------------------------------------------------------------------------------------
function monitorIssues(startMs) {
  const lo = startMs - LOOKBACK_S * 1000;
  const hi = startMs + LOOKAHEAD_S * 1000;
  const reasons = [];
  const notes = [];
  let offNetwork = false;
  const base = baseline;
  const inWindow = ticks.filter((t) => t.ms >= lo && t.ms <= hi);
  let networkState = 'UNKNOWN';
  // A tick written after a long sleep covers the interval [its time - gap, its time]: it counts if that interval touches the
  // window, even when the tick itself is written long after the block.
  const gapTicks = ticks.filter((t) => t.gapSeconds > GAP_S && t.ms >= lo && t.ms - t.gapSeconds * 1000 <= hi);
  if (!inWindow.length && !gapTicks.length) reasons.push('NO_MONITOR_TICK_NEAR_BLOCK');
  for (const t of gapTicks) reasons.push(`SLEEP_OR_PAUSE:gap ${Math.round(t.gapSeconds)} s`);
  for (const t of inWindow) {
    // Gateway and interface changes are judged between ticks of the same wrapper (every tick carries the wrapper's unique id,
    // wid, and its pid, w; a pid can be reused, wid cannot); the first tick of a wrapper has nothing to compare with.
    const idOf = (x) => (x.wid !== undefined ? x.wid : x.w);
    let prev = null;
    for (let k = ticks.indexOf(t) - 1; k >= 0; k--) {
      if (idOf(ticks[k]) === idOf(t)) { prev = ticks[k]; break; }
    }
    if (t.wifiUp === false) reasons.push('NETWORK_CHANGE:Wi-Fi down');
    if (t.vpn > 0) reasons.push('NETWORK_CHANGE:VPN adapter up');
    if (prev && t.gw !== prev.gw) reasons.push('NETWORK_CHANGE:default gateway changed');
    if (prev && JSON.stringify(t.ifaces) !== JSON.stringify(prev.ifaces)) reasons.push('NETWORK_CHANGE:interfaces up changed');
    // The network identity (the hashed name of the connected network) is compared with the first tick of the run, so that a
    // change that stays is seen in every later block and not only in the block whose window holds the tick of the change. Ticks
    // are comparable only if they were hashed with the same salt (the wrappers of one day share it). A gateway that changes
    // under the same network name (a restarted hotspot) is not "another network": only the transition rule above sees it.
    if (comparableIdentity(t)) {
      if (t.net !== base.net) {
        reasons.push('NETWORK_CHANGE:network differs from the start of the run');
        networkState = 'DIFFERENT';
        offNetwork = true;
      } else if (networkState === 'UNKNOWN') networkState = 'SAME';
    }
    if (t.power !== 'Online') notes.push('mains lost (note only)');
    if (t.restartPending === true) notes.push('Windows restart pending (note only)');
    if (Number.isFinite(t.cpuPct) && t.cpuPct > NOTE_CPU_PCT) notes.push(`CPU ${t.cpuPct.toFixed(0)}% in a tick (note only)`);
    if (prev && Number.isFinite(t.rxBytes) && Number.isFinite(prev.rxBytes) && t.rxBytes - prev.rxBytes > NOTE_RX_BYTES) {
      notes.push(`${Math.round((t.rxBytes - prev.rxBytes) / 1024)} KB received in the minute of a tick (note only)`);
    }
  }
  if (networkState === 'UNKNOWN') reasons.push('NETWORK_IDENTITY_UNKNOWN:no comparable network identity');
  return { reasons: [...new Set(reasons)], notes: [...new Set(notes)], offNetwork, networkState };
}

function evalBlock(inv, block, slot) {
  const mine = inv.rows.filter((r) => r.block === block);
  const reasons = new Map();
  const structure = new Set();
  const ev = { block, slot, rows: mine.length, reasons, structure, notes: [], status: 'clean', startedMs: null, coldMs: null, startDelayS: null, cuPerS: null, usable: {}, short: true, offNetwork: false, unfit: true };
  for (const m of MODES) ev.usable[m] = mine.filter((r) => isTimedUsable(r, m)).length;
  ev.short = MODES.some((m) => ev.usable[m] < MIN_ROWS);
  ev.unfit = ev.short; // unfit: short, or run on another network than the start (set after the monitor is read)
  if (!mine.length) {
    ev.status = 'missing';
    reasons.set('NO_ROWS', 1);
    return ev;
  }
  const missed = mine.find((r) => r.kind === 'block_missed');
  if (missed) bump(reasons, missed.late ? 'BLOCK_MISSED:started too late' : 'BLOCK_MISSED');
  const cold = mine.filter((r) => r.kind === 'sepolia' && r.mode === 'cold');
  const data = mine.filter((r) => r.kind === 'sepolia' && r.mode !== 'cold');
  const cache = mine.filter((r) => r.kind === 'cache_check');
  if (missed && !data.length) {
    ev.status = 'failed';
    return ev;
  }

  if (cold.length !== 1) structure.add(`${cold.length} cold-start rows`);
  else {
    const c = cold[0];
    ev.startedMs = typeof c.at === 'string' ? Date.parse(c.at) : NaN;
    if (!Number.isFinite(ev.startedMs)) bump(reasons, 'NO_START_TIME');
    if (c.error) {
      bump(reasons, `ERROR:${c.error}`);
      if (/HTTP_429/.test(String(c.error))) bump(reasons, 'HTTP_429');
    } else if (Number.isFinite(c.cold_ms) && c.cold_ms > 0) {
      ev.coldMs = c.cold_ms;
      if (c.cold_ms > SLOW_MS) bump(reasons, 'REQUEST_OVER_10S');
    } else bump(reasons, 'NO_TIME:cold start');
    if (slot && Number.isFinite(ev.startedMs)) {
      ev.startDelayS = (ev.startedMs - slotMs(slot)) / 1000;
      if (ev.startDelayS > START_WINDOW_S || ev.startDelayS < -1) bump(reasons, `START_OUTSIDE_WINDOW:${ev.startDelayS.toFixed(0)} s`);
    }
  }

  if (data.length !== ITERATIONS * 4) bump(reasons, `INCOMPLETE:${data.length}/${ITERATIONS * 4} rows`);
  for (let it = 1; it <= ITERATIONS; it++) {
    const rs = data.filter((r) => r.iteration === it);
    if (!rs.length) continue;
    const warm = it <= WARMUP;
    const expected = warm
      ? M.orderFor({ block, index: it - 1, perBlock: WARMUP })
      : M.orderFor({ block, index: it - 1 - WARMUP, perBlock: TIMED });
    if (rs.map((r) => r.mode).join(',') !== expected.join(',')) structure.add(`iteration ${it}: modes ${rs.map((r) => r.mode).join(',')}, expected ${expected.join(',')}`);
    for (const r of rs) {
      if (r.order !== expected.join(',')) structure.add(`iteration ${it}: order field ${r.order}`);
      if (r.warmup !== warm) structure.add(`iteration ${it}: warm-up flag ${r.warmup}`);
      if (r.pilot) structure.add('pilot row in a run');
      if (r.mode === 'P' && !r.error && !(r.steps && ['B0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'].every((s) => Number.isFinite(r.steps[s])))) structure.add(`iteration ${it}: P row without the nine step times`);
      for (const issue of rowIssues(r)) bump(reasons, issue);
    }
  }
  if (cache.length !== 1) structure.add(`${cache.length} cache-check rows`);
  else if (cache[0].error) bump(reasons, `ERROR:${cache[0].error}`);
  else if (!(cache[0].fresh_ms > 0 && cache[0].known_ms > 0)) bump(reasons, 'NO_TIME:cache check');
  else if (cache[0].fresh_ms > SLOW_MS || cache[0].known_ms > SLOW_MS) bump(reasons, 'REQUEST_OVER_10S');

  // Estimated draw on the provider's throughput limit: compute units of the block over the time its requests took.
  const activeMs = data.reduce((s, r) => s + (Number.isFinite(r.total_ms) ? r.total_ms : 0) + (r.mode !== 'P' && Number.isFinite(r.b0_ms) ? r.b0_ms : 0), 0);
  if (activeMs > 0) ev.cuPerS = ((data.length / 4) * CU_ITERATION + CU_BLOCK_EXTRA) / (activeMs / 1000);

  if (Number.isFinite(ev.startedMs) && monitorFiles.length) {
    const m = monitorIssues(ev.startedMs);
    for (const r of m.reasons) bump(reasons, r);
    ev.notes.push(...m.notes);
    ev.offNetwork = m.offNetwork;
    ev.networkState = m.networkState;
    ev.unfit = ev.short || ev.offNetwork || ev.networkState === 'UNKNOWN';
  }
  ev.status = reasons.size || structure.size ? 'failed' : 'clean';
  return ev;
}

// ---- the log --------------------------------------------------------------------------------------------------------
gate('JSON_FORMAT', false, badLines.length === 0, `every log line is valid JSON${badLines.length ? ` (bad lines: ${badLines.slice(0, 5).join(', ')})` : ''}`);
const invocations = [];
let current = null;
let orphans = 0;
for (const r of rows) {
  if (r.kind === 'header') {
    current = { header: r, rows: [], footer: null };
    invocations.push(current);
  } else if (!current) orphans += 1;
  else if (r.kind === 'footer') current.footer = r;
  else current.rows.push(r);
}
gate('ORPHAN_ROWS', false, orphans === 0, `no row before the first header (${orphans})`);
gate('INVOCATIONS_PRESENT', false, invocations.length > 0, `${invocations.length} invocation(s) in the log`);
gate('PILOT_ROWS', true, rows.filter((r) => r.pilot === true).length === 0, 'no pilot row in the log');

const label = url ? R.providerLabel(url) : null;
const evals = []; // { inv, kind, blocks: [ev] }
invocations.forEach((inv, idx) => {
  const h = inv.header;
  const kind = rehearsal ? 'rehearsal' : (h.onlyBlock !== undefined ? 'reserve' : 'main');
  const name = `invocation ${idx + 1} (${kind}${kind === 'reserve' ? `, block ${h.onlyBlock} at ${h.at}` : ''}, started ${h.startedAt})`;
  say('');
  say(`== ${name} ==`);
  gate('CONFIG_SCRIPT_LABEL', true, h.script === 'measure-sepolia.js' && h.label === 'run', `header: measure-sepolia.js, label ${h.label}`);
  gate('CONFIG_CHAIN', true, h.chainId === 11155111, `chain ${h.chainId}`);
  gate('CONFIG_COMMIT', true, h.commit === expectCommit, `commit ${h.commit} (expected ${expectCommit}, not dirty)`);
  gate('CONFIG_BLOCK_LAG', true, h.blockLag === 0, `block lag ${h.blockLag}`);
  gate('CONFIG_ITERATIONS', true, h.warmup === WARMUP && h.timed === TIMED, `warm-up ${h.warmup} and timed ${h.timed} iterations per block (expected ${WARMUP} and ${TIMED})`);
  gate('CONFIG_CONTRACT', true, h.contract === record.address, 'contract equals the deployment record');
  gate('CONFIG_CREDENTIAL', true, h.credentialB === record.credentials.B.id, 'credential B equals the deployment record');
  gate('CONFIG_DEPLOYER_START', true, h.deployer === record.deployer && h.deployerNonceStart === record.deployerNonceAfterSetup, `deployer and nonce at the start (${h.deployerNonceStart}) equal the record (${record.deployerNonceAfterSetup})`);
  gate('CONFIG_PROVIDER', true, h.provider === label, `provider label in the log: ${h.provider}`);
  gate('CONFIG_NODE', true, h.node === expectNode, `node ${h.node} (expected ${expectNode})`);
  gate('CONFIG_ETHERS', true, h.ethers === expectEthers, `ethers ${h.ethers} (expected ${expectEthers})`);
  gate('CONFIG_TIMEZONE', true, h.timezoneOffsetMinutes === IST_MIN, `time zone offset ${h.timezoneOffsetMinutes} min (IST = ${IST_MIN})`);
  gate('CONFIG_AGENTS', true, h.agents && h.agents.keepAlive === true && h.agents.scheduling === 'fifo', 'keep-alive agents, first in first out');
  gate('CONFIG_TIMEOUT', true, h.requestTimeoutMs === 30000, `request timeout ${h.requestTimeoutMs} ms (the default, 30000, as in the pilot)`);
  if (kind === 'main') gate('CONFIG_SLOTS', true, JSON.stringify(h.slots) === JSON.stringify(SLOTS), 'ten slots as fixed in the plan');
  if (kind === 'reserve') gate('RESERVE_ARGUMENTS', false, Number.isInteger(h.onlyBlock) && RESERVE_SLOTS.includes(h.at), `reserve invocation for block ${h.onlyBlock} in slot ${h.at}`);
  gate('FOOTER_PRESENT', false, !!inv.footer, 'footer present (the process ended normally)');
  if (inv.footer) {
    gate('CONFIG_DEPLOYER_END', true, inv.footer.nonceUnchanged === true && inv.footer.deployerNonceEnd === record.deployerNonceAfterSetup, `deployer nonce unchanged at the end (${inv.footer.deployerNonceEnd})`);
    say(`     finished ${inv.footer.finishedAt}; new sockets in all ${inv.footer.newSockets}`);
  }
  const foreign = inv.rows.filter((r) => r.run !== h.startedAt).length;
  gate('FOREIGN_RUN_IDS', true, foreign === 0, `every row carries this invocation's run id (${foreign} foreign)`);

  // A header without onlyBlock starts all ten blocks; one with it starts that block only (a reserve slot or a rehearsal).
  const blockList = h.onlyBlock === undefined ? SLOTS.map((s, i) => i + 1) : [h.onlyBlock];
  const blocks = blockList.map((b) => evalBlock(inv, b, kind === 'main' ? SLOTS[b - 1] : (kind === 'reserve' ? h.at : null)));
  evals.push({ inv, kind, blocks });
  say('');
  say(showValues ? 'block  slot   started (IST)  delay  rows  cold ms  est. CU/s  status' : 'block  slot   started (IST)  delay  rows  usable timed rows P S C Bt  status');
  for (const ev of blocks) {
    const reasonText = [...ev.reasons].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).concat([...ev.structure].map((s) => `STRUCTURE: ${s}`)).join('; ');
    say(`${String(ev.block).padStart(5)}  ${String(ev.slot || '-').padEnd(5)}  ${(Number.isFinite(ev.startedMs) ? istClock(ev.startedMs) : '-').padEnd(13)}  ${(ev.startDelayS === null ? '-' : `${ev.startDelayS.toFixed(0)} s`).padStart(5)}  ${String(ev.rows).padStart(4)}  ${showValues ? `${(ev.coldMs === null ? '-' : ev.coldMs.toFixed(0)).padStart(7)}  ${(ev.cuPerS === null ? '-' : ev.cuPerS.toFixed(0)).padStart(9)}` : `${MODES.map((m) => String(ev.usable[m]).padStart(3)).join(' ')}${ev.offNetwork ? ' off-net' : (ev.short ? ' short' : '      ')}`}  ${ev.status}${reasonText ? `: ${reasonText}` : ''}${ev.notes.length ? ` [${ev.notes.join(', ')}]` : ''}`);
    if (ev.structure.size) gate('BLOCK_STRUCTURE', false, false, 'block structure does not match the fixed layout');
  }
});

// ---- coverage, reserve plan, counts ----------------------------------------------------------------------------------
const mains = evals.filter((e) => e.kind === 'main');
const main = mains[0];
const reserves = evals.filter((e) => e.kind === 'reserve').sort((a, b) => String(a.inv.header.at).localeCompare(String(b.inv.header.at)));
// The plan order, fixed before the run: blocks that are unfit (short: fewer than MIN_ROWS usable timed rows in some mode, or no rows;
// or run on another network than the start) first, because they cost the day its coverage; then the other failed blocks; the lowest
// block number first within each group.
const failedMainEvals = main ? main.blocks.filter((e) => e.status !== 'clean') : [];
const failedMain = [...failedMainEvals].sort((a, b) => (Number(b.unfit) - Number(a.unfit)) || (a.block - b.block)).map((e) => e.block);
// The plan: the first reserve slot repeats the first block of that order, the second slot the next one; nothing else is repeated.
const planBlock = (slot) => failedMain[RESERVE_SLOTS.indexOf(slot)];
const matchesPlan = (r) => planBlock(r.inv.header.at) === r.inv.header.onlyBlock;
const plannedReserves = reserves.filter(matchesPlan);
// A missing invocation becomes terminal strictly after the fixed start window.
const reserveStates = RESERVE_SLOTS.map((slot) => {
  const block = planBlock(slot);
  const invocation = plannedReserves.find((r) => r.inv.header.at === slot);
  const state = invocation ? (invocation.inv.footer ? 'completed' : 'aborted')
    : (nowMs > slotMs(slot) + START_WINDOW_S * 1000 ? 'closed unused' : 'pending');
  return { slot, block, state };
}).filter((q) => q.block !== undefined);
const closedSlots = reserveStates.filter((q) => q.state === 'closed unused');
// Hidden and detached, like the main start: a wrapper started in a window or a tool call dies with it.
const commandFor = (block, slot) => `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, 'start_sepolia_run.ps1')}" -Mode Reserve -Block ${block} -At ${slot}'`;

function report() {
  let dayRule = null;
  say('');
  say('== summary ==');
  if (monitorFile) gate('MONITOR_FILE', false, monitorUsable && badTicks === 0, `monitor file: ${ticks.length} ticks, ${badTicks} unreadable line(s)`);
  else if (!rehearsal) {
    if (noMonitor) gate('NO_MONITOR_WAIVER', false, false, 'network evidence waived by --no-monitor');
    else gate('MONITOR_REQUIRED', false, false, 'a monitor file is required (--monitor <file>); --no-monitor runs without evidence of sleep and network changes');
  }
  let incomplete = false;
  if (!rehearsal) {
    gate('MAIN_COUNT', true, mains.length === 1, `exactly one main invocation in the log (${mains.length})`);
    gate('RESERVE_COUNT', true, reserves.length <= RESERVE_SLOTS.length, `at most ${RESERVE_SLOTS.length} reserve invocations (${reserves.length})`);
    gate('RESERVE_SLOT_UNIQUE', true, new Set(reserves.map((r) => r.inv.header.at)).size === reserves.length, 'every reserve slot is used at most once');
    gate('RESERVE_BLOCK_UNIQUE', true, new Set(reserves.map((r) => r.inv.header.onlyBlock)).size === reserves.length, 'no block is repeated more than once');
    if (main) {
      for (const r of reserves) {
        const slot = r.inv.header.at;
        const planned = planBlock(slot);
        gate('RESERVE_PLAN', true, planned === r.inv.header.onlyBlock, `the reserve invocation at ${slot} repeats block ${r.inv.header.onlyBlock}; the plan names ${planned === undefined ? 'no block' : `block ${planned}`} for that slot`);
        gate('RESERVE_AFTER_MAIN', true, !main.inv.footer || Date.parse(r.inv.header.startedAt) > Date.parse(main.inv.footer.finishedAt), `the reserve invocation at ${slot} started after the main invocation ended`);
      }
      const coverage = {};
      for (const ev of main.blocks) coverage[ev.block] = ev.status === 'clean' ? 'main' : null;
      for (const r of plannedReserves) for (const ev of r.blocks) if (ev.status === 'clean' && !coverage[ev.block]) coverage[ev.block] = 'reserve';
      const clean = Object.keys(coverage).filter((b) => coverage[b]).map(Number);
      const missing = Object.keys(coverage).filter((b) => !coverage[b]).map(Number);
      say(`blocks with a clean run: ${clean.join(', ') || 'none'} (${clean.length} of 10)${reserves.length ? `; clean only through a reserve slot: ${Object.keys(coverage).filter((b) => coverage[b] === 'reserve').join(', ') || 'none'}` : ''}`);
      say(`blocks without a clean run: ${missing.join(', ') || 'none'}`);
      incomplete = missing.length > 0;
      if (monitorMissing) say('reserve plan: NOT RELIABLE (no monitor evidence)');
      else if (!failedMain.length) say('reserve plan: none (no block failed)');
      else {
        say('reserve plan (unfit blocks first, then the lowest failed block; one block per slot, each repeated once):');
        let allDone = true;
        RESERVE_SLOTS.forEach((slot, i) => {
          const b = failedMain[i];
          if (b === undefined) return;
          const done = plannedReserves.find((r) => r.inv.header.at === slot);
          if (done) {
            const repeatedClean = done.inv.header.onlyBlock === b && done.blocks.every((x) => x.status === 'clean');
            say(`  ${slot}  block ${b}: ${repeatedClean ? 'repeated, clean' : (done.inv.header.onlyBlock === b ? 'repeated, NOT clean (it is not repeated again)' : `a reserve invocation exists for block ${done.inv.header.onlyBlock} instead`)}`);
          }
          else if (closedSlots.some((q) => q.slot === slot)) say(`  ${slot}  block ${b}: closed unused (start window ended)`);
          else { allDone = false; say(`  ${slot}  block ${b}:  ${commandFor(b, slot)}`); }
        });
        if (failedMain.length > RESERVE_SLOTS.length) say(`  no slot for block(s) ${failedMain.slice(RESERVE_SLOTS.length).join(', ')}: they stay missing and the paper reports the n obtained`);
        if (allDone) say('  every planned reserve is terminal; no block is repeated again');
      }
    }
  }

  // The day rule (fixed before the run; it uses usable rows, covered slots and the network identity only, never a latency value).
  // One cluster per slot: the main block, or its repetition when the main block is unfit and the repetition is not. A verdict is
  // printed only when it is final: while a planned repetition of an unfit block is still to run, it can change the result.
  if (!rehearsal && main) {
    const slotClusters = main.blocks.map((mb) => {
      const rv = plannedReserves.find((r) => r.inv.header.onlyBlock === mb.block);
      const rep = rv ? rv.blocks[0] : null;
      const useReserve = Boolean(mb.unfit && rep && !rep.unfit);
      const used = useReserve ? rep : mb;
      const excluded = used.offNetwork;
      return { block: mb.block, used: useReserve ? 'reserve' : 'main', run: (useReserve ? rv : main).inv.header.startedAt, excluded, covered: !used.unfit, usable: excluded ? Object.fromEntries(MODES.map((m) => [m, 0])) : used.usable };
    });
    const covered = slotClusters.filter((c) => c.covered).length;
    const primaryRows = Object.fromEntries(MODES.map((m) => [m, slotClusters.reduce((a, c) => a + c.usable[m], 0)]));
    const sufficient = covered >= DAY_MIN_SLOTS && MODES.every((m) => primaryRows[m] >= DAY_MIN_ROWS);
    // All fatal gates must be registered above this point, before the day decision and verdict counts.
    const stands = sufficient && fatalGateFailures === 0;
    const pending = reserveStates.filter((q) => q.state === 'pending' && main.blocks.find((b) => b.block === q.block).unfit);
    const final = !monitorMissing && pending.length === 0;
    dayRule = { final, pending, closed_slots: closedSlots, reserve_states: reserveStates, stands: fatalGateFailures > 0 ? false : (final ? stands : null), data_sufficient: sufficient, fatal_gate_failures: fatalGateFailures, covered_slots: covered, primary_usable_rows: primaryRows, slot_clusters: slotClusters };
    const numbers = `${covered} of ${SLOTS.length} slots covered (${DAY_MIN_SLOTS} needed; ${slotClusters.filter((c) => c.used === 'reserve').length} represented by a repetition); usable timed rows in the primary ${MODES.map((m) => `${m} ${primaryRows[m]}`).join(', ')} (${DAY_MIN_ROWS} needed in each mode)`;
    const decision = monitorMissing ? 'NOT FINAL: no monitor file given' : final
      ? (stands ? 'THE DAY STANDS' : `THE DAY IS FAILED (${fatalGateFailures ? 'fatal configuration gate; ' : ''}RUN_DAY.md: ${failedDayAction})`)
      : `NOT FINAL: the planned repetition(s) of unfit block(s) ${pending.map((q) => `${q.block} (${q.slot})`).join(', ')} remain open; no verdict until they have been judged`;
    say(`day rule (fixed before the run): ${numbers}: ${decision}`);
  }
  const countOf = (mode) => rows.filter((r) => isTimedUsable(r, mode)).length;
  if (closedSlots.length) say(`day rule closed slots: ${closedSlots.map((q) => `${q.slot} (block ${q.block})`).join(', ')}`);
  say(`timed rows that succeeded, per mode (what the analysis counts): P ${countOf('P')}, S ${countOf('S')}, C ${countOf('C')}, Bt ${countOf('Bt')}${rehearsal ? '' : ' (100 each when ten blocks ran once without a failed row; a block repeated cleanly adds its rows)'}`);
  const blockNumbers = rows.filter((r) => (r.kind === 'sepolia' && r.mode !== 'cold') || r.kind === 'cache_check').map((r) => r.blockNumber).filter(Number.isInteger);
  if (blockNumbers.length) say(`first and last Sepolia block read: ${Math.min(...blockNumbers)} and ${Math.max(...blockNumbers)}`);
  const cu = evals.flatMap((e) => e.blocks).map((b) => b.cuPerS).filter(Number.isFinite);
  if (showValues && cu.length) say(`estimated draw on the throughput limit: median ${median(cu).toFixed(0)} CU/s, highest ${Math.max(...cu).toFixed(0)} CU/s (the documentation's free-tier example is 300 CU/s over a 10 s window)`);
  let networkIdentity = null;
  if (ticks.length) {
    const comparable = ticks.filter(comparableIdentity);
    const differing = comparable.filter((t) => t.net !== baseline.net);
    const noProfile = ticks.filter((t) => !identityText(t.net)).length;
    networkIdentity = { compared: comparable.length, differing: differing.length, no_profile: noProfile, first_at: differing.length ? new Date(differing[0].ms).toISOString() : null, last_at: differing.length ? new Date(differing[differing.length - 1].ms).toISOString() : null };
    if (!baselineValid) say('network identity: not available (no tick has a network profile and salt id)');
    else if (differing.length) say('network identity (note): ' + differing.length + ' of ' + comparable.length + ' ticks show another network, from ' + istClock(differing[0].ms) + ' to ' + istClock(differing[differing.length - 1].ms) + ' IST');
    else say('network identity: the same at all ' + comparable.length + ' ticks');
    if (noProfile) say('network identity (note): ' + noProfile + ' ticks with no network profile');
  }
  if (ticks.length) {
    const gaps = ticks.filter((t) => t.gapSeconds > GAP_S).length;
    say(`monitor: ${ticks.length} ticks from ${istClock(ticks[0].ms)} to ${istClock(ticks[ticks.length - 1].ms)} IST; ticks with a gap over ${GAP_S} s: ${gaps}; ticks not on mains: ${ticks.filter((t) => t.power !== 'Online').length}`);
  }

  // ---- secrets ------------------------------------------------------------------------------------------------------
  const parts = url ? [...R.secretParts(url)] : [];
  const hits = R.scanText(text, parts);
  gate('LOG_SELF_SCAN', false, url !== null && hits.length === 0, `self-scan of the log for parts of the RPC URL and banned strings: ${url === null ? 'URL not loaded' : (hits.length ? hits.join(', ') : 'clean')}`);

  if (blocksJsonFile) {
    // The run is identified in the log by the invocation's startedAt (every row carries it as `run`) and the block number.
    const verdict = {
      checker_sha256: SELF_SHA,
      date,
      evaluated_at: new Date(nowMs).toISOString(),
      clock_override: has('--now'),
      expect_overrides: expectOverrides,
      closed_slots: closedSlots,
      log: path.basename(logFile),
      log_sha256: LOG_SHA,
      monitor_files: monitorHashes,
      no_monitor: noMonitor,
      rehearsal,
      gate_failures: gateFailures,
      fatal_gate_failures: fatalGateFailures,
      gates,
      failed_main_blocks: failedMain,
      unfit_main_blocks: failedMainEvals.filter((e) => e.unfit).map((e) => e.block),
      day_rule: dayRule,
      network_identity: networkIdentity,
      plan: Object.fromEntries(RESERVE_SLOTS.map((q) => [q, planBlock(q) === undefined ? null : planBlock(q)])),
      invocations: evals.map((e, i) => ({
        index: i + 1,
        kind: e.kind,
        run: e.inv.header.startedAt,
        only_block: e.inv.header.onlyBlock === undefined ? null : e.inv.header.onlyBlock,
        matches_plan: e.kind !== 'reserve' || matchesPlan(e),
        reserve_slot: e.inv.header.at === undefined || e.inv.header.at === null ? null : e.inv.header.at,
        footer: !!e.inv.footer,
        blocks: e.blocks.map((b) => ({
          block: b.block,
          slot: b.slot || null,
          status: b.status,
          reasons: [...b.reasons.keys()],
          structure: [...b.structure],
          notes: b.notes,
          rows: b.rows,
          usable: b.usable,
          short: b.short,
          off_network: b.offNetwork,
          network_state: b.networkState || 'UNKNOWN',
          unfit: b.unfit,
          started_at: Number.isFinite(b.startedMs) ? new Date(b.startedMs).toISOString() : null,
        })),
      })),
    };
    try { fs.writeFileSync(blocksJsonFile, `${redact(JSON.stringify(verdict, null, 2))}\n`); } catch (e) { gate('VERDICT_WRITE', false, false, `the verdict file was NOT written (${e && e.code ? e.code : 'error'}); analysis_primary.js cannot run without it`); }
  }
  // Exit 1 on a failed gate; for the run, also while a block lacks a clean run (a failed block that a reserve slot repeated
  // cleanly is covered); for a rehearsal, while any block is not clean.
  const notClean = evals.flatMap((e) => e.blocks).filter((b) => b.status !== 'clean').length;
  say('');
  say(`gate failures: ${gateFailures}; blocks not clean in any invocation: ${notClean}${rehearsal ? '' : `; blocks still without a clean run: ${incomplete ? 'yes' : 'none'}`}`);
  const bad = gateFailures > 0 || (rehearsal ? notClean > 0 : incomplete);
  process.stdout.write(`${out.map((l) => redact(l)).join('\n')}\n`, () => process.exit(bad ? 1 : 0));
}

// A run that is still going has no verdict: a block in progress would look incomplete and the plan would be wrong. The log is
// written only while a block runs (about 30 s in every 80 minutes), the monitor file once a minute for as long as a wrapper
// lives, so the newest write of either shows a run that is going.
const newestWriteMs = [logFile, ...monitorFiles].reduce((newest, f) => { try { return Math.max(newest, fs.statSync(f).mtimeMs); } catch { return newest; } }, 0);
const unfinished = !rehearsal && inProgressWindowS > 0 && evals.some((e) => !e.inv.footer) && (Date.now() - newestWriteMs) < inProgressWindowS * 1000;
if (unfinished) {
  process.stdout.write(`${redact(out[0])}\nRUN STILL IN PROGRESS: an invocation has no footer and the log or a monitor file was written less than ${inProgressWindowS} s ago. No verdict and no plan yet; check again when status.ps1 shows that no wrapper is running.\n`, () => process.exit(5));
} else if (planSlot) {
  // For the wrapper: which block does the plan name for this reserve slot? Exit 0 with "PLAN <slot> <block>", or 4 with "none".
  const planned = monitorMissing || closedSlots.some((q) => q.slot === planSlot) ? undefined : planBlock(planSlot);
  process.stdout.write(`PLAN ${planSlot} ${planned === undefined ? 'none' : planned}\n`, () => process.exit(planned === undefined ? 4 : 0));
} else {
  report();
}
