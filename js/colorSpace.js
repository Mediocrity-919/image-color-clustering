/**
 * Color_Space_Converter
 * ----------------------
 * Converts between sRGB (channels 0..255) and CIELAB using the D65 reference
 * white. Pipeline: sRGB -> linearize (gamma) -> XYZ -> LAB, and the inverse.
 *
 * D65 white point: Xn=95.047, Yn=100.0, Zn=108.883.
 * sRGB gamma: 0.04045 threshold with the 2.4 exponent.
 *
 * Task 9.1 implements the full round-trippable pipeline.
 */

// D65 reference white (scaled so Yn = 100, matching the XYZ scaling below).
const Xn = 95.047;
const Yn = 100.0;
const Zn = 108.883;

// CIE Lab constants (exact rationals): epsilon = 216/24389, kappa = 24389/27.
const EPSILON = 216 / 24389; // ~0.008856
const KAPPA = 24389 / 27; // ~903.3

/**
 * Linearize a single gamma-encoded sRGB channel (input/output in 0..1).
 * Uses the standard sRGB transfer function: a linear segment below the
 * 0.04045 threshold and a 2.4-exponent power curve above it.
 *
 * @param {number} c gamma-encoded channel in 0..1
 * @returns {number} linear-light channel in 0..1
 */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Apply the sRGB gamma (companding) to a linear-light channel (0..1 -> 0..1).
 * Inverse of `srgbToLinear`.
 *
 * @param {number} c linear-light channel in 0..1
 * @returns {number} gamma-encoded channel in 0..1
 */
function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Clamp a raw channel value to an integer in the range 0..255. */
function clampChannel(value) {
  const rounded = Math.round(value);
  // `<= 0` returns a literal +0 so tiny negative inputs never yield -0, which
  // would otherwise fail strict deep-equality checks (Object.is(-0, 0) === false).
  if (rounded <= 0) return 0;
  if (rounded > 255) return 255;
  return rounded;
}

/**
 * Convert an sRGB color to CIELAB (D65).
 *
 * sRGB(0..255) -> linear -> XYZ (D65) -> LAB.
 *
 * @param {[number,number,number]} rgb sRGB, each channel 0..255
 * @returns {[number,number,number]} LAB: L in ~0..100, a/b roughly -128..127
 */
export function rgb2lab(rgb) {
  // 1. Normalize to 0..1 and linearize.
  const r = srgbToLinear(rgb[0] / 255);
  const g = srgbToLinear(rgb[1] / 255);
  const b = srgbToLinear(rgb[2] / 255);

  // 2. Linear sRGB -> XYZ using the sRGB/D65 matrix, scaled to Yn = 100.
  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) * 100;
  const Y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) * 100;
  const Z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) * 100;

  // 3. XYZ -> LAB, normalized against the D65 white point.
  const fx = pivotXyz(X / Xn);
  const fy = pivotXyz(Y / Yn);
  const fz = pivotXyz(Z / Zn);

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);

  return [L, a, bb];
}

/**
 * Nonlinear XYZ pivot used by the forward LAB conversion:
 * t^(1/3) above the epsilon threshold, otherwise the linear approximation.
 *
 * @param {number} t normalized XYZ component (X/Xn, Y/Yn, or Z/Zn)
 * @returns {number}
 */
function pivotXyz(t) {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/**
 * Convert a CIELAB color back to sRGB (D65), clamped/rounded to 0..255.
 *
 * LAB -> XYZ (D65) -> linear -> sRGB(0..255).
 *
 * @param {[number,number,number]} lab
 * @returns {[number,number,number]} sRGB clamped to 0..255 (integers)
 */
export function lab2rgb(lab) {
  const [L, a, b] = lab;

  // 1. LAB -> XYZ (normalized), inverse of the forward pivot.
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;

  const fx3 = fx * fx * fx;
  const fz3 = fz * fz * fz;

  const xr = fx3 > EPSILON ? fx3 : (116 * fx - 16) / KAPPA;
  // Use the L-based branch for Y (equivalent to fy^3 above the threshold).
  const yr = L > KAPPA * EPSILON ? fy * fy * fy : L / KAPPA;
  const zr = fz3 > EPSILON ? fz3 : (116 * fz - 16) / KAPPA;

  // 2. Denormalize against the white point and scale XYZ back to 0..1.
  const X = (xr * Xn) / 100;
  const Y = (yr * Yn) / 100;
  const Z = (zr * Zn) / 100;

  // 3. XYZ -> linear sRGB using the inverse D65 matrix.
  const r = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  const g = X * -0.969266 + Y * 1.8760108 + Z * 0.041556;
  const bl = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;

  // 4. Gamma-encode, scale to 0..255, clamp/round to integer channels.
  return [
    clampChannel(linearToSrgb(r) * 255),
    clampChannel(linearToSrgb(g) * 255),
    clampChannel(linearToSrgb(bl) * 255),
  ];
}

/**
 * OKLab / OKLCH
 * -------------
 * OKLab is Björn Ottosson's perceptual color space (2020). It shares the same
 * sRGB gamma (`srgbToLinear` / `linearToSrgb`) used above but replaces the
 * XYZ/LAB pipeline with a direct linear-sRGB -> LMS -> cube-root -> OKLab
 * transform. OKLCH is simply OKLab expressed in cylindrical coordinates
 * (L, C = chroma, H = hue), analogous to how LCh relates to LAB.
 *
 * Matrices below are the canonical constants published by Ottosson; the forward
 * and inverse matrices are exact inverses so the round trip only loses the tiny
 * amount expected from sRGB companding + the 0..255 integer clamp.
 */

/**
 * Convert an sRGB color to OKLab.
 *
 * sRGB(0..255) -> linear -> LMS -> cube root -> OKLab.
 *
 * @param {[number,number,number]} rgb sRGB, each channel 0..255
 * @returns {[number,number,number]} OKLab: L in ~0..1, a/b small (~-0.4..0.4)
 */
export function rgb2oklab(rgb) {
  // 1. Normalize to 0..1 and linearize (reuse the sRGB transfer function).
  const r = srgbToLinear(rgb[0] / 255);
  const g = srgbToLinear(rgb[1] / 255);
  const b = srgbToLinear(rgb[2] / 255);

  // 2. Linear sRGB -> LMS (cone response) via Ottosson's M1 matrix.
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  // 3. Nonlinear compression: cube root of each LMS component.
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  // 4. LMS' -> OKLab via Ottosson's M2 matrix.
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  return [L, a, bb];
}

/**
 * Convert an OKLab color back to sRGB, clamped/rounded to 0..255.
 *
 * OKLab -> LMS' -> cube -> linear sRGB -> sRGB(0..255).
 *
 * @param {[number,number,number]} oklab
 * @returns {[number,number,number]} sRGB clamped to 0..255 (integers)
 */
export function oklab2rgb(oklab) {
  const [L, a, b] = oklab;

  // 1. OKLab -> LMS' via the inverse of M2.
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  // 2. Undo the cube root.
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  // 3. LMS -> linear sRGB via the inverse of M1.
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  // 4. Gamma-encode, scale to 0..255, clamp/round to integer channels.
  return [
    clampChannel(linearToSrgb(r) * 255),
    clampChannel(linearToSrgb(g) * 255),
    clampChannel(linearToSrgb(bl) * 255),
  ];
}

/**
 * Convert an sRGB color to OKLCH — the cylindrical form of OKLab.
 * L is unchanged, C = hypot(a, b), H = atan2(b, a) normalized to [0, 2π).
 *
 * @param {[number,number,number]} rgb sRGB, each channel 0..255
 * @returns {[number,number,number]} OKLCH: [L, C, H] with H in radians [0, 2π)
 */
export function rgb2oklch(rgb) {
  const [L, a, b] = rgb2oklab(rgb);
  const C = Math.hypot(a, b);
  let H = Math.atan2(b, a); // radians in (-π, π]
  if (H < 0) H += 2 * Math.PI; // normalize to [0, 2π)
  return [L, C, H];
}

/**
 * Convert an OKLCH color back to sRGB, clamped/rounded to 0..255.
 * Rebuilds the OKLab a/b from (C, H) then delegates to `oklab2rgb`.
 *
 * @param {[number,number,number]} oklch [L, C, H] (H in radians)
 * @returns {[number,number,number]} sRGB clamped to 0..255 (integers)
 */
export function oklch2rgb(oklch) {
  const [L, C, H] = oklch;
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  return oklab2rgb([L, a, b]);
}

/**
 * Color-space registry (Task: OKLab/OKLCH extension)
 * --------------------------------------------------
 * A single source of truth mapping a space name to a pair of pure functions,
 * so callers (main.js, chart.js) never branch on the space name themselves:
 *
 *   toPoint(rgb)      -> number[3]   coordinates a pixel is clustered in
 *   fromPoint(coords) -> [r,g,b]     centroid coordinates back to display RGB
 *                                    (always clamped/rounded to 0..255 ints)
 *
 * RGB is the identity space (fromPoint still clamps/rounds). LAB and OKLAB use
 * their direct Cartesian coordinates (L,a,b), which are already safe for
 * Euclidean k-means.
 *
 * OKLCH — hue-ring safety + lightness de-weighting:
 *   Hue H is angular: 0 and 2π denote the same hue, so clustering on raw
 *   [L, C, H] with Euclidean distance would tear a hue apart across the 0/2π
 *   seam (e.g. two reds at H≈0.01 and H≈6.27 look far apart numerically). To
 *   avoid that we cluster in a "hue-ring-safe" Cartesian embedding whose a/b
 *   axes are C·cos(H) and C·sin(H).
 *
 *   If we used [L, C·cos(H), C·sin(H)] the embedding would be numerically
 *   IDENTICAL to OKLab's (L, a, b) — so OKLab and OKLCH would always produce
 *   the exact same clusters (redundant). To make OKLCH genuinely distinct and
 *   useful, we DOWN-WEIGHT lightness by `OKLCH_L_WEIGHT` (< 1):
 *       toPoint -> [OKLCH_L_WEIGHT · L, C·cos(H), C·sin(H)]
 *   This makes chroma/hue (the color family) drive the grouping more than
 *   brightness, so OKLCH tends to merge light/dark shades of the same hue that
 *   OKLab would split. Chroma-weighted hue also keeps achromatic grays from
 *   scattering on hue noise. fromPoint inverts it: L = coord0 / OKLCH_L_WEIGHT,
 *   C = hypot(x,y), H = atan2(y,x), then OKLCH -> OKLab -> RGB.
 */
/**
 * Lightness weight for the OKLCH clustering embedding. A value < 1 de-weights
 * lightness so OKLCH groups more by hue/chroma (color family) than by
 * brightness, making its clusters genuinely different from OKLab's (which would
 * be identical at weight 1). Must be > 0 so the embedding stays invertible.
 */
const OKLCH_L_WEIGHT = 0.5;

export const COLOR_SPACES = {
  RGB: {
    // Identity: pixels are already RGB. fromPoint still clamps/rounds so a
    // centroid (a float average of pixels) becomes a valid 0..255 integer RGB.
    toPoint: (rgb) => [rgb[0], rgb[1], rgb[2]],
    fromPoint: (coords) => [
      clampChannel(coords[0]),
      clampChannel(coords[1]),
      clampChannel(coords[2]),
    ],
  },
  LAB: {
    toPoint: (rgb) => rgb2lab(rgb),
    fromPoint: (coords) => lab2rgb(coords),
  },
  OKLAB: {
    toPoint: (rgb) => rgb2oklab(rgb),
    fromPoint: (coords) => oklab2rgb(coords),
  },
  OKLCH: {
    // Hue-ring-safe embedding with lightness de-weighted (see the block comment
    // above): cluster in Cartesian [OKLCH_L_WEIGHT·L, C·cos(H), C·sin(H)] so
    // grouping is driven more by hue/chroma than brightness — this is what makes
    // OKLCH distinct from OKLab (which is the same embedding at weight 1).
    toPoint: (rgb) => {
      const [L, C, H] = rgb2oklch(rgb);
      return [OKLCH_L_WEIGHT * L, C * Math.cos(H), C * Math.sin(H)];
    },
    // Invert the embedding: undo the lightness weight, recover chroma/hue, then
    // OKLCH -> OKLab -> RGB.
    fromPoint: (coords) => {
      const [wl, x, y] = coords;
      const L = wl / OKLCH_L_WEIGHT;
      const C = Math.hypot(x, y);
      let H = Math.atan2(y, x);
      if (H < 0) H += 2 * Math.PI;
      return oklch2rgb([L, C, H]);
    },
  },
};

/**
 * Convert a single RGB pixel into the clustering coordinates of `spaceName`.
 * Convenience wrapper over `COLOR_SPACES[spaceName].toPoint`.
 *
 * @param {[number,number,number]} rgb sRGB pixel, channels 0..255
 * @param {keyof typeof COLOR_SPACES} spaceName e.g. "RGB" | "LAB" | "OKLAB" | "OKLCH"
 * @returns {number[]} clustering coordinates for that space
 */
export function rgbToSpace(rgb, spaceName) {
  const space = COLOR_SPACES[spaceName];
  if (!space) throw new Error(`Unknown color space: ${spaceName}`);
  return space.toPoint(rgb);
}

/**
 * Convert clustering coordinates in `spaceName` back to display RGB (0..255
 * integers). Convenience wrapper over `COLOR_SPACES[spaceName].fromPoint`.
 *
 * @param {number[]} coords centroid coordinates in that space
 * @param {keyof typeof COLOR_SPACES} spaceName e.g. "RGB" | "LAB" | "OKLAB" | "OKLCH"
 * @returns {[number,number,number]} sRGB clamped to 0..255 (integers)
 */
export function spaceToRgb(coords, spaceName) {
  const space = COLOR_SPACES[spaceName];
  if (!space) throw new Error(`Unknown color space: ${spaceName}`);
  return space.fromPoint(coords);
}
