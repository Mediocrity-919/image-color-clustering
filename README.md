# 图像颜色聚类可视化 

一个纯前端、纯客户端的静态网页：加载图片，将像素颜色用k-means聚类，并用 ECharts 可视化聚类结果（每个簇的平均颜色与像素数量，并在每个簇上直接标注平均色的hex 文本）。支持交互式选择聚类数 K、切换图片、切换图表样式、切换颜色空间（RGB / LAB / OKLab / OKLCH），并可调用大模型判断配色是否和谐。

## AI 配色和谐度判断

AI 配色和谐度判断"支持两种模式，二选一：

1. 使用deepseek服务
   前端把当前调色板（`{ hexColors: [...] }`）发给作者部署的一个受限 serverless 代理，由代理在服务端拼 prompt、带着共享的DeepSeek key 调用模型，只返回`{ harmonious, reason }`。

   该模式需要先部署代理（见 [`proxy/README.md`](proxy/README.md)），再把 `js/main.js` 顶部的 `PROXY_URL` 常量填成部署后拿到的 Worker URL。未配置时前端会提示改用"自带 API Key"。

2. 使用自己的 API Key   `/chat/completions` 接口，默认预填 DeepSeek 的配置：Base URL：`https://api.deepseek.com`    模型：`deepseek-v4-flash`     API Key 在页面上运行时输入，仅在内存中使用，不会写入源码或提交到仓库。

## 通过 HTTP 提供服务

必须通过 HTTP 服务器访问，不能直接用 `file://` 打开 `index.html`。

## 本地启动

在项目根目录运行以下任意命令，然后在浏览器打开 <http://localhost:8000> ：

```bash
# 使用 npm 脚本（等价于下面的 python 命令）
npm run dev

# 或直接使用 Python 内置的 HTTP 服务器
python -m http.server 8000

#开启本地代理
npm run proxy
```

## 运行测试

纯函数（像素提取、颜色转换、k-means、图表 option 构建、prompt/响应解析）使用Node + Vitest 进行单元测试与属性测试：

```bash
# 首次需安装依赖
npm install

# 运行测试（Vitest run 模式，一次性执行后退出）
npm test
```

## 项目结构

```
.
├── index.html          # 页面外壳：文件选择、画廊占位、控件、图表容器
├── css/
│   └── style.css       # 基础样式
├── js/
│   ├── main.js         # 入口：事件绑定、应用状态、流程编排、AI 模式切换
│   ├── imageLoader.js  # 图片 -> 缩略 canvas -> 像素数组
│   ├── colorSpace.js   # RGB <-> LAB / OKLab / OKLCH 转换
│   ├── kmeans.js       # k-means
│   ├── chart.js        # 构建并渲染 ECharts option
│   └── aiHarmony.js    # 判断配色和谐度：judgeHarmony（直连）/ judgeHarmonyViaProxy
├── proxy/              # 共享服务的受限 serverless 代理（Cloudflare Worker）
│   ├── worker.js       # 只接受 { hexColors }，服务端拼 prompt，只返回 { harmonious, reason }
│   ├── wrangler.toml   # Worker 配置示例
│   ├── .dev.vars.example # 本地开发环境变量示例
│   └── README.md       # 部署与防滥用说明
├── tests/              # Vitest 单元测试与属性测试
├── images/             # 内置样例图片 01.jpg ~ 07.jpg
├── package.json
└── README.md
```
