/**
 * Cloudflare Worker — 配色和谐度判断代理（受限转发，非通用透传）
 * ================================================================
 *
 * 目标：让没有自己 API Key 的用户也能使用"共享服务"，同时：
 *   1. 真实的 DeepSeek API Key 只作为 Worker 的密钥（env.DEEPSEEK_API_KEY）
 *      存在，绝不出现在前端代码、仓库文件或响应里。
 *   2. 代理不是通用 LLM 透传：它只接受固定形状的请求
 *      `{ hexColors: string[] }`，服务端自己拼配色判断的 prompt，
 *      只返回 `{ harmonious, reason }`。这样即便被人拿到 Worker URL，
 *      也只能用来判断配色，无法当作免费的通用大模型接口滥用。
 *   3. 通过 CORS 白名单 + 按 IP 限流 + 严格输入校验限制滥用。
 *
 * 部署形式：ES module Worker（export default { fetch }）。
 * 所需密钥/变量（部署时设置，见 proxy/README.md）：
 *   - DEEPSEEK_API_KEY  （secret，wrangler secret put）
 *   - ALLOWED_ORIGINS   （逗号分隔的来源白名单；"*" 表示允许任意来源）
 *   - RATE_LIMIT_PER_MINUTE （可选，默认 10）
 *
 * 上游：DeepSeek，OpenAI 兼容 chat completions。
 */

const UPSTREAM_URL = "https://api.deepseek.com/chat/completions";
const UPSTREAM_MODEL = "deepseek-v4-flash";

// 单个调色板允许的颜色数量上限（与前端聚类 K 的上限一致）。
const MAX_COLORS = 12;
// 每项必须是 #rrggbb 形式的 6 位十六进制颜色。
const HEX_RE = /^#[0-9a-f]{6}$/i;
// 默认限流：每个 IP 每分钟允许的请求次数（可被 env.RATE_LIMIT_PER_MINUTE 覆盖）。
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60 * 1000;

/**
 * 简易的按 IP 限流状态（内存 Map：ip -> { count, windowStart }）。
 *
 * ⚠️ 重要说明：Worker 实例的内存**不持久**，也不跨实例共享——
 * 平台会按需创建/回收多个实例，这个 Map 只在单个实例存活期间有效。
 * 因此它只能作为"最简防滥用"手段，能挡住来自单机的高频刷取，
 * 但不是严格的全局配额。
 *
 * 生产环境要做**可靠**的全局限流，应改用：
 *   - Workers KV：以 IP 为 key 存计数 + TTL（最终一致，成本低，够用）；
 *   - 或 Durable Objects：单点强一致计数（更精确，适合严格配额）。
 * 切换方式：把下面 `checkRateLimit` 里对 `ipHits` 的读写，
 * 换成对 `env.RATE_LIMIT_KV` 的 get/put（KV），
 * 或转发到一个 Durable Object 实例（用 IP 作为其 name）。
 */
const ipHits = new Map();

/**
 * 判断某个 IP 是否超出限流阈值，并在未超出时记一次数。
 * @param {string} ip 客户端 IP（CF-Connecting-IP）
 * @param {number} limit 每分钟允许次数
 * @returns {boolean} true=允许本次请求，false=已超限
 */
function checkRateLimit(ip, limit) {
  if (!ip) return true; // 拿不到 IP 时不做限制（本地开发常见）。
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    // 新窗口。
    ipHits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/**
 * 解析 ALLOWED_ORIGINS 环境变量为一个来源数组。
 * @param {string|undefined} raw 逗号分隔的来源，或 "*"
 * @returns {string[]}
 */
function parseAllowedOrigins(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 根据请求 Origin 与白名单，计算要回写的 CORS 头。
 * - 白名单含 "*" -> 回写 "*"（允许任意来源）。
 * - Origin 命中白名单 -> 回写该 Origin（并带 Vary: Origin）。
 * - 否则不回写 Allow-Origin（浏览器会因此拦截跨域响应）。
 * @param {Request} request
 * @param {string[]} allowedOrigins
 * @returns {Record<string,string>}
 */
function corsHeaders(request, allowedOrigins) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (allowedOrigins.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

/**
 * 统一的 JSON 响应封装，带上 CORS 头。
 * @param {*} obj
 * @param {number} status
 * @param {Record<string,string>} cors
 * @returns {Response}
 */
function jsonResponse(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors,
    },
  });
}

// ---------------------------------------------------------------------------
// 配色判断的 prompt 构造 —— 与前端 js/aiHarmony.js 的 buildHarmonyPrompt 保持一致。
// 复制而非引用，以保证 Worker 可独立部署（无打包步骤）。
// ---------------------------------------------------------------------------

/**
 * 构造配色和谐度判断的 chat messages。
 * @param {string[]} hexColors
 * @returns {{ messages: Array<{ role: string, content: string }> }}
 */
function buildHarmonyPrompt(hexColors) {
  const colors = Array.isArray(hexColors) ? hexColors : [];
  const list = colors.map((c, i) => `${i + 1}. ${String(c)}`).join("\n");

  const systemContent =
    "你是一位资深的配色与视觉设计专家。你会评估一组颜色搭配是否和谐，" +
    "并用简短的理由说明。请始终只返回紧凑、可解析的 JSON。";

  const userContent =
    `以下是从一张图片中聚类提取的调色板颜色（共 ${colors.length} 种）：\n` +
    `${list}\n\n` +
    "请判断这组颜色搭配整体是否和谐，并给出一句简短理由。\n" +
    "只返回如下紧凑 JSON，不要包含额外说明或代码块标记：\n" +
    '{"harmonious": true, "reason": "..."}\n' +
    "其中 harmonious 为布尔值（true 表示和谐，false 表示不和谐），reason 为简短中文理由。";

  return {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
  };
}

// ---------------------------------------------------------------------------
// 响应解析 —— 与前端 js/aiHarmony.js 的 parseHarmonyResponse 保持一致（复制）。
// 始终返回 { harmonious: boolean|null, reason: string }，绝不抛出。
// ---------------------------------------------------------------------------

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

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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

function tryParseVerdict(text) {
  try {
    const v = normalizeVerdict(JSON.parse(text));
    if (v) return v;
  } catch {
    /* fall through */
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const v = normalizeVerdict(JSON.parse(match[0]));
      if (v) return v;
    } catch {
      /* not valid JSON */
    }
  }
  return null;
}

function parseHarmonyResponse(responseJson) {
  const raw = extractRawContent(responseJson);
  const content = contentToString(raw);

  if (content == null) {
    return {
      harmonious: null,
      reason: raw === undefined ? "无法从响应中解析出内容" : safeStringify(raw),
    };
  }

  const verdict = tryParseVerdict(content);
  if (verdict) {
    if (!verdict.reason) verdict.reason = content;
    return verdict;
  }

  return { harmonious: null, reason: content };
}

// ---------------------------------------------------------------------------
// 输入校验：只接受 { hexColors: string[] }，长度 1..MAX_COLORS，每项 #rrggbb。
// ---------------------------------------------------------------------------

/**
 * @param {*} body 已解析的请求体
 * @returns {{ ok: true, hexColors: string[] } | { ok: false, message: string }}
 */
function validatePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "请求体必须是 JSON 对象" };
  }
  const { hexColors } = body;
  if (!Array.isArray(hexColors)) {
    return { ok: false, message: "hexColors 必须是数组" };
  }
  if (hexColors.length < 1 || hexColors.length > MAX_COLORS) {
    return {
      ok: false,
      message: `hexColors 长度必须在 1..${MAX_COLORS} 之间`,
    };
  }
  for (const c of hexColors) {
    if (typeof c !== "string" || !HEX_RE.test(c)) {
      return {
        ok: false,
        message: `颜色格式非法：${safeStringify(c)}（应为 #rrggbb）`,
      };
    }
  }
  return { ok: true, hexColors };
}

export default {
  /**
   * @param {Request} request
   * @param {{ DEEPSEEK_API_KEY?: string, ALLOWED_ORIGINS?: string, RATE_LIMIT_PER_MINUTE?: string }} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(request, allowedOrigins);

    // --- CORS 预检 ---
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // --- 只允许 POST ---
    if (request.method !== "POST") {
      return jsonResponse(
        { error: "只支持 POST 请求" },
        405,
        { ...cors, Allow: "POST, OPTIONS" }
      );
    }

    // --- 按 IP 限流（用 CF-Connecting-IP）---
    const rateLimit =
      Number(env.RATE_LIMIT_PER_MINUTE) > 0
        ? Number(env.RATE_LIMIT_PER_MINUTE)
        : DEFAULT_RATE_LIMIT_PER_MINUTE;
    const ip = request.headers.get("CF-Connecting-IP") || "";
    if (!checkRateLimit(ip, rateLimit)) {
      return jsonResponse(
        { error: `请求过于频繁，请稍后再试（每分钟最多 ${rateLimit} 次）` },
        429,
        { ...cors, "Retry-After": "60" }
      );
    }

    // --- 服务端必须配置了密钥 ---
    if (!env.DEEPSEEK_API_KEY) {
      return jsonResponse(
        { error: "代理未配置 DEEPSEEK_API_KEY（服务端密钥缺失）" },
        500,
        cors
      );
    }

    // --- 解析并校验请求体 ---
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "请求体不是合法 JSON" }, 400, cors);
    }
    const validated = validatePayload(body);
    if (!validated.ok) {
      return jsonResponse({ error: validated.message }, 400, cors);
    }

    // --- 服务端自己构造 prompt，调用上游 ---
    const { messages } = buildHarmonyPrompt(validated.hexColors);
    let upstream;
    try {
      upstream = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({ model: UPSTREAM_MODEL, messages }),
      });
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      return jsonResponse(
        { error: `上游请求失败：${detail}` },
        502,
        cors
      );
    }

    if (!upstream.ok) {
      // 不把上游的原始错误体（可能含敏感信息）直接透传，只给状态码。
      return jsonResponse(
        { error: `上游返回错误（HTTP ${upstream.status}）` },
        502,
        cors
      );
    }

    let upstreamJson;
    try {
      upstreamJson = await upstream.json();
    } catch {
      return jsonResponse(
        { error: "无法解析上游响应为 JSON" },
        502,
        cors
      );
    }

    // 只返回精简的 { harmonious, reason }，不回传上游原始响应。
    const verdict = parseHarmonyResponse(upstreamJson);
    return jsonResponse(verdict, 200, cors);
  },
};

// 便于对 worker 内的纯函数做隔离测试（可选）。浏览器/Worker 运行时不受影响。
export { buildHarmonyPrompt, parseHarmonyResponse, validatePayload };
