/**
 * Chart_Builder
 * -------------
 * Builds ECharts option objects from a clustering result. `buildOption` is a
 * pure function (data in, plain option object out); `renderChart` is a thin
 * side-effecting wrapper around an ECharts instance.
 *
 * Task 4.1 implements the "pie" and "bar" styles plus the view-model helpers.
 * Additional styles ("doughnut", "tree", "scatter3d") are added in Task 8.
 */

import { COLOR_SPACES } from "./colorSpace.js";

/**
 * @typedef {Object} ClusterView
 * @property {string} hex display color, e.g. "#a1b2c3"
 * @property {number} count pixel count
 * @property {[number,number,number]} rgb centroid RGB
 */

/** Clamp a raw channel value to an integer in the range 0..255. */
function clampChannel(value) {
  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  if (rounded > 255) return 255;
  return rounded;
}

/**
 * Convert a centroid RGB triple to a "#rrggbb" hex string. Channels are
 * rounded and clamped into 0..255 so the output always matches /^#[0-9a-f]{6}$/.
 *
 * @param {[number,number,number]} rgb
 * @returns {string} "#rrggbb"
 */
export function rgbToHex(rgb) {
  const [r, g, b] = [rgb[0], rgb[1], rgb[2]].map(clampChannel);
  return (
    "#" +
    [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * Convert clustering output (in the active space) into display view models.
 *
 * Centroids come back in whatever coordinates k-means ran in, so each is mapped
 * back to display RGB through the color-space registry rather than a hardcoded
 * per-space branch: `COLOR_SPACES[activeSpace].fromPoint(centroid)`. This keeps
 * the function agnostic to how many spaces exist (RGB / LAB / OKLAB / OKLCH /
 * future ones). For OKLCH the centroid is a hue-ring-safe embedding and its
 * `fromPoint` inverts that embedding — see colorSpace.js. Unknown space names
 * fall back to RGB (identity) so the function never throws mid-render.
 *
 * Regardless of the source space, every `rgb` channel is additionally
 * clamped/rounded to an integer in 0..255 here, so the produced views are
 * always valid for display even if a `fromPoint` returns raw/out-of-range
 * values.
 *
 * @param {number[][]} centroids
 * @param {number[]} counts
 * @param {"RGB"|"LAB"|"OKLAB"|"OKLCH"|string} activeSpace
 * @returns {ClusterView[]}
 */
export function toClusterViews(centroids, counts, activeSpace) {
  const space = COLOR_SPACES[activeSpace] || COLOR_SPACES.RGB;
  return centroids.map((centroid, i) => {
    // Registry converts the centroid back to RGB for the active space (RGB is
    // identity). The subsequent clamp/round guarantees a valid in-range RGB
    // triple no matter which space produced it.
    const raw = space.fromPoint(centroid);
    const rgb = [clampChannel(raw[0]), clampChannel(raw[1]), clampChannel(raw[2])];
    return {
      hex: rgbToHex(rgb),
      count: counts[i],
      rgb,
    };
  });
}

/**
 * Build an ECharts option for the given style. Each cluster maps to exactly one
 * data entry: the entry's color is the cluster hex and its value is the cluster
 * pixel count. (For the "tree" style the per-cluster entry is a leaf node under
 * a single synthetic root; for "scatter3d" the per-cluster data are points in
 * color space rather than a single count entry — see below.)
 *
 * Pure function: given the same inputs it always returns the same plain option
 * object and never touches the DOM, app state, or a chart instance.
 *
 * scatter3d data source & interface note:
 *   The 3D scatter needs the (sampled) pixel points, which live in app state,
 *   not in `views`. To keep `buildOption` pure and testable we accept an
 *   optional third argument `extra` that carries that data instead of reaching
 *   into module state:
 *     extra.samples : number[][]  sampled pixel coordinates [[x,y,z], ...]
 *     extra.labels  : number[]    parallel cluster index per sample
 *   When `extra` (or its samples) is omitted, scatter3d falls back to plotting
 *   one emphasized 3D point per centroid (using each view's rgb as the
 *   coordinate) so the option is always renderable and every cluster is shown.
 *   `extra` is ignored by every other style, so pie/doughnut/bar/tree keep the
 *   original two-argument behavior.
 *
 * @param {ClusterView[]} views
 * @param {"pie"|"doughnut"|"bar"|"tree"|"scatter3d"} style
 * @param {{ samples?: number[][], labels?: number[] }} [extra] scatter3d data
 * @returns {object} ECharts option
 */
export function buildOption(views, style, extra) {
  switch (style) {
    case "pie":
      return {
        tooltip: { trigger: "item" },
        legend: { show: false },
        series: [
          {
            type: "pie",
            radius: "70%",
            // Each slice's `name` is the cluster hex, so `{b}` renders the hex
            // value directly on the chart and `{d}%` adds the slice percentage
            // as a textual complement to the size encoding. No rgb() text.
            label: {
              show: true,
              formatter: "{b}\n{d}%",
            },
            labelLine: { show: true },
            data: views.map((v) => ({
              value: v.count,
              name: v.hex,
              itemStyle: { color: v.hex },
            })),
          },
        ],
      };
    case "doughnut":
      // Same per-cluster pie data as "pie" but rendered as a ring (inner +
      // outer radius). Each cluster is one slice, colored by hex, sized by count.
      return {
        tooltip: { trigger: "item" },
        legend: { show: false },
        series: [
          {
            type: "pie",
            radius: ["40%", "70%"],
            // Same hex + percentage label as the pie style (name === hex).
            label: {
              show: true,
              formatter: "{b}\n{d}%",
            },
            labelLine: { show: true },
            data: views.map((v) => ({
              value: v.count,
              name: v.hex,
              itemStyle: { color: v.hex },
            })),
          },
        ],
      };
    case "bar":
      return {
        tooltip: { trigger: "axis" },
        // The category axis labels are the cluster hex values, so the hex is
        // already visible per bar; the bar-top label shows the pixel count so
        // both dimensions read off the chart without duplicating the hex.
        xAxis: { type: "category", data: views.map((v) => v.hex) },
        yAxis: { type: "value" },
        series: [
          {
            type: "bar",
            label: {
              show: true,
              position: "top",
              formatter: "{c}",
            },
            data: views.map((v) => ({
              value: v.count,
              itemStyle: { color: v.hex },
            })),
          },
        ],
      };
    case "tree":
      // A single synthetic root ("clusters") with exactly one leaf per cluster.
      // Each leaf is named by its hex, valued by its pixel count, and colored by
      // its hex — so a cluster is still represented by exactly one data entry,
      // just nested one level down.
      return {
        tooltip: { trigger: "item" },
        series: [
          {
            type: "tree",
            data: [
              {
                name: "clusters",
                children: views.map((v) => ({
                  name: v.hex,
                  value: v.count,
                  itemStyle: { color: v.hex },
                })),
              },
            ],
            symbolSize: 12,
            label: { position: "left", verticalAlign: "middle", align: "right" },
            // Each leaf's `name` is the cluster hex; `show: true` + `{b}` makes
            // that hex value render next to the leaf node. No rgb() text.
            leaves: {
              label: {
                show: true,
                position: "right",
                verticalAlign: "middle",
                align: "left",
                formatter: "{b}",
              },
            },
          },
        ],
      };
    case "scatter3d": {
      // Requires echarts-gl at runtime (registers the `grid3D` component and
      // `scatter3D` series). See the JSDoc above for the `extra` data contract.
      const samples =
        extra && Array.isArray(extra.samples) ? extra.samples : [];
      const labels = extra && Array.isArray(extra.labels) ? extra.labels : [];

      // Sampled pixels, each colored by the hex of the cluster it belongs to.
      const pixelData = samples.map((p, i) => {
        const idx = labels[i] != null ? labels[i] : 0;
        const v = views[idx] || views[0];
        return {
          value: [p[0], p[1], p[2]],
          itemStyle: { color: v ? v.hex : "#000000" },
        };
      });

      // Emphasized centroids: one point per cluster at its rgb coordinate.
      const centroidData = views.map((v) => ({
        value: [v.rgb[0], v.rgb[1], v.rgb[2]],
        itemStyle: { color: v.hex },
      }));

      const series = [];
      if (pixelData.length > 0) {
        series.push({ type: "scatter3D", symbolSize: 4, data: pixelData });
      }
      series.push({
        type: "scatter3D",
        symbolSize: 18,
        data: centroidData,
        emphasis: { itemStyle: { opacity: 1 } },
      });

      return {
        tooltip: {},
        xAxis3D: { type: "value", name: "R/L" },
        yAxis3D: { type: "value", name: "G/a" },
        zAxis3D: { type: "value", name: "B/b" },
        grid3D: {},
        series,
      };
    }
    default:
      throw new Error(`Unsupported chart style: ${style}`);
  }
}

/**
 * Side-effecting render into an ECharts instance.
 *
 * @param {object} chartInstance an ECharts instance
 * @param {object} option built by `buildOption`
 * @returns {void}
 */
export function renderChart(chartInstance, option) {
  chartInstance.setOption(option, true);
}
