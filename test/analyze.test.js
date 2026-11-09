// The latency analysis must count only measurements that succeeded: a failed or pilot row must never enter a median,
// a percentile, a pairing or a minimum.
const { expect } = require('chai');
const S = require('../scripts/lib/stats');
const { analyzeSepolia, analyzeLocal } = require('../scripts/analyze-latency');

const OK_REQUESTS = { eth_blockNumber: 1, eth_call: 4 };

function sepoliaLog() {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push({ kind: 'sepolia', block: 1, iteration: i, warmup: false, pilot: false, mode: 'P', total_ms: 800 + i,
      b0_ms: 100, valid: true, reason: 'VALID', requests: OK_REQUESTS, chainIdDuringTimer: 0 });
    rows.push({ kind: 'sepolia', block: 1, iteration: i, warmup: false, pilot: false, mode: 'S', total_ms: 600 + i,
      reads_ms: [150, 150, 150, 150 + i], sane: true, requests: OK_REQUESTS, chainIdDuringTimer: 0 });
    rows.push({ kind: 'sepolia', block: 1, iteration: i, warmup: false, pilot: false, mode: 'C', total_ms: 200 + i,
      sane: true, requests: OK_REQUESTS, chainIdDuringTimer: 0 });
    rows.push({ kind: 'sepolia', block: 1, iteration: i, warmup: false, pilot: false, mode: 'Bt', total_ms: 180 + i,
      sane: true, requests: { eth_blockNumber: 1, batch: 1 }, chainIdDuringTimer: 0 });
  }
  // failures: an S timeout, a P that failed at B0, and a pilot row
  rows.push({ kind: 'sepolia', block: 1, iteration: 11, warmup: false, pilot: false, mode: 'S', total_ms: null,
    error: 'TIMEOUT', requests: { eth_blockNumber: 1, eth_call: 1 } });
  rows.push({ kind: 'sepolia', block: 1, iteration: 11, warmup: false, pilot: false, mode: 'P', total_ms: 30010,
    b0_ms: undefined, valid: false, reason: 'VERIFICATION_ERROR', error: 'TIMEOUT', requests: { eth_blockNumber: 1 } });
  rows.push({ kind: 'sepolia', block: 0, iteration: 1, warmup: false, pilot: true, mode: 'C', total_ms: 5,
    sane: true, requests: OK_REQUESTS, chainIdDuringTimer: 0 });
  return rows;
}

describe('latency analysis: only successful measurements are counted', function () {
  it('excludes failed and pilot rows from every Sepolia statistic and reports them', function () {
    const { out } = analyzeSepolia(sepoliaLog());
    expect(out.modes.S.n).to.equal(10);
    expect(out.modes.S.min).to.equal(601);
    expect(out.modes.P.n).to.equal(10);
    expect(out.modes.P.p95).to.be.below(1000);
    expect(out.modes.C.min).to.equal(201);
    expect(out.P_minus_B0.n).to.equal(10);
    expect(out.P_minus_B0.min).to.be.a('number');
    expect(out.speedup_S_over_C.n).to.equal(10);
    expect(out.speedup_S_over_C.min).to.be.above(2);
    expect(out.excluded.S).to.deep.equal({ n: 1, codes: { TIMEOUT: 1 } });
    expect(out.excluded.P).to.deep.equal({ n: 1, codes: { TIMEOUT: 1 } });
    expect(out.pilotRowsIgnored).to.equal(1);
    expect(out.requestAnomalies).to.deep.equal({});
  });

  it('flags successful rows with unexpected request counts or a chain-ID request', function () {
    const rows = sepoliaLog();
    rows[1] = { ...rows[1], requests: { eth_blockNumber: 1, eth_call: 5 } };
    rows[2] = { ...rows[2], chainIdDuringTimer: 1 };
    const { out } = analyzeSepolia(rows);
    expect(out.requestAnomalies).to.deep.equal({ S: 1, C: 1 });
  });

  it('excludes local rows that are not valid', function () {
    const rows = [
      { kind: 'local', process: 1, warmup: false, valid: true, total_ms: 3, steps: { V1: 0.1 } },
      { kind: 'local', process: 1, warmup: false, valid: true, total_ms: 4, steps: { V1: 0.1 } },
      { kind: 'local', process: 1, warmup: false, valid: false, total_ms: 1, steps: { V1: 0.1 } },
    ];
    const { out } = analyzeLocal(rows);
    expect(out.total.n).to.equal(2);
    expect(out.total.min).to.equal(3);
    expect(out.invalid).to.equal(1);
  });

  it('refuses to summarise values that are not finite numbers', function () {
    expect(() => S.summary([1, 2, null])).to.throw();
    expect(() => S.summary([1, NaN])).to.throw();
  });
});
