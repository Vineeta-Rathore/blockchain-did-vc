'use strict';
// Mutation run of check_sepolia_run.js. Each mutant is a one-place change of a COPY of the checker (in the system temp folder,
// deleted at the end); the scenario suite runs against the copy and must report at least one WRONG line. A mutant that
// survives is a rule that no scenario tests. The real files are only read. Nothing here contacts a network.
//
//   node tests/mutation.js <artifact root> <deployment record> [mutant numbers, comma separated] [parallel jobs, default 4]
//
// Each mutant is [name, exact text (must occur once in the target), replacement, target file (default check_sepolia_run.js; the
// other one is analysis_primary.js)]. Equivalent mutants (no realistic log tells them apart from the original) are marked
// "equivalent" in their name and are expected to survive.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const [root, recordFile, onlyArg, parArg] = process.argv.slice(2);
if (!root || !recordFile) {
  console.error('usage: node tests/mutation.js <artifact root> <deployment record> [mutant numbers] [parallel jobs]');
  process.exit(2);
}
const SRC = path.join(__dirname, '..');
const SOURCES = Object.fromEntries(['check_sepolia_run.js', 'analysis_primary.js'].map((f) => [f, fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r\n/g, '\n')]));

const MUTANTS = [
  [
    "gap threshold 90 -> 150",
    "const GAP_S = 90;",
    "const GAP_S = 150;"
  ],
  [
    "gap threshold 90 -> 30",
    "const GAP_S = 90;",
    "const GAP_S = 30;"
  ],
  [
    "monitor look-ahead 120 -> 30",
    "const LOOKAHEAD_S = 120;",
    "const LOOKAHEAD_S = 30;"
  ],
  [
    "monitor look-ahead 120 -> 600",
    "const LOOKAHEAD_S = 120;",
    "const LOOKAHEAD_S = 600;"
  ],
  [
    "monitor look-back 90 -> 10",
    "const LOOKBACK_S = 90;",
    "const LOOKBACK_S = 10;"
  ],
  [
    "monitor look-back 90 -> 400",
    "const LOOKBACK_S = 90;",
    "const LOOKBACK_S = 400;"
  ],
  [
    "start window 120 -> 119",
    "const START_WINDOW_S = 120;",
    "const START_WINDOW_S = 119;"
  ],
  [
    "start window 120 -> 300",
    "const START_WINDOW_S = 120;",
    "const START_WINDOW_S = 300;"
  ],
  [
    "SLOW_MS 10000 -> 10001",
    "const SLOW_MS = 10000;",
    "const SLOW_MS = 10001;"
  ],
  [
    "SLOW_MS 10000 -> 9999",
    "const SLOW_MS = 10000;",
    "const SLOW_MS = 9999;"
  ],
  [
    "IST offset 330 -> 331",
    "const IST_MIN = 330;",
    "const IST_MIN = 331;"
  ],
  [
    "slot 20:00 -> 20:01",
    "'18:40', '20:00'];",
    "'18:40', '20:01'];"
  ],
  [
    "note: CPU threshold 25 -> 1",
    "const NOTE_CPU_PCT = 25;",
    "const NOTE_CPU_PCT = 1;"
  ],
  [
    "note: traffic threshold 1 MB -> 100 bytes",
    "const NOTE_RX_BYTES = 1000000;",
    "const NOTE_RX_BYTES = 100;"
  ],
  [
    "request count: more than expected allowed (!== n -> < n)",
    "if ((requests[method] || 0) !== n) issues.push",
    "if ((requests[method] || 0) < n) issues.push"
  ],
  [
    "request count: unexpected method allowed",
    "if (!(method in expected)) issues.push(`REQUEST_COUNT:${r.mode}:unexpected ${method}`);",
    ""
  ],
  [
    "chainIdDuringTimer field ignored",
    "if ((r.chainIdDuringTimer || 0) !== 0 || requests.eth_chainId)",
    "if (requests.eth_chainId)"
  ],
  [
    "S reads_ms rule removed",
    "if (r.mode === 'S' && Array.isArray(r.reads_ms) && r.reads_ms.some((x) => x > SLOW_MS)) issues.push('REQUEST_OVER_10S');",
    ""
  ],
  [
    "b0 rule: > -> >=",
    "r.b0_ms > SLOW_MS) issues.push('REQUEST_OVER_10S');",
    "r.b0_ms >= SLOW_MS) issues.push('REQUEST_OVER_10S');"
  ],
  [
    "b0 rule removed",
    "if (r.mode !== 'P' && Number.isFinite(r.b0_ms) && r.b0_ms > SLOW_MS) issues.push('REQUEST_OVER_10S');",
    ""
  ],
  [
    "P sanity: reason not checked",
    "if (r.valid !== true || r.reason !== 'VALID') issues.push('SANITY:P not valid');",
    "if (r.valid !== true) issues.push('SANITY:P not valid');"
  ],
  [
    "P sanity: valid flag not checked",
    "if (r.valid !== true || r.reason !== 'VALID') issues.push('SANITY:P not valid');",
    "if (r.reason !== 'VALID') issues.push('SANITY:P not valid');"
  ],
  [
    "block number: any defined value",
    "if (!Number.isInteger(r.blockNumber)) issues.push('NO_BLOCK_NUMBER');",
    "if (r.blockNumber === undefined) issues.push('NO_BLOCK_NUMBER');"
  ],
  [
    "error rows: HTTP_429 label removed",
    "if (/HTTP_429/.test(String(r.error))) issues.push('HTTP_429');",
    ""
  ],
  [
    "early start tolerance -1 -> -100",
    "ev.startDelayS < -1",
    "ev.startDelayS < -100"
  ],
  [
    "cold row: more than one allowed",
    "if (cold.length !== 1) structure.add",
    "if (cold.length < 1) structure.add"
  ],
  [
    "cache row: more than one allowed",
    "if (cache.length !== 1) structure.add",
    "if (cache.length < 1) structure.add"
  ],
  [
    "incomplete: only fewer rows fail",
    "if (data.length !== ITERATIONS * 4) bump",
    "if (data.length < ITERATIONS * 4) bump"
  ],
  [
    "monitor never evaluated",
    "if (Number.isFinite(ev.startedMs) && monitorFiles.length) {",
    "if (false) {"
  ],
  [
    "cold slow check removed",
    "if (c.cold_ms > SLOW_MS) bump(reasons, 'REQUEST_OVER_10S');",
    ""
  ],
  [
    "cache slow check removed",
    "else if (cache[0].fresh_ms > SLOW_MS || cache[0].known_ms > SLOW_MS) bump(reasons, 'REQUEST_OVER_10S');",
    ""
  ],
  [
    "P steps list: V8 not required",
    "'V6', 'V7', 'V8']",
    "'V6', 'V7']"
  ],
  [
    "P steps list: B0 not required",
    "['B0', 'V1',",
    "['V1',"
  ],
  [
    "warm-up flag rule removed",
    "if (r.warmup !== warm) structure.add(",
    "if (false) structure.add("
  ],
  [
    "order field rule removed",
    "if (r.order !== expected.join(',')) structure.add(",
    "if (false) structure.add("
  ],
  [
    "pilot row rule in block removed",
    "if (r.pilot) structure.add('pilot row in a run');",
    ""
  ],
  [
    "gap rule: > -> >= (boundary 90)",
    "t.gapSeconds > GAP_S && t.ms >= lo",
    "t.gapSeconds >= GAP_S && t.ms >= lo"
  ],
  [
    "gap interval: tick time used instead of interval start",
    "t.ms - t.gapSeconds * 1000 <= hi",
    "t.ms <= hi"
  ],
  [
    "gap tick need not be at/after lo",
    "t.gapSeconds > GAP_S && t.ms >= lo &&",
    "t.gapSeconds > GAP_S &&"
  ],
  [
    "wifi down rule removed",
    "if (t.wifiUp === false) reasons.push('NETWORK_CHANGE:Wi-Fi down');",
    ""
  ],
  [
    "vpn rule: > 0 -> > 1",
    "if (t.vpn > 0) reasons.push",
    "if (t.vpn > 1) reasons.push"
  ],
  [
    "gateway rule removed",
    "if (prev && t.gw !== prev.gw) reasons.push('NETWORK_CHANGE:default gateway changed');",
    ""
  ],
  [
    "interfaces rule removed",
    "if (prev && JSON.stringify(t.ifaces) !== JSON.stringify(prev.ifaces)) reasons.push('NETWORK_CHANGE:interfaces up changed');",
    ""
  ],
  [
    "wrapper id: compare by pid only",
    "const idOf = (x) => (x.wid !== undefined ? x.wid : x.w);",
    "const idOf = (x) => x.w;"
  ],
  [
    "no tick near block: rule removed",
    "if (!inWindow.length && !gapTicks.length) reasons.push('NO_MONITOR_TICK_NEAR_BLOCK');",
    ""
  ],
  [
    "mains lost note removed",
    "if (t.power !== 'Online') notes.push('mains lost (note only)');",
    ""
  ],
  [
    "restart note removed",
    "if (t.restartPending === true) notes.push('Windows restart pending (note only)');",
    ""
  ],
  [
    "CPU note removed",
    "if (Number.isFinite(t.cpuPct) && t.cpuPct > NOTE_CPU_PCT) notes.push(",
    "if (false) notes.push("
  ],
  [
    "traffic note removed",
    "if (prev && Number.isFinite(t.rxBytes) && Number.isFinite(prev.rxBytes) && t.rxBytes - prev.rxBytes > NOTE_RX_BYTES) {",
    "if (false) {"
  ],
  [
    "reserve count gate: <= 2 -> <= 9",
    "reserves.length <= RESERVE_SLOTS.length",
    "reserves.length <= 9"
  ],
  [
    "reserve must start after main footer: removed",
    "gate('RESERVE_AFTER_MAIN', true, !main.inv.footer || Date.parse(r.inv.header.startedAt) > Date.parse(main.inv.footer.finishedAt),",
    "gate('RESERVE_AFTER_MAIN', true, true || Date.parse(r.inv.header.startedAt) > Date.parse(main.inv.footer.finishedAt),"
  ],
  [
    "plan order: short priority removed (lowest block first)",
    "(Number(b.unfit) - Number(a.unfit)) || (a.block - b.block)",
    "(a.block - b.block)"
  ],
  [
    "plan order: short priority reversed (short blocks last)",
    "(Number(b.unfit) - Number(a.unfit)) || (a.block - b.block)",
    "(Number(a.unfit) - Number(b.unfit)) || (a.block - b.block)"
  ],
  [
    "plan order: highest block number first within a group",
    "(Number(b.unfit) - Number(a.unfit)) || (a.block - b.block)",
    "(Number(b.unfit) - Number(a.unfit)) || (b.block - a.block)"
  ],
  [
    "short: minimum rows 5 -> 6",
    "const MIN_ROWS = 5;",
    "const MIN_ROWS = 6;"
  ],
  [
    "short: minimum rows 5 -> 4",
    "const MIN_ROWS = 5;",
    "const MIN_ROWS = 4;"
  ],
  [
    "short: only P is judged",
    "ev.short = MODES.some((m) => ev.usable[m] < MIN_ROWS);",
    "ev.short = ev.usable.P < MIN_ROWS;"
  ],
  [
    "day rule: slots needed 8 -> 7",
    "const DAY_MIN_SLOTS = 8;",
    "const DAY_MIN_SLOTS = 7;"
  ],
  [
    "day rule: slots needed 8 -> 9",
    "const DAY_MIN_SLOTS = 8;",
    "const DAY_MIN_SLOTS = 9;"
  ],
  [
    "day rule: rows needed 80 -> 79",
    "const DAY_MIN_ROWS = 80;",
    "const DAY_MIN_ROWS = 79;"
  ],
  [
    "day rule: rows needed 80 -> 81",
    "const DAY_MIN_ROWS = 80;",
    "const DAY_MIN_ROWS = 81;"
  ],
  [
    "day rule: a short block counts as covered",
    "covered: !used.unfit,",
    "covered: true,"
  ],
  [
    "day rule: the repetition replaces a block that is not short",
    "const useReserve = Boolean(mb.unfit && rep && !rep.unfit);",
    "const useReserve = Boolean(rep && !rep.unfit);"
  ],
  [
    "day rule: a short repetition replaces a short block",
    "const useReserve = Boolean(mb.unfit && rep && !rep.unfit);",
    "const useReserve = Boolean(mb.unfit && rep);"
  ],
  [
    "day rule: rows are not required",
    "MODES.every((m) => primaryRows[m] >= DAY_MIN_ROWS)",
    "true"
  ],
  [
    "day rule: slots are not required",
    "covered >= DAY_MIN_SLOTS && MODES.every",
    "true && MODES.every"
  ],
  [
    "day rule line not printed for a run",
    "if (!rehearsal && main) {\n    const slotClusters",
    "if (rehearsal && main) {\n    const slotClusters"
  ],
  [
    "values: always shown",
    "const showValues = has('--values');",
    "const showValues = true;"
  ],
  [
    "values: never shown",
    "const showValues = has('--values');",
    "const showValues = false;"
  ],
  [
    "plan: only status failed (a missing block gets no slot)",
    "main.blocks.filter((e) => e.status !== 'clean')",
    "main.blocks.filter((e) => e.status === 'failed')"
  ],
  [
    "coverage: reserve counts even if not clean",
    "if (ev.status === 'clean' && !coverage[ev.block]) coverage[ev.block] = 'reserve';",
    "if (!coverage[ev.block]) coverage[ev.block] = \"reserve\";"
  ],
  [
    "count line: error rows counted",
    "r.warmup === false && !r.pilot && !r.error &&",
    "r.warmup === false && !r.pilot &&"
  ],
  [
    "count line: P validity dropped",
    "(mode === 'P' ? r.valid === true : r.sane === true);",
    "(mode === 'P' ? true : r.sane === true);"
  ],
  [
    "count line: S, C and Bt sanity dropped",
    "(mode === 'P' ? r.valid === true : r.sane === true);",
    "(mode === 'P' ? r.valid === true : true);"
  ],
  [
    "count line: finite total_ms dropped",
    "Number.isFinite(r.total_ms) && (mode === 'P'",
    "(mode === 'P'"
  ],
  [
    "count line: warm-up rows counted",
    "r.warmup === false && !r.pilot",
    "!r.pilot"
  ],
  [
    "exit: incomplete ignored for main run",
    "(rehearsal ? notClean > 0 : incomplete)",
    "(rehearsal ? notClean > 0 : false)"
  ],
  [
    "self-scan: hits ignored",
    "gate('LOG_SELF_SCAN', false, url !== null && hits.length === 0,",
    "gate('LOG_SELF_SCAN', false, url !== null,"
  ],
  [
    "plan-slot exit code 4 -> 0",
    "process.exit(planned === undefined ? 4 : 0)",
    "process.exit(0)"
  ],
  [
    "header commit gate removed",
    "gate('CONFIG_COMMIT', true, h.commit === expectCommit,",
    "gate('CONFIG_COMMIT', true, true || h.commit === expectCommit,"
  ],
  [
    "header timezone gate removed",
    "gate('CONFIG_TIMEZONE', true, h.timezoneOffsetMinutes === IST_MIN,",
    "gate('CONFIG_TIMEZONE', true, true || h.timezoneOffsetMinutes === IST_MIN,"
  ],
  [
    "footer nonce gate: only the flag",
    "inv.footer.nonceUnchanged === true && inv.footer.deployerNonceEnd === record.deployerNonceAfterSetup",
    "inv.footer.nonceUnchanged === true"
  ],
  [
    "footer nonce gate: only the value",
    "inv.footer.nonceUnchanged === true && inv.footer.deployerNonceEnd === record.deployerNonceAfterSetup",
    "inv.footer.deployerNonceEnd === record.deployerNonceAfterSetup"
  ],
  [
    "header nonce gate: nonce value not compared",
    "h.deployer === record.deployer && h.deployerNonceStart === record.deployerNonceAfterSetup",
    "h.deployer === record.deployer"
  ],
  [
    "foreign run id gate removed",
    "const foreign = inv.rows.filter((r) => r.run !== h.startedAt).length;",
    "const foreign = 0;"
  ],
  [
    "agents gate: scheduling not checked",
    "h.agents.keepAlive === true && h.agents.scheduling === 'fifo'",
    "h.agents.keepAlive === true"
  ],
  [
    "slots gate (main) removed",
    "if (kind === 'main') gate('CONFIG_SLOTS', true, JSON.stringify(h.slots) === JSON.stringify(SLOTS),",
    "if (kind === 'main') gate('CONFIG_SLOTS', true, true || JSON.stringify(h.slots) === JSON.stringify(SLOTS),"
  ],
  [
    "request timeout gate removed",
    "gate('CONFIG_TIMEOUT', true, h.requestTimeoutMs === 30000,",
    "gate('CONFIG_TIMEOUT', true, true || h.requestTimeoutMs === 30000,"
  ],
  [
    "in-progress guard: time window ignored (always in progress when no footer)",
    "(Date.now() - newestWriteMs) < inProgressWindowS * 1000",
    "true"
  ],
  [
    "in-progress guard: monitor files not consulted",
    "[logFile, ...monitorFiles].reduce(",
    "[logFile].reduce("
  ],
  [
    "in-progress guard: footer not consulted",
    "evals.some((e) => !e.inv.footer) &&",
    "true &&"
  ],
  [
    "in-progress guard: rehearsal not excluded",
    "const unfinished = !rehearsal && inProgressWindowS > 0",
    "const unfinished = inProgressWindowS > 0"
  ],
  [
    "in-progress guard: exit 5 -> 1",
    "process.exit(5)",
    "process.exit(1)"
  ],
  [
    "in-progress window: negative accepted",
    "|| !(inProgressWindowS >= 0) ||",
    "||"
  ],
  [
    "blocks-json: a missing file name accepted",
    "(argv.includes('--blocks-json') && !blocksJsonFile)",
    "false"
  ],
  [
    "blocks-json: log hash left out",
    "log_sha256: LOG_SHA,",
    ""
  ],
  [
    "blocks-json: day rule left out",
    "day_rule: dayRule,",
    ""
  ],
  [
    "crash handler: exit 3 -> 1",
    "process.exit(3)",
    "process.exit(1)"
  ],
  [
    "round 5: unfit ignores the network",
    "ev.unfit = ev.short || ev.offNetwork || ev.networkState === 'UNKNOWN';",
    "ev.unfit = ev.short;"
  ],
  [
    "different network is ignored",
    "if (t.net !== base.net)",
    "if (false)"
  ],
  [
    "compare ticks with another salt",
    "&& t.saltId === baseline.saltId",
    ""
  ],
  [
    "compare ticks with empty profiles",
    "identityText(t.net) && identityText(t.saltId) && t.saltId",
    "identityText(t.saltId) && t.saltId"
  ],
  [
    "day verdict always final",
    "const final = !monitorMissing && pending.length === 0;",
    "const final = true;"
  ],
  [
    "round 5: a pending repetition counts although the block is fit",
    "main.blocks.find((b) => b.block === q.block).unfit",
    "true"
  ],
  [
    "round 5: a failed verdict write is ignored",
    "gate('VERDICT_WRITE', false, false, `the verdict file was NOT written (${e && e.code ? e.code : 'error'}); analysis_primary.js cannot run without it`)",
    "0"
  ],
  [
    "round 5: the window option accepts any number text",
    "const inProgressWindowS = /^\\d+$/.test(inProgressWindowArg) ? Number(inProgressWindowArg) : NaN;",
    "const inProgressWindowS = Number(inProgressWindowArg);"
  ],
  [
    "different network note is hidden",
    "else if (differing.length) say('network identity (note):",
    "else if (false) say('network identity (note):"
  ],
  [
    "analysis: a verdict that is not final is accepted",
    "if (verdict.day_rule.final !== true) fail(",
    "if (false) fail(",
    "analysis_primary.js"
  ],
  [
    "analysis: failed gates and missing footers are ignored",
    "if (!acceptGate && (verdict.gate_failures > 0 || noFooter.length)) {",
    "if (false) {",
    "analysis_primary.js"
  ],
  [
    "analysis: counts that differ from the verdict are ignored",
    "if (results.primary.modes[m].usable !== verdict.day_rule.primary_usable_rows[m]) fail(",
    "if (false) fail(",
    "analysis_primary.js"
  ],
  [
    "analysis: cluster rule minimum rows 5 -> 4",
    "const MIN_CLUSTER_ROWS = 5;",
    "const MIN_CLUSTER_ROWS = 4;",
    "analysis_primary.js"
  ],
  [
    "analysis: cluster rule minimum rows 5 -> 6",
    "const MIN_CLUSTER_ROWS = 5;",
    "const MIN_CLUSTER_ROWS = 6;",
    "analysis_primary.js"
  ],
  [
    "equivalent on producer logs: analysis: usable rows may carry an error code",
    "!r.error && Number.isFinite(r.total_ms) && (mode",
    "Number.isFinite(r.total_ms) && (mode",
    "analysis_primary.js"
  ],
  [
    "analysis: P validity not required",
    "(mode === 'P' ? r.valid === true : r.sane === true)",
    "(mode === 'P' ? true : r.sane === true)",
    "analysis_primary.js"
  ],
  [
    "analysis: S, C and Bt sanity not required",
    "(mode === 'P' ? r.valid === true : r.sane === true)",
    "(mode === 'P' ? r.valid === true : true)",
    "analysis_primary.js"
  ],
  [
    "analysis: warm-up rows counted as timed",
    "const timed = (r, mode) => r.kind === 'sepolia' && r.mode === mode && r.warmup === false && !r.pilot;",
    "const timed = (r, mode) => r.kind === 'sepolia' && r.mode === mode && !r.pilot;",
    "analysis_primary.js"
  ],
  [
    "analysis: the primary is every cluster (S1)",
    "const datasets = { primary: pick(primaryKeys),",
    "const datasets = { primary: rows,",
    "analysis_primary.js"
  ],
  [
    "analysis: S2 keeps failed clusters too",
    "if (inv.matches_plan !== false && b.status === 'clean') cleanKeys",
    "if (inv.matches_plan !== false) cleanKeys",
    "analysis_primary.js"
  ],
  [
    "analysis: S3 leaves nothing out",
    "!(r.kind === 'sepolia' && r.warmup === false && !r.pilot && r.newSocketsDuringTimer > 0)",
    "true",
    "analysis_primary.js"
  ],
  [
    "analysis: S3 also leaves out warm-up rows with new sockets (equivalent: warm-up rows are never timed rows)",
    "!(r.kind === 'sepolia' && r.warmup === false && !r.pilot && r.newSocketsDuringTimer > 0)",
    "!(r.kind === 'sepolia' && !r.pilot && r.newSocketsDuringTimer > 0)",
    "analysis_primary.js"
  ],
  [
    "analysis: P - B0 - S without subtracting B0",
    "(p.total_ms - p.b0_ms) - s.total_ms",
    "p.total_ms - s.total_ms",
    "analysis_primary.js"
  ],
  [
    "analysis: S/C inverted",
    "s.total_ms / c.total_ms",
    "c.total_ms / s.total_ms",
    "analysis_primary.js"
  ],
  [
    "analysis: S/Bt inverted",
    "s.total_ms / bt.total_ms",
    "bt.total_ms / s.total_ms",
    "analysis_primary.js"
  ],
  [
    "analysis: agreement always true",
    "(x.median >= bb.interval.lower && x.median <= bb.interval.upper)",
    "true",
    "analysis_primary.js"
  ],
  [
    "analysis: agreement against a one-sided bound",
    "(x.median >= bb.interval.lower && x.median <= bb.interval.upper)",
    "(x.median >= bb.interval.lower)",
    "analysis_primary.js"
  ],
  [
    "analysis: the log hash of the verdict is not checked",
    "if (verdict.log_sha256 !== crypto.createHash('sha256').update(logBytes).digest('hex')) fail(",
    "if (false) fail(",
    "analysis_primary.js"
  ],
  [
    "analysis: the log name of the verdict is not checked",
    "if (verdict.log !== path.basename(logFile)) fail(",
    "if (false) fail(",
    "analysis_primary.js"
  ],
  [
    "analysis: monitor notes not printed",
    "if (b.notes.length) { anyNote = true;",
    "if (false) { anyNote = true;",
    "analysis_primary.js"
  ],
  [
    "analysis: error rows not tabulated",
    "for (const r of attempted) if (r.error) errors[r.error] = (errors[r.error] || 0) + 1;",
    "",
    "analysis_primary.js"
  ],
  [
    "analysis: drift count read from the first mode only",
    "for (const m of MODES) if (analysis.drift && analysis.drift[m]) {",
    "for (const m of MODES.slice(0, 1)) if (analysis.drift && analysis.drift[m]) {",
    "analysis_primary.js"
  ],
  [
    "closure: closes at the exact deadline",
    "nowMs > slotMs(slot) + START_WINDOW_S * 1000",
    "nowMs >= slotMs(slot) + START_WINDOW_S * 1000",
    "check_sepolia_run.js"
  ],
  [
    "closure: unused slots never close",
    "nowMs > slotMs(slot) + START_WINDOW_S * 1000",
    "false",
    "check_sepolia_run.js"
  ],
  [
    "closure: missing invocation already completed",
    ": 'pending');",
    ": 'completed');",
    "check_sepolia_run.js"
  ],
  [
    "closure: aborted invocation called completed",
    "invocation.inv.footer ? 'completed' : 'aborted'",
    "invocation.inv.footer ? 'completed' : 'completed'",
    "check_sepolia_run.js"
  ],
  [
    "network UNKNOWN preserves coverage",
    "ev.networkState === 'UNKNOWN'",
    "false",
    "check_sepolia_run.js"
  ],
  [
    "network baseline invalid accepted",
    "gate('NETWORK_BASELINE', false, baselineValid,",
    "gate('NETWORK_BASELINE', false, true,",
    "check_sepolia_run.js"
  ],
  [
    "later SAME can erase DIFFERENT",
    "else if (networkState === 'UNKNOWN') networkState = 'SAME';",
    "else networkState = 'SAME';"
  ],
  [
    "primary keeps unreplaced off-network rows",
    "const excluded = used.offNetwork;",
    "const excluded = false;",
    "check_sepolia_run.js"
  ],
  [
    "analysis ignores primary exclusion",
    ".filter((c) => !c.excluded)",
    "",
    "analysis_primary.js"
  ],
  [
    "fatal failures do not defeat sufficient data",
    "const stands = sufficient && fatalGateFailures === 0;",
    "const stands = sufficient;",
    "check_sepolia_run.js"
  ],
  [
    "fatal gate counter never increments",
    "if (!ok && fatal) fatalGateFailures += 1;",
    "",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_SCRIPT_LABEL",
    "gate('CONFIG_SCRIPT_LABEL', true,",
    "gate('CONFIG_SCRIPT_LABEL', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_CHAIN",
    "gate('CONFIG_CHAIN', true,",
    "gate('CONFIG_CHAIN', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_COMMIT",
    "gate('CONFIG_COMMIT', true,",
    "gate('CONFIG_COMMIT', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_BLOCK_LAG",
    "gate('CONFIG_BLOCK_LAG', true,",
    "gate('CONFIG_BLOCK_LAG', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_ITERATIONS",
    "gate('CONFIG_ITERATIONS', true,",
    "gate('CONFIG_ITERATIONS', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_CONTRACT",
    "gate('CONFIG_CONTRACT', true,",
    "gate('CONFIG_CONTRACT', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_CREDENTIAL",
    "gate('CONFIG_CREDENTIAL', true,",
    "gate('CONFIG_CREDENTIAL', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_DEPLOYER_START",
    "gate('CONFIG_DEPLOYER_START', true,",
    "gate('CONFIG_DEPLOYER_START', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_DEPLOYER_END",
    "gate('CONFIG_DEPLOYER_END', true,",
    "gate('CONFIG_DEPLOYER_END', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_PROVIDER",
    "gate('CONFIG_PROVIDER', true,",
    "gate('CONFIG_PROVIDER', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_NODE",
    "gate('CONFIG_NODE', true,",
    "gate('CONFIG_NODE', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_ETHERS",
    "gate('CONFIG_ETHERS', true,",
    "gate('CONFIG_ETHERS', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_TIMEZONE",
    "gate('CONFIG_TIMEZONE', true,",
    "gate('CONFIG_TIMEZONE', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_AGENTS",
    "gate('CONFIG_AGENTS', true,",
    "gate('CONFIG_AGENTS', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_TIMEOUT",
    "gate('CONFIG_TIMEOUT', true,",
    "gate('CONFIG_TIMEOUT', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: CONFIG_SLOTS",
    "gate('CONFIG_SLOTS', true,",
    "gate('CONFIG_SLOTS', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: PILOT_ROWS",
    "gate('PILOT_ROWS', true,",
    "gate('PILOT_ROWS', false,",
    "check_sepolia_run.js"
  ],
  [
    "fatal classification removed: FOREIGN_RUN_IDS",
    "gate('FOREIGN_RUN_IDS', true,",
    "gate('FOREIGN_RUN_IDS', false,",
    "check_sepolia_run.js"
  ],
  [
    "analysis accepts fatal failures",
    "if (verdict.fatal_gate_failures > 0) fail(",
    "if (false) fail(",
    "analysis_primary.js"
  ],
  [
    "analysis accepts fatal failures with flag",
    "if (verdict.fatal_gate_failures > 0) fail(",
    "if (verdict.fatal_gate_failures > 0 && !acceptGate) fail(",
    "analysis_primary.js"
  ],
  [
    "containment treats degenerate range as decisive",
    "bb.interval.lower < bb.interval.upper",
    "bb.interval.lower <= bb.interval.upper",
    "analysis_primary.js"
  ],
  [
    "default in-progress guard disabled",
    "opt('--in-progress-window', '120')",
    "opt('--in-progress-window', '0')",
    "check_sepolia_run.js"
  ],
  [
    "analysis slow rows use wrong threshold",
    "const SLOW_MS = 10000;",
    "const SLOW_MS = 100000;",
    "analysis_primary.js"
  ],
  [
    "missing monitor plan presented as reliable",
    "if (monitorMissing) say('reserve plan: NOT RELIABLE (no monitor evidence)');",
    "if (false) say('reserve plan: NOT RELIABLE (no monitor evidence)');"
  ],
  [
    "no monitor waiver bypassed",
    "if (noMonitor) gate('NO_MONITOR_WAIVER', false, false,",
    "if (noMonitor) gate('NO_MONITOR_WAIVER', false, true,"
  ],
  [
    "first tick is the only possible baseline",
    "ticks.find((t) => identityText(t.net) && identityText(t.saltId))",
    "[ticks[0]].find((t) => t && identityText(t.net) && identityText(t.saltId))"
  ],
  [
    "wrong-slot reserve resolves pending state",
    "const invocation = plannedReserves.find",
    "const invocation = reserves.find"
  ],
  [
    "wrong-slot reserve enters primary",
    "const rv = plannedReserves.find",
    "const rv = reserves.find"
  ],
  [
    "expectation overrides not recorded",
    "expect_overrides: expectOverrides,",
    "expect_overrides: [],"
  ],
  [
    "a built-in expectation is reported as overridden",
    "has(option) && value !== builtIn",
    "has(option)"
  ],
  [
    "empty network profile counted as DIFFERENT in note",
    "const differing = comparable.filter((t) => t.net !== baseline.net);",
    "const differing = comparable.filter((t) => t.net !== baseline.net).concat(ticks.filter(t => !identityText(t.net)));"
  ],
  [
    "RESERVE_PLAN classified as nonfatal",
    "gate('RESERVE_PLAN', true,",
    "gate('RESERVE_PLAN', false,"
  ],
  [
    "RESERVE_COUNT classified as nonfatal",
    "gate('RESERVE_COUNT', true,",
    "gate('RESERVE_COUNT', false,"
  ],
  [
    "RESERVE_SLOT_UNIQUE classified as nonfatal",
    "gate('RESERVE_SLOT_UNIQUE', true,",
    "gate('RESERVE_SLOT_UNIQUE', false,"
  ],
  [
    "RESERVE_BLOCK_UNIQUE classified as nonfatal",
    "gate('RESERVE_BLOCK_UNIQUE', true,",
    "gate('RESERVE_BLOCK_UNIQUE', false,"
  ],
  [
    "RESERVE_AFTER_MAIN classified as nonfatal",
    "gate('RESERVE_AFTER_MAIN', true,",
    "gate('RESERVE_AFTER_MAIN', false,"
  ],
  [
    "MAIN_COUNT classified as nonfatal",
    "gate('MAIN_COUNT', true,",
    "gate('MAIN_COUNT', false,"
  ],
  [
    "analysis accepts unrecorded clock override",
    "if (verdict.clock_override === true && !acceptClock)",
    "if (false)",
    "analysis_primary.js"
  ],
  [
    "analysis accepts expectation overrides",
    "if (verdict.expect_overrides?.length)",
    "if (false)",
    "analysis_primary.js"
  ],
  [
    "analysis loses attempted failed pairs",
    "return { attempted, n: values.length,",
    "return { attempted: values.length, n: values.length,",
    "analysis_primary.js"
  ],
  [
    "analysis loses cold denominator",
    "new Set([...allClusters, ...coldRows.map(key)]).size",
    "cold.length",
    "analysis_primary.js"
  ],
  [
    "analysis hides median of block medians",
    "ms; median of block medians",
    "ms; block median estimate",
    "analysis_primary.js"
  ],
  [
    "analysis changes the sign of the differences",
    "? comparison - base : null",
    "? base - comparison : null",
    "analysis_primary.js"
  ],
  [
    "analysis loses acceptance metadata",
    "accepted_clock_override: verdict.clock_override === true && acceptClock",
    "accepted_clock_override: false",
    "analysis_primary.js"
  ]
];

const only = onlyArg ? onlyArg.split(',').map(Number) : null;
const par = Number(parArg || 4);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'r2_mutation_'));
process.on('exit', () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* nothing to clean */ } });

const jobs = [];
MUTANTS.forEach(([name, from, to, target = 'check_sepolia_run.js'], i) => {
  if (only && !only.includes(i)) return;
  const count = SOURCES[target].split(from).length - 1;
  if (count !== 1) { console.log(`SKIP m${i} (the pattern occurs ${count} times in ${target}): ${name}`); return; }
  const dir = path.join(out, `m${i}`);
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  for (const f of Object.keys(SOURCES)) fs.writeFileSync(path.join(dir, f), f === target ? SOURCES[f].replace(from, () => to) : SOURCES[f]);
  for (const f of ['test_check_sepolia_run.js', 'template_clean_block.jsonl']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, 'tests', f));
  jobs.push({ name, dir, i });
});

let next = 0;
let running = 0;
const results = [];
function launch() {
  while (running < par && next < jobs.length) {
    const job = jobs[next++];
    running++;
    const p = cp.spawn(process.execPath, [path.join(job.dir, 'tests', 'test_check_sepolia_run.js'), root, recordFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, R2_MUTATION_FAIL_FAST: '1' } });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    p.on('close', () => {
      running--;
      const wrong = buf.split('\n').filter((l) => /^WRONG/.test(l)).map((l) => l.replace(/^WRONG\s+/, '').split(':')[0]);
      results.push({ name: job.name, i: job.i, caught: wrong.length > 0 });
      console.log(`${wrong.length ? 'caught   ' : 'SURVIVED '}m${job.i} ${job.name}${wrong.length ? `  <- ${wrong.slice(0, 2).join(' | ')}` : ''}`);
      if (next >= jobs.length && running === 0) {
        const survivors = results.filter((r) => !r.caught);
        console.log(`\n${survivors.length} survived of ${results.length} mutants run (${MUTANTS.length} defined)`);
        for (const s of survivors) console.log(`  survivor m${s.i}: ${s.name}`);
        process.exitCode = survivors.length ? 1 : 0;
      }
      launch();
    });
  }
}
if (process.env.CHECK_PATTERNS) {
  // after any edit of the checker: does every pattern still occur exactly once? (no suite is run)
  console.log(`${jobs.length} of ${only ? only.length : MUTANTS.length} patterns occur exactly once`);
  process.exit(jobs.length === (only ? only.length : MUTANTS.length) ? 0 : 1);
}
// Control run: the unmutated suite must be green before any mutant is judged, else every mutant would count as "caught".
{
  const base = cp.spawnSync(process.execPath, [path.join(__dirname, 'test_check_sepolia_run.js'), root, recordFile], { encoding: 'utf8', env: { ...process.env, R2_MUTATION_FAIL_FAST: '0' } });
  const wrongLines = `${base.stdout}${base.stderr}`.split('\n').filter((l) => /^WRONG/.test(l));
  if (base.status !== 0 || wrongLines.length) {
    console.error(`the unmutated suite is not green (exit ${base.status}, ${wrongLines.length} WRONG line(s)): no mutant can be judged`);
    process.exit(3);
  }
  console.log('control run: the unmutated suite is green');
}
if (!jobs.length) console.log('no mutant to run');
launch();
