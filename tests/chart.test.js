import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

vi.mock("../js/colorSpace.js", () => {
  const labStub = (lab) => {
    const [L, a, b] = lab;
    return [L * 2.55, 128 + a, 128 + b];
  };
  return {
    rgb2lab: (rgb) => [...rgb],
    lab2rgb: labStub,
    COLOR_SPACES: {
      RGB: {
        toPoint: (rgb) => [...rgb],
        fromPoint: (coords) => [...coords],
      },
      LAB: {
        toPoint: (rgb) => [...rgb],
        fromPoint: labStub,
      },
    },
  };
});

import { rgbToHex, toClusterViews, buildOption } from "../js/chart.js";

const RUNS = 200;

const HEX_RE = /^#[0-9a-f]{6}$/;
const channel = fc.integer({ min: 0, max: 255 });
const count = fc.nat({ max: 100000 });

const rgbCentroid = fc
  .tuple(
    fc.double({ min: -50, max: 320, noNaN: true }),
    fc.double({ min: -50, max: 320, noNaN: true }),
    fc.double({ min: -50, max: 320, noNaN: true })
  )
  .map((t) => [...t]);

const labCentroid = fc
  .tuple(
    fc.double({ min: 0, max: 100, noNaN: true }),
    fc.double({ min: -128, max: 127, noNaN: true }),
    fc.double({ min: -128, max: 127, noNaN: true })
  )
  .map((t) => [...t]);

const centroidsCountsSpace = fc
  .oneof(
    fc.record({
      space: fc.constant("RGB"),
      centroids: fc.array(rgbCentroid, { minLength: 1, maxLength: 12 }),
    }),
    fc.record({
      space: fc.constant("LAB"),
      centroids: fc.array(labCentroid, { minLength: 1, maxLength: 12 }),
    })
  )
  .chain(({ space, centroids }) =>
    fc
      .array(count, { minLength: centroids.length, maxLength: centroids.length })
      .map((counts) => ({ space, centroids, counts }))
  );

const view = fc
  .record({
    rgb: fc.tuple(channel, channel, channel).map((t) => [...t]),
    count,
  })
  .map(({ rgb, count: c }) => ({ rgb, count: c, hex: rgbToHex(rgb) }));

const viewList = fc.array(view, { minLength: 1, maxLength: 12 });

describe("rgbToHex — example cases (Requirement 2.1)", () => {
  it("formats primaries and rounds/clamps out-of-range channels", () => {
    expect(rgbToHex([255, 0, 0])).toBe("#ff0000");
    expect(rgbToHex([0, 255, 0])).toBe("#00ff00");
    expect(rgbToHex([0, 0, 255])).toBe("#0000ff");
    expect(rgbToHex([16, 32, 48])).toBe("#102030");
    // Rounding and clamping.
    expect(rgbToHex([-5, 300, 127.6])).toBe("#00ff80");
  });
});

describe("toClusterViews — example cases (Requirement 2.1)", () => {
  it("passes RGB centroids through with rounding and preserves counts", () => {
    const views = toClusterViews([[10, 20, 30], [255.4, -1, 128.5]], [5, 9], "RGB");
    expect(views).toEqual([
      { hex: "#0a141e", count: 5, rgb: [10, 20, 30] },
      { hex: "#ff0081", count: 9, rgb: [255, 0, 129] },
    ]);
  });
});

describe("toClusterViews — Property 5: cluster views are valid in-range RGB (Requirements 2.1, 7.4)", () => {
  it("returns integer 0..255 rgb channels, #rrggbb hex, and one view per centroid", () => {
    fc.assert(
      fc.property(centroidsCountsSpace, ({ space, centroids, counts }) => {
        const views = toClusterViews(centroids, counts, space);

        expect(views).toHaveLength(centroids.length);
        views.forEach((v, i) => {
          expect(v.rgb).toHaveLength(3);
          for (const ch of v.rgb) {
            expect(Number.isInteger(ch)).toBe(true);
            expect(ch).toBeGreaterThanOrEqual(0);
            expect(ch).toBeLessThanOrEqual(255);
          }
          expect(v.hex).toMatch(HEX_RE);
          expect(v.hex).toBe(rgbToHex(v.rgb));
          expect(v.count).toBe(counts[i]);
        });
      }),
      { numRuns: RUNS }
    );
  });
});

describe("buildOption — Property 6: one entry per cluster with the correct value (Requirements 2.2, 3.2)", () => {
  const supportedStyles = ["pie", "bar"];

  it("produces exactly one data entry per view with value == count", () => {
    fc.assert(
      fc.property(viewList, fc.constantFrom(...supportedStyles), (views, style) => {
        const option = buildOption(views, style);
        const data = option.series[0].data;

        expect(data).toHaveLength(views.length);
        data.forEach((entry, i) => {
          expect(entry.value).toBe(views[i].count);
          // Each entry is colored by its cluster hex.
          expect(entry.itemStyle.color).toBe(views[i].hex);
        });
      }),
      { numRuns: RUNS }
    );
  });
});

describe("buildOption — Unit: pie and bar option shapes (Requirement 3.1)", () => {
  const views = [
    { rgb: [255, 0, 0], count: 3, hex: "#ff0000" },
    { rgb: [0, 255, 0], count: 7, hex: "#00ff00" },
    { rgb: [0, 0, 255], count: 1, hex: "#0000ff" },
  ];

  it("returns a pie series for the 'pie' style", () => {
    const option = buildOption(views, "pie");
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe("pie");
    expect(option.series[0].data).toHaveLength(views.length);
  });

  it("returns a bar series for the 'bar' style", () => {
    const option = buildOption(views, "bar");
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe("bar");
    expect(option.series[0].data).toHaveLength(views.length);
    expect(option.xAxis.data).toHaveLength(views.length);
  });

  it("throws for an unsupported style", () => {
    expect(() => buildOption(views, "bogus-style")).toThrow();
  });
});

function extractClusterCounts(option) {
  const series = option.series[0];
  if (series.type === "tree") {
    return series.data[0].children.map((leaf) => leaf.value);
  }
  return series.data.map((entry) => entry.value);
}

describe("buildOption — Property 7: style switching preserves the underlying data (Requirement 6.2)", () => {
  const dataStyles = ["pie", "doughnut", "bar", "tree"];

  it("yields identical entry counts and per-cluster count values across any two styles", () => {
    fc.assert(
      fc.property(
        viewList,
        fc.constantFrom(...dataStyles),
        fc.constantFrom(...dataStyles),
        (views, styleA, styleB) => {
          const countsA = extractClusterCounts(buildOption(views, styleA));
          const countsB = extractClusterCounts(buildOption(views, styleB));

          expect(countsA).toHaveLength(views.length);
          expect(countsB).toHaveLength(views.length);
          expect(countsA).toEqual(countsB);
          expect(countsA).toEqual(views.map((v) => v.count));
        }
      ),
      { numRuns: RUNS }
    );
  });
});

describe("buildOption — Unit: tree and doughnut option shapes (Requirement 6.1)", () => {
  const views = [
    { rgb: [255, 0, 0], count: 3, hex: "#ff0000" },
    { rgb: [0, 255, 0], count: 7, hex: "#00ff00" },
    { rgb: [0, 0, 255], count: 1, hex: "#0000ff" },
  ];

  it("returns a doughnut (pie with ring radius) for the 'doughnut' style", () => {
    const option = buildOption(views, "doughnut");
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe("pie");
    expect(Array.isArray(option.series[0].radius)).toBe(true);
    expect(option.series[0].radius).toHaveLength(2);
    expect(option.series[0].data).toHaveLength(views.length);
    option.series[0].data.forEach((entry, i) => {
      expect(entry.value).toBe(views[i].count);
      expect(entry.itemStyle.color).toBe(views[i].hex);
    });
  });

  it("returns a tree whose single root has one leaf per cluster", () => {
    const option = buildOption(views, "tree");
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe("tree");
    // Exactly one root node.
    expect(option.series[0].data).toHaveLength(1);
    const root = option.series[0].data[0];
    // One leaf per cluster under the root.
    expect(root.children).toHaveLength(views.length);
    root.children.forEach((leaf, i) => {
      expect(leaf.value).toBe(views[i].count);
      expect(leaf.name).toBe(views[i].hex);
      expect(leaf.itemStyle.color).toBe(views[i].hex);
    });
  });
});

describe("buildOption — hex labels are enabled and free of rgb() text", () => {
  const views = [
    { rgb: [255, 0, 0], count: 3, hex: "#ff0000" },
    { rgb: [0, 255, 0], count: 7, hex: "#00ff00" },
    { rgb: [0, 0, 255], count: 1, hex: "#0000ff" },
  ];

  function collectStrings(node, acc = []) {
    if (typeof node === "string") {
      acc.push(node);
    } else if (Array.isArray(node)) {
      node.forEach((child) => collectStrings(child, acc));
    } else if (node && typeof node === "object") {
      Object.values(node).forEach((child) => collectStrings(child, acc));
    }
    return acc;
  }

  it("enables a slice label with a hex-bearing formatter for pie and doughnut", () => {
    for (const style of ["pie", "doughnut"]) {
      const label = buildOption(views, style).series[0].label;
      expect(label).toBeDefined();
      expect(label.show).toBe(true);
      expect(typeof label.formatter).toBe("string");
      expect(label.formatter).toContain("{b}");
    }
  });

  it("enables a bar-top label while the x axis carries the hex values", () => {
    const option = buildOption(views, "bar");
    expect(option.series[0].label.show).toBe(true);
    expect(option.xAxis.data).toEqual(views.map((v) => v.hex));
  });

  it("shows tree leaf labels (leaf name is the hex)", () => {
    const leaves = buildOption(views, "tree").series[0].leaves;
    expect(leaves.label.show).toBe(true);
    expect(leaves.label.formatter).toContain("{b}");
  });

  it("never emits rgb() text in any label/formatter across styles", () => {
    for (const style of ["pie", "doughnut", "bar", "tree"]) {
      const strings = collectStrings(buildOption(views, style));
      strings.forEach((s) => expect(s).not.toContain("rgb("));
    }
  });
});
