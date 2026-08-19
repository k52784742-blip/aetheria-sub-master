/**
 * Project: AETHERIA Sub-Master Ultra (Dual-Bot Automated Subscription Hub - Complete Edition)
 * Architecture: Cloudflare Workers + KV + Dual Telegram Bots + Cron
 * Features:
 *  - Admin: User mgmt, order review, reseller/distribution system, broadcast, expiry reminders
 *  - Buyer: Beautiful web portal, 1-click renew, status check via store bot
 */

// ==================== 核心参数配置区 ====================
// ⚠️ 安全提示：Token/ID 通过 Cloudflare Secrets（wrangler secret put）注入环境变量！
// 上传 GitHub 时这些值不会被包含（代码从 env 读取，未设置时用占位符）
// 本地开发：复制 .dev.vars.example 为 .dev.vars 填入真实值
let ADMIN_BOT_TOKEN = "YOUR_ADMIN_BOT_TOKEN";   // 后台私密管理 Bot Token
let STORE_BOT_TOKEN = "YOUR_STORE_BOT_TOKEN";   // 前台公开售卖 Bot Token
let ADMIN_ID = 0;                              // 管理员专属 Telegram 数字 ID (白名单)
let DEFAULT_BRAND = "Maybe";                 // 节点默认品牌水印前缀
let DEFAULT_UPSTREAM_URL = "YOUR_DEFAULT_UPSTREAM_URL"; // 默认上游订阅源（可被上游池覆盖）
let STORE_ORIGIN = "";                        // 对外门户地址（env 注入，fallback 到请求 origin）
let STORE_BOT_USERNAME = "";                  // 前台 Bot 用户名（env 注入，用于分销深链/客服链接）
let SETUP_KEY = "";                           // /setup-webhooks 鉴权密钥（env 可选注入）
const DEFAULT_DAYS = 30;                        // 默认套餐天数
const REMINDER_DAYS = [3, 1, 0];                // 到期前 3 天 / 1 天 / 当天 提醒
const BOT_USERNAME_FALLBACK = "zzgmdybot";     // 兜底 Bot 用户名（仅当 env 未配置时）

// 从环境变量加载配置（每个请求入口调用）
function loadConfig(env) {
  if (!env) return;
  if (env.ADMIN_BOT_TOKEN) ADMIN_BOT_TOKEN = env.ADMIN_BOT_TOKEN;
  if (env.STORE_BOT_TOKEN) STORE_BOT_TOKEN = env.STORE_BOT_TOKEN;
  if (env.ADMIN_ID) ADMIN_ID = parseInt(env.ADMIN_ID);
  if (env.DEFAULT_UPSTREAM_URL) DEFAULT_UPSTREAM_URL = env.DEFAULT_UPSTREAM_URL;
  if (env.DEFAULT_BRAND) DEFAULT_BRAND = env.DEFAULT_BRAND;
  if (env.STORE_ORIGIN) STORE_ORIGIN = env.STORE_ORIGIN.replace(/\/$/, "");
  if (env.STORE_BOT_USERNAME) STORE_BOT_USERNAME = env.STORE_BOT_USERNAME.replace(/^@/, "");
  if (env.SETUP_KEY) SETUP_KEY = env.SETUP_KEY;
}

// 获取前台 Bot 用户名（env 优先，否则兜底）
function getStoreBotUsername() {
  return STORE_BOT_USERNAME || BOT_USERNAME_FALLBACK;
}

// 获取对外门户地址（env 优先，否则用请求 origin）
function getStoreOrigin(request) {
  if (STORE_ORIGIN) return STORE_ORIGIN;
  try { return new URL(request.url).origin; } catch (e) { return ""; }
}
// ==================== 套餐配置（可被 /plans 管理端命令修改，存 KV）====================
const DEFAULT_PLANS = [
  { id: "month", name: "月卡", days: 30, price: "30元" },
  { id: "quarter", name: "季卡", days: 90, price: "75元" },
  { id: "year", name: "年卡", days: 365, price: "240元" }
];
// ====================================================

export default {
  // ===== HTTP 入口 =====
  async fetch(request, env, ctx) {
    loadConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. 买家订阅与控制面板路由: /s/{uid}
    if (path.startsWith("/s/")) {
      const uid = path.replace("/s/", "").trim();
      if (!uid) return new Response("Error: Invalid UID", { status: 400 });
      return await handleBuyerPortal(uid, request, env);
    }

    // 1.5 续费路由: /renew/{uid}
    if (path.startsWith("/renew/")) {
      const uid = path.replace("/renew/", "").trim();
      if (!uid) return new Response("Error: Invalid UID", { status: 400 });
      return await handleRenewPage(uid, request, env);
    }

    // 1.6 分销推广路由: /r/{code} → 跳转到前台 Bot
    if (path.startsWith("/r/")) {
      const code = path.replace("/r/", "").trim().toUpperCase();
      if (!code) return new Response("Error: Invalid Code", { status: 400 });
      return await handleResellerLanding(code, request, env);
    }

    // 2. 前台客服售卖 Bot 路由 (/bot/store)
    if (path === "/bot/store" && request.method === "POST") {
      // Webhook 安全校验（配置了 secret 时校验）
      if (env.WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      return await handleStoreBot(request, env);
    }

    // 3. 后台管理控制 Bot 路由 (/bot/admin)
    if (path === "/bot/admin" && request.method === "POST") {
      // Webhook 安全校验（配置了 secret 时校验）
      if (env.WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      return await handleAdminBot(request, env);
    }

    // 4. 自注册 Webhook 端点（仅 GET，部署后访问一次即可）
    if (path === "/setup-webhooks") {
      return await handleWebhookSetup(request, env);
    }

    return new Response("AETHERIA Ultra Console is Active.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  },

  // ===== Cron 定时任务入口（到期提醒 + 每日报表）=====
  async scheduled(event, env, ctx) {
    loadConfig(env);
    try {
      await checkExpiringSubscriptions(env);
      // 每天 0 点（UTC）推送昨日运营日报
      if (event && event.cron === "0 0 * * *") {
        await sendDailyReport(env);
      }
    } catch (err) {
      // 静默失败，避免重试风暴
    }
  }
};

// 每日运营日报
async function sendDailyReport(env) {
  try {
    // 统计所有记录（游标分页取全量）
    const recordKeys = await listAllKeys(env, "record_", 5000);
    const userKeys = await listAllKeys(env, "user_", 10000);
    const now = Date.now();
    const dayMs = 86400000;
    const todayStart = new Date().setHours(0, 0, 0, 0);

    // 昨日新增订单
    let yesterdayNew = 0, yesterdayRenew = 0, yesterdayCard = 0;
    let totalOrders = 0;
    for (const k of recordKeys) {
      const r = JSON.parse(await env.SUB_STORE.get(k));
      totalOrders++;
      if (r.time >= todayStart - dayMs && r.time < todayStart) {
        if (r.via === "card") yesterdayCard++;
        else if (r.type === "renew") yesterdayRenew++;
        else yesterdayNew++;
      }
    }

    // 用户状态
    let active = 0, expired = 0, disabled = 0;
    const expiring7 = [];
    for (const k of userKeys) {
      const u = JSON.parse(await env.SUB_STORE.get(k));
      if (u.status === "disabled") disabled++;
      else if (now > u.expiry) expired++;
      else {
        active++;
        if ((u.expiry - now) <= 7 * dayMs) expiring7.push(k.replace("user_", ""));
      }
    }

    // 卡密库存
    const cardKeys = await listAllKeys(env, "card_", 10000);
    let cardUnused = 0;
    for (const k of cardKeys) {
      const c = JSON.parse(await env.SUB_STORE.get(k));
      if (c.status === "unused") cardUnused++;
    }

    const report = `📊 【每日运营日报】\n\n` +
      `📦 昨日新购: ${yesterdayNew} 单\n` +
      `🔄 昨日续费: ${yesterdayRenew} 单\n` +
      `🎫 昨日卡密: ${yesterdayCard} 单\n` +
      `🧾 历史总单: ${totalOrders} 笔\n\n` +
      `👥 当前用户: ${users.keys.length}\n` +
      `　🟢 正常: ${active} | ⏳ 过期: ${expired} | 🔴 禁用: ${disabled}\n` +
      `⚠️ 7天内到期: ${expiring7.length} 人\n` +
      `🎫 卡密库存: ${cardUnused} 张`;

    await sendTGText(ADMIN_BOT_TOKEN, ADMIN_ID, report);
  } catch (e) {}
}

// ==================== 模块 0: Webhook 自注册 (/setup-webhooks) ====================
async function handleWebhookSetup(request, env) {
  try {
    // 鉴权：配置了 SETUP_KEY 时必须带 ?key= 才能操作，防止被恶意重置 webhook
    if (SETUP_KEY) {
      const url = new URL(request.url);
      if (url.searchParams.get("key") !== SETUP_KEY) {
        return new Response("Forbidden: invalid setup key", { status: 403 });
      }
    }
    const origin = new URL(request.url).origin;
    const storeWebhook = `${origin}/bot/store`;
    const adminWebhook = `${origin}/bot/admin`;

    // 如果配置了 WEBHOOK_SECRET，注册时带上 secret_token 用于安全校验
    const secret = env.WEBHOOK_SECRET || "";
    const secretParam = secret ? `&secret_token=${encodeURIComponent(secret)}` : "";

    const storeRes = await fetch(`https://api.telegram.org/bot${STORE_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(storeWebhook)}${secretParam}`);
    const storeJson = await storeRes.json();

    const adminRes = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(adminWebhook)}${secretParam}`);
    const adminJson = await adminRes.json();

    // ===== 注册左侧命令菜单（点"/"即可看到，一键触发，无需手输命令）=====
    // 前台售卖 Bot 命令菜单（买家可见）
    const storeCommands = [
      { command: "start", description: "🏠 开始 / 公告" },
      { command: "buy", description: "🛒 购买套餐" },
      { command: "query", description: "🔍 查询订阅" },
      { command: "card", description: "🎫 兑换卡密" },
      { command: "coupon", description: "🎁 优惠券兑换" },
      { command: "faq", description: "❓ 常见问题" },
      { command: "service", description: "📞 联系客服" }
    ];
    // 管理 Bot 命令菜单（仅管理员可见）
    const adminCommands = [
      { command: "start", description: "🏠 主菜单" },
      { command: "check", description: "📊 查用户 /check UID" },
      { command: "gencard", description: "🎫 生成卡密 /gencard 数量 天数 价格" },
      { command: "gencp", description: "🎁 生成优惠券 /gencp 数量 天数 折扣 备注" },
      { command: "addurl", description: "🔗 添加上游 /addurl 链接" },
      { command: "delurl", description: "🗑️ 删除上游 /delurl 序号" },
      { command: "setdef", description: "⭐ 设默认上游 /setdef 序号" },
      { command: "nodes", description: "📡 查看节点 /nodes [序号]" },
      { command: "nodeoff", description: "🔴 禁用节点 /nodeoff 1,3,5|all" },
      { command: "nodeon", description: "🟢 启用节点 /nodeon 1,3,5|all" },
      { command: "nodelist", description: "📋 节点禁用列表" },
      { command: "merge", description: "🔄 合并模式 /merge on|off" },
      { command: "price", description: "💰 设置价格 /price 内容" },
      { command: "days", description: "📅 设置时长 /days 数字" },
      { command: "service", description: "📞 设置客服 /service @用户名" },
      { command: "setup", description: "🔗 设上游 /setup 链接" },
      { command: "qrlist", description: "🖼️ 收款码列表" },
      { command: "qrdel", description: "🗑️ 删收款码 /qrdel 序号" },
      { command: "cancel", description: "❌ 取消当前操作" }
    ];

    const setStoreCmds = await fetch(`https://api.telegram.org/bot${STORE_BOT_TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: storeCommands })
    }).then(r => r.json()).catch(() => ({}));

    const setAdminCmds = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: adminCommands })
    }).then(r => r.json()).catch(() => ({}));

    return new Response(JSON.stringify({
      store_bot: storeJson,
      admin_bot: adminJson,
      store_commands: setStoreCmds,
      admin_commands: setAdminCmds,
      store_webhook: storeWebhook,
      admin_webhook: adminWebhook,
      secret_enabled: !!secret
    }, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  } catch (err) {
    return new Response("Webhook setup failed: " + err.message, { status: 500 });
  }
}

// ==================== 模块 1: 买家门户与清洗引擎 (/s/{uid}) ====================
async function handleBuyerPortal(uid, request, env) {
  const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
  if (!userDataStr) {
    return new Response("【错误】订阅不存在或已失效", { status: 404 });
  }

  const user = JSON.parse(userDataStr);
  const ua = request.headers.get("User-Agent") || "";
  const isBrowser = ua.includes("Mozilla") || ua.includes("Chrome") || ua.includes("Safari");

  // ===== 场景 A: 浏览器访问 -> 精美控制面板 =====
  if (isBrowser) {
    const remainMs = user.expiry - Date.now();
    const remainDays = Math.ceil(remainMs / 86400000);
    const subUrl = request.url;
    const expired = remainMs <= 0;
    const disabled = user.status === "disabled";
    const statusColor = disabled ? "#f87171" : (expired ? "#fbbf24" : "#4ade80");
    const statusText = disabled ? "服务已暂停" : (expired ? "已过期" : "正常运行中");
    const renewUrl = `${getStoreOrigin(request)}/renew/${uid}`;
    const expireDate = new Date(user.expiry).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
    const plan = user.plan || "标准套餐";
    const price = user.price || "";

    // 客服配置
    const serviceContact = await env.SUB_STORE.get("service_contact") || "";
    let serviceLink = `tg://resolve?domain=${getStoreBotUsername()}`;
    if (serviceContact) {
      if (serviceContact.startsWith("@")) serviceLink = `tg://resolve?domain=${serviceContact.replace("@", "")}`;
      else if (serviceContact.startsWith("http")) serviceLink = serviceContact;
    }

    // 公告展示
    const notice = await env.SUB_STORE.get("notice_content") || "";

    // 订阅开通时间与累计信息
    const createdAt = user.createdAt || user.expiry - (30 * 86400000);
    const createdDate = new Date(createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
    const sourceDesc = user.source === "card" ? "卡密兑换" : (user.source === "coupon" ? "优惠券" : "官方购买");
    const totalPlanDays = user.planDays || (user.plan ? parseInt(String(user.plan).match(/\d+/)) || 30 : 30);

    // 有效期进度条（基于已用/总时长比例）
    const totalMs = Math.max(user.expiry - createdAt, 86400000);
    const usedMs = Date.now() - createdAt;
    const progressPct = Math.max(0, Math.min(100, Math.round((1 - (user.expiry - Date.now()) / totalMs) * 100)));

    // 公告横幅（未过期时显示）
    const noticeBanner = (notice && !disabled && !expired) ? `
    <div style="background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.2);border-radius:12px;padding:12px;margin-bottom:16px;text-align:left;">
      <div style="color:#38bdf8;font-size:12px;font-weight:700;margin-bottom:4px;">📢 公告</div>
      <div style="color:#94a3b8;font-size:13px;line-height:1.6;">${notice}</div>
    </div>` : "";

    // 即将到期横幅（7天内）
    const expiringBanner = (!disabled && !expired && remainDays <= 7 && remainDays > 0) ? `
    <div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:12px;padding:12px;margin-bottom:16px;text-align:center;">
      <div style="color:#fbbf24;font-size:14px;font-weight:700;">⏰ 订阅将于 ${remainDays} 天后到期</div>
      <div style="color:#94a3b8;font-size:12px;margin-top:4px;">请及时续费以免影响使用</div>
    </div>` : "";

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Maybe 专属节点服务</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); color: #f8fafc; min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 16px; }
    .card { background: rgba(30, 41, 59, 0.9); backdrop-filter: blur(10px); padding: 32px; border-radius: 20px; width: 100%; max-width: 440px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7); border: 1px solid rgba(148, 163, 184, 0.15); }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 16px; }
    .badge-active { background: rgba(74, 222, 128, 0.15); color: #4ade80; border: 1px solid rgba(74, 222, 128, 0.3); }
    .badge-warn { background: rgba(251, 191, 36, 0.15); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); }
    .badge-danger { background: rgba(248, 113, 113, 0.15); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.3); }
    h2 { color: #38bdf8; margin: 0 0 4px 0; font-size: 24px; }
    .subtitle { color: #64748b; font-size: 13px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
    .stat { background: rgba(15, 23, 42, 0.7); padding: 14px; border-radius: 12px; border: 1px solid rgba(148, 163, 184, 0.1); }
    .stat-label { color: #64748b; font-size: 12px; margin-bottom: 4px; }
    .stat-value { color: #f8fafc; font-size: 16px; font-weight: 700; }
    .stat-value.green { color: #4ade80; }
    .stat-value.yellow { color: #fbbf24; }
    .stat-value.red { color: #f87171; }
    .btn { display: block; width: 100%; padding: 14px 0; background: #0284c7; color: #fff; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 15px; margin-bottom: 10px; text-align: center; border: none; cursor: pointer; transition: all 0.2s; }
    .btn:hover { background: #0369a1; transform: translateY(-1px); box-shadow: 0 10px 20px -10px rgba(2, 132, 199, 0.5); }
    .btn-secondary { background: rgba(51, 65, 85, 0.8); }
    .btn-secondary:hover { background: #475569; }
    .btn-renew { background: linear-gradient(135deg, #f59e0b, #d97706); }
    .btn-renew:hover { background: linear-gradient(135deg, #d97706, #b45309); }
    .btn-copy { background: rgba(148, 163, 184, 0.15); }
    .btn-copy:hover { background: rgba(148, 163, 184, 0.25); }
    .qr-box { background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(148, 163, 184, 0.1); border-radius: 12px; padding: 12px; margin-bottom: 10px; }
    .qr-box summary { color: #38bdf8; font-size: 14px; font-weight: 600; cursor: pointer; }
    .progress-box { background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(148, 163, 184, 0.1); border-radius: 12px; padding: 14px; margin-bottom: 16px; }
    .progress-label { display: flex; justify-content: space-between; color: #94a3b8; font-size: 12px; margin-bottom: 8px; }
    .progress-bar { background: rgba(148, 163, 184, 0.15); border-radius: 20px; height: 8px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 20px; transition: width 0.5s ease; }
    .footer { text-align: center; color: #475569; font-size: 12px; margin-top: 16px; }
    .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(100px); background: #0284c7; color: #fff; padding: 10px 20px; border-radius: 10px; font-size: 14px; transition: all 0.3s; opacity: 0; }
    .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge ${disabled ? 'badge-danger' : (expired ? 'badge-warn' : 'badge-active')}">${statusText}</span>
    <h2>🛡️ ${DEFAULT_BRAND} 专属节点</h2>
    <div class="subtitle">订阅编号 · UID-${uid} · ${sourceDesc}</div>
    ${noticeBanner}
    ${expiringBanner}
    <div class="grid">
      <div class="stat">
        <div class="stat-label">📦 套餐</div>
        <div class="stat-value">${plan}</div>
      </div>
      <div class="stat">
        <div class="stat-label">⏰ 到期时间</div>
        <div class="stat-value ${disabled ? 'red' : (expired ? 'yellow' : 'green')}">${expireDate}</div>
      </div>
      <div class="stat">
        <div class="stat-label">📆 剩余时长</div>
        <div class="stat-value ${disabled ? 'red' : (expired ? 'yellow' : 'green')}">${remainDays > 0 ? remainDays + " 天" : (disabled ? "已暂停" : "已过期")}</div>
      </div>
      <div class="stat">
        <div class="stat-label">📅 开通日期</div>
        <div class="stat-value">${createdDate}</div>
      </div>
    </div>
    ${disabled ? "" : `
    <div class="progress-box">
      <div class="progress-label">
        <span>📈 有效期使用进度</span>
        <span style="color:${progressPct > 90 ? '#f87171' : (progressPct > 70 ? '#fbbf24' : '#4ade80')}">${progressPct}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${progressPct}%;background:${progressPct > 90 ? '#f87171' : (progressPct > 70 ? '#fbbf24' : '#4ade80')};"></div>
      </div>
    </div>
    <a class="btn" href="clash://install-config?url=${encodeURIComponent(subUrl)}">📥 一键导入 Clash</a>
    <button class="btn btn-copy" onclick="copyUrl()">📋 复制订阅地址</button>
    <button class="btn btn-copy" onclick="copyYamlUrl()">📄 复制 YAML 订阅</button>
    <button class="btn btn-copy" onclick="copyLegacyUrl()">🔧 复制兼容订阅（旧版客户端）</button>
    <p style="color:#64748b;font-size:11px;text-align:center;margin:-4px 0 10px 0;">YAML 订阅适用于只支持 YAML 导入的客户端；兼容订阅过滤了最新加密协议的节点</p>
    <details class="qr-box">
      <summary>📱 扫码导入（手机端）</summary>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(subUrl)}" alt="订阅二维码" style="width:100%;max-width:200px;border-radius:12px;margin:12px auto;display:block;">
      <p style="color:#64748b;font-size:12px;text-align:center;">用 Clash / Shadowrocket 等客户端扫码即可导入</p>
    </details>
    <details class="qr-box">
      <summary>📖 使用教程</summary>
      <div style="text-align:left;font-size:13px;color:#94a3b8;line-height:1.8;padding:8px 0;">
        <p><b style="color:#38bdf8;">1. Clash 客户端：</b>点上方「一键导入」即可</p>
        <p><b style="color:#38bdf8;">2. 其他客户端：</b>复制订阅地址，在客户端「添加订阅」中粘贴</p>
        <p><b style="color:#38bdf8;">3. 手机扫码：</b>展开「扫码导入」扫二维码</p>
        <p><b style="color:#38bdf8;">4. 到期续费：</b>到期前自动提醒，点续费按钮即可</p>
        <p><b style="color:#38bdf8;">5. 卡密/优惠券：</b>在 @${getStoreBotUsername()} 中兑换</p>
      </div>
    </details>
    `}
    ${expired && !disabled ? `
    <a class="btn btn-renew" href="${renewUrl}">🔄 立即续费</a>
    ` : ""}
    ${!disabled && !expired ? `
    <a class="btn btn-renew" href="${renewUrl}" style="background:rgba(56,189,248,0.15);">🔄 提前续费</a>
    ` : ""}
    <a class="btn btn-secondary" href="${serviceLink}">📩 联系客服</a>
    <div class="footer">AETHERIA Power · ${DEFAULT_BRAND} Cloud · Powered by Cloudflare</div>
  </div>
  <div class="toast" id="toast">✅ 订阅地址已复制</div>
  <script>
    function copyUrl() {
      navigator.clipboard.writeText('${subUrl}');
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
    function copyLegacyUrl() {
      const legacyUrl = '${subUrl}' + (${subUrl.includes('?')} ? '&' : '?') + 'legacy=1';
      navigator.clipboard.writeText(legacyUrl);
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
    function copyYamlUrl() {
      const yamlUrl = '${subUrl}' + (${subUrl.includes('?')} ? '&' : '?') + 'yaml=1';
      navigator.clipboard.writeText(yamlUrl);
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
  </script>
</body>
</html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // 状态校验（客户端访问）
  if (user.status === "disabled") {
    return new Response("【通知】您的服务已被管理员暂停，请联系客服处理。", { status: 403 });
  }
  if (Date.now() > user.expiry) {
    return new Response("【通知】您的服务套餐已过期，请续费后继续使用。", { status: 403 });
  }

  // ===== 场景 B: 客户端访问 -> 智能清洗、去重与缓存下发 =====
  // 兼容模式：?legacy=1 时过滤后量子加密(mlkem768x25519plus)节点，
  // 供旧版 Clash Meta / FlClash 内核（<1.19）使用，避免解析报错
  // YAML 模式：?yaml=1 时返回 Clash YAML 格式（只支持 YAML 导入的客户端）
  const yamlMode = request.url.includes("yaml=1");
  const legacyMode = request.url.includes("legacy=1");
  const cacheKey = `cache_${uid}${legacyMode ? "_legacy" : ""}${yamlMode ? "_yaml" : ""}`;
  const cachedContent = await env.SUB_STORE.get(cacheKey);
  if (cachedContent) {
    return new Response(cachedContent, {
      headers: yamlMode
        ? { "Content-Type": "application/yaml; charset=utf-8", "Access-Control-Allow-Origin": "*", "Profile-Update-Interval": "24" }
        : { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }

  // 合并模式：拉取所有活跃上游的节点；否则单上游分配
  const mergeMode = await isMergeMode(env);
  let nodeLines = [];

  if (mergeMode) {
    // 合并所有上游节点
    const mergedNodes = await fetchAllUpstreamsMerged(env);
    nodeLines = mergedNodes.map(n => n.raw);
    if (nodeLines.length === 0) {
      return new Response("上游池无可用节点，请联系管理员", { status: 502 });
    }
  } else {
    // 获取该用户的上游 URL（专属或从池中分配）
    const effectiveUpstream = await getUpstreamForUser(env, uid, user);
    if (!effectiveUpstream) {
      return new Response("上游池暂无可用源，请联系管理员", { status: 502 });
    }

    const upstreamRes = await fetch(effectiveUpstream, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    if (!upstreamRes.ok) {
      return new Response("上游源异常，请稍后重试", { status: 502 });
    }

    let rawData = await upstreamRes.text();
    let decoded = rawData.trim();

    try {
      let b64 = decoded;
      const pad = 4 - (b64.length % 4);
      if (pad < 4) b64 += "=".repeat(pad);
      decoded = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    } catch (e) {}

    nodeLines = decoded.split("\n");
  }

  const lines = nodeLines;
  const processedNodes = [];
  const seenHosts = new Set();
  const seenRawLines = new Set();
  const counters = { "香港": 1, "日本": 1, "美国": 1, "新加坡": 1, "其他": 1 };
  // 节点黑名单（循环外读取一次）
  const nodeBlacklist = await getNodeBlacklist(env);

  for (let line of lines) {
    line = line.trim();
    if (!line || !line.includes("://")) continue;

    // 兼容模式：跳过后量子加密节点（旧内核不支持 mlkem768x25519plus）
    if (legacyMode && line.includes("mlkem768x25519plus")) continue;

    const parts = line.split("#");
    const basePart = parts[0];
    let origName = parts[1] ? decodeURIComponent(parts[1]) : "Node";

    if (["官网", "测试", "过期", "到期"].some(kw => origName.includes(kw))) continue;
    ["上游", "机场", "aff", "www.", ".com", "TG@"].forEach(w => {
      origName = origName.split(w).join("");
    });

    let region = "其他";
    if (["香港", "HK", "HongKong"].some(k => origName.includes(k))) region = "香港";
    else if (["日本", "JP", "东京"].some(k => origName.includes(k))) region = "日本";
    else if (["美国", "US", "United States"].some(k => origName.includes(k))) region = "美国";
    else if (["新加坡", "SG", "Singapore"].some(k => origName.includes(k))) region = "新加坡";

    let hostKey = basePart;
    try {
      const u = new URL(basePart.includes("://") ? basePart : "http://" + basePart);
      hostKey = u.hostname + ":" + u.port;
    } catch (err) {}

    // 合并模式：所有上游节点全部下发（仅完全相同行去重）
    // 非合并模式：按 host 去重（同一上游内避免重复服务器）
    if (!mergeMode) {
      if (seenHosts.has(hostKey)) continue;
      seenHosts.add(hostKey);
    } else {
      if (seenRawLines.has(line)) continue;
      seenRawLines.add(line);
    }

    // 节点黑名单过滤（管理端禁用的节点）
    if (nodeBlacklist.includes(hostKey)) continue;

    const idx = counters[region]++;
    const formattedName = `${user.brand || DEFAULT_BRAND} · ${region} 0${idx} [UID:${uid}]`;
    // ⚠️ 兼容性关键：Clash Meta / FlClash 等对 # 后节点名只做一次 URL 解码，
    // 若用 encodeURIComponent 全量编码（中文/·/[] 变 %XX），会导致解析失败/名称乱码。
    // 正确做法：仅对空格做 %20 转义（最通用），其余保留 UTF-8 原文。
    const encodedName = formattedName.split(" ").join("%20");
    processedNodes.push(`${basePart}#${encodedName}`);
  }

  const finalOutput = processedNodes.join("\n");

  // ===== YAML 模式：返回 Clash YAML 格式 =====
  if (yamlMode) {
    const yamlContent = generateClashYAML(processedNodes, user.brand || DEFAULT_BRAND, uid);
    await env.SUB_STORE.put(cacheKey, yamlContent, { expirationTtl: 7200 });
    return new Response(yamlContent, {
      headers: {
        "Content-Type": "application/yaml; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Profile-Update-Interval": "24",
        "Subscription-Userinfo": `upload=0; download=0; total=0; expire=${Math.floor(user.expiry / 1000)}`,
        "Cache-Control": "no-store"
      }
    });
  }

  const finalBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(finalOutput)));

  await env.SUB_STORE.put(cacheKey, finalBase64, { expirationTtl: 7200 });

  // 标准订阅响应头（Clash/FlClash 等客户端会读取）：
  // - Subscription-Userinfo: 到期时间/流量（Clash 支持显示）
  // - Profile-Update-Interval: 自动更新间隔（小时）
  const userinfo = `upload=0; download=0; total=0; expire=${Math.floor(user.expiry / 1000)}`;
  return new Response(finalBase64, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Profile-Update-Interval": "24",
      "Subscription-Userinfo": userinfo,
      "Cache-Control": "no-store"
    }
  });
}

// ==================== 模块 1.5: 续费路由 (/renew/{uid}) ====================
async function handleRenewPage(uid, request, env) {
  const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
  if (!userDataStr) {
    return new Response("【错误】订阅不存在或已失效", { status: 404 });
  }
  const user = JSON.parse(userDataStr);
  const chatId = user.chatId;
  const price = await env.SUB_STORE.get("price_info") || "联系客服获取";
  const days = await env.SUB_STORE.get("default_days") || DEFAULT_DAYS;
  const serviceContact = await env.SUB_STORE.get("service_contact") || "";

  // 构造客服链接
  let serviceLink = `tg://resolve?domain=${getStoreBotUsername()}`; // 默认前台 Bot
  if (serviceContact) {
    if (serviceContact.startsWith("@")) {
      serviceLink = `tg://resolve?domain=${serviceContact.replace("@", "")}`;
    } else if (serviceContact.startsWith("http")) {
      serviceLink = serviceContact;
    }
  }

  // 仅当用户已过期或 7 天内到期时才通知管理员（避免还有很长有效期的用户误触）
  // 加防抖：30 分钟内同一 UID 不重复通知
  const remainMs = user.expiry - Date.now();
  const remainDays = remainMs / 86400000;
  const shouldNotify = user.status === "active" && remainDays <= 7;

  if (shouldNotify && chatId) {
    try {
      const lastNotified = await env.SUB_STORE.get(`renew_notify_${uid}`);
      const now = Date.now();
      if (!lastNotified || (now - parseInt(lastNotified)) > 30 * 60 * 1000) {
        const adminMarkup = {
          inline_keyboard: [
            [{ text: "🟢 确认续费 · 开通", callback_data: `approve_renew_${uid}_${chatId}` }],
            [{ text: "❌ 拒绝续费", callback_data: `reject_renew_${uid}_${chatId}` }]
          ]
        };
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: ADMIN_ID,
            text: `🔄 【续费请求】\n• 用户 UID: ${uid}\n• ChatID: \`${chatId}\`\n• 剩余: ${Math.max(0, Math.ceil(remainDays))} 天\n• 请求续费: ${days} 天\n\n请审核后点击按钮：`,
            reply_markup: adminMarkup,
            parse_mode: "Markdown"
          })
        });
        await env.SUB_STORE.put(`renew_notify_${uid}`, now.toString(), { expirationTtl: 1800 });
      }
    } catch (e) {}
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>续费申请</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #0f172a, #1e1b4b); color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: rgba(30, 41, 59, 0.95); padding: 32px; border-radius: 20px; width: 100%; max-width: 420px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7); border: 1px solid rgba(148,163,184,0.15); text-align: center; }
    h2 { color: #fbbf24; margin: 0 0 8px 0; font-size: 24px; }
    .desc { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .info { background: rgba(15,23,42,0.7); padding: 16px; border-radius: 12px; margin-bottom: 24px; text-align: left; font-size: 14px; }
    .info p { margin: 8px 0; color: #94a3b8; }
    .info span { color: #f8fafc; font-weight: 600; }
    .btn { display: block; width: 100%; padding: 14px 0; background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 15px; margin-bottom: 12px; text-align: center; }
    .btn:hover { opacity: 0.9; }
    .btn-secondary { background: rgba(51, 65, 85, 0.8); }
    .note { color: #64748b; font-size: 12px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🔄 续费申请</h2>
    <div class="desc">您的订阅即将到期，请完成续费</div>
    <div class="info">
      <p>• 订阅编号: <span>UID-${uid}</span></p>
      <p>• 续费时长: <span>${days} 天</span></p>
      <p>• 费用: <span>${price}</span></p>
    </div>
    <p>✅ 续费申请已自动提交给管理员！</p>
    <p style="color:#94a3b8; font-size:13px; margin:12px 0;">请前往 Telegram 联系客服完成付款，付款后管理员将立即为您开通。</p>
    <a class="btn btn-secondary" href="${serviceLink}">📩 联系客服</a>
    <a class="btn" href="/s/${uid}">🏠 返回控制台</a>
    <div class="note">AETHERIA Power · 续费工单已生成</div>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ==================== 模块 1.6: 分销推广落地页 (/r/{code}) ====================
async function handleResellerLanding(code, request, env) {
  // 查找分销商（游标分页）
  const resellerKeys = await listAllKeys(env, "reseller_", 2000);
  let reseller = null;
  let resellerKey = null;
  for (const k of resellerKeys) {
    const r = JSON.parse(await env.SUB_STORE.get(k));
    if (r.code === code) {
      reseller = r;
      resellerKey = k;
      break;
    }
  }

  // 记录推广点击（防刷：同 IP 10 分钟内只记一次）
  if (reseller && resellerKey) {
    try {
      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
      const clickKey = `click_${code}_${clientIp}`;
      const lastClick = await env.SUB_STORE.get(clickKey);
      if (!lastClick || (Date.now() - parseInt(lastClick)) > 10 * 60 * 1000) {
        reseller.clicks = (reseller.clicks || 0) + 1;
        await env.SUB_STORE.put(resellerKey, JSON.stringify(reseller));
        await env.SUB_STORE.put(clickKey, Date.now().toString(), { expirationTtl: 600 });
      }
    } catch (e) {}
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${reseller ? reseller.name : "推广链接"} · ${DEFAULT_BRAND} 节点</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #0f172a, #1e1b4b); color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: rgba(30, 41, 59, 0.95); padding: 32px; border-radius: 20px; width: 100%; max-width: 420px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7); border: 1px solid rgba(148,163,184,0.15); text-align: center; }
    .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); margin-bottom: 16px; }
    h2 { color: #38bdf8; margin: 0 0 8px 0; font-size: 24px; }
    .desc { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .btn { display: block; width: 100%; padding: 14px 0; background: linear-gradient(135deg, #0284c7, #0369a1); color: #fff; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 15px; margin-bottom: 12px; text-align: center; }
    .btn:hover { opacity: 0.9; }
    .note { color: #64748b; font-size: 12px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">💰 专属优惠渠道</span>
    <h2>${reseller ? reseller.name : "推广链接"}</h2>
    <div class="desc">由分销商「${reseller ? reseller.name : "未知"}」为您推荐<br>${DEFAULT_BRAND} 高速节点服务</div>
    <a class="btn" href="tg://resolve?domain=${getStoreBotUsername()}&start=${code}">🚀 前往购买 (推荐人: ${reseller ? reseller.name : "—"})</a>
    <a class="btn" href="${getStoreOrigin(request)}">🌐 查看官网</a>
    <div class="note">AETHERIA Power · 优质节点服务</div>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ==================== 模块 2: 前台客服售卖 Bot (/bot/store) ====================
async function handleStoreBot(request, env) {
  try {
    const update = await request.json();

    // 前台 Bot 菜单（定义在顶部供回调使用）
    const storeMenu = {
      keyboard: [
        [{ text: "🛒 购买套餐" }, { text: "🔍 查询订阅" }],
        [{ text: "🎫 兑换卡密" }, { text: "🎁 优惠券" }],
        [{ text: "❓ 常见问题" }, { text: "📞 联系客服" }]
      ],
      resize_keyboard: true,
      persistent: true
    };

    // ===== 前台 Bot 回调处理（套餐选择等）=====
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbChatId = cb.message.chat.id;
      const cbData = cb.data;

      // 取消购买
      if (cbData === "cancel_buy") {
        await answerCallback(STORE_BOT_TOKEN, cb.id, "❌ 已取消");
        try { await deleteTGMessage(STORE_BOT_TOKEN, cbChatId, cb.message.message_id); } catch (e) {}
        return new Response("OK");
      }

      // 选择套餐 → 显示收款码
      if (cbData.startsWith("buyplan_")) {
        const planId = cbData.replace("buyplan_", "");
        const plans = await getPlans(env);
        const plan = plans.find(p => p.id === planId);
        // 多收款码：随机取一张展示
        const displayQR = await getDisplayQR(env);
        const qrFileId = displayQR ? displayQR.fileId : null;

        // 防抖：检查该买家是否有未完成的待审订单（5分钟内），避免重复下单
        try {
          const pendingKeys = await listAllKeys(env, "pending_", 2000);
          const now = Date.now();
          for (const k of pendingKeys) {
            const o = JSON.parse(await env.SUB_STORE.get(k));
            if (o.chatId === cbChatId && (now - (o.time || 0)) < 5 * 60 * 1000) {
              await answerCallback(STORE_BOT_TOKEN, cb.id, "⏳ 您有一笔订单处理中，请先完成支付或等待处理");
              return new Response("OK");
            }
          }
        } catch (e) {}

        await answerCallback(STORE_BOT_TOKEN, cb.id, plan ? `已选 ${plan.name}` : "套餐不存在");

        if (!plan) {
          try { await deleteTGMessage(STORE_BOT_TOKEN, cbChatId, cb.message.message_id); } catch (e) {}
          return new Response("OK");
        }

        if (!qrFileId) {
          await sendTGMenu(STORE_BOT_TOKEN, cbChatId, "⚠️ 系统收款码尚未配置，请联系管理员。", storeMenu);
          return new Response("OK");
        }

        // 频控：同一买家 5 秒内只能下一单，防刷
        if (!(await rateLimit(env, "order", cbChatId, 5))) {
          await answerCallback(STORE_BOT_TOKEN, cb.id, "⏳ 操作太快啦，请稍后再试");
          return new Response("OK");
        }

        // 生成唯一订单号
        const orderId = genOrderId();

        // 发送收款码（检查结果：失败则清理订单，避免买家卡死）
        const photoRes = await fetch(`https://api.telegram.org/bot${STORE_BOT_TOKEN}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: cbChatId,
            photo: qrFileId,
            caption: `💎 【自助下单结算】\n\n• 订单编号: \`${orderId}\`\n• 套餐: ${plan.name} (${plan.days} 天)\n• 金额: ${plan.price}\n\n📌 请扫描上方二维码完成支付\n💬 付款后请直接在此发送【转账截图】\n\n⏰ 请在 30 分钟内完成支付`,
            parse_mode: "Markdown"
          })
        });
        const photoJson = await photoRes.json().catch(() => ({}));
        if (!photoJson.ok) {
          // 收款码发送失败（如 file_id 失效）：
          // 1. 清理已建订单 + 删除套餐选择消息
          // 2. 自动从列表移除失效的收款码（自愈，避免买家反复卡死）
          // 3. 通知管理员重新上传
          try { await env.SUB_STORE.delete(`pending_${orderId}`); } catch (e) {}
          try { await deleteTGMessage(STORE_BOT_TOKEN, cbChatId, cb.message.message_id); } catch (e) {}
          try {
            const qrList = await getPaymentQRs(env);
            const newList = qrList.filter(q => q.fileId !== qrFileId);
            if (newList.length !== qrList.length) {
              await savePaymentQRs(env, newList);
            }
          } catch (e) {}
          await sendTGMenu(STORE_BOT_TOKEN, cbChatId,
            "⚠️ 收款码暂时不可用，请稍后重试或联系客服。", storeMenu);
          try {
            await sendTGText(ADMIN_BOT_TOKEN, ADMIN_ID,
              `⚠️ 【收款码发送失败】\n买家 ChatID: ${cbChatId}\n套餐: ${plan.name}\n\n该收款码可能已失效，已自动移除。\n请用 /qrlist 查看剩余收款码，或 /setqr 重新上传。`);
          } catch (e) {}
          return new Response("OK");
        }

        // 存储待审订单（含套餐信息）
        await env.SUB_STORE.put(`pending_${orderId}`, JSON.stringify({
          chatId: cbChatId,
          orderId,
          time: Date.now(),
          type: "new",
          planId: plan.id,
          planName: plan.name,
          planDays: plan.days,
          planPrice: plan.price
        }), { expirationTtl: 1800 });

        // 通知管理员有新订单
        try {
          await sendTGText(ADMIN_BOT_TOKEN, ADMIN_ID,
            `🛒 【新订单生成】\n• 订单号: ${orderId}\n• 套餐: ${plan.name} (${plan.days}天/${plan.price})\n• 买家 ChatID: ${cbChatId}\n\n等待买家付款后提交截图…`
          );
        } catch (e) {}

        return new Response("OK");
      }

      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    // 仅处理私聊，群组/频道内 @bot 消息忽略（避免 chatId 错用群 ID 导致系统错乱）
    if (msg.chat && msg.chat.type && msg.chat.type !== "private") return new Response("OK");

    const chatId = msg.chat.id;
    let text = msg.text || "";

    // ===== 左侧命令菜单按钮映射（/query /card /coupon /faq /service 等）=====
    // 命令菜单点一下自动发送这些文本，这里转为对应的菜单按钮行为
    const cmdMap = {
      "/query": "🔍 查询订阅",
      "/card": "🎫 兑换卡密",
      "/coupon": "🎁 优惠券",
      "/faq": "❓ 常见问题",
      "/service": "📞 联系客服",
      "/buy": "🛒 购买套餐"
    };
    if (cmdMap[text]) {
      text = cmdMap[text];
    }

    // 处理前台菜单
    if (text === "🛒 购买套餐" || text === "/start" || text === "/buy" || text.includes("购买")) {
      // ===== 分销深链解析：tg://resolve?domain=xxx&start={code} =====
      // 买家通过分销商推广链接进入时，Telegram 会带 start payload
      if (text === "/start") {
        const startPayload = (msg.text || "").split(" ")[1] || "";
        if (startPayload) {
          // 查找分销商并关联该买家
          const resellers = await listAllKeys(env, "reseller_", 2000);
          for (const k of resellers) {
            try {
              const r = JSON.parse(await env.SUB_STORE.get(k));
              if (r.code === startPayload.toUpperCase()) {
                await setBuyerAffiliate(env, chatId, r.code);
                await sendTGText(STORE_BOT_TOKEN, chatId,
                  `🎁 【推荐人已关联】\n您由分销商「${r.name}」推荐！\n购买后分销商将获得相应佣金。`);
                break;
              }
            } catch (e) {}
          }
        }
      }

      const plans = await getPlans(env);
      const displayQR = await getDisplayQR(env);
      const qrFileId = displayQR ? displayQR.fileId : null;

      if (!qrFileId) {
        await sendTGMenu(STORE_BOT_TOKEN, chatId, "⚠️ 系统收款码尚未配置，请联系管理员。", storeMenu);
        return new Response("OK");
      }

      // 检查公告
      const notice = await env.SUB_STORE.get("notice_content");
      if (notice && text === "/start") {
        await sendTGText(STORE_BOT_TOKEN, chatId, `📢 【公告】\n${notice}`);
      }

      // 套餐选择按钮
      const planBtns = [];
      for (const p of plans) {
        planBtns.push([{ text: `📦 ${p.name} (${p.days}天 / ${p.price})`, callback_data: `buyplan_${p.id}` }]);
      }
      planBtns.push([{ text: "❌ 取消", callback_data: "cancel_buy" }]);

      await fetch(`https://api.telegram.org/bot${STORE_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🛒 【选择套餐】\n\n请选择您需要的套餐：`,
          reply_markup: { inline_keyboard: planBtns }
        })
      });
      return new Response("OK");
    }

    // 查询订阅（走 chatId 反向索引，避免全表扫描）
    if (text === "🔍 查询订阅") {
      const uid = await findUidByChatId(env, chatId);
      if (uid) {
        const u = JSON.parse(await env.SUB_STORE.get(`user_${uid}`));
        const remainDays = Math.ceil((u.expiry - Date.now()) / 86400000);
        const stateDesc = u.status === "disabled" ? "🔴 禁用中" : (remainDays <= 0 ? "⏳ 已过期" : "🟢 正常运行");
        await sendTGMenu(STORE_BOT_TOKEN, chatId,
          `📊 【您的订阅信息】\n\n• 订阅编号: \`${uid}\`\n• 状态: ${stateDesc}\n• 剩余: ${Math.max(0, remainDays)} 天\n• 到期: ${new Date(u.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n🔗 管理面板:\n${getStoreOrigin(request)}/s/${uid}`,
          storeMenu);
      } else {
        await sendTGMenu(STORE_BOT_TOKEN, chatId, "❌ 您目前还没有订阅。\n点击下方【🛒 购买套餐】开始！", storeMenu);
      }
      return new Response("OK");
    }

    // 常见问题（FAQ）
    if (text === "❓ 常见问题") {
      const price = (await env.SUB_STORE.get("price_info")) || "联系客服获取";
      const days = (await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS;
      const faqMsg = `❓ 【常见问题】\n\n` +
        `**1. 如何购买？**\n点【🛒 购买套餐】→ 选套餐 → 扫码付款 → 发截图 → 自动开通\n\n` +
        `**2. 如何兑换卡密？**\n点【🎫 兑换卡密】→ 输入卡密 → 秒开通\n\n` +
        `**3. 如何查看我的订阅？**\n点【🔍 查询订阅】即可看到到期时间和状态\n\n` +
        `**4. 怎么导入客户端？**\n打开订阅链接 → 网页控制台 → 一键导入 Clash 或复制订阅地址\n\n` +
        `**5. 套餐价格？**\n${price}\n\n` +
        `**6. 忘记续费过期了？**\n网页控制台点【🔄 立即续费】或联系客服\n\n` +
        `**7. 还有其他问题？**\n点【📞 联系客服】`;
      await sendTGMenu(STORE_BOT_TOKEN, chatId, faqMsg, storeMenu);
      return new Response("OK");
    }

    // 智能 FAQ：自动匹配常见问题关键词（普通咨询时触发）
    if (text && !msg.photo && text.length < 50) {
      const lower = text.toLowerCase();
      const faqMatch = (lower.includes("怎么") || lower.includes("如何") || lower.includes("购买") || lower.includes("价格") || lower.includes("多少钱") || lower.includes("卡密") || lower.includes("兑换") || lower.includes("过期") || lower.includes("续费") || lower.includes("节点") || lower.includes("clash") || lower.includes("订阅"))
        && !["🛒 购买套餐", "🔍 查询订阅", "🎫 兑换卡密", "❓ 常见问题", "📞 联系客服"].includes(text);
      if (faqMatch) {
        const price = (await env.SUB_STORE.get("price_info")) || "联系客服获取";
        await sendTGMenu(STORE_BOT_TOKEN, chatId,
          `💡 【自助解答】\n\n` +
          `• 购买: 点【🛒 购买套餐】选套餐付款即可\n` +
          `• 兑换: 点【🎫 兑换卡密】输入卡密秒开通\n` +
          `• 价格: ${price}\n` +
          `• 导入: 打开订阅链接一键导入 Clash\n\n` +
          `如果以上没有解决您的问题，请点【📞 联系客服】`,
          storeMenu);
        return new Response("OK");
      }
    }

    // 联系客服（显示管理端配置的客服联系方式）
    if (text === "📞 联系客服") {
      const serviceContact = await env.SUB_STORE.get("service_contact") || "";
      if (serviceContact) {
        // 有配置客服：显示可点击的客服入口
        const contactBtn = serviceContact.startsWith("@")
          ? `tg://resolve?domain=${serviceContact.replace("@", "")}`
          : serviceContact;
        await fetch(`https://api.telegram.org/bot${STORE_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `📞 【联系客服】\n\n点击下方按钮即可联系客服：`,
            reply_markup: {
              inline_keyboard: [
                [{ text: "💬 联系客服", url: contactBtn }]
              ]
            }
          })
        });
      } else {
        await sendTGMenu(STORE_BOT_TOKEN, chatId,
          `📞 【联系客服】\n\n如需帮助，请直接在此发送消息或截图，\n管理员会尽快回复您！`,
          storeMenu);
      }
      return new Response("OK");
    }

    // 兑换卡密
    if (text === "🎫 兑换卡密") {
      await env.SUB_STORE.put(`redeem_state_${chatId}`, JSON.stringify({ time: Date.now() }), { expirationTtl: 600 });
      await sendTGMenu(STORE_BOT_TOKEN, chatId,
        `🎫 【卡密兑换】\n\n请发送您的卡密（格式：MB-XXXX-XXXX-XXXX）\n\n兑换后自动开通对应时长的订阅！`,
        storeMenu);
      return new Response("OK");
    }

    // 兑换优惠券
    if (text === "🎁 优惠券") {
      await env.SUB_STORE.put(`coupon_state_${chatId}`, JSON.stringify({ time: Date.now() }), { expirationTtl: 600 });
      await sendTGMenu(STORE_BOT_TOKEN, chatId,
        `🎁 【优惠券兑换】\n\n请发送您的优惠券码（格式：CP-XXXX-XXXX-XXXX）\n\n兑换后自动开通对应时长的订阅！`,
        storeMenu);
      return new Response("OK");
    }

    // 处理优惠券输入（用户处于优惠券状态或直接发 CP- 格式）
    const couponStateStr = await env.SUB_STORE.get(`coupon_state_${chatId}`);
    if ((couponStateStr || /^CP-/.test(text.toUpperCase())) && text.trim()) {
      const cCode = text.trim().toUpperCase();
      const cResult = await redeemCoupon(env, cCode, chatId);
      await env.SUB_STORE.delete(`coupon_state_${chatId}`);
      if (cResult.ok) {
        const origin = getStoreOrigin(request);
        await sendTGMenu(STORE_BOT_TOKEN, chatId,
          `${cResult.msg}！\n\n• 套餐: ${cResult.plan}\n• 时长: ${cResult.days} 天\n\n🔗 专属短链:\n\`${origin}/s/${cResult.uid}\``,
          storeMenu);
        await sendTGText(ADMIN_BOT_TOKEN, ADMIN_ID, `🎁 优惠券兑换成功\n券码: ${cCode}\n买家 ChatID: ${chatId}\nUID: ${cResult.uid}`);
      } else {
        await sendTGMenu(STORE_BOT_TOKEN, chatId, cResult.msg, storeMenu);
      }
      return new Response("OK");
    }

    // 处理卡密输入（用户处于兑换状态或直接发卡密格式）
    const redeemStateStr = await env.SUB_STORE.get(`redeem_state_${chatId}`);
    if ((redeemStateStr || /^MB-/.test(text.toUpperCase())) && text.trim()) {
      const code = text.trim().toUpperCase();
      const result = await redeemCard(env, code, chatId);
      await env.SUB_STORE.delete(`redeem_state_${chatId}`);
      if (result.ok) {
        const origin = getStoreOrigin(request);
        await sendTGMenu(STORE_BOT_TOKEN, chatId,
          `${result.msg}！\n\n• 套餐: ${result.plan}\n• 时长: ${result.days} 天\n\n🔗 专属短链:\n\`${origin}/s/${result.uid}\``,
          storeMenu);
        // 通知管理员
        await sendTGText(ADMIN_BOT_TOKEN, ADMIN_ID, `🎫 卡密兑换成功\n卡密: ${code}\n买家 ChatID: ${chatId}\nUID: ${result.uid}`);
      } else {
        await sendTGMenu(STORE_BOT_TOKEN, chatId, result.msg, storeMenu);
      }
      return new Response("OK");
    }

    // 收款码托管：管理员直接给前台 Bot 发图片 + 配文 /setqr（file_id 天然属于前台 Bot，100% 可用）
    if (msg.photo && (text.includes("/setqr") || text === "🖼️ 设置收款码")) {
      // 仅管理员可操作
      if (msg.from.id !== ADMIN_ID) {
        await sendTGMenu(STORE_BOT_TOKEN, chatId, "❌ 无权限操作", storeMenu);
        return new Response("OK");
      }
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      // 加入多收款码列表
      const list = await addPaymentQR(env, fileId, text.replace("/setqr", "").trim() || undefined);
      await sendTGMenu(STORE_BOT_TOKEN, chatId, `✅ 【收款码已收录】第 ${list.length} 张！\n\n当前共 ${list.length} 张收款码，买家购买时随机展示。`, storeMenu);
      // 通知管理员
      try {
        await sendTGText(ADMIN_BOT_TOKEN, ADMIN_ID, `✅ 收款码已通过前台 Bot 更新！当前共 ${list.length} 张`);
      } catch (e) {}
      return new Response("OK");
    }

    // 处理付款凭证：买家发送【图片/视频/文件】时进入审核流程
    // 普通文字消息（咨询/闲聊）不应触发付款审核
    const hasMedia = !!(msg.photo || msg.video || msg.document);
    if (!hasMedia) {
      // 检查是否处于卡密兑换状态（可能是文字卡密）
      const redeeming = await env.SUB_STORE.get(`redeem_state_${chatId}`);
      if (redeeming || /^MB-/.test(text.toUpperCase())) {
        // 交给卡密处理逻辑（前面已处理，这里兜底返回）
        await sendTGMenu(STORE_BOT_TOKEN, chatId, "🎫 请输入有效的卡密（格式：MB-XXXX-XXXX-XXXX）", storeMenu);
        return new Response("OK");
      }

      // 付款意图识别：买家说"付了/已付款/转账了/发截图"等 → 引导发截图
      const payKeywords = ["付了", "付款", "支付", "转账", "截图", "已付", "扫码付", "发了"];
      const isPayIntent = payKeywords.some(k => text.includes(k));
      if (isPayIntent) {
        await sendTGMenu(STORE_BOT_TOKEN, chatId,
          `📌 【提交付款凭证】\n\n请直接发送您的【转账截图/付款凭证图片】！\n\n系统会自动提交给管理员审核，审核通过后立即开通订阅。\n\n（如果已经发过截图，请耐心等待审核）`,
          storeMenu);
        return new Response("OK");
      }

      // 普通咨询消息 → 引导使用菜单，不触发审核
      await sendTGMenu(STORE_BOT_TOKEN, chatId,
        `💬 收到您的消息！\n\n如需帮助请使用下方菜单：\n🛒 购买套餐 / 🔍 查询订阅 / 🎫 兑换卡密 / 📞 联系客服\n\n📌 温馨提示：付款成功后，请直接发送【转账截图/付款凭证图片】，系统会自动提交审核。`,
        storeMenu);
      return new Response("OK");
    }

    // ===== 以下仅处理带媒体的消息（付款凭证审核流程）=====
    // 防重复提交：30 秒内同一买家只能提交一次凭证，避免刷屏管理员
    if (!(await rateLimit(env, "proof", chatId, 30))) {
      await sendTGMenu(STORE_BOT_TOKEN, chatId, "⏳ 凭证已提交，请耐心等待审核（30秒内请勿重复发送）", storeMenu);
      return new Response("OK");
    }

    const buyerName = msg.from.first_name || "用户";
    const buyerUsername = msg.from.username ? `@${msg.from.username}` : "无";

    // 尝试匹配该买家的最近待审订单（取最新一笔），获取套餐信息
    let orderInfo = null;
    try {
      const orderKeys = await listAllKeys(env, "pending_", 1000);
      let newestTime = 0;
      for (const k of orderKeys) {
        const o = JSON.parse(await env.SUB_STORE.get(k));
        if (o.chatId === chatId && (o.time || 0) > newestTime) {
          orderInfo = o;
          newestTime = o.time || 0;
        }
      }
    } catch (e) {}

    const forwardRes = await fetch(`https://api.telegram.org/bot${STORE_BOT_TOKEN}/forwardMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_ID,
        from_chat_id: chatId,
        message_id: msg.message_id
      })
    });
    const forwardJson = await forwardRes.json().catch(() => ({}));
    const forwardOk = forwardJson.ok === true;

    // 如果转发失败（例如消息类型特殊），尝试直接发送图片/文本副本
    if (!forwardOk && msg.photo) {
      try {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await fetch(`https://api.telegram.org/bot${STORE_BOT_TOKEN}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: ADMIN_ID,
            photo: fileId,
            caption: `📸 付款凭证副本\n• 买家: ${buyerName} (${buyerUsername})\n• ChatID: ${chatId}`
          })
        });
      } catch (e) {}
    }

    const replyMarkup = {
      inline_keyboard: [
        [
          // 回调带上订单号，确认时精确匹配对应订单，避免多订单混淆
          { text: "🟢 确认到账 · 一键开通", callback_data: `approve_${chatId}_${orderInfo ? orderInfo.orderId : "0"}` },
          { text: "⏳ 稍后处理", callback_data: "later" }
        ]
      ]
    };

    // 通知管理员（含订单/套餐信息）
    const orderLine = orderInfo
      ? `• 订单号: ${orderInfo.orderId || "—"}\n• 套餐: ${orderInfo.planName || "默认"} (${orderInfo.planDays || "?"}天 / ${orderInfo.planPrice || "?"})\n`
      : "";
    await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_ID,
        text: `📦 【收到新付款凭证】\n• 买家: ${buyerName}\n• 用户名: ${buyerUsername}\n• ChatID: \`${chatId}\`\n${orderLine}\n${forwardOk ? "📎 凭证截图已转发到前台 Bot 会话" : "⚠️ 截图转发失败，请查看前台 Bot 会话"}\n\n请审核后点击下方按钮：`,
        reply_markup: replyMarkup,
        parse_mode: "Markdown"
      })
    });

    await sendTGMenu(STORE_BOT_TOKEN, chatId, "📩 凭证已成功提交给管理员，请稍候！", storeMenu);
    return new Response("OK");
  } catch (err) {
    return new Response("OK");
  }
}

// ==================== 模块 3: 后台管理控制 Bot (/bot/admin) ====================
// 主菜单
const MAIN_MENU = {
  keyboard: [
    [{ text: "👥 用户管理" }, { text: "📦 订单管理" }],
    [{ text: "🎫 卡密管理" }, { text: "📊 系统概览" }],
    [{ text: "⚙️ 系统设置" }, { text: "📣 群发通知" }],
    [{ text: "💰 分销系统" }, { text: "📜 操作日志" }],
    [{ text: "❓ 帮助说明" }]
  ],
  resize_keyboard: true,
  persistent: true
};

// 到期提醒扫描（Cron 调用）
async function checkExpiringSubscriptions(env) {
  const userKeys = await listAllKeys(env, "user_", 10000);
  const now = Date.now();
  const day = 86400000;
  // Cron 场景没有 request，续费链接用 env 配置的门户地址（STORE_ORIGIN 为空时用空链接提示）
  const originBase = STORE_ORIGIN || "";

  for (const k of userKeys) {
    const uid = k.replace("user_", "");
    const u = JSON.parse(await env.SUB_STORE.get(k));
    if (u.status !== "active") continue;
    if (!u.chatId) continue;

    const remainMs = u.expiry - now;
    const remainDays = Math.ceil(remainMs / day);

    for (const remindDay of REMINDER_DAYS) {
      if (remainDays === remindDay) {
        const lastNotified = u.lastNotified || {};
        if (lastNotified[`d${remindDay}`]) continue;

        // 通知买家（通过前台 bot）
        if (remindDay > 0) {
          await sendTGText(STORE_BOT_TOKEN, u.chatId,
            `⏰ 【到期提醒】\n您的订阅将于 ${remindDay} 天后到期！\n\n请及时续费以免影响使用。\n\n📱 快速续费: ${originBase}/renew/${uid}`
          );
        } else {
          await sendTGText(STORE_BOT_TOKEN, u.chatId,
            `⏰ 【到期提醒】\n您的订阅今天到期！\n\n请尽快续费以免服务中断。\n\n📱 快速续费: ${originBase}/renew/${uid}`
          );
        }

        // 通知管理员
        await sendTGText(ADMIN_BOT_TOKEN, ADMIN_ID,
          `⏰ 【到期提醒】\n用户 UID:${uid} (ChatID:${u.chatId})\n剩余 ${remindDay} 天到期，已通知买家。`
        );

        // 记录已通知
        lastNotified[`d${remindDay}`] = now;
        u.lastNotified = lastNotified;
        await env.SUB_STORE.put(k.name, JSON.stringify(u));
        break;
      }
    }
  }
}

async function handleAdminBot(request, env) {
  try {
    const update = await request.json();

    // ========== 回调按钮处理 ==========
    if (update.callback_query) {
      const cb = update.callback_query;
      if (cb.from.id !== ADMIN_ID) return new Response("OK");

      const chatId = cb.message.chat.id;
      const data = cb.data;
      let replyAlert = "";
      let replyText = "";
      let replyMarkup = null;

      // ===== 续费专用回调：确认续费 / 拒绝续费 =====
      // 格式：approve_renew_{uid}_{chatId} / reject_renew_{uid}_{chatId}
      if (data.startsWith("approve_renew_")) {
        const rparts = data.replace("approve_renew_", "").split("_");
        const rUid = rparts[0];
        const rChatId = rparts.slice(1).join("_");
        const rUserStr = await env.SUB_STORE.get(`user_${rUid}`);
        if (!rUserStr) {
          replyText = `❌ 用户 UID:${rUid} 不存在`;
        } else {
          const ru = JSON.parse(rUserStr);
          const days = parseInt(await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS;
          const prevExpiry = ru.expiry;
          const base = Math.max(ru.expiry, Date.now());
          ru.expiry = base + (days * 86400000);
          ru.status = "active";
          await env.SUB_STORE.put(`user_${rUid}`, JSON.stringify(ru));

          const rOrderId = "RENEW-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
          // 记流水
          const rKey = `record_${Date.now()}`;
          await env.SUB_STORE.put(rKey, JSON.stringify({
            orderId: rOrderId,
            chatId: ru.chatId || rChatId,
            plan: `${days} 天续费`,
            days,
            price: await env.SUB_STORE.get("price_info") || "",
            time: Date.now(),
            uid: rUid,
            type: "renew"
          }), { expirationTtl: 15552000 });

          // 保存撤销记录（同一订单号，撤销时删对应流水）
          await env.SUB_STORE.put(`revoke_${cb.message.message_id}`, JSON.stringify({
            uid: rUid,
            chatId: ru.chatId || rChatId,
            prevExpiry,
            isNew: false,
            days,
            orderId: rOrderId,
            time: Date.now()
          }), { expirationTtl: 86400 });

          await logAction(env, "确认续费", `UID:${rUid} +${days}天 (续费请求)`);

          // 通知买家
          try {
            const origin = new URL(request.url).origin;
            await sendTGText(STORE_BOT_TOKEN, ru.chatId || rChatId,
              `🎉 【续费成功】\n您的续费请求已通过！\n\n• 时长: ${days} 天\n• 到期: ${new Date(ru.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n🔗 ${origin}/s/${rUid}`);
          } catch (e) {}

          replyAlert = `✅ 续费已确认！UID:${rUid} (+${days}天)`;

          // 编辑管理端消息：标记已处理 + 撤销按钮（不设 replyText，避免通用逻辑二次编辑）
          try {
            const markup = {
              inline_keyboard: [
                [{ text: "↩️ 撤销此操作", callback_data: `revoke_${cb.message.message_id}` }]
              ]
            };
            await editTGMessage(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id,
              `✅ 【续费已处理】\nUID: ${rUid}\n时长: +${days} 天\n\n如需撤销请点击下方按钮。`,
              markup);
          } catch (e) {}
        }
      }

      // 拒绝续费
      else if (data.startsWith("reject_renew_")) {
        const rparts = data.replace("reject_renew_", "").split("_");
        const rUid = rparts[0];
        const rChatId = rparts.slice(1).join("_");
        const rUserStr = await env.SUB_STORE.get(`user_${rUid}`);
        if (!rUserStr) {
          replyText = `❌ 用户 UID:${rUid} 不存在`;
        } else {
          const ru = JSON.parse(rUserStr);
          // 通知买家续费被拒绝
          try {
            await sendTGText(STORE_BOT_TOKEN, ru.chatId || rChatId,
              `❌ 【续费被拒绝】\n很抱歉，您的续费请求被管理员拒绝了。\n\n如有疑问请联系客服。`);
          } catch (e) {}
          await logAction(env, "拒绝续费", `UID:${rUid} ChatID:${ru.chatId || rChatId}`);
          replyAlert = `❌ 已拒绝用户 [${rUid}] 的续费请求，已通知买家。`;
          // 编辑管理端消息标记已处理
          try {
            await editTGMessage(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id,
              `❌ 【续费已拒绝】\nUID: ${rUid} 的续费请求已被拒绝。\n\n已通知买家。`,
              null);
          } catch (e) {}
        }
      }

      // 确认到账 → 开通（区分新购/续费）
      // 幂等保护：每个凭证通知消息只处理一次，防止重复点击重复加天数
      // 回调格式：approve_{chatId}_{orderId}（orderId 可选，兼容旧按钮）
      else if (data.startsWith("approve_")) {
        const parts = data.split("_");
        const targetChatId = parts[1];
        const approveOrderId = parts.slice(2).join("_") || null; // 订单号可能含特殊字符，用 join 保留
        const targetChatIdNum = parseInt(targetChatId);
        const defaultUpstream = await getDefaultUpstream(env);

        // 读取该买家的待审订单（优先精确匹配回调带上的订单号，其次取最新一笔）
        let orderPlan = null;
        try {
          const orderKeys = await listAllKeys(env, "pending_", 1000);
          let newestTime = 0;
          for (const k of orderKeys) {
            const o = JSON.parse(await env.SUB_STORE.get(k));
            if (o.chatId === targetChatIdNum) {
              if (approveOrderId && approveOrderId !== "0" && o.orderId === approveOrderId) {
                orderPlan = o; // 精确匹配
                break;
              }
              if (!approveOrderId || approveOrderId === "0") {
                if ((o.time || 0) > newestTime) {
                  orderPlan = o; // 取最新一笔
                  newestTime = o.time || 0;
                }
              }
            }
          }
        } catch (e) {}

        const days = orderPlan && orderPlan.planDays
          ? orderPlan.planDays
          : (parseInt(await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS);
        const planLabel = orderPlan && orderPlan.planName
          ? `${orderPlan.planName} (${orderPlan.planPrice || ""})`
          : `${days} 天套餐`;

        // 幂等检查：该通知消息是否已处理过
        const processedKey = `processed_${cb.message.message_id}`;
        const alreadyProcessed = await env.SUB_STORE.get(processedKey);
        if (alreadyProcessed) {
          replyAlert = "⚠️ 该凭证已被处理过了，请勿重复操作！";
        } else if (!defaultUpstream) {
          replyAlert = "❌ 错误：请先在管理端配置默认上游链接！";
        } else {
          // 标记已处理（防重复）
          await env.SUB_STORE.put(processedKey, JSON.stringify({ chatId: targetChatId, time: Date.now() }), { expirationTtl: 86400 });

          // 检查该 ChatID 是否已有订阅（续费场景）——走索引
          const existingUid = await findUidByChatId(env, targetChatIdNum);

          let finalUid;
          let prevExpiry = null;
          if (existingUid) {
            // 续费：延长已有订阅
            const existing = JSON.parse(await env.SUB_STORE.get(`user_${existingUid}`));
            prevExpiry = existing.expiry;
            const base = Math.max(existing.expiry, Date.now());
            existing.expiry = base + (days * 86400000);
            existing.status = "active";
            if (orderPlan) existing.plan = planLabel;
            await env.SUB_STORE.put(`user_${existingUid}`, JSON.stringify(existing));
            finalUid = existingUid;
          } else {
            // 新购：创建新订阅（唯一 UID）
            const newUid = await genUniqueUid(env);
            finalUid = newUid;
            const expiry = Date.now() + (days * 86400000);
            await env.SUB_STORE.put(`user_${newUid}`, JSON.stringify({
              upstreamUrl: defaultUpstream,
              expiry,
              status: "active",
              brand: DEFAULT_BRAND,
              chatId: targetChatIdNum,
              createdAt: Date.now(),
              plan: planLabel
            }));
            await indexUserChatId(env, targetChatIdNum, newUid); // 写 chatId 索引
          }

          // 记录订单流水
          if (orderPlan) {
            const recordKey = `record_${Date.now()}`;
            const record = {
              orderId: orderPlan.orderId || genOrderId(),
              chatId: targetChatIdNum,
              plan: planLabel,
              days,
              price: orderPlan.planPrice || "",
              time: Date.now(),
              uid: finalUid,
              type: existingUid ? "renew" : "new"
            };
            await env.SUB_STORE.put(recordKey, JSON.stringify(record), { expirationTtl: 15552000 });

            // 清理该笔待审订单（避免脏数据）
            try { await env.SUB_STORE.delete(`pending_${orderPlan.orderId}`); } catch (e) {}

            // 分销佣金结算（分销商推荐购买的订单）
            await creditReseller(env, targetChatIdNum, orderPlan.planPrice);
          }

          // 保存操作前的状态，供撤销使用（含订单号，撤销时删对应流水）
          await env.SUB_STORE.put(`revoke_${cb.message.message_id}`, JSON.stringify({
            uid: finalUid,
            chatId: targetChatIdNum,
            prevExpiry: prevExpiry,
            isNew: !existingUid,
            days,
            orderId: orderPlan ? orderPlan.orderId : null,
            time: Date.now()
          }), { expirationTtl: 86400 });

          await logAction(env, existingUid ? "确认续费" : "确认发货", `UID:${finalUid} ChatID:${targetChatId} ${planLabel} ${days}天`);

          const origin = new URL(request.url).origin;
          const subLink = `${origin}/s/${finalUid}`;

          await sendTGText(STORE_BOT_TOKEN, targetChatId,
            existingUid
              ? `🎉 【续费成功】\n您的订阅已成功续费！\n\n• 套餐: ${planLabel}\n• 时长: ${days} 天\n\n🔗 专属短链:\n\`${subLink}\`\n\n服务有效期已延长，感谢支持！`
              : `🎉 【订单审核通过】\n您的专属订阅已开通完成！\n\n• 套餐: ${planLabel}\n• 时长: ${days} 天\n\n🔗 专属短链:\n\`${subLink}\`\n\n📌 点击链接可打开网页控制台，也可直接导入客户端。`
          );

          replyAlert = existingUid
            ? `✅ 续费成功！UID: ${finalUid} (+${days}天)`
            : `✅ 已成功发货！分配 UID: ${finalUid} (${days}天)`;

          // 更新通知消息：标记已处理，并附加撤销按钮
          try {
            const markup = {
              inline_keyboard: [
                [
                  { text: "🟢 确认到账 · 一键开通", callback_data: `approve_${targetChatId}_${approveOrderId || "0"}` },
                  { text: "⏳ 稍后处理", callback_data: "later" }
                ],
                [
                  { text: "↩️ 撤销此操作", callback_data: `revoke_${cb.message.message_id}` }
                ]
              ]
            };
            await editTGMessage(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id,
              `✅ 【已处理】该凭证已确认到账，订阅已开通。\n\nUID: ${finalUid}\n买家 ChatID: ${targetChatId}\n套餐: ${planLabel}\n时长: ${days} 天\n\n如需撤销请点击下方按钮。`,
              markup);
          } catch (e) {}
        }
      } else if (data === "later") {
        replyText = "⏳ 已标记【稍后处理】\n\n此凭证暂不处理，您可稍后直接点下方【确认到账】按钮。";
        replyMarkup = null; // 保留原按钮
      }

      // 撤销删除用户操作
      else if (data.startsWith("revoke_del_")) {
        const dId = data.replace("revoke_del_", "");
        const dStr = await env.SUB_STORE.get(`revoke_del_${dId}`);
        if (!dStr) {
          replyText = "❌ 撤销记录不存在或已过期（24小时）";
        } else {
          const d = JSON.parse(dStr);
          // 恢复用户数据
          await env.SUB_STORE.put(`user_${d.uid}`, JSON.stringify(d.data));
          await indexUserChatId(env, d.data.chatId, d.uid); // 恢复 chatId 索引
          await env.SUB_STORE.delete(`revoke_del_${dId}`);
          replyText = `↩️ 已恢复！用户 UID:${d.uid} 已还原`;
        }
      }

      // 撤销手动开卡操作
      else if (data.startsWith("revoke_manual_")) {
        const mId = data.replace("revoke_manual_", "");
        const mStr = await env.SUB_STORE.get(`revoke_manual_${mId}`);
        if (!mStr) {
          replyText = "❌ 撤销记录不存在或已过期（24小时）";
        } else {
          const m = JSON.parse(mStr);
          // 删除该用户
          const userDataStr = await env.SUB_STORE.get(`user_${m.uid}`);
          if (!userDataStr) {
            replyText = `❌ 用户 UID:${m.uid} 不存在或已删除`;
          } else {
            const mUser = JSON.parse(userDataStr);
            await env.SUB_STORE.delete(`user_${m.uid}`);
            await clearUserCache(env, m.uid);
            await unindexUserChatId(env, mUser.chatId); // 清理 chatId 索引
            // 通知买家
            try {
              await sendTGText(STORE_BOT_TOKEN, m.chatId,
                `⚠️ 【开通已撤销】\n管理员撤销了刚才的开通操作。\n如您已付款请联系客服核实。`
              );
            } catch (e) {}
            await env.SUB_STORE.delete(`revoke_manual_${mId}`);
            replyText = `↩️ 已撤销！用户 UID:${m.uid} 已删除`;
          }
        }
      }

      // 撤销调整时长操作
      else if (data.startsWith("revoke_adjust_")) {
        const adjId = data.replace("revoke_adjust_", "");
        const adjStr = await env.SUB_STORE.get(`revoke_adjust_${adjId}`);
        if (!adjStr) {
          replyText = "❌ 撤销记录不存在或已过期（24小时）";
        } else {
          const adj = JSON.parse(adjStr);
          const userDataStr = await env.SUB_STORE.get(`user_${adj.uid}`);
          if (!userDataStr) {
            replyText = `❌ 用户 UID:${adj.uid} 不存在`;
          } else {
            const u = JSON.parse(userDataStr);
            u.expiry = adj.prevExpiry;
            await env.SUB_STORE.put(`user_${adj.uid}`, JSON.stringify(u));
            // 删除撤销记录，防止重复撤销
            await env.SUB_STORE.delete(`revoke_adjust_${adjId}`);
            replyText = `↩️ 已撤销！UID:${adj.uid} 已恢复原到期时间`;
          }
        }
      }

      // 撤销操作：撤销误点的确认到账（使用记录的操作前状态精确恢复）
      else if (data.startsWith("revoke_")) {
        const msgId = data.replace("revoke_", "");
        const revokeStr = await env.SUB_STORE.get(`revoke_${msgId}`);
        if (!revokeStr) {
          replyText = "❌ 撤销记录不存在或已过期（24小时）";
        } else {
          const rev = JSON.parse(revokeStr);
          const userDataStr = await env.SUB_STORE.get(`user_${rev.uid}`);
          if (!userDataStr) {
            replyText = `❌ 用户 UID:${rev.uid} 不存在`;
          } else {
            if (rev.isNew) {
              // 新购撤销：删除该用户
              await env.SUB_STORE.delete(`user_${rev.uid}`);
              await clearUserCache(env, rev.uid);
              await unindexUserChatId(env, rev.chatId); // 清理 chatId 索引
              // 通知买家
              await sendTGText(STORE_BOT_TOKEN, rev.chatId,
                `⚠️ 【开通已撤销】\n管理员撤销了刚才的开通操作。\n如您已付款请联系客服核实。`
              );
              replyText = `↩️ 已撤销！新用户 UID:${rev.uid} 已删除`;
            } else {
              // 续费撤销：恢复操作前 expiry
              const u = JSON.parse(userDataStr);
              u.expiry = rev.prevExpiry;
              await env.SUB_STORE.put(`user_${rev.uid}`, JSON.stringify(u));
              // 通知买家
              await sendTGText(STORE_BOT_TOKEN, rev.chatId,
                `⚠️ 【续费已撤销】\n管理员撤销了刚才的续费操作，订阅时长已恢复。\n如您已付款请联系客服核实。`
              );
              replyText = `↩️ 已撤销！UID:${rev.uid} 已恢复原到期时间`;
            }
            // 撤销时同步删除对应的订单流水，保证账实一致
            if (rev.orderId) {
              try {
                const recKeys = await listAllKeys(env, "record_", 2000);
                for (const rk of recKeys) {
                  try {
                    const r = JSON.parse(await env.SUB_STORE.get(rk));
                    if (r.orderId === rev.orderId) {
                      await env.SUB_STORE.delete(rk);
                      break;
                    }
                  } catch (e) {}
                }
              } catch (e) {}
            }
            // 删除撤销记录，防止重复撤销
            await env.SUB_STORE.delete(`revoke_${msgId}`);
          }
        }
      }

      // 撤销删除：从最近的删除记录恢复
      else if (data.startsWith("undel_")) {
        const uid = data.replace("undel_", "");
        // 查找该用户的最近删除记录（游标分页）
        const delKeys = await listAllKeys(env, "revoke_del_", 2000);
        let found = false;
        for (const k of delKeys) {
          const d = JSON.parse(await env.SUB_STORE.get(k));
          if (d.uid === uid) {
            await env.SUB_STORE.put(`user_${uid}`, JSON.stringify(d.data));
            await indexUserChatId(env, d.data.chatId, uid); // 恢复索引
            await env.SUB_STORE.delete(k);
            found = true;
            break;
          }
        }
        if (found) {
          replyText = `↩️ 用户 [${uid}] 已恢复！\n\n订阅数据已还原。`;
          replyMarkup = { inline_keyboard: [[{ text: "🔴 禁用", callback_data: `disable_${uid}` }]] };
        } else {
          replyText = `❌ 未找到该用户的删除记录（可能超过24小时）`;
        }
      }

      // 用户管理：禁用/启用/删除
      else if (data.startsWith("disable_") || data.startsWith("enable_") || data.startsWith("del_")) {
        const [action, uid] = data.split("_");
        const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
        if (!userDataStr) {
          replyAlert = `❌ 用户 UID:${uid} 不存在`;
        } else {
          let u = JSON.parse(userDataStr);
          if (action === "disable") {
            u.status = "disabled";
            await env.SUB_STORE.put(`user_${uid}`, JSON.stringify(u));
            await logAction(env, "禁用用户", `UID:${uid} ChatID:${u.chatId || "-"}`);
            replyText = `🔴 用户 [${uid}] 已禁用！\n\n订阅将立即停止服务。`;
            replyMarkup = { inline_keyboard: [[{ text: "🟢 重新开启", callback_data: `enable_${uid}` }]] };
          } else if (action === "enable") {
            u.status = "active";
            await env.SUB_STORE.put(`user_${uid}`, JSON.stringify(u));
            await logAction(env, "启用用户", `UID:${uid} ChatID:${u.chatId || "-"}`);
            replyText = `🟢 用户 [${uid}] 已激活！\n\n服务已恢复。`;
            replyMarkup = { inline_keyboard: [[{ text: "🔴 禁用", callback_data: `disable_${uid}` }]] };
          } else if (action === "del") {
            // 保存删除前的数据，供撤销恢复
            const delId = Date.now();
            await env.SUB_STORE.put(`revoke_del_${delId}`, JSON.stringify({
              uid,
              data: JSON.parse(userDataStr),
              time: Date.now()
            }), { expirationTtl: 86400 });
            await env.SUB_STORE.delete(`user_${uid}`);
            await clearUserCache(env, uid);
            await unindexUserChatId(env, u.chatId); // 清理 chatId 索引
            await logAction(env, "删除用户", `UID:${uid} ChatID:${u.chatId || "-"}`);
            replyText = `🗑️ 用户 [${uid}] 已删除！\n\n如需恢复请点击下方按钮：`;
            replyMarkup = { inline_keyboard: [[{ text: "↩️ 恢复用户", callback_data: `undel_${uid}` }]] };
          }
        }
      }

      // 用户列表翻页（游标分页取全量）
      else if (data.startsWith("ulist_")) {
        const page = parseInt(data.replace("ulist_", "")) || 1;
        const userKeys = await listAllKeys(env, "user_", 10000);
        const allUsers = userKeys.map(k => k.replace("user_", ""));
        const totalPages = Math.max(1, Math.ceil(allUsers.length / 5));
        const start = (page - 1) * 5;
        const pageUsers = allUsers.slice(start, start + 5);

        let listText = `👥 【用户列表】 (第 ${page}/${totalPages} 页)\n\n`;
        const rows = [];
        for (const uid of pageUsers) {
          const u = JSON.parse(await env.SUB_STORE.get(`user_${uid}`));
          const remainDays = Math.ceil((u.expiry - Date.now()) / 86400000);
          const state = u.status === "disabled" ? "🔴" : (remainDays <= 0 ? "⏳" : "🟢");
          listText += `${state} UID:${uid} | 剩 ${Math.max(0, remainDays)} 天${u.note ? ` | 📝${u.note.slice(0, 10)}` : ""}\n`;
          // 每个用户一行操作按钮：详情 / 禁用(或启用) / 删除
          rows.push([
            { text: `📋 ${uid}`, callback_data: `check_${uid}` },
            { text: u.status === "disabled" ? "🟢 启用" : "🔴 禁用", callback_data: `${u.status === "disabled" ? "enable" : "disable"}_${uid}` },
            { text: "🗑️ 删除", callback_data: `del_${uid}` }
          ]);
        }

        const navBtns = [];
        if (page > 1) navBtns.push({ text: "◀️ 上一页", callback_data: `ulist_${page - 1}` });
        if (page < totalPages) navBtns.push({ text: "下一页 ▶️", callback_data: `ulist_${page + 1}` });
        if (navBtns.length) rows.push(navBtns);

        replyText = listText;
        replyMarkup = { inline_keyboard: rows };
      }

      // 用户详情（从列表进入）
      else if (data.startsWith("check_")) {
        const checkUid = data.replace("check_", "");
        const checkStr = await env.SUB_STORE.get(`user_${checkUid}`);
        if (!checkStr) {
          replyAlert = `❌ 用户 UID:${checkUid} 不存在`;
        } else {
          const cu = JSON.parse(checkStr);
          const remainDays = Math.ceil((cu.expiry - Date.now()) / 86400000);
          const stateDesc = cu.status === "disabled" ? "🔴 禁用中" : (remainDays <= 0 ? "⏳ 已过期" : "🟢 正常运行");
          const origin = new URL(request.url).origin;
          const upStatus = cu.upstreamUrl ? `🎯 已指定:\n${cu.upstreamUrl.slice(0, 50)}` : "🔄 自动分配";
          replyText = `📊 【用户档案: ${checkUid}】\n• 状态: ${stateDesc}\n• 剩余: ${Math.max(0, remainDays)} 天\n• 到期: ${new Date(cu.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n• ChatID: ${cu.chatId || "-"}\n${cu.note ? `• 备注: ${cu.note}\n` : ""}• 上游: ${upStatus}\n• 短链: ${origin}/s/${checkUid}`;
          replyMarkup = {
            inline_keyboard: [
              [
                { text: "🔴 禁用", callback_data: `disable_${checkUid}` },
                { text: "🟢 开启", callback_data: `enable_${checkUid}` },
                { text: "🗑️ 删除", callback_data: `del_${checkUid}` }
              ],
              [
                { text: "🎯 分配上游", callback_data: `assign_${checkUid}` },
                { text: "↩️ 撤销删除", callback_data: `undel_${checkUid}` }
              ],
              [{ text: "◀️ 返回列表", callback_data: "ulist_1" }]
            ]
          };
        }
      }

      // 用户选择器回调：pick_{mode}_{uid}
      // mode: adjust(调整时长) / assign(分配上游) / note(备注) / msg(私信) / del(删除)
      else if (data.startsWith("pick_")) {
        const pickStr = data.replace("pick_", "");
        const mode = pickStr.split("_")[0];
        const pickUid = pickStr.slice(mode.length + 1);
        const pickUserStr = await env.SUB_STORE.get(`user_${pickUid}`);
        if (!pickUserStr) {
          replyAlert = `❌ 用户 UID:${pickUid} 不存在`;
        } else {
          if (mode === "adjust") {
            // 调整时长：进入输入天数
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "adjust_days", uid: pickUid, chatId }));
            replyText = `⏱️ 【调整时长】\nUID:${pickUid}\n\n请输入调整天数：\n• 正数加时长（如 30）\n• 负数减时长（如 -30）\n• 直接设置到期：如 set 30 天`;
            replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
          } else if (mode === "assign") {
            // 分配上游：显示上游池选择
            const pu = JSON.parse(pickUserStr);
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "assign_up", uid: pickUid, chatId }));
            const pool = await getUpstreamPool(env);
            const btns = [];
            pool.forEach((up, i) => {
              if (up.status !== "active") return;
              btns.push([{ text: `${up.isDefault ? "⭐" : ""} ${up.note || "上游" + (i + 1)}`, callback_data: `assignup_${i}` }]);
            });
            btns.push([{ text: "↩️ 恢复自动分配", callback_data: `assignup_auto` }]);
            btns.push([{ text: "❌ 取消", callback_data: "cancel_action" }]);
            const currentUp = pu.upstreamUrl ? "（已指定）" : "（自动分配）";
            replyText = `🎯 【分配上游】\n用户 UID: ${pickUid} ${currentUp}\n\n请选择要分配的上游：`;
            replyMarkup = { inline_keyboard: btns };
          } else if (mode === "note") {
            // 备注：进入输入备注
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "note_text", uid: pickUid, chatId }));
            replyText = `📝 【用户备注】\nUID:${pickUid}\n\n请输入备注内容（如：VIP老客户）：`;
            replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
          } else if (mode === "msg") {
            // 私信：进入输入消息
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "msg_text", uid: pickUid, chatId }));
            replyText = `💬 【私信用户】\nUID:${pickUid}\n\n请输入要发送的消息内容：`;
            replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
          } else if (mode === "del") {
            // 删除：保存快照后删除 + 可恢复
            const du = JSON.parse(pickUserStr);
            const delId = Date.now();
            await env.SUB_STORE.put(`revoke_del_${delId}`, JSON.stringify({
              uid: pickUid,
              data: JSON.parse(pickUserStr),
              time: Date.now()
            }), { expirationTtl: 86400 });
            await env.SUB_STORE.delete(`user_${pickUid}`);
            await clearUserCache(env, pickUid);
            await unindexUserChatId(env, du.chatId);
            await logAction(env, "删除用户", `UID:${pickUid} ChatID:${du.chatId || "-"}`);
            replyText = `🗑️ 用户 [${pickUid}] 已删除！\n\n如需恢复请点击下方按钮：`;
            replyMarkup = { inline_keyboard: [[{ text: "↩️ 恢复用户", callback_data: `undel_${pickUid}` }]] };
          } else {
            replyAlert = "❌ 未知操作";
          }
        }
      }

      // 待审核订单（游标分页取全量）
      else if (data === "pending_orders") {
        const orderKeys = await listAllKeys(env, "pending_", 2000);
        if (orderKeys.length === 0) {
          replyAlert = "📭 当前没有待审核订单";
        } else {
          let ordersText = `📦 【待审核订单】 (${orderKeys.length})\n\n`;
          for (const k of orderKeys.slice(0, 20)) {
            const order = JSON.parse(await env.SUB_STORE.get(k));
            const timeStr = new Date(order.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
            ordersText += `• ${k.replace("pending_", "")} (${order.type === "renew" ? "续费" : "新购"})\n  买家: ${order.chatId}\n  ${timeStr}\n`;
          }
          replyAlert = ordersText;
        }
      }

      // 手动开卡：第一步（确认天数）
      else if (data.startsWith("newuser_days_")) {
        const days = parseInt(data.replace("newuser_days_", ""));
        replyText = `➕ 【手动开卡】\n请发送需要开通的聊天 ID（买家 ChatID）：\n\n（将开通 ${days} 天）\n\n> 格式：直接发送数字即可`;
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "newuser", days, chatId }));
        replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      }

      // 设置默认时长：快捷按钮
      else if (data.startsWith("setdays_")) {
        const val = data.replace("setdays_", "");
        if (val === "custom") {
          replyText = "📅 【设置默认时长】\n请直接发送天数（如 45）：";
          await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "set_days", chatId }));
          replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
        } else {
          const days = parseInt(val);
          if (!isNaN(days) && days > 0) {
            await env.SUB_STORE.put("default_days", days.toString());
            replyText = `✅ 【默认时长已设置】\n${days} 天`;
          } else {
            replyText = "❌ 无效天数";
          }
        }
      }

      // 生成卡密：选数量后选天数
      else if (data.startsWith("gencard_qty_")) {
        const val = data.replace("gencard_qty_", "");
        let qty;
        if (val === "custom") {
          replyText = "➕ 【生成卡密】\n请直接发送数量（1-200）：";
          await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "gencard_qty", chatId }));
          replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
        } else {
          qty = parseInt(val);
          if (isNaN(qty) || qty <= 0 || qty > 200) {
            replyAlert = "❌ 数量无效（1-200）";
          } else {
            replyText = `➕ 【生成卡密】\n数量: ${qty} 张\n\n请选择卡密时长：`;
            await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "gencard_days", qty, chatId }));
            replyMarkup = {
              inline_keyboard: [
                [{ text: "7 天", callback_data: "gencard_days_7" }, { text: "30 天", callback_data: "gencard_days_30" }],
                [{ text: "90 天", callback_data: "gencard_days_90" }, { text: "365 天", callback_data: "gencard_days_365" }],
                [{ text: "✏️ 自定义", callback_data: "gencard_days_custom" }],
                [{ text: "❌ 取消", callback_data: "cancel_action" }]
              ]
            };
          }
        }
      }

      // 生成卡密：选天数
      else if (data.startsWith("gencard_days_")) {
        const val = data.replace("gencard_days_", "");
        const stateStr = await env.SUB_STORE.get("admin_action_state");
        let qty = 10;
        try { if (stateStr) qty = JSON.parse(stateStr).qty || 10; } catch (e) {}

        if (val === "custom") {
          replyText = `➕ 【生成卡密】\n数量: ${qty} 张\n\n请直接发送天数：`;
          await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "gencard_days_custom", qty, chatId }));
          replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
        } else {
          const days = parseInt(val);
          if (isNaN(days) || days <= 0) {
            replyAlert = "❌ 无效天数";
          } else {
            // 直接生成卡密
            const price = (await env.SUB_STORE.get("price_info")) || "";
            const cards = await genCards(env, qty, days, `${days} 天套餐`, price);
            const cardText = cards.map(c => c.code).join("\n");
            // 分块发送
            let chunk = "";
            for (let i = 0; i < cards.length; i++) {
              chunk += cards[i].code + "\n";
              if ((i + 1) % 10 === 0 || i === cards.length - 1) {
                await sendTGText(ADMIN_BOT_TOKEN, chatId, "```\n" + chunk.trim() + "\n```");
                chunk = "";
              }
            }
            await env.SUB_STORE.delete("admin_action_state");
            replyText = `✅ 已生成 ${qty} 张卡密（${days} 天）\n\n买家在 @${getStoreBotUsername()} 点【🎫 兑换卡密】即可兑换！`;
          }
        }
      }

      // 分配上游：从 /check 面板进入，显示上游池选择
      else if (data.startsWith("assign_")) {
        const targetUid = data.replace("assign_", "");
        const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
        if (!userDataStr) {
          replyText = `❌ 用户 UID:${targetUid} 不存在`;
        } else {
          const u = JSON.parse(userDataStr);
          await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "assign_up", uid: targetUid, chatId }));
          const pool = await getUpstreamPool(env);
          const btns = [];
          pool.forEach((up, i) => {
            if (up.status !== "active") return;
            btns.push([{ text: `${up.isDefault ? "⭐" : ""} ${up.note || "上游" + (i + 1)}`, callback_data: `assignup_${i}` }]);
          });
          btns.push([{ text: "↩️ 恢复自动分配", callback_data: `assignup_auto` }]);
          btns.push([{ text: "❌ 取消", callback_data: "cancel_action" }]);
          const currentUp = u.upstreamUrl ? "（已指定）" : "（自动分配）";
          replyText = `🎯 【分配上游】\n用户 UID: ${targetUid} ${currentUp}\n\n请选择要分配的上游：`;
          replyMarkup = { inline_keyboard: btns };
        }
      }

      // 分配上游：选择上游
      else if (data.startsWith("assignup_")) {
        const arg = data.replace("assignup_", "");
        const stateStr = await env.SUB_STORE.get("admin_action_state");
        let targetUid = null;
        try { if (stateStr) targetUid = JSON.parse(stateStr).uid; } catch (e) {}
        if (!targetUid) {
          replyText = "❌ 会话已过期，请重新选择用户";
        } else {
          const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
          if (!userDataStr) {
            replyText = `❌ 用户 UID:${targetUid} 不存在`;
          } else {
            const u = JSON.parse(userDataStr);
            if (arg === "auto") {
              delete u.upstreamUrl;
              await env.SUB_STORE.put(`user_${targetUid}`, JSON.stringify(u));
              await env.SUB_STORE.delete(`cache_${targetUid}`);
              await env.SUB_STORE.delete("admin_action_state");
              replyText = `✅ 用户 [${targetUid}] 已恢复自动分配上游！`;
            } else {
              const upIdx = parseInt(arg);
              const pool = await getUpstreamPool(env);
              if (isNaN(upIdx) || upIdx < 0 || upIdx >= pool.length) {
                replyText = "❌ 上游序号无效";
              } else {
                const up = pool[upIdx];
                u.upstreamUrl = up.url;
                await env.SUB_STORE.put(`user_${targetUid}`, JSON.stringify(u));
                await env.SUB_STORE.delete(`cache_${targetUid}`);
                await env.SUB_STORE.delete("admin_action_state");
                await logAction(env, "分配上游", `UID:${targetUid} → ${up.note || up.url.slice(0, 30)}`);
                replyText = `✅ 已为用户 [${targetUid}] 分配专属上游！\n\n📡 ${up.note || "上游" + (upIdx + 1)}\n${up.url}\n\n该用户订阅将使用此线路。`;
              }
            }
          }
        }
      }

      else if (data === "cancel_action") {
        await env.SUB_STORE.delete("admin_action_state");
        // 自动清除操作提示消息
        if (cb.message && cb.message.message_id) {
          try {
            await deleteTGMessage(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id);
          } catch (e) {}
        }
        replyAlert = "❌ 已取消操作，提示消息已清除";
      }

      // 删除分销商
      else if (data.startsWith("delreseller_")) {
        const rId = data.replace("delreseller_", "");
        const rStr = await env.SUB_STORE.get(`reseller_${rId}`);
        if (!rStr) {
          replyText = "❌ 分销商不存在或已删除";
        } else {
          const r = JSON.parse(rStr);
          await env.SUB_STORE.delete(`reseller_${rId}`);
          await logAction(env, "删除分销商", `${r.name} (${r.code}) 佣金${r.commission || 0}元`);
          replyText = `🗑️ 分销商 [${r.name}] 已删除！\n（累计佣金 ${r.commission || 0} 元已作废）`;
        }
      }

      // 分销：查看佣金统计
      else if (data === "reseller_stats") {
        const resellerKeys = await listAllKeys(env, "reseller_", 2000);
        if (resellerKeys.length === 0) {
          replyAlert = "📭 当前还没有分销商";
        } else {
          let text = `💰 【分销商列表】\n\n`;
          for (const k of resellerKeys) {
            const r = JSON.parse(await env.SUB_STORE.get(k));
            text += `• ${r.name || k.replace("reseller_", "")}\n  邀请码: ${r.code}\n  佣金: ${r.commission || 0} 元\n`;
          }
          replyAlert = text;
        }
      }

      // 系统概览菜单按钮
      else if (data === "sys_overview") {
        replyText = await buildOverview(env);
      }

      if (replyText) {
        await editTGMessage(ADMIN_BOT_TOKEN, cb.message.chat.id, cb.message.message_id, replyText, replyMarkup);
      } else if (replyAlert) {
        await answerCallback(ADMIN_BOT_TOKEN, cb.id, replyAlert);
      } else {
        await answerCallback(ADMIN_BOT_TOKEN, cb.id, "✅ 已处理");
      }
      return new Response("OK");
    }

    // ========== 文本/图片消息处理 ==========
    const msg = update.message;
    if (!msg || msg.from.id !== ADMIN_ID) return new Response("OK");

    const chatId = msg.chat.id;
    const text = msg.text || "";

    // 检查是否有进行中的交互状态
    const actionStateStr = await env.SUB_STORE.get("admin_action_state");
    let actionState = null;
    if (actionStateStr) {
      try { actionState = JSON.parse(actionStateStr); } catch (e) {}
    }

    // 手动开卡流程：等待输入 ChatID
    if (actionState && actionState.mode === "newuser" && /^\d+$/.test(text)) {
      const targetChatId = parseInt(text);
      const days = actionState.days;
      const newUid = await genUniqueUid(env); // 唯一 UID
      const upstream = await getDefaultUpstream(env);
      const expiry = Date.now() + (days * 86400000);

      await env.SUB_STORE.put(`user_${newUid}`, JSON.stringify({
        upstreamUrl: upstream,
        expiry,
        status: "active",
        brand: DEFAULT_BRAND,
        chatId: targetChatId,
        createdAt: Date.now(),
        plan: `${days} 天套餐`
      }));
      await indexUserChatId(env, targetChatId, newUid); // 写 chatId 索引

      const origin = new URL(request.url).origin;
      const subLink = `${origin}/s/${newUid}`;

      await sendTGText(STORE_BOT_TOKEN, targetChatId,
        `🎉 【开通成功】\n您的专属订阅已开通！\n\n🔗 专属短链:\n\`${subLink}\`\n\n服务时长: ${days} 天`
      );

      await env.SUB_STORE.delete("admin_action_state");

      // 保存撤销记录
      const mId = Date.now();
      const revokeKey = `revoke_manual_${mId}`;
      await env.SUB_STORE.put(revokeKey, JSON.stringify({
        uid: newUid,
        isNew: true,
        chatId: targetChatId,
        time: Date.now()
      }), { expirationTtl: 86400 });

      const replyMarkup = {
        inline_keyboard: [
          [{ text: "↩️ 撤销本次开卡", callback_data: `revoke_manual_${mId}` }]
        ]
      };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✅ 【手动开卡成功】\n\n• 新 UID: \`${newUid}\`\n• 时长: ${days} 天\n• 买家 ChatID: ${targetChatId}\n• 订阅链接: ${subLink}\n\n已通知买家。\n如需撤销请点击下方按钮：`,
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 主菜单按钮：用户管理
    if (text === "👥 用户管理") {
      const userMenu = {
        keyboard: [
          [{ text: "📋 用户列表" }, { text: "🔍 查找用户" }],
          [{ text: "📊 用户统计" }, { text: "⏳ 即将到期" }],
          [{ text: "🔎 搜索用户" }, { text: "➕ 手动开卡" }],
          [{ text: "⏱️ 调整时长" }, { text: "🎯 分配上游" }],
          [{ text: "📝 用户备注" }, { text: "💬 私信用户" }],
          [{ text: "�️ 删除用户" }, { text: "📤 导出名单" }],
          [{ text: "🏠 返回主菜单" }]
        ],
        resize_keyboard: true,
        persistent: true
      };
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "👥 【用户管理】\n请选择操作：", userMenu);
      return new Response("OK");
    }

    // 删除用户（第一步：显示用户选择器）
    if (text === "🗑️ 删除用户") {
      await showUserPicker(env, chatId, "del", "🗑️ 【删除用户】\n请选择要删除的用户：\n\n（删除后 24 小时内可恢复）");
      return new Response("OK");
    }

    // 删除用户流程：输入 UID → 确认
    if (actionState && actionState.mode === "del_uid" && /^\d+$/.test(text)) {
      const targetUid = text.trim();
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      await env.SUB_STORE.delete("admin_action_state");
      if (!userDataStr) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
      } else {
        const u = JSON.parse(userDataStr);
        // 保存删除前的数据，供撤销恢复
        const delId = Date.now();
        await env.SUB_STORE.put(`revoke_del_${delId}`, JSON.stringify({
          uid: targetUid,
          data: JSON.parse(userDataStr),
          time: Date.now()
        }), { expirationTtl: 86400 });
        await env.SUB_STORE.delete(`user_${targetUid}`);
        await clearUserCache(env, targetUid);
        await unindexUserChatId(env, u.chatId);
        await logAction(env, "删除用户", `UID:${targetUid} ChatID:${u.chatId || "-"}`);
        const replyMarkup = { inline_keyboard: [[{ text: "↩️ 恢复用户", callback_data: `undel_${targetUid}` }]] };
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `🗑️ 用户 [${targetUid}] 已删除！\n\n如需恢复请点击下方按钮：`,
            reply_markup: replyMarkup
          })
        });
      }
      return new Response("OK");
    }

    // 分配上游（第一步：显示用户选择器）
    if (text === "🎯 分配上游") {
      await showUserPicker(env, chatId, "assign", "🎯 【分配上游】\n请选择要分配的用户：");
      return new Response("OK");
    }

    // 分配上游流程：输入 UID → 显示上游池选择
    if (actionState && actionState.mode === "assign_uid" && /^\d+$/.test(text)) {
      const targetUid = text.trim();
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
      } else {
        const u = JSON.parse(userDataStr);
        // 保存待分配 UID，显示上游池供选择
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "assign_up", uid: targetUid, chatId }));
        const pool = await getUpstreamPool(env);
        const btns = [];
        pool.forEach((up, i) => {
          if (up.status !== "active") return;
          btns.push([{ text: `${up.isDefault ? "⭐" : ""} ${up.note || "上游" + (i + 1)}`, callback_data: `assignup_${i}` }]);
        });
        btns.push([{ text: "↩️ 恢复自动分配", callback_data: `assignup_auto` }]);
        btns.push([{ text: "❌ 取消", callback_data: "cancel_action" }]);

        const currentUp = u.upstreamUrl ? "（当前已指定）" : "（当前为自动分配）";
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `🎯 【分配上游】\n用户 UID: ${targetUid} ${currentUp}\n\n请选择要分配的上游：`,
            reply_markup: { inline_keyboard: btns }
          })
        });
      }
      return new Response("OK");
    }

    // 分配上游命令：/assign UID 上游序号 或 /assign UID auto
    if (text.startsWith("/assign ")) {
      const parts = text.replace("/assign ", "").trim().split(/\s+/);
      const targetUid = parts[0];
      const upArg = parts[1];
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
        return new Response("OK");
      }
      const u = JSON.parse(userDataStr);
      if (upArg === "auto") {
        delete u.upstreamUrl;
        await env.SUB_STORE.put(`user_${targetUid}`, JSON.stringify(u));
        await env.SUB_STORE.delete(`cache_${targetUid}`);
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 用户 [${targetUid}] 已恢复自动分配上游！`, MAIN_MENU);
        return new Response("OK");
      }
      const upIdx = parseInt(upArg) - 1;
      const pool = await getUpstreamPool(env);
      if (isNaN(upIdx) || upIdx < 0 || upIdx >= pool.length) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 上游序号无效", MAIN_MENU);
        return new Response("OK");
      }
      const up = pool[upIdx];
      u.upstreamUrl = up.url;
      await env.SUB_STORE.put(`user_${targetUid}`, JSON.stringify(u));
      await env.SUB_STORE.delete(`cache_${targetUid}`);
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
        `✅ 已为用户 [${targetUid}] 分配专属上游！\n\n📡 ${up.note || "上游" + (upIdx + 1)}\n${up.url}`,
        MAIN_MENU);
      return new Response("OK");
    }

    // 搜索用户（按备注/套餐关键词搜索）
    if (text === "🔎 搜索用户") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "search_user", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "🔎 【搜索用户】\n请输入关键词（按备注/套餐/UID 搜索）：\n例如：VIP、月卡、1234",
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 搜索用户流程：输入关键词
    if (actionState && actionState.mode === "search_user") {
      const keyword = text.trim().toLowerCase();
      await env.SUB_STORE.delete("admin_action_state");
      if (!keyword) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 关键词无效", MAIN_MENU);
      } else {
        const userKeys = await listAllKeys(env, "user_", 10000);
        const matches = [];
        for (const k of userKeys) {
          const uid = k.replace("user_", "");
          const u = JSON.parse(await env.SUB_STORE.get(k));
          const haystack = `${uid} ${u.note || ""} ${u.plan || ""} ${u.chatId || ""}`.toLowerCase();
          if (haystack.includes(keyword)) {
            matches.push({ uid, u });
          }
        }
        if (matches.length === 0) {
          await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `🔎 未找到匹配"${text.trim()}"的用户`, MAIN_MENU);
        } else {
          let msg = `🔎 【搜索结果】(${matches.length} 个)\n\n`;
          for (const m of matches.slice(0, 15)) {
            const remain = Math.ceil((m.u.expiry - Date.now()) / 86400000);
            const state = m.u.status === "disabled" ? "🔴" : (remain <= 0 ? "⏳" : "🟢");
            msg += `${state} UID:${m.uid} | 剩 ${Math.max(0, remain)} 天${m.u.note ? ` | 📝${m.u.note.slice(0, 12)}` : ""}\n`;
          }
          if (matches.length > 15) msg += `\n...还有 ${matches.length - 15} 个`;
          await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
        }
      }
      return new Response("OK");
    }

    // 用户统计
    if (text === "📊 用户统计") {
      const userKeys = await listAllKeys(env, "user_", 10000);
      let active = 0, expired = 0, disabled = 0;
      const expiringSoon = []; // 7 天内到期
      const now = Date.now();
      for (const k of userKeys) {
        const u = JSON.parse(await env.SUB_STORE.get(k));
        if (u.status === "disabled") disabled++;
        else if (now > u.expiry) expired++;
        else {
          active++;
          const remainDays = Math.ceil((u.expiry - now) / 86400000);
          if (remainDays <= 7) expiringSoon.push(k.replace("user_", ""));
        }
      }
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
        `📊 【用户统计】\n\n` +
        `👥 用户总数: ${userKeys.length}\n` +
        `🟢 正常: ${active}\n` +
        `⏳ 已过期: ${expired}\n` +
        `🔴 已禁用: ${disabled}\n` +
        `⚠️ 7天内到期: ${expiringSoon.length} 人`,
        MAIN_MENU);
      return new Response("OK");
    }

    // 即将到期用户
    if (text === "⏳ 即将到期") {
      const userKeys = await listAllKeys(env, "user_", 10000);
      const now = Date.now();
      const expiring = [];
      for (const k of userKeys) {
        const u = JSON.parse(await env.SUB_STORE.get(k));
        if (u.status !== "active") continue;
        const remainDays = Math.ceil((u.expiry - now) / 86400000);
        if (remainDays <= 7 && remainDays > 0) {
          expiring.push({ uid: k.replace("user_", ""), remainDays, chatId: u.chatId });
        }
      }
      expiring.sort((a, b) => a.remainDays - b.remainDays);
      if (expiring.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "🎉 7天内没有即将到期的用户", MAIN_MENU);
      } else {
        let msg = `⏳ 【即将到期用户】(7天内)\n\n`;
        for (const e of expiring.slice(0, 20)) {
          msg += `• UID:${e.uid} | 剩 ${e.remainDays} 天 | ChatID:${e.chatId || "-"}\n`;
        }
        if (expiring.length > 20) msg += `\n...还有 ${expiring.length - 20} 个`;
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 私信用户（第一步：显示用户选择器）
    if (text === "💬 私信用户") {
      await showUserPicker(env, chatId, "msg", "💬 【私信用户】\n请选择要私信的用户：");
      return new Response("OK");
    }

    // 私信用户流程：输入 UID
    if (actionState && actionState.mode === "msg_uid" && /^\d+$/.test(text)) {
      const targetUid = text.trim();
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
      } else {
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "msg_text", uid: targetUid, chatId }));
        const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `💬 【私信用户】\nUID:${targetUid}\n\n请输入要发送的消息内容：`,
            reply_markup: replyMarkup
          })
        });
      }
      return new Response("OK");
    }

    // 私信用户流程：输入消息内容
    if (actionState && actionState.mode === "msg_text") {
      const { uid } = actionState;
      const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
      await env.SUB_STORE.delete("admin_action_state");
      if (!userDataStr) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${uid} 不存在`, MAIN_MENU);
      } else {
        const u = JSON.parse(userDataStr);
        if (!u.chatId) {
          await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${uid} 没有绑定的 ChatID，无法私信`, MAIN_MENU);
        } else {
          try {
            await sendTGText(STORE_BOT_TOKEN, u.chatId, `💬 【管理员消息】\n${text}`);
            await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【私信已发送】\nUID:${uid} (ChatID:${u.chatId})\n\n内容:\n${text}`, MAIN_MENU);
          } catch (e) {
            await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 发送失败，用户可能未与前台 Bot 建立会话`, MAIN_MENU);
          }
        }
      }
      return new Response("OK");
    }

    // 调整时长（第一步：输入 UID）
    if (text === "⏱️ 调整时长") {
      await showUserPicker(env, chatId, "adjust", "⏱️ 【调整时长】\n请选择要调整的用户：");
      return new Response("OK");
    }

    // 调整时长流程：输入 UID
    if (actionState && actionState.mode === "adjust_uid" && /^\d+$/.test(text)) {
      const targetUid = text.trim();
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
      } else {
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "adjust_days", uid: targetUid, chatId }));
        const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `⏱️ 【调整时长】\nUID:${targetUid}\n\n请输入调整天数：\n• 正数加时长（如 30）\n• 负数减时长（如 -30）\n• 直接设置到期：如 set 30 天`,
            reply_markup: replyMarkup
          })
        });
      }
      return new Response("OK");
    }

    // 调整时长流程：输入天数
    if (actionState && actionState.mode === "adjust_days") {
      const { uid } = actionState;
      const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${uid} 不存在`, MAIN_MENU);
        return new Response("OK");
      }
      const u = JSON.parse(userDataStr);
      const input = text.trim();
      const prevExpiry = u.expiry;

      if (/^[+-]?\d+$/.test(input)) {
        const delta = parseInt(input);
        const base = Math.max(u.expiry, Date.now());
        if (delta > 0) {
          u.expiry = base + (delta * 86400000);
        } else {
          // 减时长：不能低于当前时间
          u.expiry = Math.min(u.expiry, base + (delta * 86400000));
          if (u.expiry < Date.now()) {
            u.expiry = Date.now() + 86400000; // 至少保留 1 天
          }
        }
        u.status = "active";
        await env.SUB_STORE.put(`user_${uid}`, JSON.stringify(u));
        await env.SUB_STORE.delete("admin_action_state");

        // 保存撤销记录（恢复原到期时间）
        const adjId = Date.now();
        const revokeKey = `revoke_adjust_${adjId}`;
        await env.SUB_STORE.put(revokeKey, JSON.stringify({
          uid,
          prevExpiry,
          delta,
          time: Date.now()
        }), { expirationTtl: 86400 });

        const newRemain = Math.ceil((u.expiry - Date.now()) / 86400000);
        const replyMarkup = {
          inline_keyboard: [
            [{ text: "↩️ 撤销本次调整", callback_data: `revoke_adjust_${adjId}` }]
          ]
        };
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `✅ 【时长已调整】\nUID:${uid}\n调整: ${delta > 0 ? "+" : ""}${delta} 天\n当前剩余: ${Math.max(0, newRemain)} 天\n到期: ${new Date(u.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n\n如需撤销请点击下方按钮：`,
            reply_markup: replyMarkup
          })
        });
        return new Response("OK");
      } else {
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 输入无效，已取消操作", MAIN_MENU);
      }
      return new Response("OK");
    }

    // 导出名单
    if (text === "📤 导出名单") {
      const userKeys = await listAllKeys(env, "user_", 10000);
      if (userKeys.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有任何用户", MAIN_MENU);
      } else {
        const lines = ["UID | ChatID | 状态 | 剩余天数 | 到期 | 备注"];
        for (const k of userKeys) {
          const uid = k.replace("user_", "");
          const u = JSON.parse(await env.SUB_STORE.get(k));
          const remain = Math.ceil((u.expiry - Date.now()) / 86400000);
          const state = u.status === "disabled" ? "禁用" : (remain <= 0 ? "过期" : "正常");
          const exp = new Date(u.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
          lines.push(`${uid} | ${u.chatId || "-"} | ${state} | ${Math.max(0, remain)} | ${exp} | ${u.note || ""}`);
        }
        const textContent = lines.join("\n");
        // 分块发送
        const chunkSize = 30;
        for (let i = 0; i < lines.length; i += chunkSize) {
          const chunk = lines.slice(i, i + chunkSize).join("\n");
          await sendTGText(ADMIN_BOT_TOKEN, chatId, "```\n" + chunk + "\n```");
        }
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `📤 【导出完成】\n共 ${userKeys.length} 位用户，已分块发送`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 用户备注（第一步：显示用户选择器）
    if (text === "📝 用户备注") {
      await showUserPicker(env, chatId, "note", "📝 【用户备注】\n请选择要备注的用户：");
      return new Response("OK");
    }

    // 用户备注流程：输入 UID
    if (actionState && actionState.mode === "note_uid" && /^\d+$/.test(text)) {
      const targetUid = text.trim();
      const userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);
      if (!userDataStr) {
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${targetUid} 不存在`, MAIN_MENU);
      } else {
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "note_text", uid: targetUid, chatId }));
        const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `📝 【用户备注】\nUID:${targetUid}\n\n请输入备注内容（如：VIP老客户）：`,
            reply_markup: replyMarkup
          })
        });
      }
      return new Response("OK");
    }

    // 用户备注流程：输入备注内容
    if (actionState && actionState.mode === "note_text") {
      const { uid } = actionState;
      const userDataStr = await env.SUB_STORE.get(`user_${uid}`);
      if (userDataStr) {
        const u = JSON.parse(userDataStr);
        u.note = text.trim();
        await env.SUB_STORE.put(`user_${uid}`, JSON.stringify(u));
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【备注已保存】\nUID:${uid}\n备注: ${text.trim()}`, MAIN_MENU);
      } else {
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 用户 UID:${uid} 不存在`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 用户列表
    if (text === "📋 用户列表") {
      const userKeys = await listAllKeys(env, "user_", 10000);
      const allUsers = userKeys.map(k => k.replace("user_", ""));
      const totalPages = Math.max(1, Math.ceil(allUsers.length / 5));

      if (allUsers.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有任何用户", MAIN_MENU);
        return new Response("OK");
      }

      let listText = `👥 【用户列表】 (第 1/${totalPages} 页)\n\n`;
      const rows = [];
      for (const uid of allUsers.slice(0, 5)) {
        const u = JSON.parse(await env.SUB_STORE.get(`user_${uid}`));
        const remainDays = Math.ceil((u.expiry - Date.now()) / 86400000);
        const state = u.status === "disabled" ? "🔴" : (remainDays <= 0 ? "⏳" : "🟢");
        listText += `${state} UID:${uid} | 剩 ${Math.max(0, remainDays)} 天${u.note ? ` | 📝${u.note.slice(0, 10)}` : ""}\n`;
        // 每个用户一行操作按钮：详情 / 禁用(或启用) / 删除
        rows.push([
          { text: `📋 ${uid}`, callback_data: `check_${uid}` },
          { text: u.status === "disabled" ? "🟢 启用" : "🔴 禁用", callback_data: `${u.status === "disabled" ? "enable" : "disable"}_${uid}` },
          { text: "🗑️ 删除", callback_data: `del_${uid}` }
        ]);
      }

      const navBtns = [];
      if (totalPages > 1) navBtns.push({ text: "下一页 ▶️", callback_data: "ulist_2" });
      if (navBtns.length) rows.push(navBtns);

      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: listText,
          reply_markup: rows.length ? { inline_keyboard: rows } : {}
        })
      });
      return new Response("OK");
    }

    // 查找用户
    if (text === "🔍 查找用户") {
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "🔍 【查找用户】\n请输入 UID 查询，格式：\n`/check UID`", MAIN_MENU);
      return new Response("OK");
    }

    // 手动开卡（第一步：选择天数）
    if (text === "➕ 手动开卡") {
      const replyMarkup = {
        inline_keyboard: [
          [{ text: "7 天", callback_data: "newuser_days_7" }, { text: "30 天", callback_data: "newuser_days_30" }],
          [{ text: "90 天", callback_data: "newuser_days_90" }, { text: "365 天", callback_data: "newuser_days_365" }]
        ]
      };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "➕ 【手动开卡】\n请选择开通时长：",
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 订单管理
    if (text === "📦 订单管理") {
      const orderMenu = {
        keyboard: [
          [{ text: "⏳ 待审核订单" }, { text: "📋 已处理订单" }],
          [{ text: "🧾 收款流水" }],
          [{ text: "🏠 返回主菜单" }]
        ],
        resize_keyboard: true,
        persistent: true
      };
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📦 【订单管理】\n请选择查看：", orderMenu);
      return new Response("OK");
    }

    // 收款流水
    if (text === "🧾 收款流水") {
      const recKeys = await listAllKeys(env, "record_", 5000);
      if (recKeys.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 暂无收款流水", MAIN_MENU);
      } else {
        // 按时间倒序
        const recs = [];
        for (const k of recKeys) {
          recs.push(JSON.parse(await env.SUB_STORE.get(k)));
        }
        recs.sort((a, b) => (b.time || 0) - (a.time || 0));

        // 统计总额
        let totalPrice = 0;
        for (const r of recs) {
          const priceNum = parseFloat(String(r.price || "").replace(/[^\d.]/g, ""));
          if (!isNaN(priceNum)) totalPrice += priceNum;
        }

        let msg = `🧾 【收款流水】 (${recs.length} 笔)\n\n`;
        for (const r of recs.slice(0, 15)) {
          const timeStr = new Date(r.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
          msg += `• ${r.orderId || "—"} (${r.type === "renew" ? "续费" : "新购"}${r.via === "card" ? "·卡密" : ""})\n  ${r.plan || ""} ${r.price || ""}\n  ${timeStr}\n`;
        }
        if (totalPrice > 0) msg += `\n💰 流水金额合计: ${totalPrice} 元`;
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 待审核订单列表
    if (text === "⏳ 待审核订单") {
      const orderKeys = await listAllKeys(env, "pending_", 2000);
      if (orderKeys.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有待审核订单", MAIN_MENU);
      } else {
        let ordersText = `📦 【待审核订单】 (${orderKeys.length})\n\n`;
        for (const k of orderKeys.slice(0, 20)) {
          const order = JSON.parse(await env.SUB_STORE.get(k));
          const timeStr = new Date(order.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
          ordersText += `• ${k.replace("pending_", "")} (${order.type === "renew" ? "续费" : "新购"})\n  买家: ${order.chatId}\n  ${timeStr}\n`;
        }
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, ordersText, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 已处理订单历史
    if (text === "📋 已处理订单") {
      const procKeys = await listAllKeys(env, "processed_", 2000);
      if (procKeys.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 暂无已处理订单记录", MAIN_MENU);
      } else {
        let ordersText = `📋 【已处理订单】 (最近 ${Math.min(procKeys.length, 20)} 条)\n\n`;
        for (const k of procKeys.slice(-20)) {
          const order = JSON.parse(await env.SUB_STORE.get(k));
          const timeStr = new Date(order.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
          ordersText += `• 买家 ChatID: ${order.chatId}\n  ${timeStr}\n`;
        }
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, ordersText, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 系统设置
    if (text === "⚙️ 系统设置") {
      const settingsMenu = {
        keyboard: [
          [{ text: "🔗 上游池管理" }, { text: "🖼️ 设置收款码" }],
          [{ text: "💰 设置价格" }, { text: "📅 设置时长" }],
          [{ text: "📢 发布公告" }, { text: "📞 设置客服" }],
          [{ text: "🏠 返回主菜单" }]
        ],
        resize_keyboard: true,
        persistent: true
      };
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "⚙️ 【系统设置】\n请选择要配置的项目：", settingsMenu);
      return new Response("OK");
    }

    // 设置客服
    if (text === "📞 设置客服") {
      const current = await env.SUB_STORE.get("service_contact") || "未设置";
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
        `📞 【设置客服】\n\n当前客服: ${current}\n\n请发送命令设置客服联系方式：\n\n格式：\`/service @客服用户名\`\n或：\`/service https://t.me/客服用户名\``,
        MAIN_MENU);
      return new Response("OK");
    }

    // /service 命令：设置客服联系方式
    if (text.startsWith("/service ")) {
      const contact = text.replace("/service ", "").trim();
      if (!contact) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式：/service @客服用户名", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("service_contact", contact);
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【客服已设置】\n\n客服联系方式: ${contact}\n\n买家在前台 Bot 点【📞 联系客服】即可一键联系！`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // 上游池管理
    if (text === "🔗 上游池管理") {
      const pool = await getUpstreamPool(env);
      let msg = `🔗 【上游池管理】\n\n当前 ${pool.length} 个上游：\n\n`;
      pool.forEach((u, i) => {
        msg += `${i + 1}. ${u.isDefault ? "⭐" : "▪️"} ${u.note || "未命名"}\n   ${u.url.slice(0, 60)}\n   ${u.status === "active" ? "✅ 启用" : "🔴 停用"}\n\n`;
      });
      msg += `**命令：**\n` +
        `/addurl 链接 - 添加新上游\n` +
        `/delurl 序号 - 删除指定上游\n` +
        `/setdef 序号 - 设为默认\n` +
        `/noteurl 序号 备注 - 设置备注\n` +
        `/merge on|off - 合并全部上游节点\n` +
        `/nodes [序号] - 查看节点`;
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      return new Response("OK");
    }

    // 添加/删除/设置默认/备注 上游命令
    if (text.startsWith("/addurl ")) {
      const url = text.replace("/addurl ", "").trim();
      if (!url.startsWith("http")) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 链接必须以 http/https 开头", MAIN_MENU);
      } else {
        const r = await addUpstream(env, url, `上游${(await getUpstreamPool(env)).length + 1}`);
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}${r.isDefault ? "（已设为默认）" : ""}` : `❌ ${r.msg}`, MAIN_MENU);
      }
      return new Response("OK");
    }

    if (text.startsWith("/delurl ")) {
      const idx = parseInt(text.replace("/delurl ", "").trim()) - 1;
      const r = await removeUpstream(env, idx);
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, MAIN_MENU);
      return new Response("OK");
    }

    if (text.startsWith("/setdef ")) {
      const idx = parseInt(text.replace("/setdef ", "").trim()) - 1;
      const r = await setDefaultUpstream(env, idx);
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, MAIN_MENU);
      return new Response("OK");
    }

    if (text.startsWith("/noteurl ")) {
      const parts = text.replace("/noteurl ", "").trim().split(/\s+/);
      const idx = parseInt(parts[0]) - 1;
      const note = parts.slice(1).join(" ");
      const pool = await getUpstreamPool(env);
      if (idx < 0 || idx >= pool.length || !note) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式：/noteurl 序号 备注", MAIN_MENU);
      } else {
        pool[idx].note = note;
        await saveUpstreamPool(env, pool);
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 已设置备注: ${note}`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // ===== 节点级管理 =====
    // /nodes [序号] 查看上游节点列表（默认第 1 个上游）
    if (text === "/nodes" || text.startsWith("/nodes ")) {
      const pool = await getUpstreamPool(env);
      const arg = text.startsWith("/nodes ") ? parseInt(text.replace("/nodes ", "").trim()) : 1;
      const idx = (arg && arg >= 1) ? arg - 1 : 0;
      if (idx >= pool.length) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 上游序号无效（共 ${pool.length} 个）`, MAIN_MENU);
        return new Response("OK");
      }
      const up = pool[idx];
      await sendTGText(ADMIN_BOT_TOKEN, chatId, `⏳ 正在拉取上游 #${idx + 1} 的节点，请稍候…`);
      const result = await fetchUpstreamNodes(env, up.url);
      if (!result.ok) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 上游 #${idx + 1} 拉取失败（${up.url.slice(0, 50)}）`, MAIN_MENU);
        return new Response("OK");
      }
      if (result.nodes.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 该上游没有解析到节点", MAIN_MENU);
        return new Response("OK");
      }
      // 读取黑名单标记禁用状态
      const blacklist = await getNodeBlacklist(env);
      let msg = `📡 【节点列表】上游 #${idx + 1}\n${up.note || ""}\n共 ${result.nodes.length} 个节点\n\n`;
      // 分页显示（每页 15 个），展示 host 和状态
      const page = 1;
      const perPage = 15;
      const start = (page - 1) * perPage;
      const pageNodes = result.nodes.slice(start, start + perPage);
      pageNodes.forEach((n, i) => {
        const globalIdx = start + i + 1;
        const disabled = blacklist.includes(n.host);
        msg += `${disabled ? "🔴" : "🟢"} ${globalIdx}. ${(n.name || n.host).slice(0, 30)}\n   ${n.host}\n`;
      });
      msg += `\n**命令：**\n` +
        `/nodeoff 1,3,5 - 批量禁用节点\n` +
        `/nodeon 1,3,5 - 批量启用节点\n` +
        `/nodeoff all - 禁用全部\n` +
        `/nodeon all - 启用全部\n` +
        `/nodelist - 查看禁用列表`;
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      return new Response("OK");
    }

    // /nodeoff 批量禁用节点
    // 用法: /nodeoff 1 | /nodeoff 1,3,5 | /nodeoff all [上游序号]
    if (text.startsWith("/nodeoff ")) {
      const pool = await getUpstreamPool(env);
      const parts = text.replace("/nodeoff ", "").trim().split(/\s+/);
      const arg = parts[0];
      const upIdx = (parts[1] ? parseInt(parts[1]) : 1) - 1;

      if (arg !== "all" && !/^[\d,\s]+$/.test(arg)) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式：/nodeoff 1,3,5 或 /nodeoff all [上游序号=1]", MAIN_MENU);
        return new Response("OK");
      }
      const r = await batchToggleNodes(env, "off", arg === "all" ? "all" : arg, upIdx);
      if (!r.ok) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ ${r.msg}`, MAIN_MENU);
      } else {
        const hostPreview = r.affected.slice(0, 3).map(h => h.slice(0, 30)).join("\n");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `🔴 【批量禁用完成】\n\n• 禁用: ${r.done} 个\n• 已禁用跳过: ${r.skipped} 个\n${hostPreview ? `\n${hostPreview}${r.affected.length > 3 ? "\n..." : ""}` : ""}\n\n买家订阅将不再下发这些节点。`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // /nodeon 批量启用节点
    // 用法: /nodeon 1 | /nodeon 1,3,5 | /nodeon all [上游序号]
    if (text.startsWith("/nodeon ")) {
      const pool = await getUpstreamPool(env);
      const parts = text.replace("/nodeon ", "").trim().split(/\s+/);
      const arg = parts[0];
      const upIdx = (parts[1] ? parseInt(parts[1]) : 1) - 1;

      if (arg !== "all" && !/^[\d,\s]+$/.test(arg)) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式：/nodeon 1,3,5 或 /nodeon all [上游序号=1]", MAIN_MENU);
        return new Response("OK");
      }
      const r = await batchToggleNodes(env, "on", arg === "all" ? "all" : arg, upIdx);
      if (!r.ok) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ ${r.msg}`, MAIN_MENU);
      } else {
        const hostPreview = r.affected.slice(0, 3).map(h => h.slice(0, 30)).join("\n");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `🟢 【批量启用完成】\n\n• 启用: ${r.done} 个\n• 未禁用跳过: ${r.skipped} 个\n${hostPreview ? `\n${hostPreview}${r.affected.length > 3 ? "\n..." : ""}` : ""}\n\n买家订阅将恢复这些节点。`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // /nodelist 查看禁用列表
    if (text === "/nodelist") {
      const blacklist = await getNodeBlacklist(env);
      if (blacklist.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有禁用的节点", MAIN_MENU);
      } else {
        let msg = `🔴 【节点禁用列表】(${blacklist.length})\n\n`;
        blacklist.forEach((h, i) => {
          msg += `${i + 1}. ${h}\n`;
        });
        msg += `\n使用 /nodeon 1,2,3 或 /nodeon all 恢复节点`;
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    // /merge on|off 合并模式开关
    if (text === "/merge" || text.startsWith("/merge ")) {
      const arg = text === "/merge" ? "" : text.replace("/merge ", "").trim().toLowerCase();
      const current = await isMergeMode(env) ? "on" : "off";
      if (arg === "on") {
        await env.SUB_STORE.put("merge_mode", "on");
        // 清理所有缓存生效
        const cacheKeys = await listAllKeys(env, "cache_", 10000);
        for (const k of cacheKeys) await env.SUB_STORE.delete(k);
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `🔄 【合并模式已开启】\n\n所有买家订阅将合并上游池中全部节点的线路！\n（已清除缓存，立即生效）`,
          MAIN_MENU);
      } else if (arg === "off") {
        await env.SUB_STORE.put("merge_mode", "off");
        const cacheKeys = await listAllKeys(env, "cache_", 10000);
        for (const k of cacheKeys) await env.SUB_STORE.delete(k);
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `➡️ 【合并模式已关闭】\n\n恢复为按用户分配单个上游。`,
          MAIN_MENU);
      } else {
        // 显示当前状态 + 预览合并节点数
        let preview = "";
        if (current === "on") {
          const merged = await fetchAllUpstreamsMerged(env);
          preview = `\n\n📡 当前合并后节点数: ${merged.length}`;
        } else {
          preview = `\n\n💡 开启后买家将获得所有上游的节点（自动去重）`;
        }
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `🔄 【合并模式】\n\n当前状态: ${current === "on" ? "✅ 开启" : "⭕ 关闭"}${preview}\n\n命令：\n/merge on - 开启合并\n/merge off - 关闭合并`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // 发布公告
    if (text === "📢 发布公告") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "notice", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "📢 【发布公告】\n请发送公告内容：\n\n（公告会显示在前台 Bot 的 /start 中）",
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 公告保存流程
    if (actionState && actionState.mode === "notice") {
      const content = text.trim();
      if (content) {
        await env.SUB_STORE.put("notice_content", content);
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【公告已发布】\n\n${content}\n\n买家在前台 Bot 发送 /start 即可看到。`,
          MAIN_MENU);
      } else {
        await env.SUB_STORE.delete("admin_action_state");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 公告内容为空，已取消", MAIN_MENU);
      }
      return new Response("OK");
    }

    // 设置收款码：点击按钮直接进入等待上传状态
    if (text === "🖼️ 设置收款码") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "setqr", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "🖼️ 【上传收款码】\n请现在发送收款码图片（无需配文）：\n\n系统收录后将自动清除消息。",
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 收款码指令：进入等待收款码状态
    if (text === "/setqr") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "setqr", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "🖼️ 【上传收款码】\n请现在发送收款码图片（无需配文）：\n\n系统收录后将自动清除消息。",
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 设置价格（按钮化：点击直接进入输入状态）
    if (text === "💰 设置价格") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "set_price", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `💰 【设置套餐价格】\n当前: ${(await env.SUB_STORE.get("price_info")) || "未设置"}\n\n请直接发送价格内容（如：30元/月）：`,
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 价格输入保存
    if (actionState && actionState.mode === "set_price") {
      const price = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      if (!price) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 价格内容无效", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("price_info", price);
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【套餐价格已设置】\n${price}`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 自定义天数输入保存
    if (actionState && actionState.mode === "set_days") {
      const days = parseInt(text.trim());
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(days) || days <= 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 无效天数，已取消", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("default_days", days.toString());
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【默认时长已设置】\n${days} 天`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 卡密：自定义数量输入
    if (actionState && actionState.mode === "gencard_qty") {
      const qty = parseInt(text.trim());
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(qty) || qty <= 0 || qty > 200) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 数量无效（1-200）", MAIN_MENU);
      } else {
        // 进入选天数
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "gencard_days", qty, chatId }));
        const replyMarkup = {
          inline_keyboard: [
            [{ text: "7 天", callback_data: "gencard_days_7" }, { text: "30 天", callback_data: "gencard_days_30" }],
            [{ text: "90 天", callback_data: "gencard_days_90" }, { text: "365 天", callback_data: "gencard_days_365" }],
            [{ text: "✏️ 自定义", callback_data: "gencard_days_custom" }],
            [{ text: "❌ 取消", callback_data: "cancel_action" }]
          ]
        };
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `➕ 【生成卡密】\n数量: ${qty} 张\n\n请选择卡密时长：`,
            reply_markup: replyMarkup
          })
        });
      }
      return new Response("OK");
    }

    // 卡密：自定义天数输入
    if (actionState && actionState.mode === "gencard_days_custom") {
      const days = parseInt(text.trim());
      const qty = actionState.qty || 10;
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(days) || days <= 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 无效天数", MAIN_MENU);
      } else {
        const price = (await env.SUB_STORE.get("price_info")) || "";
        const cards = await genCards(env, qty, days, `${days} 天套餐`, price);
        let chunk = "";
        for (let i = 0; i < cards.length; i++) {
          chunk += cards[i].code + "\n";
          if ((i + 1) % 10 === 0 || i === cards.length - 1) {
            await sendTGText(ADMIN_BOT_TOKEN, chatId, "```\n" + chunk.trim() + "\n```");
            chunk = "";
          }
        }
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 已生成 ${qty} 张卡密（${days} 天）\n\n买家在 @${getStoreBotUsername()} 点【🎫 兑换卡密】即可兑换！`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // 设置时长（按钮化：点击直接进入输入状态）
    if (text === "📅 设置时长") {
      const replyMarkup = {
        inline_keyboard: [
          [{ text: "7 天", callback_data: "setdays_7" }, { text: "30 天", callback_data: "setdays_30" }],
          [{ text: "90 天", callback_data: "setdays_90" }, { text: "365 天", callback_data: "setdays_365" }],
          [{ text: "✏️ 自定义", callback_data: "setdays_custom" }],
          [{ text: "❌ 取消", callback_data: "cancel_action" }]
        ]
      };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `📅 【设置默认时长】\n当前: ${(await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS} 天\n\n请选择或输入：`,
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 卡密管理
    if (text === "🎫 卡密管理") {
      const cardMenu = {
        keyboard: [
          [{ text: "➕ 生成卡密" }, { text: "🎁 生成优惠券" }],
          [{ text: "📋 卡密统计" }, { text: "🔍 查询卡密" }],
          [{ text: "🗑️ 清理已用卡密" }],
          [{ text: "🏠 返回主菜单" }]
        ],
        resize_keyboard: true,
        persistent: true
      };
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
        `🎫 【卡密管理】\n\n点击【➕ 生成卡密】即可通过按钮快速生成，\n或直接使用命令：\n\`/gencard 数量 天数 价格\`\n例：\`/gencard 10 30 30元\`\n\n🎁 优惠券命令：\n\`/gencp 数量 天数 折扣 备注\`\n例：\`/gencp 5 30 80 八折月卡\``,
        cardMenu);
      return new Response("OK");
    }

    // 生成优惠券（按钮式）
    if (text === "🎁 生成优惠券") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "gencoupon", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🎁 【生成优惠券】\n请直接发送命令：\n\n\`/gencp 数量 天数 折扣 备注\`\n\n例：\`/gencp 5 30 80 八折月卡\`\n（折扣=优惠后价格百分比，80=8折）`,
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 生成优惠券命令
    if (text.startsWith("/gencp")) {
      const parts = text.split(/\s+/);
      const count = parseInt(parts[1]);
      if (!count || count <= 0 || count > 200) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式：/gencp 数量 天数 折扣 备注\n例：/gencp 5 30 80 八折月卡", MAIN_MENU);
        return new Response("OK");
      }
      const days = parseInt(parts[2]) || 30;
      const discount = parseInt(parts[3]) || 100;
      const note = parts.slice(4).join(" ") || `${days} 天优惠券`;

      const coupons = await genCoupons(env, count, days, discount, note);
      let chunk = "";
      for (let i = 0; i < coupons.length; i++) {
        chunk += coupons[i].code + "\n";
        if ((i + 1) % 10 === 0 || i === coupons.length - 1) {
          await sendTGText(ADMIN_BOT_TOKEN, chatId, "```\n" + chunk.trim() + "\n```");
          chunk = "";
        }
      }
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
        `🎁 【优惠券已生成】\n\n• 数量: ${count}\n• 时长: ${days} 天\n• 折扣: ${discount}%\n• 备注: ${note}\n\n买家在 @${getStoreBotUsername()} 点【🎁 优惠券】即可兑换！`,
        MAIN_MENU);
      return new Response("OK");
    }

    // 生成卡密（按钮式：选数量）
    if (text === "➕ 生成卡密") {
      const replyMarkup = {
        inline_keyboard: [
          [{ text: "5 张", callback_data: "gencard_qty_5" }, { text: "10 张", callback_data: "gencard_qty_10" }],
          [{ text: "20 张", callback_data: "gencard_qty_20" }, { text: "50 张", callback_data: "gencard_qty_50" }],
          [{ text: "✏️ 自定义数量", callback_data: "gencard_qty_custom" }],
          [{ text: "❌ 取消", callback_data: "cancel_action" }]
        ]
      };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `➕ 【生成卡密】\n请选择生成数量：`,
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 卡密统计
    if (text === "📋 卡密统计") {
      const cardKeys = await listAllKeys(env, "card_", 10000);
      let total = 0, unused = 0, used = 0, disabled = 0;
      for (const k of cardKeys) {
        total++;
        const c = JSON.parse(await env.SUB_STORE.get(k));
        if (c.status === "used") used++;
        else if (c.status === "disabled") disabled++;
        else unused++;
      }
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
        `📊 【卡密统计】\n\n• 总卡密: ${total}\n• 未使用: ${unused} 🟢\n• 已使用: ${used} 🔵\n• 已禁用: ${disabled} 🔴`,
        MAIN_MENU);
      return new Response("OK");
    }

    // 查询卡密
    if (text === "🔍 查询卡密") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "card_query", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "🔍 【查询卡密】\n请输入卡密（或完整/部分卡密）：",
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 清理已用卡密
    if (text === "🗑️ 清理已用卡密") {
      const cardKeys = await listAllKeys(env, "card_", 10000);
      let deleted = 0;
      for (const k of cardKeys) {
        const c = JSON.parse(await env.SUB_STORE.get(k));
        if (c.status === "used") {
          await env.SUB_STORE.delete(k);
          deleted++;
        }
      }
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `🗑️ 【清理完成】\n已删除 ${deleted} 张已使用卡密`, MAIN_MENU);
      return new Response("OK");
    }

    // 生成卡密命令
    if (text.startsWith("/gencard")) {
      const parts = text.split(/\s+/);
      const count = parseInt(parts[1]);
      if (!count || count <= 0 || count > 200) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式错误！\n请使用：`/gencard 数量 天数 价格`\n例：`/gencard 10 30 30元`", MAIN_MENU);
        return new Response("OK");
      }
      const days = parseInt(parts[2]) || (parseInt(await env.SUB_STORE.get("default_days")) || DEFAULT_DAYS);
      const price = parts[3] || (await env.SUB_STORE.get("price_info")) || "";

      const cards = await genCards(env, count, days, `${days} 天套餐`, price);
      const cardText = cards.map(c => c.code).join("\n");

      // 分块发送（Telegram 消息长度限制）
      const chunkSize = 20;
      let sentMsg = `🎫 【卡密生成成功】\n\n• 数量: ${count}\n• 时长: ${days} 天\n• 价格: ${price || "未设置"}\n\n`;
      let chunk = "";
      let msgCount = 0;
      for (const c of cards) {
        chunk += c.code + "\n";
        if (chunk.split("\n").length > 18 || c === cards[cards.length - 1]) {
          await sendTGText(ADMIN_BOT_TOKEN, chatId, sentMsg + "```\n" + chunk + "```");
          chunk = "";
          msgCount++;
          if (msgCount === 1) sentMsg = ""; // 后续消息不再重复头部
        }
      }
      if (msgCount === 0) {
        await sendTGText(ADMIN_BOT_TOKEN, chatId, sentMsg + "```\n" + cardText + "```");
      }
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 已生成 ${count} 张卡密，请复制上方卡密发放给买家。\n\n买家在 @${getStoreBotUsername()} 发送「🎫 兑换卡密」即可自助兑换！`, MAIN_MENU);
      return new Response("OK");
    }

    // 卡密查询流程
    if (actionState && actionState.mode === "card_query") {
      const q = text.trim().toUpperCase();
      await env.SUB_STORE.delete("admin_action_state");
      if (!q) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 输入无效", MAIN_MENU);
        return new Response("OK");
      }
      const cardStr = await env.SUB_STORE.get(`card_${q}`);
      if (cardStr) {
        const c = JSON.parse(cardStr);
        const statusDesc = c.status === "used" ? `已使用 🔵\n使用人: ${c.usedBy}\n使用时间: ${new Date(c.usedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : (c.status === "disabled" ? "已禁用 🔴" : "未使用 🟢");
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `🎫 【卡密信息】\n\n• 卡密: \`${c.code}\`\n• 套餐: ${c.planName}\n• 时长: ${c.days} 天\n• 价格: ${c.price || "未设置"}\n• 状态: ${statusDesc}`,
          MAIN_MENU);
      } else {
        // 模糊搜索（游标分页）
        const cardKeys = await listAllKeys(env, "card_", 10000);
        const matches = [];
        for (const k of cardKeys) {
          const c = JSON.parse(await env.SUB_STORE.get(k));
          if (c.code.includes(q)) matches.push(c);
        }
        if (matches.length > 0) {
          let msg = `🔍 【匹配 ${matches.length} 张卡密】\n\n`;
          for (const m of matches.slice(0, 10)) {
            msg += `• ${m.code} - ${m.status === "used" ? "已用" : (m.status === "disabled" ? "禁用" : "未用")} (${m.days}天)\n`;
          }
          await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
        } else {
          await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 未找到卡密: ${q}`, MAIN_MENU);
        }
      }
      return new Response("OK");
    }

    // 分销系统
    if (text === "💰 分销系统") {
      const resellerMenu = {
        keyboard: [
          [{ text: "📋 分销商列表" }, { text: "➕ 创建分销商" }],
          [{ text: "📈 设置佣金比例" }, { text: "🔗 推广链接" }],
          [{ text: "🗑️ 删除分销商" }],
          [{ text: "🏠 返回主菜单" }]
        ],
        resize_keyboard: true,
        persistent: true
      };
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "💰 【分销系统】\n管理你的分销网络：", resellerMenu);
      return new Response("OK");
    }

    // 设置佣金比例
    if (text === "📈 设置佣金比例") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "comm_pct", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "📈 【设置佣金比例】\n请输入佣金百分比（如 20 = 20%）：\n\n当前默认佣金比例: " + ((await env.SUB_STORE.get("comm_rate")) || "10") + "%",
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 佣金比例保存
    if (actionState && actionState.mode === "comm_pct") {
      const rate = parseFloat(text.trim());
      await env.SUB_STORE.delete("admin_action_state");
      if (isNaN(rate) || rate < 0 || rate > 100) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 无效比例，请输入 0-100 的数字", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("comm_rate", rate.toString());
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【佣金比例已设置】\n佣金: ${rate}%`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 推广链接
    if (text === "🔗 推广链接") {
      const resellerKeys = await listAllKeys(env, "reseller_", 2000);
      if (resellerKeys.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 请先创建分销商", MAIN_MENU);
      } else {
        let msg = `🔗 【分销商推广链接】\n\n`;
        for (const k of resellerKeys) {
          const r = JSON.parse(await env.SUB_STORE.get(k));
          msg += `• ${r.name}\n  推广码: \`${r.code}\`\n  链接: ${getStoreOrigin(request)}/r/${r.code}\n\n`;
        }
        msg += `买家打开链接会自动关联该分销商。`;
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 分销商列表
    if (text === "📋 分销商列表") {
      const resellerKeys = await listAllKeys(env, "reseller_", 2000);
      if (resellerKeys.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前还没有分销商\n点击【➕ 创建分销商】添加", MAIN_MENU);
      } else {
        let textMsg = `💰 【分销商列表】\n\n`;
        for (const k of resellerKeys) {
          const r = JSON.parse(await env.SUB_STORE.get(k));
          textMsg += `• ${r.name || k.replace("reseller_", "")}\n  邀请码: \`${r.code}\`\n  推广点击: ${r.clicks || 0}\n  成交订单: ${r.orders || 0}\n  佣金: ${r.commission || 0} 元\n`;
        }
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, textMsg, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 删除分销商（第一步：显示列表供选择）
    if (text === "🗑️ 删除分销商") {
      const resellerKeys = await listAllKeys(env, "reseller_", 2000);
      if (resellerKeys.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前还没有分销商", MAIN_MENU);
      } else {
        const btns = [];
        for (const k of resellerKeys) {
          const r = JSON.parse(await env.SUB_STORE.get(k));
          const rId = k.replace("reseller_", "");
          btns.push([{ text: `${r.name} (${r.code})`, callback_data: `delreseller_${rId}` }]);
        }
        btns.push([{ text: "❌ 取消", callback_data: "cancel_action" }]);
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `🗑️ 【删除分销商】\n请选择要删除的分销商：`,
            reply_markup: { inline_keyboard: btns }
          })
        });
      }
      return new Response("OK");
    }

    // 创建分销商（第一步：输入名称）
    if (text === "➕ 创建分销商") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "reseller_name", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "➕ 【创建分销商】\n请输入分销商名称（如：张三）：",
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 创建分销商流程：输入名称
    if (actionState && actionState.mode === "reseller_name") {
      const name = text.trim();
      await env.SUB_STORE.delete("admin_action_state");
      if (!name) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 名称无效，已取消", MAIN_MENU);
      } else {
        const code = "R" + Math.floor(10000 + Math.random() * 90000);
        const id = Date.now().toString(36);
        await env.SUB_STORE.put(`reseller_${id}`, JSON.stringify({
          code,
          name,
          commission: 0,
          clicks: 0,
          createdAt: Date.now()
        }));
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
          `✅ 【分销商已创建】\n\n• 名称: ${name}\n• 邀请码: \`${code}\`\n• 推广链接: ${getStoreOrigin(request)}/r/${code}\n\n买家打开推广链接或使用邀请码购买，即可关联佣金。`,
          MAIN_MENU);
      }
      return new Response("OK");
    }

    // 系统概览
    if (text === "📊 系统概览") {
      const overviewMsg = await buildOverview(env);
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, overviewMsg, MAIN_MENU);
      return new Response("OK");
    }

    // 群发通知
    if (text === "📣 群发通知") {
      await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "broadcast", chatId }));
      const replyMarkup = { inline_keyboard: [[{ text: "❌ 取消", callback_data: "cancel_action" }]] };
      await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "📣 【群发通知】\n请发送要群发的消息内容：\n\n（将发送给所有已开通用户）",
          reply_markup: replyMarkup
        })
      });
      return new Response("OK");
    }

    // 群发流程：收到文本
    if (actionState && actionState.mode === "broadcast") {
      const userKeys = await listAllKeys(env, "user_", 10000);
      let sentCount = 0;
      for (const k of userKeys) {
        const u = JSON.parse(await env.SUB_STORE.get(k));
        if (u.chatId) {
          try {
            await sendTGText(STORE_BOT_TOKEN, u.chatId, `📢 ${text}`);
            sentCount++;
          } catch (e) {}
        }
      }
      await env.SUB_STORE.delete("admin_action_state");
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【群发完成】\n已发送给 ${sentCount} 位用户`, MAIN_MENU);
      return new Response("OK");
    }

    // 操作日志
    if (text === "📜 操作日志") {
      const logs = await env.SUB_STORE.list({ prefix: "log_", limit: 100 });
      if (logs.keys.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 暂无操作日志", MAIN_MENU);
      } else {
        // 按时间倒序
        const entries = [];
        for (const k of logs.keys) {
          entries.push(JSON.parse(await env.SUB_STORE.get(k.name)));
        }
        entries.sort((a, b) => (b.time || 0) - (a.time || 0));

        let msg = `📜 【操作日志】(最近 ${entries.length} 条)\n\n`;
        for (const e of entries.slice(0, 20)) {
          const timeStr = new Date(e.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
          msg += `• ${e.action}: ${e.detail}\n  ${timeStr}\n`;
        }
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 帮助说明
    if (text === "❓ 帮助说明" || text === "/start") {
      const helpMsg = `👑 【AETHERIA 管理中枢使用指南】\n\n` +
                      `**👥 用户管理**\n- 用户列表：查看所有用户及状态\n- 查找用户：/check UID 或 /check ChatID\n- 用户统计：活跃/过期/禁用分布\n- 即将到期：7天内到期用户\n- 手动开卡：为指定 ChatID 开通\n- 调整时长：给用户加/减天数\n- 用户备注：给用户打标签\n- 私信用户：一对一给用户发消息\n- 导出名单：导出全部用户信息\n\n` +
                      `**🎫 卡密管理**\n- 生成卡密：/gencard 数量 天数 价格\n- 买家自助兑换，无需审核\n- 卡密统计/查询/清理\n\n` +
                      `**📦 订单管理**\n- 待审核：查看付款凭证\n- 已处理：处理记录\n- 收款流水：订单流水与金额统计\n- 发货：凭证下方点【确认到账】\n\n` +
                      `**⚙️ 系统设置**\n- 上游池：/addurl 链接 添加（可无限加）\n- 管理上游：/listurl /delurl /setdef\n- 合并节点：/merge on 合并所有上游节点\n- 节点管理：/nodes 查看 /nodeoff 禁用 /nodeon 启用\n- 收款码：点菜单后发图，自动转换\n- 价格：/price 内容\n- 天数：/days 数字\n- 公告：📢 发布公告\n\n` +
                      `**📣 群发通知**\n- 给所有用户发消息\n\n` +
                      `**💰 分销系统**\n- 创建分销商（自动生成推广链接）\n- 设置佣金比例\n- 查看推广点击与佣金\n\n` +
                      `**📊 系统概览**\n- 用户/订单/卡密/流水全统计\n\n` +
                      `**⏰ 到期提醒（自动）**\n- 到期前 ${REMINDER_DAYS.join("/")} 天自动通知`;
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, helpMsg, MAIN_MENU);
      return new Response("OK");
    }

    // 返回主菜单
    if (text === "🏠 返回主菜单") {
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "🏠 已返回主菜单，请选择操作：", MAIN_MENU);
      return new Response("OK");
    }

    // /cancel 命令：取消当前操作并清除提示消息
    if (text === "/cancel") {
      await env.SUB_STORE.delete("admin_action_state");
      // 尝试清除触发消息
      try {
        await deleteTGMessage(ADMIN_BOT_TOKEN, chatId, msg.message_id);
      } catch (e) {}
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 已取消当前操作", MAIN_MENU);
      return new Response("OK");
    }

    // 收款码托管：等待状态下直接收图（无需配文），或传统方式（图片+配文 /setqr）
    // 支持多张：可连续上传多张，全部收录
    if (msg.photo && (text.includes("/setqr") || (actionState && actionState.mode === "setqr"))) {
      const adminFileId = msg.photo[msg.photo.length - 1].file_id;
      // 不清除 setqr 状态（允许连续上传多张），除非配文带了 /done
      if (!text.includes("/done")) {
        await env.SUB_STORE.put("admin_action_state", JSON.stringify({ mode: "setqr", chatId }));
      } else {
        await env.SUB_STORE.delete("admin_action_state");
      }
      // 自动清除收款码图片消息
      try {
        await deleteTGMessage(ADMIN_BOT_TOKEN, chatId, msg.message_id);
      } catch (e) {}

      // 关键：将图片转为前台 Bot 可用的 file_id
      try {
        const storeFileId = await convertQRForStoreBot(adminFileId);
        if (storeFileId) {
          const list = await addPaymentQR(env, storeFileId, text.replace("/done", "").trim() || undefined);
          const doneText = text.includes("/done") ? "\n（已完成上传）" : "";
          const continueText = text.includes("/done") ? "" : "\n\n可继续上传下一张，或发送 /done 完成";
          await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
            `✅ 【收款码已收录】第 ${list.length} 张！\n\n当前共 ${list.length} 张收款码${doneText}${continueText}`,
            text.includes("/done") ? MAIN_MENU : { keyboard: [[{ text: "✅ 完成上传" }], [{ text: "🏠 返回主菜单" }]], resize_keyboard: true, persistent: true });
        } else {
          await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 收款码转换失败，请重新上传。", MAIN_MENU);
        }
      } catch (e) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 收款码处理异常，请稍后重试。", MAIN_MENU);
      }
      return new Response("OK");
    }

    // 完成上传（/done 或按钮）
    if (text === "✅ 完成上传" || text === "/done") {
      await env.SUB_STORE.delete("admin_action_state");
      const list = await getPaymentQRs(env);
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId,
        `✅ 【收款码上传完成】\n当前共 ${list.length} 张收款码。\n\n买家购买时将${list.length > 1 ? "随机展示其中一张" : "展示这张"}。\n\n可用 /qrlist 查看，/qrdel 序号 删除。`,
        MAIN_MENU);
      return new Response("OK");
    }

    // 查看收款码列表
    if (text === "/qrlist") {
      const list = await getPaymentQRs(env);
      if (list.length === 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "📭 当前没有收款码\n发送 /setqr 后上传即可添加", MAIN_MENU);
      } else {
        let msg = `🖼️ 【收款码列表】(${list.length} 张)\n\n`;
        list.forEach((q, i) => {
          msg += `${i + 1}. ${q.note || "收款码"}\n  添加于 ${new Date(q.addedAt).toLocaleDateString("zh-CN")}\n`;
        });
        msg += `\n删除：/qrdel 序号`;
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, msg, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 删除收款码
    if (text.startsWith("/qrdel")) {
      const idx = parseInt(text.replace("/qrdel", "").trim()) - 1;
      const r = await removePaymentQR(env, idx);
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, MAIN_MENU);
      return new Response("OK");
    }

    // 设置上游（兼容旧命令，实际加入上游池）
    if (text.startsWith("/setup ")) {
      const upstream = text.replace("/setup ", "").trim();
      const r = await addUpstream(env, upstream, "手动设置");
      // 兼容旧逻辑：同时写 default_upstream_url
      if (r.ok) {
        await env.SUB_STORE.put("default_upstream_url", upstream);
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ ${r.msg}${r.isDefault ? "（已设为默认）" : ""}\n\n如需管理多个上游，请用 /addurl 添加更多。`, MAIN_MENU);
      } else {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ ${r.msg}\n如需更换请使用 /addurl 添加`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 设置价格
    if (text.startsWith("/price ")) {
      const price = text.replace("/price ", "").trim();
      await env.SUB_STORE.put("price_info", price);
      await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【套餐价格已设置】\n${price}`, MAIN_MENU);
      return new Response("OK");
    }

    // 设置天数
    if (text.startsWith("/days ")) {
      const days = parseInt(text.replace("/days ", "").trim());
      if (isNaN(days) || days <= 0) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "❌ 格式错误，请使用：`/days 30`", MAIN_MENU);
      } else {
        await env.SUB_STORE.put("default_days", days.toString());
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `✅ 【默认时长已设置】\n${days} 天`, MAIN_MENU);
      }
      return new Response("OK");
    }

    // 查存: /check UID 或 /check @ChatID
    if (text.startsWith("/check ")) {
      const target = text.replace("/check ", "").trim();
      let targetUid = target;
      let userDataStr = await env.SUB_STORE.get(`user_${targetUid}`);

      // 若非 UID 直接命中，尝试按 ChatID 搜索（走索引）
      if (!userDataStr) {
        const targetChatId = parseInt(target.replace("@", ""));
        if (!isNaN(targetChatId)) {
          const uidByChat = await findUidByChatId(env, targetChatId);
          if (uidByChat) {
            targetUid = uidByChat;
            userDataStr = await env.SUB_STORE.get(`user_${uidByChat}`);
          }
        }
      }

      if (!userDataStr) {
        await sendTGMenu(ADMIN_BOT_TOKEN, chatId, `❌ 数据库未找到 UID/ChatID: ${target}`, MAIN_MENU);
      } else {
        const u = JSON.parse(userDataStr);
        const remainDays = Math.ceil((u.expiry - Date.now()) / 86400000);
        const stateDesc = u.status === "disabled" ? "🔴 禁用中" : (remainDays <= 0 ? "⏳ 已过期" : "🟢 正常运行");
        const origin = new URL(request.url).origin;

        const replyMarkup = {
          inline_keyboard: [
            [
              { text: "🔴 禁用", callback_data: `disable_${targetUid}` },
              { text: "🟢 开启", callback_data: `enable_${targetUid}` },
              { text: "🗑️ 删除", callback_data: `del_${targetUid}` }
            ],
            [
              { text: "🎯 分配上游", callback_data: `assign_${targetUid}` },
              { text: "↩️ 撤销删除", callback_data: `undel_${targetUid}` }
            ]
          ]
        };

        // 上游状态显示
        const upStatus = u.upstreamUrl ? `🎯 已指定:\n${u.upstreamUrl.slice(0, 50)}` : "🔄 自动分配";

        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `📊 【用户档案: ${targetUid}】\n• 状态: ${stateDesc}\n• 剩余: ${Math.max(0, remainDays)} 天\n• 到期: ${new Date(u.expiry).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}\n• ChatID: ${u.chatId || "-"}\n${u.note ? `• 备注: ${u.note}\n` : ""}• 上游: ${upStatus}\n• 短链: ${origin}/s/${targetUid}`,
            reply_markup: replyMarkup
          })
        });
      }
      return new Response("OK");
    }

    // 默认兜底
    await sendTGMenu(ADMIN_BOT_TOKEN, chatId, "收到指令。如需帮助请点击下方菜单或发送 /start", MAIN_MENU);
    return new Response("OK");
  } catch (err) {
    return new Response("OK");
  }
}

// ==================== 辅助工具 ====================
// ===== 通用工具：KV 游标分页遍历（突破单次 1000 key 上限）=====
// Cloudflare KV list 单次最多返回 1000 个 key，用游标循环取全量
async function listAllKeys(env, prefix, limit = 10000) {
  const keys = [];
  let cursor = undefined;
  do {
    const opts = { prefix, limit: 1000 };
    if (cursor) opts.cursor = cursor;
    const page = await env.SUB_STORE.list(opts);
    for (const k of page.keys) {
      keys.push(k.name);
      if (keys.length >= limit) return keys;
    }
    cursor = page.cursor;
  } while (cursor);
  return keys;
}

// ===== 通用工具：唯一 ID 生成 =====
// UID 用 8 位随机数字（范围更大），带 KV 存在性重试，杜绝碰撞覆盖
async function genUniqueUid(env) {
  for (let i = 0; i < 5; i++) {
    const uid = Math.floor(10000000 + Math.random() * 89999999).toString(); // 8位
    if (!(await env.SUB_STORE.get(`user_${uid}`))) return uid;
  }
  // 兜底：加时间戳尾数，几乎不可能再碰撞
  return Math.floor(10000000 + Math.random() * 89999999).toString() + Date.now().toString().slice(-2);
}

// 生成唯一订单号（ORD- + 时间戳36进制 + 随机），杜绝碰撞
function genOrderId() {
  return "ORD-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// ===== 通用工具：chatId 反向索引 =====
// 维护 chatIdx_{chatId} → uid 映射，避免每次全表扫描 user_
async function indexUserChatId(env, chatId, uid) {
  if (!chatId || !uid) return;
  await env.SUB_STORE.put(`chatIdx_${chatId}`, uid);
}

// 通过 chatId 反查 uid（索引优先，兜底全表扫描兼容旧数据）
async function findUidByChatId(env, chatId) {
  const idx = await env.SUB_STORE.get(`chatIdx_${chatId}`);
  if (idx) return idx;
  // 兜底扫描（兼容没有索引的旧用户）
  const keys = await listAllKeys(env, "user_", 5000);
  for (const k of keys) {
    try {
      const u = JSON.parse(await env.SUB_STORE.get(k));
      if (u.chatId === chatId) {
        const uid = k.replace("user_", "");
        await indexUserChatId(env, chatId, uid); // 顺手补索引
        return uid;
      }
    } catch (e) {}
  }
  return null;
}

// 删除用户时同步清理 chatId 索引
async function unindexUserChatId(env, chatId) {
  if (chatId) await env.SUB_STORE.delete(`chatIdx_${chatId}`);
}

// 清除用户所有订阅缓存变体（普通/legacy/yaml），删除用户时必须全清
async function clearUserCache(env, uid) {
  const keys = [`cache_${uid}`, `cache_${uid}_legacy`, `cache_${uid}_yaml`];
  for (const k of keys) {
    try { await env.SUB_STORE.delete(k); } catch (e) {}
  }
}

// ===== 通用工具：用户选择器 =====
// 管理端点"调整时长/分配上游/备注/私信/删除"等时，直接列出所有用户供选择
// mode 用于回调区分：adjust/assign/note/msg/del
async function showUserPicker(env, chatId, mode, title) {
  const userKeys = await listAllKeys(env, "user_", 5000);
  if (userKeys.length === 0) {
    await sendTGText(ADMIN_BOT_TOKEN, chatId, "📭 当前没有任何用户");
    return;
  }
  // 构建按钮：每行 3 个 UID
  const rows = [];
  let row = [];
  for (const k of userKeys) {
    const uid = k.replace("user_", "");
    row.push({ text: uid, callback_data: `pick_${mode}_${uid}` });
    if (row.length === 3) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: "❌ 取消", callback_data: "cancel_action" }]);

  await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: title,
      reply_markup: { inline_keyboard: rows }
    })
  });
}

// ===== 通用工具：分销关联 =====
// 记录买家 chatId 的推荐分销商（deep link /start=code 时写入）
async function setBuyerAffiliate(env, chatId, code) {
  if (!chatId || !code) return;
  await env.SUB_STORE.put(`aff_${chatId}`, code, { expirationTtl: 7776000 }); // 90天
}

// 读取买家关联的分销商（若无返回 null）
async function getBuyerAffiliate(env, chatId) {
  try {
    const code = await env.SUB_STORE.get(`aff_${chatId}`);
    if (!code) return null;
    // 根据 code 找分销商
    const keys = await listAllKeys(env, "reseller_", 2000);
    for (const k of keys) {
      try {
        const r = JSON.parse(await env.SUB_STORE.get(k));
        if (r.code === code) return { key: k, reseller: r };
      } catch (e) {}
    }
    return null;
  } catch (e) { return null; }
}

// 给分销商结算佣金（单价 × 比例）
async function creditReseller(env, chatId, planPrice) {
  try {
    const aff = await getBuyerAffiliate(env, chatId);
    if (!aff) return;
    const rate = parseFloat(await env.SUB_STORE.get("comm_rate")) || 10;
    const priceNum = parseFloat(String(planPrice || "").replace(/[^\d.]/g, ""));
    if (isNaN(priceNum) || priceNum <= 0) return;
    const commission = +(priceNum * rate / 100).toFixed(2);
    if (commission <= 0) return;
    aff.reseller.commission = (aff.reseller.commission || 0) + commission;
    aff.reseller.orders = (aff.reseller.orders || 0) + 1;
    await env.SUB_STORE.put(aff.key, JSON.stringify(aff.reseller));
  } catch (e) {}
}

// ===== 通用工具：频控（每 chatId 每动作 N 秒内限一次）=====
async function rateLimit(env, scope, chatId, seconds = 5) {
  const key = `rl_${scope}_${chatId}`;
  const last = await env.SUB_STORE.get(key);
  const now = Date.now();
  if (last && (now - parseInt(last)) < seconds * 1000) return false;
  try {
    // ⚠️ Cloudflare KV 的 expirationTtl 最小是 60 秒！小于 60 会抛错
    // 这里用 put 前先 get 判断的方式 + 存时间戳 + 最小 TTL 60
    await env.SUB_STORE.put(key, now.toString(), { expirationTtl: Math.max(seconds, 60) });
  } catch (e) {
    // 频控写失败不应阻断业务（降级为不频控）
    try { await env.SUB_STORE.put(key, now.toString()); } catch (e2) {}
  }
  return true;
}

// ===== 通用工具：收款码状态 =====
async function hasPaymentQR(env) {
  const list = await getPaymentQRs(env);
  return list.length > 0;
}

// 读取套餐列表（支持管理员自定义覆盖）
async function getPlans(env) {
  const plansStr = await env.SUB_STORE.get("plans_config");
  if (plansStr) {
    try { return JSON.parse(plansStr); } catch (e) {}
  }
  return DEFAULT_PLANS;
}

// 保存套餐列表
async function savePlans(env, plans) {
  await env.SUB_STORE.put("plans_config", JSON.stringify(plans));
}

// ===== 多上游池系统 =====
// 读取上游池
async function getUpstreamPool(env) {
  const poolStr = await env.SUB_STORE.get("upstream_list");
  if (poolStr) {
    try {
      const arr = JSON.parse(poolStr);
      if (Array.isArray(arr)) return arr;
    } catch (e) {}
  }
  return [{
    url: DEFAULT_UPSTREAM_URL,
    note: "默认上游",
    status: "active",
    addedAt: Date.now(),
    isDefault: true
  }];
}

// 保存上游池
async function saveUpstreamPool(env, pool) {
  await env.SUB_STORE.put("upstream_list", JSON.stringify(pool));
}

// 获取用户应使用的上游 URL（优先专属 → 轮询分配）
async function getUpstreamForUser(env, uid, user) {
  // 1. 用户已有专属 upstreamUrl 且有效 → 直接用
  if (user.upstreamUrl) return user.upstreamUrl;

  const pool = await getUpstreamPool(env);
  const active = pool.filter(u => u.status === "active");
  if (active.length === 0) return null;

  // 2. 轮询分配：根据 uid 哈希取模，同一用户固定同一上游
  let hash = 0;
  for (const ch of String(uid)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const idx = hash % active.length;
  return active[idx].url;
}

// 从池中取默认上游（用于新开用户绑定）
async function getDefaultUpstream(env) {
  const pool = await getUpstreamPool(env);
  const def = pool.find(u => u.isDefault && u.status === "active");
  if (def) return def.url;
  const active = pool.filter(u => u.status === "active");
  return active.length > 0 ? active[0].url : null;
}

// 添加/更新上游
async function addUpstream(env, url, note) {
  const pool = await getUpstreamPool(env);
  // 去重检查
  if (pool.some(u => u.url === url)) return { ok: false, msg: "该上游已存在" };
  const first = pool.length === 0;
  pool.push({
    url,
    note: note || `上游${pool.length + 1}`,
    status: "active",
    addedAt: Date.now(),
    isDefault: first
  });
  await saveUpstreamPool(env, pool);
  return { ok: true, msg: `已添加，当前共 ${pool.length} 个上游`, index: pool.length - 1, isDefault: first };
}

// 删除上游
async function removeUpstream(env, index) {
  const pool = await getUpstreamPool(env);
  if (index < 0 || index >= pool.length) return { ok: false, msg: "序号无效" };
  const removed = pool.splice(index, 1)[0];
  // 若删的是默认，设置新的默认
  if (removed.isDefault && pool.length > 0) {
    pool[0].isDefault = true;
  }
  await saveUpstreamPool(env, pool);
  return { ok: true, msg: `已删除: ${removed.note || removed.url.slice(0, 30)}` };
}

// 设置默认上游
async function setDefaultUpstream(env, index) {
  const pool = await getUpstreamPool(env);
  if (index < 0 || index >= pool.length) return { ok: false, msg: "序号无效" };
  pool.forEach((u, i) => { u.isDefault = (i === index); });
  await saveUpstreamPool(env, pool);
  return { ok: true, msg: `已将第 ${index + 1} 个设为默认` };
}

// ===== 节点级管理 =====
// 读取节点黑名单
async function getNodeBlacklist(env) {
  const str = await env.SUB_STORE.get("node_blacklist");
  if (str) {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr)) return arr;
    } catch (e) {}
  }
  return [];
}

// 保存节点黑名单
async function saveNodeBlacklist(env, list) {
  await env.SUB_STORE.put("node_blacklist", JSON.stringify(list));
}

// 拉取并解析上游节点（返回节点列表）
async function fetchUpstreamNodes(env, upstreamUrl) {
  const res = await fetch(upstreamUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
  });
  if (!res.ok) return { ok: false, nodes: [] };
  let rawData = await res.text();
  let decoded = rawData.trim();

  try {
    let b64 = decoded;
    const pad = 4 - (b64.length % 4);
    if (pad < 4) b64 += "=".repeat(pad);
    decoded = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  } catch (e) {}

  const nodes = [];
  for (let line of decoded.split("\n")) {
    line = line.trim();
    if (!line || !line.includes("://")) continue;
    const parts = line.split("#");
    const basePart = parts[0];
    let origName = parts[1] ? decodeURIComponent(parts[1]) : "Node";

    let hostKey = basePart;
    try {
      const u = new URL(basePart.includes("://") ? basePart : "http://" + basePart);
      hostKey = u.hostname + ":" + u.port;
    } catch (err) {}

    nodes.push({ host: hostKey, name: origName, raw: line });
  }
  return { ok: true, nodes };
}

// 检查是否启用合并模式
async function isMergeMode(env) {
  const v = await env.SUB_STORE.get("merge_mode");
  return v === "on";
}

// ===== 生成 Clash YAML 订阅（供只支持 YAML 导入的客户端使用）=====
// 输入: 清洗后的节点行数组（vless:// / hysteria2:// / vmess:// 等）
// 输出: Clash Meta 兼容的 YAML 文本
function generateClashYAML(nodes, brand, uid) {
  const proxies = [];
  const seen = new Set();

  for (const line of nodes) {
    const l = line.trim();
    if (!l || !l.includes("://")) continue;

    // 提取名称（# 后）
    let name = "Node";
    let urlPart = l;
    const hashIdx = l.indexOf("#");
    if (hashIdx >= 0) {
      urlPart = l.slice(0, hashIdx);
      try { name = decodeURIComponent(l.slice(hashIdx + 1)); } catch (e) { name = l.slice(hashIdx + 1); }
    }

    try {
      const u = new URL(urlPart);

      if (urlPart.startsWith("vless://")) {
        const params = u.searchParams;
        const enc = params.get("encryption") || "none";
        // 后量子加密（mlkem768x25519plus）老内核不支持，跳过
        if (enc && enc.includes("mlkem768x25519plus")) continue;
        const proxy = {
          name,
          type: "vless",
          server: u.hostname,
          port: u.port ? parseInt(u.port) : 443,
          uuid: u.username,
          network: params.get("type") || "tcp",
          "tls": params.get("security") === "reality" ? true : (params.get("security") === "tls" ? true : false),
          "servername": params.get("sni") || u.hostname,
          "client-fingerprint": params.get("fp") || "chrome",
          "reality-opts": {
            "public-key": params.get("pbk") || "",
            "short-id": params.get("sid") || ""
          }
        };
        if (params.get("flow")) proxy["flow"] = params.get("flow");
        if (params.get("headerType") && params.get("headerType") !== "none") proxy["header-type"] = params.get("headerType");
        if (params.get("path")) {
          proxy["ws-opts"] = { path: params.get("path") };
          if (params.get("host")) proxy["ws-opts"]["headers"] = { Host: params.get("host") };
        }
        proxies.push(proxy);
      }
      else if (urlPart.startsWith("hysteria2://")) {
        const params = u.searchParams;
        const proxy = {
          name,
          type: "hysteria2",
          server: u.hostname,
          port: u.port ? parseInt(u.port) : 443,
          password: u.username,
          "skip-cert-verify": params.get("insecure") === "1" ? true : false
        };
        if (params.get("sni")) proxy["sni"] = params.get("sni");
        if (params.get("obfs")) {
          proxy["obfs"] = params.get("obfs");
          if (params.get("obfs-password")) proxy["obfs-password"] = decodeURIComponent(params.get("obfs-password"));
        }
        proxies.push(proxy);
      }
      else if (urlPart.startsWith("vmess://")) {
        // vmess:// 可能是 base64 编码的 JSON
        try {
          let jsonStr = u.username;
          // 若是 base64，解码
          if (jsonStr && !jsonStr.startsWith("{")) {
            try {
              const pad = 4 - (jsonStr.length % 4);
              if (pad < 4) jsonStr += "=".repeat(pad);
              jsonStr = new TextDecoder().decode(Uint8Array.from(atob(jsonStr), c => c.charCodeAt(0)));
            } catch (e) {}
          }
          const vm = JSON.parse(jsonStr);
          const proxy = {
            name,
            type: "vmess",
            server: vm.add || u.hostname,
            port: vm.port ? parseInt(vm.port) : 443,
            uuid: vm.id,
            alterId: vm.aid ? parseInt(vm.aid) : 0,
            cipher: vm.scy || "auto",
            network: vm.net || "tcp"
          };
          if (vm.tls) proxy["tls"] = vm.tls === "tls" ? true : vm.tls;
          if (vm.sni) proxy["servername"] = vm.sni;
          if (vm.host && proxy.network === "ws") proxy["ws-opts"] = { headers: { Host: vm.host } };
          if (vm.path && proxy.network === "ws") {
            proxy["ws-opts"] = proxy["ws-opts"] || {};
            proxy["ws-opts"]["path"] = vm.path;
          }
          proxies.push(proxy);
        } catch (e) { /* 解析失败跳过 */ }
      }
    } catch (e) { /* 单个节点解析失败跳过 */ }
  }

  // 组名
  const groupName = `${brand || "Maybe"} 节点 [UID:${uid}]`;

  // 生成 YAML
  let yaml = `# ${groupName}\n# 由 AETHERIA 自动生成 (${new Date().toISOString()})\n\n`;
  yaml += `mixed-port: 7890\n`;
  yaml += `allow-lan: false\n`;
  yaml += `mode: rule\n`;
  yaml += `log-level: info\n\n`;
  yaml += `proxies:\n`;
  for (const p of proxies) {
    yaml += `  - name: ${JSON.stringify(p.name)}\n`;
    for (const [k, v] of Object.entries(p)) {
      if (k === "name") continue;
      if (typeof v === "object" && v !== null) {
        yaml += `    ${k}:\n`;
        for (const [k2, v2] of Object.entries(v)) {
          if (typeof v2 === "object" && v2 !== null) {
            yaml += `      ${k2}:\n`;
            for (const [k3, v3] of Object.entries(v2)) {
              yaml += `        ${k3}: ${JSON.stringify(v3)}\n`;
            }
          } else {
            yaml += `      ${k2}: ${JSON.stringify(v2)}\n`;
          }
        }
      } else {
        yaml += `    ${k}: ${JSON.stringify(v)}\n`;
      }
    }
    yaml += "\n";
  }
  yaml += `proxy-groups:\n`;
  yaml += `  - name: "🚀 节点选择"\n`;
  yaml += `    type: select\n`;
  yaml += `    proxies:\n`;
  for (const p of proxies) {
    yaml += `      - ${JSON.stringify(p.name)}\n`;
  }
  yaml += `  - name: "♻️ 自动选择"\n`;
  yaml += `    type: url-test\n`;
  yaml += `    url: "http://www.gstatic.com/generate_204"\n`;
  yaml += `    interval: 300\n`;
  yaml += `    proxies:\n`;
  for (const p of proxies) {
    yaml += `      - ${JSON.stringify(p.name)}\n`;
  }
  yaml += `rules:\n`;
  yaml += `  - MATCH,🚀 节点选择\n`;

  return yaml;
}

// 合并拉取所有活跃上游的节点（仅对完全相同的节点去重，保留各上游全部节点）
async function fetchAllUpstreamsMerged(env) {
  const pool = await getUpstreamPool(env);
  const active = pool.filter(u => u.status === "active");
  const seenLines = new Set();  // 只对完全相同的内容去重
  const mergedNodes = [];

  // 并行拉取所有上游
  const results = await Promise.allSettled(
    active.map(up => fetchUpstreamNodes(env, up.url))
  );

  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value.ok) continue;
    for (const node of r.value.nodes) {
      if (seenLines.has(node.raw)) continue;  // 完全相同才跳过
      seenLines.add(node.raw);
      mergedNodes.push(node);
    }
  }
  return mergedNodes;
}

// 节点是否被禁用
async function isNodeDisabled(env, hostKey) {
  const blacklist = await getNodeBlacklist(env);
  return blacklist.includes(hostKey);
}

// 批量操作节点（action: "off"/"on"）
// 输入: 逗号分隔序号 或 "all"
// 返回: { ok, done, skipped, hosts }
async function batchToggleNodes(env, action, nodeIdxList, upIdx) {
  const pool = await getUpstreamPool(env);
  if (upIdx < 0 || upIdx >= pool.length) return { ok: false, msg: "上游序号无效" };
  const up = pool[upIdx];
  const result = await fetchUpstreamNodes(env, up.url);
  if (!result.ok) return { ok: false, msg: "上游拉取失败" };

  let idxList = [];
  if (nodeIdxList === "all") {
    idxList = result.nodes.map((_, i) => i + 1);
  } else {
    idxList = nodeIdxList.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 1 && n <= result.nodes.length);
    if (idxList.length === 0) return { ok: false, msg: "没有有效的节点序号" };
  }

  let blacklist = await getNodeBlacklist(env);
  let done = 0, skipped = 0;
  const affected = [];

  for (const idx of idxList) {
    const node = result.nodes[idx - 1];
    const inList = blacklist.includes(node.host);
    if (action === "off") {
      if (!inList) {
        blacklist.push(node.host);
        done++;
        affected.push(node.host);
      } else {
        skipped++;
      }
    } else { // on
      if (inList) {
        blacklist = blacklist.filter(h => h !== node.host);
        done++;
        affected.push(node.host);
      } else {
        skipped++;
      }
    }
  }

  await saveNodeBlacklist(env, blacklist);

  // 有变化则清理所有订阅缓存
  if (done > 0) {
    const cacheKeys = await listAllKeys(env, "cache_", 10000);
    for (const k of cacheKeys) {
      await env.SUB_STORE.delete(k);
    }
  }

  return { ok: true, done, skipped, affected, action };
}

// ===== 优惠券系统 =====
// 生成优惠券码（折扣卡密，使用后按折扣价兑换对应天数）
function genCouponCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "CP-";
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (i < 2) code += "-";
  }
  return code;
}

// 生成优惠券
async function genCoupons(env, count, days, discountPct, note) {
  const coupons = [];
  for (let i = 0; i < count; i++) {
    const code = genCouponCode();
    const coupon = {
      code,
      days,
      discountPct, // 折扣百分比，如 80 = 8折
      note: note || "优惠券",
      status: "unused",
      usedBy: null,
      usedAt: null,
      createdAt: Date.now()
    };
    await env.SUB_STORE.put(`coupon_${code}`, JSON.stringify(coupon), { expirationTtl: 7776000 }); // 90天
    coupons.push(coupon);
  }
  return coupons;
}

// 兑换优惠券
async function redeemCoupon(env, code, chatId) {
  const key = `coupon_${code}`;
  const couponStr = await env.SUB_STORE.get(key);
  if (!couponStr) return { ok: false, msg: "❌ 优惠券不存在或已过期" };

  const coupon = JSON.parse(couponStr);
  if (coupon.status === "used") return { ok: false, msg: "❌ 该优惠券已被使用" };

  // 折扣实际生效：如 80 折 → 送 80% 天数
  const actualDays = Math.max(1, Math.round((coupon.days || 30) * (coupon.discountPct || 100) / 100));

  // 检查该 ChatID 是否已有订阅（走索引）
  const existingUid = await findUidByChatId(env, chatId);
  let existingUser = existingUid ? JSON.parse(await env.SUB_STORE.get(`user_${existingUid}`)) : null;

  const upstream = await getDefaultUpstream(env);
  const now = Date.now();
  let finalUid;

  if (existingUid) {
    finalUid = existingUid;
    const base = Math.max(existingUser.expiry, now);
    existingUser.expiry = base + (actualDays * 86400000);
    existingUser.status = "active";
    existingUser.plan = coupon.note || `${actualDays} 天`;
    await env.SUB_STORE.put(`user_${existingUid}`, JSON.stringify(existingUser));
  } else {
    finalUid = await genUniqueUid(env);
    await env.SUB_STORE.put(`user_${finalUid}`, JSON.stringify({
      upstreamUrl: upstream,
      expiry: now + (actualDays * 86400000),
      status: "active",
      brand: DEFAULT_BRAND,
      chatId,
      createdAt: now,
      plan: coupon.note || `${actualDays} 天`,
      source: "coupon"
    }));
    await indexUserChatId(env, chatId, finalUid);
  }

  coupon.status = "used";
  coupon.usedBy = chatId;
  coupon.usedAt = now;
  await env.SUB_STORE.put(key, JSON.stringify(coupon));

  // 记录流水（优惠券渠道也计入）
  await env.SUB_STORE.put(`record_${now}`, JSON.stringify({
    orderId: code,
    chatId,
    plan: coupon.note || `${actualDays} 天`,
    days: actualDays,
    price: "",
    time: now,
    uid: finalUid,
    type: existingUid ? "renew" : "new",
    via: "coupon"
  }), { expirationTtl: 15552000 });

  // 分销佣金结算
  await creditReseller(env, chatId, "");

  return { ok: true, msg: "🎉 优惠券兑换成功", uid: finalUid, days: actualDays, plan: coupon.note, discount: coupon.discountPct };
}

// ===== 卡密系统 =====
// 生成卡密
function genCardCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去除易混淆字符
  let code = "MB-";
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (i < 2) code += "-";
  }
  return code;
}

// 批量生成卡密
async function genCards(env, count, days, planName, price) {
  const cards = [];
  const batchId = "B" + Date.now().toString(36).toUpperCase();
  for (let i = 0; i < count; i++) {
    const code = genCardCode();
    const card = {
      code,
      days,
      planName: planName || `${days} 天套餐`,
      price: price || "",
      status: "unused", // unused / used / disabled
      usedBy: null,
      usedAt: null,
      batchId,
      createdAt: Date.now()
    };
    await env.SUB_STORE.put(`card_${code}`, JSON.stringify(card), { expirationTtl: 15552000 });
    cards.push(card);
  }
  return cards;
}

// 兑换卡密
async function redeemCard(env, code, chatId) {
  const key = `card_${code}`;
  const cardStr = await env.SUB_STORE.get(key);
  if (!cardStr) return { ok: false, msg: "❌ 卡密不存在或已失效" };

  const card = JSON.parse(cardStr);
  if (card.status === "used") return { ok: false, msg: "❌ 该卡密已被使用" };
  if (card.status === "disabled") return { ok: false, msg: "❌ 该卡密已被禁用" };

  // 检查该 ChatID 是否已有订阅（走索引）
  const existingUid = await findUidByChatId(env, chatId);
  let existingUser = existingUid ? JSON.parse(await env.SUB_STORE.get(`user_${existingUid}`)) : null;

  const upstream = await getDefaultUpstream(env);
  const now = Date.now();
  let finalUid;

  if (existingUid) {
    // 续费：延长已有订阅
    finalUid = existingUid;
    const base = Math.max(existingUser.expiry, now);
    existingUser.expiry = base + (card.days * 86400000);
    existingUser.status = "active";
    existingUser.plan = card.planName;
    await env.SUB_STORE.put(`user_${existingUid}`, JSON.stringify(existingUser));
  } else {
    // 新购：创建订阅（唯一 UID）
    finalUid = await genUniqueUid(env);
    await env.SUB_STORE.put(`user_${finalUid}`, JSON.stringify({
      upstreamUrl: upstream,
      expiry: now + (card.days * 86400000),
      status: "active",
      brand: DEFAULT_BRAND,
      chatId,
      createdAt: now,
      plan: card.planName,
      source: "card"
    }));
    await indexUserChatId(env, chatId, finalUid);
  }

  // 标记卡密已使用
  card.status = "used";
  card.usedBy = chatId;
  card.usedAt = now;
  await env.SUB_STORE.put(key, JSON.stringify(card));

  // 记录流水
  await env.SUB_STORE.put(`record_${now}`, JSON.stringify({
    orderId: code,
    chatId,
    plan: card.planName,
    days: card.days,
    price: card.price,
    time: now,
    uid: finalUid,
    type: existingUid ? "renew" : "new",
    via: "card"
  }), { expirationTtl: 15552000 });

  // 分销佣金结算（卡密渠道）
  await creditReseller(env, chatId, card.price);

  return { ok: true, msg: "🎉 兑换成功", uid: finalUid, days: card.days, plan: card.planName };
}

// 生成系统概览文本（含数据统计）
async function buildOverview(env) {
  const userKeys = await listAllKeys(env, "user_", 10000);
  const pendingKeys = await listAllKeys(env, "pending_", 2000);
  const userCount = userKeys.length;
  const pendingCount = pendingKeys.length;
  const pool = await getUpstreamPool(env);
  const activeUp = pool.filter(u => u.status === "active");
  const currentUpstream = activeUp.length > 0 ? activeUp[0].url : DEFAULT_UPSTREAM_URL;
  const hasQr = (await hasPaymentQR(env)) ? "已托管 🟢" : "未托管 🔴";
  const days = await env.SUB_STORE.get("default_days") || DEFAULT_DAYS;
  const price = await env.SUB_STORE.get("price_info") || "未设置";

  // 数据统计
  let activeCount = 0, expiredCount = 0, disabledCount = 0;
  for (const k of userKeys) {
    const u = JSON.parse(await env.SUB_STORE.get(k));
    if (u.status === "disabled") disabledCount++;
    else if (Date.now() > u.expiry) expiredCount++;
    else activeCount++;
  }

  // 订单流水统计
  const recordKeys = await listAllKeys(env, "record_", 5000);
  let recordCount = recordKeys.length;

  // 卡密统计
  const cardKeys = await listAllKeys(env, "card_", 10000);
  let cardUnused = 0;
  for (const k of cardKeys) {
    const c = JSON.parse(await env.SUB_STORE.get(k));
    if (c.status === "unused") cardUnused++;
  }

  const mergeMode = await isMergeMode(env);

  return `📊 【系统运行大盘】\n\n` +
    `👥 用户总数: ${userCount}\n` +
    `　🟢 正常: ${activeCount} | ⏳ 过期: ${expiredCount} | 🔴 禁用: ${disabledCount}\n` +
    `📦 待审订单: ${pendingCount}\n` +
    `🧾 订单流水: ${recordCount} 笔\n` +
    `🎫 可用卡密: ${cardUnused} 张\n` +
    `💰 套餐价格: ${price}\n` +
    `📅 默认时长: ${days} 天\n` +
    `🖼️ 收款码: ${hasQr}\n` +
    `🔗 上游池: ${pool.length} 个 (可用 ${activeUp.length})\n` +
    `🔄 合并模式: ${mergeMode ? "✅ 开启" : "⭕ 关闭"}\n` +
    `⚡ 运行环境: Cloudflare Workers (Edge)\n` +
    `⏰ 到期提醒: 自动 (${REMINDER_DAYS.join("/")}天前)\n` +
    `🚀 状态: 运行正常`;
}

// 收款码跨 Bot 转换：将管理 Bot 的图片 file_id 转为前台 Bot 可用的 file_id
// 原理：Worker 下载管理 Bot 的图片字节 → 通过 multipart 用前台 Bot 上传 → 获取前台 Bot 的 file_id
async function convertQRForStoreBot(adminFileId) {
  try {
    // 1. 用管理 Bot 获取 file_path
    const fileRes = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(adminFileId)}`);
    const fileJson = await fileRes.json();
    if (!fileJson.ok || !fileJson.result || !fileJson.result.file_path) {
      return null;
    }
    // 2. 构造图片下载 URL 并下载图片字节
    const fileUrl = `https://api.telegram.org/file/bot${ADMIN_BOT_TOKEN}/${fileJson.result.file_path}`;
    const imgRes = await fetch(fileUrl);
    if (!imgRes.ok) {
      return null;
    }
    const imgBlob = await imgRes.blob();

    // 3. 通过 multipart 用前台 Bot 上传图片，获取前台 Bot 自己的 file_id
    const formData = new FormData();
    formData.append("chat_id", String(ADMIN_ID));
    // 从 file_path 提取文件名
    const fname = fileJson.result.file_path.split("/").pop() || "qr.jpg";
    formData.append("photo", imgBlob, fname);

    const sendRes = await fetch(`https://api.telegram.org/bot${STORE_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: formData
    });
    const sendJson = await sendRes.json().catch(() => ({}));
    if (sendJson.ok && sendJson.result && sendJson.result.photo && sendJson.result.photo.length > 0) {
      // 取最高分辨率版本的 file_id
      const storeFileId = sendJson.result.photo[sendJson.result.photo.length - 1].file_id;
      // 清除前台 Bot 发给管理员的临时图片
      try {
        await fetch(`https://api.telegram.org/bot${STORE_BOT_TOKEN}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: ADMIN_ID, message_id: sendJson.result.message_id })
        });
      } catch (e) {}
      return storeFileId;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ===== 多收款码管理 =====
// 读取收款码列表（兼容旧版单张存储）
async function getPaymentQRs(env) {
  const listStr = await env.SUB_STORE.get("payment_qrs");
  if (listStr) {
    try {
      const arr = JSON.parse(listStr);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (e) {}
  }
  // 兼容旧版：单张存储
  const single = await env.SUB_STORE.get("payment_qr_file_id");
  if (single) return [{ id: 0, fileId: single, note: "收款码", addedAt: Date.now() }];
  return [];
}

// 保存收款码列表
async function savePaymentQRs(env, list) {
  await env.SUB_STORE.put("payment_qrs", JSON.stringify(list));
  // 兼容旧字段
  if (list.length > 0) {
    await env.SUB_STORE.put("payment_qr_file_id", list[0].fileId);
  }
}

// 添加收款码（返回新列表）
async function addPaymentQR(env, fileId, note) {
  const list = await getPaymentQRs(env);
  const id = Date.now();
  list.push({ id, fileId, note: note || `收款码${list.length + 1}`, addedAt: Date.now() });
  await savePaymentQRs(env, list);
  return list;
}

// 删除收款码
async function removePaymentQR(env, index) {
  const list = await getPaymentQRs(env);
  if (index < 0 || index >= list.length) return { ok: false, msg: "序号无效" };
  list.splice(index, 1);
  await savePaymentQRs(env, list);
  return { ok: true, msg: `已删除第 ${index + 1} 个收款码` };
}

// 获取买家展示的收款码（多张时随机轮换）
async function getDisplayQR(env) {
  const list = await getPaymentQRs(env);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  // 多张：随机选一张（分散收款压力）
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

// 发送普通文本
async function sendTGText(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
}

// 记录操作日志（保留最近 200 条）
async function logAction(env, action, detail) {
  try {
    const logEntry = {
      action,
      detail,
      time: Date.now()
    };
    const key = `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await env.SUB_STORE.put(key, JSON.stringify(logEntry), { expirationTtl: 2592000 }); // 30天
    // 超量清理（保留最新200条）
    const logs = await env.SUB_STORE.list({ prefix: "log_", limit: 300 });
    if (logs.keys.length > 250) {
      const toDelete = logs.keys.slice(0, logs.keys.length - 200);
      for (const k of toDelete) await env.SUB_STORE.delete(k.name);
    }
  } catch (e) {}
}

// 发送带常驻底部菜单的文本
async function sendTGMenu(token, chatId, text, menuMarkup) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      reply_markup: menuMarkup,
      parse_mode: "Markdown"
    })
  });
}

// 编辑已有消息
async function editTGMessage(token, chatId, messageId, text, replyMarkup) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "Markdown"
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// 删除消息
async function deleteTGMessage(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}

// 回复回调查询
async function answerCallback(token, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text, show_alert: false })
  });
}