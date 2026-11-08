#!/usr/bin/env node
/**
 * Statistics for a latency log (plan D1; definitions in scripts/lib/stats.js).
 *
 *   node scripts/analyze-latency.js <log.jsonl> [--out <summary.json>]
 *
 * Understands three logs:
 *   - the July 2026 Sepolia log (records "latency" and "latency_parallel"), also with the R1 ("July-style") values;
 *   - measure-local.js logs (rows with kind "local");
 *   - measure-sepolia.js logs (rows with kind "sepolia" and "cache_check").
 * Warm-up rows are excluded. Reads only the log; never contacts a network.
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

const r1 = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(1));
const r2 = (v) => Number(v).toFixed(2);

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
    `July-style (R1): sequential upper median ${r1(j.run1_upperMedian)} ms; "p95" ${r1(j.run1_p95ByIndex)} ms (the maximum); ` +
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
  const timed = rows.filter((r) => r.kind === 'local' && !r.warmup);
  const totals = timed.map((r) => r.total_ms);
  const steps = {};
  for (const name of ['V1', 'B0', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8']) {
    const v = timed.filter((r) => r.steps && r.steps[name] !== undefined).map((r) => r.steps[name]);
    if (v.length) steps[name] = S.summary(v);
  }
  const perProcess = {};
  for (const [p, rs] of groupBy(timed, (r) => r.process)) perProcess[p] = S.median(rs.map((r) => r.total_ms));
  const out = {
    log: 'measure-local.js (full verification pipeline, Hardhat in-process network)',
    invalid: timed.filter((r) => !r.valid).length,
    total: S.summary(totals),
    steps,
    perProcessMedian: perProcess,
  };
  const t = out.total;
  const lines = [
    out.log,
    `n = ${t.n} timed verifications (${out.invalid} not valid); median ${r2(t.median)} ms ` +
      `[${r2(t.medianCI.lower)}, ${r2(t.medianCI.upper)}], Q1 ${r2(t.q1)}, Q3 ${r2(t.q3)}, p95 ${r2(t.p95)}, ` +
      `mean ${r2(t.mean)}, min ${r2(t.min)}, max ${r2(t.max)} ms`,
    `Per-step medians (ms): ${Object.entries(steps).map(([k, v]) => `${k} ${v.median.toFixed(3)}`).join(', ')}`,
    `Per-process medians (ms): ${Object.entries(perProcess).map(([k, v]) => `${k}: ${r2(v)}`).join(', ')}`,
  ];
  return { out, lines };
}

function analyzeSepolia(rows) {
  const timed = rows.filter((r) => r.kind === 'sepolia' && !r.warmup);
  const byMode = groupBy(timed, (r) => r.mode);
  const modes = {};
  for (const [mode, rs] of byMode) modes[mode] = S.summary(rs.map((r) => r.total_ms));
  const p = byMode.get('P') || [];
  const pMinusB0 = p.map((r) => r.total_ms - r.b0_ms);
  const s = byMode.get('S') || [];
  const sThreeReads = s.filter((r) => Array.isArray(r.reads_ms)).map((r) => r.total_ms - r.reads_ms[0]);
  const key = (r) => `${r.block}:${r.iteration}`;
  const pairs = (a, b) => {
    const mb = new Map((byMode.get(b) || []).map((r) => [key(r), r]));
    const left = [];
    const right = [];
    for (const r of byMode.get(a) || []) {
      if (mb.has(key(r))) {
        left.push(r.total_ms);
        right.push(mb.get(key(r)).total_ms);
      }
    }
    return left.length ? S.pairedRatio(left, right) : null;
  };
  const perBlock = {};
  for (const [blk, rs] of groupBy(timed, (r) => r.block)) {
    perBlock[blk] = Object.fromEntries([...groupBy(rs, (r) => r.mode)].map(([m, x]) => [m, S.median(x.map((r) => r.total_ms))]));
  }
  const cold = rows.filter((r) => r.kind === 'sepolia' && r.coldStart).map((r) => r.cold_ms).filter((v) => v !== undefined);
  const cache = rows.filter((r) => r.kind === 'cache_check');
  const out = {
    log: 'measure-sepolia.js (Sepolia; P = full pipeline, S = four reads in sequence, C = concurrent, Bt = one batch)',
    invalid: timed.filter((r) => r.mode === 'P' && !r.valid).length,
    modes,
    P_minus_B0: pMinusB0.length ? S.summary(pMinusB0) : null,
    S_threeReads_derived: sThreeReads.length ? S.summary(sThreeReads) : null,
    speedup_S_over_C: pairs('S', 'C'),
    speedup_S_over_Bt: pairs('S', 'Bt'),
    perBlockMedian: perBlock,
    coldStart: cold.length ? S.summary(cold) : null,
    cacheCheck: cache.length ? S.summary(cache.map((r) => r.fresh_ms)) : null,
  };
  const lines = [out.log, `P rows not valid: ${out.invalid}`];
  for (const [m, v] of Object.entries(modes)) {
    lines.push(`${m}: n = ${v.n}, median ${r1(v.median)} ms [${r1(v.medianCI.lower)}, ${r1(v.medianCI.upper)}], ` +
      `Q1 ${r1(v.q1)}, Q3 ${r1(v.q3)}, p95 ${r1(v.p95)}, max ${r1(v.max)}`);
  }
  if (out.P_minus_B0) lines.push(`P without B0: median ${r1(out.P_minus_B0.median)} ms`);
  if (out.S_threeReads_derived) lines.push(`S without its V2 read (derived three-read figure): median ${r1(out.S_threeReads_derived.median)} ms`);
  for (const [name, v] of [['S/C', out.speedup_S_over_C], ['S/Bt', out.speedup_S_over_Bt]]) {
    if (v) {
      lines.push(`${name} paired speed-up: median ${r2(v.medianOfRatios)} [${r2(v.bootstrap.lower)}, ${r2(v.bootstrap.upper)}] ` +
        `(seed ${v.bootstrap.seed}), range ${r2(v.min)}-${r2(v.max)}, ratio of medians ${r2(v.ratioOfMedians)}`);
    }
  }
  return { out, lines };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const outIndex = args.indexOf('--out');
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

main();
