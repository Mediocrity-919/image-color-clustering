// 应用入口：绑定 DOM 事件，保存应用状态，串起 加载 -> 提取 -> 聚类 -> 渲染。

import { loadImagePixels } from "./imageLoader.js";
import { kmeans } from "./kmeans.js";
import { toClusterViews, buildOption, renderChart } from "./chart.js";
import { COLOR_SPACES } from "./colorSpace.js";
import { judgeHarmony, judgeHarmonyViaProxy } from "./aiHarmony.js";

// 共享服务模式使用的代理地址（真实 API Key 只在代理服务端）。留空表示未配置。
const PROXY_URL = "http://localhost:8787";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

const state = {
  source: null,
  pixelsRGB: [],
  // pixelsRGB 在当前颜色空间下的聚类点缓存；换图或换空间时失效重算。
  pointsCache: null,
  k: 5,
  activeSpace: "RGB",
  chartStyle: "pie",
  lastResult: null,
  // scatter3d 用的像素采样与对应聚类标签，聚类时填充，切到 3D 时直接复用。
  scatterSamples: [],
  scatterLabels: [],
  // AI 判断的运行时配置；byok 模式的 baseUrl/model/apiKey 仅存于内存。
  ai: { mode: "shared", baseUrl: "", model: "", apiKey: "" },
};

const SCATTER_SAMPLE_LIMIT = 1500;

// 固定随机种子，保证同一张图多次聚类得到一致的调色板。
const CLUSTER_SEED = 42;

let chartInstance = null;

function meanRGB(pixels) {
  if (!pixels || pixels.length === 0) return [0, 0, 0];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [pr, pg, pb] of pixels) {
    r += pr;
    g += pg;
    b += pb;
  }
  const n = pixels.length;
  return [r / n, g / n, b / n];
}

// 把原始 K 值取整并夹到 [1, maxK]；非有限输入回退为 1。
function clampK(raw, maxK) {
  const hi = Math.max(1, Math.floor(Number.isFinite(maxK) ? maxK : 1));
  if (!Number.isFinite(raw)) return 1;
  const n = Math.round(raw);
  if (n < 1) return 1;
  if (n > hi) return hi;
  return n;
}

// 生成内置样例图路径，如 images/01.jpg .. images/07.jpg。
function buildGallerySources(
  count = 7,
  { prefix = "images/", ext = ".jpg", pad = 2 } = {}
) {
  const sources = [];
  for (let i = 1; i <= count; i++) {
    sources.push(`${prefix}${String(i).padStart(pad, "0")}${ext}`);
  }
  return sources;
}

// K 的上界：控件 max 与像素数中的较小者，至少为 1。
function currentMaxK() {
  const control = document.getElementById("k-control");
  const controlMax = control ? Number(control.max) || 12 : 12;
  const pixelCount = state.pixelsRGB ? state.pixelsRGB.length : 0;
  if (pixelCount > 0) return Math.max(1, Math.min(controlMax, pixelCount));
  return controlMax;
}

function showPreview(thumbnailCanvas) {
  const previewCanvas = document.getElementById("preview-canvas");
  if (!previewCanvas) return;
  previewCanvas.width = thumbnailCanvas.width;
  previewCanvas.height = thumbnailCanvas.height;
  const ctx = previewCanvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    ctx.drawImage(thumbnailCanvas, 0, 0);
  }
  const previewImg = document.getElementById("preview-img");
  if (previewImg) previewImg.hidden = true;
}

function setSelectedThumb(selected) {
  const gallery = document.getElementById("gallery");
  if (!gallery) return;
  for (const thumb of gallery.querySelectorAll(".gallery-thumb")) {
    thumb.classList.toggle("selected", thumb === selected);
  }
}

// 把内置样例图渲染成可点击缩略图，点击后走与上传相同的处理流程。
function renderGallery() {
  const gallery = document.getElementById("gallery");
  if (!gallery) return;

  gallery.innerHTML = "";
  for (const src of buildGallerySources()) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = `样例图片 ${src}`;
    img.className = "gallery-thumb";
    img.dataset.source = src;
    img.addEventListener("click", () => {
      setSelectedThumb(img);
      handleSource(src);
    });
    gallery.appendChild(img);
  }
}

// 按等间隔对像素及其聚类标签抽样，缓存供 3D 散点复用。
function cacheScatterSamples(result) {
  const pixels = state.pixelsRGB || [];
  const labels = result.labels || [];
  const n = pixels.length;
  const stride = Math.max(1, Math.ceil(n / SCATTER_SAMPLE_LIMIT));
  const samples = [];
  const sampleLabels = [];
  for (let i = 0; i < n; i += stride) {
    samples.push(pixels[i]);
    sampleLabels.push(labels[i]);
  }
  state.scatterSamples = samples;
  state.scatterLabels = sampleLabels;
}

// 用当前图表样式重绘缓存的聚类结果，不重新跑 k-means。
function renderCurrentStyle() {
  if (!chartInstance) return;
  if (!state.lastResult) return;

  const { centroids, counts } = state.lastResult;
  const views = toClusterViews(centroids, counts, state.activeSpace);
  const extra =
    state.chartStyle === "scatter3d"
      ? { samples: state.scatterSamples, labels: state.scatterLabels }
      : undefined;
  const option = buildOption(views, state.chartStyle, extra);
  renderChart(chartInstance, option);
}

// 用颜色空间注册表把 RGB 像素批量转成该空间的聚类坐标（未知名回退 RGB）。
function pixelsToPoints(pixelsRGB, spaceName) {
  const space = COLOR_SPACES[spaceName] || COLOR_SPACES.RGB;
  return pixelsRGB.map((rgb) => space.toPoint(rgb));
}

/**
 * Cluster the currently loaded pixels in the active color space and render the
 * palette chart.
 *
 * Pipeline: pick the point set for `state.activeSpace` -> `kmeans`
 * (K = `state.k`, fixed seed) -> cache scatter sample -> `renderCurrentStyle`:
 *  - RGB: cluster `state.pixelsRGB` directly; centroids are RGB.
 *  - Any other space (LAB / OKLAB / OKLCH / ...): cluster the registry's
 *    conversion of the pixels (`COLOR_SPACES[space].toPoint`, cached on
 *    `state.pointsCache`); centroids come back in that space's coordinates and
 *    are converted to RGB for display by `toClusterViews(..., state.activeSpace)`
 *    inside `renderCurrentStyle` (Requirement 7.4).
 *
 * Because the clustering space defines the geometry k-means operates on,
 * switching space requires a fresh k-means run (not just a redraw) — the
 * `#space-select` handler calls this function rather than `renderCurrentStyle`.
 *
 * The rendered chart carries both required dimensions: each entry is colored by
 * its cluster's average color and sized by its pixel count.
 *
 * No-ops when there is no chart instance (Node/tests) or no pixels loaded.
 */
function runClusteringAndRender() {
  if (!chartInstance) return;
  if (!state.pixelsRGB || state.pixelsRGB.length === 0) return;

  // Choose the point set matching the active clustering space (Requirement
  // 7.3) via the color-space registry. RGB is the identity space and clusters
  // the raw pixels directly (no conversion/copy). Any other space converts the
  // pixels through `toPoint` and caches the result on `state.pointsCache`, so
  // repeated runs in the same space (e.g. K changes) reuse the per-pixel
  // conversion; the cache is recomputed when the space changes and invalidated
  // when the image changes.
  let points;
  if (state.activeSpace === "RGB") {
    points = state.pixelsRGB;
  } else {
    if (!state.pointsCache || state.pointsCache.space !== state.activeSpace) {
      state.pointsCache = {
        space: state.activeSpace,
        points: pixelsToPoints(state.pixelsRGB, state.activeSpace),
      };
    }
    points = state.pointsCache.points;
  }

  // A fixed seed keeps the palette reproducible across runs on the same image.
  const result = kmeans(points, state.k, { seed: CLUSTER_SEED });
  state.lastResult = result;
  // scatter3d always plots RGB pixel coordinates (simple and consistent across
  // spaces); labels are index-aligned with the pixels so they still map to the
  // clusters produced in either space.
  cacheScatterSamples(result);

  renderCurrentStyle();
}

/**
 * Load an image source through the pipeline: extract thumbnail pixels, render
 * the preview, log the whole-image mean RGB (Task 2.2 behavior), then cluster
 * and render the palette chart (Task 4.2).
 * @param {string|File} source
 */
async function handleSource(source) {
  try {
    const { pixels, width, height, canvas } = await loadImagePixels(source);
    state.source = source;
    state.pixelsRGB = pixels;
    // New image => any cached space conversion is stale; recompute lazily on
    // the next non-RGB clustering run.
    state.pointsCache = null;

    showPreview(canvas);

    const [mr, mg, mb] = meanRGB(pixels);
    // Whole-image mean is computed over the thumbnail pixels, i.e. the same
    // input the clustering consumes.
    console.log(
      `[image-color-clustering] thumbnail ${width}x${height} (${pixels.length} px) mean RGB:`,
      `rgb(${mr.toFixed(1)}, ${mg.toFixed(1)}, ${mb.toFixed(1)})`
    );

    runClusteringAndRender();
  } catch (err) {
    console.error("[image-color-clustering] failed to load image:", err);
  }
}

/**
 * Derive the current palette (hex strings) from the last clustering result.
 * Centroids are converted to display RGB via `toClusterViews`, honoring the
 * active color space (LAB centroids are converted back to RGB). Returns an
 * empty array when there is no clustering result yet.
 * @returns {string[]}
 */
function currentPaletteHex() {
  if (!state.lastResult) return [];
  const { centroids, counts } = state.lastResult;
  return toClusterViews(centroids, counts, state.activeSpace).map((v) => v.hex);
}

/**
 * Write a message into the `#ai-result` panel. `kind` toggles a status class so
 * loading / success / error can be styled differently.
 * @param {string} text
 * @param {"info"|"loading"|"success"|"error"} [kind="info"]
 */
function setAiResult(text, kind = "info") {
  const el = document.getElementById("ai-result");
  if (!el) return;
  el.textContent = text;
  el.className = `ai-result ai-result--${kind}`;
}

/**
 * Read the currently selected AI mode from the radio group. Defaults to
 * "shared" when the control is absent (e.g. under tests) or unset.
 * @returns {"shared"|"byok"}
 */
function readAiMode() {
  const checked = document.querySelector('input[name="ai-mode"]:checked');
  return checked && checked.value === "byok" ? "byok" : "shared";
}

/**
 * Show or hide the "bring your own key" config fields (Base URL / model / key)
 * and the shared-service note according to the active mode. Only the BYOK mode
 * needs those inputs; the shared-service mode routes through the proxy and
 * requires no runtime config.
 * @param {"shared"|"byok"} mode
 */
function applyAiModeUI(mode) {
  const byokFields = document.getElementById("ai-byok-fields");
  const sharedNote = document.getElementById("ai-shared-note");
  const isByok = mode === "byok";
  if (byokFields) byokFields.hidden = !isByok;
  if (sharedNote) sharedNote.hidden = isByok;
}

/**
 * Render a `{ harmonious, reason }` verdict into the result panel with a
 * consistent verdict line + reason, choosing the status styling from the
 * boolean verdict.
 * @param {{ harmonious: boolean|null, reason: string }} verdict
 */
function showVerdict({ harmonious, reason }) {
  const label =
    harmonious === true
      ? "✅ 和谐"
      : harmonious === false
      ? "❌ 不太和谐"
      : "❓ 未能明确判断";
  const reasonText = reason ? String(reason) : "（模型未给出理由）";
  setAiResult(`${label}\n理由：${reasonText}`, harmonious === false ? "error" : "success");
}

/**
 * Handle a click on the "judge harmony" button (Task 11.2, hybrid mode).
 *
 * Two modes:
 *  - "shared": route the palette through our serverless proxy
 *    (`judgeHarmonyViaProxy`) using the front-end `PROXY_URL` constant. No API
 *    key is sent from the browser — the real key lives only in the proxy. When
 *    `PROXY_URL` is empty (proxy not deployed yet) we show a friendly hint to
 *    switch to the BYOK mode.
 *  - "byok": direct OpenAI-compatible call (`judgeHarmony`) with the runtime
 *    Base URL / model / API key entered in the UI. The key lives only in memory
 *    (`state.ai`) and is never persisted.
 *
 * Both modes require a palette first; otherwise a friendly prompt is shown.
 */
async function handleJudgeHarmony() {
  const btn = document.getElementById("ai-judge-btn");
  const mode = readAiMode();

  const palette = currentPaletteHex();
  if (palette.length === 0) {
    setAiResult("请先选择或上传一张图片并生成聚类调色板，然后再判断配色是否和谐。", "info");
    return;
  }

  if (mode === "shared") {
    state.ai.mode = "shared";
    if (!PROXY_URL) {
      setAiResult(
        "共享服务尚未配置（需先部署代理并在 js/main.js 中填入 PROXY_URL），你也可以切换到“使用我自己的 API Key”。",
        "info"
      );
      return;
    }

    setAiResult("正在通过共享服务判断配色是否和谐……", "loading");
    if (btn) btn.disabled = true;
    try {
      const verdict = await judgeHarmonyViaProxy({
        proxyUrl: PROXY_URL,
        hexColors: palette,
      });
      showVerdict(verdict);
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      setAiResult(`判断失败：${detail}`, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
    return;
  }

  // --- BYOK 模式：直连 OpenAI 兼容接口 ---
  const baseUrlEl = document.getElementById("ai-base-url");
  const modelEl = document.getElementById("ai-model");
  const keyEl = document.getElementById("ai-api-key");

  // Snapshot the runtime config into in-memory state (never persisted).
  state.ai = {
    mode: "byok",
    baseUrl: baseUrlEl ? baseUrlEl.value.trim() : "",
    model: modelEl ? modelEl.value.trim() : "",
    apiKey: keyEl ? keyEl.value.trim() : "",
  };

  const missing = [];
  if (!state.ai.baseUrl) missing.push("Base URL");
  if (!state.ai.model) missing.push("模型");
  if (!state.ai.apiKey) missing.push("API Key");
  if (missing.length > 0) {
    setAiResult(`请先填写：${missing.join("、")}（仅在内存中使用，不会写入源码）。`, "info");
    return;
  }

  setAiResult("正在请求模型判断配色是否和谐……", "loading");
  if (btn) btn.disabled = true;

  try {
    const verdict = await judgeHarmony({
      baseUrl: state.ai.baseUrl,
      model: state.ai.model,
      apiKey: state.ai.apiKey,
      hexColors: palette,
    });
    showVerdict(verdict);
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    setAiResult(`判断失败：${detail}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Initialize the application: create the ECharts instance, bind DOM events, and
 * keep the chart sized to its container. Later tasks extend this to wire the K
 * control, gallery, chart styles, color space, etc.
 */
function init() {
  // Create the ECharts instance once; reused for every subsequent render.
  const chartEl = document.getElementById("chart");
  if (chartEl && typeof window !== "undefined" && window.echarts) {
    chartInstance = window.echarts.init(chartEl);
    window.addEventListener("resize", () => {
      if (chartInstance) chartInstance.resize();
    });
  }

  // Gallery (Task 7.1): render the built-in samples as clickable thumbnails.
  renderGallery();

  const fileInput = document.getElementById("file-input");
  if (fileInput) {
    fileInput.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) {
        // An upload is not one of the gallery images: clear the highlight.
        setSelectedThumb(null);
        handleSource(file);
      }
    });
  }

  // K control (Task 6.1): changing K re-clusters the current pixels and
  // re-renders without reloading the image. The raw slider value is clamped to
  // a valid integer via `clampK`, `state.k` and the `#k-value` display are kept
  // in sync, then `runClusteringAndRender` reruns k-means on the current image.
  const kControl = document.getElementById("k-control");
  const kValue = document.getElementById("k-value");
  if (kControl) {
    // Reflect the control's initial value into state and the display.
    state.k = clampK(Number(kControl.value), currentMaxK());
    if (kValue) kValue.value = String(state.k);

    kControl.addEventListener("input", (event) => {
      const raw = Number(event.target.value);
      state.k = clampK(raw, currentMaxK());
      if (kValue) kValue.value = String(state.k);
      runClusteringAndRender();
    });
  }

  // Color-space selector (Task 9.2, extended): choosing a space (RGB / LAB /
  // OKLAB / OKLCH — any key of COLOR_SPACES) sets `state.activeSpace` and
  // re-runs clustering. Unlike the chart-style selector, switching space
  // changes the geometry k-means operates in, so this must re-cluster (call
  // `runClusteringAndRender`), not merely redraw the cached result. In non-RGB
  // modes pixels are clustered in that space and centroids are converted back
  // to RGB for display by `toClusterViews` (Requirements 7.3, 7.4).
  const spaceSelect = document.getElementById("space-select");
  if (spaceSelect) {
    // Reflect the control's initial value into state.
    state.activeSpace = spaceSelect.value || state.activeSpace;

    spaceSelect.addEventListener("change", (event) => {
      state.activeSpace = event.target.value; // "RGB" | "LAB" | "OKLAB" | "OKLCH"
      runClusteringAndRender();
    });
  }

  // Chart-style selector (Task 8.1): switching style only re-renders the cached
  // clustering result via `renderCurrentStyle` — it never re-runs k-means, so
  // the underlying data is untouched (Requirement 6.2). scatter3d reuses the
  // pixel sample cached during the last clustering pass.
  const styleSelect = document.getElementById("style-select");
  if (styleSelect) {
    // Reflect the control's initial value into state.
    state.chartStyle = styleSelect.value || state.chartStyle;

    styleSelect.addEventListener("change", (event) => {
      state.chartStyle = event.target.value;
      renderCurrentStyle();
    });
  }

  // AI harmony judgment (Task 11.2): read the runtime config into state and, on
  // "judge harmony", send the current palette to the OpenAI-compatible endpoint
  // via `judgeHarmony`. Loading / success / error states are shown in the
  // `#ai-result` panel; missing config or no clustering result yields a
  // friendly prompt rather than an error. The API key stays in memory only.
  const aiJudgeBtn = document.getElementById("ai-judge-btn");
  if (aiJudgeBtn) {
    aiJudgeBtn.addEventListener("click", () => {
      handleJudgeHarmony();
    });
  }

  // AI 模式切换（共享服务 / 自带 Key）：默认"共享服务"。切换时只显示/隐藏
  // 自带 Key 的输入项与共享服务说明，不触发任何网络请求。
  const modeRadios = document.querySelectorAll('input[name="ai-mode"]');
  if (modeRadios.length > 0) {
    state.ai.mode = readAiMode();
    applyAiModeUI(state.ai.mode);
    modeRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        state.ai.mode = readAiMode();
        applyAiModeUI(state.ai.mode);
      });
    });
  }
}

// Only auto-initialize inside a browser (skip under Node/test).
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

export { state, init, meanRGB, clampK, buildGallerySources };
