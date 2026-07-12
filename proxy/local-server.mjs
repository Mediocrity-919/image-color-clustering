import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildHarmonyPrompt, parseHarmonyResponse } from "../js/aiHarmony.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const UPSTREAM_URL = "https://api.deepseek.com/chat/completions";
const UPSTREAM_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

const MAX_COLORS = 12;
const HEX_RE = /^#[0-9a-f]{6}$/i;

function getApiKey() {
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  try {
    return readFileSync(path.join(__dirname, "..", "api.txt"), "utf8").trim();
  } catch {
    return "";
  }
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/**
 * 校验请求体：只接受 { hexColors: string[] }，长度 1..MAX_COLORS，每项 #rrggbb。
 * @param {*} body
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
    return { ok: false, message: `hexColors 长度必须在 1..${MAX_COLORS} 之间` };
  }
  for (const c of hexColors) {
    if (typeof c !== "string" || !HEX_RE.test(c)) {
      return { ok: false, message: `颜色格式非法：${JSON.stringify(c)}（应为 #rrggbb）` };
    }
  }
  return { ok: true, hexColors };
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "只支持 POST 请求" });
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 10_000) req.destroy();
  });
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: "请求体不是合法 JSON" });
    }

    const v = validatePayload(body);
    if (!v.ok) return sendJson(res, 400, { error: v.message });

    const apiKey = getApiKey();
    if (!apiKey) {
      return sendJson(res, 500, {
        error: "未找到 DEEPSEEK_API_KEY（请设置同名环境变量，或在项目根目录放置 api.txt）",
      });
    }

    const { messages } = buildHarmonyPrompt(v.hexColors);
    let upstream;
    try {
      upstream = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: UPSTREAM_MODEL, messages }),
      });
    } catch (err) {
      const detail = err && err.message ? err.message : String(err);
      return sendJson(res, 502, { error: `上游请求失败：${detail}` });
    }

    if (!upstream.ok) {
      return sendJson(res, 502, { error: `上游返回错误（HTTP ${upstream.status}）` });
    }

    let json;
    try {
      json = await upstream.json();
    } catch {
      return sendJson(res, 502, { error: "无法解析上游响应为 JSON" });
    }

    return sendJson(res, 200, parseHarmonyResponse(json));
  });
});

server.listen(PORT, () => {
  const hasKey = getApiKey() ? "已找到 key" : "未找到 key（设 DEEPSEEK_API_KEY 或放 api.txt）";
  console.log(
    `[local proxy] listening on http://localhost:${PORT}  model=${UPSTREAM_MODEL}  ${hasKey}`
  );
  console.log(
    `[local proxy] 前端 js/main.js 的 PROXY_URL 需指向 http://localhost:${PORT}`
  );
});
