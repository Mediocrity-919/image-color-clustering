import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { computeThumbnailSize, imageDataToPixels } from "../js/imageLoader.js";


const RUNS = 200; 

function isPositiveInt(n) {
  return Number.isInteger(n) && n >= 1;
}

describe("computeThumbnailSize — example cases (Requirement 9.1)", () => {
  it("scales a 200x100 landscape image to 150x75", () => {
    expect(computeThumbnailSize(200, 100)).toEqual({ width: 150, height: 75 });
  });

  it("scales a square 300x300 image to 150x150", () => {
    expect(computeThumbnailSize(300, 300)).toEqual({ width: 150, height: 150 });
  });

  it("scales a 100x200 portrait image to 75x150", () => {
    expect(computeThumbnailSize(100, 200)).toEqual({ width: 75, height: 150 });
  });

  it("does not upscale an image already within maxEdge", () => {
    expect(computeThumbnailSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(computeThumbnailSize(150, 150)).toEqual({ width: 150, height: 150 });
  });

  it("keeps an extreme long strip valid with height floored at 1", () => {
    expect(computeThumbnailSize(1000, 1)).toEqual({ width: 150, height: 1 });
    expect(computeThumbnailSize(1, 1000)).toEqual({ width: 1, height: 150 });
  });

  it("honours a custom maxEdge", () => {
    expect(computeThumbnailSize(400, 200, 100)).toEqual({ width: 100, height: 50 });
  });
});

describe("computeThumbnailSize — Property 10 (Requirement 9.1)", () => {

  it("returns integer dims >= 1, caps the longest edge, never upscales, and preserves aspect ratio within rounding", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 400 }),
        (width, height, maxEdge) => {
          const { width: w, height: h } = computeThumbnailSize(width, height, maxEdge);

          expect(isPositiveInt(w)).toBe(true);
          expect(isPositiveInt(h)).toBe(true);

          expect(Math.max(w, h)).toBeLessThanOrEqual(maxEdge);
          expect(w).toBeLessThanOrEqual(width);
          expect(h).toBeLessThanOrEqual(height);

          const cross = Math.abs(w * height - h * width);
          expect(cross).toBeLessThanOrEqual(width + height);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("uses the default maxEdge of 150 when omitted", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        (width, height) => {
          const { width: w, height: h } = computeThumbnailSize(width, height);
          expect(isPositiveInt(w)).toBe(true);
          expect(isPositiveInt(h)).toBe(true);
          expect(Math.max(w, h)).toBeLessThanOrEqual(150);
        }
      ),
      { numRuns: RUNS }
    );
  });
});

function makeImageData(width, height, bytes) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(bytes.subarray(0, data.length));
  return { width, height, data };
}

describe("imageDataToPixels — example cases (Requirement 9.2)", () => {
  it("emits one [r,g,b] triple per pixel and drops alpha", () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]);
    const pixels = imageDataToPixels({ width: 2, height: 1, data });
    expect(pixels).toEqual([
      [255, 0, 0],
      [0, 255, 0],
    ]);
  });
});

describe("imageDataToPixels — Property 11 (Requirement 9.2)", () => {
  it("returns exactly W*H triples with each channel an integer in 0..255", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 0, max: 255 }),
        (width, height, fill) => {
          const raw = new Uint8ClampedArray(width * height * 4);
          for (let i = 0; i < raw.length; i++) {
            raw[i] = (fill + i * 37) % 256;
          }
          const imageData = makeImageData(width, height, raw);

          const pixels = imageDataToPixels(imageData);

          expect(pixels.length).toBe(width * height);
          for (const px of pixels) {
            expect(px).toHaveLength(3);
            for (const ch of px) {
              expect(Number.isInteger(ch)).toBe(true);
              expect(ch).toBeGreaterThanOrEqual(0);
              expect(ch).toBeLessThanOrEqual(255);
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  });
});
