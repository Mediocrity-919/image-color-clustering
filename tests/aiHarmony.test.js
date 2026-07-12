import { describe, it, expect, vi, afterEach } from "vitest";
import fc from "fast-check";

import {
  buildHarmonyPrompt,
  parseHarmonyResponse,
  judgeHarmony,
  judgeHarmonyViaProxy,
} from "../js/aiHarmony.js";


const RUNS = 200;

const hexColor = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => "#" + n.toString(16).padStart(6, "0"));
const palette = fc.array(hexColor, { minLength: 1, maxLength: 12 });

describe("buildHarmonyPrompt — example cases (Requirement 8.2)", () => {
  it("returns chat messages that include every palette color and ask for JSON", () => {
    const { messages } = buildHarmonyPrompt(["#ff0000", "#00ff00", "#0000ff"]);
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    for (const m of messages) {
      expect(typeof m.role).toBe("string");
      expect(typeof m.content).toBe("string");
    }
    const text = messages.map((m) => m.content).join("\n");
    expect(text).toContain("#ff0000");
    expect(text).toContain("#00ff00");
    expect(text).toContain("#0000ff");
    expect(text.toLowerCase()).toContain("json");
    expect(text).toContain("harmonious");
  });

  it("handles an empty palette without throwing", () => {
    expect(() => buildHarmonyPrompt([])).not.toThrow();
    const { messages } = buildHarmonyPrompt([]);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("buildHarmonyPrompt — Property 12: harmony prompt contains the full palette (Requirement 8.2)", () => {
  it("includes every palette color in the built prompt", () => {
    fc.assert(
      fc.property(palette, (colors) => {
        const { messages } = buildHarmonyPrompt(colors);
        const text = messages.map((m) => m.content).join("\n");
        for (const c of colors) {
          expect(text).toContain(c);
        }
      }),
      { numRuns: RUNS }
    );
  });
});

const contentValue = fc.oneof(
  fc.string(),
  fc.constant('{"harmonious": true, "reason": "balanced neutrals"}'),
  fc.constant('好的 {"harmonious": false, "reason": "对比过强"} 结束'),
  fc.constant("```json\n{\"harmonious\": true, \"reason\": \"ok\"}\n```"),
  fc.array(fc.record({ type: fc.constant("text"), text: fc.string() })),
  fc.anything()
);

const openAiLike = fc.record({
  choices: fc.array(
    fc.record({ message: fc.record({ content: contentValue }) }),
    { minLength: 0, maxLength: 3 }
  ),
});

const responseArb = fc.oneof(fc.anything(), openAiLike);

describe("parseHarmonyResponse — Property 13: parsing always returns a well-formed verdict (Requirement 8.3)", () => {
  it("returns harmonious in {boolean|null} and reason as a string for any input", () => {
    fc.assert(
      fc.property(responseArb, (response) => {
        const result = parseHarmonyResponse(response);
        expect(result).not.toBeNull();
        expect(typeof result).toBe("object");
        expect(
          result.harmonious === null || typeof result.harmonious === "boolean"
        ).toBe(true);
        expect(typeof result.reason).toBe("string");
      }),
      { numRuns: RUNS }
    );
  });
});

describe("parseHarmonyResponse — example cases (Requirement 8.3)", () => {
  it("parses a clean JSON verdict", () => {
    const response = {
      choices: [
        { message: { content: '{"harmonious": true, "reason": "柔和统一"}' } },
      ],
    };
    expect(parseHarmonyResponse(response)).toEqual({
      harmonious: true,
      reason: "柔和统一",
    });
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const response = {
      choices: [
        {
          message: {
            content: '结论如下：{"harmonious": false, "reason": "冲突"}，仅供参考',
          },
        },
      ],
    };
    expect(parseHarmonyResponse(response)).toEqual({
      harmonious: false,
      reason: "冲突",
    });
  });

  it("degrades gracefully to raw text when content is not JSON", () => {
    const response = {
      choices: [{ message: { content: "这组颜色看起来很协调。" } }],
    };
    const result = parseHarmonyResponse(response);
    expect(result.harmonious).toBeNull();
    expect(result.reason).toBe("这组颜色看起来很协调。");
  });

  it("degrades gracefully on a completely unexpected shape", () => {
    const result = parseHarmonyResponse({ unexpected: 123 });
    expect(result.harmonious).toBeNull();
    expect(typeof result.reason).toBe("string");
  });
});


const cfg = {
  baseUrl: "https://api.example.com/v1/",
  model: "gpt-4o-mini",
  apiKey: "sk-test",
  hexColors: ["#ff0000", "#00ff00"],
};

describe("judgeHarmony — network failure handling (Requirement 8.5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("surfaces a readable error when fetch rejects (network/CORS)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));
    await expect(judgeHarmony(cfg)).rejects.toThrow(/网络请求失败/);
  });

  it("surfaces a readable error on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "upstream boom",
      })
    );
    await expect(judgeHarmony(cfg)).rejects.toThrow(/HTTP 500/);
  });

  it("resolves with a parsed verdict on a successful response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: { content: '{"harmonious": true, "reason": "well balanced"}' },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await judgeHarmony(cfg);
    expect(result).toEqual({ harmonious: true, reason: "well balanced" });

    // POSTs to the joined endpoint with a Bearer key and no double slash.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(init.headers["Content-Type"]).toContain("application/json");
    const parsedBody = JSON.parse(init.body);
    expect(parsedBody.model).toBe("gpt-4o-mini");
    expect(Array.isArray(parsedBody.messages)).toBe(true);
  });

  it("handles a base URL without a trailing slash without dropping the separator", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"harmonious": false, "reason": "x"}' } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await judgeHarmony({ ...cfg, baseUrl: "https://api.example.com/v1" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.example.com/v1/chat/completions"
    );
  });
});

const proxyCfg = {
  proxyUrl: "https://color-harmony-proxy.example.workers.dev",
  hexColors: ["#ff0000", "#00ff00", "#0000ff"],
};

describe("judgeHarmonyViaProxy — shared-service mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs only { hexColors } to the proxy (no API key, no base URL)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ harmonious: true, reason: "均衡的三原色" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await judgeHarmonyViaProxy(proxyCfg);
    expect(result).toEqual({ harmonious: true, reason: "均衡的三原色" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(proxyCfg.proxyUrl);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toContain("application/json");
    expect(init.headers.Authorization).toBeUndefined();
    const parsedBody = JSON.parse(init.body);
    expect(parsedBody).toEqual({ hexColors: proxyCfg.hexColors });
  });

  it("parses a direct { harmonious, reason } proxy response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ harmonious: false, reason: "对比过强" }),
      })
    );
    const result = await judgeHarmonyViaProxy(proxyCfg);
    expect(result).toEqual({ harmonious: false, reason: "对比过强" });
  });

  it("still parses an OpenAI-shaped response if the proxy forwards one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            { message: { content: '{"harmonious": true, "reason": "柔和"}' } },
          ],
        }),
      })
    );
    const result = await judgeHarmonyViaProxy(proxyCfg);
    expect(result).toEqual({ harmonious: true, reason: "柔和" });
  });

  it("surfaces a readable error when fetch rejects (network/CORS)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Failed to fetch"))
    );
    await expect(judgeHarmonyViaProxy(proxyCfg)).rejects.toThrow(/网络请求失败/);
    await expect(judgeHarmonyViaProxy(proxyCfg)).rejects.toThrow(/CORS/);
  });

  it("surfaces the proxy's { error } message on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: async () => ({ error: "请求过于频繁，请稍后再试" }),
      })
    );
    const p = judgeHarmonyViaProxy(proxyCfg);
    await expect(p).rejects.toThrow(/HTTP 429/);
    await expect(judgeHarmonyViaProxy(proxyCfg)).rejects.toThrow(
      /请求过于频繁/
    );
  });

  it("throws a readable error when proxyUrl is missing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      judgeHarmonyViaProxy({ hexColors: ["#ffffff"] })
    ).rejects.toThrow(/PROXY_URL/);
  });

  it("does not crash when the successful body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected end of JSON input");
        },
      })
    );
    await expect(judgeHarmonyViaProxy(proxyCfg)).rejects.toThrow(
      /无法解析共享服务响应/
    );
  });
});
