/**
 * server.js - VPS 服务器运行适配器
 * 让 AETHERIA Worker 在 Node.js 环境运行（用于 VPS 自建部署）
 *
 * 用法：
 *   1. 配置环境变量（或 .env 文件）
 *   2. node server.js
 *   3. 默认监听 8787 端口
 *
 * 环境变量：
 *   ADMIN_BOT_TOKEN        管理 Bot Token
 *   STORE_BOT_TOKEN        前台 Bot Token
 *   ADMIN_ID               管理员 Telegram ID
 *   DEFAULT_UPSTREAM_URL   默认上游链接
 *   PORT                   监听端口（默认 8787）
 */

import { createServer } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== 加载环境变量（支持 .env 文件）=====
function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) {}
}
loadEnvFile();

// ===== 简易 KV 存储（内存 + 文件持久化）=====
class LocalKV {
  constructor() {
    this.data = new Map();
    this.file = path.join(__dirname, ".kv-data.json");
    this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
        for (const [k, v] of Object.entries(raw)) this.data.set(k, v);
      }
    } catch (e) {}
  }
  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.data)));
    } catch (e) {}
  }
  async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
  async put(key, value, opts) {
    this.data.set(key, value);
    if (opts && opts.expirationTtl) {
      setTimeout(() => this.data.delete(key), opts.expirationTtl * 1000);
    }
    this.save();
  }
  async delete(key) { this.data.delete(key); this.save(); }
  async list(opts) {
    const prefix = (opts && opts.prefix) || "";
    const limit = (opts && opts.limit) || 1000;
    const keys = [];
    for (const k of this.data.keys()) {
      if (k.startsWith(prefix)) keys.push({ name: k });
      if (keys.length >= limit) break;
    }
    return { keys };
  }
}

// ===== 创建 KV 模拟 =====
const SUB_STORE = new LocalKV();

// ===== 加载 Worker =====
async function loadWorker() {
  try {
    // 注意：ESM 动态 import 在 Windows 上必须用 file:// URL，否则报
    // "Only URLs with a scheme in: file, data, and node are supported"
    const workerPath = pathToFileURL(path.join(__dirname, "worker.js")).href;
    const mod = await import(workerPath);
    return mod.default;
  } catch (e) {
    console.error("加载 worker.js 失败:", e.message);
    process.exit(1);
  }
}

// ===== 启动 HTTP 服务 =====
async function main() {
  const worker = await loadWorker();
  const port = parseInt(process.env.PORT) || 8787;

  // 检查必需配置
  if (!process.env.ADMIN_BOT_TOKEN || process.env.ADMIN_BOT_TOKEN === "YOUR_ADMIN_BOT_TOKEN") {
    console.warn("⚠️  警告：ADMIN_BOT_TOKEN 未配置！请设置环境变量或 .env 文件");
  }

  const server = createServer(async (req, res) => {
    try {
      // 构造 Request 对象
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, String(v));
      }

      // 读取请求体
      let body = null;
      if (req.method === "POST") {
        body = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on("data", c => chunks.push(c));
          req.on("end", () => resolve(Buffer.concat(chunks)));
          req.on("error", reject);
        });
      }

      // 构造 Worker 环境
      const env = {
        SUB_STORE,
        ADMIN_BOT_TOKEN: process.env.ADMIN_BOT_TOKEN,
        STORE_BOT_TOKEN: process.env.STORE_BOT_TOKEN,
        ADMIN_ID: process.env.ADMIN_ID,
        DEFAULT_UPSTREAM_URL: process.env.DEFAULT_UPSTREAM_URL,
        DEFAULT_BRAND: process.env.DEFAULT_BRAND,
        STORE_ORIGIN: process.env.STORE_ORIGIN,
        STORE_BOT_USERNAME: process.env.STORE_BOT_USERNAME,
        SETUP_KEY: process.env.SETUP_KEY,
        WEBHOOK_SECRET: process.env.WEBHOOK_SECRET
      };

      const request = new Request(url, {
        method: req.method,
        headers,
        body: body ? body : undefined
      });

      // 调用 Worker
      const response = await worker.fetch(request, env, {});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      const text = await response.text();
      res.end(text);
    } catch (e) {
      console.error("处理请求出错:", e);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  });

  server.listen(port, () => {
    console.log(`🚀 AETHERIA 服务已启动`);
    console.log(`   ➜ 本地地址: http://localhost:${port}`);
    console.log(`   ➜ Webhook 注册: http://你的域名:${port}/setup-webhooks`);
    console.log(`   ➜ 买家订阅: http://你的域名:${port}/s/{uid}`);
    console.log(`\n⚠️  记得配置 Nginx 反向代理 + HTTPS 才能被 Telegram 访问`);
  });

  // ===== VPS 模式补全 Cron 定时任务 =====
  // Cloudflare Workers 上由平台 Cron 触发；VPS 上无平台调度，这里用定时器模拟：
  //  - 每 30 分钟执行一次到期提醒扫描（checkExpiringSubscriptions 本身幂等，不会重复通知）
  //  - 每天 0 点（UTC+8 早上 8 点即 UTC 0 点）推送每日运营日报
  try {
    const env = {
      SUB_STORE,
      ADMIN_BOT_TOKEN: process.env.ADMIN_BOT_TOKEN,
      STORE_BOT_TOKEN: process.env.STORE_BOT_TOKEN,
      ADMIN_ID: process.env.ADMIN_ID,
      DEFAULT_UPSTREAM_URL: process.env.DEFAULT_UPSTREAM_URL,
      DEFAULT_BRAND: process.env.DEFAULT_BRAND,
      STORE_ORIGIN: process.env.STORE_ORIGIN,
      STORE_BOT_USERNAME: process.env.STORE_BOT_USERNAME,
      SETUP_KEY: process.env.SETUP_KEY,
      WEBHOOK_SECRET: process.env.WEBHOOK_SECRET
    };

    // 到期提醒扫描：每 30 分钟一次
    setInterval(async () => {
      try {
        await worker.scheduled({ cron: "0 8 * * *" }, env, {});
        console.log(`[Cron] 到期提醒扫描完成 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
      } catch (e) {
        console.error("[Cron] 到期提醒扫描失败:", e.message);
      }
    }, 30 * 60 * 1000);

    // 每日日报：UTC 0 点（北京时间早 8 点）推送
    const scheduleDailyReport = () => {
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(0, 0, 5, 0); // UTC 0 点后 5 秒
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      const delay = next - now;
      setTimeout(async () => {
        try {
          await worker.scheduled({ cron: "0 0 * * *" }, env, {});
          console.log(`[Cron] 每日运营日报已推送 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
        } catch (e) {
          console.error("[Cron] 每日日报推送失败:", e.message);
        }
        scheduleDailyReport(); // 循环调度
      }, delay);
    };
    scheduleDailyReport();
    console.log(`   ➜ 定时任务: 到期提醒每30分钟 / 日报每天UTC 0点`);
  } catch (e) {
    console.error("定时任务初始化失败:", e.message);
  }
}

main();