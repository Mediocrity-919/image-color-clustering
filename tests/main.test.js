import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { clampK, buildGallerySources } from "../js/main.js";


const RUNS = 200; 

const rawNumber = fc.oneof(
  fc.double({ min: -1e6, max: 1e6 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.constantFrom(NaN, Infinity, -Infinity, 0, -0, 0.5, 1.5)
);

const positiveMaxK = fc.integer({ min: 1, max: 4096 });

describe("clampK — example cases (Requirement 4.2)", () => {
  it("clamps below the lower bound up to 1", () => {
    expect(clampK(0, 12)).toBe(1);
    expect(clampK(-5, 12)).toBe(1);
  });

  it("clamps above the upper bound down to maxK", () => {
    expect(clampK(99, 12)).toBe(12);
    expect(clampK(13, 12)).toBe(12);
  });

  it("rounds fractional values to the nearest integer (Math.round)", () => {
    expect(clampK(3.7, 12)).toBe(4);
    expect(clampK(3.4, 12)).toBe(3);
    expect(clampK(2.5, 12)).toBe(3); 
  });

  it("falls back to 1 for non-finite input", () => {
    expect(clampK(NaN, 12)).toBe(1);
    expect(clampK(Infinity, 12)).toBe(1);
    expect(clampK(-Infinity, 12)).toBe(1);
  });

  it("passes valid in-range integers through unchanged", () => {
    expect(clampK(1, 12)).toBe(1);
    expect(clampK(5, 12)).toBe(5);
    expect(clampK(12, 12)).toBe(12);
  });
});

describe("clampK — Property 8: K selection is clamped to a valid integer (Requirement 4.2)", () => {
  it("returns an integer in [1, maxK] for any raw number and positive maxK", () => {
    fc.assert(
      fc.property(rawNumber, positiveMaxK, (raw, maxK) => {
        const k = clampK(raw, maxK);
        expect(Number.isInteger(k)).toBe(true);
        expect(k).toBeGreaterThanOrEqual(1);
        expect(k).toBeLessThanOrEqual(maxK);
      }),
      { numRuns: RUNS }
    );
  });
});

describe("buildGallerySources — gallery sources (Requirement 5.1)", () => {
  it("returns exactly the seven built-in sample sources images/01.jpg..images/07.jpg", () => {
    expect(buildGallerySources()).toEqual([
      "images/01.jpg",
      "images/02.jpg",
      "images/03.jpg",
      "images/04.jpg",
      "images/05.jpg",
      "images/06.jpg",
      "images/07.jpg",
    ]);
  });

  it("produces exactly 7 sources by default", () => {
    expect(buildGallerySources()).toHaveLength(7);
  });

  it("zero-pads each index to two digits with the images/ prefix and .jpg extension", () => {
    for (const src of buildGallerySources()) {
      expect(src).toMatch(/^images\/0[1-7]\.jpg$/);
    }
  });
});
