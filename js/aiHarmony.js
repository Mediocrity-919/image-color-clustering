/**
 * AI_Harmony_Advisor
 * ------------------
 * Builds a prompt from the palette and calls an OpenAI-compatible chat
 * completions endpoint directly from the browser. Configuration (base URL,
 * model, API key) is entered at runtime and never written to source.
 *
 * Split into pure helpers (`buildHarmonyPrompt`, `parseHarmonyResponse`) that
 * are unit- and property-tested under Node, and a side-effecting network call
 * (`judgeHarmony`) whose `fetch` can be injected/stubbed in tests.
 */

/**
 * Build the chat messages for a harmony judgment.
 *
 * The user message lists every palette color verbatim (Property 12: the prompt
 * mentions every color) and asks the model to decide whether the palette is
 * harmonious, returning a compact JSON verdict so `parseHarmonyResponse` can
 * extract the result reliably.
 *
 * @param {string[]} hexColors palette hex strings, e.g. ["#a1b2c3", ...]
 * @returns {{ messages: Array<{ role: string, content: string }> }}
 */
export function buildHarmonyPrompt(hexColors) {
  const colors = Array.isArray(hexColors) ? hexColors : [];
  // Each color on its own numbered line, included verbatim so the built prompt
  // always contains every palette color.
  const list = colors.map((c, i) => `${i + 1}. ${String(c)}`).join("\n");

  const systemContent =
    "你是一位资深的配色与视觉设计专家。你会评估一组颜色搭配是否和谐，" +
    "并用简短的理由说明。请始终只返回紧凑、可解析的 JSON。";

  const userContent =
    `以下是从一张图片中聚类提取的调色板颜色（共 ${colors.length} 种）：\n` +
    `${list}\n\n` +
    "请判断这组颜色搭配整体是否和谐，并给出一句简短理由。\n" +
    '只返回如下紧凑 JSON，不要包含额外说明或代码块标记：\n' +
    '{"harmonious": true, "reason": "..."}\n' +
    "其中 harmonious 为布尔值（true 表示和谐，false 表示不和谐），reason 为简短中文理由。";

  return {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
  };
}

/**
 * Safely read `choices[0].message.content` from an OpenAI-compatible response.
 * Returns the raw content value (string, array-of-parts, or something else),
 * or `undefined` when the expected path is absent. Never throws.
 *
 * @param {*} responseJson
 * @returns {*}
 */
function extractRawContent(responseJson) {
  if (!responseJson || typeof responseJson !== "object") return undefined;
  const choices = responseJson.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const message = first.message;
  if (!message || typeof message !== "object") return undefined;
  return message.content;
}

/**
 * Coerce a chat message `content` into a plain string.
 *  - string -> itself
 *  - array of parts (OpenAI content parts) -> concatenated text
 *  - anything else -> null (caller falls back)
 *
 * @param {*} content
 * @returns {string|null}
 */
function contentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return null;
}

/** JSON.stringify that never throws (falls back to String()). */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalize an arbitrary parsed object into a verdict, or `null` if it is not a
 * usable object. `harmonious` is coerced to boolean|null; `reason` to a string.
 *
 * @param {*} obj
 * @returns {{ harmonious: boolean|null, reason: string }|null}
 */
function normalizeVerdict(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  let harmonious = null;
  const h = obj.harmonious;
  if (typeof h === "boolean") {
    harmonious = h;
  } else if (typeof h === "string") {
    const s = h.trim().toLowerCase();
    if (["true", "yes", "harmonious", "和谐"].includes(s)) harmonious = true;
    else if (["false", "no", "not harmonious", "不和谐"].includes(s))
      harmonious = false;
  } else if (typeof h === "number") {
    harmonious = h !== 0;
  }

  let reason = "";
  if (typeof obj.reason === "string") reason = obj.reason;
  else if (obj.reason != null) reason = safeStringify(obj.reason);

  return { harmonious, reason };
}

/**
 * Try to extract a `{harmonious, reason}` verdict from a text blob: first as a
 * whole-string JSON parse, then from the first `{...}` substring (handles cases
 * where the model wraps JSON in prose or code fences).
 *
 * @param {string} text
 * @returns {{ harmonious: boolean|null, reason: string }|null}
 */
function tryParseVerdict(text) {
  // Whole-string JSON.
  try {
    const v = normalizeVerdict(JSON.parse(text));
    if (v) return v;
  } catch {
    /* fall through to substring extraction */
  }

  // First balanced-looking {...} block anywhere in the text.
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const v = normalizeVerdict(JSON.parse(match[0]));
      if (v) return v;
    } catch {
      /* not valid JSON; caller falls back to raw text */
    }
  }
  return null;
}

/**
 * Parse an OpenAI-compatible chat completion response into a verdict.
 *
 * Always returns a well-formed object (Property 13): `harmonious` is a boolean
 * or null, `reason` is a string. Degrades gracefully to
 * `{ harmonious: null, reason: <raw text or description> }` on malformed or
 * unexpected input, and never throws.
 *
 * @param {object} responseJson
 * @returns {{ harmonious: boolean|null, reason: string }}
 */
export function parseHarmonyResponse(responseJson) {
  const raw = extractRawContent(responseJson);
  const content = contentToString(raw);

  if (content == null) {
    // No usable message content at the expected path.
    return {
      harmonious: null,
      reason:
        raw === undefined
          ? "无法从响应中解析出内容"
          : safeStringify(raw),
    };
  }

  const verdict = tryParseVerdict(content);
  if (verdict) {
    // Guarantee a non-empty, useful reason string.
    if (!verdict.reason) verdict.reason = content;
    return verdict;
  }

  // Content was present but not a parseable verdict: surface the raw text.
  return { harmonious: null, reason: content };
}

/**
 * Join a base URL and a path with exactly one slash, tolerating a base URL that
 * ends with `/`, `/v1`, `/v1/`, or nothing. Does not add `/v1` itself — the
 * caller supplies whatever base the endpoint expects.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const p = String(path).replace(/^\/+/, "");
  return `${base}/${p}`;
}

/**
 * Side-effecting: POST the harmony prompt to `${baseUrl}/chat/completions` with
 * a Bearer API key and parse the verdict.
 *
 * Surfaces readable errors for network failures (including likely CORS) and for
 * non-2xx responses; on success delegates to `parseHarmonyResponse`.
 *
 * `fetchImpl` is injectable for testing; it defaults to the ambient `fetch` at
 * call time (so `vi.stubGlobal('fetch', ...)` works).
 *
 * @param {{ baseUrl: string, model: string, apiKey: string, hexColors: string[] }} cfg
 * @param {typeof fetch} [fetchImpl] optional fetch override (tests)
 * @returns {Promise<{ harmonious: boolean|null, reason: string }>}
 */
export async function judgeHarmony(
  { baseUrl, model, apiKey, hexColors } = {},
  fetchImpl
) {
  const fetchFn =
    fetchImpl ||
    (typeof globalThis !== "undefined" ? globalThis.fetch : undefined);
  if (typeof fetchFn !== "function") {
    throw new Error("当前环境不支持 fetch，无法发起请求");
  }

  const url = joinUrl(baseUrl, "chat/completions");
  const { messages } = buildHarmonyPrompt(hexColors);
  const body = JSON.stringify({ model, messages });

  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(
      `网络请求失败：${detail}（可能是网络中断或浏览器跨域 CORS 限制，见 README 中的 CORS 说明）`
    );
  }

  if (!response || !response.ok) {
    const status = response ? response.status : "unknown";
    const statusText = response && response.statusText ? ` ${response.statusText}` : "";
    let detail = "";
    try {
      if (response && typeof response.text === "function") {
        detail = await response.text();
      }
    } catch {
      /* ignore body read failures */
    }
    throw new Error(
      `请求失败（HTTP ${status}${statusText}）${detail ? "：" + detail : ""}`
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new Error("无法解析响应内容为 JSON");
  }

  return parseHarmonyResponse(json);
}

/**
 * Coerce an arbitrary parsed payload into a `{harmonious, reason}` verdict.
 *
 * The shared proxy already returns `{ harmonious, reason }` directly, so this
 * accepts that shape as-is (after normalization). But to stay robust it also
 * handles the case where the proxy (or a future change) forwards an
 * OpenAI-compatible response — in which case it falls back to
 * `parseHarmonyResponse`. Always returns a well-formed verdict; never throws.
 *
 * @param {*} payload parsed JSON from the proxy
 * @returns {{ harmonious: boolean|null, reason: string }}
 */
function coerceProxyVerdict(payload) {
  const isObject =
    payload && typeof payload === "object" && !Array.isArray(payload);

  // If it looks like an OpenAI-compatible response (has `choices`), parse it
  // robustly rather than mistaking the wrapper for a verdict.
  if (isObject && Array.isArray(payload.choices)) {
    return parseHarmonyResponse(payload);
  }

  // Direct verdict shape from the proxy: only trust it when it actually carries
  // a `harmonious` or `reason` field, so we don't turn an unrelated object into
  // an empty verdict.
  if (isObject && ("harmonious" in payload || "reason" in payload)) {
    const direct = normalizeVerdict(payload);
    if (direct) {
      if (!direct.reason) direct.reason = "";
      return direct;
    }
  }

  // Fallback: let the robust parser surface whatever it can (never throws).
  return parseHarmonyResponse(payload);
}

/**
 * Shared-service mode: POST `{ hexColors }` to our serverless proxy, which
 * holds the real API key server-side and returns `{ harmonious, reason }`.
 *
 * The proxy never exposes the key, only accepts the fixed `{ hexColors }`
 * shape, and enforces CORS + per-IP rate limiting (see proxy/README.md). This
 * function therefore sends no API key and no base URL — just the palette.
 *
 * Surfaces readable errors for network failures (including likely CORS) and for
 * non-2xx responses (preferring the proxy's `{ error }` message when present).
 *
 * `fetchImpl` is injectable for testing; it defaults to the ambient `fetch` at
 * call time (so `vi.stubGlobal('fetch', ...)` works).
 *
 * @param {{ proxyUrl: string, hexColors: string[] }} cfg
 * @param {typeof fetch} [fetchImpl] optional fetch override (tests)
 * @returns {Promise<{ harmonious: boolean|null, reason: string }>}
 */
export async function judgeHarmonyViaProxy({ proxyUrl, hexColors } = {}, fetchImpl) {
  const fetchFn =
    fetchImpl ||
    (typeof globalThis !== "undefined" ? globalThis.fetch : undefined);
  if (typeof fetchFn !== "function") {
    throw new Error("当前环境不支持 fetch，无法发起请求");
  }
  if (!proxyUrl || typeof proxyUrl !== "string") {
    throw new Error("共享服务地址（PROXY_URL）未配置");
  }

  let response;
  try {
    response = await fetchFn(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hexColors }),
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(
      `网络请求失败：${detail}（可能是网络中断或浏览器跨域 CORS 限制，需要在代理的 ALLOWED_ORIGINS 中加入本站来源，见 proxy/README.md）`
    );
  }

  if (!response || !response.ok) {
    const status = response ? response.status : "unknown";
    const statusText =
      response && response.statusText ? ` ${response.statusText}` : "";
    // Prefer the proxy's structured { error } message when available.
    let detail = "";
    try {
      if (response && typeof response.json === "function") {
        const errJson = await response.json();
        if (errJson && typeof errJson.error === "string") detail = errJson.error;
        else if (errJson != null) detail = safeStringify(errJson);
      } else if (response && typeof response.text === "function") {
        detail = await response.text();
      }
    } catch {
      /* ignore body read failures */
    }
    throw new Error(
      `共享服务请求失败（HTTP ${status}${statusText}）${detail ? "：" + detail : ""}`
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new Error("无法解析共享服务响应内容为 JSON");
  }

  return coerceProxyVerdict(json);
}
