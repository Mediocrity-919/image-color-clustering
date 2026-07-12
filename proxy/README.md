# 配色和谐度判断代理

## 它做了什么 / 不做什么

- 只接受固定形状的请求：`POST { "hexColors": ["#rrggbb", ...] }`。
- 服务端拼配色和谐度判断的 prompt（与前端 `js/aiHarmony.js` 的`buildHarmonyPrompt` 保持一致），调用 DeepSeek 的 OpenAI 兼容接口。
- 只返回精简结果：`{ "harmonious": true|false|null, "reason": "..." }`。
- 不是通用透传：无法用它跑任意 prompt，因此拿到 URL 也只能判断配色。

## 请求契约

- 方法：`POST`（同时支持 `OPTIONS` 预检）。
- 请求体：`{ "hexColors": string[] }`
  - 数组长度 1..12；
  - 每项匹配 `/^#[0-9a-f]{6}$/i`（即 `#rrggbb`）。
  - 不合法 -> `400`，返回 `{ "error": "..." }`。
- 成功响应：`200`，`{ "harmonious": boolean|null, "reason": string }`。
- 频率超限：`429`（带 `Retry-After`）。
- 上游/服务器错误：`5xx`，`{ "error": "..." }`（不透传上游原始错误体）。

## 密钥安全

- 真实的 DeepSeek API Key 只作为 Worker 密钥存在：
  - 生产：`wrangler secret put DEEPSEEK_API_KEY`（加密存储）；
  - 本地：写在 `proxy/.dev.vars`（已被 `.gitignore` 忽略）。
- Key 绝不写进 `wrangler.toml`、前端代码、`index.html` 或仓库任何文件。
- 工作区根目录的 `api.txt` 只是你本地保存 key 的地方，部署时请手动把它的值填进密钥，不要复制进任何被提交的文件。

## 本地快速启用

如果只想在本地把服务跑通，不必部署 Worker，用`proxy/local-server.mjs` 这个零依赖的 Node 代理即可：

```bash
# 终端 A：前端静态服务器（项目根目录）
python -m http.server 8000

# 终端 B：本地代理（项目根目录）
npm run proxy          # 等价于 node proxy/local-server.mjs
```

- 代理监听 `http://localhost:8787`，前端 `js/main.js` 的 `PROXY_URL` 已默认指向它。
- Key 的来源：优先环境变量 `DEEPSEEK_API_KEY`，否则自动读取项目根目录的 `api.txt`（已被 `.gitignore` 忽略）。key 只在这个 Node 进程里，不会发给浏览器。
- 和 Worker 版一样：只接受 `{ hexColors }`、服务端拼 prompt、只返回`{ harmonious, reason }`，并带 CORS 头。
- 启动后到页面里选"使用免费服务"，点"判断配色是否和谐"即可。

## 部署步骤

1. 安装 Wrangler（Cloudflare 官方 CLI）：

   ```bash
   npm install -g wrangler
   # 或使用 npx：npx wrangler <命令>
   wrangler login
   ```

2. 进入本目录并设置密钥：

   ```bash
   cd proxy
   wrangler secret put DEEPSEEK_API_KEY
   ```

3. 设置允许来源。可在 `wrangler.toml` 的 `[vars]` 里改 `ALLOWED_ORIGINS`为你前端站点的域名（逗号分隔多个），例如：
   
   ```toml
   [vars]
   ALLOWED_ORIGINS = "https://your-site.example.com,http://localhost:8000"
   RATE_LIMIT_PER_MINUTE = "10"
   ```
   
4. 部署：

   ```bash
   wrangler deploy
   ```

   部署完成后 Wrangler 会打印一个 Worker URL，形如
   `https://color-harmony-proxy.<account>.workers.dev`。

5. 回到前端：把 `js/main.js` 顶部的 `PROXY_URL` 常量改成上面拿到的 Worker URL，免费服务模式即可启用。

## 本地开发

```bash
cd proxy
cp .dev.vars.example .dev.vars
wrangler dev
```

`wrangler dev` 会自动读取 `proxy/.dev.vars` 里的 `DEEPSEEK_API_KEY` /`ALLOWED_ORIGINS`，并在本地起一个监听端口。把前端的 `PROXY_URL` 临时指向该本地地址即可联调。
