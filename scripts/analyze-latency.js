#!/usr/bin/env node
/**
 * Statistics for a latency log (definitions in scripts/lib/stats.js).
 *
 *   node scripts/analyze-latency.js <log.jsonl> [--out <summary.json>]
 *
 * Understands three logs:
 *   - the July 2026 Sepolia log (records "latency" and "latency_parallel"), also with the values as first reported ("July-style");
 *   - measure-local.js logs (rows with kind "local");
 *   - measure-sepolia.js logs (rows with kind "sepolia" and "cache_check").
 * Warm-up rows are excluded. Reads only the log; never contacts a network.
 *
 * Samples of one process (local) or one block (Sepolia) are not independent of each other, so besides the pooled
 * statistics every summary gives the median of each process or block and an interval over them (whole processes or
 * blocks resampled; stats.clusterBootstrapCI), and compares the first and second half of the timed iterations within
 * each process or block (drift). Headers that disagree (commit, machine, versions) are reported as warnings.
 */
const fs = require('fs');
const path = require('path');
const S = require('./lib/stats');

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function groupBy(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(row);
  }
  return out;
}

// The median of each cluster and an interval over clusters (whole clusters resampled).
function clusterSummary(rows, clusterKey) {
  const groups = groupBy(rows, clusterKey);
  return {
    k: groups.size,
    medians: Object.fromEntries([...groups].map(([g, rs]) => [g, S.median(rs.map((r) => r.total_ms))])),
    bootstrap: S.clusterBootstrapCI([...groups.values()].map((rs) => rs.map((r) => r.total_ms)), S.median),
  };
}

// First half against second half of the timed iterations of each cluster (equal halves; the middle iteration of an
// odd count is left out). A warm-up that is too short shows as first halves that are slower in most clusters.
function drift(rows, clusterKey) {
  const first = [];
  const second = [];
  let clusters = 0;
  let slowerFirst = 0;
  for (const rs of groupBy(rows, clusterKey).values()) {
    const x = [...rs].sort((a, b) => a.iteration - b.iteration).map((r) => r.total_ms);
    const h = Math.floor(x.length / 2);
    if (h < 1) continue;
    const f = x.slice(0, h);
    const s = x.slice(x.length - h);
    first.push(...f);
    second.push(...s);
    clusters += 1;
    if (S.median(f) > S.median(s)) slowerFirst += 1;
  }
  return clusters ? {
    clusters, firstHalfMedian: S.median(first), secondHalfMedian: S.median(second), clustersSlowerFirst: slowerFirst,
  } : null;
}

// Fields that must agree across the headers of one log; a repeated process index and a dirty checkout are reported.
function headerWarnings(rows, fields) {
  const headers = rows.filter((r) => r.kind === 'header');
  const warnings = [];
  for (const f of fields) {
    const values = [...new Set(headers.map((h) => JSON.stringify(h[f] === undefined ? null : h[f])))];
    if (values.length > 1) warnings.push(`headers differ in ${f}: ${values.join(', ')}`);
  }
  const indices = {};
  for (const h of headers) if (h.processIndex !== undefined) indices[h.processIndex] = (indices[h.processIndex] || 0) + 1;
  for (const [p, n] of Object.entries(indices)) if (n > 1) warnings.push(`process index ${p} appears in ${n} headers`);
  if (headers.some((h) => typeof h.commit === 'string' && h.commit.endsWith('-dirty'))) {
    warnings.push('a header records a dirty checkout (tracked files differ from the commit)');
  }
  return warnings;
}

const r1 = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(1));
const r2 = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(2));

function analyzeJuly(rows) {
  const run1 = rows.find((r) => r.kind === 'latency');
  const run2 = rows.find((r) => r.kind === 'latency_parallel');
  const seq1 = run1.totals;
  const out = {
    log: 'July 2026 Sepolia run (n = 20 per run; the four contract reads only)',
    run1_sequential: S.summary(seq1),
    run1_perRead_median: Object.fromEntries(Object.entries(run1.per).map(([k, v]) => [k, S.median(v)])),
    run2_sequential: S.summary(run2.sequential),
    run2_parallel: S.summary(run2.parallel),
    run2_pairedSpeedup: S.pairedRatio(run2.sequential, run2.parallel),
    julyStyle: {
      run1_upperMedian: S.julyStyle.upperMedian(seq1),
      run1_p95ByIndex: S.julyStyle.p95ByIndex(seq1),
      run1_bootstrapUpperMedian_5seeds: [1, 2, 3, 4, 5].map((seed) => S.julyStyle.bootstrapUpperMedian(seq1, seed)),
      run2_parallel_upperMedian: S.julyStyle.upperMedian(run2.parallel),
      crossRunSpeedup: S.julyStyle.upperMedian(seq1) / S.julyStyle.upperMedian(run2.parallel),
    },
  };
  const j = out.julyStyle;
  const b = j.run1_bootstrapUpperMedian_5seeds.map((x) => `[${r1(x.lower)}, ${r1(x.upper)}]`);
  const lines = [
    out.log,
    `July-style (as first reported): sequential upper median ${r1(j.run1_upperMedian)} ms; "p95" ${r1(j.run1_p95ByIndex)} ms (the maximum); ` +
      `parallel upper median ${r1(j.run2_parallel_upperMedian)} ms; bootstrap of the upper median ${b[0]} ms ` +
      `(seeds 1-5: ${b.join(' ')}); cross-run speed-up ${r2(j.crossRunSpeedup)}`,
    `Conventional: sequential median ${r1(out.run1_sequential.median)} ms, order-statistic interval ` +
      `[${r1(out.run1_sequential.medianCI.lower)}, ${r1(out.run1_sequential.medianCI.upper)}] ms ` +
      `(ranks ${out.run1_sequential.medianCI.ranks.join(' and ')}, coverage ${(100 * out.run1_sequential.medianCI.coverage).toFixed(1)}%), ` +
      `nearest-rank p95 ${r1(out.run1_sequential.p95)} ms; parallel median ${r1(out.run2_parallel.median)} ms`,
    `Paired speed-up (run 2): median of ratios ${r2(out.run2_pairedSpeedup.medianOfRatios)} ` +
      `(range ${r2(out.run2_pairedSpeedup.min)}-${r2(out.run2_pairedSpeedup.max)}), ratio of medians ` +
      `${r2(out.run2_pairedSpeedup.ratioOfMedians)}`,
  ];
  return { out, lines };
}

function analyzeLocal(rows) {
  const all = rows.filter((r) => r.kind === 'local' && !r.warmup);
  const timed = all.filter((r) => r.valid === true && typeof r.total_ms === 'number' && Number.isFinite(r.total_ms));
  const totals = timed.map((r) => r.total_ms);
  const steps = {};
  for (const name of ['V1', 'B0', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8']) {
    const v = timed.filter((r) => r.steps && r.steps[name] !== undefined).map((r) => r.steps[name]);
    if (v.length) steps[name] = S.summary(v);
  }
  const byProcess = (r) => r.process;
  const out = {
    log: 'measure-local.js (full verification pipeline, Hardhat in-process network)',
    warnings: headerWarnings(rows, ['commit', 'cpu', 'cpuCount', 'node', 'hardhat', 'ethers', 'hardfork', 'solc', 'warmup', 'timed', 'powerScheme']),
    invalid: all.length - timed.length,
    total: S.summary(totals),
    steps,
    clusters: clusterSummary(timed, byProcess),
    drift: drift(timed, byProcess),
  };
  const t = out.total;
  const c = out.clusters;
  const d = out.drift;
  const lines = [
    out.log,
    ...out.warnings.map((w) => `WARNING: ${w}`),
    `n = ${t.n} timed verifications (${out.invalid} not valid); median ${r2(t.median)} ms ` +
      `[${r2(t.medianCI.lower)}, ${r2(t.medianCI.upper)}] (rows taken as independent), Q1 ${r2(t.q1)}, Q3 ${r2(t.q3)}, ` +
      `p95 ${r2(t.p95)}, mean ${r2(t.mean)}, min ${r2(t.min)}, max ${r2(t.max)} ms`,
    `Over ${c.k} processes: per-process medians ${Object.entries(c.medians).map(([k, v]) => `${k}: ${r2(v)}`).join(', ')} ms; ` +
      `interval for the median, processes resampled: [${r2(c.bootstrap.lower)}, ${r2(c.bootstrap.upper)}] ms (seed ${c.bootstrap.seed})`,
    ...(d ? [`Drift: first-half median ${r2(d.firstHalfMedian)} ms, second-half ${r2(d.secondHalfMedian)} ms; ` +
      `first half slower in ${d.clustersSlowerFirst} of ${d.clusters} processes`] : []),
    `Per-step medians (ms): ${Object.entries(steps).map(([k, v]) => `${k} ${v.median.toFixed(3)}`).join(', ')}`,
  ];
  return { out, lines };
}

// Requests a successful iteration of each mode sends (B0 plus the four reads; Bt's four reads travel in one batch).
const EXPECTED_REQUESTS = {
  P: { eth_blockNumber: 1, eth_call: 4 },
  S: { eth_blockNumber: 1, eth_call: 4 },
  C: { eth_blockNumber: 1, eth_call: 4 },
  Bt: { eth_blockNumber: 1, batch: 1 },
};

// A row enters the statistics only if its measurement succeeded: P must be VALID, and S, C and Bt must have a time,
// no error and answers that decode as expected. Failed rows are counted, by mode and error code, but never timed.
function usable(r) {
  if (typeof r.total_ms !== 'number' || !Number.isFinite(r.total_ms) || r.error) return false;
  return r.mode === 'P' ? r.valid === true : r.sane === true;
}

function sameCounts(actual = {}, expected = {}) {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].every((k) => (actual[k] || 0) === (expected[k] || 0));
}

function analyzeSepolia(rows) {
  const measured = rows.filter((r) => r.kind === 'sepolia' && !r.warmup && EXPECTED_REQUESTS[r.mode]);
  const pilotRowsIgnored = measured.filter((r) => r.pilot).length;
  const runRows = measured.filter((r) => !r.pilot);
  const timed = runRows.filter(usable);
  const excluded = {};
  for (const r of runRows.filter((x) => !usable(x))) {
    const e = excluded[r.mode] || (excluded[r.mode] = { n: 0, codes: {} });
    e.n += 1;
    const code = r.error || r.reason || (r.sane === false ? 'DECODE_CHECK_FAILED' : 'NO_TIME');
    e.codes[code] = (e.codes[code] || 0) + 1;
  }
  const requestAnomalies = {};
  for (const r of timed) {
    if (!sameCounts(r.requests, EXPECTED_REQUESTS[r.mode]) || (r.chainIdDuringTimer || 0) > 0) {
      requestAnomalies[r.mode] = (requestAnomalies[r.mode] || 0) + 1;
    }
  }
  const byMode = groupBy(timed, (r) => r.mode);
  const modes = {};
  for (const [mode, rs] of byMode) modes[mode] = S.summary(rs.map((r) => r.total_ms));
  const p = (byMode.get('P') || []).filter((r) => Number.isFinite(r.b0_ms));
  const pMinusB0 = p.map((r) => r.total_ms - r.b0_ms);
  const s = (byMode.get('S') || []).filter((r) => Array.isArray(r.reads_ms) && Number.isFinite(r.reads_ms[0]));
  const sThreeReads = s.map((r) => r.total_ms - r.reads_ms[0]);
  // One cluster per block of one run: a block run again (a reserve slot, or a second process) is its own cluster, and
  // its rows never pair with those of the first.
  const byBlock = (r) => `${r.run || ''}|${r.block}${r.reserve ? '|reserve' : ''}`;
  const key = (r) => `${byBlock(r)}|${r.iteration}`;
  // Pairs only iterations in which both modes succeeded; the interval resamples whole blocks.
  const pairs = (a, b) => {
    const mb = new Map((byMode.get(b) || []).map((r) => [key(r), r]));
    const left = [];
    const right = [];
    const ratios = new Map();
    for (const r of byMode.get(a) || []) {
      const other = mb.get(key(r));
      if (!other) continue;
      left.push(r.total_ms);
      right.push(other.total_ms);
      if (!ratios.has(byBlock(r))) ratios.set(byBlock(r), []);
      ratios.get(byBlock(r)).push(r.total_ms / other.total_ms);
    }
    if (!left.length) return null;
    return { ...S.pairedRatio(left, right), blockBootstrap: S.clusterBootstrapCI([...ratios.values()], S.median) };
  };
  const perBlock = {};
  for (const [blk, rs] of groupBy(timed, (r) => `${r.block}${r.reserve ? ' (reserve)' : ''}`)) {
    perBlock[blk] = Object.fromEntries([...groupBy(rs, (r) => r.mode)].map(([m, x]) => [m, S.median(x.map((r) => r.total_ms))]));
  }
  // Rows whose timer included a new connection (DNS, TCP, TLS), by mode and order; they stay in the statistics.
  const newSockets = {};
  for (const r of timed.filter((x) => (x.newSocketsDuringTimer || 0) > 0)) {
    const m = newSockets[r.mode] || (newSockets[r.mode] = {});
    m[r.order] = (m[r.order] || 0) + 1;
  }
  const clusters = {};
  const driftByMode = {};
  for (const [mode, rs] of byMode) {
    clusters[mode] = clusterSummary(rs, byBlock);
    driftByMode[mode] = drift(rs, byBlock);
  }
  const cold = rows.filter((r) => r.kind === 'sepolia' && r.coldStart && !r.pilot).map((r) => r.cold_ms).filter(Number.isFinite);
  const cache = rows.filter((r) => r.kind === 'cache_check' && Number.isFinite(r.fresh_ms) && Number.isFinite(r.known_ms));
  const out = {
    log: 'measure-sepolia.js (Sepolia; P = full pipeline, S = four reads in sequence, C = concurrent, Bt = one batch)',
    warnings: headerWarnings(rows.filter((r) => r.kind !== 'header' || r.label !== 'pilot'),
      ['commit', 'node', 'ethers', 'provider', 'chainId', 'contract', 'credentialB', 'blockLag', 'requestTimeoutMs', 'agents']),
    invalid: runRows.filter((r) => r.mode === 'P' && !r.valid).length,
    excluded,
    pilotRowsIgnored,
    requestAnomalies,
    newSockets,
    modes,
    clusters,
    drift: driftByMode,
    P_minus_B0: pMinusB0.length ? S.summary(pMinusB0) : null,
    S_threeReads_derived: sThreeReads.length ? S.summary(sThreeReads) : null,
    speedup_S_over_C: pairs('S', 'C'),
    speedup_S_over_Bt: pairs('S', 'Bt'),
    perBlockMedian: perBlock,
    coldStart: cold.length ? S.summary(cold) : null,
    cacheCheck: cache.length ? {
      fresh: S.summary(cache.map((r) => r.fresh_ms)),
      known: S.summary(cache.map((r) => r.known_ms)),
      freshMinusKnown: S.summary(cache.map((r) => r.fresh_ms - r.known_ms)),
    } : null,
  };
  const lines = [out.log, `P rows not valid: ${out.invalid}`];
  for (const [m, e] of Object.entries(excluded)) {
    lines.push(`${m}: ${e.n} row(s) excluded (${Object.entries(e.codes).map(([c, n]) => `${c} ${n}`).join(', ')})`);
  }
  if (pilotRowsIgnored) lines.push(`pilot rows ignored: ${pilotRowsIgnored}`);
  for (const w of out.warnings) lines.unshift(`WARNING: ${w}`);
  for (const [m, n] of Object.entries(requestAnomalies)) lines.push(`${m}: ${n} row(s) with unexpected request counts or a chain-ID request`);
  for (const [m, byOrder] of Object.entries(newSockets)) {
    lines.push(`${m}: rows whose timer opened a new connection, by order: ${Object.entries(byOrder).map(([o, n]) => `${o} ${n}`).join('; ')}`);
  }
  for (const [m, v] of Object.entries(modes)) {
    const c = clusters[m];
    const d = driftByMode[m];
    lines.push(`${m}: n = ${v.n}, median ${r1(v.median)} ms [${r1(v.medianCI.lower)}, ${r1(v.medianCI.upper)}] (rows taken as ` +
      `independent), over ${c.k} blocks [${r1(c.bootstrap.lower)}, ${r1(c.bootstrap.upper)}] (blocks resampled), ` +
      `Q1 ${r1(v.q1)}, Q3 ${r1(v.q3)}, p95 ${r1(v.p95)}, max ${r1(v.max)}` +
      (d ? `; first/second half ${r1(d.firstHalfMedian)}/${r1(d.secondHalfMedian)} ms, first slower in ${d.clustersSlowerFirst} of ${d.clusters} blocks` : ''));
  }
  if (out.P_minus_B0) lines.push(`P without B0: median ${r1(out.P_minus_B0.median)} ms`);
  if (out.S_threeReads_derived) lines.push(`S without its V2 read (derived three-read figure): median ${r1(out.S_threeReads_derived.median)} ms`);
  for (const [name, v] of [['S/C', out.speedup_S_over_C], ['S/Bt', out.speedup_S_over_Bt]]) {
    if (v) {
      lines.push(`${name} paired speed-up (n = ${v.n}): median ${r2(v.medianOfRatios)} [${r2(v.bootstrap.lower)}, ${r2(v.bootstrap.upper)}] ` +
        `(pairs resampled), [${r2(v.blockBootstrap.lower)}, ${r2(v.blockBootstrap.upper)}] (blocks resampled; seed ${v.bootstrap.seed}), ` +
        `range ${r2(v.min)}-${r2(v.max)}, ratio of medians ${r2(v.ratioOfMedians)}`);
    }
  }
  if (out.cacheCheck) {
    lines.push(`cache check (n = ${out.cacheCheck.fresh.n}): fresh read median ${r1(out.cacheCheck.fresh.median)} ms, known read ` +
      `${r1(out.cacheCheck.known.median)} ms, paired difference median ${r1(out.cacheCheck.freshMinusKnown.median)} ms`);
  }
  return { out, lines };
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const file = args.find((a, i) => !a.startsWith('--') && !(outIndex >= 0 && i === outIndex + 1));
  if (!file) {
    console.error('usage: node scripts/analyze-latency.js <log.jsonl> [--out <summary.json>]');
    process.exit(2);
  }
  const rows = readJsonl(file);
  let result;
  if (rows.some((r) => r.kind === 'latency_parallel')) result = analyzeJuly(rows);
  else if (rows.some((r) => r.kind === 'local')) result = analyzeLocal(rows);
  else if (rows.some((r) => r.kind === 'sepolia')) result = analyzeSepolia(rows);
  else throw new Error('unknown log format');
  result.out.source = path.basename(file);
  for (const line of result.lines) console.log(line);
  if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], `${JSON.stringify(result.out, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { analyzeJuly, analyzeLocal, analyzeSepolia };
