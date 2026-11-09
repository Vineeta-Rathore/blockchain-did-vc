// Statistics used for every latency figure. Each definition lives here once.
//   median          conventional: the middle value, or the mean of the two middle values when n is even
//   q1, q3          Hyndman and Fan type 7 (numpy's default "linear" method)
//   p95             nearest rank: the ceil(0.95 n)-th smallest value (numpy method="inverted_cdf")
//   medianCI        distribution-free interval for the median from order statistics (exact binomial)
//   bootstrap       percentile bootstrap with a seeded generator (used only for paired speed-ups)
//   cluster         percentile bootstrap over clusters (processes or blocks): whole clusters are resampled, because
//                   samples within one process or one block are not independent of each other
// The "July-style" functions reproduce the definitions behind the July 2026 figures as first reported, for comparison only.

function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values) {
  const x = sorted(values);
  const n = x.length;
  return n % 2 ? x[(n - 1) / 2] : (x[n / 2 - 1] + x[n / 2]) / 2;
}

// Hyndman and Fan type 7: h = (n - 1) p, linear interpolation between x[floor(h)] and x[floor(h) + 1].
function quantileType7(values, p) {
  const x = sorted(values);
  const h = (x.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, x.length - 1);
  return x[lo] + (h - lo) * (x[hi] - x[lo]);
}

// Nearest rank: the smallest value x with at least a fraction p of the data at or below it.
function nearestRank(values, p) {
  const x = sorted(values);
  const rank = Math.max(1, Math.ceil(p * x.length - 1e-9));
  return x[rank - 1];
}

function binomialCdf(k, n) {
  // P(B <= k) for B ~ Binomial(n, 1/2), exact enough for n up to a few thousand
  let logC = 0; // log C(n, 0)
  let total = 0;
  const logHalfN = n * Math.log(0.5);
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    total += Math.exp(logC + logHalfN);
  }
  return Math.min(1, total);
}

// Order-statistic interval for the median: ranks l and u = n - l + 1, with l the largest rank such that
// P(B <= l - 1) <= alpha / 2. Coverage = 1 - 2 P(B <= l - 1).
function medianCI(values, alpha = 0.05) {
  const x = sorted(values);
  const n = x.length;
  let l = 0;
  for (let k = 1; k <= Math.floor((n + 1) / 2); k++) {
    if (binomialCdf(k - 1, n) <= alpha / 2) l = k;
  }
  if (l === 0) return { lower: null, upper: null, ranks: null, coverage: null };
  const u = n - l + 1;
  return { lower: x[l - 1], upper: x[u - 1], ranks: [l, u], coverage: 1 - 2 * binomialCdf(l - 1, n) };
}

// mulberry32: small seeded generator, so that every bootstrap can be re-run exactly.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapCI(values, statistic, { resamples = 10000, seed = 20261111, alpha = 0.05 } = {}) {
  const next = rng(seed);
  const n = values.length;
  const stats = new Array(resamples);
  const sample = new Array(n);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) sample[i] = values[Math.floor(next() * n)];
    stats[b] = statistic(sample);
  }
  return {
    lower: quantileType7(stats, alpha / 2),
    upper: quantileType7(stats, 1 - alpha / 2),
    resamples,
    seed,
  };
}

// Resamples whole clusters with replacement and computes the statistic of the pooled values of each resample.
function clusterBootstrapCI(clusters, statistic, { resamples = 10000, seed = 20261111, alpha = 0.05 } = {}) {
  if (!clusters.length || clusters.some((c) => !c.length)) throw new Error('clusterBootstrapCI needs non-empty clusters');
  const next = rng(seed);
  const k = clusters.length;
  const stats = new Array(resamples);
  for (let b = 0; b < resamples; b++) {
    const pooled = [];
    for (let i = 0; i < k; i++) pooled.push(...clusters[Math.floor(next() * k)]);
    stats[b] = statistic(pooled);
  }
  return {
    lower: quantileType7(stats, alpha / 2),
    upper: quantileType7(stats, 1 - alpha / 2),
    resamples,
    seed,
    clusters: k,
  };
}

function summary(values) {
  if (!values.length || values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('summary needs a non-empty list of finite numbers');
  }
  const ci = medianCI(values);
  return {
    n: values.length,
    median: median(values),
    q1: quantileType7(values, 0.25),
    q3: quantileType7(values, 0.75),
    p95: nearestRank(values, 0.95),
    mean: mean(values),
    min: Math.min(...values),
    max: Math.max(...values),
    medianCI: ci,
  };
}

// Paired speed-up: per-iteration ratios a_i / b_i, their median and range, a seeded bootstrap interval for that
// median, and the ratio of the two medians.
function pairedRatio(a, b, options) {
  if (a.length !== b.length) throw new Error('paired samples differ in length');
  const ratios = a.map((v, i) => v / b[i]);
  return {
    n: ratios.length,
    medianOfRatios: median(ratios),
    min: Math.min(...ratios),
    max: Math.max(...ratios),
    bootstrap: bootstrapCI(ratios, median, options),
    ratioOfMedians: median(a) / median(b),
  };
}

// "July-style" definitions, used only to show how the July 2026 figures as first reported arose.
const julyStyle = {
  upperMedian: (values) => sorted(values)[Math.floor(values.length / 2)],
  p95ByIndex: (values) => sorted(values)[Math.floor(values.length * 0.95)],
  bootstrapUpperMedian: (values, seed = 42) =>
    bootstrapCI(values, julyStyle.upperMedian, { resamples: 5000, seed }),
};

module.exports = {
  binomialCdf,
  bootstrapCI,
  clusterBootstrapCI,
  julyStyle,
  mean,
  median,
  medianCI,
  nearestRank,
  pairedRatio,
  quantileType7,
  rng,
  summary,
};
