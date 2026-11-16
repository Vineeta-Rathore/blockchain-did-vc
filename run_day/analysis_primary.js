#!/usr/bin/env node
/**
 * The analysis of the 12 Nov run as it was fixed before the run (LOG.md, "Run-day addendum", rules A1-A9): one command on the
 * closed and hashed log, with the verdict that check_sepolia_run.js wrote with --blocks-json. It decides nothing from a latency
 * value: which rows and blocks enter each dataset comes from the checker's verdict (status, usable row counts, the day rule).
 *
 *   node analysis_primary.js --root <artifact folder> --log <log.jsonl> --verdict <verdict.json> [--out <summary.json>]
 *        [--accept-gate-failures] [--accept-clock-override]
 *
 * Datasets (a cluster is one invocation's block: the run id and the block number):
 *   primary  one cluster per slot: the main-run block, or its repetition when the main block is unfit
 *            and the repetition is not. Every usable timed row of those clusters, failed blocks
 *            included, except excluded off-network clusters. No row is left out for its latency, for coming after a reset, or for a monitor note.
 *   S1       every cluster of the log: the repetitions are added to the primary.
 *   S2       the clusters that the checker calls clean: a clean repetition replaces its failed original.
 *   S3       the primary without the timed rows whose timer opened a new connection (newSocketsDuringTimer above 0).
 * A usable timed row has a time, no error, P valid, S, C and Bt sane (the test of scripts/analyze-latency.js). Statistics come
 * from scripts/lib/stats.js and analyze-latency.js of the artifact; this script adds the cluster rule (a block median enters a
 * between-block interval only with at least 5 usable rows), the paired difference P - B0 - S, the agreement of S1-S3 with the
 * primary, and the tables of rows and errors.
 *
 * It refuses (exit 2) a verdict that does not belong to this exact log (name or SHA-256), one that is not final (the day rule
 * still said NOT FINAL), one with failed gates or with an invocation that has no footer (unless --accept-gate-failures is given
 * after the cause was understood and written in LOG.md, addendum D4), and a log whose usable counts differ from the verdict's.
 *
 * Exit code: 0 on success, 2 on a usage error or a refused verdict.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const root = opt('--root');
const logFile = opt('--log');
const verdictFile = opt('--verdict');
const outFile = opt('--out');
const acceptGate = argv.includes('--accept-gate-failures');
const acceptClock = argv.includes('--accept-clock-override');
const fail = (message) => { console.error(message); process.exit(2); };
if (!root || !logFile || !verdictFile || (argv.includes('--out') && !outFile)) {
  fail('usage: node analysis_primary.js --root <artifact folder> --log <log.jsonl> --verdict <verdict.json> [--out <summary.json>] [--accept-gate-failures] [--accept-clock-override]');
}
const A = require(path.join(root, 'scripts', 'analyze-latency.js'));
const S = require(path.join(root, 'scripts', 'lib', 'stats.js'));

const MODES = ['P', 'S', 'C', 'Bt'];
const MIN_CLUSTER_ROWS = 5;
const SLOW_MS = 10000;
const clone = (x) => JSON.parse(JSON.stringify(x));
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '-');

let logBytes;
try { logBytes = fs.readFileSync(logFile); } catch { fail('the log file cannot be read'); }
let verdict;
// no parse message is printed: it can quote the first line of a wrong file (review 28, S3B-03)
try { verdict = JSON.parse(fs.readFileSync(verdictFile, 'utf8')); } catch { fail('the verdict file cannot be read or is not valid JSON'); }
if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) fail('the verdict is not a JSON object');
if (verdict.log !== path.basename(logFile)) fail(`the verdict is for the log ${verdict.log}, not ${path.basename(logFile)}`);
if (verdict.log_sha256 !== crypto.createHash('sha256').update(logBytes).digest('hex')) fail('the verdict was made for another version of this log (the SHA-256 differs)');
if (!verdict.day_rule) fail('the verdict has no day rule (a rehearsal, or a log without a main invocation)');
if (!Number.isInteger(verdict.fatal_gate_failures) || verdict.fatal_gate_failures < 0) fail('the verdict has no valid fatal-gate count; regenerate it with the frozen checker');
if (verdict.fatal_gate_failures > 0) fail('fatal failed gate: the run did not follow the frozen configuration; --accept-gate-failures cannot authorise analysis');
if (!Array.isArray(verdict.gates) || !verdict.gates.some((g) => g.id === 'LOG_SELF_SCAN' && g.ok === true)) {
  fail('log self-scan did not pass; analysis cannot publish data from this log');
}
if (verdict.day_rule.final !== true) fail('the verdict is not final: the day rule says NOT FINAL (a planned repetition of an unfit block is still to run); run it, then run the checker again');
if (!Array.isArray(verdict.expect_overrides) || typeof verdict.clock_override !== 'boolean') fail('the verdict lacks expect_overrides or clock_override; regenerate it with the frozen checker');
if (verdict.expect_overrides?.length) fail('the verdict used frozen expectation overrides; analysis refused');
if (verdict.clock_override === true && !acceptClock) fail('the verdict used --now; pass --accept-clock-override for a documented replay');
if (verdict.gates.some((g) => g.id === 'JSON_FORMAT' && !g.ok)) fail('log contains malformed JSON; analysis refused');
const noFooter = verdict.invocations.filter((inv) => !inv.footer).map((inv) => inv.index);
if (!acceptGate && (verdict.gate_failures > 0 || noFooter.length)) {
  fail(`the verdict has ${verdict.gate_failures} failed gate(s)${noFooter.length ? ` and no footer for invocation(s) ${noFooter.join(', ')}` : ''}: understand them and write the cause in LOG.md (addendum D4); then run again with --accept-gate-failures`);
}
let rows;
try { rows = logBytes.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { fail('log contains malformed JSON; analysis refused'); }

// ---- the datasets -------------------------------------------------------------------------------------------------------
const key = (r) => `${r.run}|${r.block}`;
const pick = (keys) => rows.filter((r) => r.kind === 'header' || r.kind === 'footer' || keys.has(key(r)));
const primaryKeys = new Set(verdict.day_rule.slot_clusters.filter((c) => !c.excluded).map((c) => `${c.run}|${c.block}`));
const cleanKeys = new Set();
for (const inv of verdict.invocations) for (const b of inv.blocks) if (inv.matches_plan !== false && b.status === 'clean') cleanKeys.add(`${inv.run}|${b.block}`);
const datasets = { primary: pick(primaryKeys), S1: rows, S2: pick(cleanKeys) };
datasets.S3 = datasets.primary.filter((r) => !(r.kind === 'sepolia' && r.warmup === false && !r.pilot && r.newSocketsDuringTimer > 0));

// ---- statistics ---------------------------------------------------------------------------------------------------------
const timed = (r, mode) => r.kind === 'sepolia' && r.mode === mode && r.warmup === false && !r.pilot;
const usable = (r, mode) => timed(r, mode) && !r.error && Number.isFinite(r.total_ms) && (mode === 'P' ? r.valid === true : r.sane === true);

// The median of each cluster's values and the order-statistic interval of those medians; a cluster with fewer than
// MIN_CLUSTER_ROWS values stays out of the interval (its rows remain in the pooled statistics).
function betweenBlocks(valuesByCluster, allClusters) {
  const medians = [];
  const small = [];
  for (const c of allClusters) {
    const v = valuesByCluster.get(c) || [];
    if (v.length >= MIN_CLUSTER_ROWS) medians.push(S.median(v)); else small.push(c);
  }
  return { clusters: medians.length, small_clusters: small.length, small_list: small, medians, interval: medians.length ? S.clusterMedianCI(medians) : null };
}
function paired(rowsD, a, b, valueOf, allClusters) {
  const index = (m) => { const out = new Map(); for (const r of rowsD) if (usable(r, m)) out.set(`${key(r)}|${r.iteration}`, r); return out; };
  const pairKey = (r) => [key(r), r.iteration].join('|');
  const attemptedA = new Set(rowsD.filter((r) => timed(r, a)).map(pairKey));
  const attemptedB = new Set(rowsD.filter((r) => timed(r, b)).map(pairKey));
  const attempted = [...attemptedA].filter((k) => attemptedB.has(k)).length;
  const ia = index(a);
  const ib = index(b);
  const values = [];
  const perCluster = new Map();
  for (const [k, ra] of ia) {
    const rb = ib.get(k);
    if (!rb) continue;
    const v = valueOf(ra, rb);
    if (!Number.isFinite(v)) continue;
    values.push(v);
    const c = key(ra);
    if (!perCluster.has(c)) perCluster.set(c, []);
    perCluster.get(c).push(v);
  }
  return { attempted, n: values.length, median: values.length ? S.median(values) : null, bootstrap: values.length ? S.bootstrapCI(values, S.median) : null, between: betweenBlocks(perCluster, allClusters) };
}
function summarize(rowsD) {
  // The artifact's analysis supplies the drift count and the new-socket table; if it cannot run on a dataset (for example
  // one with no timed row), the rest of this report still stands and the reason is recorded.
  let analysis = { drift: {}, newSockets: {} };
  let analysisError = null;
  try { analysis = A.analyzeSepolia(clone(rowsD)).out; } catch (e) { analysisError = String(e && e.message); }
  const allClusters = [...new Set(rowsD.filter((r) => MODES.some((m) => timed(r, m))).map(key))];
  const out = { clusters: allClusters.length, analysis_error: analysisError, modes: {}, paired: {} };
  for (const m of MODES) {
    const attempted = rowsD.filter((r) => timed(r, m));
    const values = rowsD.filter((r) => usable(r, m)).map((r) => r.total_ms);
    const errors = {};
    for (const r of attempted) if (r.error) errors[r.error] = (errors[r.error] || 0) + 1;
    const byCluster = new Map();
    for (const r of rowsD) if (usable(r, m)) { const k = key(r); if (!byCluster.has(k)) byCluster.set(k, []); byCluster.get(k).push(r.total_ms); }
    const sm = values.length ? S.summary(values) : null;
    out.modes[m] = {
      attempted: attempted.length,
      usable: values.length,
      error_rows: errors,
      not_usable_without_error_code: attempted.length - values.length - Object.values(errors).reduce((a, b) => a + b, 0),
      rows_over_10s: values.filter((v) => v > SLOW_MS).length,
      median: sm ? sm.median : null,
      p95: sm ? sm.p95 : null,
      max: sm ? sm.max : null,
      pooled_interval_rows_as_independent: sm ? sm.medianCI : null,
      between_blocks: betweenBlocks(byCluster, allClusters),
    };
  }
  out.paired['S/C'] = paired(rowsD, 'S', 'C', (s, c) => s.total_ms / c.total_ms, allClusters);
  out.paired['S/Bt'] = paired(rowsD, 'S', 'Bt', (s, bt) => s.total_ms / bt.total_ms, allClusters);
  out.paired['P-B0-S'] = paired(rowsD, 'P', 'S', (p, s) => (p.total_ms - p.b0_ms) - s.total_ms, allClusters);
  const coldRows = rowsD.filter((r) => r.kind === 'sepolia' && r.coldStart && !r.pilot);
  const cold = coldRows.filter((r) => Number.isFinite(r.cold_ms)).map((r) => r.cold_ms);
  out.cold_blocks = new Set([...allClusters, ...coldRows.map(key)]).size;
  out.cold_start = cold.length ? { n: cold.length, median: S.median(cold), min: Math.min(...cold), max: Math.max(...cold) } : null;
  const cache = rowsD.filter((r) => r.kind === 'cache_check' && Number.isFinite(r.fresh_ms) && Number.isFinite(r.known_ms));
  out.cache_check = cache.length ? { n: cache.length, fresh_median: S.median(cache.map((r) => r.fresh_ms)), known_median: S.median(cache.map((r) => r.known_ms)), fresh_minus_known_median: S.median(cache.map((r) => r.fresh_ms - r.known_ms)) } : null;
  let slower = 0;
  let pairs = 0;
  for (const m of MODES) if (analysis.drift && analysis.drift[m]) { slower += analysis.drift[m].clustersSlowerFirst; pairs += analysis.drift[m].clusters; }
  out.drift = { first_half_slower_in: slower, of_block_mode_pairs: pairs };
  out.new_socket_rows = analysis.newSockets || {};
  return out;
}

const results = {};
for (const [name, rowsD] of Object.entries(datasets)) results[name] = summarize(rowsD);
for (const m of MODES) {
  if (results.primary.modes[m].usable !== verdict.day_rule.primary_usable_rows[m]) fail(`the primary has ${results.primary.modes[m].usable} usable ${m} rows, the verdict says ${verdict.day_rule.primary_usable_rows[m]}: the log and the verdict disagree`);
}
const kindOf = new Map(verdict.invocations.map((inv) => [inv.run, `${inv.kind} invocation ${inv.index}`]));
const named = (clusterKeys) => clusterKeys.map((k) => { const [run, block] = k.split('|'); return `block ${block} of ${kindOf.get(run) || run}`; }).join(', ');

// ---- the report ---------------------------------------------------------------------------------------------------------
const say = (t = '') => console.log(t);
const range = (b) => (b.interval ? `[${f1(b.interval.lower)}, ${f1(b.interval.upper)}] (ranks ${b.interval.ranks.join(' and ')} of ${b.clusters} blocks, nominal exact coverage under independent exchangeable block medians ${(100 * b.interval.coverage).toFixed(1)}%)` : 'not available (no block with 5 usable rows)');
const rangeR = (b) => (b.interval ? `[${f3(b.interval.lower)}, ${f3(b.interval.upper)}] (ranks ${b.interval.ranks.join(' and ')} of ${b.clusters} blocks, nominal exact coverage under independent exchangeable block medians ${(100 * b.interval.coverage).toFixed(1)}%)` : 'not available (no block with 5 usable pairs)');
const codes = (e) => (Object.keys(e).length ? Object.entries(e).map(([c, n]) => `${c} x${n}`).join(', ') : 'none');

say(`checker SHA-256 ${verdict.checker_sha256}; log SHA-256 ${verdict.log_sha256}`);
say('verdict evaluated_at: ' + (verdict.evaluated_at || 'not recorded') + ', clock_override: ' + String(verdict.clock_override) +
    (verdict.clock_override && acceptClock ? ' (ACCEPTED with --accept-clock-override)' : ''));
say('== primary cluster table ==');
say('block | used cluster | run kind | started_at (UTC) | network_state | excluded | covered');
for (const c of verdict.day_rule.slot_clusters) {
  const inv = verdict.invocations.find((candidate) => candidate.run === c.run);
  const b = inv?.blocks.find((block) => block.block === c.block);
  say([c.block, c.used === 'reserve' ? 'repetition' : 'main', inv?.kind || '-', b?.started_at || '-',
    b?.network_state || 'UNKNOWN', c.excluded, c.covered].join(' | '));
}
say(`gates: ${verdict.gate_failures} failed${acceptGate && (verdict.gate_failures > 0 || noFooter.length) ? ' (ACCEPTED with --accept-gate-failures)' : ''}; footers: ${noFooter.length ? `missing for invocation(s) ${noFooter.join(', ')}` : 'present for every invocation'}; monitor: ${verdict.no_monitor ? 'none (--no-monitor)' : (verdict.monitor_files.length ? verdict.monitor_files.map((f) => `${f.name} ${f.sha256.slice(0, 12)}`).join(', ') : 'no file given')}`);
say(`day rule (from the verdict): ${verdict.day_rule.covered_slots} of ${verdict.day_rule.slot_clusters.length} slots covered; usable timed rows in the primary ${MODES.map((m) => `${m} ${verdict.day_rule.primary_usable_rows[m]}`).join(', ')}: ${verdict.day_rule.stands ? 'the day stands' : 'THE DAY IS FAILED'}`);
say('');
say('== monitor notes (tabulated before any latency is shown; never a reason to exclude or explain a row) ==');
let anyNote = false;
for (const inv of verdict.invocations) for (const b of inv.blocks) if (b.notes.length) { anyNote = true; say(`${inv.kind} invocation ${inv.run}, block ${b.block}: ${b.notes.join('; ')}`); }
if (!anyNote) say('none');
if (verdict.network_identity) say(`network identity (from the monitor): ${verdict.network_identity.differing} of ${verdict.network_identity.compared} ticks show another network than the first comparable baseline tick${verdict.network_identity.differing ? `, between ${verdict.network_identity.first_at} and ${verdict.network_identity.last_at} (UTC)` : ''}`);
else say('network identity: not available');
if (verdict.network_identity?.no_profile) say('monitor ticks with no network profile: ' + verdict.network_identity.no_profile);
say('');
say('== rows: usable, attempted, error rows by code (primary dataset; n = 100 per mode is the planned size only) ==');
const P = results.primary;
for (const m of MODES) {
  const x = P.modes[m];
  say(`${m}: ${x.usable} usable of ${x.attempted} attempted timed rows in ${P.clusters} blocks; error rows: ${codes(x.error_rows)}; not usable without an error code (P not valid, S, C or Bt reads not as expected): ${x.not_usable_without_error_code}; rows over 10 s: ${x.rows_over_10s}`);
}
say('');
say('== primary analysis: one cluster per slot, every usable timed row ==');
say('Intervals are the range between the blocks of one day (order statistics of the block medians), not confidence intervals for the latency; the pooled interval treats rows as independent.');
for (const m of MODES) {
  const x = P.modes[m];
  say(`${m}: pooled median ${f1(x.median)} ms; median of block medians ${f1(x.between_blocks.medians.length ? S.median(x.between_blocks.medians) : null)} ms; range between blocks ${range(x.between_blocks)}; pooled interval, rows taken as independent ${x.pooled_interval_rows_as_independent && x.pooled_interval_rows_as_independent.lower !== null ? `[${f1(x.pooled_interval_rows_as_independent.lower)}, ${f1(x.pooled_interval_rows_as_independent.upper)}]` : 'n/a'}; p95 ${f1(x.p95)}, max ${f1(x.max)}; ${x.between_blocks.small_clusters} block(s) with fewer than ${MIN_CLUSTER_ROWS} usable rows${x.between_blocks.small_clusters ? ` (${named(x.between_blocks.small_list)}; their rows stay in the pooled statistics)` : ''}`);
}
for (const [name, label] of [['S/C', 'S over C (paired per iteration)'], ['S/Bt', 'S over Bt (paired per iteration)'], ['P-B0-S', 'P minus its own block-number read minus S (paired per iteration, ms)']]) {
  const x = P.paired[name];
  if (!x.n) { say(label + ': 0 usable pairs of ' + x.attempted + ' attempted'); continue; }
  const fmt = name === 'P-B0-S' ? f1 : f3;
  say(`${label}: n = ${x.n} usable pairs of ${x.attempted} attempted, pooled median ${fmt(x.median)}, median of block medians ${fmt(x.between.medians.length ? S.median(x.between.medians) : null)}, bootstrap interval [${fmt(x.bootstrap.lower)}, ${fmt(x.bootstrap.upper)}] (pairs taken as independent; seed ${x.bootstrap.seed}), range between blocks ${(name === 'P-B0-S' ? range : rangeR)(x.between)}`);
  say('  paired clusters below five: ' + x.between.small_clusters + (x.between.small_clusters ? ' (' + named(x.between.small_list) + '; their pairs stay in the pooled statistics)' : ''));
}
say(P.cold_start ? `cold start (descriptive, ${P.cold_start.n} of ${P.cold_blocks} blocks): median ${f1(P.cold_start.median)} ms, from ${f1(P.cold_start.min)} to ${f1(P.cold_start.max)} ms` : ('cold start: 0 of ' + P.cold_blocks + ' blocks'));
say(P.cache_check ? `cache check (descriptive, n = ${P.cache_check.n} blocks; the fresh read is always timed first and the known read second, not counterbalanced): fresh median ${f1(P.cache_check.fresh_median)} ms, known ${f1(P.cache_check.known_median)} ms, paired difference ${f1(P.cache_check.fresh_minus_known_median)} ms` : 'cache check: no row');
say(`drift (read only as one pooled count): the first half of the timed iterations is slower in ${P.drift.first_half_slower_in} of ${P.drift.of_block_mode_pairs} block-mode pairs`);
say(`rows whose timer opened a new connection, by mode and order: ${JSON.stringify(P.new_socket_rows)}`);
say('C against Bt is descriptive only: the four orders are a cyclic Latin square that does not balance which mode precedes which.');
say('');
say('== sensitivity analyses, always shown beside the primary ==');
const labels = { S1: 'S1, every cluster of the log (repetitions added)', S2: 'S2, clusters the checker calls clean (a clean repetition replaces its failed original)', S3: 'S3, primary without rows whose timer opened a new connection' };
const agreement = {};
for (const name of ['S1', 'S2', 'S3']) {
  const R = results[name];
  say(`${labels[name]}: ${R.clusters} blocks`);
  agreement[name] = {};
  for (const m of MODES) {
    const x = R.modes[m];
    say('  ' + m + ' error rows: ' + codes(x.error_rows) + '; not usable without an error code: ' + x.not_usable_without_error_code);
    const bb = P.modes[m].between_blocks;
    const agrees = bb.interval && bb.interval.lower < bb.interval.upper && Number.isFinite(x.median) ? (x.median >= bb.interval.lower && x.median <= bb.interval.upper) : null;
    agreement[name][m] = agrees;
    say(`  ${m}: ${x.usable} usable of ${x.attempted}, median ${f1(x.median)} ms, range between blocks ${range(x.between_blocks)}; descriptive containment: ${agrees === null ? 'indeterminate (absent or degenerate primary range, or no sensitivity median)' : (agrees ? 'inside the primary range' : 'outside the primary range')}; containment is not equivalence`);
  }
  for (const pname of ['S/C', 'S/Bt', 'P-B0-S']) {
    const x = R.paired[pname];
    if (x) {
      say(`  ${pname}: n = ${x.n} usable pairs of ${x.attempted} attempted, median ${pname === 'P-B0-S' ? f1(x.median) : f3(x.median)}; range between blocks ${(pname === 'P-B0-S' ? range : rangeR)(x.between)}`);
      say('  paired clusters below five: ' + x.between.small_clusters + (x.between.small_clusters ? ' (' + named(x.between.small_list) + ')' : ''));
    }
  }
}
say('All datasets are shown side by side. Containment is descriptive, not equivalence or evidence of robustness; an absent or degenerate range is indeterminate.');

const differences = {};
for (const label of [...MODES, 'S/C', 'S/Bt', 'P-B0-S']) {
  const median = (result) => (result.modes[label] || result.paired[label])?.median;
  const base = median(P);
  const unit = label === 'S/C' || label === 'S/Bt' ? 'ratio units' : 'ms';
  differences[label] = {};
  const texts = ['S1', 'S2', 'S3'].map((name) => {
    const comparison = median(results[name]);
    const delta = Number.isFinite(base) && Number.isFinite(comparison) ? comparison - base : null;
    const percent = Number.isFinite(delta) && base > 0 ? 100 * delta / base : null; // a zero or negative primary median gives no percentage (its sign would flip)
    differences[label][name] = { delta, unit, percent_of_primary: percent };
    return name + ' - primary: ' + (delta === null ? 'unavailable' :
      (unit === 'ms' ? f1(delta) : f3(delta)) + ' ' + unit + ' (' + (percent === null ? 'percentage unavailable' : f1(percent) + '%') + ')');
  });
  say(label + ' differences: ' + texts.join(' | '));
}
if (outFile) {
  fs.writeFileSync(outFile, `${JSON.stringify({ checker_sha256: verdict.checker_sha256, log_sha256: verdict.log_sha256, day_rule: verdict.day_rule, gate_failures: verdict.gate_failures, fatal_gate_failures: verdict.fatal_gate_failures, accepted_gate_failures: acceptGate && (verdict.gate_failures > 0 || noFooter.length > 0), gates: verdict.gates, evaluated_at: verdict.evaluated_at, clock_override: verdict.clock_override, accepted_clock_override: verdict.clock_override === true && acceptClock, results, agreement, differences }, null, 2)}\n`);
}
