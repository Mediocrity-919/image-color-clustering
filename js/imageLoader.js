/**
 * Image_Loader
 * ------------
 * Loads an image (gallery URL or uploaded File) into an offscreen thumbnail
 * canvas whose longest edge is at most `maxEdge` px, then extracts pixels.
 *
 * The pure helpers (`computeThumbnailSize`, `imageDataToPixels`) are
 * implemented in Task 2.1 and are runnable under Node for testing.
 * `loadImagePixels` (Task 2.2) is browser-side, side-effecting code: it needs
 * a real DOM/`<canvas>` and is therefore exercised in the browser rather than
 * under Node unit tests.
 */

/**
 * Compute the downscaled dimensions preserving aspect ratio so the longest
 * edge is at most `maxEdge`. Returns integer width/height >= 1 and never
 * upscales beyond the original size.
 *
 * The applied scale is `min(1, maxEdge / longestEdge)`, so images already
 * within `maxEdge` are left at their native size. Each dimension is rounded
 * to the nearest integer and floored at 1 (so an extreme strip such as
 * 1000x1 still yields a valid 150x1 canvas).
 *
 * @param {number} width  original image width
 * @param {number} height original image height
 * @param {number} [maxEdge=150]
 * @returns {{ width: number, height: number }}
 */
export function computeThumbnailSize(width, height, maxEdge = 150) {
  // Guard against non-positive / non-finite inputs so we always return a
  // usable canvas size.
  const safeW = Number.isFinite(width) && width > 0 ? width : 1;
  const safeH = Number.isFinite(height) && height > 0 ? height : 1;
  const edge = Number.isFinite(maxEdge) && maxEdge > 0 ? maxEdge : 1;

  const longest = Math.max(safeW, safeH);
  // Only ever scale down (scale <= 1); never enlarge a small image.
  const scale = longest > edge ? edge / longest : 1;

  const outW = Math.max(1, Math.round(safeW * scale));
  const outH = Math.max(1, Math.round(safeH * scale));

  return { width: outW, height: outH };
}

/**
 * Convert an ImageData object into an array of RGB triples.
 * Alpha channel is dropped. One triple per pixel, channels in 0..255.
 *
 * Reads the RGBA-packed `Uint8ClampedArray` in `imageData.data` at stride 4
 * and emits `[r, g, b]` for each pixel.
 *
 * @param {ImageData} imageData
 * @returns {number[][]} e.g. [[r,g,b], [r,g,b], ...], channels in 0..255
 */
export function imageDataToPixels(imageData) {
  const data = imageData.data;
  const pixelCount = Math.floor(data.length / 4);
  const pixels = new Array(pixelCount);

  for (let p = 0; p < pixelCount; p++) {
    const i = p * 4;
    pixels[p] = [data[i], data[i + 1], data[i + 2]];
  }

  return pixels;
}

/**
 * Decide whether a string image URL points at a different origin than the page
 * and therefore needs `crossOrigin = "anonymous"` so the canvas stays readable.
 * Relative paths (e.g. the built-in `images/01.jpg` gallery) and same-origin
 * absolute URLs are treated as same-origin and need no CORS opt-in.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isCrossOrigin(url) {
  if (typeof location === "undefined") return false;
  try {
    const resolved = new URL(url, location.href);
    return resolved.origin !== location.origin;
  } catch {
    // Malformed / relative-only string that URL() cannot resolve -> treat as
    // same-origin (no crossOrigin needed).
    return false;
  }
}

/**
 * Side-effecting: load an image source into a thumbnail canvas and return pixels.
 *
 * Loads a gallery URL (string) or an uploaded `File` into an
 * `HTMLImageElement`, draws it onto an offscreen canvas sized by
 * `computeThumbnailSize` (longest edge <= `maxEdge`), reads the pixels via
 * `getImageData`, and converts them with `imageDataToPixels`.
 *
 * For an uploaded `File`, an object URL is created and revoked once loading
 * settles. For a cross-origin string URL, `crossOrigin = "anonymous"` is set so
 * the drawn canvas remains readable (the remote host must allow CORS).
 *
 * @param {string|File} source  gallery URL or uploaded File
 * @param {number} [maxEdge=150]
 * @returns {Promise<{ pixels: number[][], width: number, height: number, canvas: HTMLCanvasElement }>}
 */
export function loadImagePixels(source, maxEdge = 150) {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("loadImagePixels requires a browser DOM environment"));
      return;
    }
    if (!source) {
      reject(new Error("loadImagePixels: source is required"));
      return;
    }

    const isFile = typeof File !== "undefined" && source instanceof File;
    const objectUrl = isFile ? URL.createObjectURL(source) : null;
    const src = isFile ? objectUrl : String(source);

    const img = new Image();
    // Only opt into CORS for cross-origin string URLs; object URLs are
    // same-origin and File uploads never need it.
    if (!isFile && isCrossOrigin(src)) {
      img.crossOrigin = "anonymous";
    }

    const cleanup = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };

    img.onload = () => {
      try {
        const { width, height } = computeThumbnailSize(
          img.naturalWidth || img.width,
          img.naturalHeight || img.height,
          maxEdge
        );

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("loadImagePixels: could not get 2D canvas context");
        }
        ctx.drawImage(img, 0, 0, width, height);

        const imageData = ctx.getImageData(0, 0, width, height);
        const pixels = imageDataToPixels(imageData);

        cleanup();
        resolve({ pixels, width, height, canvas });
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    img.onerror = () => {
      cleanup();
      reject(new Error(`loadImagePixels: failed to load image (${isFile ? source.name : src})`));
    };

    img.src = src;
  });
}
