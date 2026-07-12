import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { kmeans } from "../js/kmeans.js";

const RUNS = 200;

const channel = fc.integer({ min: 0, max: 255 });
const point3 = fc.tuple(channel, channel, channel).map((t) => [...t]);

// General case: a non-empty set of distinct-ish points with K in 1..n.
const pointsAndK = fc
  .array(point3, { minLength: 1, maxLength: 40 })
  .chain((points) =>
    fc.integer({ min: 1, max: points.length }).map((k) => ({ points, k }))
  );

const degeneratePointsAndK = fc
  .array(point3, { minLength: 1, maxLength: 5 })
  .chain((pool) =>
    fc
      .array(fc.nat({ max: 4 }), { minLength: 1, maxLength: 40 })
      .chain((idxs) => {
        const points = idxs.map((i) => pool[i % pool.length].slice());
        return fc
          .integer({ min: 1, max: points.length })
          .map((k) => ({ points, k }));
      })
  );

const anyPointsAndK = fc.oneof(pointsAndK, degeneratePointsAndK);

describe("kmeans — Property 1: structural validity (Requirements 1.1, 1.4)", () => {
  it("returns well-formed labels, centroids, counts with finite coordinates", () => {
    fc.assert(
      fc.property(anyPointsAndK, fc.integer({ min: 0, max: 2 ** 31 - 1 }), ({ points, k }, seed) => {
        const res = kmeans(points, k, { seed });

        expect(res.labels).toHaveLength(points.length);
        expect(res.centroids).toHaveLength(k);
        expect(res.counts).toHaveLength(k);

        for (const label of res.labels) {
          expect(Number.isInteger(label)).toBe(true);
          expect(label).toBeGreaterThanOrEqual(0);
          expect(label).toBeLessThan(k);
        }

        for (const centroid of res.centroids) {
          expect(centroid).toHaveLength(3);
          for (const coord of centroid) {
            expect(Number.isFinite(coord)).toBe(true);
          }
        }
      }),
      { numRuns: RUNS }
    );
  });
});

describe("kmeans — Property 2: counts partition the input (Requirement 1.5)", () => {
  it("returns per-cluster counts whose sum equals the input length", () => {
    fc.assert(
      fc.property(anyPointsAndK, fc.integer({ min: 0, max: 2 ** 31 - 1 }), ({ points, k }, seed) => {
        const res = kmeans(points, k, { seed });
        const total = res.counts.reduce((a, b) => a + b, 0);
        expect(total).toBe(points.length);
      }),
      { numRuns: RUNS }
    );
  });
});

describe("kmeans — Property 3: determinism under a fixed seed (Requirement 1.3)", () => {
  it("produces identical results for two runs with the same seed", () => {
    fc.assert(
      fc.property(anyPointsAndK, fc.integer({ min: 0, max: 2 ** 31 - 1 }), ({ points, k }, seed) => {
        const r1 = kmeans(points, k, { seed });
        const r2 = kmeans(points, k, { seed });
        expect(r1.labels).toEqual(r2.labels);
        expect(r1.centroids).toEqual(r2.centroids);
        expect(r1.counts).toEqual(r2.counts);
        expect(r1.iterations).toBe(r2.iterations);
      }),
      { numRuns: RUNS }
    );
  });
});

describe("kmeans — Property 4: k=1 yields the global mean (Requirement 1.6)", () => {
  const coord = fc.double({ min: -1000, max: 1000, noNaN: true });
  const floatPoint = fc.tuple(coord, coord, coord).map((t) => [...t]);

  it("returns the coordinate-wise mean as the sole centroid", () => {
    fc.assert(
      fc.property(
        fc.array(floatPoint, { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (points, seed) => {
          const res = kmeans(points, 1, { seed });
          expect(res.centroids).toHaveLength(1);

          const dim = points[0].length;
          const mean = new Array(dim).fill(0);
          for (const p of points) for (let d = 0; d < dim; d++) mean[d] += p[d];
          for (let d = 0; d < dim; d++) mean[d] /= points.length;

          for (let d = 0; d < dim; d++) {
            expect(Math.abs(res.centroids[0][d] - mean[d])).toBeLessThan(1e-6);
          }
          // The lone cluster must own every point.
          expect(res.counts).toEqual([points.length]);
          expect(res.labels.every((l) => l === 0)).toBe(true);
        }
      ),
      { numRuns: RUNS }
    );
  });
});

describe("kmeans — Unit tests: separable clusters and degenerate inputs (Requirements 1.1, 1.4)", () => {
  it("groups three well-separated synthetic clusters correctly", () => {
    const blobA = [];
    const blobB = [];
    const blobC = [];
    for (let i = 0; i < 10; i++) {
      blobA.push([10 + i * 0.1, 10 + i * 0.05, 10]);
      blobB.push([200, 200 - i * 0.1, 200 + i * 0.02]);
      blobC.push([100, 10 + i * 0.03, 200 - i * 0.1]);
    }
    const points = [...blobA, ...blobB, ...blobC];

    const res = kmeans(points, 3, { seed: 7 });

    const la = res.labels.slice(0, 10);
    const lb = res.labels.slice(10, 20);
    const lc = res.labels.slice(20, 30);
    expect(new Set(la).size).toBe(1);
    expect(new Set(lb).size).toBe(1);
    expect(new Set(lc).size).toBe(1);
    expect(new Set([la[0], lb[0], lc[0]]).size).toBe(3);
    expect([...res.counts].sort((a, b) => a - b)).toEqual([10, 10, 10]);
    expect(res.counts.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it("does not crash on all-identical points (heavy duplication)", () => {
    const points = Array.from({ length: 8 }, () => [128, 128, 128]);
    const res = kmeans(points, 3, { seed: 1 });

    expect(res.centroids).toHaveLength(3);
    for (const c of res.centroids) {
      for (const v of c) expect(Number.isFinite(v)).toBe(true);
    }
    expect(res.counts.reduce((a, b) => a + b, 0)).toBe(8);
  });

  it("guards K larger than the number of points without NaN centroids", () => {
    const points = [
      [0, 0, 0],
      [255, 255, 255],
    ];
    const res = kmeans(points, 5, { seed: 3 });

    expect(res.centroids).toHaveLength(5);
    expect(res.counts).toHaveLength(5);
    for (const c of res.centroids) {
      for (const v of c) expect(Number.isFinite(v)).toBe(true);
    }
    expect(res.counts.reduce((a, b) => a + b, 0)).toBe(2);
    for (const label of res.labels) {
      expect(label).toBeGreaterThanOrEqual(0);
      expect(label).toBeLessThan(5);
    }
  });

  it("handles a single point with k=1", () => {
    const res = kmeans([[1, 2, 3]], 1, { seed: 1 });
    expect(res.centroids).toEqual([[1, 2, 3]]);
    expect(res.counts).toEqual([1]);
    expect(res.labels).toEqual([0]);
  });

  it("does not crash on empty input", () => {
    expect(() => kmeans([], 3, { seed: 1 })).not.toThrow();
  });
});
