/**
 * Clustering_Engine
 * -----------------
 * Hand-written k-means operating on N-dimensional numeric points (here 3D
 * color points in the active color space). Uses k-means++ seeding, a seeded
 * PRNG for determinism, and empty-cluster re-seeding.
 *
 * The engine is dimension-agnostic: `points` is an array of equal-length
 * numeric vectors. `main.js` converts pixels to the active color space before
 * calling `kmeans`, and converts centroids back to RGB for display.
 *
 * No DOM dependency: this module is a set of pure functions and runs under Node.
 */

/**
 * @typedef {Object} KMeansOptions
 * @property {number} [maxIterations=50]
 * @property {number} [tolerance=1e-4] stop when the max centroid coordinate shift is below this
 * @property {number} [seed] fixed seed for deterministic runs
 */

/**
 * @typedef {Object} KMeansResult
 * @property {number[]} labels cluster index per input point
 * @property {number[][]} centroids K centroid coordinates in input space
 * @property {number[]} counts pixel count per cluster (length K)
 * @property {number} iterations iterations actually performed
 */

/**
 * mulberry32 — a tiny, fast, seedable 32-bit PRNG.
 * Deterministic: the same seed always yields the same sequence in [0, 1).
 *
 * @param {number} seed unsigned 32-bit integer seed
 * @returns {() => number} generator returning floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Squared Euclidean distance between two equal-length vectors. */
function sqDist(a, b) {
  let sum = 0;
  for (let d = 0; d < a.length; d++) {
    const diff = a[d] - b[d];
    sum += diff * diff;
  }
  return sum;
}

/** Coordinate-wise mean of a non-empty list of points. */
function meanOf(points, dim) {
  const mean = new Array(dim).fill(0);
  for (const p of points) {
    for (let d = 0; d < dim; d++) mean[d] += p[d];
  }
  for (let d = 0; d < dim; d++) mean[d] /= points.length;
  return mean;
}

/** Allocate a K x dim matrix of zeros. */
function zeros(K, dim) {
  const arr = new Array(K);
  for (let c = 0; c < K; c++) arr[c] = new Array(dim).fill(0);
  return arr;
}

/**
 * k-means++ initialization.
 *
 * The first center is chosen uniformly at random from the points (via the
 * seeded RNG). Each subsequent center is chosen with probability proportional
 * to the squared distance to the nearest already-chosen center. When every
 * point already coincides with a chosen center (squared distances all zero),
 * the next center is chosen uniformly at random so we never divide by zero.
 *
 * @param {number[][]} points non-empty array of equal-length vectors
 * @param {number} K number of centers to pick (K >= 1)
 * @param {() => number} rng seeded PRNG returning [0, 1)
 * @returns {number[][]} K centroid vectors (copies of chosen points)
 */
export function kmeansppInit(points, K, rng) {
  const n = points.length;
  const centroids = [];

  const first = Math.min(Math.floor(rng() * n), n - 1);
  centroids.push(points[first].slice());

  // dist2[i] = squared distance from point i to its nearest chosen center.
  const dist2 = new Array(n);
  for (let i = 0; i < n; i++) dist2[i] = sqDist(points[i], centroids[0]);

  while (centroids.length < K) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += dist2[i];

    let idx;
    if (sum > 0 && Number.isFinite(sum)) {
      // Weighted pick proportional to squared distance.
      const target = rng() * sum;
      let acc = 0;
      idx = n - 1;
      for (let i = 0; i < n; i++) {
        acc += dist2[i];
        if (acc >= target) {
          idx = i;
          break;
        }
      }
    } else {
      // All points coincide with chosen centers: fall back to uniform pick.
      idx = Math.min(Math.floor(rng() * n), n - 1);
    }

    centroids.push(points[idx].slice());

    // Refresh nearest-center squared distances with the newly added center.
    const added = centroids[centroids.length - 1];
    for (let i = 0; i < n; i++) {
      const d = sqDist(points[i], added);
      if (d < dist2[i]) dist2[i] = d;
    }
  }

  return centroids;
}

/**
 * Hand-written k-means with k-means++ init and empty-cluster re-seeding.
 *
 * Algorithm:
 *  - Seeding: k-means++ using a seeded PRNG (deterministic for a fixed seed).
 *  - Assignment: each point joins the nearest centroid by squared Euclidean distance.
 *  - Update: each centroid becomes the mean of its assigned points.
 *  - Empty-cluster re-seeding: a cluster left with no members is re-seeded to the
 *    point farthest from its currently assigned centroid (keeps centroids finite).
 *  - Convergence: stop when the maximum centroid coordinate shift is below
 *    `tolerance`, or when `maxIterations` is reached.
 *  - k=1 returns a single centroid equal to the global mean.
 *  - Degenerate inputs (k larger than the point count, heavy duplication, a
 *    single point) are guarded so centroids are never NaN.
 *
 * @param {number[][]} points array of equal-length numeric vectors
 * @param {number} k number of clusters, k >= 1
 * @param {KMeansOptions} [opts]
 * @returns {KMeansResult}
 */
export function kmeans(points, k, opts = {}) {
  const maxIterations = opts.maxIterations ?? 50;
  const tolerance = opts.tolerance ?? 1e-4;
  const seed = opts.seed === undefined ? 0x9e3779b9 : opts.seed;

  const n = points.length;
  const K = Math.max(1, Math.floor(k));

  // Empty input guard: nothing to cluster.
  if (n === 0) {
    return { labels: [], centroids: [], counts: new Array(K).fill(0), iterations: 0 };
  }

  const dim = points[0].length;

  // k=1: the single centroid is exactly the global mean of all points.
  if (K === 1) {
    return {
      labels: new Array(n).fill(0),
      centroids: [meanOf(points, dim)],
      counts: [n],
      iterations: 0,
    };
  }

  const rng = mulberry32(seed);
  let centroids = kmeansppInit(points, K, rng);
  let labels = new Array(n).fill(0);
  let counts = new Array(K).fill(0);
  let iterations = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;

    // --- Assignment: nearest centroid by squared Euclidean distance. ---
    counts = new Array(K).fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < K; c++) {
        const d = sqDist(points[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      labels[i] = best;
      counts[best]++;
    }

    // --- Update: each centroid becomes the mean of its members. ---
    const newCentroids = zeros(K, dim);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      const p = points[i];
      for (let d = 0; d < dim; d++) newCentroids[c][d] += p[d];
    }
    for (let c = 0; c < K; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < dim; d++) newCentroids[c][d] /= counts[c];
      }
    }

    // --- Empty-cluster re-seeding from the worst-fit points. ---
    const emptyClusters = [];
    for (let c = 0; c < K; c++) {
      if (counts[c] === 0) emptyClusters.push(c);
    }
    if (emptyClusters.length > 0) {
      // Rank points by squared distance to their assigned centroid (descending).
      const ranked = points.map((p, i) => ({ i, d: sqDist(p, centroids[labels[i]]) }));
      ranked.sort((a, b) => b.d - a.d || a.i - b.i);
      let ptr = 0;
      for (const c of emptyClusters) {
        const src = ranked[ptr % ranked.length].i;
        newCentroids[c] = points[src].slice();
        ptr++;
      }
    }

    // --- Convergence: max absolute coordinate shift across all centroids. ---
    let maxShift = 0;
    for (let c = 0; c < K; c++) {
      for (let d = 0; d < dim; d++) {
        const shift = Math.abs(newCentroids[c][d] - centroids[c][d]);
        if (shift > maxShift) maxShift = shift;
      }
    }

    centroids = newCentroids;
    if (maxShift < tolerance) break;
  }

  return { labels, centroids, counts, iterations };
}
