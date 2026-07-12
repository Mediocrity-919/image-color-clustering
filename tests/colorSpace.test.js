import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  rgb2lab,
  lab2rgb,
  rgb2oklab,
  oklab2rgb,
  rgb2oklch,
  oklch2rgb,
  COLOR_SPACES,
} from "../js/colorSpace.js";


const RUNS = 200; 

const channel = fc.integer({ min: 0, max: 255 });
const rgbColor = fc.tuple(channel, channel, channel).map((t) => [...t]);

describe("colorSpace — Property 9: conversion round-trips (Requirement 7.2)", () => {
  const TOLERANCE = 2;

  it("reproduces the original sRGB color within a small per-channel tolerance", () => {
    fc.assert(
      fc.property(rgbColor, (rgb) => {
        const roundTrip = lab2rgb(rgb2lab(rgb));
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(roundTrip[i] - rgb[i])).toBeLessThanOrEqual(TOLERANCE);
        }
      }),
      { numRuns: RUNS }
    );
  });
});

describe("colorSpace — Unit: known reference LAB values (Requirement 7.1)", () => {
  const TOL = 1;

  it("maps white [255,255,255] to L~=100 with a,b~=0", () => {
    const [L, a, b] = rgb2lab([255, 255, 255]);
    expect(Math.abs(L - 100)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(a)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(b)).toBeLessThanOrEqual(TOL);
  });

  it("maps black [0,0,0] to L~=0 with a,b~=0", () => {
    const [L, a, b] = rgb2lab([0, 0, 0]);
    expect(Math.abs(L - 0)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(a)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(b)).toBeLessThanOrEqual(TOL);
  });

  it("maps pure red [255,0,0] to its known LAB value (~53.24, 80.09, 67.20)", () => {
    const [L, a, b] = rgb2lab([255, 0, 0]);
    expect(Math.abs(L - 53.24)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(a - 80.09)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(b - 67.2)).toBeLessThanOrEqual(TOL);
  });

  it("round-trips white and red back to their original sRGB", () => {
    expect(lab2rgb(rgb2lab([255, 255, 255]))).toEqual([255, 255, 255]);
    expect(lab2rgb(rgb2lab([255, 0, 0]))).toEqual([255, 0, 0]);
  });
});

describe("colorSpace — Property: OKLab conversion round-trips (Requirement 7.2)", () => {
  const TOLERANCE = 2;

  it("reproduces the original sRGB color within a small per-channel tolerance", () => {
    fc.assert(
      fc.property(rgbColor, (rgb) => {
        const roundTrip = oklab2rgb(rgb2oklab(rgb));
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(roundTrip[i] - rgb[i])).toBeLessThanOrEqual(TOLERANCE);
        }
      }),
      { numRuns: RUNS }
    );
  });
});

describe("colorSpace — Property: OKLCH conversion round-trips (Requirement 7.2)", () => {
  const TOLERANCE = 2;

  it("reproduces the original sRGB color within a small per-channel tolerance", () => {
    fc.assert(
      fc.property(rgbColor, (rgb) => {
        const roundTrip = oklch2rgb(rgb2oklch(rgb));
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(roundTrip[i] - rgb[i])).toBeLessThanOrEqual(TOLERANCE);
        }
      }),
      { numRuns: RUNS }
    );
  });
});

describe("colorSpace — Property: OKLCH hue-ring-safe embedding round-trips (Requirement 7.2)", () => {
  const TOLERANCE = 2;

  it("toPoint -> fromPoint reproduces the original sRGB within tolerance", () => {
    fc.assert(
      fc.property(rgbColor, (rgb) => {
        const embedded = COLOR_SPACES.OKLCH.toPoint(rgb);
        const roundTrip = COLOR_SPACES.OKLCH.fromPoint(embedded);
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(roundTrip[i] - rgb[i])).toBeLessThanOrEqual(TOLERANCE);
        }
      }),
      { numRuns: RUNS }
    );
  });
});

describe("colorSpace — Unit: known reference OKLab values (Requirement 7.1)", () => {
  const TOL = 0.01;

  it("maps white [255,255,255] to L~=1.0 with a,b~=0", () => {
    const [L, a, b] = rgb2oklab([255, 255, 255]);
    expect(Math.abs(L - 1)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(a)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(b)).toBeLessThanOrEqual(TOL);
  });

  it("maps black [0,0,0] to L~=0 with a,b~=0", () => {
    const [L, a, b] = rgb2oklab([0, 0, 0]);
    expect(Math.abs(L)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(a)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(b)).toBeLessThanOrEqual(TOL);
  });

  it("gives near-zero chroma for a neutral gray in OKLCH", () => {
    const [, C] = rgb2oklch([128, 128, 128]);
    expect(C).toBeLessThanOrEqual(0.01);
  });

  it("round-trips white and black back to their original sRGB (OKLab & OKLCH)", () => {
    expect(oklab2rgb(rgb2oklab([255, 255, 255]))).toEqual([255, 255, 255]);
    expect(oklab2rgb(rgb2oklab([0, 0, 0]))).toEqual([0, 0, 0]);
    expect(oklch2rgb(rgb2oklch([255, 255, 255]))).toEqual([255, 255, 255]);
    expect(oklch2rgb(rgb2oklch([0, 0, 0]))).toEqual([0, 0, 0]);
  });
});
